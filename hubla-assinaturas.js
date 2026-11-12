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
// Ofertas de OUTROS produtos que também liberam o painel (desde 11/11/2026:
// a "Escola do Viajante" vendida como produto próprio). Casa pelo id do produto
// ou, sem id, pelo nome do produto; a oferta sempre pelo nome.
// semVitalicio: só libera enquanto a assinatura tiver prazo — a Escola
// vitalícia (curso comprado para sempre) NÃO dá painel (decisão de 11/11/2026).
const OFERTAS_PAINEL_OUTROS_PRODUTOS = [
  { produtoId: '9WymDJ2TYmaj6VY3KP3E', produtoNome: 'Escola do Viajante', oferta: 'Escola do Viajante', semVitalicio: true },
];
function _outroProdutoPainel(produtoId, produtoNome, ofertaNome) {
  return OFERTAS_PAINEL_OUTROS_PRODUTOS.find(x =>
    (produtoId ? produtoId === x.produtoId : norm(produtoNome) === norm(x.produtoNome)) && norm(ofertaNome) === norm(x.oferta)) || null;
}
// ── Regras de acesso editáveis (desde 11/11/2026) ────────────────────────────
// O Davi decide no gestor, oferta por oferta de TODOS os produtos, o que dá
// painel. Arquivo `painel-regras-acesso.json` (repo de dados):
//   { atualizadoEm, ofertas: { <ofertaId>: { regra, produtoId, produtoNome, ofertaNome } } }
// regra: 'libera' | 'prazo' (só enquanto tiver prazo; vitalício não) | 'nao'.
// Oferta fora do arquivo (ou arquivo inexistente) segue a regra padrão abaixo
// (as 7 ofertas de OFERTAS_PAINEL + OFERTAS_PAINEL_OUTROS_PRODUTOS). index.js
// carrega o arquivo e chama definirRegrasAcesso().
const REGRAS = ['libera', 'prazo', 'nao'];
let _regras = null; // { porId: Map, porNome: Map, atualizadoEm, grupos }
// Grupos de WhatsApp (jid) que cada oferta libera (desde 11/11/2026). Índice
// separado das regras do painel: uma oferta pode dar grupo sem dar painel.
//   porOferta: Map ofertaId → Set(jid) · porProduto: Map produtoId → Set(jid)
//   (união das ofertas do produto, para acesso sem fatura) · mapeados: Set(jid)
let _grupos = { porOferta: new Map(), porProduto: new Map(), mapeados: new Set() };
function _indiceGrupos(arquivo) {
  const g = { porOferta: new Map(), porProduto: new Map(), mapeados: new Set() };
  for (const [id, r] of Object.entries((arquivo && arquivo.ofertas) || {})) {
    const lista = Array.isArray(r && r.grupos) ? r.grupos.filter(j => /@g\.us$/.test(String(j))) : [];
    if (!lista.length) continue;
    g.porOferta.set(id, new Set(lista));
    if (r.produtoId) {
      const s = g.porProduto.get(r.produtoId) || new Set();
      lista.forEach(j => s.add(j));
      g.porProduto.set(r.produtoId, s);
    }
    lista.forEach(j => g.mapeados.add(j));
  }
  return g;
}
function gruposAcesso() { return _grupos; }
function _chaveNome(produtoId, produtoNome, ofertaNome) {
  return [produtoId ? 'id:' + produtoId : 'nome:' + norm(produtoNome), norm(ofertaNome)].join('|');
}
function definirRegrasAcesso(arquivo) {
  const ofertas = (arquivo && arquivo.ofertas) || {};
  const porId = new Map(), porNome = new Map();
  const peso = { libera: 3, prazo: 2, nao: 1 };
  for (const [id, r] of Object.entries(ofertas)) {
    if (!r || !REGRAS.includes(r.regra)) continue;
    porId.set(id, r.regra);
    // Índice por nome, para o cadastro do membro (membros.json só guarda o
    // nome da oferta). Duas ofertas de mesmo nome no mesmo produto: vale a mais
    // aberta (as duas "Clube do Viajante (Premium)" liberam juntas).
    for (const k of [_chaveNome(r.produtoId, '', r.ofertaNome), _chaveNome('', r.produtoNome, r.ofertaNome)]) {
      if (!r.ofertaNome || (!r.produtoId && k.startsWith('id:'))) continue;
      const ant = porNome.get(k);
      if (!ant || peso[r.regra] > peso[ant]) porNome.set(k, r.regra);
    }
  }
  _regras = porId.size ? { porId, porNome, atualizadoEm: (arquivo && arquivo.atualizadoEm) || null } : null;
  _grupos = _indiceGrupos(arquivo);
  return { total: porId.size, grupos: _grupos.mapeados.size };
}
function regrasAcessoAtivas() { return !!_regras; }
// Regra de fábrica (antes do arquivo de regras).
function regraPadraoAcesso(produtoId, produtoNome, ofertaNome) {
  if (produtoEhDoPainel(produtoId, produtoNome) && _ofertasPainelNorm.has(norm(ofertaNome))) return 'libera';
  const x = _outroProdutoPainel(produtoId, produtoNome, ofertaNome);
  if (x) return x.semVitalicio ? 'prazo' : 'libera';
  return 'nao';
}
// Regra efetiva: id da oferta → nome da oferta no produto → padrão.
function regraAcesso(produtoId, produtoNome, ofertaNome, ofertaId, regras = _regras) {
  if (regras) {
    if (ofertaId && regras.porId.has(ofertaId)) return regras.porId.get(ofertaId);
    const k1 = produtoId ? _chaveNome(produtoId, '', ofertaNome) : null;
    if (k1 && regras.porNome.has(k1)) return regras.porNome.get(k1);
    const k2 = _chaveNome('', produtoNome, ofertaNome);
    if (produtoNome && regras.porNome.has(k2)) return regras.porNome.get(k2);
  }
  return regraPadraoAcesso(produtoId, produtoNome, ofertaNome);
}
function ofertaLiberaPainel(produtoId, produtoNome, ofertaNome, ofertaId) {
  return regraAcesso(produtoId, produtoNome, ofertaNome, ofertaId) !== 'nao';
}
// A oferta libera o painel só quando NÃO é vitalícia?
function ofertaPainelExigePrazo(produtoId, produtoNome, ofertaNome, ofertaId) {
  return regraAcesso(produtoId, produtoNome, ofertaNome, ofertaId) === 'prazo';
}
// Recalcula na leitura (o campo gravado em hubla-assinaturas.json fica velho
// quando as regras mudam, até a próxima sincronização). `regras` opcional:
// simula um conjunto de regras ainda não salvo (prévia do gestor).
function assinaturaLiberaPainel(a, agora = Date.now(), regras) {
  if (!a) return false;
  if (!(a.ofertaNome || a.produtoNome || a.ofertaId)) return !!a.liberaPainel;
  const r = regraAcesso(a.produtoId, a.produtoNome, a.ofertaNome, a.ofertaId, regras === undefined ? _regras : regras);
  if (r === 'nao') return false;
  if (r === 'prazo' && calcularSituacao(a, agora).situacao === 'vitalicio') return false;
  return true;
}
// Monta o índice de um arquivo de regras sem ativá-lo (para a prévia).
function indiceRegras(arquivo) {
  const salvo = _regras, salvoG = _grupos;
  definirRegrasAcesso(arquivo);
  const r = _regras;
  if (r) r.grupos = _grupos; // a prévia também usa os grupos novos
  _regras = salvo; _grupos = salvoG;
  return r;
}
function indiceGrupos(arquivo) { return _indiceGrupos(arquivo); }

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
  return pares.find(x => ofertaLiberaPainel(x.produtoId, x.produtoNome, x.ofertaNome, x.ofertaId)) || pares[0];
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
  const creditos = Number(a.creditos) || 0;
  // Créditos = dias pagos que restam (1 crédito = 1 dia), contados a partir da
  // última conferência na API. 10.000 dias é como a Hubla grava o vitalício.
  const baseCreditos = new Date(a.conferidaApiEm || a.ultimoDebito || a.modificadaEm || agora).getTime();
  const porCreditos = creditos > 0 ? new Date(baseCreditos + creditos * DIA).toISOString() : null;
  const futuro = v => v && new Date(v).getTime() > agora ? v : null;
  let fim = null;
  let situacao;
  // "canceled" na Hubla = renovação desligada: o acesso segue até os créditos
  // acabarem (ex.: cancelou em set/2026 com renovação paga até nov/2026).
  // "inactive" com créditos = acesso retirado à mão: conta como encerrada.
  const vigente = st === 'active' || st === 'trial' || (st === 'canceled' && creditos > 0);
  if (vigente) {
    if (creditos >= 3650) {
      situacao = 'vitalicio';
    } else {
      // A Hubla mantém `deactivateEta` de ciclos antigos: só vale se estiver no futuro.
      const desativaFutura = futuro(a.desativaEm);
      fim = futuro(a.proximaCobranca) || porCreditos || desativaFutura || a.proximaCobranca || null;
      if (desativaFutura && fim && new Date(desativaFutura) < new Date(fim)) fim = desativaFutura;
      situacao = (st === 'trial' || a.teste) ? 'teste' : 'vigente';
      if (fim && new Date(fim).getTime() < agora - DIA && !(st !== 'canceled' && a.renovacaoAutomatica)) situacao = 'encerrada';
    }
  } else if (st === 'incomplete') {
    situacao = 'pendente';
  } else if (st) {
    // Fim = a data mais recente entre inativação e cancelamento (a Hubla guarda
    // inativações antigas, de antes da primeira ativação).
    const datas = [a.inativadaEm, a.canceladaEm].filter(Boolean).sort();
    fim = datas[datas.length - 1] || a.modificadaEm || null;
    situacao = 'encerrada';
  } else {
    situacao = 'desconhecida';
  }
  const diasRestantes = fim && situacao !== 'encerrada'
    ? Math.ceil((new Date(fim).getTime() - agora) / DIA) : null;
  return { situacao, fim, diasRestantes };
}

