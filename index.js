// CDV Proxy — redeploy 2026-07-12 env-dev
const express = require('express');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO || 'davileles/cdv-compras-bonificadas';

const ALLOWED = ['comparemania.com.br', 'passageirodeprimeira.com', 'marketplace-api.web.bancointer.com.br'];

// ── Modo DEV ──────────────────────────────────────────────────────────────────
// Requisições com header "x-cdv-env: dev" lêem/escrevem arquivos *-dev.json
// Ex: milhas.json → milhas-dev.json, membros.json → membros-dev.json
// O middleware abaixo injeta req.isDevMode e sobrescreve ghGetJson/ghPutJson
// localmente via res.locals para não afetar o contexto de produção.
function devPath(filePath) {
  return filePath.replace(/\.json$/, '-dev.json');
}
app.use((req, res, next) => {
  res.locals.isDevMode = req.headers['x-cdv-env'] === 'dev';
  next();
});
function ghGetJsonDev(filePath, fallback, devMode) {
  return ghGetJson(devMode ? devPath(filePath) : filePath, fallback);
}
function ghPutJsonDev(filePath, jsonData, sha, message, devMode) {
  const path = devMode ? devPath(filePath) : filePath;
  const msg  = devMode ? `[DEV] ${message}` : message;
  return ghPutJson(path, jsonData, sha, msg);
}

