require('dotenv').config();
const axios = require('axios');

const BASE_URL = `https://graph.facebook.com/${process.env.GRAPH_API_VERSION || 'v21.0'}`;
let currentToken = process.env.META_ACCESS_TOKEN;

function setToken(newToken) {
  currentToken = newToken;
  process.env.META_ACCESS_TOKEN = newToken;
}

// Troca o token atual por um novo de longa duração (~60 dias).
// Exige um app da Meta com META_APP_ID/META_APP_SECRET configurados.
async function refreshAccessToken() {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error('META_APP_ID e META_APP_SECRET precisam estar configurados para renovar o token');
  }

  const params = {
    grant_type: 'fb_exchange_token',
    client_id: appId,
    client_secret: appSecret,
    fb_exchange_token: currentToken,
  };
  const res = await axios.get(`${BASE_URL}/oauth/access_token`, { params });
  const { access_token, expires_in } = res.data;
  setToken(access_token);
  return { access_token, expires_in };
}

// Parseia a variável IG_ACCOUNTS="copa_do_brasil:123,brasileirao:456,brasileiras:789"
function getAccounts() {
  const raw = process.env.IG_ACCOUNTS || '';
  return raw.split(',').map(entry => {
    const [label, id] = entry.trim().split(':');
    return { label, id };
  }).filter(a => a.label && a.id);
}

// Busca posts básicos de uma conta (curtidas + comentários), paginando conforme necessário.
// limit = null busca TODO o histórico disponível da conta (segue os cursores até acabar).
async function getPostsBasic(accountId, limit = null) {
  const url = `${BASE_URL}/${accountId}/media`;
  const fields = 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count';
  const pageSize = 100; // máximo permitido por página pela Graph API

  let posts = [];
  let params = { fields, limit: pageSize, access_token: currentToken };

  while (!limit || posts.length < limit) {
    const res = await axios.get(url, { params });
    const page = res.data.data || [];
    posts = posts.concat(page);

    const after = res.data.paging?.cursors?.after;
    if (!res.data.paging?.next || !after || page.length === 0) break;
    params = { fields, limit: pageSize, after, access_token: currentToken };
  }

  return limit ? posts.slice(0, limit) : posts;
}

// Busca insights completos de um post específico.
// A API rejeita a chamada inteira se qualquer métrica pedida não for suportada
// pelo tipo de mídia do post (ex: "follows" não existe para Reels) — por isso,
// ao encontrar esse erro, removemos a métrica apontada e tentamos de novo.
async function getPostInsights(postId) {
  let metrics = ['reach', 'saved', 'shares', 'total_interactions', 'views', 'follows'];
  const url = `${BASE_URL}/${postId}/insights`;
  const unsupportedPatterns = [
    /does not support the (\w+) metric/i,
    /the (\w+) metric is no longer supported/i,
  ];

  while (true) {
    try {
      const params = { metric: metrics.join(','), access_token: currentToken };
      const res = await axios.get(url, { params });
      const result = {};
      (res.data.data || []).forEach(m => {
        result[m.name] = m.values ? m.values[0]?.value : m.value;
      });
      return result;
    } catch (err) {
      const message = err.response?.data?.error?.message || '';
      const unsupported = unsupportedPatterns.map(re => message.match(re)?.[1]).find(Boolean);
      if (unsupported && metrics.includes(unsupported)) {
        metrics = metrics.filter(m => m !== unsupported);
        continue;
      }
      throw err;
    }
  }
}

// Busca impressões diárias da conta em um período (inclui Stories, Reels, Feed).
// since/until = Unix timestamp (segundos).
async function getAccountInsights(accountId, since, until) {
  const url = `${BASE_URL}/${accountId}/insights`;
  const params = {
    metric: 'views',
    metric_type: 'total_value',
    period: 'day',
    since,
    until,
    access_token: currentToken,
  };
  const res = await axios.get(url, { params });
  const data = res.data.data || [];
  const metric = data.find(m => m.name === 'views');
  if (!metric) return 0;
  // com metric_type=total_value: total_value.value (soma do período)
  // ou values[] com { value, end_time } por dia — aceita os dois formatos
  if (metric.total_value?.value !== undefined) return metric.total_value.value;
  const values = metric.values || [];
  return values.reduce((s, v) => s + (v.value || 0), 0);
}

// Busca seguidores de uma conta
async function getFollowersCount(accountId) {
  const url = `${BASE_URL}/${accountId}`;
  const params = {
    fields: 'followers_count,username',
    access_token: currentToken,
  };
  const res = await axios.get(url, { params });
  return res.data;
}

// Busca posts publicados em uma data específica (YYYY-MM-DD, horário Brasília UTC-3)
async function getPostsByDate(accountId, dateStr) {
  const startOfDay = new Date(`${dateStr}T00:00:00-03:00`);
  const endOfDay = new Date(`${dateStr}T23:59:59-03:00`);

  const allPosts = await getPostsBasic(accountId, 50);
  return allPosts.filter(post => {
    const ts = new Date(post.timestamp);
    return ts >= startOfDay && ts <= endOfDay;
  });
}

module.exports = { getAccounts, getPostsBasic, getPostInsights, getFollowersCount, getAccountInsights, getPostsByDate, refreshAccessToken, setToken };
