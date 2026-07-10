// Diagnóstico: testa token Meta + planilha Google
require('dotenv').config();
const axios = require('axios');
const { google } = require('googleapis');

const BASE_URL = `https://graph.facebook.com/${process.env.GRAPH_API_VERSION || 'v21.0'}`;

async function testMeta() {
  console.log('\n🔵 Testando token Meta/Instagram...');
  try {
    const res = await axios.get(`${BASE_URL}/me`, {
      params: {
        fields: 'id,name',
        access_token: process.env.META_ACCESS_TOKEN,
      },
    });
    console.log(`  ✅ Token válido! Usuário: ${res.data.name} (${res.data.id})`);

    // Testa cada conta configurada
    const accounts = (process.env.IG_ACCOUNTS || '').split(',').map(e => {
      const [label, id] = e.trim().split(':');
      return { label, id };
    }).filter(a => a.label && a.id);

    if (accounts.length === 0) {
      console.log('  ⚠️  IG_ACCOUNTS não configurado');
    } else {
      for (const acc of accounts) {
        try {
          const r = await axios.get(`${BASE_URL}/${acc.id}`, {
            params: {
              fields: 'username,followers_count',
              access_token: process.env.META_ACCESS_TOKEN,
            },
          });
          console.log(`  ✅ ${acc.label}: @${r.data.username} — ${r.data.followers_count?.toLocaleString('pt-BR')} seguidores`);
        } catch (e) {
          console.log(`  ❌ ${acc.label} (${acc.id}): ${e.response?.data?.error?.message || e.message}`);
        }
      }
    }
  } catch (err) {
    console.log(`  ❌ Token inválido: ${err.response?.data?.error?.message || err.message}`);
  }
}

async function testSheets() {
  console.log('\n🟢 Testando conexão Google Sheets...');
  try {
    const auth = new google.auth.JWT({
      email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    await auth.authorize();

    const sheets = google.sheets({ version: 'v4', auth });
    const res = await sheets.spreadsheets.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
    });
    console.log(`  ✅ Planilha acessível: "${res.data.properties.title}"`);
  } catch (err) {
    console.log(`  ❌ Erro na planilha: ${err.message}`);
  }
}

async function main() {
  console.log('🔍 insta-dash — Diagnóstico de conexões');
  console.log('=========================================');

  if (!process.env.META_ACCESS_TOKEN) {
    console.log('  ⚠️  META_ACCESS_TOKEN não configurado — pulando teste Meta');
  } else {
    await testMeta();
  }

  if (!process.env.GOOGLE_SHEET_ID || !process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL) {
    console.log('\n  ⚠️  Google Sheets não configurado — pulando teste Sheets');
  } else {
    await testSheets();
  }

  console.log('\n=========================================');
  console.log('Diagnóstico concluído.');
}

main().catch(err => {
  console.error('Erro inesperado:', err);
  process.exit(1);
});
