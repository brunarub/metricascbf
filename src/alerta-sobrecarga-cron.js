// src/alerta-sobrecarga-cron.js
// Cron diário (ver render.yaml) — verifica sobrecarga de jogos na escala e
// alerta a Bruna por email. Roda como job separado pelo mesmo motivo do
// resumo-semanal-cron.js: o serviço web pode dormir e perder o setTimeout/
// setInterval que fazia essa checagem antes.
require('dotenv').config();
const { getEscalaSemana, detectarSobrecarga } = require('./escala');
const { enviarAlertaSobrecarga } = require('./emails');
const { getCalendario } = require('./calendario');

(async () => {
  try {
    const dadosEscala = await getEscalaSemana();
    const jogos = await getCalendario().catch(() => []);

    const jogosAgrupados = {};
    for (const j of jogos) {
      const chave = j.data || j.date || '';
      if (!jogosAgrupados[chave]) jogosAgrupados[chave] = [];
      jogosAgrupados[chave].push(j);
    }

    const alertas = detectarSobrecarga(dadosEscala.diasPorData, jogosAgrupados);
    if (alertas.length > 0) {
      await enviarAlertaSobrecarga(alertas);
      console.log(`✅ Alerta enviado (${alertas.length} data(s) com sobrecarga)`);
    } else {
      console.log('ℹ️ Nenhuma sobrecarga detectada hoje');
    }
    process.exit(0);
  } catch (err) {
    console.error('❌ Erro ao verificar sobrecarga:', err.message);
    process.exit(1);
  }
})();
