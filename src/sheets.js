require('dotenv').config();
const { google } = require('googleapis');

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_TAB = process.env.GOOGLE_SHEET_TAB || 'Posts';

const HEADERS = [
  'ID do Post',
  'Data de Publicação',
  'Perfil',
  'Plataforma',
  'Link do Post',
  'Tipo de Conteúdo',
  'Legenda',
  'Alcance',
  'Impressões',
  'Visualizações/Reproduções',
  'Curtidas',
  'Comentários',
  'Compartilhamentos',
  'Salvamentos',
  'Interações Totais',
  'Taxa de Engajamento (%)',
  'Visualizações Seguidores',
  'Visualizações Não Seguidores',
  'Comparação vs Média Anterior (%)',
  'Última Atualização',
];

async function getAuth() {
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  await auth.authorize();
  return auth;
}

async function getSheets() {
  const auth = await getAuth();
  return google.sheets({ version: 'v4', auth });
}

// Garante que o cabeçalho existe na planilha
async function ensureHeaders(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A1:T1`,
  });
  const firstRow = res.data.values?.[0] || [];
  if (firstRow.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [HEADERS] },
    });
  }
}

// Lê todos os IDs de posts existentes na planilha
async function getExistingPostIds(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A:A`,
  });
  const rows = res.data.values || [];
  return rows.slice(1).map(r => r[0]).filter(Boolean);
}

// Converte um post para linha da planilha
function postToRow(post, comparisonPct) {
  const insights = post.insights || {};
  const interactions = (post.like_count || 0) + (post.comments_count || 0) +
    (insights.saved || 0) + (insights.shares || 0);
  const reach = insights.reach || '';
  const engRate = reach ? ((interactions / reach) * 100).toFixed(2) : '';

  return [
    post.id,
    post.timestamp ? new Date(post.timestamp).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '',
    post.account_label || '',
    'Instagram',
    post.permalink || '',
    post.media_type || '',
    (post.caption || '').substring(0, 300),
    reach,
    insights.impressions || '',
    insights.plays || insights.video_views || '',
    post.like_count || 0,
    post.comments_count || 0,
    insights.shares || '',
    insights.saved || '',
    interactions,
    engRate,
    insights.ig_reels_video_view_total_time || '',
    '',
    comparisonPct !== null ? comparisonPct : '',
    new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
  ];
}

// Upsert: atualiza linha existente ou adiciona nova
async function upsertPost(post, comparisonPct = null) {
  const sheets = await getSheets();
  await ensureHeaders(sheets);

  const existingIds = await getExistingPostIds(sheets);
  const row = postToRow(post, comparisonPct);
  const existingIndex = existingIds.indexOf(post.id);

  if (existingIndex >= 0) {
    // Linha existe — atualiza (linha 2 = index 0, então +2)
    const rowNumber = existingIndex + 2;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB}!A${rowNumber}`,
      valueInputOption: 'RAW',
      requestBody: { values: [row] },
    });
    console.log(`  Atualizado: ${post.id}`);
  } else {
    // Novo post — adiciona no final
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB}!A1`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] },
    });
    console.log(`  Adicionado: ${post.id}`);
  }
}

module.exports = { upsertPost };
