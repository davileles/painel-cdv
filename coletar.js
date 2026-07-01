// coletar.js
// Executado pelo GitHub Action diariamente (coletar-historico.yml).
// 1. Acessa as páginas de cada programa de fidelidade no Comparemania
// 2. Extrai a pontuação de cada parceiro (pts/R$)
// 3. Salva/atualiza o historico.json com o snapshot do dia
//
// Variáveis de ambiente necessárias:
//   RESEND_API_KEY     → chave Resend para disparar alertas por e-mail
//   ANTHROPIC_API_KEY  → não utilizado por este script (mantido no env por compatibilidade)
//
// Uso: node coletar.js

const fs   = require('fs');
const path = require('path');

const HISTORICO_FILE  = path.join(__dirname, 'historico.json');
const ALERTAS_FILE    = path.join(__dirname, 'alertas.json');
const RESEND_API_KEY  = process.env.RESEND_API_KEY || '';

// ── Programas monitorados ─────────────────────────────────────────────────────
const PROGRAMS = [
  {
    id:   'livelo',
    name: 'Livelo',
    url:  'https://www.comparemania.com.br/lojas/pontos-milhas/programa-fidelidade-livelo',
  },
  {
    id:   'esfera',
    name: 'Esfera',
    url:  'https://www.comparemania.com.br/lojas/pontos-milhas/programa-fidelidade-santander-esfera',
  },
  {
    id:   'smiles',
    name: 'Smiles',
    url:  'https://www.comparemania.com.br/lojas/pontos-milhas/programa-fidelidade-smiles',
  },
  {
    id:   'azul',
    name: 'Azul',
    url:  'https://www.comparemania.com.br/lojas/pontos-milhas/programa-fidelidade-azul',
  },
  {
    id:   'latam',
    name: 'LATAM Pass',
    url:  'https://www.comparemania.com.br/lojas/pontos-milhas/programa-fidelidade-latam-pass',
  },
];

// ── HTTP helper — acesso direto (GitHub Actions não tem CORS) ─────────────────
async function fetchDirect(url, timeoutMs = 25000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.7',
        'Cache-Control':   'no-cache',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} para ${url}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

