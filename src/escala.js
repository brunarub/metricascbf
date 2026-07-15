// src/escala.js
// Lê a planilha de escala do Google Sheets e detecta sobrecarga de jogos
// Planilha: https://docs.google.com/spreadsheets/d/1q70NUkhhIt5Kk8mZTIJ6huDyEIXbEydgE1xj00pGWrk

const { google } = require('googleapis');

const SHEET_ID = '1q70NUkhhIt5Kk8mZTIJ6huDyEIXbEydgE1xj00pGWrk';
// Nome da aba por mês: "ESCALA JULHO 2026", "ESCALA AGOSTO 2026", etc.
const MESES_PT = ['JANEIRO','FEVEREIRO','MARÇO','ABRIL','MAIO','JUNHO','JULHO','AGOSTO','SETEMBRO','OUTUBRO','NOVEMBRO','DEZEMBRO'];
function getSheetTab() {
  const now = new Date();
  return `ESCALA ${MESES_PT[now.getMonth()]} ${now.getFullYear()}`;
}

// Nomes das pessoas com função social media (em minúsculas para comparar)
// Ajuste essa lista conforme os nomes na planilha
const SOCIAL_NAMES = [
  'natalia', 'natália',
  'joanna',
  'thais', 'thaís',
  'luiza',
  'mariaclara', 'maria clara',
  'gabriela',
  'yves',
  'rafaela',
  'leo', 'leocattari',
  'henrique'
];

async function getAuthClient() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (!email || !key) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_EMAIL ou GOOGLE_PRIVATE_KEY não configurados no .env');
  }

  const auth = new google.auth.JWT(email, null, key, [
    'https://www.googleapis.com/auth/spreadsheets.readonly'
  ]);
  await auth.authorize();
  return auth;
}

