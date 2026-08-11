// CDV Proxy — redeploy 2026-07-12 env-dev
const express = require('express');
const fetch = require('node-fetch');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO || 'davileles/cdv-compras-bonificadas';

// ── Separação de dados sensíveis ─────────────────────────────────────────────
// Arquivos com dados pessoais devem viver em repositório PRIVADO. O repo de
// código (painel-cdv) precisa continuar público porque serve o GitHub Pages.
// Enquanto GITHUB_REPO_DADOS não estiver definido no Railway, tudo continua
// lendo/escrevendo em GITHUB_REPO — comportamento idêntico ao atual.
const GITHUB_REPO_DADOS = process.env.GITHUB_REPO_DADOS || GITHUB_REPO;
// Dados do Tudo Sobre Promos vivem em repo privado proprio. Regra por PREFIXO
// de path (tsp/...), nao por lista de nomes: qualquer arquivo novo do TSP cai
// no lugar certo sem precisar editar codigo.
const GITHUB_REPO_TSP = process.env.GITHUB_REPO_TSP || 'davileles/cdv-tsp-dados';
// FASE 1 — arquivos tocados APENAS pelo proxy. Migração sem efeito colateral.
const ARQUIVOS_SENSIVEIS = new Set([
  'membros.json',
  'perfis.json',
  'cartoes.json',
  'assinaturas.json',
  'desejos.json'
]);
// NÃO migrar (verificado): 'passagens.json' é catálogo de ofertas
// (cia/origem/destino/pontos) — sem dado pessoal. 'historico.json',
// 'ofertas.json', 'milhas.json', 'lounges-db.json' idem.
//
// PENDENTE: 'alertas.json' contém e-mail de membro. Não migrado porque é lido
// e reescrito por coletar.js via checkout local (git add no coletar-historico.yml).
// Para migrar: trocar os fs.read/writeFileSync de alertas.json no coletar.js por
// chamadas à Contents API do repo de dados, usando um secret com Contents:write,
// e remover o arquivo do 'git add' do workflow.

// Aceita tanto 'membros.json' quanto a variante dev 'membros-dev.json'
function repoDoArquivo(filePath) {
  const base = String(filePath || '').replace(/-dev\.json$/, '.json');
  if (base.startsWith('tsp/')) return GITHUB_REPO_TSP;
  return ARQUIVOS_SENSIVEIS.has(base) ? GITHUB_REPO_DADOS : GITHUB_REPO;
}

const ALLOWED = ['comparemania.com.br', 'passageirodeprimeira.com', 'marketplace-api.web.bancointer.com.br', 'meliuz.com.br', 'topcashback.co.uk', 'topcashback.com'];

// ── Modo DEV ──────────────────────────────────────────────────────────────────
// Requisições com header "x-cdv-env: dev" lêem/escrevem arquivos *-dev.json
// Ex: milhas.json → milhas-dev.json, membros.json → membros-dev.json
// O middleware abaixo injeta req.isDevMode e sobrescreve ghGetJson/ghPutJson
// localmente via res.locals para não afetar o contexto de produção.
function devPath(filePath) {
  return filePath.replace(/\.json$/, '-dev.json');
}
app.use((req, res, next) => {
  res.locals.isDevMode = req.headers['x-cdv-env'] === 'dev';
  next();
});
function ghGetJsonDev(filePath, fallback, devMode) {
  return ghGetJson(devMode ? devPath(filePath) : filePath, fallback);
}
function ghPutJsonDev(filePath, jsonData, sha, message, devMode) {
  const path = devMode ? devPath(filePath) : filePath;
  const msg  = devMode ? `[DEV] ${message}` : message;
  return ghPutJson(path, jsonData, sha, msg);
}

