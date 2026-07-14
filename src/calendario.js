// Cliente não-oficial da API interna do cbf.com.br (não documentada publicamente).
// Descoberta observando as requisições feitas pelo próprio site: a página
// /futebol-brasileiro/calendario consulta, por dia, um endpoint que devolve
// TODOS os jogos daquela data agrupados por competição — inclusive placar
// (que é "0" tanto pra jogos futuros quanto já jogados; por isso calculamos
// o status nós mesmos comparando a data/hora do jogo com o horário atual).
const axios = require('axios');

const BASE_URL = 'https://www.cbf.com.br/api/cbf/calendario/jogos';

// Cada entrada casa um par (nome do campeonato, nome da subcategoria) retornado
// pela API com o rótulo que queremos mostrar no dashboard.
const COMPETITIONS = [
  { match: (camp) => camp === 'Brasileiro Feminino', label: 'Brasileirão Feminino A1' },
  { match: (camp, sub) => camp === 'Copa do Brasil' && /feminino/i.test(sub || ''), label: 'Copa do Brasil Feminino' },
];

async function fetchDia(ano, mes, dia) {
  const url = `${BASE_URL}/${ano}/${String(mes).padStart(2, '0')}/${String(dia).padStart(2, '0')}`;
  const res = await axios.get(url);
  return res.data.jogos || {};
}

function extractGames(jogosPorCampeonato) {
  const out = [];
  for (const campName in jogosPorCampeonato) {
    const subs = jogosPorCampeonato[campName];
    for (const subName in subs) {
      const comp = COMPETITIONS.find(c => c.match(campName, subName));
      if (!comp) continue;
      (subs[subName] || []).forEach(g => out.push({ ...g, competicao: comp.label }));
    }
  }
  return out;
}

// "data" vem como " DD/MM/YYYY" e "hora" como "HH:MM", em horário de Brasília (UTC-3)
function parseDataHora(dataStr, horaStr) {
  const [d, m, y] = (dataStr || '').trim().split('/').map(Number);
  const [hh, mm] = (horaStr || '00:00').split(':').map(Number);
  if (!d || !m || !y) return null;
  return new Date(Date.UTC(y, m - 1, d, (hh || 0) + 3, mm || 0));
}

function normalizeGame(g) {
  const datetime = parseDataHora(g.data, g.hora);
  const now = new Date();
  let status = 'agendado';
  if (datetime) {
    if (datetime <= now) {
      const horasDesde = (now - datetime) / (1000 * 60 * 60);
      status = horasDesde <= 2.5 ? 'ao_vivo' : 'encerrado';
    }
  }

  return {
    id: g.id_jogo,
    competicao: g.competicao,
    rodada: g.rodada || null,
    grupo: g.grupo || null,
    mandante: {
      nome: g.mandante?.nome || '?',
      escudo: g.mandante?.url_escudo || null,
      gols: status === 'agendado' ? null : parseInt(g.mandante?.gols || '0', 10),
    },
    visitante: {
      nome: g.visitante?.nome || '?',
      escudo: g.visitante?.url_escudo || null,
      gols: status === 'agendado' ? null : parseInt(g.visitante?.gols || '0', 10),
    },
    local: (g.local || '').trim() || null,
    data: (g.data || '').trim(),
    hora: g.hora || null,
    datetime: datetime ? datetime.toISOString() : null,
    status, // 'agendado' | 'ao_vivo' | 'encerrado'
  };
}

// Busca o calendário unificado das competições femininas suportadas,
// varrendo um intervalo de dias (padrão: 7 dias atrás até 60 dias à frente).
async function getCalendario({ pastDays = 7, futureDays = 60 } = {}) {
  const today = new Date();
  const dates = [];
  for (let i = -pastDays; i <= futureDays; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    dates.push({ ano: d.getFullYear(), mes: d.getMonth() + 1, dia: d.getDate() });
  }

  const CONCURRENCY = 5;
  const rawGames = [];

  for (let i = 0; i < dates.length; i += CONCURRENCY) {
    const batch = dates.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(({ ano, mes, dia }) =>
      fetchDia(ano, mes, dia).catch(err => {
        console.error(`Erro ao buscar calendário CBF ${ano}-${mes}-${dia}:`, err.message);
        return {};
      })
    ));
    results.forEach(jogosPorCampeonato => rawGames.push(...extractGames(jogosPorCampeonato)));
  }

  const games = rawGames.map(normalizeGame).filter(g => g.datetime);
  games.sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
  return games;
}

module.exports = { getCalendario };
