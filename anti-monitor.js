// anti-monitor.js — quem esta "quebrando" os links rastreados do Tica Promos
//
// MODO OBSERVACAO (desde 21/11/2026): nada e bloqueado e ninguem espera nada.
// O redirecionamento de ir.ticapromos.com.br/<loja>/<codigo>-<grupo> continua
// o mesmo 302 de sempre; esta conta e feita DEPOIS da resposta sair
// (setImmediate no index.js), so para registrar quem SERIA barrado se um dia o
// bloqueio for ligado. Decisao do Davi: cliente normal com acesso rapido vale
// mais que impedir o monitor — por isso o bloqueio so liga depois de conferir
// esta lista e ver que nao tem gente de verdade nela.
//
// "Seria barrado" (motivos):
//   programa       — user-agent de biblioteca/robo (curl, python, Go, headless…)
//   head           — pedido HEAD (resolve o destino sem abrir a pagina)
//   servidor:<id>  — IP de servidor/nuvem (AWS, Google Cloud, Oracle,
//                    DigitalOcean, Linode, lista geral de datacenters)
// So registrado (nunca seria barrado):
//   previa_de_servidor — robo de previa (WhatsApp/Telegram…) vindo de servidor:
//                        e como um bot (Baileys) de concorrente repassa a oferta
//   rajada             — mesmo IP abrindo 4+ links distintos em 1 minuto
// Fora da conta: robo de anuncio da Meta e previa vinda de celular.
// IP do iCloud Private Relay (Safari no iPhone) NUNCA conta como servidor:
// ele sai por Akamai/Cloudflare/Fastly, que estao na lista de datacenters.
//
// Listas de rede: baixadas das fontes oficiais 45 s depois do boot e de 24 em
// 24 h (uma por vez, leitura em pedacos para nao travar o servidor). Falha de
// uma lista mantem a anterior. Sem lista carregada, IP fica "desconhecido"
// e nao conta como servidor (na duvida, libera).
//
// Registro do dia: memoria + tsp/vigia-monitor_<dia>.json (repo de dados) a
// cada 5 min e no SIGTERM. IP so em hash. Leitura: GET /links/monitor.
//
// BLOQUEIO (desde 27/11/2026, aprovado depois de 6 dias de observacao):
// decidir() roda ANTES do 302 e custa microssegundos (lista em memoria).
// Recebe a pagina generica (200, sem o destino) so quem tem sinal forte:
//   programa          - user-agent de biblioteca/robo
//   head              - pedido HEAD
//   servidor_repetido - IP de servidor com LIMIAR+ cliques no dia (padrao 5),
//                       ou que ja bateu o limiar hoje/ontem (reincidente,
//                       lido do arquivo do dia no boot e de hora em hora)
// Clique isolado de servidor (VPN, rede de empresa) continua liberado.
// Previa (WhatsApp etc.) e robo da Meta nunca sao barrados. Erro = libera.
// Kill switch: ANTI_MONITOR_MODO=observacao volta ao modo so de registro;
// ANTI_MONITOR_LIMIAR muda o limiar de cliques de servidor.
//
// SUPORTE NA PAGINA DE BLOQUEIO (ideia de um conhecido, 27/11/2026): a pagina
// mostra um codigo (6 letras, tirado do hash do IP) e um botao que abre o
// WhatsApp do suporte (env ANTI_MONITOR_SUPORTE_WA, so numeros) com a mensagem
// pronta. Quem mandar: o operador consulta o codigo (GET /links/monitor/codigo)
// e ve motivo, grupos e cliques. Gente de verdade -> POST /links/monitor/liberar
// (o IP nunca mais cai em servidor_repetido); monitor -> tirar do grupo.
// Sem a env, a pagina mostra so o codigo.

const crypto = require('crypto');

