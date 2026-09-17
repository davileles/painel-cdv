// transferencia-deducao.js
// Deduz origem/destino/bonusMax de uma oferta categoria=transferencia a partir
// do texto, usando SOMENTE as listas fixas de programas.
//
// POR QUE ESTA NO SERVIDOR (2026-09-17)
// Ate aqui a deducao so existia no browser do gestor-cdv, que a usava para
// pre-preencher os dropdowns "Origem/Destino (historico)". Ofertas aprovadas
// pelo bot do Telegram (baileys-server/bot-cdv-ofertas.js) chegavam em
// /ofertas/aprovar sem esses campos, atualizarHistoricoTransferencia desistia
// em silencio e a campanha nao aparecia como ativa no Comparador (oferta
// 12sfgv4, Livelo -> Smiles 80%). Agora o proxy completa os campos que
// faltarem; o que o gestor manda escolhido na tela continua valendo.
//
// COPIA ESPELHADA: gestor-cdv/index.html (deduzirTransferencia e listas
// ORIGEM_/DESTINO_TRANSFERENCIA_OPTIONS). Ajuste nos DOIS.

const ORIGEM_TRANSFERENCIA_OPTIONS = ['Todos','Alloyal','Azul Fidelidade','BRB','BTG','C6','Caixa','Esfera','Inter','Itaú','LATAM Pass','Livelo','Nubank','Porto Seguro','Premmia','Revolut','Sicoob','Sicredi','Smiles','XP'];
const DESTINO_TRANSFERENCIA_OPTIONS = ['AAdvantage','ALL Accor','Azul Fidelidade','Connect Miles','Flying Blue','Hilton Honors','Iberia Plus','IHG','LATAM Pass','Livelo','Smiles','TAP Miles&Go'];

const ALIAS_PROGRAMAS = {
  'Azul Fidelidade': ['azul fidelidade','pontos azul','azul'],
  'LATAM Pass': ['latam pass','latam'],
  'ALL Accor': ['all accor','accor'],
  'Connect Miles': ['connect miles','connectmiles'],
  'TAP Miles&Go': ['tap miles&go','tap miles e go','miles&go'],
  'Iberia Plus': ['iberia plus','iberia'],
  'Hilton Honors': ['hilton honors','hilton'],
  'Porto Seguro': ['porto seguro','porto bank','porto'],
  'C6': ['c6 bank','c6'],
  'BTG': ['btg pactual','btg'],
  'Inter': ['banco inter','inter'],
  'AAdvantage': ['aadvantage','advantage'],
  'Premmia': ['petrobras premmia','premmia'],
  'Alloyal': ['alloyal'],
};

function normalizarBusca(s) {
  return (s || '').toString().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}
function aliasesDe(op) { return ALIAS_PROGRAMAS[op] || [normalizarBusca(op)]; }
function escRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Posicao do match mais a esquerda (com bordas de palavra). Infinity = ausente.
function posPrograma(txt, op) {
  let pos = Infinity;
  aliasesDe(op).forEach((a) => {
    const m = new RegExp('(^|[^a-z0-9])' + escRegex(a) + '($|[^a-z0-9])').exec(txt);
    if (m) { const i = m.index + m[1].length; if (i < pos) pos = i; }
  });
  return pos;
}

function matchPosicional(txt, opcoes, excluir) {
  let melhor = '', pos = Infinity;
  (opcoes || []).forEach((op) => {
    if (!op || op === 'Todos' || op === excluir) return;
    const i = posPrograma(txt, op);
    if (i < pos) { pos = i; melhor = op; }
  });
  return melhor;
}

// Ultimo programa citado logo apos preposicao de destino ("para X", "-> X").
function destinoPorPreposicao(txt) {
  let melhor = '', pos = -1;
  DESTINO_TRANSFERENCIA_OPTIONS.forEach((d) => {
    aliasesDe(d).forEach((a) => {
      const re = new RegExp('(?:para|rumo a|->|\u2192|em direcao a)\\s*(?:o|a|os|as)?\\s*' + escRegex(a) + '($|[^a-z0-9])', 'g');
      let m;
      while ((m = re.exec(txt)) !== null) { if (m.index > pos) { pos = m.index; melhor = d; } }
    });
  });
  return melhor;
}

function deduzirTransferencia(o) {
  const titulo   = normalizarBusca(o.titulo || '');
  const programa = normalizarBusca(o.programa || '');
  const corpo    = normalizarBusca([o.bonus, o.resumo].filter(Boolean).join(' '));
  const texto    = [titulo, programa, corpo].join(' ');
  const link     = (o.link || '').toLowerCase();

  const setas = (titulo.match(/\u2192|->/g) || []).length;
  const combo = setas >= 2 || /(^|[^a-z])combo([^a-z]|$)/.test(titulo);

  const destino = destinoPorPreposicao(titulo)
               || matchPosicional(programa, DESTINO_TRANSFERENCIA_OPTIONS)
               || matchPosicional(titulo, DESTINO_TRANSFERENCIA_OPTIONS)
               || destinoPorPreposicao(corpo)
               || matchPosicional(corpo, DESTINO_TRANSFERENCIA_OPTIONS);

  const gatilhosTodos = ['todos os bancos','quase todos os parceiros','bancos parceiros',
    'todos os parceiros','bancos participantes','parceiros bancarios','bancos selecionados',
    'cartoes de credito e programas','bancos e programas','diversos bancos','principais bancos',
    'varios parceiros','diversos parceiros'];
  let origem = '';
  if (gatilhosTodos.some((g) => texto.indexOf(g) !== -1)) {
    origem = 'Todos';
  } else {
    origem = matchPosicional(titulo, ORIGEM_TRANSFERENCIA_OPTIONS, destino)
          || matchPosicional(programa, ORIGEM_TRANSFERENCIA_OPTIONS, destino)
          || matchPosicional(corpo, ORIGEM_TRANSFERENCIA_OPTIONS, destino);
    if (!origem && link.indexOf('/bancos-') !== -1) origem = 'Todos';
  }

  let bonusMax = null;
  if (!combo) {
    const fonte = normalizarBusca([o.titulo, o.bonus].filter(Boolean).join(' '));
    const matches = fonte.match(/(\d{1,3})\s*%/g);
    if (matches && matches.length) {
      const nums = matches.map((m) => parseInt(m, 10)).filter((n) => !isNaN(n) && n > 0 && n <= 500);
      if (nums.length) bonusMax = Math.max.apply(null, nums);
    }
  }
  return { origem, destino, bonusMax, combo };
}

function vazio(v) { return v === undefined || v === null || v === ''; }

// Devolve uma COPIA da oferta com origem/destino/bonusMax completados quando
// ausentes. Nunca sobrescreve valor ja informado. Combo sem decisao explicita
// vira semHistorico=true — mesmo default do checkbox do gestor.
function completarTransferencia(item) {
  if (!item || item.categoria !== 'transferencia') return item;
  const out = { ...item };
  const g = deduzirTransferencia(out);
  if (out.semHistorico === undefined && g.combo) out.semHistorico = true;
  if (out.semHistorico) return out;
  if (vazio(out.origem) && g.origem) out.origem = g.origem;
  if (vazio(out.destino) && g.destino) out.destino = g.destino;
  if (vazio(out.bonusMax) && g.bonusMax != null) out.bonusMax = g.bonusMax;
  return out;
}

module.exports = {
  ORIGEM_TRANSFERENCIA_OPTIONS,
  DESTINO_TRANSFERENCIA_OPTIONS,
  deduzirTransferencia,
  completarTransferencia,
};
