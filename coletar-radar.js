// coletar-radar.js
// Executado pelo GitHub Action periodicamente.
// 1. Lê feeds RSS de categorias de promoções de milhas/pontos
// 2. Para cada postagem nova, busca o artigo completo (via proxy) e reescreve
//    com IA como conteúdo 100% original — sem citar a fonte em nenhum momento
// 3. Salva o resultado em ofertas.json (lido pela aba "Radar de Ofertas" do painel)
//
// Variáveis de ambiente necessárias:
//   ANTHROPIC_API_KEY  → chave da API Anthropic (Claude)
//
// Uso: node coletar-radar.js

const fs = require('fs');
const path = require('path');

const PROXY = 'https://cdv-proxy-production.up.railway.app/fetch';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OUT_FILE = path.join(__dirname, 'ofertas.json');

// IMPORTANTE: a fonte nunca é exibida no painel nem mencionada nos textos
// gerados pela IA — esses valores ficam só aqui, internos ao coletor.
const FEEDS = [
  { categoria: 'transferencia', url: 'https://passageirodeprimeira.com/categorias/promocoes/transferencia-de-pontos/feed/' },
  { categoria: 'compra',        url: 'https://passageirodeprimeira.com/categorias/promocoes/compra-de-pontos/feed/' },
  { categoria: 'clube',         url: 'https://passageirodeprimeira.com/categorias/promocoes/clube-de-pontos/feed/' },
  { categoria: 'cartao',        url: 'https://passageirodeprimeira.com/categorias/promocoes/bancos-e-cartoes/feed/' },
];

const MAX_ITEMS_GUARDADOS = 60;      // mantém no máximo N ofertas no JSON final
const MAX_DIAS_RETENCAO = 21;        // remove ofertas mais antigas que isso
const MAX_NOVOS_POR_EXECUCAO = 8;    // limite de chamadas de IA por execução (custo/tempo)

// ── HTTP helper via proxy ─────────────────────────────────────────────────────
async function fetchViaProxy(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${PROXY}?url=${encodeURIComponent(url)}`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`proxy retornou ${res.status} para ${url}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

// ── Parser RSS simples (sem dependências externas) ───────────────────────────
function parseRSS(xml) {
  const items = [];
  const itemBlocks = xml.match(/<item[\s\S]*?<\/item>/g) || [];
  for (const block of itemBlocks) {
    const get = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
      if (!m) return '';
      return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, '$1').trim();
    };
    const link = get('link') || (block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i) || [])[1] || '';
    const title = decodeEntities(stripTags(get('title')));
    const pubDate = get('pubDate');
    if (link && title) items.push({ link: link.trim(), title, pubDate });
  }
  return items;
}