const FONTES = [
  { id: 'aws', url: 'https://ip-ranges.amazonaws.com/ip-ranges.json',
    ler: t => { const d = JSON.parse(t); return [...(d.prefixes || []).map(p => p.ip_prefix), ...(d.ipv6_prefixes || []).map(p => p.ipv6_prefix)]; } },
  { id: 'google-cloud', url: 'https://www.gstatic.com/ipranges/cloud.json',
    ler: t => (JSON.parse(t).prefixes || []).map(p => p.ipv4Prefix || p.ipv6Prefix) },
  { id: 'oracle', url: 'https://docs.oracle.com/en-us/iaas/tools/public_ip_ranges.json',
    ler: t => { const out = []; for (const r of (JSON.parse(t).regions || [])) for (const c of (r.cidrs || [])) out.push(c.cidr); return out; } },
  { id: 'digitalocean', url: 'https://digitalocean.com/geo/google.csv', ler: linhasCsv },
  { id: 'linode', url: 'https://geoip.linode.com/', ler: linhasCsv },
  { id: 'datacenter', url: 'https://raw.githubusercontent.com/X4BNet/lists_vpn/main/output/datacenter/ipv4.txt', ler: linhasCsv },
  // Excecao: so IPv4 (o IPv6 do Relay e de CDN, que nao esta nas listas acima)
  { id: 'icloud-relay', url: 'https://mask-api.icloud.com/egress-ip-ranges.csv', excecao: true, soV4: true, ler: linhasCsv },
];
// Na consulta, a excecao (Relay) vem antes: o mesmo IP esta na lista geral.
const FONTES_EXCECAO_PRIMEIRO = [...FONTES.filter(f => f.excecao), ...FONTES.filter(f => !f.excecao)];
const ATUALIZAR_MS = 24 * 60 * 60 * 1000;
const PRIMEIRA_MS  = 45 * 1000;
const FLUSH_MS     = 5 * 60 * 1000;
const MODO = String(process.env.ANTI_MONITOR_MODO || 'bloqueio').toLowerCase() === 'observacao' ? 'observacao' : 'bloqueio';
const LIMIAR_SERVIDOR = Math.max(2, parseInt(process.env.ANTI_MONITOR_LIMIAR, 10) || 5);
const RECARREGAR_MS = 60 * 60 * 1000;
const MAX_IPS      = 1000;   // IPs distintos guardados por dia
const LAT_AMOSTRAS = 2000;

function linhasCsv(t) {
  const out = [];
  for (const l of String(t).split('\n')) {
    const s = l.trim();
    if (!s || s[0] === '#') continue;
    const c = s.split(',')[0].trim();
    if (c) out.push(c);
  }
  return out;
}

// ── IPs ──────────────────────────────────────────────────────────────────────
function v4Int(ip) {
  const p = String(ip).split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const x of p) {
    if (!/^\d{1,3}$/.test(x)) return null;
    const v = Number(x); if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}
function v6Big(ip) {
  let s = String(ip).toLowerCase().split('%')[0];
  if (!s.includes(':')) return null;
  // IPv6 com IPv4 no fim (::ffff:1.2.3.4)
  const m = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (m) { const v = v4Int(m[2]); if (v == null) return null; s = m[1] + (v >>> 16).toString(16) + ':' + (v & 0xffff).toString(16); }
  const partes = s.split('::');
  if (partes.length > 2) return null;
  const a = partes[0] ? partes[0].split(':') : [];
  const b = partes.length === 2 && partes[1] ? partes[1].split(':') : [];
  const falta = 8 - a.length - b.length;
  if (partes.length === 1 ? a.length !== 8 : falta < 0) return null;
  const grupos = [...a, ...Array(partes.length === 2 ? falta : 0).fill('0'), ...b];
  let n = 0n;
  for (const g of grupos) { if (!/^[0-9a-f]{1,4}$/.test(g)) return null; n = (n << 16n) | BigInt(parseInt(g, 16)); }
  return n;
}
function faixa(cidr) {
  const [base, bitsTxt] = String(cidr || '').trim().split('/');
  if (!base) return null;
  if (base.includes(':')) {
    const n = v6Big(base); const bits = bitsTxt == null ? 128 : Number(bitsTxt);
    if (n == null || !(bits >= 0 && bits <= 128)) return null;
    const host = (1n << BigInt(128 - bits)) - 1n;
    return { v6: true, s: n & ~host & ((1n << 128n) - 1n), e: (n & ~host) | host };
  }
  const n = v4Int(base); const bits = bitsTxt == null ? 32 : Number(bitsTxt);
  if (n == null || !(bits >= 0 && bits <= 32)) return null;
  const tam = 2 ** (32 - bits);
  const s = Math.floor(n / tam) * tam;
  return { v6: false, s, e: s + tam - 1 };
}
function juntar(lista) {
  lista.sort((x, y) => (x.s < y.s ? -1 : x.s > y.s ? 1 : 0));
  const out = [];
  for (const r of lista) {
    const u = out[out.length - 1];
    if (u && r.s <= u.e + (typeof u.e === 'bigint' ? 1n : 1)) { if (r.e > u.e) u.e = r.e; }
    else out.push({ s: r.s, e: r.e });
  }
  return out;
}
function contem(arr, n) {
  let lo = 0, hi = arr.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (arr[m].s > n) hi = m - 1;
    else if (arr[m].e < n) lo = m + 1;
    else return true;
  }
  return false;
}
const pausa = () => new Promise(r => setImmediate(r));

