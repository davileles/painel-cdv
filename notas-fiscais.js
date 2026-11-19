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

const ARQ = 'notas-fiscais.json';
const DIA = 864e5;
const soDig = (s) => String(s == null ? '' : s).replace(/\D/g, '');

const PRODUTOS_PADRAO = [
  { id: 'afiliados', nome: 'Comissão de afiliados', cTribNac: '170601', cTribMun: '001', cNBS: '114061900',
    descricao: 'Comissões de afiliados', infoCompl: '', ativo: true },
  { id: 'milhas', nome: 'Produtos de milhas', cTribNac: '080201', cTribMun: '001', cNBS: '122051900',
    descricao: '{produto}', infoCompl: 'Valor aprox dos tributos: 7,47% Fonte: IBPT 115C76.', ativo: true },
];

function padrao() {
  return {
    versao: 1,
    config: { modo: 'desligado', emitirDesde: null, diasEspera: 7, serie: '900', competencia: 'emissao', produtoPadrao: 'milhas', loteMax: 15 },
    empresa: { cnpj: '34379496000178', im: '11662870013', razao: 'Tudo Sobre Milhas Curso Online Ltda', cMun: '3106200',
      fone: '', email: '', opSimpNac: 3, regApTribSN: 1, regEspTrib: 0, pTotTribSN: 7.47 },
    produtos: PRODUTOS_PADRAO.map(p => Object.assign({}, p)),
    ofertas: {},
    contadores: { producao: 0, homologacao: 0 },
    notas: [],
    testes: [],
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
      for (const f of faturas) {
        if (!f || !f.id) continue;
        const ref = 'hubla:' + f.id;
        const existente = porRef.get(ref);
        const status = String(f.status || '');
        if (existente) {
          if (status !== 'paid') {
            if (existente.status === 'pendente' || existente.status === 'erro') {
              existente.status = 'venda_reembolsada'; existente.statusFatura = status; existente.atualizadaEm = new Date().toISOString();
              resumo.reembolsadas++; mudou = true;
            } else if (existente.status === 'emitida' && !existente.vendaReembolsadaEm) {
              existente.vendaReembolsadaEm = new Date().toISOString(); existente.statusFatura = status; mudou = true;
            }
          }
          continue;
        }
        if (status !== 'paid') continue;
        const valor = totalDe(f);
        const pagaEm = pagaEmDe(f) || isoOuNull(f.saleDate) || isoOuNull(f.createdAt);
        if (!(valor > 0) || !pagaEm) continue;
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
          status: docValido(doc) ? 'pendente' : 'erro',
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
      const pf = produtoFiscal(base, n.produtoFiscalId);
      if (!pf) throw new Error('produto fiscal "' + n.produtoFiscalId + '" não existe');
      if (pf.ativo === false) throw new Error('produto fiscal "' + pf.nome + '" está desligado');
      if (!docValido(n.tomador && n.tomador.doc)) throw new Error('tomador sem CPF/CNPJ válido');
      if (!n.nDps) {
        base.contadores[ambiente] = (Number(base.contadores[ambiente]) || 0) + 1;
        n.nDps = base.contadores[ambiente];
        n.serie = String(base.config.serie || '900');
      }
      idDpsAnterior = n.status === 'verificar' || n.status === 'enviando' ? n.idDps : null;
      const comp = n.competencia || (base.config.competencia === 'pagamento' && n.pagaEm ? nfse.dataSP(n.pagaEm) : nfse.dataSP());
      dados = {
        serie: n.serie, numero: n.nDps, competencia: comp, empresa: base.empresa, tomador: n.tomador, valor: n.valor,
        servico: { cTribNac: pf.cTribNac, cTribMun: pf.cTribMun, cNBS: pf.cNBS, descricao: descricaoDa(pf, n), infoCompl: pf.infoCompl },
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
      if (modo === 'producao') {
        const { base: b2 } = await ler();
        const agora = Date.now();
        const vez = b2.notas.filter(n => (n.status === 'pendente' || n.status === 'verificar' ||
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
      const x = Object.assign({}, n); delete x.xmlGz;
      x.tomador = Object.assign({}, n.tomador || {}, { docMascarado: mascararDoc(n.tomador && n.tomador.doc) });
      x.temXml = !!n.xmlGz;
      return x;
    };
    const ord = (l) => l.slice().sort((a, b) => String(b.pagaEm || b.criadaEm).localeCompare(String(a.pagaEm || a.criadaEm)));
    const notas = ord(base.notas);
    return {
      config: base.config, empresa: base.empresa, produtos: base.produtos, ofertas: base.ofertas, contadores: base.contadores,
      rodada: base.rodada, certificado: nfse.estadoCertificado(), hublaApi: !!(deps.hubla && deps.hubla.temChaveApi()),
      ofertasHubla,
      contagem: notas.reduce((m, n) => { m[n.status] = (m[n.status] || 0) + 1; return m; }, {}),
      notas: (todas ? notas : notas.slice(0, 400)).map(limpa),
      testes: ord(base.testes).slice(0, 50).map(limpa),
    };
  }

  return { ler, mutar, planejar, emitirUma, ciclo, criarAvulsa, estado };
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
          c.competencia = c.competencia === 'pagamento' ? 'pagamento' : 'emissao';
          c.loteMax = Math.max(1, Math.min(50, Number(c.loteMax) || 15));
          if (c.produtoPadrao && !(b.produtos || base.produtos).some(p => p.id === c.produtoPadrao)) throw new Error('produto padrão inválido');
          base.config = c;
        }
        if (b.empresa) {
          const e = Object.assign({}, base.empresa, b.empresa);
          if (!cnpjValido(e.cnpj)) throw new Error('CNPJ da empresa inválido');
          e.cnpj = soDig(e.cnpj); e.im = soDig(e.im); e.cMun = soDig(e.cMun) || '3106200'; e.fone = soDig(e.fone);
          e.pTotTribSN = Math.max(0, Number(String(e.pTotTribSN).replace(',', '.')) || 0);
          base.empresa = e;
        }
        if (Array.isArray(b.produtos)) {
          const ids = new Set();
          base.produtos = b.produtos.map(p => {
            const id = String(p.id || '').trim() || ('pf-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5));
            if (ids.has(id)) throw new Error('produto fiscal repetido: ' + id); ids.add(id);
            const x = { id, nome: String(p.nome || '').trim(), cTribNac: soDig(p.cTribNac), cTribMun: soDig(p.cTribMun) || '001',
              cNBS: soDig(p.cNBS), descricao: String(p.descricao || '').trim(), infoCompl: String(p.infoCompl || '').trim(), ativo: p.ativo !== false };
            if (!x.nome) throw new Error('produto fiscal sem nome');
            if (x.cTribNac.length !== 6) throw new Error(x.nome + ': código de tributação nacional precisa de 6 dígitos');
            if (x.cNBS.length !== 9) throw new Error(x.nome + ': NBS precisa de 9 dígitos');
            if (!x.descricao) throw new Error(x.nome + ': descrição da nota vazia');
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
      if (!nfse.estadoCertificado().ok) throw new Error('certificado indisponível');
      const id = await nf.criarAvulsa(b, 'producao');
      res.json(Object.assign({ ok: true, id }, await nf.emitirUma(id, 'producao')));
    } catch (e) { erro(res, e); }
  });

  // ignorar (não emitir), reativar (volta para a fila), cancelada (cancelada no Emissor Nacional),
  // produto (troca o produto fiscal), tomador (corrige CPF/nome antes de emitir).
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
      const amb = teste ? 'homologacao' : 'producao';
      const nome = `nfse-${n.numero || n.chave}`;
      if (req.params.tipo === 'xml') {
        if (!n.xmlGz) throw new Error('XML não guardado');
        res.setHeader('Content-Type', 'application/xml; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${nome}.xml"`);
        return res.send(zlib.gunzipSync(Buffer.from(n.xmlGz, 'base64')));
      }
      const r = await nfse.baixarDanfse(amb, n.chave);
      if (!r.ok) throw new Error('DANFSe indisponível no Emissor Nacional (HTTP ' + r.status + ')');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${nome}.pdf"`);
      res.send(r.pdf);
    } catch (e) { erro(res, e); }
  });

  app.get('/notas/certificado', (req, res) => {
    if (!op(req, res)) return;
    res.json(Object.assign({ ok: true }, nfse.estadoCertificado()));
  });

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
      } catch (e) { console.error('[notas] autoteste falhou:', e.message, e.code || ''); }
    }, 70 * 1000);
  }
  return nf;
}

module.exports = { registrar, criarNotasFiscais, normalizar, itensDe, cpfValido, cnpjValido, descricaoDa };
