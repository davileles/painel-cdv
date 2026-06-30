// Script executado pelo GitHub Action
// 1. Coleta pontuações → historico.json
// 2. Raspa feeds RSS → reescreve com IA → ofertas.json
// 3. Verifica alertas → dispara emails

const https = require('https');
const http = require('http');
const fs = require('fs');

const PROXY = 'https://cdv-proxy-production.up.railway.app/fetch';
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = 'alertas@clubedoviajante.com.br';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const PROGRAMS = [
  { id:'livelo',  name:'Livelo',     url:'https://www.comparemania.com.br/lojas/pontos-milhas/programa-fidelidade-livelo' },
  { id:'esfera',  name:'Esfera',     url:'https://www.comparemania.com.br/lojas/pontos-milhas/programa-fidelidade-santander-esfera' },
  { id:'smiles',  name:'Smiles',     url:'https://www.comparemania.com.br/lojas/pontos-milhas/programa-fidelidade-smiles' },
  { id:'azul',    name:'Azul',       url:'https://www.comparemania.com.br/lojas/pontos-milhas/programa-fidelidade-azul' },
  { id:'latam',   name:'LATAM Pass', url:'https://www.comparemania.com.br/lojas/pontos-milhas/programa-fidelidade-latam-pass' },
];

const EQUIV = { livelo:1, esfera:1, smiles:1/1.8, azul:1/1.9, latam:1/1.25 };

// Categorias de ofertas a monitorar (fonte fica só aqui, nunca exposta no painel)
const FEEDS = [
  { id:'transferencia', label:'Transferência com bônus', emoji:'🔄',
    url:'https://passageirodeprimeira.com/categorias/promocoes/transferencia-de-pontos/feed/' },
  { id:'compra',        label:'Compra de pontos',        emoji:'🛒',
    url:'https://passageirodeprimeira.com/categorias/promocoes/compra-de-pontos/feed/' },
  { id:'clube',         label:'Assinatura de clube',     emoji:'🎫',
    url:'https://passageirodeprimeira.com/categorias/promocoes/clube-de-pontos/feed/' },
  { id:'cartoes',       label:'Cartões e anuidade',      emoji:'💳',
    url:'https://passageirodeprimeira.com/categorias/promocoes/bancos-e-cartoes/feed/' },
];

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function httpGet(url, timeout=15000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location, timeout).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          const err = new Error(`HTTP ${res.statusCode}: ${data.slice(0,200)}`);
          err.statusCode = res.statusCode;
          err.body = data;
          return reject(err);
        }
        resolve(data);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function httpPost(hostname, path, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({ hostname, path, method:'POST',
      headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload),...headers}
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status:res.statusCode, body:data }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── Parser Comparemania ───────────────────────────────────────────────────────
function extractPts(g) {
  const ate    = g.match(/até\s+(\d+)/i);
  const eq     = g.match(/=\s+(\d+)/i);
  const azul   = g.match(/(\d+[,.]?\d*)\s*pt\//i);
  const latam  = g.match(/=\s*(\d+)\s*ponto/i);
  const smiles = g.match(/ganha\s+(?:até\s+)?(\d+)\s+smiles/i);
  const raw    = ate||eq||latam||smiles||azul;
  if (!raw) return null;
  const pts = parseFloat((raw[1]||'').replace(',','.'));
  return { pts:Math.round(pts)||pts, ate:!!(ate||smiles) };
}

function parseHTMLComparemania(html, progId) {
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
    const name = nameLink[2].replace(textRe,'').trim();
    const g = gainLink[2].replace(textRe,'').trim()+' '+cells[1].replace(textRe,'');
    const parsed = extractPts(g);
    if (!parsed||!name) continue;
    const rawHref = nameLink[1];
    const url = rawHref.startsWith('http')?rawHref:'https://www.comparemania.com.br'+rawHref;
    out.push({ name, pts:parsed.pts, ate:parsed.ate, url, prog:progId });
  }
  return out;
}

async function fetchProg(prog) {
  console.log(`Consultando ${prog.id}...`);
  const url = `${PROXY}?url=${encodeURIComponent(prog.url)}`;
  const html = await httpGet(url);
  if (!html.includes('ponto(s)')&&!html.includes('Smiles')&&!html.includes('pt/R$'))
    throw new Error(`${prog.id}: resposta inesperada`);
  const items = parseHTMLComparemania(html, prog.id);
  console.log(`  → ${items.length} parceiros`);
  return items;
}