// ── Estado das listas ────────────────────────────────────────────────────────
// redes[id] = { v4: Float64Array-like [{s,e}], v6: [{s,e}], faixas, em, erro }
const redes = {};

async function carregarFonte(fetch, f) {
  const t0 = Date.now();
  try {
    const r = await fetch(f.url, { signal: AbortSignal.timeout(90 * 1000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const texto = await r.text();
    await pausa();
    const cidrs = f.ler(texto);
    const v4 = [], v6 = [];
    for (let i = 0; i < cidrs.length; i++) {
      const c = cidrs[i];
      if (f.soV4 && String(c).includes(':')) continue;
      const x = faixa(c);
      if (x) (x.v6 ? v6 : v4).push(x);
      if (i % 5000 === 4999) await pausa();   // nao travar o servidor
    }
    await pausa();
    const j4 = juntar(v4); await pausa();
    const j6 = juntar(v6);
    redes[f.id] = { v4: j4, v6: j6, faixas: cidrs.length, em: new Date().toISOString(), ms: Date.now() - t0, erro: null };
  } catch (e) {
    const ant = redes[f.id];
    redes[f.id] = ant ? { ...ant, erro: e.message, tentouEm: new Date().toISOString() }
                      : { v4: [], v6: [], faixas: 0, em: null, erro: e.message, tentouEm: new Date().toISOString() };
    console.error('[anti-monitor] lista', f.id, e.message);
  }
}
async function carregarTudo(fetch) {
  for (const f of FONTES) { await carregarFonte(fetch, f); await pausa(); }
  console.log('[anti-monitor] listas:', FONTES.map(f => f.id + '=' + ((redes[f.id] && redes[f.id].faixas) || 0)).join(' '));
}

// { rede: 'relay'|'servidor'|'comum'|'desconhecido', provedor? }
function classificarIp(ipBruto) {
  let ip = String(ipBruto || '').trim();
  if (ip.startsWith('::ffff:') && ip.includes('.')) ip = ip.slice(7);
  const v6 = ip.includes(':');
  const n = v6 ? v6Big(ip) : v4Int(ip);
  if (n == null) return { rede: 'desconhecido' };
  let algumaLista = false;
  for (const f of FONTES_EXCECAO_PRIMEIRO) {
    const r = redes[f.id];
    if (!r || !r.em) continue;
    algumaLista = true;
    if (contem(v6 ? r.v6 : r.v4, n)) return f.excecao ? { rede: 'relay', provedor: f.id } : { rede: 'servidor', provedor: f.id };
  }
  return { rede: algumaLista ? 'comum' : 'desconhecido' };
}

// ── Latencia do redirecionamento ─────────────────────────────────────────────
const latencias = [];   // { ms, origem }
function registrarLatencia(ms, origem) {
  latencias.push({ ms, origem: origem || '?' });
  if (latencias.length > LAT_AMOSTRAS) latencias.shift();
}
function percentis(lista) {
  if (!lista.length) return null;
  const v = lista.map(x => x.ms).sort((a, b) => a - b);
  const p = q => Math.round(v[Math.min(v.length - 1, Math.floor(q * v.length))] * 10) / 10;
  return { amostras: v.length, p50: p(0.5), p95: p(0.95), p99: p(0.99), max: Math.round(v[v.length - 1] * 10) / 10 };
}
const custoClassificacao = { n: 0, totalUs: 0, maxUs: 0 };

// ── Registro do dia ──────────────────────────────────────────────────────────
function hojeSP() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }); }
function diaVazio(dia) {
  return { dia, cliques: 0, seriaBarrado: 0, bloqueados: 0, relayLiberado: 0, desconhecido: 0, motivos: {}, grupos: {}, ips: {} };
}
let buffer = {};        // dia -> parcial ainda nao gravado
let sujo = false;

