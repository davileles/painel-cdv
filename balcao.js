'use strict';
// ── BALCÃO DO CLUBE DO VIAJANTE — formulário de verificação ────────────────────
// Página pública: painel.clubedoviajante.com.br/balcao/ (balcao/index.html).
// Tudo o que chega aqui é dado pessoal sensível (CPF, documento com foto,
// selfie, comprovante de endereço, chave PIX, termo assinado), então nada vai
// para o painel-cdv (público): registros e arquivos vão para o repo PRIVADO de
// dados (`davileles/dados`):
//   balcao/verificacoes.json              lista de pedidos (sem os arquivos)
//   balcao/arquivos/<id>/<campo>.<ext>    cada documento, em binário
//
// Rotas:
//   POST /balcao/verificacao                       pública (formulário)
//   GET  /balcao/resumo                            pública (só contagens)
//   GET  /balcao/verificacoes                      X-CDV-Op
//   GET  /balcao/arquivo/:id/:campo                X-CDV-Op (devolve o arquivo)
//   POST /balcao/verificacoes/status {id, status, obs}   X-CDV-Op
//   POST /balcao/verificacoes/telefone {id, telefone, remover?}  X-CDV-Op (vínculo manual)
//   POST /balcao/vincular                          X-CDV-Op (refaz os vínculos agora)
//   GET  /balcao/grupo                             X-CDV-Op (quem está no grupo do Balcão)
//   POST /balcao/lista/enviar-codigo {email}       pública (código no e-mail)
//   POST /balcao/lista/verificar-codigo {email, codigo}  pública → token (7 dias)
//   GET  /balcao/lista                             X-CDV-Balcao (token) → nome + telefone
//
// Lista de aprovados (desde 17/11/2026, página balcao/aprovados/): nome e
// telefone de quem tem a verificação APROVADA e, HOJE, direito ao grupo do
// Balcão pela assinatura (mesma regra da auditoria dos grupos: oferta ativa que
// dá o grupo, exceção ou cliente do concierge). Assinatura vencida = sai da lista.
// Só abre com login por código no e-mail, e só para quem está na própria lista
// (e-mail do formulário, do vínculo ou da Hubla nesse telefone) ou é admin. O
// acesso é reconferido a cada leitura: venceu a assinatura, perde a lista.
//
// Grupo do Balcão (desde 17/11/2026): só fica quem tem assinatura que dá o grupo
// E verificação APROVADA. O vínculo pessoa ↔ telefone do WhatsApp sai de:
// telefone/e-mail do formulário, CPF → pagador das faturas da Hubla
// (pagadoresPorDocumento, só em memória), e-mail → telefone da Hubla e
// telefones vinculados à mão no gestor. Nome NÃO vincula sozinho: vira
// sugestão (r.sugestoes) que o Davi aceita/recusa no gestor. dadosAuditoria() entrega os conjuntos de chaves
// (55+DDD+8) para hubla-grupos-auditoria.js; a remoção é a do Tico
// (balcaoExigirVerificacao + esperaVerificacaoH em grupos-remocao.json).
// Registros importados da planilha antiga do Google Forms: origem 'forms', os
// documentos ficam como link do Google Drive (arquivos[campo].link).

const crypto = require('crypto');
const REGISTROS = 'balcao/verificacoes.json';
const PASTA_ARQ = 'balcao/arquivos/';

// campo → tipos aceitos
const ARQUIVOS = {
  documento:   { rotulo: 'Documento com foto (RG ou CNH)', tipos: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] },
  selfie:      { rotulo: 'Selfie com o documento',          tipos: ['image/jpeg', 'image/png', 'image/webp'] },
  comprovante: { rotulo: 'Comprovante de endereço',         tipos: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] },
  instagram:   { rotulo: 'Print do Instagram',              tipos: ['image/jpeg', 'image/png', 'image/webp'] },
  termo:       { rotulo: 'Termo de uso assinado (GOV.BR)',  tipos: ['application/pdf'] },
};
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
const MAX_ARQ_BYTES = 6 * 1024 * 1024;
const STATUS = ['pendente', 'aprovado', 'reprovado'];