// ── Parser RSS ─────────────────────────────────────────────────────────────────
function decodeEntities(s){
  return s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
          .replace(/&quot;/g,'"').replace(/&#039;/g,"'").replace(/&nbsp;/g,' ');
}

function parseRSS(xml, catId, catLabel, catEmoji) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const title = decodeEntities((block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) ||
                     block.match(/<title>([\s\S]*?)<\/title>/))?.[1]?.trim() || '');
    const link    = block.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim() || '';
    const pubDate = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim() || '';
    // Tenta content:encoded primeiro (texto completo), senão description
    const contentFull = (block.match(/<content:encoded><!\[CDATA\[([\s\S]*?)\]\]><\/content:encoded>/))?.[1] || '';
    const descRaw = (block.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/) ||
                     block.match(/<description>([\s\S]*?)<\/description>/))?.[1] || '';
    const rawHtml = contentFull || descRaw;
    const plainText = decodeEntities(rawHtml.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim());
    if (!title || !link) continue;
    const date = pubDate ? new Date(pubDate).toISOString() : new Date().toISOString();
    const slug = link.replace(/^https?:\/\/[^/]+\//, '').replace(/\/$/, '');
    items.push({ id:slug, cat:catId, catLabel, catEmoji, title, link, date, rawText:plainText.slice(0,8000) });
  }
  return items;
}

async function fetchFeed(feed) {
  console.log(`Buscando feed ${feed.id}...`);
  try {
    const xml = await httpGet(feed.url);
    const items = parseRSS(xml, feed.id, feed.label, feed.emoji);
    console.log(`  → ${items.length} artigos`);
    return items;
  } catch(e) {
    console.error(`  Erro no feed ${feed.id}:`, e.message);
    return [];
  }
}

// ── Busca o conteúdo completo da página do artigo (não só o resumo do feed) ──
async function fetchArticleFullText(link) {
  try {
    const html = await httpGet(`${PROXY}?url=${encodeURIComponent(link)}`);

    // Estratégia 1: tenta containers conhecidos de conteúdo (várias variações de tema)
    let bodyHtml =
      (html.match(/<article[^>]*>([\s\S]*?)<\/article>/i))?.[1] ||
      (html.match(/<div[^>]+class="[^"]*(?:entry-content|post-content|article-content|single-content|post-body)[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<\/div>\s*){0,4}(?:<footer|<aside|$)/i))?.[1] ||
      '';

    // Estratégia 2 (fallback robusto): pega tudo entre o <h1> do título e marcadores
    // conhecidos de fim de post (compartilhamento, autor, "Leia também", footer)
    if (!bodyHtml || bodyHtml.length < 300) {
      const h1Match = html.match(/<h1[^>]*>[\s\S]*?<\/h1>/i);
      if (h1Match) {
        const afterH1 = html.slice(h1Match.index + h1Match[0].length);
        const endMarkers = [
          /Entre agora para o nosso/i,
          /Leia também/i,
          /URL para compartilhar/i,
          /Compartilhar no WhatsApp/i,
          /<footer/i,
          /class="[^"]*author[^"]*"/i,
        ];
        let cutIdx = afterH1.length;
        for (const marker of endMarkers) {
          const m = afterH1.match(marker);
          if (m && m.index < cutIdx) cutIdx = m.index;
        }
        bodyHtml = afterH1.slice(0, cutIdx);
      }
    }

    if (!bodyHtml || bodyHtml.length < 200) return null;

    // Remove blocos claramente irrelevantes antes de extrair texto
    bodyHtml = bodyHtml
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
      .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
      .replace(/<form[\s\S]*?<\/form>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ');

    // Preserva quebras de linha de headings/parágrafos/listas antes de remover tags,
    // para a IA conseguir distinguir seções (Desconto, Limite, Parcelamento etc.)
    bodyHtml = bodyHtml
      .replace(/<\/(h[1-6]|p|li|div)>/gi, '\n')
      .replace(/<li[^>]*>/gi, '\n- ');

    const plain = decodeEntities(bodyHtml.replace(/<[^>]+>/g, ' '))
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s*\n+/g, '\n')
      .trim();

    // Corta qualquer rodapé padrão do site que ainda tenha sobrado
    const cortado = plain.split(/\bO post\b.{0,10}apareceu primeiro em/i)[0].trim();

    return cortado.length > 200 ? cortado.slice(0, 14000) : null;
  } catch(e) {
    console.log(`  [fetchArticleFullText] falhou para ${link}: ${e.message}`);
    return null;
  }
}

