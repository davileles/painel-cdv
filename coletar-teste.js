// coletar-teste.js
// Versão paralela de teste: coleta Livelo e Esfera diretamente nas fontes oficiais
// (livelo.com.br e esfera.com.vc) em vez do Comparemania.
// Salva em historico-teste.json para comparação — não altera historico.json.
//
// Uso: node coletar-teste.js

const fs   = require('fs');
const path = require('path');

const SAIDA_FILE = path.join(__dirname, 'historico-teste.json');

// ── HTTP helper ───────────────────────────────────────────────────────────────
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

// ── Decode de entidades HTML ──────────────────────────────────────────────────
function decodeEntities(s) {
  return (s || '')
    .replace(/&#x([0-9a-fA-F]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&amp;/g, '&').replace(/&apos;/g, "'").replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/&shy;/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

// ── PARSER LIVELO ─────────────────────────────────────────────────────────────
// Fonte: https://www.livelo.com.br/juntar-pontos/todos-os-parceiros
// A página é SSR (Next.js) — os dados de slug e pontuação ficam nos links <a href>
// e no texto adjacente. Não depende de JS para renderizar a tabela.
function parseLivelo(html) {
  const result = {};

  // Remove scripts e styles
  const clean = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');

  // Links de parceiros têm formato: /juntar-pontos/parceiros/{slug}/{CODIGO}
  // O texto de pontuação fica dentro do mesmo <a>: "Até X pontos por R$ 1" ou "X pontos por R$ 1"
  const linkPattern = /<a[^>]+href="\/juntar-pontos\/parceiros\/([^/"]+)\/[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkPattern.exec(clean)) !== null) {
    const slug = m[1].toLowerCase().trim();
    const inner = m[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

    // Extrai pontos: "Até X pontos por R$ 1" ou "X pontos por R$ 1"
    const pts = inner.match(/(\d+)\s*ponto/i)?.[1];
    if (!pts || !slug) continue;

    const tipo = /até/i.test(inner) ? 'até' : '=';

    if (!result[slug] || parseInt(pts) > result[slug].pts) {
      result[slug] = { pts: parseInt(pts), tipo, dollar: false };
    }
  }

  return result;
}

