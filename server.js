require('dotenv').config();
const express = require('express');
const path = require('path');
const { getAccounts, getPostsBasic, getPostInsights, getFollowersCount } = require('./src/instagram');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Cache em memória — 15 minutos
const cache = { posts: null, ts: 0 };
const CACHE_TTL = 15 * 60 * 1000;

function isCacheValid() {
  return cache.posts && (Date.now() - cache.ts) < CACHE_TTL;
}

// Cache de insights por post — evita rebuscar tudo na Graph API a cada refresh
const insightsCache = new Map(); // postId -> { data, ts }

function getCachedInsights(id) {
  const entry = insightsCache.get(id);
  if (entry && (Date.now() - entry.ts) < CACHE_TTL) return entry.data;
  return null;
}

// GET /api/accounts — lista de contas configuradas
app.get('/api/accounts', (req, res) => {
  const accounts = getAccounts();
  res.json(accounts.map(a => ({ label: a.label, id: a.id })));
});

// GET /api/posts?limit=25 — posts básicos de todas as contas
app.get('/api/posts', async (req, res) => {
  try {
    if (isCacheValid()) {
      return res.json(cache.posts);
    }

    const accounts = getAccounts();
    if (accounts.length === 0) {
      return res.status(400).json({ error: 'Nenhuma conta configurada em IG_ACCOUNTS' });
    }

    // Sem limit na query = busca todo o histórico disponível de cada conta
    const limit = req.query.limit ? parseInt(req.query.limit) : null;
    const allPosts = [];

    for (const account of accounts) {
      try {
        const posts = await getPostsBasic(account.id, limit);
        // Tenta buscar seguidores
        let followers = null;
        try {
          const info = await getFollowersCount(account.id);
          followers = info.followers_count;
        } catch (_) {}

        posts.forEach(p => {
          allPosts.push({
            ...p,
            account_label: account.label,
            account_id: account.id,
            followers_count: followers,
          });
        });
      } catch (err) {
        console.error(`Erro ao buscar posts de ${account.label}:`, err.response?.data || err.message);
      }
    }

    // Ordena por data, mais recente primeiro
    allPosts.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    cache.posts = allPosts;
    cache.ts = Date.now();

    res.json(allPosts);
  } catch (err) {
    console.error('Erro /api/posts:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/insights/batch — insights de até 10 posts
app.post('/api/insights/batch', async (req, res) => {
  try {
    const { postIds } = req.body;
    if (!postIds || !Array.isArray(postIds)) {
      return res.status(400).json({ error: 'postIds deve ser um array' });
    }

    const ids = postIds.slice(0, 10);
    const results = {};
    const CONCURRENCY = 5;

    async function fetchOne(id) {
      const cached = getCachedInsights(id);
      if (cached) {
        results[id] = cached;
        return;
      }
      try {
        results[id] = await getPostInsights(id);
        insightsCache.set(id, { data: results[id], ts: Date.now() });
      } catch (err) {
        const graphError = err.response?.data?.error;
        console.error(`❌ /api/insights/batch — erro no post ${id}:`, graphError ? JSON.stringify(graphError, null, 2) : err);
        results[id] = { error: graphError?.message || err.message };
      }
    }

    // Busca em ondas de até 5 posts em paralelo, com uma pequena pausa entre ondas
    for (let i = 0; i < ids.length; i += CONCURRENCY) {
      const wave = ids.slice(i, i + CONCURRENCY);
      await Promise.all(wave.map(fetchOne));
      if (i + CONCURRENCY < ids.length) await new Promise(r => setTimeout(r, 200));
    }

    res.json(results);
  } catch (err) {
    console.error('Erro /api/insights/batch:', err);
    res.status(500).json({ error: err.message });
  }
});

// Rota raiz → dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🚀 insta-dash rodando em http://localhost:${PORT}`);
  console.log(`   Contas configuradas: ${getAccounts().map(a => a.label).join(', ') || 'nenhuma'}`);
});