// Lê a planilha inteira e retorna os dados brutos
async function lerPlanilha() {
  const auth = await getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${getSheetTab()}!A1:Z100`
  });

  return res.data.values || [];
}

// Verifica se uma célula parece uma data (ex: "13/7", "1/7", "13/07")
function ehData(val) {
  return val && /^\d{1,2}\/\d{1,2}$/.test(String(val).trim());
}

// Verifica se a pessoa está trabalhando (qualquer valor que não seja "Folga" vazio)
function estaTrabalho(status) {
  if (!status || status.trim() === '') return false;
  return !status.toLowerCase().includes('folga');
}

// Normaliza data para formato DD/MM (ex: "13/7" → "13/07", "1/7" → "01/07")
function normalizarData(val) {
  const parts = String(val).trim().split('/');
  if (parts.length !== 2) return val;
  return `${parts[0].padStart(2, '0')}/${parts[1].padStart(2, '0')}`;
}

// Parseia a planilha com estrutura de blocos semanais
// Cada bloco tem: linha de mês (merged), linha de dias da semana, linha de datas, linhas de pessoas
function parsearEscala(rows) {
  if (!rows || rows.length < 2) return { cabecalho: [], pessoas: [], diasPorData: {} };

  const pessoas = new Map(); // nome → { ehSocial, escalaDias }
  const diasPorData = {};

  let i = 0;
  while (i < rows.length) {
    const row = rows[i] || [];

    // Detecta linha de datas: col A vazia e col B tem formato "13/7"
    const colB = String(row[1] || '').trim();
    if (!row[0] && ehData(colB)) {
      // Extrair datas das colunas B-H (índices 1-7)
      const datasBloco = [];
      for (let c = 1; c <= 7; c++) {
        const v = String(row[c] || '').trim();
        datasBloco.push(v ? normalizarData(v) : null);
      }

      // Inicializar diasPorData para essas datas
      for (const data of datasBloco) {
        if (data && !diasPorData[data]) {
          diasPorData[data] = { sociais: [], todos: [] };
        }
      }

      // Ler linhas de pessoas a seguir
      let j = i + 1;
      while (j < rows.length) {
        const pRow = rows[j] || [];
        const nomeCell = String(pRow[0] || '').trim();

        // Parar se linha vazia ou nova linha de datas
        if (!nomeCell && !pRow[1]) { j++; break; }
        if (!nomeCell && ehData(String(pRow[1] || '').trim())) break;

        // Ignorar "CONTEÚDOS QUENTES", linhas de mês e dias da semana
        const ignorar = ['CONTEÚDOS QUENTES', 'JULHO', 'AGOSTO', 'JUNHO', 'SETEMBRO', 'OUTUBRO', 'NOVEMBRO', 'DEZEMBRO',
          'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado', 'domingo'];
        if (!nomeCell || ignorar.some(ig => nomeCell.toUpperCase().includes(ig.toUpperCase()))) {
          j++; continue;
        }

        const ehSocial = SOCIAL_NAMES.some(s => nomeCell.toLowerCase().includes(s));

        if (!pessoas.has(nomeCell)) {
          pessoas.set(nomeCell, { ehSocial, escalaDias: {} });
        }

        // Mapear status por data
        for (let c = 0; c < datasBloco.length; c++) {
          const data = datasBloco[c];
          if (!data) continue;
          const status = String(pRow[c + 1] || '').trim();

          pessoas.get(nomeCell).escalaDias[data] = status;

          if (!diasPorData[data]) diasPorData[data] = { sociais: [], todos: [] };

          diasPorData[data].todos.push({ nome: nomeCell, status });

          if (ehSocial && estaTrabalho(status)) {
            if (!diasPorData[data].sociais.includes(nomeCell)) {
              diasPorData[data].sociais.push(nomeCell);
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

// Retorna escala da semana atual + próxima semana
async function getEscalaSemana() {
  const rows = await lerPlanilha();
  const { cabecalho, pessoas, diasPorData } = parsearEscala(rows);

  return {
    cabecalho,
    pessoas,
    diasPorData,
    atualizadoEm: new Date().toISOString()
  };
}

// Detecta dias com sobrecarga: 3+ jogos E apenas 1 social escalada
// jogosCalendario = objeto { "DD/MM/YYYY": [ ...jogos ] } ou array de eventos
function detectarSobrecarga(diasPorData, jogosCalendario) {
  const alertas = [];

  for (const [data, info] of Object.entries(diasPorData)) {
    // Normaliza a chave de data para comparar com o calendário
    const jogosDoDia = jogosCalendario[data] || [];
    const qtdJogos = jogosDoDia.length;
    const qtdSociais = info.sociais.length;

    if (qtdJogos >= 3 && qtdSociais <= 1) {
      alertas.push({
        data,
        qtdJogos,
        qtdSociais,
        socaisEscalados: info.sociais,
        jogos: jogosDoDia
      });
    }
  }

  return alertas;
}

// Retorna escala de D até D+9 (para email semanal de sexta)
async function getEscalaProxDias(diasAfrente = 9) {
  const rows = await lerPlanilha();
  const { cabecalho, pessoas, diasPorData } = parsearEscala(rows);

  const hoje = new Date();
  const datas = [];

  for (let i = 0; i <= diasAfrente; i++) {
    const d = new Date(hoje);
    d.setDate(hoje.getDate() + i);
    // Formatos possíveis: DD/MM, DD/MM/YYYY, YYYY-MM-DD
    const ddmm = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
    const ddmmyyyy = `${ddmm}/${d.getFullYear()}`;
    datas.push({ ddmm, ddmmyyyy, dateObj: d });
  }

  const escalaFiltrada = {};

  for (const { ddmm, ddmmyyyy, dateObj } of datas) {
    // Tenta encontrar a data no cabeçalho (pode estar em vários formatos)
    const chave = Object.keys(diasPorData).find(k =>
      k.includes(ddmm) || k.includes(ddmmyyyy)
    );

    if (chave) {
      escalaFiltrada[ddmm] = {
        dateObj,
        ...diasPorData[chave]
      };
    } else {
      escalaFiltrada[ddmm] = {
        dateObj,
        sociais: [],
        todos: [],
        semDados: true
      };
    }
  }

  return { escalaFiltrada, pessoas, atualizadoEm: new Date().toISOString() };
}

module.exports = { getEscalaSemana, getEscalaProxDias, detectarSobrecarga };
