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
          grupoBalcao } = d;

  // ── Cache dos registros (a auditoria dos grupos lê a cada rodada) ─────────
  let _cache = null;
  async function registros(forcar) {
    if (!forcar && _cache && Date.now() - _cache.em < 2 * 60 * 1000) return _cache.lista;
    const { lista } = await lerLista(REGISTROS);
    _cache = { em: Date.now(), lista };
    return lista;
  }
  const limparCache = () => { _cache = null; };

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

  return { dadosAuditoria, vincular };
}

module.exports = { registrar, cnpjValido, situacaoPorCpf, chaveTel };
