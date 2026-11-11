// hubla-grupos-auditoria.js — quem está nos grupos de WhatsApp do CDV sem acesso
// ativo na Hubla e, desde 11/11/2026, quem o Tico deve tirar do grupo.
// O relatório (auditar) não remove ninguém; a remoção é feita pelo proxy
// (index.js, bloco "Remoção pelo Tico") com a lista de candidatosRemocao().
//
// Entrada (montada em index.js):
//   - hubla: conteúdo de hubla-assinaturas.json (assinaturas + acessosPorProduto)
//   - grupos: [{ jid, nome, membros: [{ telefone, admin, conta }] }] do baileys-server
//   - clientesConcierge: dados/concierge/clientes.json (concierge não passa pela Hubla)
//   - gruposRegras (opcional): { porOferta: Map ofertaId→Set(jid), porProduto:
//     Map produtoId→Set(jid), mapeados: Set(jid) } — quais grupos cada oferta dá
//     (painel-regras-acesso.json). Grupo que nenhuma oferta marca segue a regra
//     antiga: qualquer assinatura ativa vale.
//   - excecoes (opcional): Set de chaves de telefone que ficam (exceções do
//     painel e admins do CDV).
// Cruzamento pelo telefone: DDI 55 + DDD + últimos 8 dígitos (o 9º dígito do
// celular às vezes falta no WhatsApp ou no cadastro).
//
// Situações por grupo: ativo · excecao · concierge · vencido (teve oferta que
// dava este grupo e acabou) · sem_direito (tem cadastro, mas nenhuma oferta
// dele dá este grupo) · sem_cadastro.
//
// CommonJS. Usa as regras de situação de hubla-assinaturas.js.
const { calcularSituacao, membroAtivo } = require('./hubla-assinaturas');

// Grupos fora da conferência (nome, sem acento/caixa). Emissões em executiva tem
// clientes do concierge sem cadastro na Hubla (decisão do Davi, 29/10/2026).
const GRUPOS_IGNORADOS = [/executiva/, /grupo operador/];
const DIA = 86400000;

function norm(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}
function chaveTelefone(t) {
  const d = String(t || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) return d.slice(0, 4) + d.slice(-8);
  if (d.length === 10 || d.length === 11) return '55' + d.slice(0, 2) + d.slice(-8); // sem DDI
  return d;
}
function maisRecente(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return new Date(a) >= new Date(b) ? a : b;
}
function grupoIgnorado(nome) { const n = norm(nome); return GRUPOS_IGNORADOS.some(re => re.test(n)); }

// Registros por telefone: cada assinatura/acesso com produto, oferta, se está
// ativo e quando acabou (só datas passadas).
function indicePorTelefone(hubla, agora) {
  const porChave = new Map();
  const add = (k, r) => { if (!k) return; const l = porChave.get(k) || []; l.push(r); porChave.set(k, l); };
  for (const [pid, p] of Object.entries((hubla && hubla.acessosPorProduto) || {})) {
    for (const [email, m] of Object.entries(p.membros || {})) {
      const ativo = membroAtivo(m, agora);
      const fim = !ativo && m.removidoEm && new Date(m.removidoEm).getTime() <= agora ? m.removidoEm : null;
      add(chaveTelefone(m.telefone), { tipo: 'acesso', produtoId: pid, ofertaId: null, produto: p.nome, nome: m.nome, email, ativo, fim, conta: true });
    }
  }
  for (const a of Object.values((hubla && hubla.assinaturas) || {})) {
    const sit = calcularSituacao(a, agora).situacao;
    const ativo = sit === 'vigente' || sit === 'teste' || sit === 'vitalicio';
    // Como antes: só conta como "já teve" a assinatura cancelada/inativa (pendente
    // e desconhecida não dizem nada).
    const conta = ativo || a.status === 'inactive' || a.status === 'canceled';
    let fim = null;
    if (!ativo) {
      const f = a.inativadaEm || a.canceladaEm || a.modificadaEm;
      if (f && new Date(f).getTime() <= agora) fim = f;
    }
    add(chaveTelefone(a.telefone), { tipo: 'assinatura', produtoId: a.produtoId || '', ofertaId: a.ofertaId || '', produto: a.produtoNome,
      oferta: a.ofertaNome, nome: a.nome, email: a.email, ativo, fim, conta });
  }
  return porChave;
}