function somarDia(acc, d) {
  for (const k of ['cliques', 'seriaBarrado', 'bloqueados', 'relayLiberado', 'desconhecido']) acc[k] = (acc[k] || 0) + (d[k] || 0);
  for (const [k, n] of Object.entries(d.motivos || {})) acc.motivos[k] = (acc.motivos[k] || 0) + n;
  for (const [g, x] of Object.entries(d.grupos || {})) {
    const a = acc.grupos[g] || (acc.grupos[g] = { cliques: 0, seriaBarrado: 0 });
    a.cliques += x.cliques || 0; a.seriaBarrado += x.seriaBarrado || 0;
    if (x.bloqueados) a.bloqueados = (a.bloqueados || 0) + x.bloqueados;
  }
  for (const [h, x] of Object.entries(d.ips || {})) {
    let a = acc.ips[h];
    if (!a) {
      if (Object.keys(acc.ips).length >= MAX_IPS && !(x.seriaBarrado > 0)) continue;
      a = acc.ips[h] = { cliques: 0, seriaBarrado: 0, motivos: {}, grupos: {}, links: 0 };
    }
    a.cliques += x.cliques || 0; a.seriaBarrado += x.seriaBarrado || 0;
    if (x.bloqueados) a.bloqueados = (a.bloqueados || 0) + x.bloqueados;
    for (const [k, n] of Object.entries(x.motivos || {})) a.motivos[k] = (a.motivos[k] || 0) + n;
    for (const [g, n] of Object.entries(x.grupos || {})) a.grupos[g] = (a.grupos[g] || 0) + n;
    a.links = Math.max(a.links || 0, x.links || 0);
    if (x.provedor) a.provedor = x.provedor;
    if (x.ua) a.ua = x.ua;
    if (x.primeiro && (!a.primeiro || x.primeiro < a.primeiro)) a.primeiro = x.primeiro;
    if (x.ultimo && (!a.ultimo || x.ultimo > a.ultimo)) a.ultimo = x.ultimo;
  }
  // Teto de IPs: fica quem seria barrado e quem mais clicou
  const ks = Object.keys(acc.ips);
  if (ks.length > MAX_IPS) {
    ks.sort((x, y) => (acc.ips[y].seriaBarrado - acc.ips[x].seriaBarrado) || (acc.ips[y].cliques - acc.ips[x].cliques));
    for (const k of ks.slice(MAX_IPS)) delete acc.ips[k];
  }
  return acc;
}

// Links distintos por IP no dia (so em memoria, para "abriu N ofertas")
const linksPorIp = new Map();   // dia|hash -> Set(codigo)

// ── Bloqueio ─────────────────────────────────────────────────────────────────
const servidorHoje = new Map();   // dia|hash -> cliques de servidor no dia
let reincidentes = new Set();     // hashes que bateram o limiar hoje ou ontem
let reincidentesDia = null;
const custoDecisao = { n: 0, totalUs: 0, maxUs: 0 };
// Dia de SP com cache de 1 s (toLocaleDateString custa ~30 us por chamada)
let diaCache = { em: 0, dia: null };
function hojeRapido() {
  const agora = Date.now();
  if (agora - diaCache.em > 1000) diaCache = { em: agora, dia: hojeSP() };
  return diaCache.dia;
}

