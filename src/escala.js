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

// Converte os dados brutos em estrutura utilizável
// Retorna: { cabecalho, pessoas, diasPorData }
function parsearEscala(rows) {
  if (!rows || rows.length < 2) return { cabecalho: [], pessoas: [], diasPorData: {} };

  // Primeira linha = cabeçalho (datas ou nomes de colunas)
  const cabecalho = rows[0];

  // Linhas seguintes = uma por pessoa
  const pessoas = [];
  const diasPorData = {};

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !row[0]) continue; // linha vazia

    const nomePessoa = row[0]?.trim() || '';
    if (!nomePessoa) continue;

    const ehSocial = SOCIAL_NAMES.some(s => nomePessoa.toLowerCase().includes(s));

    const escalaDias = {};

    // Colunas a partir da 1 = dias/datas
    for (let c = 1; c < cabecalho.length; c++) {
      const colLabel = cabecalho[c]?.trim() || '';
      const valor = row[c]?.trim() || '';

      // "T" = trabalhando/escalada, "F" = folga, "HC" = hot content
      escalaDias[colLabel] = valor;

      if (!diasPorData[colLabel]) {
        diasPorData[colLabel] = { sociais: [], todos: [] };
      }

      diasPorData[colLabel].todos.push({ nome: nomePessoa, status: valor });

      const estaTrabalhandoOuHC = valor === 'T' || valor.toUpperCase().includes('HC') || valor === '1' || valor.toLowerCase() === 'sim';

      if (ehSocial && estaTrabalhandoOuHC) {
        diasPorData[colLabel].sociais.push(nomePessoa);
      }
    }

    pessoas.push({ nome: nomePessoa, ehSocial, escalaDias });
  }

  return { cabecalho, pessoas, diasPorData };
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