// Esse registro dá acesso ao grupo jid?
function registroDaGrupo(r, jid, regras) {
  if (!regras || !regras.mapeados || !regras.mapeados.has(jid)) return true; // grupo sem regra: qualquer cadastro vale
  if (r.ofertaId && regras.porOferta.has(r.ofertaId)) return regras.porOferta.get(r.ofertaId).has(jid);
  if (r.tipo === 'acesso' || !r.ofertaId) { const s = regras.porProduto.get(r.produtoId); return !!(s && s.has(jid)); }
  return false;
}

function situacaoNoGrupo(regs, jid, regras) {
  const validos = (regs || []).filter(r => r.conta);
  const dao = validos.filter(r => registroDaGrupo(r, jid, regras));
  if (dao.some(r => r.ativo)) return { situacao: 'ativo' };
  const vencidos = dao.filter(r => !r.ativo);
  if (vencidos.length) {
    let venceuEm = null;
    for (const r of vencidos) if (r.fim) venceuEm = maisRecente(venceuEm, r.fim);
    return { situacao: 'vencido', venceuEm, registros: vencidos };
  }
  if (validos.length) return { situacao: 'sem_direito', registros: validos };
  return { situacao: 'sem_cadastro' };
}

function auditar({ hubla, grupos, clientesConcierge, gruposRegras, excecoes, agora = Date.now() }) {
  const porChave = indicePorTelefone(hubla, agora);
  const regras = gruposRegras || null;
  const exc = excecoes instanceof Set ? excecoes : new Set();
  const concierge = new Map();
  for (const c of (Array.isArray(clientesConcierge) ? clientesConcierge : [])) {
    const k = chaveTelefone(c && c.tel);
    if (k && c.ativo !== false) concierge.set(k, c.nome || '');
  }

  const resumoGrupos = [];
  const ignorados = [];
  const pessoas = new Map();   // chave|situacao → linha do relatório
  const detalhe = [];          // por grupo × pessoa fora do "ativo" (para a remoção)
  for (const g of (grupos || [])) {
    if (grupoIgnorado(g.nome)) { ignorados.push(g.nome); continue; }
    const mapeado = !!(regras && regras.mapeados && regras.mapeados.has(g.jid));
    const r = { jid: g.jid, nome: g.nome, mapeado, participantes: 0, ativo: 0, excecao: 0, concierge: 0, vencido: 0, semDireito: 0, semCadastro: 0, admins: 0 };
    for (const m of (g.membros || [])) {
      if (m.conta) continue;                 // números da casa
      r.participantes++;
      if (m.admin) { r.admins++; continue; } // admins ficam fora da conferência
      const k = chaveTelefone(m.telefone);
      const regs = k ? porChave.get(k) : null;
      let s = situacaoNoGrupo(regs, g.jid, regras);
      if (s.situacao !== 'ativo') {
        if (k && exc.has(k)) s = { situacao: 'excecao' };
        else if (k && concierge.has(k)) s = { situacao: 'concierge' };
      }
      const situacao = s.situacao;
      const campo = { sem_cadastro: 'semCadastro', sem_direito: 'semDireito' }[situacao] || situacao;
      r[campo]++;
      if (situacao === 'ativo') continue;
      const qualquer = (regs || [])[0] || {};
      const nome = situacao === 'concierge' ? concierge.get(k) : (qualquer.nome || '');
      const email = qualquer.email || '';
      const produtos = [...new Set((s.registros || []).map(x => x.produto).filter(Boolean))].sort();
      const diasDesde = s.venceuEm ? Math.floor((agora - new Date(s.venceuEm).getTime()) / DIA) : null;
      detalhe.push({ jid: g.jid, grupo: g.nome, mapeado, telefone: String(m.telefone || ''), chave: k, situacao,
        nome, email, produtos, venceuEm: s.venceuEm || null, diasDesdeVencimento: diasDesde });
      const id = (k || m.telefone) + '|' + situacao;
      const linha = pessoas.get(id) || {
        telefone: String(m.telefone || ''), situacao, grupos: [], nome, email, produtos, venceuEm: s.venceuEm || null, diasDesdeVencimento: diasDesde,
      };
      linha.grupos.push(g.nome);
      if (s.venceuEm && (!linha.venceuEm || new Date(s.venceuEm) > new Date(linha.venceuEm))) {
        linha.venceuEm = s.venceuEm; linha.diasDesdeVencimento = diasDesde;
      }
      for (const p of produtos) if (!linha.produtos.includes(p)) linha.produtos.push(p);
      pessoas.set(id, linha);
    }
    resumoGrupos.push(r);
  }
  resumoGrupos.sort((a, b) => b.participantes - a.participantes);
  const lista = [...pessoas.values()];
  const ordem = { sem_cadastro: 0, vencido: 1, sem_direito: 2, concierge: 3, excecao: 4 };
  lista.sort((a, b) => (ordem[a.situacao] - ordem[b.situacao]) || (b.grupos.length - a.grupos.length)
    || String(a.nome || a.telefone).localeCompare(String(b.nome || b.telefone), 'pt-BR'));
  for (const l of lista) { l.grupos.sort((a, b) => a.localeCompare(b, 'pt-BR')); l.produtos.sort(); }

  const unicos = { vencido: 0, sem_direito: 0, sem_cadastro: 0, concierge: 0, excecao: 0 };
  for (const l of lista) unicos[l.situacao]++;
  return {
    geradoEm: new Date(agora).toISOString(),
    hublaAtualizadoEm: (hubla && hubla.atualizadoEm) || null,
    ignorados,
    totais: unicos,
    grupos: resumoGrupos,
    pessoas: lista,
    detalhe,
  };
}

