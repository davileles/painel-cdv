#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// guardas.mjs — rede de protecao contra commits que quebram ou apagam codigo.
//
// Nasceu de um incidente real: em 09/08/2026 o commit 8bf01d9c no
// baileys-server tinha mensagem "feat:" e removia 463 linhas — apagou a
// integracao Awin inteira (9 endpoints) porque foi gravado a partir de uma
// copia local velha do server.js. O SHA do PUT estava fresco, entao o GitHub
// aceitou sem 409. Nenhuma checagem existia para pegar isso.
//
// Tres guardas independentes:
//   1) SINTAXE   — node --check em todo .js/.mjs e nos <script> inline de .html
//   2) SUPERFICIE— marcadores obrigatorios declarados em .github/superficie.json
//                  nao podem desaparecer (endpoints, funcoes, imports)
//   3) REGRESSAO — commit que remove muito mais do que adiciona, sem declarar
//                  isso na mensagem, e barrado
//
// Variaveis de ambiente:
//   ALVO        diretorio do repositorio a inspecionar (padrao: .)
//   BASE_SHA    commit anterior (para o guarda de regressao); vazio = pula
//   HEAD_SHA    commit atual
//   LIMIAR      remocao liquida de linhas que dispara o alarme (padrao 150)
//   SO_AVISO    '1' = reporta mas nao falha (modo observacao)
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync, existsSync, readdirSync, statSync, writeFileSync, mkdtempSync } from 'fs';
import { execSync, execFileSync } from 'child_process';
import { join, relative, extname, basename } from 'path';
import { tmpdir } from 'os';

const ALVO     = process.env.ALVO || '.';
const BASE_SHA = (process.env.BASE_SHA || '').trim();
const HEAD_SHA = (process.env.HEAD_SHA || 'HEAD').trim();
const LIMIAR   = parseInt(process.env.LIMIAR || '150', 10);
const SO_AVISO = process.env.SO_AVISO === '1';

// Diretorios que nunca contem codigo nosso — varrer isso so gasta tempo e
// produz falso positivo em bundle minificado de terceiro.
const IGNORAR_DIR = new Set([
  '.git', 'node_modules', '.github', 'uploads', 'arquivos', 'assets',
  'sessao', 'dist', 'build', 'vendor', 'coverage',
]);

// Arquivos gigantes gerados por script (tabelas de dados em forma de .js) —
// validam a sintaxe normalmente, mas ficam de fora do guarda de regressao,
// senao qualquer regeracao dispara alarme.
const GERADOS = [/^iata\.js$/i];

const problemas = [];
const avisos = [];
function falhar(guarda, msg) { problemas.push(`[${guarda}] ${msg}`); }
function avisar(guarda, msg) { avisos.push(`[${guarda}] ${msg}`); }

// ── util ────────────────────────────────────────────────────────────────────
function varrer(dir, acc = []) {
  let itens;
  try { itens = readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const it of itens) {
    if (it.isDirectory()) {
      if (IGNORAR_DIR.has(it.name)) continue;
      varrer(join(dir, it.name), acc);
    } else if (it.isFile()) {
      acc.push(join(dir, it.name));
    }
  }
  return acc;
}

function ehCodigo(p) {
  const e = extname(p).toLowerCase();
  return e === '.js' || e === '.mjs' || e === '.cjs' || e === '.html';
}

// ── GUARDA 1: sintaxe ───────────────────────────────────────────────────────
// Um <script> pode ser JS de verdade, template de string ou JSON embutido.
// Mandar template para o node --check gera falso positivo, entao filtramos
// pelo type: so passa o que o navegador de fato executaria como JS.
const TYPES_JS = new Set([
  '', 'text/javascript', 'application/javascript', 'module',
  'text/ecmascript', 'application/ecmascript',
]);

