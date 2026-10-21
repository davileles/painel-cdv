// busca-voos-precos.js — preços ao vivo de Azul, LATAM, Smiles e GOL via ZenRows (etapa de teste)
//
// Por que ZenRows: a sonda (busca-voos.js) mostrou que os quatro sites recusam a busca feita
// direto do servidor (Akamai, 403/406, sem resposta). O ZenRows abre a página de resultados num
// navegador de verdade, com IP residencial do Brasil, e devolve o HTML + as chamadas internas
// (XHR) que a página fez. Daqui lemos os voos do JSON dessas chamadas.
//
// Fluxo: GET /voos/precos?origem=&destino=&ida=&volta=&adt=&chd=&inf=&cabine=&pagamento=
//   → responde na hora com o estado da busca (rodando / pronta) e roda em segundo plano;
//     a página repete a consulta até ficar pronta. Mesma busca em 15 min = resultado guardado.
//
// Custo: cada página aberta gasta créditos do ZenRows (js_render + premium_proxy ≈ 25 créditos).
// "Ambos" em ida e volta = até 12 páginas. Teto diário em ZENROWS_LIMITE_DIA (padrão 150 páginas).
//
// Env: ZENROWS_API_KEY (sem ela a rota responde 503 com aviso), ZENROWS_LIMITE_DIA, ZENROWS_ESPERA_MS.
//
// As rotas internas dos sites não são API oficial: o formato do JSON pode mudar sem aviso.
// Por isso cada programa tem leitura específica + leitura genérica de reserva, e a última
// captura bruta fica em memória (GET /voos/precos/bruto) para ajustar a leitura.

const fetch = require('node-fetch');

const ZENROWS_URL = 'https://api.zenrows.com/v1/';
const TIMEOUT_MS = 170 * 1000;
const CACHE_MS = 15 * 60 * 1000;

function chave() { return process.env.ZENROWS_API_KEY || process.env.ZENROWS_KEY || ''; }
function limiteDia() { const n = parseInt(process.env.ZENROWS_LIMITE_DIA, 10); return isNaN(n) ? 150 : n; }
// ZENROWS_ESPERA_MS (se definida) vale para todos; senão cada fonte tem a sua espera
function esperaMs(padrao) { const n = parseInt(process.env.ZENROWS_ESPERA_MS, 10); return Math.min(Math.max(isNaN(n) ? (padrao || 15000) : n, 0), 30000); }
function hojeSP() { return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10); }

// ── Links de busca (mesmo formato do bloco bv* dos painéis) ──
function partes(iso) { const p = String(iso).split('-'); return { a: p[0], m: p[1], d: p[2] }; }
function linkAzul(b, modo) {
  const x = partes(b.ida);
  const q = ['c[0].ds=' + b.origem, 'c[0].std=' + x.m + '/' + x.d + '/' + x.a, 'c[0].as=' + b.destino];
  let i = 0;
  [['ADT', b.adt], ['CHD', b.chd], ['INF', b.inf]].forEach(p => {
    if (p[1] > 0) { q.push('p[' + i + '].t=' + p[0], 'p[' + i + '].c=' + p[1], 'p[' + i + '].cp=false'); i++; }
  });
  q.push('f.dl=3', 'f.dr=3', 'cc=' + (modo === 'dinheiro' ? 'BRL' : 'PTS'));
  return 'https://www.voeazul.com.br/br/pt/home/selecao-voo?' + q.join('&');
}
function linkLatam(b, modo) {
  return 'https://www.latamairlines.com/br/pt/oferta-voos/?' + [
    'origin=' + b.origem, 'outbound=' + b.ida, 'destination=' + b.destino, 'inbound=null',
    'adt=' + b.adt, 'chd=' + b.chd, 'inf=' + b.inf, 'trip=OW',
    'cabin=' + (b.cabine === 'executiva' ? 'Business' : 'Economy'),
    'redemption=' + (modo === 'pontos' ? 'true' : 'false'), 'sort=RECOMMENDED'
  ].join('&');
}
function linkSmiles(b) {
  const ms = String(Date.parse(b.ida + 'T00:00:00-03:00'));
  return 'https://www.smiles.com.br/mfe/emissao-passagem/?' + [
    'adults=' + b.adt, 'cabin=' + (b.cabine === 'executiva' ? 'BUSINESS' : 'ECONOMIC'), 'children=' + b.chd,
    'departureDate=' + ms, 'infants=' + b.inf, 'isElegible=false', 'isFlexibleDateChecked=false', 'returnDate=',
    'searchType=g3', 'segments=1', 'tripType=2',
    'originAirport=' + b.origem, 'originCity=', 'originCountry=', 'originAirportIsAny=false',
    'destinationAirport=' + b.destino, 'destinCity=', 'destinCountry=', 'destinAirportIsAny=false',
    'novo-resultado-voos=true'
  ].join('&');
}
function linkGol(b) {
  const x = partes(b.ida);
  return 'https://b2c.voegol.com.br/compra/busca-parceiros?' + [
    'pv=br', 'tipo=DF', 'lang=pt-BR', 'de=' + b.origem, 'para=' + b.destino, 'ida=' + x.d + '-' + x.m + '-' + x.a,
    'ADT=' + b.adt, 'ADL=0', 'CHD=' + b.chd, 'INF=' + b.inf, 'voebiz=0'
  ].join('&');
}

