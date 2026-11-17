// Vendas antigas da Hotmart (antes da Hubla) — desde 17/11/2026.
//
// O Davi vendia pela Hotmart antes de ir para a Hubla. Dois produtos de lá
// entram na base:
//   "Tudo Sobre Milhas"                      → Escola do Viajante (EDV)
//   "Grupos Exclusivos Tudo Sobre Milhas"    → Clube do Viajante (CDV)
// ("Escola do Viajante"/"Clube do Viajante" escritos à mão no arquivo também.)
// "Travel Concierge" e qualquer outro produto ficam de fora.
//
// Cada venda vale 1 ano a partir da compra (tempo de acesso do sistema para a
// Escola; o Grupos Exclusivos era assinatura anual). Tudo é HISTÓRICO: nada
// aqui dá acesso ao painel nem aos grupos, e a auditoria dos grupos / Tico não
// leem este arquivo. Serve para a base de ex-clientes (gestor → Assinaturas) e
// para o Google Contatos — e, lá, só para quem NÃO tem nenhum registro na
// Hubla, no concierge nem nas exceções (quem comprou depois na Hubla segue o
// nome da Hubla: a venda da Hotmart nunca sobrescreve).
//
// Arquivo: hotmart-vendas.json (repo de dados, ARQUIVOS_SENSIVEIS) =
//   {atualizadoEm, vendas:{<id>:{id, produto, sigla, nome, email, telefone,
//    cidade, estado, compraEm, fim, valor, transacao, importadoEm}}}
// Não guarda CPF nem endereço (o CSV da Hotmart tem; não são necessários).
// CommonJS.

const { nomeProprio } = require('./hubla-assinaturas');

const PRODUTOS = [
  { re: /^grupos exclusivos/, produto: 'Clube do Viajante', sigla: 'CDV' },
  { re: /^clube do viajante$/, produto: 'Clube do Viajante', sigla: 'CDV' },
  { re: /^tudo sobre milhas$/, produto: 'Escola do Viajante', sigla: 'EDV' },
  { re: /^escola do viajante$/, produto: 'Escola do Viajante', sigla: 'EDV' },
];
const STATUS_OK = /^(completo|aprovado)$/;

