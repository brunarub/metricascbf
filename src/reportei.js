// src/reportei.js
// Integração com a API v2 do Reportei — usada pra puxar dados de Instagram de contas
// que não têm acesso direto via Meta Graph API (Brasileirão e Seleção Brasileira).
// Variável necessária no .env: REPORTEI_API_TOKEN=...

require('dotenv').config();
const axios = require('axios');

const API_BASE = 'https://app.reportei.com/api/v2';
const TOKEN = process.env.REPORTEI_API_TOKEN;

// account_label -> integration_id no Reportei (integração Instagram Business de cada
// conta). Descobertos via GET /v2/integrations?project_id=X: projeto "BR Feminino"
// (id 1050166, perfil @brfeminino) e "Seleção Brasileira" (id 1062369, perfil
// @selecaofemininadefutebol).
const ACCOUNTS = {
  brasileirao: { integrationId: 3278904 },
  selecao:     { integrationId: 3613462 },
};

// Definição fixa da métrica "media_datatable" do Instagram no Reportei — numa chamada
// só, ela já retorna a lista de posts do período COM os insights (reach, views,
// interações etc), diferente da Graph API que precisa de uma chamada por post.
const MEDIA_DATATABLE_METRIC = {
  id: 'db1de871-3355-42fb-8074-11e93df20c71',
  reference_key: 'ig:media_datatable',
  component: 'datatable_v1',
  metrics: ['type', 'reach', 'views', 'total_interactions', 'post_interactions_rate', 'likes', 'comments', 'saved', 'follows', 'profile_visits', 'shares', 'created_at'],
  dimensions: ['media'],
};

const TYPE_MAP = { Image: 'IMAGE', Carousel: 'CAROUSEL_ALBUM', Reels: 'REELS', Video: 'VIDEO' };

function fmtDate(d) {
  return d.toISOString().substring(0, 10);
}

// Busca os posts de uma conta nos últimos `daysBack` dias, já normalizados no mesmo
// formato usado pro resto do dashboard (mesma forma de src/tiktok.js/instagram.js).
async function fetchAccountPosts(accountLabel, integrationId, daysBack) {
  const end = new Date();
  const start = new Date(end.getTime() - daysBack * 24 * 60 * 60 * 1000);

  const res = await axios.post(`${API_BASE}/metrics/get-data`, {
    start: fmtDate(start),
    end: fmtDate(end),
    integration_id: integrationId,
    metrics: [MEDIA_DATATABLE_METRIC],
  }, {
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    timeout: 20000,
  });

  const result = res.data?.data?.[MEDIA_DATATABLE_METRIC.id];
  const rows = result?.values || [];

  return rows.map(row => {
    const [media, type, reach, views, total_interactions, post_interactions_rate, likes, comments, saved, follows, profile_visits, shares, created_at] = row;
    return {
      id: `rp_${accountLabel}_${media.id}`,
      platform: 'instagram',
      source: 'reportei',
      account_label: accountLabel,
      media_type: TYPE_MAP[type] || 'IMAGE',
      caption: media.text || '',
      timestamp: created_at,
      like_count: likes || 0,
      comments_count: comments || 0,
      permalink: media.url || '',
      thumbnail_url: media.cdn_image || '',
      media_url: media.cdn_image || '',
      // Insights já vêm nessa mesma chamada — sem precisar de uma 2ª etapa de
      // "loadInsights" como no Instagram nativo via Graph API.
      _insights: {
        views: views || 0,
        saved: saved || 0,
        shares: shares || 0,
        follows: follows || 0,
        total_interactions: total_interactions || 0,
        reach: reach || 0,
      },
    };
  });
}

// Retorna posts normalizados de todas as contas configuradas (Brasileirão + Seleção).
async function getReporteiPosts(daysBack = 180) {
  if (!TOKEN) return [];
  const allPosts = [];
  const entries = Object.entries(ACCOUNTS);
  for (let i = 0; i < entries.length; i++) {
    const [accountLabel, { integrationId }] = entries[i];
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, 300));
    try {
      const posts = await fetchAccountPosts(accountLabel, integrationId, daysBack);
      allPosts.push(...posts);
    } catch (err) {
      console.error(`Erro Reportei ${accountLabel}:`, err.response?.data || err.message);
    }
  }
  allPosts.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return allPosts;
}

module.exports = { getReporteiPosts };
