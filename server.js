require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const { getAccounts, getPostsBasic, getPostInsights, getFollowersCount, getAccountInsights, refreshAccessToken } = require('./src/instagram');
const { getYouTubePosts, getYouTubeAccounts } = require('./src/youtube');
const { getTikTokPosts, getAuthUrl, exchangeCode, readTokens, writeTokensLocal, persistTokens } = require('./src/tiktok');
const { getReporteiPosts, getAccountViewsTotal, REPORTEI_ACCOUNT_LABELS } = require('./src/reportei');
const { getCalendario } = require('./src/calendario');
const { getEscalaSemana, getEscalaProxDias, detectarSobrecarga, calcularHorarioPlantao, ehCoberturaDejogo, isIntern } = require('./src/escala');
const { enviarAlertaSobrecarga, enviarResumoSemanal } = require('./src/emails');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Cache em memória — 15 minutos
const cache = { posts: null, ts: 0, failedAccounts: [] };
const CACHE_TTL = 15 * 60 * 1000;

function isCacheValid() {
  return cache.posts && (Date.now() - cache.ts) < CACHE_TTL;
}

// Corre uma promise contra um limite de tempo — se a promise original nunca
// resolver/rejeitar (ex: API externa travada sem erro nem timeout próprio),
// garante que quem chamou não fica pendurado pra sempre. A promise perdedora
// continua rodando em segundo plano (não é cancelada), só deixa de ser esperada.
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout (${label || 'operação'} > ${ms}ms)`)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
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
// Resposta sempre no formato { posts, error, stale, failedAccounts } (mesmo padrão das
// outras 3 fontes) — uma conta que falha (timeout, token expirado etc) é reportada em
// `failedAccounts`, não descartada em silêncio como se simplesmente não tivesse posts.
app.get('/api/posts', async (req, res) => {
  try {
    if (isCacheValid()) {
      return res.json({
        posts: cache.posts,
        error: cache.failedAccounts.length ? 'instagram_partial' : null,
        stale: false,
        failedAccounts: cache.failedAccounts,
      });
    }

    const accounts = getAccounts();
    if (accounts.length === 0) {
      return res.status(400).json({ error: 'Nenhuma conta configurada em IG_ACCOUNTS' });
    }

    // Sem limit na query = busca todo o histórico disponível de cada conta
    const limit = req.query.limit ? parseInt(req.query.limit) : null;
    const allPosts = [];
    const failedAccounts = [];

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
        failedAccounts.push(account.label);
      }
    }

    // Ordena por data, mais recente primeiro
    allPosts.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    cache.posts = allPosts;
    cache.ts = Date.now();
    cache.failedAccounts = failedAccounts;

    res.json({ posts: allPosts, error: failedAccounts.length ? 'instagram_partial' : null, stale: false, failedAccounts });
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

// ─── TikTok OAuth ─────────────────────────────────────────────────────────────

// GET /auth/tiktok?account=brasileiras — inicia o fluxo OAuth para uma conta
app.get('/auth/tiktok', (req, res) => {
  const account = req.query.account;
  if (!account) return res.status(400).send('Parâmetro account obrigatório');
  if (!process.env.TIKTOK_CLIENT_KEY) return res.status(500).send('TIKTOK_CLIENT_KEY não configurada');
  res.redirect(getAuthUrl(account));
});

// GET /auth/tiktok/callback — TikTok redireciona aqui após o login
app.get('/auth/tiktok/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.send(`❌ Erro TikTok: ${error}`);
  if (!code) return res.status(400).send('Código de autorização não recebido');

  try {
    const tokenData = await exchangeCode(code);
    const accountLabel = state || 'desconhecido';

    const tokens = readTokens();
    tokens[accountLabel] = {
      access_token:  tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      open_id:       tokenData.open_id,
      connected_at:  new Date().toISOString(),
      // access_token do TikTok dura 24h — guardar quando expira permite renovar
      // proativamente em getTikTokPosts() (src/tiktok.js) em vez de descobrir só na
      // hora (401) a cada chamada.
      expires_at:    typeof tokenData.expires_in === 'number' ? Date.now() + tokenData.expires_in * 1000 : undefined,
    };
    // persistTokens salva no arquivo local E atualiza process.env.TIKTOK_TOKENS
    // na hora — sem isso, o processo em execução continuava com o token antigo
    // até reiniciar, mesmo depois de reconectar com sucesso pelo navegador.
    await persistTokens(tokens);

    // Instrução para salvar no Render
    const tokenJson = JSON.stringify(tokens);
    res.send(`
      <html><body style="font-family:Arial;max-width:700px;margin:60px auto;padding:0 24px">
      <h2>✅ TikTok conectado: <b>${accountLabel}</b></h2>
      <p>Conta autenticada com sucesso! Agora você precisa salvar o token no Render para persistir após o deploy.</p>
      <p><b>Copie o valor abaixo</b> e adicione como variável de ambiente <code>TIKTOK_TOKENS</code> no Render:</p>
      <textarea rows="4" style="width:100%;font-size:0.8rem;padding:8px">${tokenJson.replace(/</g,'&lt;')}</textarea>
      <p><a href="/">← Voltar ao dashboard</a></p>
      </body></html>
    `);
  } catch (err) {
    console.error('Erro TikTok callback:', err.response?.data || err.message);
    res.status(500).send(`❌ Erro ao trocar token: ${err.message}`);
  }
});

// GET /api/tiktok-posts — vídeos das contas TikTok conectadas
// Resposta sempre no formato { posts, error, stale, staleAgeMin } (mesmo padrão do
// /api/reportei-posts) — nunca um array solto. Uma chamada que falha/trava (timeout,
// rate limit, ERR_ABORTED no front-end) não pode virar silenciosamente "sem posts";
// se já existir um cache anterior, ele é reaproveitado e marcado como `stale`.
//
// ttCache.posts só pode ser gravado quando a busca deu 100% certo (nenhuma conta em
// failedAccounts) — é o que garante a invariante abaixo: se `ttCache.posts` existe,
// ele é sempre um resultado limpo, nunca um `[]` que na real veio de uma falha. Uma
// versão anterior gravava `ttCache.posts = posts` incondicionalmente (inclusive
// quando `posts` era `[]` por TODAS as contas terem falhado); como array vazio ainda
// é truthy em JS, o cache-hit em cima devolvia `error: null` por até 15 min depois de
// uma falha real — o TikTok sumia em silêncio de novo, regressão pro bug original.
const ttCache = { posts: null, ts: 0 };
app.get('/api/tiktok-posts', async (req, res) => {
  if (!process.env.TIKTOK_CLIENT_KEY) return res.json({ posts: [], error: null, stale: false });
  const tokens = readTokens();
  if (!Object.keys(tokens).length) return res.json({ posts: [], error: null, stale: false });
  if (ttCache.posts && (Date.now() - ttCache.ts) < CACHE_TTL) {
    return res.json({ posts: ttCache.posts, error: null, stale: false });
  }
  // Timing de diagnóstico: getTikTokPosts() já loga por conta/fase (ver src/tiktok.js),
  // esse log fecha o quadro mostrando o tempo total da requisição — útil pra confirmar
  // nos logs do Render se o timeout de 20s realmente está sendo acionado (e por causa
  // de qual conta) ou se o problema é outro.
  //
  // Confirmado nos logs do Render: a causa real do timeout/429 persistente não era
  // renovação de token — era getTikTokPosts() buscando o HISTÓRICO COMPLETO de cada
  // conta (brasileirao sozinha tem 672 vídeos = ~34 páginas) toda vez que o cache de
  // 15 min expirava. limit=50 por padrão (mesmo valor de /api/youtube-posts) — cobre
  // de sobra o uso normal do dashboard e corta drasticamente as requisições à TikTok.
  const limit = req.query.limit ? parseInt(req.query.limit) : 50;
  const reqStart = Date.now();
  try {
    const { posts, failedAccounts } = await withTimeout(getTikTokPosts(limit), 20000, 'tiktok-posts');
    console.log(`/api/tiktok-posts OK em ${Date.now() - reqStart}ms${failedAccounts.length ? ` (parcial: ${failedAccounts.join(', ')})` : ''}`);

    if (failedAccounts.length === 0) {
      ttCache.posts = posts;
      ttCache.ts = Date.now();
      return res.json({ posts, error: null, stale: false });
    }

    // Falha parcial (algumas contas ok, outras não) — nunca vira o cache "bom" (ver
    // comentário acima). Se já existe um resultado limpo anterior, serve ele marcado
    // como stale (mesmo padrão do /api/reportei-posts); senão devolve o parcial de
    // agora mesmo, sempre com `error` setado — nunca `null` quando alguma conta falhou.
    if (ttCache.posts) {
      const staleAgeMin = Math.round((Date.now() - ttCache.ts) / 60000);
      return res.json({ posts: ttCache.posts, error: 'tiktok_partial', stale: true, staleAgeMin, failedAccounts });
    }
    res.json({ posts, error: 'tiktok_partial', stale: false, failedAccounts });
  } catch (err) {
    console.error(`Erro /api/tiktok-posts (${Date.now() - reqStart}ms):`, err.message);
    if (ttCache.posts) {
      const staleAgeMin = Math.round((Date.now() - ttCache.ts) / 60000);
      return res.json({ posts: ttCache.posts, error: 'tiktok_timeout', stale: true, staleAgeMin });
    }
    res.json({ posts: [], error: 'tiktok_timeout', stale: false });
  }
});

// GET /conectar-tiktok — página para conectar contas TikTok
app.get('/conectar-tiktok', (req, res) => {
  const tokens = readTokens();
  const accounts = ['brasileiras', 'copa_do_brasil', 'brasileirao'];
  const rows = accounts.map(a => {
    const connected = tokens[a]?.access_token;
    const status = connected
      ? `✅ Conectado em ${new Date(tokens[a].connected_at).toLocaleDateString('pt-BR')}`
      : '❌ Não conectado';
    return `<tr>
      <td style="padding:12px 16px;font-weight:700">${a}</td>
      <td style="padding:12px 16px">${status}</td>
      <td style="padding:12px 16px"><a href="/auth/tiktok?account=${a}" style="background:#ff2d55;color:#fff;padding:8px 16px;border-radius:8px;text-decoration:none;font-weight:700">
        ${connected ? '🔄 Reconectar' : '🔗 Conectar'}
      </a></td>
    </tr>`;
  }).join('');
  res.send(`
    <html><body style="font-family:Arial;max-width:700px;margin:60px auto;padding:0 24px">
    <h1 style="color:#0A2342">🎵 Conectar contas TikTok</h1>
    <p>Cada responsável pela conta precisa clicar em "Conectar" e fazer login com o TikTok correspondente.</p>
    <table style="width:100%;border-collapse:collapse;border:1px solid #ddd;border-radius:8px;overflow:hidden">
      <thead><tr style="background:#0A2342;color:#fff">
        <th style="padding:12px 16px;text-align:left">Conta</th>
        <th style="padding:12px 16px;text-align:left">Status</th>
        <th style="padding:12px 16px;text-align:left">Ação</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="margin-top:24px"><a href="/">← Voltar ao dashboard</a></p>
    </body></html>
  `);
});

// ─── Reportei (Brasileirão e Seleção — sem acesso direto via Meta Graph API) ───

// GET /api/reportei-posts — posts de Instagram via Reportei
// Resposta sempre no formato { posts, error, stale, staleAgeMin } — nunca um array
// solto — pra o front-end (public/index.html) sempre ter algo a renderizar, mesmo
// quando o Reportei trava ou erra. A API do Reportei já ficou minutos sem responder
// (nem erro nem timeout) pras contas Brasileirão/Seleção, o que travava a página
// inteira em "Carregando..." (o front-end esperava as 4 fontes num Promise.all).
//
// rpCache.posts só pode ser gravado quando a busca deu 100% certo (nenhuma conta em
// failedAccounts) — mesma invariante do ttCache/ytCache abaixo. Uma falha parcial
// nunca pode virar cache "bom": um `[]` vindo de falha ainda é truthy em JS, então um
// cache-hit em cima dele devolveria `error: null` por até 15 min como se fosse
// sucesso — foi exatamente essa regressão que aconteceu com o TikTok.
const rpCache = { posts: null, ts: 0 };
app.get('/api/reportei-posts', async (req, res) => {
  if (!process.env.REPORTEI_API_TOKEN) return res.json({ posts: [], error: null, stale: false });
  if (rpCache.posts && (Date.now() - rpCache.ts) < CACHE_TTL) {
    return res.json({ posts: rpCache.posts, error: null, stale: false });
  }
  try {
    // Limite duro de 20s pra essa rota, além do timeout de 15s já embutido em
    // cada chamada axios dentro de getReporteiPosts() (ver src/reportei.js) —
    // segunda camada de proteção caso a primeira falhe por algum motivo.
    const { posts, failedAccounts } = await withTimeout(getReporteiPosts(), 20000, 'reportei-posts');

    if (failedAccounts.length === 0) {
      rpCache.posts = posts;
      rpCache.ts = Date.now();
      return res.json({ posts, error: null, stale: false });
    }

    if (rpCache.posts) {
      const staleAgeMin = Math.round((Date.now() - rpCache.ts) / 60000);
      return res.json({ posts: rpCache.posts, error: 'reportei_partial', stale: true, staleAgeMin, failedAccounts });
    }
    res.json({ posts, error: 'reportei_partial', stale: false, failedAccounts });
  } catch (err) {
    console.error('Erro /api/reportei-posts:', err.message);
    if (rpCache.posts) {
      const staleAgeMin = Math.round((Date.now() - rpCache.ts) / 60000);
      return res.json({ posts: rpCache.posts, error: 'reportei_timeout', stale: true, staleAgeMin });
    }
    res.json({ posts: [], error: 'reportei_timeout', stale: false });
  }
});

// ─── YouTube ──────────────────────────────────────────────────────────────────

// GET /api/youtube-posts?limit=50 — vídeos dos canais YouTube configurados
// Mesmo formato de resposta { posts, error, stale, staleAgeMin } que /api/tiktok-posts
// e /api/reportei-posts — ver comentário acima. Mesma invariante de cache também:
// ytCache.posts só é gravado num resultado 100% limpo (ver comentário no ttCache).
const ytCache = { posts: null, ts: 0 };
app.get('/api/youtube-posts', async (req, res) => {
  if (!process.env.YT_API_KEY) return res.json({ posts: [], error: null, stale: false });
  if (ytCache.posts && (Date.now() - ytCache.ts) < CACHE_TTL) {
    return res.json({ posts: ytCache.posts, error: null, stale: false });
  }
  const limit = req.query.limit ? parseInt(req.query.limit) : 50;
  try {
    const { posts, failedAccounts } = await withTimeout(getYouTubePosts(limit), 20000, 'youtube-posts');

    if (failedAccounts.length === 0) {
      ytCache.posts = posts;
      ytCache.ts = Date.now();
      return res.json({ posts, error: null, stale: false });
    }

    if (ytCache.posts) {
      const staleAgeMin = Math.round((Date.now() - ytCache.ts) / 60000);
      return res.json({ posts: ytCache.posts, error: 'youtube_partial', stale: true, staleAgeMin, failedAccounts });
    }
    res.json({ posts, error: 'youtube_partial', stale: false, failedAccounts });
  } catch (err) {
    console.error('Erro /api/youtube-posts:', err.message);
    if (ytCache.posts) {
      const staleAgeMin = Math.round((Date.now() - ytCache.ts) / 60000);
      return res.json({ posts: ytCache.posts, error: 'youtube_timeout', stale: true, staleAgeMin });
    }
    res.json({ posts: [], error: 'youtube_timeout', stale: false });
  }
});

// GET /api/account-insights?since=YYYY-MM-DD&until=YYYY-MM-DD[&account=label]
// Retorna impressões reais da conta Instagram (Feed + Reels + Stories) para o período.
// account (opcional): filtra por label específico (ex: brasileiras)
app.get('/api/account-insights', async (req, res) => {
  try {
    const { since, until, account } = req.query;
    if (!since || !until) {
      return res.status(400).json({ error: 'since e until são obrigatórios (YYYY-MM-DD)' });
    }
    const sinceTs = Math.floor(new Date(since + 'T00:00:00-03:00').getTime() / 1000);
    const untilTs = Math.floor(new Date(until + 'T23:59:59-03:00').getTime() / 1000);

    let accounts = getAccounts();
    if (account && account !== 'todos') {
      accounts = accounts.filter(a => a.label === account);
    }
    const byAccount = {};
    let total = 0;

    for (const acc of accounts) {
      try {
        const impressions = await getAccountInsights(acc.id, sinceTs, untilTs);
        byAccount[acc.label] = impressions;
        total += impressions;
      } catch (err) {
        console.error(`Erro account-insights ${acc.label}:`, err.response?.data?.error || err.message);
        byAccount[acc.label] = null;
      }
    }

    // Brasileirão e Seleção não têm acesso direto via Meta Graph API — usam a métrica
    // agregada "ig:views" do Reportei (ver src/reportei.js), não a soma por post. Sem
    // isso, essas duas contas ficavam de fora do account-insights (e o dashboard caía
    // pra somar `views` por post, que fica bem abaixo do real).
    let reporteiLabels = REPORTEI_ACCOUNT_LABELS;
    if (account && account !== 'todos') {
      reporteiLabels = reporteiLabels.filter(label => label === account);
    }
    for (const label of reporteiLabels) {
      try {
        const views = await getAccountViewsTotal(label, since, until);
        byAccount[label] = views;
        if (views) total += views;
      } catch (err) {
        console.error(`Erro Reportei account-views ${label}:`, err.message);
        byAccount[label] = null;
      }
    }

    res.json({ total, byAccount });
  } catch (err) {
    console.error('Erro /api/account-insights:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/resumo?since=YYYY-MM-DD&until=YYYY-MM-DD
// Retorna views + volumetria (contagem de posts) por conta e por plataforma,
// já filtrado pro período pedido. Pensado pra alimentar relatórios e
// automações sem precisar paginar/filtrar manualmente no client.
app.get('/api/resumo', async (req, res) => {
  try {
    const { since, until } = req.query;
    if (!since || !until) {
      return res.status(400).json({ error: 'since e until são obrigatórios (YYYY-MM-DD)' });
    }

    const sinceMs = new Date(since + 'T00:00:00-03:00').getTime();
    const untilMs = new Date(until + 'T23:59:59-03:00').getTime();
    const dentroDoPeriodo = (timestamp) => {
      const t = new Date(timestamp).getTime();
      return t >= sinceMs && t <= untilMs;
    };

    const resumo = {}; // { [accountLabel]: { instagram: {views, posts}, tiktok: {...}, youtube: {...} } }
    function registrar(label, plataforma, views, posts) {
      if (!resumo[label]) resumo[label] = {};
      resumo[label][plataforma] = { views, posts };
    }

    // ── Instagram: views via Insights oficial (period-accurate), posts contados por data ──
    const igAccounts = getAccounts();
    for (const account of igAccounts) {
      try {
        const sinceTs = Math.floor(sinceMs / 1000);
        const untilTs = Math.floor(untilMs / 1000);
        const views = await getAccountInsights(account.id, sinceTs, untilTs);
        const todosPosts = await getPostsBasic(account.id, 300); // últimos 300 posts é margem suficiente pra qualquer período de relatório
        const posts = todosPosts.filter(p => dentroDoPeriodo(p.timestamp)).length;
        registrar(account.label, 'instagram', views, posts);
      } catch (err) {
        console.error(`Erro resumo IG ${account.label}:`, err.response?.data?.error || err.message);
        registrar(account.label, 'instagram', null, null);
      }
    }

    // ── TikTok: filtrar e somar por período ──
    // 300 (mesma margem generosa usada em getYouTubePosts(300) logo abaixo) — o
    // default de getTikTokPosts() é 50 (dashboard), baixo demais pra relatórios que
    // podem pedir um período mais antigo; nunca usar limit indefinido aqui (ver
    // comentário em getTikTokPosts em src/tiktok.js sobre por que isso derrubava a
    // rota com rate limit da TikTok).
    try {
      const { posts: ttPosts } = await getTikTokPosts(300);
      const porConta = {};
      for (const p of ttPosts) {
        if (!dentroDoPeriodo(p.timestamp)) continue;
        if (!porConta[p.account_label]) porConta[p.account_label] = { views: 0, posts: 0 };
        porConta[p.account_label].views += p.view_count;
        porConta[p.account_label].posts += 1;
      }
      for (const [label, v] of Object.entries(porConta)) {
        registrar(label, 'tiktok', v.views, v.posts);
      }
    } catch (err) {
      console.error('Erro resumo TikTok:', err.message);
    }

    // ── YouTube: getYouTubePosts(300) busca até 300 vídeos por canal, filtra e soma ──
    // Nota: 300 é uma margem generosa pra garantir que cobre qualquer período razoável
    // de relatório sem deixar de trazer vídeos antigos o suficiente.
    try {
      const { posts: ytPosts } = await getYouTubePosts(300);
      const porConta = {};
      for (const p of ytPosts) {
        if (!dentroDoPeriodo(p.timestamp)) continue;
        if (!porConta[p.account_label]) porConta[p.account_label] = { views: 0, posts: 0 };
        porConta[p.account_label].views += Number(p.view_count) || 0;
        porConta[p.account_label].posts += 1;
      }
      for (const [label, v] of Object.entries(porConta)) {
        registrar(label, 'youtube', v.views, v.posts);
      }
    } catch (err) {
      console.error('Erro resumo YouTube:', err.message);
    }

    res.json({ since, until, contas: resumo });
  } catch (err) {
    console.error('Erro /api/resumo:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/debug-account-insights?since=YYYY-MM-DD&until=YYYY-MM-DD
// Retorna a resposta bruta da Graph API — útil para diagnosticar o formato.
app.get('/api/debug-account-insights', async (req, res) => {
  try {
    const { since, until } = req.query;
    if (!since || !until) return res.status(400).json({ error: 'since e until obrigatórios' });
    const sinceTs = Math.floor(new Date(since + 'T00:00:00-03:00').getTime() / 1000);
    const untilTs = Math.floor(new Date(until + 'T23:59:59-03:00').getTime() / 1000);

    const axios = require('axios');
    const BASE_URL = `https://graph.facebook.com/${process.env.GRAPH_API_VERSION || 'v21.0'}`;
    const accounts = getAccounts();
    const raw = {};

    for (const account of accounts) {
      try {
        const r = await axios.get(`${BASE_URL}/${account.id}/insights`, {
          params: {
            metric: 'views',
            metric_type: 'total_value',
            period: 'day',
            since: sinceTs,
            until: untilTs,
            access_token: process.env.META_ACCESS_TOKEN,
          }
        });
        raw[account.label] = r.data;
      } catch (err) {
        raw[account.label] = { error: err.response?.data || err.message };
      }
    }

    res.json({ sinceTs, untilTs, raw });
  } catch (err) {
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

// Cache do calendário — 12h (API da CBF bloqueia cloud IPs com frequência)
const CALENDARIO_CACHE_TTL = 12 * 60 * 60 * 1000;
const calendarioCache = { games: null, ts: 0 };

// GET /api/calendario — jogos do Brasileirão Feminino A1 e Copa do Brasil Feminino,
// vindos da API interna (não oficial) do cbf.com.br.
app.get('/api/calendario', async (req, res) => {
  try {
    if (calendarioCache.games && (Date.now() - calendarioCache.ts) < CALENDARIO_CACHE_TTL) {
      return res.json(calendarioCache.games);
    }

    const games = await getCalendario();
    if (games.length > 0) {
      calendarioCache.games = games;
      calendarioCache.ts = Date.now();
    } else if (calendarioCache.games) {
      // API falhou mas temos cache antigo — devolve o que temos
      console.warn('⚠️ CBF API retornou vazio, usando cache antigo.');
      return res.json(calendarioCache.games);
    }
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

// ── Debug calendário ────────────────────────────────────────────────
app.get('/api/debug-calendario', async (req, res) => {
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret || req.query.secret !== adminSecret) {
    return res.status(401).json({ erro: 'Não autorizado' });
  }
  try {
    const axios = require('axios');
    const https = require('https');
    const url = 'https://www.cbf.com.br/api/cbf/calendario/jogos/2026/07/22';
    const r = await axios.get(url, {
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Referer': 'https://www.cbf.com.br/futebol-brasileiro/calendario',
      }
    });
    res.json({ status: r.status, keys: Object.keys(r.data || {}), jogosKeys: Object.keys(r.data?.jogos || {}) });
  } catch (err) {
    res.json({ erro: err.message, code: err.response?.status });
  }
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

// ── Enriquecimento escala × jogos ───────────────────────────────────
// Cruza diasPorData com o calendário: injeta horarioCalculado e jogoCobertura
// em cada entrada de todos[] que representa cobertura de jogo.
function enriquecerEscalaComJogos(dadosEscala, jogos) {
  // Agrupa jogos por DD/MM
  const jogosPorData = {};
  for (const j of jogos) {
    const raw = j.data || '';
    const m = raw.match(/(\d{1,2})[\/\-](\d{1,2})/);
    if (!m || !j.datetime) continue;
    const chave = `${m[1].padStart(2,'0')}/${m[2].padStart(2,'0')}`;
    if (!jogosPorData[chave]) jogosPorData[chave] = [];
    jogosPorData[chave].push(j);
  }

  for (const [data, info] of Object.entries(dadosEscala.diasPorData)) {
    const ddmm = data.substring(0, 5);
    const jogosDoDia = jogosPorData[ddmm] || [];
    if (!jogosDoDia.length) continue;

    for (const pessoa of info.todos) {
      if (!ehCoberturaDejogo(pessoa.status) && !/\d+h/.test(pessoa.status)) continue;

      // Encontra o jogo mais relevante: prioriza o que tem a keyword no status
      let jogo = jogosDoDia.find(j => {
        const s = pessoa.status.toLowerCase();
        const c = (j.competicao || '').toLowerCase();
        return (s.includes('brasileir') && c.includes('brasileir')) ||
               (s.includes('copa') && c.includes('copa')) ||
               (s.includes('libertadores') && c.includes('libertadores'));
      }) || jogosDoDia[0];

      const horario = calcularHorarioPlantao(jogo.datetime, isIntern(pessoa.nome));
      pessoa.horarioCalculado = horario; // null = horário normal (10h-19h) já cobre
      pessoa.jogoCobertura = {
        competicao: jogo.competicao,
        mandante:   jogo.mandante?.nome  || '?',
        visitante:  jogo.visitante?.nome || '?',
        hora:       jogo.hora || null,
        datetime:   jogo.datetime
      };
    }
  }

  return dadosEscala;
}

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
    if (calendarioCache.games?.length) enriquecerEscalaComJogos(dados, calendarioCache.games);
    escalaCache = dados;
    escalaCacheTime = agora;
    res.json(dados);
  } catch (err) {
    console.error('Erro /api/escala:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// Alerta de sobrecarga e resumo semanal agora rodam como Render Cron Jobs
// separados (src/alerta-sobrecarga-cron.js e src/resumo-semanal-cron.js, ver
// render.yaml) em vez de setTimeout/setInterval aqui — o serviço web no plano
// free do Render dorme após inatividade e perde timers agendados para o futuro,
// o que fazia o email semanal simplesmente não ser enviado.

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

});