// Quem o Tico tira, a partir do detalhe da auditoria. Só em grupo com regra de
// grupos (mapeado), só quem tem cadastro (o telefone casou com a Hubla) e:
//   - vencido há pelo menos carenciaDias; ou
//   - sem_direito, se incluirSemDireito (tem assinatura, mas nenhuma oferta dá o grupo).
// Sem cadastro, exceção, concierge, admin e número da casa nunca saem.
// Devolve uma linha por pessoa com os grupos de onde sai.
function candidatosRemocao(aud, { carenciaDias = 3, incluirSemDireito = false } = {}) {
  const porPessoa = new Map();
  for (const d of ((aud && aud.detalhe) || [])) {
    if (!d.mapeado || !d.chave || !d.telefone) continue;
    let motivo = null;
    if (d.situacao === 'vencido') {
      if (d.diasDesdeVencimento === null || d.diasDesdeVencimento < carenciaDias) continue;
      motivo = 'vencido';
    } else if (d.situacao === 'sem_direito' && incluirSemDireito) {
      motivo = 'sem_direito';
    } else continue;
    const x = porPessoa.get(d.chave) || { chave: d.chave, telefone: d.telefone, nome: d.nome, email: d.email, grupos: [], motivos: [] };
    x.grupos.push({ jid: d.jid, nome: d.grupo, motivo, venceuEm: d.venceuEm, dias: d.diasDesdeVencimento });
    if (!x.motivos.includes(motivo)) x.motivos.push(motivo);
    porPessoa.set(d.chave, x);
  }
  return [...porPessoa.values()].sort((a, b) => String(a.nome || a.telefone).localeCompare(String(b.nome || b.telefone), 'pt-BR'));
}

module.exports = { auditar, candidatosRemocao, chaveTelefone, grupoIgnorado, GRUPOS_IGNORADOS };
