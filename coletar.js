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
  { categoria: 'transferencia',     url: 'https://passageirodeprimeira.com/categorias/promocoes/transferencia-de-pontos/feed/' },
  { categoria: 'compra',            url: 'https://passageirodeprimeira.com/categorias/promocoes/compra-de-pontos/feed/' },
  { categoria: 'compra_bonificada', url: 'https://passageirodeprimeira.com/categorias/promocoes/compre-e-pontue/feed/' },
  { categoria: 'clube',             url: 'https://passageirodeprimeira.com/categorias/promocoes/clube-de-pontos/feed/' },
  { categoria: 'cartao',            url: 'https://passageirodeprimeira.com/categorias/promocoes/bancos-e-cartoes/feed/' },
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
  let prev = s || '';
  let out = prev;
  for (let i = 0; i < 4; i++) {
    out = out
      .replace(/&amp;/g, '&').replace(/&#0?38;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ');
    if (out === prev) break;
    prev = out;
  }
  return out;
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
  return text.slice(0, 24000);
}

// ── Chamada à API Anthropic para reescrever a notícia ─────────────────────────
// ── Extrai candidatos a "link da oferta" a partir dos <a href> do HTML bruto ──
// Procura âncoras com texto típico de CTA (clique aqui, acesse, confira, etc.)
// e também qualquer link que aponte para fora do próprio site da matéria.
const CTA_TEXT_RE = /clique aqui|acesse|confira|participar|saiba mais|ver oferta|garanta|aproveite|inscreva-se|assine|compre|transferir|cadastr/i;

function stripUtm(url) {
  try {
    // Alguns links do site de origem vêm com artefato "amp;" sem o "&" na frente
    // (bug de geração de URL no WordPress: "?amp;utm_medium=..." em vez de "?utm_medium=...").
    // Normaliza esses separadores antes de interpretar a query string.
    const cleaned = (url || '').replace(/\?amp;/gi, '?').replace(/&amp;/gi, '&');
    const u = new URL(cleaned);
    [...u.searchParams.keys()].forEach((k) => {
      if (/^utm_/i.test(k)) u.searchParams.delete(k);
    });
    return u.toString();
  } catch (e) {
    return url;
  }
}

function extractLinkCandidates(html) {
  const anchors = html.match(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi) || [];
  const candidatos = [];
  const vistos = new Set();
  for (const a of anchors) {
    const m = a.match(/href="([^"]+)"/i);
    if (!m) continue;
    let href = decodeEntities(m[1]); // o HTML traz "&amp;" no lugar de "&" dentro do href
    if (!/^https?:\/\//i.test(href)) continue;
    if (href.includes('passageirodeprimeira.com')) continue; // nunca o próprio site
    if (/facebook\.com|instagram\.com|whatsapp\.com|t\.me|twitter\.com|x\.com|tiktok\.com|youtube\.com|threads\.com|wp-content|cdn-cgi|cookiedatabase/i.test(href)) continue;
    href = stripUtm(href);
    if (vistos.has(href)) continue;
    vistos.add(href);
    const texto = stripTags(a).trim();
    candidatos.push({ href, texto, ctaProvavel: CTA_TEXT_RE.test(texto) });
  }
  // CTAs prováveis primeiro, depois os demais — máximo 12 para não pesar o prompt
  candidatos.sort((a, b) => (b.ctaProvavel ? 1 : 0) - (a.ctaProvavel ? 1 : 0));
  return candidatos.slice(0, 12);
}