// ── PARSER ESFERA ─────────────────────────────────────────────────────────────
// Fonte: https://www.esfera.com.vc/junte-pontos/junte-pontos/esf02163
// SSR puro — dados no HTML como texto: "Nome\nGanhe X pts a cada real"
function parseEsfera(html) {
  const result = {};

  // Decodifica entidades no HTML inteiro primeiro
  const decoded = decodeEntities(html);

  // Remove scripts e styles para evitar falsos positivos
  const clean = decoded
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');

  // Extrai blocos <a href="/p/{slug}/..."> com nome e pontuação dentro
  // Estrutura: <a href="/p/nome-loja/e000..."><img alt="Nome">...<span>Ganhe X pts a cada real</span></a>
  const linkPattern = /<a[^>]+href="\/p\/([^/"]+)\/[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkPattern.exec(clean)) !== null) {
    const slug = m[1].toLowerCase().trim();
    const inner = m[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

    // Extrai nome via alt da imagem dentro do link
    const nomeMatch = m[2].match(/alt="([^"]+)"/i);
    const nome = nomeMatch ? decodeEntities(nomeMatch[1]).trim() : slug;

    // Extrai pontos: "Ganhe X pts a cada real" ou "Ganhe X pt a cada real"
    const pts = inner.match(/ganhe\s+(\d+)\s*pt/i)?.[1];
    if (!pts || !slug) continue;

    if (!result[slug] || parseInt(pts) > result[slug].pts) {
      result[slug] = { nome, pts: parseInt(pts), dollar: false };
    }
  }

  // Fallback: se o parser de links não pegou nada, tenta pelo texto corrido
  // Padrão no innerText: "Nome\n\nGanhe X pts a cada real"
  if (Object.keys(result).length === 0) {
    console.log('[Esfera] Fallback para parser de texto corrido...');
    const textPattern = /([^\n<>]{2,60})\n+Ganhe\s+(\d+)\s*pt[s]?\s+a\s+cada\s+real/gi;
    while ((m = textPattern.exec(clean)) !== null) {
      const nome = m[1].trim();
      const pts = parseInt(m[2]);
      if (!nome || nome.includes('Ganhe')) continue;
      const slug = nome.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      if (!result[slug] || pts > result[slug].pts) {
        result[slug] = { nome, pts, dollar: false };
      }
    }
  }

  return result;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const hoje = new Date().toISOString().split('T')[0];
  console.log(`[Teste] Iniciando coleta de teste para ${hoje}`);

  const snapshot = {};

  // ── 1. Livelo ──────────────────────────────────────────────────────────────
  console.log('[Teste] Coletando Livelo (livelo.com.br)...');
  try {
    const html = await fetchDirect('https://www.livelo.com.br/juntar-pontos/todos-os-parceiros');
    const parceiros = parseLivelo(html);
    const count = Object.keys(parceiros).length;
    console.log(`[Teste] Livelo: ${count} parceiros encontrados`);

    for (const [slug, dados] of Object.entries(parceiros)) {
      if (!snapshot[slug]) snapshot[slug] = { programs: {} };
      snapshot[slug].programs.livelo = { pts: dados.pts, dollar: dados.dollar };
    }

    // Amostra dos primeiros 10
    const amostra = Object.entries(parceiros).slice(0, 10);
    console.log('[Teste] Amostra Livelo:', amostra.map(([k,v]) => `${k}:${v.pts}`).join(', '));
  } catch (e) {
    console.error('[Teste] Erro Livelo:', e.message);
  }

  // ── 2. Esfera ──────────────────────────────────────────────────────────────
  console.log('[Teste] Coletando Esfera (esfera.com.vc)...');
  try {
    const html = await fetchDirect('https://www.esfera.com.vc/junte-pontos/junte-pontos/esf02163');
    const parceiros = parseEsfera(html);
    const count = Object.keys(parceiros).length;
    console.log(`[Teste] Esfera: ${count} parceiros encontrados`);

    for (const [slug, dados] of Object.entries(parceiros)) {
      // Usa o nome real da Esfera como chave (C&A em vez de cea)
      const chave = dados.nome ? dados.nome.toLowerCase().trim() : slug;
      if (!snapshot[chave]) snapshot[chave] = { programs: {} };
      snapshot[chave].programs.esfera = { pts: dados.pts, dollar: dados.dollar };
    }

    // Amostra dos primeiros 10
    const amostra = Object.entries(parceiros).slice(0, 10);
    console.log('[Teste] Amostra Esfera:', amostra.map(([k,v]) => `${v.nome||k}:${v.pts}`).join(', '));
  } catch (e) {
    console.error('[Teste] Erro Esfera:', e.message);
  }

  // ── Resumo ─────────────────────────────────────────────────────────────────
  const totalParceiros = Object.keys(snapshot).length;
  const comLivelo  = Object.values(snapshot).filter(v => v.programs.livelo).length;
  const comEsfera  = Object.values(snapshot).filter(v => v.programs.esfera).length;
  const comAmbos   = Object.values(snapshot).filter(v => v.programs.livelo && v.programs.esfera).length;

  console.log(`\n[Teste] ── Resumo ──────────────────────────────`);
  console.log(`[Teste] Total parceiros únicos: ${totalParceiros}`);
  console.log(`[Teste] Com Livelo:  ${comLivelo}`);
  console.log(`[Teste] Com Esfera:  ${comEsfera}`);
  console.log(`[Teste] Com ambos:   ${comAmbos}`);

  // ── Salva resultado ────────────────────────────────────────────────────────
  const saida = { geradoEm: new Date().toISOString(), [hoje]: snapshot };
  fs.writeFileSync(SAIDA_FILE, JSON.stringify(saida, null, 2));
  console.log(`\n[Teste] Salvo em historico-teste.json (${totalParceiros} parceiros)`);
}

main().catch(e => {
  console.error('[Teste] Erro fatal:', e);
  process.exit(1);
});
