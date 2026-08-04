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

// Retorna posts normalizados de todas as contas TikTok conectadas
async function getTikTokPosts() {
  const tokens = readTokens();
  const allPosts = [];

  const entries = Object.entries(tokens);
  for (let i = 0; i < entries.length; i++) {
    const [accountLabel, tokenData] = entries[i];
    if (!tokenData?.access_token) continue;

    if (i > 0) await sleep(500);

    try {
      let { access_token, refresh_token } = tokenData;

      // Tenta buscar; se der 401, renova o token
      let videos;
      try {
        videos = await fetchTikTokVideos(access_token);
      } catch (err) {
        if (err.response?.status === 401 && refresh_token) {
          console.log(`TikTok: renovando token de ${accountLabel}...`);
          const renewed = await refreshToken(refresh_token);
          access_token = renewed.access_token;
          refresh_token = renewed.refresh_token || refresh_token;
          // Persiste token renovado
          const updated = readTokens();
          updated[accountLabel] = { ...tokenData, access_token, refresh_token };
          await persistTokens(updated);
          videos = await fetchTikTokVideos(access_token);
        } else {
          throw err;
        }
      }

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
      console.error(`Erro TikTok ${accountLabel} (status ${err.response?.status}):`, err.response?.data || err.message);
    }
  }

  allPosts.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return allPosts;
}

module.exports = { getTikTokPosts, getAuthUrl, exchangeCode, readTokens, writeTokensLocal, persistTokens };