// ── Tabela de fallback: link oficial por programa quando a IA não acha um link confiável ──
const FALLBACK_LINKS = [
  [/clube\s*livelo/i, 'https://www.livelo.com.br/clube'],
  [/livelo.*compra|compra.*livelo/i, 'https://www.livelo.com.br/compre-pontos'],
  [/livelo/i, 'https://www.livelo.com.br'],
  [/clube\s*smiles/i, 'https://www.smiles.com.br/clube-smiles/beneficios-clube'],
  [/smiles/i, 'https://www.smiles.com.br/home'],
  [/clube\s*latam/i, 'https://latampass.latam.com/pt_br/clube'],
  [/latam/i, 'https://www.latamairlines.com/br/pt'],
  [/clube\s*azul|azul\s*fidelidade.*clube/i, 'https://www.voeazul.com.br/br/pt/voeazul/clube-azul'],
  [/azul\s*pelo\s*mundo/i, 'https://azulpelomundo.voeazul.com.br'],
  [/azul/i, 'https://www.voeazul.com.br/br/pt/home'],
  [/clube\s*esfera/i, 'https://www.esfera.com.vc/clube'],
  [/esfera/i, 'https://www.esfera.com.vc'],
  [/hoteis\.com|hotéis\.com/i, 'https://www.hoteis.com'],
  [/magalu|magazine\s*luiza/i, 'https://www.magazineluiza.com.br'],
  [/iberia/i, 'https://www.iberia.com'],
  [/suma|air\s*europa/i, 'https://www.aireuropa.com/en/flights/home'],
  [/aadvantage|american\s*airlines/i, 'https://www.aa.com.br'],
  [/\btap\b/i, 'https://www.flytap.com'],
];

function resolverLinkFallback(programa, loja) {
  const alvo = `${programa || ''} ${loja || ''}`;
  for (const [re, url] of FALLBACK_LINKS) {
    if (re.test(alvo)) return url;
  }
  return '';
}

function linkValido(link) {
  return !!link && /^https?:\/\//i.test(link) && !link.includes('passageirodeprimeira.com');
}

const TEXTO_IMPORTANTE_COMPRA_BONIFICADA =
  'Sempre verifique a necessidade de uso de cupom, formas de pagamento e produtos específicos participantes, além do prazo para receber os pontos. ' +
  'Recomendamos fortemente que todo processo seja gravado para possível reclamação futura. Sem a gravação você não obterá os pontos se eles não forem creditados corretamente.';