app.use(express.json({ limit: '20mb' }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Health check / warm-up
app.get('/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));

// ── Gift Cards do Shopping Inter ──────────────────────────────────────────────
// Proxy para a API pública do Inter, que bloqueia IPs de datacenter (GitHub Actions).
// O coletar-inter.js chama este endpoint para contornar o bloqueio por ASN.
app.get('/inter/gift-cards', async (req, res) => {
  const API = 'https://marketplace-api.web.bancointer.com.br/site/giftcard/inter/v1/giftcards/search?lang=pt-BR&category=';
  try {
    const response = await fetch(API, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'application/json, */*',
        'Accept-Language': 'pt-BR,pt;q=0.9',
        'Cache-Control': 'no-cache',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return res.status(response.status).json({ error: `Inter API retornou ${response.status}` });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Fetch para análise de ofertas (sem restrição de domínio) ─────────────────
app.get('/fetch-oferta', async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).json({ error: 'Parâmetro ?url= obrigatório' });
  if (!/^https?:\/\//i.test(target)) return res.status(400).json({ error: 'URL inválida' });

  try {
    const response = await fetch(target, {
      compress: false,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Encoding': 'identity',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.7',
        'Cache-Control': 'no-cache',
        'Upgrade-Insecure-Requests': '1'
      },
      timeout: 20000
    });
    if (!response.ok) return res.status(response.status).json({ error: `Destino retornou ${response.status}` });
    const html = await response.text();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Proxy de fetch (domínios restritos — usado pelo painel público) ───────────
app.get('/fetch', async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).json({ error: 'Parâmetro ?url= obrigatório' });

  const isAllowed = ALLOWED.some(domain => target.includes(domain));
  if (!isAllowed) return res.status(403).json({ error: 'Domínio não permitido' });

  try {
    const response = await fetch(target, {
      compress: false,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Encoding': 'identity',
        'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Upgrade-Insecure-Requests': '1'
      },
      timeout: 15000
    });
    if (!response.ok) return res.status(response.status).json({ error: `Destino retornou ${response.status}` });
    const html = await response.text();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Salvar alerta ─────────────────────────────────────────────────────────────
app.post('/alerta', async (req, res) => {
  const { email, parceiro, programa, minPts } = req.body || {};

  if (!email || !parceiro || !programa || !minPts) {
    return res.status(400).json({ ok: false, erro: 'Campos obrigatórios: email, parceiro, programa, minPts' });
  }
  if (!GITHUB_TOKEN) {
    return res.status(500).json({ ok: false, erro: 'GITHUB_TOKEN não configurado no servidor' });
  }

  try {
    const apiBase = `https://api.github.com/repos/${GITHUB_REPO}/contents/alertas.json`;
    const headers = {
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json'
    };

    const getRes = await fetch(apiBase, { compress: false, headers });
    const getData = await getRes.json();
    const sha = getData.sha;
    const alertas = JSON.parse(Buffer.from(getData.content, 'base64').toString('utf8'));

    const idx = alertas.findIndex(a => a.email === email && a.parceiro === parceiro && a.programa === programa);
    if (idx >= 0) {
      alertas[idx].minPts = minPts;
      alertas[idx].atualizadoEm = new Date().toISOString();
    } else {
      alertas.push({ email, parceiro, programa, minPts, criadoEm: new Date().toISOString() });
    }

    const putRes = await fetch(apiBase, {
      compress: false,
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message: `chore: alerta ${email} → ${parceiro} (${programa} ≥ ${minPts} pts)`,
        content: Buffer.from(JSON.stringify(alertas, null, 2)).toString('base64'),
        sha
      })
    });

    if (putRes.ok) {
      res.json({ ok: true });
    } else {
      const err = await putRes.json();
      res.status(500).json({ ok: false, erro: err.message || 'Falha ao salvar no GitHub' });
    }
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ── Helpers genéricos de leitura/escrita de arquivos JSON no GitHub ───────────
function ghHeaders(nocache = false) {
  const h = {
    'Authorization': `Bearer ${GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'Content-Type': 'application/json'
  };
  if (nocache) {
    h['Cache-Control'] = 'no-cache, no-store';
    h['If-None-Match'] = '';
    h['Pragma'] = 'no-cache';
  }
  return h;
}

async function ghGetJson(filePath, fallback) {
  const apiBase = `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`;
  const res = await fetch(apiBase, { compress: false, headers: ghHeaders(true) });
  if (res.status === 404) return { data: fallback, sha: null };
  const data = await res.json();
  if (!res.ok) return { data: fallback, sha: null };
  // Arquivo >1MB: GitHub retorna encoding:'none' e content vazio — buscar via raw URL
  if (data.encoding === 'none' || !data.content) {
    const sha = data.sha || null;
    try {
      const rawUrl = `https://raw.githubusercontent.com/${GITHUB_REPO}/main/${filePath}`;
      const rawRes = await fetch(rawUrl, { compress: false, headers: ghHeaders(true) });
      if (!rawRes.ok) return { data: fallback, sha };
      const parsed = await rawRes.json();
      return { data: parsed, sha };
    } catch (e) {
      return { data: fallback, sha };
    }
  }
  try {
    return { data: JSON.parse(Buffer.from(data.content, 'base64').toString('utf8')), sha: data.sha };
  } catch (e) {
    return { data: fallback, sha: data.sha };
  }
}

async function ghPutJson(filePath, jsonData, sha, message) {
  const apiBase = `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`;
  const body = {
    message,
    content: Buffer.from(JSON.stringify(jsonData, null, 2)).toString('base64'),
  };
  if (sha) body.sha = sha;
  const res = await fetch(apiBase, { compress: false, method: 'PUT', headers: ghHeaders(), body: JSON.stringify(body) });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `Falha ao salvar ${filePath} no GitHub (status ${res.status})`);
  }
  return res.json();
}

const OFERTAS_PENDENTES_PATH  = 'ofertas-pendentes.json';
const OFERTAS_APROVADAS_PATH  = 'ofertas.json';
const OFERTAS_REJEITADAS_PATH = 'ofertas-rejeitadas.json';
const HISTORICO_TRANSFERENCIAS_PATH = 'historico-transferencias.json';

// ── Histórico de transferências bonificadas ───────────────────────────────────
function normalizarChaveHist(s) {
  return (s || '').toString().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().replace(/\s+/g, '_');
}
function chaveHistorico(origem, destino) {
  return `${normalizarChaveHist(origem)}→${normalizarChaveHist(destino)}`;
}
function prazoParaIso(prazoStr) {
  const m = (prazoStr || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

// Atualiza historico-transferencias.json após aprovação de uma oferta categoria=transferencia.
// Regra de dedup: mesma chave (origem→destino) + mesmo prazo = mesma campanha (reenvio/lembrete),
// só anexa o ofertaId. Prazo diferente (ou ausente) = campanha nova = novo registro.
// Best-effort: falhas aqui nunca devem quebrar o fluxo de aprovação da oferta.
async function atualizarHistoricoTransferencia(item) {
  if (!item || item.categoria !== 'transferencia') return;
  if (!item.origem || !item.destino || item.bonusMax === undefined || item.bonusMax === null || item.bonusMax === '') return;

  const chave = chaveHistorico(item.origem, item.destino);
  const prazoIso = prazoParaIso(item.prazo);
  const dataInicio = (item.publicadoEm ? item.publicadoEm.slice(0, 10) : new Date().toISOString().slice(0, 10));

  const hist = await ghGetJson(HISTORICO_TRANSFERENCIAS_PATH, {
    geradoEm: null,
    descricao: 'Histórico de ofertas de transferência bonificada entre programas.',
    regrasDedup: "Duas ofertas com a mesma chave origem→destino e o MESMO prazo de encerramento são consideradas a mesma campanha e não geram novo registro — apenas anexam o ofertaId ao registro existente.",
    items: [],
  });

  const items = hist.data.items || [];
  const existente = items.find((h) => h.chave === chave && prazoIso && h.prazo === prazoIso);

  if (existente) {
    if (!existente.ofertaIds.includes(item.id)) existente.ofertaIds.push(item.id);
  } else {
    items.unshift({
      chave,
      origem: item.origem,
      destino: item.destino,
      origemTipo: item.origem === 'Todos' ? 'todos' : 'especifica',
      bonusMax: Number(item.bonusMax),
      tipoBonus: 'percentual_direto',
      dataInicio,
      prazo: prazoIso || '',
      ofertaIds: [item.id],
      observacao: '',
    });
  }

  await ghPutJson(
    HISTORICO_TRANSFERENCIAS_PATH,
    { geradoEm: new Date().toISOString(), descricao: hist.data.descricao, regrasDedup: hist.data.regrasDedup, items },
    hist.sha,
    `chore: atualiza historico de transferencias (${chave})`
  );
}
const PASSAGENS_PATH          = 'passagens.json';
const MAX_OFERTAS_APROVADAS   = 100;
const MAX_DIAS_PASSAGENS      = 180;
const MEMBROS_PATH            = 'membros.json';
const MILHAS_PATH             = 'milhas.json';
const CARTOES_PATH            = 'cartoes.json';
const ASSINATURAS_PATH        = 'assinaturas.json';
const PERFIS_PATH             = 'perfis.json';
const HUBLA_TOKEN             = process.env.HUBLA_TOKEN;

// ── Listar ofertas pendentes (com CORS correto) ───────────────────────────────
app.get('/ofertas/pendentes', async (req, res) => {
  try {
    const pend = await ghGetJson(OFERTAS_PENDENTES_PATH, { geradoEm: null, items: [] });
    res.setHeader('Content-Type', 'application/json');
    res.json(pend.data);
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ── Aprovar oferta pendente ───────────────────────────────────────────────────
app.post('/ofertas/aprovar', async (req, res) => {
  const { id, edits } = req.body || {};
  if (!id) return res.status(400).json({ ok: false, erro: 'Campo obrigatório: id' });
  if (!GITHUB_TOKEN) return res.status(500).json({ ok: false, erro: 'GITHUB_TOKEN não configurado no servidor' });

  try {
    const pend = await ghGetJson(OFERTAS_PENDENTES_PATH, { geradoEm: null, items: [] });
    const idx = (pend.data.items || []).findIndex((o) => o.id === id);
    if (idx < 0) return res.status(404).json({ ok: false, erro: 'Oferta não encontrada nas pendentes (pode já ter sido processada)' });

    const item = { ...pend.data.items[idx], ...(edits || {}) };
    pend.data.items.splice(idx, 1);

    const aprov = await ghGetJson(OFERTAS_APROVADAS_PATH, { geradoEm: null, items: [] });
    const jaExiste = (aprov.data.items || []).some((o) => o.id === id);
    const novosAprovados = jaExiste
      ? aprov.data.items
      : [item, ...(aprov.data.items || [])].slice(0, MAX_OFERTAS_APROVADAS);

    await ghPutJson(
      OFERTAS_APROVADAS_PATH,
      { geradoEm: new Date().toISOString(), items: novosAprovados },
      aprov.sha,
      `chore: aprova oferta "${item.titulo || id}"`
    );
    await ghPutJson(
      OFERTAS_PENDENTES_PATH,
      { geradoEm: pend.data.geradoEm || new Date().toISOString(), items: pend.data.items },
      pend.sha,
      `chore: remove oferta aprovada "${item.titulo || id}" das pendentes`
    );

    try {
      await atualizarHistoricoTransferencia(item);
    } catch (errHist) {
      console.error('[Histórico transferências] Falha ao atualizar:', errHist.message);
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ── Rejeitar oferta pendente ──────────────────────────────────────────────────
app.post('/ofertas/rejeitar', async (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ ok: false, erro: 'Campo obrigatório: id' });
  if (!GITHUB_TOKEN) return res.status(500).json({ ok: false, erro: 'GITHUB_TOKEN não configurado no servidor' });

  try {
    const rej = await ghGetJson(OFERTAS_REJEITADAS_PATH, []);
    const listaRejeitadas = Array.isArray(rej.data) ? rej.data : [];
    if (!listaRejeitadas.includes(id)) listaRejeitadas.push(id);
    await ghPutJson(OFERTAS_REJEITADAS_PATH, listaRejeitadas.slice(-1000), rej.sha, `chore: bloqueia oferta rejeitada ${id}`);

    const pend = await ghGetJson(OFERTAS_PENDENTES_PATH, { geradoEm: null, items: [] });
    const idx = (pend.data.items || []).findIndex((o) => o.id === id);
    if (idx >= 0) {
      pend.data.items.splice(idx, 1);
      await ghPutJson(
        OFERTAS_PENDENTES_PATH,
        { geradoEm: pend.data.geradoEm || new Date().toISOString(), items: pend.data.items },
        pend.sha,
        `chore: remove oferta rejeitada ${id} das pendentes`
      );
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ── Enfileirar oferta no baileys-server para envio via WhatsApp ───────────────
// Proxy para /radar/enviar do baileys-server, mantendo o gerador desacoplado.
const BAILEYS_URL = process.env.BAILEYS_URL || 'https://baileys-server-production-ebfe.up.railway.app';

app.post('/ofertas/enviar', async (req, res) => {
  const { id, mensagem, grupo } = req.body || {};
  if (!mensagem?.trim()) return res.status(400).json({ ok: false, erro: 'mensagem obrigatória' });
  try {
    const r = await fetch(BAILEYS_URL + '/radar/enviar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, mensagem, grupo: grupo || 'cdv_ofertas' }),
    });
    const d = await r.json();
    res.status(r.status).json(d);
  } catch(err) {
    res.status(502).json({ ok: false, erro: 'Baileys inacessível: ' + err.message });
  }
});

// ── Publicar oferta diretamente no radar ──────────────────────────────────────
app.post('/ofertas/publicar', async (req, res) => {
  const oferta = req.body || {};
  if (!oferta.titulo) return res.status(400).json({ ok: false, erro: 'Campo obrigatório: titulo' });
  if (!GITHUB_TOKEN) return res.status(500).json({ ok: false, erro: 'GITHUB_TOKEN não configurado no servidor' });

  try {
    const raw = (oferta.titulo || '') + Date.now();
    let hash = 0;
    for (let i = 0; i < raw.length; i++) hash = (hash * 31 + raw.charCodeAt(i)) >>> 0;
    const id = hash.toString(36);

    const item = {
      id,
      titulo:            oferta.titulo || '',
      emoji:             oferta.emoji  || '📰',
      resumo:            oferta.resumo || oferta.descricao || '',
      programa:          oferta.programa || '',
      bonus:             oferta.bonus || '',
      prazo:             oferta.prazo || '',
      categoria:         oferta.categoria || 'geral',
      loja:              oferta.loja || '',
      cupom:             oferta.cupom || '',
      milheiro:          oferta.milheiro || '',
      tetoTransferencia: oferta.tetoTransferencia || '',
      importante:        oferta.importante || '',
      link:              oferta.link || '',
      restricoes:        Array.isArray(oferta.restricoes) ? oferta.restricoes : [],
      publicadoEm:       new Date().toISOString(),
    };

    const aprov = await ghGetJson(OFERTAS_APROVADAS_PATH, { geradoEm: null, items: [] });
    const jaExiste = (aprov.data.items || []).some(o => o.id === id);
    const novosItens = jaExiste
      ? aprov.data.items
      : [item, ...(aprov.data.items || [])].slice(0, 100);

    await ghPutJson(
      OFERTAS_APROVADAS_PATH,
      { geradoEm: new Date().toISOString(), items: novosItens },
      aprov.sha,
      `chore: publica oferta "${item.titulo}"`
    );

    res.json({ ok: true, id });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ── Registrar passagem enviada ────────────────────────────────────────────────
// Chamado pelo gerador após envio bem-sucedido via Baileys (aba Emissão e Alertas)
// Body: { origem, destino, cia, programa, pontos, cabine, datas_ida, datas_volta, fonte }
// fonte: 'emissao' | 'alerta'
app.post('/passagens/registrar', async (req, res) => {
  const { origem, destino, cia, programa, pontos, cabine, datas_ida, datas_volta, fonte } = req.body || {};

  if (!origem || !destino || !programa || !pontos) {
    return res.status(400).json({ ok: false, erro: 'Campos obrigatórios: origem, destino, programa, pontos' });
  }
  if (!GITHUB_TOKEN) {
    return res.status(500).json({ ok: false, erro: 'GITHUB_TOKEN não configurado no servidor' });
  }

  try {
    // Gera ID estável baseado na rota + programa + pontos + timestamp
    const raw = `${origem}-${destino}-${programa}-${pontos}-${Date.now()}`;
    let hash = 0;
    for (let i = 0; i < raw.length; i++) hash = (hash * 31 + raw.charCodeAt(i)) >>> 0;
    const id = hash.toString(36);

    const agora = new Date().toISOString();

    const novaPassagem = {
      id,
      origem:      origem.trim(),
      destino:     destino.trim(),
      cia:         (cia || '').trim(),
      programa:    programa.trim(),
      pontos:      Number(pontos),
      cabine:      (cabine || '').trim(),
      datas_ida:   (datas_ida || '').trim(),
      datas_volta: (datas_volta || '').trim(),
      fonte:       fonte || 'emissao',
      enviadoEm:   agora,
    };

    // Lê passagens existentes
    const atual = await ghGetJson(PASSAGENS_PATH, { items: [] });
    let items = Array.isArray(atual.data.items) ? atual.data.items : [];

    // Remove passagens com mais de 180 dias
    const corteMs = Date.now() - MAX_DIAS_PASSAGENS * 24 * 60 * 60 * 1000;
    items = items.filter(p => new Date(p.enviadoEm).getTime() >= corteMs);

    // Calcula stats de histórico 180 dias ANTES de inserir a nova entrada
    // Chave de agrupamento: origem|destino|programa|cabine (igual ao painel)
    const grupoKey = `${(novaPassagem.origem).toLowerCase()}|${(novaPassagem.destino).toLowerCase()}|${(novaPassagem.programa).toLowerCase()}|${(novaPassagem.cabine).toLowerCase()}|${(novaPassagem.cia).toLowerCase()}`;
    const corteMs180 = Date.now() - 180 * 24 * 60 * 60 * 1000;
    const hist180 = items.filter(p =>
      `${(p.origem||'').toLowerCase()}|${(p.destino||'').toLowerCase()}|${(p.programa||'').toLowerCase()}|${(p.cabine||'').toLowerCase()}|${(p.cia||'').toLowerCase()}` === grupoKey &&
      new Date(p.enviadoEm).getTime() >= corteMs180 &&
      p.pontos > 0
    );

    let hist180Stats = null;
    if (hist180.length >= 1) {
      const pontosArr = hist180.map(h => h.pontos);
      const minPts    = Math.min(...pontosArr);
      const mediaPts  = Math.round(pontosArr.reduce((a, b) => a + b, 0) / pontosArr.length);
      const isMin     = Number(pontos) <= minPts;
      hist180Stats = { minPts, mediaPts, count: hist180.length, isMin };
    }

    // Adiciona nova passagem no início
    items.unshift(novaPassagem);

    await ghPutJson(
      PASSAGENS_PATH,
      { atualizadoEm: agora, items },
      atual.sha,
      `chore: registra passagem ${origem} → ${destino} (${programa} ${pontos} pts)`
    );

    res.json({ ok: true, id, hist180: hist180Stats });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ── Listar passagens (para consulta do gerador) ───────────────────────────────
app.get('/passagens/listar', async (req, res) => {
  try {
    const atual = await ghGetJson(PASSAGENS_PATH, { items: [] });
    const corteMs = Date.now() - MAX_DIAS_PASSAGENS * 24 * 60 * 60 * 1000;
    const items = (atual.data.items || []).filter(p => new Date(p.enviadoEm).getTime() >= corteMs);
    res.setHeader('Content-Type', 'application/json');
    res.json({ atualizadoEm: atual.data.atualizadoEm || null, items });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ── Excluir passagem ──────────────────────────────────────────────────────────
app.post('/passagens/excluir', async (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ ok: false, erro: 'Campo obrigatório: id' });
  if (!GITHUB_TOKEN) return res.status(500).json({ ok: false, erro: 'GITHUB_TOKEN não configurado no servidor' });

  try {
    const atual = await ghGetJson(PASSAGENS_PATH, { items: [] });
    const items = (atual.data.items || []).filter(p => p.id !== id);

    await ghPutJson(
      PASSAGENS_PATH,
      { atualizadoEm: new Date().toISOString(), items },
      atual.sha,
      `chore: remove passagem ${id}`
    );

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ── OTP: store em memória (email → { codigo, expira, nome, produtos }) ────────
const otpStore = new Map();
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const OTP_TTL = 10 * 60 * 1000; // 10 minutos

function gerarCodigo() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// ── Membros: enviar código OTP por e-mail ────────────────────────────────────
app.post('/membros/enviar-codigo', async (req, res) => {
  const email = ((req.body || {}).email || '').toLowerCase().trim();
  if (!email) return res.status(400).json({ ok: false, erro: 'E-mail obrigatório' });
  try {
    const devMode = res.locals.isDevMode;
    const dados = await ghGetJsonDev(MEMBROS_PATH, { membros: [] }, devMode);
    const membro = (dados.data.membros || []).find(m => m.email === email);
    if (!membro) return res.json({ ok: false, motivo: 'nao_encontrado' });
    if (membro.status !== 'ativo') return res.json({ ok: false, motivo: 'inativo', nome: membro.nome });

    const codigo = gerarCodigo();
    otpStore.set(email, { codigo, expira: Date.now() + OTP_TTL, nome: membro.nome, produtos: membro.produtos });

    if (!RESEND_API_KEY) {
      // Modo dev sem Resend: loga o código no servidor
      console.log(`[OTP-DEV] ${email} → ${codigo}`);
      return res.json({ ok: true, dev: true });
    }

    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Clube do Viajante <noreply@clubedoviajante.com.br>',
        to: [email],
        subject: `Seu código de acesso: ${codigo}`,
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#0a0c12;color:#fff;border-radius:12px">
            <h2 style="color:#FF6B5B;margin-bottom:8px">Clube do Viajante</h2>
            <p style="color:#aaa;margin-bottom:24px">Use o código abaixo para acessar seu painel. Ele expira em <strong>10 minutos</strong>.</p>
            <div style="background:#1a1d2e;border-radius:10px;padding:24px;text-align:center;letter-spacing:12px;font-size:32px;font-weight:900;color:#FF6B5B;margin-bottom:24px">${codigo}</div>
            <p style="color:#666;font-size:12px">Se você não solicitou este código, ignore este e-mail.</p>
          </div>`
      })
    });
    if (!emailRes.ok) {
      const errBody = await emailRes.text();
      console.error('[OTP-RESEND]', errBody);
      return res.status(500).json({ ok: false, erro: 'Falha ao enviar e-mail' });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ── Membros: verificar código OTP ────────────────────────────────────────────
app.post('/membros/verificar-codigo', (req, res) => {
  const { email, codigo } = req.body || {};
  const emailNorm = (email || '').toLowerCase().trim();
  const codigoNorm = (codigo || '').trim();
  if (!emailNorm || !codigoNorm) return res.status(400).json({ ok: false, erro: 'E-mail e código obrigatórios' });

  const entrada = otpStore.get(emailNorm);
  if (!entrada) return res.json({ ok: false, motivo: 'nao_encontrado' });
  if (Date.now() > entrada.expira) {
    otpStore.delete(emailNorm);
    return res.json({ ok: false, motivo: 'expirado' });
  }
  if (entrada.codigo !== codigoNorm) return res.json({ ok: false, motivo: 'invalido' });

  otpStore.delete(emailNorm);
  res.json({ ok: true, acesso: true, nome: entrada.nome, email: emailNorm, produtos: entrada.produtos });
});

// ── Membros: verificar acesso por e-mail ─────────────────────────────────────
app.get('/membros/verificar', async (req, res) => {
  const email = (req.query.email || '').toLowerCase().trim();
  if (!email) return res.status(400).json({ ok: false, erro: 'E-mail obrigatório' });
  try {
    const devMode = res.locals.isDevMode;
    const dados = await ghGetJsonDev(MEMBROS_PATH, { membros: [] }, devMode);
    const membro = (dados.data.membros || []).find(m => m.email === email);
    if (!membro) return res.json({ ok: false, acesso: false, motivo: 'nao_encontrado' });
    if (membro.status !== 'ativo') return res.json({ ok: false, acesso: false, motivo: 'inativo', nome: membro.nome });
    res.json({ ok: true, acesso: true, nome: membro.nome, email: membro.email, produtos: membro.produtos });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ── Preferência de tema por membro ───────────────────────────────────────────
app.get('/membros/tema', async (req, res) => {
  const email = (req.query.email || '').toLowerCase().trim();
  if (!email) return res.status(400).json({ ok: false, erro: 'E-mail obrigatório' });
  try {
    const devMode = res.locals.isDevMode;
    const dados = await ghGetJsonDev(MEMBROS_PATH, { membros: [] }, devMode);
    const membro = (dados.data.membros || []).find(m => m.email === email);
    if (!membro) return res.status(404).json({ ok: false, erro: 'Membro não encontrado' });
    res.json({ ok: true, tema: membro.tema || 'dark' });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.post('/membros/tema', async (req, res) => {
  const { email, tema } = req.body || {};
  if (!email || !tema) return res.status(400).json({ ok: false, erro: 'E-mail e tema obrigatórios' });
  if (!['dark', 'light'].includes(tema)) return res.status(400).json({ ok: false, erro: 'Tema inválido' });
  try {
    const devMode = res.locals.isDevMode;
    const dados = await ghGetJsonDev(MEMBROS_PATH, { membros: [] }, devMode);
    const membros = dados.data.membros || [];
    const idx = membros.findIndex(m => m.email === email.toLowerCase().trim());
    if (idx === -1) return res.status(404).json({ ok: false, erro: 'Membro não encontrado' });
    membros[idx].tema = tema;
    const shaDados = await ghGetJsonDev(MEMBROS_PATH, { membros: [] }, devMode);
    await ghPutJsonDev(MEMBROS_PATH, { ...shaDados.data, membros }, shaDados.sha, `chore: tema ${tema} para ${email}`, devMode);
    res.json({ ok: true, tema });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ── Webhook Hubla: member_added / member_removed ──────────────────────────────
app.post('/webhook/hubla-membros', async (req, res) => {
  // Valida token
  const tokenRecebido = req.headers['x-hubla-token'] || req.headers['authorization'];
  if (HUBLA_TOKEN && tokenRecebido !== HUBLA_TOKEN) {
    return res.status(401).json({ ok: false, erro: 'Token inválido' });
  }

  const { type, event } = req.body || {};
  if (!type || !event) return res.status(400).json({ ok: false, erro: 'Payload inválido' });

  const isMemberAdded   = type === 'customer.member_added'   || type === 'member.granted';
  const isMemberRemoved = type === 'customer.member_removed' || type === 'member.revoked';
  if (!isMemberAdded && !isMemberRemoved) return res.json({ ok: true, ignorado: true, type });

  // Payload v2: e-mail em event.user ou event.subscription.payer
  const user   = event.user || event.subscription?.payer || event.member || event.customer || {};
  const email  = (user.email || '').toLowerCase().trim();
  const nome   = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.fullName || user.name || email;
  const produto = event.products?.[0] || event.product || {};

  if (!email) return res.status(400).json({ ok: false, erro: 'E-mail não encontrado no payload' });

  for (let tentativa = 1; tentativa <= 4; tentativa++) {
    try {
      const agora = new Date().toISOString();
      const dados = await ghGetJson(MEMBROS_PATH, { atualizadoEm: agora, total: 0, membros: [] });
      let membros = dados.data.membros || [];
      const idx   = membros.findIndex(m => m.email === email);

      if (isMemberAdded) {
        const entrada = {
          oferta:      produto.offers?.[0]?.name || produto.name || '',
          produtoId:   produto.id || '',
          produtoNome: produto.name || ''
        };
        if (idx >= 0) {
          membros[idx].status       = 'ativo';
          membros[idx].atualizadoEm = agora;
          if (!membros[idx].produtos) membros[idx].produtos = [];
          const jaExiste = membros[idx].produtos.some(p => p.produtoId === entrada.produtoId);
          if (!jaExiste) membros[idx].produtos.push(entrada);
        } else {
          membros.push({ nome, email, status: 'ativo', produtos: [entrada], adicionadoEm: agora, atualizadoEm: agora, origem: 'webhook' });
        }
      }

      if (isMemberRemoved) {
        if (idx >= 0) {
          membros[idx].status       = 'inativo';
          membros[idx].atualizadoEm = agora;
          membros[idx].removidoEm   = agora;
        }
      }

      await ghPutJson(MEMBROS_PATH, { atualizadoEm: agora, total: membros.filter(m => m.status === 'ativo').length, membros }, dados.sha, 'webhook: atualiza membros');
      return res.json({ ok: true, type, email, acao: isMemberAdded ? 'adicionado' : 'removido' });

    } catch (err) {
      const isShaConflict = err.message && err.message.includes('but expected');
      if (isShaConflict && tentativa < 4) {
        console.warn(`[hubla-membros] SHA conflict, retry ${tentativa}/4 em ${tentativa * 400}ms`);
        await new Promise(r => setTimeout(r, tentativa * 400));
        continue;
      }
      console.error('[webhook-hubla-membros]', err.message);
      return res.status(500).json({ ok: false, erro: err.message });
    }
  }
});

// ── Perfis: listar ────────────────────────────────────────────────────────────
app.get('/perfis/listar', async (req, res) => {
  const email = (req.query.email || '').toLowerCase().trim();
  if (!email) return res.status(400).json({ ok: false, erro: 'E-mail obrigatório' });
  try {
    const devMode = res.locals.isDevMode;
    const atual = await ghGetJsonDev(PERFIS_PATH, { perfis: [] }, devMode);
    const perfis = (atual.data.perfis || []).filter(p => p.email === email);
    res.json({ ok: true, perfis });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ── Perfis: salvar lista completa do usuário ───────────────────────────────────
// Body: { email, perfis: [{id, nome}] }
app.post('/perfis/salvar', async (req, res) => {
  const { email, perfis } = req.body || {};
  if (!email) return res.status(400).json({ ok: false, erro: 'E-mail obrigatório' });
  if (!Array.isArray(perfis)) return res.status(400).json({ ok: false, erro: 'perfis deve ser um array' });
  if (!GITHUB_TOKEN) return res.status(500).json({ ok: false, erro: 'GITHUB_TOKEN não configurado' });

  const emailNorm = email.toLowerCase().trim();
  const perfisSanitizados = perfis.map(p => ({ ...p, email: emailNorm }));

  for (let tentativa = 1; tentativa <= 4; tentativa++) {
    try {
      const atual = await ghGetJson(PERFIS_PATH, { atualizadoEm: null, perfis: [] });
      const outros = (atual.data.perfis || []).filter(p => p.email !== emailNorm);
      const novos  = [...outros, ...perfisSanitizados];
      await ghPutJson(PERFIS_PATH, { atualizadoEm: new Date().toISOString(), perfis: novos }, atual.sha,
        `chore: perfis ${emailNorm} (${perfisSanitizados.length} perfis)`);
      return res.json({ ok: true, total: perfisSanitizados.length });
    } catch (err) {
      const isShaConflict = err.message && err.message.includes('but expected');
      if (isShaConflict && tentativa < 4) { await new Promise(r => setTimeout(r, tentativa * 400)); continue; }
      console.error('[perfis/salvar]', err.message);
      return res.status(500).json({ ok: false, erro: err.message });
    }
  }
});

// ── Gestão de Milhas: listar registros do usuário ────────────────────────────
app.get('/milhas/listar', async (req, res) => {
  const email = (req.query.email || '').toLowerCase().trim();
  if (!email) return res.status(400).json({ ok: false, erro: 'E-mail obrigatório' });
  try {
    const devMode = res.locals.isDevMode;
    const atual = await ghGetJsonDev(MILHAS_PATH, { registros: [] }, devMode);
    const registros = (atual.data.registros || []).filter(r => r.email === email);
    res.json({ ok: true, registros });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ── Gestão de Milhas: salvar lista completa do usuário ───────────────────────
// Body: { email, registros: [...] }
// Substitui todos os registros daquele e-mail; mantém registros de outros usuários intactos.
app.post('/milhas/salvar', async (req, res) => {
  const { email, registros } = req.body || {};
  if (!email) return res.status(400).json({ ok: false, erro: 'E-mail obrigatório' });
  if (!Array.isArray(registros)) return res.status(400).json({ ok: false, erro: 'registros deve ser um array' });
  if (!GITHUB_TOKEN) return res.status(500).json({ ok: false, erro: 'GITHUB_TOKEN não configurado' });

  const emailNorm = email.toLowerCase().trim();

  // Garante que todos os registros enviados pertencem ao e-mail autenticado
  const registrosSanitizados = registros.map(r => ({ ...r, email: emailNorm }));

  for (let tentativa = 1; tentativa <= 4; tentativa++) {
    try {
      const atual = await ghGetJson(MILHAS_PATH, { atualizadoEm: null, registros: [] });
      const outros = (atual.data.registros || []).filter(r => r.email !== emailNorm);
      const novos  = [...outros, ...registrosSanitizados];

      await ghPutJson(
        MILHAS_PATH,
        { atualizadoEm: new Date().toISOString(), registros: novos },
        atual.sha,
        `chore: milhas ${emailNorm} (${registrosSanitizados.length} registros)`
      );

      return res.json({ ok: true, total: registrosSanitizados.length });
    } catch (err) {
      const isShaConflict = err.message && err.message.includes('but expected');
      if (isShaConflict && tentativa < 4) {
        console.warn(`[milhas/salvar] SHA conflict, retry ${tentativa}/4 em ${tentativa * 400}ms`);
        await new Promise(r => setTimeout(r, tentativa * 400));
        continue;
      }
      console.error('[milhas/salvar]', err.message);
      return res.status(500).json({ ok: false, erro: err.message });
    }
  }
});

// ── Gestão de Milhas: excluir um registro por ID ────────────────────────────
// Body: { email, id }
app.post('/milhas/excluir', async (req, res) => {
  const { email, id } = req.body || {};
  if (!email || !id) return res.status(400).json({ ok: false, erro: 'Campos obrigatórios: email, id' });
  if (!GITHUB_TOKEN) return res.status(500).json({ ok: false, erro: 'GITHUB_TOKEN não configurado' });

  const emailNorm = email.toLowerCase().trim();

  for (let tentativa = 1; tentativa <= 4; tentativa++) {
    try {
      const atual = await ghGetJson(MILHAS_PATH, { atualizadoEm: null, registros: [] });
      const registros = (atual.data.registros || []).filter(r => !(r.email === emailNorm && r.id === id));

      await ghPutJson(
        MILHAS_PATH,
        { atualizadoEm: new Date().toISOString(), registros },
        atual.sha,
        `chore: exclui milha ${id} (${emailNorm})`
      );

      return res.json({ ok: true });
    } catch (err) {
      const isShaConflict = err.message && err.message.includes('but expected');
      if (isShaConflict && tentativa < 4) {
        console.warn(`[milhas/excluir] SHA conflict, retry ${tentativa}/4 em ${tentativa * 400}ms`);
        await new Promise(r => setTimeout(r, tentativa * 400));
        continue;
      }
      console.error('[milhas/excluir]', err.message);
      return res.status(500).json({ ok: false, erro: err.message });
    }
  }
});


// ── Cartões: listar ────────────────────────────────────────────────────────
app.get('/cartoes/listar', async (req, res) => {
  const email = (req.query.email || '').toLowerCase().trim();
  if (!email) return res.status(400).json({ ok: false, erro: 'E-mail obrigatório' });
  try {
    const devMode = res.locals.isDevMode;
    const atual = await ghGetJsonDev(CARTOES_PATH, { cartoes: [] }, devMode);
    const cartoes = (atual.data.cartoes || []).filter(c => c.email === email);
    res.json({ ok: true, cartoes });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ── Cartões: salvar lista completa do usuário ──────────────────────────────
app.post('/cartoes/salvar', async (req, res) => {
  const { email, cartoes } = req.body || {};
  if (!email) return res.status(400).json({ ok: false, erro: 'E-mail obrigatório' });
  if (!Array.isArray(cartoes)) return res.status(400).json({ ok: false, erro: 'cartoes deve ser um array' });
  if (!GITHUB_TOKEN) return res.status(500).json({ ok: false, erro: 'GITHUB_TOKEN não configurado' });

  const emailNorm = email.toLowerCase().trim();
  const cartoesSanitizados = cartoes.map(c => ({ ...c, email: emailNorm }));

  for (let tentativa = 1; tentativa <= 4; tentativa++) {
    try {
      const atual = await ghGetJson(CARTOES_PATH, { atualizadoEm: null, cartoes: [] });
      const outros = (atual.data.cartoes || []).filter(c => c.email !== emailNorm);
      const novos  = [...outros, ...cartoesSanitizados];
      await ghPutJson(CARTOES_PATH, { atualizadoEm: new Date().toISOString(), cartoes: novos }, atual.sha,
        `chore: cartoes ${emailNorm} (${cartoesSanitizados.length} registros)`);
      return res.json({ ok: true, total: cartoesSanitizados.length });
    } catch (err) {
      const isShaConflict = err.message && err.message.includes('but expected');
      if (isShaConflict && tentativa < 4) { await new Promise(r => setTimeout(r, tentativa * 400)); continue; }
      console.error('[cartoes/salvar]', err.message);
      return res.status(500).json({ ok: false, erro: err.message });
    }
  }
});

// ── Assinaturas: listar ────────────────────────────────────────────────────
app.get('/assinaturas/listar', async (req, res) => {
  const email = (req.query.email || '').toLowerCase().trim();
  if (!email) return res.status(400).json({ ok: false, erro: 'E-mail obrigatório' });
  try {
    const devMode = res.locals.isDevMode;
    const atual = await ghGetJsonDev(ASSINATURAS_PATH, { assinaturas: [] }, devMode);
    const assinaturas = (atual.data.assinaturas || []).filter(a => a.email === email);
    res.json({ ok: true, assinaturas });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ── Assinaturas: salvar lista completa do usuário ──────────────────────────
app.post('/assinaturas/salvar', async (req, res) => {
  const { email, assinaturas } = req.body || {};
  if (!email) return res.status(400).json({ ok: false, erro: 'E-mail obrigatório' });
  if (!Array.isArray(assinaturas)) return res.status(400).json({ ok: false, erro: 'assinaturas deve ser um array' });
  if (!GITHUB_TOKEN) return res.status(500).json({ ok: false, erro: 'GITHUB_TOKEN não configurado' });

  const emailNorm = email.toLowerCase().trim();
  const assinaturasSanitizadas = assinaturas.map(a => ({ ...a, email: emailNorm }));

  for (let tentativa = 1; tentativa <= 4; tentativa++) {
    try {
      const atual = await ghGetJson(ASSINATURAS_PATH, { atualizadoEm: null, assinaturas: [] });
      const outros = (atual.data.assinaturas || []).filter(a => a.email !== emailNorm);
      const novos  = [...outros, ...assinaturasSanitizadas];
      await ghPutJson(ASSINATURAS_PATH, { atualizadoEm: new Date().toISOString(), assinaturas: novos }, atual.sha,
        `chore: assinaturas ${emailNorm} (${assinaturasSanitizadas.length} registros)`);
      return res.json({ ok: true, total: assinaturasSanitizadas.length });
    } catch (err) {
      const isShaConflict = err.message && err.message.includes('but expected');
      if (isShaConflict && tentativa < 4) { await new Promise(r => setTimeout(r, tentativa * 400)); continue; }
      console.error('[assinaturas/salvar]', err.message);
      return res.status(500).json({ ok: false, erro: err.message });
    }
  }
});

// ── IA: Extrair dados de reserva via Anthropic ──────────────────
app.post('/ia/extrair-reserva', (req, res) => {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  const { mediaType, base64, isPdf, tipoCampos } = req.body;
  console.log('[ia/extrair-reserva] recebido. isPdf:', isPdf, 'mediaType:', mediaType, 'base64 len:', (base64||'').length);

  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ ok: false, erro: 'ANTHROPIC_API_KEY não configurada no servidor.' });
  }
  if (!base64 || !mediaType) {
    return res.status(400).json({ ok: false, erro: 'Parâmetros base64 e mediaType são obrigatórios.' });
  }

  const prompt =
    'Você é um assistente de extração de dados de documentos de viagem. ' +
    'Analise este documento (' + (isPdf ? 'PDF' : 'imagem') + ') de ' + (tipoCampos || 'reserva de viagem') + '. ' +
    'Extraia os dados REAIS do documento e retorne SOMENTE um JSON válido (sem markdown). ' +
    'Use exatamente esta estrutura JSON (substitua pelos valores reais): ' +
    '{"tipo":"voo","trechos":[{"nvoo":"numero do voo","origem":"IATA","destino":"IATA","data":"YYYY-MM-DD","horaPartida":"HH:MM","horaChegada":"HH:MM","cabine":"cabine exata","cia":"companhia aerea"}],"pnr":"","pax":0,"programa":"","milhasTotal":0,"valor":"","hotelNome":"","hotelDestino":"","hotelQuarto":"","checkin":"","checkout":"","noites":"","hospedes":"","hotelConf":"","regime":"","hotelValor":"","subtipo":"transfer","transferOrigem":"","transferDestino":"","transferData":"","transferHora":"","transferPax":"","transferOp":"","transferVeiculo":"","transferConf":"","transferValor":"","locadora":"","carroCat":"","retLocal":"","devLocal":"","retData":"","devData":"","carroConf":"","carroValor":"","passeioNome":"","passeioDest":"","passeioOp":"","passeioData":"","passeioHora":"","passeioPax":"","passeioConf":"","passeioValor":"","obs":""} ' +
    'REGRAS: ' +
    '1) trechos[]: um objeto por segmento de voo na ordem do itinerário. ' +
    '2) Em cada trecho, cia = nome da companhia aérea operadora (ex: LATAM, Azul, Gol, TAP, KLM). ' +
    '3) pax = total de passageiros listados por nome no documento. ' +
    '4) milhasTotal = total bruto de milhas do documento inteiro, sem dividir. ' +
    '5) Para hotel, preencha os campos hotel* e trechos=[]. ' +
    '6) Para qualquer transporte terrestre ou aquático: use tipo=\"carro\" e defina subtipo conforme abaixo. ' +
    '   - Transfer/traslado (van, táxi, shuttle, ponto a ponto sem devolução): subtipo=\"transfer\". ' +
    '   - Trem, metrô, trem de alta velocidade, trem noturno: subtipo=\"trem\". ' +
    '   - Ônibus, autocarro, bus turístico, coach: subtipo=\"onibus\". ' +
    '   - Ferry, balsa, barco, cruzeiro fluvial: subtipo=\"ferry\". ' +
    '   - Locação/aluguel de carro (cliente retira e devolve): subtipo=\"locacao\". ' +
    '   Para transfer/trem/onibus/ferry preencha: transferOrigem, transferDestino, transferData, transferHora, transferPax, transferOp, transferVeiculo, transferConf, transferValor. ' +
    '   Para locacao preencha: locadora, carroCat, retLocal, devLocal, retData, devData, carroConf, carroValor. ' +
    '7) Para passeio/atividade, use tipo=\"passeio\" e preencha passeio*. ' +
    '8) Retorne SOMENTE o JSON, sem explicações.';

  // Processar trechos no servidor para derivar conexao, destino final, etc.
  function processarTrechos(d) {
    if (!d.trechos || d.trechos.length === 0) return d;

    // Aeroportos da mesma cidade (para detectar conexão com troca de aeroporto)
    const mesmaCidade = [
      ['GRU','CGH','VCP'],   // São Paulo
      ['CDG','ORY','BVA'],   // Paris
      ['LHR','LGW','STN','LTN','LCY'], // Londres
      ['JFK','LGA','EWR'],   // Nova York
      ['FCO','CIA'],          // Roma
      ['MXP','LIN','BGY'],   // Milão
      ['TXL','SXF'],          // Berlim
      ['OSL','TRF'],          // Oslo
      ['STO','ARN','BMA','NYO'], // Estocolmo
    ];

    function mesmaCidadeCheck(a, b) {
      a = (a||'').toUpperCase(); b = (b||'').toUpperCase();
      if (a === b) return true;
      return mesmaCidade.some(g => g.includes(a) && g.includes(b));
    }

    function cabineToClasse(cabine) {
      if (!cabine) return '';
      const c = cabine.toLowerCase();
      if (c.includes('business') || c.includes('executiv')) return 'Executiva';
      if (c.includes('premium') && c.includes('econ')) return 'Econômica Premium';
      if (c.includes('first') || c.includes('primeira')) return 'Primeira Classe';
      return 'Econômica';
    }

    // Separar trechos de ida e volta
    // Ida: sequência do início; volta: quando destino de um trecho = origem do primeiro
    const origem0 = (d.trechos[0].origem||'').toUpperCase();
    let idxVolta = -1;
    for (let i = 1; i < d.trechos.length; i++) {
      if (mesmaCidadeCheck(d.trechos[i].origem, d.trechos[d.trechos.length-1].destino) &&
          mesmaCidadeCheck(d.trechos[i].destino, origem0)) {
        idxVolta = i; break;
      }
      // Se destino do último trecho da ida = origem do primeiro → é volta
      if (mesmaCidadeCheck(d.trechos[i].destino, origem0) && i === d.trechos.length - 1) {
        idxVolta = i; break;
      }
    }

    const trechosIda = idxVolta === -1 ? d.trechos : d.trechos.slice(0, idxVolta);
    const trechosVolta = idxVolta === -1 ? [] : d.trechos.slice(idxVolta);

    // Montar campos de ida
    const primeiro = trechosIda[0];
    const ultimo = trechosIda[trechosIda.length - 1];

    d.origem = primeiro.origem;
    d.destino = ultimo.destino;
    d.dataIda = primeiro.data;
    d.horaPartida = primeiro.horaPartida;
    d.horaChegada = ultimo.horaChegada;
    d.nvooIda = trechosIda.map(t => t.nvoo).filter(Boolean).join(', ');
    d.classe = cabineToClasse(primeiro.cabine);
    if (!d.ciaIda) d.ciaIda = trechosIda.map(t => t.cia).filter(Boolean)[0] || '';

    // Conexão na ida: destino do primeiro trecho (se há mais de um trecho)
    if (trechosIda.length > 1) {
      d.conexao = trechosIda[0].destino;
    }

    // Montar campos de volta
    if (trechosVolta.length > 0) {
      const primeiroV = trechosVolta[0];
      const ultimoV = trechosVolta[trechosVolta.length - 1];
      d.dataVolta = primeiroV.data;
      d.horaPartidaVolta = primeiroV.horaPartida;
      d.horaChegadaVolta = ultimoV.horaChegada;
      d.nvooVolta = trechosVolta.map(t => t.nvoo).filter(Boolean).join(', ');
      d.ciaVolta = d.ciaVolta || d.ciaIda;
      if (trechosVolta.length > 1) {
        d.conexaoVolta = trechosVolta[0].destino;
      }
    }

    // Milhas por passageiro
    if (d.milhasTotal && d.pax) {
      d.milhas = String(Math.round(d.milhasTotal / d.pax));
    }

    return d;
  }

  const contentBlock = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
    : { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } };

  const bodyPayload = JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{ role: 'user', content: [contentBlock, { type: 'text', text: prompt }] }]
  });

  const https = require('https');
  const options = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(bodyPayload),
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    }
  };

  const apiReq = https.request(options, (apiRes) => {
    let raw = '';
    apiRes.on('data', (chunk) => { raw += chunk; });
    apiRes.on('end', () => {
      console.log('[ia/extrair-reserva] status:', apiRes.statusCode, 'len:', raw.length);
      try {
        const parsed = JSON.parse(raw);
        if (parsed.error) return res.json({ ok: false, erro: parsed.error.message });
        const texto = (parsed.content && parsed.content[0] && parsed.content[0].text) || '';
        const textoClean = texto.replace(/```json|```/g, '').trim();
        try {
          const dadosRaw = JSON.parse(textoClean);
          const dadosProcessados = processarTrechos(dadosRaw);
          return res.json({ ok: true, texto: JSON.stringify(dadosProcessados) });
        } catch(e) {
          return res.json({ ok: true, texto: textoClean });
        }
      } catch (e) {
        return res.json({ ok: false, erro: 'Resposta inválida: ' + raw.slice(0, 300) });
      }
    });
  });

  apiReq.on('error', (e) => {
    console.error('[ia/extrair-reserva] erro:', e.message);
    return res.json({ ok: false, erro: e.message });
  });

  apiReq.setTimeout(55000, () => {
    apiReq.destroy();
    return res.json({ ok: false, erro: 'Timeout (>55s) ao chamar API Anthropic.' });
  });

  apiReq.write(bodyPayload);
  apiReq.end();
});

// ── CONCIERGE: Reservas e Viagens ──────────────────────────────

const CONCIERGE_REPO = 'davileles/concierge';

async function getConciergeFile(filename) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    // Primeiro buscar SHA via API normal
    const optsMeta = {
      hostname: 'api.github.com',
      path: `/repos/${CONCIERGE_REPO}/contents/${filename}`,
      headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'cdv-proxy', 'Accept': 'application/vnd.github+json' }
    };
    https.get(optsMeta, (resMeta) => {
      let rawMeta = '';
      resMeta.on('data', d => rawMeta += d);
      resMeta.on('end', () => {
        try {
          const meta = JSON.parse(rawMeta);
          const fileSha = meta.sha;
          // Se arquivo pequeno e tem content, usar diretamente
          if (meta.content && meta.encoding === 'base64') {
            const content = JSON.parse(Buffer.from(meta.content.replace(/\n/g,''), 'base64').toString('utf-8'));
            return resolve({ content, sha: fileSha });
          }
          // Arquivo grande (>1MB): usar raw API
          const optsRaw = {
            hostname: 'raw.githubusercontent.com',
            path: `/davileles/concierge/main/${filename}`,
            headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'cdv-proxy' }
          };
          https.get(optsRaw, (resRaw) => {
            let rawData = '';
            resRaw.on('data', d => rawData += d);
            resRaw.on('end', () => {
              try {
                const content = JSON.parse(rawData);
                resolve({ content, sha: fileSha });
              } catch(e) { reject(e); }
            });
          }).on('error', reject);
        } catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function putConciergeFile(filename, content, sha) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const body = JSON.stringify({
      message: `update: ${filename}`,
      content: Buffer.from(JSON.stringify(content, null, 2)).toString('base64'),
      sha
    });
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${CONCIERGE_REPO}/contents/${filename}`,
      method: 'PUT',
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'User-Agent': 'cdv-proxy',
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => resolve(JSON.parse(raw)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// GET /concierge/reservas
app.get('/concierge/reservas', async (req, res) => {
  try {
    const { content } = await getConciergeFile('reservas.json');
    res.json({ ok: true, data: content });
  } catch(e) {
    console.error('[concierge/reservas GET]', e.message);
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// POST /concierge/reservas
app.post('/concierge/reservas', async (req, res) => {
  try {
    const { data } = req.body;
    if (!Array.isArray(data)) return res.status(400).json({ ok: false, erro: 'data deve ser um array' });
    const { sha } = await getConciergeFile('reservas.json');
    await putConciergeFile('reservas.json', data, sha);
    res.json({ ok: true });
  } catch(e) {
    console.error('[concierge/reservas POST]', e.message);
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// GET /concierge/viagens
app.get('/concierge/viagens', async (req, res) => {
  try {
    const { content } = await getConciergeFile('viagens.json');
    res.json({ ok: true, data: content });
  } catch(e) {
    console.error('[concierge/viagens GET]', e.message);
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// POST /concierge/viagens
app.post('/concierge/viagens', async (req, res) => {
  try {
    const { data } = req.body;
    if (!Array.isArray(data)) return res.status(400).json({ ok: false, erro: 'data deve ser um array' });
    const { sha } = await getConciergeFile('viagens.json');
    await putConciergeFile('viagens.json', data, sha);
    res.json({ ok: true });
  } catch(e) {
    console.error('[concierge/viagens POST]', e.message);
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// GET /concierge/portal?email=x — dados do cliente para o portal de acompanhamento
app.get('/concierge/portal', async (req, res) => {
  const email = (req.query.email || '').toLowerCase().trim();
  if (!email) return res.status(400).json({ ok: false, erro: 'email obrigatório' });

  try {
    // 1. Buscar cfg para obter URL do Apps Script e configuração de colunas
    const CONCIERGE_REPO = 'davileles/concierge';
    const ghHeaders = { 'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json' };

    const cfgRes = await fetch(`https://api.github.com/repos/${CONCIERGE_REPO}/contents/cfg.json`, { compress: false, headers: ghHeaders });
    const cfgData = await cfgRes.json();
    const cfg = JSON.parse(Buffer.from(cfgData.content, 'base64').toString('utf8'));

    if (!cfg.url) return res.status(400).json({ ok: false, erro: 'Apps Script não configurado' });

    // 2. Buscar clientes do Apps Script
    const sheetUrl = cfg.url + '?aba=' + encodeURIComponent(cfg.aba || 'Clientes') + '&linha=' + (cfg.linha || 2);
    const sheetRes = await fetch(sheetUrl);
    const sheetData = await sheetRes.json();

    function colIdx(letra) {
      const s = (letra || 'A').toUpperCase().trim();
      let r = 0;
      for (let i = 0; i < s.length; i++) r = r * 26 + (s.charCodeAt(i) - 64);
      return r - 1;
    }

    const rows = sheetData.rows || [];
    // Encontrar clientes cujo e-mail corresponde
    const clientesMatch = rows
      .map(row => ({
        nome: String(row[colIdx(cfg.colNome)] || '').trim(),
        email: String(row[colIdx(cfg.colEmail)] || '').trim().toLowerCase(),
      }))
      .filter(c => c.email === email && c.nome);

    if (!clientesMatch.length) {
      return res.json({ ok: true, clientes: [], viagens: [], reservas: [] });
    }

    const nomesCliente = clientesMatch.map(c => {
      const partes = c.nome.trim().split(/\s+/);
      return (partes[0].charAt(0).toUpperCase() + partes[0].slice(1).toLowerCase()) + 
             (partes[1] ? ' ' + partes[1].charAt(0).toUpperCase() + partes[1].slice(1).toLowerCase() : '');
    });

    // 3. Buscar viagens e reservas do GitHub
    const [viagensRes, reservasRes] = await Promise.all([
      fetch(`https://api.github.com/repos/${CONCIERGE_REPO}/contents/viagens.json`, { compress: false, headers: ghHeaders }),
      fetch(`https://api.github.com/repos/${CONCIERGE_REPO}/contents/reservas.json`, { compress: false, headers: ghHeaders }),
    ]);
    const viagensData = await viagensRes.json();
    const reservasData = await reservasRes.json();
    const todasViagens  = JSON.parse(Buffer.from(viagensData.content,  'base64').toString('utf8'));
    const todasReservas = JSON.parse(Buffer.from(reservasData.content, 'base64').toString('utf8'));

    // 4. Filtrar por nome do cliente (normalizado)
    function nomeMatch(nome) {
      if (!nome) return false;
      const partes = nome.trim().split(/\s+/);
      const norm = (partes[0].charAt(0).toUpperCase() + partes[0].slice(1).toLowerCase()) +
                   (partes[1] ? ' ' + partes[1].charAt(0).toUpperCase() + partes[1].slice(1).toLowerCase() : '');
      return nomesCliente.includes(norm);
    }

    const viagens = todasViagens.filter(v => {
      const clis = Array.isArray(v.clientes) ? v.clientes : [v.clientes];
      return clis.some(nomeMatch);
    });

    const reservas = todasReservas.filter(r => nomeMatch(r.cliente));

    res.json({ ok: true, clientes: clientesMatch, nomesCliente, viagens, reservas });
  } catch(e) {
    console.error('[concierge/portal]', e.message);
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// GET /concierge/cfg
app.get('/concierge/cfg', async (req, res) => {
  try {
    const { content } = await getConciergeFile('cfg.json');
    res.json({ ok: true, data: content });
  } catch(e) {
    res.json({ ok: true, data: {} });
  }
});

// POST /concierge/cfg
app.post('/concierge/cfg', async (req, res) => {
  try {
    const { data } = req.body;
    let sha = null;
    try { ({ sha } = await getConciergeFile('cfg.json')); } catch(e) {}
    await putConciergeFile('cfg.json', data, sha);
    res.json({ ok: true });
  } catch(e) {
    console.error('[concierge/cfg POST]', e.message);
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// GET /concierge/modelos
app.get('/concierge/modelos', async (req, res) => {
  try {
    const { content } = await getConciergeFile('modelos.json');
    res.json({ ok: true, data: content });
  } catch(e) {
    res.json({ ok: true, data: [] });
  }
});

// POST /concierge/modelos
app.post('/concierge/modelos', async (req, res) => {
  try {
    const { data } = req.body;
    if (!Array.isArray(data)) return res.status(400).json({ ok: false, erro: 'data deve ser um array' });
    let sha = null;
    try { ({ sha } = await getConciergeFile('modelos.json')); } catch(e) {}
    await putConciergeFile('modelos.json', data, sha);
    res.json({ ok: true });
  } catch(e) {
    console.error('[concierge/modelos POST]', e.message);
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// GET /concierge/msgs-enviadas — log de mensagens automáticas já enviadas
app.get('/concierge/msgs-enviadas', async (req, res) => {
  try {
    const { content } = await getConciergeFile('msgs-enviadas.json');
    res.json({ ok: true, data: content });
  } catch(e) {
    res.json({ ok: true, data: [] }); // arquivo ainda não existe = nenhum envio
  }
});

// POST /concierge/msgs-enviadas — salva log de mensagens automáticas
app.post('/concierge/msgs-enviadas', async (req, res) => {
  try {
    const { data } = req.body;
    if (!Array.isArray(data)) return res.status(400).json({ ok: false, erro: 'data deve ser um array' });
    let sha = null;
    try { ({ sha } = await getConciergeFile('msgs-enviadas.json')); } catch(e) {}
    await putConciergeFile('msgs-enviadas.json', data, sha);
    res.json({ ok: true });
  } catch(e) {
    console.error('[concierge/msgs-enviadas POST]', e.message);
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// GET /parceiros — lista parceiros do snapshot filtrados por categoria viagem
const PARCEIROS_VIAGEM = new Set([
  // ✈️ Aéreo / Transporte
  'clickbus', 'flixbus', 'quero passagem', 'uber',
  // 🏨 Hospedagem
  'booking', 'decolar', 'hoteis.com', 'hotel nacional', 'hope resort',
  'beach park hospedagens', 'summerville', 'wala place', 'grupo dreams', 'luxury loyalty',
  // 🚗 Locação de Carro
  'avis', 'budget', 'hertz', 'localiza internacional', 'localiza meoo',
  'movida', 'rentcars', 'reservecar', 'sixt', 'unidas',
  // 🎯 Passeios / Entretenimento
  'agaxtur cruzeiros', 'agaxtur viagens e turismo', 'beach park ingressos',
  'beto carrero world', 'civitatis', 'easy live entreterimento',
  'horas mágicas', 'hot beach', 'mundos infinitos', 'seus ingressos', 'viajar',
  // 🛡️ Seguros de Viagem
  'allianz travel', 'assist card', 'ciclic seguro viagem', 'coris',
  'hero seguro viagem', 'liga vitória - seguro de viagem', 'next seguro viagem',
  'seguro viagem bradesco', 'sulamérica seguro viagem', 'tokio marine seguros',
  'universal assistance – seguro viagem',
  // 🧳 Acessórios e Serviços de Viagem
  'airport park', 'airport park - guarulhos', 'bagaggio', 'portal das malas',
  'samsonite', 'thule', 'travelex', 'tripchip', 'wavee, seu esim global', 'nomad'
]);

app.get('/parceiros', async (req, res) => {
  try {
    const filtroViagem = req.query.viagem !== 'false'; // padrão: filtra por viagem
    const apiBase = `https://api.github.com/repos/${GITHUB_REPO}/contents/historico.json`;
    const headers = { 'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json' };
    const getRes = await fetch(apiBase, { compress: false, headers });
    const getData = await getRes.json();
    const historico = JSON.parse(Buffer.from(getData.content, 'base64').toString('utf8'));
    const dates = Object.keys(historico).sort();
    const last = historico[dates[dates.length - 1]] || {};
    let parceiros = Object.entries(last)
      .filter(([nome]) => !filtroViagem || PARCEIROS_VIAGEM.has(nome))
      .map(([nome, info]) => ({
        nome,
        programas: typeof info === 'object' && info.programs ? Object.keys(info.programs) : []
      }))
      .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
    res.json({ ok: true, data: parceiros, atualizadoEm: dates[dates.length - 1] });
  } catch(e) {
    console.error('[/parceiros]', e.message);
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// POST /concierge/alerta — cria alerta de compra bonificada do concierge (disparo via WhatsApp)
app.post('/concierge/alerta', async (req, res) => {
  const { parceiro, programa, minPts, grupoWhatsApp, viagemId, viagemNome, atividadeNome, atividadeTitulo } = req.body || {};
  if (!parceiro || !programa || !minPts || !grupoWhatsApp) {
    return res.status(400).json({ ok: false, erro: 'Campos obrigatórios: parceiro, programa, minPts, grupoWhatsApp' });
  }
  try {
    const apiBase = `https://api.github.com/repos/davileles/concierge/contents/alertas-concierge.json`;
    const headers = {
      'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json'
    };
    let alertas = [], sha = null;
    try {
      const getRes = await fetch(apiBase, { compress: false, headers });
      const getData = await getRes.json();
      sha = getData.sha;
      alertas = JSON.parse(Buffer.from(getData.content, 'base64').toString('utf8'));
    } catch(e) {}

    // Upsert: mesmo parceiro + programa + viagem
    const idx = alertas.findIndex(a => a.parceiro === parceiro && a.programa === programa && a.viagemId === viagemId);
    const novo = {
      tipo: 'concierge',
      parceiro, programa, minPts: parseFloat(minPts),
      grupoWhatsApp, viagemId, viagemNome,
      atividadeNome, atividadeTitulo,
      criadoEm: new Date().toISOString()
    };
    if (idx >= 0) { alertas[idx] = { ...alertas[idx], ...novo, atualizadoEm: new Date().toISOString() }; }
    else { alertas.push(novo); }

    const body = { message: `chore: alerta concierge ${parceiro} (${programa} ≥ ${minPts})`, content: Buffer.from(JSON.stringify(alertas, null, 2)).toString('base64') };
    if (sha) body.sha = sha;
    await fetch(apiBase, { compress: false, method: 'PUT', headers, body: JSON.stringify(body) });
    res.json({ ok: true });
  } catch(e) {
    console.error('[concierge/alerta POST]', e.message);
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// GET /concierge/alertas — lista alertas de compra bonificada do concierge
app.get('/concierge/alertas', async (req, res) => {
  try {
    const apiBase = `https://api.github.com/repos/davileles/concierge/contents/alertas-concierge.json`;
    const headers = { 'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json' };
    const getRes = await fetch(apiBase, { compress: false, headers });
    const getData = await getRes.json();
    const alertas = JSON.parse(Buffer.from(getData.content, 'base64').toString('utf8'));
    res.json({ ok: true, data: alertas });
  } catch(e) {
    res.json({ ok: true, data: [] });
  }
});

// DELETE /concierge/alerta — remove alerta específico
app.delete('/concierge/alerta', async (req, res) => {
  const { parceiro, programa, viagemId } = req.body || {};
  try {
    const apiBase = `https://api.github.com/repos/davileles/concierge/contents/alertas-concierge.json`;
    const headers = { 'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' };
    const getRes = await fetch(apiBase, { compress: false, headers });
    const getData = await getRes.json();
    let alertas = JSON.parse(Buffer.from(getData.content, 'base64').toString('utf8'));
    alertas = alertas.filter(a => !(a.parceiro === parceiro && a.programa === programa && a.viagemId === viagemId));
    await fetch(apiBase, { compress: false, method: 'PUT', headers, body: JSON.stringify({ message: `chore: remove alerta ${parceiro} (${programa})`, content: Buffer.from(JSON.stringify(alertas, null, 2)).toString('base64'), sha: getData.sha }) });
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════
//  POST /roteiros/publicar
//  Recebe: { slug, html (base64 ou string), viagemId? }
//  - Faz commit do HTML em davileles/roteiros/{slug}/index.html
//  - Se viagemId fornecido, atualiza viagem no concierge com slugRoteiro + urlRoteiro
// ══════════════════════════════════════════════════════════════════
app.post('/roteiros/publicar', async (req, res) => {
  const { slug, html, htmlBase64, viagemId } = req.body || {};

  if (!slug) return res.status(400).json({ ok: false, erro: 'slug obrigatório' });

  const htmlContent = html || (htmlBase64 ? Buffer.from(htmlBase64, 'base64').toString('utf-8') : null);
  if (!htmlContent) return res.status(400).json({ ok: false, erro: 'html ou htmlBase64 obrigatório' });

  const ROTEIROS_REPO = 'davileles/roteiros';
  const caminho = `${slug}/index.html`;
  const ghHeaders = {
    'Authorization': `token ${GITHUB_TOKEN}`,
    'User-Agent': 'cdv-proxy',
    'Accept': 'application/vnd.github+json',
    'Content-Type': 'application/json'
  };

  try {
    // 1. Buscar SHA existente (se o arquivo já existe)
    let shaBefore = null;
    try {
      const checkRes = await fetch(`https://api.github.com/repos/${ROTEIROS_REPO}/contents/${caminho}`, {
        headers: ghHeaders
      });
      if (checkRes.ok) {
        const checkData = await checkRes.json();
        shaBefore = checkData.sha || null;
      }
    } catch(e) { /* arquivo não existe ainda */ }

    // 2. Commit do HTML no repositório roteiros
    const putBody = {
      message: `roteiro: ${slug}`,
      content: Buffer.from(htmlContent).toString('base64')
    };
    if (shaBefore) putBody.sha = shaBefore;

    const putRes = await fetch(`https://api.github.com/repos/${ROTEIROS_REPO}/contents/${caminho}`, {
      method: 'PUT',
      headers: ghHeaders,
      body: JSON.stringify(putBody)
    });

    if (!putRes.ok) {
      const putErr = await putRes.json().catch(() => ({}));
      throw new Error(putErr.message || `GitHub PUT falhou (${putRes.status})`);
    }

    const url = `https://davileles.github.io/roteiros/${slug}/`;

    // 3. Se viagemId fornecido, atualizar viagem no concierge com slugRoteiro + urlRoteiro
    if (viagemId) {
      try {
        const { content: viagens, sha: viagensSha } = await getConciergeFile('viagens.json');
        const idx = viagens.findIndex(v => v.id === viagemId);
        if (idx !== -1) {
          viagens[idx].slugRoteiro = slug;
          viagens[idx].urlRoteiro  = url;
          viagens[idx].roteiroPubEm = new Date().toISOString().split('T')[0];
          await putConciergeFile('viagens.json', viagens, viagensSha);
        }
      } catch(e) {
        console.warn('[roteiros/publicar] Aviso: não atualizou viagem no concierge:', e.message);
        // Não falha — o commit do HTML já foi feito
      }
    }

    res.json({ ok: true, url, slug, viagemAtualizada: !!viagemId });

  } catch(e) {
    console.error('[roteiros/publicar]', e.message);
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// GET /roteiros/publicar?slug=xxx — verifica se roteiro já existe e retorna URL
app.get('/roteiros/publicar', async (req, res) => {
  const slug = (req.query.slug || '').trim();
  if (!slug) return res.status(400).json({ ok: false, erro: 'slug obrigatório' });
  const ROTEIROS_REPO = 'davileles/roteiros';
  try {
    const checkRes = await fetch(`https://api.github.com/repos/${ROTEIROS_REPO}/contents/${slug}/index.html`, {
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'User-Agent': 'cdv-proxy',
        'Accept': 'application/vnd.github+json'
      }
    });
    if (checkRes.ok) {
      res.json({ ok: true, existe: true, url: `https://davileles.github.io/roteiros/${slug}/` });
    } else {
      res.json({ ok: true, existe: false });
    }
  } catch(e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});


// ══════════════════════════════════════════════════════════════
//  POST /roteiros/doc-upload
//  Body: { slug, docId, nome, tipo, base64, mediaType }
//  Salva o arquivo em davileles/roteiros/{slug}/docs/{docId}
//  e atualiza docs-meta.json com metadados
// ══════════════════════════════════════════════════════════════
app.post('/roteiros/doc-upload', async (req, res) => {
  try {
    const { slug, docId, nome, tipo, base64: fileB64, mediaType } = req.body;
    if (!slug || !docId || !fileB64) return res.status(400).json({ ok: false, erro: 'Parâmetros incompletos' });

    const ROTEIROS_REPO = 'davileles/roteiros';
    const GH = 'https://api.github.com';
    const headers = {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'User-Agent': 'cdv-proxy',
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json'
    };

    // 1. Salvar arquivo binário
    const filePath = `${slug}/docs/${docId}`;
    let fileSha;
    try {
      const checkRes = await fetch(`${GH}/repos/${ROTEIROS_REPO}/contents/${filePath}`, { headers });
      if (checkRes.ok) { const d = await checkRes.json(); fileSha = d.sha; }
    } catch(e) {}

    const filePayload = { message: `doc: ${slug}/${docId}`, content: fileB64, ...(fileSha ? { sha: fileSha } : {}) };
    const fileRes = await fetch(`${GH}/repos/${ROTEIROS_REPO}/contents/${filePath}`, {
      method: 'PUT', headers, body: JSON.stringify(filePayload)
    });
    if (!fileRes.ok) throw new Error('Erro ao salvar arquivo: ' + (await fileRes.text()));

    // 2. Atualizar docs-meta.json
    const metaPath = `${slug}/docs-meta.json`;
    let meta = {}, metaSha;
    try {
      const metaRes = await fetch(`${GH}/repos/${ROTEIROS_REPO}/contents/${metaPath}`, { headers });
      if (metaRes.ok) {
        const d = await metaRes.json();
        metaSha = d.sha;
        meta = JSON.parse(Buffer.from(d.content.replace(/\n/g,''), 'base64').toString('utf-8'));
      }
    } catch(e) {}

    meta[docId] = { nome: nome||docId, tipo: tipo||'', mediaType: mediaType||'application/octet-stream', uploadEm: new Date().toISOString() };
    const metaB64 = Buffer.from(JSON.stringify(meta, null, 2)).toString('base64');
    const metaPayload = { message: `doc-meta: ${slug}`, content: metaB64, ...(metaSha ? { sha: metaSha } : {}) };
    await fetch(`${GH}/repos/${ROTEIROS_REPO}/contents/${metaPath}`, {
      method: 'PUT', headers, body: JSON.stringify(metaPayload)
    });

    const rawUrl = `https://raw.githubusercontent.com/${ROTEIROS_REPO}/main/${filePath}`;
    res.json({ ok: true, rawUrl, docId });
  } catch(e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  DELETE /roteiros/doc-upload
//  Body: { slug, docId }
//  Remove o arquivo e atualiza docs-meta.json
// ══════════════════════════════════════════════════════════════
app.delete('/roteiros/doc-upload', async (req, res) => {
  try {
    const { slug, docId } = req.body;
    if (!slug || !docId) return res.status(400).json({ ok: false, erro: 'Parâmetros incompletos' });

    const ROTEIROS_REPO = 'davileles/roteiros';
    const GH = 'https://api.github.com';
    const headers = {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'User-Agent': 'cdv-proxy',
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json'
    };

    // Deletar arquivo
    const filePath = `${slug}/docs/${docId}`;
    try {
      const checkRes = await fetch(`${GH}/repos/${ROTEIROS_REPO}/contents/${filePath}`, { headers });
      if (checkRes.ok) {
        const d = await checkRes.json();
        await fetch(`${GH}/repos/${ROTEIROS_REPO}/contents/${filePath}`, {
          method: 'DELETE', headers,
          body: JSON.stringify({ message: `doc-remove: ${slug}/${docId}`, sha: d.sha })
        });
      }
    } catch(e) {}

    // Atualizar meta
    const metaPath = `${slug}/docs-meta.json`;
    let meta = {}, metaSha;
    try {
      const metaRes = await fetch(`${GH}/repos/${ROTEIROS_REPO}/contents/${metaPath}`, { headers });
      if (metaRes.ok) {
        const d = await metaRes.json();
        metaSha = d.sha;
        meta = JSON.parse(Buffer.from(d.content.replace(/\n/g,''), 'base64').toString('utf-8'));
      }
    } catch(e) {}

    delete meta[docId];
    const metaB64 = Buffer.from(JSON.stringify(meta, null, 2)).toString('base64');
    await fetch(`${GH}/repos/${ROTEIROS_REPO}/contents/${metaPath}`, {
      method: 'PUT', headers,
      body: JSON.stringify({ message: `doc-meta: ${slug}`, content: metaB64, ...(metaSha ? { sha: metaSha } : {}) })
    });

    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  GET /roteiros/doc-upload?slug=xxx
//  Retorna docs-meta.json do roteiro
// ══════════════════════════════════════════════════════════════
app.get('/roteiros/doc-upload', async (req, res) => {
  try {
    const { slug } = req.query;
    if (!slug) return res.status(400).json({ ok: false, erro: 'slug obrigatório' });

    const ROTEIROS_REPO = 'davileles/roteiros';
    const GH = 'https://api.github.com';
    const headers = { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'cdv-proxy', 'Accept': 'application/vnd.github+json', 'Cache-Control': 'no-cache' };

    const metaRes = await fetch(`${GH}/repos/${ROTEIROS_REPO}/contents/${slug}/docs-meta.json`, { headers });
    if (!metaRes.ok) return res.json({ ok: true, docs: {} });
    const d = await metaRes.json();
    const meta = JSON.parse(Buffer.from(d.content.replace(/\n/g,''), 'base64').toString('utf-8'));
    res.json({ ok: true, docs: meta });
  } catch(e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});


// ══════════════════════════════════════════════════════════════
//  POST /roteiros/doc-meta
//  Body: { slug, meta }
//  Salva o docs-meta.json completo (inclui _deletedCards, _extraCards)
// ══════════════════════════════════════════════════════════════
app.post('/roteiros/doc-meta', async (req, res) => {
  try {
    const { slug, meta } = req.body;
    if (!slug || !meta) return res.status(400).json({ ok: false, erro: 'Parâmetros incompletos' });

    const ROTEIROS_REPO = 'davileles/roteiros';
    const GH = 'https://api.github.com';
    const headers = {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'User-Agent': 'cdv-proxy',
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json'
    };

    const metaPath = `${slug}/docs-meta.json`;
    let metaSha;
    try {
      const checkRes = await fetch(`${GH}/repos/${ROTEIROS_REPO}/contents/${metaPath}`, { headers });
      if (checkRes.ok) { const d = await checkRes.json(); metaSha = d.sha; }
    } catch(e) {}

    const metaB64 = Buffer.from(JSON.stringify(meta, null, 2)).toString('base64');
    const payload = { message: `doc-meta: ${slug}`, content: metaB64, ...(metaSha ? { sha: metaSha } : {}) };
    await fetch(`${GH}/repos/${ROTEIROS_REPO}/contents/${metaPath}`, {
      method: 'PUT', headers, body: JSON.stringify(payload)
    });

    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// ── Resolver e salvar links diretos dos parceiros Tier1 ──────────────────────
// POST /parceiros/resolver-links
// Roda uma vez (ou manualmente quando necessário).
// Varre todos os parceiros do snapshot mais recente, acessa a página de cada
// um no Comparemania via fetch interno (Railway tem acesso), extrai o link
// /redirecionar/oferta de cada programa e salva em historico.json[data][parceiro].links
app.post('/parceiros/resolver-links', async (req, res) => {
  if (!GITHUB_TOKEN) return res.status(500).json({ ok: false, erro: 'GITHUB_TOKEN não configurado' });

  // Estratégia: busca as 4 páginas de listagem do Comparemania (uma por programa),
  // extrai o href de cada parceiro na tabela + segue para a página do parceiro
  // para pegar o link /redirecionar/oferta que vai direto ao programa de fidelidade.
  // Salva em historico.json[data][parceiro].links[prog].

  const PROGS = [
    { id: 'livelo', url: 'https://www.comparemania.com.br/lojas/pontos-milhas/programa-fidelidade-livelo' },
    { id: 'esfera', url: 'https://www.comparemania.com.br/lojas/pontos-milhas/programa-fidelidade-santander-esfera' },
    { id: 'smiles', url: 'https://www.comparemania.com.br/lojas/pontos-milhas/programa-fidelidade-smiles' },
    { id: 'azul',   url: 'https://www.comparemania.com.br/lojas/pontos-milhas/programa-fidelidade-tudo-azul' },
  ];

  const TIER1 = new Set([
    'booking', 'hoteis.com', 'decolar',
    'mercado livre', 'casas bahia', 'magazine luiza', 'shopee',
    'netshoes', 'centauro', 'carrefour mercado', 'extra',
    'pão de açúcar', 'drogasil', 'ultrafarma', 'lojas renner', 'c&a', 'riachuelo',
  ]);
  const processarTodos = req.body && req.body.todos === true;

  const FHEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Encoding': 'identity',
    'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Upgrade-Insecure-Requests': '1',
  };

  async function fetchHtml(url, timeoutMs = 20000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { compress: false, headers: FHEADERS, signal: ctrl.signal });
      clearTimeout(t);
      console.log(`[ResolveLinks] ${url.substring(0,80)} → ${r.status}`);
      if (!r.ok) return '';
      return await r.text();
    } catch(e) { clearTimeout(t); console.log(`[ResolveLinks] erro: ${e.message}`); return ''; }
  }

  // Extrai parceiros e seus hrefs da tabela da página de listagem do programa
  function extrairParceiros(html) {
    const result = {};
    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let row;
    while ((row = rowRe.exec(html)) !== null) {
      const cells = row[1].split(/<\/td>/i);
      if (cells.length < 2) continue;
      const aMatch = cells[0].match(/<a([^>]*)>([\s\S]*?)<\/a>/i);
      if (!aMatch) continue;
      const name = aMatch[2].replace(/<[^>]*>/g, '').trim().toLowerCase();
      if (!name) continue;
      const hrefMatch = aMatch[1].match(/href=["']([^"']+)["']/i);
      if (!hrefMatch) continue;
      const raw = hrefMatch[1];
      const partnerPageUrl = raw.startsWith('http') ? raw : 'https://www.comparemania.com.br' + raw;
      result[name] = partnerPageUrl;
    }
    return result;
  }

  // Extrai o link /redirecionar/oferta da página individual do parceiro
  function extrairRedirect(html) {
    const m = html.match(/href=["']((?:https?:\/\/www\.comparemania\.com\.br)?\/redirecionar\/oferta[^"']+)["']/i);
    if (!m) return '';
    return m[1].startsWith('http') ? m[1] : 'https://www.comparemania.com.br' + m[1];
  }

  try {
    const hist = await ghGetJson('historico.json', {});
    const datas = Object.keys(hist.data).sort();
    if (datas.length === 0) return res.status(400).json({ ok: false, erro: 'historico.json vazio' });

    const resolved = {};  // { parceiro: { prog: redirectUrl } }
    let total = 0, salvos = 0;
    const erros = [];

    for (const prog of PROGS) {
      // Passo 1: busca página de listagem do programa
      const listHtml = await fetchHtml(prog.url);
      if (!listHtml) { console.log(`[ResolveLinks] sem HTML para ${prog.id}`); continue; }

      const parceiros = extrairParceiros(listHtml);
      console.log(`[ResolveLinks] ${prog.id}: ${Object.keys(parceiros).length} parceiros na listagem`);

      // Passo 2: para cada parceiro (tier1 ou todos), busca a página individual
      for (const [nome, partnerPageUrl] of Object.entries(parceiros)) {
        if (!processarTodos && !TIER1.has(nome)) continue;
        total++;

        const partnerHtml = await fetchHtml(partnerPageUrl);
        const redirectUrl = extrairRedirect(partnerHtml);

        if (redirectUrl) {
          if (!resolved[nome]) resolved[nome] = {};
          resolved[nome][prog.id] = redirectUrl;
          salvos++;
          console.log(`[ResolveLinks] ✓ ${nome}/${prog.id}`);
        } else {
          erros.push(`${nome}/${prog.id}`);
          console.log(`[ResolveLinks] ✗ sem redirect: ${nome}/${prog.id}`);
        }

        // Também salva a URL da página do parceiro no historico (usada como fallback)
        const dataRecente = datas[datas.length - 1];
        for (const data of datas) {
          const snap = hist.data[data];
          if (snap[nome] && !snap[nome].partnerUrl) {
            snap[nome].partnerUrl = {};
          }
          if (snap[nome]) snap[nome].partnerUrl = snap[nome].partnerUrl || {};
          if (snap[nome]) snap[nome].partnerUrl[prog.id] = partnerPageUrl;
        }

        await new Promise(r => setTimeout(r, 300));
      }
    }

    // Salva links /redirecionar/oferta em historico.json em todas as datas
    for (const data of datas) {
      for (const [parceiro, links] of Object.entries(resolved)) {
        if (!hist.data[data][parceiro]) continue;
        if (!hist.data[data][parceiro].links) hist.data[data][parceiro].links = {};
        Object.assign(hist.data[data][parceiro].links, links);
      }
    }

    await ghPutJson('historico.json', hist.data, hist.sha, `chore: salva links diretos de ${salvos} parceiros (resolve via listagem)`);

    res.json({ ok: true, total, salvos, erros: erros.length, falhas: erros });
  } catch(e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});


// ── Diagnóstico: testar fetch de URL do Comparemania ─────────────────────────
app.get('/parceiros/testar-fetch', async (req, res) => {
  const url = req.query.url || 'https://www.comparemania.com.br/cashback-mercado-livre';
  const buscar = (req.query.buscar || '').toLowerCase(); // ex: ?buscar=centauro
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Encoding': 'identity',
    'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Upgrade-Insecure-Requests': '1',
  };
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 15000);
    const r = await fetch(url, { compress: false, headers, signal: ctrl.signal });
    const body = await r.text();
    const temTabela = /<table/i.test(body);
    const temTr = /<tr/i.test(body);
    // Extrair todas as linhas da tabela com nome + href
    const trs = body.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    const linhas = trs.map(t => {
      const txt = t.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
      const hm = t.match(/href=["']([^"']+)["']/i);
      return { txt: txt.substring(0,120), href: hm ? hm[1] : '' };
    }).filter(l => l.txt.length > 3);
    // Se ?buscar=termo, filtra linhas que contenham o termo + 200 chars de contexto HTML
    let resultado, contextoHtml = '';
    if (buscar) {
      resultado = linhas.filter(l => l.txt.toLowerCase().includes(buscar));
      const pos = body.toLowerCase().indexOf(buscar);
      if (pos !== -1) contextoHtml = body.substring(Math.max(0, pos-300), pos+500);
      // Também buscar ocorrências de redirecionar na página
      const redirPos = body.indexOf('redirecionar');
      const temRedirJS = body.includes('redirecionar');
      contextoHtml += ' ||| temRedirecionar=' + temRedirJS + (redirPos > -1 ? ' pos=' + redirPos + ' ctx=' + body.substring(Math.max(0,redirPos-100), redirPos+200) : '');
    } else {
      resultado = linhas.slice(0,10);
    }
    res.json({
      url, status: r.status, ok: r.ok,
      bodyLen: body.length, temTabela, temTr,
      totalLinhas: linhas.length,
      resultado,
      contextoHtml,
    });
  } catch(e) {
    res.json({ url, erro: e.message });
  }
});


// ══════════════════════════════════════════════════════════════════════════════
// SALAS VIP — busca por aeroporto (LoungeKey + DragonPass + Priority Pass)
// ══════════════════════════════════════════════════════════════════════════════

const LOUNGES_DB_PATH = 'lounges-db.json';

// ─── LoungeReview parser ──────────────────────────────────────────────────────

function lrExtrairSlugs(html, iata) {
  // Extrai slugs de salas da página de busca do Google: site:loungereview.com/lounges/ IATA
  const slugs = new Set();
  const re = /loungereview\.com\/lounges\/([\w-]+(?:-' + iata.toLowerCase() + r'[\w-]*|[\w-]*-' + iata.toLowerCase() + r'[\w-]*))\//gi;
  // Padrão direto: qualquer link /lounges/algo-GRU-algo/
  const reLinks = /loungereview\.com\/lounges\/([\w-]+)\//gi;
  let m;
  while ((m = reLinks.exec(html)) !== null) {
    const slug = m[1].toLowerCase();
    // filtra slugs que contenham o IATA
    if (slug.includes(iata.toLowerCase())) {
      slugs.add(slug);
    }
  }
  return [...slugs];
}

function lrExtrairDetalhes(html, slug) {
  const strip = s => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').replace(/[\u200b-\u200f\u2028\u2029\uFEFF]/g, '').trim();

  // Nome
  let nome = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) nome = strip(h1[1]);
  else {
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (titleMatch) nome = strip(titleMatch[1]).replace(/\s*[-|].*$/, '').replace(/- LoungeReview\.com.*/i, '').trim();
  }

  // Horários
  let horario = '';
  if (/open 24 hours|24\s*hours/i.test(html)) {
    horario = '24h';
  } else {
    const hMatch = html.match(/(\d{1,2}:\d{2}\s*(?:am|pm)\s*[-–to]+\s*\d{1,2}:\d{2}\s*(?:am|pm))/i)
                || html.match(/(\d{2}:\d{2}\s*[-–]\s*\d{2}:\d{2})/);
    if (hMatch) horario = hMatch[1].replace(/\s+/g, ' ').trim();
  }

  // Localização
  let localizacao = '';
  const locP1 = html.match(/\([A-Z]{3}\)\s*[–-]\s*(Terminal[\s\S]{10,300}?)(?:<|\n{2})/i);
  const locP2 = html.match(/(Terminal\s+\d[^<.]{10,250}(?:security|gate)[^<.]{0,100}\.)/i);
  const locP3 = html.match(/((?:after|before|airside|landside)[^<.]{10,250}(?:terminal|gate|level|security)[^<.]{0,150}\.)/i);
  if (locP1) localizacao = strip(locP1[1]).substring(0, 300);
  else if (locP2) localizacao = strip(locP2[1]).substring(0, 300);
  else if (locP3) localizacao = strip(locP3[1]).substring(0, 300);

  // Amenidades
  const amenidades = { comida: [], bebida: [], outros: [] };
  const extractList = (sectionHtml) => {
    if (!sectionHtml) return [];
    const liItems = sectionHtml.match(/<li[^>]*>([\s\S]*?)<\/li>/gi);
    if (liItems) return liItems.map(li => strip(li)).filter(s => s.length > 1 && s.length < 80);
    return sectionHtml.split(/[,;]/).map(s => strip(s)).filter(s => s.length > 2 && s.length < 60);
  };
  const foodSect  = html.match(/(?:Food|Comida)[:\s]*(<ul[\s\S]*?<\/ul>|[\s\S]{10,300}?)(?:Drink|Beverage|Other amenities|Overview|Access)/i);
  const drinkSect = html.match(/(?:Drinks?|Beverages?)[:\s]*(<ul[\s\S]*?<\/ul>|[\s\S]{10,300}?)(?:Other amenities|Overview|Access|$)/i);
  const otherSect = html.match(/(?:Other amenities?)[:\s]*(<ul[\s\S]*?<\/ul>|[\s\S]{10,300}?)(?:Overview|Access rules|Comments|Reviews|$)/i);
  amenidades.comida = extractList(foodSect?.[1]).slice(0, 12);
  amenidades.bebida = extractList(drinkSect?.[1]).slice(0, 10);
  amenidades.outros = extractList(otherSect?.[1]).slice(0, 12);
  if (!amenidades.outros.length) {
    ['Wi-Fi','Shower','Television','Flight monitors','Power outlets','Newspapers','Conference room',
     'Luggage storage','Air conditioning','Kids area','Business center','Printing','Workstations']
      .forEach(kw => { if (new RegExp(kw, 'i').test(html)) amenidades.outros.push(kw); });
  }

  // Overview
  let overview = '';
  const ovMatch = html.match(/<p[^>]*>([\s\S]{80,600}?)<\/p>/i);
  if (ovMatch) {
    const candidate = strip(ovMatch[1]).substring(0, 400);
    if (!/access wizard|install the|log in|create an|buy access/i.test(candidate)) overview = candidate;
  }

  // Programas
  const programas = [];
  if (/lounge\s*key|loungekey/i.test(html)) programas.push('LoungeKey');
  if (/priority\s*pass/i.test(html)) programas.push('Priority Pass');
  if (/dragon\s*pass|dragonpass/i.test(html)) programas.push('DragonPass');
  if (/diners\s*club/i.test(html)) programas.push('Diners Club');

  // Terminal
  let terminal = '';
  const tMatch = html.match(/Terminal\s+([\w\d]+(?:\s*[\(\)\/]\s*[\w\d]+)?)/i);
  if (tMatch) terminal = 'Terminal ' + tMatch[1].trim();

  return { nome, slug, terminal, horario, localizacao, overview, amenidades, programas,
    urlLoungereview: `https://loungereview.com/lounges/${slug}/`,
    urlFotos: `https://loungereview.com/lounges/${slug}/#photos` };
}

async function lrBuscarSalasPorIATA(iata, slugsConhecidos = []) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  const fetchSafe = async (url) => {
    try {
      const r = await fetch(url, { headers, timeout: 15000 });
      if (!r.ok) return '';
      return r.text();
    } catch { return ''; }
  };

  // Usa slugs pré-populados no lounges-db.json
  const slugs = slugsConhecidos.length ? slugsConhecidos : [];

  if (slugs.length === 0) return [];

  // Para cada slug, busca detalhes da página individual em paralelo
  const salas = await Promise.all(slugs.slice(0, 15).map(async slug => {
    const html = await fetchSafe(`https://loungereview.com/lounges/${slug}/`);
    if (!html || html.length < 500) return null;
    // Ignora salas encerradas permanentemente
    if (/CLOSED PERMANENTLY/i.test(html)) return null;
    return lrExtrairDetalhes(html, slug);
  }));

  return salas.filter(Boolean);
}

function extrairLoungesLoungeKey(html, iata) {
  const salas = [];
  const reLoungeLink = /lounge-finder\/lounge\?loungecode=([A-Z0-9]+)/g;
  const blocos = html.match(/<[^>]*(?:lounge-card|lounge-item|result-item)[^>]*>[\s\S]*?<\/[^>]+>/gi) || [];
  blocos.forEach(bloco => {
    const nomeMatch = bloco.match(/class="[^"]*(?:title|name|heading)[^"]*"[^>]*>([\s\S]*?)<\//) ||
                      bloco.match(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/i);
    const terminalMatch = bloco.match(/(?:Terminal|T\d)[^<"]{0,40}/i);
    const horarioMatch = bloco.match(/\d{2}:\d{2}\s*[-–]\s*\d{2}:\d{2}/);
    const codeMatch = bloco.match(/loungecode=([A-Z0-9]+)/i);
    if (nomeMatch) {
      const nome = nomeMatch[1].replace(/<[^>]+>/g, '').trim();
      if (nome.length > 3) {
        salas.push({
          nome,
          terminal: terminalMatch ? terminalMatch[0].trim() : '',
          horario: horarioMatch ? horarioMatch[0] : '',
          url: codeMatch
            ? `https://airport.mastercard.com/pt/lounge-finder/lounge?loungecode=${codeMatch[1]}`
            : `https://airport.mastercard.com/pt/lounge-finder/airport?airportcode=${iata}`
        });
      }
    }
  });
  if (salas.length === 0) {
    let m;
    while ((m = reLoungeLink.exec(html)) !== null) {
      const code = m[1];
      if (!salas.find(s => s.url && s.url.includes(code))) {
        salas.push({ nome: `Sala VIP ${code}`, terminal: '', horario: '',
          url: `https://airport.mastercard.com/pt/lounge-finder/lounge?loungecode=${code}` });
      }
    }
  }
  return salas;
}

function extrairLoungesDragonPass(html, iata) {
  const salas = [];
  const blocos = html.match(/<[^>]*(?:lounge[-_]?card|facility[-_]?card|lounge[-_]?item)[^>]*>[\s\S]*?<\/(?:div|article|section)>/gi) || [];
  blocos.forEach(bloco => {
    const nomeMatch = bloco.match(/<h[234][^>]*>([\s\S]*?)<\/h[234]>/i) ||
                      bloco.match(/class="[^"]*(?:title|name|heading)[^"]*"[^>]*>([\s\S]*?)<\//i);
    const horarioMatch = bloco.match(/\d{2}:\d{2}\s*[-–]\s*\d{2}:\d{2}/);
    const linkMatch = bloco.match(/href="([^"]*explore\/lounge[^"]*)"/i);
    if (nomeMatch) {
      const nome = nomeMatch[1].replace(/<[^>]+>/g, '').trim();
      if (nome.length > 3) {
        salas.push({
          nome, terminal: '', horario: horarioMatch ? horarioMatch[0] : '',
          url: linkMatch ? `https://www.dragonpass.com${linkMatch[1]}`
            : `https://www.dragonpass.com/explore/airport/${iata}`
        });
      }
    }
  });
  return salas;
}

function extrairLoungesPriorityPass(html, iata) {
  const salas = [];
  const blocos = html.match(/<[^>]*(?:lounge[-_]?card|experience[-_]?card|result[-_]?card)[^>]*>[\s\S]*?<\/(?:div|article|li)>/gi) || [];
  blocos.forEach(bloco => {
    const nomeMatch = bloco.match(/<h[234][^>]*>([\s\S]*?)<\/h[234]>/i) ||
                      bloco.match(/class="[^"]*(?:title|name|heading)[^"]*"[^>]*>([\s\S]*?)<\//i);
    const terminalMatch = bloco.match(/Terminal\s*[0-9A-Z\-]+/i);
    const horarioMatch = bloco.match(/\d{2}:\d{2}\s*[-–]\s*\d{2}:\d{2}/);
    if (nomeMatch) {
      const nome = nomeMatch[1].replace(/<[^>]+>/g, '').trim();
      if (nome.length > 3) {
        salas.push({
          nome, terminal: terminalMatch ? terminalMatch[0] : '',
          horario: horarioMatch ? horarioMatch[0] : '',
          url: `https://www.prioritypass.com/pt-BR/airport-lounges?location=${iata}`
        });
      }
    }
  });
  return salas;
}

async function buscarLoungesAoVivo(iata) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.7',
    'Cache-Control': 'no-cache'
  };
  const fetchSafe = async (url) => {
    try {
      const r = await fetch(url, { compress: false, headers, timeout: 15000 });
      if (!r.ok) return '';
      return r.text();
    } catch { return ''; }
  };
  const [htmlLK, htmlDP, htmlPP] = await Promise.all([
    fetchSafe(`https://airport.mastercard.com/pt/lounge-finder/airport?airportcode=${iata}`),
    fetchSafe(`https://www.dragonpass.com/explore/airport/${iata}`),
    fetchSafe(`https://www.prioritypass.com/pt-BR/airport-lounges?location=${iata}`)
  ]);
  return {
    loungekey:    extrairLoungesLoungeKey(htmlLK, iata),
    dragonpass:   extrairLoungesDragonPass(htmlDP, iata),
    prioritypass: extrairLoungesPriorityPass(htmlPP, iata)
  };
}

// GET /lounges/buscar?iata=GRU
// Retorna salas do lounges-db.json (dados pré-catalogados do LoungeReview)
app.get('/lounges/buscar', async (req, res) => {
  const iata = (req.query.iata || '').toUpperCase().trim();
  if (!iata || !/^[A-Z]{3}$/.test(iata)) {
    return res.status(400).json({ ok: false, erro: 'Parâmetro ?iata= deve ter 3 letras (ex: GRU)' });
  }
  try {
    // 1. Cache em memória (mais rápido, sem I/O)
    if (global._loungesCache?.[iata]?.salas?.length) {
      const mem = global._loungesCache[iata];
      return res.json({ ok: true, fonte: 'cache', buscadoEm: mem.buscadoEm,
        aeroporto: mem.aeroporto, salas: mem.salas });
    }

    // 2. Lê do lounges-db.json no GitHub
    const db = await ghGetJson(LOUNGES_DB_PATH, { aeroportos: {} });
    const entrada = db.data.aeroportos?.[iata];

    if (entrada?.salas?.length) {
      // Salva em memória para próximas consultas
      if (!global._loungesCache) global._loungesCache = {};
      global._loungesCache[iata] = {
        salas: entrada.salas,
        buscadoEm: entrada.buscadoEm || null,
        aeroporto: { iata, nome: entrada.nome, cidade: entrada.cidade, pais: entrada.pais }
      };
      return res.json({
        ok: true, fonte: 'cache',
        buscadoEm: entrada.buscadoEm || null,
        aeroporto: { iata, nome: entrada.nome, cidade: entrada.cidade, pais: entrada.pais },
        salas: entrada.salas
      });
    }

    // 3. Aeroporto ainda não catalogado
    return res.json({
      ok: true, fonte: 'sem-dados',
      aeroporto: {
        iata,
        nome: entrada?.nome || `Aeroporto ${iata}`,
        cidade: entrada?.cidade || '',
        pais: entrada?.pais || ''
      },
      salas: []
    });

  } catch (err) {
    console.error('[lounges]', err);
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// GET /lounges/sala?slug=w-lounge-guarulhos-gru-terminal-3
// Busca detalhes de uma sala específica (sempre ao vivo)
app.get('/lounges/sala', async (req, res) => {
  const slug = (req.query.slug || '').replace(/[^a-z0-9-]/gi, '').toLowerCase();
  if (!slug) return res.status(400).json({ ok: false, erro: 'Parâmetro ?slug= obrigatório' });
  try {
    const r = await fetch(`https://loungereview.com/lounges/${slug}/`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      timeout: 15000
    });
    if (!r.ok) return res.status(404).json({ ok: false, erro: 'Sala não encontrada' });
    const html = await r.text();
    const sala = lrExtrairDetalhes(html, slug);
    res.json({ ok: true, sala });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// GET /lounges/aeroportos
app.get('/lounges/aeroportos', async (req, res) => {
  try {
    const db = await ghGetJson(LOUNGES_DB_PATH, { aeroportos: {} });
    const lista = Object.values(db.data.aeroportos || {}).map(a => ({
      iata: a.iata, nome: a.nome, cidade: a.cidade, pais: a.pais
    })).sort((a, b) => a.iata.localeCompare(b.iata));
    res.json({ ok: true, total: lista.length, aeroportos: lista });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});


// ── CONCIERGE: Arquivos de reserva (bilhetes, vouchers) ─────────────────────
// Salva em arquivos/RES-xxx.ext no repo davileles/concierge
// Suporta múltiplos arquivos: arquivos/RES-xxx_0.ext, arquivos/RES-xxx_1.ext ...

// POST /concierge/arquivo
// Body: { reservaId, base64, mediaType, nome }
// Salva o arquivo como arquivos/{reservaId}_{idx}.json contendo { base64, mediaType, nome }
app.post('/concierge/arquivo', async (req, res) => {
  try {
    const { reservaId, base64, mediaType, nome } = req.body || {};
    if (!reservaId || !base64 || !mediaType) {
      return res.status(400).json({ ok: false, erro: 'reservaId, base64 e mediaType são obrigatórios' });
    }
    // Sanitizar reservaId para uso como nome de arquivo
    const safeId = String(reservaId).replace(/[^a-zA-Z0-9\-_]/g, '');
    if (!safeId) return res.status(400).json({ ok: false, erro: 'reservaId inválido' });

    // Descobrir próximo índice disponível (suporte a múltiplos arquivos)
    let idx = 0;
    const apiBase = `https://api.github.com/repos/${CONCIERGE_REPO}/contents/arquivos/`;
    const headers = {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'User-Agent': 'cdv-proxy',
      'Accept': 'application/vnd.github+json'
    };
    try {
      const listRes = await fetch(apiBase, { headers });
      if (listRes.ok) {
        const listData = await listRes.json();
        if (Array.isArray(listData)) {
          const prefix = safeId + '_';
          const existing = listData.filter(f => f.name.startsWith(prefix));
          idx = existing.length;
        }
      }
    } catch(e) { /* pasta pode não existir ainda, idx = 0 */ }

    const filename = `arquivos/${safeId}_${idx}.json`;
    const payload = JSON.stringify({ base64, mediaType, nome: nome || '' });
    const encoded = Buffer.from(payload).toString('base64');

    // Verificar se já existe (para pegar SHA e sobrescrever se necessário)
    let sha = null;
    try {
      const checkRes = await fetch(`https://api.github.com/repos/${CONCIERGE_REPO}/contents/${filename}`, { headers });
      if (checkRes.ok) { const cd = await checkRes.json(); sha = cd.sha || null; }
    } catch(e) {}

    const putBody = {
      message: `arquivo: ${safeId}_${idx}`,
      content: encoded
    };
    if (sha) putBody.sha = sha;

    const putRes = await fetch(`https://api.github.com/repos/${CONCIERGE_REPO}/contents/${filename}`, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(putBody)
    });
    if (!putRes.ok) {
      const putErr = await putRes.json().catch(() => ({}));
      throw new Error(putErr.message || `GitHub PUT falhou (${putRes.status})`);
    }
    res.json({ ok: true, filename, idx });
  } catch(e) {
    console.error('[concierge/arquivo POST]', e.message);
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// GET /concierge/arquivo/:reservaId
// Retorna lista de arquivos da reserva: [{ idx, nome, mediaType, base64 }, ...]
app.get('/concierge/arquivo/:reservaId', async (req, res) => {
  try {
    const safeId = String(req.params.reservaId || '').replace(/[^a-zA-Z0-9\-_]/g, '');
    if (!safeId) return res.status(400).json({ ok: false, erro: 'reservaId inválido' });

    const headers = {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'User-Agent': 'cdv-proxy',
      'Accept': 'application/vnd.github+json'
    };

    // Listar pasta arquivos/
    const listRes = await fetch(`https://api.github.com/repos/${CONCIERGE_REPO}/contents/arquivos/`, { headers });
    if (!listRes.ok) return res.json({ ok: true, arquivos: [] });

    const listData = await listRes.json();
    if (!Array.isArray(listData)) return res.json({ ok: true, arquivos: [] });

    const prefix = safeId + '_';
    const arquivosRepo = listData
      .filter(f => f.name.startsWith(prefix) && f.name.endsWith('.json'))
      .sort((a, b) => a.name.localeCompare(b.name));

    if (!arquivosRepo.length) return res.json({ ok: true, arquivos: [] });

    // Buscar conteúdo de cada arquivo em paralelo
    const resultados = await Promise.all(arquivosRepo.map(async (f) => {
      try {
        // Preferir raw para evitar problema de encoding: none em arquivos grandes
        const rawRes = await fetch(
          `https://raw.githubusercontent.com/${CONCIERGE_REPO}/main/${f.path}`,
          { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'cdv-proxy' } }
        );
        if (!rawRes.ok) return null;
        const text = await rawRes.text();
        const parsed = JSON.parse(text);
        const idxMatch = f.name.match(/_(\d+)\.json$/);
        return { idx: idxMatch ? parseInt(idxMatch[1]) : 0, nome: parsed.nome || f.name, mediaType: parsed.mediaType, base64: parsed.base64 };
      } catch(e) { return null; }
    }));

    res.json({ ok: true, arquivos: resultados.filter(Boolean) });
  } catch(e) {
    console.error('[concierge/arquivo GET]', e.message);
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// DELETE /concierge/arquivo/:reservaId/:idx
// Remove um arquivo específico da reserva
app.delete('/concierge/arquivo/:reservaId/:idx', async (req, res) => {
  try {
    const safeId = String(req.params.reservaId || '').replace(/[^a-zA-Z0-9\-_]/g, '');
    const idx    = parseInt(req.params.idx);
    if (!safeId || isNaN(idx)) return res.status(400).json({ ok: false, erro: 'reservaId ou idx inválido' });

    const filename = `arquivos/${safeId}_${idx}.json`;
    const headers = {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'User-Agent': 'cdv-proxy',
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json'
    };

    // Pegar SHA para poder deletar
    const checkRes = await fetch(`https://api.github.com/repos/${CONCIERGE_REPO}/contents/${filename}`, { headers });
    if (!checkRes.ok) return res.status(404).json({ ok: false, erro: 'Arquivo não encontrado' });
    const checkData = await checkRes.json();

    const delRes = await fetch(`https://api.github.com/repos/${CONCIERGE_REPO}/contents/${filename}`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ message: `remove: ${filename}`, sha: checkData.sha })
    });
    if (!delRes.ok) {
      const delErr = await delRes.json().catch(() => ({}));
      throw new Error(delErr.message || `GitHub DELETE falhou (${delRes.status})`);
    }
    res.json({ ok: true });
  } catch(e) {
    console.error('[concierge/arquivo DELETE]', e.message);
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// ── IA: Gerar reclamação formal (CDC / ANAC 400 / Convenção de Montreal) ──────
app.post('/ia/reclamacao', (req, res) => {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ ok: false, erro: 'ANTHROPIC_API_KEY não configurada no servidor.' });
  }

  const { empresa, servico, data, problema, contato, impacto, solucao, plataforma } = req.body;
  if (!empresa || !problema || !solucao) {
    return res.status(400).json({ ok: false, erro: 'Campos obrigatórios: empresa, problema, solucao.' });
  }

  const plataformaLabel = plataforma === 'reclame_aqui' ? 'Reclame Aqui' : 'Consumidor.gov.br';
  const camposLabel = plataforma === 'reclame_aqui'
    ? '(Título, Categoria, Descrição do Problema, O que você espera da empresa)'
    : '(Problema, Impacto, Solução Esperada)';

  const prompt = `Você é um especialista em defesa do consumidor brasileiro. Redija uma reclamação formal para publicação na plataforma ${plataformaLabel}.

DADOS DO CASO:
- Empresa: ${empresa}
- Serviço: ${servico || 'não especificado'}
- Data do ocorrido: ${data || 'não informada'}
- Problema: ${problema}
- Tentativas de contato: ${contato || 'não realizadas'}
- Impacto sofrido: ${impacto || 'não especificado'}
- Solução esperada: ${solucao}

INSTRUÇÕES:
1. Redija o TEXTO DA RECLAMAÇÃO com linguagem formal, objetiva e fundamentada juridicamente. Estrutura: introdução do caso → descrição detalhada → tentativas de solução → fundamento legal (CDC, Resolução ANAC 400 se for voo, Convenção de Montreal se aplicável) → pedido claro de solução → encerramento respeitoso. Máximo 3.000 caracteres.
2. Sugira um TÍTULO para a reclamação (máximo 100 caracteres, direto e descritivo).
3. Preencha os CAMPOS DA PLATAFORMA específicos para ${plataformaLabel} ${camposLabel}.

Responda APENAS em JSON válido, sem markdown, sem texto fora do JSON:
{"texto":"texto completo da reclamação","titulo":"sugestão de título","campos":"campos formatados como CAMPO: valor\nCAMPO: valor"}`;

  const bodyPayload = JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }]
  });

  const https = require('https');
  const options = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(bodyPayload),
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    }
  };

  const chunks = [];
  const apiReq = https.request(options, (apiRes) => {
    apiRes.on('data', (chunk) => { chunks.push(chunk); });
    apiRes.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      console.log('[ia/reclamacao] status:', apiRes.statusCode, 'raw len:', raw.length, 'preview:', raw.slice(0,120));
      try {
        const parsed = JSON.parse(raw);
        if (parsed.error) { console.error('[ia/reclamacao] API error:', parsed.error); return res.json({ ok: false, erro: parsed.error.message }); }
        const texto = (parsed.content && parsed.content[0] && parsed.content[0].text) || '';
        const clean = texto.replace(/```json|```/g, '').trim();
        try {
          const result = JSON.parse(clean);
          return res.json({ ok: true, ...result });
        } catch(e) {
          console.error('[ia/reclamacao] JSON parse error:', e.message, 'clean:', clean.slice(0,300));
          return res.json({ ok: false, erro: 'Resposta inesperada da IA.', raw: clean });
        }
      } catch(e) {
        console.error('[ia/reclamacao] outer parse error:', e.message, 'raw:', raw.slice(0,300));
        return res.json({ ok: false, erro: 'Erro ao processar resposta da IA.' });
      }
    });
  });
  apiReq.on('error', (e) => { console.error('[ia/reclamacao] req error:', e.message); res.json({ ok: false, erro: e.message }); });
  apiReq.setTimeout(55000, () => { apiReq.destroy(); res.json({ ok: false, erro: 'Timeout ao chamar API Anthropic.' }); });
  apiReq.write(bodyPayload);
  apiReq.end();
});

// ── IA: Assistente de Roteiros (conversacional — sem publicar HTML/PDF) ──
// Body: { messages: [{role:'user'|'assistant', content:'...'}, ...] }
// O front envia o histórico completo a cada turno; o proxy injeta o system prompt
// e repassa para a Anthropic, devolvendo apenas a próxima mensagem do assistente.
app.post('/ia/roteiro-chat', (req, res) => {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ ok: false, erro: 'ANTHROPIC_API_KEY não configurada no servidor.' });
  }

  const { messages } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ ok: false, erro: 'Campo obrigatório: messages (array não vazio).' });
  }

  // Sanitiza: só role/content, role sempre user|assistant, alternância válida
  const historico = messages
    .filter(m => m && typeof m.content === 'string' && m.content.trim() && (m.role === 'user' || m.role === 'assistant'))
    .map(m => ({ role: m.role, content: m.content.trim() }));
  if (!historico.length || historico[historico.length - 1].role !== 'user') {
    return res.status(400).json({ ok: false, erro: 'A última mensagem do histórico precisa ser do usuário.' });
  }

  const systemPrompt = `Você é um assistente de viagens conversacional chamado "Assistente de Roteiros", parte do Clube do Viajante. Sua missão é criar roteiros ultra detalhados, realistas e eficientes, adaptados ao estilo do usuário.

REGRAS CRÍTICAS:
- Faça SEMPRE uma pergunta por vez. Espere a resposta antes de prosseguir.
- Seja caloroso, entusiasmado e use emojis com moderação.
- Use linguagem clara, informal mas profissional (pt-BR).
- Nunca invente informações sobre locais ou horários. Se não tiver certeza, avise e diga como confirmar.
- Inclua sempre horários sugeridos, preços estimados e necessidade de reservas.
- Para cada atração, indique como chegar a partir do hotel ou atração anterior.
- Sempre pontue e faça referência ao que o usuário já informou nas respostas anteriores antes de fazer a próxima pergunta (ex: "Perfeito, viagem romântica para Paris em outubro! Agora me conta...").
- NÃO ofereça, mencione ou execute qualquer publicação, geração de HTML, PDF ou envio — sua única tarefa nesta conversa é planejar e redigir o roteiro em texto.

FLUXO DE PERGUNTAS (uma por vez, espere a resposta antes de avançar):
1. Destino da viagem (cidade, região, país)
2. Datas ou duração da viagem + horários de chegada/partida se já tiver voo
3. Com quem viajará (sozinho, casal, família com idades dos filhos, amigos)
4. Hospedagem: já reservada (nome/localização) ou preferência (econômico/equilibrado/luxo, bairro preferido)
5. Tipo de viagem (romântica, aventura, cultural, gastronômica, descanso, com filhos, etc.)
6. Já visitou o destino? O que gostou/não gostou?
7. Orçamento por dia por pessoa (ou: econômico/equilibrado/luxo)
8. Preferências: experiências pagas, gratuitas ou mistas; prioridades (gastronomia, natureza, compras, história…)
9. Atrações obrigatórias — ANTES de perguntar, sugira 7-10 atrações comuns do destino informado na pergunta 1
10. Restrições especiais (mobilidade, alimentação, carrinho de bebê, acessibilidade, horários)
11. Ritmo preferido (intenso / leve / meio-termo)

Após a pergunta 11:
- Elogie as escolhas e faça um RESUMO do que foi pedido
- Informe clima/temperatura média na época + dicas rápidas (roupas, horários de pico, reservas antecipadas)
- Diga: "Tenho tudo para montar o roteiro! Vou preparar os Dias 1 e 2 agora. Posso começar?"

ENTREGA DO ROTEIRO — sempre em blocos de 2 dias. Ao final de cada bloco, pergunte se está OK e se quer ajustes antes de continuar.

ESTRUTURA OBRIGATÓRIA PARA CADA DIA:

📅 **DIA [N] – [DIA E MÊS] | [TÍTULO RESUMO DO DIA]**

📋 **RESUMO**
[2-4 linhas com storytelling curto do dia]

🔋 **NÍVEL DE ENERGIA:** [Leve / Moderado / Intenso]

🏨 **SAÍDA DO HOTEL:** [HH:MM]

🚶 **ITINERÁRIO**

**[HH:MM – HH:MM] | [Nome da Atração]**
- [O que é e por que fazer — 2-3 linhas]
- 💡 Dica: [dica prática sobre fila, reserva, melhor horário, tempo médio]

[linha em branco entre cada atração]

🧭 **DESLOCAMENTOS**
- [Atração A → Atração B]: [como ir, tempo estimado, custo]

💰 **CUSTOS ESTIMADOS (por pessoa)**
- [Item]: R$ [valor]
- Total estimado do dia: R$ [valor]

🍽️ **RESTAURANTES SUGERIDOS**
1. **[Nome]** — [tipo] | [diferencial] | ~R$ [valor médio] por pessoa

🔗 **LINKS ÚTEIS**
- [Site oficial, Viator, GetYourGuide ou transporte público quando relevante]

Ao final de cada bloco de 2 dias pergunte: "Os dias ficaram bons? Quer ajustar algo ou posso ir para os próximos dias?"

FINALIZAÇÃO — quando terminar TODOS os dias:
1. Apresente tabela de resumo: Dia | Data | Resumo (até 65 caracteres)
2. Apresente tabela de custos: Dia | Data | Motivo | Valor por pessoa em R$
3. Encerre agradecendo e desejando uma ótima viagem. NÃO ofereça publicar, gerar HTML/PDF ou enviar o roteiro — isso não faz parte desta conversa.`;

  const bodyPayload = JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: systemPrompt,
    messages: historico
  });

  const https = require('https');
  const options = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(bodyPayload),
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    }
  };

  const chunks = [];
  const apiReq = https.request(options, (apiRes) => {
    apiRes.on('data', (chunk) => { chunks.push(chunk); });
    apiRes.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      console.log('[ia/roteiro-chat] status:', apiRes.statusCode, 'raw len:', raw.length);
      try {
        const parsed = JSON.parse(raw);
        if (parsed.error) { console.error('[ia/roteiro-chat] API error:', parsed.error); return res.json({ ok: false, erro: parsed.error.message }); }
        const texto = (parsed.content && parsed.content[0] && parsed.content[0].text) || '';
        if (!texto) return res.json({ ok: false, erro: 'A IA não retornou texto.' });
        return res.json({ ok: true, texto });
      } catch (e) {
        console.error('[ia/roteiro-chat] parse error:', e.message, 'raw:', raw.slice(0, 300));
        return res.json({ ok: false, erro: 'Erro ao processar resposta da IA.' });
      }
    });
  });
  apiReq.on('error', (e) => { console.error('[ia/roteiro-chat] req error:', e.message); res.json({ ok: false, erro: e.message }); });
  apiReq.setTimeout(170000, () => { apiReq.destroy(); res.json({ ok: false, erro: 'Timeout ao chamar API Anthropic.' }); });
  apiReq.write(bodyPayload);
  apiReq.end();
});

// ══════════════════════════════════════════════════════════════════════════════

app.listen(PORT, '0.0.0.0', () => {
  console.log(`CDV Proxy rodando na porta ${PORT}`);
});

