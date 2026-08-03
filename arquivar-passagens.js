/**
 * arquivar-passagens.js — rotação de passagens.json para shards semestrais
 *
 * Roda diariamente às 01h BRT (04:00 UTC) via .github/workflows/arquivar-passagens.yml
 *
 * Move registros com mais de MAX_DIAS dias de passagens.json para
 * passagens-historico-{ANO}-S{1|2}.json e atualiza passagens-historico-index.json.
 *
 * REGRA CRÍTICA DE SEGURANÇA: o shard é gravado ANTES da janela quente ser reescrita.
 * Só é removido de passagens.json aquilo que já foi confirmadamente persistido no
 * shard. Se qualquer PUT de shard falhar, o processo aborta sem tocar em passagens.json.
 *
 * Tudo via GitHub Contents API (não via git commit) porque o proxy Railway escreve
 * passagens.json concorrentemente — a cópia do checkout ficaria stale.
 */

const TOKEN    = process.env.GITHUB_TOKEN;
const REPO     = process.env.GITHUB_REPO || 'davileles/painel-cdv';
const MAX_DIAS = Number(process.env.MAX_DIAS_PASSAGENS || 180);
const DRY_RUN  = process.argv.includes('--dry-run');

const PASSAGENS_PATH = 'passagens.json';
const INDEX_PATH     = 'passagens-historico-index.json';
const API            = `https://api.github.com/repos/${REPO}/contents`;

const HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'cdv-arquivador',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function shardDe(enviadoEm) {
  const d = String(enviadoEm).slice(0, 10);
  const ano = Number(d.slice(0, 4));
  const mes = Number(d.slice(5, 7));
  return `${ano}-S${mes <= 6 ? 1 : 2}`;
}

const arquivoDoShard = (periodo) => `passagens-historico-${periodo}.json`;

// Chave de identidade: usa id quando existe (registros de alerta), senão a
// composição dos campos (registros vindos do backfill da planilha, que não têm id).
function chave(p) {
  if (p.id) return `id:${p.id}`;
  return [
    (p.origem || '').toLowerCase().trim(),
    (p.destino || '').toLowerCase().trim(),
    (p.programa || '').toLowerCase().trim(),
    (p.cia || '').toLowerCase().trim(),
    (p.cabine || '').toLowerCase().trim(),
    p.pontos,
    String(p.enviadoEm).slice(0, 10),
    String(p.datas_ida || '').slice(0, 60),
  ].join('|');
}

// ── GitHub Contents API ──────────────────────────────────────────────────────
// Arquivos >1MB voltam com encoding:'none' e sem content — o SHA vem na mesma
// resposta e o conteúdo é buscado via raw. (Mesmo tratamento do ghGetJson do proxy.)
async function ghGet(path, fallback) {
  const r = await fetch(`${API}/${path}`, { headers: HEADERS });
  if (r.status === 404) return { data: fallback, sha: null, existe: false };
  if (!r.ok) throw new Error(`GET ${path}: HTTP ${r.status}`);
  const meta = await r.json();

  let texto;
  if (meta.encoding === 'base64' && meta.content) {
    texto = Buffer.from(meta.content, 'base64').toString('utf8');
  } else {
    const raw = await fetch(
      `https://raw.githubusercontent.com/${REPO}/main/${path}?t=${Date.now()}`,
      { headers: HEADERS }
    );
    if (!raw.ok) throw new Error(`RAW ${path}: HTTP ${raw.status}`);
    texto = await raw.text();
  }

  let data;
  try { data = JSON.parse(texto); }
  catch { throw new Error(`${path}: JSON inválido — abortando por segurança`); }

  return { data, sha: meta.sha, existe: true };
}

