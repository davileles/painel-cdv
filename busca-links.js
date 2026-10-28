// busca-links.js
// Busca de voos ja preenchida por tras do link mascarado do Clube.
//
// ir.clubedoviajante.com.br/<slug>?bo=CNF&bd=GRU&bi=2026-12-15[&bv=2026-12-22][&bc=exec][&ba=2]
// vira a pagina de pesquisa do programa com rota, datas, passageiros e cabine
// ja preenchidos — e o proxy (handleIr → montarDestinoIr) ainda aplica os
// parametros de afiliado de links.json em cima. Assim as emissoes dos grupos
// levam o membro direto a busca E continuam comissionadas.
//
// Os formatos de URL sao OS MESMOS do bloco bv* (aba Buscar voos) de
// painel-cdv/index.html, gestor-cdv/index.html e concierge/index.html, conferidos
// com buscas reais em out/2026. Mudou um, muda o outro.
//
// Quem monta os parametros: baileys-server/server.js (buscaDaEmissao +
// linkPrograma, PROGRAMAS_COM_BUSCA). Slug sem builder aqui ignora os
// parametros e cai no destino padrao do slug.

const RE_IATA = /^[A-Z]{3}$/;
const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;

function partes(iso) { const p = String(iso).split('-'); return { a: p[0], m: p[1], d: p[2] }; }

// Azul Fidelidade: c[i].std = MM/DD/AAAA; passageiros p[i].t = ADT/CHD/INF; cc = PTS (pontos) ou BRL
function linkAzul(b) {
  const q = [];
  function trecho(i, de, data, para) {
    const x = partes(data);
    q.push('c[' + i + '].ds=' + de, 'c[' + i + '].std=' + x.m + '/' + x.d + '/' + x.a, 'c[' + i + '].as=' + para);
  }
  trecho(0, b.origem, b.ida, b.destino);
  if (b.volta) trecho(1, b.destino, b.volta, b.origem);
  let i = 0;
  [['ADT', b.adt], ['CHD', b.chd], ['INF', b.inf]].forEach((p) => {
    if (p[1] > 0) { q.push('p[' + i + '].t=' + p[0], 'p[' + i + '].c=' + p[1], 'p[' + i + '].cp=false'); i++; }
  });
  q.push('f.dl=3', 'f.dr=3', 'cc=' + (b.pagamento === 'dinheiro' ? 'BRL' : 'PTS'));
  return 'https://www.voeazul.com.br/br/pt/home/selecao-voo?' + q.join('&');
}

// Azul pelo Mundo (parceiras, so pontos)
function linkAzulMundo(b) {
  return 'https://azulpelomundo.voeazul.com.br/flights/' + [
    b.volta ? 'RT' : 'OW', b.origem, b.destino, '-', '-', b.ida, b.volta || '-',
    b.adt, b.chd, b.inf, 0, 0, 'ALL', 'F',
    b.cabine === 'executiva' ? 'BUSINESS' : 'ECONOMY', '-', '-', '-', '-', 'A', '-'
  ].join('/');
}

// LATAM Pass: datas AAAA-MM-DD, inbound=null em so ida; redemption=true e busca em pontos
function linkLatam(b) {
  return 'https://www.latamairlines.com/br/pt/oferta-voos/?' + [
    'origin=' + b.origem,
    'outbound=' + b.ida,
    'destination=' + b.destino,
    'inbound=' + (b.volta || 'null'),
    'adt=' + b.adt, 'chd=' + b.chd, 'inf=' + b.inf,
    'trip=' + (b.volta ? 'RT' : 'OW'),
    'cabin=' + (b.cabine === 'executiva' ? 'Business' : 'Economy'),
    'redemption=' + (b.pagamento === 'pontos' ? 'true' : 'false'),
    'sort=RECOMMENDED'
  ].join('&');
}

// Smiles: datas em milissegundos (meia-noite de Brasilia); tripType 1 = ida e volta, 2 = so ida
function linkSmiles(b) {
  function ms(d) { return String(Date.parse(d + 'T00:00:00-03:00')); }
  return 'https://www.smiles.com.br/mfe/emissao-passagem/?' + [
    'adults=' + b.adt,
    'cabin=' + (b.cabine === 'executiva' ? 'BUSINESS' : 'ECONOMIC'),
    'children=' + b.chd,
    'departureDate=' + ms(b.ida),
    'infants=' + b.inf,
    'isElegible=false', 'isFlexibleDateChecked=false',
    'returnDate=' + (b.volta ? ms(b.volta) : ''),
    'searchType=g3', 'segments=1',
    'tripType=' + (b.volta ? '1' : '2'),
    'originAirport=' + b.origem, 'originCity=', 'originCountry=', 'originAirportIsAny=false',
    'destinationAirport=' + b.destino, 'destinCity=', 'destinCountry=', 'destinAirportIsAny=false',
    'novo-resultado-voos=true'
  ].join('&');
}

// slug de links.json → builder. Slug fora daqui nao tem busca preenchida.
const BUILDERS = {
  'azul': linkAzul,
  'azul-mundo': linkAzulMundo,
  'latam': linkLatam,
  'smiles': linkSmiles,
};

// Parametros de busca na query do /ir. Chaves curtas para a mensagem do grupo
// nao ficar quilometrica: bo (origem), bd (destino), bi (ida), bv (volta),
// bc (eco|exec), ba (adultos, 1–9). Devolve null se faltar o minimo (bo, bd, bi)
// ou se algum valor vier fora do formato.
const CHAVES_BUSCA = ['bo', 'bd', 'bi', 'bv', 'bc', 'ba'];

function lerBuscaDaQuery(query) {
  if (!query) return null;
  const origem = String(query.bo || '').toUpperCase();
  const destino = String(query.bd || '').toUpperCase();
  const ida = String(query.bi || '');
  const volta = String(query.bv || '');
  if (!RE_IATA.test(origem) || !RE_IATA.test(destino) || !RE_DATA.test(ida)) return null;
  if (volta && (!RE_DATA.test(volta) || volta < ida)) return null;
  const adt = parseInt(query.ba, 10);
  return {
    origem, destino, ida,
    volta: volta || '',
    cabine: /^exec/i.test(String(query.bc || '')) ? 'executiva' : 'economica',
    pagamento: 'pontos',
    adt: isNaN(adt) || adt < 1 ? 1 : Math.min(adt, 9),
    chd: 0, inf: 0,
  };
}

function montarLinkBusca(slug, busca) {
  const f = BUILDERS[String(slug || '').toLowerCase()];
  if (!f || !busca) return null;
  try { return f(busca); } catch (e) { return null; }
}

module.exports = { BUILDERS, CHAVES_BUSCA, lerBuscaDaQuery, montarLinkBusca };