// Uma "fonte" = um programa num modo (pontos ou dinheiro). xhr = quais chamadas da página têm os voos.
const FONTES = [
  { id: 'azul-pontos',   programa: 'Azul Fidelidade', modo: 'pontos',   espera: 20000, link: b => linkAzul(b, 'pontos'),   xhr: /availability/i, ler: lerAzul },
  { id: 'latam-pontos',  programa: 'LATAM Pass',      modo: 'pontos',   espera: 25000, link: b => linkLatam(b, 'pontos'),  xhr: /offers\/search/i, ler: lerLatam },
  { id: 'smiles-pontos', programa: 'Smiles',          modo: 'pontos',   espera: 28000, link: b => linkSmiles(b),           xhr: /airlines\/search|flightsearch/i, ler: lerSmiles },
  { id: 'azul-dinheiro', programa: 'Azul',            modo: 'dinheiro', espera: 20000, link: b => linkAzul(b, 'dinheiro'), xhr: /availability/i, ler: lerAzul },
  { id: 'latam-dinheiro', programa: 'LATAM',          modo: 'dinheiro', espera: 25000, link: b => linkLatam(b, 'dinheiro'), xhr: /offers\/search/i, ler: lerLatam },
  { id: 'gol-dinheiro',  programa: 'GOL',             modo: 'dinheiro', espera: 25000, link: b => linkGol(b),              xhr: /availability|search|flight|offer|shop/i, ler: null }
];

// ── Utilitários de leitura ──
function num(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (typeof v === 'object') return num(v.amount != null ? v.amount : v.value);
  let s = String(v).replace(/[^\d.,-]/g, '');
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = parseFloat(s);
  return isFinite(n) ? n : null;
}
function hhmm(v) {
  const m = String(v || '').match(/T?(\d{2}):(\d{2})/);
  return m ? m[1] + ':' + m[2] : '';
}
function dataDe(v) {
  const m = String(v || '').match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}
function pegar(o, caminho) {
  return caminho.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
}
function primeiro(o, caminhos) {
  for (const c of caminhos) { const v = pegar(o, c); if (v != null && v !== '') return v; }
  return undefined;
}
// Menor número positivo cujo nome de campo casa com a expressão (procura em profundidade).
function menorPorChave(obj, re, limite) {
  let menor = null, n = 0;
  (function andar(o, prof) {
    if (!o || typeof o !== 'object' || prof > 8 || n++ > 4000) return;
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (re.test(k) && (typeof v === 'number' || typeof v === 'string')) {
        const x = num(v);
        if (x != null && x > 0 && (!limite || x < limite) && (menor == null || x < menor)) menor = x;
      } else if (v && typeof v === 'object') andar(v, prof + 1);
    }
  })(obj, 0);
  return menor;
}
function json(body) {
  if (body && typeof body === 'object') return body;
  try { return JSON.parse(body); } catch (e) { return null; }
}