function scriptsInline(html) {
  const blocos = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] || '';
    if (/\bsrc\s*=/i.test(attrs)) continue;             // script externo
    const tipo = (attrs.match(/\btype\s*=\s*["']?([^"'\s>]*)/i)?.[1] || '').toLowerCase();
    if (!TYPES_JS.has(tipo)) continue;                   // template / JSON
    const corpo = m[2].trim();
    if (corpo) blocos.push({ corpo, ehModulo: tipo === 'module' });
  }
  return blocos;
}

function checarSintaxe(arquivos) {
  const tmp = mkdtempSync(join(tmpdir(), 'guardas-'));
  let okJs = 0, okHtml = 0, blocos = 0;

  for (const arq of arquivos) {
    const rel = relative(ALVO, arq);
    const ext = extname(arq).toLowerCase();

    if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
      try {
        execFileSync('node', ['--check', arq], { stdio: 'pipe' });
        okJs++;
      } catch (e) {
        falhar('SINTAXE', `${rel}\n${String(e.stderr || e.message).trim().split('\n').slice(0, 6).join('\n')}`);
      }
      continue;
    }

    // .html — cada bloco inline vai separado, para o erro apontar o bloco certo
    let html;
    try { html = readFileSync(arq, 'utf8'); } catch { continue; }
    const lista = scriptsInline(html);
    if (!lista.length) continue;
    let falhouAqui = false;
    lista.forEach((b, i) => {
      blocos++;
      const destino = join(tmp, `${basename(arq)}.${i}.${b.ehModulo ? 'mjs' : 'js'}`);
      writeFileSync(destino, b.corpo);
      try {
        execFileSync('node', ['--check', destino], { stdio: 'pipe' });
      } catch (e) {
        falhouAqui = true;
        const det = String(e.stderr || e.message).trim().split('\n').slice(0, 6).join('\n');
        falhar('SINTAXE', `${rel} — bloco <script> #${i + 1}\n${det}`);
      }
    });
    if (!falhouAqui) okHtml++;
  }
  console.log(`  sintaxe: ${okJs} arquivo(s) .js OK, ${okHtml} .html OK (${blocos} bloco(s) inline)`);
}

// ── GUARDA 2: superficie ────────────────────────────────────────────────────
// .github/superficie.json declara o que cada arquivo PRECISA conter. E um
// contrato: se um endpoint ou funcao critica sumir, o push falha e o autor
// descobre no minuto seguinte, nao semanas depois.
//
// Formato:
// {
//   "limiarRemocao": 150,
//   "arquivos": {
//     "server.js": {
//       "obrigatorio": ["app.get('/status'", "function formatarCupomTSP"],
//       "minLinhas": 5000
//     }
//   }
// }
function checarSuperficie() {
  const caminho = join(ALVO, '.github', 'superficie.json');
  if (!existsSync(caminho)) {
    console.log('  superficie: sem .github/superficie.json — guarda inativo neste repo');
    return null;
  }
  let cfg;
  try { cfg = JSON.parse(readFileSync(caminho, 'utf8')); }
  catch (e) { falhar('SUPERFICIE', `superficie.json invalido: ${e.message}`); return null; }

  let checados = 0, marcadores = 0;
  for (const [arq, regras] of Object.entries(cfg.arquivos || {})) {
    const full = join(ALVO, arq);
    if (!existsSync(full)) {
      falhar('SUPERFICIE', `arquivo declarado sumiu do repositorio: ${arq}`);
      continue;
    }
    const txt = readFileSync(full, 'utf8');
    checados++;

    for (const marca of regras.obrigatorio || []) {
      marcadores++;
      if (!txt.includes(marca)) {
        falhar('SUPERFICIE', `${arq} perdeu o marcador obrigatorio: ${marca}`);
      }
    }
    if (regras.minLinhas) {
      const n = txt.split('\n').length;
      if (n < regras.minLinhas) {
        falhar('SUPERFICIE', `${arq} encolheu para ${n} linhas (minimo declarado: ${regras.minLinhas})`);
      }
    }
  }
  console.log(`  superficie: ${checados} arquivo(s), ${marcadores} marcador(es) verificado(s)`);
  return cfg;
}

