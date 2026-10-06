// src/youtube.js
// Busca vídeos (Shorts e longos) dos canais YouTube via YouTube Data API v3.
// Variáveis necessárias no .env:
//   YT_API_KEY=...
//   YT_ACCOUNTS=copa_do_brasil:UCNXqgvltbKmIBj5ot66slNg,brasileiras:UCALGUym7Kxp-qK20rOtFPzw,brasileirao:UCeWivzR7k1Fmg6juZVJyB2Q

require('dotenv').config();
const axios = require('axios');

const BASE_URL = 'https://www.googleapis.com/youtube/v3';

function getYouTubeAccounts() {
  const raw = process.env.YT_ACCOUNTS || '';
  return raw.split(',').map(entry => {
    const idx = entry.trim().indexOf(':');
    if (idx < 0) return null;
    const label = entry.trim().slice(0, idx);
    const id    = entry.trim().slice(idx + 1);
    return { label, id };
  }).filter(a => a && a.label && a.id);
}

// Parseia duração ISO 8601 (PT1M30S) em segundos
function parseDurationSeconds(iso) {
  if (!iso) return 0;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (parseInt(m[1] || 0) * 3600) +
         (parseInt(m[2] || 0) * 60)  +
          parseInt(m[3] || 0);
}

// Busca IDs dos uploads de um canal (via uploads playlist), paginando até cobrir
// `sinceTs` (timestamp em ms) ou até o teto de segurança `safetyLimit` — NÃO busca
// mais um número fixo de vídeos ("últimos N"). A playlist de uploads de um canal
// (ID "UU" + channelId[2:]) devolve os vídeos mais recentes primeiro; cada item já
// traz `contentDetails.videoPublishedAt`, então dá pra decidir quando parar sem
// precisar de uma chamada extra a /videos.
//
// "Cobrir sinceTs" = já vimos, em alguma página, um vídeo publicado antes de sinceTs
// — nesse ponto já temos todos os vídeos entre sinceTs e agora. Usa o MÍNIMO de
// videoPublishedAt de toda a página (não só o último item) — mais seguro que assumir
// uma ordem interna estrita da página, que a documentação da API não garante.
//
// Se o teto de segurança for atingido antes de cobrir sinceTs, devolve truncated=true
// e oldestFetchedTs = a data do vídeo mais antigo buscado, pra quem chamou saber até
// onde os dados são confiáveis em vez de fingir cobertura total.
async function getUploadIds(channelId, sinceTs, safetyLimit) {
  const apiKey = process.env.YT_API_KEY;
  const playlistId = 'UU' + channelId.slice(2);
  const ids = [];
  let pageToken = null;
  let apiHasMore = true;
  let coveredSince = false;
  let oldestFetchedTs = null;

  while (apiHasMore && ids.length < safetyLimit && !coveredSince) {
    const params = {
      part: 'contentDetails',
      playlistId,
      maxResults: Math.min(50, safetyLimit - ids.length),
      key: apiKey,
    };
    if (pageToken) params.pageToken = pageToken;

    const res = await axios.get(`${BASE_URL}/playlistItems`, { params });
    const items = res.data.items || [];
    if (items.length === 0) break;
    items.forEach(item => ids.push(item.contentDetails.videoId));

    const publishedTimes = items
      .map(item => item.contentDetails?.videoPublishedAt ? new Date(item.contentDetails.videoPublishedAt).getTime() : null)
      .filter(t => t !== null);
    if (publishedTimes.length) {
      const oldestInPageTs = Math.min(...publishedTimes);
      if (oldestFetchedTs === null || oldestInPageTs < oldestFetchedTs) oldestFetchedTs = oldestInPageTs;
      if (oldestInPageTs < sinceTs) coveredSince = true;
    }

    pageToken = res.data.nextPageToken;
    apiHasMore = !!pageToken;
  }

  const truncated = apiHasMore && !coveredSince;
  return { ids: ids.slice(0, safetyLimit), truncated, oldestFetchedTs };
}

// Busca detalhes de até 50 vídeos por chamada (estatísticas + duração + snippet)
async function getVideoDetails(videoIds) {
  if (!videoIds.length) return [];
  const apiKey = process.env.YT_API_KEY;
  const all = [];

  for (let i = 0; i < videoIds.length; i += 50) {
    const chunk = videoIds.slice(i, i + 50);
    const res = await axios.get(`${BASE_URL}/videos`, {
      params: {
        part: 'snippet,statistics,contentDetails',
        id: chunk.join(','),
        key: apiKey,
      }
    });
    all.push(...(res.data.items || []));
  }
  return all;
}