// Origem do vitalício (desde 12/11/2026), conferida na base real:
// - 'vendido': o produto/oferta foi vendido como vitalício — assinatura
//   `one_time` paga com 10.000 créditos, ou membro `buyer` com isLifetime;
// - 'concedido': acesso vitalício liberado à mão (assinatura `free` com
//   10.000 créditos ou membro `free` com isLifetime), inclusive em produto cuja
//   oferta normal tem prazo (ex.: Clube do Viajante (Premium), anual).
// Sem vitalício devolve null.
function origemVitalicio(reg, situacao) {
  if (!reg || situacao !== 'vitalicio') return null;
  return reg.tipo === 'free' ? 'concedido' : 'vendido';
}

// Membro com acesso? A leitura sem filtro da API não preenche o status de quem
// está ativo (vem vazio); desativado vem "deactivate".
// Turmas do membro, se a API devolver (o painel da Hubla mostra a coluna
// "Turma", que é o mais perto da oferta). Aceita os formatos mais comuns.
function turmasDoMembro(m) {
  if (!m) return undefined;
  const fontes = [m.cohorts, m.cohort, m.classes, m.groups, m.cohortNames, m.cohortName];
  const out = [];
  for (const f of fontes) {
    for (const x of (Array.isArray(f) ? f : (f ? [f] : []))) {
      const n = typeof x === 'string' ? x : (x && (x.name || x.title || x.label));
      if (n && !out.includes(String(n))) out.push(String(n));
    }
  }
  return out.length ? out : undefined;
}

function membroAtivo(m, agora = Date.now()) {
  if (!m) return false;
  if (m.status === 'active') return true;
  if (m.status) return false;
  return !m.removidoEm || new Date(m.removidoEm).getTime() > agora;
}