// ── Leitura específica por programa (defensiva: o formato pode variar) ──
function lerLatam(j, modo) {
  const lista = primeiro(j, ['content', 'data.content', 'offers']);
  if (!Array.isArray(lista) || !lista.length) return null;
  return lista.map(it => {
    const s = it.summary || it;
    const preco = s.lowestPrice || pegar(s, 'brands.0.price') || {};
    const valor = num(preco.amount != null ? preco.amount : preco);
    const taxas = num(primeiro(preco, ['taxes', 'taxesAmount', 'taxAmount', 'tax.amount'])) ||
      menorPorChave(s.brands || {}, /tax/i);
    const voos = (it.itinerary || []).map(t => pegar(t, 'flight.airlineCode') && (pegar(t, 'flight.airlineCode') + pegar(t, 'flight.flightNumber'))).filter(Boolean);
    return {
      voo: voos.length ? voos.join(' + ') : (s.flightCode || ''),
      cia: 'LATAM',
      de: pegar(s, 'origin.iataCode'), para: pegar(s, 'destination.iataCode'),
      saida: pegar(s, 'origin.departure'), chegada: pegar(s, 'destination.arrival'),
      escalas: num(s.stopQuantity),
      duracaoMin: num(s.duration),
      pontos: modo === 'pontos' ? valor : null,
      taxas: modo === 'pontos' ? taxas : null,
      dinheiro: modo === 'dinheiro' ? valor : null,
      moeda: preco.currency || ''
    };
  });
}
function lerSmiles(j) {
  const segs = primeiro(j, ['requestedFlightSegmentList', 'requestedFlightSegments']);
  const lista = Array.isArray(segs) && segs[0] ? (segs[0].flightList || segs[0].flights) : null;
  if (!Array.isArray(lista) || !lista.length) return null;
  return lista.map(f => {
    const tarifas = Array.isArray(f.fareList) ? f.fareList : [];
    let pontos = null, dinheiro = null;
    tarifas.forEach(t => {
      const m = num(t.miles != null ? t.miles : t.baseMiles);
      if (m && (pontos == null || m < pontos)) pontos = m;
      const d = num(t.money);
      if (d && (dinheiro == null || d < dinheiro)) dinheiro = d;
    });
    const pernas = Array.isArray(f.legList) ? f.legList : [];
    return {
      voo: pernas.map(l => (pegar(l, 'marketingAirline.code') || pegar(l, 'operationAirline.code') || '') + (l.flightNumber || '')).filter(Boolean).join(' + '),
      cia: pegar(f, 'airline.name') || pegar(f, 'airline.code') || '',
      de: pegar(f, 'departure.airport.code'), para: pegar(f, 'arrival.airport.code'),
      saida: pegar(f, 'departure.date'), chegada: pegar(f, 'arrival.date'),
      escalas: num(f.stops),
      duracaoMin: num(f.durationNumber) || null,
      pontos, taxas: null,
      dinheiroComPontos: dinheiro,
      dinheiro: null, moeda: 'BRL'
    };
  });
}
function lerAzul(j, modo) {
  const trips = primeiro(j, ['data.trips', 'trips']);
  const lista = Array.isArray(trips) && trips[0] ? (trips[0].journeys || trips[0].journeysAvailable) : null;
  if (!Array.isArray(lista) || !lista.length) return null;
  return lista.map(v => {
    const id = v.identifier || v.designator || v;
    const pernas = Array.isArray(v.segments) ? v.segments : [];
    const pontos = modo === 'pontos' ? menorPorChave(v.fares || v, /points?$|^amount$/i) : null;
    const dinheiro = modo === 'dinheiro' ? menorPorChave(v.fares || v, /total|amount|price/i) : null;
    const taxas = modo === 'pontos' ? menorPorChave(v.fares || v, /tax/i) : null;
    return {
      voo: pernas.length ? pernas.map(s => (pegar(s, 'identifier.carrierCode') || 'AD') + (pegar(s, 'identifier.flightNumber') || '')).join(' + ')
        : ((id.carrierCode || 'AD') + (id.flightNumber || '')),
      cia: 'Azul',
      de: id.departureStation || id.origin, para: id.arrivalStation || id.destination,
      saida: id.std || id.departure, chegada: id.sta || id.arrival,
      escalas: num(pegar(id, 'connections.count') != null ? pegar(id, 'connections.count') : (pernas.length ? pernas.length - 1 : null)),
      duracaoMin: null,
      pontos, taxas, dinheiro, moeda: 'BRL'
    };
  });
}