// ── Parser de pontuação ───────────────────────────────────────────────────────
// Suporta os formatos que a Comparemania usa por programa:
//   Livelo/Esfera : "= 5 ponto(s) por 1 real"  |  "até 84 ponto(s) por 1 real"
//   Azul          : "5 pt/R$"  |  "4,5 pt/R$"
//   LATAM         : "Cada 1 real gastos = 3 ponto(s) Latam Pass"
//   Smiles        : "você ganha até 26 Smiles"
function extractPts(g) {
  const ate    = g.match(/até\s+(\d+)/i);
  const eq     = g.match(/=\s+(\d+)/i);
  const azul   = g.match(/(\d+[,.]?\d*)\s*pt\//i);
  const latam  = g.match(/=\s*(\d+)\s*ponto/i);
  const smiles = g.match(/ganha\s+(?:até\s+)?(\d+)\s+smiles/i);
  const raw    = ate || eq || latam || smiles || azul;
  if (!raw) return null;
  const pts = parseFloat((raw[1] || '').replace(',', '.'));
  return isNaN(pts) ? null : Math.round(pts) || pts;
}

// O heading do programa na página difere do ID interno
const HEADING_MAP = {
  livelo: 'livelo',
  esfera: 'esfera',
  smiles: 'smiles',
  azul:   'tudo azul',
  latam:  'latam pass',
};

function normalizeHeading(txt) {
  return txt.toLowerCase().trim();
}

// Extrai { parceiro → pts } de uma página HTML do Comparemania
function parseComparemaniaPts(html, progId) {
  const result = {};

  // Remove scripts/styles para evitar falsos positivos
  const clean = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');

  // Percorre todas as linhas <tr> com pelo menos 2 <td>
  const trBlocks = clean.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  for (const tr of trBlocks) {
    const tds = tr.match(/<td[\s\S]*?<\/td>/gi) || [];
    if (tds.length < 2) continue;

    // Primeiro <td> → nome do parceiro (via link <a>)
    const aMatch = tds[0].match(/<a[^>]*>([\s\S]*?)<\/a>/i);
    if (!aMatch) continue;
    const name = aMatch[1].replace(/<[^>]*>/g, '').trim();
    if (!name) continue;

    // Segundo <td> → texto com pontuação
    const ptsTxt = tds[1].replace(/<[^>]*>/g, ' ').trim();
    const pts = extractPts(ptsTxt);
    if (!pts) continue;

    const key = name.toLowerCase().trim();
    // Guarda o maior pts encontrado para o mesmo parceiro (pode aparecer mais de uma vez)
    if (!result[key] || pts > result[key]) {
      result[key] = pts;
    }
  }

  return result; // { "shopee": 8, "magalu": 5, ... }
}

// ── Alerta por e-mail via Resend ──────────────────────────────────────────────
async function dispararAlerta(alerta, parceiro, pts) {
  if (!RESEND_API_KEY) return;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from:    'Clube do Viajante <alertas@clubedoviajante.com.br>',
        to:      [alerta.email],
        subject: `🔔 ${parceiro} atingiu ${pts} pts/R$ no ${alerta.programa}`,
        html: `
          <p>Olá!</p>
          <p>O parceiro <strong>${parceiro}</strong> está oferecendo
          <strong>${pts} pts/R$</strong> no programa <strong>${alerta.programa}</strong>.</p>
          <p>Você configurou um alerta para quando atingisse <strong>${alerta.minPts} pts/R$</strong>.</p>
          <p><a href="https://davileles.github.io/painel-cdv/">Acessar o painel</a></p>
          <p>— Clube do Viajante</p>
        `,
      }),
    });
    if (res.ok) {
      console.log(`[Histórico] Alerta enviado para ${alerta.email} (${parceiro} ${pts} pts)`);
    } else {
      const err = await res.text();
      console.error(`[Histórico] Falha ao enviar alerta: ${err.slice(0, 200)}`);
    }
  } catch (e) {
    console.error(`[Histórico] Erro ao disparar alerta:`, e.message);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const hoje = new Date().toISOString().split('T')[0]; // "YYYY-MM-DD"
  console.log(`[Histórico] Iniciando coleta para ${hoje}`);

  // 1. Carrega histórico existente
  let historico = {};
  if (fs.existsSync(HISTORICO_FILE)) {
    try {
      historico = JSON.parse(fs.readFileSync(HISTORICO_FILE, 'utf8'));
    } catch (e) {
      console.warn('[Histórico] historico.json corrompido — iniciando vazio.');
    }
  }

  // 2. Carrega alertas cadastrados
  let alertas = [];
  if (fs.existsSync(ALERTAS_FILE)) {
    try {
      alertas = JSON.parse(fs.readFileSync(ALERTAS_FILE, 'utf8'));
      if (!Array.isArray(alertas)) alertas = [];
    } catch (e) {
      alertas = [];
    }
  }

  // 3. Snapshot do dia: { "shopee": { programs: { livelo: 8, esfera: 5 } } }
  const snapshot = {};

  for (const prog of PROGRAMS) {
    console.log(`[Histórico] Coletando ${prog.name}…`);
    try {
      const html = await fetchDirect(prog.url);

      // Sanidade mínima
      const hasContent =
        html.includes('ponto') || html.includes('PONTOS') ||
        html.includes('pt/R$') || /<table[\s\S]*?<tr/i.test(html);
      if (!hasContent) {
        console.warn(`[Histórico] ${prog.name}: resposta inesperada (${html.length} chars), pulando.`);
        continue;
      }

      const parceiros = parseComparemaniaPts(html, prog.id);
      const count = Object.keys(parceiros).length;
      console.log(`[Histórico] ${prog.name}: ${count} parceiros encontrados`);

      // Popula snapshot
      for (const [key, pts] of Object.entries(parceiros)) {
        if (!snapshot[key]) snapshot[key] = { programs: {} };
        snapshot[key].programs[prog.id] = pts;
      }
    } catch (e) {
      console.error(`[Histórico] Erro ao coletar ${prog.name}:`, e.message);
    }
  }

  const totalParceiros = Object.keys(snapshot).length;
  console.log(`[Histórico] Snapshot do dia: ${totalParceiros} parceiros únicos`);

  if (totalParceiros === 0) {
    console.error('[Histórico] Nenhum dado coletado — abortando sem salvar.');
    process.exit(1);
  }

  // 4. Verifica alertas
  for (const alerta of alertas) {
    const key = (alerta.parceiro || '').toLowerCase().trim();
    const snap = snapshot[key];
    if (!snap) continue;
    const pts = snap.programs[alerta.programa];
    if (pts && pts >= alerta.minPts) {
      await dispararAlerta(alerta, alerta.parceiro, pts);
    }
  }

  // 5. Salva snapshot no histórico (sobrescreve o dia se já existir)
  historico[hoje] = snapshot;

  // Remove dias com mais de 180 dias (mantém ~6 meses)
  const corte = new Date();
  corte.setDate(corte.getDate() - 180);
  const corteStr = corte.toISOString().split('T')[0];
  for (const data of Object.keys(historico)) {
    if (data < corteStr) delete historico[data];
  }

  fs.writeFileSync(HISTORICO_FILE, JSON.stringify(historico, null, 2));
  console.log(`[Histórico] historico.json salvo com ${Object.keys(historico).length} dias.`);
}

main().catch((e) => {
  console.error('[Histórico] Erro fatal:', e);
  process.exit(1);
});