// ── GUARDA 3: regressao ─────────────────────────────────────────────────────
// Palavras que autorizam remocao grande. A ideia nao e proibir apagar codigo —
// e obrigar quem apaga a dizer que esta apagando.
const AUTORIZA = /\b(refactor|refatora|remove|remocao|remoção|limpeza|cleanup|deprecat|delet|migra|rewrite|reescrit|split|extrai|extract|revert|\[grande\])/i;

function git(args) {
  return execSync(`git ${args}`, { cwd: ALVO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}

function checarRegressao(limiar) {
  if (!BASE_SHA || /^0+$/.test(BASE_SHA)) {
    console.log('  regressao: sem commit base (branch nova ou force push) — guarda pulado');
    return;
  }
  let numstat;
  try { numstat = git(`diff --numstat ${BASE_SHA} ${HEAD_SHA}`); }
  catch (e) { avisar('REGRESSAO', `nao foi possivel comparar ${BASE_SHA.slice(0,8)}..${HEAD_SHA.slice(0,8)}: ${e.message}`); return; }

  let mensagens = '';
  try { mensagens = git(`log --format=%B ${BASE_SHA}..${HEAD_SHA}`); } catch { /* segue sem */ }
  const autorizado = AUTORIZA.test(mensagens);

  const linhas = numstat.split('\n').filter(Boolean);
  let analisados = 0;
  for (const l of linhas) {
    const [addRaw, delRaw, arq] = l.split('\t');
    if (addRaw === '-' || delRaw === '-') continue;      // binario
    if (!ehCodigo(arq)) continue;
    if (GERADOS.some(re => re.test(basename(arq)))) continue;
    analisados++;

    const add = parseInt(addRaw, 10), del = parseInt(delRaw, 10);
    const liquido = del - add;
    if (liquido < limiar) continue;

    const msg = `${arq}: +${add} −${del} (remocao liquida de ${liquido} linhas, limiar ${limiar})`;
    if (autorizado) {
      avisar('REGRESSAO', `${msg} — permitido: a mensagem do commit declara a remocao`);
    } else {
      falhar('REGRESSAO',
        `${msg}\n` +
        `    Se a remocao e intencional, cite o motivo na mensagem do commit\n` +
        `    (refactor / remove / limpeza / revert / [grande]).\n` +
        `    Se nao e, voce provavelmente commitou a partir de uma copia local\n` +
        `    velha do arquivo — rebaixe a versao atual do GitHub e refaca a edicao.`);
    }
  }
  console.log(`  regressao: ${analisados} arquivo(s) de codigo no intervalo ${BASE_SHA.slice(0,8)}..${HEAD_SHA.slice(0,8)}`);
}

// ── execucao ────────────────────────────────────────────────────────────────
console.log(`\n🛡  Guardas de repositorio — ${ALVO}\n`);

const arquivos = varrer(ALVO).filter(ehCodigo);
checarSintaxe(arquivos);
const cfg = checarSuperficie();
checarRegressao(cfg?.limiarRemocao ?? LIMIAR);

console.log('');
if (avisos.length) {
  console.log('⚠️  Avisos:');
  for (const a of avisos) console.log('   ' + a.replace(/\n/g, '\n   '));
  console.log('');
}
if (problemas.length) {
  console.log(`❌ ${problemas.length} problema(s):\n`);
  for (const p of problemas) console.log('   ' + p.replace(/\n/g, '\n   ') + '\n');
  if (SO_AVISO) {
    console.log('(SO_AVISO=1 — reportado, mas sem falhar o job)');
    process.exit(0);
  }
  process.exit(1);
}
console.log('✅ Todos os guardas passaram.');
