// src/emails.js
// Emails via Resend: alertas de sobrecarga + resumo semanal para o time

const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

const BRUNA_EMAIL = 'bruna@road.ag';
const LINK_ESCALA = 'https://docs.google.com/spreadsheets/d/1q70NUkhhIt5Kk8mZTIJ6huDyEIXbEydgE1xj00pGWrk/edit';

// Todos os emails do time
const TIME_EMAILS = [
  'natalia@road.ag',
  'leocattari@outlook.com',
  'joanna@road.ag',
  'thais@road.ag',
  'henrique.dsgroad@gmail.com',
  'luiza@road.ag',
  'mariaclara.freitasroad@gmail.com',
  'gabrieladutton.road@gmail.com',
  'yveslara.road@gmail.com',
  'rafaelaroad97@gmail.com'
];

// Dias da semana em português
const DIAS_SEMANA = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const MESES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

function formatarData(dateObj) {
  const dia = DIAS_SEMANA[dateObj.getDay()];
  const d = String(dateObj.getDate()).padStart(2, '0');
  const m = MESES[dateObj.getMonth()];
  return `${dia}, ${d} ${m}`;
}

// ─────────────────────────────────────────────
// 1. ALERTA DE SOBRECARGA → bruna@road.ag
// ─────────────────────────────────────────────

function htmlAlertaSobrecarga(alertas) {
  const linhas = alertas.map(a => {
    const social = a.socaisEscalados.length > 0
      ? a.socaisEscalados.join(', ')
      : '⚠️ <strong>Nenhuma</strong>';

    const jogosLista = a.jogos.length > 0
      ? a.jogos.map(j => {
          const nome = j.nome || j.mandante || j.descricao || JSON.stringify(j);
          const hora = j.hora || j.horario || '';
          return `<li>${nome}${hora ? ` — ${hora}` : ''}</li>`;
        }).join('')
      : '<li>Jogos detectados no calendário</li>';

    return `
      <div style="background:#fff3cd;border-left:4px solid #e8a000;padding:16px;margin:16px 0;border-radius:4px;">
        <h3 style="margin:0 0 8px;color:#856404;">⚠️ ${a.data} — ${a.qtdJogos} jogos · ${a.qtdSociais === 0 ? '0 sociais' : `só ${a.qtdSociais} social`}</h3>
        <p style="margin:4px 0;"><strong>Social escalada:</strong> ${social}</p>
        <p style="margin:4px 0;"><strong>Jogos do dia:</strong></p>
        <ul style="margin:4px 0 0 20px;">${jogosLista}</ul>
      </div>
    `;
  }).join('');

  return `
    <!DOCTYPE html>
    <html>
    <body style="font-family:Arial,sans-serif;background:#f5f5f5;padding:20px;">
      <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1);">
        <div style="background:#003478;padding:24px;text-align:center;">
          <h1 style="color:#fff;margin:0;font-size:20px;">⚠️ Alerta de Escala — Sobrecarga detectada</h1>
        </div>
        <div style="padding:24px;">
          <p style="color:#333;">Olá, Bruna! Os dias abaixo têm <strong>3 ou mais jogos</strong> com poucas sociais escaladas. Verifique a escala.</p>
          ${linhas}
          <div style="text-align:center;margin-top:24px;">
            <a href="${LINK_ESCALA}" style="background:#003478;color:#fff;padding:12px 24px;text-decoration:none;border-radius:4px;font-weight:bold;">
              Abrir Planilha de Escala
            </a>
          </div>
        </div>
        <div style="background:#f0f0f0;padding:16px;text-align:center;font-size:12px;color:#888;">
          Enviado automaticamente pelo sistema CBF Hub
        </div>
      </div>
    </body>
    </html>
  `;
}

async function enviarAlertaSobrecarga(alertas) {
  if (!alertas || alertas.length === 0) return;

  const datasStr = alertas.map(a => a.data).join(', ');
  const assunto = `⚠️ Alerta de escala: ${datasStr} — sobrecarga de jogos`;

  try {
    const result = await resend.emails.send({
      from: 'CBF Hub <onboarding@resend.dev>',
      to: [BRUNA_EMAIL],
      subject: assunto,
      html: htmlAlertaSobrecarga(alertas)
    });
    console.log('✅ Email de alerta enviado para', BRUNA_EMAIL, result);
    return result;
  } catch (err) {
    console.error('❌ Erro ao enviar alerta de sobrecarga:', err.message);
    throw err;
  }
}

// ─────────────────────────────────────────────
// 2. RESUMO SEMANAL → todo o time (sexta 9h)
// ─────────────────────────────────────────────

