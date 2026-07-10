require('dotenv').config();
const axios = require('axios');

const BASE_URL = `https://graph.facebook.com/${process.env.GRAPH_API_VERSION || 'v21.0'}`;
const TOKEN = process.env.META_ACCESS_TOKEN;

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
  let params = { fields, limit: pageSize, access_token: TOKEN };

  while (!limit || posts.length < limit) {
    const res = await axios.get(url, { params });
    const page = res.data.data || [];
    posts = posts.concat(page);

    const after = res.data.paging?.cursors?.after;
    if (!res.data.paging?.next || !after || page.length === 0) break;
    params = { fields, limit: pageSize, after, access_token: TOKEN };
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
      const params = { metric: metrics.join(','), access_token: TOKEN };
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

// Busca seguidores de uma conta
async function getFollowersCount(accountId) {
  const url = `${BASE_URL}/${accountId}`;
  const params = {
    fields: 'followers_count,username',
    access_token: TOKEN,
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

module.exports = { getAccounts, getPostsBasic, getPostInsights, getFollowersCount, getPostsByDate };
