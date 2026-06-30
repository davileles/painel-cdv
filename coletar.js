// Script executado pelo GitHub Action para coletar pontuações diárias
// e disparar alertas de email quando pontuações mínimas são atingidas

const https = require('https');
const fs = require('fs');

const PROXY = 'https://cdv-proxy-production.up.railway.app/fetch';
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = 'alertas@clubedoviajante.com.br'; // ou seu domínio verificado no Resend

const PROGRAMS = [
  { id: 'livelo', name: 'Livelo',     url: 'https://www.comparemania.com.br/lojas/pontos-milhas/programa-fidelidade-livelo' },
  { id: 'esfera', name: 'Esfera',     url: 'https://www.comparemania.com.br/lojas/pontos-milhas/programa-fidelidade-santander-esfera' },
  { id: 'smiles', name: 'Smiles',     url: 'https://www.comparemania.com.br/lojas/pontos-milhas/programa-fidelidade-smiles' },
  { id: 'azul',   name: 'Azul',       url: 'https://www.comparemania.com.br/lojas/pontos-milhas/programa-fidelidade-azul' },
  { id: 'latam',  name: 'LATAM Pass', url: 'https://www.comparemania.com.br/lojas/pontos-milhas/programa-fidelidade-latam-pass' },
];

const EQUIV = { livelo:1, esfera:1, smiles:1/1.8, azul:1/1.9, latam:1/1.25 };

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function httpPost(hostname, path, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({ hostname, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── Parser ────────────────────────────────────────────────────────────────────
function extractPts(g) {
  const ate    = g.match(/até\s+(\d+)/i);
  const eq     = g.match(/=\s+(\d+)/i);
  const azul   = g.match(/(\d+[,.]?\d*)\s*pt\//i);
  const latam  = g.match(/=\s*(\d+)\s*ponto/i);
  const smiles = g.match(/ganha\s+(?:até\s+)?(\d+)\s+smiles/i);
  const raw    = ate || eq || latam || smiles || azul;
  if (!raw) return null;
  const pts = parseFloat((raw[1]||'').replace(',','.'));
  return { pts: Math.round(pts) || pts, ate: !!(ate || smiles) };
}

function parseHTML(html, progId) {
  const out = [];
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
  const html = await httpGet(url);
  if (!html.includes('ponto(s)') && !html.includes('Smiles') && !html.includes('pt/R$')) {
    throw new Error(`${prog.id}: resposta inesperada`);
  }
  const items = parseHTML(html, prog.id);
  console.log(`  → ${items.length} parceiros`);
  return items;
}

// ── Email via Resend ──────────────────────────────────────────────────────────
async function enviarEmail(para, assunto, html) {
  if (!RESEND_API_KEY) { console.log('[email] RESEND_API_KEY não definida, pulando email para', para); return; }
  const res = await httpPost('api.resend.com', '/emails', {
    from: RESEND_FROM,
    to: [para],
    subject: assunto,
    html,
  }, { Authorization: `Bearer ${RESEND_API_KEY}` });
  console.log(`[email] ${para} → status ${res.status}`);
  return res;
}

function buildEmailHtml(alerta, parceiro, pts, progName, url) {
  return `
<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;background:#1e2535;color:#eee;padding:32px">
  <div style="max-width:480px;margin:0 auto;background:#2a3246;border-radius:14px;overflow:hidden;border:1px solid #3d4a66">
    <div style="background:#2a3246;border-bottom:3px solid #ff585e;padding:20px 24px">
      <span style="font-size:20px;font-weight:800;color:#eee">Clube do Viajante</span><br>
      <span style="font-size:11px;color:#ff585e;font-weight:600;text-transform:uppercase;letter-spacing:1px">Alerta de Compras Bonificadas</span>
    </div>
    <div style="padding:24px">
      <p style="font-size:16px;color:#8a9bbf;margin:0 0 6px">🔔 Seu alerta foi atingido!</p>
      <h2 style="margin:0 0 20px;font-size:22px;color:#eee">${parceiro}</h2>
      <div style="background:#323c54;border-radius:10px;padding:16px;margin-bottom:20px">
        <div style="font-size:12px;color:#5a6a8a;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Pontuação atual</div>
        <div style="font-size:36px;font-weight:900;color:#ff585e">${pts} <span style="font-size:14px;color:#8a9bbf">pts/R$</span></div>
        <div style="font-size:13px;color:#8a9bbf;margin-top:4px">via ${progName}</div>
      </div>
      <div style="font-size:13px;color:#8a9bbf;margin-bottom:20px">
        Seu alerta estava configurado para <strong style="color:#eee">${alerta.minPts} pts</strong> ou mais.
      </div>
      <a href="${url}" style="display:block;text-align:center;background:#ff585e;color:#fff;padding:14px;border-radius:10px;text-decoration:none;font-weight:800;font-size:14px">
        ↗ Aproveitar oferta agora
      </a>
    </div>
    <div style="padding:16px 24px;border-top:1px solid #3d4a66;font-size:11px;color:#5a6a8a;text-align:center">
      Clube do Viajante · Para cancelar este alerta, acesse o painel.
    </div>
  </div>
</body>
</html>`;
}

// ── Resolve link direto do parceiro no programa ──────────────────────────────
const PROG_HEADING_MAP = { livelo:'livelo', esfera:'esfera', smiles:'smiles', azul:'tudo azul', latam:'latam pass' };

async function resolveDirectUrl(partnerCashbackUrl, progId) {
  try {
    const html = await httpGet(`${PROXY}?url=${encodeURIComponent(partnerCashbackUrl)}`);
    const heading = PROG_HEADING_MAP[progId] || progId;
    // Acha link de redirecionar próximo ao heading do programa
    const idx = html.toLowerCase().indexOf(`>${heading}<`);
    if (idx < 0) return null;
    const chunk = html.slice(idx, idx + 2000);
    const rm = chunk.match(/redirecionar\/oferta\/[\d]+\/[\d]+\/[a-z0-9-]+/i);
    if (!rm) return null;
    const redirectUrl = 'https://www.comparemania.com.br/' + rm[0];
    const rhtml = await httpGet(`${PROXY}?url=${encodeURIComponent(redirectUrl)}`);
    // Link direto via <a href>
    const lm = rhtml.match(/href="(https?:\/\/(?:(?!comparemania)[^"]+)(?:esfera\.com|livelo\.com|smiles\.com|viajemais\.voeazul|latamairlines)[^"]*)"/i);
    if (lm) return lm[1];
    // Fallback JSON encoded
    const jm = rhtml.match(/https?:%5C%5Cu002F%5C%5Cu002F[^"<\s]*/i) || rhtml.match(/https?:\\u002F\\u002F[^"<\s]*/i);
    if (jm) return decodeURIComponent(jm[0].replace(/\\u002F/g,'/').replace(/\\u0026/g,'&'));
    return null;
  } catch(e) {
    console.log('[resolveDirectUrl] erro:', e.message);
    return null;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const hoje = new Date().toISOString().split('T')[0];

  // 1. Carrega histórico
  let historico = {};
  if (fs.existsSync('historico.json')) {
    try { historico = JSON.parse(fs.readFileSync('historico.json', 'utf8')); }
    catch(e) { console.log('historico.json inválido, iniciando novo'); }
  }

  // 2. Carrega alertas
  let alertas = [];
  if (fs.existsSync('alertas.json')) {
    try { alertas = JSON.parse(fs.readFileSync('alertas.json', 'utf8')); }
    catch(e) { console.log('alertas.json inválido'); }
  }
  console.log(`Alertas cadastrados: ${alertas.length}`);

  // 3. Coleta dados de hoje
  const allData = {};
  for (const prog of PROGRAMS) {
    try { allData[prog.id] = await fetchProg(prog); }
    catch(e) { console.error(`Erro em ${prog.id}:`, e.message); allData[prog.id] = []; }
  }

  // 4. Merge por parceiro
  const map = {};
  for (const [progId, items] of Object.entries(allData)) {
    for (const p of items) {
      const key = p.name.toLowerCase().trim();
      if (!map[key]) map[key] = { name: p.name, programs: {}, urls: {} };
      map[key].programs[progId] = p.pts;
      map[key].urls[progId] = p.url;
    }
  }

  // 5. Monta snapshot
  const snapshot = {};
  for (const [key, p] of Object.entries(map)) {
    let bestEquiv = 0, bestPts = 0;
    for (const [pid, pts] of Object.entries(p.programs)) {
      const equiv = pts * (EQUIV[pid] || 1);
      if (equiv > bestEquiv) { bestEquiv = equiv; bestPts = pts; }
    }
    snapshot[key] = { name: p.name, pts: bestPts, programs: p.programs, urls: p.urls };
  }

  // 6. Verifica alertas e dispara emails
  const alertasDisparados = [];
  for (const alerta of alertas) {
    if (!alerta.email || !alerta.parceiro || !alerta.minPts || !alerta.programa) continue;
    const key = alerta.parceiro.toLowerCase().trim();
    const snap = snapshot[key];
    if (!snap) continue;
    const progId = alerta.programa;
    const pts = snap.programs[progId];
    if (!pts) continue;
    if (pts >= alerta.minPts) {
      const prog = PROGRAMS.find(p => p.id === progId);
      const cashbackUrl = snap.urls[progId] || '';
      console.log(`🔔 Alerta! ${alerta.email} → ${alerta.parceiro} ${pts} pts via ${prog.name}`);
      // Resolve link direto do programa
      let directUrl = cashbackUrl;
      if (cashbackUrl) {
        const resolved = await resolveDirectUrl(cashbackUrl, progId);
        if (resolved) { directUrl = resolved; console.log(`  Link direto: ${resolved}`); }
      }
      await enviarEmail(
        alerta.email,
        `🔔 ${snap.name} atingiu ${pts} pts/R$ no ${prog.name}`,
        buildEmailHtml(alerta, snap.name, pts, prog.name, directUrl)
      );
      alertasDisparados.push({ ...alerta, ptsAtingido: pts, data: hoje });
    }
  }

  if (alertasDisparados.length > 0) {
    console.log(`\n${alertasDisparados.length} alerta(s) disparado(s)`);
  }

  // 7. Atualiza histórico (mantém 180 dias)
  historico[hoje] = snapshot;
  const datas = Object.keys(historico).sort();
  const limite = new Date();
  limite.setDate(limite.getDate() - 180);
  const limiteStr = limite.toISOString().split('T')[0];
  for (const d of datas) {
    if (d < limiteStr) delete historico[d];
  }

  fs.writeFileSync('historico.json', JSON.stringify(historico, null, 2));
  console.log(`\nHistórico salvo: ${Object.keys(historico).length} dias, ${Object.keys(snapshot).length} parceiros`);
}

main().catch(e => { console.error(e); process.exit(1); });
