// link-parceiro.js
// Mascara do link das ofertas de COMPRA BONIFICADA de PARCEIRO UNICO (Tier 1)
// pelo dominio do Clube: https://ir.clubedoviajante.com.br/cb-<parceiro>?u=<link>
//
// Objetivo: medir cliques por parceiro (qual parceiro interessa mais aos
// membros). Cada parceiro vira uma chave propria em cliques.json
// ("cb-netshoes", "cb-booking"...), e a origem do clique carrega o programa
// ("of-livelo", "of-esfera"...), entao da para ver as duas coisas.
//
// Regra: so oferta com categoria 'compra_bonificada' e tier1 === true (as
// mensagens individuais geradas por coletar.js / coletar-inter.js /
// coletar-meliuz.js / coletar-topcashback.js). Ofertas agrupadas (varios
// parceiros) e ofertas manuais continuam com o link de sempre.
//
// O proxy (index.js, handleIr) resolve qualquer slug "cb-*" com a config
// virtual CB_CFG abaixo — nao ha entrada por parceiro em links.json. So
// URLs de DOMINIOS_CB sao aceitas (trava contra open redirect); link fora da
// lista sai sem mascara, nunca quebrado.
//
// ESPELHO: gestor-cdv/index.html (DOMINIOS_CB / slugParceiroCb /
// linkParceiroCb). Mudou aqui, muda la.

const IR_BASE_CB = 'https://ir.clubedoviajante.com.br/';
const IR_HOST_CB = 'ir.clubedoviajante.com.br';

const DOMINIOS_CB = [
  // Shoppings dos programas
  'clubedoviajante.com.br',
  'esfera.com.vc',
  'inter.co',
  'latam.com',
  'latamairlines.com',
  'latampass.com',
  'livelo.com.br',
  'meliuz.com.br',
  'shoppingsmiles.com.br',
  'smiles.com.br',
  'topcashback.co.uk',
  'topcashback.com',
  'voeazul.com.br',
  // Paginas b2b dos parceiros (Azul Fidelidade aponta direto para a loja)
  'camicado.com.br',
  'casasbahia.com.br',
  'extra.com.br',
  'lojasrenner.com.br',
  'magazineluiza.com.br',
  'netshoes.com.br',
  'pontofrio.com.br',
];

// Slugs de afiliado cujos params sao reaplicados quando o destino cai no
// dominio deles (ex.: shoppingsmiles -> params do slug 'smiles'). Mantem o
// mesmo resultado que o link teria pela mascara do programa.
const CB_HERDAR_DE = ['smiles', 'azul', 'latam'];

// Config virtual usada pelo proxy para qualquer slug cb-*.
const CB_CFG = {
  programa: 'Compras bonificadas',
  destino: 'https://painel.clubedoviajante.com.br/',
  dominios: DOMINIOS_CB,
  params: {},
};

function slugTexto(s, max) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, 'e')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max || 37)
    .replace(/-+$/g, '');
}

function slugParceiroCb(nome) {
  const s = slugTexto(nome, 37);
  return s ? 'cb-' + s : '';
}

function hostNaLista(host) {
  host = String(host || '').toLowerCase();
  return DOMINIOS_CB.some((d) => host === d || host.endsWith('.' + d));
}

// Devolve o link mascarado, ou o link original quando a oferta nao se encaixa.
function linkParceiroCb(o) {
  const link = o && o.link;
  if (!link) return link;
  if (!o.tier1 || o.categoria !== 'compra_bonificada') return link;
  const slug = slugParceiroCb(o.loja);
  if (!slug) return link;
  let u;
  try { u = new URL(String(link).trim()); } catch (e) { return link; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return link;
  const host = u.hostname.toLowerCase();
  if (host === IR_HOST_CB) return link; // ja mascarado
  if (!hostNaLista(host)) return link;
  const origem = 'of' + (o.programa ? '-' + slugTexto(o.programa, 30) : '');
  return IR_BASE_CB + slug + '?u=' + encodeURIComponent(u.toString()) + '&o=' + encodeURIComponent(origem);
}

module.exports = {
  DOMINIOS_CB,
  CB_CFG,
  CB_HERDAR_DE,
  slugParceiroCb,
  linkParceiroCb,
};
