'use strict';
// ── Notas fiscais (NFS-e Nacional) — desde 18/11/2026 ───────────────────────
// Emite as NFS-e da Tudo Sobre Milhas Curso Online direto no Emissor Nacional
// (nfse.js), sem o eNotas. Aba "Notas fiscais" do gestor-cdv.
//
// Arquivo notas-fiscais.json (repo de dados, ARQUIVOS_SENSIVEIS):
//   config   { modo: desligado|homologacao|producao, emitirDesde: AAAA-MM-DD,
//              diasEspera (7 = fim do prazo de desistência), serie, competencia:
//              emissao|pagamento, produtoPadrao, loteMax }
//   empresa  { cnpj, im, razao, cMun, fone, email, opSimpNac, regApTribSN, regEspTrib, pTotTribSN }
//   produtos [{ id, nome, cTribNac, cTribMun, cNBS, descricao ('{produto}', '{oferta}'), infoCompl, ativo }]
//   ofertas  { <ofertaId da Hubla>: <id do produto fiscal> }
//   contadores { producao, homologacao } — último nº de DPS usado (série config.serie)
//   notas    [...] (produção) · testes [...] (homologação, sem valor fiscal)
//
// Vendas da Hubla: a cada 30 min o proxy lê as faturas pela API. Fatura paga a
// partir de `emitirDesde` vira nota "pendente" com data prevista = pagamento +
// diasEspera; reembolsada antes disso sai da fila ("venda reembolsada"). Só no
// modo produção as pendentes vencidas são emitidas sozinhas. Em homologação a
// fila é montada, mas só sai nota de teste pelo botão do gestor.

const crypto = require('crypto');
const zlib = require('zlib');
const nfse = require('./nfse');
const danfse = require('./danfse.cjs');

const ARQ = 'notas-fiscais.json';
// Status de fatura da Hubla que são devolução total (a nota emitida é cancelada).
// Outro status diferente de "paid" (ex.: reembolso parcial) só fica marcado para conferir.
const STATUS_REEMBOLSO_TOTAL = new Set(['refunded', 'chargeback', 'chargedback', 'charged_back', 'canceled', 'cancelled']);
const DIA = 864e5;
const soDig = (s) => String(s == null ? '' : s).replace(/\D/g, '');

// Produto fiscal: mesmos campos do Tica Promos (baileys-server/notas-shopee.js),
// decisão do Davi de 19/11/2026. Lá a descrição se chama xDescServ/xInfComp.
const TRIBUTOS_PADRAO = { pTotTribSN: '', tribISSQN: '1', tpRetISSQN: '1', cstPisCofins: '00', tpRetPisCofins: '0', competencia: '', codigosConfirmados: false };
const PRODUTOS_PADRAO = [
  Object.assign({}, TRIBUTOS_PADRAO, { id: 'milhas', nome: 'Produtos de milhas', cTribNac: '080201', cTribMun: '001', cNBS: '122051900',
    descricao: '{produto}', infoCompl: 'Valor aprox dos tributos: 7,47% Fonte: IBPT 115C76.', ativo: true, pTotTribSN: '7.47', codigosConfirmados: true }),
];

function padrao() {
  return {
    versao: 1,
    config: { modo: 'desligado', emitirAuto: true, minimo: 0, emitirDesde: null, diasEspera: 7, serie: '900', competencia: 'emissao', produtoPadrao: 'milhas', loteMax: 15, cancelarReembolso: true },
    empresa: { cnpj: '34379496000178', im: '11662870013', razao: 'Tudo Sobre Milhas Curso Online Ltda', cMun: '3106200',
      fone: '', email: '', opSimpNac: 3, regApTribSN: 1, regEspTrib: 0, pTotTribSN: 7.47 },
    produtos: PRODUTOS_PADRAO.map(p => Object.assign({}, p)),
    ofertas: {},
    contadores: { producao: 0, homologacao: 0 },
    notas: [],
    testes: [],
    transicao: [],
    rodada: null,
  };
}
function normalizar(d) {
  const p = padrao();
  if (!d || typeof d !== 'object') return p;
  const o = Object.assign({}, p, d);
  o.config = Object.assign({}, p.config, d.config || {});
  o.empresa = Object.assign({}, p.empresa, d.empresa || {});
  o.produtos = Array.isArray(d.produtos) && d.produtos.length ? d.produtos : p.produtos;
  o.ofertas = d.ofertas && typeof d.ofertas === 'object' ? d.ofertas : {};
  o.contadores = Object.assign({}, p.contadores, d.contadores || {});
  o.notas = Array.isArray(d.notas) ? d.notas : [];
  o.testes = Array.isArray(d.testes) ? d.testes : [];
  o.transicao = Array.isArray(d.transicao) ? d.transicao : [];
  // 'Comissão de afiliados' saiu dos produtos do Clube do Viajante (19/11/2026): comissão de
  // afiliados é do Tica Promos e fica nos produtos fiscais de lá. Só some se ninguém usa.
  const usado = (id) => o.config.produtoPadrao === id || Object.values(o.ofertas).includes(id) ||
    o.notas.some(n => n.produtoFiscalId === id) || o.testes.some(n => n.produtoFiscalId === id);
  if (o.produtos.length > 1 && !usado('afiliados')) o.produtos = o.produtos.filter(x => x.id !== 'afiliados');
  // Tributos por produto (19/11/2026, iguais aos do Tica Promos). Produto gravado antes
  // disso já estava em uso: herda a alíquota da empresa e os códigos contam como confirmados.
  o.produtos = o.produtos.map(x => {
    const y = Object.assign({}, TRIBUTOS_PADRAO, x);
    if (x.pTotTribSN == null) y.pTotTribSN = Number(o.empresa.pTotTribSN) > 0 ? String(o.empresa.pTotTribSN) : '';
    if (x.codigosConfirmados == null) y.codigosConfirmados = true;
    return y;
  });
  return o;
}