const DEFAULT_LOOKBACK_DAYS = 30;
const SAFETY_LIMIT_PER_ACCOUNT = 400;

// Retorna posts normalizados de todos os canais YouTube configurados, junto com a
// lista de canais que falharam — sem isso, uma falha (timeout, quota da API etc)
// vira silenciosamente "0 vídeos", indistinguível de um canal sem posts no período.
// media_type = 'SHORTS' se duração ≤ 60s, 'VIDEO' caso contrário.
//
// since: cobre o histórico até essa data (Date, timestamp ou string ISO) em vez de um
// número fixo de vídeos — mesmo princípio e mesmo motivo de getTikTokPosts em
// src/tiktok.js (um limit fixo trunca silenciosamente um filtro de período longo).
// Sem since, usa os últimos 30 dias por padrão.
async function getYouTubePosts({ since, safetyLimit = SAFETY_LIMIT_PER_ACCOUNT } = {}) {
  const sinceTs = since ? new Date(since).getTime() : Date.now() - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const accounts = getYouTubeAccounts();
  const allPosts = [];
  const failedAccounts = [];
  // truncated/coveredSinceTs: ver getUploadIds — coveredSinceTs é o pior caso (mais
  // recente = menos cobertura) entre os canais que deram certo.
  let truncated = false;
  let coveredSinceTs = sinceTs;

  for (const account of accounts) {
    try {
      const { ids: videoIds, truncated: acctTruncated, oldestFetchedTs } = await getUploadIds(account.id, sinceTs, safetyLimit);
      if (acctTruncated) {
        truncated = true;
        const acctCoveredSinceTs = oldestFetchedTs ?? sinceTs;
        if (acctCoveredSinceTs > coveredSinceTs) coveredSinceTs = acctCoveredSinceTs;
        console.log(`YouTube: ${account.label} TRUNCADO — atingiu o teto de ${safetyLimit} vídeos antes de cobrir o período pedido; cobre só até ${new Date(acctCoveredSinceTs).toISOString().substring(0, 10)}`);
      }
      if (!videoIds.length) continue;

      const videos = await getVideoDetails(videoIds);

      for (const video of videos) {
        const durSec  = parseDurationSeconds(video.contentDetails?.duration);
        const isShort = durSec > 0 && durSec <= 60;
        const stats   = video.statistics || {};
        const snippet = video.snippet   || {};
        const thumb   = snippet.thumbnails?.medium?.url ||
                        snippet.thumbnails?.default?.url || '';

        allPosts.push({
          id:             'yt_' + video.id,
          yt_video_id:    video.id,
          platform:       'youtube',
          account_label:  account.label,
          account_id:     account.id,
          media_type:     isShort ? 'SHORTS' : 'VIDEO',
          caption:        snippet.title || '',
          timestamp:      snippet.publishedAt || '',
          like_count:     parseInt(stats.likeCount    || 0),
          comments_count: parseInt(stats.commentCount || 0),
          // view_count = statistics.viewCount da videos.list (Data API v3, pública, só
          // API key) — é o total VITALÍCIO de views do vídeo desde a publicação, NÃO
          // views ganhas dentro de um período específico. Não é a mesma métrica que o
          // YouTube Studio mostra quando você filtra por data (esse usa a Analytics
          // API, `reports.query` com metric=views + startDate/endDate, que exige OAuth
          // do dono do canal — não implementado aqui). Isso é esperado divergir do
          // Studio: um vídeo publicado ANTES do período filtrado mas incluído porque
          // segue recebendo views continua contando o total acumulado dele, não só o
          // que ganhou nesse período — por isso o dashboard tende a mostrar MAIS do
          // que o Studio quando o filtro pega vídeos com alguns dias/semanas de idade.
          // Bater exatamente com o Studio é um projeto à parte (Analytics API + OAuth).
          view_count:     parseInt(stats.viewCount    || 0),
          thumbnail_url:  thumb,
          media_url:      thumb,
          permalink:      `https://www.youtube.com/watch?v=${video.id}`,
          duration_sec:   durSec,
        });
      }
    } catch (err) {
      console.error(`Erro YouTube ${account.label}:`, err.response?.data?.error || err.message);
      failedAccounts.push(account.label);
    }
  }

  allPosts.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return { posts: allPosts, failedAccounts, truncated, coveredSince: new Date(coveredSinceTs).toISOString().substring(0, 10) };
}

module.exports = { getYouTubePosts, getYouTubeAccounts };
