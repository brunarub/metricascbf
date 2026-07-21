// src/resumo-semanal-cron.js
// Cron semanal (ver render.yaml) — envia o resumo de escala para o time.
// Roda como job separado (não depende do serviço web estar "acordado"),
// porque no plano free do Render o serviço web dorme após ~15min sem tráfego
// e um setTimeout agendado para dias no futuro é perdido quando isso acontece.
require('dotenv').config();
const { getEscalaProxDias } = require('./escala');
const { enviarResumoSemanal } = require('./emails');

(async () => {
  try {
    const { escalaFiltrada } = await getEscalaProxDias(9);
    const resultados = await enviarResumoSemanal(escalaFiltrada);
    const falhas = resultados.filter(r => !r.ok);
    if (falhas.length > 0) {
      console.error(`⚠️ ${falhas.length} email(s) falharam:`, falhas);
      process.exit(1);
    }
    console.log(`✅ Resumo semanal enviado para ${resultados.length} pessoa(s)`);
    process.exit(0);
  } catch (err) {
    console.error('❌ Erro ao enviar resumo semanal:', err.message);
    process.exit(1);
  }
})();