// Acesso ao painel que continua válido além da assinatura `assinaturaId` que
// está saindo (ex.: o teste Experimental acabou, mas a pessoa tem a Escola do
// Viajante liberada até 2027). Devolve o motivo ou null. Usada antes de
// desativar alguém em membros.json (desde 07/11/2026).
//  1. outra assinatura de oferta do painel vigente, em teste ou vitalícia;
//  2. acesso gratuito COM PRAZO ativo no produto do painel (último censo da
//     API), com mais de 1 dia pela frente, E uma oferta do painel (que não seja
//     o teste Experimental) já registrada no cadastro do membro. O produto tem
//     ofertas sem painel (Básico, ex-alunos, membros antigos), por isso o acesso
//     sozinho não basta; o vitalício gratuito é o lote antigo de ex-alunos, que
//     não dá painel (decisão de 07/11/2026).
function outroAcessoPainel(base, email, assinaturaId, membro, agora = Date.now()) {
  const e = String(email || '').toLowerCase().trim();
  if (!e) return null;
  for (const a of Object.values((base && base.assinaturas) || {})) {
    if (!a || String(a.email || '').toLowerCase().trim() !== e) continue;
    if (assinaturaId && a.id === assinaturaId) continue;
    if (!assinaturaLiberaPainel(a, agora)) continue;
    const { situacao } = calcularSituacao(a, agora);
    if (situacao === 'vigente' || situacao === 'teste' || situacao === 'vitalicio') {
      return `assinatura_vigente: ${a.ofertaNome || a.id}`;
    }
  }
  const ac = ((base && base.acessos) || {})[e];
  const acessoComPrazo = ac && membroAtivo(ac, agora) && ac.tipo === 'free' && !ac.vitalicio
    && ac.removidoEm && new Date(ac.removidoEm).getTime() > agora + DIA;
  if (acessoComPrazo) {
    const ofertaPainel = ((membro && membro.produtos) || [])
      .find(p => p && !/experimental/i.test(p.oferta || '') && ofertaLiberaPainel(p.produtoId, p.produtoNome, p.oferta));
    if (ofertaPainel) return `acesso_hubla_ativo: ${ofertaPainel.oferta}`;
  }
  return null;
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

// Produto excluído na Hubla (desde 11/11/2026): a sincronização grava em
// `produtosHubla` os produtos que a API ainda devolve. Assinatura/oferta cujo
// produto não está mais lá (nem pelo id nem pelo nome) = produto excluído. O
// histórico fica guardado; as telas só escondem. Sem lista gravada ou sem
// produto conhecido na linha, nunca marca.
function produtoExcluidoNaHubla(base, produtoId, produtoNome) {
  const ph = base && base.produtosHubla;
  if (!ph || !Array.isArray(ph.ids) || !ph.ids.length) return false;
  if (!produtoId && !produtoNome) return false;
  if (produtoId && ph.ids.includes(produtoId)) return false;
  if (produtoNome && (ph.nomes || []).includes(norm(produtoNome))) return false;
  return true;
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
        for (const k of Object.keys(base.assinaturas)) if (/-tester$/.test(k)) delete base.assinaturas[k];
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
      acessosPorProduto: d.acessosPorProduto || {},
      produtosHubla: d.produtosHubla || null, sondagemApi: d.sondagemApi || null,
      ofertasAcesso: d.ofertasAcesso || {},
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

  // ── Oferta do acesso (produto+e-mail) ──────────────────────────────────────
  // `ofertasAcesso` = { '<produtoId>|<email>': {ofertaId, ofertaNome, produtoNome, em, fonte} }.
  // Fontes: webhook customer.member_added e importação (POST /hubla/acessos/ofertas).
  async function registrarOfertaAcessoDoEvento(e) {
    const pessoa = pessoaDe(e.user || e.member || e.customer || (e.subscription && e.subscription.payer));
    if (!pessoa.email) return;
    const produtos = (Array.isArray(e.products) && e.products.length) ? e.products : [e.product || {}];
    const itens = [];
    for (const p of produtos) {
      const of = (p && Array.isArray(p.offers) && p.offers[0]) || null;
      if (p && p.id && of && of.name) itens.push({ email: pessoa.email, produtoId: p.id, produtoNome: p.name || '', ofertaId: of.id || '', ofertaNome: of.name });
    }
    if (itens.length) await gravarOfertasAcesso(itens, 'webhook');
  }
  async function gravarOfertasAcesso(itens, fonte) {
    const validos = (itens || []).map(x => ({
      email: String((x && x.email) || '').toLowerCase().trim(),
      produtoId: String((x && x.produtoId) || '').trim(), produtoNome: String((x && x.produtoNome) || '').trim(),
      ofertaId: String((x && x.ofertaId) || '').trim(), ofertaNome: String((x && x.ofertaNome) || '').trim(),
    })).filter(x => x.email && x.ofertaNome && (x.produtoId || x.produtoNome));
    if (!validos.length) return { gravados: 0, ignorados: (itens || []).length };
    let gravados = 0, semProduto = 0;
    await salvar(base => {
      base.ofertasAcesso = base.ofertasAcesso || {};
      const prods = Object.entries(base.acessosPorProduto || {});
      for (const x of validos) {
        let pid = x.produtoId;
        if (!pid) { const m = prods.find(([, p]) => p && norm(p.nome) === norm(x.produtoNome)); pid = m ? m[0] : ''; }
        if (!pid) { semProduto++; continue; }
        if (!x.ofertaId) {
          const o = Object.entries(base.ofertas || {}).find(([, o]) => o && !o.ehProduto && o.produtoId === pid && norm(o.nome) === norm(x.ofertaNome));
          if (o) x.ofertaId = o[0];
        }
        base.ofertasAcesso[pid + '|' + x.email] = { ofertaId: x.ofertaId || null, ofertaNome: x.ofertaNome,
          produtoNome: x.produtoNome || ((base.acessosPorProduto || {})[pid] || {}).nome || '', em: new Date().toISOString(), fonte };
        gravados++;
      }
      if (!gravados) return false;
    }, `hubla: oferta do acesso (${fonte}, ${validos.length})`);
    return { gravados, semProduto, ignorados: (itens || []).length - validos.length };
  }

  // ── Webhook ────────────────────────────────────────────────────────────────
  // Registra/atualiza a assinatura do evento. Devolve o registro mesclado (ou null).
  async function registrarEvento(type, event) {
    const e = event || {};
    const sub = e.subscription || null;
    const fatura = e.invoice || null;
    const subId = String((sub && sub.id) || e.subscriptionId || (fatura && (fatura.subscriptionId || (fatura.subscriptionIds || [])[0])) || '').trim();
    // Membro incluído/removido: guarda a oferta do acesso por produto+e-mail
    // (desde 12/11/2026). A lista de membros da API não diz a oferta; assim o
    // acesso sem assinatura também fica com ela.
    if (/^customer\.member_added/.test(type)) {
      try { await registrarOfertaAcessoDoEvento(e); } catch (err) { log.warn('[hubla-assinaturas] oferta do acesso', err.message); }
    }
    if (!subId) return null;
    // "Testar configuração" da Hubla manda IDs fictícios terminados em -tester: não grava.
    if (/-tester$/.test(subId)) return null;
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
    if (po.ofertaNome || po.produtoNome) novo.liberaPainel = ofertaLiberaPainel(po.produtoId, po.produtoNome, po.ofertaNome, po.ofertaId);

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
          liberaPainel: ofertaLiberaPainel(po.produtoId, po.produtoNome, po.ofertaNome, po.ofertaId),
        });
      }
    }, `hubla: ${type} ${subId.slice(0, 8)}`);
    return registro;
  }

  // ── Sincronização completa pela API ────────────────────────────────────────
  const progresso = { rodando: false, etapa: null, inicio: null, fim: null, erro: null, contagem: {} };

  async function paginar(fn, max = 500, rotulo) {
    const itens = [];
    let primeiroAnterior = null;
    for (let page = 1; page <= max; page++) {
      if (rotulo) progresso.contagem[rotulo + 'Paginas'] = page;
      const r = await fn(page);
      const lote = (r && (r.items || r.data)) || [];
      // API que ignora o parâmetro de página devolveria a mesma página para sempre.
      const primeiro = lote[0] && (lote[0].id || JSON.stringify(lote[0]).slice(0, 80));
      if (page > 1 && primeiro && primeiro === primeiroAnterior) break;
      primeiroAnterior = primeiro;
      itens.push(...lote);
      const ultima = (r && (r.lastPage || (r.pagination && r.pagination.lastPage))) || 0;
      if (!lote.length || (ultima && page >= ultima)) break;
    }
    return itens;
  }

  // Sincronização RETOMÁVEL. O proxy reinicia a cada commit no painel-cdv (os
  // coletores comitam de poucos em poucos minutos), então o avanço fica gravado
  // em `sincronizacao.emAndamento` e um novo processo continua de onde parou:
  //   1. produtos + ofertas + faturas (rápido) → grava os registros-base e a fila
  //      `pendentes` de IDs a conferir na API;
  //   2. cada assinatura pela API, em lotes de LOTE, tirando da fila a cada lote;
  //   3. membros do produto do painel → `acessos`, resumo e `ultimaEm`.
  const LOTE = 40;

  async function etapaBase() {
    progresso.etapa = 'produtos';
    const produtos = await paginar(p => api('POST', '/v1/products/list', { page: p, pageSize: 100 }), 20, 'produtos');
    const ofertas = {};
    progresso.etapa = 'ofertas';
    for (const pr of produtos) {
      ofertas[pr.id] = ofertas[pr.id] || { nome: pr.name, produtoId: pr.id, produtoNome: pr.name, liberaPainel: false, ehProduto: true };
      const lista = await paginar(p => api('GET', `/v1/products/${encodeURIComponent(pr.id)}/offers?page=${p}&pageSize=100`), 10);
      for (const of of lista) {
        ofertas[of.id] = { nome: of.name, produtoId: pr.id, produtoNome: pr.name,
          liberaPainel: ofertaLiberaPainel(pr.id, pr.name, of.name, of.id), arquivada: !!of.isArchived };
      }
    }
    progresso.contagem.produtos = produtos.length;
    progresso.contagem.ofertas = Object.values(ofertas).filter(o => !o.ehProduto).length;

    progresso.etapa = 'faturas';
    const porSub = {};
    const ate = new Date().toISOString();
    const faturas = await paginar(p => api('POST', '/v1/invoices/list', {
      filters: { dateStart: '2018-01-01T00:00:00.000Z', dateEnd: ate, dateRangeBy: 'createdAt', orderBy: 'createdAt', orderDir: 'ASC' },
      pagination: { page: p, pageSize: 200 },
    }), 500, 'faturas');
    progresso.contagem.faturas = faturas.length;
    for (const f of faturas) {
      const ids = [f.subscriptionId, ...(Array.isArray(f.subscriptionIds) ? f.subscriptionIds : [])].filter(Boolean);
      for (const sid of new Set(ids)) {
        const x = porSub[sid] = porSub[sid] || { id: sid, faturasPagas: 0 };
        if (f.status === 'paid') x.faturasPagas++;
        const pessoa = pessoaDe(f.payer);
        if (pessoa.email) Object.assign(x, pessoa);
        const itens = Array.isArray(f.items) ? f.items : [];
        const item = itens.find(i => i && ofertas[i.id] && !ofertas[i.id].ehProduto) || itens.find(i => i && ofertas[i.id]) || itens[0];
        if (item) {
          const o = ofertas[item.id];
          x.ofertaId = item.id;
          x.ofertaNome = o ? o.nome : item.name;
          if (o) { x.produtoId = o.produtoId; x.produtoNome = o.produtoNome; }
        }
        const quando = iso(f.paidAt || f.createdAt);
        if (f.status === 'paid' && quando) {
          x.primeiraAtivacao = minIso(x.primeiraAtivacao || null, quando);
          if (!x.ultimoPagamento || quando > x.ultimoPagamento) x.ultimoPagamento = quando;
        }
      }
    }
    for (const x of Object.values(porSub)) {
      if (x.ofertaNome || x.produtoNome) x.liberaPainel = ofertaLiberaPainel(x.produtoId, x.produtoNome, x.ofertaNome, x.ofertaId);
    }
    const pendentes = Object.keys(porSub);
    progresso.contagem.assinaturas = pendentes.length;
    progresso.etapa = 'gravando';
    await salvar(base => {
      Object.assign(base.ofertas, ofertas);
      // Produtos que ainda existem na Hubla (a lista veio inteira: erro da API interrompe antes daqui).
      if (produtos.length) {
        base.produtosHubla = { em: new Date().toISOString(),
          ids: [...new Set(produtos.flatMap(pr => pr ? [pr.id, pr.legacyId] : []).filter(Boolean))],
          nomes: [...new Set(produtos.map(pr => pr && norm(pr.name)).filter(Boolean))] };
      }
      for (const [sid, novo] of Object.entries(porSub)) base.assinaturas[sid] = mesclarRegistro(base.assinaturas[sid], novo);
      base.sincronizacao = Object.assign({}, base.sincronizacao, {
        emAndamento: { inicio: progresso.inicio, total: pendentes.length, pendentes, contagem: Object.assign({}, progresso.contagem) },
      });
    }, `hubla: sincronização — base (${pendentes.length} assinaturas)`);
    return pendentes;
  }

  // Membros do produto do painel. A API filtra por `types`/`status`; sem filtro
  // pode vir vazio, então tenta as combinações e junta por e-mail. Contagens
  // (sem dado pessoal) ficam em progresso.contagem.membrosTentativas.
  async function lerAcessosProduto() {
    progresso.etapa = 'membros';
    const acessos = {};
    const tentativas = {};
    // O `id` público do produto passou a ser o da oferta principal; a rota de
    // membros pode esperar o id interno (`legacyId`). Tenta os dois.
    const refs = [PRODUTO_PAINEL_ID];
    try {
      const produtos = await paginar(p => api('POST', '/v1/products/list', { page: p, pageSize: 100 }), 20);
      const pr = produtos.find(x => x && (x.id === PRODUTO_PAINEL_ID || norm(x.name) === norm(PRODUTO_PAINEL_NOME)));
      if (pr && pr.legacyId && !refs.includes(pr.legacyId)) refs.unshift(pr.legacyId);
      if (pr && pr.id && !refs.includes(pr.id)) refs.push(pr.id);
    } catch (err) { tentativas.produtos = 'erro: ' + err.message.slice(0, 80); }
    const variantes = [];
    for (const ref of refs) for (const f of ['', 'status=active', 'status=deactivate']) variantes.push({ ref, f });
    for (const { ref, f } of variantes) {
      const rotulo = (ref === PRODUTO_PAINEL_ID ? 'id' : 'legacyId') + (f ? ' ' + f : '');
      let lista = [];
      try {
        lista = await paginar(p => api('GET', `/v1/${encodeURIComponent(ref)}/members?page=${p}&pageSize=200${f ? '&' + f : ''}`), 100);
      } catch (err) { tentativas[rotulo] = 'erro: ' + err.message.slice(0, 120); continue; }
      tentativas[rotulo] = lista.length;
      for (const m of lista) {
        const email = String(m.email || '').toLowerCase().trim();
        if (!email) continue;
        const ant = acessos[email];
        const novo = { nome: m.name || '', telefone: m.phone || '', tipo: m.type || '', status: m.status || '',
          removidoEm: iso(m.removalAt), vitalicio: !!m.isLifetime,
          turmas: turmasDoMembro(m), entrouEm: iso(m.createdAt || m.joinedAt || m.grantedAt) };
        // Mesmo e-mail em duas listas: vale o acesso ativo.
        if (!ant || (ant.status !== 'active' && novo.status === 'active')) acessos[email] = novo;
      }
    }
    progresso.contagem.membrosTentativas = tentativas;
    progresso.contagem.acessosProduto = Object.keys(acessos).length;
    return acessos;
  }

  // Membros de TODOS os produtos (gratuitos, convites, vitalícios e compradores),
  // para cruzar com os participantes dos grupos do WhatsApp. Usa o id interno
  // (legacyId) de cada produto. Resultado: { produtoId: { nome, membros: { email: {...} } } }.
  async function lerAcessosTodosProdutos() {
    progresso.etapa = 'membros de todos os produtos';
    const porProduto = {};
    const contagem = {};
    const produtos = await paginar(p => api('POST', '/v1/products/list', { page: p, pageSize: 100 }), 20);
    for (const pr of produtos) {
      const ref = pr.legacyId || pr.id;
      const membros = {};
      for (const f of ['', 'status=deactivate']) {
        let lista = [];
        try {
          lista = await paginar(p => api('GET', `/v1/${encodeURIComponent(ref)}/members?page=${p}&pageSize=200${f ? '&' + f : ''}`), 100);
        } catch (err) { contagem[pr.name] = 'erro: ' + err.message.slice(0, 80); continue; }
        if (lista[0] && !progresso.contagem.camposMembro) progresso.contagem.camposMembro = Object.keys(lista[0]).sort();
        for (const m of lista) {
          const email = String(m.email || '').toLowerCase().trim();
          if (!email) continue;
          const novo = { nome: m.name || '', telefone: m.phone || '', tipo: m.type || '',
            status: m.status || (f ? 'deactivate' : 'active'),
            removidoEm: iso(m.removalAt), vitalicio: !!m.isLifetime,
            turmas: turmasDoMembro(m), entrouEm: iso(m.createdAt || m.joinedAt || m.grantedAt) };
          const ant = membros[email];
          if (!ant || (ant.status !== 'active' && novo.status === 'active')) membros[email] = novo;
        }
      }
      porProduto[pr.id] = { nome: pr.name, legacyId: pr.legacyId || null, membros };
      if (typeof contagem[pr.name] !== 'string') {
        const v = Object.values(membros);
        contagem[pr.name] = { ativos: v.filter(x => membroAtivo(x)).length, total: v.length };
      }
    }
    progresso.contagem.membrosPorProduto = contagem;
    return porProduto;
  }

  // ── Sondagem da API (desde 12/11/2026) ─────────────────────────────────────
  // A lista de membros não traz oferta nem turma. Testa rotas e filtros que
  // podem trazer isso para quem entrou antes, e grava em `sondagemApi` SÓ
  // código HTTP, nomes de campos e contagens (nenhum dado pessoal). Roda uma
  // vez por SONDA_VERSAO, no boot do proxy.
  const SONDA_VERSAO = 2;
  async function apiBruta(metodo, caminho, corpo) {
    const espera = 700 - (Date.now() - _ultimaChamada);
    if (espera > 0) await new Promise(r => setTimeout(r, espera));
    _ultimaChamada = Date.now();
    try {
      const r = await fetch(API_BASE + caminho, {
        method: metodo,
        headers: { Authorization: apiKey(), 'Content-Type': 'application/json', Accept: 'application/json' },
        body: corpo ? JSON.stringify(corpo) : undefined, timeout: 30000,
      });
      const txt = await r.text();
      let j = null; try { j = JSON.parse(txt); } catch (e) {}
      return { status: r.status, j };
    } catch (err) { return { status: 0, erro: err.message.slice(0, 80) }; }
  }
  function chavesDe(o, prefixo = '', fora = new Set(), nivel = 0) {
    if (!o || typeof o !== 'object' || nivel > 3) return fora;
    if (Array.isArray(o)) { for (const x of o.slice(0, 5)) chavesDe(x, prefixo + '[].', fora, nivel + 1); return fora; }
    for (const [k, v] of Object.entries(o)) { fora.add(prefixo + k); chavesDe(v, prefixo + k + '.', fora, nivel + 1); }
    return fora;
  }
  function resumoResposta(r, baseEmails) {
    const out = { status: r.status };
    if (r.erro) out.erro = r.erro;
    const j = r.j;
    if (!j || typeof j !== 'object') return out;
    const itens = Array.isArray(j) ? j : (j.items || j.data || null);
    const topo = Array.isArray(j) ? [] : Object.keys(j).filter(k => !['items', 'data'].includes(k));
    out.topo = topo;
    for (const k of ['total', 'totalItems', 'count', 'lastPage', 'page', 'pageSize']) if (typeof j[k] === 'number') out[k] = j[k];
    if (j.pagination && typeof j.pagination === 'object') out.pagination = j.pagination;
    if (Array.isArray(itens)) {
      out.itens = itens.length;
      out.camposItem = [...chavesDe(itens)].sort().slice(0, 80);
      const tipos = {};
      for (const it of itens) { const t = it && (it.type || it.subscriptionType); if (t) tipos[t] = (tipos[t] || 0) + 1; }
      if (Object.keys(tipos).length) out.porTipo = tipos;
      if (baseEmails) {
        const em = itens.map(m => String((m && m.email) || '').toLowerCase()).filter(Boolean);
        out.emComumComSemFiltro = em.filter(e => baseEmails.has(e)).length;
      }
    } else {
      out.campos = [...chavesDe(j)].sort().slice(0, 80);
    }
    if (typeof j.message === 'string') out.mensagem = j.message.slice(0, 120);
    return out;
  }
  async function sondarApi({ forcar = false } = {}) {
    if (!apiKey()) return null;
    const d = await ler();
    if (!forcar && d.sondagemApi && d.sondagemApi.versao === SONDA_VERSAO) return d.sondagemApi;
    const res = {};
    // Produto do painel: id público e interno (legacyId).
    const prods = await apiBruta('POST', '/v1/products/list', { page: 1, pageSize: 100 });
    const lp = (prods.j && (prods.j.items || prods.j.data)) || [];
    const pr = lp.find(x => x && (x.id === PRODUTO_PAINEL_ID || norm(x.name) === norm(PRODUTO_PAINEL_NOME))) || {};
    const pid = pr.id || PRODUTO_PAINEL_ID;
    const ref = pr.legacyId || pid;
    res.produtoCampos = [...chavesDe(pr)].sort();
    // Ofertas do produto: alguma traz turmas (cohorts) com nome?
    const ofs = await apiBruta('GET', `/v1/products/${encodeURIComponent(pid)}/offers?page=1&pageSize=100`);
    res['GET products/:id/offers'] = resumoResposta(ofs);
    const listaOf = (ofs.j && (ofs.j.items || ofs.j.data)) || [];
    res.ofertasComTurma = listaOf.filter(o => o && Array.isArray(o.cohorts) && o.cohorts.length).length;
    // Ids de oferta e turma: das ofertas da API ou do log de webhooks (member_added).
    let ofertaId = null, turmaId = null;
    for (const o of listaOf) {
      if (!ofertaId && /premium\)?$/i.test(String(o.name || '')) ) ofertaId = o.id;
      if (!turmaId && Array.isArray(o.cohorts) && o.cohorts[0]) turmaId = o.cohorts[0].id;
    }
    try {
      const logw = (await ghGetJson('hubla-webhooks-log.json', { eventos: [] })).data || {};
      for (const ev of (logw.eventos || [])) {
        for (const p of ((ev && ev.event && ev.event.products) || [])) for (const o of (p.offers || [])) {
          if (!ofertaId && o.id) ofertaId = o.id;
          if (!turmaId && o.cohorts && o.cohorts[0]) turmaId = o.cohorts[0].id;
        }
      }
    } catch (e) {}
    if (!ofertaId) ofertaId = (Object.entries(d.ofertas || {}).find(([, o]) => o && o.produtoId === PRODUTO_PAINEL_ID) || [])[0] || null;
    res.temOfertaId = !!ofertaId; res.temTurmaId = !!turmaId;
    // Membros sem filtro (referência).
    const base = await apiBruta('GET', `/v1/${encodeURIComponent(ref)}/members?page=1&pageSize=200`);
    res['GET :ref/members'] = resumoResposta(base);
    const baseItens = (base.j && (base.j.items || base.j.data)) || [];
    const baseEmails = new Set(baseItens.map(m => String((m && m.email) || '').toLowerCase()).filter(Boolean));
    const membroId = (baseItens[0] && baseItens[0].id) || null;
    const subGratis = (Object.values(d.assinaturas || {}).find(a => a && a.tipo === 'free' && a.ofertaNome) || {}).id || null;
    // Filtros na lista de membros: se o total/itens mudar, o filtro existe.
    const filtros = [];
    if (ofertaId) for (const k of ['offerId', 'offerIds', 'offer', 'offersIds']) filtros.push(`${k}=${encodeURIComponent(ofertaId)}`);
    if (turmaId) for (const k of ['cohortId', 'cohortIds', 'cohort', 'cohortsIds']) filtros.push(`${k}=${encodeURIComponent(turmaId)}`);
    filtros.push('include=cohorts', 'include=offers', 'expand=cohorts');
    for (const f of filtros) {
      const r = await apiBruta('GET', `/v1/${encodeURIComponent(ref)}/members?page=1&pageSize=200&${f}`);
      res['GET :ref/members?' + f.split('=')[0] + (f.startsWith('include') || f.startsWith('expand') ? '=' + f.split('=')[1] : '')] = resumoResposta(r, baseEmails);
    }
    // Rotas candidatas.
    const rotas = [
      ['GET', `/v1/${ref}/cohorts`, ':ref/cohorts'],
      ['GET', `/v1/products/${pid}/cohorts`, 'products/:id/cohorts'],
      ofertaId && ['GET', `/v1/offers/${ofertaId}`, 'offers/:id'],
      ofertaId && ['GET', `/v1/offers/${ofertaId}/cohorts`, 'offers/:id/cohorts'],
      ofertaId && ['GET', `/v1/offers/${ofertaId}/members?page=1&pageSize=50`, 'offers/:id/members'],
      ofertaId && ['GET', `/v1/products/${pid}/offers/${ofertaId}`, 'products/:id/offers/:id'],
      turmaId && ['GET', `/v1/cohorts/${turmaId}`, 'cohorts/:id'],
      turmaId && ['GET', `/v1/cohorts/${turmaId}/members?page=1&pageSize=50`, 'cohorts/:id/members'],
      turmaId && ['GET', `/v1/${ref}/cohorts/${turmaId}/members?page=1&pageSize=50`, ':ref/cohorts/:id/members'],
      membroId && ['GET', `/v1/${ref}/members/${membroId}`, ':ref/members/:id'],
      membroId && ['GET', `/v1/members/${membroId}`, 'members/:id'],
      ['POST', '/v1/members/list', 'POST members/list', { page: 1, pageSize: 50, productId: pid }],
      // v2: lista de assinaturas (as gratuitas não geram fatura).
      ['POST', '/v1/subscriptions/list', 'POST subscriptions/list (pagination)', { pagination: { page: 1, pageSize: 50 } }],
      ['POST', '/v1/subscriptions/list', 'POST subscriptions/list (page)', { page: 1, pageSize: 50 }],
      ['POST', '/v1/subscriptions/list', 'POST subscriptions/list (filtros)', {
        filters: { dateStart: '2018-01-01T00:00:00.000Z', dateEnd: new Date().toISOString(), dateRangeBy: 'createdAt', orderBy: 'createdAt', orderDir: 'ASC' },
        pagination: { page: 1, pageSize: 50 } }],
      ['GET', '/v1/subscriptions?page=1&pageSize=50', 'subscriptions?page'],
      ['GET', `/v1/products/${pid}/subscriptions?page=1&pageSize=50`, 'products/:id/subscriptions'],
      ['GET', `/v1/${ref}/subscriptions?page=1&pageSize=50`, ':ref/subscriptions'],
      subGratis && ['GET', `/v1/subscriptions/${subGratis}`, 'subscriptions/:id (gratuita)'],
    ].filter(Boolean);
    for (const [m, cam, rot, corpo] of rotas) {
      const r = await apiBruta(m, cam.replace(/\/v1\/([^/?]+)/, (s, x) => '/v1/' + encodeURIComponent(x)), corpo);
      res[(m === 'GET' ? 'GET ' : '') + rot] = resumoResposta(r, baseEmails);
    }
    const sondagem = { versao: SONDA_VERSAO, em: new Date().toISOString(), resultados: res };
    await salvar(b => { b.sondagemApi = sondagem; }, 'hubla: sondagem da API (oferta/turma por membro)');
    return sondagem;
  }

  // Só a etapa de membros + resumo (rápida), sem refazer faturas e assinaturas.
  async function sincronizarMembros({ membrosAtivos, membrosInativos } = {}) {
    if (progresso.rodando) return { ok: false, erro: 'sincronização já em andamento', progresso };
    if (!apiKey()) return { ok: false, erro: 'HUBLA_API_KEY não configurada no Railway' };
    Object.assign(progresso, { rodando: true, etapa: 'membros', inicio: new Date().toISOString(), fim: null, erro: null, contagem: {} });
    try {
      const acessos = await lerAcessosProduto();
      const acessosPorProduto = await lerAcessosTodosProdutos();
      let resumo = null;
      await salvar(base => {
        base.acessos = acessos;
        base.acessosPorProduto = acessosPorProduto;
        resumo = resumir(base, membrosAtivos, membrosInativos);
        base.sincronizacao = Object.assign({}, base.sincronizacao, { membrosEm: new Date().toISOString(), resumo,
          contagem: Object.assign({}, (base.sincronizacao && base.sincronizacao.contagem) || {}, progresso.contagem) });
      }, 'hubla: sincroniza membros do produto do painel');
      progresso.etapa = 'concluida';
      return { ok: true, contagem: progresso.contagem, resumo };
    } catch (err) {
      progresso.erro = err.message;
      return { ok: false, erro: err.message };
    } finally {
      progresso.rodando = false;
      progresso.fim = new Date().toISOString();
    }
  }

  async function sincronizar({ membrosAtivos, membrosInativos, retomar } = {}) {
    if (progresso.rodando) return { ok: false, erro: 'sincronização já em andamento', progresso };
    if (!apiKey()) return { ok: false, erro: 'HUBLA_API_KEY não configurada no Railway' };
    Object.assign(progresso, { rodando: true, etapa: 'iniciando', inicio: new Date().toISOString(), fim: null, erro: null, contagem: {} });
    try {
      const atual = await ler();
      const andamento = atual.sincronizacao && atual.sincronizacao.emAndamento;
      let pendentes;
      if (andamento && Array.isArray(andamento.pendentes) && (retomar !== false)) {
        pendentes = andamento.pendentes.slice();
        progresso.inicio = andamento.inicio || progresso.inicio;
        Object.assign(progresso.contagem, andamento.contagem || {}, { retomada: true });
        progresso.contagem.assinaturas = andamento.total || pendentes.length;
      } else {
        pendentes = await etapaBase();
      }

      // 2. Assinaturas pela API, em lotes gravados
      progresso.etapa = 'assinaturas';
      const total = progresso.contagem.assinaturas || pendentes.length;
      progresso.contagem.lidas = total - pendentes.length;
      while (pendentes.length) {
        const lote = pendentes.slice(0, LOTE);
        const registros = {};
        for (const sid of lote) {
          let completo = null;
          try { completo = await buscarAssinaturaApi(sid); } catch (err) { log.warn('[hubla-sync]', sid, err.message); }
          if (completo) registros[sid] = Object.assign(camposDaAssinatura(completo), { conferidaApiEm: new Date().toISOString() });
          progresso.contagem.lidas++;
        }
        const restantes = pendentes.slice(LOTE);
        await salvar(base => {
          for (const [sid, novo] of Object.entries(registros)) base.assinaturas[sid] = mesclarRegistro(base.assinaturas[sid], novo);
          const em = (base.sincronizacao && base.sincronizacao.emAndamento) || {};
          em.pendentes = restantes;
          base.sincronizacao = Object.assign({}, base.sincronizacao, { emAndamento: em });
        }, `hubla: sincronização — ${total - restantes.length}/${total}`);
        pendentes = restantes;
      }

      // 3. Acessos atuais do produto do painel (inclui gratuitos/convites, que não têm fatura)
      const acessos = await lerAcessosProduto();
      const acessosPorProduto = await lerAcessosTodosProdutos();

      progresso.etapa = 'gravando';
      let resumo = null;
      await salvar(base => {
        base.acessos = acessos;
        base.acessosPorProduto = acessosPorProduto;
        resumo = resumir(base, membrosAtivos, membrosInativos);
        base.sincronizacao = { ultimaEm: new Date().toISOString(), inicio: progresso.inicio, contagem: Object.assign({}, progresso.contagem), resumo };
      }, 'hubla: sincronização concluída');
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
  function resumir(base, membrosAtivos, membrosInativos) {
    const agora = Date.now();
    const porSituacao = {};
    const vigentesPainel = new Set();
    for (const a of Object.values(base.assinaturas || {})) {
      const { situacao } = calcularSituacao(a, agora);
      porSituacao[situacao] = (porSituacao[situacao] || 0) + 1;
      if (assinaturaLiberaPainel(a) && (situacao === 'vigente' || situacao === 'teste' || situacao === 'vitalicio') && a.email) vigentesPainel.add(a.email);
    }
    const out = { porSituacao, membrosComAssinaturaPainelVigente: vigentesPainel.size };
    if (membrosAtivos) {
      const ativos = new Set(membrosAtivos);
      const acessos = base.acessos || {};
      const acessoAtivo = e => membroAtivo(acessos[e], agora);
      out.ativosNoPainelSemAssinaturaVigente = [...ativos].filter(e => !vigentesPainel.has(e) && !acessoAtivo(e)).sort();
      out.assinaturaVigenteSemPainel = [...vigentesPainel].filter(e => !ativos.has(e)).sort();
    }
    // Inativos no painel que ainda têm acesso válido (outra assinatura do
    // painel ou acesso gratuito/vitalício com oferta do painel no cadastro).
    if (Array.isArray(membrosInativos)) {
      out.inativosNoPainelComAcessoValido = membrosInativos
        .filter(m => m && m.email && outroAcessoPainel(base, m.email, null, m, agora))
        .map(m => String(m.email).toLowerCase().trim()).sort();
    }
    return out;
  }

  // Lista para telas/relatórios, com situação e fim calculados agora.
  async function listar({ situacao, painel, email } = {}) {
    const d = await ler();
    const agora = Date.now();
    let lista = Object.values(d.assinaturas).map(a => Object.assign({}, a, calcularSituacao(a, agora), { liberaPainel: assinaturaLiberaPainel(a) }));
    // Quem tem acesso a um produto sem assinatura paga dele (grátis, convite,
    // vitalício): entra como linha de "acesso", com o fim que a Hubla informa
    // (removalAt). Desde 11/11/2026 vale para TODOS os produtos
    // (acessosPorProduto, gravado na sincronização diária), não só o do painel.
    // Assinatura gratuita não gera fatura, por isso não aparece na descoberta
    // pelas faturas. Acesso ativo só fica de fora se já houver assinatura ATIVA
    // do mesmo produto (uma assinatura antiga vencida não pode esconder um
    // acesso grátis/vitalício atual). A oferta vem da assinatura gratuita do
    // mesmo produto/e-mail, quando a Hubla tiver criado uma (a lista de membros
    // da API não diz a oferta).
    for (const a of lista) {
      a.gratuito = a.tipo === 'free';
      const ov = origemVitalicio(a, a.situacao);
      if (ov) a.vitalicioOrigem = ov;
    }
    const porProduto = Object.assign({}, d.acessosPorProduto || {});
    if (d.acessos && Object.keys(d.acessos).length) {
      porProduto[PRODUTO_PAINEL_ID] = Object.assign({}, porProduto[PRODUTO_PAINEL_ID] || {}, { nome: PRODUTO_PAINEL_NOME, membros: d.acessos });
    }
    // Assinatura com prazo (recorrente) de quem a Hubla tem como membro
    // VITALÍCIO do mesmo produto: o acesso foi liberado como vitalício à mão.
    // A situação da assinatura não muda (cobrança e fim seguem os da Hubla);
    // só ganha a marca para o gestor separar (desde 12/11/2026).
    for (const a of lista) {
      if (a.situacao !== 'vigente' && a.situacao !== 'teste') continue;
      const m = (((porProduto[a.produtoId] || {}).membros) || {})[a.email];
      if (m && m.vitalicio && membroAtivo(m, agora)) {
        a.acessoVitalicio = true;
        a.vitalicioOrigem = 'concedido';
      }
    }
    const assPorProdEmail = {};
    for (const a of lista) {
      if (!a.produtoId || !a.email) continue;
      (assPorProdEmail[a.produtoId + '|' + a.email] = assPorProdEmail[a.produtoId + '|' + a.email] || []).push(a);
    }
    const t = x => (x ? new Date(x).getTime() : 0);
    for (const [pid, prod] of Object.entries(porProduto)) {
      const nomeProduto = (prod && prod.nome) || (pid === PRODUTO_PAINEL_ID ? PRODUTO_PAINEL_NOME : pid);
      for (const [em, ac] of Object.entries((prod && prod.membros) || {})) {
        const ativo = membroAtivo(ac, agora);
        const doEmail = assPorProdEmail[pid + '|' + em] || [];
        if (doEmail.some(a => a.situacao === 'vigente' || a.situacao === 'teste' || a.situacao === 'vitalicio')) continue;
        if (!ativo && doEmail.length) continue;
        const fim = ac.removidoEm || null;
        const situacao = ativo ? (ac.vitalicio ? 'vitalicio' : 'vigente') : 'encerrada';
        // Vitalício concedido num produto cujas ofertas têm prazo: guarda a
        // oferta recorrente que a pessoa teve (a mais recente), para o gestor
        // mostrar "concedido · oferta com prazo: X".
        const recorrente = ac.vitalicio
          ? doEmail.filter(a => a.tipo === 'recurring').sort((x, y) => t(y.inicio || y.criadaEm) - t(x.inicio || x.criadaEm))[0]
          : null;
        const oa = (d.ofertasAcesso || {})[pid + '|' + em] || null;
        const gratis = doEmail.filter(a => a.tipo === 'free').sort((x, y) => t(y.inicio || y.criadaEm) - t(x.inicio || x.criadaEm))[0];
        const rotulo = ac.vitalicio
          ? (ac.tipo === 'free' ? 'Acesso vitalício gratuito' : 'Acesso vitalício (sem assinatura paga)')
          : (ac.tipo === 'free' ? 'Acesso gratuito / convite' : 'Acesso ao produto (sem fatura)');
        lista.push({
          id: 'acesso:' + pid + ':' + em, fonte: 'acesso', email: em, nome: ac.nome, telefone: ac.telefone,
          produtoId: pid, produtoNome: nomeProduto,
          ofertaNome: gratis && gratis.ofertaNome ? gratis.ofertaNome : (oa ? oa.ofertaNome : rotulo),
          ofertaConfirmada: !!((gratis && gratis.ofertaNome) || oa),
          ofertaFonte: gratis && gratis.ofertaNome ? 'assinatura gratuita' : (oa ? oa.fonte : undefined),
          turmas: Array.isArray(ac.turmas) && ac.turmas.length ? ac.turmas : undefined,
          tipo: ac.tipo, gratuito: ac.tipo === 'free', doPainel: pid === PRODUTO_PAINEL_ID,
          liberaPainel: false, situacao, fim, inicio: ac.entrouEm || undefined,
          vitalicioOrigem: origemVitalicio(ac, situacao) || undefined,
          ofertaComPrazo: recorrente ? (recorrente.ofertaNome || recorrente.produtoNome) : undefined,
          diasRestantes: ativo && fim && !ac.vitalicio ? Math.ceil((new Date(fim).getTime() - agora) / DIA) : null,
        });
      }
    }
    const excluidos = new Set();
    for (const a of lista) {
      a.produtoExcluido = produtoExcluidoNaHubla(d, a.produtoId, a.produtoNome);
      if (a.produtoExcluido && a.produtoNome) excluidos.add(a.produtoNome);
    }
    if (painel === '1' || painel === true) lista = lista.filter(a => a.liberaPainel);
    if (situacao) {
      const quer = new Set(String(situacao).split(','));
      lista = lista.filter(a => quer.has(a.situacao));
    }
    if (email) lista = lista.filter(a => a.email === String(email).toLowerCase().trim());
    lista.sort((a, b) => String(a.fim || '9999').localeCompare(String(b.fim || '9999')));
    return { total: lista.length, atualizadoEm: d.atualizadoEm, sincronizacao: d.sincronizacao,
      produtosHublaEm: (d.produtosHubla && d.produtosHubla.em) || null,
      produtosExcluidos: [...excluidos].sort((a, b) => a.localeCompare(b, 'pt-BR')), assinaturas: lista };
  }

  return {
    registrarEvento, sincronizar, sincronizarMembros, listar, ler, resumir, progresso, sondarApi, gravarOfertasAcesso,
    temChaveApi: () => !!apiKey(),
  };
}

module.exports = {
  criarHublaAssinaturas, ofertaLiberaPainel, assinaturaLiberaPainel, produtoExcluidoNaHubla,
  definirRegrasAcesso, regrasAcessoAtivas, gruposAcesso, indiceGrupos, regraPadraoAcesso, regraAcesso, indiceRegras, REGRAS_ACESSO: REGRAS, ofertaPainelExigePrazo, OFERTAS_PAINEL_OUTROS_PRODUTOS, produtoOfertaDoEvento, calcularSituacao, membroAtivo, outroAcessoPainel, origemVitalicio,
  camposDaAssinatura, mesclarRegistro, OFERTAS_PAINEL, PRODUTO_PAINEL_ID, ARQUIVO_HUBLA_ASSINATURAS: ARQUIVO,
};
