// src/tiktok.js
// Integração TikTok via OAuth 2.0 (Login Kit + video.list scope)
// Variáveis necessárias no .env:
//   TIKTOK_CLIENT_KEY=...
//   TIKTOK_CLIENT_SECRET=...
//   TIKTOK_TOKENS={"brasileiras":{"access_token":"...","refresh_token":"...","open_id":"..."}}

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const CLIENT_KEY    = process.env.TIKTOK_CLIENT_KEY;
const CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET;
const REDIRECT_URI  = process.env.TIKTOK_REDIRECT_URI || 'https://metricascbf.onrender.com/auth/tiktok/callback';

// Lê tokens do env (JSON string) ou arquivo local como fallback
function readTokens() {
  try {
    const raw = process.env.TIKTOK_TOKENS;
    if (raw) return JSON.parse(raw);
  } catch (_) {}
  try {
    const filePath = path.join(__dirname, '..', '.tiktok-tokens.json');
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {}
  return {};
}

function writeTokensLocal(tokens) {
  try {
    const filePath = path.join(__dirname, '..', '.tiktok-tokens.json');
    fs.writeFileSync(filePath, JSON.stringify(tokens, null, 2));
  } catch (_) {}
}

// Salva os tokens em 3 lugares: arquivo local, memória do processo (process.env,
// já vale sem precisar de restart) e a env var TIKTOK_TOKENS no Render via API
// (assim sobrevive ao próximo deploy). Sem RENDER_API_KEY/RENDER_SERVICE_ID
// configuradas, pula só o passo do Render e mantém o comportamento atual.
async function persistTokens(tokens) {
  writeTokensLocal(tokens);
  process.env.TIKTOK_TOKENS = JSON.stringify(tokens);

  const renderApiKey    = process.env.RENDER_API_KEY;
  const renderServiceId = process.env.RENDER_SERVICE_ID;
  if (!renderApiKey || !renderServiceId) return;

  try {
    await axios.put(
      `https://api.render.com/v1/services/${renderServiceId}/env-vars/TIKTOK_TOKENS`,
      { value: JSON.stringify(tokens) },
      {
        headers: {
          Authorization: `Bearer ${renderApiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      }
    );
  } catch (err) {
    console.error('Erro ao persistir TIKTOK_TOKENS no Render:', err.response?.data || err.message);
  }
}

// URL de autorização para redirecionar o usuário ao TikTok
function getAuthUrl(accountLabel) {
  const params = new URLSearchParams({
    client_key:    CLIENT_KEY,
    scope:         'user.info.basic,video.list',
    response_type: 'code',
    redirect_uri:  REDIRECT_URI,
    state:         accountLabel, // usamos o state para saber qual conta está sendo conectada
  });
  return `https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`;
}

// Troca o code OAuth por access_token + refresh_token
async function exchangeCode(code) {
  const res = await axios.post('https://open.tiktokapis.com/v2/oauth/token/', new URLSearchParams({
    client_key:    CLIENT_KEY,
    client_secret: CLIENT_SECRET,
    code,
    grant_type:    'authorization_code',
    redirect_uri:  REDIRECT_URI,
  }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 });
  return res.data;
}

// Renova o access_token usando o refresh_token
async function refreshToken(refreshTokenStr) {
  const res = await axios.post('https://open.tiktokapis.com/v2/oauth/token/', new URLSearchParams({
    client_key:     CLIENT_KEY,
    client_secret:  CLIENT_SECRET,
    grant_type:     'refresh_token',
    refresh_token:  refreshTokenStr,
  }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 });
  return res.data;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// access_token do TikTok dura 24h (`expires_in`, ver doc oficial). Sem guardar isso,
// o código só descobre que o token expirou reativamente (tenta, recebe 401, só então
// renova) — um round-trip extra garantido toda vez que o token expira. Refresca
// proativamente quando faltar menos de 10 min pro vencimento.
const ACCESS_TOKEN_REFRESH_MARGIN_MS = 10 * 60 * 1000;

function computeExpiresAt(expiresInSec) {
  return typeof expiresInSec === 'number' ? Date.now() + expiresInSec * 1000 : undefined;
}

// Tokens salvos antes desse campo existir não têm `expires_at` — nesse caso não dá
// pra saber se está perto de expirar, então só o 401 reativo decide (comportamento
// de antes, preservado).
function needsProactiveRefresh(tokenData) {
  if (!tokenData.expires_at) return false;
  return Date.now() >= (tokenData.expires_at - ACCESS_TOKEN_REFRESH_MARGIN_MS);
}

// Busca vídeos de uma conta usando o access_token, paginando conforme necessário.
// limit = null busca TODO o histórico disponível da conta (segue os cursores até acabar,
// igual já fazemos com o Instagram em src/instagram.js). A API do TikTok limita cada
// página a no máximo 20 vídeos (max_count), então paginamos com cursor/has_more.
async function fetchTikTokVideos(accessToken, limit = null) {
  const fields = 'id,title,cover_image_url,share_url,video_description,duration,height,width,title,embed_link,like_count,comment_count,share_count,view_count,create_time';
  const url = 'https://open.tiktokapis.com/v2/video/list/';
  const pageSize = 20; // máximo permitido por página pela API do TikTok

  let videos = [];
  let cursor = 0;
  let hasMore = true;

  while (hasMore && (!limit || videos.length < limit)) {
    let res;
    for (let attempt = 1; ; attempt++) {
      try {
        res = await axios.post(url,
          { max_count: pageSize, cursor },
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            params: { fields },
            timeout: 15000,
          }
        );
        break;
      } catch (err) {
        const status = err.response?.status;
        if (attempt < 3 && (status === 429 || status >= 500)) {
          await sleep(1000 * attempt);
        } else {
          throw err;
        }
      }
    }
    const page = res.data?.data?.videos || [];
    if (page.length === 0) break;
    videos = videos.concat(page);
    hasMore = !!res.data?.data?.has_more;
    cursor = res.data?.data?.cursor || cursor;
    if (hasMore) await sleep(300);
  }

  return limit ? videos.slice(0, limit) : videos;
}

// Retorna posts normalizados de todas as contas TikTok conectadas, junto com a lista
// de contas que falharam (timeout, rate limit, token inválido etc) — sem essa lista,
// uma falha parcial (ou total) vira silenciosamente "0 posts", indistinguível de uma
// conta que legitimamente não postou nada no período.
//
// limit = 50 por padrão (igual getYouTubePosts, ver src/youtube.js) — NÃO usar null
// (histórico completo) aqui como fazíamos antes. Achado nos logs do Render: a conta
// brasileirao sozinha tem 672 vídeos, e com 20 vídeos por página (máximo da API do
// TikTok) isso é ~34 requisições sequenciais só pra essa conta, toda vez que o cache
// de 15 min expira — 30-40s de chamadas em sequência, e é exatamente isso (não o
// refresh de token, já verificado e descartado) que estoura o rate limit (429) da
// TikTok nas 3 contas e trava a rota nos 20s de timeout. Quem precisar do histórico
// completo (ex: /api/resumo em server.js, pra relatórios de período específico) deve
// passar um limit explícito e generoso — nunca null.
async function getTikTokPosts(limit = 50) {
  const tokens = readTokens();
  const allPosts = [];
  const failedAccounts = [];

  const entries = Object.entries(tokens);
  for (let i = 0; i < entries.length; i++) {
    const [accountLabel, tokenData] = entries[i];
    if (!tokenData?.access_token) continue;

    if (i > 0) await sleep(500);
    const acctStart = Date.now();

    try {
      let { access_token, refresh_token } = tokenData;

      // Salva o token renovado sem bloquear nessa chamada em espera do PUT pro
      // Render — writeTokensLocal() e process.env.TIKTOK_TOKENS (o que importa pra
      // essa e as próximas chamadas dentro do mesmo processo) já acontecem de forma
      // síncrona antes do primeiro `await` dentro de persistTokens(); só o PUT na
      // API do Render (rede externa, timeout de 15s, best-effort — sobrevive a um
      // redeploy mas não é o que essa requisição precisa esperar) fica em segundo
      // plano. Sem isso, uma renovação de token podia empurrar essa requisição bem
      // perto (ou além) do timeout de 20s de /api/tiktok-posts.
      const saveRenewed = (newAccessToken, newRefreshToken, expiresIn) => {
        const updated = readTokens();
        updated[accountLabel] = { ...tokenData, access_token: newAccessToken, refresh_token: newRefreshToken, expires_at: computeExpiresAt(expiresIn) };
        persistTokens(updated);
      };

      // Renova proativamente se o token já está perto de expirar — evita o
      // round-trip garantido de "tenta com token vencido, recebe 401, só então
      // renova" toda vez que o token expira (access_token dura só 24h).
      if (needsProactiveRefresh(tokenData) && refresh_token) {
        const t0 = Date.now();
        console.log(`TikTok: renovando token de ${accountLabel} proativamente (perto de expirar)...`);
        const renewed = await refreshToken(refresh_token);
        access_token = renewed.access_token;
        refresh_token = renewed.refresh_token || refresh_token;
        saveRenewed(access_token, refresh_token, renewed.expires_in);
        console.log(`TikTok: token de ${accountLabel} renovado (proativo) em ${Date.now() - t0}ms`);
      }

      // Tenta buscar; se ainda assim der 401 (token revogado, relógio de expiração
      // impreciso etc), renova reativamente como antes.
      let videos;
      try {
        videos = await fetchTikTokVideos(access_token, limit);
      } catch (err) {
        if (err.response?.status === 401 && refresh_token) {
          const t0 = Date.now();
          console.log(`TikTok: renovando token de ${accountLabel} (401 reativo)...`);
          const renewed = await refreshToken(refresh_token);
          access_token = renewed.access_token;
          refresh_token = renewed.refresh_token || refresh_token;
          saveRenewed(access_token, refresh_token, renewed.expires_in);
          console.log(`TikTok: token de ${accountLabel} renovado (401 reativo) em ${Date.now() - t0}ms`);
          videos = await fetchTikTokVideos(access_token, limit);
        } else {
          throw err;
        }
      }

      console.log(`TikTok: ${accountLabel} OK — ${videos.length} vídeos em ${Date.now() - acctStart}ms`);
      for (const v of videos) {
        allPosts.push({
          id:             'tt_' + v.id,
          tt_video_id:    v.id,
          platform:       'tiktok',
          account_label:  accountLabel,
          media_type:     'TIKTOK',
          caption:        v.title || v.video_description || '',
          timestamp:      v.create_time ? new Date(v.create_time * 1000).toISOString() : '',
          like_count:     v.like_count    || 0,
          comments_count: v.comment_count || 0,
          view_count:     v.view_count    || 0,
          shares:         v.share_count   || 0,
          thumbnail_url:  v.cover_image_url || '',
          media_url:      v.cover_image_url || '',
          permalink:      v.share_url || `https://www.tiktok.com/@${accountLabel}/video/${v.id}`,
        });
      }
    } catch (err) {
      console.error(`Erro TikTok ${accountLabel} (status ${err.response?.status}, ${Date.now() - acctStart}ms):`, err.response?.data || err.message);
      failedAccounts.push(accountLabel);
    }
  }

  allPosts.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return { posts: allPosts, failedAccounts };
}

module.exports = { getTikTokPosts, getAuthUrl, exchangeCode, readTokens, writeTokensLocal, persistTokens };
