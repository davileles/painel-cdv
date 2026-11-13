// google-contatos.js — nome de cada aluno no Google Contatos do Davi (desde 13/11/2026).
//
// Padrão do nome: "<Nome> <SIGLA> <dd/mm/aa>" (ex.: "William Camargo CDV 16/09/27").
// Quem lê esta lista é o Apps Script da conta Google do Davi (pasta
// google-contatos/ deste repo), pela rota GET /hubla/contatos do proxy: o script
// acha o contato pelo telefone (ou e-mail), troca só o fim do nome (sigla + data)
// e cria o contato de quem não está na agenda. Este módulo não fala com o Google.
//
// Regra da assinatura que vale para o nome (decisão do Davi, 13/11/2026):
//   - só contam ofertas que dão acesso a GRUPOS do CDV (painel-regras-acesso.json →
//     ofertas[id].grupos) e que têm sigla (SIGLAS abaixo ou ofertas[id].sigla);
//     ex.: o acesso vitalício ao conteúdo gravado não dá grupo, então nunca entra
//     — vale a outra assinatura da pessoa que dá grupo, mesmo que seja anterior;
//     Escola do Viajante vitalícia (e oferta "Só com prazo" vitalícia) também não conta;
//   - entre as que contam, vale a ÚLTIMA: primeiro as ativas (a de início mais
//     recente); sem nenhuma ativa, a que terminou por último;
//   - exceção com oferta (gestor → Exceções) só vale se a pessoa não tiver nenhuma
//     assinatura ativa que conte (a extensão/bônus não esconde o Premium pago);
//   - vitalício sai com "VIT" no lugar da data.
//
// CommonJS. Usa as regras de situação de hubla-assinaturas.js.
const { calcularSituacao, membroAtivo, nomeProprio } = require('./hubla-assinaturas');
const { chaveTelefone } = require('./hubla-grupos-auditoria');

// Sigla pelo nome da oferta e, se não bater, pelo nome do produto. A primeira
// regra que casa vence (ordem importa: "Premium" antes de "Clube do Viajante").
// Para trocar a sigla de uma oferta específica: ofertas[id].sigla no
// painel-regras-acesso.json (vence esta tabela).
const SIGLAS = [
  { re: /concierge/, sigla: 'TRC' },             // Travel Concierge
  { re: /escola do viajante|clube \+ escola/, sigla: 'EDV' }, // Escola do Viajante, Combo Especial - Clube + Escola
  { re: /premium/, sigla: 'CDVP' },              // Clube do Viajante Premium (todas as variações)
  { re: /clube do viajante|tudo sobre promos|ex.?alunos|membros antigos/, sigla: 'CDV' },
];
const SIGLAS_CONHECIDAS = ['TRC', 'EDV', 'CDVP', 'CDV'];
// Nunca dá nome, mesmo se alguém marcar grupo nela por engano.
const NUNCA = /conteudo gravado/;

function norm(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}
function siglaPorNome(ofertaNome, produtoNome) {
  for (const txt of [norm(ofertaNome), norm(produtoNome)]) {
    if (!txt) continue;
    for (const s of SIGLAS) if (s.re.test(txt)) return s.sigla;
  }
  return '';
}
// dd/mm/aa no fuso de São Paulo (-03:00 fixo).
function dataCurta(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const d = new Date(t - 3 * 3600000);
  const p = n => String(n).padStart(2, '0');
  return p(d.getUTCDate()) + '/' + p(d.getUTCMonth() + 1) + '/' + String(d.getUTCFullYear()).slice(-2);
}
const ms = v => (v ? new Date(v).getTime() || 0 : 0);
function soDigitos(t) { return String(t || '').replace(/\D/g, ''); }