function cnpjValido(v) {
  const c = String(v || '').replace(/\D/g, '');
  if (c.length !== 14 || /^(\d)\1+$/.test(c)) return false;
  const calc = (base) => {
    const pesos = base.length === 12 ? [5,4,3,2,9,8,7,6,5,4,3,2] : [6,5,4,3,2,9,8,7,6,5,4,3,2];
    const s = base.split('').reduce((a, d, i) => a + Number(d) * pesos[i], 0);
    const r = s % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const d1 = calc(c.slice(0, 12));
  const d2 = calc(c.slice(0, 12) + d1);
  return c.endsWith(String(d1) + String(d2));
}

function texto(v, max) { return String(v == null ? '' : v).trim().slice(0, max || 200); }
function normNome(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
}
function chaveTel(t) {
  const d = String(t || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) return d.slice(0, 4) + d.slice(-8);
  if (d.length === 10 || d.length === 11) return '55' + d.slice(0, 2) + d.slice(-8);
  return d.length >= 8 ? d : null; // estrangeiro (ex.: +351): mesma chave da auditoria dos grupos
}
const quando = r => String((r && (r.statusEm || r.recebidoEm)) || '');
const tokensNome = s => normNome(s).split(' ').filter(t => t && !['de', 'da', 'do', 'das', 'dos', 'e'].includes(t));

// Situação por pessoa (CPF): a decisão mais recente vale; formulário novo depois
// de uma aprovação não tira a aprovação. Sem decisão + formulário = pendente.
function situacaoPorCpf(lista) {
  const por = new Map();
  for (const r of lista) {
    if (!r || !r.cpf) continue;
    const l = por.get(r.cpf) || []; l.push(r); por.set(r.cpf, l);
  }
  const out = new Map();
  for (const [cpf, regs] of por) {
    const decididos = regs.filter(r => r.status === 'aprovado' || r.status === 'reprovado').sort((a, b) => quando(b).localeCompare(quando(a)));
    let situacao = decididos.length ? decididos[0].status : (regs.some(r => r.status === 'pendente') ? 'pendente' : 'reprovado');
    if (situacao === 'reprovado' && regs.some(r => r.status === 'pendente' && quando(r) > quando(decididos[0] || {}))) situacao = 'pendente';
    out.set(cpf, { situacao, regs });
  }
  return out;
}

function registrar(app, d) {
  const { fetch, GITHUB_TOKEN, REPO, putRetry, lerLista, getArquivoJson, cpfValido, soDigitos,
          nomeApresentavel, limiteIp, opAutorizado, BAILEYS_URL, hublaArquivo, pagadoresPorDocumento,
          grupoBalcao, direitoBalcao, RESEND_API_KEY, adminEmails } = d;

  // ── Cache dos registros (a auditoria dos grupos lê a cada rodada) ─────────
  let _cache = null;
  async function registros(forcar) {
    if (!forcar && _cache && Date.now() - _cache.em < 2 * 60 * 1000) return _cache.lista;
    const { lista } = await lerLista(REGISTROS);
    _cache = { em: Date.now(), lista };
    return lista;
  }
  const limparCache = () => { _cache = null; _aprovados = null; };

  // Telefones de um registro: formulário + vínculo automático + manuais.
  function telefonesDo(r) {
    const s = new Set();
    for (const t of [r.tel, ...(((r.vinculo || {}).telefones) || []), ...(r.telefonesManuais || [])]) { const k = chaveTel(t); if (k) s.add(k); }
    return s;
  }

  // Conjuntos para hubla-grupos-auditoria.js (aprovados e pendentes por chave).
  async function dadosAuditoria() {
    const lista = await registros();
    const aprovados = new Set(), pendentes = new Set();
    for (const { situacao, regs } of situacaoPorCpf(lista).values()) {
      const alvo = situacao === 'aprovado' ? aprovados : situacao === 'pendente' ? pendentes : null;
      if (!alvo) continue;
      for (const r of regs) for (const k of telefonesDo(r)) alvo.add(k);
      // sugestão de vínculo ainda não analisada: não remove ninguém por ela
      for (const r of regs) for (const s of (r.sugestoes || [])) { const k = chaveTel(s.telefone); if (k) pendentes.add(k); }
    }
    for (const k of aprovados) pendentes.delete(k);
    return { aprovados, pendentes };
  }

  // ── Vínculo pessoa ↔ telefone/e-mail ──────────────────────────────────────
  let _pagadores = null; // { em, mapa }
  let _vinculando = null;
  let _retentarFaturas = null;
  async function vincular() {
    if (_vinculando) return _vinculando;
    _vinculando = (async () => {
      let hubla = {};
      try { hubla = (await hublaArquivo()) || {}; } catch (e) { console.warn('[balcao] hubla:', e.message); }
      // Pessoas da Hubla por telefone (para sugestões por nome) e e-mail → telefones.
      const telPorEmail = new Map(), pessoas = new Map();
      const add = (email, tel, nome, produto) => {
        const e = String(email || '').toLowerCase().trim();
        if (e && tel) { const l = telPorEmail.get(e) || new Set(); l.add(String(tel)); telPorEmail.set(e, l); }
        const k = chaveTel(tel);
        if (!k) return;
        const p = pessoas.get(k) || { nome: '', email: '', telefone: String(tel), produtos: new Set(), tokens: [] };
        if (nome && String(nome).length > p.nome.length) { p.nome = String(nome); p.tokens = tokensNome(nome); }
        if (e && !p.email) p.email = e;
        if (produto) p.produtos.add(String(produto));
        pessoas.set(k, p);
      };
      for (const a of Object.values(hubla.assinaturas || {})) add(a.email, a.telefone, a.nome, a.produtoNome);
      for (const p of Object.values(hubla.acessosPorProduto || {})) for (const [e, m] of Object.entries(p.membros || {})) add(e, m.telefone, m.nome, p.nome);
      let faturasFalharam = false;
      if (pagadoresPorDocumento && (!_pagadores || !_pagadores.mapa.size || Date.now() - _pagadores.em > 12 * 3600e3)) {
        try { _pagadores = { em: Date.now(), mapa: await pagadoresPorDocumento() }; }
        catch (e) { faturasFalharam = true; console.warn('[balcao] faturas da Hubla:', e.message); }
      }
      const pag = (_pagadores && _pagadores.mapa) || new Map();
      // Sem as faturas (falha da API), NUNCA desfaz o vínculo por CPF já feito:
      // em 17/11/2026 uma leitura sem faturas apagou 228 vínculos e o Tico tirou
      // verificados do grupo. Tenta de novo em 15 min.
      const semFaturas = !pag.size;
      if (semFaturas && !_retentarFaturas) {
        _retentarFaturas = setTimeout(() => { _retentarFaturas = null; vincular().catch(() => {}); }, 15 * 60 * 1000);
      }
      const calc = (r) => {
        const ant = r.vinculo || {};
        const emails = new Set(), tels = new Set(), fontes = new Set();
        if (r.email) emails.add(String(r.email).toLowerCase());
        if (semFaturas && (ant.fontes || []).includes('cpf')) {
          for (const e of (ant.emails || [])) emails.add(e);
          for (const t of (ant.telefones || [])) tels.add(t);
          fontes.add('cpf');
        }
        for (const p of (pag.get(String(r.cpf || '')) || [])) {
          if (p.email) emails.add(p.email);
          if (p.telefone) tels.add(String(p.telefone));
          fontes.add('cpf');
        }
        for (const e of emails) for (const t of (telPorEmail.get(e) || [])) { tels.add(t); fontes.add('email'); }
        return { emails: [...emails].sort(), telefones: [...tels].sort(), fontes: [...fontes].sort() };
      };
      // Sugestões (desde 17/11/2026): quem continua sem telefone ganha até 3
      // pessoas da Hubla com nome parecido (mesmo 1º nome + mais um nome em comum).
      // Nada é vinculado sozinho: o Davi aceita ou recusa no gestor. Enquanto a
      // sugestão está aberta o telefone conta como "aguardando análise" no grupo
      // do Balcão (não sai).
      const sugerir = (r, usados) => {
        const A = tokensNome(r.nome);
        if (A.length < 2) return [];
        const recusadas = new Set((r.sugestoesRecusadas || []).map(chaveTel));
        const out = [];
        for (const [k, p] of pessoas) {
          if (recusadas.has(k) || usados.has(k) || p.tokens[0] !== A[0]) continue;
          const comum = p.tokens.filter(t => A.includes(t)).length;
          if (comum < 2) continue;
          const pontos = comum + (p.tokens[p.tokens.length - 1] === A[A.length - 1] ? 1 : 0) + (normNome(p.nome) === normNome(r.nome) ? 2 : 0);
          out.push({ nome: p.nome, email: p.email, telefone: p.telefone, produtos: [...p.produtos].sort().slice(0, 4), pontos });
        }
        return out.sort((a, b) => b.pontos - a.pontos).slice(0, 3);
      };
      let mudou = 0;
      await putRetry(REGISTROS, (lista) => {
        mudou = 0;
        for (const r of lista) {
          if (!r) continue;
          const v = calc(r);
          const ant = r.vinculo || {};
          if (!v.telefones.length && (ant.fontes || []).includes('duplicado')) continue; // revisto no passo dos duplicados
          if (JSON.stringify([ant.emails, ant.telefones, ant.fontes]) !== JSON.stringify([v.emails, v.telefones, v.fontes])) {
            r.vinculo = Object.assign(v, { em: new Date().toISOString() });
            mudou++;
          }
        }
        // Mesma pessoa que reenviou o formulário com o CPF digitado errado (desde
        // 17/11/2026): mesmo nome + mesma data de nascimento + CPF diferente em até
        // 2 dígitos (ou CPF inválido) → herda os telefones do registro que já tem vínculo.
        const difCpf = (a, b) => { a = soDigitos(a); b = soDigitos(b); if (a.length !== 11 || b.length !== 11) return 99; let d = 0; for (let i = 0; i < 11; i++) if (a[i] !== b[i]) d++; return d; };
        for (const r of lista) {
          if (!r || telefonesDo(r).size || !r.nascimento) continue;
          const irmao = lista.find(o => o && o !== r && o.nascimento === r.nascimento && normNome(o.nome) === normNome(r.nome) && (difCpf(o.cpf, r.cpf) <= 2 || !cpfValido(r.cpf)) && (o.vinculo && (o.vinculo.telefones || []).length));
          if (!irmao) continue;
          const v = r.vinculo || { emails: [], telefones: [], fontes: [] };
          r.vinculo = { emails: [...new Set([...(v.emails || []), ...(irmao.vinculo.emails || [])])].sort(), telefones: [...new Set([...(v.telefones || []), ...irmao.vinculo.telefones])].sort(), fontes: [...new Set([...(v.fontes || []), 'duplicado'])].sort(), duplicadoDe: irmao.id, em: new Date().toISOString() };
          mudou++;
        }
        // telefones já usados por alguma verificação não viram sugestão de outra
        const usados = new Set();
        for (const r of lista) if (r) for (const k of telefonesDo(r)) usados.add(k);
        for (const r of lista) {
          if (!r) continue;
          const sug = telefonesDo(r).size ? [] : sugerir(r, usados);
          if (JSON.stringify(r.sugestoes || []) !== JSON.stringify(sug)) {
            if (sug.length) r.sugestoes = sug; else delete r.sugestoes;
            mudou++;
          }
        }
        return mudou ? lista : null;
      });
      limparCache();
      const lista = await registros(true);
      const semVinculo = lista.filter(r => r && !telefonesDo(r).size).length;
      const comSugestao = lista.filter(r => r && (r.sugestoes || []).length).length;
      return { ok: true, registros: lista.length, atualizados: mudou, semVinculo, comSugestao, faturasHubla: !semFaturas, faturasFalharam };
    })().finally(() => { _vinculando = null; });
    return _vinculando;
  }
  setTimeout(() => vincular().then(r => console.log('[balcao] vínculos:', JSON.stringify(r))).catch(e => console.warn('[balcao] vínculos:', e.message)), 75 * 1000);
  setInterval(() => vincular().catch(() => {}), 12 * 3600e3);

  const ghHeaders = () => ({
    'Authorization': `token ${GITHUB_TOKEN}`,
    'User-Agent': 'cdv-proxy',
    'Accept': 'application/vnd.github+json',
  });

  async function gravarArquivo(caminho, base64, mensagem) {
    const url = `https://api.github.com/repos/${REPO}/contents/${caminho}`;
    const r = await fetch(url, {
      method: 'PUT',
      headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: mensagem, content: base64 }),
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(e.message || `GitHub PUT ${caminho} falhou (${r.status})`);
    }
  }

  async function avisarGrupo(reg) {
    try {
      let grupo = '';
      try { const { content: cfg } = await getArquivoJson('cfg.json'); grupo = (cfg && cfg.grupoAlertas) || ''; } catch (e) {}
      if (!grupo) return;
      const mensagem = [
        '🛡️ *Nova verificação do Balcão*',
        `👤 ${reg.nome}`,
        reg.reenvio ? '🔁 Reenvio (já havia pedido com este CPF)' : '',
        `🆔 ${reg.id}`,
        '⏳ Prazo de validação: até 5 dias úteis',
      ].filter(Boolean).join('\n');
      await fetch(`${BAILEYS_URL}/enviar`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grupo, mensagem }),
      });
    } catch (e) { console.warn('[balcao] aviso WA falhou:', e.message); }
  }

  // ── POST /balcao/verificacao (pública) ──────────────────────────────────
  app.post('/balcao/verificacao', async (req, res) => {
    try {
      const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
      if (!limiteIp(ip)) return res.status(429).json({ ok: false, erro: 'Muitas tentativas. Tente novamente em uma hora.' });

      const b = req.body || {};
      if (texto(b.website)) return res.json({ ok: true }); // honeypot
      if (b.consentimento !== true) return res.status(400).json({ ok: false, erro: 'É necessário concordar com o termo de consentimento (LGPD) para acessar o Balcão.' });

      const dd = b.dados || {};
      const nome = nomeApresentavel(texto(dd.nome, 140));
      const cpf = soDigitos(dd.cpf);
      const email = texto(dd.email, 160).toLowerCase();
      const tel = soDigitos(dd.tel);
      const nascimento = texto(dd.nascimento, 10);
      const instagram = texto(dd.instagram, 60).replace(/^@+/, '');
      const pixTipo = dd.pixTipo === 'cnpj' ? 'cnpj' : 'cpf';
      const pixChave = soDigitos(dd.pixChave);
      const pixBanco = texto(dd.pixBanco, 80);

      if (nome.split(/\s+/).length < 2) return res.status(400).json({ ok: false, erro: 'Informe o nome completo.' });
      if (!cpfValido(cpf)) return res.status(400).json({ ok: false, erro: 'CPF inválido.' });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(nascimento)) return res.status(400).json({ ok: false, erro: 'Data de nascimento inválida.' });
      const idade = (Date.now() - Date.parse(nascimento + 'T12:00:00-03:00')) / (365.25 * 86400000);
      if (!(idade >= 18 && idade < 110)) return res.status(400).json({ ok: false, erro: 'É preciso ser maior de 18 anos para participar do Balcão.' });
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ ok: false, erro: 'E-mail inválido.' });
      if (tel.length < 10) return res.status(400).json({ ok: false, erro: 'WhatsApp inválido — inclua o DDD.' });
      if (pixTipo === 'cpf') {
        if (pixChave !== cpf) return res.status(400).json({ ok: false, erro: 'A chave PIX do tipo CPF precisa ser o seu próprio CPF.' });
      } else if (!cnpjValido(pixChave)) return res.status(400).json({ ok: false, erro: 'CNPJ da chave PIX inválido.' });
      if (!pixBanco) return res.status(400).json({ ok: false, erro: 'Informe o banco da conta PIX.' });

      // Arquivos
      const arqs = b.arquivos || {};
      const prontos = [];
      for (const campo of Object.keys(ARQUIVOS)) {
        const a = arqs[campo] || {};
        const tipo = String(a.tipo || '');
        const base64 = String(a.base64 || '').replace(/^data:[^,]*,/, '');
        if (!base64) return res.status(400).json({ ok: false, erro: `Envie: ${ARQUIVOS[campo].rotulo}.` });
        if (!ARQUIVOS[campo].tipos.includes(tipo)) return res.status(400).json({ ok: false, erro: `Formato não aceito em: ${ARQUIVOS[campo].rotulo}.` });
        const bytes = Math.floor(base64.length * 3 / 4);
        if (bytes > MAX_ARQ_BYTES) return res.status(413).json({ ok: false, erro: `Arquivo grande demais em: ${ARQUIVOS[campo].rotulo} (máx. 6 MB).` });
        prontos.push({ campo, tipo, base64, bytes, nomeOriginal: texto(a.nome, 120) });
      }

      const id = 'bal-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
      const arquivos = {};
      for (const p of prontos) {
        const caminho = `${PASTA_ARQ}${id}/${p.campo}.${EXT[p.tipo]}`;
        await gravarArquivo(caminho, p.base64, `balcao: ${id} ${p.campo}`);
        arquivos[p.campo] = { caminho, tipo: p.tipo, bytes: p.bytes, nomeOriginal: p.nomeOriginal };
      }

      const reg = {
        id, recebidoEm: new Date().toISOString(), ip, status: 'pendente',
        nome, cpf, nascimento, email, tel, instagram,
        pix: { tipo: pixTipo, chave: pixChave, banco: pixBanco },
        arquivos,
        consentimento: { aceito: true, em: new Date().toISOString(), versao: '2026-11' },
      };
      await putRetry(REGISTROS, (lista) => {
        reg.reenvio = lista.some(x => x && x.cpf === cpf);
        lista.push(reg);
        return lista;
      });
      avisarGrupo(reg); // best-effort
      limparCache();
      setTimeout(() => vincular().catch(() => {}), 5000);
      res.json({ ok: true, id });
    } catch (e) {
      console.error('[balcao/verificacao]', e.message);
      res.status(500).json({ ok: false, erro: 'Não foi possível registrar agora. Tente novamente em instantes.' });
    }
  });

  // ── GET /balcao/verificacoes (operador) ─────────────────────────────────
  app.get('/balcao/verificacoes', async (req, res) => {
    if (!opAutorizado(req, res)) return;
    try {
      const lista = await registros(true);
      const sit = situacaoPorCpf(lista);
      const data = lista.filter(Boolean).map(r => Object.assign({}, r, {
        situacaoPessoa: (sit.get(r.cpf) || {}).situacao || r.status,
        reenvios: ((sit.get(r.cpf) || {}).regs || []).length,
        telefonesChave: [...telefonesDo(r)],
      }));
      const st = texto(req.query.status, 20);
      res.json({ ok: true, data: st ? data.filter(x => x.status === st) : data });
    } catch (e) {
      console.error('[balcao/verificacoes GET]', e.message);
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // ── GET /balcao/arquivo/:id/:campo (operador) ───────────────────────────
  app.get('/balcao/arquivo/:id/:campo', async (req, res) => {
    if (!opAutorizado(req, res)) return;
    try {
      const lista = await registros();
      const reg = lista.find(x => x && x.id === req.params.id);
      const a = reg && reg.arquivos && reg.arquivos[req.params.campo];
      if (!a) return res.status(404).json({ ok: false, erro: 'arquivo não encontrado' });
      const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${a.caminho}`, {
        headers: { ...ghHeaders(), 'Accept': 'application/vnd.github.raw' },
      });
      if (!r.ok) return res.status(502).json({ ok: false, erro: `GitHub ${r.status}` });
      res.setHeader('Content-Type', a.tipo);
      res.setHeader('Cache-Control', 'no-store');
      res.send(await r.buffer());
    } catch (e) {
      console.error('[balcao/arquivo GET]', e.message);
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // ── POST /balcao/verificacoes/status (operador) ─────────────────────────
  app.post('/balcao/verificacoes/status', async (req, res) => {
    if (!opAutorizado(req, res)) return;
    const { id, status } = req.body || {};
    if (!id || !STATUS.includes(status)) return res.status(400).json({ ok: false, erro: 'id e status (pendente|aprovado|reprovado) obrigatórios' });
    try {
      let achou = false;
      await putRetry(REGISTROS, (lista) => {
        const k = lista.findIndex(x => x && x.id === id);
        if (k === -1) return null;
        achou = true;
        lista[k].status = status;
        lista[k].statusEm = new Date().toISOString();
        lista[k].obs = texto(req.body.obs, 1000);
        return lista;
      });
      if (!achou) return res.status(404).json({ ok: false, erro: 'verificação não encontrada' });
      limparCache();
      res.json({ ok: true });
    } catch (e) {
      console.error('[balcao/verificacoes/status]', e.message);
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // ── POST /balcao/verificacoes/telefone (operador): vínculo manual ─────────
  app.post('/balcao/verificacoes/telefone', async (req, res) => {
    if (!opAutorizado(req, res)) return;
    const b = req.body || {};
    const tel = String(b.telefone || '').replace(/\D/g, '');
    if (!b.id || !chaveTel(tel)) return res.status(400).json({ ok: false, erro: 'id e telefone (com DDD) obrigatórios' });
    try {
      let achou = false;
      await putRetry(REGISTROS, (lista) => {
        const r = lista.find(x => x && x.id === b.id);
        if (!r) return null;
        achou = true;
        const atual = (r.telefonesManuais || []).filter(t => chaveTel(t) !== chaveTel(tel));
        r.telefonesManuais = b.remover ? atual : [...atual, tel];
        return lista;
      });
      if (!achou) return res.status(404).json({ ok: false, erro: 'verificação não encontrada' });
      limparCache();
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── POST /balcao/verificacoes/sugestao (operador): aceita ou recusa ───────
  app.post('/balcao/verificacoes/sugestao', async (req, res) => {
    if (!opAutorizado(req, res)) return;
    const b = req.body || {};
    const k = chaveTel(b.telefone);
    if (!b.id || !k) return res.status(400).json({ ok: false, erro: 'id e telefone obrigatórios' });
    try {
      let achou = false;
      await putRetry(REGISTROS, (lista) => {
        const r = lista.find(x => x && x.id === b.id);
        if (!r) return null;
        achou = true;
        const s = (r.sugestoes || []).find(x => chaveTel(x.telefone) === k);
        r.sugestoes = (r.sugestoes || []).filter(x => chaveTel(x.telefone) !== k);
        if (!r.sugestoes.length) delete r.sugestoes;
        if (b.aceitar) {
          r.telefonesManuais = [...(r.telefonesManuais || []).filter(t => chaveTel(t) !== k), String(b.telefone).replace(/\D/g, '')];
          r.vinculoAceito = { telefone: String(b.telefone), nome: s ? s.nome : '', email: s ? s.email : '', em: new Date().toISOString() };
          delete r.sugestoes; // as outras sugestões deixam de valer
        } else {
          r.sugestoesRecusadas = [...new Set([...(r.sugestoesRecusadas || []), String(b.telefone).replace(/\D/g, '')])];
        }
        return lista;
      });
      if (!achou) return res.status(404).json({ ok: false, erro: 'verificação não encontrada' });
      limparCache();
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── POST /balcao/vincular (operador): refaz os vínculos agora ─────────────
  app.post('/balcao/vincular', async (req, res) => {
    if (!opAutorizado(req, res)) return;
    try { res.json(await vincular()); } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  // ── GET /balcao/grupo (operador): situação de quem está no grupo ──────────
  app.get('/balcao/grupo', async (req, res) => {
    if (!opAutorizado(req, res)) return;
    try { res.json(Object.assign({ ok: true }, await grupoBalcao({ forcar: req.query.forcar === '1' }))); }
    catch (e) { res.status(502).json({ ok: false, erro: e.message }); }
  });

  // ── GET /balcao/resumo (pública, só contagens) ────────────────────────────
  app.get('/balcao/resumo', async (req, res) => {
    try {
      const lista = await registros();
      const sit = situacaoPorCpf(lista);
      const cont = { pessoas: sit.size, aprovado: 0, pendente: 0, reprovado: 0, aprovadosSemTelefone: 0, comSugestao: lista.filter(r => r && (r.sugestoes || []).length).length };
      for (const { situacao, regs } of sit.values()) {
        cont[situacao] = (cont[situacao] || 0) + 1;
        if (situacao === 'aprovado' && !regs.some(r => telefonesDo(r).size)) cont.aprovadosSemTelefone++;
      }
      res.json({ ok: true, contagem: cont });
    } catch (e) { res.status(500).json({ ok: false, erro: 'indisponível' }); }
  });

  // ── Lista de aprovados com assinatura em dia ─────────────────────────────
  const LISTA_OTP_TTL = 10 * 60 * 1000, LISTA_OTP_MAX = 5, LISTA_OTP_INTERVALO = 45 * 1000;
  const LISTA_SESSAO_TTL = 7 * 24 * 3600 * 1000;
  const listaOtp = new Map();   // email → { codigo, expira, tentativas, enviadoEm }
  const listaIps = new Map();   // ip → [ts] (máx. 10 pedidos de código por hora)
  setInterval(() => { const a = Date.now(); for (const [k, v] of listaOtp) if (a > v.expira) listaOtp.delete(k); }, 15 * 60 * 1000);
  const segredoLista = () => {
    const base = process.env.MEMBRO_SESSION_SECRET || process.env.CONCIERGE_SESSION_SECRET || GITHUB_TOKEN || '';
    return base ? crypto.createHash('sha256').update('balcao-lista-v1|' + base).digest() : null;
  };
  function assinarLista(email) {
    const s = segredoLista(); if (!s) return null;
    const p = Buffer.from(JSON.stringify({ tipo: 'balcao-lista', email, exp: Date.now() + LISTA_SESSAO_TTL })).toString('base64url');
    return p + '.' + crypto.createHmac('sha256', s).update(p).digest('base64url');
  }
  function emailDaLista(token) {
    const s = segredoLista(); if (!s || !token) return null;
    const [p, a] = String(token).split('.'); if (!p || !a) return null;
    const esp = crypto.createHmac('sha256', s).update(p).digest();
    let rec; try { rec = Buffer.from(a, 'base64url'); } catch (e) { return null; }
    if (rec.length !== esp.length || !crypto.timingSafeEqual(rec, esp)) return null;
    let d2; try { d2 = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); } catch (e) { return null; }
    return d2 && d2.tipo === 'balcao-lista' && d2.email && Number(d2.exp) > Date.now() ? d2.email : null;
  }
  const normEmail = e => String(e || '').toLowerCase().trim();
  const ehAdmin = e => ((adminEmails && adminEmails()) || []).map(normEmail).includes(normEmail(e));
  function telefoneBonito(t) {
    let x = String(t || '').replace(/\D/g, '');
    if (x.startsWith('55') && (x.length === 12 || x.length === 13)) x = x.slice(2);
    if (x.length === 11) return `(${x.slice(0, 2)}) ${x.slice(2, 7)}-${x.slice(7)}`;
    if (x.length === 10) return `(${x.slice(0, 2)}) ${x.slice(2, 6)}-${x.slice(6)}`;
    return x ? '+' + x : '';
  }

  let _aprovados = null; // { em, pessoas, emails }
  async function aprovadosVigentes(forcar) {
    if (!forcar && _aprovados && Date.now() - _aprovados.em < 5 * 60 * 1000) return _aprovados;
    const lista = await registros();
    const base = [];
    for (const { situacao, regs } of situacaoPorCpf(lista).values()) {
      if (situacao !== 'aprovado') continue;
      const ord = regs.slice().sort((a, b) => quando(b).localeCompare(quando(a)));
      const chaves = new Set(), emails = new Set();
      for (const r of regs) {
        for (const k of telefonesDo(r)) chaves.add(k);
        if (r.email) emails.add(normEmail(r.email));
        for (const e of (((r.vinculo || {}).emails) || [])) emails.add(normEmail(e));
      }
      const ref = ord.find(r => r.status === 'aprovado') || ord[0];
      const tel = (ord.find(r => chaveTel(r.tel)) || {}).tel || [...chaves][0] || '';
      base.push({ nome: ref.nome || '', tel, chaves: [...chaves], emails });
    }
    const todas = [...new Set(base.flatMap(p => p.chaves))];
    const direito = await direitoBalcao(todas);
    const pessoas = [], emailsOk = new Set();
    for (const p of base) {
      const vale = p.chaves.filter(k => ['ativo', 'excecao', 'concierge'].includes(((direito.get(k) || {}).situacao)));
      if (!vale.length) continue;
      for (const k of vale) for (const e of ((direito.get(k) || {}).emails || [])) p.emails.add(e);
      for (const e of p.emails) emailsOk.add(e);
      const nome = nomeApresentavel(p.nome);
      pessoas.push({ nome, telefone: telefoneBonito(p.tel), whatsapp: String(p.tel || '').replace(/\D/g, '') });
    }
    // mesmo telefone em dois CPFs (raro): uma linha só
    const vistos = new Set();
    const unicas = pessoas.filter(p => { const k = chaveTel(p.whatsapp) || p.nome; if (vistos.has(k)) return false; vistos.add(k); return true; });
    unicas.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
    _aprovados = { em: Date.now(), pessoas: unicas, emails: emailsOk };
    return _aprovados;
  }

  app.post('/balcao/lista/enviar-codigo', async (req, res) => {
    const email = normEmail((req.body || {}).email);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 200) return res.status(400).json({ ok: false, erro: 'E-mail inválido.' });
    const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    const hist = (listaIps.get(ip) || []).filter(t => Date.now() - t < 3600e3);
    if (hist.length >= 10) return res.status(429).json({ ok: false, erro: 'Muitas tentativas. Tente novamente em uma hora.' });
    hist.push(Date.now()); listaIps.set(ip, hist);
    const ant = listaOtp.get(email);
    if (ant && Date.now() - ant.enviadoEm < LISTA_OTP_INTERVALO) return res.json({ ok: false, motivo: 'aguarde', erro: 'Aguarde alguns segundos para pedir um novo código.' });
    try {
      const { emails } = await aprovadosVigentes();
      if (!emails.has(email) && !ehAdmin(email)) {
        return res.json({ ok: false, motivo: 'sem_acesso', erro: 'Este e-mail não está entre os membros aprovados do Balcão com assinatura em dia. Use o e-mail da sua compra na Hubla.' });
      }
      const codigo = String(crypto.randomInt(100000, 1000000));
      listaOtp.set(email, { codigo, expira: Date.now() + LISTA_OTP_TTL, tentativas: 0, enviadoEm: Date.now() });
      if (!RESEND_API_KEY) { console.log(`[BALCAO-OTP-DEV] ${email} → ${codigo}`); return res.json({ ok: true }); }
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'Clube do Viajante <noreply@clubedoviajante.com.br>',
          to: [email],
          subject: `Seu código do Balcão: ${codigo}`,
          html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#0a0c12;color:#fff;border-radius:12px">
            <h2 style="color:#FF6B5B;margin-bottom:8px">Balcão · Clube do Viajante</h2>
            <p style="color:#aaa;margin-bottom:24px">Use o código abaixo para ver a lista de membros aprovados do Balcão. Ele expira em <strong>10 minutos</strong>.</p>
            <div style="background:#1a1d2e;border-radius:10px;padding:24px;text-align:center;letter-spacing:12px;font-size:32px;font-weight:900;color:#FF6B5B;margin-bottom:24px">${codigo}</div>
            <p style="color:#666;font-size:12px">Se você não solicitou este código, ignore este e-mail.</p></div>`,
        }),
      });
      if (!r.ok) { console.error('[balcao/lista OTP]', await r.text()); listaOtp.delete(email); return res.status(500).json({ ok: false, erro: 'Falha ao enviar o e-mail. Tente de novo.' }); }
      res.json({ ok: true });
    } catch (e) {
      console.error('[balcao/lista/enviar-codigo]', e.message);
      res.status(503).json({ ok: false, erro: 'Lista indisponível agora. Tente novamente em instantes.' });
    }
  });

  app.post('/balcao/lista/verificar-codigo', (req, res) => {
    const email = normEmail((req.body || {}).email);
    const codigo = String((req.body || {}).codigo || '').trim();
    if (!email || !codigo) return res.status(400).json({ ok: false, erro: 'E-mail e código obrigatórios.' });
    const ent = listaOtp.get(email);
    if (!ent || Date.now() > ent.expira) { listaOtp.delete(email); return res.json({ ok: false, erro: 'Código expirado. Peça um novo.' }); }
    if (++ent.tentativas > LISTA_OTP_MAX) { listaOtp.delete(email); return res.json({ ok: false, erro: 'Tentativas demais. Peça um novo código.' }); }
    const a = Buffer.from(codigo), b = Buffer.from(ent.codigo);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.json({ ok: false, erro: 'Código incorreto.' });
    listaOtp.delete(email);
    const token = assinarLista(email);
    if (!token) return res.status(500).json({ ok: false, erro: 'Serviço indisponível.' });
    res.json({ ok: true, token, email });
  });

  app.get('/balcao/lista', async (req, res) => {
    const email = emailDaLista(req.headers['x-cdv-balcao']);
    if (!email) return res.status(401).json({ ok: false, motivo: 'sessao' });
    try {
      const ap = await aprovadosVigentes(req.query.forcar === '1' && ehAdmin(email));
      if (!ap.emails.has(email) && !ehAdmin(email)) return res.status(403).json({ ok: false, motivo: 'sem_acesso', erro: 'Sua assinatura não está em dia ou sua verificação não está aprovada.' });
      res.setHeader('Cache-Control', 'no-store');
      res.json({ ok: true, atualizadoEm: new Date(ap.em).toISOString(), total: ap.pessoas.length,
        membros: ap.pessoas.map(p => ({ nome: p.nome, telefone: p.telefone, whatsapp: p.whatsapp })) });
    } catch (e) {
      console.error('[balcao/lista]', e.message);
      res.status(503).json({ ok: false, erro: 'Lista indisponível agora. Tente novamente em instantes.' });
    }
  });

  return { dadosAuditoria, vincular };
}

module.exports = { registrar, cnpjValido, situacaoPorCpf, chaveTel };
