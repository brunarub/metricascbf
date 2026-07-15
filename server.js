require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const { getAccounts, getPostsBasic, getPostInsights, getFollowersCount, refreshAccessToken } = require('./src/instagram');
const { getCalendario } = require('./src/calendario');
const { getEscalaSemana, getEscalaProxDias, detectarSobrecarga } = require('./src/escala');
const { enviarAlertaSobrecarga, enviarResumoSemanal } = require('./src/emails');

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

// POST /api/refresh-token — troca o token atual por um novo de longa duração (~60 dias).
// Pensado para ser chamado por um cron mensal (ver render.yaml), já que o token de
// longa duração da Meta expira em 60 dias.
app.post('/api/refresh-token', async (req, res) => {
  try {
    const { access_token, expires_in } = await refreshAccessToken();
    const expiresInDays = Math.round(expires_in / 86400);

    // Melhor esforço: persiste no .env local para sobreviver a um restart deste processo.
    // Não tem efeito em ambientes com disco efêmero (ex: cron job separado no Render) —
    // lá, o token renovado só vale para o processo web em execução até o próximo deploy.
    try {
      const envPath = path.join(__dirname, '.env');
      const envContent = fs.readFileSync(envPath, 'utf8');
      const updated = envContent.replace(/^META_ACCESS_TOKEN=.*$/m, `META_ACCESS_TOKEN=${access_token}`);
      fs.writeFileSync(envPath, updated);
    } catch (fsErr) {
      console.warn('Não foi possível persistir o novo token em .env:', fsErr.message);
    }

    console.log(`✅ Token renovado — válido por ~${expiresInDays} dias`);
    res.json({ success: true, expires_in, expires_in_days: expiresInDays });
  } catch (err) {
    const graphError = err.response?.data?.error;
    console.error('❌ /api/refresh-token — erro:', graphError ? JSON.stringify(graphError, null, 2) : err.message);
    res.status(500).json({ error: graphError?.message || err.message });
  }
});

// Cache do calendário de jogos — 15 minutos (mesmo padrão dos outros caches)
const calendarioCache = { games: null, ts: 0 };

// GET /api/calendario — jogos do Brasileirão Feminino A1 e Copa do Brasil Feminino,
// vindos da API interna (não oficial) do cbf.com.br.
app.get('/api/calendario', async (req, res) => {
  try {
    if (calendarioCache.games && (Date.now() - calendarioCache.ts) < CACHE_TTL) {
      return res.json(calendarioCache.games);
    }

    const games = await getCalendario();
    calendarioCache.games = games;
    calendarioCache.ts = Date.now();
    res.json(games);
  } catch (err) {
    console.error('Erro /api/calendario:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// Rota raiz → dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Rota → página de calendário
app.get('/calendario', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'calendario.html'));
});

// Rota → página com o site de influenciadoras embutido em iframe
app.get('/influenciadoras', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'influenciadoras.html'));
});

// ── Test email ──────────────────────────────────────────────────────
app.get('/api/test-email', async (req, res) => {
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret || req.query.secret !== adminSecret) {
    return res.status(401).json({ erro: 'Não autorizado' });
  }
  try {
    const tipo = req.query.tipo || 'semanal'; // ?tipo=alerta ou ?tipo=semanal
    if (tipo === 'alerta') {
      await enviarAlertaSobrecarga([{
        data: 'TESTE',
        qtdJogos: 3,
        qtdSociais: 1,
        socaisEscalados: ['Yves Lara'],
        jogos: [{ nome: 'Jogo A 15:00' }, { nome: 'Jogo B 17:00' }, { nome: 'Jogo C 19:00' }]
      }]);
      res.json({ ok: true, mensagem: 'Email de alerta enviado para bruna@road.ag' });
    } else {
      const { getEscalaProxDias } = require('./src/escala');
      const { escalaFiltrada } = await getEscalaProxDias(9);
      await enviarResumoSemanal(escalaFiltrada);
      res.json({ ok: true, mensagem: 'Emails semanais enviados para todo o time' });
    }
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ── Escala ──────────────────────────────────────────────────────────
let escalaCache = null;
let escalaCacheTime = 0;
const ESCALA_CACHE_TTL = 60 * 60 * 1000;

app.get('/api/escala', async (req, res) => {
  try {
    const agora = Date.now();
    if (escalaCache && (agora - escalaCacheTime) < ESCALA_CACHE_TTL) {
      return res.json(escalaCache);
    }
    const dados = await getEscalaSemana();
    escalaCache = dados;
    escalaCacheTime = agora;
    res.json(dados);
  } catch (err) {
    console.error('Erro /api/escala:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// Alerta de sobrecarga (boot + a cada 24h)
const alertasEnviados = new Set();
async function verificarSobrecarga() {
  try {
    const dadosEscala = await getEscalaSemana();
    const jogos = await getCalendario().catch(() => []);
    // Agrupa jogos por data DD/MM
    const jogosAgrupados = {};
    for (const j of jogos) {
      const chave = j.data || j.date || '';
      if (!jogosAgrupados[chave]) jogosAgrupados[chave] = [];
      jogosAgrupados[chave].push(j);
    }
    const alertas = detectarSobrecarga(dadosEscala.diasPorData, jogosAgrupados);
    const novos = alertas.filter(a => !alertasEnviados.has(a.data));
    if (novos.length > 0) {
      await enviarAlertaSobrecarga(novos);
      novos.forEach(a => alertasEnviados.add(a.data));
    }
  } catch (err) {
    console.error('Erro verificarSobrecarga:', err.message);
  }
}

// Email semanal toda sexta 9h Brasília (12h UTC)
function agendarEmailSexta() {
  const agora = new Date();
  const proximaSexta = new Date(agora);
  proximaSexta.setUTCHours(12, 0, 0, 0);
  const diaSemana = proximaSexta.getUTCDay();
  const diasAte = (5 - diaSemana + 7) % 7 || 7;
  if (diaSemana === 5 && agora.getUTCHours() >= 12) {
    proximaSexta.setUTCDate(proximaSexta.getUTCDate() + 7);
  } else {
    proximaSexta.setUTCDate(proximaSexta.getUTCDate() + diasAte);
  }
  const ms = proximaSexta - agora;
  console.log(`📅 Próximo resumo semanal: ${proximaSexta.toISOString()}`);
  setTimeout(async () => {
    try {
      const { escalaFiltrada } = await getEscalaProxDias(9);
      await enviarResumoSemanal(escalaFiltrada);
    } catch (err) {
      console.error('Erro email semanal:', err.message);
    }
    agendarEmailSexta();
  }, ms);
}

app.listen(PORT, () => {
  console.log(`\n🚀 insta-dash rodando em http://localhost:${PORT}`);
  console.log(`   Contas configuradas: ${getAccounts().map(a => a.label).join(', ') || 'nenhuma'}`);

  // Pré-aquece o cache do calendário em background — a primeira busca varre
  // ~68 dias na API do CBF e pode levar bem mais de um minuto.
  getCalendario()
    .then(games => {
      calendarioCache.games = games;
      calendarioCache.ts = Date.now();
      console.log(`📅 Calendário pré-carregado: ${games.length} jogos`);
    })
    .catch(err => console.error('Erro ao pré-carregar calendário:', err.message));

  // Escala + emails
  setTimeout(verificarSobrecarga, 5000);
  setInterval(verificarSobrecarga, 24 * 60 * 60 * 1000);
  agendarEmailSexta();
});