// Leitura genérica de reserva: procura listas de objetos que tenham horário de saída e de chegada.
const RE_SAIDA = /^(departure|departuredate|departuredatetime|departuretime|std|partida|saida|horasaida|dataida|departure_date)$/i;
const RE_CHEGADA = /^(arrival|arrivaldate|arrivaldatetime|arrivaltime|sta|chegada|horachegada|arrival_date)$/i;
const RE_DATAHORA = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}|\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}/;
function horarioEm(o, re) {
  for (const k of Object.keys(o || {})) {
    if (!re.test(k)) continue;
    const v = o[k];
    if (typeof v === 'string' && RE_DATAHORA.test(v)) return v;
    if (v && typeof v === 'object') {
      const d = primeiro(v, ['date', 'dateTime', 'datetime', 'local', 'time']);
      if (typeof d === 'string' && RE_DATAHORA.test(d)) return d;
    }
  }
  return null;
}
function pareceVoo(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  const alvo = o.identifier || o.summary || o.designator || o;
  return !!(horarioEm(alvo, RE_SAIDA) && horarioEm(alvo, RE_CHEGADA));
}
function lerGenerico(j, modo) {
  let achou = null;
  (function andar(o, prof) {
    if (achou || !o || typeof o !== 'object' || prof > 10) return;
    if (Array.isArray(o)) {
      if (o.length && o.filter(pareceVoo).length >= Math.max(1, Math.ceil(o.length / 2))) { achou = o; return; }
      o.forEach(x => andar(x, prof + 1));
      return;
    }
    Object.keys(o).forEach(k => andar(o[k], prof + 1));
  })(j, 0);
  if (!achou) return null;
  return achou.filter(pareceVoo).map(o => {
    const a = o.identifier || o.summary || o.designator || o;
    return {
      voo: String(primeiro(a, ['flightNumber', 'flightCode', 'number']) || ''),
      cia: '',
      de: primeiro(a, ['origin', 'departureStation', 'origin.iataCode', 'departureAirport']),
      para: primeiro(a, ['destination', 'arrivalStation', 'destination.iataCode', 'arrivalAirport']),
      saida: horarioEm(a, RE_SAIDA), chegada: horarioEm(a, RE_CHEGADA),
      escalas: num(primeiro(a, ['stops', 'stopQuantity', 'connections.count', 'numberOfStops'])),
      duracaoMin: null,
      pontos: modo === 'pontos' ? menorPorChave(o, /miles|points|pontos|milhas/i) : null,
      taxas: modo === 'pontos' ? menorPorChave(o, /tax|taxa|boarding/i) : null,
      dinheiro: modo === 'dinheiro' ? menorPorChave(o, /^(total|totalamount|totalprice|price|amount|fare|valor)$/i) : null,
      moeda: 'BRL',
      leituraGenerica: true
    };
  });
}

function normalizar(v, fonte) {
  if (typeof v.de === 'object') v.de = pegar(v.de, 'iataCode') || pegar(v.de, 'code') || '';
  if (typeof v.para === 'object') v.para = pegar(v.para, 'iataCode') || pegar(v.para, 'code') || '';
  return {
    programa: fonte.programa, modo: fonte.modo,
    voo: v.voo || '', cia: v.cia || '',
    de: v.de || '', para: v.para || '',
    data: dataDe(v.saida), saida: hhmm(v.saida), chegada: hhmm(v.chegada),
    chegadaData: dataDe(v.chegada),
    escalas: v.escalas == null ? null : v.escalas,
    duracaoMin: v.duracaoMin || null,
    pontos: v.pontos || null, taxas: v.taxas || null,
    dinheiro: v.dinheiro || null, moeda: v.moeda || 'BRL',
    leituraGenerica: !!v.leituraGenerica
  };
}

// Só sinais claros de página de bloqueio (não a palavra "captcha" solta: páginas normais carregam reCAPTCHA)
function tituloDe(html) { const m = String(html || '').match(/<title[^>]*>([^<]{0,160})/i); return m ? m[1].trim() : ''; }
function sinalBloqueio(html) {
  const h = String(html || '').slice(0, 60000);
  const t = tituloDe(h).toLowerCase();
  if (/access denied/.test(t) || /<h1>access denied<\/h1>/i.test(h)) return 'akamai';
  if (/just a moment|attention required/.test(t) || /cf-chl-|challenge-platform/i.test(h)) return 'cloudflare';
  if (/id="px-captcha"|px-captcha-wrapper/i.test(h)) return 'perimeterx';
  if (/incapsula incident|_incapsula_resource/i.test(h)) return 'imperva';
  return '';
}

