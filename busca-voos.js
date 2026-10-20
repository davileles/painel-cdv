// busca-voos.js — sonda de busca de voos nos programas (Azul, LATAM, Smiles, GOL)
//
// GET /voos/sonda faz uma busca fixa (CNF → GRU, ida daqui a 30 dias) em cada programa,
// a partir do servidor, e responde o que aconteceu: código HTTP, tempo, tamanho, sinais
// de proteção do site e um trecho curto da resposta. Não recebe parâmetro do usuário
// e guarda o resultado por 2 min. Usada pela aba Buscar voos do gestor-cdv e do concierge.
//
// As rotas internas dos sites não são API oficial: podem mudar sem aviso.

const fetch = require('node-fetch');
const crypto = require('crypto');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const TIMEOUT_MS = 20000;

function dataISO(diasAFrente) {
  const d = new Date(Date.now() - 3 * 3600 * 1000 + diasAFrente * 86400000);
  return d.toISOString().slice(0, 10);
}
function uuid() { return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'); }

function sinaisDeProtecao(status, headers, corpo) {
  const t = String(corpo || '').slice(0, 4000).toLowerCase();
  const s = [];
  if (status === 403) s.push('403');
  if (status === 429) s.push('429');
  if (/access denied|reference #\d/.test(t)) s.push('akamai');
  if (/just a moment|cf-chl|challenge-platform|attention required/.test(t) || headers.get('cf-mitigated')) s.push('cloudflare');
  if (/px-captcha|perimeterx|_pxhd|human verification/.test(t)) s.push('perimeterx');
  if (/captcha|recaptcha|hcaptcha|incapsula|imperva/.test(t)) s.push('captcha');
  return s;
}

async function chamar(nome, url, opcoes) {
  const ini = Date.now();
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, Object.assign({ redirect: 'manual', signal: ctrl.signal }, opcoes));
    const corpo = await r.text();
    const protecao = sinaisDeProtecao(r.status, r.headers, corpo);
    let json = null;
    try { json = JSON.parse(corpo); } catch (e) {}
    return {
      teste: nome,
      status: r.status,
      ms: Date.now() - ini,
      bytes: corpo.length,
      servidor: r.headers.get('server') || '',
      tipo: (r.headers.get('content-type') || '').split(';')[0],
      redireciona: r.headers.get('location') || undefined,
      protecao: protecao.length ? protecao : undefined,
      json: json ? Object.keys(json).slice(0, 12) : undefined,
      trecho: corpo.replace(/\s+/g, ' ').slice(0, 280)
    };
  } catch (e) {
    return { teste: nome, erro: e.name === 'AbortError' ? 'tempo esgotado (' + TIMEOUT_MS / 1000 + ' s)' : e.message, ms: Date.now() - ini };
  } finally {
    clearTimeout(tm);
  }
}

function cabecalhosNavegador(extra) {
  return Object.assign({
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8'
  }, extra || {});
}

