// src/emails.js
// Emails via Gmail (nodemailer): alertas de sobrecarga + resumo semanal para o time

const axios = require('axios');

const BRUNA_EMAIL = 'bruna@road.ag';
const LINK_ESCALA = 'https://docs.google.com/spreadsheets/d/1q70NUkhhIt5Kk8mZTIJ6huDyEIXbEydgE1xj00pGWrk/edit';

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

const DIAS_SEMANA = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const MESES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

function formatarData(dateObj) {
  const dia = DIAS_SEMANA[dateObj.getDay()];
  const d = String(dateObj.getDate()).padStart(2, '0');
  const m = MESES[dateObj.getMonth()];
  return `${dia}, ${d} ${m}`;
}

// Envia email via Brevo HTTP API (sem SMTP — funciona no Render free tier)
async function enviarBrevo({ to, subject, html }) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) throw new Error('BREVO_API_KEY não configurada');

  const toArr = Array.isArray(to) ? to : [{ email: to }];

  await axios.post('https://api.brevo.com/v3/smtp/email', {
    sender: { name: 'CBF Hub', email: process.env.BREVO_SENDER || 'copadobrasilfeminina@gmail.com' },
    to: toArr,
    subject,
    htmlContent: html
  }, {
    headers: {
      'api-key': apiKey,
      'Content-Type': 'application/json'
    },
    timeout: 15000
  });
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
    <!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#f5f5f5;padding:20px;">
      <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1);">
        <div style="background:#003478;padding:24px;text-align:center;">
          <h1 style="color:#fff;margin:0;font-size:20px;">⚠️ Alerta de Escala — Sobrecarga detectada</h1>
        </div>
        <div style="padding:24px;">
          <p style="color:#333;">Olá, Bruna! Os dias abaixo têm <strong>3 ou mais jogos</strong> com poucas sociais escaladas.</p>
          ${linhas}
          <div style="text-align:center;margin-top:24px;">
            <a href="${LINK_ESCALA}" style="background:#003478;color:#fff;padding:12px 24px;text-decoration:none;border-radius:4px;font-weight:bold;">Abrir Planilha de Escala</a>
          </div>
        </div>
        <div style="background:#f0f0f0;padding:16px;text-align:center;font-size:12px;color:#888;">Enviado automaticamente pelo CBF Hub</div>
      </div>
    </body></html>
  `;
}

async function enviarAlertaSobrecarga(alertas) {
  if (!alertas || alertas.length === 0) return;
  const datasStr = alertas.map(a => a.data).join(', ');
  try {
    await enviarBrevo({
      to: BRUNA_EMAIL,
      subject: `⚠️ Alerta de escala: ${datasStr} — sobrecarga de jogos`,
      html: htmlAlertaSobrecarga(alertas)
    });
    console.log('✅ Alerta enviado para', BRUNA_EMAIL);
  } catch (err) {
    console.error('❌ Erro ao enviar alerta:', err.response?.data || err.message);
    throw err;
  }
}

// ─────────────────────────────────────────────
// 2. RESUMO SEMANAL → todo o time (sexta 9h)
// ─────────────────────────────────────────────

const JOGOS_KW = ['brasileirão','brasileirao','copa','libertadores','sulamericana','in loco'];
function ehJogo(s) { return s && JOGOS_KW.some(k => s.toLowerCase().includes(k)); }

// Encontra a pessoa na escala pelo nome (parcial, case-insensitive)
function encontrarPessoa(todos, nome) {
  return todos?.find(p => p.nome.toLowerCase().includes(nome.toLowerCase()));
}

// Retorna string descritiva do horário para exibição no email
function descHorario(p) {
  if (!p) return '';
  if (ehJogo(p.status)) {
    if (p.horarioCalculado) return `⚽ Plantão ${p.horarioCalculado}`;
    return `⚽ ${p.status} (horário normal)`;
  }
  if (/\d+h/.test(p.status)) return `🕐 Plantão ${p.status}`;
  return '✓ Horário normal';
}

// Seção "Jogos que você cobre" — aparece só quando há cobertura de jogo
function secaoJogosPessoa(todos, nomePessoa) {
  const meus = (todos || []).filter(p =>
    p.nome.toLowerCase().includes(nomePessoa.toLowerCase()) &&
    (ehJogo(p.status) || p.jogoCobertura)
  );
  if (!meus.length) return '';

  const linhas = meus.map(p => {
    const jc = p.jogoCobertura;
    const jogo = jc ? `${jc.mandante} × ${jc.visitante} (${jc.hora || '?'})` : p.status;
    const horario = p.horarioCalculado ? ` · <strong>${p.horarioCalculado}</strong>` : ' · horário normal';

    // Encontra parceiro no mesmo dia (role diferente com cobertura de jogo)
    // Isso é apenas o que o servidor já injetou em todos[]
    return `<li style="margin-bottom:6px;">${jogo}${horario}</li>`;
  }).join('');

  return `
    <div style="background:#fff8f0;border-left:4px solid #e65100;padding:12px 16px;margin:16px 0;border-radius:4px;">
      <strong style="color:#e65100;">⚽ Jogos que você cobre</strong>
      <ul style="margin:8px 0 0 16px;padding:0;font-size:13px;color:#333;">${linhas}</ul>
    </div>`;
}

// Seção de duplas de cobertura para cada dia com jogo
function secaoDuplasDia(todos, ddmm, dateObj) {
  const comJogo = (todos || []).filter(p => ehJogo(p.status) || p.jogoCobertura);
  if (!comJogo.length) return '';
  const sociais   = comJogo.filter(p => p.role === 'SOCIAL').map(p => p.nome).join(', ') || '⚠️ Nenhuma';
  const designers = comJogo.filter(p => p.role === 'DESIGNER').map(p => p.nome).join(', ') || '⚠️ Nenhum';
  const jc = comJogo.find(p => p.jogoCobertura)?.jogoCobertura;
  const jogoStr = jc ? `${jc.mandante} × ${jc.visitante}` : 'Jogo';
  return `<tr>
    <td style="padding:8px;border-bottom:1px solid #eee;font-size:13px;color:#333;">${formatarData(dateObj)}</td>
    <td style="padding:8px;border-bottom:1px solid #eee;font-size:13px;">${jogoStr}</td>
    <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px;color:#1565c0;">${sociais}</td>
    <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px;color:#880e4f;">${designers}</td>
  </tr>`;
}

function htmlResumoSemanal(nomeDestinatario, roleDestinatario, escalaFiltrada) {
  const dias = Object.entries(escalaFiltrada);

  // Linhas da tabela principal (todos os dias)
  const linhasDias = dias.map(([ddmm, info]) => {
    if (info.semDados) {
      return `<tr><td colspan="3" style="padding:10px 8px;border-bottom:1px solid #eee;color:#bbb;">${formatarData(info.dateObj)} — sem dados</td></tr>`;
    }
    const eu = encontrarPessoa(info.todos, nomeDestinatario);
    const trabalhando = eu && eu.status && eu.status.toLowerCase() !== 'folga' && eu.status !== '';
    const horarioDesc = trabalhando ? descHorario(eu) : null;

    const statusCell = trabalhando
      ? `<span style="background:#003478;color:#fff;padding:2px 10px;border-radius:12px;font-size:12px;font-weight:bold;">${horarioDesc}</span>`
      : `<span style="background:#e9ecef;color:#666;padding:2px 10px;border-radius:12px;font-size:12px;">Folga</span>`;

    // Coluna 3: parceiro dependendo do role
    let parceiros = '—';
    if (trabalhando) {
      if (roleDestinatario === 'SOCIAL') {
        const ds = (info.designers || []).filter(n => !n.toLowerCase().includes(nomeDestinatario.toLowerCase()));
        parceiros = ds.length ? `🎨 ${ds.join(', ')}` : '—';
      } else {
        const ss = (info.sociais || []).filter(n => !n.toLowerCase().includes(nomeDestinatario.toLowerCase()));
        parceiros = ss.length ? `📱 ${ss.join(', ')}` : '—';
      }
    }

    return `
      <tr style="${trabalhando ? 'background:#f0f4ff;' : ''}">
        <td style="padding:10px 8px;border-bottom:1px solid #eee;color:#333;font-weight:${trabalhando ? 'bold' : 'normal'}">${formatarData(info.dateObj)} (${ddmm})</td>
        <td style="padding:10px 8px;border-bottom:1px solid #eee;">${statusCell}</td>
        <td style="padding:10px 8px;border-bottom:1px solid #eee;font-size:13px;color:#555;">${parceiros}</td>
      </tr>`;
  }).join('');

  // Seção de jogos desta semana (só dias com cobertura)
  const linhasJogos = dias
    .filter(([, info]) => !info.semDados && (info.todos || []).some(p => ehJogo(p.status) || p.jogoCobertura))
    .map(([ddmm, info]) => secaoDuplasDia(info.todos, ddmm, info.dateObj))
    .join('');

  const secaoJogos = linhasJogos ? `
    <h3 style="color:#e65100;font-size:15px;margin:20px 0 8px;">⚽ Jogos da semana — duplas de cobertura</h3>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead><tr style="background:#fff3e0;">
        <th style="padding:8px;text-align:left;border-bottom:2px solid #e65100;color:#e65100;">Data</th>
        <th style="padding:8px;text-align:left;border-bottom:2px solid #e65100;color:#e65100;">Jogo</th>
        <th style="padding:8px;text-align:left;border-bottom:2px solid #e65100;color:#1565c0;">Social</th>
        <th style="padding:8px;text-align:left;border-bottom:2px solid #e65100;color:#880e4f;">Designer</th>
      </tr></thead>
      <tbody>${linhasJogos}</tbody>
    </table>` : '';

  // Meus jogos desta semana
  const todosFlat = dias.flatMap(([, info]) => info.todos || []);
  const meusJogos = secaoJogosPessoa(todosFlat, nomeDestinatario);

  const col3Header = roleDestinatario === 'SOCIAL' ? 'Designer parceiro' : 'Social parceira';

  return `
    <!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#f5f5f5;padding:20px;">
      <div style="max-width:620px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1);">
        <div style="background:#003478;padding:24px;text-align:center;">
          <h1 style="color:#fff;margin:0 0 4px;font-size:22px;">Escala da Semana</h1>
          <p style="color:#90b8e8;margin:0;font-size:14px;">Próximos 9 dias</p>
        </div>
        <div style="padding:24px;">
          ${meusJogos}
          ${secaoJogos}
          <h3 style="color:#003478;font-size:15px;margin:20px 0 8px;">📅 Sua escala completa</h3>
          <table style="width:100%;border-collapse:collapse;font-size:14px;">
            <thead><tr style="background:#f8f9fa;">
              <th style="padding:10px 8px;text-align:left;border-bottom:2px solid #003478;color:#003478;">Data</th>
              <th style="padding:10px 8px;text-align:left;border-bottom:2px solid #003478;color:#003478;">Sua escala</th>
              <th style="padding:10px 8px;text-align:left;border-bottom:2px solid #003478;color:#003478;">${col3Header}</th>
            </tr></thead>
            <tbody>${linhasDias}</tbody>
          </table>
          <div style="margin-top:16px;padding:12px;background:#f8f9fa;border-radius:4px;font-size:13px;color:#666;">
            💡 <a href="${LINK_ESCALA}" style="color:#003478;font-weight:bold;">Ver planilha completa</a>
          </div>
        </div>
        <div style="background:#f0f0f0;padding:16px;text-align:center;font-size:12px;color:#888;">Enviado automaticamente toda sexta-feira pelo CBF Hub</div>
      </div>
    </body></html>`;
}

// Mapa email → role para personalizar o email
const ROLES_TIME = {
  'natalia@road.ag':                  'SOCIAL',
  'leocattari@outlook.com':           'DESIGNER',
  'joanna@road.ag':                   'SOCIAL',
  'thais@road.ag':                    'SOCIAL',
  'henrique.dsgroad@gmail.com':       'DESIGNER',
  'luiza@road.ag':                    'SOCIAL',
  'mariaclara.freitasroad@gmail.com': 'DESIGNER',
  'gabrieladutton.road@gmail.com':    'DESIGNER',
  'yveslara.road@gmail.com':          'SOCIAL',
  'rafaelaroad97@gmail.com':          'SOCIAL'
};

function primeiroNomeDoEmail(email) {
  return email.split('@')[0].replace(/[0-9]/g, '').split(/[._-]/)[0];
}

async function enviarResumoSemanal(escalaFiltrada) {
  console.log('📧 Enviando resumo semanal...');
  const resultados = [];

  for (const email of TIME_EMAILS) {
    const nome = primeiroNomeDoEmail(email);
    const role = ROLES_TIME[email] || 'SOCIAL';
    try {
      await enviarBrevo({
        to: email,
        subject: `📅 Escala da semana — ${new Date().toLocaleDateString('pt-BR')}`,
        html: htmlResumoSemanal(nome, role, escalaFiltrada)
      });
      console.log(`  ✅ Enviado para ${email}`);
      resultados.push({ email, ok: true });
    } catch (err) {
      console.error(`  ❌ Erro para ${email}:`, err.response?.data || err.message);
      resultados.push({ email, ok: false, erro: err.response?.data || err.message });
    }
    await new Promise(r => setTimeout(r, 300));
  }
  return resultados;
}

module.exports = { enviarAlertaSobrecarga, enviarResumoSemanal };