// ── Chamada ao ZenRows ──
const brutos = {}; // última captura por fonte (para ajustar a leitura): { quando, url, xhr:[{url,status,bytes,inicio}] , escolhido }
let usoDia = { dia: '', paginas: 0, creditos: 0 };

function contarUso(creditos) {
  const d = hojeSP();
  if (usoDia.dia !== d) usoDia = { dia: d, paginas: 0, creditos: 0 };
  usoDia.paginas++;
  usoDia.creditos += creditos || 0;
}
function podeGastar(n) {
  const d = hojeSP();
  if (usoDia.dia !== d) usoDia = { dia: d, paginas: 0, creditos: 0 };
  return usoDia.paginas + n <= limiteDia();
}

async function abrirPagina(url, espera) {
  const params = new URLSearchParams({
    apikey: chave(), url,
    js_render: 'true', premium_proxy: 'true', proxy_country: 'br',
    json_response: 'true', wait: String(esperaMs(espera))
  });
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const ini = Date.now();
  try {
    const r = await fetch(ZENROWS_URL + '?' + params.toString(), { signal: ctrl.signal });
    const texto = await r.text();
    const custo = parseFloat(r.headers.get('x-request-cost') || '') || null;
    contarUso(custo);
    if (!r.ok) {
      const j = json(texto) || {};
      // nunca devolver a URL do ZenRows (leva a chave)
      return { erro: 'ZenRows ' + r.status + (j.code ? ' ' + j.code : '') + (j.title || j.detail ? ': ' + (j.title || j.detail) : ''), ms: Date.now() - ini, custo };
    }
    const j = json(texto);
    if (!j) return { erro: 'resposta do ZenRows não veio em JSON', ms: Date.now() - ini, custo };
    return { html: j.html || '', xhr: Array.isArray(j.xhr) ? j.xhr : [], ms: Date.now() - ini, custo };
  } catch (e) {
    return { erro: e.name === 'AbortError' ? 'tempo esgotado (' + TIMEOUT_MS / 1000 + ' s)' : String(e.message || e).replace(/apikey=[^&\s]+/g, 'apikey=***'), ms: Date.now() - ini };
  } finally {
    clearTimeout(tm);
  }
}