function addDias(iso, dias) { return new Date(new Date(iso).getTime() + dias * DIA).toISOString(); }
function isoOuNull(v) { if (!v) return null; const t = new Date(v).getTime(); return isNaN(t) ? null : new Date(t).toISOString(); }
function novoId(prefixo) { return prefixo + '-' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'); }
function mascararDoc(d) {
  const s = soDig(d);
  if (s.length === 11) return '***.' + s.slice(3, 6) + '.' + s.slice(6, 9) + '-**';
  if (s.length === 14) return s.slice(0, 2) + '.' + s.slice(2, 5) + '.' + s.slice(5, 8) + '/' + s.slice(8, 12) + '-' + s.slice(12);
  return s ? '***' : '';
}
function cpfValido(c) {
  const s = soDig(c);
  if (s.length !== 11 || /^(\d)\1+$/.test(s)) return false;
  for (const t of [9, 10]) {
    let soma = 0;
    for (let i = 0; i < t; i++) soma += Number(s[i]) * (t + 1 - i);
    if (((soma * 10) % 11) % 10 !== Number(s[t])) return false;
  }
  return true;
}
function cnpjValido(c) {
  const s = soDig(c);
  if (s.length !== 14 || /^(\d)\1+$/.test(s)) return false;
  const calc = (n) => { let soma = 0, pos = n - 7; for (let i = n; i >= 1; i--) { soma += Number(s[n - i]) * pos--; if (pos < 2) pos = 9; } const r = soma % 11; return r < 2 ? 0 : 11 - r; };
  return calc(12) === Number(s[12]) && calc(13) === Number(s[13]);
}
function docValido(d) { const s = soDig(d); return s.length === 11 ? cpfValido(s) : s.length === 14 ? cnpjValido(s) : false; }

// Pagamento da fatura: paidAt ou o "paid" do histórico de status.
function pagaEmDe(f) {
  if (f.paidAt) return isoOuNull(f.paidAt);
  const st = Array.isArray(f.statusAt) ? f.statusAt : [];
  const p = st.filter(s => s && s.status === 'paid').map(s => s.when).sort().pop();
  return isoOuNull(p);
}
// Corte eNotas → sistema (19/11/2026): venda paga antes de `emitirDesde` é do eNotas
// e nunca sai daqui, mesmo que já esteja na fila (montada antes, em homologação ou
// com outra data). Vale para a fila, para a rodada e para o "emitir agora".
function antesDoCorte(n, cfg) {
  if (!n || n.origem !== 'hubla' || !cfg || !cfg.emitirDesde || !n.pagaEm) return false;
  return nfse.dataSP(n.pagaEm) < cfg.emitirDesde;
}
// Quando a fatura entrou no status atual (histórico statusAt da Hubla).
function statusEmDe(f, status) {
  const st = Array.isArray(f && f.statusAt) ? f.statusAt : [];
  const w = st.filter(s => s && String(s.status || '').toLowerCase() === status).map(s => s.when).sort().pop();
  return isoOuNull(w);
}
// Reembolso, depois do corte, de venda paga antes dele (ainda em garantia no eNotas, que
// não fica mais sabendo depois que a integração Hubla → eNotas é desligada): entra na lista
// "transicao" para o Davi cancelar no eNotas. Só vendas pagas até 10 dias antes do corte.
function registrarTransicao(base, f, status, quando) {
  const cfg = base.config || {};
  if (!cfg.emitirDesde || !f || !f.id || !status || status === 'paid') return false;
  const pagaEm = pagaEmDe(f);
  if (!pagaEm) return false;
  const dia = nfse.dataSP(pagaEm);
  if (dia >= cfg.emitirDesde) return false;
  if (new Date(pagaEm).getTime() < new Date(cfg.emitirDesde + 'T00:00:00-03:00').getTime() - 10 * DIA) return false;
  const em = quando || statusEmDe(f, status);
  if (em && nfse.dataSP(em) < cfg.emitirDesde) return false;   // reembolso antes do corte: o eNotas soube
  base.transicao = Array.isArray(base.transicao) ? base.transicao : [];
  const ex = base.transicao.find(x => x.faturaId === f.id);
  if (ex) { if (ex.statusFatura === status) return false; ex.statusFatura = status; ex.atualizadaEm = new Date().toISOString(); return true; }
  const payer = f.payer || {};
  base.transicao.push({
    faturaId: f.id, pagaEm, reembolsoEm: em || new Date().toISOString(), statusFatura: status,
    valor: Math.round(totalDe(f) * 100) / 100,
    nome: [payer.firstName, payer.lastName].filter(Boolean).join(' ') || payer.fullName || payer.name || '',
    email: String(payer.email || '').toLowerCase().trim(), doc: soDig(payer.document),
    vistaEm: new Date().toISOString(), resolvidaEm: null,
  });
  return true;
}
function totalDe(f) {
  const a = f.amount || {};
  if (typeof a.totalCents === 'number') return a.totalCents / 100;
  if (typeof a.total === 'number') return a.total;
  if (typeof f.totalCents === 'number') return f.totalCents / 100;
  return 0;
}
// Itens (ofertas) da fatura, com produto, a partir do cadastro de ofertas do
// hubla-assinaturas.json ({id: {nome, produtoId, produtoNome, ehProduto}}).
function itensDe(f, ofertasHubla) {
  const out = [];
  const add = (x) => { if (x && (x.ofertaId || x.produtoNome) && !out.some(y => y.ofertaId === x.ofertaId && y.produtoNome === x.produtoNome)) out.push(x); };
  for (const pr of (Array.isArray(f.products) ? f.products : [])) {
    for (const of of (Array.isArray(pr.offers) ? pr.offers : [])) add({ ofertaId: of.id || null, ofertaNome: of.name || '', produtoId: pr.id || null, produtoNome: pr.name || '' });
    if (!(pr.offers || []).length) add({ ofertaId: null, ofertaNome: '', produtoId: pr.id || null, produtoNome: pr.name || '' });
  }
  for (const it of (Array.isArray(f.items) ? f.items : [])) {
    if (!it) continue;
    const o = ofertasHubla[it.id];
    if (o && !o.ehProduto) add({ ofertaId: it.id, ofertaNome: o.nome || it.name || '', produtoId: o.produtoId || null, produtoNome: o.produtoNome || '' });
    else if (o && o.ehProduto) add({ ofertaId: null, ofertaNome: '', produtoId: it.id, produtoNome: o.nome || it.name || '' });
    else add({ ofertaId: it.id || null, ofertaNome: it.name || '', produtoId: it.productId || null, produtoNome: it.productName || it.name || '' });
  }
  return out;
}

// Data de competência (mesma regra do Tica Promos): nota com data própria → produto
// fiscal → padrão da Emissão. 'pagamento' = dia do pagamento; 'mes' = último dia do
// mês do pagamento.
function competenciaDa(base, pf, n) {
  if (n.competencia) return n.competencia;
  const m = (pf && pf.competencia) || base.config.competencia;
  const pg = n.pagaEm ? nfse.dataSP(n.pagaEm) : null;
  if (m === 'pagamento' && pg) return pg;
  if (m === 'mes' && pg) { const [a, mm] = pg.split('-').map(Number); return new Date(Date.UTC(a, mm, 0)).toISOString().slice(0, 10); }
  return nfse.dataSP();
}
function produtoFiscal(base, id) { return (base.produtos || []).find(p => p.id === id) || null; }
function produtoFiscalDaNota(base, itens) {
  for (const it of itens || []) if (it.ofertaId && base.ofertas[it.ofertaId]) return base.ofertas[it.ofertaId];
  return base.config.produtoPadrao || 'milhas';
}
function descricaoDa(pf, nota) {
  if (nota.descricao) return nota.descricao;
  const prods = [...new Set((nota.itens || []).map(i => i.produtoNome).filter(Boolean))];
  const ofs = [...new Set((nota.itens || []).map(i => i.ofertaNome).filter(Boolean))];
  const t = String((pf && pf.descricao) || '{produto}');
  return t.replace(/\{produto\}/g, prods.join(' + ') || ofs.join(' + ') || (pf && pf.nome) || '')
    .replace(/\{oferta\}/g, ofs.join(' + ') || prods.join(' + ') || '').trim();
}

function criarNotasFiscais(deps) {
  const { ghGetJson, ghPutJson } = deps;
  const log = deps.log || console;

  // ── Leitura/gravação (uma de cada vez; 409 = relê e reaplica) ─────────────
  let _fila = Promise.resolve();
  function serial(fn) { const p = _fila.then(fn); _fila = p.catch(() => {}); return p; }
  // Cache da última versão lida/gravada: a API do GitHub pode devolver a versão
  // anterior logo depois de um PUT (leitura atrasada), e só este proxy escreve
  // o arquivo. Vale por 2 min; depois relê do GitHub.
  let _cache = null; // { json, sha, em }
  async function ler() {
    if (_cache && Date.now() - _cache.em < 2 * 60 * 1000) return { base: normalizar(JSON.parse(_cache.json)), sha: _cache.sha };
    const { data, sha } = await ghGetJson(ARQ, null);
    if (!data && sha) throw new Error('leitura de ' + ARQ + ' falhou (tente de novo)');
    _cache = { json: JSON.stringify(data || null), sha, em: Date.now() };
    return { base: normalizar(data), sha };
  }
  async function mutar(fn, msg) {
    for (let t = 1; t <= 5; t++) {
      const { base, sha } = await ler();
      const r = await fn(base);
      if (r === false) return { base, mudou: false };
      try {
        const put = await ghPutJson(ARQ, base, sha, msg);
        const novoSha = put && put.content && put.content.sha;
        _cache = novoSha ? { json: JSON.stringify(base), sha: novoSha, em: Date.now() } : null;
        return { base, mudou: true, r };
      } catch (e) {
        _cache = null;
        if (t < 5 && /409|sha|conflict|does not match|expected/i.test(String(e.message))) { await new Promise(x => setTimeout(x, 600 * t)); continue; }
        throw e;
      }
    }
  }

  // ── Fila das vendas da Hubla ──────────────────────────────────────────────
  async function planejar() {
    const hubla = deps.hubla;
    if (!hubla || !hubla.temChaveApi()) return { erro: 'HUBLA_API_KEY não configurada' };
    const { base: atual } = await ler();
    const desdeCfg = atual.config.emitirDesde;
    if (!desdeCfg) return { erro: 'Defina a data "emitir a partir de"' };
    const janela = Date.now() - 75 * DIA;
    const desde = new Date(Math.max(janela, new Date(desdeCfg + 'T00:00:00-03:00').getTime() - 10 * DIA)).toISOString();
    const faturas = await hubla.faturasDesde(desde);
    let ofertasHubla = {};
    try { ofertasHubla = ((await deps.hublaArquivo()) || {}).ofertas || {}; } catch (e) { log.warn('[notas] ofertas da Hubla:', e.message); }
    const resumo = { faturas: faturas.length, novas: 0, reembolsadas: 0 };
    await mutar(base => {
      const porRef = new Map(base.notas.map(n => [n.ref, n]));
      let mudou = false;
      // Corte: o que já está na fila e foi pago antes de "emitir a partir de" sai da fila
      // (fica com o eNotas); se a data voltar para trás, volta para a fila.
      for (const n of base.notas) {
        if (n.origem !== 'hubla') continue;
        if ((n.status === 'pendente' || n.status === 'erro') && !n.nDps && antesDoCorte(n, base.config)) {
          n.statusAntesCorte = n.status; n.status = 'antes_do_corte';
          n.motivo = 'paga antes de "emitir a partir de" (' + base.config.emitirDesde.split('-').reverse().join('/') + '): fica com o eNotas';
          n.atualizadaEm = new Date().toISOString(); resumo.antesDoCorte = (resumo.antesDoCorte || 0) + 1; mudou = true;
        } else if (n.status === 'antes_do_corte' && !antesDoCorte(n, base.config)) {
          n.status = n.statusAntesCorte === 'erro' || !docValido(n.tomador && n.tomador.doc) ? 'erro' : 'pendente';
          delete n.statusAntesCorte; n.motivo = undefined; n.atualizadaEm = new Date().toISOString(); mudou = true;
        }
      }
      for (const f of faturas) {
        if (!f || !f.id) continue;
        const ref = 'hubla:' + f.id;
        const existente = porRef.get(ref);
        const status = String(f.status || '');
        if (status !== 'paid' && registrarTransicao(base, f, status.toLowerCase())) { resumo.transicao = (resumo.transicao || 0) + 1; mudou = true; }
        if (existente) {
          if (status !== 'paid') {
            if (existente.status === 'pendente' || existente.status === 'erro') {
              existente.status = 'venda_reembolsada'; existente.statusFatura = status; existente.atualizadaEm = new Date().toISOString();
              resumo.reembolsadas++; mudou = true;
            } else if (existente.status === 'emitida' && !existente.vendaReembolsadaEm) {
              existente.vendaReembolsadaEm = new Date().toISOString(); existente.statusFatura = status;
              existente.reembolsoTotal = STATUS_REEMBOLSO_TOTAL.has(status); mudou = true;
            }
          }
          continue;
        }
        if (status !== 'paid') continue;
        const valor = totalDe(f);
        const pagaEm = pagaEmDe(f) || isoOuNull(f.saleDate) || isoOuNull(f.createdAt);
        if (!(valor > 0) || !pagaEm) continue;
        const minimo = Number(base.config.minimo) || 0;
        if (nfse.dataSP(pagaEm) < desdeCfg) continue;
        const payer = f.payer || {};
        const doc = soDig(payer.document);
        const itens = itensDe(f, ofertasHubla);
        const nota = {
          id: novoId('NF'), ref, origem: 'hubla', faturaId: f.id, criadaEm: new Date().toISOString(),
          venda: isoOuNull(f.saleDate || f.createdAt), pagaEm,
          previstaPara: addDias(pagaEm, Number(base.config.diasEspera) >= 0 ? Number(base.config.diasEspera) : 7),
          valor: Math.round(valor * 100) / 100, parcelas: f.installments || null,
          tomador: {
            doc, nome: [payer.firstName, payer.lastName].filter(Boolean).join(' ') || payer.fullName || payer.name || '',
            email: String(payer.email || '').toLowerCase().trim(), fone: payer.phone || '',
          },
          itens, produtoFiscalId: produtoFiscalDaNota(base, itens),
          status: minimo > 0 && valor < minimo ? 'ignorada' : docValido(doc) ? 'pendente' : 'erro',
          motivo: minimo > 0 && valor < minimo ? 'abaixo do valor mínimo (R$ ' + minimo.toFixed(2) + ')' : undefined,
          erros: docValido(doc) ? [] : [{ codigo: 'SEM_DOC', descricao: 'A fatura não tem CPF/CNPJ válido do comprador. Corrija o documento e reative.' }],
          tentativas: 0,
        };
        base.notas.push(nota); porRef.set(ref, nota); resumo.novas++; mudou = true;
      }
      if (!mudou) return false;
    }, `notas: fila Hubla (+${resumo.novas})`);
    return resumo;
  }

  // ── Emissão de uma nota (produção ou teste) ────────────────────────────────
  function listaDe(base, ambiente) { return ambiente === 'producao' ? base.notas : base.testes; }

  async function emitirUma(id, ambiente) {
    // 1) reserva o número da DPS (gravado antes de enviar: nunca repete número)
    let dados = null, idDpsAnterior = null, aguardar = false;
    const reserva = await mutar(base => {
      const n = listaDe(base, ambiente).find(x => x.id === id);
      if (!n) throw new Error('nota não encontrada');
      if (n.status === 'emitida') { aguardar = true; return false; }
      if (!['pendente', 'erro', 'verificar', 'enviando'].includes(n.status)) throw new Error('nota não está na fila (' + n.status + ')');
      if (ambiente === 'producao' && !n.nDps && antesDoCorte(n, base.config)) throw new Error('venda paga antes de "emitir a partir de": a nota é do eNotas');
      const pf = produtoFiscal(base, n.produtoFiscalId);
      if (!pf) throw new Error('produto fiscal "' + n.produtoFiscalId + '" não existe');
      if (pf.ativo === false) throw new Error('produto fiscal "' + pf.nome + '" está desligado');
      if (ambiente === 'producao' && !pf.codigosConfirmados) throw new Error('códigos de "' + pf.nome + '" não confirmados com o contador');
      if (!docValido(n.tomador && n.tomador.doc)) throw new Error('tomador sem CPF/CNPJ válido');
      if (!n.nDps) {
        base.contadores[ambiente] = (Number(base.contadores[ambiente]) || 0) + 1;
        n.nDps = base.contadores[ambiente];
        n.serie = String(base.config.serie || '900');
      }
      idDpsAnterior = n.status === 'verificar' || n.status === 'enviando' ? n.idDps : null;
      const comp = competenciaDa(base, pf, n);
      dados = {
        serie: n.serie, numero: n.nDps, competencia: comp, empresa: base.empresa, tomador: n.tomador, valor: n.valor,
        servico: { cTribNac: pf.cTribNac, cTribMun: pf.cTribMun, cNBS: pf.cNBS, descricao: descricaoDa(pf, n), infoCompl: pf.infoCompl,
          pTotTribSN: pf.pTotTribSN, tribISSQN: pf.tribISSQN, tpRetISSQN: pf.tpRetISSQN, cstPisCofins: pf.cstPisCofins, tpRetPisCofins: pf.tpRetPisCofins },
      };
      n.idDps = nfse.idDps({ cMun: base.empresa.cMun, cnpj: base.empresa.cnpj, serie: n.serie, numero: n.nDps });
      n.status = 'enviando'; n.enviandoEm = new Date().toISOString(); n.competenciaUsada = comp; n.descricaoUsada = dados.servico.descricao;
    }, `notas: envia ${id}`);
    if (aguardar) return { ok: true, jaEmitida: true };
    if (!reserva || !dados) throw new Error('não foi possível reservar a nota');
    const idDps = nfse.idDps({ cMun: dados.empresa.cMun, cnpj: dados.empresa.cnpj, serie: dados.serie, numero: dados.numero });

    // 2) tentativa anterior sem resposta: a DPS já virou nota?
    let r = null;
    if (idDpsAnterior) {
      try {
        const c = await nfse.consultarDps(ambiente, idDpsAnterior);
        if (c.existe) { const b = await nfse.baixarNfse(ambiente, c.chave); if (b.ok) r = { ok: true, chave: c.chave, numero: b.numero, autorizadaEm: b.autorizadaEm, xml: b.xml, recuperada: true }; }
      } catch (e) { log.warn('[notas] consulta da DPS', idDpsAnterior, e.message); }
    }
    // 3) envio
    if (!r) {
      try { r = await nfse.emitir(ambiente, dados); } catch (e) { r = { ok: false, erros: [{ codigo: 'LOCAL', descricao: e.message }] }; }
      if (!r.ok && !r.ambiguo && (r.erros || []).some(e => /j[áa] (existe|foi)|duplic/i.test(e.descricao + ' ' + e.complemento))) {
        try {
          const c = await nfse.consultarDps(ambiente, idDps);
          if (c.existe) { const b = await nfse.baixarNfse(ambiente, c.chave); if (b.ok) r = { ok: true, chave: c.chave, numero: b.numero, autorizadaEm: b.autorizadaEm, xml: b.xml, recuperada: true }; }
        } catch (e) { log.warn('[notas] consulta da DPS duplicada', e.message); }
      }
    }
    // 4) resultado
    await mutar(base => {
      const n = listaDe(base, ambiente).find(x => x.id === id);
      if (!n) return false;
      n.tentativas = (Number(n.tentativas) || 0) + 1;
      n.ultimaTentativaEm = new Date().toISOString();
      if (r.ok) {
        n.status = 'emitida'; n.chave = r.chave; n.numero = r.numero || null; n.emitidaEm = r.autorizadaEm || new Date().toISOString();
        n.xmlGz = zlib.gzipSync(Buffer.from(r.xml || '', 'utf8')).toString('base64'); n.erros = [];
        if (r.alertas) n.alertas = r.alertas;
      } else if (r.ambiguo) {
        n.status = 'verificar'; n.erros = r.erros || [];
      } else {
        n.status = 'erro'; n.erros = r.erros || [];
      }
      delete n.enviandoEm;
    }, `notas: ${r.ok ? 'emitida' : 'erro'} ${id}`);
    if (r.ok) log.log(`[notas] ${ambiente} nota ${r.numero || '?'} emitida (${id})`);
    else log.warn(`[notas] ${ambiente} ${id} não emitida:`, JSON.stringify(r.erros || []).slice(0, 500));
    return r.ok ? { ok: true, chave: r.chave, numero: r.numero } : { ok: false, ambiguo: !!r.ambiguo, erros: r.erros };
  }

  // ── Cancelamento (evento e101101 no Emissor Nacional) ─────────────────────
  async function cancelarUma(id, ambiente, motivo, justificativa, origem) {
    const { base } = await ler();
    const n = listaDe(base, ambiente).find(x => x.id === id);
    if (!n) throw new Error('nota não encontrada');
    if (n.status === 'cancelada') return { ok: true, jaCancelada: true };
    if (n.status !== 'emitida' || !n.chave) throw new Error('só nota emitida pode ser cancelada');
    let r;
    try { r = await nfse.cancelar(ambiente, { cnpj: base.empresa.cnpj, chave: n.chave, motivo, justificativa }); }
    catch (e) { r = { ok: false, erros: [{ codigo: 'LOCAL', descricao: e.message }] }; }
    await mutar(b => {
      const x = listaDe(b, ambiente).find(y => y.id === id);
      if (!x) return false;
      const agora = new Date().toISOString();
      x.cancelamentoTentativas = (Number(x.cancelamentoTentativas) || 0) + 1;
      x.cancelamentoTentadoEm = agora;
      if (r.ok || r.jaCancelada) {
        x.status = 'cancelada'; x.canceladaEm = agora; x.canceladaPor = origem || 'manual';
        x.motivoCancelamento = Number(motivo) || 9; x.motivo = justificativa; x.cancelamentoErros = [];
        if (r.xml) x.eventoXmlGz = zlib.gzipSync(Buffer.from(r.xml, 'utf8')).toString('base64');
      } else {
        x.cancelamentoErros = r.erros || [];
      }
    }, `notas: cancelamento ${id} ${r.ok ? 'ok' : 'erro'}`);
    if (r.ok) log.log(`[notas] ${ambiente} nota ${n.numero || id} cancelada (${origem || 'manual'})`);
    else log.warn(`[notas] cancelamento ${id} recusado:`, JSON.stringify(r.erros || []).slice(0, 400));
    return r.ok || r.jaCancelada ? { ok: true } : { ok: false, erros: r.erros };
  }

  // ── Webhook da Hubla: venda cancelada/reembolsada → nota cancelada na hora ──
  // Chamado pelo /webhook/hubla-assinaturas em todo evento de fatura. Fatura que
  // deixou de estar paga: nota ainda na fila sai da fila; nota já emitida é
  // cancelada no Emissor Nacional (produção, reembolso total, cancelarReembolso).
  async function aoEventoHubla(type, event) {
    const inv = (event && event.invoice) || null;
    if (!inv || !inv.id) return { ignorado: 'sem fatura' };
    const t = String(type || '').toLowerCase();
    let status = String(inv.status || '').toLowerCase();
    if (!status || status === 'paid') {
      if (/partial/.test(t)) status = 'partially_refunded';
      else if (/refund/.test(t)) status = 'refunded';
      else if (/charge_?back|dispute/.test(t)) status = 'chargeback';
      else if (/cancel/.test(t)) status = 'canceled';
    }
    if (!status || status === 'paid') return { ignorado: 'fatura paga' };
    const ref = 'hubla:' + inv.id;
    let alvo = null, modo = null, cancelarAuto = true;
    await mutar(base => {
      alvo = null;
      modo = base.config.modo; cancelarAuto = base.config.cancelarReembolso !== false;
      const n = base.notas.find(x => x.ref === ref);
      if (!n || n.status === 'antes_do_corte') {
        if (registrarTransicao(base, inv, status, new Date().toISOString())) { alvo = { acao: 'transicao' }; return; }
        return false;
      }
      const agora = new Date().toISOString();
      if (n.status === 'pendente' || n.status === 'erro' || n.status === 'verificar') {
        n.status = 'venda_reembolsada'; n.statusFatura = status; n.atualizadaEm = agora;
        alvo = { id: n.id, acao: 'fila' };
      } else if (n.status === 'emitida') {
        alvo = { id: n.id, acao: 'emitida' };
        if (n.vendaReembolsadaEm && n.statusFatura === status) return false;
        n.vendaReembolsadaEm = n.vendaReembolsadaEm || agora; n.statusFatura = status;
        n.reembolsoTotal = STATUS_REEMBOLSO_TOTAL.has(status);
      } else return false;
    }, `notas: webhook ${status} ${inv.id}`);
    if (!alvo) return { ignorado: 'sem nota' };
    if (alvo.acao === 'transicao') { log.log(`[notas] webhook Hubla ${type}: venda do eNotas (antes do corte) ${status}, fatura ${inv.id} — cancelar no eNotas`); return alvo; }
    log.log(`[notas] webhook Hubla ${type}: fatura ${status}, nota ${alvo.id} (${alvo.acao})`);
    if (alvo.acao !== 'emitida' || modo !== 'producao' || !cancelarAuto || !STATUS_REEMBOLSO_TOTAL.has(status)) return alvo;
    const r = await cancelarUma(alvo.id, 'producao', 2,
      'Venda cancelada com reembolso integral ao cliente (fatura ' + status + ' na Hubla).', 'reembolso');
    return Object.assign(alvo, { cancelada: !!r.ok, erros: r.erros });
  }

  // ── Ciclo automático ──────────────────────────────────────────────────────
  let _rodando = false;
  async function ciclo(motivo) {
    if (_rodando) return { ok: false, erro: 'ciclo já em andamento' };
    _rodando = true;
    const rodada = { em: new Date().toISOString(), motivo: motivo || 'agenda', emitidas: 0, erros: 0 };
    try {
      const { base } = await ler();
      const modo = base.config.modo;
      if (modo === 'desligado') { rodada.pulou = 'desligado'; return rodada; }
      try { Object.assign(rodada, await planejar()); } catch (e) { rodada.erroFila = e.message; }
      if (modo === 'producao' && base.config.emitirAuto !== false) {
        const { base: b2 } = await ler();
        const agora = Date.now();
        const vez = b2.notas.filter(n => !(antesDoCorte(n, b2.config) && !n.nDps) && (n.status === 'pendente' || n.status === 'verificar' ||
          (n.status === 'enviando' && agora - new Date(n.enviandoEm || 0).getTime() > 10 * 60 * 1000)) &&
          new Date(n.previstaPara || 0).getTime() <= agora)
          .sort((a, c) => String(a.previstaPara).localeCompare(String(c.previstaPara)))
          .slice(0, Math.max(1, Math.min(50, Number(b2.config.loteMax) || 15)));
        for (const n of vez) {
          try {
            const r = await emitirUma(n.id, 'producao');
            if (r.ok) rodada.emitidas++; else rodada.erros++;
          } catch (e) { rodada.erros++; log.warn('[notas] emitir', n.id, e.message); }
          await new Promise(x => setTimeout(x, 2500));
        }
        // Venda reembolsada (devolução total) depois da nota emitida: cancela a nota.
        if (b2.config.cancelarReembolso !== false) {
          const { base: b3 } = await ler();
          const cancelar = b3.notas.filter(n => n.status === 'emitida' && n.vendaReembolsadaEm && n.reembolsoTotal &&
            (Number(n.cancelamentoTentativas) || 0) < 3 &&
            (!n.cancelamentoTentadoEm || agora - new Date(n.cancelamentoTentadoEm).getTime() > 6 * 3600 * 1000)).slice(0, 10);
          rodada.canceladas = 0;
          for (const n of cancelar) {
            try {
              const r = await cancelarUma(n.id, 'producao', 2,
                'Venda cancelada com reembolso integral ao cliente (fatura ' + (n.statusFatura || 'reembolsada') + ' na Hubla).', 'reembolso');
              if (r.ok) rodada.canceladas++; else rodada.erros++;
            } catch (e) { rodada.erros++; log.warn('[notas] cancelar', n.id, e.message); }
            await new Promise(x => setTimeout(x, 2500));
          }
        }
      }
      return rodada;
    } catch (e) {
      rodada.erro = e.message;
      return rodada;
    } finally {
      _rodando = false;
      try { await mutar(b => { b.rodada = rodada; }, 'notas: rodada'); } catch (e) { log.warn('[notas] gravar rodada', e.message); }
    }
  }

  // Nota avulsa (tomador digitado) ou teste a partir de uma nota da fila.
  async function criarAvulsa(corpo, ambiente) {
    const t = corpo.tomador || {};
    const doc = soDig(t.doc);
    if (!docValido(doc)) throw new Error('CPF/CNPJ do tomador inválido');
    const valor = Math.round(Number(String(corpo.valor).replace(',', '.')) * 100) / 100;
    if (!(valor > 0)) throw new Error('valor inválido');
    const comp = corpo.competencia && /^\d{4}-\d{2}-\d{2}$/.test(corpo.competencia) ? corpo.competencia : null;
    let id = null;
    await mutar(base => {
      if (!produtoFiscal(base, corpo.produtoFiscalId)) throw new Error('produto fiscal inválido');
      const n = {
        id: novoId(ambiente === 'producao' ? 'NF' : 'T'), ref: 'avulsa:' + Date.now(), origem: corpo.origem || 'avulsa',
        criadaEm: new Date().toISOString(), previstaPara: new Date().toISOString(), valor,
        tomador: { doc, nome: String(t.nome || '').trim(), email: String(t.email || '').trim(), fone: String(t.fone || '').trim() },
        itens: [], produtoFiscalId: corpo.produtoFiscalId, descricao: String(corpo.descricao || '').trim() || null,
        competencia: comp, status: 'pendente', erros: [], tentativas: 0, deNota: corpo.deNota || null,
      };
      listaDe(base, ambiente).push(n); id = n.id;
    }, `notas: avulsa ${ambiente}`);
    return id;
  }

  // ── Emitir de novo uma nota cancelada (mesma regra do Tica Promos, 19/11/2026) ──
  // A nota nova assume o lugar da cancelada (mesmo ref: reembolso e fila da Hubla
  // passam a apontar para ela); a cancelada fica no histórico com o ref renomeado.
  // ajustes: competencia (AAAA-MM-DD, vazio = regra do produto), valor.
  async function reemitirUma(id, ambiente, ajustes = {}) {
    const comp = String(ajustes.competencia || '').trim();
    if (comp && !/^\d{4}-\d{2}-\d{2}$/.test(comp)) throw new Error('competência inválida (use AAAA-MM-DD)');
    if (comp && comp > nfse.dataSP()) throw new Error('a competência não pode ser depois de hoje');
    let valor = null;
    if (ajustes.valor != null && String(ajustes.valor).trim() !== '') {
      valor = Math.round(Number(String(ajustes.valor).replace(',', '.')) * 100) / 100;
      if (!(valor > 0)) throw new Error('valor inválido');
    }
    let novoIdNota = null;
    await mutar(base => {
      const l = listaDe(base, ambiente);
      const n = l.find(x => x.id === id);
      if (!n) throw new Error('nota não encontrada');
      if (n.status !== 'cancelada') throw new Error('só nota cancelada pode ser emitida de novo');
      if (n.substituidaPor) throw new Error('esta nota já foi emitida de novo');
      const agora = new Date().toISOString();
      const nova = {
        id: novoId(ambiente === 'producao' ? 'NF' : 'T'), ref: n.ref, origem: n.origem, faturaId: n.faturaId || null,
        criadaEm: agora, previstaPara: agora, pagaEm: n.pagaEm || null,
        valor: valor != null ? valor : n.valor, tomador: Object.assign({}, n.tomador || {}),
        itens: (n.itens || []).map(i => Object.assign({}, i)), produtoFiscalId: n.produtoFiscalId,
        descricao: n.descricao || null, competencia: comp || null,
        status: 'pendente', erros: [], tentativas: 0, deNota: n.deNota || null, reemissaoDe: n.id,
      };
      n.ref = String(n.ref || '') + '#substituida:' + nova.id;
      n.substituidaPor = nova.id; n.atualizadaEm = agora;
      l.push(nova); novoIdNota = nova.id;
    }, `notas: emitir de novo ${id}`);
    return novoIdNota;
  }

  async function estado(todas) {
    const { base } = await ler();
    let ofertasHubla = [];
    try {
      const of = ((await deps.hublaArquivo()) || {}).ofertas || {};
      ofertasHubla = Object.entries(of).filter(([, o]) => o && !o.ehProduto)
        .map(([id, o]) => ({ id, nome: o.nome || '', produtoId: o.produtoId || null, produtoNome: o.produtoNome || '', arquivada: !!o.arquivada }))
        .sort((a, b) => (a.produtoNome + ' ' + a.nome).localeCompare(b.produtoNome + ' ' + b.nome, 'pt-BR'));
    } catch (e) { log.warn('[notas] ofertas', e.message); }
    const limpa = (n) => {
      const x = Object.assign({}, n); delete x.xmlGz; delete x.eventoXmlGz;
      x.temEvento = !!n.eventoXmlGz;
      x.tomador = Object.assign({}, n.tomador || {}, { docMascarado: mascararDoc(n.tomador && n.tomador.doc) });
      x.temXml = !!n.xmlGz;
      return x;
    };
    const ord = (l) => l.slice().sort((a, b) => String(b.pagaEm || b.criadaEm).localeCompare(String(a.pagaEm || a.criadaEm)));
    const notas = ord(base.notas);
    return {
      config: base.config, empresa: base.empresa, empresaAtualizada: base.empresaAtualizada || null, produtos: base.produtos, ofertas: base.ofertas, contadores: base.contadores,
      rodada: base.rodada, certificado: nfse.estadoCertificado(), hublaApi: !!(deps.hubla && deps.hubla.temChaveApi()),
      ofertasHubla,
      contagem: notas.reduce((m, n) => { m[n.status] = (m[n.status] || 0) + 1; return m; }, {}),
      notas: (todas ? notas : notas.slice(0, 400)).map(limpa),
      testes: ord(base.testes).slice(0, 50).map(limpa),
      transicao: (base.transicao || []).slice().sort((a, b) => String(b.reembolsoEm).localeCompare(String(a.reembolsoEm)))
        .map(x => Object.assign({}, x, { doc: undefined, docMascarado: mascararDoc(x.doc) })),
    };
  }

  return { ler, mutar, planejar, emitirUma, cancelarUma, reemitirUma, aoEventoHubla, ciclo, criarAvulsa, estado };
}

// ── Rotas (todas com X-CDV-Op) ───────────────────────────────────────────────
function registrar(app, deps) {
  const nf = criarNotasFiscais(deps);
  const op = deps.opAutorizado;
  const erro = (res, e, st) => res.status(st || 400).json({ ok: false, erro: e.message || String(e) });

  app.get('/notas/estado', async (req, res) => {
    if (!op(req, res)) return;
    try { res.json(Object.assign({ ok: true }, await nf.estado(req.query.todas === '1'))); } catch (e) { erro(res, e, 500); }
  });

  // Salva config, empresa, produtos fiscais e o vínculo oferta → produto fiscal.
  app.post('/notas/config', async (req, res) => {
    if (!op(req, res)) return;
    const b = req.body || {};
    try {
      const { base } = await nf.mutar(base => {
        if (b.config) {
          const c = Object.assign({}, base.config, b.config);
          if (!['desligado', 'homologacao', 'producao'].includes(c.modo)) throw new Error('modo inválido');
          if (c.emitirDesde && !/^\d{4}-\d{2}-\d{2}$/.test(c.emitirDesde)) throw new Error('data "emitir a partir de" inválida');
          if (c.modo === 'producao' && !c.emitirDesde) throw new Error('Para ligar a emissão defina "emitir a partir de" (vendas pagas antes dessa data ficam com o eNotas)');
          if (c.modo === 'producao' && !nfse.estadoCertificado().ok) throw new Error('certificado indisponível: ' + nfse.estadoCertificado().erro);
          c.diasEspera = Math.max(0, Math.min(60, Number(c.diasEspera) || 0));
          c.serie = String(soDig(c.serie) || '900').slice(0, 5);
          c.competencia = ['pagamento', 'mes'].includes(c.competencia) ? c.competencia : 'emissao';
          c.emitirAuto = c.emitirAuto !== false;
          c.minimo = Math.max(0, Number(String(c.minimo == null ? 0 : c.minimo).replace(',', '.')) || 0);
          c.loteMax = Math.max(1, Math.min(50, Number(c.loteMax) || 15));
          c.cancelarReembolso = c.cancelarReembolso !== false;
          if (c.produtoPadrao && !(b.produtos || base.produtos).some(p => p.id === c.produtoPadrao)) throw new Error('produto padrão inválido');
          base.config = c;
        }
        if (b.empresa) {
          const e = Object.assign({}, base.empresa, b.empresa);
          if (!cnpjValido(e.cnpj)) throw new Error('CNPJ da empresa inválido');
          e.cnpj = soDig(e.cnpj); e.im = soDig(e.im); e.cMun = soDig(e.cMun) || '3106200'; e.fone = soDig(e.fone);
          e.pTotTribSN = Math.max(0, Number(String(e.pTotTribSN).replace(',', '.')) || 0);
          if (['cnpj', 'im', 'razao', 'cMun', 'fone', 'email', 'opSimpNac', 'regApTribSN', 'regEspTrib'].some(k => String(e[k]) !== String(base.empresa[k])))
            base.empresaAtualizada = { em: new Date().toISOString(), por: 'gestor-cdv' };   // o Tica Promos puxa daqui
          base.empresa = e;
        }
        if (Array.isArray(b.produtos)) {
          const ids = new Set();
          base.produtos = b.produtos.map(p => {
            const id = String(p.id || '').trim() || ('pf-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5));
            if (ids.has(id)) throw new Error('produto fiscal repetido: ' + id); ids.add(id);
            const antes = base.produtos.find(q => q.id === id);
            const x = { id, nome: String(p.nome || '').trim(), cTribNac: soDig(p.cTribNac), cTribMun: soDig(p.cTribMun) || '001',
              cNBS: soDig(p.cNBS), descricao: String(p.descricao || '').trim(), infoCompl: String(p.infoCompl || '').trim(), ativo: p.ativo !== false,
              pTotTribSN: String(p.pTotTribSN == null ? '' : p.pTotTribSN).trim().replace(',', '.'),
              tribISSQN: soDig(p.tribISSQN) || '1', tpRetISSQN: soDig(p.tpRetISSQN) || '1',
              cstPisCofins: soDig(p.cstPisCofins), tpRetPisCofins: soDig(p.tpRetPisCofins) || '0',
              competencia: ['emissao', 'pagamento', 'mes'].includes(p.competencia) ? p.competencia : '',
              codigosConfirmados: p.codigosConfirmados === true };
            if (!x.nome) throw new Error('produto fiscal sem nome');
            if (x.cTribNac.length !== 6) throw new Error(x.nome + ': código de tributação nacional precisa de 6 dígitos');
            if (x.cNBS.length !== 9) throw new Error(x.nome + ': NBS precisa de 9 dígitos');
            if (!x.descricao) throw new Error(x.nome + ': descrição da nota vazia');
            if (x.pTotTribSN && !/^\d{1,2}(\.\d{1,2})?$/.test(x.pTotTribSN)) throw new Error(x.nome + ': alíquota do Simples inválida');
            // Mexeu nos códigos: precisa confirmar de novo com o contador.
            if (antes && ['cTribNac', 'cTribMun', 'cNBS'].some(k => antes[k] !== x[k]) && p.codigosConfirmados !== true) x.codigosConfirmados = false;
            return x;
          });
        }
        if (b.ofertas && typeof b.ofertas === 'object') {
          const o = {};
          for (const [k, v] of Object.entries(b.ofertas)) if (v && base.produtos.some(p => p.id === v)) o[k] = v;
          base.ofertas = o;
        }
      }, 'notas: configuração');
      res.json({ ok: true, config: base.config, empresa: base.empresa, produtos: base.produtos, ofertas: base.ofertas });
    } catch (e) { erro(res, e); }
  });

  // ── Empresa compartilhada (19/11/2026) ──────────────────────────────────────
  // Cadastro ÚNICO da empresa emissora para o Gestão CDV e para o Notas Fiscais
  // do Tica Promos (baileys-server/notas-shopee.js, que lê e grava por aqui com
  // a chave de operador). Só os dados da empresa: a alíquota do Simples
  // (pTotTribSN) continua em cada sistema.
  const CAMPOS_EMPRESA_COMP = ['cnpj', 'im', 'razao', 'cMun', 'fone', 'email', 'opSimpNac', 'regApTribSN', 'regEspTrib'];
  app.get('/notas/empresa', async (req, res) => {
    if (!op(req, res)) return;
    try {
      const { base } = await nf.ler();
      const empresa = {};
      for (const k of CAMPOS_EMPRESA_COMP) empresa[k] = base.empresa[k] == null ? '' : base.empresa[k];
      res.json({ ok: true, empresa, atualizada: base.empresaAtualizada || null });
    } catch (e) { erro(res, e, 500); }
  });
  app.post('/notas/empresa', async (req, res) => {
    if (!op(req, res)) return;
    const b = req.body || {};
    try {
      const { base } = await nf.mutar(base => {
        const e = Object.assign({}, base.empresa);
        for (const k of CAMPOS_EMPRESA_COMP) if (b.empresa && b.empresa[k] != null && String(b.empresa[k]).trim() !== '') e[k] = b.empresa[k];
        if (!cnpjValido(e.cnpj)) throw new Error('CNPJ da empresa inválido');
        e.cnpj = soDig(e.cnpj); e.im = soDig(e.im); e.cMun = soDig(e.cMun) || '3106200'; e.fone = soDig(e.fone);
        e.razao = String(e.razao || '').trim(); e.email = String(e.email || '').trim();
        for (const k of ['opSimpNac', 'regApTribSN', 'regEspTrib']) e[k] = Number(e[k]) || 0;
        if (CAMPOS_EMPRESA_COMP.every(k => String(e[k]) === String(base.empresa[k]))) return false;
        base.empresa = e;
        base.empresaAtualizada = { em: new Date().toISOString(), por: String(b.origem || 'api').slice(0, 30) };
      }, 'notas: empresa (' + String(b.origem || 'api').slice(0, 30) + ')');
      const empresa = {};
      for (const k of CAMPOS_EMPRESA_COMP) empresa[k] = base.empresa[k] == null ? '' : base.empresa[k];
      res.json({ ok: true, empresa, atualizada: base.empresaAtualizada || null });
    } catch (e) { erro(res, e); }
  });

  app.post('/notas/rodar', async (req, res) => {
    if (!op(req, res)) return;
    try { res.json({ ok: true, rodada: await nf.ciclo('manual') }); } catch (e) { erro(res, e, 500); }
  });

  // Emite agora uma nota da fila (produção). Só com a emissão ligada.
  app.post('/notas/emitir', async (req, res) => {
    if (!op(req, res)) return;
    try {
      const { base } = await nf.ler();
      if (base.config.modo !== 'producao') throw new Error('A emissão está em ' + base.config.modo + ': ligue o modo produção para emitir notas válidas');
      res.json(Object.assign({ ok: true }, await nf.emitirUma(String((req.body || {}).id || ''), 'producao')));
    } catch (e) { erro(res, e); }
  });

  // Nota de teste (homologação) a partir de uma nota da fila ou de dados digitados.
  app.post('/notas/teste', async (req, res) => {
    if (!op(req, res)) return;
    const b = req.body || {};
    try {
      let corpo = b;
      if (b.id) {
        const { base } = await nf.ler();
        const n = base.notas.find(x => x.id === b.id);
        if (!n) throw new Error('nota não encontrada');
        const pf = produtoFiscal(base, n.produtoFiscalId);
        corpo = { tomador: n.tomador, valor: n.valor, produtoFiscalId: n.produtoFiscalId, descricao: descricaoDa(pf, n), origem: 'teste', deNota: n.id };
      }
      const id = await nf.criarAvulsa(corpo, 'homologacao');
      res.json(Object.assign({ ok: true, id }, await nf.emitirUma(id, 'homologacao')));
    } catch (e) { erro(res, e); }
  });

  // Nota avulsa válida (produção), ex.: comissão de afiliados. Exige confirmar.
  app.post('/notas/avulsa', async (req, res) => {
    if (!op(req, res)) return;
    const b = req.body || {};
    try {
      if (!b.confirmar) throw new Error('confirmação ausente');
      const { base } = await nf.ler();
      if (base.config.modo !== 'producao') throw new Error('A emissão está em ' + base.config.modo + ': ligue o modo produção para emitir notas válidas');
      if (!nfse.estadoCertificado().ok) throw new Error('certificado indisponível');
      const id = await nf.criarAvulsa(b, 'producao');
      res.json(Object.assign({ ok: true, id }, await nf.emitirUma(id, 'producao')));
    } catch (e) { erro(res, e); }
  });

  // Cancela a nota no Emissor Nacional (evento e101101). Nota de teste cancela em homologação.
  app.post('/notas/cancelar', async (req, res) => {
    if (!op(req, res)) return;
    const b = req.body || {};
    try {
      const amb = b.teste ? 'homologacao' : 'producao';
      res.json(Object.assign({ ok: true }, await nf.cancelarUma(String(b.id || ''), amb, b.motivo, String(b.justificativa || ''), 'manual')));
    } catch (e) { erro(res, e); }
  });

  // Emitir de novo uma nota cancelada (com competência/valor ajustados). Em produção
  // sai na hora só com o modo Produção; senão fica pendente na fila.
  app.post('/notas/reemitir', async (req, res) => {
    if (!op(req, res)) return;
    const b = req.body || {};
    try {
      const amb = b.teste ? 'homologacao' : 'producao';
      const id = await nf.reemitirUma(String(b.id || ''), amb, { competencia: b.competencia, valor: b.valor });
      const { base } = await nf.ler();
      if (amb === 'producao' && base.config.modo !== 'producao') return res.json({ ok: true, id, naFila: true, aviso: 'A emissão está em ' + base.config.modo + ': a nota nova ficou pendente na fila' });
      res.json(Object.assign({ ok: true, id }, await nf.emitirUma(id, amb)));
    } catch (e) { erro(res, e); }
  });

  // ignorar (não emitir), reativar (volta para a fila), cancelada (cancelada no Emissor Nacional),
  // produto (troca o produto fiscal), tomador (corrige CPF/nome antes de emitir).
  // Reembolso de venda do eNotas (antes do corte): marcar como resolvido (já cancelado no eNotas) ou reabrir.
  app.post('/notas/transicao', async (req, res) => {
    if (!op(req, res)) return;
    const b = req.body || {};
    try {
      await nf.mutar(base => {
        const x = (base.transicao || []).find(t => t.faturaId === b.faturaId);
        if (!x) throw new Error('reembolso não encontrado');
        if (b.acao === 'resolvido') x.resolvidaEm = new Date().toISOString();
        else if (b.acao === 'reabrir') x.resolvidaEm = null;
        else throw new Error('ação inválida');
      }, `notas: transição ${b.acao} ${b.faturaId}`);
      res.json({ ok: true });
    } catch (e) { erro(res, e); }
  });

  app.post('/notas/situacao', async (req, res) => {
    if (!op(req, res)) return;
    const b = req.body || {};
    try {
      await nf.mutar(base => {
        const l = b.teste ? base.testes : base.notas;
        const n = l.find(x => x.id === b.id);
        if (!n) throw new Error('nota não encontrada');
        const agora = new Date().toISOString();
        if (b.acao === 'ignorar') {
          if (n.status === 'emitida') throw new Error('nota já emitida: cancele no Emissor Nacional e marque como cancelada');
          n.status = 'ignorada'; n.motivo = String(b.motivo || '').trim() || null;
        } else if (b.acao === 'reativar') {
          if (n.status === 'emitida') throw new Error('nota já emitida');
          if (!b.teste && antesDoCorte(n, base.config)) throw new Error('venda paga antes de "emitir a partir de": a nota é do eNotas');
          n.status = 'pendente'; n.erros = [];
        } else if (b.acao === 'cancelada') {
          if (n.status !== 'emitida') throw new Error('só nota emitida pode ser marcada como cancelada');
          n.status = 'cancelada'; n.canceladaEm = agora; n.motivo = String(b.motivo || '').trim() || null;
        } else if (b.acao === 'produto') {
          if (n.status === 'emitida') throw new Error('nota já emitida');
          if (!produtoFiscal(base, b.produtoFiscalId)) throw new Error('produto fiscal inválido');
          n.produtoFiscalId = b.produtoFiscalId;
        } else if (b.acao === 'tomador') {
          if (n.status === 'emitida') throw new Error('nota já emitida');
          const t = b.tomador || {};
          if (t.doc != null) { if (!docValido(t.doc)) throw new Error('CPF/CNPJ inválido'); n.tomador.doc = soDig(t.doc); }
          if (t.nome != null) n.tomador.nome = String(t.nome).trim();
          if (n.status === 'erro' && docValido(n.tomador.doc)) { n.status = 'pendente'; n.erros = []; }
        } else throw new Error('ação inválida');
        n.atualizadaEm = agora;
      }, `notas: ${b.acao} ${b.id}`);
      res.json({ ok: true });
    } catch (e) { erro(res, e); }
  });

  // XML (guardado) ou PDF (DANFSe baixado do Emissor Nacional na hora).
  app.get('/notas/arquivo/:id/:tipo', async (req, res) => {
    if (!op(req, res)) return;
    try {
      const { base } = await nf.ler();
      const teste = base.testes.find(x => x.id === req.params.id);
      const n = teste || base.notas.find(x => x.id === req.params.id);
      if (!n || !n.chave) throw new Error('nota sem chave de acesso');
      if (!['xml', 'pdf', 'evento'].includes(req.params.tipo)) throw new Error('tipo inválido');
      const amb = teste ? 'homologacao' : 'producao';
      const nome = `nfse-${n.numero || n.chave}`;
      if (req.params.tipo === 'evento') {
        if (!n.eventoXmlGz) throw new Error('XML do cancelamento não guardado');
        res.setHeader('Content-Type', 'application/xml; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${nome}-cancelamento.xml"`);
        return res.send(zlib.gunzipSync(Buffer.from(n.eventoXmlGz, 'base64')));
      }
      if (req.params.tipo === 'xml') {
        if (!n.xmlGz) throw new Error('XML não guardado');
        res.setHeader('Content-Type', 'application/xml; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${nome}.xml"`);
        return res.send(zlib.gunzipSync(Buffer.from(n.xmlGz, 'base64')));
      }
      // PDF montado aqui a partir do XML autorizado (danfse.cjs, igual ao Tica Promos):
      // a API de DANFSe do ADN foi desligada em 03/08/2026 (NT 008) e responde 503.
      let xml = n.xmlGz ? zlib.gunzipSync(Buffer.from(n.xmlGz, 'base64')).toString('utf8') : '';
      if (!xml) {
        const r = await nfse.baixarNfse(amb, n.chave);
        if (!r.ok) throw new Error('XML da nota não guardado e a Sefin não o devolveu agora (HTTP ' + r.status + '). A nota segue emitida; o PDF oficial sai na Consulta Pública do Portal Nacional com a chave ' + n.chave + '.');
        xml = r.xml;
      }
      const pdf = danfse.gerarDanfse(xml, { cancelada: n.status === 'cancelada' });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${nome}.pdf"`);
      res.send(pdf);
    } catch (e) { erro(res, e); }
  });

  app.get('/notas/certificado', (req, res) => {
    if (!op(req, res)) return;
    res.json(Object.assign({ ok: true }, nfse.estadoCertificado()));
  });
  // Envio do certificado pela tela (19/11/2026, igual ao Tica Promos). Fica no
  // notas-fiscais.json (repo de dados, privado) com o .pfx e a senha cifrados
  // (AES-256-GCM, chave do servidor); vale mais que NFSE_CERT_PFX/NFSE_CERT_SENHA.
  app.post('/notas/certificado', async (req, res) => {
    if (!op(req, res)) return;
    const b = req.body || {};
    try {
      const pfx = String(b.pfxB64 || '').replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
      if (!pfx) throw new Error('arquivo .pfx vazio');
      const est = nfse.testarPfx(pfx, String(b.senha || ''));
      await nf.mutar(base => { base.certificadoCifrado = nfse.cifrarCert(pfx, String(b.senha || '')); base.certificadoEnviadoEm = new Date().toISOString(); }, 'notas: certificado');
      nfse.usarPfx(pfx, String(b.senha || ''), 'painel');
      res.json(Object.assign({ ok: true }, est));
    } catch (e) { erro(res, e); }
  });
  // Certificado enviado pela tela: carrega no boot.
  nf.ler().then(({ base }) => {
    if (!base.certificadoCifrado) return;
    try { const c = nfse.decifrarCert(base.certificadoCifrado); nfse.usarPfx(c.pfx, c.senha, 'painel'); }
    catch (e) { console.warn('[notas] certificado salvo não abre:', e.message); }
  }).catch(() => {});

  // Agenda: a cada 30 min (primeira rodada 2 min após o boot).
  setTimeout(() => nf.ciclo('boot').catch(() => {}), 2 * 60 * 1000);
  setInterval(() => nf.ciclo('agenda').catch(() => {}), 30 * 60 * 1000);

  // Autoteste de conexão (env NFSE_AUTOTESTE=1): emite uma nota de teste em
  // homologação com tomador fictício e escreve o resultado no log.
  if (process.env.NFSE_AUTOTESTE === '1') {
    setTimeout(async () => {
      try {
        console.log('[notas] autoteste: certificado', JSON.stringify(nfse.estadoCertificado()));
        const id = await nf.criarAvulsa({ tomador: { doc: '12345678909', nome: 'Tomador Teste' }, valor: 1, produtoFiscalId: 'milhas',
          descricao: 'Teste de integração (homologação)', origem: 'autoteste' }, 'homologacao');
        const r = await nf.emitirUma(id, 'homologacao');
        console.log('[notas] autoteste resultado:', JSON.stringify(r).slice(0, 1500));
        if (r.ok) {
          const rc = await nf.cancelarUma(id, 'homologacao', 1, 'Teste de cancelamento da integração (homologação).', 'autoteste');
          console.log('[notas] autoteste cancelamento:', JSON.stringify(rc).slice(0, 1500));
        }
      } catch (e) { console.error('[notas] autoteste falhou:', e.message, e.code || ''); }
    }, 70 * 1000);
  }
  return nf;
}

module.exports = { registrar, criarNotasFiscais, normalizar, itensDe, cpfValido, cnpjValido, descricaoDa };