function norm(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}
function produtoDe(nomeProduto) {
  const n = norm(nomeProduto);
  for (const p of PRODUTOS) if (p.re.test(n)) return p;
  return null;
}
// "01/08/2023 09:11:36" (horário de SP) → ISO.
function dataBr(s) {
  const m = String(s || '').trim().match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  const iso = `${m[3]}-${m[2]}-${m[1]}T${m[4] || '12'}:${m[5] || '00'}:${m[6] || '00'}-03:00`;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
// Mesmo dia no ano seguinte, até o fim do dia (SP).
function umAnoDepois(iso) {
  const d = new Date(new Date(iso).getTime() - 3 * 3600000);
  const y = d.getUTCFullYear() + 1, mo = d.getUTCMonth() + 1, dia = d.getUTCDate();
  const p = n => String(n).padStart(2, '0');
  const ultimo = new Date(Date.UTC(y, mo, 0)).getUTCDate(); // 29/02 → 28/02
  return new Date(`${y}-${p(mo)}-${p(Math.min(dia, ultimo))}T23:59:59-03:00`).toISOString();
}
function telefoneDe(ddd, tel, pais) {
  const t = String(tel || '').replace(/\D/g, '');
  const d = String(ddd || '').replace(/\D/g, '');
  if (!t) return '';
  const brasil = !pais || norm(pais) === 'brasil';
  if (!brasil) return d + t;
  let n = t.length >= 10 ? t : d + t;
  if (n.length === 10 || n.length === 11) n = '55' + n;
  return n;
}

// cabecalho = linha 1 do CSV; linhas = demais linhas (arrays). A coluna vale
// pela PRIMEIRA ocorrência do nome (o CSV da Hotmart repete "Moeda").
function normalizarCsv(cabecalho, linhas, agoraIso = new Date().toISOString()) {
  const idx = {};
  (Array.isArray(cabecalho) ? cabecalho : []).forEach((h, i) => { const k = norm(h); if (k && !(k in idx)) idx[k] = i; });
  const col = (l, nome) => { const i = idx[norm(nome)]; return i === undefined ? '' : String(l[i] == null ? '' : l[i]).trim(); };
  const vendas = {};
  const ignorados = { produto: {}, status: 0, semContato: 0, semData: 0 };
  for (const l of (Array.isArray(linhas) ? linhas : [])) {
    if (!Array.isArray(l) || !l.some(v => String(v || '').trim())) continue;
    const nomeProduto = col(l, 'Nome do Produto');
    const p = produtoDe(nomeProduto);
    if (!p) { const k = nomeProduto || '(vazio)'; ignorados.produto[k] = (ignorados.produto[k] || 0) + 1; continue; }
    const status = col(l, 'Status');
    if (status && !STATUS_OK.test(norm(status))) { ignorados.status++; continue; }
    const compraEm = dataBr(col(l, 'Data de Venda')) || dataBr(col(l, 'Data de Confirmação'));
    if (!compraEm) { ignorados.semData++; continue; }
    const email = col(l, 'Email').toLowerCase();
    const telefone = telefoneDe(col(l, 'DDD'), col(l, 'Telefone'), col(l, 'País'));
    if (!email && !telefone) { ignorados.semContato++; continue; }
    const transacao = col(l, 'Transação');
    const id = 'hotmart:' + (transacao || (p.sigla + ':' + (email || telefone) + ':' + compraEm.slice(0, 10)));
    vendas[id] = {
      id, produto: p.produto, sigla: p.sigla, produtoHotmart: nomeProduto,
      nome: nomeProprio(col(l, 'Nome')), email, telefone,
      cidade: col(l, 'Cidade'), estado: col(l, 'Estado'),
      compraEm, fim: umAnoDepois(compraEm),
      valor: Number(col(l, 'Preço Total Convertido') || col(l, 'Preço Total') || col(l, 'Preço do Produto')) || null,
      transacao: transacao || null, importadoEm: agoraIso,
    };
  }
  return { vendas, ignorados };
}

// Linhas no formato de GET /hubla/assinaturas (fonte:'hotmart', sempre encerrada
// ou, se o ano ainda não acabou, 'vigente' só como informação).
function linhasAssinaturas(arquivo, agora = Date.now()) {
  return Object.values((arquivo && arquivo.vendas) || {}).map(v => {
    const fimMs = new Date(v.fim).getTime();
    const ativo = fimMs >= agora;
    return {
      id: v.id, fonte: 'hotmart', email: v.email || '', nome: v.nome || '', telefone: v.telefone || '',
      produtoId: 'hotmart-' + v.sigla.toLowerCase(), produtoNome: v.produto + ' (Hotmart)',
      ofertaNome: v.produtoHotmart || v.produto, tipo: 'one_time', gratuito: false,
      doPainel: false, liberaPainel: false, situacao: ativo ? 'vigente' : 'encerrada',
      inicio: v.compraEm, fim: v.fim, diasRestantes: ativo ? Math.ceil((fimMs - agora) / 86400000) : null,
      valor: v.valor, cidade: v.cidade, estado: v.estado, produtoExcluido: false,
    };
  });
}

// Registros para google-contatos.js (montarContatos → hotmart).
function registrosContatos(arquivo, agora = Date.now()) {
  return Object.values((arquivo && arquivo.vendas) || {}).map(v => ({
    fonte: 'hotmart', ofertaId: '', produtoId: '', ofertaNome: v.produto, produtoNome: v.produto, gratuito: false,
    sigla: v.sigla, ativo: new Date(v.fim).getTime() >= agora, vitalicio: false, fim: v.fim, inicio: v.compraEm,
    nome: v.nome, email: v.email || '', telefone: v.telefone || '',
  }));
}

module.exports = { normalizarCsv, linhasAssinaturas, registrosContatos, produtoDe, umAnoDepois, telefoneDe };