// ── Reescreve a oferta via IA (Claude Haiku) — conteúdo 100% original ─────────
async function reescreverOferta(item) {
  if (!ANTHROPIC_API_KEY) {
    // Fallback sem IA: usa título e primeiras frases do texto bruto
    return {
      titulo: item.title,
      resumo: item.rawText.slice(0,600),
      bonus: '',
      prazo: '',
      programa: ''
    };
  }

  const prompt = `Você vai reescrever uma notícia sobre promoção de pontos/milhas em formato de post próprio, SEM citar nomes de sites, portais, blogs ou veículos de imprensa. Não use frases como "segundo o site", "de acordo com o portal", "confira no link" etc. Não inclua links nem menções a "matéria", "artigo" ou "publicação".

Sua tarefa é extrair e reescrever TODAS as informações relevantes do texto original, de forma completa, para que o leitor tenha ciência total das regras sem precisar consultar outra fonte. Não resuma demais — inclua todos os detalhes práticos disponíveis no texto: percentuais de bônus (inclusive escalonados por faixa, se houver), prazos de início e término, valor mínimo/máximo de transferência ou compra, cupons e códigos promocionais, limites por CPF ou por período, prazo de crédito dos pontos/validade dos pontos bônus, condições de elegibilidade (ex: assinantes de clube, cartão específico), e qualquer restrição ou observação importante mencionada no texto.

Notícia original (título + texto):
TÍTULO: ${item.title}
TEXTO: ${item.rawText}

Responda SOMENTE em JSON válido, sem markdown, neste formato exato:
{"titulo":"título reescrito, direto, sem citar fontes","resumo":"texto completo reescrito em parágrafos corridos (ou bullets com '-') cobrindo TODAS as regras, condições, prazos, cupons e limitações encontradas no texto original — não limite o tamanho artificialmente, inclua tudo que for relevante","bonus":"percentual de bônus se houver, ex: '80%' ou vazio","prazo":"prazo da oferta se houver, ex: 'até 30/06' ou vazio","programa":"nome do programa de fidelidade principal envolvido, ex: 'Livelo', 'Azul Fidelidade', ou vazio"}`;

  try {
    const payload = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2500,
      messages: [{ role:'user', content:prompt }]
    });

    const result = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname:'api.anthropic.com', path:'/v1/messages', method:'POST',
        headers:{
          'Content-Type':'application/json',
          'x-api-key':ANTHROPIC_API_KEY,
          'anthropic-version':'2023-06-01',
          'Content-Length':Buffer.byteLength(payload)
        }
      }, res => {
        let data='';
        res.on('data', c=>data+=c);
        res.on('end', ()=>resolve(data));
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });

    const parsed = JSON.parse(result);
    const text = parsed.content?.[0]?.text || '';
    const clean = text.replace(/```json\s*/gi,'').replace(/```\s*/gi,'').trim();
    const json = JSON.parse(clean);
    return json;
  } catch(e) {
    console.error('  [IA] erro ao reescrever, usando fallback:', e.message);
    return {
      titulo: item.title,
      resumo: item.rawText.slice(0,600),
      bonus: '', prazo: '', programa: ''
    };
  }
}

// ── Email via Resend ──────────────────────────────────────────────────────────
async function enviarEmail(para, assunto, html) {
  if (!RESEND_API_KEY) { console.log('[email] sem RESEND_API_KEY, pulando'); return; }
  const res = await httpPost('api.resend.com', '/emails',
    { from:RESEND_FROM, to:[para], subject:assunto, html },
    { Authorization:`Bearer ${RESEND_API_KEY}` }
  );
  console.log(`[email] ${para} → status ${res.status}`);
}

// ── Resolve link direto do programa ──────────────────────────────────────────
const PROG_HEADING_MAP = { livelo:'livelo', esfera:'esfera', smiles:'smiles', azul:'tudo azul', latam:'latam pass' };

