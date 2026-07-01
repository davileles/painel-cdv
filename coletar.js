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
  const smiles = g.match(/ganha\s+(?:você\s+)?(?:até\s+)?(\d+)\s+smiles/i) || g.match(/ganha\s+até\s+(\d+)\s+smiles/i) || g.match(/(\d+)\s+smiles/i);
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

  // Extrai todos os pares de <a href> (nome do parceiro) + texto de pontuação
  // O Smiles e outros programas têm estrutura:
  // <td><a href="...">Nome</a></td><td><a href="...">A cada 1 real gasto...</a></td>
  // Usa split por </tr> para processar linha a linha sem regex greedy
  const rows = clean.split(/<\/tr>/i);
  for (const row of rows) {
    // Divide a linha em células pelo fechamento de </td>
    const cells = row.split(/<\/td>/i);
    if (cells.length < 2) continue;

    // Primeiro <td>: extrai o nome via <a>
    const aMatch = cells[0].match(/<a[^>]*>([\s\S]*?)<\/a>/i);
    if (!aMatch) continue;
    const name = aMatch[1].replace(/<[^>]*>/g, '').trim();
    if (!name) continue;

    // Segundo <td>: texto de pontuação (remove tags)
    const ptsTxt = cells[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    const pts = extractPts(ptsTxt);
    if (!pts) continue;

    const key = name.toLowerCase().trim();
    if (!result[key] || pts > result[key]) {
      result[key] = pts;
    }
  }

  return result;
}

function decodeEntities(s) {
  return (s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/&#0?39;/g, "'");
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
        html: `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<style>@import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@400;600;700;800;900&display=swap');</style>
</head>
<body style="margin:0;padding:0;background:#f4f4f7;font-family:'Montserrat',Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:32px 0">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);max-width:560px;width:100%">

        <!-- Header -->
        <tr>
          <td style="background:#2a3246;padding:28px 32px;text-align:center">
            <p style="margin:0;font-size:22px;font-weight:800;color:#ffffff;letter-spacing:-0.3px">Clube do Viajante</p>
            <p style="margin:6px 0 0;font-size:11px;font-weight:600;color:#ff585e;letter-spacing:2px;text-transform:uppercase">Alerta de Pontuação</p>
          </td>
        </tr>

        <!-- Ícone -->
        <tr>
          <td style="padding:32px 32px 0;text-align:center">
            <div style="display:inline-block;background:#fff3f3;border-radius:50%;width:64px;height:64px;line-height:64px;font-size:30px;text-align:center">🔔</div>
          </td>
        </tr>

        <!-- Título -->
        <tr>
          <td style="padding:16px 32px 8px;text-align:center">
            <p style="margin:0;font-size:20px;font-weight:800;color:#1a1a2e">Sua meta foi atingida!</p>
            <p style="margin:8px 0 0;font-size:14px;color:#666;line-height:1.5">O parceiro que você monitora atingiu a pontuação configurada.</p>
          </td>
        </tr>

        <!-- Card de destaque -->
        <tr>
          <td style="padding:24px 32px">
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8f9ff;border:1px solid #e0e4f0;border-radius:10px;overflow:hidden">
              <tr>
                <td style="padding:20px 24px">
                  <p style="margin:0 0 4px;font-size:11px;font-weight:700;color:#8a9bbf;text-transform:uppercase;letter-spacing:1px">Parceiro</p>
                  <p style="margin:0;font-size:20px;font-weight:800;color:#2a3246">${parceiro}</p>
                </td>
                <td style="padding:20px 24px;text-align:right;border-left:1px solid #e0e4f0">
                  <p style="margin:0 0 4px;font-size:11px;font-weight:700;color:#8a9bbf;text-transform:uppercase;letter-spacing:1px">Pontuação atual</p>
                  <p style="margin:0;font-size:28px;font-weight:900;color:#ff585e">${pts} <span style="font-size:14px;font-weight:600;color:#8a9bbf">pts/R$</span></p>
                </td>
              </tr>
              <tr>
                <td colspan="2" style="padding:0 24px 20px">
                  <p style="margin:0;font-size:11px;font-weight:700;color:#8a9bbf;text-transform:uppercase;letter-spacing:1px">Programa</p>
                  <p style="margin:4px 0 0;font-size:14px;font-weight:700;color:#2a3246">${alerta.programa.charAt(0).toUpperCase()+alerta.programa.slice(1)}</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Info alerta -->
        <tr>
          <td style="padding:0 32px 24px;text-align:center">
            <p style="margin:0;font-size:13px;color:#999">Você configurou um alerta para <strong style="color:#2a3246">${alerta.minPts} pts/R$</strong> neste parceiro.</p>
          </td>
        </tr>

        <!-- CTA -->
        <tr>
          <td style="padding:0 32px 32px;text-align:center">
            <a href="https://davileles.github.io/painel-cdv/" style="display:inline-block;background:#ff585e;color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;padding:14px 32px;border-radius:8px;letter-spacing:0.3px">Acessar o Painel →</a>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#f8f9ff;padding:20px 32px;text-align:center;border-top:1px solid #e0e4f0">
            <p style="margin:0;font-size:12px;color:#aaa">Este alerta foi enviado automaticamente pelo Clube do Viajante.<br>Após o envio, o alerta é removido automaticamente.</p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`,
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
        const cleanKey = decodeEntities(key);
        if (!snapshot[cleanKey]) snapshot[cleanKey] = { programs: {} };
        snapshot[cleanKey].programs[prog.id] = pts;
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

  // 4. Verifica alertas e dispara os atingidos (remove após enviar)
  const alertasRestantes = [];
  for (const alerta of alertas) {
    const key = (alerta.parceiro || '').toLowerCase().trim();
    const snap = snapshot[key];
    if (!snap) { alertasRestantes.push(alerta); continue; }
    const pts = snap.programs[alerta.programa];
    if (pts && pts >= alerta.minPts) {
      await dispararAlerta(alerta, alerta.parceiro, pts);
      // Não adiciona de volta — alerta consumido após envio
      console.log(`[Histórico] Alerta removido após envio: ${alerta.email} / ${alerta.parceiro} / ${alerta.programa}`);
    } else {
      alertasRestantes.push(alerta);
    }
  }
  // Salva alertas restantes (sem os que já foram disparados)
  fs.writeFileSync(ALERTAS_FILE, JSON.stringify(alertasRestantes, null, 2));

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
