// transferencia-historico.js
// Regra unica de "mesma campanha" de transferencia bonificada (reenvio x
// campanha nova). Usada pelo proxy (index.js: card do gestor/bot, gravacao na
// aprovacao) e pelo coletor do RSS (coletar-radar.js: oferta repetida nem entra
// na fila de Aprovar Ofertas). Antes vivia so no index.js; foi extraida em
// 29/10/2026 para o coletor usar exatamente a mesma regra.

const { completarTransferencia } = require('./transferencia-deducao.js');

function formatarDataBR(iso) {
  const m = (iso || '').match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : (iso || '');
}

function normalizarChaveHist(s) {
  return (s || '').toString().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().replace(/\s+/g, '_');
}
function chaveHistorico(origem, destino) {
  return `${normalizarChaveHist(origem)}→${normalizarChaveHist(destino)}`;
}
function prazoParaIso(prazoStr) {
  const m = (prazoStr || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

// ── REENVIO x CAMPANHA NOVA (transferencias) ─────────────────────────────────
// O mesmo alerta de transferencia chega varias vezes (grupo que reposta,
// lembrete de ultimo dia, fonte diferente). Registrar duas vezes a mesma
// campanha distorce a media e a frequencia do historico. Esta e a regra unica
// usada tanto para MOSTRAR no card (gestor e bot do Telegram) quanto para
// GRAVAR na aprovacao (atualizarHistoricoTransferencia).
const JANELA_REENVIO_SEM_PRAZO_DIAS = 5;

function hojeIsoSP() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}
function somarDiasIso(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Devolve { registro, motivo } do registro que e a MESMA campanha, ou null.
// 1) mesma chave + mesmo prazo;
// 2) campanha registrada ainda vigente (inicio <= hoje <= prazo) — pega o
//    lembrete com prazo escrito diferente ou sem prazo;
// 3) oferta sem prazo + mesma chave registrada nos ultimos 5 dias.
function registroMesmaCampanha(items, chave, prazoIso, hojeIso) {
  const hoje = hojeIso || hojeIsoSP();
  const daChave = (items || []).filter((h) => h && h.chave === chave);
  if (!daChave.length) return null;
  if (prazoIso) {
    const igual = daChave.find((h) => h.prazo === prazoIso);
    if (igual) return { registro: igual, motivo: 'mesmo prazo' };
  }
  const vigente = daChave.find((h) => h.prazo && h.prazo >= hoje
    && h.dataInicio && h.dataInicio <= hoje
    && (!prazoIso || prazoIso >= h.dataInicio));
  if (vigente) return { registro: vigente, motivo: 'campanha registrada ainda vigente' };
  if (!prazoIso) {
    const corte = somarDiasIso(hoje, -JANELA_REENVIO_SEM_PRAZO_DIAS);
    const recente = daChave.find((h) => h.dataInicio && h.dataInicio >= corte);
    if (recente) return { registro: recente, motivo: 'registrada há poucos dias (oferta sem prazo)' };
  }
  return null;
}

function periodoHistorico(h) {
  const ini = formatarDataBR(h.dataInicio);
  const fim = h.prazo ? formatarDataBR(h.prazo) : '';
  if (!fim || fim === ini) return ini || fim || 'data desconhecida';
  return ini ? `${ini} a ${fim}` : `até ${fim}`;
}

// Origens que viram registro no historico. "Bancos selecionados" = um registro
// por banco da lista (`origens`); qualquer outra origem = ela mesma.
function origensDaOferta(c) {
  if (!c || !c.origem) return [];
  if (c.origem !== 'Bancos selecionados') return [c.origem];
  const vistos = {};
  return (Array.isArray(c.origens) ? c.origens : [])
    .map((s) => String(s || '').trim())
    .filter((s) => s && s !== 'Todos' && s !== 'Bancos selecionados' && !vistos[s] && (vistos[s] = 1));
}

// Situacao de uma oferta pendente frente ao historico e a propria fila.
// tipo: reenvio | duplicada_fila | nova | indefinida. null = nao se aplica.
function situacaoHistoricoTransferencia(o, histItems, pendentes) {
  if (!o || o.categoria !== 'transferencia') return null;
  const c = completarTransferencia(o);
  if (c.semHistorico) return null;
  if (!c.origem || !c.destino) {
    return { tipo: 'indefinida', texto: '❔ Não identifiquei origem/destino — confira no histórico antes de aprovar' };
  }
  if (c.origem === 'Bancos selecionados') return situacaoVariasOrigens(o, c, histItems, pendentes);
  const chave = chaveHistorico(c.origem, c.destino);
  const prazoIso = prazoParaIso(c.prazo);
  const par = `${c.origem} → ${c.destino}`;
  const base = { chave, origem: c.origem, destino: c.destino };
  const resumoReg = (h) => ({ dataInicio: h.dataInicio || '', prazo: h.prazo || '', bonusMax: h.bonusMax, ofertaIds: h.ofertaIds || [] });

  const m = registroMesmaCampanha(histItems, chave, prazoIso);
  if (m) {
    const r = m.registro;
    return {
      ...base, tipo: 'reenvio', motivo: m.motivo, registro: resumoReg(r),
      texto: `🔁 Reenvio: ${par} já está no histórico (${periodoHistorico(r)}, ${r.bonusMax}%) — ${m.motivo}. Aprovar não cria registro novo.`,
    };
  }

  // Mesma campanha esperando mais antiga na propria fila (duas fontes postaram).
  const outros = (pendentes || [])
    .filter((p) => p && p.id !== o.id && p.categoria === 'transferencia' && (p.publicadoEm || '') < (o.publicadoEm || ''))
    .map((p) => {
      const cp = completarTransferencia(p);
      if (cp.semHistorico || !cp.origem || !cp.destino) return null;
      return { id: p.id, chave: chaveHistorico(cp.origem, cp.destino), prazo: prazoParaIso(cp.prazo) || '',
               dataInicio: (p.publicadoEm || '').slice(0, 10), bonusMax: cp.bonusMax };
    })
    .filter(Boolean);
  const mf = registroMesmaCampanha(outros, chave, prazoIso);
  if (mf) {
    return {
      ...base, tipo: 'duplicada_fila', motivo: mf.motivo, outroId: mf.registro.id,
      texto: `🔁 Duplicada na fila: mesma campanha ${par} da oferta #${mf.registro.id}, ainda pendente.`,
    };
  }

  const ult = (histItems || [])
    .filter((h) => h && h.chave === chave && h.dataInicio)
    .sort((a, b) => b.dataInicio.localeCompare(a.dataInicio))[0];
  return {
    ...base, tipo: 'nova', ultima: ult ? resumoReg(ult) : null,
    texto: ult
      ? `🆕 Campanha nova: ${par}. Última registrada: ${periodoHistorico(ult)}, ${ult.bonusMax}%.`
      : `🆕 Campanha nova: primeira ${par} no histórico.`,
  };
}

// "Bancos selecionados": reenvio/duplicada so quando TODOS os bancos da lista
// ja estao registrados (ou na fila) para essa campanha; senao e nova e o texto
// diz quais bancos ja estavam.
function situacaoVariasOrigens(o, c, histItems, pendentes) {
  const lista = origensDaOferta(c);
  if (!lista.length) {
    return { tipo: 'indefinida', texto: '❔ Origem "Bancos selecionados" sem nenhum banco marcado — marque os bancos antes de aprovar' };
  }
  const prazoIso = prazoParaIso(c.prazo);
  const par = `${lista.length} banco${lista.length === 1 ? '' : 's'} → ${c.destino}`;
  const base = { chave: chaveHistorico('Bancos selecionados', c.destino), origem: c.origem, origens: lista, destino: c.destino };
  const resumoReg = (h) => ({ dataInicio: h.dataInicio || '', prazo: h.prazo || '', bonusMax: h.bonusMax, ofertaIds: h.ofertaIds || [] });

  const noHist = lista.map((b) => ({ b, m: registroMesmaCampanha(histItems, chaveHistorico(b, c.destino), prazoIso) }));
  const ja = noHist.filter((x) => x.m);
  // A mesma campanha registrada antes como "Todos → destino" (rotulo antigo,
  // ex. fqbp5g) cobre todos os bancos: e reenvio, e a aprovacao troca aquele
  // registro pelos registros por banco.
  const todos = registroMesmaCampanha(histItems, chaveHistorico('Todos', c.destino), prazoIso);
  if (todos && !c.campanhaNova) {
    const r = todos.registro;
    return {
      ...base, tipo: 'reenvio', motivo: todos.motivo, registro: resumoReg(r), substituiTodos: true,
      texto: `🔁 Reenvio: a campanha já está no histórico como Todos → ${c.destino} (${periodoHistorico(r)}, ${r.bonusMax}%) — ${todos.motivo}. Aprovar troca esse registro por um para cada um dos ${par}.`,
    };
  }
  if (ja.length === lista.length) {
    const r = ja[0].m.registro;
    return {
      ...base, tipo: 'reenvio', motivo: ja[0].m.motivo, registro: resumoReg(r),
      texto: `🔁 Reenvio: ${par} já estão no histórico (${periodoHistorico(r)}, ${r.bonusMax}%) — ${ja[0].m.motivo}. Aprovar não cria registro novo.`,
    };
  }

  const outros = [];
  (pendentes || [])
    .filter((p) => p && p.id !== o.id && p.categoria === 'transferencia' && (p.publicadoEm || '') < (o.publicadoEm || ''))
    .forEach((p) => {
      const cp = completarTransferencia(p);
      if (cp.semHistorico || !cp.destino) return;
      origensDaOferta(cp).forEach((b) => outros.push({ id: p.id, chave: chaveHistorico(b, cp.destino),
        prazo: prazoParaIso(cp.prazo) || '', dataInicio: (p.publicadoEm || '').slice(0, 10), bonusMax: cp.bonusMax }));
    });
  const naFila = lista.map((b) => registroMesmaCampanha(outros, chaveHistorico(b, c.destino), prazoIso));
  if (naFila.every(Boolean)) {
    return {
      ...base, tipo: 'duplicada_fila', motivo: naFila[0].motivo, outroId: naFila[0].registro.id,
      texto: `🔁 Duplicada na fila: mesma campanha ${par} da oferta #${naFila[0].registro.id}, ainda pendente.`,
    };
  }

  const novos = noHist.filter((x) => !x.m).map((x) => x.b);
  return {
    ...base, tipo: 'nova', jaNoHistorico: ja.map((x) => x.b),
    texto: ja.length
      ? `🆕 Campanha nova: ${par}. Entram no histórico: ${novos.join(', ')}. Já registrados nesta campanha: ${ja.map((x) => x.b).join(', ')}.`
      : `🆕 Campanha nova: ${par} (${lista.join(', ')}). Cada banco ganha seu registro no histórico.`,
  };
}

module.exports = {
  origensDaOferta,
  normalizarChaveHist,
  chaveHistorico,
  prazoParaIso,
  registroMesmaCampanha,
  situacaoHistoricoTransferencia,
};
