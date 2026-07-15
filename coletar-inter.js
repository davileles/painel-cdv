// coletar-inter.js
// Executado pelo GitHub Action (coletar-historico.yml — mesmo workflow do Comparemania).
// 1. Acessa a API pública do Shopping Inter (marketplace-api.web.bancointer.com.br)
// 2. Extrai o cashbackValue (%) de cada Gift Card
// 3. Salva/atualiza o historico.json com o snapshot do dia no programa "inter"
//
// Estrutura no historico.json:
//   "2026-07-15": {
//     "ifood": { programs: { inter: { pts: 10, dollar: false } } },
//     "uber":  { programs: { inter: { pts: 2,  dollar: false } } },
//     ...
//   }
//
// Isso permite que o Comparador do painel-cdv exiba o Inter como mais um programa,
// com suporte a filtros, badges, "acima da média" e histórico — igual ao Livelo/Esfera.
//
// Uso: node coletar-inter.js

const fs   = require('fs');
const path = require('path');

const HISTORICO_FILE = path.join(__dirname, 'historico.json');
// A API do Inter bloqueia IPs de datacenter (GitHub Actions = ASN bloqueado).
// A requisição é roteada pelo proxy Railway do CDV, que tem IP não bloqueado.
const PROXY_URL = process.env.CDV_PROXY_URL || 'https://cdv-proxy-production.up.railway.app';
const API_URL = `${PROXY_URL}/inter/gift-cards`;

// ── HTTP helper ───────────────────────────────────────────────────────────────
async function fetchDirect(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, */*',
        'Accept-Language': 'pt-BR,pt;q=0.9',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} para ${url}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// Normaliza nome do gift card para chave do historico.json
// (mesmo padrão lowercase trim do coletar.js e do index.html)
function normalizarChave(name) {
  return (name || '')
    .replace(/^Gift Card\s*/i, '')  // remove prefixo "Gift Card "
    .toLowerCase()
    .trim();
}

// ── Categorização (mesmas regras do CAT_RULES do index.html) ─────────────────
function categorize(n) {
  const CAT_RULES = [
    [/uber|99.taxi|buser|clickbus/i, 'Transporte'],
    [/playstation|xbox|steam|nintendo|razer|nuuvem|game|garena|riot|blizzard/i, 'Games'],
    [/ifood|rappi|zé.delivery|delivery/i, 'Alimentação'],
    [/netflix|spotify|deezer|hbo|disney|globoplay|apple.tv|amazon.prime|paramount/i, 'Streaming'],
    [/amazon|shopee|mercado.livre|magalu|magazine/i, 'Marketplace'],
    [/booking|decolar|hoteis|airbnb/i, 'Viagem'],
    [/farmácia|droga|drogaria|drogal/i, 'Farmácia'],
    [/petlove|petz|cobasi/i, 'Pet'],
    [/assaí|assai|carrefour|sam.?s.club|supernosso/i, 'Supermercado'],
    [/claro|tim\b|vivo|oi\b/i, 'Telecom'],
    [/renner|riachuelo|c.?&.?a\b|cea\b|zattini|dafiti|centauro|netshoes/i, 'Moda'],
    [/sephora|beleza|natura|boticário|eudora/i, 'Beleza'],
    [/bagaggio|samsonite/i, 'Viagem'],
    [/outback|madero|cvc|bob.s/i, 'Alimentação'],
    [/electrolux|brastemp|consul|samsung|lg\b|acer|multilaser/i, 'Eletrônicos'],
    [/google|apple\b|microsoft/i, 'Tech'],
    [/tok.stok|leroy|telhanorte|leroy.merlin/i, 'Casa'],
    [/cinemark|ingresso/i, 'Entretenimento'],
    [/itunes|app.store/i, 'Tech'],
    [/google.play/i, 'Tech'],
  ];
  for (const [re, c] of CAT_RULES) if (re.test(n)) return c;
  return 'Gift Card';
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const hoje = new Date().toISOString().split('T')[0];
  console.log(`[Inter] Iniciando coleta para ${hoje}`);

  // 1. Carrega historico.json existente
  let historico = {};
  if (fs.existsSync(HISTORICO_FILE)) {
    try {
      historico = JSON.parse(fs.readFileSync(HISTORICO_FILE, 'utf8'));
    } catch (e) {
      console.warn('[Inter] historico.json corrompido — iniciando vazio.');
    }
  }

  // 2. Chama API do Inter
  console.log('[Inter] Consultando API do Shopping Inter…');
  let giftCards = [];
  try {
    const data = await fetchDirect(API_URL);
    giftCards = data.giftCards || [];
    console.log(`[Inter] ${giftCards.length} gift cards encontrados`);
  } catch (e) {
    console.error('[Inter] Erro ao consultar API:', e.message);
    process.exit(1);
  }

  if (!giftCards.length) {
    console.error('[Inter] Nenhum gift card retornado — abortando.');
    process.exit(1);
  }

  // 3. Monta snapshot do dia para o programa "inter"
  // Garante que o snapshot do dia existe
  if (!historico[hoje]) historico[hoje] = {};
  const snapHoje = historico[hoje];

  let atualizados = 0;
  for (const gc of giftCards) {
    const chave = normalizarChave(gc.name);
    if (!chave) continue;

    // Inicializa entrada do parceiro se não existir
    if (!snapHoje[chave]) snapHoje[chave] = { programs: {} };
    if (!snapHoje[chave].programs) snapHoje[chave].programs = {};

    // Salva cashback% como pts no programa "inter" (mesmo campo que livelo/esfera usam)
    snapHoje[chave].programs.inter = {
      pts: gc.cashbackValue,
      dollar: false,
      slug: gc.slug,
    };

    // Adiciona link direto para a página do gift card no Shopping Inter
    if (!snapHoje[chave].links) snapHoje[chave].links = {};
    snapHoje[chave].links.inter = `https://shopping.inter.co/gift-card/${gc.slug}`;

    atualizados++;
  }

  console.log(`[Inter] ${atualizados} parceiros atualizados no historico.json`);

  // 4. Remove dias com mais de 180 dias
  const corte = new Date();
  corte.setDate(corte.getDate() - 180);
  const corteStr = corte.toISOString().split('T')[0];
  let removidos = 0;
  for (const data of Object.keys(historico)) {
    if (data < corteStr) { delete historico[data]; removidos++; }
  }
  if (removidos) console.log(`[Inter] ${removidos} dia(s) antigos removidos`);

  // 5. Salva historico.json
  fs.writeFileSync(HISTORICO_FILE, JSON.stringify(historico, null, 2));
  console.log(`[Inter] historico.json salvo com ${Object.keys(historico).length} dias.`);

  // Resumo: top 5
  const top5 = giftCards
    .sort((a, b) => b.cashbackValue - a.cashbackValue)
    .slice(0, 5);
  console.log('\n🏆 Top 5 cashbacks Inter hoje:');
  top5.forEach(gc => console.log(`  ${gc.cashbackValue}% — ${gc.name}`));
}

main().catch(e => {
  console.error('[Inter] Erro fatal:', e.message);
  process.exit(1);
});