app.use(express.json({ limit: '20mb' }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-TSP-Token, X-CDV-Env');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Health check / warm-up
app.get('/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));

// ══════════════════════════════════════════════════════════════════════════════
// LINKS MASCARADOS / AFILIADO — ir.clubedoviajante.com.br
// ══════════════════════════════════════════════════════════════════════════════
// Redireciona 302 para o destino do programa de fidelidade com os parâmetros de
// afiliado (utm_*) anexados. O mapa vive em links.json — trocar destino/params
// lá NÃO exige redeploy nem reeditar mensagens já enviadas.
//
// Formatos aceitos:
//   https://ir.clubedoviajante.com.br/smiles          → destino padrão do slug
//   .../smiles?o=grupo-emissao                        → registra origem do clique
//   .../smiles?u=<deep link>                          → aplica os params de afiliado
//                                                       em uma URL específica.
//                                                       Só aceita URLs dos domínios
//                                                       declarados no slug (trava
//                                                       contra open redirect).
//   https://cdv-proxy-production.up.railway.app/ir/smiles  (mesma coisa, sem máscara)
//
// Cliques ficam em buffer na memória e são gravados em cliques.json a cada 10min
// — escrever a cada clique geraria 409 de SHA e latência no redirect.
const LINKS_FILE     = 'links.json';
const CLIQUES_FILE   = 'cliques.json';
const LINKS_HOST     = 'ir.clubedoviajante.com.br';
const LINKS_TTL_MS   = 5 * 60 * 1000;
const CLIQUES_FLUSH_MS = 10 * 60 * 1000;
const LINKS_FALLBACK = 'https://davileles.com/clube-do-viajante/';
const PREVIEW_BOT_RE = /whatsapp|facebookexternalhit|telegrambot|twitterbot|slackbot|discordbot|linkedinbot|skypeuripreview|bingbot|googlebot/i;

const RESERVADOS_IR = new Set(['ir', 'ir-stats', 'g', 'gg', 'ping', 'health', 'fetch', 'parceiros', 'bandeiras']);

let linksCache = { data: null, ts: 0 };

async function carregarLinks() {
  if (linksCache.data && (Date.now() - linksCache.ts) < LINKS_TTL_MS) return linksCache.data;
  const { data } = await ghGetJson(LINKS_FILE, {});
  linksCache = { data: (data && typeof data === 'object') ? data : {}, ts: Date.now() };
  return linksCache.data;
}

// Monta a URL final. Se urlAlvo vier preenchida (?u=), valida o domínio contra a
// whitelist do slug antes de anexar os params — sem isso vira open redirect.
function hostPermitido(cfg, host) {
  host = String(host || '').toLowerCase();
  return (cfg.dominios || []).some(function (d) {
    d = String(d).toLowerCase();
    return host === d || host.endsWith('.' + d);
  });
}

// Monta a URL final em tres modos:
//   1. padrao      -> destino fixo do slug
//   2. passthrough -> /<slug>/<resto do path> reconstroi no dominio do programa,
//                     preservando a query original. Ex: /smiles/portal/campanhas/x
//   3. ?u=<url>    -> URL completa, usada quando a campanha vive em outro host
//                     do mesmo programa (ex: latampass.latam.com)
// Em todos, os params de afiliado do links.json sao anexados por ultimo.
function montarDestinoIr(cfg, opts) {
  opts = opts || {};
  let base;
  if (opts.urlAlvo) {
    let u;
    try { u = new URL(String(opts.urlAlvo)); } catch (e) { return null; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (!hostPermitido(cfg, u.hostname)) return null;
    base = u.toString();
  } else if (opts.resto) {
    let origem;
    try { origem = new URL(cfg.destino).origin; } catch (e) { return null; }
    base = origem + (opts.resto.charAt(0) === '/' ? opts.resto : '/' + opts.resto);
  } else {
    base = cfg.destino;
  }
  let final;
  try { final = new URL(base); } catch (e) { return null; }
  // Repassa a query original da campanha, menos os parametros de controle
  if (opts.query) {
    for (const k of Object.keys(opts.query)) {
      if (k === 'o' || k === 'u') continue;
      const v = opts.query[k];
      if (typeof v === 'string') final.searchParams.set(k, v);
    }
  }
  const params = cfg.params || {};
  for (const k of Object.keys(params)) final.searchParams.set(k, params[k]);
  // Defesa em profundidade: nada sai fora dos dominios declarados no slug
  if (!hostPermitido(cfg, final.hostname)) return null;
  return final.toString();
}

// ── Contador de cliques (buffer em memória + flush periódico) ────────────────
const cliquesBuffer = {};
let cliquesDirty = false;

function registrarClique(slug, origem) {
  const b = cliquesBuffer[slug] || (cliquesBuffer[slug] = { total: 0, origens: {} });
  b.total++;
  const o = String(origem || 'direto').slice(0, 40).replace(/[^\w.\-]/g, '') || 'direto';
  b.origens[o] = (b.origens[o] || 0) + 1;
  cliquesDirty = true;
}

async function flushCliques() {
  if (!cliquesDirty) return;
  const pendentes = JSON.parse(JSON.stringify(cliquesBuffer));
  for (const k of Object.keys(cliquesBuffer)) delete cliquesBuffer[k];
  cliquesDirty = false;
  try {
    // SHA sempre fresco, imediatamente antes do PUT
    const { data, sha } = await ghGetJson(CLIQUES_FILE, {});
    const acc = (data && typeof data === 'object') ? data : {};
    const agora = new Date().toISOString();
    for (const slug of Object.keys(pendentes)) {
      const d = pendentes[slug];
      const a = acc[slug] || (acc[slug] = { total: 0, origens: {} });
      a.total = (a.total || 0) + d.total;
      a.origens = a.origens || {};
      for (const o of Object.keys(d.origens)) a.origens[o] = (a.origens[o] || 0) + d.origens[o];
      a.ultimo = agora;
    }
    await ghPutJson(CLIQUES_FILE, acc, sha, 'cliques: flush de redirects /ir');
  } catch (e) {
    console.error('[cliques flush]', e.message);
    // devolve ao buffer para não perder contagem
    for (const slug of Object.keys(pendentes)) {
      const d = pendentes[slug];
      const b = cliquesBuffer[slug] || (cliquesBuffer[slug] = { total: 0, origens: {} });
      b.total += d.total;
      for (const o of Object.keys(d.origens)) b.origens[o] = (b.origens[o] || 0) + d.origens[o];
    }
    cliquesDirty = true;
  }
}

const cliquesTimer = setInterval(flushCliques, CLIQUES_FLUSH_MS);
if (cliquesTimer.unref) cliquesTimer.unref();

// Preview do WhatsApp/Telegram: o bot segue o 302 e mostraria a marca do programa.
// Servimos HTML com OG do Clube do Viajante só para bots; humano continua no 302.
function paginaPreviewIr(destino, cfg) {
  const titulo = 'Clube do Viajante';
  const desc = cfg.programa ? ('Acesse ' + cfg.programa + ' pelo Clube do Viajante') : 'Economize até 90% nas suas passagens';
  const esc = function (s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };
  return '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + esc(titulo) + '</title>' +
    '<meta property="og:title" content="' + esc(titulo) + '">' +
    '<meta property="og:description" content="' + esc(desc) + '">' +
    '<meta property="og:type" content="website">' +
    '<meta name="robots" content="noindex,nofollow">' +
    '<meta http-equiv="refresh" content="0;url=' + esc(destino) + '">' +
    '</head><body><a href="' + esc(destino) + '">Continuar</a>' +
    '<script>location.replace(' + JSON.stringify(destino) + ');</scr' + 'ipt>' +
    '</body></html>';
}

async function handleIr(req, res, slug, resto) {
  let links;
  try { links = await carregarLinks(); } catch (e) { links = linksCache.data || {}; }
  const cfg = links[slug];
  if (!cfg || !cfg.destino) return res.redirect(302, LINKS_FALLBACK);
  const destino = montarDestinoIr(cfg, { urlAlvo: req.query.u, resto: resto, query: req.query });
  if (!destino) return res.status(400).send('Destino inválido para este link.');
  if (PREVIEW_BOT_RE.test(req.headers['user-agent'] || '')) {
    res.set('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(paginaPreviewIr(destino, cfg));
  }
  registrarClique(slug, req.query.o);
  res.set('Cache-Control', 'no-store');
  return res.redirect(302, destino);
}

// Host mascarado: ir.clubedoviajante.com.br/<slug> → mesmo tratamento de /ir/<slug>
app.use(async (req, res, next) => {
  const host = String(req.hostname || '').toLowerCase();
  if (host !== LINKS_HOST) return next();
  if (req.path === '/' || req.path === '') return res.redirect(302, LINKS_FALLBACK);
  const m = req.path.match(/^\/([a-zA-Z0-9\-_]{1,40})(\/.*)?$/);
  if (!m) return next();
  const slug = m[1].toLowerCase();
  const resto = (m[2] && m[2] !== '/') ? m[2] : '';
  // Paths operacionais do proxy continuam funcionando mesmo neste host
  if (RESERVADOS_IR.has(slug)) return next();
  let links;
  try { links = await carregarLinks(); } catch (e) { links = linksCache.data || {}; }
  // Slug desconhecido (typo em mensagem antiga, link cadastrado errado): manda
  // para o site do Clube em vez de devolver 404 do Express na cara do membro.
  if (!links[slug]) return res.redirect(302, LINKS_FALLBACK);
  return handleIr(req, res, slug, resto);
});

app.get(/^\/ir\/([a-zA-Z0-9\-_]{1,40})(\/.*)?$/, (req, res) =>
  handleIr(req, res, String(req.params[0] || '').toLowerCase(), req.params[1] || ''));

// Consulta de métricas (acumulado gravado + buffer ainda não persistido)
app.get('/ir-stats', async (req, res) => {
  try {
    const { data } = await ghGetJson(CLIQUES_FILE, {});
    res.json({ ok: true, gravado: data || {}, buffer: cliquesBuffer });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// Força a gravação imediata do buffer (útil para testar sem esperar 10min)
app.post('/ir-stats/flush', async (req, res) => {
  try { await flushCliques(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});


// ══ DISTRIBUIDOR DE ENTRADAS EM GRUPOS ═══════════════════════════════════════
// Um link (/g/<slug>) que reveza entre varios grupos de WhatsApp. Usado em
// trafego pago: um unico criativo alimenta N grupos sem link manual por grupo.
//
// O clique NUNCA toca GitHub nem Baileys — tudo resolve em memoria. A contagem
// real de membros vem de um worker de fundo; o ponteiro e os cliques sao
// gravados por flush periodico, como o contador do /ir.
const GG_FILE          = 'tsp/grupos-links.json';
const GG_BAILEYS       = process.env.BAILEYS_URL || 'https://baileys-server-production-ebfe.up.railway.app';
const GG_SYNC_MS       = 4 * 60 * 1000;
const GG_FLUSH_MS      = 2 * 60 * 1000;
const GG_LIMITE_PADRAO = 1010;
const GG_TETO_WA       = 1024;   // limite duro de um grupo de WhatsApp

let ggEstado = null;
let ggCarregado = false;
let ggDirty = false;

async function ggCarregar() {
  if (ggCarregado && ggEstado) return ggEstado;
  const { data } = await ghGetJson(GG_FILE, { links: {} });
  ggEstado = (data && typeof data === 'object' && data.links) ? data : { links: {} };
  ggCarregado = true;
  return ggEstado;
}

async function ggSalvar(msg) {
  if (!ggEstado) return;
  const { sha } = await ghGetJson(GG_FILE, { links: {} });   // SHA sempre fresco
  ggEstado.atualizadoEm = new Date().toISOString();
  await ghPutJson(GG_FILE, ggEstado, sha, msg || 'chore: distribuidor de grupos');
  ggDirty = false;
}

// Ocupacao = contagem real da ultima sincronizacao + cliques desde entao.
// Sem esse "entradas", entre duas sincronizacoes de 4 min poderiam entrar
// centenas de pessoas num grupo que ja estava perto do teto.
function ggOcupacao(g) {
  return (g.membros == null ? 0 : g.membros) + (g.entradas || 0);
}

function ggLimite(link) {
  return Math.min(Number(link.limite) || GG_LIMITE_PADRAO, GG_TETO_WA);
}

function ggElegiveis(link) {
  const lim = ggLimite(link);
  return (link.grupos || []).filter(g => g.ativo !== false && g.convite && ggOcupacao(g) < lim);
}

function ggEscolher(link) {
  const eleg = ggElegiveis(link);
  if (!eleg.length) return null;
  if (link.modo === 'sequencial') return eleg[0];            // enche um, depois o proximo
  if (link.modo === 'aleatorio')  return eleg[Math.floor(Math.random() * eleg.length)];
  const p = Number.isFinite(link.ponteiro) ? link.ponteiro : 0;   // rodizio (padrao)
  link.ponteiro = (p + 1) % 1000000;
  return eleg[p % eleg.length];
}

function ggEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Preview do WhatsApp: o bot NAO pode consumir uma vaga do rodizio, senao o
// contador infla so de colar o link. Ele recebe OG estatico; o humano cai no
// mesmo endereco com ?e=1 e passa pelo fluxo normal.
function ggPaginaPreview(link, slug) {
  const titulo = link.ogTitulo || link.nome || 'Entre no grupo';
  const desc   = link.ogDesc   || 'Toque para entrar no grupo do WhatsApp.';
  const destino = '/g/' + encodeURIComponent(slug) + '?e=1';
  return '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + ggEsc(titulo) + '</title>' +
    '<meta property="og:title" content="' + ggEsc(titulo) + '">' +
    '<meta property="og:description" content="' + ggEsc(desc) + '">' +
    (link.ogImagem ? '<meta property="og:image" content="' + ggEsc(link.ogImagem) + '">' : '') +
    '<meta property="og:type" content="website">' +
    '<meta name="robots" content="noindex,nofollow">' +
    '</head><body style="font-family:system-ui;text-align:center;padding:40px">' +
    '<p>Redirecionando…</p><a href="' + ggEsc(destino) + '">Entrar no grupo</a>' +
    '<script>location.replace(' + JSON.stringify(destino) + ');</scr' + 'ipt>' +
    '</body></html>';
}

async function ggHandle(req, res, slug) {
  let est;
  try { est = await ggCarregar(); } catch (e) { est = ggEstado || { links: {} }; }
  const link = est.links[slug];
  if (!link) return res.redirect(302, LINKS_FALLBACK);
  if (link.ativo === false) return res.redirect(302, link.fallback || LINKS_FALLBACK);

  const ua = req.headers['user-agent'] || '';
  if (PREVIEW_BOT_RE.test(ua) && req.query.e !== '1') {
    res.set('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(ggPaginaPreview(link, slug));
  }

  const g = ggEscolher(link);
  // Todos cheios ou sem convite: manda para o fallback do link em vez de 404.
  if (!g) return res.redirect(302, link.fallback || LINKS_FALLBACK);

  g.entradas = (g.entradas || 0) + 1;
  g.cliques  = (g.cliques  || 0) + 1;
  link.cliques = (link.cliques || 0) + 1;
  const origem = String(req.query.o || 'direto').slice(0, 40).replace(/[^\w.\-]/g, '') || 'direto';
  link.origens = link.origens || {};
  link.origens[origem] = (link.origens[origem] || 0) + 1;
  link.ultimoClique = new Date().toISOString();
  ggDirty = true;

  res.set('Cache-Control', 'no-store');
  return res.redirect(302, g.convite);
}

// Pergunta ao Baileys a contagem real de cada grupo e zera a estimativa local.
async function ggSincronizar(slugFiltro) {
  const est = await ggCarregar();
  const jids = new Set();
  for (const [slug, link] of Object.entries(est.links)) {
    if (slugFiltro && slug !== slugFiltro) continue;
    for (const g of (link.grupos || [])) if (g.jid) jids.add(g.jid);
  }
  if (!jids.size) return { ok: true, atualizados: 0 };

  let mapa = {};
  try {
    const url = GG_BAILEYS + '/grupos/info?jids=' + encodeURIComponent([...jids].join(','));
    const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
    const d = await r.json();
    if (!d.ok) return { ok: false, erro: d.erro || 'baileys recusou', atualizados: 0 };
    for (const g of (d.grupos || [])) mapa[g.jid] = g;
  } catch (e) {
    return { ok: false, erro: 'baileys indisponivel: ' + e.message, atualizados: 0 };
  }

  const agora = new Date().toISOString();
  let n = 0;
  for (const [slug, link] of Object.entries(est.links)) {
    if (slugFiltro && slug !== slugFiltro) continue;
    for (const g of (link.grupos || [])) {
      const info = mapa[g.jid];
      if (!info || info.membros == null) { g.erro = (info && info.erro) || 'sem resposta'; continue; }
      g.nome     = info.nome || g.nome;
      g.membros  = info.membros;
      g.entradas = 0;                 // a contagem real ja absorveu quem entrou
      g.souAdmin = info.souAdmin;
      g.sincronizadoEm = agora;
      g.erro = null;
      n++;
    }
  }
  ggDirty = true;
  return { ok: true, atualizados: n };
}

async function ggBuscarConvite(jid, tokenOperador) {
  const r = await fetch(GG_BAILEYS + '/grupos/convite?jid=' + encodeURIComponent(jid),
    { headers: tokenOperador ? { 'X-TSP-Token': tokenOperador } : {},
      signal: AbortSignal.timeout(20000) });
  const d = await r.json();
  if (!d.ok) throw new Error(d.erro || 'falha ao obter convite');
  return d.url;
}

const ggSyncTimer = setInterval(() => {
  ggSincronizar().catch(e => console.error('[gg sync]', e.message));
}, GG_SYNC_MS);
if (ggSyncTimer.unref) ggSyncTimer.unref();

const ggFlushTimer = setInterval(() => {
  if (ggDirty) ggSalvar('chore: distribuidor — flush de cliques').catch(e => console.error('[gg flush]', e.message));
}, GG_FLUSH_MS);
if (ggFlushTimer.unref) ggFlushTimer.unref();

// ── Redirect publico ─────────────────────────────────────────────────────────
// Dominio proprio do TSP: <host>/<slug> sem o /g/, para o link caber no anuncio.
// Aponte um CNAME do subdominio para este servico no Railway.
const GG_HOSTS = new Set(String(process.env.GG_HOSTS ||
  'grupo.tudosobrepromos.com,ir.tudosobrepromos.com')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
const GG_HOME = process.env.GG_HOME || 'https://tudosobrepromos.com/';

app.use(async (req, res, next) => {
  if (!GG_HOSTS.has(String(req.hostname || '').toLowerCase())) return next();
  if (req.path === '/' || req.path === '') return res.redirect(302, GG_HOME);
  const m = req.path.match(/^\/([a-zA-Z0-9\-_]{1,40})$/);
  if (!m) return next();
  const slug = m[1].toLowerCase();
  if (RESERVADOS_IR.has(slug)) return next();   // /ping, /health etc seguem funcionando
  let est;
  try { est = await ggCarregar(); } catch (e) { est = ggEstado || { links: {} }; }
  if (!est.links[slug]) return res.redirect(302, GG_HOME);
  return ggHandle(req, res, slug);
});

app.get(/^\/g\/([a-zA-Z0-9\-_]{1,40})$/, (req, res) =>
  ggHandle(req, res, String(req.params[0] || '').toLowerCase()));

// Base publica que o painel de gestao exibe/copia. Sai do GG_HOSTS para nao
// existir URL hardcoded no front quando o dominio mudar.
function ggBase() {
  const h = [...GG_HOSTS][0];
  return h ? 'https://' + h + '/' : 'https://cdv-proxy-production.up.railway.app/g/';
}

// ── Gestao ───────────────────────────────────────────────────────────────────
app.get('/gg/links', async (req, res) => {
  try {
    const tid = await tenantDaReqGg(req);
    if (!tid) return res.status(401).json({ ok:false, erro:'sessao invalida — faca login novamente' });
    const est = await ggCarregar();
    const links = Object.entries(est.links)
      .filter(([, l]) => (l.tenant || 'tsp') === tid)
      .map(([slug, l]) => ({
      slug,
      nome: l.nome || slug,
      modo: l.modo || 'igual',
      limite: ggLimite(l),
      ativo: l.ativo !== false,
      fallback: l.fallback || '',
      cliques: l.cliques || 0,
      origens: l.origens || {},
      ultimoClique: l.ultimoClique || null,
      criadoEm: l.criadoEm || null,
      disponiveis: ggElegiveis(l).length,
      grupos: (l.grupos || []).map(g => ({
        jid: g.jid, nome: g.nome || null, convite: g.convite || '',
        ativo: g.ativo !== false, membros: g.membros == null ? null : g.membros,
        entradas: g.entradas || 0, ocupacao: ggOcupacao(g), cliques: g.cliques || 0,
        souAdmin: g.souAdmin === undefined ? null : g.souAdmin,
        sincronizadoEm: g.sincronizadoEm || null, erro: g.erro || null,
        cheio: ggOcupacao(g) >= ggLimite(l),
      })),
    })).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
    res.json({ ok: true, total: links.length, links, base: ggBase(), atualizadoEm: est.atualizadoEm || null });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

// Upsert por slug. Grupos novos ganham o convite na hora; os que ja existiam
// preservam contagem, cliques e convite ja obtido.
app.post('/gg/links', async (req, res) => {
  const b = req.body || {};
  const slug = String(b.slug || '').trim().toLowerCase();
  if (!/^[a-z0-9\-_]{1,40}$/.test(slug)) {
    return res.status(400).json({ ok: false, erro: 'slug invalido (use a-z, 0-9, - e _)' });
  }
  if (RESERVADOS_IR.has(slug)) return res.status(400).json({ ok: false, erro: 'slug reservado' });
  try {
    const tid = await tenantDaReqGg(req);
    if (!tid) return res.status(401).json({ ok:false, erro:'sessao invalida — faca login novamente' });
    const est = await ggCarregar();
    // Slug e global (a URL publica /g/<slug> nao tem operador): um operador nao
    // pode assumir o slug de outro.
    if (est.links[slug] && (est.links[slug].tenant || 'tsp') !== tid) {
      return res.status(409).json({ ok:false, erro:'slug ja em uso por outra operacao — escolha outro' });
    }
    const atual = est.links[slug] || { criadoEm: new Date().toISOString(), ponteiro: 0, cliques: 0, origens: {}, tenant: tid };
    atual.tenant = atual.tenant || tid;
    const antigos = new Map((atual.grupos || []).map(g => [g.jid, g]));

    const grupos = [];
    const avisos = [];
    for (const item of (Array.isArray(b.grupos) ? b.grupos : [])) {
      const jid = String(item.jid || '').trim();
      if (!jid.endsWith('@g.us')) continue;
      const velho = antigos.get(jid) || {};
      const g = {
        jid,
        nome: item.nome || velho.nome || null,
        convite: velho.convite || '',
        ativo: item.ativo !== false,
        membros: velho.membros == null ? null : velho.membros,
        entradas: velho.entradas || 0,
        cliques: velho.cliques || 0,
        souAdmin: velho.souAdmin,
        sincronizadoEm: velho.sincronizadoEm || null,
        erro: velho.erro || null,
      };
      if (!g.convite) {
        try { g.convite = await ggBuscarConvite(jid, req.headers['x-tsp-token']); g.erro = null; }
        catch (e) { g.erro = e.message; avisos.push((g.nome || jid) + ': ' + e.message); }
      }
      grupos.push(g);
    }

    est.links[slug] = Object.assign(atual, {
      nome: String(b.nome || atual.nome || slug).slice(0, 80),
      modo: ['igual', 'sequencial', 'aleatorio'].includes(b.modo) ? b.modo : (atual.modo || 'igual'),
      limite: Math.min(Math.max(Number(b.limite) || GG_LIMITE_PADRAO, 1), GG_TETO_WA),
      ativo: b.ativo !== false,
      fallback: String(b.fallback || atual.fallback || '').slice(0, 300),
      ogTitulo: String(b.ogTitulo || atual.ogTitulo || '').slice(0, 120),
      ogDesc: String(b.ogDesc || atual.ogDesc || '').slice(0, 200),
      grupos,
    });

    await ggSincronizar(slug).catch(() => {});
    await ggSalvar('chore: distribuidor — salva link ' + slug);
    res.json({ ok: true, slug, avisos });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.post('/gg/links/excluir', async (req, res) => {
  const slug = String((req.body || {}).slug || '').trim().toLowerCase();
  if (!slug) return res.status(400).json({ ok: false, erro: 'informe slug' });
  try {
    const tid = await tenantDaReqGg(req);
    if (!tid) return res.status(401).json({ ok:false, erro:'sessao invalida — faca login novamente' });
    const est = await ggCarregar();
    if (!est.links[slug] || (est.links[slug].tenant || 'tsp') !== tid) {
      return res.status(404).json({ ok: false, erro: 'slug nao encontrado' });
    }
    delete est.links[slug];
    await ggSalvar('chore: distribuidor — remove link ' + slug);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

// Renova o convite de um grupo (usar quando o link for revogado no WhatsApp)
app.post('/gg/convite', async (req, res) => {
  const b = req.body || {};
  const slug = String(b.slug || '').trim().toLowerCase();
  const jid  = String(b.jid || '').trim();
  try {
    const tid = await tenantDaReqGg(req);
    if (!tid) return res.status(401).json({ ok:false, erro:'sessao invalida — faca login novamente' });
    const est = await ggCarregar();
    const link = est.links[slug];
    if (!link || (link.tenant || 'tsp') !== tid) return res.status(404).json({ ok: false, erro: 'slug nao encontrado' });
    const g = (link.grupos || []).find(x => x.jid === jid);
    if (!g) return res.status(404).json({ ok: false, erro: 'grupo nao esta neste link' });
    const r = await fetch(GG_BAILEYS + '/grupos/convite?refresh=1&jid=' + encodeURIComponent(jid),
      { headers: req.headers['x-tsp-token'] ? { 'X-TSP-Token': req.headers['x-tsp-token'] } : {},
        signal: AbortSignal.timeout(20000) });
    const d = await r.json();
    if (!d.ok) { g.erro = d.erro; ggDirty = true; return res.status(502).json({ ok: false, erro: d.erro }); }
    g.convite = d.url; g.erro = null;
    await ggSalvar('chore: distribuidor — renova convite ' + slug);
    res.json({ ok: true, url: d.url });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.post('/gg/sync', async (req, res) => {
  const slug = String((req.body || {}).slug || '').trim().toLowerCase() || null;
  try {
    const r = await ggSincronizar(slug);
    if (ggDirty) await ggSalvar('chore: distribuidor — sincroniza contagens');
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.post('/gg/flush', async (req, res) => {
  try { await ggSalvar('chore: distribuidor — flush manual'); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});


// ── Gift Cards do Shopping Inter ──────────────────────────────────────────────
// Proxy para a API pública do Inter, que bloqueia IPs de datacenter (GitHub Actions).
// O coletar-inter.js chama este endpoint para contornar o bloqueio por ASN.
app.get('/inter/gift-cards', async (req, res) => {
  const API = 'https://marketplace-api.web.bancointer.com.br/site/giftcard/inter/v1/giftcards/search?lang=pt-BR&category=';
  try {
    const response = await fetch(API, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'application/json, */*',
        'Accept-Language': 'pt-BR,pt;q=0.9',
        'Cache-Control': 'no-cache',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return res.status(response.status).json({ error: `Inter API retornou ${response.status}` });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Cashback Méliuz ───────────────────────────────────────────────────────────
// O Méliuz não expõe API pública de cashback: api-seo.meliuz.com.br responde 403
// (CloudFront bloqueia IPs de datacenter, mesmo caso do Inter). O www responde
// normalmente, e o cashback vem no HTML SSR da página de cada loja.
// Recebe até 20 slugs por chamada e devolve JSON já parseado.
const MELIUZ_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// Quebra do cashback por categoria ("Mostrar cashback por categoria"). Vem no
// mesmo HTML SSR, num <nav> oculto — nenhuma requisicao extra. So existe quando
// a loja tem taxa segmentada (ex: Decolar 20% Seguros / 3% Pacotes / 1% resto).
// O <strong data-main> marca a taxa das "Demais categorias", ou seja, a taxa
// base que vale para o restante do site.
function parseMeliuzCategorias(html) {
  const nav = html.match(/<nav class="hero-sec__cashback-category"[^>]*>([\s\S]*?)<\/nav>/);
  if (!nav) return null;
  const out = [];
  for (const li of (nav[1].match(/<li>[\s\S]*?<\/li>/g) || [])) {
    const mNomeCat = li.match(/<span>([\s\S]*?)<\/span>/);
    const mValCat  = li.match(/<strong([^>]*)>([\s\S]*?)<\/strong>/);
    if (!mNomeCat || !mValCat) continue;
    const pct = (mValCat[2].match(/([0-9]+(?:[.,][0-9]+)?)\s*%/) || [])[1];
    if (!pct) continue;
    out.push({
      categoria: mNomeCat[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim(),
      pts: parseFloat(pct.replace(',', '.')),
      principal: /data-main/.test(mValCat[1]),
    });
  }
  return out.length ? out : null;
}

function parseMeliuz(html, slug) {
  if (!/data-has-cashback="true"/.test(html)) return { slug, temCashback: false, pts: null };

  const mBtn = html.match(/Ativar\s*<span>([^<]+)<\/span>\s*de cashback/i);
  const mOff = html.match(/<strong>\s*\+?\s*([^<]*?)\s*cashback\s*<\/strong>(?:\s*\.\s*era\s*([0-9.,]+)%)?/i);
  const bruto = (mBtn && mBtn[1]) || (mOff && mOff[1]) || '';

  const ate = /at[ée]/i.test(bruto);
  const num = (bruto.match(/([0-9]+(?:[.,][0-9]+)?)\s*%/) || [])[1];
  if (!num) return { slug, temCashback: false, pts: null };

  const mNome = html.match(/<h1>([^<]+)<\/h1>/);
  const mLink = html.match(/data-redirect-url="([^"]+)"/);
  const mPid  = html.match(/partnerId\s*=\s*(\d+)/);
  const cats = parseMeliuzCategorias(html);
  const catPrincipal = cats ? (cats.find(c => c.principal) || null) : null;

  return {
    slug,
    partnerId: mPid ? parseInt(mPid[1], 10) : null,
    temCashback: true,
    pts: parseFloat(num.replace(',', '.')),
    ate,
    era: (mOff && mOff[2]) ? parseFloat(mOff[2].replace(',', '.')) : null,
    // `categorias` e a quebra do SSR; `ptsBase` e a taxa "Demais categorias".
    // Quando existem, `pts` (que pode vir sobreposto pela api-seo) representa a
    // MAIOR categoria, nao a taxa geral da loja.
    categorias: cats,
    ptsBase: catPrincipal ? catPrincipal.pts : null,
    nome: mNome ? mNome[1].trim() : slug,
    // `link` é a página pública da loja — é o que vai para o grupo e para o modal.
    // O data-redirect-url (/redirecionar2/oferta/ID) exige login no Méliuz e por
    // isso não serve como link compartilhável; fica exposto à parte em `linkAtivar`.
    link: 'https://www.meliuz.com.br/desconto/' + slug,
    linkAtivar: (mLink && mLink[1]) || null,
  };
}

// A página SSR mostra a taxa base (ex: Accor 3%), mas o navegador, após a
// hidratação, chama api-seo.meliuz.com.br/partners/cashback-offers e exibe a
// taxa promocional/turbinada (ex: 15%). O token é anônimo — vem de
// www.meliuz.com.br/oauth/client-seo-v2, sem login. O CloudFront do api-seo
// bloqueia parte dos IPs de datacenter, mas o egress do Railway passa.
// Se qualquer etapa falhar, a taxa SSR continua valendo (fallback silencioso).
let meliuzTokenCache = { token: null, expira: 0 };
async function meliuzTokenAnonimo() {
  if (meliuzTokenCache.token && Date.now() < meliuzTokenCache.expira) return meliuzTokenCache.token;
  try {
    const r = await fetch('https://www.meliuz.com.br/oauth/client-seo-v2', {
      headers: { 'User-Agent': MELIUZ_UA, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const tok = j && j.data;
    if (tok) meliuzTokenCache = { token: tok, expira: Date.now() + 30 * 60 * 1000 };
    return tok || null;
  } catch (e) {
    return null;
  }
}

// ── Token de usuário (cashback promocional/turbinado) ─────────────────────────
// O cashback-offers exige token de usuário. O access token (mzsync) dura ~11h,
// então renovamos sozinhos usando o refresh token (mzsync-r), que vive semanas.
// Fluxo espelha o do bundle do Méliuz: POST /oauth/token com grant_type
// refresh_token e client_id do client-seo (sem client_secret). O refresh token
// pode rotacionar a cada uso — guardamos o mais recente em memória para não
// depender de reescrever a env a cada renovação.
//   MELIUZ_MZSYNC   — access token inicial (opcional; serve até o 1º refresh)
//   MELIUZ_MZSYNC_R — refresh token (obrigatório para renovação automática)
let meliuzUserCache = {
  access: (process.env.MELIUZ_MZSYNC || '').trim() || null,
  refresh: (process.env.MELIUZ_MZSYNC_R || '').trim() || null,
  accessExpira: 0, // epoch ms; 0 = desconhecido, força validação pelo exp do JWT
  ultimoRefreshErro: null,
};

function jwtExp(tok) {
  try {
    const p = JSON.parse(Buffer.from(String(tok).split('.')[1], 'base64').toString());
    return p.exp ? p.exp * 1000 : null;
  } catch (e) {
    return null;
  }
}

async function meliuzRenovarAccess() {
  if (!meliuzUserCache.refresh) {
    meliuzUserCache.ultimoRefreshErro = 'sem_refresh_token';
    return null;
  }
  try {
    // Endpoint dedicado do client-seo: /oauth/refresh-token, body só com o
    // refresh_token (sem client_id/secret). Espelha exatamente o fluxo do
    // bundle logado do Méliuz. Resposta em data.accessToken/data.refreshToken,
    // com rotação do refresh (o novo vale ~90 dias).
    const r = await fetch('https://api-seo.meliuz.com.br/oauth/refresh-token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': MELIUZ_UA,
        'Accept': 'application/json',
        'Origin': 'https://www.meliuz.com.br',
        'Referer': 'https://www.meliuz.com.br/',
      },
      body: JSON.stringify({ refresh_token: meliuzUserCache.refresh }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) {
      const corpo = await r.text().catch(() => '');
      meliuzUserCache.ultimoRefreshErro = `http_${r.status}: ${corpo.slice(0, 150)}`;
      return null;
    }
    const j = await r.json();
    const d = j.data || j; // resposta oficial vem em data.*
    const novoAccess  = d.accessToken  || d.access_token;
    const novoRefresh = d.refreshToken || d.refresh_token;
    if (!novoAccess) {
      meliuzUserCache.ultimoRefreshErro = 'resposta_sem_access_token';
      return null;
    }
    meliuzUserCache.access = novoAccess;
    if (novoRefresh) meliuzUserCache.refresh = novoRefresh; // rotação
    const exp = jwtExp(novoAccess);
    meliuzUserCache.accessExpira = exp || (Date.now() + 10 * 60 * 60 * 1000);
    meliuzUserCache.ultimoRefreshErro = null;
    return novoAccess;
  } catch (e) {
    meliuzUserCache.ultimoRefreshErro = 'excecao: ' + e.message;
    return null;
  }
}

// Retorna um access token de usuário válido, renovando se estiver perto de expirar.
async function meliuzTokenUsuario() {
  const MARGEM = 5 * 60 * 1000; // renova 5 min antes de expirar
  const exp = meliuzUserCache.accessExpira || jwtExp(meliuzUserCache.access) || 0;
  if (meliuzUserCache.access && exp && Date.now() < exp - MARGEM) {
    return meliuzUserCache.access;
  }
  // Access ausente ou perto de expirar → tenta renovar via refresh.
  const renovado = await meliuzRenovarAccess();
  if (renovado) return renovado;
  // Refresh falhou: se ainda houver um access não totalmente expirado, usa ele.
  if (meliuzUserCache.access && exp && Date.now() < exp) return meliuzUserCache.access;
  return null;
}

// Decodifica o exp de um JWT sem validar assinatura — só para telemetria.
function jwtExpiraEm(tok) {
  try {
    const p = JSON.parse(Buffer.from(String(tok).split('.')[1], 'base64').toString());
    return p.exp ? new Date(p.exp * 1000).toISOString() : null;
  } catch (e) {
    return null;
  }
}

async function meliuzTaxasAoVivo(out) {
  const ids = out.filter(o => o.partnerId).map(o => o.partnerId);
  if (!ids.length) return { ok: false, status: 'sem_partner_ids' };
  // O cashback-offers exige token de USUÁRIO (cookie mzsync do site logado) —
  // o token anônimo do client-seo retorna 401. O token do usuário vem da env
  // MELIUZ_MZSYNC no Railway; quando expirar, o status abaixo avisa e o
  // comparador segue com a taxa SSR (pública) até o token ser renovado.
  const tokUser = await meliuzTokenUsuario();
  const tok = tokUser || await meliuzTokenAnonimo();
  if (!tok) return { ok: false, status: 'token_falhou', refreshErro: meliuzUserCache.ultimoRefreshErro };
  const fonteToken = tokUser ? 'usuario' : 'anonimo';
  const expiraEm = jwtExpiraEm(tok);
  const r = await fetch(`https://api-seo.meliuz.com.br/partners/cashback-offers?ids=${ids.join(',')}`, {
    headers: {
      'Authorization': `Bearer ${tok}`,
      'User-Agent': MELIUZ_UA,
      'Accept': 'application/json',
      'Origin': 'https://www.meliuz.com.br',
      'Referer': 'https://www.meliuz.com.br/',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) {
    const corpo = await r.text().catch(() => '');
    const status = (r.status === 401 && fonteToken === 'usuario')
      ? 'token_usuario_invalido_ou_expirado'
      : `http_${r.status}`;
    return { ok: false, status, fonteToken, expiraEm, corpo: corpo.slice(0, 200) };
  }
  const j = await r.json();
  const porId = new Map((j.data || []).map(o => [o.partner_id, o]));
  const PCT = new Set(['percent', 'percentage']);
  for (const o of out) {
    const off = o.partnerId && porId.get(o.partnerId);
    if (!off || !PCT.has(off.type)) continue; // taxa em R$ fixo: mantém SSR
    const novo = parseFloat(off.value);
    if (!Number.isFinite(novo) || novo <= 0) continue;
    if (o.pts !== null && novo !== o.pts) o.taxaBase = o.pts; // referência: taxa pública SSR
    o.pts = novo;
    o.temCashback = true;
    o.promocional = !!off.promotional;
    if (off.cashback_category) o.ate = true; // varia por categoria → "até X%"
    if (off.previous && PCT.has(off.previous.type)) o.era = parseFloat(off.previous.value);
  }
  return { ok: true, status: 'ok', fonteToken, expiraEm, recebidos: (j.data || []).length };
}

// Diagnóstico do estado do token de usuário (sem expor os tokens em si).
function meliuzEstadoToken() {
  const expAccess = meliuzUserCache.accessExpira || jwtExp(meliuzUserCache.access) || null;
  const expRefresh = jwtExp(meliuzUserCache.refresh);
  return {
    temAccess: !!meliuzUserCache.access,
    temRefresh: !!meliuzUserCache.refresh,
    accessExpiraEm: expAccess ? new Date(expAccess).toISOString() : null,
    refreshExpiraEm: expRefresh ? new Date(expRefresh).toISOString() : null,
    ultimoRefreshErro: meliuzUserCache.ultimoRefreshErro,
  };
}

app.get('/meliuz/cashback', async (req, res) => {
  const slugs = String(req.query.slugs || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 20);
  if (!slugs.length) return res.status(400).json({ error: 'Parâmetro ?slugs= obrigatório' });

  const CONC = 5;
  const out = [];
  for (let i = 0; i < slugs.length; i += CONC) {
    const lote = await Promise.all(slugs.slice(i, i + CONC).map(async (slug) => {
      try {
        const r = await fetch('https://www.meliuz.com.br/desconto/' + encodeURIComponent(slug), {
          redirect: 'follow',
          headers: {
            'User-Agent': MELIUZ_UA,
            'Accept': 'text/html,application/xhtml+xml',
            'Accept-Language': 'pt-BR,pt;q=0.9',
          },
          signal: AbortSignal.timeout(15000),
        });
        if (!r.ok) return { slug, erro: `HTTP ${r.status}` };
        return parseMeliuz(await r.text(), slug);
      } catch (e) {
        return { slug, erro: e.message };
      }
    }));
    out.push(...lote);
  }

  // Sobrepõe as taxas SSR com as taxas ao vivo (promocionais/turbinadas) da
  // api-seo. `apiLive` indica se o merge funcionou — se false, os valores são
  // apenas os do HTML público.
  let live = { ok: false, status: 'nao_executado' };
  try {
    live = await meliuzTaxasAoVivo(out);
  } catch (e) {
    console.error('[Méliuz] cashback-offers falhou:', e.message);
    live = { ok: false, status: 'excecao', erro: e.message };
  }

  res.json({ geradoEm: new Date().toISOString(), apiLive: live.ok, apiLiveStatus: live, lojas: out });
});

// Diagnóstico do token de usuário do Méliuz — mostra validade do access/refresh
// e o último erro de renovação, sem expor os tokens. Útil para saber quando o
// refresh token (mzsync-r) precisa ser trocado no Railway.
app.get('/meliuz/token-status', (req, res) => {
  res.json(meliuzEstadoToken());
});

// Força uma renovação do access token via refresh — para validar o fluxo sem
// esperar o access expirar. Retorna o estado antes/depois (sem expor tokens).
app.get('/meliuz/token-refresh', async (req, res) => {
  const antes = meliuzEstadoToken().accessExpiraEm;
  const novo = await meliuzRenovarAccess();
  res.json({
    renovou: !!novo,
    accessExpiraAntes: antes,
    accessExpiraDepois: meliuzEstadoToken().accessExpiraEm,
    ultimoRefreshErro: meliuzUserCache.ultimoRefreshErro,
  });
});

// ── Cashback TopCashback (UK e US) ────────────────────────────────────────────
// Mesma abordagem do Méliuz: não há API pública, o cashback vem do HTML SSR da
// página de cada loja. O TopCashback publica uma ou mais faixas por loja
// (categorias de produto / tipo de cliente), então devolvemos todas as faixas e
// o máximo — que é o número usado como pontuação do parceiro no Comparador.
const TCB_BASES = {
  uk: 'https://www.topcashback.co.uk',
  us: 'https://www.topcashback.com',
};

function decodeEntidades(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .trim();
}

function parseTopcashback(html, slug, pais) {
  // Uma loja pode ter VÁRIOS rate cards (ex: ALL Accor UK tem um para membros e
  // outro para novos clientes), cada um com suas faixas. Os tokens aparecem em
  // ordem — title, (sub-cat, rate)* — então varremos mantendo o título corrente
  // como `grupo`, senão as faixas dos dois cards se misturam e viram duplicata.
  const toks = [...html.matchAll(/class="merch-cat__(title|sub-cat|rate)">([\s\S]*?)<\/(?:h2|span)>/g)]
    .map(m => ({ tipo: m[1], valor: decodeEntidades(m[2].replace(/<[^>]+>/g, '')) }));

  const categorias = [];
  let grupo = '';
  let sub = '';
  for (const t of toks) {
    if (t.tipo === 'title') { grupo = t.valor.replace(/\s*Cash\s*back\s*$/i, '').trim(); sub = ''; continue; }
    if (t.tipo === 'sub-cat') { sub = t.valor; continue; }
    const pct = parseFloat(String(t.valor).replace('%', '').replace(',', '.'));
    if (!isFinite(pct) || pct <= 0) { sub = ''; continue; }
    categorias.push({ grupo, nome: sub, pct });
    sub = '';
  }

  if (!categorias.length) return { slug, pais, temCashback: false, pts: null };

  const valores = categorias.map(x => x.pct);
  const pts = Math.max(...valores);
  const distintos = new Set(valores);

  return {
    slug,
    pais,
    temCashback: true,
    pts,
    ate: distintos.size > 1,
    categorias,
    nome: categorias[0]?.grupo || slug,
    link: `${TCB_BASES[pais]}/${slug}/`,
  };
}

app.get('/topcashback/cashback', async (req, res) => {
  const pais = String(req.query.pais || '').toLowerCase();
  const base = TCB_BASES[pais];
  if (!base) return res.status(400).json({ error: "Parâmetro ?pais= deve ser 'uk' ou 'us'" });

  const slugs = String(req.query.slugs || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 10);
  if (!slugs.length) return res.status(400).json({ error: 'Parâmetro ?slugs= obrigatório' });

  const CONC = 3;
  const out = [];
  for (let i = 0; i < slugs.length; i += CONC) {
    const lote = await Promise.all(slugs.slice(i, i + CONC).map(async (slug) => {
      try {
        const r = await fetch(`${base}/${encodeURIComponent(slug)}/`, {
          redirect: 'follow',
          headers: {
            'User-Agent': MELIUZ_UA,
            'Accept': 'text/html,application/xhtml+xml',
            'Accept-Language': pais === 'uk' ? 'en-GB,en;q=0.9' : 'en-US,en;q=0.9',
          },
          signal: AbortSignal.timeout(20000),
        });
        if (!r.ok) return { slug, pais, erro: `HTTP ${r.status}` };
        return parseTopcashback(await r.text(), slug, pais);
      } catch (e) {
        return { slug, pais, erro: e.message };
      }
    }));
    out.push(...lote);
  }
  res.json({ geradoEm: new Date().toISOString(), pais, lojas: out });
});

// ── Fetch para análise de ofertas (sem restrição de domínio) ─────────────────
app.get('/fetch-oferta', async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).json({ error: 'Parâmetro ?url= obrigatório' });
  if (!/^https?:\/\//i.test(target)) return res.status(400).json({ error: 'URL inválida' });

  try {
    const response = await fetch(target, {
      compress: false,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Encoding': 'identity',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.7',
        'Cache-Control': 'no-cache',
        'Upgrade-Insecure-Requests': '1'
      },
      timeout: 20000
    });
    if (!response.ok) return res.status(response.status).json({ error: `Destino retornou ${response.status}` });
    const html = await response.text();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Proxy de fetch (domínios restritos — usado pelo painel público) ───────────
app.get('/fetch', async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).json({ error: 'Parâmetro ?url= obrigatório' });

  const isAllowed = ALLOWED.some(domain => target.includes(domain));
  if (!isAllowed) return res.status(403).json({ error: 'Domínio não permitido' });

  try {
    const response = await fetch(target, {
      compress: false,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Encoding': 'identity',
        'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Upgrade-Insecure-Requests': '1'
      },
      timeout: 15000
    });
    if (!response.ok) return res.status(response.status).json({ error: `Destino retornou ${response.status}` });
    const html = await response.text();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Salvar alerta ─────────────────────────────────────────────────────────────
app.post('/alerta', async (req, res) => {
  const { email, parceiro, programa, minPts } = req.body || {};

  if (!email || !parceiro || !programa || !minPts) {
    return res.status(400).json({ ok: false, erro: 'Campos obrigatórios: email, parceiro, programa, minPts' });
  }
  if (!GITHUB_TOKEN) {
    return res.status(500).json({ ok: false, erro: 'GITHUB_TOKEN não configurado no servidor' });
  }

  try {
    const apiBase = `https://api.github.com/repos/${repoDoArquivo('alertas.json')}/contents/alertas.json`;
    const headers = {
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json'
    };

    const getRes = await fetch(apiBase, { compress: false, headers });
    const getData = await getRes.json();
    const sha = getData.sha;
    const alertas = JSON.parse(Buffer.from(getData.content, 'base64').toString('utf8'));

    const idx = alertas.findIndex(a => a.email === email && a.parceiro === parceiro && a.programa === programa);
    if (idx >= 0) {
      alertas[idx].minPts = minPts;
      alertas[idx].atualizadoEm = new Date().toISOString();
    } else {
      alertas.push({ email, parceiro, programa, minPts, criadoEm: new Date().toISOString() });
    }

    const putRes = await fetch(apiBase, {
      compress: false,
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message: `chore: alerta ${email} → ${parceiro} (${programa} ≥ ${minPts} pts)`,
        content: Buffer.from(JSON.stringify(alertas, null, 2)).toString('base64'),
        sha
      })
    });

    if (putRes.ok) {
      res.json({ ok: true });
    } else {
      const err = await putRes.json();
      res.status(500).json({ ok: false, erro: err.message || 'Falha ao salvar no GitHub' });
    }
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ── Helpers genéricos de leitura/escrita de arquivos JSON no GitHub ───────────
function ghHeaders(nocache = false) {
  const h = {
    'Authorization': `Bearer ${GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'Content-Type': 'application/json'
  };
  if (nocache) {
    h['Cache-Control'] = 'no-cache, no-store';
    h['If-None-Match'] = '';
    h['Pragma'] = 'no-cache';
  }
  return h;
}

async function ghGetJson(filePath, fallback) {
  const apiBase = `https://api.github.com/repos/${repoDoArquivo(filePath)}/contents/${filePath}`;
  const res = await fetch(apiBase, { compress: false, headers: ghHeaders(true) });
  if (res.status === 404) return { data: fallback, sha: null };
  const data = await res.json();
  if (!res.ok) return { data: fallback, sha: null };
  // Arquivo >1MB: GitHub retorna encoding:'none' e content vazio.
  // Buscar via git/blobs pelo SHA, e nao repetindo o GET na Contents API:
  // um segundo GET pode cair numa versao diferente da que forneceu o SHA
  // (passagens.json sofre escrita concorrente), e o PUT seguinte usaria um SHA
  // que nao corresponde ao conteudo lido. O blob e imutavel e casa com o SHA.
  if (data.encoding === 'none' || !data.content) {
    const sha = data.sha || null;
    if (!sha) return { data: fallback, sha: null };
    try {
      const blobUrl = `https://api.github.com/repos/${repoDoArquivo(filePath)}/git/blobs/${sha}`;
      const blobRes = await fetch(blobUrl, { compress: false, headers: ghHeaders(true) });
      if (!blobRes.ok) return { data: fallback, sha };
      const blob = await blobRes.json();
      const parsed = JSON.parse(Buffer.from(blob.content, 'base64').toString('utf8'));
      return { data: parsed, sha };
    } catch (e) {
      console.error(`[ghGetJson blob] ${filePath}:`, e.message);
      return { data: fallback, sha };
    }
  }
  try {
    return { data: JSON.parse(Buffer.from(data.content, 'base64').toString('utf8')), sha: data.sha };
  } catch (e) {
    return { data: fallback, sha: data.sha };
  }
}

async function ghPutJson(filePath, jsonData, sha, message) {
  const apiBase = `https://api.github.com/repos/${repoDoArquivo(filePath)}/contents/${filePath}`;
  const body = {
    message,
    content: Buffer.from(JSON.stringify(jsonData, null, 2)).toString('base64'),
  };
  if (sha) body.sha = sha;
  const res = await fetch(apiBase, { compress: false, method: 'PUT', headers: ghHeaders(), body: JSON.stringify(body) });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `Falha ao salvar ${filePath} no GitHub (status ${res.status})`);
  }
  return res.json();
}

const OFERTAS_PENDENTES_PATH  = 'ofertas-pendentes.json';
const OFERTAS_APROVADAS_PATH  = 'ofertas.json';
const OFERTAS_REJEITADAS_PATH = 'ofertas-rejeitadas.json';
const HISTORICO_TRANSFERENCIAS_PATH = 'historico-transferencias.json';

// ── Histórico de transferências bonificadas ───────────────────────────────────
function normalizarChaveHist(s) {
  return (s || '').toString().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().replace(/\s+/g, '_');
}
function chaveHistorico(origem, destino) {
  return `${normalizarChaveHist(origem)}→${normalizarChaveHist(destino)}`;
}
function prazoParaIso(prazoStr) {
  const m = (prazoStr || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

// Atualiza historico-transferencias.json após aprovação de uma oferta categoria=transferencia.
// Regra de dedup: mesma chave (origem→destino) + mesmo prazo = mesma campanha (reenvio/lembrete),
// só anexa o ofertaId. Prazo diferente (ou ausente) = campanha nova = novo registro.
// Best-effort: falhas aqui nunca devem quebrar o fluxo de aprovação da oferta.
async function atualizarHistoricoTransferencia(item) {
  if (!item || item.categoria !== 'transferencia') return;
  // Ofertas combo / derivadas (ex: "Esfera -> Azul -> ALL Accor") juntam pernas
  // de campanhas distintas: registra-las duplicaria bonus ja gravados pelas
  // ofertas individuais e colaria o % de uma perna no par da outra.
  if (item.semHistorico) return;
  if (!item.origem || !item.destino || item.bonusMax === undefined || item.bonusMax === null || item.bonusMax === '') return;

  const chave = chaveHistorico(item.origem, item.destino);
  const prazoIso = prazoParaIso(item.prazo);
  const dataInicio = (item.publicadoEm ? item.publicadoEm.slice(0, 10) : new Date().toISOString().slice(0, 10));

  const hist = await ghGetJson(HISTORICO_TRANSFERENCIAS_PATH, {
    geradoEm: null,
    descricao: 'Histórico de ofertas de transferência bonificada entre programas.',
    regrasDedup: "Duas ofertas com a mesma chave origem→destino e o MESMO prazo de encerramento são consideradas a mesma campanha e não geram novo registro — apenas anexam o ofertaId ao registro existente.",
    items: [],
  });

  const items = hist.data.items || [];
  const existente = items.find((h) => h.chave === chave && prazoIso && h.prazo === prazoIso);

  if (existente) {
    if (!existente.ofertaIds.includes(item.id)) existente.ofertaIds.push(item.id);
  } else {
    items.unshift({
      chave,
      origem: item.origem,
      destino: item.destino,
      origemTipo: item.origem === 'Todos' ? 'todos' : 'especifica',
      bonusMax: Number(item.bonusMax),
      tipoBonus: 'percentual_direto',
      dataInicio,
      prazo: prazoIso || '',
      ofertaIds: [item.id],
      observacao: '',
    });
  }

  await ghPutJson(
    HISTORICO_TRANSFERENCIAS_PATH,
    { geradoEm: new Date().toISOString(), descricao: hist.data.descricao, regrasDedup: hist.data.regrasDedup, items },
    hist.sha,
    `chore: atualiza historico de transferencias (${chave})`
  );
}
const { normalizarDatas, resumirDatas } = require('./passagens-datas.js');
const { escopoRota } = require('./passagens-escopo.js');

const PASSAGENS_PATH          = 'passagens.json';
const PASSAGENS_INDEX_PATH    = 'passagens-historico-index.json';
const MAX_OFERTAS_APROVADAS   = 100;
const MAX_DIAS_PASSAGENS      = 180;
const MEMBROS_PATH            = 'membros.json';
const MILHAS_PATH             = 'milhas.json';
const CARTOES_PATH            = 'cartoes.json';
const ASSINATURAS_PATH        = 'assinaturas.json';
const PERFIS_PATH             = 'perfis.json';
const HUBLA_TOKEN             = process.env.HUBLA_TOKEN;

// ── Listar ofertas pendentes (com CORS correto) ───────────────────────────────
app.get('/ofertas/pendentes', async (req, res) => {
  try {
    const pend = await ghGetJson(OFERTAS_PENDENTES_PATH, { geradoEm: null, items: [] });
    res.setHeader('Content-Type', 'application/json');
    res.json(pend.data);
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ── Aprovar oferta pendente ───────────────────────────────────────────────────
app.post('/ofertas/aprovar', async (req, res) => {
  const { id, edits } = req.body || {};
  if (!id) return res.status(400).json({ ok: false, erro: 'Campo obrigatório: id' });
  if (!GITHUB_TOKEN) return res.status(500).json({ ok: false, erro: 'GITHUB_TOKEN não configurado no servidor' });

  try {
    const pend = await ghGetJson(OFERTAS_PENDENTES_PATH, { geradoEm: null, items: [] });
    const idx = (pend.data.items || []).findIndex((o) => o.id === id);
    if (idx < 0) return res.status(404).json({ ok: false, erro: 'Oferta não encontrada nas pendentes (pode já ter sido processada)' });

    const item = { ...pend.data.items[idx], ...(edits || {}) };
    pend.data.items.splice(idx, 1);

    const aprov = await ghGetJson(OFERTAS_APROVADAS_PATH, { geradoEm: null, items: [] });
    const jaExiste = (aprov.data.items || []).some((o) => o.id === id);
    const novosAprovados = jaExiste
      ? aprov.data.items
      : [item, ...(aprov.data.items || [])].slice(0, MAX_OFERTAS_APROVADAS);

    await ghPutJson(
      OFERTAS_APROVADAS_PATH,
      { geradoEm: new Date().toISOString(), items: novosAprovados },
      aprov.sha,
      `chore: aprova oferta "${item.titulo || id}"`
    );
    await ghPutJson(
      OFERTAS_PENDENTES_PATH,
      { geradoEm: pend.data.geradoEm || new Date().toISOString(), items: pend.data.items },
      pend.sha,
      `chore: remove oferta aprovada "${item.titulo || id}" das pendentes`
    );

    try {
      await atualizarHistoricoTransferencia(item);
    } catch (errHist) {
      console.error('[Histórico transferências] Falha ao atualizar:', errHist.message);
    }

    // Alertas de oportunidade do concierge (alvo=transferencia).
    // Best-effort: falha aqui nunca deve quebrar a aprovação da oferta.
    try {
      await verificarAlertasTransferencia(item);
    } catch (errAl) {
      console.error('[Alertas concierge] Falha ao verificar transferências:', errAl.message);
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ── Rejeitar oferta pendente ──────────────────────────────────────────────────
app.post('/ofertas/rejeitar', async (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ ok: false, erro: 'Campo obrigatório: id' });
  if (!GITHUB_TOKEN) return res.status(500).json({ ok: false, erro: 'GITHUB_TOKEN não configurado no servidor' });

  try {
    const rej = await ghGetJson(OFERTAS_REJEITADAS_PATH, []);
    const listaRejeitadas = Array.isArray(rej.data) ? rej.data : [];
    if (!listaRejeitadas.includes(id)) listaRejeitadas.push(id);
    await ghPutJson(OFERTAS_REJEITADAS_PATH, listaRejeitadas.slice(-1000), rej.sha, `chore: bloqueia oferta rejeitada ${id}`);

    const pend = await ghGetJson(OFERTAS_PENDENTES_PATH, { geradoEm: null, items: [] });
    const idx = (pend.data.items || []).findIndex((o) => o.id === id);
    if (idx >= 0) {
      pend.data.items.splice(idx, 1);
      await ghPutJson(
        OFERTAS_PENDENTES_PATH,
        { geradoEm: pend.data.geradoEm || new Date().toISOString(), items: pend.data.items },
        pend.sha,
        `chore: remove oferta rejeitada ${id} das pendentes`
      );
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ── Enfileirar oferta no baileys-server para envio via WhatsApp ───────────────
// Proxy para /radar/enviar do baileys-server, mantendo o gerador desacoplado.
const BAILEYS_URL = process.env.BAILEYS_URL || 'https://baileys-server-production-ebfe.up.railway.app';

// ── Alerta operacional para o grupo interno do operador ───────────────────────
// Avisos de infraestrutura (coleta degradada, parser quebrado) — NAO sao ofertas
// e por isso nao passam pela filaRadar: vao diretos, no mesmo grupo onde caem os
// avisos de "Novo cupom capturado".
app.post('/alertas/operador', async (req, res) => {
  const { mensagem } = req.body || {};
  if (!mensagem || !String(mensagem).trim()) {
    return res.status(400).json({ ok: false, erro: 'Campo mensagem obrigatório.' });
  }
  try {
    const r = await fetch(BAILEYS_URL + '/enviar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grupo: 'operador', mensagem, direto: true }),
      signal: AbortSignal.timeout(25000),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.ok === false) {
      return res.status(502).json({ ok: false, erro: d.erro || d.error || `status ${r.status}` });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ ok: false, erro: e.message });
  }
});

app.post('/ofertas/enviar', async (req, res) => {
  const { id, mensagem, grupo } = req.body || {};
  if (!mensagem?.trim()) return res.status(400).json({ ok: false, erro: 'mensagem obrigatória' });
  try {
    const r = await fetch(BAILEYS_URL + '/radar/enviar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, mensagem, grupo: grupo || 'cdv_ofertas' }),
    });
    const d = await r.json();
    res.status(r.status).json(d);
  } catch(err) {
    res.status(502).json({ ok: false, erro: 'Baileys inacessível: ' + err.message });
  }
});

// ── Publicar oferta diretamente no radar ──────────────────────────────────────
app.post('/ofertas/publicar', async (req, res) => {
  const oferta = req.body || {};
  if (!oferta.titulo) return res.status(400).json({ ok: false, erro: 'Campo obrigatório: titulo' });
  if (!GITHUB_TOKEN) return res.status(500).json({ ok: false, erro: 'GITHUB_TOKEN não configurado no servidor' });

  try {
    const raw = (oferta.titulo || '') + Date.now();
    let hash = 0;
    for (let i = 0; i < raw.length; i++) hash = (hash * 31 + raw.charCodeAt(i)) >>> 0;
    const id = hash.toString(36);

    const item = {
      id,
      titulo:            oferta.titulo || '',
      emoji:             oferta.emoji  || '📰',
      resumo:            oferta.resumo || oferta.descricao || '',
      programa:          oferta.programa || '',
      bonus:             oferta.bonus || '',
      prazo:             oferta.prazo || '',
      categoria:         oferta.categoria || 'geral',
      loja:              oferta.loja || '',
      cupom:             oferta.cupom || '',
      milheiro:          oferta.milheiro || '',
      tetoTransferencia: oferta.tetoTransferencia || '',
      importante:        oferta.importante || '',
      link:              oferta.link || '',
      restricoes:        Array.isArray(oferta.restricoes) ? oferta.restricoes : [],
      publicadoEm:       new Date().toISOString(),
    };

    const aprov = await ghGetJson(OFERTAS_APROVADAS_PATH, { geradoEm: null, items: [] });
    const jaExiste = (aprov.data.items || []).some(o => o.id === id);
    const novosItens = jaExiste
      ? aprov.data.items
      : [item, ...(aprov.data.items || [])].slice(0, 100);

    await ghPutJson(
      OFERTAS_APROVADAS_PATH,
      { geradoEm: new Date().toISOString(), items: novosItens },
      aprov.sha,
      `chore: publica oferta "${item.titulo}"`
    );

    res.json({ ok: true, id });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ── Registrar passagem enviada ────────────────────────────────────────────────
// Chamado pelo gerador após envio bem-sucedido via Baileys (aba Emissão e Alertas)
// Body: { origem, destino, cia, programa, pontos, cabine, datas_ida, datas_volta, fonte }
// ── NORMALIZAÇÃO DE NOME DE CIA (siglas e variações → nome canônico) ──────────
// Espelha ALIAS_CIA de baileys-server/server.js. Mantém a grupoKey do histórico
// 180d consistente entre alertas (radar) e emissões manuais (gerador-cdv).
const ALIAS_CIA = {
  'saa':'South African', 'sa':'South African', 'south african airways':'South African', 'south african':'South African',
  'gol':'GOL', 'gol linhas aereas':'GOL', 'g3':'GOL', 'voegol':'GOL',
  'azul':'Azul', 'azul linhas aereas':'Azul', 'ad':'Azul', 'voeazul':'Azul',
  'latam':'LATAM', 'latam airlines':'LATAM', 'tam':'LATAM', 'la':'LATAM',
  'aa':'American Airlines', 'american':'American Airlines', 'american airlines':'American Airlines',
  'tap':'TAP', 'tap air portugal':'TAP', 'tp':'TAP',
  'af':'Air France', 'air france':'Air France', 'airfrance':'Air France',
  'kl':'KLM', 'klm':'KLM', 'klm royal dutch airlines':'KLM',
  'ba':'British Airways', 'british':'British Airways', 'british airways':'British Airways',
  'ib':'Iberia', 'iberia':'Iberia', 'iberia express':'Iberia',
  'cm':'COPA', 'copa':'COPA', 'copa airlines':'COPA',
  'ua':'United', 'united':'United', 'united airlines':'United',
  'dl':'Delta', 'delta':'Delta', 'delta air lines':'Delta',
  'tk':'Turkish', 'turkish':'Turkish', 'turkish airlines':'Turkish',
  'qr':'Qatar Airways', 'qatar':'Qatar Airways', 'qatar airways':'Qatar Airways',
  'ek':'Emirates', 'emirates':'Emirates',
  'ay':'Finnair', 'finnair':'Finnair',
  'lh':'Lufthansa', 'lufthansa':'Lufthansa',
  'ux':'Air Europa', 'air europa':'Air Europa',
  'ar':'Aerolineas Argentinas', 'aerolineas':'Aerolineas Argentinas', 'aerolineas argentinas':'Aerolineas Argentinas',
  'av':'Avianca', 'avianca':'Avianca',
  'et':'Ethiopian', 'ethiopian':'Ethiopian', 'ethiopian airlines':'Ethiopian',
  'ac':'Air Canada', 'air canada':'Air Canada',
  'sq':'Singapore Airlines', 'singapore':'Singapore Airlines', 'singapore airlines':'Singapore Airlines',
  'a3':'Aegean', 'aegean':'Aegean', 'aegean airlines':'Aegean',
  'vs':'Virgin Atlantic', 'virgin atlantic':'Virgin Atlantic',
};

function normalizarCia(cia) {
  const bruto = String(cia == null ? '' : cia).trim();
  if (!bruto) return bruto;
  const chave = bruto
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[.]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return ALIAS_CIA[chave] || bruto;
}

// fonte: 'emissao' | 'alerta'
app.post('/passagens/registrar', async (req, res) => {
  // apenasConsulta: true → calcula e devolve hist180 SEM gravar em passagens.json.
  // Usado pelo baileys-server para montar o rodapé de histórico da mensagem
  // enquanto a emissão ainda está pendente de aprovação.
  const { origem, destino, cia, programa, pontos, cabine, datas_ida, datas_volta, fonte, apenasConsulta } = req.body || {};

  if (!origem || !destino || !programa || !pontos) {
    return res.status(400).json({ ok: false, erro: 'Campos obrigatórios: origem, destino, programa, pontos' });
  }
  if (!GITHUB_TOKEN) {
    return res.status(500).json({ ok: false, erro: 'GITHUB_TOKEN não configurado no servidor' });
  }

  try {
    // Gera ID estável baseado na rota + programa + pontos + timestamp
    const raw = `${origem}-${destino}-${programa}-${pontos}-${Date.now()}`;
    let hash = 0;
    for (let i = 0; i < raw.length; i++) hash = (hash * 31 + raw.charCodeAt(i)) >>> 0;
    const id = hash.toString(36);

    const agora = new Date().toISOString();

    const novaPassagem = {
      id,
      origem:      origem.trim(),
      destino:     destino.trim(),
      cia:         normalizarCia(cia),
      programa:    programa.trim(),
      pontos:      Number(pontos),
      cabine:      (cabine || '').trim(),
      datas_ida:   (datas_ida || '').trim(),
      datas_volta: (datas_volta || '').trim(),
      fonte:       fonte || 'emissao',
      enviadoEm:   agora,
    };

    // Lê passagens existentes
    const atual = await ghGetJson(PASSAGENS_PATH, { items: [] });
    let items = Array.isArray(atual.data.items) ? atual.data.items : [];

    // NAO deletar aqui. A rotacao para os shards semestrais
    // (passagens-historico-{ANO}-S{1|2}.json) e feita por arquivar-passagens.js,
    // que grava o shard ANTES de remover da janela quente. Filtrar por data neste
    // ponto ja causou perda silenciosa do backfill historico da planilha.

    // Calcula stats de histórico 180 dias ANTES de inserir a nova entrada
    // Chave de agrupamento: origem|destino|programa|cabine (igual ao painel)
    const grupoKey = `${(novaPassagem.origem).toLowerCase()}|${(novaPassagem.destino).toLowerCase()}|${(novaPassagem.programa).toLowerCase()}|${(novaPassagem.cabine).toLowerCase()}|${(novaPassagem.cia).toLowerCase()}`;
    const corteMs180 = Date.now() - 180 * 24 * 60 * 60 * 1000;
    const hist180 = items.filter(p =>
      `${(p.origem||'').toLowerCase()}|${(p.destino||'').toLowerCase()}|${(p.programa||'').toLowerCase()}|${(p.cabine||'').toLowerCase()}|${(p.cia||'').toLowerCase()}` === grupoKey &&
      new Date(p.enviadoEm).getTime() >= corteMs180 &&
      p.pontos > 0
    );

    let hist180Stats = null;
    if (hist180.length >= 1) {
      const pontosArr = hist180.map(h => h.pontos);
      const minPts    = Math.min(...pontosArr);
      const mediaPts  = Math.round(pontosArr.reduce((a, b) => a + b, 0) / pontosArr.length);
      const isMin     = Number(pontos) <= minPts;
      hist180Stats = { minPts, mediaPts, count: hist180.length, isMin };
    }

    if (apenasConsulta) {
      return res.json({ ok: true, id: null, apenasConsulta: true, hist180: hist180Stats, ida: resumirDatas(datas_ida, agora) });
    }

    // Adiciona nova passagem no início
    items.unshift(novaPassagem);

    await ghPutJson(
      PASSAGENS_PATH,
      { atualizadoEm: agora, items },
      atual.sha,
      `chore: registra passagem ${origem} → ${destino} (${programa} ${pontos} pts)`
    );

    // Antecedencia calculada na hora e devolvida ao gerador. NAO e persistida:
    // gravar as datas normalizadas triplicaria passagens.json (1,17 -> 3,48 MB)
    // e o valor e 100% derivavel de datas_ida via normalizarDatas().
    res.json({ ok: true, id, hist180: hist180Stats, ida: resumirDatas(datas_ida, agora) });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ── Listar passagens (para consulta do gerador) ───────────────────────────────
app.get('/passagens/listar', async (req, res) => {
  try {
    const todos = req.query.todos === '1' || req.query.todos === 'true';
    const desde = (req.query.desde || '').trim();   // YYYY-MM-DD

    const atual = await ghGetJson(PASSAGENS_PATH, { items: [] });
    let items = Array.isArray(atual.data.items) ? atual.data.items : [];

    // Sem parametro: comportamento historico preservado (janela de 180 dias).
    // Painel, mapa de emissoes e gerador seguem recebendo exatamente o mesmo payload.
    if (!todos && !desde) {
      const corteMs = Date.now() - MAX_DIAS_PASSAGENS * 24 * 60 * 60 * 1000;
      items = items.filter(p => new Date(p.enviadoEm).getTime() >= corteMs);
      res.setHeader('Content-Type', 'application/json');
      return res.json({ atualizadoEm: atual.data.atualizadoEm || null, items });
    }

    // Com ?todos=1 ou ?desde=YYYY-MM-DD: agrega os shards semestrais do historico.
    const idx = await ghGetJson(PASSAGENS_INDEX_PATH, { shards: [] });
    const shards = Array.isArray(idx.data.shards) ? idx.data.shards : [];
    const relevantes = desde
      ? shards.filter(s => !s.ate || s.ate >= desde)
      : shards;

    for (const s of relevantes) {
      try {
        const sh = await ghGetJson(s.arquivo, { items: [] });
        if (Array.isArray(sh.data.items)) items = items.concat(sh.data.items);
      } catch (e) {
        console.warn(`[passagens/listar] shard ${s.arquivo} indisponivel: ${e.message}`);
      }
    }

    if (desde) items = items.filter(p => String(p.enviadoEm).slice(0, 10) >= desde);
    items.sort((a, b) => String(b.enviadoEm).localeCompare(String(a.enviadoEm)));

    res.setHeader('Content-Type', 'application/json');
    res.json({ atualizadoEm: atual.data.atualizadoEm || null, total: items.length, items });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ── Comportamento de disponibilidade ──────────────────────────────────────────
// Perfil de antecedencia (dias entre a busca e a data do voo).
// Base: passagens.json + shards semestrais do historico.
//
// GET /passagens/comportamento
//   ?origem= &destino= &programa= &cia= &cabine=   filtros (todos opcionais)
//   ?escopo=nacional|internacional  (se omitido, deduzido de origem+destino)
//   ?antecedencia=N    classifica uma oferta especifica dentro de cada nivel
//   ?precisao=dia      (default) descarta registros com granularidade so de mes
//   ?desde=YYYY-MM-DD  limita a janela historica
//
// Devolve TODOS os niveis aplicaveis com amostra suficiente, do mais especifico
// ao mais amplo — a rota exata e a combinacao cia+programa+cabine+escopo contam
// historias diferentes e as duas interessam na hora de aprovar um alerta.

const COMPORTAMENTO_TTL_MS = 30 * 60 * 1000;
let ROTULOS = new Map();

// Devolve a grafia mais frequente para uma chave normalizada ("latam pass" -> "LATAM Pass")
function rotuloDe(chave) {
  const m = ROTULOS.get(chave);
  if (!m || !m.size) return chave;
  let melhor = null, freq = -1;
  for (const [txt, n] of m) if (n > freq) { melhor = txt; freq = n; }
  return melhor;
}
let comportamentoCache = { pontos: null, ts: 0 };

const MIN_REGISTROS = 5;    // snapshots distintos
const MIN_PONTOS    = 60;   // pares (registro x data disponivel)

// Sufixos comerciais que nao distinguem operador: "Turkish" e "Turkish Airlines"
// sao a mesma companhia e precisam cair no mesmo grupo, senao a mesma rota
// aparece duas vezes na analise com amostras partidas ao meio.
const SUFIXOS_CIA = /\s+(airways|airlines|air lines|linhas aereas|aereas|airline)$/;

function chaveTexto(v) {
  return String(v == null ? '' : v)
    .toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
}

// Chave especifica de companhia: normaliza e remove sufixo comercial.
function chaveCia(v) {
  return chaveTexto(v).replace(SUFIXOS_CIA, '').trim();
}

// Carrega a base inteira (quente + shards) e converte em pontos de antecedencia.
async function carregarPontosComportamento() {
  if (comportamentoCache.pontos && (Date.now() - comportamentoCache.ts) < COMPORTAMENTO_TTL_MS) {
    return comportamentoCache.pontos;
  }

  const arquivos = [PASSAGENS_PATH];
  try {
    const idx = await ghGetJson(PASSAGENS_INDEX_PATH, { shards: [] });
    for (const s of (idx.data.shards || [])) if (s.arquivo) arquivos.push(s.arquivo);
  } catch (e) {
    console.warn(`[comportamento] index indisponivel: ${e.message}`);
  }

  const pontos = [];
  const brutos = [];
  // grafia canonica para exibicao (a chave e normalizada; a UI mostra o original)
  const rotulos = new Map();
  // variante para cia: agrupa por chaveCia mas guarda a grafia original
  const registrarRotuloCia = (valor) => {
    const k = chaveCia(valor);
    if (!k) return k;
    if (!rotulos.get(k)) rotulos.set(k, new Map());
    const m = rotulos.get(k);
    m.set(valor, (m.get(valor) || 0) + 1);
    return k;
  };

  const registrarRotulo = (valor) => {
    const k = chaveTexto(valor);
    if (!k) return k;
    const atual = rotulos.get(k);
    if (!atual) rotulos.set(k, new Map());
    const m = rotulos.get(k);
    m.set(valor, (m.get(valor) || 0) + 1);
    return k;
  };

  for (const arq of arquivos) {
    let dados;
    try {
      dados = await ghGetJson(arq, { items: [] });
    } catch (e) {
      console.warn(`[comportamento] ${arq} indisponivel: ${e.message}`);
      continue;
    }
    for (const p of (dados.data.items || [])) brutos.push(p);
  }

  // ── Deduplicacao de observacoes repetidas ────────────────────────────────
  // O radar roda varias vezes por dia e re-registra a mesma oferta a cada
  // execucao (ate 4x no mesmo dia). Sao observacoes genuinas, mas para a
  // estatistica cada oferta deve pesar uma vez: senao uma oferta que sobrevive
  // o dia inteiro conta varias vezes e a distribuicao pende para ofertas
  // duradouras. Mantem-se a PRIMEIRA ocorrencia do dia, que e a que responde
  // "quando essa disponibilidade apareceu".
  // Os registros originais seguem intactos no arquivo — isto e so leitura.
  brutos.sort((a, b) => String(a.enviadoEm).localeCompare(String(b.enviadoEm)));
  const vistos = new Set();
  const unicos = [];
  for (const p of brutos) {
    const k = [
      chaveTexto(p.origem), chaveTexto(p.destino), chaveTexto(p.programa),
      chaveCia(p.cia), chaveTexto(p.cabine), p.pontos, String(p.enviadoEm).slice(0, 10),
    ].join('|');
    if (vistos.has(k)) continue;
    vistos.add(k);
    unicos.push(p);
  }
  const repetidos = brutos.length - unicos.length;

  for (const p of unicos) {
    const r = normalizarDatas(p.datas_ida, p.enviadoEm);
    if (r.status !== 'ok') continue;
    const ref = new Date(String(p.enviadoEm).slice(0, 10));
    if (!Number.isFinite(ref.getTime())) continue;
    const registro = {
      origem: chaveTexto(p.origem),
      destino: chaveTexto(p.destino),
      programa: registrarRotulo(p.programa),
      cia: registrarRotuloCia(p.cia),
      cabine: registrarRotulo(p.cabine),
      escopo: escopoRota(p.origem, p.destino),
      snap: String(p.enviadoEm).slice(0, 10),
      precisao: r.precisao,
    };
    for (const d of r.datas) {
      const ant = Math.round((new Date(d) - ref) / 86400000);
      if (ant >= 0 && ant <= 800) pontos.push({ ...registro, ant });
    }
  }

  comportamentoCache = { pontos, ts: Date.now() };
  ROTULOS = rotulos;
  console.log(`[comportamento] base carregada: ${pontos.length} pontos | ${unicos.length} registros unicos (${repetidos} observacoes repetidas descartadas) de ${arquivos.length} arquivo(s)`);
  return pontos;
}

function percentil(ordenado, q) {
  if (!ordenado.length) return null;
  const i = Math.min(ordenado.length - 1, Math.max(0, Math.floor(ordenado.length * q)));
  return ordenado[i];
}

function estatisticas(valores) {
  const v = [...valores].sort((a, b) => a - b);
  const n = v.length;
  return {
    pontos: n,
    min: v[0],
    p10: percentil(v, 0.10),
    p25: percentil(v, 0.25),
    mediana: percentil(v, 0.50),
    p75: percentil(v, 0.75),
    p90: percentil(v, 0.90),
    max: v[n - 1],
    media: Math.round(v.reduce((a, b) => a + b, 0) / n),
  };
}

function classificar(valores, alvo) {
  if (!Number.isFinite(alvo)) return null;
  const abaixo = valores.filter(v => v < alvo).length;
  const pct = Math.round(100 * abaixo / valores.length);
  let leitura;
  if (pct <= 10)      leitura = 'muito abaixo do usual — janela curta e atipica';
  else if (pct <= 25) leitura = 'abaixo do usual';
  else if (pct <= 75) leitura = 'dentro do padrao';
  else if (pct <= 90) leitura = 'acima do usual';
  else                leitura = 'muito acima do usual — liberacao antecipada atipica';
  return { antecedencia: alvo, percentil: pct, leitura };
}

// Niveis de agregacao, do mais especifico ao mais amplo.
// Um nivel so e avaliado se TODOS os campos que ele usa foram informados.
const NIVEIS_COMPORTAMENTO = [
  { nome: 'rota_completa',             campos: ['origem', 'destino', 'programa', 'cia', 'cabine'] },
  { nome: 'rota_programa_cabine',      campos: ['origem', 'destino', 'programa', 'cabine'] },
  { nome: 'rota_programa',             campos: ['origem', 'destino', 'programa'] },
  { nome: 'rota',                      campos: ['origem', 'destino'] },
  // Combinacoes cia + programa + cabine dentro do escopo (nacional/internacional):
  // "todo voo Azul emitido em Azul Fidelidade, internacional, executiva"
  { nome: 'cia_programa_cabine_escopo', campos: ['cia', 'programa', 'cabine', 'escopo'] },
  { nome: 'cia_programa_escopo',        campos: ['cia', 'programa', 'escopo'] },
  { nome: 'programa_cabine_escopo',     campos: ['programa', 'cabine', 'escopo'] },
  { nome: 'cia_cabine_escopo',          campos: ['cia', 'cabine', 'escopo'] },
  { nome: 'programa_escopo',            campos: ['programa', 'escopo'] },
  { nome: 'programa_cabine',            campos: ['programa', 'cabine'] },
  { nome: 'programa',                   campos: ['programa'] },
  { nome: 'escopo_cabine',              campos: ['escopo', 'cabine'] },
  { nome: 'geral',                      campos: [] },
];

app.get('/passagens/comportamento', async (req, res) => {
  try {
    const f = {
      origem: chaveTexto(req.query.origem),
      destino: chaveTexto(req.query.destino),
      programa: chaveTexto(req.query.programa),
      cia: chaveCia(req.query.cia),
      cabine: chaveTexto(req.query.cabine),
      escopo: chaveTexto(req.query.escopo),
    };

    // Escopo deduzido da rota quando nao informado explicitamente
    if (!f.escopo && req.query.origem && req.query.destino) {
      f.escopo = escopoRota(req.query.origem, req.query.destino);
    }
    if (f.escopo && f.escopo !== 'nacional' && f.escopo !== 'internacional') {
      return res.status(400).json({ ok: false, erro: "escopo deve ser 'nacional' ou 'internacional'" });
    }

    const desde = (req.query.desde || '').trim();
    const soDia = (req.query.precisao || 'dia') === 'dia';
    const alvo = req.query.antecedencia != null && req.query.antecedencia !== ''
      ? Number(req.query.antecedencia) : null;

    let base = await carregarPontosComportamento();
    if (soDia) base = base.filter(p => p.precisao === 'dia');
    if (desde) base = base.filter(p => p.snap >= desde);

    const faixas = [[0,30],[31,60],[61,90],[91,120],[121,180],[181,240],[241,300],[301,400]];
    const niveis = [];
    const descartados = [];

    for (const nivel of NIVEIS_COMPORTAMENTO) {
      if (nivel.campos.some(c => !f[c])) continue;

      const sel = base.filter(p => nivel.campos.every(c => p[c] === f[c]));
      const registros = new Set(
        sel.map(p => `${p.origem}|${p.destino}|${p.programa}|${p.cabine}|${p.snap}`)
      ).size;

      if (registros < MIN_REGISTROS || sel.length < MIN_PONTOS) {
        descartados.push({ nivel: nivel.nome, registros, pontos: sel.length, motivo: 'amostra_insuficiente' });
        continue;
      }

      const valores = sel.map(p => p.ant);
      niveis.push({
        nivel: nivel.nome,
        agregadoPor: nivel.campos,
        registros,
        ...estatisticas(valores),
        histograma: faixas.map(([a, b]) => {
          const n = valores.filter(v => v >= a && v <= b).length;
          return { de: a, ate: b, n, pct: Number((100 * n / valores.length).toFixed(1)) };
        }),
        classificacao: classificar(valores, alvo),
      });
    }

    if (!niveis.length) {
      return res.json({
        ok: false, motivo: 'amostra_insuficiente',
        minimos: { registros: MIN_REGISTROS, pontos: MIN_PONTOS },
        filtro: f, descartados,
      });
    }

    res.set('Cache-Control', 'no-store');
    res.json({
      ok: true,
      filtro: f,
      precisao: soDia ? 'dia' : 'todas',
      // principal = nivel mais especifico com amostra; os demais servem de contexto
      principal: niveis[0].nivel,
      niveis,
      descartados,
    });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ── Panorama de comportamento ─────────────────────────────────────────────────
// Tabela agregada de todas as combinacoes cia + programa + cabine + escopo com
// amostra suficiente. Payload pequeno (~40 linhas), pensado para o mapa de
// emissoes carregar de uma vez em vez de fazer N chamadas a /comportamento.
//
// GET /passagens/panorama
//   ?escopo=nacional|internacional   filtra o recorte
//   ?destino= &origem=               restringe a uma cidade (usado no modal do mapa)
//   ?precisao=dia (default) &desde=YYYY-MM-DD
//   ?minRegistros= &minPontos=       limiares de amostra (default 5 / 60)

app.get('/passagens/panorama', async (req, res) => {
  try {
    const soDia = (req.query.precisao || 'dia') === 'dia';
    const desde = (req.query.desde || '').trim();
    const fEscopo = chaveTexto(req.query.escopo);
    const fDestino = chaveTexto(req.query.destino);
    const fOrigem = chaveTexto(req.query.origem);
    // ?par=Origem|Destino — casa as DUAS direcoes. O mapa trata a rota como par
    // nao ordenado (combina orig->dest e dest->orig), entao filtrar so um sentido
    // cortaria metade da amostra.
    const par = String(req.query.par || '').split('|').map(chaveTexto).filter(Boolean);
    const minReg = Number(req.query.minRegistros) || MIN_REGISTROS;
    const minPts = Number(req.query.minPontos) || MIN_PONTOS;

    let base = await carregarPontosComportamento();
    if (soDia) base = base.filter(p => p.precisao === 'dia');
    if (desde) base = base.filter(p => p.snap >= desde);
    if (fEscopo) base = base.filter(p => p.escopo === fEscopo);
    if (fDestino) base = base.filter(p => p.destino === fDestino);
    if (fOrigem) base = base.filter(p => p.origem === fOrigem);
    if (par.length === 2) {
      const [a, b] = par;
      base = base.filter(p => (p.origem === a && p.destino === b) || (p.origem === b && p.destino === a));
    }

    const grupos = new Map();
    for (const p of base) {
      const k = `${p.cia}|${p.programa}|${p.cabine}|${p.escopo}`;
      let g = grupos.get(k);
      if (!g) {
        g = { cia: p.cia, programa: p.programa, cabine: p.cabine, escopo: p.escopo, vals: [], regs: new Set() };
        grupos.set(k, g);
      }
      g.vals.push(p.ant);
      g.regs.add(`${p.origem}|${p.destino}|${p.snap}`);
    }

    const combos = [];
    for (const g of grupos.values()) {
      if (g.regs.size < minReg || g.vals.length < minPts) continue;
      // Registros antigos do backfill sem programa/cia nao dizem nada sobre
      // comportamento de programa — ficam de fora do panorama.
      if (!g.programa || !g.cia) continue;
      combos.push({
        cia: rotuloDe(g.cia),
        programa: rotuloDe(g.programa),
        cabine: rotuloDe(g.cabine),
        escopo: g.escopo,
        registros: g.regs.size,
        ...estatisticas(g.vals),
      });
    }

    // Ordena por escopo, depois programa, depois cabine — a lista e lida como tabela
    combos.sort((a, b) =>
      a.escopo.localeCompare(b.escopo) ||
      a.programa.localeCompare(b.programa) ||
      a.cabine.localeCompare(b.cabine) ||
      a.cia.localeCompare(b.cia));

    res.set('Cache-Control', 'no-store');
    res.json({
      ok: true,
      precisao: soDia ? 'dia' : 'todas',
      filtro: { escopo: fEscopo || null, destino: fDestino || null, origem: fOrigem || null, par: par.length === 2 ? par : null },
      minimos: { registros: minReg, pontos: minPts },
      total: combos.length,
      combos,
    });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ── Excluir passagem ──────────────────────────────────────────────────────────
app.post('/passagens/excluir', async (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ ok: false, erro: 'Campo obrigatório: id' });
  if (!GITHUB_TOKEN) return res.status(500).json({ ok: false, erro: 'GITHUB_TOKEN não configurado no servidor' });

  try {
    const atual = await ghGetJson(PASSAGENS_PATH, { items: [] });
    const items = (atual.data.items || []).filter(p => p.id !== id);

    await ghPutJson(
      PASSAGENS_PATH,
      { atualizadoEm: new Date().toISOString(), items },
      atual.sha,
      `chore: remove passagem ${id}`
    );

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  DESEJOS DE COMPRA (assistente de compras no WhatsApp)
//  desejos.json vive no repo PRIVADO de dados (contém telefone).
//  Escrita é item-a-item (upsert por id) e não substituição do array inteiro,
//  porque o assistente grava em paralelo com edições feitas no painel.
// ══════════════════════════════════════════════════════════════════════════════
const DESEJOS_PATH = 'desejos.json';
const DESEJO_STATUS = new Set(['aberto', 'pausado', 'atendido', 'cancelado']);

function normalizarTelefone(t) {
  return String(t || '').replace(/\D+/g, '');
}

function normalizarDesejo(d, anterior) {
  const agora = new Date().toISOString();
  const base = anterior || {};
  const tel = normalizarTelefone(d.telefone != null ? d.telefone : base.telefone);
  return {
    id: base.id || d.id || 'DSJ-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7),
    telefone: tel,
    nome: (d.nome != null ? d.nome : base.nome || '').trim(),
    produto: (d.produto != null ? d.produto : base.produto || '').trim(),
    termos: Array.isArray(d.termos) ? d.termos.map(s => String(s).toLowerCase().trim()).filter(Boolean)
          : (Array.isArray(base.termos) ? base.termos : []),
    categoria: (d.categoria != null ? d.categoria : base.categoria || '').trim(),
    lojas: Array.isArray(d.lojas) ? d.lojas.filter(Boolean) : (Array.isArray(base.lojas) ? base.lojas : []),
    precoAlvo: d.precoAlvo != null ? Number(d.precoAlvo) || null : (base.precoAlvo ?? null),
    precoMax:  d.precoMax  != null ? Number(d.precoMax)  || null : (base.precoMax  ?? null),
    prazo: (d.prazo != null ? d.prazo : base.prazo || '') || '',
    obs: (d.obs != null ? d.obs : base.obs || '').trim(),
    status: DESEJO_STATUS.has(d.status) ? d.status : (base.status || 'aberto'),
    origem: base.origem || d.origem || 'painel',
    avisos: Array.isArray(base.avisos) ? base.avisos : [],
    criadoEm: base.criadoEm || agora,
    atualizadoEm: agora
  };
}

// GET /compras/desejos?telefone=...&status=aberto
app.get('/compras/desejos', async (req, res) => {
  try {
    const { data } = await ghGetJsonDev(DESEJOS_PATH, [], res.locals.isDevMode);
    let itens = Array.isArray(data) ? data : [];
    const tel = normalizarTelefone(req.query.telefone);
    if (tel) itens = itens.filter(d => normalizarTelefone(d.telefone) === tel);
    const st = (req.query.status || '').trim();
    if (st) itens = itens.filter(d => (d.status || 'aberto') === st);
    itens.sort((a, b) => String(b.atualizadoEm || '').localeCompare(String(a.atualizadoEm || '')));
    res.json({ ok: true, total: itens.length, data: itens });
  } catch (e) {
    console.error('[compras/desejos GET]', e.message);
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// POST /compras/desejos — cria (sem id) ou atualiza (com id) UM desejo
app.post('/compras/desejos', async (req, res) => {
  const body = req.body || {};
  if (!body.id && !normalizarTelefone(body.telefone)) {
    return res.status(400).json({ ok: false, erro: 'telefone obrigatório' });
  }
  if (!body.id && !String(body.produto || '').trim()) {
    return res.status(400).json({ ok: false, erro: 'produto obrigatório' });
  }
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    try {
      const { data, sha } = await ghGetJsonDev(DESEJOS_PATH, [], res.locals.isDevMode);
      const lista = Array.isArray(data) ? data : [];
      const i = body.id ? lista.findIndex(d => d.id === body.id) : -1;
      if (body.id && i === -1) return res.status(404).json({ ok: false, erro: 'desejo não encontrado' });
      const item = normalizarDesejo(body, i >= 0 ? lista[i] : null);
      if (i >= 0) lista[i] = item; else lista.unshift(item);
      await ghPutJsonDev(DESEJOS_PATH, lista, sha,
        (i >= 0 ? 'chore: atualiza desejo ' : 'chore: novo desejo ') + item.id + ' [skip ci]',
        res.locals.isDevMode);
      return res.json({ ok: true, data: item });
    } catch (e) {
      if (/409|422|sha|conflict|expected|does not match/i.test(e.message) && tentativa < 2) continue;
      console.error('[compras/desejos POST]', e.message);
      return res.status(500).json({ ok: false, erro: e.message });
    }
  }
});

// POST /compras/desejos/aviso — registra que a pessoa já foi avisada desta oferta
// (ledger anti-duplicata, mesmo papel do msgs-enviadas.json no concierge)
app.post('/compras/desejos/aviso', async (req, res) => {
  const { id, ofertaId, canal } = req.body || {};
  if (!id || !ofertaId) return res.status(400).json({ ok: false, erro: 'id e ofertaId obrigatórios' });
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    try {
      const { data, sha } = await ghGetJsonDev(DESEJOS_PATH, [], res.locals.isDevMode);
      const lista = Array.isArray(data) ? data : [];
      const i = lista.findIndex(d => d.id === id);
      if (i === -1) return res.status(404).json({ ok: false, erro: 'desejo não encontrado' });
      lista[i].avisos = Array.isArray(lista[i].avisos) ? lista[i].avisos : [];
      if (lista[i].avisos.some(a => a.ofertaId === ofertaId)) {
        return res.json({ ok: true, jaAvisado: true });
      }
      lista[i].avisos.push({ ofertaId, canal: canal || 'whatsapp', em: new Date().toISOString() });
      lista[i].atualizadoEm = new Date().toISOString();
      await ghPutJsonDev(DESEJOS_PATH, lista, sha, 'chore: aviso ' + id + ' [skip ci]', res.locals.isDevMode);
      return res.json({ ok: true, jaAvisado: false });
    } catch (e) {
      if (/409|422|sha|conflict|expected|does not match/i.test(e.message) && tentativa < 2) continue;
      console.error('[compras/desejos/aviso]', e.message);
      return res.status(500).json({ ok: false, erro: e.message });
    }
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ── OTP: store em memória (email → { codigo, expira, nome, produtos }) ────────
const otpStore = new Map();
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const OTP_TTL = 10 * 60 * 1000; // 10 minutos

function gerarCodigo() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// ── Membros: enviar código OTP por e-mail ────────────────────────────────────
app.post('/membros/enviar-codigo', async (req, res) => {
  const email = ((req.body || {}).email || '').toLowerCase().trim();
  if (!email) return res.status(400).json({ ok: false, erro: 'E-mail obrigatório' });
  try {
    const devMode = res.locals.isDevMode;
    const dados = await ghGetJsonDev(MEMBROS_PATH, { membros: [] }, devMode);
    const membro = (dados.data.membros || []).find(m => m.email === email);
    if (!membro) return res.json({ ok: false, motivo: 'nao_encontrado' });
    if (membro.status !== 'ativo') return res.json({ ok: false, motivo: 'inativo', nome: membro.nome });

    const codigo = gerarCodigo();
    otpStore.set(email, { codigo, expira: Date.now() + OTP_TTL, nome: membro.nome, produtos: membro.produtos });

    if (!RESEND_API_KEY) {
      // Modo dev sem Resend: loga o código no servidor
      console.log(`[OTP-DEV] ${email} → ${codigo}`);
      return res.json({ ok: true, dev: true });
    }

    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Clube do Viajante <noreply@clubedoviajante.com.br>',
        to: [email],
        subject: `Seu código de acesso: ${codigo}`,
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#0a0c12;color:#fff;border-radius:12px">
            <h2 style="color:#FF6B5B;margin-bottom:8px">Clube do Viajante</h2>
            <p style="color:#aaa;margin-bottom:24px">Use o código abaixo para acessar seu painel. Ele expira em <strong>10 minutos</strong>.</p>
            <div style="background:#1a1d2e;border-radius:10px;padding:24px;text-align:center;letter-spacing:12px;font-size:32px;font-weight:900;color:#FF6B5B;margin-bottom:24px">${codigo}</div>
            <p style="color:#666;font-size:12px">Se você não solicitou este código, ignore este e-mail.</p>
          </div>`
      })
    });
    if (!emailRes.ok) {
      const errBody = await emailRes.text();
      console.error('[OTP-RESEND]', errBody);
      return res.status(500).json({ ok: false, erro: 'Falha ao enviar e-mail' });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ── Membros: verificar código OTP ────────────────────────────────────────────
app.post('/membros/verificar-codigo', (req, res) => {
  const { email, codigo } = req.body || {};
  const emailNorm = (email || '').toLowerCase().trim();
  const codigoNorm = (codigo || '').trim();
  if (!emailNorm || !codigoNorm) return res.status(400).json({ ok: false, erro: 'E-mail e código obrigatórios' });

  const entrada = otpStore.get(emailNorm);
  if (!entrada) return res.json({ ok: false, motivo: 'nao_encontrado' });
  if (Date.now() > entrada.expira) {
    otpStore.delete(emailNorm);
    return res.json({ ok: false, motivo: 'expirado' });
  }
  if (entrada.codigo !== codigoNorm) return res.json({ ok: false, motivo: 'invalido' });

  otpStore.delete(emailNorm);
  res.json({ ok: true, acesso: true, nome: entrada.nome, email: emailNorm, produtos: entrada.produtos });
});

// ── ADMIN OTP: acesso restrito (TSP + Concierge) ─────────────────────────────
// Allowlist fixa — independente de membros.json. Para liberar novos acessos,
// basta adicionar o e-mail (minúsculo) no array abaixo.
// ADMIN_EMAILS      → acesso a TODOS os painéis (TSP + Concierge)
// ADMIN_EMAILS_APP  → acesso restrito a um painel específico
const ADMIN_EMAILS = ['davileles@gmail.com'];

// ── Operadores do TSP hospedado (fase 2.5) ───────────────────────────────────
// O registro de operadores mora em cdv-tsp-dados/tsp/tenants.json (mantido
// pelo baileys-server). O login do painel TSP aceita os e-mails de la, com
// cache curto para nao bater no GitHub a cada OTP.
let _tenantsCache = { emails: [], porEmail: {}, ts: 0 };
async function emailsDosTenantsTsp() {
  if (Date.now() - _tenantsCache.ts < 5 * 60 * 1000) return _tenantsCache.emails;
  try {
    const r = await fetch('https://api.github.com/repos/davileles/cdv-tsp-dados/contents/tsp/tenants.json', {
      headers: { 'Authorization': 'Bearer ' + process.env.GITHUB_TOKEN, 'Accept': 'application/vnd.github.raw' },
    });
    if (r.ok) {
      const reg = await r.json();
      const emails = [];
      for (const t of (reg.tenants || [])) {
        if (t.ativo === false) continue;
        for (const e of (t.emails || [])) emails.push(String(e).toLowerCase().trim());
      }
      const porEmail = {};
      for (const t of (reg.tenants || [])) {
        if (t.ativo === false) continue;
        for (const e of (t.emails || [])) porEmail[String(e).toLowerCase().trim()] = String(t.id || '').toLowerCase();
      }
      _tenantsCache = { emails: [...new Set(emails)], porEmail, ts: Date.now() };
    }
  } catch (e) { console.log('[ADMIN] Falha ao ler tenants.json:', e.message); }
  return _tenantsCache.emails;
}

// Token de sessao do operador: HMAC com segredo compartilhado com o
// baileys-server (env TSP_TENANT_SECRET nos DOIS servicos). 7 dias.
// Verificacao do token (mesmo formato que o baileys-server valida).
function verificarTokenTenant(bruto) {
  const secret = process.env.TSP_TENANT_SECRET || '';
  const tk = String(bruto || '').trim();
  if (!secret || !tk) return null;
  const ponto = tk.lastIndexOf('.');
  if (ponto < 1) return null;
  const payload = tk.slice(0, ponto), assinatura = tk.slice(ponto + 1);
  const esperada = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(assinatura, 'hex'), Buffer.from(esperada, 'hex'))) return null;
  } catch { return null; }
  try {
    const d = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
    if (!d.email || !d.exp || Date.now() > d.exp) return null;
    return { email: String(d.email).toLowerCase(), exp: d.exp };
  } catch { return null; }
}

// Operador da requisicao no distribuidor: sem token = operacao padrao ('tsp');
// token invalido = null (o endpoint devolve 401, nunca cai na padrao).
async function tenantDaReqGg(req) {
  const bruto = req.headers['x-tsp-token'] || '';
  if (!bruto) return 'tsp';
  const tk = verificarTokenTenant(bruto);
  if (!tk) return null;
  await emailsDosTenantsTsp();   // garante cache do mapa
  return _tenantsCache.porEmail[tk.email] || null;
}

function assinarTokenTenant(email) {
  const secret = process.env.TSP_TENANT_SECRET || '';
  if (!secret) return null;
  const payload = Buffer.from(JSON.stringify({
    email: String(email).toLowerCase(), exp: Date.now() + 7 * 24 * 3600 * 1000,
  })).toString('base64url');
  const assinatura = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return payload + '.' + assinatura;
}
const ADMIN_EMAILS_APP = {
  tsp:       [],
  concierge: ['felipetruta1@gmail.com']
};
function adminAutorizado(email, appKey) {
  if (ADMIN_EMAILS.includes(email)) return true;
  if (appKey && ADMIN_EMAILS_APP[appKey]) return ADMIN_EMAILS_APP[appKey].includes(email);
  return Object.values(ADMIN_EMAILS_APP).some(l => l.includes(email));
}
const adminOtpStore = new Map();

const ADMIN_APPS = {
  tsp:       { nome: 'Tudo Sobre Promos', cor: '#ffa500', from: 'Tudo Sobre Promos <noreply@clubedoviajante.com.br>' },
  concierge: { nome: 'Travel Concierge',  cor: '#126eff', from: 'Travel Concierge <noreply@clubedoviajante.com.br>' }
};

app.post('/admin/enviar-codigo', async (req, res) => {
  const body  = req.body || {};
  const email = (body.email || '').toLowerCase().trim();
  const app_  = ADMIN_APPS[body.app] || ADMIN_APPS.concierge;
  if (!email) return res.status(400).json({ ok: false, erro: 'E-mail obrigatório' });
  const appKey_ = ADMIN_APPS[body.app] ? body.app : null;
  const podeEntrar = adminAutorizado(email, appKey_)
    || (appKey_ === 'tsp' && (await emailsDosTenantsTsp()).includes(email));
  if (!podeEntrar) return res.json({ ok: false, motivo: 'nao_autorizado' });

  const codigo = gerarCodigo();
  adminOtpStore.set(email, { codigo, expira: Date.now() + OTP_TTL });

  if (!RESEND_API_KEY) {
    console.log(`[ADMIN-OTP-DEV] ${email} → ${codigo}`);
    return res.json({ ok: true, dev: true });
  }
  try {
    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: app_.from,
        to: [email],
        subject: `Seu código de acesso: ${codigo}`,
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#0a0c12;color:#fff;border-radius:12px">
            <h2 style="color:${app_.cor};margin-bottom:8px">${app_.nome}</h2>
            <p style="color:#aaa;margin-bottom:24px">Use o código abaixo para acessar o painel. Ele expira em <strong>10 minutos</strong>.</p>
            <div style="background:#1a1d2e;border-radius:10px;padding:24px;text-align:center;letter-spacing:12px;font-size:32px;font-weight:900;color:${app_.cor};margin-bottom:24px">${codigo}</div>
            <p style="color:#666;font-size:12px">Se você não solicitou este código, ignore este e-mail.</p>
          </div>`
      })
    });
    if (!emailRes.ok) {
      console.error('[ADMIN-OTP-RESEND]', await emailRes.text());
      return res.status(500).json({ ok: false, erro: 'Falha ao enviar e-mail' });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.post('/admin/verificar-codigo', async (req, res) => {
  const body   = req.body || {};
  const email  = (body.email || '').toLowerCase().trim();
  const codigo = (body.codigo || '').trim();
  if (!email || !codigo) return res.status(400).json({ ok: false, erro: 'E-mail e código obrigatórios' });
  const appKey = ADMIN_APPS[body.app] ? body.app : null;
  const autorizado = adminAutorizado(email, appKey);
  // Painel TSP: operadores do registro tambem entram (fase 2.5).
  const operadorTsp = !autorizado && appKey === 'tsp'
    ? (await emailsDosTenantsTsp()).includes(email) : false;
  if (!autorizado && !operadorTsp) return res.json({ ok: false, motivo: 'nao_autorizado' });

  const entrada = adminOtpStore.get(email);
  if (!entrada) return res.json({ ok: false, motivo: 'nao_encontrado' });
  if (Date.now() > entrada.expira) { adminOtpStore.delete(email); return res.json({ ok: false, motivo: 'expirado' }); }
  if (entrada.codigo !== codigo) return res.json({ ok: false, motivo: 'invalido' });

  adminOtpStore.delete(email);
  // Token de operador so no painel TSP — identifica o tenant no baileys-server.
  const tenantToken = appKey === 'tsp' ? assinarTokenTenant(email) : null;
  // Trava: um OPERADOR sem token cairia na operacao padrao dentro do
  // baileys-server (sem token = raiz). Se o segredo nao esta configurado,
  // melhor recusar o login dele do que deixa-lo operar dados alheios.
  if (operadorTsp && !tenantToken) {
    return res.status(500).json({ ok: false, erro: 'TSP_TENANT_SECRET nao configurado no proxy — login de operador bloqueado por seguranca.' });
  }
  res.json({ ok: true, acesso: true, email, ...(tenantToken ? { tenantToken } : {}) });
});

// ── Membros: verificar acesso por e-mail ─────────────────────────────────────
app.get('/membros/verificar', async (req, res) => {
  const email = (req.query.email || '').toLowerCase().trim();
  if (!email) return res.status(400).json({ ok: false, erro: 'E-mail obrigatório' });
  try {
    const devMode = res.locals.isDevMode;
    const dados = await ghGetJsonDev(MEMBROS_PATH, { membros: [] }, devMode);
    const membro = (dados.data.membros || []).find(m => m.email === email);
    if (!membro) return res.json({ ok: false, acesso: false, motivo: 'nao_encontrado' });
    if (membro.status !== 'ativo') return res.json({ ok: false, acesso: false, motivo: 'inativo', nome: membro.nome });
    res.json({ ok: true, acesso: true, nome: membro.nome, email: membro.email, produtos: membro.produtos });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ── Preferência de tema por membro ───────────────────────────────────────────
app.get('/membros/tema', async (req, res) => {
  const email = (req.query.email || '').toLowerCase().trim();
  if (!email) return res.status(400).json({ ok: false, erro: 'E-mail obrigatório' });
  try {
    const devMode = res.locals.isDevMode;
    const dados = await ghGetJsonDev(MEMBROS_PATH, { membros: [] }, devMode);
    const membro = (dados.data.membros || []).find(m => m.email === email);
    if (!membro) return res.status(404).json({ ok: false, erro: 'Membro não encontrado' });
    res.json({ ok: true, tema: membro.tema || 'dark' });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.post('/membros/tema', async (req, res) => {
  const { email, tema } = req.body || {};
  if (!email || !tema) return res.status(400).json({ ok: false, erro: 'E-mail e tema obrigatórios' });
  if (!['dark', 'light'].includes(tema)) return res.status(400).json({ ok: false, erro: 'Tema inválido' });
  try {
    const devMode = res.locals.isDevMode;
    const dados = await ghGetJsonDev(MEMBROS_PATH, { membros: [] }, devMode);
    const membros = dados.data.membros || [];
    const idx = membros.findIndex(m => m.email === email.toLowerCase().trim());
    if (idx === -1) return res.status(404).json({ ok: false, erro: 'Membro não encontrado' });
    membros[idx].tema = tema;
    const shaDados = await ghGetJsonDev(MEMBROS_PATH, { membros: [] }, devMode);
    await ghPutJsonDev(MEMBROS_PATH, { ...shaDados.data, membros }, shaDados.sha, `chore: tema ${tema} para ${email}`, devMode);
    res.json({ ok: true, tema });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ── Webhook Hubla: member_added / member_removed ──────────────────────────────
app.post('/webhook/hubla-membros', async (req, res) => {
  // Valida token
  const tokenRecebido = req.headers['x-hubla-token'] || req.headers['authorization'];
  if (HUBLA_TOKEN && tokenRecebido !== HUBLA_TOKEN) {
    return res.status(401).json({ ok: false, erro: 'Token inválido' });
  }

  const { type, event } = req.body || {};
  if (!type || !event) return res.status(400).json({ ok: false, erro: 'Payload inválido' });

  const isMemberAdded   = type === 'customer.member_added'   || type === 'member.granted';
  const isMemberRemoved = type === 'customer.member_removed' || type === 'member.revoked';
  if (!isMemberAdded && !isMemberRemoved) return res.json({ ok: true, ignorado: true, type });

  // Payload v2: e-mail em event.user ou event.subscription.payer
  const user   = event.user || event.subscription?.payer || event.member || event.customer || {};
  const email  = (user.email || '').toLowerCase().trim();
  const nome   = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.fullName || user.name || email;
  const produto = event.products?.[0] || event.product || {};

  if (!email) return res.status(400).json({ ok: false, erro: 'E-mail não encontrado no payload' });

  for (let tentativa = 1; tentativa <= 4; tentativa++) {
    try {
      const agora = new Date().toISOString();
      const dados = await ghGetJson(MEMBROS_PATH, { atualizadoEm: agora, total: 0, membros: [] });
      let membros = dados.data.membros || [];
      const idx   = membros.findIndex(m => m.email === email);

      if (isMemberAdded) {
        const entrada = {
          oferta:      produto.offers?.[0]?.name || produto.name || '',
          produtoId:   produto.id || '',
          produtoNome: produto.name || ''
        };
        if (idx >= 0) {
          membros[idx].status       = 'ativo';
          membros[idx].atualizadoEm = agora;
          if (!membros[idx].produtos) membros[idx].produtos = [];
          const jaExiste = membros[idx].produtos.some(p => p.produtoId === entrada.produtoId);
          if (!jaExiste) membros[idx].produtos.push(entrada);
        } else {
          membros.push({ nome, email, status: 'ativo', produtos: [entrada], adicionadoEm: agora, atualizadoEm: agora, origem: 'webhook' });
        }
      }

      if (isMemberRemoved) {
        if (idx >= 0) {
          membros[idx].status       = 'inativo';
          membros[idx].atualizadoEm = agora;
          membros[idx].removidoEm   = agora;
        }
      }

      await ghPutJson(MEMBROS_PATH, { atualizadoEm: agora, total: membros.filter(m => m.status === 'ativo').length, membros }, dados.sha, 'webhook: atualiza membros');
      return res.json({ ok: true, type, email, acao: isMemberAdded ? 'adicionado' : 'removido' });

    } catch (err) {
      const isShaConflict = err.message && err.message.includes('but expected');
      if (isShaConflict && tentativa < 4) {
        console.warn(`[hubla-membros] SHA conflict, retry ${tentativa}/4 em ${tentativa * 400}ms`);
        await new Promise(r => setTimeout(r, tentativa * 400));
        continue;
      }
      console.error('[webhook-hubla-membros]', err.message);
      return res.status(500).json({ ok: false, erro: err.message });
    }
  }
});

// ── Perfis: listar ────────────────────────────────────────────────────────────
app.get('/perfis/listar', async (req, res) => {
  const email = (req.query.email || '').toLowerCase().trim();
  if (!email) return res.status(400).json({ ok: false, erro: 'E-mail obrigatório' });
  try {
    const devMode = res.locals.isDevMode;
    const atual = await ghGetJsonDev(PERFIS_PATH, { perfis: [] }, devMode);
    const perfis = (atual.data.perfis || []).filter(p => p.email === email);
    res.json({ ok: true, perfis });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ── Perfis: salvar lista completa do usuário ───────────────────────────────────
// Body: { email, perfis: [{id, nome}] }
app.post('/perfis/salvar', async (req, res) => {
  const { email, perfis } = req.body || {};
  if (!email) return res.status(400).json({ ok: false, erro: 'E-mail obrigatório' });
  if (!Array.isArray(perfis)) return res.status(400).json({ ok: false, erro: 'perfis deve ser um array' });
  if (!GITHUB_TOKEN) return res.status(500).json({ ok: false, erro: 'GITHUB_TOKEN não configurado' });

  const emailNorm = email.toLowerCase().trim();
  const perfisSanitizados = perfis.map(p => ({ ...p, email: emailNorm }));

  for (let tentativa = 1; tentativa <= 4; tentativa++) {
    try {
      const atual = await ghGetJson(PERFIS_PATH, { atualizadoEm: null, perfis: [] });
      const outros = (atual.data.perfis || []).filter(p => p.email !== emailNorm);
      const novos  = [...outros, ...perfisSanitizados];
      await ghPutJson(PERFIS_PATH, { atualizadoEm: new Date().toISOString(), perfis: novos }, atual.sha,
        `chore: perfis ${emailNorm} (${perfisSanitizados.length} perfis)`);
      return res.json({ ok: true, total: perfisSanitizados.length });
    } catch (err) {
      const isShaConflict = err.message && err.message.includes('but expected');
      if (isShaConflict && tentativa < 4) { await new Promise(r => setTimeout(r, tentativa * 400)); continue; }
      console.error('[perfis/salvar]', err.message);
      return res.status(500).json({ ok: false, erro: err.message });
    }
  }
});

// ── Gestão de Milhas: listar registros do usuário ────────────────────────────
app.get('/milhas/listar', async (req, res) => {
  const email = (req.query.email || '').toLowerCase().trim();
  if (!email) return res.status(400).json({ ok: false, erro: 'E-mail obrigatório' });
  try {
    const devMode = res.locals.isDevMode;
    const atual = await ghGetJsonDev(MILHAS_PATH, { registros: [] }, devMode);
    const registros = (atual.data.registros || []).filter(r => r.email === email);
    res.json({ ok: true, registros });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ── Gestão de Milhas: salvar lista completa do usuário ───────────────────────
// Body: { email, registros: [...] }
// Substitui todos os registros daquele e-mail; mantém registros de outros usuários intactos.
app.post('/milhas/salvar', async (req, res) => {
  const { email, registros } = req.body || {};
  if (!email) return res.status(400).json({ ok: false, erro: 'E-mail obrigatório' });
  if (!Array.isArray(registros)) return res.status(400).json({ ok: false, erro: 'registros deve ser um array' });
  if (!GITHUB_TOKEN) return res.status(500).json({ ok: false, erro: 'GITHUB_TOKEN não configurado' });

  const emailNorm = email.toLowerCase().trim();

  // Garante que todos os registros enviados pertencem ao e-mail autenticado
  const registrosSanitizados = registros.map(r => ({ ...r, email: emailNorm }));

  for (let tentativa = 1; tentativa <= 4; tentativa++) {
    try {
      const atual = await ghGetJson(MILHAS_PATH, { atualizadoEm: null, registros: [] });
      const outros = (atual.data.registros || []).filter(r => r.email !== emailNorm);
      const novos  = [...outros, ...registrosSanitizados];

      await ghPutJson(
        MILHAS_PATH,
        { atualizadoEm: new Date().toISOString(), registros: novos },
        atual.sha,
        `chore: milhas ${emailNorm} (${registrosSanitizados.length} registros)`
      );

      return res.json({ ok: true, total: registrosSanitizados.length });
    } catch (err) {
      const isShaConflict = err.message && err.message.includes('but expected');
      if (isShaConflict && tentativa < 4) {
        console.warn(`[milhas/salvar] SHA conflict, retry ${tentativa}/4 em ${tentativa * 400}ms`);
        await new Promise(r => setTimeout(r, tentativa * 400));
        continue;
      }
      console.error('[milhas/salvar]', err.message);
      return res.status(500).json({ ok: false, erro: err.message });
    }
  }
});

// ── Gestão de Milhas: excluir um registro por ID ────────────────────────────
// Body: { email, id }
app.post('/milhas/excluir', async (req, res) => {
  const { email, id } = req.body || {};
  if (!email || !id) return res.status(400).json({ ok: false, erro: 'Campos obrigatórios: email, id' });
  if (!GITHUB_TOKEN) return res.status(500).json({ ok: false, erro: 'GITHUB_TOKEN não configurado' });

  const emailNorm = email.toLowerCase().trim();

  for (let tentativa = 1; tentativa <= 4; tentativa++) {
    try {
      const atual = await ghGetJson(MILHAS_PATH, { atualizadoEm: null, registros: [] });
      const registros = (atual.data.registros || []).filter(r => !(r.email === emailNorm && r.id === id));

      await ghPutJson(
        MILHAS_PATH,
        { atualizadoEm: new Date().toISOString(), registros },
        atual.sha,
        `chore: exclui milha ${id} (${emailNorm})`
      );

      return res.json({ ok: true });
    } catch (err) {
      const isShaConflict = err.message && err.message.includes('but expected');
      if (isShaConflict && tentativa < 4) {
        console.warn(`[milhas/excluir] SHA conflict, retry ${tentativa}/4 em ${tentativa * 400}ms`);
        await new Promise(r => setTimeout(r, tentativa * 400));
        continue;
      }
      console.error('[milhas/excluir]', err.message);
      return res.status(500).json({ ok: false, erro: err.message });
    }
  }
});


// ── Cartões: listar ────────────────────────────────────────────────────────
app.get('/cartoes/listar', async (req, res) => {
  const email = (req.query.email || '').toLowerCase().trim();
  if (!email) return res.status(400).json({ ok: false, erro: 'E-mail obrigatório' });
  try {
    const devMode = res.locals.isDevMode;
    const atual = await ghGetJsonDev(CARTOES_PATH, { cartoes: [] }, devMode);
    const cartoes = (atual.data.cartoes || []).filter(c => c.email === email);
    res.json({ ok: true, cartoes });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ── Cartões: salvar lista completa do usuário ──────────────────────────────
app.post('/cartoes/salvar', async (req, res) => {
  const { email, cartoes } = req.body || {};
  if (!email) return res.status(400).json({ ok: false, erro: 'E-mail obrigatório' });
  if (!Array.isArray(cartoes)) return res.status(400).json({ ok: false, erro: 'cartoes deve ser um array' });
  if (!GITHUB_TOKEN) return res.status(500).json({ ok: false, erro: 'GITHUB_TOKEN não configurado' });

  const emailNorm = email.toLowerCase().trim();
  const cartoesSanitizados = cartoes.map(c => ({ ...c, email: emailNorm }));

  for (let tentativa = 1; tentativa <= 4; tentativa++) {
    try {
      const atual = await ghGetJson(CARTOES_PATH, { atualizadoEm: null, cartoes: [] });
      const outros = (atual.data.cartoes || []).filter(c => c.email !== emailNorm);
      const novos  = [...outros, ...cartoesSanitizados];
      await ghPutJson(CARTOES_PATH, { atualizadoEm: new Date().toISOString(), cartoes: novos }, atual.sha,
        `chore: cartoes ${emailNorm} (${cartoesSanitizados.length} registros)`);
      return res.json({ ok: true, total: cartoesSanitizados.length });
    } catch (err) {
      const isShaConflict = err.message && err.message.includes('but expected');
      if (isShaConflict && tentativa < 4) { await new Promise(r => setTimeout(r, tentativa * 400)); continue; }
      console.error('[cartoes/salvar]', err.message);
      return res.status(500).json({ ok: false, erro: err.message });
    }
  }
});

// ── Assinaturas: listar ────────────────────────────────────────────────────
app.get('/assinaturas/listar', async (req, res) => {
  const email = (req.query.email || '').toLowerCase().trim();
  if (!email) return res.status(400).json({ ok: false, erro: 'E-mail obrigatório' });
  try {
    const devMode = res.locals.isDevMode;
    const atual = await ghGetJsonDev(ASSINATURAS_PATH, { assinaturas: [] }, devMode);
    const assinaturas = (atual.data.assinaturas || []).filter(a => a.email === email);
    res.json({ ok: true, assinaturas });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ── Assinaturas: salvar lista completa do usuário ──────────────────────────
app.post('/assinaturas/salvar', async (req, res) => {
  const { email, assinaturas } = req.body || {};
  if (!email) return res.status(400).json({ ok: false, erro: 'E-mail obrigatório' });
  if (!Array.isArray(assinaturas)) return res.status(400).json({ ok: false, erro: 'assinaturas deve ser um array' });
  if (!GITHUB_TOKEN) return res.status(500).json({ ok: false, erro: 'GITHUB_TOKEN não configurado' });

  const emailNorm = email.toLowerCase().trim();
  const assinaturasSanitizadas = assinaturas.map(a => ({ ...a, email: emailNorm }));

  for (let tentativa = 1; tentativa <= 4; tentativa++) {
    try {
      const atual = await ghGetJson(ASSINATURAS_PATH, { atualizadoEm: null, assinaturas: [] });
      const outros = (atual.data.assinaturas || []).filter(a => a.email !== emailNorm);
      const novos  = [...outros, ...assinaturasSanitizadas];
      await ghPutJson(ASSINATURAS_PATH, { atualizadoEm: new Date().toISOString(), assinaturas: novos }, atual.sha,
        `chore: assinaturas ${emailNorm} (${assinaturasSanitizadas.length} registros)`);
      return res.json({ ok: true, total: assinaturasSanitizadas.length });
    } catch (err) {
      const isShaConflict = err.message && err.message.includes('but expected');
      if (isShaConflict && tentativa < 4) { await new Promise(r => setTimeout(r, tentativa * 400)); continue; }
      console.error('[assinaturas/salvar]', err.message);
      return res.status(500).json({ ok: false, erro: err.message });
    }
  }
});

// ── IA: Extrair dados de reserva via Anthropic ──────────────────
app.post('/ia/extrair-reserva', (req, res) => {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  const { mediaType, base64, isPdf, isHtml, texto, tipoCampos } = req.body;

  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ ok: false, erro: 'ANTHROPIC_API_KEY não configurada no servidor.' });
  }

  // Normaliza a entrada para uma lista de documentos.
  // Aceita o formato antigo (base64/mediaType/isPdf/texto no corpo) e o novo
  // documentos: [{ base64, mediaType, isPdf, texto, nome }, ...] — todos da MESMA reserva.
  const fontes = (Array.isArray(req.body.documentos) && req.body.documentos.length)
    ? req.body.documentos
    : [{ base64, mediaType, isPdf, isHtml, texto }];

  const docs = [];
  for (const f of fontes) {
    if (!f) continue;
    const t = (typeof f.texto === 'string' ? f.texto : '').trim();
    if (t) { docs.push({ kind: 'texto', texto: t.slice(0, 60000), nome: f.nome || '' }); continue; }
    if (f.base64 && f.mediaType) {
      docs.push({ kind: f.isPdf ? 'pdf' : 'imagem', base64: f.base64, mediaType: f.mediaType, nome: f.nome || '' });
    }
  }

  if (!docs.length) {
    return res.status(400).json({ ok: false, erro: 'Informe base64 + mediaType (imagem/PDF) ou texto (HTML).' });
  }

  const multiDoc = docs.length > 1;
  console.log('[ia/extrair-reserva] recebido.', docs.length, 'documento(s):',
              docs.map(d => d.kind + (d.nome ? ':' + d.nome : '')).join(', '));

  const prompt =
    'Você é um assistente de extração de dados de documentos de viagem. ' +
    (multiDoc
      ? 'Foram enviados ' + docs.length + ' documentos que pertencem a UMA MESMA reserva de ' + (tipoCampos || 'reserva de viagem') + ' (ex: bilhete de ida e bilhete de volta, um bilhete por passageiro, voucher + comprovante de pagamento). Analise TODOS eles em conjunto e consolide tudo em UM UNICO JSON. '
      : 'Analise este documento (' + (docs[0].kind === 'texto' ? 'texto extraído de um arquivo HTML' : (docs[0].kind === 'pdf' ? 'PDF' : 'imagem')) + ') de ' + (tipoCampos || 'reserva de viagem') + '. ') +
    'Extraia os dados REAIS do documento e retorne SOMENTE um JSON válido (sem markdown). ' +
    'Use exatamente esta estrutura JSON (substitua pelos valores reais): ' +
    '{"tipo":"voo","trechos":[{"nvoo":"numero do voo","origem":"IATA","destino":"IATA","data":"YYYY-MM-DD","horaPartida":"HH:MM","horaChegada":"HH:MM","cabine":"cabine exata","cia":"companhia aerea"}],"pnr":"","pax":0,"programa":"","milhasTotal":0,"valor":"","hotelNome":"","hotelDestino":"","hotelQuarto":"","checkin":"","checkout":"","noites":"","hospedes":"","hotelConf":"","regime":"","hotelValor":"","subtipo":"transfer","transferOrigem":"","transferDestino":"","transferData":"","transferHora":"","transferPax":"","transferOp":"","transferVeiculo":"","transferConf":"","transferValor":"","transferVoltaOrigem":"","transferVoltaDestino":"","transferVoltaData":"","transferVoltaHora":"","transferVoltaHoraChegada":"","transferVoltaOp":"","transferVoltaConf":"","transferVoltaCategoria":"","locadora":"","carroCat":"","retLocal":"","devLocal":"","retData":"","devData":"","carroConf":"","carroValor":"","passeioNome":"","passeioDest":"","passeioOp":"","passeioData":"","passeioHora":"","passeioPax":"","passeioConf":"","passeioValor":"","seguradora":"","seguroPlano":"","seguroApolice":"","seguroCartao":"","seguroInicio":"","seguroFim":"","seguroModalidade":"","seguroDias":"","seguroTerritorio":"","seguroCobertura":"","seguroPax":"","seguroValor":"","seguroEmergencia":"","obs":""} ' +
    'REGRAS: ' +
    '1) trechos[]: um objeto por segmento de voo na ordem do itinerário. ' +
    '2) Em cada trecho, cia = nome da companhia aérea operadora (ex: LATAM, Azul, Gol, TAP, KLM). ' +
    '3) pax = total de passageiros DISTINTOS listados por nome no documento. Se a mesma pessoa aparecer em bilhetes separados (ex: um bilhete de ida e outro de volta, ou um bilhete por passageiro), conte cada pessoa uma unica vez. ' +
    '4) milhasTotal = total bruto de milhas do documento inteiro, sem dividir. ' +
    '5) Para hotel, preencha os campos hotel* e trechos=[]. ' +
    '6) Para qualquer transporte terrestre ou aquático: use tipo=\"carro\" e defina subtipo conforme abaixo. ' +
    '   - Transfer/traslado (van, táxi, shuttle, ponto a ponto sem devolução): subtipo=\"transfer\". ' +
    '   - Trem, metrô, trem de alta velocidade, trem noturno: subtipo=\"trem\". ' +
    '   - Ônibus, autocarro, bus turístico, coach: subtipo=\"onibus\". ' +
    '   - Ferry, balsa, barco, cruzeiro fluvial: subtipo=\"ferry\". ' +
    '   - Locação/aluguel de carro (cliente retira e devolve): subtipo=\"locacao\". ' +
    '   Para transfer/trem/onibus/ferry preencha: transferOrigem, transferDestino, transferData, transferHora, transferPax, transferOp, transferVeiculo, transferConf, transferValor. ' +
    '   IDA E VOLTA: se o documento contiver mais de um trecho ponto-a-ponto (ex: um bilhete de ida e outro de retorno, ou trechos A->B e B->A), trate como UMA unica reserva e preencha tambem os campos de volta: ' +
    '   transferVoltaOrigem, transferVoltaDestino, transferVoltaData, transferVoltaHora, transferVoltaHoraChegada, transferVoltaOp, transferVoltaConf, transferVoltaCategoria. ' +
    '   Os trechos podem ser de operadoras, embarcacoes, navios, vouchers ou fornecedores DIFERENTES — isso nao impede que sejam ida e volta da mesma reserva. ' +
    '   O trecho cronologicamente anterior e a ida; o posterior (ou o que retorna ao ponto de partida) e a volta. ' +
    '   transferValor deve ser o valor TOTAL da reserva, somando ida, volta e todos os passageiros. ' +
    '   Se houver apenas um sentido, deixe todos os campos transferVolta* vazios. ' +
    '   Para locacao preencha: locadora, carroCat, retLocal, devLocal, retData, devData, carroConf, carroValor. ' +
    '7) Para passeio/atividade, use tipo=\"passeio\" e preencha passeio*. ' +
    '8) SEGURO VIAGEM: bilhete de seguro viagem, apólice, certificado ou voucher de assistência internacional ' +
    '   (Assist Card, Coris, GTA, Universal Assistance, April, Affinity, Intermac, ITA, Porto Seguro, Allianz Travel, AXA, Travel Ace, Vital Card, World Assistance, SulAmerica, MAPFRE, AIG e similares) ' +
    '   -> use tipo=\"seguro\", trechos=[] e preencha: ' +
    '   seguradora = nome comercial curto da assistência/seguradora (ex: \"Assist Card\") — nunca a razão social nem a seguradora emissora do risco; ' +
    '   seguroPlano = nome do plano/produto (ex: \"PLANO 250\"); ' +
    '   seguroApolice = número do bilhete, apólice ou certificado (identificador principal do documento, ex: \"2013.94318.26.0012623\"); ' +
    '   seguroCartao = número do cartão de assistência, se houver (ex: \"550 33378809 0B59\"); ' +
    '   seguroInicio e seguroFim = início e fim da VIGÊNCIA do serviço em YYYY-MM-DD — nunca use a data de emissão do bilhete; ' +
    '   seguroModalidade = \"multiviagem\" quando o documento indicar multitrip/multiviagem, \"anual\" quando for plano anual sem limite de dias por viagem, \"unica\" quando cobrir uma única viagem; ' +
    '   seguroDias = dias consecutivos por viagem SOMENTE quando seguroModalidade=\"multiviagem\" (ex: \"MULTITRIP 30 DAYS\" -> \"30\"); ' +
    '   seguroTerritorio = validade territorial (ex: \"Internacional\", \"Europa (Schengen)\", \"America do Sul\", \"Brasil\", \"Mercosul\"); ' +
    '   seguroCobertura = capital segurado de despesas médicas e hospitalares, resumido (ex: \"EUR/USD 250.000\"); ' +
    '   seguroPax = quantidade de segurados nominados no documento; ' +
    '   seguroValor = valor TOTAL pago pelo cliente em reais, somando prêmio de seguro, IOF e custo de assistência (ex: \"1.690,65\"); ' +
    '   seguroEmergencia = telefone principal de emergência para acionamento no exterior. ' +
    '   Nunca classifique um bilhete de seguro viagem como voo, hotel, carro ou passeio. ' +
    '9) DATAS: se o documento não informar o ano de alguma data, use o ano atual (' + new Date().getFullYear() + '). ' +
    '   Toda data deve sair completa no formato YYYY-MM-DD — nunca retorne data sem ano. ' +
    '10) Retorne SOMENTE o JSON, sem explicações.' +
    (multiDoc
      ? ' 11) MULTIPLOS DOCUMENTOS DA MESMA RESERVA: nunca gere um JSON por documento — consolide todos em um so. ' +
        'trechos[] deve conter os segmentos de TODOS os documentos, ordenados cronologicamente (data + hora de partida); ' +
        'se um documento cobre a ida e outro a volta, os trechos de ambos entram no mesmo array. ' +
        'pax = passageiros DISTINTOS por nome considerando todos os documentos juntos — a mesma pessoa repetida em documentos diferentes conta uma unica vez. ' +
        'milhasTotal = soma das milhas de todos os documentos. ' +
        'Campos monetarios (valor, hotelValor, transferValor, carroValor, passeioValor, seguroValor) = soma total de todos os documentos. ' +
        'Campos de identificacao (pnr, hotelConf, transferConf, carroConf, passeioConf, seguroApolice): se os documentos trouxerem codigos diferentes, junte-os separados por virgula. ' +
        'Para os demais campos, se houver divergencia entre documentos, use o valor do documento mais completo e ignore campos vazios.'
      : '');

  // Completa o ano atual em datas que a IA retornou sem ano (ex: "12/03", "03-12", "--03-12")
  function normalizarAnoDatas(d) {
    const anoAtual = new Date().getFullYear();
    function fix(v) {
      if (!v || typeof v !== 'string') return v;
      const s = v.trim();
      if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s;                    // já tem ano
      let m = s.match(/^--(\d{2})-(\d{2})$/);                          // ISO sem ano: --MM-DD
      if (m) return anoAtual + '-' + m[1] + '-' + m[2];
      m = s.match(/^(\d{1,2})\/(\d{1,2})$/);                          // padrão BR: DD/MM
      if (m) return anoAtual + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
      m = s.match(/^(\d{2})-(\d{2})$/);                                // fragmento ISO: MM-DD
      if (m) return anoAtual + '-' + m[1] + '-' + m[2];
      return s;
    }
    if (Array.isArray(d.trechos)) d.trechos.forEach(t => { if (t) t.data = fix(t.data); });
    ['checkin', 'checkout', 'transferData', 'transferVoltaData', 'retData', 'devData', 'passeioData', 'dataIda', 'dataVolta', 'seguroInicio', 'seguroFim']
      .forEach(k => { if (d[k]) d[k] = fix(d[k]); });
    return d;
  }

  // Processar trechos no servidor para derivar conexao, destino final, etc.
  function processarTrechos(d) {
    if (!d.trechos || d.trechos.length === 0) return d;

    // Aeroportos da mesma cidade (para detectar conexão com troca de aeroporto)
    const mesmaCidade = [
      ['GRU','CGH','VCP'],   // São Paulo
      ['CDG','ORY','BVA'],   // Paris
      ['LHR','LGW','STN','LTN','LCY'], // Londres
      ['JFK','LGA','EWR'],   // Nova York
      ['FCO','CIA'],          // Roma
      ['MXP','LIN','BGY'],   // Milão
      ['TXL','SXF'],          // Berlim
      ['OSL','TRF'],          // Oslo
      ['STO','ARN','BMA','NYO'], // Estocolmo
    ];

    function mesmaCidadeCheck(a, b) {
      a = (a||'').toUpperCase(); b = (b||'').toUpperCase();
      if (a === b) return true;
      return mesmaCidade.some(g => g.includes(a) && g.includes(b));
    }

    function cabineToClasse(cabine) {
      if (!cabine) return '';
      const c = cabine.toLowerCase();
      if (c.includes('business') || c.includes('executiv')) return 'Executiva';
      if (c.includes('premium') && c.includes('econ')) return 'Econômica Premium';
      if (c.includes('first') || c.includes('primeira')) return 'Primeira Classe';
      return 'Econômica';
    }

    // Separar trechos de ida e volta
    // Ida: sequência do início; volta: quando destino de um trecho = origem do primeiro
    const origem0 = (d.trechos[0].origem||'').toUpperCase();
    let idxVolta = -1;
    for (let i = 1; i < d.trechos.length; i++) {
      if (mesmaCidadeCheck(d.trechos[i].origem, d.trechos[d.trechos.length-1].destino) &&
          mesmaCidadeCheck(d.trechos[i].destino, origem0)) {
        idxVolta = i; break;
      }
      // Se destino do último trecho da ida = origem do primeiro → é volta
      if (mesmaCidadeCheck(d.trechos[i].destino, origem0) && i === d.trechos.length - 1) {
        idxVolta = i; break;
      }
    }

    const trechosIda = idxVolta === -1 ? d.trechos : d.trechos.slice(0, idxVolta);
    const trechosVolta = idxVolta === -1 ? [] : d.trechos.slice(idxVolta);

    // Montar campos de ida
    const primeiro = trechosIda[0];
    const ultimo = trechosIda[trechosIda.length - 1];

    d.origem = primeiro.origem;
    d.destino = ultimo.destino;
    d.dataIda = primeiro.data;
    d.horaPartida = primeiro.horaPartida;
    d.horaChegada = ultimo.horaChegada;
    d.nvooIda = trechosIda.map(t => t.nvoo).filter(Boolean).join(', ');
    d.classe = cabineToClasse(primeiro.cabine);
    if (!d.ciaIda) d.ciaIda = trechosIda.map(t => t.cia).filter(Boolean)[0] || '';

    // Conexão na ida: destino do primeiro trecho (se há mais de um trecho)
    if (trechosIda.length > 1) {
      d.conexao = trechosIda[0].destino;
    }

    // Montar campos de volta
    if (trechosVolta.length > 0) {
      const primeiroV = trechosVolta[0];
      const ultimoV = trechosVolta[trechosVolta.length - 1];
      d.dataVolta = primeiroV.data;
      d.horaPartidaVolta = primeiroV.horaPartida;
      d.horaChegadaVolta = ultimoV.horaChegada;
      d.nvooVolta = trechosVolta.map(t => t.nvoo).filter(Boolean).join(', ');
      d.ciaVolta = d.ciaVolta || d.ciaIda;
      if (trechosVolta.length > 1) {
        d.conexaoVolta = trechosVolta[0].destino;
      }
    }

    // Milhas por passageiro
    if (d.milhasTotal && d.pax) {
      d.milhas = String(Math.round(d.milhasTotal / d.pax));
    }

    return d;
  }

  const contentBlocks = [];
  docs.forEach((d, i) => {
    const rotulo = 'DOCUMENTO ' + (i + 1) + ' de ' + docs.length + (d.nome ? ' — ' + d.nome : '');
    if (d.kind === 'texto') {
      contentBlocks.push({
        type: 'text',
        text: (multiDoc ? rotulo + ' (texto extraído de arquivo HTML):' : 'CONTEÚDO DO DOCUMENTO (texto extraído de arquivo HTML):')
              + '\n"""\n' + d.texto + '\n"""'
      });
      return;
    }
    if (multiDoc) contentBlocks.push({ type: 'text', text: rotulo + ':' });
    if (d.kind === 'pdf') {
      contentBlocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: d.base64 } });
    } else {
      contentBlocks.push({ type: 'image', source: { type: 'base64', media_type: d.mediaType, data: d.base64 } });
    }
  });

  const bodyPayload = JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: multiDoc ? 4096 : 2048,
    messages: [{ role: 'user', content: contentBlocks.concat([{ type: 'text', text: prompt }]) }]
  });

  const https = require('https');
  const options = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(bodyPayload),
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    }
  };

  const apiReq = https.request(options, (apiRes) => {
    let raw = '';
    apiRes.on('data', (chunk) => { raw += chunk; });
    apiRes.on('end', () => {
      console.log('[ia/extrair-reserva] status:', apiRes.statusCode, 'len:', raw.length);
      try {
        const parsed = JSON.parse(raw);
        if (parsed.error) return res.json({ ok: false, erro: parsed.error.message });
        const texto = (parsed.content && parsed.content[0] && parsed.content[0].text) || '';
        const textoClean = texto.replace(/```json|```/g, '').trim();
        try {
          const dadosRaw = JSON.parse(textoClean);
          const dadosProcessados = processarTrechos(normalizarAnoDatas(dadosRaw));
          return res.json({ ok: true, texto: JSON.stringify(dadosProcessados) });
        } catch(e) {
          return res.json({ ok: true, texto: textoClean });
        }
      } catch (e) {
        return res.json({ ok: false, erro: 'Resposta inválida: ' + raw.slice(0, 300) });
      }
    });
  });

  apiReq.on('error', (e) => {
    console.error('[ia/extrair-reserva] erro:', e.message);
    return res.json({ ok: false, erro: e.message });
  });

  const timeoutMs = multiDoc ? 110000 : 55000;
  apiReq.setTimeout(timeoutMs, () => {
    apiReq.destroy();
    return res.json({ ok: false, erro: 'Timeout (>' + Math.round(timeoutMs / 1000) + 's) ao chamar API Anthropic.' });
  });

  apiReq.write(bodyPayload);
  apiReq.end();
});

// ── CONCIERGE: Reservas e Viagens ──────────────────────────────

const CONCIERGE_REPO = 'davileles/concierge';

async function getConciergeFile(filename) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    // Primeiro buscar SHA via API normal
    const optsMeta = {
      hostname: 'api.github.com',
      path: `/repos/${CONCIERGE_REPO}/contents/${filename}`,
      headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'cdv-proxy', 'Accept': 'application/vnd.github+json' }
    };
    https.get(optsMeta, (resMeta) => {
      let rawMeta = '';
      resMeta.on('data', d => rawMeta += d);
      resMeta.on('end', () => {
        try {
          const meta = JSON.parse(rawMeta);
          const fileSha = meta.sha;
          // Se arquivo pequeno e tem content, usar diretamente
          if (meta.content && meta.encoding === 'base64') {
            const content = JSON.parse(Buffer.from(meta.content.replace(/\n/g,''), 'base64').toString('utf-8'));
            return resolve({ content, sha: fileSha });
          }
          // Arquivo grande (>1MB): Contents API com Accept:raw
          // (não usa raw.githubusercontent.com, que quebra se o repo for privado)
          const optsRaw = {
            hostname: 'api.github.com',
            path: `/repos/${CONCIERGE_REPO}/contents/${filename}`,
            headers: {
              'Authorization': `token ${GITHUB_TOKEN}`,
              'User-Agent': 'cdv-proxy',
              'Accept': 'application/vnd.github.raw'
            }
          };
          https.get(optsRaw, (resRaw) => {
            let rawData = '';
            resRaw.on('data', d => rawData += d);
            resRaw.on('end', () => {
              try {
                const content = JSON.parse(rawData);
                resolve({ content, sha: fileSha });
              } catch(e) { reject(e); }
            });
          }).on('error', reject);
        } catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function putConciergeFile(filename, content, sha) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const body = JSON.stringify({
      message: `update: ${filename}`,
      content: Buffer.from(JSON.stringify(content, null, 2)).toString('base64'),
      sha
    });
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${CONCIERGE_REPO}/contents/${filename}`,
      method: 'PUT',
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'User-Agent': 'cdv-proxy',
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(raw); } catch(e) { return reject(new Error('Resposta inválida do GitHub')); }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(parsed);
        const err = new Error(parsed.message || `GitHub PUT falhou (status ${res.statusCode})`);
        err.status = res.statusCode;
        reject(err);
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Preserva as marcas de envio automático gravadas pelo lembrete-voo.js.
// O painel do concierge salva sempre o array inteiro que tem em memória
// (read-modify-write); se a Action gravou uma flag `enviado_*` depois que a
// página carregou, esse save apagaria a flag e a mensagem seria reenviada na
// execução seguinte. O arquivo remoto é sempre a fonte autoritativa dessas
// chaves — o payload do front nunca vence.
function preservarFlagsEnvio(remoto, novo) {
  if (!Array.isArray(remoto) || !Array.isArray(novo)) return novo;
  const porId = new Map();
  for (const item of remoto) if (item && item.id) porId.set(item.id, item);
  let preservadas = 0;
  for (const item of novo) {
    if (!item || !item.id) continue;
    const antigo = porId.get(item.id);
    if (!antigo) continue;
    for (const k of Object.keys(antigo)) {
      if (!k.startsWith('enviado_')) continue;
      if (item[k] !== antigo[k]) { item[k] = antigo[k]; preservadas++; }
    }
  }
  if (preservadas) console.log(`[concierge] ${preservadas} marca(s) de envio preservada(s)`);
  return novo;
}

// GET /concierge/reservas
app.get('/concierge/reservas', async (req, res) => {
  try {
    const { content } = await getConciergeFile('reservas.json');
    res.json({ ok: true, data: content });
  } catch(e) {
    console.error('[concierge/reservas GET]', e.message);
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// POST /concierge/reservas
app.post('/concierge/reservas', async (req, res) => {
  const { data } = req.body;
  if (!Array.isArray(data)) return res.status(400).json({ ok: false, erro: 'data deve ser um array' });
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    try {
      const { content: remoto, sha } = await getConciergeFile('reservas.json');
      await putConciergeFile('reservas.json', preservarFlagsEnvio(remoto, data), sha);
      return res.json({ ok: true });
    } catch(e) {
      // 409 = SHA desatualizado (outra escrita concorrente venceu a corrida) — busca SHA fresco e tenta de novo
      if (e.status === 409 && tentativa < 2) continue;
      console.error('[concierge/reservas POST]', e.message);
      return res.status(500).json({ ok: false, erro: e.message });
    }
  }
});

// GET /concierge/viagens
app.get('/concierge/viagens', async (req, res) => {
  try {
    const { content } = await getConciergeFile('viagens.json');
    res.json({ ok: true, data: content });
  } catch(e) {
    console.error('[concierge/viagens GET]', e.message);
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// POST /concierge/viagens
app.post('/concierge/viagens', async (req, res) => {
  const { data } = req.body;
  if (!Array.isArray(data)) return res.status(400).json({ ok: false, erro: 'data deve ser um array' });
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    try {
      const { content: remoto, sha } = await getConciergeFile('viagens.json');
      await putConciergeFile('viagens.json', preservarFlagsEnvio(remoto, data), sha);
      return res.json({ ok: true });
    } catch(e) {
      // 409 = SHA desatualizado (outra escrita concorrente venceu a corrida) — busca SHA fresco e tenta de novo
      if (e.status === 409 && tentativa < 2) continue;
      console.error('[concierge/viagens POST]', e.message);
      return res.status(500).json({ ok: false, erro: e.message });
    }
  }
});

// ── Demandas avulsas (sem viagem vinculada) ─────────────────────────
// Demandas espelhadas de atividades de viagem continuam vivendo em viagens.json.
// Aqui ficam apenas as que não têm viagemId — ex.: alerta de assinatura bonificada
// que atende vários clientes de uma vez.

// GET /concierge/demandas
app.get('/concierge/demandas', async (req, res) => {
  try {
    const { content } = await getConciergeFile('demandas.json');
    res.json({ ok: true, data: Array.isArray(content) ? content : [] });
  } catch(e) {
    console.error('[concierge/demandas GET]', e.message);
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// POST /concierge/demandas
app.post('/concierge/demandas', async (req, res) => {
  const { data } = req.body;
  if (!Array.isArray(data)) return res.status(400).json({ ok: false, erro: 'data deve ser um array' });
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    try {
      const { sha } = await getConciergeFile('demandas.json');
      await putConciergeFile('demandas.json', data, sha);
      return res.json({ ok: true });
    } catch(e) {
      // 409 = SHA desatualizado (escrita concorrente venceu a corrida) — refaz com SHA fresco
      if (e.status === 409 && tentativa < 2) continue;
      console.error('[concierge/demandas POST]', e.message);
      return res.status(500).json({ ok: false, erro: e.message });
    }
  }
});

// GET /concierge/portal?email=x — dados do cliente para o portal de acompanhamento
app.get('/concierge/portal', async (req, res) => {
  const email = (req.query.email || '').toLowerCase().trim();
  if (!email) return res.status(400).json({ ok: false, erro: 'email obrigatório' });

  try {
    // 1. Buscar cfg para obter URL do Apps Script e configuração de colunas
    const CONCIERGE_REPO = 'davileles/concierge';
    const ghHeaders = { 'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json' };

    const cfgRes = await fetch(`https://api.github.com/repos/${CONCIERGE_REPO}/contents/cfg.json`, { compress: false, headers: ghHeaders });
    const cfgData = await cfgRes.json();
    const cfg = JSON.parse(Buffer.from(cfgData.content, 'base64').toString('utf8'));

    if (!cfg.url) return res.status(400).json({ ok: false, erro: 'Apps Script não configurado' });

    // 2. Buscar clientes do Apps Script
    const sheetUrl = cfg.url + '?aba=' + encodeURIComponent(cfg.aba || 'Clientes') + '&linha=' + (cfg.linha || 2);
    const sheetRes = await fetch(sheetUrl);
    const sheetData = await sheetRes.json();

    function colIdx(letra) {
      const s = (letra || 'A').toUpperCase().trim();
      let r = 0;
      for (let i = 0; i < s.length; i++) r = r * 26 + (s.charCodeAt(i) - 64);
      return r - 1;
    }

    const rows = sheetData.rows || [];
    // Encontrar clientes cujo e-mail corresponde
    const clientesMatch = rows
      .map(row => ({
        nome: String(row[colIdx(cfg.colNome)] || '').trim(),
        email: String(row[colIdx(cfg.colEmail)] || '').trim().toLowerCase(),
      }))
      .filter(c => c.email === email && c.nome);

    if (!clientesMatch.length) {
      return res.json({ ok: true, clientes: [], viagens: [], reservas: [] });
    }

    const nomesCliente = clientesMatch.map(c => {
      const partes = c.nome.trim().split(/\s+/);
      return (partes[0].charAt(0).toUpperCase() + partes[0].slice(1).toLowerCase()) + 
             (partes[1] ? ' ' + partes[1].charAt(0).toUpperCase() + partes[1].slice(1).toLowerCase() : '');
    });

    // 3. Buscar viagens e reservas do GitHub
    const [viagensRes, reservasRes] = await Promise.all([
      fetch(`https://api.github.com/repos/${CONCIERGE_REPO}/contents/viagens.json`, { compress: false, headers: ghHeaders }),
      fetch(`https://api.github.com/repos/${CONCIERGE_REPO}/contents/reservas.json`, { compress: false, headers: ghHeaders }),
    ]);
    const viagensData = await viagensRes.json();
    const reservasData = await reservasRes.json();
    const todasViagens  = JSON.parse(Buffer.from(viagensData.content,  'base64').toString('utf8'));
    const todasReservas = JSON.parse(Buffer.from(reservasData.content, 'base64').toString('utf8'));

    // 4. Filtrar por nome do cliente (normalizado)
    function nomeMatch(nome) {
      if (!nome) return false;
      const partes = nome.trim().split(/\s+/);
      const norm = (partes[0].charAt(0).toUpperCase() + partes[0].slice(1).toLowerCase()) +
                   (partes[1] ? ' ' + partes[1].charAt(0).toUpperCase() + partes[1].slice(1).toLowerCase() : '');
      return nomesCliente.includes(norm);
    }

    const viagens = todasViagens.filter(v => {
      const clis = Array.isArray(v.clientes) ? v.clientes : [v.clientes];
      return clis.some(nomeMatch);
    });

    const reservas = todasReservas.filter(r => nomeMatch(r.cliente));

    res.json({ ok: true, clientes: clientesMatch, nomesCliente, viagens, reservas });
  } catch(e) {
    console.error('[concierge/portal]', e.message);
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// GET /concierge/cfg
app.get('/concierge/cfg', async (req, res) => {
  try {
    const { content } = await getConciergeFile('cfg.json');
    res.json({ ok: true, data: content });
  } catch(e) {
    res.json({ ok: true, data: {} });
  }
});

// POST /concierge/cfg
app.post('/concierge/cfg', async (req, res) => {
  const { data } = req.body;
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    try {
      let sha = null;
      try { ({ sha } = await getConciergeFile('cfg.json')); } catch(e) {}
      await putConciergeFile('cfg.json', data, sha);
      return res.json({ ok: true });
    } catch(e) {
      // 409 = SHA desatualizado (outra escrita concorrente venceu a corrida) — busca SHA fresco e tenta de novo
      if (e.status === 409 && tentativa < 2) continue;
      console.error('[concierge/cfg POST]', e.message);
      return res.status(500).json({ ok: false, erro: e.message });
    }
  }
});

// GET /concierge/modelos
app.get('/concierge/modelos', async (req, res) => {
  try {
    const { content } = await getConciergeFile('modelos.json');
    res.json({ ok: true, data: content });
  } catch(e) {
    res.json({ ok: true, data: [] });
  }
});

// POST /concierge/modelos
app.post('/concierge/modelos', async (req, res) => {
  try {
    const { data } = req.body;
    if (!Array.isArray(data)) return res.status(400).json({ ok: false, erro: 'data deve ser um array' });
    let sha = null;
    try { ({ sha } = await getConciergeFile('modelos.json')); } catch(e) {}
    await putConciergeFile('modelos.json', data, sha);
    res.json({ ok: true });
  } catch(e) {
    console.error('[concierge/modelos POST]', e.message);
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// GET /concierge/msgs-enviadas — log de mensagens automáticas já enviadas
app.get('/concierge/msgs-enviadas', async (req, res) => {
  try {
    const { content } = await getConciergeFile('msgs-enviadas.json');
    res.json({ ok: true, data: content });
  } catch(e) {
    res.json({ ok: true, data: [] }); // arquivo ainda não existe = nenhum envio
  }
});

// POST /concierge/msgs-enviadas — salva log de mensagens automáticas
app.post('/concierge/msgs-enviadas', async (req, res) => {
  try {
    const { data } = req.body;
    // Array = formato legado; objeto { "MOD-x|RES-y": timestamp } = ledger atual
    if (!data || typeof data !== 'object') return res.status(400).json({ ok: false, erro: 'data deve ser um array ou objeto' });
    let sha = null;
    try { ({ sha } = await getConciergeFile('msgs-enviadas.json')); } catch(e) {}
    await putConciergeFile('msgs-enviadas.json', data, sha);
    res.json({ ok: true });
  } catch(e) {
    console.error('[concierge/msgs-enviadas POST]', e.message);
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// GET /parceiros — lista parceiros do snapshot filtrados por categoria viagem
const PARCEIROS_VIAGEM = new Set([
  // ✈️ Aéreo / Transporte
  'clickbus', 'flixbus', 'quero passagem', 'uber',
  // 🏨 Hospedagem
  'booking', 'decolar', 'hoteis.com', 'hotel nacional', 'hope resort',
  'beach park hospedagens', 'summerville', 'wala place', 'grupo dreams', 'luxury loyalty',
  // 🚗 Locação de Carro
  'avis', 'budget', 'hertz', 'localiza internacional', 'localiza meoo',
  'movida', 'rentcars', 'reservecar', 'sixt', 'unidas',
  // 🎯 Passeios / Entretenimento
  'agaxtur cruzeiros', 'agaxtur viagens e turismo', 'beach park ingressos',
  'beto carrero world', 'civitatis', 'easy live entreterimento',
  'horas mágicas', 'hot beach', 'mundos infinitos', 'seus ingressos', 'viajar',
  // 🛡️ Seguros de Viagem
  'allianz travel', 'assist card', 'ciclic seguro viagem', 'coris',
  'hero seguro viagem', 'liga vitória - seguro de viagem', 'next seguro viagem',
  'seguro viagem bradesco', 'sulamérica seguro viagem', 'tokio marine seguros',
  'universal assistance – seguro viagem',
  // 🧳 Acessórios e Serviços de Viagem
  'airport park', 'airport park - guarulhos', 'bagaggio', 'portal das malas',
  'samsonite', 'thule', 'travelex', 'tripchip', 'wavee, seu esim global', 'nomad'
]);

app.get('/parceiros', async (req, res) => {
  try {
    const filtroViagem = req.query.viagem !== 'false'; // padrão: filtra por viagem
    // ghGetJson já trata arquivos >1MB (Accept:raw) e autentica — historico.json cresce continuamente
    const { data: historico } = await ghGetJson('historico.json', {});
    const dates = Object.keys(historico).sort();
    const last = historico[dates[dates.length - 1]] || {};
    let parceiros = Object.entries(last)
      .filter(([nome]) => !filtroViagem || PARCEIROS_VIAGEM.has(nome))
      .map(([nome, info]) => ({
        nome,
        programas: typeof info === 'object' && info.programs ? Object.keys(info.programs) : []
      }))
      .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
    res.json({ ok: true, data: parceiros, atualizadoEm: dates[dates.length - 1] });
  } catch(e) {
    console.error('[/parceiros]', e.message);
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════
//  ALERTAS DE OPORTUNIDADE DO CONCIERGE
//  Vivem em davileles/concierge/alertas-concierge.json. Cada alerta está
//  amarrado a uma atividade de viagem pelo campo `id` (a atividade guarda
//  o mesmo valor em `alertaId`), e tem um alvo:
//    • compra_bonificada → avaliado pelo coletar.js contra o snapshot
//      Comparemania; o disparo chega aqui por POST /concierge/alerta/disparar
//    • transferencia     → avaliado aqui mesmo, em POST /ofertas/aprovar
//  O grupo de WhatsApp NÃO fica gravado no alerta: é lido de cfg.json
//  (campo grupoAlertas) no momento do envio, para refletir sempre a
//  configuração atual da aba Configuração do concierge.
//  Alertas são consumidos (removidos) após o envio.
// ══════════════════════════════════════════════════════════════════
const ALERTAS_CONCIERGE_FILE = 'alertas-concierge.json';
// BAILEYS_URL já declarado acima (bloco do radar)

function alvoDoAlerta(al) {
  const a = al && al.alvo;
  if (a === 'transferencia') return 'transferencia';
  if (a === 'lembrete') return 'lembrete';
  return 'compra_bonificada';
}

function fmtDataBRAlerta(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).split('-');
  return (d && m && y) ? `${d}/${m}/${y}` : String(iso);
}

// Timestamp (ms) do disparo de um lembrete. Brasil nao tem mais horario de verao,
// entao -03:00 fixo e seguro — mesmo criterio usado pelo lembrete-voo.js.
function tsLembrete(al) {
  if (!al || !al.dataLembrete) return null;
  const hora = /^\d{2}:\d{2}$/.test(al.horaLembrete || '') ? al.horaLembrete : '09:00';
  const t = new Date(`${al.dataLembrete}T${hora}:00-03:00`).getTime();
  return isNaN(t) ? null : t;
}

async function lerAlertasConcierge() {
  try {
    const { content, sha } = await getConciergeFile(ALERTAS_CONCIERGE_FILE);
    return { alertas: Array.isArray(content) ? content : [], sha };
  } catch (e) {
    return { alertas: [], sha: null };
  }
}

function montarMsgAlertaConcierge(al, dados) {
  const d = dados || {};
  const alvo = alvoDoAlerta(al);
  const linhas = [];

  if (alvo === 'lembrete') {
    linhas.push('*Lembrete agendado*', '');
    linhas.push(al.textoLembrete || al.demandaTitulo || al.atividadeTitulo || 'Lembrete');
    if (al.dataLembrete) {
      linhas.push(`*Programado para:* ${fmtDataBRAlerta(al.dataLembrete)}${al.horaLembrete ? ' às ' + al.horaLembrete : ''}`);
    }
  } else if (alvo === 'transferencia') {
    linhas.push('*Oportunidade para uma demanda*', '');
    linhas.push(`*Transferência bonificada:* ${d.origem || al.origem || 'Qualquer origem'} → ${d.destino || al.destino || '—'}`);
    linhas.push(`*Bônus:* ${d.bonus}% (mínimo configurado: ${al.bonusMin}%)`);
    if (d.prazo) linhas.push(`*Prazo:* ${d.prazo}`);
    if (d.titulo) linhas.push(`*Oferta:* ${d.titulo}`);
  } else {
    linhas.push('*Oportunidade para uma demanda*', '');
    linhas.push(`*Compra bonificada:* ${al.parceiro} · ${al.programa}`);
    linhas.push(`*Pontuação atual:* ${d.pts} pts/R$ (mínimo configurado: ${al.minPts})`);
  }

  // Contexto do vinculo: demanda e/ou atividade de viagem (campos opcionais)
  const ctx = [];
  if (al.demandaNumero) ctx.push(`*Demanda:* #${String(al.demandaNumero).padStart(3, '0')}${al.demandaTitulo ? ' — ' + al.demandaTitulo : ''}`);
  if (al.clientes) ctx.push(`*Cliente:* ${al.clientes}`);
  if (al.viagemNome) ctx.push(`*Viagem:* ${al.viagemNome}`);
  if (al.atividadeTitulo || al.atividadeNome) ctx.push(`*Atividade:* ${al.atividadeTitulo || al.atividadeNome}`);
  if (al.atividadeTitulo && al.atividadeNome) ctx.push(`*Tipo:* ${al.atividadeNome}`);
  if (al.atividadeDescricao) ctx.push(`*Detalhes:* ${al.atividadeDescricao}`);
  if (ctx.length) { linhas.push(''); ctx.forEach((l) => linhas.push(l)); }

  linhas.push('');
  linhas.push(alvo === 'lembrete'
    ? 'Hora de executar essa tarefa.'
    : 'Essa oferta atende a uma necessidade do cliente — vale avaliar agora.');
  return linhas.join('\n');
}

// Envia o alerta para o grupo fixo configurado e consome (remove) o alerta.
async function dispararAlertaConcierge(alertaId, dados) {
  const { alertas, sha } = await lerAlertasConcierge();
  const al = alertas.find((a) => a.id === alertaId);
  if (!al) return { ok: false, erro: 'Alerta não encontrado (pode já ter sido disparado)' };

  let grupo = '';
  try {
    const { content: cfg } = await getConciergeFile('cfg.json');
    grupo = (cfg && cfg.grupoAlertas) || '';
  } catch (e) {}
  if (!grupo) return { ok: false, erro: 'grupoAlertas não configurado (aba Configuração do concierge)' };

  const rw = await fetch(`${BAILEYS_URL}/enviar`, {
    compress: false,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grupo, mensagem: montarMsgAlertaConcierge(al, dados) })
  });
  if (!rw.ok) throw new Error(`Baileys respondeu ${rw.status}`);

  // Alerta consumido após o envio
  await putConciergeFile(ALERTAS_CONCIERGE_FILE, alertas.filter((a) => a.id !== alertaId), sha);
  console.log(`[concierge/alerta] disparado ${alertaId} → ${grupo}`);
  return { ok: true, grupo };
}

// Avalia alertas de transferência quando uma oferta do Radar é aprovada.
async function verificarAlertasTransferencia(item) {
  if (!item || item.categoria !== 'transferencia') return;
  if (!item.destino || item.bonusMax === undefined || item.bonusMax === null || item.bonusMax === '') return;

  const { alertas } = await lerAlertasConcierge();
  const destinoItem = normalizarChaveHist(item.destino);
  const origemItem  = normalizarChaveHist(item.origem);
  const bonus = Number(item.bonusMax);

  const atingidos = alertas.filter((al) => {
    if (alvoDoAlerta(al) !== 'transferencia') return false;
    if (normalizarChaveHist(al.destino) !== destinoItem) return false;
    const origemAl = normalizarChaveHist(al.origem);
    // Alerta sem origem = qualquer origem. Oferta com origem "Todos" vale para todas.
    const origemBate = !origemAl || origemAl === 'todos' || origemItem === 'todos' || origemAl === origemItem;
    if (!origemBate) return false;
    return bonus >= Number(al.bonusMin);
  });

  for (const al of atingidos) {
    try {
      const r = await dispararAlertaConcierge(al.id, {
        origem: item.origem, destino: item.destino,
        bonus, prazo: item.prazo || '', titulo: item.titulo || ''
      });
      if (!r.ok) console.error('[Alertas concierge] Não enviado:', al.id, r.erro);
    } catch (e) {
      console.error('[Alertas concierge] Erro ao disparar', al.id, e.message);
    }
  }
}

// Procura algo JÁ ATIVO que atenda o alerta no momento em que ele é criado.
// Sem isso, um alerta criado depois de a campanha entrar no ar só dispararia
// na próxima coleta (compra bonificada) ou nunca (transferência, cujo gatilho
// é a aprovação da oferta). Retorna os dados do disparo, ou null.
async function checarOportunidadeAtual(al) {
  // Lembrete nao depende de oferta: so dispara na hora se a data ja passou
  // (util para lembrete criado com data retroativa ou para hoje mais cedo).
  if (alvoDoAlerta(al) === 'lembrete') {
    const ts = tsLembrete(al);
    return (ts !== null && ts <= Date.now()) ? { vencido: true } : null;
  }
  if (alvoDoAlerta(al) === 'transferencia') {
    const { data: ofertas } = await ghGetJson(OFERTAS_APROVADAS_PATH, { items: [] });
    const hoje = new Date().toISOString().slice(0, 10);
    const limite7d = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const destinoAl = normalizarChaveHist(al.destino);
    const origemAl  = normalizarChaveHist(al.origem);
    for (const item of (ofertas.items || [])) {
      if (item.categoria !== 'transferencia' || item.semHistorico) continue;
      if (!item.destino || item.bonusMax === undefined || item.bonusMax === null || item.bonusMax === '') continue;
      if (normalizarChaveHist(item.destino) !== destinoAl) continue;
      const origemItem = normalizarChaveHist(item.origem);
      const origemBate = !origemAl || origemAl === 'todos' || origemItem === 'todos' || origemAl === origemItem;
      if (!origemBate) continue;
      if (Number(item.bonusMax) < Number(al.bonusMin)) continue;
      // Vigência: prazo ainda no futuro; sem prazo, aceita se publicada nos últimos 7 dias
      const prazoIso = prazoParaIso(item.prazo);
      const vigente = prazoIso ? prazoIso >= hoje : (item.publicadoEm || '').slice(0, 10) >= limite7d;
      if (!vigente) continue;
      return { origem: item.origem, destino: item.destino, bonus: Number(item.bonusMax), prazo: item.prazo || '', titulo: item.titulo || '' };
    }
    return null;
  }
  // Compra bonificada: último snapshot do histórico (mesma fonte usada pelo coletar.js)
  const { data: historico } = await ghGetJson('historico.json', {});
  const dias = Object.keys(historico).sort();
  const snap = (historico[dias[dias.length - 1]] || {})[(al.parceiro || '').toLowerCase().trim()];
  if (!snap || !snap.programs) return null;
  const pd = snap.programs[al.programa];
  const pts = (pd && typeof pd === 'object') ? pd.pts : pd;
  if (!pts || Number(pts) < Number(al.minPts)) return null;
  return { pts };
}

// POST /concierge/alerta — cria/atualiza alerta de oportunidade
app.post('/concierge/alerta', async (req, res) => {
  const b = req.body || {};
  const alvo = b.alvo === 'transferencia' ? 'transferencia'
             : b.alvo === 'lembrete'      ? 'lembrete'
             : 'compra_bonificada';
  if (alvo === 'transferencia') {
    if (!b.destino || b.bonusMin === undefined || b.bonusMin === null || b.bonusMin === '') {
      return res.status(400).json({ ok: false, erro: 'Campos obrigatórios: destino, bonusMin' });
    }
  } else if (alvo === 'lembrete') {
    if (!b.dataLembrete || !/^\d{4}-\d{2}-\d{2}$/.test(String(b.dataLembrete)) || !String(b.textoLembrete || '').trim()) {
      return res.status(400).json({ ok: false, erro: 'Campos obrigatórios: dataLembrete (YYYY-MM-DD), textoLembrete' });
    }
  } else if (!b.parceiro || !b.programa || !b.minPts) {
    return res.status(400).json({ ok: false, erro: 'Campos obrigatórios: parceiro, programa, minPts' });
  }
  try {
    const { alertas, sha } = await lerAlertasConcierge();
    const id = b.id || ('ALT-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
    const novo = {
      id,
      alvo,
      parceiro: b.parceiro || '',
      programa: b.programa || '',
      minPts: (b.minPts !== undefined && b.minPts !== '' && b.minPts !== null) ? parseFloat(b.minPts) : null,
      origem: b.origem || '',
      destino: b.destino || '',
      bonusMin: (b.bonusMin !== undefined && b.bonusMin !== '' && b.bonusMin !== null) ? parseFloat(b.bonusMin) : null,
      dataLembrete: b.dataLembrete || '',
      horaLembrete: /^\d{2}:\d{2}$/.test(b.horaLembrete || '') ? b.horaLembrete : (alvo === 'lembrete' ? '09:00' : ''),
      textoLembrete: (b.textoLembrete || '').trim(),
      // Vinculo: 'atividade' (modal da viagem) ou 'demanda' (modal de demandas).
      // Demanda espelhada de atividade tem os dois conjuntos de campos preenchidos.
      vinculo: b.vinculo || (b.demandaId ? 'demanda' : 'atividade'),
      demandaId: b.demandaId || '',
      demandaNumero: b.demandaNumero || '',
      demandaTitulo: b.demandaTitulo || '',
      clientes: b.clientes || '',
      viagemId: b.viagemId || '',
      viagemNome: b.viagemNome || '',
      atividadeNome: b.atividadeNome || '',
      atividadeTitulo: b.atividadeTitulo || '',
      atividadeDescricao: b.atividadeDescricao || '',
      criadoEm: new Date().toISOString()
    };
    const idx = alertas.findIndex((a) => a.id === id);
    if (idx >= 0) {
      alertas[idx] = { ...alertas[idx], ...novo, criadoEm: alertas[idx].criadoEm || novo.criadoEm, atualizadoEm: new Date().toISOString() };
    } else {
      alertas.push(novo);
    }
    await putConciergeFile(ALERTAS_CONCIERGE_FILE, alertas, sha);

    // Já existe algo ativo que atende? Dispara na hora (e consome o alerta).
    let disparadoAgora = false;
    try {
      const dados = await checarOportunidadeAtual(novo);
      if (dados) {
        const r = await dispararAlertaConcierge(id, dados);
        disparadoAgora = !!r.ok;
        if (!r.ok) console.error('[concierge/alerta] oportunidade ativa encontrada mas não enviada:', r.erro);
      }
    } catch(e) {
      console.error('[concierge/alerta] checagem imediata falhou:', e.message);
    }

    res.json({ ok: true, id, disparadoAgora });
  } catch(e) {
    console.error('[concierge/alerta POST]', e.message);
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// GET /concierge/alertas — lista alertas de oportunidade do concierge
app.get('/concierge/alertas', async (req, res) => {
  const { alertas } = await lerAlertasConcierge();
  res.json({ ok: true, data: alertas });
});

// DELETE /concierge/alerta — remove alerta por id
app.delete('/concierge/alerta', async (req, res) => {
  const { id, parceiro, programa, viagemId } = req.body || {};
  try {
    const { alertas, sha } = await lerAlertasConcierge();
    const restantes = id
      ? alertas.filter((a) => a.id !== id)
      : alertas.filter((a) => !(a.parceiro === parceiro && a.programa === programa && a.viagemId === viagemId));
    await putConciergeFile(ALERTAS_CONCIERGE_FILE, restantes, sha);
    res.json({ ok: true });
  } catch(e) {
    console.error('[concierge/alerta DELETE]', e.message);
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════
//  LEMBRETES COM DATA MARCADA (alvo = 'lembrete')
//  Nao dependem de oferta nenhuma: disparam quando a data/hora chega.
//  Criterio e "venceu e ainda nao disparou" (nao e janela de tempo), entao
//  atraso do worker so adia o envio — nunca perde um lembrete. O alerta e
//  consumido no envio, o que ja serve de deduplicacao.
//  O coletar.js ignora estes alertas: filtra alvo !== 'compra_bonificada'.
// ══════════════════════════════════════════════════════════════════
let _lembretesRodando = false;

async function checarLembretes() {
  if (_lembretesRodando) return { ok: true, pulado: 'execução anterior em andamento' };
  _lembretesRodando = true;
  const enviados = [], falhas = [];
  try {
    const { alertas } = await lerAlertasConcierge();
    const agora = Date.now();
    const vencidos = alertas.filter((al) => {
      if (alvoDoAlerta(al) !== 'lembrete') return false;
      const ts = tsLembrete(al);
      return ts !== null && ts <= agora;
    });
    // Sequencial de proposito: dispararAlertaConcierge re-le o arquivo (SHA fresco)
    // a cada chamada, entao paralelizar geraria 409 no PUT.
    for (const al of vencidos) {
      try {
        const r = await dispararAlertaConcierge(al.id, {});
        if (r.ok) enviados.push(al.id);
        else falhas.push({ id: al.id, erro: r.erro });
      } catch (e) {
        falhas.push({ id: al.id, erro: e.message });
      }
    }
    if (enviados.length || falhas.length) {
      console.log(`[lembretes] enviados=${enviados.length} falhas=${falhas.length}`);
    }
    return { ok: true, enviados, falhas };
  } catch (e) {
    console.error('[lembretes] erro:', e.message);
    return { ok: false, erro: e.message };
  } finally {
    _lembretesRodando = false;
  }
}

// POST /concierge/lembretes/checar — disparo manual/backup (o worker roda sozinho)
app.post('/concierge/lembretes/checar', async (req, res) => {
  res.json(await checarLembretes());
});

// Worker interno: o proxy ja e always-on, entao nao depende do cron do GitHub
// Actions (que ja apresentou gaps de ~4h). 10 min da pontualidade suficiente
// para um lembrete com hora marcada.
setInterval(() => { checarLembretes().catch(() => {}); }, 10 * 60 * 1000);
setTimeout(() => { checarLembretes().catch(() => {}); }, 60 * 1000);

// Dispatcher: dispara a Action lembrete-voo do concierge a cada 30 min via
// workflow_dispatch. Motivo: o cron do GitHub roda com atraso de 2-3h (e as
// vezes cancela jobs), o que ja fez o alerta de check-in (janela 24h→20h)
// perder a janela. O ledger msgs-enviadas.json deduplica, entao rodar em
// paralelo com o cron do GitHub nao gera envio duplicado.
// Requer que o GITHUB_TOKEN tenha permissao Actions:write em davileles/concierge.
async function dispararLembreteVoo() {
  if (!GITHUB_TOKEN) return;
  try {
    const r = await fetch('https://api.github.com/repos/davileles/concierge/actions/workflows/lembrete-voo.yml/dispatches', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'cdv-proxy'
      },
      body: JSON.stringify({ ref: 'main' })
    });
    if (r.status !== 204) {
      console.error('[lembrete-voo dispatch] falhou:', r.status, (await r.text()).slice(0, 200));
    }
  } catch (e) {
    console.error('[lembrete-voo dispatch] erro:', e.message);
  }
}
setInterval(() => { dispararLembreteVoo(); }, 30 * 60 * 1000);
setTimeout(() => { dispararLembreteVoo(); }, 90 * 1000);

// POST /concierge/alerta/disparar — usado pelo coletar.js (alvo=compra_bonificada)
app.post('/concierge/alerta/disparar', async (req, res) => {
  const { id, pts } = req.body || {};
  if (!id) return res.status(400).json({ ok: false, erro: 'Campo obrigatório: id' });
  try {
    const r = await dispararAlertaConcierge(id, { pts });
    res.json(r);
  } catch(e) {
    console.error('[concierge/alerta/disparar]', e.message);
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════
//  Open Graph para roteiros publicados
//  O crawler do WhatsApp/Telegram nao executa JS, entao titulo,
//  descricao e imagem precisam estar no HTML estatico.
// ══════════════════════════════════════════════════════════════════
const ROTEIROS_BASE_URL = 'https://roteiros.clubedoviajante.com.br';

// Retorna os blocos "{...}" de cada atribuicao real a ROTEIRO_DATA.
// A primeira mencao no arquivo costuma ser um comentario do template, e o
// template embutido traz exemplos ("Santiago & Andes") que nao sao o roteiro.
function extrairBlocosRoteiroData(html) {
  const blocos = [];
  const re = /ROTEIRO_DATA\s*=\s*\{/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const start = html.indexOf('{', m.index);
    if (start === -1) continue;
    let depth = 0, inStr = false, esc = false;
    for (let p = start; p < html.length; p++) {
      const ch = html[p];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { blocos.push(html.slice(start, p + 1)); break; }
      }
    }
  }
  return blocos;
}

function extrairRoteiroData(html) {
  const blocos = extrairBlocosRoteiroData(html);
  for (const b of blocos) {
    try {
      const obj = JSON.parse(b);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
    } catch(e) { /* tenta o proximo bloco */ }
  }
  return null;
}

// Fallback: roteiros legados usam objeto JS literal (chaves sem aspas) ou
// nem sequer possuem ROTEIRO_DATA. Extrai os poucos campos que o OG precisa.
function montarDadosOG(html) {
  const D = extrairRoteiroData(html);
  if (D) return D;

  // Busca restrita ao bloco da atribuicao, para nao capturar exemplos do template
  const blocos = extrairBlocosRoteiroData(html);
  const escopo = blocos.length ? blocos[blocos.length - 1] : '';

  const pick = function(re) {
    const m = escopo.match(re);
    if (!m) return null;
    try { return JSON.parse('"' + m[1] + '"'); } catch(e) { return m[1]; }
  };

  const out = {};
  out.titulo     = pick(/\btitulo"?\s*:\s*"((?:[^"\\]|\\.)*)"/);
  out.subtitulo  = pick(/\bsubtitulo"?\s*:\s*"((?:[^"\\]|\\.)*)"/);
  out.marcaTexto = pick(/\bmarcaTexto"?\s*:\s*"((?:[^"\\]|\\.)*)"/);
  out.footerNote = pick(/\bfooterNote"?\s*:\s*"((?:[^"\\]|\\.)*)"/);

  // heroImage: ignora placeholders do template (ex.: "https://images.unsplash.com/...")
  const reImg = /heroImage"?\s*:\s*"([^"]+)"/g;
  let mi;
  while ((mi = reImg.exec(escopo)) !== null) {
    const u = mi[1];
    if (u.indexOf('http') === 0 && u.indexOf('/...') === -1 && !/\.\.\.$/.test(u)) { out.heroImage = u; break; }
  }

  // Ultimo recurso: deriva do <title> ("Titulo · Marca")
  if (!out.titulo) {
    const mt = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    if (mt && mt[1].trim()) {
      const partes = mt[1].split('·').map(function(s) { return s.trim(); }).filter(Boolean);
      if (partes.length >= 2) {
        out.titulo = partes.slice(0, -1).join(' · ');
        out.marcaTexto = out.marcaTexto || partes[partes.length - 1];
      } else {
        out.titulo = mt[1].trim();
      }
    }
  }

  return (out.titulo || out.heroImage) ? out : null;
}

function escAttrHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Unsplash aceita parametros de resize: garante ~1200x630 em JPG leve
function normalizarCapaUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.hostname.indexOf('images.unsplash.com') !== -1) {
      u.searchParams.delete('auto');
      u.searchParams.set('w', '1200');
      u.searchParams.set('h', '630');
      u.searchParams.set('fit', 'crop');
      u.searchParams.set('fm', 'jpg');
      u.searchParams.set('q', '70');
      return u.toString();
    }
    return url;
  } catch(e) { return url; }
}

// Baixa a capa e commita em {slug}/capa.jpg — garante peso e disponibilidade.
// Retorna null se falhar (o og:image cai para a URL original).
async function publicarCapaRoteiro(slug, heroImage, ghHeaders, repo) {
  const src = normalizarCapaUrl(heroImage);
  if (!src) return null;
  try {
    const r = await fetch(src, { headers: { 'User-Agent': 'cdv-proxy' } });
    if (!r.ok) return null;
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    let ext = null;
    if (ct.indexOf('jpeg') !== -1 || ct.indexOf('jpg') !== -1) ext = 'jpg';
    else if (ct.indexOf('png') !== -1) ext = 'png';
    if (!ext) return null;

    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || buf.length > 1500000) return null;

    const caminhoCapa = slug + '/capa.' + ext;
    let shaCapa = null;
    try {
      const chk = await fetch('https://api.github.com/repos/' + repo + '/contents/' + caminhoCapa, { headers: ghHeaders });
      if (chk.ok) { const d = await chk.json(); shaCapa = d.sha || null; }
    } catch(e) { /* capa ainda nao existe */ }

    const body = { message: 'roteiro: capa ' + slug, content: buf.toString('base64') };
    if (shaCapa) body.sha = shaCapa;

    const put = await fetch('https://api.github.com/repos/' + repo + '/contents/' + caminhoCapa, {
      method: 'PUT', headers: ghHeaders, body: JSON.stringify(body)
    });
    if (!put.ok) return null;

    return ROTEIROS_BASE_URL + '/' + slug + '/capa.' + ext;
  } catch(e) { return null; }
}

function injetarOpenGraph(html, slug, capaUrl, D) {
  D = D || {};
  const marca   = D.marcaTexto || 'Travel Concierge';
  const titulo  = D.titulo || 'Roteiro';
  const desc    = D.subtitulo || D.footerNote || ('Roteiro de viagem · ' + marca);
  const imagem  = capaUrl || normalizarCapaUrl(D.heroImage) || '';
  const urlCan  = ROTEIROS_BASE_URL + '/' + slug + '/';
  const tituloFull = titulo + ' · ' + marca;

  // Preserva atributos do <title> original (o template usa id="page-title" no JS)
  const mTitle = html.match(/<title([^>]*)>/i);
  const titleAttrs = mTitle ? (mTitle[1] || '') : ' id="page-title"';

  const linhas = [
    '<title' + titleAttrs + '>' + escAttrHtml(tituloFull) + '</title>',
    '<link rel="canonical" href="' + escAttrHtml(urlCan) + '"/>',
    '<meta name="description" content="' + escAttrHtml(desc) + '"/>',
    '<meta property="og:type" content="website"/>',
    '<meta property="og:site_name" content="' + escAttrHtml(marca) + '"/>',
    '<meta property="og:locale" content="pt_BR"/>',
    '<meta property="og:title" content="' + escAttrHtml(titulo) + '"/>',
    '<meta property="og:description" content="' + escAttrHtml(desc) + '"/>',
    '<meta property="og:url" content="' + escAttrHtml(urlCan) + '"/>'
  ];
  if (imagem) {
    linhas.push('<meta property="og:image" content="' + escAttrHtml(imagem) + '"/>');
    linhas.push('<meta property="og:image:secure_url" content="' + escAttrHtml(imagem) + '"/>');
    linhas.push('<meta property="og:image:type" content="image/' + (imagem.indexOf('.png') !== -1 ? 'png' : 'jpeg') + '"/>');
    linhas.push('<meta property="og:image:width" content="1200"/>');
    linhas.push('<meta property="og:image:height" content="630"/>');
    linhas.push('<meta property="og:image:alt" content="' + escAttrHtml(titulo) + '"/>');
    linhas.push('<meta name="twitter:card" content="summary_large_image"/>');
    linhas.push('<meta name="twitter:image" content="' + escAttrHtml(imagem) + '"/>');
  } else {
    linhas.push('<meta name="twitter:card" content="summary"/>');
  }
  linhas.push('<meta name="twitter:title" content="' + escAttrHtml(titulo) + '"/>');
  linhas.push('<meta name="twitter:description" content="' + escAttrHtml(desc) + '"/>');
  const bloco = linhas.join('\n');

  // Remove tags anteriores (republicacao do mesmo slug)
  let out = html
    .replace(/[ \t]*<meta\s+(?:property|name)\s*=\s*"(?:og:|twitter:|description)[^"]*"[^>]*>\s*\n?/gi, '')
    .replace(/[ \t]*<link\s+rel\s*=\s*"canonical"[^>]*>\s*\n?/gi, '');

  if (/<title[^>]*>[\s\S]*?<\/title>/i.test(out)) {
    out = out.replace(/<title[^>]*>[\s\S]*?<\/title>/i, function() { return bloco; });
  } else {
    out = out.replace(/<\/head>/i, function() { return bloco + '\n</head>'; });
  }

  return out;
}

// ══════════════════════════════════════════════════════════════════
//  POST /roteiros/publicar
//  Recebe: { slug, html (base64 ou string), viagemId? }
//  - Faz commit do HTML em davileles/roteiros/{slug}/index.html
//  - Se viagemId fornecido, atualiza viagem no concierge com slugRoteiro + urlRoteiro
// ══════════════════════════════════════════════════════════════════
app.post('/roteiros/publicar', async (req, res) => {
  const { slug, html, htmlBase64, viagemId } = req.body || {};

  if (!slug) return res.status(400).json({ ok: false, erro: 'slug obrigatório' });

  const htmlContent = html || (htmlBase64 ? Buffer.from(htmlBase64, 'base64').toString('utf-8') : null);
  if (!htmlContent) return res.status(400).json({ ok: false, erro: 'html ou htmlBase64 obrigatório' });

  const ROTEIROS_REPO = 'davileles/roteiros';
  const caminho = `${slug}/index.html`;
  const ghHeaders = {
    'Authorization': `token ${GITHUB_TOKEN}`,
    'User-Agent': 'cdv-proxy',
    'Accept': 'application/vnd.github+json',
    'Content-Type': 'application/json'
  };

  try {
    // 1. Buscar SHA existente (se o arquivo já existe)
    let shaBefore = null;
    try {
      const checkRes = await fetch(`https://api.github.com/repos/${ROTEIROS_REPO}/contents/${caminho}`, {
        headers: ghHeaders
      });
      if (checkRes.ok) {
        const checkData = await checkRes.json();
        shaBefore = checkData.sha || null;
      }
    } catch(e) { /* arquivo não existe ainda */ }

    // 1b. Injetar Open Graph (preview com imagem no WhatsApp/Telegram)
    let htmlFinal = htmlContent;
    try {
      const D = montarDadosOG(htmlContent);
      const capaUrl = D ? await publicarCapaRoteiro(slug, D.heroImage, ghHeaders, ROTEIROS_REPO) : null;
      htmlFinal = injetarOpenGraph(htmlContent, slug, capaUrl, D);
    } catch(e) {
      console.warn('[roteiros/publicar] Aviso: Open Graph não injetado:', e.message);
    }

    // 2. Commit do HTML no repositório roteiros
    const putBody = {
      message: `roteiro: ${slug}`,
      content: Buffer.from(htmlFinal).toString('base64')
    };
    if (shaBefore) putBody.sha = shaBefore;

    const putRes = await fetch(`https://api.github.com/repos/${ROTEIROS_REPO}/contents/${caminho}`, {
      method: 'PUT',
      headers: ghHeaders,
      body: JSON.stringify(putBody)
    });

    if (!putRes.ok) {
      const putErr = await putRes.json().catch(() => ({}));
      throw new Error(putErr.message || `GitHub PUT falhou (${putRes.status})`);
    }

    const url = `${ROTEIROS_BASE_URL}/${slug}/`;

    // 3. Se viagemId fornecido, atualizar viagem no concierge com slugRoteiro + urlRoteiro
    if (viagemId) {
      try {
        const { content: viagens, sha: viagensSha } = await getConciergeFile('viagens.json');
        const idx = viagens.findIndex(v => v.id === viagemId);
        if (idx !== -1) {
          viagens[idx].slugRoteiro = slug;
          viagens[idx].urlRoteiro  = url;
          viagens[idx].roteiroPubEm = new Date().toISOString().split('T')[0];
          await putConciergeFile('viagens.json', viagens, viagensSha);
        }
      } catch(e) {
        console.warn('[roteiros/publicar] Aviso: não atualizou viagem no concierge:', e.message);
        // Não falha — o commit do HTML já foi feito
      }
    }

    res.json({ ok: true, url, slug, viagemAtualizada: !!viagemId });

  } catch(e) {
    console.error('[roteiros/publicar]', e.message);
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// GET /roteiros/publicar?slug=xxx — verifica se roteiro já existe e retorna URL
app.get('/roteiros/publicar', async (req, res) => {
  const slug = (req.query.slug || '').trim();
  if (!slug) return res.status(400).json({ ok: false, erro: 'slug obrigatório' });
  const ROTEIROS_REPO = 'davileles/roteiros';
  try {
    const checkRes = await fetch(`https://api.github.com/repos/${ROTEIROS_REPO}/contents/${slug}/index.html`, {
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'User-Agent': 'cdv-proxy',
        'Accept': 'application/vnd.github+json'
      }
    });
    if (checkRes.ok) {
      res.json({ ok: true, existe: true, url: `${ROTEIROS_BASE_URL}/${slug}/` });
    } else {
      res.json({ ok: true, existe: false });
    }
  } catch(e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});


// ══════════════════════════════════════════════════════════════
//  POST /roteiros/doc-upload
//  Body: { slug, docId, nome, tipo, base64, mediaType }
//  Salva o arquivo em davileles/roteiros/{slug}/docs/{docId}
//  e atualiza docs-meta.json com metadados
// ══════════════════════════════════════════════════════════════
app.post('/roteiros/doc-upload', async (req, res) => {
  try {
    const { slug, docId, nome, tipo, base64: fileB64, mediaType } = req.body;
    if (!slug || !docId || !fileB64) return res.status(400).json({ ok: false, erro: 'Parâmetros incompletos' });

    const ROTEIROS_REPO = 'davileles/roteiros';
    const GH = 'https://api.github.com';
    const headers = {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'User-Agent': 'cdv-proxy',
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json'
    };

    // 1. Salvar arquivo binário
    const filePath = `${slug}/docs/${docId}`;
    let fileSha;
    try {
      const checkRes = await fetch(`${GH}/repos/${ROTEIROS_REPO}/contents/${filePath}`, { headers });
      if (checkRes.ok) { const d = await checkRes.json(); fileSha = d.sha; }
    } catch(e) {}

    const filePayload = { message: `doc: ${slug}/${docId}`, content: fileB64, ...(fileSha ? { sha: fileSha } : {}) };
    const fileRes = await fetch(`${GH}/repos/${ROTEIROS_REPO}/contents/${filePath}`, {
      method: 'PUT', headers, body: JSON.stringify(filePayload)
    });
    if (!fileRes.ok) throw new Error('Erro ao salvar arquivo: ' + (await fileRes.text()));

    // 2. Atualizar docs-meta.json
    const metaPath = `${slug}/docs-meta.json`;
    let meta = {}, metaSha;
    try {
      const metaRes = await fetch(`${GH}/repos/${ROTEIROS_REPO}/contents/${metaPath}`, { headers });
      if (metaRes.ok) {
        const d = await metaRes.json();
        metaSha = d.sha;
        meta = JSON.parse(Buffer.from(d.content.replace(/\n/g,''), 'base64').toString('utf-8'));
      }
    } catch(e) {}

    meta[docId] = { nome: nome||docId, tipo: tipo||'', mediaType: mediaType||'application/octet-stream', uploadEm: new Date().toISOString() };
    const metaB64 = Buffer.from(JSON.stringify(meta, null, 2)).toString('base64');
    const metaPayload = { message: `doc-meta: ${slug}`, content: metaB64, ...(metaSha ? { sha: metaSha } : {}) };
    await fetch(`${GH}/repos/${ROTEIROS_REPO}/contents/${metaPath}`, {
      method: 'PUT', headers, body: JSON.stringify(metaPayload)
    });

    const rawUrl = `https://raw.githubusercontent.com/${ROTEIROS_REPO}/main/${filePath}`;
    res.json({ ok: true, rawUrl, docId });
  } catch(e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  DELETE /roteiros/doc-upload
//  Body: { slug, docId }
//  Remove o arquivo e atualiza docs-meta.json
// ══════════════════════════════════════════════════════════════
app.delete('/roteiros/doc-upload', async (req, res) => {
  try {
    const { slug, docId } = req.body;
    if (!slug || !docId) return res.status(400).json({ ok: false, erro: 'Parâmetros incompletos' });

    const ROTEIROS_REPO = 'davileles/roteiros';
    const GH = 'https://api.github.com';
    const headers = {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'User-Agent': 'cdv-proxy',
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json'
    };

    // Deletar arquivo
    const filePath = `${slug}/docs/${docId}`;
    try {
      const checkRes = await fetch(`${GH}/repos/${ROTEIROS_REPO}/contents/${filePath}`, { headers });
      if (checkRes.ok) {
        const d = await checkRes.json();
        await fetch(`${GH}/repos/${ROTEIROS_REPO}/contents/${filePath}`, {
          method: 'DELETE', headers,
          body: JSON.stringify({ message: `doc-remove: ${slug}/${docId}`, sha: d.sha })
        });
      }
    } catch(e) {}

    // Atualizar meta
    const metaPath = `${slug}/docs-meta.json`;
    let meta = {}, metaSha;
    try {
      const metaRes = await fetch(`${GH}/repos/${ROTEIROS_REPO}/contents/${metaPath}`, { headers });
      if (metaRes.ok) {
        const d = await metaRes.json();
        metaSha = d.sha;
        meta = JSON.parse(Buffer.from(d.content.replace(/\n/g,''), 'base64').toString('utf-8'));
      }
    } catch(e) {}

    delete meta[docId];
    const metaB64 = Buffer.from(JSON.stringify(meta, null, 2)).toString('base64');
    await fetch(`${GH}/repos/${ROTEIROS_REPO}/contents/${metaPath}`, {
      method: 'PUT', headers,
      body: JSON.stringify({ message: `doc-meta: ${slug}`, content: metaB64, ...(metaSha ? { sha: metaSha } : {}) })
    });

    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  GET /roteiros/doc-upload?slug=xxx
//  Retorna docs-meta.json do roteiro
// ══════════════════════════════════════════════════════════════
app.get('/roteiros/doc-upload', async (req, res) => {
  try {
    const { slug } = req.query;
    if (!slug) return res.status(400).json({ ok: false, erro: 'slug obrigatório' });

    const ROTEIROS_REPO = 'davileles/roteiros';
    const GH = 'https://api.github.com';
    const headers = { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'cdv-proxy', 'Accept': 'application/vnd.github+json', 'Cache-Control': 'no-cache' };

    const metaRes = await fetch(`${GH}/repos/${ROTEIROS_REPO}/contents/${slug}/docs-meta.json`, { headers });
    if (!metaRes.ok) return res.json({ ok: true, docs: {} });
    const d = await metaRes.json();
    const meta = JSON.parse(Buffer.from(d.content.replace(/\n/g,''), 'base64').toString('utf-8'));
    res.json({ ok: true, docs: meta });
  } catch(e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});


// ══════════════════════════════════════════════════════════════
//  POST /roteiros/doc-meta
//  Body: { slug, meta }
//  Salva o docs-meta.json completo (inclui _deletedCards, _extraCards)
// ══════════════════════════════════════════════════════════════
app.post('/roteiros/doc-meta', async (req, res) => {
  try {
    const { slug, meta } = req.body;
    if (!slug || !meta) return res.status(400).json({ ok: false, erro: 'Parâmetros incompletos' });

    const ROTEIROS_REPO = 'davileles/roteiros';
    const GH = 'https://api.github.com';
    const headers = {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'User-Agent': 'cdv-proxy',
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json'
    };

    const metaPath = `${slug}/docs-meta.json`;
    let metaSha;
    try {
      const checkRes = await fetch(`${GH}/repos/${ROTEIROS_REPO}/contents/${metaPath}`, { headers });
      if (checkRes.ok) { const d = await checkRes.json(); metaSha = d.sha; }
    } catch(e) {}

    const metaB64 = Buffer.from(JSON.stringify(meta, null, 2)).toString('base64');
    const payload = { message: `doc-meta: ${slug}`, content: metaB64, ...(metaSha ? { sha: metaSha } : {}) };
    await fetch(`${GH}/repos/${ROTEIROS_REPO}/contents/${metaPath}`, {
      method: 'PUT', headers, body: JSON.stringify(payload)
    });

    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// ── Resolver e salvar links diretos dos parceiros Tier1 ──────────────────────
// POST /parceiros/resolver-links
// Roda uma vez (ou manualmente quando necessário).
// Varre todos os parceiros do snapshot mais recente, acessa a página de cada
// um no Comparemania via fetch interno (Railway tem acesso), extrai o link
// /redirecionar/oferta de cada programa e salva em historico.json[data][parceiro].links
app.post('/parceiros/resolver-links', async (req, res) => {
  if (!GITHUB_TOKEN) return res.status(500).json({ ok: false, erro: 'GITHUB_TOKEN não configurado' });

  // Estratégia: busca as 4 páginas de listagem do Comparemania (uma por programa),
  // extrai o href de cada parceiro na tabela + segue para a página do parceiro
  // para pegar o link /redirecionar/oferta que vai direto ao programa de fidelidade.
  // Salva em historico.json[data][parceiro].links[prog].

  const PROGS = [
    { id: 'livelo', url: 'https://www.comparemania.com.br/lojas/pontos-milhas/programa-fidelidade-livelo' },
    { id: 'esfera', url: 'https://www.comparemania.com.br/lojas/pontos-milhas/programa-fidelidade-santander-esfera' },
    { id: 'smiles', url: 'https://www.comparemania.com.br/lojas/pontos-milhas/programa-fidelidade-smiles' },
    { id: 'azul',   url: 'https://www.comparemania.com.br/lojas/pontos-milhas/programa-fidelidade-tudo-azul' },
  ];

  const TIER1 = new Set([
    'booking', 'hoteis.com', 'decolar',
    'mercado livre', 'casas bahia', 'magazine luiza', 'shopee',
    'netshoes', 'centauro', 'carrefour mercado', 'extra',
    'pão de açúcar', 'drogasil', 'ultrafarma', 'lojas renner', 'c&a', 'riachuelo',
  ]);
  const processarTodos = req.body && req.body.todos === true;

  const FHEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Encoding': 'identity',
    'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Upgrade-Insecure-Requests': '1',
  };

  async function fetchHtml(url, timeoutMs = 20000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { compress: false, headers: FHEADERS, signal: ctrl.signal });
      clearTimeout(t);
      console.log(`[ResolveLinks] ${url.substring(0,80)} → ${r.status}`);
      if (!r.ok) return '';
      return await r.text();
    } catch(e) { clearTimeout(t); console.log(`[ResolveLinks] erro: ${e.message}`); return ''; }
  }

  // Extrai parceiros e seus hrefs da tabela da página de listagem do programa
  function extrairParceiros(html) {
    const result = {};
    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let row;
    while ((row = rowRe.exec(html)) !== null) {
      const cells = row[1].split(/<\/td>/i);
      if (cells.length < 2) continue;
      const aMatch = cells[0].match(/<a([^>]*)>([\s\S]*?)<\/a>/i);
      if (!aMatch) continue;
      const name = aMatch[2].replace(/<[^>]*>/g, '').trim().toLowerCase();
      if (!name) continue;
      const hrefMatch = aMatch[1].match(/href=["']([^"']+)["']/i);
      if (!hrefMatch) continue;
      const raw = hrefMatch[1];
      const partnerPageUrl = raw.startsWith('http') ? raw : 'https://www.comparemania.com.br' + raw;
      result[name] = partnerPageUrl;
    }
    return result;
  }

  // Extrai o link /redirecionar/oferta da página individual do parceiro
  function extrairRedirect(html) {
    const m = html.match(/href=["']((?:https?:\/\/www\.comparemania\.com\.br)?\/redirecionar\/oferta[^"']+)["']/i);
    if (!m) return '';
    return m[1].startsWith('http') ? m[1] : 'https://www.comparemania.com.br' + m[1];
  }

  try {
    const hist = await ghGetJson('historico.json', {});
    const datas = Object.keys(hist.data).sort();
    if (datas.length === 0) return res.status(400).json({ ok: false, erro: 'historico.json vazio' });

    const resolved = {};  // { parceiro: { prog: redirectUrl } }
    let total = 0, salvos = 0;
    const erros = [];

    for (const prog of PROGS) {
      // Passo 1: busca página de listagem do programa
      const listHtml = await fetchHtml(prog.url);
      if (!listHtml) { console.log(`[ResolveLinks] sem HTML para ${prog.id}`); continue; }

      const parceiros = extrairParceiros(listHtml);
      console.log(`[ResolveLinks] ${prog.id}: ${Object.keys(parceiros).length} parceiros na listagem`);

      // Passo 2: para cada parceiro (tier1 ou todos), busca a página individual
      for (const [nome, partnerPageUrl] of Object.entries(parceiros)) {
        if (!processarTodos && !TIER1.has(nome)) continue;
        total++;

        const partnerHtml = await fetchHtml(partnerPageUrl);
        const redirectUrl = extrairRedirect(partnerHtml);

        if (redirectUrl) {
          if (!resolved[nome]) resolved[nome] = {};
          resolved[nome][prog.id] = redirectUrl;
          salvos++;
          console.log(`[ResolveLinks] ✓ ${nome}/${prog.id}`);
        } else {
          erros.push(`${nome}/${prog.id}`);
          console.log(`[ResolveLinks] ✗ sem redirect: ${nome}/${prog.id}`);
        }

        // Também salva a URL da página do parceiro no historico (usada como fallback)
        const dataRecente = datas[datas.length - 1];
        for (const data of datas) {
          const snap = hist.data[data];
          if (snap[nome] && !snap[nome].partnerUrl) {
            snap[nome].partnerUrl = {};
          }
          if (snap[nome]) snap[nome].partnerUrl = snap[nome].partnerUrl || {};
          if (snap[nome]) snap[nome].partnerUrl[prog.id] = partnerPageUrl;
        }

        await new Promise(r => setTimeout(r, 300));
      }
    }

    // Salva links /redirecionar/oferta em historico.json em todas as datas
    for (const data of datas) {
      for (const [parceiro, links] of Object.entries(resolved)) {
        if (!hist.data[data][parceiro]) continue;
        if (!hist.data[data][parceiro].links) hist.data[data][parceiro].links = {};
        Object.assign(hist.data[data][parceiro].links, links);
      }
    }

    await ghPutJson('historico.json', hist.data, hist.sha, `chore: salva links diretos de ${salvos} parceiros (resolve via listagem)`);

    res.json({ ok: true, total, salvos, erros: erros.length, falhas: erros });
  } catch(e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});


// ── Diagnóstico: testar fetch de URL do Comparemania ─────────────────────────
app.get('/parceiros/testar-fetch', async (req, res) => {
  const url = req.query.url || 'https://www.comparemania.com.br/cashback-mercado-livre';
  const buscar = (req.query.buscar || '').toLowerCase(); // ex: ?buscar=centauro
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Encoding': 'identity',
    'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Upgrade-Insecure-Requests': '1',
  };
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 15000);
    const r = await fetch(url, { compress: false, headers, signal: ctrl.signal });
    const body = await r.text();
    const temTabela = /<table/i.test(body);
    const temTr = /<tr/i.test(body);
    // Extrair todas as linhas da tabela com nome + href
    const trs = body.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    const linhas = trs.map(t => {
      const txt = t.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
      const hm = t.match(/href=["']([^"']+)["']/i);
      return { txt: txt.substring(0,120), href: hm ? hm[1] : '' };
    }).filter(l => l.txt.length > 3);
    // Se ?buscar=termo, filtra linhas que contenham o termo + 200 chars de contexto HTML
    let resultado, contextoHtml = '';
    if (buscar) {
      resultado = linhas.filter(l => l.txt.toLowerCase().includes(buscar));
      const pos = body.toLowerCase().indexOf(buscar);
      if (pos !== -1) contextoHtml = body.substring(Math.max(0, pos-300), pos+500);
      // Também buscar ocorrências de redirecionar na página
      const redirPos = body.indexOf('redirecionar');
      const temRedirJS = body.includes('redirecionar');
      contextoHtml += ' ||| temRedirecionar=' + temRedirJS + (redirPos > -1 ? ' pos=' + redirPos + ' ctx=' + body.substring(Math.max(0,redirPos-100), redirPos+200) : '');
    } else {
      resultado = linhas.slice(0,10);
    }
    res.json({
      url, status: r.status, ok: r.ok,
      bodyLen: body.length, temTabela, temTr,
      totalLinhas: linhas.length,
      resultado,
      contextoHtml,
    });
  } catch(e) {
    res.json({ url, erro: e.message });
  }
});


// ══════════════════════════════════════════════════════════════════════════════
// SALAS VIP — busca por aeroporto (LoungeKey + DragonPass + Priority Pass)
// ══════════════════════════════════════════════════════════════════════════════

const LOUNGES_DB_PATH = 'lounges-db.json';

// ─── LoungeReview parser ──────────────────────────────────────────────────────

function lrExtrairSlugs(html, iata) {
  // Extrai slugs de salas da página de busca do Google: site:loungereview.com/lounges/ IATA
  const slugs = new Set();
  const re = /loungereview\.com\/lounges\/([\w-]+(?:-' + iata.toLowerCase() + r'[\w-]*|[\w-]*-' + iata.toLowerCase() + r'[\w-]*))\//gi;
  // Padrão direto: qualquer link /lounges/algo-GRU-algo/
  const reLinks = /loungereview\.com\/lounges\/([\w-]+)\//gi;
  let m;
  while ((m = reLinks.exec(html)) !== null) {
    const slug = m[1].toLowerCase();
    // filtra slugs que contenham o IATA
    if (slug.includes(iata.toLowerCase())) {
      slugs.add(slug);
    }
  }
  return [...slugs];
}

function lrExtrairDetalhes(html, slug) {
  const strip = s => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').replace(/[\u200b-\u200f\u2028\u2029\uFEFF]/g, '').trim();

  // Nome
  let nome = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) nome = strip(h1[1]);
  else {
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (titleMatch) nome = strip(titleMatch[1]).replace(/\s*[-|].*$/, '').replace(/- LoungeReview\.com.*/i, '').trim();
  }

  // Horários
  let horario = '';
  if (/open 24 hours|24\s*hours/i.test(html)) {
    horario = '24h';
  } else {
    const hMatch = html.match(/(\d{1,2}:\d{2}\s*(?:am|pm)\s*[-–to]+\s*\d{1,2}:\d{2}\s*(?:am|pm))/i)
                || html.match(/(\d{2}:\d{2}\s*[-–]\s*\d{2}:\d{2})/);
    if (hMatch) horario = hMatch[1].replace(/\s+/g, ' ').trim();
  }

  // Localização
  let localizacao = '';
  const locP1 = html.match(/\([A-Z]{3}\)\s*[–-]\s*(Terminal[\s\S]{10,300}?)(?:<|\n{2})/i);
  const locP2 = html.match(/(Terminal\s+\d[^<.]{10,250}(?:security|gate)[^<.]{0,100}\.)/i);
  const locP3 = html.match(/((?:after|before|airside|landside)[^<.]{10,250}(?:terminal|gate|level|security)[^<.]{0,150}\.)/i);
  if (locP1) localizacao = strip(locP1[1]).substring(0, 300);
  else if (locP2) localizacao = strip(locP2[1]).substring(0, 300);
  else if (locP3) localizacao = strip(locP3[1]).substring(0, 300);

  // Amenidades
  const amenidades = { comida: [], bebida: [], outros: [] };
  const extractList = (sectionHtml) => {
    if (!sectionHtml) return [];
    const liItems = sectionHtml.match(/<li[^>]*>([\s\S]*?)<\/li>/gi);
    if (liItems) return liItems.map(li => strip(li)).filter(s => s.length > 1 && s.length < 80);
    return sectionHtml.split(/[,;]/).map(s => strip(s)).filter(s => s.length > 2 && s.length < 60);
  };
  const foodSect  = html.match(/(?:Food|Comida)[:\s]*(<ul[\s\S]*?<\/ul>|[\s\S]{10,300}?)(?:Drink|Beverage|Other amenities|Overview|Access)/i);
  const drinkSect = html.match(/(?:Drinks?|Beverages?)[:\s]*(<ul[\s\S]*?<\/ul>|[\s\S]{10,300}?)(?:Other amenities|Overview|Access|$)/i);
  const otherSect = html.match(/(?:Other amenities?)[:\s]*(<ul[\s\S]*?<\/ul>|[\s\S]{10,300}?)(?:Overview|Access rules|Comments|Reviews|$)/i);
  amenidades.comida = extractList(foodSect?.[1]).slice(0, 12);
  amenidades.bebida = extractList(drinkSect?.[1]).slice(0, 10);
  amenidades.outros = extractList(otherSect?.[1]).slice(0, 12);
  if (!amenidades.outros.length) {
    ['Wi-Fi','Shower','Television','Flight monitors','Power outlets','Newspapers','Conference room',
     'Luggage storage','Air conditioning','Kids area','Business center','Printing','Workstations']
      .forEach(kw => { if (new RegExp(kw, 'i').test(html)) amenidades.outros.push(kw); });
  }

  // Overview
  let overview = '';
  const ovMatch = html.match(/<p[^>]*>([\s\S]{80,600}?)<\/p>/i);
  if (ovMatch) {
    const candidate = strip(ovMatch[1]).substring(0, 400);
    if (!/access wizard|install the|log in|create an|buy access/i.test(candidate)) overview = candidate;
  }

  // Programas
  const programas = [];
  if (/lounge\s*key|loungekey/i.test(html)) programas.push('LoungeKey');
  if (/priority\s*pass/i.test(html)) programas.push('Priority Pass');
  if (/dragon\s*pass|dragonpass/i.test(html)) programas.push('DragonPass');
  if (/diners\s*club/i.test(html)) programas.push('Diners Club');

  // Terminal
  let terminal = '';
  const tMatch = html.match(/Terminal\s+([\w\d]+(?:\s*[\(\)\/]\s*[\w\d]+)?)/i);
  if (tMatch) terminal = 'Terminal ' + tMatch[1].trim();

  return { nome, slug, terminal, horario, localizacao, overview, amenidades, programas,
    urlLoungereview: `https://loungereview.com/lounges/${slug}/`,
    urlFotos: `https://loungereview.com/lounges/${slug}/#photos` };
}

async function lrBuscarSalasPorIATA(iata, slugsConhecidos = []) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  const fetchSafe = async (url) => {
    try {
      const r = await fetch(url, { headers, timeout: 15000 });
      if (!r.ok) return '';
      return r.text();
    } catch { return ''; }
  };

  // Usa slugs pré-populados no lounges-db.json
  const slugs = slugsConhecidos.length ? slugsConhecidos : [];

  if (slugs.length === 0) return [];

  // Para cada slug, busca detalhes da página individual em paralelo
  const salas = await Promise.all(slugs.slice(0, 15).map(async slug => {
    const html = await fetchSafe(`https://loungereview.com/lounges/${slug}/`);
    if (!html || html.length < 500) return null;
    // Ignora salas encerradas permanentemente
    if (/CLOSED PERMANENTLY/i.test(html)) return null;
    return lrExtrairDetalhes(html, slug);
  }));

  return salas.filter(Boolean);
}

function extrairLoungesLoungeKey(html, iata) {
  const salas = [];
  const reLoungeLink = /lounge-finder\/lounge\?loungecode=([A-Z0-9]+)/g;
  const blocos = html.match(/<[^>]*(?:lounge-card|lounge-item|result-item)[^>]*>[\s\S]*?<\/[^>]+>/gi) || [];
  blocos.forEach(bloco => {
    const nomeMatch = bloco.match(/class="[^"]*(?:title|name|heading)[^"]*"[^>]*>([\s\S]*?)<\//) ||
                      bloco.match(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/i);
    const terminalMatch = bloco.match(/(?:Terminal|T\d)[^<"]{0,40}/i);
    const horarioMatch = bloco.match(/\d{2}:\d{2}\s*[-–]\s*\d{2}:\d{2}/);
    const codeMatch = bloco.match(/loungecode=([A-Z0-9]+)/i);
    if (nomeMatch) {
      const nome = nomeMatch[1].replace(/<[^>]+>/g, '').trim();
      if (nome.length > 3) {
        salas.push({
          nome,
          terminal: terminalMatch ? terminalMatch[0].trim() : '',
          horario: horarioMatch ? horarioMatch[0] : '',
          url: codeMatch
            ? `https://airport.mastercard.com/pt/lounge-finder/lounge?loungecode=${codeMatch[1]}`
            : `https://airport.mastercard.com/pt/lounge-finder/airport?airportcode=${iata}`
        });
      }
    }
  });
  if (salas.length === 0) {
    let m;
    while ((m = reLoungeLink.exec(html)) !== null) {
      const code = m[1];
      if (!salas.find(s => s.url && s.url.includes(code))) {
        salas.push({ nome: `Sala VIP ${code}`, terminal: '', horario: '',
          url: `https://airport.mastercard.com/pt/lounge-finder/lounge?loungecode=${code}` });
      }
    }
  }
  return salas;
}

function extrairLoungesDragonPass(html, iata) {
  const salas = [];
  const blocos = html.match(/<[^>]*(?:lounge[-_]?card|facility[-_]?card|lounge[-_]?item)[^>]*>[\s\S]*?<\/(?:div|article|section)>/gi) || [];
  blocos.forEach(bloco => {
    const nomeMatch = bloco.match(/<h[234][^>]*>([\s\S]*?)<\/h[234]>/i) ||
                      bloco.match(/class="[^"]*(?:title|name|heading)[^"]*"[^>]*>([\s\S]*?)<\//i);
    const horarioMatch = bloco.match(/\d{2}:\d{2}\s*[-–]\s*\d{2}:\d{2}/);
    const linkMatch = bloco.match(/href="([^"]*explore\/lounge[^"]*)"/i);
    if (nomeMatch) {
      const nome = nomeMatch[1].replace(/<[^>]+>/g, '').trim();
      if (nome.length > 3) {
        salas.push({
          nome, terminal: '', horario: horarioMatch ? horarioMatch[0] : '',
          url: linkMatch ? `https://www.dragonpass.com${linkMatch[1]}`
            : `https://www.dragonpass.com/explore/airport/${iata}`
        });
      }
    }
  });
  return salas;
}

function extrairLoungesPriorityPass(html, iata) {
  const salas = [];
  const blocos = html.match(/<[^>]*(?:lounge[-_]?card|experience[-_]?card|result[-_]?card)[^>]*>[\s\S]*?<\/(?:div|article|li)>/gi) || [];
  blocos.forEach(bloco => {
    const nomeMatch = bloco.match(/<h[234][^>]*>([\s\S]*?)<\/h[234]>/i) ||
                      bloco.match(/class="[^"]*(?:title|name|heading)[^"]*"[^>]*>([\s\S]*?)<\//i);
    const terminalMatch = bloco.match(/Terminal\s*[0-9A-Z\-]+/i);
    const horarioMatch = bloco.match(/\d{2}:\d{2}\s*[-–]\s*\d{2}:\d{2}/);
    if (nomeMatch) {
      const nome = nomeMatch[1].replace(/<[^>]+>/g, '').trim();
      if (nome.length > 3) {
        salas.push({
          nome, terminal: terminalMatch ? terminalMatch[0] : '',
          horario: horarioMatch ? horarioMatch[0] : '',
          url: `https://www.prioritypass.com/pt-BR/airport-lounges?location=${iata}`
        });
      }
    }
  });
  return salas;
}

async function buscarLoungesAoVivo(iata) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.7',
    'Cache-Control': 'no-cache'
  };
  const fetchSafe = async (url) => {
    try {
      const r = await fetch(url, { compress: false, headers, timeout: 15000 });
      if (!r.ok) return '';
      return r.text();
    } catch { return ''; }
  };
  const [htmlLK, htmlDP, htmlPP] = await Promise.all([
    fetchSafe(`https://airport.mastercard.com/pt/lounge-finder/airport?airportcode=${iata}`),
    fetchSafe(`https://www.dragonpass.com/explore/airport/${iata}`),
    fetchSafe(`https://www.prioritypass.com/pt-BR/airport-lounges?location=${iata}`)
  ]);
  return {
    loungekey:    extrairLoungesLoungeKey(htmlLK, iata),
    dragonpass:   extrairLoungesDragonPass(htmlDP, iata),
    prioritypass: extrairLoungesPriorityPass(htmlPP, iata)
  };
}

// GET /lounges/buscar?iata=GRU
// Retorna salas do lounges-db.json (dados pré-catalogados do LoungeReview)
app.get('/lounges/buscar', async (req, res) => {
  const iata = (req.query.iata || '').toUpperCase().trim();
  if (!iata || !/^[A-Z]{3}$/.test(iata)) {
    return res.status(400).json({ ok: false, erro: 'Parâmetro ?iata= deve ter 3 letras (ex: GRU)' });
  }
  try {
    // 1. Cache em memória (mais rápido, sem I/O)
    if (global._loungesCache?.[iata]?.salas?.length) {
      const mem = global._loungesCache[iata];
      return res.json({ ok: true, fonte: 'cache', buscadoEm: mem.buscadoEm,
        aeroporto: mem.aeroporto, salas: mem.salas });
    }

    // 2. Lê do lounges-db.json no GitHub
    const db = await ghGetJson(LOUNGES_DB_PATH, { aeroportos: {} });
    const entrada = db.data.aeroportos?.[iata];

    if (entrada?.salas?.length) {
      // Salva em memória para próximas consultas
      if (!global._loungesCache) global._loungesCache = {};
      global._loungesCache[iata] = {
        salas: entrada.salas,
        buscadoEm: entrada.buscadoEm || null,
        aeroporto: { iata, nome: entrada.nome, cidade: entrada.cidade, pais: entrada.pais }
      };
      return res.json({
        ok: true, fonte: 'cache',
        buscadoEm: entrada.buscadoEm || null,
        aeroporto: { iata, nome: entrada.nome, cidade: entrada.cidade, pais: entrada.pais },
        salas: entrada.salas
      });
    }

    // 3. Aeroporto ainda não catalogado
    return res.json({
      ok: true, fonte: 'sem-dados',
      aeroporto: {
        iata,
        nome: entrada?.nome || `Aeroporto ${iata}`,
        cidade: entrada?.cidade || '',
        pais: entrada?.pais || ''
      },
      salas: []
    });

  } catch (err) {
    console.error('[lounges]', err);
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// GET /lounges/sala?slug=w-lounge-guarulhos-gru-terminal-3
// Busca detalhes de uma sala específica (sempre ao vivo)
app.get('/lounges/sala', async (req, res) => {
  const slug = (req.query.slug || '').replace(/[^a-z0-9-]/gi, '').toLowerCase();
  if (!slug) return res.status(400).json({ ok: false, erro: 'Parâmetro ?slug= obrigatório' });
  try {
    const r = await fetch(`https://loungereview.com/lounges/${slug}/`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      timeout: 15000
    });
    if (!r.ok) return res.status(404).json({ ok: false, erro: 'Sala não encontrada' });
    const html = await r.text();
    const sala = lrExtrairDetalhes(html, slug);
    res.json({ ok: true, sala });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// GET /lounges/aeroportos
app.get('/lounges/aeroportos', async (req, res) => {
  try {
    const db = await ghGetJson(LOUNGES_DB_PATH, { aeroportos: {} });
    const lista = Object.values(db.data.aeroportos || {}).map(a => ({
      iata: a.iata, nome: a.nome, cidade: a.cidade, pais: a.pais
    })).sort((a, b) => a.iata.localeCompare(b.iata));
    res.json({ ok: true, total: lista.length, aeroportos: lista });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});


// ── CONCIERGE: Arquivos de reserva (bilhetes, vouchers) ─────────────────────
// Salva em arquivos/RES-xxx.ext no repo davileles/concierge
// Suporta múltiplos arquivos: arquivos/RES-xxx_0.ext, arquivos/RES-xxx_1.ext ...

// POST /concierge/arquivo
// Body: { reservaId, base64, mediaType, nome }
// Salva o arquivo como arquivos/{reservaId}_{idx}.json contendo { base64, mediaType, nome }
app.post('/concierge/arquivo', async (req, res) => {
  try {
    const { reservaId, base64, mediaType, nome } = req.body || {};
    if (!reservaId || !base64 || !mediaType) {
      return res.status(400).json({ ok: false, erro: 'reservaId, base64 e mediaType são obrigatórios' });
    }
    // Sanitizar reservaId para uso como nome de arquivo
    const safeId = String(reservaId).replace(/[^a-zA-Z0-9\-_]/g, '');
    if (!safeId) return res.status(400).json({ ok: false, erro: 'reservaId inválido' });

    // Descobrir próximo índice disponível (suporte a múltiplos arquivos)
    let idx = 0;
    const apiBase = `https://api.github.com/repos/${CONCIERGE_REPO}/contents/arquivos/`;
    const headers = {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'User-Agent': 'cdv-proxy',
      'Accept': 'application/vnd.github+json'
    };
    try {
      const listRes = await fetch(apiBase, { headers });
      if (listRes.ok) {
        const listData = await listRes.json();
        if (Array.isArray(listData)) {
          const prefix = safeId + '_';
          const existing = listData.filter(f => f.name.startsWith(prefix));
          idx = existing.length;
        }
      }
    } catch(e) { /* pasta pode não existir ainda, idx = 0 */ }

    const filename = `arquivos/${safeId}_${idx}.json`;
    const payload = JSON.stringify({ base64, mediaType, nome: nome || '' });
    const encoded = Buffer.from(payload).toString('base64');

    // Verificar se já existe (para pegar SHA e sobrescrever se necessário)
    let sha = null;
    try {
      const checkRes = await fetch(`https://api.github.com/repos/${CONCIERGE_REPO}/contents/${filename}`, { headers });
      if (checkRes.ok) { const cd = await checkRes.json(); sha = cd.sha || null; }
    } catch(e) {}

    const putBody = {
      message: `arquivo: ${safeId}_${idx}`,
      content: encoded
    };
    if (sha) putBody.sha = sha;

    const putRes = await fetch(`https://api.github.com/repos/${CONCIERGE_REPO}/contents/${filename}`, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(putBody)
    });
    if (!putRes.ok) {
      const putErr = await putRes.json().catch(() => ({}));
      throw new Error(putErr.message || `GitHub PUT falhou (${putRes.status})`);
    }
    res.json({ ok: true, filename, idx });
  } catch(e) {
    console.error('[concierge/arquivo POST]', e.message);
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// GET /concierge/arquivo/:reservaId
// Retorna lista de arquivos da reserva: [{ idx, nome, mediaType, base64 }, ...]
app.get('/concierge/arquivo/:reservaId', async (req, res) => {
  try {
    const safeId = String(req.params.reservaId || '').replace(/[^a-zA-Z0-9\-_]/g, '');
    if (!safeId) return res.status(400).json({ ok: false, erro: 'reservaId inválido' });

    const headers = {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'User-Agent': 'cdv-proxy',
      'Accept': 'application/vnd.github+json'
    };

    // Listar pasta arquivos/
    const listRes = await fetch(`https://api.github.com/repos/${CONCIERGE_REPO}/contents/arquivos/`, { headers });
    if (!listRes.ok) return res.json({ ok: true, arquivos: [] });

    const listData = await listRes.json();
    if (!Array.isArray(listData)) return res.json({ ok: true, arquivos: [] });

    const prefix = safeId + '_';
    const arquivosRepo = listData
      .filter(f => f.name.startsWith(prefix) && f.name.endsWith('.json'))
      .sort((a, b) => a.name.localeCompare(b.name));

    if (!arquivosRepo.length) return res.json({ ok: true, arquivos: [] });

    // Buscar conteúdo de cada arquivo em paralelo
    const resultados = await Promise.all(arquivosRepo.map(async (f) => {
      try {
        // Contents API com Accept:raw — evita encoding:'none' em arquivos grandes
        // e continua funcionando se o repositório for privado
        const rawRes = await fetch(
          `https://api.github.com/repos/${CONCIERGE_REPO}/contents/${f.path}`,
          { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'cdv-proxy', 'Accept': 'application/vnd.github.raw' } }
        );
        if (!rawRes.ok) return null;
        const text = await rawRes.text();
        const parsed = JSON.parse(text);
        const idxMatch = f.name.match(/_(\d+)\.json$/);
        return { idx: idxMatch ? parseInt(idxMatch[1]) : 0, nome: parsed.nome || f.name, mediaType: parsed.mediaType, base64: parsed.base64 };
      } catch(e) { return null; }
    }));

    res.json({ ok: true, arquivos: resultados.filter(Boolean) });
  } catch(e) {
    console.error('[concierge/arquivo GET]', e.message);
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// DELETE /concierge/arquivo/:reservaId/:idx
// Remove um arquivo específico da reserva
app.delete('/concierge/arquivo/:reservaId/:idx', async (req, res) => {
  try {
    const safeId = String(req.params.reservaId || '').replace(/[^a-zA-Z0-9\-_]/g, '');
    const idx    = parseInt(req.params.idx);
    if (!safeId || isNaN(idx)) return res.status(400).json({ ok: false, erro: 'reservaId ou idx inválido' });

    const filename = `arquivos/${safeId}_${idx}.json`;
    const headers = {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'User-Agent': 'cdv-proxy',
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json'
    };

    // Pegar SHA para poder deletar
    const checkRes = await fetch(`https://api.github.com/repos/${CONCIERGE_REPO}/contents/${filename}`, { headers });
    if (!checkRes.ok) return res.status(404).json({ ok: false, erro: 'Arquivo não encontrado' });
    const checkData = await checkRes.json();

    const delRes = await fetch(`https://api.github.com/repos/${CONCIERGE_REPO}/contents/${filename}`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ message: `remove: ${filename}`, sha: checkData.sha })
    });
    if (!delRes.ok) {
      const delErr = await delRes.json().catch(() => ({}));
      throw new Error(delErr.message || `GitHub DELETE falhou (${delRes.status})`);
    }
    res.json({ ok: true });
  } catch(e) {
    console.error('[concierge/arquivo DELETE]', e.message);
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// ── IA: Gerar reclamação formal (CDC / ANAC 400 / Convenção de Montreal) ──────
app.post('/ia/reclamacao', (req, res) => {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ ok: false, erro: 'ANTHROPIC_API_KEY não configurada no servidor.' });
  }

  const { empresa, servico, data, problema, contato, impacto, solucao, plataforma } = req.body;
  if (!empresa || !problema || !solucao) {
    return res.status(400).json({ ok: false, erro: 'Campos obrigatórios: empresa, problema, solucao.' });
  }

  const plataformaLabel = plataforma === 'reclame_aqui' ? 'Reclame Aqui' : 'Consumidor.gov.br';
  const camposLabel = plataforma === 'reclame_aqui'
    ? '(Título, Categoria, Descrição do Problema, O que você espera da empresa)'
    : '(Problema, Impacto, Solução Esperada)';

  const prompt = `Você é um especialista em defesa do consumidor brasileiro. Redija uma reclamação formal para publicação na plataforma ${plataformaLabel}.

DADOS DO CASO:
- Empresa: ${empresa}
- Serviço: ${servico || 'não especificado'}
- Data do ocorrido: ${data || 'não informada'}
- Problema: ${problema}
- Tentativas de contato: ${contato || 'não realizadas'}
- Impacto sofrido: ${impacto || 'não especificado'}
- Solução esperada: ${solucao}

INSTRUÇÕES:
1. Redija o TEXTO DA RECLAMAÇÃO com linguagem formal, objetiva e fundamentada juridicamente. Estrutura: introdução do caso → descrição detalhada → tentativas de solução → fundamento legal (CDC, Resolução ANAC 400 se for voo, Convenção de Montreal se aplicável) → pedido claro de solução → encerramento respeitoso. Máximo 3.000 caracteres.
2. Sugira um TÍTULO para a reclamação (máximo 100 caracteres, direto e descritivo).
3. Preencha os CAMPOS DA PLATAFORMA específicos para ${plataformaLabel} ${camposLabel}.

Responda APENAS em JSON válido, sem markdown, sem texto fora do JSON:
{"texto":"texto completo da reclamação","titulo":"sugestão de título","campos":"campos formatados como CAMPO: valor\nCAMPO: valor"}`;

  const bodyPayload = JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }]
  });

  const https = require('https');
  const options = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(bodyPayload),
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    }
  };

  const chunks = [];
  const apiReq = https.request(options, (apiRes) => {
    apiRes.on('data', (chunk) => { chunks.push(chunk); });
    apiRes.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      console.log('[ia/reclamacao] status:', apiRes.statusCode, 'raw len:', raw.length, 'preview:', raw.slice(0,120));
      try {
        const parsed = JSON.parse(raw);
        if (parsed.error) { console.error('[ia/reclamacao] API error:', parsed.error); return res.json({ ok: false, erro: parsed.error.message }); }
        const texto = (parsed.content && parsed.content[0] && parsed.content[0].text) || '';
        const clean = texto.replace(/```json|```/g, '').trim();
        try {
          const result = JSON.parse(clean);
          return res.json({ ok: true, ...result });
        } catch(e) {
          console.error('[ia/reclamacao] JSON parse error:', e.message, 'clean:', clean.slice(0,300));
          return res.json({ ok: false, erro: 'Resposta inesperada da IA.', raw: clean });
        }
      } catch(e) {
        console.error('[ia/reclamacao] outer parse error:', e.message, 'raw:', raw.slice(0,300));
        return res.json({ ok: false, erro: 'Erro ao processar resposta da IA.' });
      }
    });
  });
  apiReq.on('error', (e) => { console.error('[ia/reclamacao] req error:', e.message); res.json({ ok: false, erro: e.message }); });
  apiReq.setTimeout(55000, () => { apiReq.destroy(); res.json({ ok: false, erro: 'Timeout ao chamar API Anthropic.' }); });
  apiReq.write(bodyPayload);
  apiReq.end();
});

// ── IA: Assistente de Roteiros (conversacional — sem publicar HTML/PDF) ──
// Body: { messages: [{role:'user'|'assistant', content:'...'}, ...] }
// O front envia o histórico completo a cada turno; o proxy injeta o system prompt
// e repassa para a Anthropic, devolvendo apenas a próxima mensagem do assistente.
app.post('/ia/roteiro-chat', (req, res) => {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ ok: false, erro: 'ANTHROPIC_API_KEY não configurada no servidor.' });
  }

  const { messages } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ ok: false, erro: 'Campo obrigatório: messages (array não vazio).' });
  }

  // Sanitiza: só role/content, role sempre user|assistant, alternância válida
  const historico = messages
    .filter(m => m && typeof m.content === 'string' && m.content.trim() && (m.role === 'user' || m.role === 'assistant'))
    .map(m => ({ role: m.role, content: m.content.trim() }));
  if (!historico.length || historico[historico.length - 1].role !== 'user') {
    return res.status(400).json({ ok: false, erro: 'A última mensagem do histórico precisa ser do usuário.' });
  }

  const systemPrompt = `Você é um assistente de viagens conversacional chamado "Assistente de Roteiros", parte do Clube do Viajante. Sua missão é criar roteiros ultra detalhados, realistas e eficientes, adaptados ao estilo do usuário.

REGRAS CRÍTICAS:
- Faça SEMPRE uma pergunta por vez. Espere a resposta antes de prosseguir.
- Seja caloroso, entusiasmado e use emojis com moderação.
- Use linguagem clara, informal mas profissional (pt-BR).
- Nunca invente informações sobre locais ou horários. Se não tiver certeza, avise e diga como confirmar.
- Inclua sempre horários sugeridos, preços estimados e necessidade de reservas.
- Para cada atração, indique como chegar a partir do hotel ou atração anterior.
- Sempre pontue e faça referência ao que o usuário já informou nas respostas anteriores antes de fazer a próxima pergunta (ex: "Perfeito, viagem romântica para Paris em outubro! Agora me conta...").
- NÃO ofereça, mencione ou execute qualquer publicação, geração de HTML, PDF ou envio — sua única tarefa nesta conversa é planejar e redigir o roteiro em texto.
- NUNCA use linhas separadoras como "---" ou qualquer marcação de linha horizontal (hr) entre seções, dias ou blocos. Para separar visualmente, use apenas uma linha em branco.

FLUXO DE PERGUNTAS (uma por vez, espere a resposta antes de avançar):
1. Destino da viagem (cidade, região, país)
2. Datas ou duração da viagem + horários de chegada/partida se já tiver voo
3. Com quem viajará (sozinho, casal, família com idades dos filhos, amigos)
4. Hospedagem: já reservada (nome/localização) ou preferência (econômico/equilibrado/luxo, bairro preferido)
5. Tipo de viagem (romântica, aventura, cultural, gastronômica, descanso, com filhos, etc.)
6. Já visitou o destino? O que gostou/não gostou?
7. Orçamento por dia por pessoa (ou: econômico/equilibrado/luxo)
8. Preferências: experiências pagas, gratuitas ou mistas; prioridades (gastronomia, natureza, compras, história…)
9. Atrações obrigatórias — ANTES de perguntar, sugira 7-10 atrações comuns do destino informado na pergunta 1
10. Restrições especiais (mobilidade, alimentação, carrinho de bebê, acessibilidade, horários)
11. Ritmo preferido (intenso / leve / meio-termo)

Após a pergunta 11:
- Elogie as escolhas e faça um RESUMO do que foi pedido
- Informe clima/temperatura média na época + dicas rápidas (roupas, horários de pico, reservas antecipadas)
- Diga: "Tenho tudo para montar o roteiro! Vou preparar os Dias 1 e 2 agora. Posso começar?"

ENTREGA DO ROTEIRO — sempre em blocos de 2 dias. Ao final de cada bloco, pergunte se está OK e se quer ajustes antes de continuar.

ESTRUTURA OBRIGATÓRIA PARA CADA DIA:

📅 **DIA [N] – [DIA E MÊS] | [TÍTULO RESUMO DO DIA]**

📋 **RESUMO**
[2-4 linhas com storytelling curto do dia]

🔋 **NÍVEL DE ENERGIA:** [Leve / Moderado / Intenso]

🏨 **SAÍDA DO HOTEL:** [HH:MM]

🚶 **ITINERÁRIO**

**[HH:MM – HH:MM] | [Nome da Atração]**
- [O que é e por que fazer — 2-3 linhas]
- 💡 Dica: [dica prática sobre fila, reserva, melhor horário, tempo médio]

[linha em branco entre cada atração]

🧭 **DESLOCAMENTOS**
- [Atração A → Atração B]: [como ir, tempo estimado, custo]

💰 **CUSTOS ESTIMADOS (por pessoa)**
- [Item]: R$ [valor]
- Total estimado do dia: R$ [valor]

🍽️ **RESTAURANTES SUGERIDOS**
1. **[Nome]** — [tipo] | [diferencial] | ~R$ [valor médio] por pessoa

🔗 **LINKS ÚTEIS**
- [Site oficial, Viator, GetYourGuide ou transporte público quando relevante]

Ao final de cada bloco de 2 dias pergunte: "Os dias ficaram bons? Quer ajustar algo ou posso ir para os próximos dias?"

FINALIZAÇÃO — quando terminar TODOS os dias:
1. Apresente tabela de resumo: Dia | Data | Resumo (até 65 caracteres)
2. Apresente tabela de custos: Dia | Data | Motivo | Valor por pessoa em R$
3. Encerre agradecendo e desejando uma ótima viagem. NÃO ofereça publicar, gerar HTML/PDF ou enviar o roteiro — isso não faz parte desta conversa.`;

  const bodyPayload = JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: systemPrompt,
    messages: historico
  });

  const https = require('https');
  const options = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(bodyPayload),
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    }
  };

  const chunks = [];
  const apiReq = https.request(options, (apiRes) => {
    apiRes.on('data', (chunk) => { chunks.push(chunk); });
    apiRes.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      console.log('[ia/roteiro-chat] status:', apiRes.statusCode, 'raw len:', raw.length);
      try {
        const parsed = JSON.parse(raw);
        if (parsed.error) { console.error('[ia/roteiro-chat] API error:', parsed.error); return res.json({ ok: false, erro: parsed.error.message }); }
        let texto = (parsed.content && parsed.content[0] && parsed.content[0].text) || '';
        if (!texto) return res.json({ ok: false, erro: 'A IA não retornou texto.' });
        // Remove linhas separadoras "---" (markdown hr), mantendo a linha em branco no lugar
        texto = texto.replace(/^[ \t]*-{3,}[ \t]*$/gm, '');
        return res.json({ ok: true, texto });
      } catch (e) {
        console.error('[ia/roteiro-chat] parse error:', e.message, 'raw:', raw.slice(0, 300));
        return res.json({ ok: false, erro: 'Erro ao processar resposta da IA.' });
      }
    });
  });
  apiReq.on('error', (e) => { console.error('[ia/roteiro-chat] req error:', e.message); res.json({ ok: false, erro: e.message }); });
  apiReq.setTimeout(170000, () => { apiReq.destroy(); res.json({ ok: false, erro: 'Timeout ao chamar API Anthropic.' }); });
  apiReq.write(bodyPayload);
  apiReq.end();
});

// ══════════════════════════════════════════════════════════════════════════════

// ── IA: Extrai ROTEIRO_DATA estruturado a partir da conversa do Assistente de Roteiros ──
// Body: { messages: [{role,content}, ...] } — mesmo historico do /ia/roteiro-chat, ja finalizado
// Devolve JSON pronto para ser injetado no template davileles/roteiros/template/index.html
app.post('/ia/roteiro-extrair', (req, res) => {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ ok: false, erro: 'ANTHROPIC_API_KEY nao configurada no servidor.' });
  }

  const { messages } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ ok: false, erro: 'Campo obrigatorio: messages (array nao vazio).' });
  }

  const historico = messages
    .filter(m => m && typeof m.content === 'string' && m.content.trim() && (m.role === 'user' || m.role === 'assistant'))
    .map(m => ({ role: m.role, content: m.content.trim() }));
  if (!historico.length) {
    return res.status(400).json({ ok: false, erro: 'Historico vazio.' });
  }
  // A extracao e sempre disparada por uma instrucao final do usuario
  historico.push({ role: 'user', content: 'Extraia agora o ROTEIRO_DATA completo em JSON, seguindo exatamente as instrucoes do system prompt. Responda SOMENTE com o JSON, sem markdown.' });

  const systemPrompt = `Voce e um extrator de dados estruturados. Vai receber a conversa completa entre o "Assistente de Roteiros" do Clube do Viajante e um usuario, na qual foi construido um roteiro de viagem dia a dia. Sua unica tarefa e ler essa conversa e devolver um objeto JSON valido — e SOMENTE o JSON, sem texto antes/depois, sem blocos de codigo markdown — com exatamente esta estrutura:

{
  "titulo": "string curta — nome do destino, ex: 'Rio de Janeiro'",
  "subtitulo": "string curta — estilo/tema da viagem, ex: 'Praia, trilhas e vida noturna em familia'",
  "eyebrow": "string — ex: 'Clube do Viajante · Rio de Janeiro, Brasil'",
  "heroImage": "",
  "pills": ["ate 4 badges curtos: datas, numero de pessoas, estilo da viagem"],
  "visaoGeral": [ { "label": "string curta em maiusculas", "value": "string", "variant": "" } ],
  "dias": [
    {
      "num": 1,
      "data": "AAAA-MM-DD ou o texto da data como veio na conversa",
      "titulo": "titulo curto do dia",
      "resumo": "2-3 linhas resumindo o dia",
      "energia": "Leve, Moderado ou Intenso",
      "atividades": [ { "horario": "HH:MM–HH:MM", "nome": "nome da atracao", "descricao": "2-3 linhas", "dica": "dica pratica, se houver" } ],
      "deslocamentos": ["Atracao A → Atracao B: como ir, tempo, custo"],
      "custos": [ { "label": "item", "valor": "R$ valor" } ],
      "custoTotal": "R$ valor total do dia"
    }
  ],
  "footerNote": "string curta — ex: 'Rio de Janeiro, Brasil · Roteiro personalizado'"
}

REGRAS:
- Use SOMENTE informacoes que realmente aparecem na conversa. Nunca invente atracoes, precos ou dicas que nao foram mencionadas.
- "visaoGeral" deve ter entre 4 e 6 cards com os principais dados da viagem (destino, datas, viajantes, orcamento, ritmo, tipo de viagem).
- Se algum campo opcional nao tiver informacao suficiente na conversa, retorne string vazia "" ou array vazio [], nunca invente.
- "dias" deve conter TODOS os dias que apareceram na conversa, na ordem correta, numerados a partir de 1.
- Responda apenas com o JSON puro, comecando em { e terminando em }.`;

  const bodyPayload = JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    system: systemPrompt,
    messages: historico
  });

  const https = require('https');
  const options = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(bodyPayload),
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    }
  };

  const chunks = [];
  const apiReq = https.request(options, (apiRes) => {
    apiRes.on('data', (chunk) => { chunks.push(chunk); });
    apiRes.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      console.log('[ia/roteiro-extrair] status:', apiRes.statusCode, 'raw len:', raw.length);
      try {
        const parsed = JSON.parse(raw);
        if (parsed.error) { console.error('[ia/roteiro-extrair] API error:', parsed.error); return res.json({ ok: false, erro: parsed.error.message }); }
        let texto = (parsed.content && parsed.content[0] && parsed.content[0].text) || '';
        if (!texto) return res.json({ ok: false, erro: 'A IA nao retornou texto.' });
        texto = texto.replace(/```json|```/g, '').trim();
        let dados;
        try {
          dados = JSON.parse(texto);
        } catch (e2) {
          console.error('[ia/roteiro-extrair] JSON invalido:', e2.message, 'texto:', texto.slice(0, 300));
          return res.json({ ok: false, erro: 'A IA nao retornou um JSON valido.' });
        }
        return res.json({ ok: true, dados });
      } catch (e) {
        console.error('[ia/roteiro-extrair] parse error:', e.message, 'raw:', raw.slice(0, 300));
        return res.json({ ok: false, erro: 'Erro ao processar resposta da IA.' });
      }
    });
  });
  apiReq.on('error', (e) => { console.error('[ia/roteiro-extrair] req error:', e.message); res.json({ ok: false, erro: e.message }); });
  apiReq.setTimeout(170000, () => { apiReq.destroy(); res.json({ ok: false, erro: 'Timeout ao chamar API Anthropic.' }); });
  apiReq.write(bodyPayload);
  apiReq.end();
});

// ══════════════════════════════════════════════════════════════════════════════
//  COMPARADOR DE CARTOES
//  Base curada a partir de fontes oficiais dos emissores e das bandeiras.
//  Arquivos: cartoes.json (produtos) e bandeiras.json (catalogo por categoria).
// ══════════════════════════════════════════════════════════════════════════════

// ATENCAO: 'cartoes.json' JA EXISTE e e o cadastro de cartoes DOS MEMBROS,
// listado em ARQUIVOS_SENSIVEIS (roteado para o repo privado de dados).
// O catalogo publico do comparador usa nome e rotas proprios para nao colidir.
const CATALOGO_PATH  = 'cartoes-catalogo.json';
const BANDEIRAS_PATH = 'bandeiras.json';

// Dominios aceitos como fonte oficial. Qualquer campo cuja fonte nao pertenca
// a esta lista e descartado pelo extrator e volta como null em campos_pendentes.
const CARTOES_DOMINIOS_OFICIAIS = [
  'bb.com.br', 'bancobrasil.com.br',
  'bradesco.com.br', 'bradescoprime.com.br', 'banco.bradesco', 'assets.bradesco',
  'safra.com.br', 'banrisul.com.br', 'genial.com.vc', 'genialinvestimentos.com.br',
  'unicred.com.br', 'portobank.com.br', 'porto.com.br', 'banestes.com.br',
  'brb.com.br',
  'btgpactual.com', 'banking.btgpactual.com',
  'c6bank.com.br',
  'caixa.gov.br',
  'bancointer.com.br', 'inter.co',
  'itau.com.br', 'itaupersonnalite.com.br',
  'nubank.com.br',
  'santander.com.br',
  'sicredi.com.br',
  'sicoob.com.br',
  'xpi.com.br', 'xpinvestimentos.com.br',
  'elo.com.br',
  // mastercard.com hospeda a pagina de produto BR (/br/pt/) e tambem a sala de
  // imprensa. Os dois convivem no mesmo host, entao o corte e por caminho
  // em CARTOES_CAMINHOS_BLOQUEADOS, nao pela remocao do dominio.
  'mastercard.com', 'mastercard.com.br',
  'visa.com.br', 'visa-infinite.com',
  'americanexpress.com',
  // Emissor: o site de produto do Porto Bank fica em portoseguro.com.br,
  // nao em portobank.com.br (que e apenas institucional).
  'portoseguro.com.br',
  // Programas de fidelidade: para co-branded, a regra de pontuacao costuma
  // estar publicada no site do programa e nao no do banco emissor.
  'smiles.com.br', 'latampass.com', 'latampass.latam.com', 'voeazul.com.br', 'aa.com',
  // Fintechs (hosts nao verificados em pagina de produto; conferir na 1a extracao)
  'picpay.com', 'picpay.com.br', 'recargapay.com.br', 'rico.com.vc', 'mercadopago.com.br'
];

// A IA costuma anexar a citacao apos a URL ("...pdf - item 1.1.1").
// Valida-se e guarda-se apenas a parte navegavel.
function cartoesUrlLimpa(v) {
  return String(v || '').trim().split(/[\s,;]/)[0];
}

// Dominio oficial nao garante conteudo de produto: bancos e bandeiras hospedam
// sala de imprensa, blog e campanha no mesmo host. Esses caminhos noticiam
// beneficio sem valer como ficha tecnica e ja entraram como fonte por engano.
const CARTOES_CAMINHOS_BLOQUEADOS = [
  '/news', '/noticias', '/noticia', '/imprensa', '/comunicados-de-imprensa',
  '/press', '/press-release', '/pressroom', '/sala-de-imprensa', '/releases',
  '/institucional/imprensa'
];
// '/blog' NAO entra: C6 e BTG publicam ficha de produto no proprio blog
// (c6bank.com.br/blog/c6-mastercard-black, por exemplo). Bloquear /blog
// derrubaria 46 campos legitimos em vez dos 6 de imprensa.

function cartoesCaminhoEditorial(pathname) {
  const p = String(pathname || '').toLowerCase();
  return CARTOES_CAMINHOS_BLOQUEADOS.some(b => p === b || p.startsWith(b + '/') || p.startsWith(b + '-'));
}

function cartoesFonteOficial(url) {
  try {
    const u = new URL(cartoesUrlLimpa(url));
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (!CARTOES_DOMINIOS_OFICIAIS.some(d => host === d || host.endsWith('.' + d))) return false;
    return !cartoesCaminhoEditorial(u.pathname);
  } catch (e) { return false; }
}

// Aceita procedencia declarada por subcampo: 'pontos.nacional' vale para 'pontos'.
function cartoesProcDoCampo(proc, campo) {
  if (proc[campo]) return proc[campo];
  const chave = Object.keys(proc).find(k => k.indexOf(campo + '.') === 0);
  return chave ? proc[chave] : null;
}

// Dois registros sao o mesmo cartao se o emissor bate e um conjunto de nome
// esta contido no outro, ignorando bandeira e palavras de ruido.
function catalogoTokens(nome) {
  // 'black'/'platinum'/'gold' NAO sao ruido: distinguem tiers do mesmo emissor.
  // Tokens de 2 letras entram, senao 'C6', 'BB' e 'XP' somem do nome.
  const RUIDO = new Set(['cartao','card','mastercard','visa','elo','amex','american','express',
                         'de','do','da','the']);
  return new Set(String(nome || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')
    .filter(w => w.length >= 2 && !RUIDO.has(w)));
}

const CATALOGO_TIERS = new Set(['black','platinum','gold']);

function catalogoNucleo(nome) {
  return new Set([...catalogoTokens(nome)].filter(w => !CATALOGO_TIERS.has(w)));
}
function catalogoTier(nome) {
  return new Set([...catalogoTokens(nome)].filter(w => CATALOGO_TIERS.has(w)));
}

// Mesmo cartao = mesmo emissor + mesmo nucleo de nome + tiers compativeis.
// O tier e comparado a parte porque as vezes so um dos nomes o traz
// ("C6 Carbon" e "C6 Carbon Mastercard Black" sao o mesmo produto),
// mas quando ambos declaram tier ele precisa bater ("C6 Black" != "C6 Platinum").
function catalogoMesmoCartao(a, b) {
  const ea = catalogoTokens(a.emissor), eb = catalogoTokens(b.emissor);
  if (ea.size && eb.size && ![...ea].some(w => eb.has(w))) return false;

  const na = catalogoNucleo(a.nome), nb = catalogoNucleo(b.nome);
  if (!na.size || !nb.size) return false;
  if (na.size !== nb.size || ![...na].every(w => nb.has(w))) return false;

  const ta = catalogoTier(a.nome), tb = catalogoTier(b.nome);
  if (!ta.size || !tb.size) return true;
  return ta.size === tb.size && [...ta].every(w => tb.has(w));
}

// Deriva o catalogo de bandeira a partir de bandeira/categoria/nome, que a IA
// escreve em texto livre ("Black / World Elite", "Ultra Premium / Metal").
// World Elite = nome internacional do Mastercard Black no Brasil, mesmo tier.
// World Legend, Infinite Privilege e Centurion sao tiers superiores com
// beneficios proprios: ficam sem ref ate existir catalogo especifico.
function catalogoBandeiraRef(c) {
  const t = [c.bandeira, c.categoria, c.nome].join(' ')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  // Tiers com catalogo proprio tem precedencia sobre Black/Infinite.
  // Amex Centurion nao tem catalogo publico de bandeira.
  if (t.includes('centurion')) return null;
  // Elo (inclusive Elo Diners Club) usa catalogo unico: o Elo Flex nao varia por categoria.
  if (t.includes('elo') || t.includes('diners')) return 'elo-flex';
  if (t.includes('legend')) return t.includes('mastercard') ? 'mastercard-world-legend' : null;
  if (t.includes('privilege') && t.includes('visa') && t.includes('infinite')) return 'visa-infinite-privilege';
  if (t.includes('mastercard') && /black|world elite/.test(t)) return 'mastercard-black';
  if (t.includes('visa') && t.includes('infinite')) return 'visa-infinite';
  return null;
}

function cartoesSlugify(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Exige procedencia POR CAMPO. Um valor so sobrevive se procedencia[campo]
// apontar para um dominio oficial. Sem isso o campo e zerado e vira pendente.
// Motivo: valores sem origem declarada ja entraram na base mais de uma vez.
const CATALOGO_CAMPOS = ['anuidade','anuidade_parcelas','isencao','renda_minima',
  'adicionais_gratis','pontos','cashback','spread','iof','salas_vip',
  'transfere_para','requisito_acesso','validade_pontos','programa_proprio'];

function catalogoVazio(v){
  return v === null || v === undefined || v === '' ||
         (Array.isArray(v) && !v.length) ||
         (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length);
}

// Emissor e gravado sempre em nome comercial curto. A IA devolve razao social
// completa ("Banco Bradesco S.A."), o que fragmenta o filtro por emissor na
// aba "Todos os cartoes". Mapa aplicado a toda gravacao no catalogo.
const CARTOES_EMISSORES_CANONICOS = {
  'banco bradesco s.a.': 'Bradesco',
  'banco btg pactual s.a.': 'BTG Pactual',
  'brb / brbcard': 'BRB',
  'brb - banco de brasilia (operado pela brbcard s.a.)': 'BRB',
  'brb banco de brasilia': 'BRB',
  'caixa economica federal': 'CAIXA',
  'itau unibanco': 'Itaú',
  'itau unibanco s.a.': 'Itaú',
  'itau unibanco (banco itaucard s.a.)': 'Itaú',
  'itau unibanco / banco itaucard s.a.': 'Itaú',
  'banco itaucard s.a. (itau personnalite)': 'Itaú',
  'banco itaucard s.a.': 'Itaú',
  'sicoob (sistema de cooperativas de credito do brasil)': 'Sicoob',
  'unicred (confederacao nacional das cooperativas centrais unicred ltda - unicred do brasil)': 'Unicred',
  'unicred do brasil': 'Unicred',
  'banco inter s.a.': 'Banco Inter',
  'banco santander (brasil) s.a.': 'Santander',
  'banco santander s.a.': 'Santander',
  'banco xp s.a.': 'XP',
  'banestes - banco do estado do espirito santo': 'Banestes',
  // Variantes devolvidas pela extracao de 28/07/2026
  'banco bradesco / banco bankpar s.a.': 'Bradesco',
  'banco bradesco': 'Bradesco',
  'banco bankpar s.a.': 'Bradesco',
  'banco do brasil s.a.': 'Banco do Brasil',
  'banco safra s.a.': 'Banco Safra',
  'banco sicredi': 'Sicredi',
  'banco c6 s.a.': 'C6 Bank',
  'nu pagamentos s.a.': 'Nubank',
  'porto seguro': 'Porto Bank',
  'porto bank / porto seguro': 'Porto Bank'
};

// Nomes ja aceitos como canonicos. Usados so como alvo de comparacao: um valor
// desconhecido nunca e reescrito por adivinhacao, apenas mantido como veio.
const CARTOES_EMISSORES_ACEITOS = ['Bradesco','BTG Pactual','BRB','CAIXA','Itaú',
  'Sicoob','Unicred','Banco Inter','Santander','XP','Banestes','Banco do Brasil',
  'Banco Safra','C6 Bank','Genial Investimentos','Nubank','Porto Bank','Revolut','Sicredi'];

function cartoesChaveEmissor(s) {
  // Descarta acento e TODA pontuacao. Sem isso, remover o sufixo 'S.A.' deixava
  // um ponto orfao ('Banco do Brasil .') e a chave nunca casava com o canonico.
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Mapa indexado pela mesma funcao de chave, para as entradas legiveis acima
// continuarem casando depois que a pontuacao passou a ser descartada.
const CARTOES_EMISSORES_INDEX = {};
Object.keys(CARTOES_EMISSORES_CANONICOS).forEach(k => {
  CARTOES_EMISSORES_INDEX[cartoesChaveEmissor(k)] = CARTOES_EMISSORES_CANONICOS[k];
});

function cartoesNormalizarEmissor(valor) {
  if (!valor || typeof valor !== 'string') return valor || null;
  const bruto = valor.trim();
  if (!bruto) return null;

  const chave = cartoesChaveEmissor(bruto);
  if (CARTOES_EMISSORES_INDEX[chave]) return CARTOES_EMISSORES_INDEX[chave];

  // Segunda tentativa: remove sufixo entre parenteses, aposto apos travessao
  // ou barra, e sufixo de razao social. Serve so para reconsultar o mapa.
  const limpo = bruto
    .replace(/\([^)]*\)/g, ' ')
    .split(/\s+[-\u2010-\u2015/]\s+/)[0]
    .replace(/\bS\.?\s*\/?\s*A\.?\b/gi, ' ')
    .replace(/\s+/g, ' ').trim();

  const chaveLimpa = cartoesChaveEmissor(limpo);
  if (CARTOES_EMISSORES_INDEX[chaveLimpa]) return CARTOES_EMISSORES_INDEX[chaveLimpa];

  const aceito = CARTOES_EMISSORES_ACEITOS.find(a => cartoesChaveEmissor(a) === chaveLimpa);
  if (aceito) return aceito;

  // Desconhecido: mantem o texto original. Normalizar por adivinhacao ja
  // produziu emissor errado antes; melhor uma grafia nova visivel na lista.
  return bruto;
}

function cartoesSanitizar(cartao) {
  const c = { ...(cartao || {}) };
  // A IA ora devolve cashback como objeto, ora como frase. Normaliza para objeto
  // para a tela nao exibir "a confirmar" quando existe informacao textual.
  if (typeof c.cashback === 'string' && c.cashback.trim()) {
    c.cashback = { nacional: null, internacional: null, observacao: c.cashback.trim() };
  }
  const proc = c.procedencia && typeof c.procedencia === 'object' ? { ...c.procedencia } : {};
  const pendentes = new Set(Array.isArray(c.campos_pendentes) ? c.campos_pendentes : []);
  const rejeitados = [];

  c.fontes = Array.from(new Set(
    (Array.isArray(c.fontes) ? c.fontes : [])
      .filter(cartoesFonteOficial).map(cartoesUrlLimpa)
  ));

  CATALOGO_CAMPOS.forEach(campo => {
    const temValor = !catalogoVazio(c[campo]);
    const fonteBruta = cartoesProcDoCampo(proc, campo);
    const fonteOk  = !!fonteBruta && cartoesFonteOficial(fonteBruta);
    if (temValor && !fonteOk) {
      rejeitados.push(campo);
      c[campo] = Array.isArray(c[campo]) ? [] : null;
      delete proc[campo];
      pendentes.add(campo);
    } else if (temValor && fonteOk) {
      pendentes.delete(campo);
      const limpa = cartoesUrlLimpa(fonteBruta);
      if (c.fontes.indexOf(limpa) < 0) c.fontes.push(limpa);
    } else {
      pendentes.add(campo);
      delete proc[campo];
    }
  });

  c.procedencia = proc;
  // Analise e OPINIAO derivada dos fatos, nao dado do emissor. Nao exige
  // procedencia, mas fica marcada para nunca ser confundida com fato apurado.
  if (c.analise && typeof c.analise === 'object') {
    c.analise = {
      origem: 'editorial',
      gerada_em: c.analise.gerada_em || new Date().toISOString().slice(0, 10),
      vantagens: (Array.isArray(c.analise.vantagens) ? c.analise.vantagens : []).map(String).slice(0, 8),
      desvantagens: (Array.isArray(c.analise.desvantagens) ? c.analise.desvantagens : []).map(String).slice(0, 8)
    };
  } else { c.analise = null; }
  // Descarta pendencias inventadas (ex: 'transfere_para_dotz_ratio'):
  // so vale nome de campo real, ou subcampo dele.
  c.campos_pendentes = Array.from(pendentes).filter(p =>
    CATALOGO_CAMPOS.some(k => p === k || p.indexOf(k + '.') === 0)
  ).sort();
  if (rejeitados.length) c.campos_rejeitados = rejeitados;
  // Ref explicito prevalece: houve caso de nome com 'Privilege' num cartao Infinite.
  if (!c.bandeira_ref) c.bandeira_ref = catalogoBandeiraRef(c);
  // Quantidade de escolhas e beneficios fixos do Elo Flex variam por emissor,
  // entao sao declarados no cartao. Valem a mesma regra de procedencia dos demais
  // campos factuais, mas so entram em campos_pendentes quando o cartao os declara:
  // marcar como pendente em cartao Visa/Mastercard seria ruido.
  ['flex_quantidade', 'flex_fixos'].forEach(campo => {
    if (catalogoVazio(c[campo])) { delete c[campo]; return; }
    const fonteBruta = cartoesProcDoCampo(proc, campo);
    if (!fonteBruta || !cartoesFonteOficial(fonteBruta)) {
      rejeitados.push(campo);
      delete c[campo];
      delete proc[campo];
      return;
    }
    const limpa = cartoesUrlLimpa(fonteBruta);
    if (c.fontes.indexOf(limpa) < 0) c.fontes.push(limpa);
    if (campo === 'flex_quantidade') {
      const n = parseInt(c[campo], 10);
      if (!Number.isFinite(n) || n <= 0) { delete c[campo]; return; }
      c[campo] = n;
    } else {
      c[campo] = c[campo].map(String).filter(Boolean);
    }
  });
  if (rejeitados.length) c.campos_rejeitados = rejeitados;

  c.emissor = cartoesNormalizarEmissor(c.emissor);
  c.verificado_em = c.verificado_em || new Date().toISOString().slice(0, 10);
  return c;
}

app.get('/catalogo-cartoes', async (req, res) => {
  try {
    const { data } = await ghGetJson(CATALOGO_PATH, { cartoes: [] });
    const lista = (data.cartoes || []).slice().sort((a, b) =>
      String(a.nome || '').localeCompare(String(b.nome || ''), 'pt-BR'));
    res.json({ ok: true, total: lista.length, cartoes: lista, meta: data._meta || {} });
  } catch (e) {
    console.error('[catalogo GET]', e.message);
    res.status(500).json({ ok: false, erro: e.message });
  }
});

app.get('/bandeiras', async (req, res) => {
  try {
    const { data } = await ghGetJson(BANDEIRAS_PATH, { bandeiras: [] });
    res.json({ ok: true, bandeiras: data.bandeiras || [] });
  } catch (e) {
    console.error('[bandeiras GET]', e.message);
    res.status(500).json({ ok: false, erro: e.message });
  }
});

app.get('/catalogo-cartoes/:slug', async (req, res) => {
  try {
    const { data } = await ghGetJson(CATALOGO_PATH, { cartoes: [] });
    const cartao = (data.cartoes || []).find(c => c.slug === req.params.slug);
    if (!cartao) return res.status(404).json({ ok: false, erro: 'Cartao nao encontrado.' });

    // Resolve os beneficios herdados da bandeira
    let beneficiosBandeira = [];
    let bandeiraInfo = null;
    const ref = cartao.bandeira_ref || catalogoBandeiraRef(cartao);
    if (ref) {
      const { data: bd } = await ghGetJson(BANDEIRAS_PATH, { bandeiras: [] });
      const b = (bd.bandeiras || []).find(x => x.ref === ref);
      if (b) {
        beneficiosBandeira = b.beneficios || [];
        // O front precisa saber se o catalogo e fixo ou de escolha (Elo Flex)
        // para nao dar a entender que o cliente tem todos os itens da lista.
        bandeiraInfo = {
          ref: b.ref, bandeira: b.bandeira, categoria: b.categoria,
          modelo: b.modelo || 'fixo', nota: b.nota || null,
          regras: b.regras || [], fonte: b.fonte || null
        };
      }
    }
    res.json({ ok: true, cartao: {
      ...cartao, beneficios_bandeira: beneficiosBandeira, bandeira_info: bandeiraInfo
    } });
  } catch (e) {
    console.error('[catalogo GET slug]', e.message);
    res.status(500).json({ ok: false, erro: e.message });
  }
});

app.post('/catalogo-cartoes', async (req, res) => {
  try {
    const entrada = req.body && req.body.cartao;
    if (!entrada || !entrada.nome) {
      return res.status(400).json({ ok: false, erro: 'Campo obrigatorio: cartao.nome' });
    }
    const cartao = cartoesSanitizar({ ...entrada, slug: entrada.slug || cartoesSlugify(entrada.nome) });

    // SHA sempre fresco, imediatamente antes do PUT
    const { data, sha } = await ghGetJson(CATALOGO_PATH, { _meta: {}, cartoes: [] });
    const lista = data.cartoes || [];
    // Casar tambem por nome normalizado: o mesmo produto escrito de dois jeitos
    // ("C6 Carbon" e "C6 Carbon Mastercard Black") gerava slugs diferentes e duplicava.
    let idx = lista.findIndex(c => c.slug === cartao.slug);
    if (idx < 0) idx = lista.findIndex(c => catalogoMesmoCartao(c, cartao));
    if (idx >= 0) cartao.slug = lista[idx].slug;
    if (idx >= 0) lista[idx] = { ...lista[idx], ...cartao };
    else lista.push(cartao);

    lista.sort((a, b) => String(a.nome || '').localeCompare(String(b.nome || ''), 'pt-BR'));
    data.cartoes = lista;
    data._meta = { ...(data._meta || {}), total: lista.length, atualizado_em: new Date().toISOString().slice(0, 10) };

    await ghPutJson(CATALOGO_PATH, data, sha, `catalogo: ${idx >= 0 ? 'atualiza' : 'adiciona'} ${cartao.slug}`);
    // Devolve a lista ja atualizada: ler de volta do GitHub logo apos o PUT
    // pode retornar conteudo em cache e a tela ficaria sem o cartao recem-salvo.
    res.json({ ok: true, cartao, novo: idx < 0, total: lista.length, cartoes: lista });
  } catch (e) {
    console.error('[catalogo POST]', e.message);
    res.status(500).json({ ok: false, erro: e.message });
  }
});

app.delete('/catalogo-cartoes/:slug', async (req, res) => {
  try {
    const { data, sha } = await ghGetJson(CATALOGO_PATH, { _meta: {}, cartoes: [] });
    const lista = data.cartoes || [];
    const restante = lista.filter(c => c.slug !== req.params.slug);
    if (restante.length === lista.length) {
      return res.status(404).json({ ok: false, erro: 'Cartao nao encontrado.' });
    }
    data.cartoes = restante;
    data._meta = { ...(data._meta || {}), total: restante.length, atualizado_em: new Date().toISOString().slice(0, 10) };
    await ghPutJson(CATALOGO_PATH, data, sha, `catalogo: remove ${req.params.slug}`);
    res.json({ ok: true, total: restante.length });
  } catch (e) {
    console.error('[catalogo DELETE]', e.message);
    res.status(500).json({ ok: false, erro: e.message });
  }
});


// ── Analise editorial: vantagens e desvantagens derivadas dos fatos apurados ──
// Nao consulta a web. Opina apenas sobre o que ja esta na base, para nao
// introduzir informacao sem procedencia por via indireta.
app.post('/catalogo-cartoes/analisar', async (req, res) => {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ ok: false, erro: 'ANTHROPIC_API_KEY nao configurada.' });
  const slug = (req.body && req.body.slug || '').trim();
  if (!slug) return res.status(400).json({ ok: false, erro: 'Campo obrigatorio: slug' });

  let cartao;
  try {
    const { data } = await ghGetJson(CATALOGO_PATH, { cartoes: [] });
    cartao = (data.cartoes || []).find(c => c.slug === slug);
  } catch (e) { return res.status(500).json({ ok: false, erro: e.message }); }
  if (!cartao) return res.status(404).json({ ok: false, erro: 'Cartao nao encontrado.' });

  const systemPrompt = `Voce analisa cartoes de credito para viajantes brasileiros que acumulam milhas.
Recebe a ficha tecnica JA VERIFICADA de um cartao e deve apontar vantagens e desvantagens.

REGRAS:
- Baseie-se EXCLUSIVAMENTE nos dados do JSON recebido. Nao use conhecimento externo nem invente numeros.
- Campos null significam "nao apurado". NUNCA trate null como zero, gratuito ou inexistente.
- Se a ausencia de um dado for relevante para a decisao, isso pode virar uma desvantagem, mas descrita como falta de transparencia, nao como valor ruim.
- Cada item deve ser uma frase curta e concreta, citando o numero quando houver.
- 3 a 5 vantagens e 2 a 4 desvantagens. Nao force: se nao houver base, devolva menos itens.

Responda SOMENTE com JSON: {"vantagens":["..."],"desvantagens":["..."]}`;

  const bodyPayload = JSON.stringify({
    model: 'claude-sonnet-4-6', max_tokens: 2048, system: systemPrompt,
    messages: [{ role: 'user', content: JSON.stringify(cartao) }]
  });
  // Uma resposta so. apiReq.destroy() dispara 'error', que antes tentava
  // responder de novo e derrubava o processo com ERR_HTTP_HEADERS_SENT.
  let respondido = false;
  const responder = (payload, status) => {
    if (respondido || res.headersSent) return;
    respondido = true;
    res.status(status || 200).json(payload);
  };
  const https = require('https');
  const options = { hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyPayload),
               'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' } };

  const apiReq = https.request(options, (apiRes) => {
    let buf = '';
    apiRes.on('data', d => buf += d);
    apiRes.on('end', () => {
      try {
        const parsed = JSON.parse(buf);
        if (parsed.error) return responder({ ok: false, erro: parsed.error.message });
        const raw = (parsed.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n')
                      .replace(/```json|```/g, '').trim();
        const m = raw.match(/\{[\s\S]*\}/);
        if (!m) return responder({ ok: false, erro: 'IA nao retornou JSON.' });
        const a = JSON.parse(m[0]);
        responder({ ok: true, analise: { origem: 'editorial',
          gerada_em: new Date().toISOString().slice(0, 10),
          vantagens: a.vantagens || [], desvantagens: a.desvantagens || [] } });
      } catch (e) { responder({ ok: false, erro: 'Erro ao processar resposta da IA.' }); }
    });
  });
  apiReq.on('error', e => responder({ ok: false, erro: 'Falha de rede: ' + e.message }, 502));
  apiReq.setTimeout(150000, () => {
    responder({ ok: false, erro: 'Timeout na analise (150s).' });
    apiReq.destroy();
  });
  apiReq.write(bodyPayload); apiReq.end();
});

// ── Extrator: recebe apenas o NOME do cartao e busca o dado na fonte oficial ──
app.post('/catalogo-cartoes/extrair', (req, res) => {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ ok: false, erro: 'ANTHROPIC_API_KEY nao configurada no servidor.' });
  }
  const nome = (req.body && req.body.nome || '').trim();
  if (!nome) return res.status(400).json({ ok: false, erro: 'Campo obrigatorio: nome' });

  try {
  const systemPrompt = `Voce e um curador de dados de cartoes de credito brasileiros. Recebe o NOME de um cartao e deve pesquisar na web para preencher uma ficha tecnica.

REGRA ABSOLUTA DE PROCEDENCIA:
Use EXCLUSIVAMENTE paginas do proprio banco emissor ou da bandeira (dominios oficiais: caixa.gov.br, bb.com.br, itau.com.br, bradesco.com.br, santander.com.br, nubank.com.br, c6bank.com.br, bancointer.com.br, xpi.com.br, btgpactual.com, sicredi.com.br, sicoob.com.br, brb.com.br, visa.com.br, mastercard.com.br, elo.com.br, americanexpress.com).
NUNCA use blogs, portais de comparacao, agregadores, sites de noticias ou canais de milhas. Eles frequentemente publicam valores desatualizados.
Para CADA campo preenchido voce DEVE informar em "procedencia" a URL oficial de onde leu o valor. Use como chave o NOME EXATO do campo (ex: "pontos", "salas_vip"), nunca subcampos como "pontos.nacional". O valor deve ser SO a URL, sem citacao ou comentario anexado. Campo sem procedencia sera descartado pelo servidor.\nSe um dado nao aparecer em fonte oficial, deixe o campo como null e liste o nome do campo em campos_pendentes. NUNCA infira, estime ou complete por conhecimento previo. Campo vazio e melhor que campo errado.
Priorize, quando existirem: pagina do produto, tabela de tarifas e contrato/regulamento do programa de pontos.

Responda SOMENTE com JSON valido, sem markdown, nesta estrutura:
{
  "slug": "kebab-case",
  "nome": "", "emissor": "", "bandeira": "", "categoria": "",
  "anuidade": null, "anuidade_parcelas": null,
  "isencao": { "tipo": null, "valor": null, "regra": null },
  "renda_minima": null, "requisito_acesso": null, "adicionais_gratis": null,
  "pontos": { "nacional": null, "internacional": null, "unidade": "pts/USD", "observacao": null },
  "cashback": null,
  "programa_proprio": null, "transfere_para": [],
  "spread": null, "iof": null, "validade_pontos": null,
  "salas_vip": [ { "programa": "", "regra": "" } ],
  "beneficios_banco": [ { "titulo": "", "descricao": "" } ],
  "link_solicitacao": "", "fontes": ["URLs oficiais efetivamente consultadas"],
  "campos_pendentes": [], "nota_curadoria": "",\n  "procedencia": { "nome_exato_do_campo": "URL oficial pura, sem citacao anexada" },
  "vigencia_ate": null
}

Use vigencia_ate (AAAA-MM-DD) quando algum beneficio for promocional com prazo.`;

  const bodyPayload = JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: systemPrompt,
    tools: [{
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: 6,
      allowed_domains: CARTOES_DOMINIOS_OFICIAIS
    }],
    messages: [{ role: 'user', content: `Pesquise e extraia a ficha tecnica do cartao: ${nome}` }]
  });

  // Uma resposta so. apiReq.destroy() dispara 'error', que antes tentava
  // responder de novo e derrubava o processo com ERR_HTTP_HEADERS_SENT.
  let respondido = false;
  const responder = (payload, status) => {
    if (respondido || res.headersSent) return;
    respondido = true;
    res.status(status || 200).json(payload);
  };
  const https = require('https');
  const options = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(bodyPayload),
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    }
  };

  const apiReq = https.request(options, (apiRes) => {
    let buf = '';
    apiRes.on('data', d => buf += d);
    apiRes.on('end', () => {
      try {
        const parsed = JSON.parse(buf);
        if (parsed.error) {
          const tipo = parsed.error.type || '';
          const limite = apiRes.statusCode === 429 || tipo === 'rate_limit_error' ||
                         tipo === 'overloaded_error';
          return responder({ ok: false, erro: parsed.error.message, tipo: tipo,
                             limite: limite, http: apiRes.statusCode }, limite ? 429 : 200);
        }
        const raw = (parsed.content || [])
          .filter(b => b.type === 'text').map(b => b.text).join('\n')
          .replace(/```json|```/g, '').trim();
        const m = raw.match(/\{[\s\S]*\}/);
        if (!m) return responder({ ok: false, erro: 'IA nao retornou JSON.' });

        const bruto = JSON.parse(m[0]);
        bruto.slug = bruto.slug || cartoesSlugify(bruto.nome || nome);
        const cartao = cartoesSanitizar(bruto);
        responder({
          ok: true,
          cartao,
          aviso: cartao.campos_rejeitados
            ? ('Campos sem procedencia oficial foram descartados: ' + cartao.campos_rejeitados.join(', '))
            : null
        });
      } catch (e) {
        console.error('[catalogo/extrair] parse error:', e.message, 'raw:', buf.slice(0, 300));
        responder({ ok: false, erro: 'Erro ao processar resposta da IA.' });
      }
    });
  });
  apiReq.on('error', (e) => { console.error('[catalogo/extrair] req error:', e.message); responder({ ok: false, erro: 'Falha de rede: ' + e.message }, 502); });
  apiReq.setTimeout(170000, () => {
    responder({ ok: false, erro: 'Timeout na extracao (170s). Tente este cartao sozinho.' });
    apiReq.destroy();
  });
  apiReq.write(bodyPayload);
  apiReq.end();
  } catch (e) {
    console.error('[catalogo/extrair] excecao:', (e && e.stack) || e);
    responder({ ok: false, erro: 'Falha no extrator: ' + ((e && e.message) || String(e)) });
  }
});

// ══════════════════════════════════════════════════════════════════════════════


// ── Comissões de afiliados (TSP) ──────────────────────────────────────────────
// Dados coletados diariamente por tudo-sobre-promos/coletar-comissoes.js às 20h
// SP nas três plataformas (Amazon Associados, Mercado Livre, Shopee).
// Substitui a leitura da aba "Comissionamento" do Apps Script no painel.html.
//
// Formato do arquivo: { atualizadoEm, dias: { "YYYY-MM-DD": { amazon|ml|shopee:
// { cliques, vendas, comissao, vendasRev?, comissaoRev? } | null } } }
//
// `vendas`/`comissao` são a FOTO do dia (congelada). `vendasRev`/`comissaoRev`
// só aparecem quando a plataforma revisou o número depois — ML e Shopee revisam
// nos dois sentidos, Amazon não revisa. O front escolhe qual usar.
const COMISSOES_FILE = 'tsp/comissoes-afiliados.json';
const PLATAFORMAS_AFILIADOS = ['amazon', 'ml', 'shopee'];

// GET /afiliados/comissoes?de=YYYY-MM-DD&ate=YYYY-MM-DD&plataforma=ml
// Sem parâmetros devolve tudo. `de`/`ate` são inclusivos.
app.get('/afiliados/comissoes', async (req, res) => {
  try {
    const { data } = await ghGetJson(COMISSOES_FILE, { dias: {} });
    const dias = data.dias || {};
    const { de, ate, plataforma } = req.query;

    const valida = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
    if ((de && !valida(de)) || (ate && !valida(ate))) {
      return res.status(400).json({ ok: false, erro: 'de/ate devem estar em YYYY-MM-DD' });
    }
    if (plataforma && !PLATAFORMAS_AFILIADOS.includes(plataforma)) {
      return res.status(400).json({ ok: false, erro: `plataforma deve ser uma de: ${PLATAFORMAS_AFILIADOS.join(', ')}` });
    }

    const saida = {};
    for (const dia of Object.keys(dias).sort()) {
      if (de && dia < de) continue;
      if (ate && dia > ate) continue;
      saida[dia] = plataforma ? { [plataforma]: dias[dia]?.[plataforma] ?? null } : dias[dia];
    }

    res.json({ ok: true, atualizadoEm: data.atualizadoEm || null, total: Object.keys(saida).length, dias: saida });
  } catch (e) {
    console.error('[afiliados/comissoes GET]', e.message);
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// POST /afiliados/comissoes  { data, plataforma, cliques, vendas, comissao }
// Correção manual pontual. A coleta automática NÃO passa por aqui — ela escreve
// direto no GitHub — então este endpoint sempre sobrescreve a foto, que é o que
// se espera de uma correção feita à mão.
app.post('/afiliados/comissoes', async (req, res) => {
  const { data: dia, plataforma, cliques, vendas, comissao } = req.body || {};

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dia || '')) {
    return res.status(400).json({ ok: false, erro: 'data obrigatória em YYYY-MM-DD' });
  }
  if (!PLATAFORMAS_AFILIADOS.includes(plataforma)) {
    return res.status(400).json({ ok: false, erro: `plataforma deve ser uma de: ${PLATAFORMAS_AFILIADOS.join(', ')}` });
  }
  const numOuNulo = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
  const valores = { cliques: numOuNulo(cliques), vendas: numOuNulo(vendas), comissao: numOuNulo(comissao) };
  if (Object.values(valores).some((v) => v !== null && !Number.isFinite(v))) {
    return res.status(400).json({ ok: false, erro: 'cliques/vendas/comissao devem ser numéricos ou nulos' });
  }

  // 409 = outra escrita venceu a corrida. O coletor grava no mesmo arquivo às
  // 20h; sem retry uma correção feita nesse minuto se perderia.
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    try {
      const { data: arquivo, sha } = await ghGetJson(COMISSOES_FILE, { dias: {} });
      arquivo.dias = arquivo.dias || {};
      arquivo.dias[dia] = arquivo.dias[dia] || {};
      arquivo.dias[dia][plataforma] = valores;
      arquivo.dias = Object.fromEntries(Object.keys(arquivo.dias).sort().map((k) => [k, arquivo.dias[k]]));
      arquivo.atualizadoEm = new Date().toISOString();

      await ghPutJson(COMISSOES_FILE, arquivo, sha, `chore: correção manual ${plataforma} ${dia}`);
      return res.json({ ok: true, dia, plataforma, valores });
    } catch (e) {
      if (/409|sha/i.test(e.message) && tentativa < 2) continue;
      console.error('[afiliados/comissoes POST]', e.message);
      return res.status(500).json({ ok: false, erro: e.message });
    }
  }
});


// Qualquer excecao nao tratada vira JSON, nunca a pagina HTML do Express.
// Sem isso o front recebe '<' e a causa real se perde.
app.use((err, req, res, next) => {
  console.error('[erro nao tratado]', req.method, req.path, (err && err.stack) || err);
  if (res.headersSent) return next(err);
  res.status(500).json({ ok: false, erro: (err && err.message) || 'Erro interno', rota: req.path });
});

process.on('uncaughtException', (e) => {
  console.error('[uncaughtException] processo seguiu vivo:', (e && e.stack) || e);
});
process.on('unhandledRejection', (e) => {
  console.error('[unhandledRejection]', (e && e.stack) || e);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`CDV Proxy rodando na porta ${PORT}`);
});



