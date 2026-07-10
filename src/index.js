// Script de sincronização diária — busca posts de D-1 e salva no Google Sheets
require('dotenv').config();
const { getAccounts, getPostsBasic, getPostInsights } = require('./instagram');
const { upsertPost } = require('./sheets');
const { compareWithPrevious } = require('./metrics');

function getYesterdayBrasilia() {
  const now = new Date();
  // Ajusta para UTC-3
  const brasilia = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  brasilia.setDate(brasilia.getDate() - 1);
  return brasilia.toISOString().split('T')[0]; // YYYY-MM-DD
}

async function syncAccount(account) {
  console.log(`\n📱 Sincronizando: ${account.label} (${account.id})`);
  const yesterday = getYesterdayBrasilia();
  console.log(`  Buscando posts de: ${yesterday}`);

  // Busca os últimos 50 posts para filtrar por data
  const allPosts = await getPostsBasic(account.id, 50);
  const startOfDay = new Date(`${yesterday}T00:00:00-03:00`);
  const endOfDay = new Date(`${yesterday}T23:59:59-03:00`);

  const dayPosts = allPosts.filter(post => {
    const ts = new Date(post.timestamp);
    return ts >= startOfDay && ts <= endOfDay;
  });

  console.log(`  Encontrados ${dayPosts.length} posts em ${yesterday}`);

  for (const post of dayPosts) {
    console.log(`  Coletando insights: ${post.id}`);
    const insights = await getPostInsights(post.id);
    post.insights = insights;
    post.account_label = account.label;

    // Calcula comparação com posts anteriores
    const previousPosts = allPosts
      .filter(p => p.id !== post.id)
      .map(p => ({ ...p, account_label: account.label }));
    const comparison = compareWithPrevious({ ...post, account_label: account.label }, previousPosts);

    await upsertPost(post, comparison);

    // Pequena pausa para não estourar rate limit
    await new Promise(r => setTimeout(r, 500));
  }
}

async function main() {
  console.log('🚀 Iniciando sync diário do insta-dash...');
  console.log(`   Data: ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`);

  const accounts = getAccounts();
  if (accounts.length === 0) {
    console.error('❌ Nenhuma conta configurada em IG_ACCOUNTS');
    process.exit(1);
  }

  for (const account of accounts) {
    try {
      await syncAccount(account);
    } catch (err) {
      console.error(`❌ Erro em ${account.label}:`, err.response?.data || err.message);
    }
  }

  console.log('\n✅ Sync concluído!');
}

main().catch(err => {
  console.error('❌ Erro fatal:', err);
  process.exit(1);
});
