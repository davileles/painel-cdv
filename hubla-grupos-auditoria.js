// hubla-grupos-auditoria.js — quem está nos grupos de WhatsApp do CDV sem acesso
// ativo na Hubla. SÓ RELATÓRIO: nada aqui remove ninguém de grupo.
//
// Entrada (montada em index.js):
//   - hubla: conteúdo de hubla-assinaturas.json (assinaturas + acessosPorProduto)
//   - grupos: [{ jid, nome, membros: [{ telefone, admin, conta }] }] do baileys-server
//   - clientesConcierge: dados/concierge/clientes.json (concierge não passa pela Hubla)
// Cruzamento pelo telefone: DDI 55 + DDD + últimos 8 dígitos (o 9º dígito do
// celular às vezes falta no WhatsApp ou no cadastro).
//
// CommonJS, sem dependências.

// Grupos fora da conferência (nome, sem acento/caixa). Emissões em executiva tem
// clientes do concierge sem cadastro na Hubla (decisão do Davi, 29/10/2026).
const GRUPOS_IGNORADOS = [/executiva/, /grupo operador/];

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

function auditar({ hubla, grupos, clientesConcierge, agora = Date.now() }) {
  // 1. Índice por telefone: quem tem acesso ativo e quem já teve.
  const ativos = new Map();   // chave → { nome, email, produtos:Set }
  const vencidos = new Map(); // chave → { nome, email, produtos:Set, venceuEm }
  const reg = (mapa, k, dados) => {
    const x = mapa.get(k) || { nome: '', email: '', produtos: new Set(), venceuEm: null };
    if (!x.nome && dados.nome) x.nome = dados.nome;
    if (!x.email && dados.email) x.email = dados.email;
    if (dados.produto) x.produtos.add(dados.produto);
    // Só datas que já passaram: a Hubla guarda em membros desativados uma data
    // de remoção futura (até 2054 em vitalício), que não é quando o acesso acabou.
    if (dados.venceuEm && new Date(dados.venceuEm).getTime() <= agora) x.venceuEm = maisRecente(x.venceuEm, dados.venceuEm);
    mapa.set(k, x);
  };
  for (const p of Object.values((hubla && hubla.acessosPorProduto) || {})) {
    for (const [email, m] of Object.entries(p.membros || {})) {
      const k = chaveTelefone(m.telefone);
      if (!k) continue;
      if (m.status === 'active') reg(ativos, k, { nome: m.nome, email, produto: p.nome });
      else reg(vencidos, k, { nome: m.nome, email, produto: p.nome, venceuEm: m.removidoEm });
    }
  }
  for (const a of Object.values((hubla && hubla.assinaturas) || {})) {
    const k = chaveTelefone(a.telefone);
    if (!k) continue;
    if (a.status === 'active' || a.status === 'trial') reg(ativos, k, { nome: a.nome, email: a.email, produto: a.produtoNome });
    else if (a.status === 'inactive' || a.status === 'canceled') {
      reg(vencidos, k, { nome: a.nome, email: a.email, produto: a.produtoNome,
        venceuEm: a.inativadaEm || a.canceladaEm || a.modificadaEm });
    }
  }
  const concierge = new Map();
  for (const c of (Array.isArray(clientesConcierge) ? clientesConcierge : [])) {
    const k = chaveTelefone(c && c.tel);
    if (k && c.ativo !== false) concierge.set(k, c.nome || '');
  }

  // 2. Cada participante de cada grupo conferido.
  const resumoGrupos = [];
  const ignorados = [];
  const pessoas = new Map(); // chave → linha do relatório
  for (const g of (grupos || [])) {
    const nomeN = norm(g.nome);
    if (GRUPOS_IGNORADOS.some(re => re.test(nomeN))) { ignorados.push(g.nome); continue; }
    const r = { jid: g.jid, nome: g.nome, participantes: 0, ativo: 0, concierge: 0, vencido: 0, semCadastro: 0, admins: 0 };
    for (const m of (g.membros || [])) {
      if (m.conta) continue;                 // números da casa
      r.participantes++;
      if (m.admin) { r.admins++; continue; } // admins ficam fora da conferência
      const k = chaveTelefone(m.telefone);
      let situacao;
      if (k && ativos.has(k)) situacao = 'ativo';
      else if (k && concierge.has(k)) situacao = 'concierge';
      else if (k && vencidos.has(k)) situacao = 'vencido';
      else situacao = 'sem_cadastro';
      r[situacao === 'sem_cadastro' ? 'semCadastro' : situacao]++;
      if (situacao === 'ativo') continue;
      const linha = pessoas.get(k || m.telefone) || {
        telefone: String(m.telefone || ''), situacao, grupos: [],
        nome: '', email: '', produtos: [], venceuEm: null, diasDesdeVencimento: null,
      };
      linha.grupos.push(g.nome);
      if (situacao === 'vencido') {
        const v = vencidos.get(k);
        Object.assign(linha, { nome: v.nome, email: v.email, produtos: [...v.produtos].sort(), venceuEm: v.venceuEm,
          diasDesdeVencimento: v.venceuEm ? Math.floor((agora - new Date(v.venceuEm).getTime()) / 86400000) : null });
      } else if (situacao === 'concierge') {
        linha.nome = concierge.get(k);
      }
      pessoas.set(k || m.telefone, linha);
    }
    resumoGrupos.push(r);
  }
  resumoGrupos.sort((a, b) => b.participantes - a.participantes);
  const lista = [...pessoas.values()];
  const ordem = { sem_cadastro: 0, vencido: 1, concierge: 2 };
  lista.sort((a, b) => (ordem[a.situacao] - ordem[b.situacao]) || (b.grupos.length - a.grupos.length)
    || String(a.nome || a.telefone).localeCompare(String(b.nome || b.telefone), 'pt-BR'));
  for (const l of lista) l.grupos.sort((a, b) => a.localeCompare(b, 'pt-BR'));

  const unicos = { vencido: 0, sem_cadastro: 0, concierge: 0 };
  for (const l of lista) unicos[l.situacao]++;
  return {
    geradoEm: new Date(agora).toISOString(),
    hublaAtualizadoEm: (hubla && hubla.atualizadoEm) || null,
    ignorados,
    totais: unicos,
    grupos: resumoGrupos,
    pessoas: lista,
  };
}

module.exports = { auditar, chaveTelefone, GRUPOS_IGNORADOS };