async function ghPut(path, jsonData, sha, message) {
  const body = {
    message,
    content: Buffer.from(JSON.stringify(jsonData), 'utf8').toString('base64'),
  };
  if (sha) body.sha = sha;

  const r = await fetch(`${API}/${path}`, {
    method: 'PUT',
    headers: { ...HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const txt = await r.text();
    const err = new Error(`PUT ${path}: HTTP ${r.status} — ${txt.slice(0, 200)}`);
    err.status = r.status;
    throw err;
  }
  const j = await r.json();
  return j.commit.sha.slice(0, 10);
}

// SHA sempre buscado imediatamente antes do PUT — passagens.json sofre escrita
// concorrente do proxy e um SHA de leitura anterior gera 409.
async function ghPutComRetry(path, montar, message, tentativas = 4) {
  for (let i = 1; i <= tentativas; i++) {
    const atual = await ghGet(path, null);
    const jsonData = montar(atual.data);
    if (jsonData === null) return null;
    try {
      return await ghPut(path, jsonData, atual.sha, message);
    } catch (e) {
      if ((e.status === 409 || e.status === 422) && i < tentativas) {
        console.warn(`[Arquivar] ${path}: conflito (${e.status}), tentativa ${i}/${tentativas}`);
        await sleep(2000 * i);
        continue;
      }
      throw e;
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!TOKEN) {
    console.error('[Arquivar] GITHUB_TOKEN não configurado — abortando.');
    process.exit(1);
  }

  const corteMs = Date.now() - MAX_DIAS * 24 * 60 * 60 * 1000;
  const corteISO = new Date(corteMs).toISOString().slice(0, 10);
  console.log(`[Arquivar] Corte: ${corteISO} (${MAX_DIAS} dias)${DRY_RUN ? ' — DRY RUN' : ''}`);

  const passagens = await ghGet(PASSAGENS_PATH, { items: [] });
  const todos = Array.isArray(passagens.data.items) ? passagens.data.items : [];
  console.log(`[Arquivar] passagens.json: ${todos.length} registros`);

  const frio = [];
  for (const p of todos) {
    const t = new Date(p.enviadoEm).getTime();
    if (!Number.isFinite(t)) {
      console.warn(`[Arquivar] enviadoEm inválido, mantido na janela quente: ${JSON.stringify(p).slice(0, 120)}`);
      continue;
    }
    if (t < corteMs) frio.push(p);
  }

  if (frio.length === 0) {
    console.log('[Arquivar] Nada a arquivar. Encerrando.');
    return;
  }

  const porShard = new Map();
  for (const p of frio) {
    const s = shardDe(p.enviadoEm);
    if (!porShard.has(s)) porShard.set(s, []);
    porShard.get(s).push(p);
  }
  console.log(`[Arquivar] ${frio.length} registros a arquivar em ${porShard.size} shard(s):`,
    [...porShard.entries()].map(([k, v]) => `${k}=${v.length}`).join(', '));

  if (DRY_RUN) {
    console.log('[Arquivar] DRY RUN — nenhuma escrita realizada.');
    return;
  }

  // ── 1. Grava os shards PRIMEIRO ────────────────────────────────────────────
  const arquivados = new Set();
  const resumoShards = [];

  for (const [periodo, novos] of [...porShard.entries()].sort()) {
    const arquivo = arquivoDoShard(periodo);

    const commit = await ghPutComRetry(arquivo, (atual) => {
      const existentes = (atual && Array.isArray(atual.items)) ? atual.items : [];
      const vistos = new Set(existentes.map(chave));
      const adicionar = novos.filter((p) => !vistos.has(chave(p)));
      const items = [...existentes, ...adicionar]
        .sort((a, b) => String(b.enviadoEm).localeCompare(String(a.enviadoEm)));
      return {
        periodo,
        atualizadoEm: new Date().toISOString(),
        total: items.length,
        items,
      };
    }, `chore(passagens): arquiva ${novos.length} registro(s) em ${periodo}`);

    // Confirmação: relê o shard e só marca como arquivado o que está de fato lá.
    const conf = await ghGet(arquivo, { items: [] });
    const presentes = new Set((conf.data.items || []).map(chave));
    let ok = 0;
    for (const p of novos) {
      if (presentes.has(chave(p))) { arquivados.add(chave(p)); ok++; }
    }
    if (ok !== novos.length) {
      throw new Error(`${arquivo}: apenas ${ok}/${novos.length} confirmados — abortando sem tocar em passagens.json`);
    }
    resumoShards.push({
      periodo,
      arquivo,
      total: conf.data.items.length,
      de: conf.data.items.length ? conf.data.items[conf.data.items.length - 1].enviadoEm.slice(0, 10) : null,
      ate: conf.data.items.length ? conf.data.items[0].enviadoEm.slice(0, 10) : null,
    });
    console.log(`[Arquivar] ${arquivo}: +${novos.length} → ${conf.data.items.length} total (commit ${commit})`);
  }

  // ── 2. Só agora remove da janela quente ────────────────────────────────────
  // Relê passagens.json com SHA fresco e remove APENAS o que foi confirmado no
  // shard — registros criados pelo proxy durante a execução são preservados.
  const commitQuente = await ghPutComRetry(PASSAGENS_PATH, (atual) => {
    const items = (atual && Array.isArray(atual.items) ? atual.items : [])
      .filter((p) => !arquivados.has(chave(p)));
    return { atualizadoEm: new Date().toISOString(), items };
  }, `chore(passagens): rotaciona ${arquivados.size} registro(s) para o histórico`);

  const depois = await ghGet(PASSAGENS_PATH, { items: [] });
  console.log(`[Arquivar] passagens.json: ${todos.length} → ${depois.data.items.length} registros (commit ${commitQuente})`);

  // ── 3. Atualiza o manifest ─────────────────────────────────────────────────
  await ghPutComRetry(INDEX_PATH, (atual) => {
    const anteriores = (atual && Array.isArray(atual.shards)) ? atual.shards : [];
    const mapa = new Map(anteriores.map((s) => [s.periodo, s]));
    for (const s of resumoShards) mapa.set(s.periodo, s);
    return {
      atualizadoEm: new Date().toISOString(),
      shards: [...mapa.values()].sort((a, b) => a.periodo.localeCompare(b.periodo)),
    };
  }, 'chore(passagens): atualiza index do historico');

  console.log('[Arquivar] Concluído.');
}

main().catch((e) => {
  console.error('[Arquivar] Erro fatal:', e.message);
  process.exit(1);
});