async function buscarFonte(fonte, b) {
  const url = fonte.link(b);
  let pg = await abrirPagina(url, fonte.espera);
  // RESP001 = o ZenRows não conseguiu carregar a página; uma segunda tentativa costuma passar
  if (pg.erro && /RESP001/.test(pg.erro)) {
    console.log('[voos/precos] ' + fonte.id + ': RESP001, tentando de novo');
    const ms1 = pg.ms;
    pg = await abrirPagina(url, fonte.espera);
    pg.ms = (pg.ms || 0) + (ms1 || 0);
  }
  const base = { fonte: fonte.id, programa: fonte.programa, modo: fonte.modo, link: url, ms: pg.ms, custo: pg.custo || null };
  if (pg.erro) return Object.assign(base, { estado: 'erro', erro: pg.erro, voos: [] });

  const resumoXhr = pg.xhr.map(x => {
    const corpo = typeof x.body === 'string' ? x.body : JSON.stringify(x.body || '');
    return { url: String(x.url || '').slice(0, 300), status: x.status_code || x.status || null, bytes: corpo.length, inicio: corpo.slice(0, 200) };
  });
  // candidatas: chamadas que casam com o padrão do programa; depois qualquer JSON
  const ordenadas = pg.xhr.slice().sort((a, b2) => (fonte.xhr.test(b2.url || '') ? 1 : 0) - (fonte.xhr.test(a.url || '') ? 1 : 0));
  let voos = null, escolhido = null, generico = false;
  for (const x of ordenadas) {
    const j = json(x.body);
    if (!j) continue;
    let lidos = null;
    if (fonte.xhr.test(x.url || '') && fonte.ler) { try { lidos = fonte.ler(j, fonte.modo); } catch (e) { lidos = null; } }
    if (!lidos || !lidos.length) { try { lidos = lerGenerico(j, fonte.modo); generico = !!lidos; } catch (e) { lidos = null; } }
    if (lidos && lidos.length) { voos = lidos; escolhido = String(x.url || '').slice(0, 300); break; }
  }
  brutos[fonte.id] = {
    quando: new Date().toISOString(), link: url, escolhido, xhr: resumoXhr,
    corpoEscolhido: escolhido ? (() => { const x = pg.xhr.find(z => String(z.url || '').slice(0, 300) === escolhido); const c = typeof x.body === 'string' ? x.body : JSON.stringify(x.body); return c.slice(0, 60000); })() : null,
    htmlInicio: String(pg.html || '').replace(/\s+/g, ' ').slice(0, 3000)
  };
  if (!voos) {
    const marca = sinalBloqueio(pg.html);
    const protegido = !!marca;
    console.log('[voos/precos][diag] ' + fonte.id + ' ' + JSON.stringify({
      titulo: tituloDe(pg.html), bloqueio: marca || null, htmlBytes: String(pg.html || '').length,
      xhr: resumoXhr.slice(0, 60).map(x => ({ u: x.url.slice(0, 160), s: x.status, b: x.bytes, i: x.inicio.replace(/\s+/g, ' ').slice(0, 80) }))
    }));
    return Object.assign(base, {
      estado: 'sem-voos',
      erro: protegido ? 'a página abriu com bloqueio do site (' + marca + ')' : (pg.xhr.length ? 'a página abriu, mas não achei os voos nas chamadas dela (' + pg.xhr.length + ')' : 'a página abriu sem chamadas de dados'),
      voos: []
    });
  }
  const lista = voos.map(v => normalizar(v, fonte)).filter(v => v.saida || v.pontos || v.dinheiro);
  console.log('[voos/precos] ' + fonte.id + ' ' + b.origem + '→' + b.destino + ' ' + b.ida + ': ' + lista.length + ' voos' + (generico ? ' (leitura genérica)' : '') + ' em ' + Math.round(pg.ms / 1000) + ' s');
  return Object.assign(base, { estado: 'ok', voos: lista, leituraGenerica: generico });
}

// ── Buscas em andamento e guardadas ──
const buscas = new Map(); // chave → { em, estado, fontes:{id: resultado}, pedido }

function validar(q) {
  const iata = s => String(s || '').trim().toUpperCase();
  const b = {
    origem: iata(q.origem), destino: iata(q.destino),
    ida: String(q.ida || ''), volta: String(q.volta || ''),
    adt: Math.min(Math.max(parseInt(q.adt, 10) || 1, 1), 9),
    chd: Math.min(Math.max(parseInt(q.chd, 10) || 0, 0), 8),
    inf: Math.min(Math.max(parseInt(q.inf, 10) || 0, 0), 8),
    cabine: q.cabine === 'executiva' ? 'executiva' : 'economica',
    pagamento: ['pontos', 'dinheiro', 'ambos'].includes(q.pagamento) ? q.pagamento : 'pontos'
  };
  if (!/^[A-Z]{3}$/.test(b.origem) || !/^[A-Z]{3}$/.test(b.destino)) return { erro: 'origem e destino precisam ser códigos de 3 letras' };
  if (b.origem === b.destino) return { erro: 'origem e destino iguais' };
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(b.ida) || b.ida < hojeSP()) return { erro: 'data de ida inválida ou no passado' };
  if (b.volta && (!re.test(b.volta) || b.volta < b.ida)) return { erro: 'data de volta inválida' };
  return { b };
}

function fontesDoPedido(b) {
  const modos = b.pagamento === 'ambos' ? ['pontos', 'dinheiro'] : [b.pagamento];
  return FONTES.filter(f => modos.includes(f.modo));
}

