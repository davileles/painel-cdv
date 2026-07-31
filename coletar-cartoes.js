/**
 * coletar-cartoes.js — Coletor do catálogo de cartões do Clube do Viajante
 *
 * Substitui a curadoria manual via chat. Fluxo:
 *   1. Lê cartoes-alvos.json (slug + URLs oficiais de cada cartão)
 *   2. Baixa cada URL, limpa HTML → texto, calcula hash do conteúdo
 *   3. Compara com cartoes-fontes.json — se nada mudou, NÃO chama a IA
 *   4. Só o que mudou (ou é novo) vai para a IA com prompt de sistema em cache
 *   5. Sanitiza o resultado pela mesma regra do valida_catalogo.py:
 *      campo factual só sobrevive com URL de fonte oficial em procedencia[campo]
 *   6. Faz merge em cartoes-catalogo.json preservando curadoria manual
 *
 * Fontes bloqueadas por WAF podem ser capturadas por fora (navegador com IP
 * residencial) e gravadas em cartoes-fontes-manuais.json — o coletor usa esse
 * texto no lugar do fetch.
 *
 * O passo 3 é o que torna a manutenção barata: revalidação semanal de 200
 * cartões custa quase nada porque a maioria das páginas não muda.
 *
 * Variáveis de ambiente:
 *   ANTHROPIC_API_KEY  (obrigatória)
 *   CARTOES_MODEL      modelo (default: claude-sonnet-5)
 *   MAX_CARTOES        teto de cartões processados por execução (default: 25)
 *   SLUGS              lista separada por vírgula — processa só esses
 *   CATEGORIAS         filtra por categoria (substring). Ex: "black,infinite,platinum" 
 *   FORCAR             "true" ignora o hash e reprocessa mesmo sem mudança
 *   DRY_RUN            "true" coleta e mostra o diff, mas não grava arquivos
 *   DIAG               "true" só testa acessibilidade das URLs (não gasta tokens)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = __dirname;
const ARQ_ALVOS = path.join(DIR, 'cartoes-alvos.json');
const ARQ_CATALOGO = path.join(DIR, 'cartoes-catalogo.json');
const ARQ_FONTES = path.join(DIR, 'cartoes-fontes.json');
const ARQ_MANUAIS = path.join(DIR, 'cartoes-fontes-manuais.json');

const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.CARTOES_MODEL || 'claude-sonnet-5';
const MAX_CARTOES = parseInt(process.env.MAX_CARTOES || '25', 10);
const SLUGS = (process.env.SLUGS || '').split(',').map(s => s.trim()).filter(Boolean);
const FORCAR = String(process.env.FORCAR || '').toLowerCase() === 'true';
const CATEGORIAS = (process.env.CATEGORIAS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const DRY_RUN = String(process.env.DRY_RUN || '').toLowerCase() === 'true';
const DIAG = String(process.env.DIAG || '').toLowerCase() === 'true';

// Limites de custo/segurança
const MAX_CHARS_POR_FONTE = 14000;   // texto limpo de uma página HTML
const MAX_CHARS_TOTAL = 60000;       // soma de todas as fontes HTML de um cartão
const MAX_PDF_BYTES = 2.5 * 1024 * 1024;
const MAX_PDFS_POR_CARTAO = 4;       // regulamentos longos estouram o custo sozinhos
const TIMEOUT_FETCH = 30000;
const DIAS_VALIDADE_MANUAL = 45;   // captura manual mais velha que isso: tenta a rede antes
const MIN_CHARS_SPA = 1500;        // abaixo disso, numa pagina SPA, o texto e so casca

// ── Regra de procedência (espelha valida_catalogo.py) ────────────────────────
const DOMINIOS_OFICIAIS = [
  'bb.com.br', 'bradesco.com.br', 'brb.com.br', 'btgpactual.com', 'c6bank.com.br',
  'caixa.gov.br', 'bancointer.com.br', 'inter.co', 'itau.com.br', 'nubank.com.br',
  'santander.com.br', 'sicredi.com.br', 'sicoob.com.br', 'xpi.com.br',
  'banco.bradesco', 'assets.bradesco', 'soliciteseucartao.bradesco', 'safra.com.br', 'banrisul.com.br',
  'genial.com.vc', 'genialinvestimentos.com.br', 'unicred.com.br',
  'portobank.com.br', 'porto.com.br', 'banestes.com.br',
  'elo.com.br', 'mastercard.com', 'mastercard.com.br', 'visa.com.br',
  'visa-infinite.com', 'americanexpress.com', 'revolut.com',
  // Programas de fidelidade aerea — fonte oficial para cartoes co-branded
  'smiles.com.br', 'latampass.latam.com', 'voeazul.com.br', 'tudoazul.com',
];

// Hierarquia de fontes: a pagina do EMISSOR manda mais que a da BANDEIRA.
// A bandeira costuma publicar material de lancamento, que envelhece: foi assim
// que a anuidade do Azul virou conflito (nota da Visa dizia 1200, Itau dizia 1260).
const DOMINIOS_BANDEIRA = [
  'elo.com.br', 'mastercard.com', 'mastercard.com.br', 'visa.com.br',
  'visa-infinite.com', 'americanexpress.com',
];

function ehBandeira(url) {
  try {
    let h = new URL(String(url)).hostname.toLowerCase();
    if (h.startsWith('www.')) h = h.slice(4);
    return DOMINIOS_BANDEIRA.some(d => h === d || h.endsWith('.' + d));
  } catch (e) {
    return false;
  }
}

const CAMPOS_FACTUAIS = [
  'anuidade', 'anuidade_parcelas', 'isencao', 'renda_minima',
  'adicionais_gratis', 'pontos', 'cashback', 'spread', 'iof',
  'salas_vip', 'transfere_para', 'requisito_acesso',
];

function ehOficial(url) {
  try {
    let h = new URL(String(url)).hostname.toLowerCase();
    if (h.startsWith('www.')) h = h.slice(4);
    return DOMINIOS_OFICIAIS.some(d => h === d || h.endsWith('.' + d));
  } catch (e) {
    return false;
  }
}

// Compara URLs ignorando diferencas cosmeticas. A IA frequentemente devolve a
// URL sem a barra final ou sem www, e a comparacao literal rejeitava o campo
// mesmo com a procedencia correta.
function normalizarUrl(u) {
  try {
    const x = new URL(String(u));
    let h = x.hostname.toLowerCase();
    if (h.startsWith('www.')) h = h.slice(4);
    let caminho = x.pathname.replace(/\/+$/, '').toLowerCase();
    return h + caminho + (x.search || '');
  } catch (e) {
    return String(u).trim().toLowerCase().replace(/\/+$/, '');
  }
}

function vazio(v) {
  if (v === null || v === undefined || v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

// ── Limpeza de HTML → texto ──────────────────────────────────────────────────
// Corta ~90-95% dos tokens: uma página de banco tem 200-600 KB de HTML e
// costuma render 5-15 KB de texto útil.
function htmlParaTexto(html) {
  let t = html;

  // Blocos que nunca contêm informação de produto
  t = t.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  t = t.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  t = t.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  t = t.replace(/<svg[\s\S]*?<\/svg>/gi, ' ');
  t = t.replace(/<nav[\s\S]*?<\/nav>/gi, ' ');
  t = t.replace(/<header[\s\S]*?<\/header>/gi, ' ');
  t = t.replace(/<footer[\s\S]*?<\/footer>/gi, ' ');
  t = t.replace(/<iframe[\s\S]*?<\/iframe>/gi, ' ');
  t = t.replace(/<!--[\s\S]*?-->/g, ' ');

  // Preserva estrutura de tabela — anuidade e pontuação quase sempre vêm em tabela
  t = t.replace(/<\/t[dh]>/gi, ' | ');
  t = t.replace(/<\/tr>/gi, '\n');
  t = t.replace(/<br\s*\/?>/gi, '\n');
  t = t.replace(/<\/(p|div|li|h[1-6]|section|article)>/gi, '\n');

  t = t.replace(/<[^>]+>/g, ' ');

  // Entidades nomeadas acentuadas — páginas de banco usam muito
  const ACENTOS = {
    agrave: 'à', aacute: 'á', acirc: 'â', atilde: 'ã', auml: 'ä',
    eacute: 'é', ecirc: 'ê', egrave: 'è', euml: 'ë',
    iacute: 'í', icirc: 'î', iuml: 'ï',
    oacute: 'ó', ocirc: 'ô', otilde: 'õ', ouml: 'ö', ograve: 'ò',
    uacute: 'ú', ucirc: 'û', uuml: 'ü', ugrave: 'ù',
    ccedil: 'ç', ntilde: 'ñ', reg: '®', copy: '©', deg: '°',
    ordm: 'º', ordf: 'ª', hellip: '…', ndash: '–', mdash: '—',
  };
  t = t.replace(/&([a-z]+);/gi, (m, nome) => {
    const k = nome.toLowerCase();
    if (ACENTOS[k] !== undefined) {
      const maiuscula = /^[A-Z]/.test(nome) && k.length > 3;
      return maiuscula ? ACENTOS[k].toUpperCase() : ACENTOS[k];
    }
    return m;
  });

  // Entidades comuns
  t = t.replace(/&nbsp;/gi, ' ')
       .replace(/&amp;/gi, '&')
       .replace(/&lt;/gi, '<')
       .replace(/&gt;/gi, '>')
       .replace(/&quot;/gi, '"')
       .replace(/&#0?39;/g, "'")
       .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
       .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d));

  t = t.replace(/[ \t\u00a0]+/g, ' ');
  t = t.split('\n').map(l => l.trim()).filter(Boolean).join('\n');
  t = t.replace(/\n{3,}/g, '\n\n');

  return t.trim();
}

async function baixar(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_FETCH);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/pdf,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ct = (res.headers.get('content-type') || '').toLowerCase();

    if (ct.includes('pdf') || url.toLowerCase().endsWith('.pdf')) {
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_PDF_BYTES) {
        throw new Error(`PDF muito grande (${(buf.length / 1048576).toFixed(1)} MB)`);
      }
      // pdftotext reduz o custo em ~10x frente a enviar o PDF em base64,
      // que a API cobra por página renderizada.
      const tmp = path.join(require('os').tmpdir(), `cdv-${sha(url)}.pdf`);
      try {
        fs.writeFileSync(tmp, buf);
        let texto = require('child_process')
          .execFileSync('pdftotext', ['-layout', '-enc', 'UTF-8', tmp, '-'], { maxBuffer: 32 * 1024 * 1024 })
          .toString('utf8');
        texto = texto.replace(/[ \t]+/g, ' ').split('\n').map(l => l.trim()).filter(Boolean).join('\n');
        if (texto.length < 200) throw new Error('PDF sem texto extraível (provável PDF escaneado)');
        if (texto.length > MAX_CHARS_POR_FONTE) texto = texto.slice(0, MAX_CHARS_POR_FONTE) + '\n[...truncado]';
        return { tipo: 'pdf_texto', texto, hash: sha(texto) };
      } catch (e) {
        if (e.code === 'ENOENT') {
          // pdftotext ausente — cai para base64 (funciona, porém mais caro)
          return { tipo: 'pdf', base64: buf.toString('base64'), hash: sha(buf.toString('base64')) };
        }
        throw e;
      } finally {
        try { fs.unlinkSync(tmp); } catch (_) {}
      }
    }

    const html = await res.text();
    let texto = htmlParaTexto(html);

    // Bancos brasileiros usam WAF (Akamai/Cloudflare) que bloqueia IP de datacenter.
    // Às vezes o bloqueio vem com HTTP 200, então precisa ser detectado pelo conteúdo.
    const BLOQUEIO = /access denied|erro no acesso|attention required|request unsuccessful|checking your browser|forbidden|identificador de seguran|not authorized/i;
    if (texto.length < 1500 && BLOQUEIO.test(texto)) {
      throw new Error('BLOQUEADO pelo WAF do site (IP de datacenter)');
    }

    // Paginas SPA (Next.js, Nuxt, React, Angular) entregam so o esqueleto ao runner:
    // anuidade, pontuacao e beneficios sao montados por JS e nunca chegam ao HTML.
    // O que sobra passa dos 200 chars (menu + rodape + aviso legal), entao o piso
    // antigo nao pegava o caso e a IA recebia casca — gerando ficha vazia em silencio.
    // Falhar alto aqui e o comportamento certo: sinaliza que a pagina precisa de
    // captura manual em cartoes-fontes-manuais.json.
    const SPA = /__NEXT_DATA__|\/_next\/static\/|id="__next"|__NUXT__|data-reactroot|ng-version=|<app-root/i;
    if (texto.length < MIN_CHARS_SPA && SPA.test(html)) {
      throw new Error('PAGINA JS-ONLY (SPA) — conteudo montado por JS; capturar em cartoes-fontes-manuais.json');
    }

    if (texto.length > MAX_CHARS_POR_FONTE) texto = texto.slice(0, MAX_CHARS_POR_FONTE) + '\n[...truncado]';
    if (texto.length < 200) throw new Error('conteúdo vazio após limpeza (possível página JS-only)');
    return { tipo: 'html', texto, hash: sha(texto) };
  } finally {
    clearTimeout(timer);
  }
}

// ── Fontes capturadas manualmente (via navegador) ────────────────────────────
// Bancos com WAF (C6, CAIXA, Bradesco, BB, Santander, parte do Itaú) bloqueiam o
// IP do runner. O texto dessas páginas é capturado por fora, num navegador com
// IP residencial, e gravado em cartoes-fontes-manuais.json. O coletor consome
// dali. A extração com IA continua acontecendo aqui, no Actions.
let MANUAIS = null;

function carregarManuais() {
  if (MANUAIS) return MANUAIS;
  MANUAIS = {};
  if (fs.existsSync(ARQ_MANUAIS)) {
    try {
      const doc = JSON.parse(fs.readFileSync(ARQ_MANUAIS, 'utf8'));
      MANUAIS = doc.fontes || {};
    } catch (e) {
      console.warn(`[Cartões] cartoes-fontes-manuais.json ilegível: ${e.message}`);
    }
  }
  return MANUAIS;
}

function diasDesde(iso) {
  if (!iso) return Infinity;
  const d = (Date.now() - new Date(iso).getTime()) / 86400000;
  return Number.isNaN(d) ? Infinity : d;
}

function lerManual(url) {
  const m = carregarManuais()[url];
  if (!m || !m.texto || m.texto.length < 200) return null;
  let texto = m.texto;
  if (texto.length > MAX_CHARS_POR_FONTE) texto = texto.slice(0, MAX_CHARS_POR_FONTE) + '\n[...truncado]';
  return {
    tipo: 'manual',
    texto,
    hash: sha(texto),
    idade_dias: Math.round(diasDesde(m.capturado_em)),
  };
}

async function coletarFontes(alvo) {
  const fontes = [];
  const falhas = [];
  let charsTotal = 0;
  let pdfs = 0;

  for (const url of alvo.urls || []) {
    try {
      let r = null;
      const manual = lerManual(url);

      // Captura manual recente vence: evita gastar 30s de timeout numa URL que
      // sabidamente bloqueia o runner.
      if (manual && manual.idade_dias <= DIAS_VALIDADE_MANUAL) {
        r = manual;
      } else {
        try {
          r = await baixar(url);
        } catch (eRede) {
          // Rede falhou. Se existe captura manual (mesmo velha), ela salva o cartão.
          if (!manual) throw eRede;
          r = manual;
          falhas.push(`${url}: rede falhou (${eRede.message}) — usando captura manual de ${manual.idade_dias} dias atrás`);
        }
      }

      if (r.tipo === 'pdf') {   // base64 (fallback) — caro, limite rigido
        if (pdfs >= MAX_PDFS_POR_CARTAO) { falhas.push(`${url}: limite de PDFs atingido`); continue; }
        pdfs++;
      } else {
        if (charsTotal + r.texto.length > MAX_CHARS_TOTAL) {
          const resta = MAX_CHARS_TOTAL - charsTotal;
          if (resta < 500) { falhas.push(`${url}: limite de caracteres atingido`); continue; }
          r.texto = r.texto.slice(0, resta) + '\n[...truncado]';
        }
        charsTotal += r.texto.length;
      }
      fontes.push({ url, ...r });
    } catch (e) {
      falhas.push(`${url}: ${e.message}`);
    }
  }
  return { fontes, falhas };
}

// ── Prompt ───────────────────────────────────────────────────────────────────
const PROMPT_SISTEMA = `Você é um curador de dados de cartões de crédito brasileiros para o Clube do Viajante.

Sua tarefa: extrair os dados de UM cartão a partir do conteúdo de páginas e documentos oficiais do emissor ou da bandeira, e devolver um único objeto JSON.

REGRA CENTRAL — PROCEDÊNCIA:
Um campo factual só pode ter valor se a informação estiver EXPLÍCITA no conteúdo de uma fonte específica. Para cada campo factual que você preencher, registre em "procedencia" a URL exata da fonte de onde tirou aquela informação. Se a informação não estiver nas fontes, use null (ou [] para listas) e NÃO registre procedência. Nunca deduza, estime, arredonde ou complete com conhecimento próprio — um campo vazio é sempre melhor que um campo inventado.

ATENÇÃO — DE ONDE COPIAR A URL DE PROCEDÊNCIA:
O valor de "procedencia" DEVE ser copiado literalmente de um dos cabeçalhos "===== FONTE: <url> =====" que separam os blocos de conteúdo, e de nenhum outro lugar.
O texto das páginas frequentemente MENCIONA outros endereços ("Acesse banco.bradesco/cartoes/anuidade", "Veja mais em visa.com.br/..."). Essas URLs citadas dentro do texto NÃO são fontes — você não leu o conteúdo delas. Usá-las como procedência faz o campo ser descartado.
Ao final, confira cada valor de "procedencia": ele tem de ser idêntico a uma das URLs listadas em FONTES VÁLIDAS abaixo.

CAMPOS FACTUAIS (exigem procedência): anuidade, anuidade_parcelas, isencao, renda_minima, adicionais_gratis, pontos, cashback, spread, iof, salas_vip, transfere_para, requisito_acesso.

SCHEMA DE SAÍDA (todos os campos obrigatórios; use null quando não houver informação):
{
  "nome": string,
  "emissor": string,           // nome comercial curto: Itaú, Bradesco, Banco do Brasil, Santander, CAIXA, BTG Pactual, C6 Bank, Banco Safra, Sicoob, Unicred, BRB, Porto Bank, Sicredi, XP, Banestes, Banco Inter, Nubank
  "bandeira": string,          // Visa, Mastercard, Elo, American Express
  "categoria": string,         // Infinite, Signature, Platinum, Gold, Internacional, Black, Nanquim, Grafite, etc.
  "anuidade": number|null,     // valor ANUAL total em reais, mesmo que cobrado mensalmente
  "anuidade_parcelas": number|null,
  "isencao": {"tipo": "gasto_mensal"|"gasto_anual"|"investimento"|"relacionamento"|"vitalicia"|"outro", "valor": number|null, "regra": string}|null,
  "renda_minima": number|null,
  "requisito_acesso": string|null,
  "adicionais_gratis": number|null,
  "pontos": {"nacional": number|null, "internacional": number|null, "unidade": "pts/USD"|"pts/BRL", "observacao": string}|null,
  "cashback": {"percentual": number, "regra": string}|null,
  "programa_proprio": string|null,
  "transfere_para": string[],
  "spread": number|null,
  "iof": number|null,
  "validade_pontos": string|null,
  "salas_vip": [{"programa": string, "regra": string}],
  "beneficios_banco": [{"titulo": string, "descricao": string}],
  "link_solicitacao": string|null,
  "nota_curadoria": string,
  "procedencia": {"<campo>": "<url da fonte>"}
}

REGRAS DE PREENCHIMENTO:
- "anuidade": sempre o TOTAL ANUAL. Se a página informa R$ 105,00/mês, grave 1260 e use anuidade_parcelas=12.
- "pontos": informe a unidade correta. Cartões premium quase sempre pontuam por dólar (pts/USD); cartões de entrada costumam pontuar por real (pts/BRL). Se a fonte não deixar claro, use null.
- "isencao.regra": descreva a regra completa em uma ou duas frases, incluindo faixas de desconto parcial quando houver.
- "salas_vip": um item por programa (LoungeKey, Priority Pass, Dragon Pass, salas próprias do emissor). Inclua a quantidade de acessos na "regra".
- "beneficios_banco": no máximo 6 itens, os mais relevantes para viajante. Ignore seguros genéricos de bandeira já cobertos pelo campo bandeira.
- "nota_curadoria": 2 a 4 frases em português com o que um assessor precisa saber — pegadinhas de anuidade, condições de acesso, o que ficou sem confirmação oficial.
- Textos em português do Brasil.

Responda APENAS com o objeto JSON. Sem markdown, sem crases, sem texto antes ou depois.`;

async function extrairComIA(alvo, fontes) {
  const blocos = [];

  const listaUrls = fontes.map((f, i) => `  ${i + 1}. ${f.url}`).join('\n');
  blocos.push({
    type: 'text',
    text: `CARTÃO: ${alvo.nome}\nEMISSOR ESPERADO: ${alvo.emissor || 'não informado'}\nBANDEIRA ESPERADA: ${alvo.bandeira || 'não informada'}\n\n`
      + `FONTES VÁLIDAS (os ÚNICOS valores aceitos em "procedencia" — copie exatamente, sem alterar):\n${listaUrls}\n\n`
      + `Qualquer outro endereço, mesmo que apareça escrito dentro do texto das páginas, é INVÁLIDO como procedência.\n\n`
      + `Segue o conteúdo das fontes.`,
  });

  for (const f of fontes) {
    if (f.tipo === 'manual') {
      blocos.push({ type: 'text', text: `\n===== FONTE: ${f.url} =====\n${f.texto}` });
    } else if (f.tipo === 'pdf_texto') {
      blocos.push({ type: 'text', text: `\n===== FONTE (PDF): ${f.url} =====\n${f.texto}` });
    } else if (f.tipo === 'pdf') {
      blocos.push({ type: 'text', text: `\n===== FONTE (PDF): ${f.url} =====` });
      blocos.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: f.base64 },
      });
    } else {
      blocos.push({ type: 'text', text: `\n===== FONTE: ${f.url} =====\n${f.texto}` });
    }
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8000,
      // cache_control no prompt de sistema: ele é idêntico para todo cartão,
      // então a partir da 2ª chamada o input dele custa 10%
      system: [{ type: 'text', text: PROMPT_SISTEMA, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: blocos }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`API ${res.status}: ${err.slice(0, 300)}`);
  }

  const data = await res.json();
  const texto = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  const limpo = texto.replace(/^```(?:json)?/gm, '').replace(/```$/gm, '').trim();

  let obj;
  try {
    obj = JSON.parse(limpo);
  } catch (e) {
    const m = limpo.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('resposta da IA não é JSON válido');
    obj = JSON.parse(m[0]);
  }

  const u = data.usage || {};
  return {
    obj,
    uso: {
      in: u.input_tokens || 0,
      out: u.output_tokens || 0,
      cache_w: u.cache_creation_input_tokens || 0,
      cache_r: u.cache_read_input_tokens || 0,
    },
  };
}

// ── Sanitização: zera o que não tem procedência oficial ──────────────────────
function sanitizar(cartao, urlsPermitidas) {
  const proc = cartao.procedencia || {};
  const pend = new Set();
  const rejeitados = [];
  // mapa normalizada -> URL canonica (a que foi realmente lida)
  const permitidas = new Map(urlsPermitidas.map(u => [normalizarUrl(u), u]));
  const canonica = (u) => (u ? permitidas.get(normalizarUrl(u)) : undefined);

  // Fallback de fonte unica. Quando o cartao foi extraido de UMA so fonte oficial,
  // nao ha ambiguidade possivel: o valor so pode ter saido dali. A IA as vezes
  // preenche o campo e esquece de registrar a procedencia (ou atribui a uma URL
  // apenas citada no texto), e a regra estrita descartava dado correto — foi o que
  // aconteceu com o Bradesco Visa Platinum em 07/2026, duas execucoes seguidas.
  // Com 2+ fontes a regra continua estrita: ai a origem importa de verdade.
  const inferidos = [];
  const fonteUnica = (urlsPermitidas.length === 1 && ehOficial(urlsPermitidas[0]))
    ? urlsPermitidas[0]
    : null;

  for (const campo of CAMPOS_FACTUAIS) {
    const v = cartao[campo];
    const temValor = !vazio(v);
    const fonte = proc[campo];
    // Só vale se a URL for oficial E tiver sido realmente uma das fontes lidas
    let url = canonica(fonte);
    let fonteOk = !!fonte && ehOficial(fonte) && !!url;
    if (!fonteOk && temValor && fonteUnica) {
      url = fonteUnica;
      fonteOk = true;
      inferidos.push(campo);
    }
    if (fonteOk) proc[campo] = url;   // grava sempre a URL canonica

    if (temValor && !fonteOk) {
      cartao[campo] = Array.isArray(v) ? [] : null;
      delete proc[campo];
      pend.add(campo);
      rejeitados.push(campo);
    } else if (!temValor) {
      pend.add(campo);
      delete proc[campo];
    }
  }

  // Limpa procedência órfã (campo inexistente ou URL não oficial)
  for (const k of Object.keys(proc)) {
    const u = canonica(proc[k]);
    if (!u || !ehOficial(u)) delete proc[k];
    else proc[k] = u;
  }

  cartao.procedencia = proc;
  cartao.campos_pendentes = [...pend].sort();
  cartao.campos_rejeitados = rejeitados.sort();
  if (inferidos.length) cartao.campos_procedencia_inferida = inferidos.sort();
  else delete cartao.campos_procedencia_inferida;
  return cartao;
}

// Merge NÃO-DESTRUTIVO. Regra: o coletor só enriquece.
// Se a nova extração não trouxe um campo (porque uma fonte caiu, tomou 403 ou
// foi truncada) mas o catálogo já tinha valor com procedência oficial, o valor
// antigo é preservado. Sem isso, uma fonte fora do ar apaga curadoria boa.
// Campos onde uma mudança de NÚMERO é significativa o bastante para exigir
// revisão humana. Texto reformulado não conta — só valores.
// Sem esse filtro, toda reescrita de "regra" viraria conflito e o sinal se perderia.
const CAMPOS_CRITICOS = {
  'anuidade': c => c.anuidade,
  'anuidade_parcelas': c => c.anuidade_parcelas,
  'renda_minima': c => c.renda_minima,
  'adicionais_gratis': c => c.adicionais_gratis,
  'spread': c => c.spread,
  'iof': c => c.iof,
  'isencao.valor': c => c.isencao && c.isencao.valor,
  'pontos.nacional': c => c.pontos && c.pontos.nacional,
  'pontos.internacional': c => c.pontos && c.pontos.internacional,
  'cashback.percentual': c => c.cashback && c.cashback.percentual,
};

function numero(v) {
  return typeof v === 'number' && !Number.isNaN(v);
}

// Detecta divergência de valor entre catálogo e nova extração.
// O valor NOVO é gravado; o antigo fica registrado em conflitos para revisão.
function detectarConflitos(existente, novo) {
  const conflitos = [];
  const procAntiga = existente.procedencia || {};
  const procNova = novo.procedencia || {};

  for (const [nome, ler] of Object.entries(CAMPOS_CRITICOS)) {
    const antes = ler(existente);
    const depois = ler(novo);
    if (!numero(antes) || !numero(depois)) continue;   // só compara número com número
    if (antes === depois) continue;

    const raiz = nome.split('.')[0];
    const fonteAntes = procAntiga[raiz] || null;
    const fonteDepois = procNova[raiz] || null;

    // Hierarquia: se o valor antigo veio do emissor e o novo veio da bandeira,
    // o antigo prevalece. O conflito continua registrado para revisão.
    const rebaixado = !!fonteAntes && !!fonteDepois
      && !ehBandeira(fonteAntes) && ehBandeira(fonteDepois);

    conflitos.push({
      campo: nome,
      antes,
      depois,
      variacao_pct: antes ? Number((((depois - antes) / antes) * 100).toFixed(1)) : null,
      fonte_antes: fonteAntes,
      fonte_depois: fonteDepois,
      valor_mantido: rebaixado ? 'antes' : 'depois',
      motivo: rebaixado ? 'fonte nova e da bandeira; fonte anterior e do emissor (tem precedencia)' : null,
      detectado_em: hoje(),
      resolvido: false,
    });
  }
  return conflitos;
}

function mesclar(existente, novo) {
  if (!existente) return novo;

  const procAntiga = existente.procedencia || {};
  const preservados = [];

  const CAMPOS_PRESERVAVEIS = CAMPOS_FACTUAIS.concat([
    'programa_proprio', 'validade_pontos', 'beneficios_banco', 'link_solicitacao',
  ]);

  for (const campo of CAMPOS_PRESERVAVEIS) {
    if (!vazio(novo[campo])) continue;              // extração nova trouxe algo — vale a nova
    if (vazio(existente[campo])) continue;          // nada a preservar

    const fonteAntiga = procAntiga[campo];
    const factual = CAMPOS_FACTUAIS.includes(campo);
    // Campo factual só é preservado se tinha procedência oficial declarada
    if (factual && !(fonteAntiga && ehOficial(fonteAntiga))) continue;

    novo[campo] = existente[campo];
    if (fonteAntiga) novo.procedencia[campo] = fonteAntiga;
    preservados.push(campo);
  }

  if (preservados.length) {
    const pend = new Set(novo.campos_pendentes || []);
    preservados.forEach(c => pend.delete(c));
    novo.campos_pendentes = [...pend].sort();
    novo.campos_preservados = preservados.sort();
    // fontes preservadas continuam sendo fontes do registro
    const fontes = new Set(novo.fontes || []);
    preservados.forEach(c => { if (procAntiga[c]) fontes.add(procAntiga[c]); });
    novo.fontes = [...fontes];
  }

  // Curadoria manual pura
  for (const campo of ['analise', 'bandeira_ref', 'vigencia_ate']) {
    if (vazio(novo[campo]) && !vazio(existente[campo])) novo[campo] = existente[campo];
  }
  if (vazio(novo.nota_curadoria) && !vazio(existente.nota_curadoria)) {
    novo.nota_curadoria = existente.nota_curadoria;
  }

  // Divergência de número entre catálogo e extração: grava o novo, sinaliza o antigo
  const conflitos = detectarConflitos(existente, novo);

  // Aplica a hierarquia: restaura o valor do emissor onde a bandeira tentou sobrescrever
  for (const c of conflitos.filter(x => x.valor_mantido === 'antes')) {
    const partes = c.campo.split('.');
    if (partes.length === 1) {
      novo[partes[0]] = c.antes;
      if (procAntiga[partes[0]]) novo.procedencia[partes[0]] = procAntiga[partes[0]];
    } else if (novo[partes[0]] && typeof novo[partes[0]] === 'object') {
      novo[partes[0]][partes[1]] = c.antes;
    }
  }

  if (conflitos.length) novo.conflitos = conflitos;
  else delete novo.conflitos;   // conflito que sumiu está resolvido

  return novo;
}

const hoje = () => new Date().toISOString().slice(0, 10);

// ── Modo diagnóstico: testa acessibilidade das URLs sem gastar 1 token ───────
// Bancos brasileiros bloqueiam IP de datacenter com frequência. Rode isto ANTES
// de qualquer coleta para saber de quais emissores o runner consegue ler.
async function diagnostico(alvos) {
  const porEmissor = new Map();

  for (const alvo of alvos) {
    for (const url of alvo.urls || []) {
      let status;
      try {
        await baixar(url);
        status = 'OK';
      } catch (e) {
        status = /BLOQUEADO|HTTP 40|HTTP 50/.test(e.message) ? 'BLOQUEADO' : 'FALHA';
      }
      const em = alvo.emissor || '?';
      if (!porEmissor.has(em)) porEmissor.set(em, { OK: 0, BLOQUEADO: 0, FALHA: 0, exemplos: [] });
      const r = porEmissor.get(em);
      r[status]++;
      if (status !== 'OK' && r.exemplos.length < 2) r.exemplos.push(url);
    }
  }

  console.log('\n=== DIAGNÓSTICO DE ACESSO POR EMISSOR ===');
  let totOk = 0, totBloq = 0;
  for (const [em, r] of [...porEmissor.entries()].sort()) {
    totOk += r.OK; totBloq += r.BLOQUEADO + r.FALHA;
    const marca = r.OK === 0 ? '❌' : (r.BLOQUEADO + r.FALHA ? '⚠️ ' : '✅');
    console.log(`${marca} ${em}: ok=${r.OK} bloqueado=${r.BLOQUEADO} falha=${r.FALHA}`);
    r.exemplos.forEach(u => console.log(`      ${u}`));
  }
  console.log(`\nTotal: ${totOk} URLs acessíveis, ${totBloq} inacessíveis deste runner.`);
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (DIAG) {
    const doc = JSON.parse(fs.readFileSync(ARQ_ALVOS, 'utf8'));
    let lista = (doc.alvos || []).filter(a => a.ativo !== false && (a.urls || []).length);
    if (SLUGS.length) lista = lista.filter(a => SLUGS.includes(a.slug));
    if (CATEGORIAS.length) lista = lista.filter(a => CATEGORIAS.some(k => (a.categoria || '').toLowerCase().includes(k)));
    return diagnostico(lista);
  }

  if (!API_KEY) { console.error('ANTHROPIC_API_KEY não configurada.'); process.exit(1); }

  const alvosDoc = JSON.parse(fs.readFileSync(ARQ_ALVOS, 'utf8'));
  const catalogo = JSON.parse(fs.readFileSync(ARQ_CATALOGO, 'utf8'));
  let fontesDoc = { _meta: { descricao: 'Hash do conteúdo das fontes por cartão. Se o hash não mudou, o coletor não chama a IA.' }, cartoes: {} };
  if (fs.existsSync(ARQ_FONTES)) {
    try { fontesDoc = JSON.parse(fs.readFileSync(ARQ_FONTES, 'utf8')); } catch (e) { /* recomeça */ }
  }
  fontesDoc.cartoes = fontesDoc.cartoes || {};

  const porSlug = new Map((catalogo.cartoes || []).map(c => [c.slug, c]));

  let alvos = (alvosDoc.alvos || []).filter(a => a.ativo !== false && (a.urls || []).length);
  if (SLUGS.length) alvos = alvos.filter(a => SLUGS.includes(a.slug));
  if (CATEGORIAS.length) {
    alvos = alvos.filter(a => {
      const cat = (a.categoria || '').toLowerCase();
      return CATEGORIAS.some(k => cat.includes(k));
    });
  }

  console.log(`[Cartões] ${alvos.length} alvos elegíveis | modelo=${MODEL} | forcar=${FORCAR} | dry=${DRY_RUN}`);

  const uso = { in: 0, out: 0, cache_w: 0, cache_r: 0 };
  let processados = 0, pulados = 0, novos = 0, atualizados = 0, erros = 0;
  const conflitosAbertos = [];

  for (const alvo of alvos) {
    if (processados >= MAX_CARTOES) {
      console.log(`[Cartões] Teto de ${MAX_CARTOES} atingido — o restante fica para a próxima execução.`);
      break;
    }

    const { fontes, falhas } = await coletarFontes(alvo);
    if (falhas.length) falhas.forEach(f => console.warn(`  ! ${alvo.slug} — ${f}`));
    if (!fontes.length) { console.warn(`[${alvo.slug}] nenhuma fonte acessível — pulado`); erros++; continue; }

    const hashAtual = sha(fontes.map(f => `${f.url}:${f.hash}`).join('|'));
    const registro = fontesDoc.cartoes[alvo.slug];
    const existente = porSlug.get(alvo.slug);

    if (!FORCAR && existente && registro && registro.hash === hashAtual) {
      pulados++;
      continue;
    }

    const nManual = fontes.filter(f => f.tipo === 'manual').length;
    console.log(`[${alvo.slug}] ${fontes.length} fonte(s), ${fontes.filter(f => f.tipo.startsWith('pdf')).length} PDF`
      + (nManual ? `, ${nManual} de captura manual` : '') + ' — chamando IA');

    try {
      const { obj, uso: u } = await extrairComIA(alvo, fontes);
      uso.in += u.in; uso.out += u.out; uso.cache_w += u.cache_w; uso.cache_r += u.cache_r;

      let cartao = {
        slug: alvo.slug,
        ...obj,
        fontes: fontes.map(f => f.url),
        verificado_em: hoje(),
      };
      cartao = sanitizar(cartao, fontes.map(f => f.url));
      cartao = mesclar(existente, cartao);

      if (cartao.campos_rejeitados.length) {
        console.log(`  → rejeitados por falta de procedência: ${cartao.campos_rejeitados.join(', ')}`);
      }
      if (cartao.campos_procedencia_inferida && cartao.campos_procedencia_inferida.length) {
        console.log(`  → procedência inferida da fonte única: ${cartao.campos_procedencia_inferida.join(', ')}`);
      }
      if (cartao.campos_preservados && cartao.campos_preservados.length) {
        console.log(`  → preservados do catálogo (extração veio vazia): ${cartao.campos_preservados.join(', ')}`);
      }
      if (cartao.conflitos) {
        cartao.conflitos.forEach(c => {
          const pct = c.variacao_pct === null ? '' : ` (${c.variacao_pct > 0 ? '+' : ''}${c.variacao_pct}%)`;
          const mantido = c.valor_mantido === 'antes' ? ` — MANTIDO ${c.antes} (fonte do emissor tem precedência)` : '';
          console.log(`  ⚠ CONFLITO ${c.campo}: ${c.antes} → ${c.depois}${pct}${mantido}`);
        });
      }

      if (DRY_RUN) {
        console.log(`  --- JSON extraído ---`);
        console.log(JSON.stringify(cartao, null, 2));
        if (existente) {
          const mudancas = [];
          for (const campo of CAMPOS_FACTUAIS.concat(['programa_proprio', 'validade_pontos'])) {
            const a = JSON.stringify(existente[campo] ?? null);
            const b = JSON.stringify(cartao[campo] ?? null);
            if (a !== b) mudancas.push(`    ${campo}:\n      antes: ${a}\n      agora: ${b}`);
          }
          console.log(mudancas.length ? `  --- DIFF vs catálogo atual ---\n${mudancas.join('\n')}` : '  --- sem mudanças nos campos factuais ---');
        }
      }

      if (cartao.conflitos) conflitosAbertos.push({ slug: alvo.slug, nome: cartao.nome, conflitos: cartao.conflitos });

      if (existente) {
        const i = catalogo.cartoes.findIndex(c => c.slug === alvo.slug);
        catalogo.cartoes[i] = cartao;
        atualizados++;
      } else {
        catalogo.cartoes.push(cartao);
        novos++;
      }
      porSlug.set(alvo.slug, cartao);

      fontesDoc.cartoes[alvo.slug] = { hash: hashAtual, urls: fontes.map(f => f.url), em: hoje() };
      processados++;
    } catch (e) {
      // Não grava o hash: o cartão será retentado na próxima execução
      console.error(`[${alvo.slug}] ERRO: ${e.message}`);
      erros++;
    }
  }

  // Estimativa de custo (tarifas de julho/2026, USD por milhão de tokens)
  const TARIFAS = {
    'claude-sonnet-5': [2, 10],
    'claude-opus-5': [5, 25],
    'claude-haiku-4-5': [1, 5],
  };
  const [pIn, pOut] = TARIFAS[MODEL] || TARIFAS['claude-sonnet-5'];
  const custo = (uso.in * pIn + uso.cache_w * pIn * 1.25 + uso.cache_r * pIn * 0.1 + uso.out * pOut) / 1e6;

  if (conflitosAbertos.length) {
    console.log('\n=== ⚠ CONFLITOS PARA REVISÃO HUMANA ===');
    console.log('O valor novo foi gravado. O anterior está no campo "conflitos" de cada cartão.');
    for (const c of conflitosAbertos) {
      console.log(`\n${c.nome} (${c.slug})`);
      c.conflitos.forEach(x => {
        console.log(`  ${x.campo}: ${x.antes} → ${x.depois}  [gravado: ${x.valor_mantido === 'antes' ? x.antes : x.depois}]`);
        console.log(`    fonte anterior: ${x.fonte_antes || '—'}`);
        console.log(`    fonte nova:     ${x.fonte_depois || '—'}`);
      });
    }
    console.log('');
  }

  console.log(`\n[Cartões] novos=${novos} atualizados=${atualizados} inalterados=${pulados} erros=${erros} conflitos=${conflitosAbertos.length}`);
  console.log(`[Cartões] tokens: in=${uso.in} cache_write=${uso.cache_w} cache_read=${uso.cache_r} out=${uso.out}`);
  console.log(`[Cartões] custo estimado: US$ ${custo.toFixed(4)}`);

  if (DRY_RUN) { console.log('[Cartões] DRY_RUN — nada foi gravado.'); return; }
  if (!processados) { console.log('[Cartões] Nada a gravar.'); return; }

  catalogo.cartoes.sort((a, b) => (a.emissor || '').localeCompare(b.emissor || '') || (a.nome || '').localeCompare(b.nome || ''));
  catalogo._meta.total = catalogo.cartoes.length;
  catalogo._meta.atualizado_em = hoje();
  catalogo._meta.coletor = 'coletar-cartoes.js';
  catalogo._meta.modelo_coleta = MODEL;
  catalogo._meta.conflitos_abertos = catalogo.cartoes.filter(c => c.conflitos && c.conflitos.length).length;

  fontesDoc._meta.atualizado_em = hoje();
  fontesDoc._meta.total = Object.keys(fontesDoc.cartoes).length;

  fs.writeFileSync(ARQ_CATALOGO, JSON.stringify(catalogo, null, 2), 'utf8');
  fs.writeFileSync(ARQ_FONTES, JSON.stringify(fontesDoc, null, 2), 'utf8');
  console.log(`[Cartões] Gravado. Catálogo com ${catalogo.cartoes.length} cartões.`);
}

main().catch(e => { console.error('Falha geral:', e); process.exit(1); });
