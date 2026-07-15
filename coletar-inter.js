// coletar-inter.js — Coleta cashbacks de Gift Cards do Shopping Inter
// API: marketplace-api.web.bancointer.com.br (pública, sem autenticação)
// Salva: inter-gift-cards.json (snapshot atual) + inter-historico.json (série histórica)

const https = require('https');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO || 'davileles/painel-cdv';
const API_URL = 'https://marketplace-api.web.bancointer.com.br/site/giftcard/inter/v1/giftcards/search?lang=pt-BR&category=';

// Média móvel: janela de dias para calcular "acima da média"
const JANELA_MEDIA = 30;

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'CDV-Coletor/1.0' } }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON inválido: ' + data.slice(0, 200))); }
      });
    }).on('error', reject);
  });
}

function githubGet(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_REPO}/contents/${path}`,
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'User-Agent': 'CDV-Coletor/1.0',
        'Accept': 'application/vnd.github.v3+json'
      }
    };
    https.get(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function githubPut(path, content, sha, message) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      message,
      content: Buffer.from(JSON.stringify(content, null, 2)).toString('base64'),
      ...(sha ? { sha } : {})
    });
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_REPO}/contents/${path}`,
      method: 'PUT',
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'User-Agent': 'CDV-Coletor/1.0',
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const parsed = JSON.parse(data);
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
        else reject(new Error(`GitHub PUT ${res.statusCode}: ${data.slice(0, 300)}`));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function getFileSha(path) {
  try {
    const res = await githubGet(path);
    return res.sha || null;
  } catch {
    return null;
  }
}

async function getFileContent(path) {
  try {
    const res = await githubGet(path);
    if (res.encoding === 'base64' && res.content) {
      return JSON.parse(Buffer.from(res.content, 'base64').toString('utf8'));
    }
    // Arquivo grande: usar raw URL
    const rawUrl = `https://raw.githubusercontent.com/${GITHUB_REPO}/main/${path}`;
    return await httpsGet(rawUrl);
  } catch {
    return null;
  }
}

function calcularMedia(historico, slug, janela) {
  const entradas = Object.entries(historico)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-janela)
    .map(([, parceiros]) => parceiros[slug]?.cashback_pct)
    .filter(v => v !== undefined);
  if (!entradas.length) return null;
  return entradas.reduce((s, v) => s + v, 0) / entradas.length;
}

async function main() {
  console.log('🏦 Coletando Gift Cards do Shopping Inter...');

  // 1. Buscar dados da API
  const apiData = await httpsGet(API_URL);
  const giftCards = apiData.giftCards || [];
  console.log(`✅ ${giftCards.length} gift cards encontrados`);

  const hoje = new Date().toISOString().slice(0, 10);

  // 2. Carregar histórico existente
  let historico = await getFileContent('inter-historico.json') || {};

  // 3. Calcular médias e montar snapshot atual
  const snapshot = {
    coletado_em: new Date().toISOString(),
    total: giftCards.length,
    gift_cards: giftCards.map(gc => {
      const media = calcularMedia(historico, gc.slug, JANELA_MEDIA);
      const acima_da_media = media !== null && gc.cashbackValue > media * 1.1;
      return {
        id: gc.id,
        slug: gc.slug,
        name: gc.name,
        cashback_pct: gc.cashbackValue,
        benefits: gc.benefits,
        image_url: gc.imageUrl,
        media_30d: media !== null ? Math.round(media * 10) / 10 : null,
        acima_da_media
      };
    }).sort((a, b) => b.cashback_pct - a.cashback_pct)
  };

  // 4. Atualizar histórico (entrada do dia)
  const entradaHoje = {};
  giftCards.forEach(gc => {
    entradaHoje[gc.slug] = { cashback_pct: gc.cashbackValue, name: gc.name };
  });
  historico[hoje] = entradaHoje;

  // Manter apenas últimos 90 dias
  const todasDatas = Object.keys(historico).sort();
  if (todasDatas.length > 90) {
    const remover = todasDatas.slice(0, todasDatas.length - 90);
    remover.forEach(d => delete historico[d]);
  }

  // 5. Salvar inter-gift-cards.json (snapshot)
  const shaSnapshot = await getFileSha('inter-gift-cards.json');
  await githubPut('inter-gift-cards.json', snapshot, shaSnapshot,
    `🏦 Inter Gift Cards: ${giftCards.length} cards coletados em ${hoje}`);
  console.log('✅ inter-gift-cards.json atualizado');

  // 6. Salvar inter-historico.json
  const shaHistorico = await getFileSha('inter-historico.json');
  await githubPut('inter-historico.json', historico, shaHistorico,
    `📊 Histórico Inter: entrada de ${hoje}`);
  console.log('✅ inter-historico.json atualizado');

  // Resumo: top 5 cashbacks e acima da média
  const top5 = snapshot.gift_cards.slice(0, 5);
  console.log('\n🏆 Top 5 cashbacks hoje:');
  top5.forEach(gc => console.log(`  ${gc.cashback_pct}% — ${gc.name}${gc.acima_da_media ? ' ⭐ ACIMA DA MÉDIA' : ''}`));

  const destaques = snapshot.gift_cards.filter(gc => gc.acima_da_media);
  console.log(`\n⭐ Acima da média (últimos ${JANELA_MEDIA} dias): ${destaques.length} cards`);
  destaques.forEach(gc => console.log(`  ${gc.cashback_pct}% (média: ${gc.media_30d}%) — ${gc.name}`));
}

main().catch(err => {
  console.error('❌ Erro:', err.message);
  process.exit(1);
});
