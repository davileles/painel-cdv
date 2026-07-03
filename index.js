const express = require('express');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO || 'davileles/cdv-compras-bonificadas';

const ALLOWED = ['comparemania.com.br', 'passageirodeprimeira.com'];

app.use(express.json({ limit: '20mb' }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
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
  if (!res.ok || !data.content) return { data: fallback, sha: null };
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
const PASSAGENS_PATH          = 'passagens.json';
const MAX_OFERTAS_APROVADAS   = 100;
const MAX_DIAS_PASSAGENS      = 180;
const MEMBROS_PATH            = 'membros.json';
const MILHAS_PATH             = 'milhas.json';
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

    // Adiciona nova passagem no início
    items.unshift(novaPassagem);

    await ghPutJson(
      PASSAGENS_PATH,
      { atualizadoEm: agora, items },
      atual.sha,
      `chore: registra passagem ${origem} → ${destino} (${programa} ${pontos} pts)`
    );

    res.json({ ok: true, id });
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

// ── Membros: verificar acesso por e-mail ─────────────────────────────────────
app.get('/membros/verificar', async (req, res) => {
  const email = (req.query.email || '').toLowerCase().trim();
  if (!email) return res.status(400).json({ ok: false, erro: 'E-mail obrigatório' });
  try {
    const dados = await ghGetJson(MEMBROS_PATH, { membros: [] });
    const membro = (dados.data.membros || []).find(m => m.email === email);
    if (!membro) return res.json({ ok: false, acesso: false, motivo: 'nao_encontrado' });
    if (membro.status !== 'ativo') return res.json({ ok: false, acesso: false, motivo: 'inativo', nome: membro.nome });
    res.json({ ok: true, acesso: true, nome: membro.nome, email: membro.email, produtos: membro.produtos });
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

// ── Gestão de Milhas: listar registros do usuário ────────────────────────────
app.get('/milhas/listar', async (req, res) => {
  const email = (req.query.email || '').toLowerCase().trim();
  if (!email) return res.status(400).json({ ok: false, erro: 'E-mail obrigatório' });
  try {
    const atual = await ghGetJson(MILHAS_PATH, { registros: [] });
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
    'Retorne SOMENTE um JSON válido (sem markdown) com os campos: ' +
    'tipo (voo/hotel/carro/passeio), origem, destino, dataIda (YYYY-MM-DD), horaPartida (HH:MM), horaChegada (HH:MM), ' +
    'ciaIda, nvooIda, dataVolta (YYYY-MM-DD), horaPartidaVolta, horaChegadaVolta, ciaVolta, nvooVolta, ' +
    'classe, pnr, pax, programa, milhas, valor, ' +
    'hotelNome, hotelDestino, hotelQuarto, checkin (YYYY-MM-DD), checkout (YYYY-MM-DD), noites, hospedes, hotelConf, regime, hotelValor, ' +
    'locadora, carroCat, retLocal, devLocal, retData (YYYY-MM-DD), devData (YYYY-MM-DD), carroConf, carroValor, ' +
    'passeioNome, passeioDest, passeioOp, passeioData (YYYY-MM-DD), passeioHora (HH:MM), passeioPax, passeioConf, passeioValor, obs. ' +
    'Preencha apenas os campos que existem no documento.';

  const contentBlock = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
    : { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } };

  const bodyPayload = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
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
        return res.json({ ok: true, texto: texto.replace(/```json|```/g, '').trim() });
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`CDV Proxy rodando na porta ${PORT}`);
});