function htmlResumoSemanal(nomeDestinatario, emailDestinatario, escalaFiltrada) {
  const dias = Object.entries(escalaFiltrada);

  const linhasDias = dias.map(([ddmm, info]) => {
    if (info.semDados) {
      return `
        <tr>
          <td style="padding:10px 8px;border-bottom:1px solid #eee;color:#999;">${formatarData(info.dateObj)} (${ddmm})</td>
          <td style="padding:10px 8px;border-bottom:1px solid #eee;color:#bbb;" colspan="2">Sem dados na escala</td>
        </tr>
      `;
    }

    // Verifica se o destinatário está escalado nesse dia
    const destinatarioEscalado = info.todos.some(p =>
      p.nome.toLowerCase().includes(nomeDestinatario.toLowerCase()) &&
      (p.status === 'T' || p.status.toUpperCase().includes('HC') || p.status === '1' || p.status.toLowerCase() === 'sim')
    );

    const statusCell = destinatarioEscalado
      ? `<span style="background:#003478;color:#fff;padding:2px 10px;border-radius:12px;font-size:12px;font-weight:bold;">Você está escalada</span>`
      : `<span style="background:#e9ecef;color:#666;padding:2px 10px;border-radius:12px;font-size:12px;">Folga</span>`;

    const outros = info.sociais.filter(n => !n.toLowerCase().includes(nomeDestinatario.toLowerCase()));
    const outrosStr = outros.length > 0
      ? outros.join(', ')
      : '—';

    return `
      <tr style="${destinatarioEscalado ? 'background:#f0f4ff;' : ''}">
        <td style="padding:10px 8px;border-bottom:1px solid #eee;font-weight:${destinatarioEscalado ? 'bold' : 'normal'};color:#333;">
          ${formatarData(info.dateObj)} (${ddmm})
        </td>
        <td style="padding:10px 8px;border-bottom:1px solid #eee;">${statusCell}</td>
        <td style="padding:10px 8px;border-bottom:1px solid #eee;color:#555;font-size:13px;">${outrosStr}</td>
      </tr>
    `;
  }).join('');

  return `
    <!DOCTYPE html>
    <html>
    <body style="font-family:Arial,sans-serif;background:#f5f5f5;padding:20px;">
      <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1);">
        <div style="background:#003478;padding:24px;text-align:center;">
          <h1 style="color:#fff;margin:0 0 4px;font-size:22px;">Escala da Semana</h1>
          <p style="color:#90b8e8;margin:0;font-size:14px;">Próximos 9 dias</p>
        </div>
        <div style="padding:24px;">
          <p style="color:#333;font-size:15px;">Olá! Aqui está a escala dos próximos dias.</p>

          <table style="width:100%;border-collapse:collapse;font-size:14px;">
            <thead>
              <tr style="background:#f8f9fa;">
                <th style="padding:10px 8px;text-align:left;border-bottom:2px solid #003478;color:#003478;">Data</th>
                <th style="padding:10px 8px;text-align:left;border-bottom:2px solid #003478;color:#003478;">Sua escala</th>
                <th style="padding:10px 8px;text-align:left;border-bottom:2px solid #003478;color:#003478;">Outros sociais</th>
              </tr>
            </thead>
            <tbody>
              ${linhasDias}
            </tbody>
          </table>

          <div style="margin-top:20px;padding:12px;background:#f8f9fa;border-radius:4px;font-size:13px;color:#666;">
            💡 Para ver a escala completa com toda a equipe, acesse a planilha:
            <a href="${LINK_ESCALA}" style="color:#003478;font-weight:bold;">Planilha de Escala</a>
          </div>
        </div>
        <div style="background:#f0f0f0;padding:16px;text-align:center;font-size:12px;color:#888;">
          Enviado automaticamente toda sexta-feira pelo CBF Hub
        </div>
      </div>
    </body>
    </html>
  `;
}

// Extrai o primeiro nome a partir do email (para personalizar)
function primeiroNomeDoEmail(email) {
  const parte = email.split('@')[0];
  // Remove números e pontos, pega primeira palavra
  return parte.replace(/[0-9]/g, '').split(/[._-]/)[0];
}

async function enviarResumoSemanal(escalaFiltrada) {
  console.log('📧 Enviando resumo semanal para o time...');
  const resultados = [];

  for (const email of TIME_EMAILS) {
    const nome = primeiroNomeDoEmail(email);

    try {
      const result = await resend.emails.send({
        from: 'CBF Hub <onboarding@resend.dev>',
        to: [email],
        subject: `📅 Escala da semana — ${new Date().toLocaleDateString('pt-BR')}`,
        html: htmlResumoSemanal(nome, email, escalaFiltrada)
      });
      console.log(`  ✅ Enviado para ${email}`);
      resultados.push({ email, ok: true });
    } catch (err) {
      console.error(`  ❌ Erro ao enviar para ${email}:`, err.message);
      resultados.push({ email, ok: false, erro: err.message });
    }

    // Pequena pausa para não estourar rate limit
    await new Promise(r => setTimeout(r, 300));
  }

  return resultados;
}

module.exports = { enviarAlertaSobrecarga, enviarResumoSemanal };