// arquivoRegras = painel-regras-acesso.json; excecoes = lista única de
// painel-excecoes.json (lerExcecoesPainel().proprias); ajustes = ajustes de cadastro.
function montarContatos({ hubla, arquivoRegras, excecoes, ajustes, agora = Date.now() }) {
  const ofertasRegra = (arquivoRegras && arquivoRegras.ofertas) || {};
  const gruposDaOferta = new Map();   // ofertaId → nº de grupos
  const gruposDoProduto = new Map();  // produtoId → nº de grupos (união, p/ acesso sem oferta)
  const siglaManual = new Map();
  for (const [id, r] of Object.entries(ofertasRegra)) {
    const n = Array.isArray(r && r.grupos) ? r.grupos.filter(j => /@g\.us$/.test(String(j))).length : 0;
    if (r && r.sigla) siglaManual.set(id, String(r.sigla).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6));
    if (!n) continue;
    gruposDaOferta.set(id, n);
    if (r.produtoId) gruposDoProduto.set(r.produtoId, (gruposDoProduto.get(r.produtoId) || 0) + n);
  }
  const semSigla = new Map(); // ofertas que dão grupo mas não têm sigla (relatório)
  function siglaDe(ofertaId, ofertaNome, produtoNome) {
    if (ofertaId && siglaManual.has(ofertaId)) return siglaManual.get(ofertaId);
    return siglaPorNome(ofertaNome, produtoNome);
  }
  // Conta para o nome? Devolve a sigla ('' = não conta).
  function siglaSeConta(rec, vitalicio) {
    if (NUNCA.test(norm(rec.ofertaNome)) || NUNCA.test(norm(rec.produtoNome))) return '';
    // Escola do Viajante vitalícia = conteúdo gravado, sem grupo; o mesmo vale para
    // qualquer oferta marcada "Só com prazo" nas Regras de acesso.
    if (vitalicio && (/escola/.test(norm(rec.ofertaNome) + ' ' + norm(rec.produtoNome))
      || (rec.ofertaId && ofertasRegra[rec.ofertaId] && ofertasRegra[rec.ofertaId].regra === 'prazo'))) return '';
    let daGrupo;
    if (rec.ofertaId) daGrupo = gruposDaOferta.has(rec.ofertaId);
    else daGrupo = gruposDoProduto.has(rec.produtoId);
    if (!daGrupo) return '';
    const s = siglaDe(rec.ofertaId, rec.ofertaNome, rec.produtoNome);
    if (!s) {
      const k = (rec.produtoNome || '') + ' · ' + (rec.ofertaNome || '');
      semSigla.set(k, (semSigla.get(k) || 0) + 1);
    }
    return s;
  }

  // ── registros (assinaturas, acessos sem fatura, exceções) ──
  const regs = [];
  const assinaturas = Object.values((hubla && hubla.assinaturas) || {});
  const temAss = new Set();
  for (const a of assinaturas) {
    if (!a) continue;
    const { situacao, fim } = calcularSituacao(a, agora);
    if (situacao === 'pendente' || situacao === 'desconhecida') continue;
    if (a.produtoId && a.email) temAss.add(a.produtoId + '|' + String(a.email).toLowerCase().trim());
    const rec = { fonte: 'assinatura', ofertaId: a.ofertaId || '', produtoId: a.produtoId || '', ofertaNome: a.ofertaNome || '', produtoNome: a.produtoNome || '' };
    rec.sigla = siglaSeConta(rec, situacao === 'vitalicio');
    if (!rec.sigla) continue;
    rec.ativo = situacao === 'vigente' || situacao === 'teste' || situacao === 'vitalicio';
    rec.vitalicio = situacao === 'vitalicio';
    rec.fim = rec.vitalicio ? null : fim;
    rec.inicio = a.primeiraAtivacao || a.ativadaEm || a.inicio || a.criadaEm || null;
    rec.nome = a.nome; rec.email = a.email; rec.telefone = a.telefone;
    regs.push(rec);
  }
  const ofAcesso = (hubla && hubla.ofertasAcesso) || {};
  for (const [pid, p] of Object.entries((hubla && hubla.acessosPorProduto) || {})) {
    for (const [email, m] of Object.entries((p && p.membros) || {})) {
      if (!m) continue;
      // Quem tem assinatura do mesmo produto já entra por ela (a lista de membros
      // repete o mesmo acesso sem dizer a oferta).
      if (temAss.has(pid + '|' + String(email).toLowerCase().trim())) continue;
      const oa = ofAcesso[pid + '|' + email] || null;
      // Vitalício sem oferta conhecida é, quase sempre, o conteúdo gravado: fora.
      if (m.vitalicio && !oa) continue;
      const rec = { fonte: 'acesso', ofertaId: (oa && oa.ofertaId) || '', produtoId: pid,
        ofertaNome: (oa && oa.ofertaNome) || '', produtoNome: (p && p.nome) || '' };
      rec.sigla = siglaSeConta(rec, !!m.vitalicio && membroAtivo(m, agora));
      if (!rec.sigla) continue;
      rec.ativo = membroAtivo(m, agora);
      rec.vitalicio = rec.ativo && !!m.vitalicio;
      rec.fim = rec.vitalicio ? null : (m.removidoEm || null);
      rec.inicio = m.entrouEm || null;
      rec.nome = m.nome; rec.email = email; rec.telefone = m.telefone;
      regs.push(rec);
    }
  }
  for (const x of (Array.isArray(excecoes) ? excecoes : [])) {
    if (!x || !(x.ofertaId || x.ofertaNome) || !(x.email || x.telefone)) continue;
    const rec = { fonte: 'excecao', ofertaId: x.ofertaId || '', produtoId: x.produtoId || '', ofertaNome: x.ofertaNome || '', produtoNome: x.produtoNome || '' };
    const fimMs = /^\d{4}-\d{2}-\d{2}$/.test(String(x.fim || '')) ? new Date(x.fim + 'T23:59:59-03:00').getTime() : null;
    rec.sigla = siglaSeConta(rec, fimMs === null);
    if (!rec.sigla) continue;
    rec.ativo = fimMs === null || fimMs >= agora;
    rec.vitalicio = fimMs === null;
    rec.fim = fimMs === null ? null : new Date(fimMs).toISOString();
    rec.inicio = x.criadoEm || x.atualizadoEm || null;
    rec.nome = x.nome; rec.email = x.email || ''; rec.telefone = x.telefone || '';
    regs.push(rec);
  }

  // ── pessoas: mesma pessoa = mesmo e-mail ou mesmo telefone ──
  const extrasTel = new Map(); // e-mail da Hubla → telefones dos Ajustes de cadastro
  const extrasEmail = new Map(); // e-mail da Hubla → e-mail do painel
  for (const a of (Array.isArray(ajustes) ? ajustes : [])) {
    const e = String((a && a.emailHubla) || '').toLowerCase().trim();
    if (!e) continue;
    if (a.telefone) { const l = extrasTel.get(e) || []; l.push(String(a.telefone)); extrasTel.set(e, l); }
    if (a.emailPainel) { const l = extrasEmail.get(e) || []; l.push(String(a.emailPainel).toLowerCase().trim()); extrasEmail.set(e, l); }
  }
  const pai = new Map();
  const achar = k => { while (pai.get(k) !== k) { pai.set(k, pai.get(pai.get(k))); k = pai.get(k); } return k; };
  const unir = (a, b) => { if (!pai.has(a)) pai.set(a, a); if (!pai.has(b)) pai.set(b, b); const ra = achar(a), rb = achar(b); if (ra !== rb) pai.set(rb, ra); };
  const chavesDe = r => {
    const ks = [];
    const e = String(r.email || '').toLowerCase().trim();
    if (e) ks.push('e:' + e);
    const t = chaveTelefone(r.telefone); if (t) ks.push('t:' + t);
    for (const t2 of (extrasTel.get(e) || [])) { const k = chaveTelefone(t2); if (k) ks.push('t:' + k); }
    for (const e2 of (extrasEmail.get(e) || [])) ks.push('e:' + e2);
    return ks;
  };
  for (const r of regs) {
    r._ks = chavesDe(r);
    if (!r._ks.length) continue;
    for (const k of r._ks) unir(r._ks[0], k);
  }
  const grupos = new Map();
  for (const r of regs) {
    if (!r._ks.length) continue;
    const raiz = achar(r._ks[0]);
    const l = grupos.get(raiz) || []; l.push(r); grupos.set(raiz, l);
  }

  const contatos = [];
  for (const lista of grupos.values()) {
    const reais = lista.filter(r => r.fonte !== 'excecao');
    const excs = lista.filter(r => r.fonte === 'excecao');
    const ordAtivo = (a, b) => (ms(b.inicio) - ms(a.inicio)) || ((b.vitalicio ? Infinity : ms(b.fim)) - (a.vitalicio ? Infinity : ms(a.fim)));
    const ordFim = (a, b) => ms(b.fim) - ms(a.fim);
    const escolhido = reais.filter(r => r.ativo).sort(ordAtivo)[0]
      || excs.filter(r => r.ativo).sort(ordAtivo)[0]
      || lista.filter(r => !r.ativo).sort(ordFim)[0];
    if (!escolhido) continue;
    // Nome: o do registro escolhido; sem nome, o de qualquer outro.
    const nome = nomeProprio((escolhido.nome && !String(escolhido.nome).includes('@') ? escolhido.nome : '')
      || (lista.find(r => r.nome && !String(r.nome).includes('@')) || {}).nome || '');
    const telefones = [...new Set(lista.flatMap(r => [r.telefone, ...(extrasTel.get(String(r.email || '').toLowerCase().trim()) || [])]).map(soDigitos).filter(t => t.length >= 10))];
    const emails = [...new Set(lista.flatMap(r => { const e = String(r.email || '').toLowerCase().trim(); return e ? [e, ...(extrasEmail.get(e) || [])] : []; }))];
    if (!telefones.length && !emails.length) continue;
    const quando = escolhido.vitalicio ? 'VIT' : dataCurta(escolhido.fim);
    const sufixo = [escolhido.sigla, quando].filter(Boolean).join(' ');
    contatos.push({
      id: emails[0] ? 'e:' + emails[0] : 't:' + telefones[0],
      nome, sufixo, nomeContato: [nome, sufixo].filter(Boolean).join(' '),
      sigla: escolhido.sigla, fim: escolhido.fim || null, vitalicio: !!escolhido.vitalicio, ativo: !!escolhido.ativo,
      oferta: escolhido.ofertaNome || escolhido.produtoNome, produto: escolhido.produtoNome, fonte: escolhido.fonte,
      telefones, chavesTelefone: [...new Set(telefones.map(chaveTelefone).filter(Boolean))], emails,
    });
  }
  contatos.sort((a, b) => a.nomeContato.localeCompare(b.nomeContato, 'pt-BR'));
  const siglas = [...new Set(SIGLAS_CONHECIDAS.concat([...siglaManual.values()]))];
  return {
    geradoEm: new Date(agora).toISOString(),
    total: contatos.length,
    ativos: contatos.filter(c => c.ativo).length,
    siglas,
    // Fim do nome que o script troca: " SIGLA dd/mm/aa" ou " SIGLA VIT" (qualquer
    // sigla de 2 a 6 letras, para limpar também siglas antigas).
    padraoSufixo: '\\s+[A-Z]{2,6}\\s+(\\d{2}/\\d{2}/\\d{2,4}|VIT)\\s*$',
    ofertasSemSigla: [...semSigla.entries()].map(([oferta, registros]) => ({ oferta, registros })),
    contatos,
  };
}

module.exports = { montarContatos, siglaPorNome, dataCurta, SIGLAS, SIGLAS_CONHECIDAS };