function diaAnterior(dia) {
  return new Date(new Date(dia + 'T12:00:00Z').getTime() - 86400000).toISOString().slice(0, 10);
}
function cliquesDeServidor(x) {
  let n = 0;
  for (const [k, v] of Object.entries((x && x.motivos) || {})) if (k.startsWith('servidor:')) n = Math.max(n, v);
  return n;
}
// Le hoje e ontem do repo de dados: quem bateu o limiar vira reincidente
// (vale mesmo antes das listas de rede carregarem, depois de um reinicio).
async function carregarReincidentes() {
  if (!gh) return;
  const hoje = hojeSP();
  const novo = new Set();
  for (const dia of [hoje, diaAnterior(hoje)]) {
    try {
      const { data } = await gh.get(arquivoDoDia(dia), null);
      const base = data && data.dia ? JSON.parse(JSON.stringify(data)) : diaVazio(dia);
      const d = somarDia(base, dia === hoje ? (buffer[dia] || diaVazio(dia)) : diaVazio(dia));
      for (const [h, x] of Object.entries(d.ips || {})) {
        const n = cliquesDeServidor(x);
        if (n >= LIMIAR_SERVIDOR) novo.add(h);
        if (dia === hoje && n) { const k = hoje + '|' + h; servidorHoje.set(k, Math.max(servidorHoje.get(k) || 0, n)); }
      }
    } catch (e) { console.error('[anti-monitor] reincidentes', dia, e.message); }
  }
  if (reincidentesDia === hoje) for (const h of reincidentes) novo.add(h);   // nao perde os de hoje
  reincidentes = novo; reincidentesDia = hoje;
  console.log('[anti-monitor] modo', MODO, '- reincidentes', reincidentes.size);
}

// ── Suporte: codigo na pagina de bloqueio e IPs liberados ────────────────────
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // sem 0/O/1/I
function codigoDe(ipHash) {
  const b = crypto.createHash('sha1').update('suporte|' + String(ipHash || '')).digest();
  let s = '';
  for (let i = 0; i < 6; i++) s += ALFABETO[b[i] % ALFABETO.length];
  return s;
}
const ARQ_LIBERADOS = 'tsp/anti-monitor-liberados.json';
let liberados = new Map();   // hash -> { codigo, em, obs }

async function carregarLiberados() {
  if (!gh) return;
  try {
    const { data } = await gh.get(ARQ_LIBERADOS, null);
    const novo = new Map();
    for (const x of ((data && data.liberados) || [])) if (x && x.hash) novo.set(x.hash, x);
    liberados = novo;
  } catch (e) { console.error('[anti-monitor] liberados', e.message); }   // mantem os de memoria
}