function stripTags(html) {
  return (html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function decodeEntities(s) {
  return (s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ');
}

// ── Extrai o texto principal do artigo a partir do HTML completo ─────────────
function extractArticleText(html) {
  let body = html;

  // O tema usa <article> em vários lugares da página (cards de "Leia também",
  // posts recentes, etc.) — pegamos o MAIOR bloco <article>, que é o corpo
  // da notícia, em vez do primeiro (que pode ser um card pequeno).
  const articleBlocks = html.match(/<article[\s\S]*?<\/article>/gi) || [];
  if (articleBlocks.length) {
    body = articleBlocks.reduce((a, b) => (b.length > a.length ? b : a));
  } else {
    // Sem <article>: tenta isolar pela área de conteúdo principal do WordPress
    const mainMatch = html.match(/<main[\s\S]*?<\/main>/i);
    if (mainMatch) body = mainMatch[0];
  }

  body = body
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  let text = decodeEntities(stripTags(body));

  // Se mesmo assim veio pouco texto, cai para o body inteiro da página como
  // último recurso (mais ruído, mas evita descartar a notícia à toa).
  if (text.length < 200 && articleBlocks.length) {
    const bodyMatch = html.match(/<body[\s\S]*?<\/body>/i);
    const fallbackHtml = (bodyMatch ? bodyMatch[0] : html)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ');
    const fallbackText = decodeEntities(stripTags(fallbackHtml));
    if (fallbackText.length > text.length) text = fallbackText;
  }

  // Limita tamanho para não estourar o contexto da chamada de IA
  return text.slice(0, 14000);
}

// ── Chamada à API Anthropic para reescrever a notícia ─────────────────────────
async function reescreverComIA(titulo, textoArtigo) {
  const systemPrompt = `Você é um redator que escreve posts originais e independentes sobre promoções e oportunidades do mercado de pontos e milhas no Brasil (transferências bonificadas, compra de pontos, clubes de fidelidade, cartões de crédito).

REGRAS OBRIGATÓRIAS:
- NUNCA mencione, cite ou faça referência a qualquer site, blog, veículo de imprensa ou nome de fonte. O texto deve parecer 100% autoral, como se você tivesse apurado a informação diretamente.
- NUNCA copie frases literais do texto de origem — reescreva tudo com suas próprias palavras.
- Extraia e estruture os dados objetivos: bônus/percentual, prazo final, programa(s) envolvido(s), condições e restrições.
- Se alguma informação não estiver clara no texto de origem, use "não informado" — nunca invente dados.
- Retorne APENAS um JSON válido, sem texto antes ou depois, sem blocos de código markdown.

Formato exato de saída:
{
  "titulo": "título objetivo e direto, sem clickbait, refletindo a oportunidade (máx 80 caracteres)",
  "emoji": "um único emoji que represente a oferta",
  "resumo": "2 a 3 frases resumindo a oportunidade e por que ela é relevante",
  "programa": "nome do(s) programa(s) de fidelidade envolvido(s)",
  "bonus": "valor do bônus/ganho de forma objetiva, ex: 'até 100% de bônus' ou 'R$1 = 5 pontos'",
  "prazo": "data ou período de validade da promoção, ou 'não informado'",
  "categoria": "uma das opções: transferencia, compra, clube, cartao, geral",
  "restricoes": ["lista de condições, restrições, elegibilidade e regras importantes, cada item uma frase curta e objetiva"]
}`;

  const userPrompt = `Título original da notícia (apenas para contexto, não usar literalmente): ${titulo}\n\nConteúdo completo extraído da página:\n${textoArtigo}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${errText.slice(0, 300)}`);
  }
  const data = await res.json();
  const textBlock = (data.content || []).find((b) => b.type === 'text');
  if (!textBlock) throw new Error('Resposta da IA sem bloco de texto');

  const clean = textBlock.text.replace(/```json/g, '').replace(/```/g, '').trim();
  return JSON.parse(clean);
}

// ── Hash simples para gerar IDs estáveis a partir do link original ───────────
function idFromLink(link) {
  let hash = 0;
  for (let i = 0; i < link.length; i++) {
    hash = (hash * 31 + link.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

function categorizeFallback(categoriaFeed) {
  return ['transferencia', 'compra', 'clube', 'cartao'].includes(categoriaFeed) ? categoriaFeed : 'geral';
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  if (!ANTHROPIC_API_KEY) {
    console.error('[Radar] ANTHROPIC_API_KEY não configurada — abortando.');
    process.exit(1);
  }

  let atual = { geradoEm: null, items: [] };
  if (fs.existsSync(OUT_FILE)) {
    try { atual = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')); } catch (e) { /* arquivo corrompido, recomeça */ }
  }
  const existentes = new Map((atual.items || []).map((o) => [o.id, o]));

  // 1. Coleta todos os feeds e monta lista de candidatos
  const candidatos = [];
  for (const feed of FEEDS) {
    try {
      console.log(`[Radar] Lendo feed: categoria=${feed.categoria}`);
      const xml = await fetchViaProxy(feed.url);
      const items = parseRSS(xml);
      for (const it of items) {
        const id = idFromLink(it.link);
        if (existentes.has(id)) continue; // já processado antes
        candidatos.push({ ...it, categoriaFeed: feed.categoria, id });
      }
    } catch (e) {
      console.error(`[Radar] Falha ao ler feed ${feed.categoria}:`, e.message);
    }
  }

  console.log(`[Radar] ${candidatos.length} postagens novas encontradas (limite por execução: ${MAX_NOVOS_POR_EXECUCAO}).`);
  const aProcessar = candidatos.slice(0, MAX_NOVOS_POR_EXECUCAO);

  const novosItens = [];
  for (const c of aProcessar) {
    try {
      console.log(`[Radar] Processando: ${c.title}`);
      const html = await fetchViaProxy(c.link);
      const texto = extractArticleText(html);
      if (texto.length < 200) {
        console.log(`[Radar] Conteúdo insuficiente (extraído=${texto.length} chars, html=${html.length} chars), pulando: ${c.title}`);
        continue;
      }
      console.log(`[Radar] Texto extraído: ${texto.length} chars`);
      const ia = await reescreverComIA(c.title, texto);
      novosItens.push({
        id: c.id,
        titulo: ia.titulo || c.title,
        emoji: ia.emoji || '📰',
        resumo: ia.resumo || '',
        programa: ia.programa || '',
        bonus: ia.bonus || '',
        prazo: ia.prazo || 'não informado',
        categoria: ia.categoria || categorizeFallback(c.categoriaFeed),
        restricoes: Array.isArray(ia.restricoes) ? ia.restricoes : [],
        publicadoEm: c.pubDate ? new Date(c.pubDate).toISOString() : new Date().toISOString(),
      });
    } catch (e) {
      console.error(`[Radar] Erro ao processar "${c.title}":`, e.message);
    }
  }

  console.log(`[Radar] ${novosItens.length} ofertas reescritas com sucesso.`);

  // 2. Combina com os existentes, remove antigos, ordena por data desc, limita tamanho
  const corteMs = Date.now() - MAX_DIAS_RETENCAO * 24 * 60 * 60 * 1000;
  let todos = [...novosItens, ...(atual.items || [])]
    .filter((o) => !o.publicadoEm || new Date(o.publicadoEm).getTime() >= corteMs)
    .sort((a, b) => new Date(b.publicadoEm) - new Date(a.publicadoEm))
    .slice(0, MAX_ITEMS_GUARDADOS);

  // Dedup final por id (segurança)
  const vistos = new Set();
  todos = todos.filter((o) => (vistos.has(o.id) ? false : (vistos.add(o.id), true)));

  const saida = { geradoEm: new Date().toISOString(), items: todos };
  fs.writeFileSync(OUT_FILE, JSON.stringify(saida, null, 2));
  console.log(`[Radar] ofertas.json salvo com ${todos.length} itens.`);
}

main().catch((e) => {
  console.error('[Radar] Erro fatal:', e);
  process.exit(1);
});