async function resolveDirectUrl(partnerCashbackUrl, progId) {
  try {
    const html = await httpGet(`${PROXY}?url=${encodeURIComponent(partnerCashbackUrl)}`);
    const heading = PROG_HEADING_MAP[progId]||progId;
    const idx = html.toLowerCase().indexOf(`>${heading}<`);
    if (idx < 0) return null;
    const chunk = html.slice(idx, idx+2000);
    const rm = chunk.match(/redirecionar\/oferta\/[\d]+\/[\d]+\/[a-z0-9-]+/i);
    if (!rm) return null;
    const redirectUrl = 'https://www.comparemania.com.br/'+rm[0];
    const rhtml = await httpGet(`${PROXY}?url=${encodeURIComponent(redirectUrl)}`);
    const lm = rhtml.match(/href="(https?:\/\/(?:(?!comparemania)[^"]+)(?:esfera\.com|livelo\.com|smiles\.com|viajemais\.voeazul|latamairlines)[^"]*)"/i);
    if (lm) return lm[1];
    const jm = rhtml.match(/https?:\\u002F\\u002F[^"<\s]*/i);
    if (jm) return decodeURIComponent(jm[0].replace(/\\u002F/g,'/').replace(/\\u0026/g,'&'));
    return null;
  } catch(e) { return null; }
}

function buildEmailHtml(alerta, parceiro, pts, progName, url) {
  return `<!DOCTYPE html><html><body style="font-family:sans-serif;background:#1e2535;color:#eee;padding:32px">
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
      <a href="${url}" style="display:block;text-align:center;background:#ff585e;color:#fff;padding:14px;border-radius:10px;text-decoration:none;font-weight:800;font-size:14px">↗ Aproveitar oferta agora</a>
    </div>
    <div style="padding:16px 24px;border-top:1px solid #3d4a66;font-size:11px;color:#5a6a8a;text-align:center">
      Clube do Viajante · Para cancelar este alerta, acesse o painel.
    </div>
  </div></body></html>`;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const hoje = new Date().toISOString().split('T')[0];
  const isFirstRunOfDay = () => {
    const h = new Date().getUTCHours();
    return h >= 11 && h < 13; // ~8h SP
  };

  let historico = {};
  if (fs.existsSync('historico.json')) {
    try { historico = JSON.parse(fs.readFileSync('historico.json','utf8')); } catch(e) {}
  }

  let alertas = [];
  if (fs.existsSync('alertas.json')) {
    try { alertas = JSON.parse(fs.readFileSync('alertas.json','utf8')); } catch(e) {}
  }

  let ofertas = { atualizadoEm:'', items:[] };
  if (fs.existsSync('ofertas.json')) {
    try { ofertas = JSON.parse(fs.readFileSync('ofertas.json','utf8')); } catch(e) {}
  }

  // ── Radar de Ofertas: busca feeds, reescreve novos artigos via IA ──────────
  console.log('\n=== RADAR DE OFERTAS ===');
  const slugsExistentes = new Set(ofertas.items.map(i => i.id));
  const limiteOfertasPre = new Date();
  limiteOfertasPre.setDate(limiteOfertasPre.getDate() - 7);
  const candidatosNovos = [];
  let descartadosPorData = 0;

  for (const feed of FEEDS) {
    const items = await fetchFeed(feed);
    for (const item of items) {
      if (slugsExistentes.has(item.id)) continue;
      // Descarta já aqui itens fora da janela de 7 dias — evita gastar fetch/IA com eles
      if (new Date(item.date) <= limiteOfertasPre) {
        descartadosPorData++;
        continue;
      }
      candidatosNovos.push(item);
      slugsExistentes.add(item.id);
    }
  }
  if (descartadosPorData > 0) {
    console.log(`${descartadosPorData} artigo(s) do feed já fora da janela de 7 dias — ignorados antes do processamento`);
  }

  // Descarta qualquer item no formato antigo (sem campo "titulo") — migração de versão
  const itemsValidos = ofertas.items.filter(i => i && typeof i.titulo === 'string' && i.titulo.length > 0);
  if (itemsValidos.length !== ofertas.items.length) {
    console.log(`Descartando ${ofertas.items.length - itemsValidos.length} item(ns) em formato antigo`);
  }

  console.log(`${candidatosNovos.length} artigo(s) novo(s) — buscando conteúdo completo e reescrevendo com IA...`);
  const novosProcessados = [];
  for (const item of candidatosNovos) {
    console.log(`  Acessando página: ${item.link}`);
    const fullText = await fetchArticleFullText(item.link);
    if (fullText) {
      console.log(`    → conteúdo completo extraído (${fullText.length} chars)`);
      item.rawText = fullText;
    } else {
      console.log(`    → falhou, usando resumo do feed (${item.rawText.length} chars)`);
    }

    const reescrito = await reescreverOferta(item);
    novosProcessados.push({
      id: item.id,
      cat: item.cat,
      catLabel: item.catLabel,
      catEmoji: item.catEmoji,
      date: item.date,
      titulo: reescrito.titulo || item.title,
      resumo: reescrito.resumo || '',
      bonus: reescrito.bonus || '',
      prazo: reescrito.prazo || '',
      programa: reescrito.programa || '',
    });
    // throttle leve para não sobrecarregar a API
    await new Promise(r => setTimeout(r, 300));
  }

  // Janela de exibição: mantém os últimos 7 dias de ofertas
  const limiteOfertas = new Date();
  limiteOfertas.setDate(limiteOfertas.getDate() - 7);

  const combinados = [...novosProcessados, ...itemsValidos];
  const itemsFinais = combinados.filter(i => new Date(i.date) > limiteOfertas);

  console.log(`Itens combinados (novos + válidos antigos): ${combinados.length}`);
  console.log(`Itens dentro da janela de 7 dias: ${itemsFinais.length}`);
  if (combinados.length > 0 && itemsFinais.length === 0) {
    const datas = combinados.map(i => i.date).sort();
    console.log(`AVISO: todos os itens foram filtrados pela janela de data. Mais recente: ${datas[datas.length-1]}, limite: ${limiteOfertas.toISOString()}`);
  }

  ofertas.items = itemsFinais.sort((a,b) => new Date(b.date) - new Date(a.date));
  ofertas.atualizadoEm = new Date().toISOString();

  fs.writeFileSync('ofertas.json', JSON.stringify(ofertas, null, 2));
  console.log(`Ofertas salvas: ${ofertas.items.length} total (últimos 7 dias), ${novosProcessados.length} novas`);

  // ── Histórico de pontuações (apenas 1ª execução do dia) ────────────────────
  if (isFirstRunOfDay()) {
    console.log('\n=== HISTÓRICO DE PONTUAÇÕES ===');
    const allData = {};
    for (const prog of PROGRAMS) {
      try { allData[prog.id] = await fetchProg(prog); }
      catch(e) { console.error(`Erro em ${prog.id}:`, e.message); allData[prog.id] = []; }
    }

    const map = {};
    for (const [progId, items] of Object.entries(allData)) {
      for (const p of items) {
        const key = p.name.toLowerCase().trim();
        if (!map[key]) map[key] = { name:p.name, programs:{}, urls:{} };
        map[key].programs[progId] = p.pts;
        map[key].urls[progId] = p.url;
      }
    }

    const snapshot = {};
    for (const [key, p] of Object.entries(map)) {
      let bestEquiv=0, bestPts=0;
      for (const [pid,pts] of Object.entries(p.programs)) {
        const eq = pts*(EQUIV[pid]||1);
        if (eq>bestEquiv){bestEquiv=eq;bestPts=pts;}
      }
      snapshot[key] = { name:p.name, pts:bestPts, programs:p.programs, urls:p.urls };
    }

    historico[hoje] = snapshot;
    const limiteHist = new Date();
    limiteHist.setDate(limiteHist.getDate()-180);
    const limiteHistStr = limiteHist.toISOString().split('T')[0];
    for (const d of Object.keys(historico)) {
      if (d < limiteHistStr) delete historico[d];
    }
    fs.writeFileSync('historico.json', JSON.stringify(historico, null, 2));
    console.log(`Histórico salvo: ${Object.keys(historico).length} dias`);

    console.log('\n=== ALERTAS ===');
    for (const alerta of alertas) {
      if (!alerta.email||!alerta.parceiro||!alerta.minPts||!alerta.programa) continue;
      const key = alerta.parceiro.toLowerCase().trim();
      const snap = snapshot[key];
      if (!snap) continue;
      const pts = snap.programs[alerta.programa];
      if (!pts||pts<alerta.minPts) continue;
      const prog = PROGRAMS.find(p=>p.id===alerta.programa);
      const cashbackUrl = snap.urls[alerta.programa]||'';
      console.log(`🔔 ${alerta.email} → ${alerta.parceiro} ${pts} pts via ${prog.name}`);
      let directUrl = cashbackUrl;
      if (cashbackUrl) {
        const resolved = await resolveDirectUrl(cashbackUrl, alerta.programa);
        if (resolved) directUrl = resolved;
      }
      await enviarEmail(
        alerta.email,
        `🔔 ${snap.name} atingiu ${pts} pts/R$ no ${prog.name}`,
        buildEmailHtml(alerta, snap.name, pts, prog.name, directUrl)
      );
    }
  } else {
    console.log('\n[Histórico e alertas: apenas na primeira execução do dia]');
  }

  console.log('\n✅ Concluído');
}

main().catch(e => { console.error(e); process.exit(1); });