// Procura o codigo nos ultimos `dias` arquivos do dia (so IPs com motivo).
async function buscarCodigo(codigo, dias = 7) {
  const cod = String(codigo || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (cod.length !== 6) return null;
  let dia = hojeSP();
  const achados = [];
  for (let i = 0; i < Math.min(14, Math.max(1, dias)); i++) {
    let d = diaVazio(dia);
    if (gh) { try { const { data } = await gh.get(arquivoDoDia(dia), null); if (data && data.dia) d = JSON.parse(JSON.stringify(data)); } catch (e) { /* segue */ } }
    if (i === 0) d = somarDia(d, buffer[dia] || diaVazio(dia));
    for (const [h, x] of Object.entries(d.ips || {})) {
      if (codigoDe(h) !== cod) continue;
      achados.push({ dia, cliques: x.cliques, seriaBarrado: x.seriaBarrado, bloqueados: x.bloqueados || 0,
        motivos: x.motivos, grupos: x.grupos, links: x.links, provedor: x.provedor || null, ua: x.ua || null,
        primeiro: x.primeiro || null, ultimo: x.ultimo || null, _hash: h });
    }
    dia = diaAnterior(dia);
  }
  if (!achados.length) return null;
  const hash = achados[0]._hash;
  for (const a of achados) delete a._hash;
  return { codigo: cod, ipHash: hash, liberado: liberados.has(hash), reincidente: reincidentes.has(hash), dias: achados };
}

// Libera (ou volta a bloquear, com desfazer) o IP de um codigo.
async function liberar(codigo, obs, desfazer) {
  const achado = await buscarCodigo(codigo, 14);
  if (!achado) return { ok: false, erro: 'codigo nao encontrado nos ultimos 14 dias' };
  const hash = achado.ipHash;
  const { data, sha } = await gh.get(ARQ_LIBERADOS, null);   // SHA fresco
  const lista = ((data && data.liberados) || []).filter(x => x && x.hash !== hash);
  if (!desfazer) lista.push({ hash, codigo: achado.codigo, em: new Date().toISOString(), obs: String(obs || '').slice(0, 200) });
  await gh.put(ARQ_LIBERADOS, { atualizadoEm: new Date().toISOString(), liberados: lista }, sha,
    'vigia: anti-monitor ' + (desfazer ? 'bloqueia de novo ' : 'libera ') + achado.codigo);
  liberados = new Map(lista.map(x => [x.hash, x]));
  if (!desfazer) reincidentes.delete(hash);
  return { ok: true, codigo: achado.codigo, liberado: !desfazer, totalLiberados: lista.length };
}

function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
// Pagina que quem foi bloqueado recebe no lugar do redirecionamento (sem o destino).
function paginaBloqueio(ipHash) {
  const cod = codigoDe(ipHash);
  const num = String(process.env.ANTI_MONITOR_SUPORTE_WA || '').replace(/\D/g, '');
  const texto = 'Oi! Tentei abrir uma oferta do Tica Promos e não consegui. Código: ' + cod;
  const botao = num.length >= 10
    ? '<p><a href="https://wa.me/' + num + '?text=' + encodeURIComponent(texto) + '" style="display:inline-block;background:#FA5150;color:#fff;' +
      'text-decoration:none;font-weight:700;padding:14px 22px;border-radius:12px">Falar com o suporte no WhatsApp</a></p>'
    : '';
  return '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">' +
    '<title>Tica Promos</title></head><body style="font-family:sans-serif;text-align:center;padding:48px 16px;color:#2E3348;max-width:420px;margin:auto">' +
    '<h1 style="font-size:22px">Não foi possível abrir esta oferta</h1>' +
    '<p>Sua conexão foi identificada como acesso automático. Se foi engano, fale com a gente e informe o código abaixo.</p>' +
    '<p style="font-size:28px;font-weight:700;letter-spacing:4px;margin:24px 0">' + esc(cod) + '</p>' + botao +
    '</body></html>';
}

// Chamado pelo index.js ANTES do redirecionamento. Sincrono e barato.
// p = { ip, ipHash, metodo, classe } -> { bloquear, motivo }
function decidir(p) {
  if (MODO !== 'bloqueio') return { bloquear: false };
  const t0 = process.hrtime.bigint();
  try {
    if (p.classe === 'preview' || p.classe === 'meta') return { bloquear: false };
    if (p.classe === 'robo') return { bloquear: true, motivo: 'programa' };
    if (p.metodo === 'HEAD') return { bloquear: true, motivo: 'head' };
    if (p.ipHash && liberados.has(p.ipHash)) return { bloquear: false };   // gente de verdade liberada pelo suporte
    if (p.ipHash && reincidentes.has(p.ipHash)) return { bloquear: true, motivo: 'servidor_repetido' };
    const rede = classificarIp(p.ip);
    if (rede.rede !== 'servidor') return { bloquear: false };
    const k = hojeRapido() + '|' + p.ipHash;
    const n = (servidorHoje.get(k) || 0) + 1;
    servidorHoje.set(k, n);
    if (servidorHoje.size > 20000) servidorHoje.delete(servidorHoje.keys().next().value);
    if (n >= LIMIAR_SERVIDOR) { reincidentes.add(p.ipHash); return { bloquear: true, motivo: 'servidor_repetido' }; }
    return { bloquear: false };
  } catch (e) {
    return { bloquear: false };                    // na duvida, libera
  } finally {
    const us = Number(process.hrtime.bigint() - t0) / 1000;
    custoDecisao.n++; custoDecisao.totalUs += us; if (us > custoDecisao.maxUs) custoDecisao.maxUs = us;
  }
}

// Chamado pelo index.js DEPOIS de o redirecionamento sair.
// p = { ip, ipHash, ua, metodo, classe ('humano'|'preview'|'meta'|'robo'), rajada, codigo, grupo, bloqueado, motivoBloqueio }
function observar(p) {
  if (p.classe === 'meta') return;
  const t0 = process.hrtime.bigint();
  const rede = classificarIp(p.ip);
  const us = Number(process.hrtime.bigint() - t0) / 1000;
  custoClassificacao.n++; custoClassificacao.totalUs += us; if (us > custoClassificacao.maxUs) custoClassificacao.maxUs = us;

  const motivos = [];
  let barrado = false;
  if (p.classe === 'preview') {
    if (rede.rede !== 'servidor') return;          // previa de celular: normal
    motivos.push('previa_de_servidor');
  } else {
    if (p.classe === 'robo') { motivos.push('programa'); barrado = true; }
    if (p.metodo === 'HEAD') { motivos.push('head'); barrado = true; }
    if (rede.rede === 'servidor') { motivos.push('servidor:' + rede.provedor); barrado = true; }
    if (p.rajada) motivos.push('rajada');
  }
  const dia = hojeSP();
  const d = buffer[dia] || (buffer[dia] = diaVazio(dia));
  const g = String(p.grupo || '?');
  if (p.classe !== 'preview') {
    d.cliques++;
    const gg = d.grupos[g] || (d.grupos[g] = { cliques: 0, seriaBarrado: 0 });
    gg.cliques++;
    if (barrado) { d.seriaBarrado++; gg.seriaBarrado++; }
    if (p.bloqueado) { d.bloqueados++; gg.bloqueados = (gg.bloqueados || 0) + 1; }
    if (rede.rede === 'relay') d.relayLiberado++;
    if (rede.rede === 'desconhecido') d.desconhecido++;
  }
  if (p.bloqueado) motivos.push('bloqueado:' + (p.motivoBloqueio || '?'));
  for (const m of motivos) d.motivos[m] = (d.motivos[m] || 0) + 1;
  sujo = true;
  if (!motivos.length) return;                     // gente comum: so a contagem

  const chave = dia + '|' + p.ipHash;
  let set = linksPorIp.get(chave);
  if (!set) { set = new Set(); linksPorIp.set(chave, set); if (linksPorIp.size > 20000) linksPorIp.delete(linksPorIp.keys().next().value); }
  set.add(p.codigo);
  const agora = new Date().toISOString();
  const x = d.ips[p.ipHash] || (d.ips[p.ipHash] = { cliques: 0, seriaBarrado: 0, motivos: {}, grupos: {}, links: 0, primeiro: agora });
  x.cliques++; if (barrado) x.seriaBarrado++; if (p.bloqueado) x.bloqueados = (x.bloqueados || 0) + 1;
  for (const m of motivos) x.motivos[m] = (x.motivos[m] || 0) + 1;
  x.grupos[g] = (x.grupos[g] || 0) + 1;
  x.links = set.size;
  if (rede.provedor) x.provedor = rede.provedor;
  x.ua = String(p.ua || '').slice(0, 140);
  x.ultimo = agora;
}

function arquivoDoDia(dia) { return 'tsp/vigia-monitor_' + dia + '.json'; }

let gh = null;
async function flush() {
  if (!sujo || !gh) return;
  const pend = buffer; buffer = {}; sujo = false;
  for (const dia of Object.keys(pend)) {
    try {
      const { data, sha } = await gh.get(arquivoDoDia(dia), null);   // SHA fresco
      const acc = somarDia(data && data.dia ? data : diaVazio(dia), pend[dia]);
      acc.atualizadoEm = new Date().toISOString();
      await gh.put(arquivoDoDia(dia), acc, sha, 'vigia: anti-monitor (' + MODO + ') ' + dia);
    } catch (e) {
      console.error('[anti-monitor] flush', dia, e.message);
      buffer[dia] = somarDia(buffer[dia] || diaVazio(dia), pend[dia]);   // devolve
      sujo = true;
    }
  }
}

async function relatorio(diaPedido, top) {
  const dia = /^\d{4}-\d{2}-\d{2}$/.test(String(diaPedido || '')) ? diaPedido : hojeSP();
  let base = diaVazio(dia);
  if (gh) { try { const { data } = await gh.get(arquivoDoDia(dia), null); if (data && data.dia) base = data; } catch (e) { /* so memoria */ } }
  const d = somarDia(JSON.parse(JSON.stringify(base)), buffer[dia] || diaVazio(dia));
  const ips = Object.entries(d.ips)
    .map(([h, x]) => ({ ip: h, ...x, grupos: Object.entries(x.grupos).sort((a, b) => b[1] - a[1]).map(([g, n]) => ({ grupo: g, cliques: n })) }))
    .sort((a, b) => (b.seriaBarrado - a.seriaBarrado) || (b.links - a.links) || (b.cliques - a.cliques))
    .slice(0, Math.min(500, Math.max(1, top || 50)));
  const grupos = Object.entries(d.grupos)
    .map(([g, x]) => ({ grupo: g, ...x, pct: x.cliques ? Math.round(1000 * x.seriaBarrado / x.cliques) / 10 : 0 }))
    .sort((a, b) => b.seriaBarrado - a.seriaBarrado);
  return {
    dia,
    modo: MODO,
    resumo: { cliques: d.cliques, seriaBarrado: d.seriaBarrado, pctSeriaBarrado: d.cliques ? Math.round(1000 * d.seriaBarrado / d.cliques) / 10 : 0,
      bloqueados: d.bloqueados || 0,
      relayLiberado: d.relayLiberado, ipDesconhecido: d.desconhecido, motivos: d.motivos },
    grupos, ips,
    atualizadoEm: d.atualizadoEm || null,
  };
}

function estado() {
  const porOrigem = {};
  for (const x of latencias) (porOrigem[x.origem] = porOrigem[x.origem] || []).push(x);
  return {
    modo: MODO,
    limiarServidor: LIMIAR_SERVIDOR,
    reincidentes: reincidentes.size,
    liberados: liberados.size,
    suporteWhatsapp: String(process.env.ANTI_MONITOR_SUPORTE_WA || '').replace(/\D/g, '').length >= 10,
    custoDecisaoUs: { n: custoDecisao.n, media: custoDecisao.n ? Math.round(100 * custoDecisao.totalUs / custoDecisao.n) / 100 : 0,
      max: Math.round(custoDecisao.maxUs * 100) / 100 },
    listas: FONTES.map(f => { const r = redes[f.id] || {}; return { id: f.id, excecao: !!f.excecao, faixas: r.faixas || 0,
      v4: (r.v4 || []).length, v6: (r.v6 || []).length, em: r.em || null, erro: r.erro || null }; }),
    latenciaRedirecionamentoMs: { geral: percentis(latencias),
      porOrigem: Object.fromEntries(Object.entries(porOrigem).map(([k, v]) => [k, percentis(v)])) },
    custoClassificacaoUs: { n: custoClassificacao.n, media: custoClassificacao.n ? Math.round(100 * custoClassificacao.totalUs / custoClassificacao.n) / 100 : 0,
      max: Math.round(custoClassificacao.maxUs * 100) / 100 },
  };
}

function iniciar({ fetch, ghGetJson, ghPutJson }) {
  gh = { get: ghGetJson, put: ghPutJson };
  const t1 = setTimeout(() => carregarTudo(fetch), PRIMEIRA_MS); if (t1.unref) t1.unref();
  const t2 = setInterval(() => carregarTudo(fetch), ATUALIZAR_MS); if (t2.unref) t2.unref();
  const t3 = setInterval(() => { flush().catch(() => {}); }, FLUSH_MS); if (t3.unref) t3.unref();
  if (MODO === 'bloqueio') {
    const t4 = setTimeout(() => { carregarLiberados().then(carregarReincidentes).catch(() => {}); }, 5 * 1000); if (t4.unref) t4.unref();
    const t5 = setInterval(() => { carregarLiberados().then(carregarReincidentes).catch(() => {}); }, RECARREGAR_MS); if (t5.unref) t5.unref();
  }
}

module.exports = { iniciar, decidir, paginaBloqueio, buscarCodigo, liberar, codigoDe, observar, registrarLatencia, flush, relatorio, estado, classificarIp,
  _teste: { servidorHoje, carregarReincidentes, faixa, juntar, contem, v6Big, v4Int, carregarFonte, redes, FONTES, somarDia, diaVazio } };
