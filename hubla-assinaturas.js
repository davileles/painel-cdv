// hubla-assinaturas.js — controle das assinaturas da Hubla (início, fim, status)
// e decisão de quais ofertas liberam o painel do membro CDV.
//
// - Dados em `hubla-assinaturas.json` no repo PRIVADO de dados (ARQUIVOS_SENSIVEIS):
//   { atualizadoEm, ofertas: {id: {...}}, assinaturas: {id: {...}}, acessos: {email: {...}}, sincronizacao }
// - Entrada em tempo real: webhook `POST /webhook/hubla-assinaturas` (index.js).
// - Histórico e conferência diária: API pública da Hubla (env HUBLA_API_KEY).
// - Toda escrita passa por `salvar()` (fila única + SHA fresco + retry), para
//   webhook e sincronização não se atropelarem (lost update).
//
// CommonJS. Dependências injetadas por index.js: ghGetJson, ghPutJson, fetch.

const ARQUIVO = 'hubla-assinaturas.json';
const API_BASE = 'https://backend-bff-public-api.platform.hub.la';

// ── Quem libera o painel ──────────────────────────────────────────────────────
// Só estas ofertas do produto "Clube do Viajante - @davileles" (decisão do Davi,
// 29/10/2026). Casamento por nome normalizado DENTRO do produto: há ofertas com
// o mesmo nome (duas "Clube do Viajante (Premium)") e todas valem. Nome exato:
// "Escola do Viajante (acesso vitalício…)" NÃO casa com "Escola do Viajante".
const PRODUTO_PAINEL_ID = '5aPVHUjfhTa79XR2bWqC';
const PRODUTO_PAINEL_NOME = 'Clube do Viajante - @davileles';
const OFERTAS_PAINEL = [
  'Clube do Viajante (Premium)',
  'Clube do Viajante (Premium) Experimental',
  'Clube do Viajante (Premium) Ex-membros',
  'Clube do Viajante (ex-alunos) + acesso ao conteúdo gravado',
  'Consultoria Individual',
  'Escola do Viajante',
  'Travel Concierge',
];

function norm(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}
const _ofertasPainelNorm = new Set(OFERTAS_PAINEL.map(norm));

function produtoEhDoPainel(produtoId, produtoNome) {
  if (produtoId) return produtoId === PRODUTO_PAINEL_ID;
  return norm(produtoNome) === norm(PRODUTO_PAINEL_NOME);
}
function ofertaLiberaPainel(produtoId, produtoNome, ofertaNome) {
  return produtoEhDoPainel(produtoId, produtoNome) && _ofertasPainelNorm.has(norm(ofertaNome));
}

// Produto e oferta de um payload de webhook v2. Venda com order bump chega num
// evento só, com vários produtos (modo "Integração recomendada" da Hubla): vale
// o par que libera o painel, se houver; senão o primeiro.
function produtoOfertaDoEvento(event) {
  const e = event || {};
  const produtos = (Array.isArray(e.products) && e.products.length) ? e.products : [e.product || {}];
  const pares = [];
  for (const produto of produtos) {
    const p = produto || {};
    const ofertas = (Array.isArray(p.offers) && p.offers.length) ? p.offers : [{}];
    for (const oferta of ofertas) {
      pares.push({
        produtoId: p.id || '',
        produtoNome: p.name || '',
        ofertaId: (oferta && oferta.id) || '',
        ofertaNome: (oferta && oferta.name) || p.name || '',
      });
    }
  }
  return pares.find(x => ofertaLiberaPainel(x.produtoId, x.produtoNome, x.ofertaNome)) || pares[0];
}