async function rodar(chaveBusca, b) {
  const reg = buscas.get(chaveBusca);
  const trechos = [{ sentido: 'ida', b: Object.assign({}, b) }];
  if (b.volta) trechos.push({ sentido: 'volta', b: Object.assign({}, b, { origem: b.destino, destino: b.origem, ida: b.volta }) });
  const tarefas = [];
  for (const t of trechos) {
    for (const f of fontesDoPedido(b)) {
      const id = t.sentido + ':' + f.id;
      reg.fontes[id] = { fonte: f.id, programa: f.programa, modo: f.modo, sentido: t.sentido, estado: 'rodando', voos: [] };
      tarefas.push({ id, f, t });
    }
  }
  // até 3 páginas ao mesmo tempo (limite de concorrência dos planos menores do ZenRows)
  let i = 0;
  async function trabalhador() {
    while (i < tarefas.length) {
      const { id, f, t } = tarefas[i++];
      try {
        const r = await buscarFonte(f, t.b);
        r.sentido = t.sentido;
        r.voos.forEach(v => { v.sentido = t.sentido; });
        reg.fontes[id] = r;
      } catch (e) {
        reg.fontes[id] = { fonte: f.id, programa: f.programa, modo: f.modo, sentido: t.sentido, estado: 'erro', erro: e.message, voos: [] };
      }
    }
  }
  await Promise.all([trabalhador(), trabalhador(), trabalhador()]);
  reg.estado = 'pronta';
  reg.em = Date.now();
}

function resposta(reg) {
  const fontes = Object.keys(reg.fontes).map(k => reg.fontes[k]);
  const voos = [];
  fontes.forEach(f => (f.voos || []).forEach(v => voos.push(v)));
  voos.sort((a, b) => {
    if (a.sentido !== b.sentido) return a.sentido === 'ida' ? -1 : 1;
    if (a.modo !== b.modo) return a.modo === 'pontos' ? -1 : 1;
    const va = a.modo === 'pontos' ? a.pontos : a.dinheiro, vb = b.modo === 'pontos' ? b.pontos : b.dinheiro;
    return (va || Infinity) - (vb || Infinity);
  });
  return {
    ok: true, estado: reg.estado, pedido: reg.pedido, iniciadaEm: new Date(reg.inicio).toISOString(),
    fontes: fontes.map(f => ({ fonte: f.fonte, programa: f.programa, modo: f.modo, sentido: f.sentido, estado: f.estado, erro: f.erro, qtd: (f.voos || []).length, ms: f.ms, custo: f.custo, link: f.link, leituraGenerica: f.leituraGenerica })),
    voos,
    uso: { dia: usoDia.dia, paginas: usoDia.paginas, creditos: usoDia.creditos, limitePaginas: limiteDia() }
  };
}

function buscarPrecos(q) {
  if (!chave()) return { status: 503, corpo: { ok: false, erro: 'ZENROWS_API_KEY não configurada no Railway (serviço cdv-proxy).', motivo: 'sem-chave' } };
  const v = validar(q || {});
  if (v.erro) return { status: 400, corpo: { ok: false, erro: v.erro } };
  const b = v.b;
  const chaveBusca = JSON.stringify(b);
  const atual = buscas.get(chaveBusca);
  const novo = q.novo === '1' || q.novo === 'true';
  if (atual && (atual.estado === 'rodando' || (!novo && Date.now() - atual.em < CACHE_MS))) return { status: 200, corpo: resposta(atual) };

  const paginas = fontesDoPedido(b).length * (b.volta ? 2 : 1);
  if (!podeGastar(paginas)) {
    return { status: 429, corpo: { ok: false, erro: 'Limite diário de buscas atingido (' + usoDia.paginas + '/' + limiteDia() + ' páginas hoje). Aumente ZENROWS_LIMITE_DIA no Railway se quiser.', motivo: 'limite' } };
  }
  // limpa buscas velhas
  for (const [k, r] of buscas) if (r.estado === 'pronta' && Date.now() - r.em > CACHE_MS * 4) buscas.delete(k);
  const reg = { estado: 'rodando', inicio: Date.now(), em: Date.now(), pedido: b, fontes: {} };
  buscas.set(chaveBusca, reg);
  rodar(chaveBusca, b).catch(e => { console.error('[voos/precos]', e.message); reg.estado = 'pronta'; reg.erro = e.message; });
  return { status: 200, corpo: resposta(reg) };
}

function capturaBruta(fonte) {
  if (fonte) return brutos[fonte] || null;
  const r = {};
  Object.keys(brutos).forEach(k => { r[k] = Object.assign({}, brutos[k], { corpoEscolhido: brutos[k].corpoEscolhido ? brutos[k].corpoEscolhido.slice(0, 1500) : null }); });
  return r;
}

module.exports = { buscarPrecos, capturaBruta, _teste: { lerLatam, lerSmiles, lerAzul, lerGenerico, normalizar, validar, FONTES } };
