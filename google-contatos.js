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
//     Escola do Viajante vitalícia (e oferta "Só com prazo" vitalícia) também não conta,
//     nem o teste gratuito (Premium Experimental sem pagamento; o pago conta);
//   - entre as que contam, vale a ÚLTIMA: primeiro as ativas (a de início mais
//     recente); sem nenhuma ativa, a que terminou por último;
//   - exceção com oferta (gestor → Exceções) só vale se a pessoa não tiver nenhuma
//     assinatura ativa que conte (a extensão/bônus não esconde o Premium pago);
//   - Balcão (BAL), Comunidade (COM), Direto aos Pontos (DAP) e Tudo Sobre
//     Emissões (TSE) são complementos: só aparecem para quem não tem outro
//     produto ativo (DAP e TSE entram mesmo sem dar grupo, e só para quem não tem
//     nenhum outro produto, nem vencido);
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
  { re: /consultoria individual/, sigla: 'CIN' }, // Consultoria Individual
  { re: /balcao/, sigla: 'BAL' },                // Balcão CDV
  { re: /comunidade do viajante/, sigla: 'COM' }, // Comunidade do Viajante
  { re: /direto aos pontos/, sigla: 'DAP' },     // Direto aos Pontos (não dá grupo)
  { re: /tudo sobre emissoes/, sigla: 'TSE' },   // Tudo Sobre Emissões (não dá grupo)
  { re: /escola do viajante|clube \+ escola/, sigla: 'EDV' }, // Escola do Viajante, Combo Especial - Clube + Escola
  { re: /premium/, sigla: 'CDVP' },              // Clube do Viajante Premium (todas as variações)
  { re: /clube do viajante|tudo sobre promos|ex.?alunos|membros antigos/, sigla: 'CDV' },
];
const SECUNDARIAS = new Set(['BAL', 'COM', 'DAP', 'TSE']);
// Produtos que entram no nome mesmo sem dar grupo (decisão do Davi, 13/11/2026);
// como complementos, só aparecem para quem não tem produto principal ativo.
const SEM_GRUPO_CONTA = new Set(['DAP', 'TSE']);
const PRAZO_FIXO_DIAS = { TSE: 365 };
const SIGLAS_CONHECIDAS = ['BAL', 'CDV', 'CDVP', 'CIN', 'COM', 'DAP', 'EDV', 'TRC', 'TSE'];
// Nunca dá nome, mesmo se alguém marcar grupo nela por engano.
const NUNCA = /conteudo gravado/;
// Teste GRATUITO (Premium Experimental sem pagamento) não entra: o nome fica no
// último produto de verdade. Experimental pago (ex.: R$ 597 com 1 ano) conta
// normal como Premium (decisões do Davi, 13/11/2026).
const TESTE = /experimental/;
// Escola do Viajante comprada (não o conteúdo gravado, que já cai em NUNCA).
const ESCOLA_PAGA = /escola do viajante|clube \+ escola/;

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
    if (rec.gratuito && TESTE.test(norm(rec.ofertaNome))) return '';
    // Escola do Viajante vitalícia = conteúdo gravado, sem grupo; o mesmo vale para
    // qualquer oferta marcada "Só com prazo" nas Regras de acesso.
    // Exceção: compra PAGA da Escola que a Hubla gravou como vitalícia (ofertas
    // vendidas até ago/2024, antes de a oferta passar a 1 ano) vale 1 ano a partir
    // da compra (rec.prazoFixoDias, decisão do Davi, 13/11/2026).
    if (vitalicio && !rec.gratuito && ESCOLA_PAGA.test(norm(rec.ofertaNome))) rec.prazoFixoDias = 365;
    else if (vitalicio && (/escola/.test(norm(rec.ofertaNome) + ' ' + norm(rec.produtoNome))
      || (rec.ofertaId && ofertasRegra[rec.ofertaId] && ofertasRegra[rec.ofertaId].regra === 'prazo'))) return '';
    let daGrupo;
    if (rec.ofertaId) daGrupo = gruposDaOferta.has(rec.ofertaId);
    else daGrupo = gruposDoProduto.has(rec.produtoId);
    const s = siglaDe(rec.ofertaId, rec.ofertaNome, rec.produtoNome);
    if (!daGrupo && !SEM_GRUPO_CONTA.has(s)) return '';
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
    const rec = { fonte: 'assinatura', ofertaId: a.ofertaId || '', produtoId: a.produtoId || '', ofertaNome: a.ofertaNome || '', produtoNome: a.produtoNome || '',
      gratuito: a.tipo === 'free' || !(Number(a.faturasPagas) > 0 || a.ultimoPagamento) };
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
        ofertaNome: (oa && oa.ofertaNome) || '', produtoNome: (p && p.nome) || '', gratuito: m.tipo !== 'buyer' };
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
    const rec = { fonte: 'excecao', ofertaId: x.ofertaId || '', produtoId: x.produtoId || '', ofertaNome: x.ofertaNome || '', produtoNome: x.produtoNome || '', gratuito: true };
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

  // Produtos que a Hubla grava como vitalícios (compra única, 10.000 dias), mas
  // que na verdade duram um prazo fixo a partir da compra (decisão do Davi,
  // 13/11/2026: Tudo Sobre Emissões = 1 ano; Escola do Viajante paga gravada
  // como vitalícia = 1 ano).
  for (let i = regs.length - 1; i >= 0; i--) {
    const r = regs[i];
    const dias = r.prazoFixoDias || PRAZO_FIXO_DIAS[r.sigla];
    if (!dias || !r.vitalicio) continue;
    const ini = ms(r.inicio);
    if (!ini) { regs.splice(i, 1); continue; } // sem data de compra não dá para calcular
    const fimMs = ini + dias * 86400000;
    r.vitalicio = false;
    r.fim = new Date(fimMs).toISOString();
    r.ativo = fimMs >= agora;
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
  for (const lista0 of grupos.values()) {
    // DAP/TSE (cursos sem grupo) só dão nome a quem não tem nenhum outro registro:
    // um curso vitalício não pode esconder a data do Clube vencido.
    const comGrupo = lista0.filter(r => !SEM_GRUPO_CONTA.has(r.sigla));
    const lista = comGrupo.length ? comGrupo : lista0;
    const reais = lista.filter(r => r.fonte !== 'excecao');
    const excs = lista.filter(r => r.fonte === 'excecao');
    const ordAtivo = (a, b) => (ms(b.inicio) - ms(a.inicio)) || ((b.vitalicio ? Infinity : ms(b.fim)) - (a.vitalicio ? Infinity : ms(a.fim)));
    const ordFim = (a, b) => ms(b.fim) - ms(a.fim);
    // Balcão e Comunidade dão um grupo só e costumam vir junto com o Clube:
    // ficam atrás de qualquer produto principal (só aparecem no nome de quem
    // não tem outro ativo; entre encerradas, só se acabaram 30+ dias depois).
    const princ = r => !SECUNDARIAS.has(r.sigla);
    const encerradas = lista.filter(r => !r.ativo).sort(ordFim);
    const encP = encerradas.find(princ), encS = encerradas.find(r => !princ(r));
    const escolhido = reais.filter(r => r.ativo && princ(r)).sort(ordAtivo)[0]
      || excs.filter(r => r.ativo && princ(r)).sort(ordAtivo)[0]
      || lista.filter(r => r.ativo).sort(ordAtivo)[0]
      || (encP && encS && ms(encS.fim) - ms(encP.fim) > 30 * 86400000 ? encS : (encP || encS));
    if (!escolhido) continue;
    // Nome: o do registro escolhido; sem nome, o de qualquer outro.
    const nome = nomeProprio((escolhido.nome && !String(escolhido.nome).includes('@') ? escolhido.nome : '')
      || (lista.find(r => r.nome && !String(r.nome).includes('@')) || {}).nome || '');
    const telefones = [...new Set(lista0.flatMap(r => [r.telefone, ...(extrasTel.get(String(r.email || '').toLowerCase().trim()) || [])]).map(soDigitos).filter(t => t.length >= 10))];
    const emails = [...new Set(lista0.flatMap(r => { const e = String(r.email || '').toLowerCase().trim(); return e ? [e, ...(extrasEmail.get(e) || [])] : []; }))];
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
    // Fim do nome que o script troca: um ou mais " SIGLA data" ou " SIGLA VIT"
    // (sigla de 2 a 8 letras, com ou sem "+", para limpar também siglas antigas;
    // data d/m/aa até dd/mm/aaaa, com / . ou -). Ex.: "CDVE 11/8/2026".
    padraoSufixo: '(\\s+[A-Z+]{2,8}\\s+(\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}|VIT))+\\s*$',
    // Nome do contato que não vale como nome (erro de planilha "#REF!", "#N/A",
    // só número de telefone, e-mail): o script troca pelo nome da Hubla.
    // Decisão do Davi (13/11/2026): o nome do contato é sempre o do sistema
    // (Hubla); o script não guarda o nome que estava na agenda.
    usarNomeDoSistema: true,
    padraoNomeInvalido: '^\\s*(#|[+\\d\\s().-]+$|\\S+@\\S+$)',
    ofertasSemSigla: [...semSigla.entries()].map(([oferta, registros]) => ({ oferta, registros })),
    contatos,
  };
}

module.exports = { montarContatos, siglaPorNome, dataCurta, SIGLAS, SIGLAS_CONHECIDAS };
