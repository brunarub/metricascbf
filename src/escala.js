// src/escala.js
// Lê a planilha de escala do Google Sheets e detecta sobrecarga de jogos
// Planilha: https://docs.google.com/spreadsheets/d/1q70NUkhhIt5Kk8mZTIJ6huDyEIXbEydgE1xj00pGWrk

const { google } = require('googleapis');

const SHEET_ID = '1q70NUkhhIt5Kk8mZTIJ6huDyEIXbEydgE1xj00pGWrk';
const MESES_PT = ['JANEIRO','FEVEREIRO','MARÇO','ABRIL','MAIO','JUNHO','JULHO','AGOSTO','SETEMBRO','OUTUBRO','NOVEMBRO','DEZEMBRO'];
function getSheetTab() {
  const now = new Date();
  return `ESCALA ${MESES_PT[now.getMonth()]} ${now.getFullYear()}`;
}

// Fallback por nome (caso a planilha não tenha a coluna de role)
const SOCIAL_NAMES = [
  'natalia', 'natália', 'joanna', 'thais', 'thaís',
  'luiza', 'mariaclara', 'maria clara', 'gabriela',
  'yves', 'rafaela', 'rafa'
];

async function getAuthClient() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (!email || !key) throw new Error('GOOGLE_SERVICE_ACCOUNT_EMAIL ou GOOGLE_PRIVATE_KEY não configurados');
  const auth = new google.auth.JWT(email, null, key, ['https://www.googleapis.com/auth/spreadsheets.readonly']);
  await auth.authorize();
  return auth;
}

