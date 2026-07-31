// catalogo-meliuz.js
// Executado semanalmente pelo GitHub Action (catalogo-meliuz.yml).
// 1. Baixa o índice A-Z de lojas do Méliuz (https://www.meliuz.com.br/desconto)
// 2. Cruza com os parceiros já presentes no historico.json (snapshot mais recente)
// 3. Grava meliuz-lojas.json — o catálogo que o coletar-meliuz.js consome
//
// Por que cruzar em vez de pegar tudo? O índice tem ~2.360 lojas, mas só as que
// já existem no Comparador interessam: usando a MESMA chave do coletar.js
// (Comparemania), o cashback do Méliuz entra direto no card do parceiro, sem
// nenhuma reconciliação de nomes no front.
//
// Uso: node catalogo-meliuz.js

const fs   = require('fs');
const path = require('path');

const HISTORICO_FILE = path.join(__dirname, 'historico.json');
const OUT_FILE       = path.join(__dirname, 'meliuz-lojas.json');
const INDICE_URL     = 'https://www.meliuz.com.br/desconto';

// ── Lojas incluídas manualmente ───────────────────────────────────────────────
// Cobre dois casos que o cruzamento automático por nome não resolve:
//
//  a) ALIAS — a loja existe no historico.json, mas com nome diferente do Méliuz
//     (ex: Méliuz "Booking.com" vs Comparemania "booking"). Aqui `chave` DEVE ser
//     exatamente a chave já usada no historico.json, senão o parceiro duplica
//     no Comparador.
//  b) EXTRA — parceiro relevante para o CDV que não é parceiro Comparemania e
//     portanto nunca apareceria no historico.json (ex: ALL Accor). Nesse caso a
//     `chave` é nova e passa a existir só por causa do Méliuz.
//
// Em ambos os casos a `chave` precisa ser estável e em minúsculas — ela é o
// identificador usado no historico.json, no merge do Comparador e no set Tier 1.
const EXTRAS = [
  { slug: 'cupom-accor-hoteis', nome: 'ALL Accor',   chave: 'all accor' }, // extra
  { slug: 'cupom-booking',      nome: 'Booking.com', chave: 'booking'   }, // alias
  { slug: 'cupom-decolarcom',   nome: 'Decolar.com', chave: 'decolar'   }, // alias
];

// ── Normalização para casar nomes entre Méliuz e Comparemania ────────────────
function norm(s) {
  return (s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

async function fetchDirect(url, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'pt-BR,pt;q=0.9',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} para ${url}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

async function main() {
  console.log('[Catálogo Méliuz] Baixando índice de lojas…');
  const html = await fetchDirect(INDICE_URL);

  const pares = [...html.matchAll(/<li><a href="\/desconto\/([^"]+)">([^<]+)<\/a><\/li>/g)]
    .map(m => ({ slug: m[1], nome: m[2].trim() }));

  console.log(`[Catálogo Méliuz] ${pares.length} lojas no índice`);
  if (pares.length < 500) {
    console.error('[Catálogo Méliuz] Índice abaixo do esperado — abortando sem salvar.');
    process.exit(1);
  }

  // Chaves do snapshot mais recente do historico.json
  let historico = {};
  try {
    historico = JSON.parse(fs.readFileSync(HISTORICO_FILE, 'utf8'));
  } catch (e) {
    console.error('[Catálogo Méliuz] historico.json ilegível — abortando.');
    process.exit(1);
  }
  const ultimoDia = Object.keys(historico).sort().at(-1);
  const snap = historico[ultimoDia] || {};

  const chavesPorNorm = {};
  for (const k of Object.keys(snap)) chavesPorNorm[norm(k)] = k;
  console.log(`[Catálogo Méliuz] ${Object.keys(snap).length} parceiros no snapshot de ${ultimoDia}`);

  const vistos = new Set();
  const lojas = [];

  // Extras primeiro — têm prioridade sobre um eventual match automático
  for (const e of EXTRAS) {
    vistos.add(e.chave);
    lojas.push({ ...e, extra: true });
  }

  for (const p of pares) {
    const chave = chavesPorNorm[norm(p.nome)];
    if (!chave || vistos.has(chave)) continue;
    vistos.add(chave);
    lojas.push({ slug: p.slug, nome: p.nome, chave });
  }

  lojas.sort((a, b) => a.chave.localeCompare(b.chave, 'pt-BR'));

  fs.writeFileSync(OUT_FILE, JSON.stringify({
    geradoEm: new Date().toISOString(),
    baseSnapshot: ultimoDia,
    lojas,
  }, null, 2));

  console.log(`[Catálogo Méliuz] ${lojas.length} lojas gravadas em meliuz-lojas.json (${EXTRAS.length} extra(s)).`);
}

main().catch(e => {
  console.error('[Catálogo Méliuz] Erro fatal:', e.message);
  process.exit(1);
});