// ── Datas e situação ─────────────────────────────────────────────────────────
function iso(v) {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
function minIso(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return new Date(a) <= new Date(b) ? a : b;
}
const DIA = 24 * 60 * 60 * 1000;

// Situação e fim calculados na hora (o fim de uma assinatura ativa passa).
// - vigente/teste: fim = desativaEm (Hubla já sabe quando desliga) → próxima
//   cobrança → hoje + créditos (1 crédito = 1 dia).
// - encerrada: fim = inativação → cancelamento → última modificação.
function calcularSituacao(a, agora = Date.now()) {
  const st = String(a.status || '').toLowerCase();
  let fim = null;
  let situacao;
  if (st === 'active' || st === 'trial') {
    fim = a.desativaEm || a.proximaCobranca
      || (Number(a.creditos) > 0 ? new Date(agora + Number(a.creditos) * DIA).toISOString() : null);
    situacao = (st === 'trial' || a.teste) ? 'teste' : 'vigente';
    if (fim && new Date(fim).getTime() < agora - DIA && !a.renovacaoAutomatica) situacao = 'encerrada';
  } else if (st === 'incomplete') {
    situacao = 'pendente';
  } else if (st) {
    fim = a.inativadaEm || a.canceladaEm || a.modificadaEm || null;
    situacao = 'encerrada';
  } else {
    situacao = 'desconhecida';
  }
  const diasRestantes = fim && situacao !== 'encerrada'
    ? Math.ceil((new Date(fim).getTime() - agora) / DIA) : null;
  return { situacao, fim, diasRestantes };
}

// Converte o objeto de assinatura (webhook ou API) para o registro interno.
// Sem dado pessoal além de nome, e-mail e telefone (CPF não é guardado).
function camposDaAssinatura(sub) {
  const s = sub || {};
  const ativacoes = (Array.isArray(s.statusAt) ? s.statusAt : [])
    .filter(x => x && x.status === 'active' && x.when).map(x => iso(x.when)).filter(Boolean).sort();
  const lf = s.lastInvoice || null;
  const out = {
    tipo: s.type || undefined,
    status: s.status || undefined,
    teste: typeof s.freeTrial === 'boolean' ? s.freeTrial : undefined,
    cicloMeses: s.billingCycleMonths ?? undefined,
    formaPagamento: s.paymentMethod || undefined,
    renovacaoAutomatica: typeof s.autoRenew === 'boolean' ? s.autoRenew : undefined,
    creditos: typeof s.credits === 'number' ? s.credits : undefined,
    criadaEm: iso(s.createdAt) || undefined,
    ativadaEm: iso(s.activatedAt) || undefined,
    inativadaEm: iso(s.inactivatedAt) || undefined,
    canceladaEm: iso(s.canceledAt) || undefined,
    renovacaoDesativadaEm: iso(s.deactivatedAutoRenewAt) || undefined,
    proximaCobranca: iso(s.nextDueAt) || undefined,
    desativaEm: iso(s.deactivateEta) || undefined,
    ultimoDebito: iso(s.lastDebitAt) || undefined,
    modificadaEm: iso(s.modifiedAt) || undefined,
    version: typeof s.version === 'number' ? s.version : undefined,
    primeiraAtivacao: ativacoes[0] || undefined,
    ultimaFatura: lf ? {
      id: lf.id || null, tipo: lf.type || null, status: lf.status || null,
      venda: iso(lf.saleDate), vencimento: iso(lf.dueDate),
    } : undefined,
  };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

function pessoaDe(obj) {
  const p = obj || {};
  const nome = [p.firstName, p.lastName].filter(Boolean).join(' ') || p.fullName || p.name || '';
  return {
    email: String(p.email || '').toLowerCase().trim(),
    nome: nome.trim(),
    telefone: p.phone || '',
  };
}

// Mescla dados novos num registro. Campos da assinatura só sobrescrevem se a
// versão recebida não for mais antiga (eventos chegam fora de ordem).
function mesclarRegistro(atual, novo) {
  const r = Object.assign({}, atual || {});
  const vAtual = typeof r.version === 'number' ? r.version : -1;
  const vNovo = typeof novo.version === 'number' ? novo.version : null;
  const mAtual = r.modificadaEm ? new Date(r.modificadaEm).getTime() : 0;
  const mNovo = novo.modificadaEm ? new Date(novo.modificadaEm).getTime() : 0;
  const antigo = (vNovo !== null && vNovo < vAtual) || (vNovo === null && mNovo && mAtual && mNovo < mAtual);
  const CAMPOS_SUB = new Set(['tipo', 'status', 'teste', 'cicloMeses', 'formaPagamento', 'renovacaoAutomatica',
    'creditos', 'ativadaEm', 'inativadaEm', 'canceladaEm', 'renovacaoDesativadaEm', 'proximaCobranca',
    'desativaEm', 'ultimoDebito', 'modificadaEm', 'version', 'ultimaFatura']);
  for (const [k, v] of Object.entries(novo)) {
    if (v === undefined || v === null || v === '') continue;
    if (antigo && CAMPOS_SUB.has(k)) continue;
    r[k] = v;
  }
  // Início = primeira ativação conhecida (nunca anda para frente). ativadaEm é
  // a ÚLTIMA ativação, por isso só entra como candidato.
  const candidatos = [r.inicio, novo.primeiraAtivacao, r.ativadaEm, novo.ativadaEm].filter(Boolean).sort();
  r.inicio = candidatos[0] || r.criadaEm || null;
  delete r.primeiraAtivacao;
  return r;
}

function criarHublaAssinaturas({ ghGetJson, ghPutJson, fetch, log = console }) {
  const apiKey = () => process.env.HUBLA_API_KEY || process.env.HUBLA_PUBLIC_API_KEY || process.env.HUBLA_API_TOKEN || '';

  // ── Persistência: fila única ───────────────────────────────────────────────
  let fila = Promise.resolve();
  function salvar(alterar, mensagem) {
    const tarefa = fila.then(async () => {
      for (let t = 1; t <= 5; t++) {
        const { data, sha } = await ghGetJson(ARQUIVO, null);
        const base = data && typeof data === 'object' ? data : {};
        base.ofertas = base.ofertas || {};
        base.assinaturas = base.assinaturas || {};
        base.acessos = base.acessos || {};
        const resultado = await alterar(base);
        if (resultado === false) return base; // nada mudou
        base.atualizadoEm = new Date().toISOString();
        try {
          await ghPutJson(ARQUIVO, base, sha, mensagem || 'hubla: assinaturas');
          return base;
        } catch (e) {
          const conflito = /but expected|does not match|409/.test(e.message || '');
          if (!conflito || t === 5) throw e;
          await new Promise(r => setTimeout(r, t * 500));
        }
      }
    });
    fila = tarefa.catch(() => {});
    return tarefa;
  }
  async function ler() {
    const { data } = await ghGetJson(ARQUIVO, null);
    const d = data && typeof data === 'object' ? data : {};
    return { ofertas: d.ofertas || {}, assinaturas: d.assinaturas || {}, acessos: d.acessos || {},
      sincronizacao: d.sincronizacao || null, atualizadoEm: d.atualizadoEm || null };
  }

  // ── API pública ────────────────────────────────────────────────────────────
  let _ultimaChamada = 0;
  async function api(metodo, caminho, corpo) {
    const chave = apiKey();
    if (!chave) throw new Error('HUBLA_API_KEY não configurada no Railway');
    for (let t = 1; t <= 4; t++) {
      const espera = 700 - (Date.now() - _ultimaChamada); // ~85 req/min, abaixo do limite de 100
      if (espera > 0) await new Promise(r => setTimeout(r, espera));
      _ultimaChamada = Date.now();
      const r = await fetch(API_BASE + caminho, {
        method: metodo,
        headers: { Authorization: chave, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: corpo ? JSON.stringify(corpo) : undefined,
        timeout: 30000,
      });
      if (r.status === 429) {
        const ra = Number(r.headers.get('retry-after')) || 10 * t;
        await new Promise(res => setTimeout(res, Math.min(ra, 60) * 1000));
        continue;
      }
      if (r.status === 404) return null;
      const txt = await r.text();
      if (!r.ok) throw new Error(`Hubla ${metodo} ${caminho.split('?')[0]} → ${r.status} ${txt.slice(0, 200)}`);
      try { return JSON.parse(txt); } catch (e) { return null; }
    }
    throw new Error(`Hubla ${caminho.split('?')[0]}: limite de requisições`);
  }
  const buscarAssinaturaApi = (id) => api('GET', `/v1/subscriptions/${encodeURIComponent(id)}`);

  // ── Webhook ────────────────────────────────────────────────────────────────
  // Registra/atualiza a assinatura do evento. Devolve o registro mesclado (ou null).
  async function registrarEvento(type, event) {
    const e = event || {};
    const sub = e.subscription || null;
    const fatura = e.invoice || null;
    const subId = String((sub && sub.id) || e.subscriptionId || (fatura && (fatura.subscriptionId || (fatura.subscriptionIds || [])[0])) || '').trim();
    if (!subId) return null;
    const po = produtoOfertaDoEvento(e);
    const pessoa = pessoaDe(e.user || (sub && sub.payer) || (fatura && fatura.payer) || e.member || e.customer);
    const novo = Object.assign(
      { id: subId },
      pessoa.email ? pessoa : {},
      po.produtoId || po.produtoNome ? po : {},
      sub ? camposDaAssinatura(sub) : {},
      { ultimoEvento: type, ultimoEventoEm: new Date().toISOString() },
    );
    if (fatura) {
      novo.ultimaFatura = {
        id: fatura.id || null, tipo: fatura.type || null, status: fatura.status || null,
        venda: iso(fatura.saleDate || fatura.createdAt), vencimento: iso(fatura.dueDate), pagaEm: iso(fatura.paidAt),
      };
    }
    if (po.ofertaNome || po.produtoNome) novo.liberaPainel = ofertaLiberaPainel(po.produtoId, po.produtoNome, po.ofertaNome);

    // Completa pela API (próxima cobrança e data de desativação não vêm no webhook).
    if (apiKey()) {
      try {
        const completo = await buscarAssinaturaApi(subId);
        if (completo) Object.assign(novo, camposDaAssinatura(completo), { conferidaApiEm: new Date().toISOString() });
      } catch (err) { log.warn('[hubla-assinaturas] API', subId, err.message); }
    }

    let registro = null;
    await salvar(base => {
      registro = mesclarRegistro(base.assinaturas[subId], novo);
      base.assinaturas[subId] = registro;
      if (po.ofertaId) {
        base.ofertas[po.ofertaId] = Object.assign({}, base.ofertas[po.ofertaId], {
          nome: po.ofertaNome, produtoId: po.produtoId, produtoNome: po.produtoNome,
          liberaPainel: ofertaLiberaPainel(po.produtoId, po.produtoNome, po.ofertaNome),
        });
      }
    }, `hubla: ${type} ${subId.slice(0, 8)}`);
    return registro;
  }

  // ── Sincronização completa pela API ────────────────────────────────────────
  const progresso = { rodando: false, etapa: null, inicio: null, fim: null, erro: null, contagem: {} };

  async function paginar(fn, max = 500) {
    const itens = [];
    for (let page = 1; page <= max; page++) {
      const r = await fn(page);
      const lote = (r && (r.items || r.data)) || [];
      itens.push(...lote);
      const ultima = (r && (r.lastPage || (r.pagination && r.pagination.lastPage))) || 0;
      if (!lote.length || (ultima && page >= ultima)) break;
    }
    return itens;
  }

  async function sincronizar({ membrosAtivos } = {}) {
    if (progresso.rodando) return { ok: false, erro: 'sincronização já em andamento', progresso };
    if (!apiKey()) return { ok: false, erro: 'HUBLA_API_KEY não configurada no Railway' };
    Object.assign(progresso, { rodando: true, etapa: 'produtos', inicio: new Date().toISOString(), fim: null, erro: null, contagem: {} });
    try {
      // 1. Produtos e ofertas
      const produtos = await paginar(p => api('POST', '/v1/products/list', { page: p, pageSize: 100 }), 20);
      const ofertas = {};
      for (const pr of produtos) {
        ofertas[pr.id] = ofertas[pr.id] || { nome: pr.name, produtoId: pr.id, produtoNome: pr.name, liberaPainel: false, ehProduto: true };
        const lista = await paginar(p => api('GET', `/v1/products/${encodeURIComponent(pr.id)}/offers?page=${p}&pageSize=100`), 20);
        for (const of of lista) {
          ofertas[of.id] = { nome: of.name, produtoId: pr.id, produtoNome: pr.name,
            liberaPainel: ofertaLiberaPainel(pr.id, pr.name, of.name), arquivada: !!of.isArchived };
        }
      }
      progresso.contagem.produtos = produtos.length;
      progresso.contagem.ofertas = Object.values(ofertas).filter(o => !o.ehProduto).length;

      // 2. Faturas → assinaturas (pagador, oferta, primeira/última venda)
      progresso.etapa = 'faturas';
      const porSub = {};
      const ate = new Date().toISOString();
      const faturas = await paginar(p => api('POST', '/v1/invoices/list', {
        filters: { dateStart: '2018-01-01T00:00:00.000Z', dateEnd: ate, dateRangeBy: 'createdAt', orderBy: 'createdAt', orderDir: 'ASC' },
        pagination: { page: p, pageSize: 200 },
      }), 500);
      progresso.contagem.faturas = faturas.length;
      for (const f of faturas) {
        const ids = [f.subscriptionId, ...(Array.isArray(f.subscriptionIds) ? f.subscriptionIds : [])].filter(Boolean);
        for (const sid of new Set(ids)) {
          const x = porSub[sid] = porSub[sid] || { id: sid, faturas: 0, pagas: 0 };
          x.faturas++;
          if (f.status === 'paid') x.pagas++;
          const pessoa = pessoaDe(f.payer);
          if (pessoa.email) Object.assign(x, pessoa);
          const item = (Array.isArray(f.items) ? f.items : []).find(i => i && ofertas[i.id] && !ofertas[i.id].ehProduto)
            || (Array.isArray(f.items) ? f.items : []).find(i => i && ofertas[i.id])
            || (Array.isArray(f.items) ? f.items[0] : null);
          if (item) {
            const o = ofertas[item.id];
            x.ofertaId = item.id;
            x.ofertaNome = o ? o.nome : item.name;
            if (o) { x.produtoId = o.produtoId; x.produtoNome = o.produtoNome; }
          }
          const quando = iso(f.paidAt || f.createdAt);
          if (f.status === 'paid' && quando) {
            x.primeiroPagamento = minIso(x.primeiroPagamento || null, quando);
            if (!x.ultimoPagamento || quando > x.ultimoPagamento) x.ultimoPagamento = quando;
          }
        }
      }

      // 3. Cada assinatura pela API (datas exatas)
      progresso.etapa = 'assinaturas';
      const ids = Object.keys(porSub);
      progresso.contagem.assinaturas = ids.length;
      progresso.contagem.lidas = 0;
      const registros = {};
      for (const sid of ids) {
        let completo = null;
        try { completo = await buscarAssinaturaApi(sid); } catch (err) { log.warn('[hubla-sync]', sid, err.message); }
        const base = porSub[sid];
        const novo = Object.assign({}, base, completo ? camposDaAssinatura(completo) : {},
          completo ? { conferidaApiEm: new Date().toISOString() } : {});
        if (!novo.primeiraAtivacao && base.primeiroPagamento) novo.primeiraAtivacao = base.primeiroPagamento;
        if (novo.ofertaNome || novo.produtoNome) novo.liberaPainel = ofertaLiberaPainel(novo.produtoId, novo.produtoNome, novo.ofertaNome);
        delete novo.faturas;
        novo.faturasPagas = base.pagas;
        registros[sid] = novo;
        progresso.contagem.lidas++;
      }

      // 4. Acessos atuais do produto do painel (status, data de remoção, vitalício)
      progresso.etapa = 'membros';
      const acessos = {};
      const membros = await paginar(p => api('GET', `/v1/${PRODUTO_PAINEL_ID}/members?page=${p}&pageSize=200`), 100);
      for (const m of membros) {
        const email = String(m.email || '').toLowerCase().trim();
        if (!email) continue;
        acessos[email] = { nome: m.name || '', telefone: m.phone || '', tipo: m.type || '', status: m.status || '',
          removidoEm: iso(m.removalAt), vitalicio: !!m.isLifetime };
      }
      progresso.contagem.acessosProduto = membros.length;

      // 5. Grava (mescla com o que webhooks gravaram no meio tempo)
      progresso.etapa = 'gravando';
      let resumo = null;
      await salvar(base => {
        Object.assign(base.ofertas, ofertas);
        for (const [sid, novo] of Object.entries(registros)) base.assinaturas[sid] = mesclarRegistro(base.assinaturas[sid], novo);
        base.acessos = acessos;
        resumo = resumir(base, membrosAtivos);
        base.sincronizacao = { ultimaEm: new Date().toISOString(), contagem: Object.assign({}, progresso.contagem), resumo };
      }, 'hubla: sincroniza assinaturas pela API');
      progresso.etapa = 'concluida';
      return { ok: true, contagem: progresso.contagem, resumo };
    } catch (err) {
      progresso.erro = err.message;
      log.error('[hubla-sync]', err.message);
      return { ok: false, erro: err.message };
    } finally {
      progresso.rodando = false;
      progresso.fim = new Date().toISOString();
    }
  }

  // Assinaturas do painel por e-mail + divergências com membros.json (só relata,
  // nunca muda acesso sozinho).
  function resumir(base, membrosAtivos) {
    const agora = Date.now();
    const porSituacao = {};
    const vigentesPainel = new Set();
    for (const a of Object.values(base.assinaturas || {})) {
      const { situacao } = calcularSituacao(a, agora);
      porSituacao[situacao] = (porSituacao[situacao] || 0) + 1;
      if (a.liberaPainel && (situacao === 'vigente' || situacao === 'teste') && a.email) vigentesPainel.add(a.email);
    }
    const out = { porSituacao, membrosComAssinaturaPainelVigente: vigentesPainel.size };
    if (membrosAtivos) {
      const ativos = new Set(membrosAtivos);
      const acessos = base.acessos || {};
      const acessoAtivo = e => acessos[e] && acessos[e].status === 'active';
      out.ativosNoPainelSemAssinaturaVigente = [...ativos].filter(e => !vigentesPainel.has(e) && !acessoAtivo(e)).sort();
      out.assinaturaVigenteSemPainel = [...vigentesPainel].filter(e => !ativos.has(e)).sort();
    }
    return out;
  }

  // Lista para telas/relatórios, com situação e fim calculados agora.
  async function listar({ situacao, painel, email } = {}) {
    const d = await ler();
    const agora = Date.now();
    let lista = Object.values(d.assinaturas).map(a => Object.assign({}, a, calcularSituacao(a, agora)));
    if (painel === '1' || painel === true) lista = lista.filter(a => a.liberaPainel);
    if (situacao) {
      const quer = new Set(String(situacao).split(','));
      lista = lista.filter(a => quer.has(a.situacao));
    }
    if (email) lista = lista.filter(a => a.email === String(email).toLowerCase().trim());
    lista.sort((a, b) => String(a.fim || '9999').localeCompare(String(b.fim || '9999')));
    return { total: lista.length, atualizadoEm: d.atualizadoEm, sincronizacao: d.sincronizacao, assinaturas: lista };
  }

  return {
    registrarEvento, sincronizar, listar, ler, resumir, progresso,
    temChaveApi: () => !!apiKey(),
  };
}

module.exports = {
  criarHublaAssinaturas, ofertaLiberaPainel, produtoOfertaDoEvento, calcularSituacao,
  camposDaAssinatura, mesclarRegistro, OFERTAS_PAINEL, PRODUTO_PAINEL_ID, ARQUIVO_HUBLA_ASSINATURAS: ARQUIVO,
};
