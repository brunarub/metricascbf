// Script de cron mensal — chama /api/refresh-token no serviço web já em produção.
require('dotenv').config();
const http = require('http');
const https = require('https');

const dashboardUrl = process.env.DASHBOARD_URL;

if (!dashboardUrl) {
  console.error('❌ DASHBOARD_URL não configurada (URL do serviço web, ex: https://insta-dash-web.onrender.com)');
  process.exit(1);
}

const client = dashboardUrl.startsWith('https') ? https : http;
const req = client.request(`${dashboardUrl}/api/refresh-token`, { method: 'POST' }, (res) => {
  let body = '';
  res.on('data', (chunk) => { body += chunk; });
  res.on('end', () => {
    console.log(`Status: ${res.statusCode}`);
    console.log(body);
    process.exit(res.statusCode === 200 ? 0 : 1);
  });
});

req.on('error', (err) => {
  console.error('❌ Erro ao chamar /api/refresh-token:', err.message);
  process.exit(1);
});

req.end();