async function reescreverComIA(titulo, textoArtigo, categoriaFeed, linkCandidatos) {
  const systemPrompt = `Você é um redator que escreve posts originais e independentes sobre promoções e oportunidades do mercado de pontos e milhas no Brasil (transferências bonificadas, compra de pontos, compras bonificadas em parceiros, clubes de fidelidade, cartões de crédito).

REGRAS GERAIS OBRIGATÓRIAS:
- NUNCA mencione, cite ou faça referência a qualquer site, blog, veículo de imprensa ou nome de fonte. O texto deve parecer 100% autoral, como se você tivesse apurado a informação diretamente.
- NUNCA copie frases literais do texto de origem — reescreva tudo com suas próprias palavras.
- Se alguma informação não estiver clara no texto de origem, use "não informado" (ou string vazia "" para campos que pedem isso) — nunca invente dados.
- Retorne APENAS um JSON válido, sem texto antes ou depois, sem blocos de código markdown.
- categoria deve ser uma destas: transferencia, compra, compra_bonificada, clube, cartao, geral.
  • "compra_bonificada" = oferta em que a pessoa GANHA pontos/milhas por real ou dólar gasto em um parceiro/loja (ex: "5 pontos por real gasto na Loja X").
  • "compra" = compra direta de pontos/milhas com dinheiro (ex: desconto na compra de milhas).
  • "transferencia" = transferência de pontos entre programas com bônus.

REGRAS POR CATEGORIA:

[compra_bonificada]
- "titulo" DEVE seguir exatamente este template: "[X] pontos por [real/dólar] entre [Parceiro] e [Programa]". Use "Até [X] pontos..." SOMENTE se houver variação de pontuação por perfil/categoria/produto.
- "resumo" e "restricoes": extraia fielmente o que está no texto de origem. Em "restricoes", liste cada quebra de pontuação por perfil, categoria de produto, condição, cupom necessário e prazo específico de cada condição — cada item começando com hífen, um item por condição.
- "loja": nome do parceiro/e-commerce onde a compra é feita.
- "cupom": código do cupom principal necessário, se houver; senão "".
- "importante": deixe como "" (este texto é adicionado automaticamente pelo sistema, não o escreva).
- "milheiro": deixe como "" (não se aplica a esta categoria).

[compra] e [transferencia]
- "resumo" e "restricoes": extraia fielmente, com quebras de pontuação por perfil/categoria/condição/cupom/prazo específico, cada item em "restricoes" como hífen.
- SEMPRE calcule o custo do milheiro (custo de 1.000 pontos recebidos) quando houver valor pago e quantidade de pontos recebidos no texto.
  Fórmula: CUSTO_MILHEIRO = (VALOR_TOTAL_PAGO / PONTOS_RECEBIDOS) * 1000, arredondado para 2 casas decimais.
  Exemplo: pagar R$ 885,60 por 32.000 pontos = R$ 27,65 por 1.000 pontos.
  Preencha o campo "milheiro" EXATAMENTE no formato: "💰 Custo do milheiro: R$ XX,XX por 1.000 pontos".
  Se houver mais de um cenário (perfil/quantidade diferentes), calcule para cada um e liste todos no campo "milheiro" separados por quebra de linha (\\n), cada um no mesmo formato.
  Se não for possível calcular (faltam valor pago ou pontos recebidos), deixe "milheiro" como "".
- "loja" e "cupom": deixe como "" (não se aplicam, exceto se houver cupom de desconto na compra — nesse caso preencha "cupom").
- "importante": deixe como "".

[transferencia] — REGRA ADICIONAL OBRIGATÓRIA DO TETO DE BÔNUS:
- Transferências bonificadas quase sempre têm um TETO MÁXIMO de bônus (ex: "limite de 300.000 milhas bônus por CPF"). Essa informação costuma aparecer em seções como "Informações importantes" ou "Regulamento", geralmente perto do FINAL do texto — procure ativamente por palavras como "limite", "máximo", "até X milhas/pontos por CPF" em todo o conteúdo antes de concluir que não há teto. Quando esse teto existir no texto, calcule o VOLUME MÁXIMO de pontos que a pessoa deve transferir para atingir exatamente esse teto, para CADA percentual de bônus aplicável (cada perfil/categoria).
  Fórmula: PONTOS_PARA_ATINGIR_TETO = TETO_DE_BONUS_EM_PONTOS / (PERCENTUAL_DE_BONUS / 100)
  Exemplo: bônus de 80% com teto de 300.000 milhas bônus → transferir até 375.000 pontos (375.000 × 80% = 300.000 milhas de bônus, atingindo o teto). Para o cenário de 50% de bônus com o mesmo teto de 300.000 → transferir até 600.000 pontos.
  Preencha o campo "tetoTransferencia" com uma linha por cenário/perfil, no formato: "🎯 Bônus de [X]% ([perfil, se houver]): transfira até [N] pontos para atingir o teto de [TETO] milhas/pontos de bônus", uma linha por cenário separada por quebra de linha (\\n).
  Se não houver teto de bônus explícito no texto, ou não for possível calcular, deixe "tetoTransferencia" como "".

[clube] e [cartao] e [geral]
- "resumo" e "restricoes" normalmente, sem regras especiais de título.
- "loja", "cupom", "milheiro", "tetoTransferencia", "importante": deixe "" a menos que claramente aplicável (ex: cupom de assinatura).

REGRA DE PRAZO (todas as categorias):
- "prazo" = data de ENCERRAMENTO da campanha/promoção em si.
- NUNCA use prazo de check-in/check-out de hotel, validade de pontos recebidos, ou prazo de crédito dos pontos — essas informações vão em "restricoes", não em "prazo".
- Se não houver prazo explícito de encerramento da campanha, deixe "prazo" como "".

REGRA DE LINK DA OFERTA (todas as categorias):
- "link" deve ser o link OFICIAL da oferta (site do programa de fidelidade, banco, companhia aérea ou loja parceira) — NUNCA um link do site/blog onde a notícia foi publicada.
- Abaixo estão os links encontrados na página, extraídos de âncoras como "clique aqui", "acesse", "confira", "participar" etc. Escolha o mais apropriado para a oferta descrita. Se nenhum candidato for adequado ou não houver confiança suficiente, deixe "link" como "".
- NUNCA invente um link que não esteja na lista de candidatos.

Formato exato de saída (todos os campos sempre presentes, mesmo que vazios):
{
  "titulo": "string",
  "emoji": "um único emoji",
  "resumo": "2 a 3 frases",
  "programa": "nome do(s) programa(s) de fidelidade envolvido(s)",
  "bonus": "valor do bônus/ganho de forma objetiva",
  "prazo": "data de encerramento da campanha, ou \"\"",
  "categoria": "transferencia | compra | compra_bonificada | clube | cartao | geral",
  "loja": "string ou \"\"",
  "cupom": "string ou \"\"",
  "milheiro": "string ou \"\"",
  "tetoTransferencia": "string ou \"\"",
  "importante": "",
  "link": "string ou \"\"",
  "restricoes": ["item com hífen", "..."]
}`;

  const candidatosTxt = linkCandidatos.length
    ? linkCandidatos.map((c) => `- ${c.href}  (texto do link: "${c.texto}")`).join('\n')
    : '(nenhum link encontrado na página)';

  const userPrompt = `Categoria do feed de origem (pista, mas reavalie pelo conteúdo): ${categoriaFeed}\n\nTítulo original da notícia (apenas para contexto, não usar literalmente): ${titulo}\n\nConteúdo completo extraído da página:\n${textoArtigo}\n\nCandidatos a link da oferta (escolha um destes para "link", ou deixe "" se nenhum servir):\n${candidatosTxt}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1400,
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
  return ['transferencia', 'compra', 'compra_bonificada', 'clube', 'cartao'].includes(categoriaFeed) ? categoriaFeed : 'geral';
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
      const linkCandidatos = extractLinkCandidates(html);
      const ia = await reescreverComIA(c.title, texto, c.categoriaFeed, linkCandidatos);

      const categoria = ia.categoria || categorizeFallback(c.categoriaFeed);
      let link = stripUtm(decodeEntities((ia.link || '').trim()));
      if (!linkValido(link)) {
        const fb = resolverLinkFallback(ia.programa, ia.loja);
        if (fb) {
          console.log(`[Radar] Link não confiável da IA, usando fallback: ${fb}`);
          link = fb;
        } else {
          console.log(`[Radar] Nenhum link confiável encontrado para "${c.title}".`);
          link = '';
        }
      }

      // Ícone fixo por categoria (mais consistente do que deixar a IA escolher)
      const EMOJI_POR_CATEGORIA = {
        compra: '💰',
        transferencia: '🔄',
        cartao: '💳',
        compra_bonificada: '🛍️',
      };
      const emoji = EMOJI_POR_CATEGORIA[categoria] || ia.emoji || '📰';

      novosItens.push({
        id: c.id,
        titulo: ia.titulo || c.title,
        emoji,
        resumo: ia.resumo || '',
        programa: ia.programa || '',
        bonus: ia.bonus || '',
        prazo: ia.prazo || '',
        categoria,
        loja: categoria === 'compra_bonificada' ? (ia.loja || '') : '',
        cupom: ia.cupom || '',
        milheiro: ia.milheiro || '',
        tetoTransferencia: categoria === 'transferencia' ? (ia.tetoTransferencia || '') : '',
        importante: categoria === 'compra_bonificada' ? TEXTO_IMPORTANTE_COMPRA_BONIFICADA : '',
        link,
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