async function lerPlanilha() {
  const auth = await getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${getSheetTab()}!A1:Z200`
  });
  return res.data.values || [];
}

function ehData(val) {
  return val && /^\d{1,2}\/\d{1,2}$/.test(String(val).trim());
}

function estaTrabalho(status) {
  if (!status || status.trim() === '') return false;
  return !status.toLowerCase().includes('folga');
}

function normalizarData(val) {
  const parts = String(val).trim().split('/');
  if (parts.length !== 2) return val;
  return `${parts[0].padStart(2, '0')}/${parts[1].padStart(2, '0')}`;
}

const IGNORAR = [
  'CONTEÚDOS QUENTES', 'CONTEUDOS QUENTES',
  'JANEIRO','FEVEREIRO','MARÇO','ABRIL','MAIO','JUNHO',
  'JULHO','AGOSTO','SETEMBRO','OUTUBRO','NOVEMBRO','DEZEMBRO',
  'segunda','terça','quarta','quinta','sexta','sábado','domingo'
];

// Detecta o offset de coluna onde começam as datas:
//   offset=2 → novo formato (col A=role, col B=nome, col C-I=dias)
//   offset=1 → antigo formato (col A=nome, col B-H=dias)
function detectarOffset(row) {
  if (!row[0] && !row[1] && ehData(String(row[2] || '').trim())) return 2;
  if (!row[0] && ehData(String(row[1] || '').trim())) return 1;
  return 0;
}

function parsearEscala(rows) {
  if (!rows || rows.length < 2) return { cabecalho: [], pessoas: [], diasPorData: {} };

  const pessoas = new Map();
  const diasPorData = {};

  let i = 0;
  while (i < rows.length) {
    const row = rows[i] || [];
    const colOffset = detectarOffset(row);

    if (colOffset > 0) {
      const colNome = colOffset - 1; // índice da coluna de nomes (0 ou 1)

      // Extrai datas do bloco (7 colunas a partir do offset)
      const datasBloco = [];
      for (let c = colOffset; c < colOffset + 7; c++) {
        const v = String(row[c] || '').trim();
        datasBloco.push(v ? normalizarData(v) : null);
      }

      for (const data of datasBloco) {
        if (data && !diasPorData[data]) {
          diasPorData[data] = { sociais: [], designers: [], todos: [] };
        }
      }

      let currentRole = null;
      let j = i + 1;

      while (j < rows.length) {
        const pRow = rows[j] || [];
        const roleCell = String(pRow[0] || '').trim().toUpperCase();
        const nomeCell = String(pRow[colNome] || '').trim();

        // Parar em linha vazia
        if (!nomeCell && !pRow[colNome + 1]) { j++; break; }

        // Parar em nova linha de datas
        if (detectarOffset(pRow) > 0) break;

        // Atualiza role se col A contém marcador de grupo
        if (roleCell === 'SOCIAL' || roleCell === 'DESIGNER') {
          currentRole = roleCell;
        }

        // Ignora linhas de cabeçalho e especiais
        const devIgnorar =
          !nomeCell ||
          IGNORAR.some(ig => roleCell.includes(ig.toUpperCase())) ||
          IGNORAR.some(ig => nomeCell.toUpperCase().includes(ig.toUpperCase()));
        if (devIgnorar) { j++; continue; }

        // Role: prioriza coluna da planilha, fallback por nome
        const ehSocial = currentRole === 'SOCIAL' ||
          (!currentRole && SOCIAL_NAMES.some(s => nomeCell.toLowerCase().includes(s)));
        const role = currentRole || (ehSocial ? 'SOCIAL' : 'DESIGNER');

        if (!pessoas.has(nomeCell)) {
          pessoas.set(nomeCell, { ehSocial, role, escalaDias: {} });
        }

        for (let c = 0; c < datasBloco.length; c++) {
          const data = datasBloco[c];
          if (!data) continue;
          const status = String(pRow[c + colOffset] || '').trim();

          pessoas.get(nomeCell).escalaDias[data] = status;

          if (!diasPorData[data]) diasPorData[data] = { sociais: [], designers: [], todos: [] };

          diasPorData[data].todos.push({ nome: nomeCell, status, role });

          if (ehSocial && estaTrabalho(status)) {
            if (!diasPorData[data].sociais.includes(nomeCell)) {
              diasPorData[data].sociais.push(nomeCell);
            }
          }
          if (role === 'DESIGNER' && estaTrabalho(status)) {
            if (!diasPorData[data].designers.includes(nomeCell)) {
              diasPorData[data].designers.push(nomeCell);
            }
          }
        }

        j++;
      }
      i = j;
    } else {
      i++;
    }
  }

  const pessoasArr = Array.from(pessoas.entries()).map(([nome, dados]) => ({ nome, ...dados }));
  return { cabecalho: Object.keys(diasPorData), pessoas: pessoasArr, diasPorData };
}

async function getEscalaSemana() {
  const rows = await lerPlanilha();
  const { cabecalho, pessoas, diasPorData } = parsearEscala(rows);
  return { cabecalho, pessoas, diasPorData, atualizadoEm: new Date().toISOString() };
}

function detectarSobrecarga(diasPorData, jogosCalendario) {
  const alertas = [];
  for (const [data, info] of Object.entries(diasPorData)) {
    const jogosDoDia = jogosCalendario[data] || [];
    const qtdJogos = jogosDoDia.length;
    const qtdSociais = info.sociais.length;
    if (qtdJogos >= 3 && qtdSociais <= 1) {
      alertas.push({ data, qtdJogos, qtdSociais, socaisEscalados: info.sociais, jogos: jogosDoDia });
    }
  }
  return alertas;
}

async function getEscalaProxDias(diasAfrente = 9) {
  const rows = await lerPlanilha();
  const { cabecalho, pessoas, diasPorData } = parsearEscala(rows);

  const hoje = new Date();
  const escalaFiltrada = {};

  for (let i = 0; i <= diasAfrente; i++) {
    const d = new Date(hoje);
    d.setDate(hoje.getDate() + i);
    const ddmm = `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}`;
    const chave = Object.keys(diasPorData).find(k => k.includes(ddmm));
    escalaFiltrada[ddmm] = chave
      ? { dateObj: d, ...diasPorData[chave] }
      : { dateObj: d, sociais: [], designers: [], todos: [], semDados: true };
  }

  return { escalaFiltrada, pessoas, atualizadoEm: new Date().toISOString() };
}

module.exports = { getEscalaSemana, getEscalaProxDias, detectarSobrecarga };
