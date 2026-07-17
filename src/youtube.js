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

// Busca IDs dos uploads recentes de um canal (via uploads playlist)
async function getUploadIds(channelId, maxResults) {
  const apiKey = process.env.YT_API_KEY;
  // A playlist de uploads de um canal tem ID "UU" + channelId[2:]
  const playlistId = 'UU' + channelId.slice(2);
  const ids = [];
  let pageToken = null;

  while (ids.length < maxResults) {
    const params = {
      part: 'contentDetails',
      playlistId,
      maxResults: Math.min(50, maxResults - ids.length),
      key: apiKey,
    };
    if (pageToken) params.pageToken = pageToken;

    const res = await axios.get(`${BASE_URL}/playlistItems`, { params });
    const items = res.data.items || [];
    items.forEach(item => ids.push(item.contentDetails.videoId));

    pageToken = res.data.nextPageToken;
    if (!pageToken || items.length === 0) break;
  }

  return ids;
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

// Retorna posts normalizados de todos os canais YouTube configurados.
// media_type = 'SHORTS' se duração ≤ 60s, 'VIDEO' caso contrário.
async function getYouTubePosts(maxResults = 50) {
  const accounts = getYouTubeAccounts();
  const allPosts = [];

  for (const account of accounts) {
    try {
      const videoIds = await getUploadIds(account.id, maxResults);
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
          view_count:     parseInt(stats.viewCount    || 0),
          thumbnail_url:  thumb,
          media_url:      thumb,
          permalink:      `https://www.youtube.com/watch?v=${video.id}`,
          duration_sec:   durSec,
        });
      }
    } catch (err) {
      console.error(`Erro YouTube ${account.label}:`, err.response?.data?.error || err.message);
    }
  }

  allPosts.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return allPosts;
}

module.exports = { getYouTubePosts, getYouTubeAccounts };