function testes(o, d, ida) {
  const [a, m, dd] = ida.split('-');
  const ms = String(Date.parse(ida + 'T00:00:00-03:00'));
  return [
    // LATAM
    ['latam-pagina', 'https://www.latamairlines.com/br/pt/oferta-voos/?origin=' + o + '&outbound=' + ida + '&destination=' + d + '&inbound=null&adt=1&chd=0&inf=0&trip=OW&cabin=Economy&redemption=true&sort=RECOMMENDED',
      { headers: cabecalhosNavegador() }],
    ['latam-api', 'https://www.latamairlines.com/bff/air-offers/v2/offers/search?redemption=true&sort=RECOMMENDED&cabinType=Economy&origin=' + o + '&destination=' + d +
      '&inFlightDate=null&inFrom=null&inOfferId=null&outFlightDate=null&outFrom=' + ida + '&outOfferId=null&adult=1&child=0&infant=0',
      { headers: cabecalhosNavegador({
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://www.latamairlines.com/br/pt/oferta-voos/',
        'x-latam-app-session-id': uuid(), 'x-latam-track-id': uuid(), 'x-latam-request-id': uuid(),
        'x-latam-application-country': 'BR', 'x-latam-application-lang': 'pt',
        'x-latam-application-name': 'web-air-offers', 'x-latam-client-name': 'web-air-offers'
      }) }],
    // Smiles
    ['smiles-pagina', 'https://www.smiles.com.br/mfe/emissao-passagem/?adults=1&cabin=ECONOMIC&children=0&departureDate=' + ms + '&infants=0&isElegible=false&isFlexibleDateChecked=false&returnDate=&searchType=g3&segments=1&tripType=2&originAirport=' + o + '&originCity=&originCountry=&originAirportIsAny=false&destinationAirport=' + d + '&destinCity=&destinCountry=&destinAirportIsAny=false&novo-resultado-voos=true',
      { headers: cabecalhosNavegador() }],
    ['smiles-api', 'https://api-air-flightsearch-green.smiles.com.br/v1/airlines/search?cabinType=all&originAirportCode=' + o + '&destinationAirportCode=' + d + '&departureDate=' + ida + '&memberNumber=&adults=1&children=0&infants=0&forceCongener=false',
      { headers: cabecalhosNavegador({
        'Accept': 'application/json, text/plain, */*',
        'Origin': 'https://www.smiles.com.br', 'Referer': 'https://www.smiles.com.br/',
        'channel': 'WEB', 'region': 'BRASIL'
      }) }],
    // Azul
    ['azul-pagina', 'https://www.voeazul.com.br/br/pt/home/selecao-voo?c[0].ds=' + o + '&c[0].std=' + m + '/' + dd + '/' + a + '&c[0].as=' + d + '&p[0].t=ADT&p[0].c=1&p[0].cp=false&f.dl=3&f.dr=3&cc=PTS',
      { headers: cabecalhosNavegador() }],
    ['azul-api', 'https://b2c-api.voeazul.com.br/', { headers: cabecalhosNavegador({ 'Accept': 'application/json, text/plain, */*', 'Origin': 'https://www.voeazul.com.br' }) }],
    // GOL
    ['gol-pagina', 'https://b2c.voegol.com.br/compra/busca-parceiros?pv=br&tipo=DF&lang=pt-BR&de=' + o + '&para=' + d + '&ida=' + dd + '-' + m + '-' + a + '&ADT=1&ADL=0&CHD=0&INF=0&voebiz=0',
      { headers: cabecalhosNavegador() }]
  ];
}

let cacheSonda = null;
let sondaRodando = null;

async function rodarSonda() {
  const origem = 'CNF', destino = 'GRU', ida = dataISO(30);
  const resultados = [];
  // um teste por vez, para não parecer rajada
  for (const [nome, url, op] of testes(origem, destino, ida)) resultados.push(await chamar(nome, url, op));
  const dados = { ok: true, quando: new Date().toISOString(), rota: origem + '→' + destino, ida, resultados };
  cacheSonda = { em: Date.now(), dados };
  console.log('[voos/sonda] ' + JSON.stringify(resultados.map(x => ({ t: x.teste, s: x.status, e: x.erro, p: x.protecao, ms: x.ms, bytes: x.bytes, srv: x.servidor, j: x.json, tr: (x.trecho || '').slice(0, 120) }))));
  return dados;
}

// Responde na hora: devolve o último resultado (até 10 min) e, se estiver velho, dispara
// uma rodada nova em segundo plano. Assim a página não fica esperando os sites.
function sondar() {
  const velho = !cacheSonda || Date.now() - cacheSonda.em > 2 * 60 * 1000;
  if (velho && !sondaRodando) {
    sondaRodando = rodarSonda().catch(e => console.error('[voos/sonda]', e.message)).finally(() => { sondaRodando = null; });
  }
  if (cacheSonda) return Object.assign({ rodandoNovamente: !!sondaRodando }, cacheSonda.dados);
  return { ok: true, rodando: true, aviso: 'Teste em andamento (leva até 2 min). Abra de novo daqui a pouco.' };
}

module.exports = { sondar };
