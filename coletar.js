// Script executado pelo GitHub Action para coletar pontuações diárias
// Salva/atualiza historico.json no repositório

const https = require('https');
const fs = require('fs');

const PROXY = 'https://cdv-proxy-production.up.railway.app/fetch';
const PROGRAMS = [
  { id: 'livelo', url: 'https://www.comparemania.com.br/lojas/pontos-milhas/programa-fidelidade-livelo' },
  { id: 'esfera', url: 'https://www.comparemania.com.br/lojas/pontos-milhas/programa-fidelidade-santander-esfera' },
  { id: 'smiles', url: 'https://www.comparemania.com.br/lojas/pontos-milhas/programa-fidelidade-smiles' },
  { id: 'azul',   url: 'https://www.comparemania.com.br/lojas/pontos-milhas/programa-fidelidade-azul' },
  { id: 'latam',  url: 'https://www.comparemania.com.br/lojas/pontos-milhas/programa-fidelidade-latam-pass' },
];

// Fatores de equivalência (iguais ao painel)
const EQUIV = { livelo:1, esfera:1, smiles:1/1.8, azul:1/1.9, latam:1/1.25 };

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function extractPts(g) {
  const ate   = g.match(/até\s+(\d+)/i);
  const eq    = g.match(/=\s+(\d+)/i);
  const azul  = g.match(/(\d+[,.]?\d*)\s*pt\//i);
  const latam = g.match(/=\s*(\d+)\s*ponto/i);
  const smiles= g.match(/ganha\s+(?:até\s+)?(\d+)\s+smiles/i);
  const raw   = ate || eq || latam || smiles || azul;
  if (!raw) return null;
  const pts = parseFloat((raw[1]||'').replace(',','.'));
  return { pts: Math.round(pts) || pts, ate: !!(ate || smiles) };
}

function parseHTML(html, progId) {
  const out = [];
  // Extrai linhas de tabela com regex simples (sem DOMParser no Node)
  const rowRe = /<tr[\s\S]*?<\/tr>/gi;
  const cellRe = /<td[\s\S]*?<\/td>/gi;
  const linkRe = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i;
  const textRe = /<[^>]+>/g;

  let rowMatch;
  while ((rowMatch = rowRe.exec(html)) !== null) {
    const row = rowMatch[0];
    const cells = row.match(cellRe);
    if (!cells || cells.length < 2) continue;
    const nameLink = cells[0].match(linkRe);
    const gainLink = cells[1].match(linkRe);
    if (!nameLink || !gainLink) continue;
    const name = nameLink[2].replace(textRe, '').trim();
    const g = gainLink[2].replace(textRe, '').trim() + ' ' + cells[1].replace(textRe, '');
    const parsed = extractPts(g);
    if (!parsed || !name) continue;
    const rawHref = nameLink[1];
    const url = rawHref.startsWith('http') ? rawHref : 'https://www.comparemania.com.br' + rawHref;
    out.push({ name, pts: parsed.pts, ate: parsed.ate, url, prog: progId });
  }
  return out;
}

async function fetchProg(prog) {
  console.log(`Consultando ${prog.id}...`);
  const url = `${PROXY}?url=${encodeURIComponent(prog.url)}`;
  const html = await fetch(url);
  if (!html.includes('ponto(s)') && !html.includes('Smiles') && !html.includes('pt/R$')) {
    throw new Error(`${prog.id}: resposta inesperada`);
  }
  const items = parseHTML(html, prog.id);
  console.log(`  → ${items.length} parceiros`);
  return items;
}

async function main() {
  const hoje = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  // Carrega histórico existente
  let historico = {};
  if (fs.existsSync('historico.json')) {
    try {
      historico = JSON.parse(fs.readFileSync('historico.json', 'utf8'));
    } catch(e) {
      console.log('historico.json inválido, iniciando novo');
    }
  }

  // Coleta dados de hoje
  const allData = {};
  for (const prog of PROGRAMS) {
    try {
      allData[prog.id] = await fetchProg(prog);
    } catch(e) {
      console.error(`Erro em ${prog.id}:`, e.message);
      allData[prog.id] = [];
    }
  }

  // Merge por parceiro → maior pts equivalente
  const map = {};
  for (const [progId, items] of Object.entries(allData)) {
    for (const p of items) {
      const key = p.name.toLowerCase().trim();
      if (!map[key]) map[key] = { name: p.name, programs: {} };
      map[key].programs[progId] = p.pts;
    }
  }

  // Calcula melhor pts equivalente por parceiro
  const snapshot = {};
  for (const [key, p] of Object.entries(map)) {
    let bestEquiv = 0, bestPts = 0;
    for (const [pid, pts] of Object.entries(p.programs)) {
      const equiv = pts * (EQUIV[pid] || 1);
      if (equiv > bestEquiv) { bestEquiv = equiv; bestPts = pts; }
    }
    snapshot[key] = { name: p.name, pts: bestPts, programs: p.programs };
  }

  // Adiciona snapshot de hoje ao histórico
  // Mantém apenas últimos 180 dias
  historico[hoje] = snapshot;
  const datas = Object.keys(historico).sort();
  const limite = new Date();
  limite.setDate(limite.getDate() - 180);
  const limiteStr = limite.toISOString().split('T')[0];
  for (const d of datas) {
    if (d < limiteStr) delete historico[d];
  }

  fs.writeFileSync('historico.json', JSON.stringify(historico, null, 2));
  console.log(`\nHistórico salvo: ${Object.keys(historico).length} dias, ${Object.keys(snapshot).length} parceiros hoje`);
}

main().catch(e => { console.error(e); process.exit(1); });
