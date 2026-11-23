'use strict';
// ══════════════════════════════════════════════════════════════════════════
//  Anexos das reservas do concierge → pasta de documentos do roteiro
//  (desde 23/11/2026, decisão do Davi)
//
//  Os vouchers, bilhetes e apólices anexados às reservas do concierge ficam em
//  davileles/dados/concierge/arquivos/<RES-id>_<n>.json (privado). A pasta de
//  documentos da página do roteiro lê davileles/roteiros/<_slug>/docs-meta.json
//  e os arquivos de <_slug>/docs/ (público). Este módulo copia os anexos das
//  reservas ligadas à viagem (atividades[].reservaId) para a pasta do roteiro
//  (viagens[].slugRoteiro), cada um no cartão do tipo dele:
//    hotel → Hospedagem · voo → Cartão de embarque/Passagens · trem, transfer,
//    ônibus, ferry → Transporte · locação → Locação/Transporte · passeio →
//    Ingressos · seguro → Seguro. Sem cartão do tipo, cria um cartão extra
//    (_extraCards), como o "+ Adicionar documento" da página.
//  Os arquivos ficam PÚBLICOS (repo roteiros, como os que o cliente anexa).
//
//  Nunca copia duas vezes: cada anexo copiado entra em docs-meta._importados
//  (<RES-id>_<n>:<sha>). Arquivo removido na página não volta; cartão removido
//  na página (_deletedCards) não recebe mais anexos. Anexo trocado na reserva
//  (sha novo) é copiado de novo.
//
//  Quando roda: a cada 30 min para todas as viagens com roteiro (só lê página e
//  docs-meta se o conjunto de anexos mudou desde a última rodada), logo depois
//  de /roteiros/publicar com viagemId e pelo botão do Gerar Roteiro do concierge
//  (POST /concierge/roteiro/anexos {viagemId?}, sessão do concierge).
// ══════════════════════════════════════════════════════════════════════════

const ROTEIROS_REPO = 'davileles/roteiros';
const GH = 'https://api.github.com';
const INTERVALO_MIN = 30;
const MAX_MB = 25;

const CATEGORIAS = {
  hotel:      { re: /hosped|hotel|voucher/, titulo: 'Hospedagem', icon: '🏨' },
  voo:        { re: /embarque|passage|voo|aere/, titulo: 'Passagens aéreas', icon: '✈️' },
  transporte: { re: /transporte|trem|transfer|onibus|ferry|bilhete/, titulo: 'Transporte', icon: '🚆' },
  locacao:    { re: /locac|aluguel|carro|veicul/, titulo: 'Locação de carro', icon: '🚗', depois: 'transporte' },
  passeio:    { re: /ingresso|passeio|atrac|ticket/, titulo: 'Ingressos', icon: '🎟️' },
  seguro:     { re: /seguro/, titulo: 'Seguro Viagem', icon: '🛡️' },
  outro:      { re: /^reservas?$/, titulo: 'Reservas', icon: '📎' },
};

function categoriaDaReserva(r) {
  const t = String((r && r.tipo) || '').toLowerCase();
  if (t === 'hotel') return 'hotel';
  if (t === 'voo') return 'voo';
  if (['transfer', 'trem', 'onibus', 'ferry'].includes(t)) return 'transporte';
  if (t === 'carro' || t === 'locacao') return 'locacao';
  if (t === 'passeio') return 'passeio';
  if (t === 'seguro') return 'seguro';
  return 'outro';
}

function normalizar(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

// Recorta o literal de ROTEIRO_DATA da página e faz JSON.parse (nunca executa a página).
function extrairRoteiroData(html) {
  const m = /ROTEIRO_DATA\s*=\s*\{/.exec(String(html || ''));
  if (!m) return null;
  const ini = m.index + m[0].length - 1;
  let prof = 0, emStr = false, esc = false;
  for (let i = ini; i < html.length; i++) {
    const c = html[i];
    if (emStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') emStr = false;
      continue;
    }
    if (c === '"') emStr = true;
    else if (c === '{') prof++;
    else if (c === '}') {
      prof--;
      if (prof === 0) {
        try { return JSON.parse(html.slice(ini, i + 1)); } catch (e) { return null; }
      }
    }
  }
  return null;
}

function extensaoDe(nome, mediaType) {
  const m = /\.([a-z0-9]{2,5})$/i.exec(String(nome || ''));
  if (m) return m[1].toLowerCase();
  const mt = String(mediaType || '').toLowerCase();
  if (mt.includes('pdf')) return 'pdf';
  if (mt.includes('png')) return 'png';
  if (mt.includes('jpeg') || mt.includes('jpg')) return 'jpg';
  if (mt.includes('webp')) return 'webp';
  if (mt.includes('heic')) return 'heic';
  if (mt.includes('html')) return 'html';
  return 'pdf';
}

function nomeDescritivo(r) {
  const partes = {
    hotel: r.hotelNome, voo: [r.cia, r.origem && r.destino ? r.origem + '-' + r.destino : ''].filter(Boolean).join(' '),
    transfer: r.origem, trem: [r.origem, r.destino].filter(Boolean).join(' - '), onibus: [r.origem, r.destino].filter(Boolean).join(' - '),
    ferry: [r.origem, r.destino].filter(Boolean).join(' - '), carro: r.locadora, locacao: r.locadora,
    passeio: r.passeioNome, seguro: r.seguradora,
  }[String(r.tipo || '').toLowerCase()];
  return String(partes || r.tipo || 'Reserva').trim() || 'Reserva';
}

function registrar(app, { fetch, GITHUB_TOKEN, getConciergeFile, CONCIERGE_DADOS_REPO, CONCIERGE_PASTA }) {
  const H = () => ({
    'Authorization': `token ${GITHUB_TOKEN}`,
    'User-Agent': 'cdv-proxy',
    'Accept': 'application/vnd.github+json',
  });

  async function lerRaw(repo, caminho) {
    const r = await fetch(`${GH}/repos/${repo}/contents/${encodeURI(caminho)}`, {
      headers: { ...H(), 'Accept': 'application/vnd.github.raw', 'Cache-Control': 'no-cache' },
    });
    if (r.status === 404) return null;
    if (!r.ok) { const e = new Error(`GitHub GET ${repo}/${caminho} falhou (${r.status})`); e.status = r.status; throw e; }
    return r.text();
  }

  async function lerMeta(slug) {
    const r = await fetch(`${GH}/repos/${ROTEIROS_REPO}/contents/${encodeURI(slug)}/docs-meta.json`, { headers: { ...H(), 'Cache-Control': 'no-cache' } });
    if (r.status === 404) return { meta: {}, sha: null };
    if (!r.ok) throw new Error(`docs-meta de ${slug} (${r.status})`);
    const d = await r.json();
    let meta = {};
    try { meta = JSON.parse(Buffer.from(String(d.content || '').replace(/\n/g, ''), 'base64').toString('utf-8')) || {}; } catch (e) { meta = {}; }
    return { meta, sha: d.sha };
  }

  async function putRoteiros(caminho, conteudoB64, mensagem, sha) {
    const r = await fetch(`${GH}/repos/${ROTEIROS_REPO}/contents/${encodeURI(caminho)}`, {
      method: 'PUT',
      headers: { ...H(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: mensagem, content: conteudoB64, ...(sha ? { sha } : {}) }),
    });
    if (!r.ok) { const e = new Error(`GitHub PUT ${caminho} falhou (${r.status}) ${(await r.text()).slice(0, 160)}`); e.status = r.status; throw e; }
    return r.json();
  }

  // Anexos de todas as reservas: { 'RES-x': [{idx, path, sha}] }
  async function listarAnexos() {
    // Árvore do git (a Contents API corta a listagem de pasta em 1.000 itens).
    const pasta = `${CONCIERGE_PASTA}arquivos`;
    const r = await fetch(`${GH}/repos/${CONCIERGE_DADOS_REPO}/git/trees/HEAD:${encodeURI(pasta)}`, { headers: H() });
    if (r.status === 404) return {};
    if (!r.ok) throw new Error(`lista de anexos (${r.status})`);
    const d = await r.json();
    const porReserva = {};
    for (const f of Array.isArray(d.tree) ? d.tree : []) {
      if (f.type !== 'blob') continue;
      const m = /^(.+)_(\d+)\.json$/.exec(f.path || '');
      if (!m) continue;
      (porReserva[m[1]] = porReserva[m[1]] || []).push({ idx: parseInt(m[2], 10), path: `${pasta}/${f.path}`, sha: f.sha || '', tamanho: f.size || 0 });
    }
    for (const k of Object.keys(porReserva)) porReserva[k].sort((a, b) => a.idx - b.idx);
    return porReserva;
  }

  function escolherCard(cat, cards, deletados) {
    const ordem = [cat];
    if (CATEGORIAS[cat] && CATEGORIAS[cat].depois) ordem.push(CATEGORIAS[cat].depois);
    for (const c of ordem) {
      const re = CATEGORIAS[c].re;
      const achado = cards.find(d => re.test(normalizar(d.titulo)));
      if (achado) return deletados.has(achado.docId) ? { removido: true } : { card: achado };
    }
    return null;
  }

  const ultimaAssinatura = new Map(); // viagemId → anexos+slug da última rodada sem pendência

  async function sincronizarViagem(v, reservasPorId, anexosPorReserva, forcar) {
    const slugRoteiro = String(v.slugRoteiro || '').replace(/^\/+|\/+$/g, '');
    if (!slugRoteiro) return { viagemId: v.id, pulado: 'sem roteiro' };
    const ids = [...new Set((v.atividades || []).map(a => a && a.reservaId).filter(Boolean))];
    const itens = [];
    for (const id of ids) {
      const r = reservasPorId.get(id);
      for (const an of anexosPorReserva[String(id).replace(/[^a-zA-Z0-9\-_]/g, '')] || []) {
        itens.push({ reserva: r || { id, tipo: '' }, ...an, chave: `${id}_${an.idx}:${String(an.sha).slice(0, 10)}` });
      }
    }
    const assinatura = slugRoteiro + '|' + itens.map(i => i.chave).sort().join(',');
    if (!itens.length) return { viagemId: v.id, slug: slugRoteiro, novos: 0, semAnexos: true };
    if (!forcar && ultimaAssinatura.get(v.id) === assinatura) return { viagemId: v.id, slug: slugRoteiro, novos: 0, semMudanca: true };

    const html = await lerRaw(ROTEIROS_REPO, `${slugRoteiro}/index.html`);
    if (!html) return { viagemId: v.id, slug: slugRoteiro, erro: 'página do roteiro não encontrada' };
    if (!html.includes('/roteiros/doc-upload')) return { viagemId: v.id, slug: slugRoteiro, pulado: 'página sem pasta de documentos' };
    const D = extrairRoteiroData(html);
    const docsSlug = D && D._slug ? String(D._slug) : '';
    if (!docsSlug) return { viagemId: v.id, slug: slugRoteiro, pulado: 'página sem _slug (pasta de documentos desligada)' };

    const { meta } = await lerMeta(docsSlug);
    const importados = new Set(Array.isArray(meta._importados) ? meta._importados : []);
    const pendentes = itens.filter(i => !importados.has(i.chave));
    if (!pendentes.length) { ultimaAssinatura.set(v.id, assinatura); return { viagemId: v.id, slug: slugRoteiro, novos: 0 }; }

    const deletados = new Set(Array.isArray(meta._deletedCards) ? meta._deletedCards : []);
    const extrasAntigos = Array.isArray(meta._extraCards) ? meta._extraCards : [];
    const cards = (Array.isArray(D.documentos) ? D.documentos : []).map((d, i) => ({ ...d, docId: d.docId || ('doc_' + i) }));
    for (const ex of extrasAntigos) if (ex && ex.docId && !cards.some(c => c.docId === ex.docId)) cards.push(ex);

    const novosMeta = {}, novasChaves = [], novosExtras = [], copiados = [], ignorados = [];
    let n = 0;
    for (const it of pendentes) {
      const cat = categoriaDaReserva(it.reserva);
      let esc = escolherCard(cat, cards, deletados);
      if (esc && esc.removido) { novasChaves.push(it.chave); ignorados.push({ reservaId: it.reserva.id, motivo: 'cartão removido na página' }); continue; }
      let card = esc && esc.card;
      if (!card) {
        const c = CATEGORIAS[cat];
        card = { icon: c.icon, titulo: c.titulo, meta: 'Arquivos das reservas', docId: 'doc_res_' + cat };
        cards.push(card); novosExtras.push(card);
      }
      if (it.tamanho > MAX_MB * 1024 * 1024 * 1.4) { novasChaves.push(it.chave); ignorados.push({ reservaId: it.reserva.id, motivo: 'arquivo grande demais' }); continue; }
      const txt = await lerRaw(CONCIERGE_DADOS_REPO, it.path);
      if (!txt) continue;
      let arq;
      try { arq = JSON.parse(txt); } catch (e) { continue; }
      if (!arq || !arq.base64) continue;
      const b64 = String(arq.base64).replace(/^data:[^,]*,/, '');
      const ext = extensaoDe(arq.nome, arq.mediaType);
      const nome = String(arq.nome || '').trim() || (nomeDescritivo(it.reserva) + '.' + ext);
      const fileName = `${card.docId}_${Date.now() + (n++)}.${ext}`;
      await putRoteiros(`${docsSlug}/docs/${fileName}`, b64, `doc (reserva ${it.reserva.id}): ${docsSlug}/${fileName}`);
      novosMeta[fileName] = {
        nome, tipo: ext, mediaType: arq.mediaType || 'application/octet-stream',
        uploadEm: new Date().toISOString(), origem: 'reserva', reservaId: it.reserva.id, idx: it.idx,
      };
      novasChaves.push(it.chave);
      copiados.push({ reservaId: it.reserva.id, tipo: it.reserva.tipo || '', nome, cartao: card.titulo });
    }

    if (novasChaves.length) {
      for (let t = 0; t < 4; t++) {
        const { meta: atual, sha } = await lerMeta(docsSlug);
        Object.assign(atual, novosMeta);
        atual._importados = [...new Set([...(Array.isArray(atual._importados) ? atual._importados : []), ...novasChaves])];
        const extras = Array.isArray(atual._extraCards) ? atual._extraCards : [];
        for (const ex of novosExtras) if (!extras.some(e => e && e.docId === ex.docId)) extras.push(ex);
        if (extras.length) atual._extraCards = extras;
        try {
          await putRoteiros(`${docsSlug}/docs-meta.json`, Buffer.from(JSON.stringify(atual, null, 2)).toString('base64'), `doc-meta (reservas): ${docsSlug}`, sha);
          break;
        } catch (e) {
          if ((e.status === 409 || e.status === 422) && t < 3) { await new Promise(r => setTimeout(r, 800 * (t + 1))); continue; }
          throw e;
        }
      }
    }
    ultimaAssinatura.set(v.id, assinatura);
    if (copiados.length) console.log(`[roteiro-anexos] ${v.id} → ${docsSlug}: ${copiados.length} anexo(s) copiado(s)`);
    return { viagemId: v.id, slug: slugRoteiro, docsSlug, novos: copiados.length, copiados, ignorados };
  }

  let fila = Promise.resolve();
  function sincronizar(opcoes = {}) {
    const rodada = fila.then(async () => {
      const [{ content: viagens }, { content: reservas }, anexos] = await Promise.all([
        getConciergeFile('viagens.json'), getConciergeFile('reservas.json'), listarAnexos(),
      ]);
      const reservasPorId = new Map((Array.isArray(reservas) ? reservas : []).filter(r => r && r.id).map(r => [r.id, r]));
      const alvo = (Array.isArray(viagens) ? viagens : []).filter(v => v && v.slugRoteiro && (!opcoes.viagemId || v.id === opcoes.viagemId));
      const resultados = [];
      for (const v of alvo) {
        try { resultados.push(await sincronizarViagem(v, reservasPorId, anexos, !!opcoes.forcar)); }
        catch (e) { console.error('[roteiro-anexos]', v.id, e.message); resultados.push({ viagemId: v.id, slug: v.slugRoteiro, erro: e.message }); }
      }
      return {
        viagens: alvo.length,
        copiados: resultados.reduce((s, r) => s + (r.novos || 0), 0),
        resultados,
      };
    });
    fila = rodada.catch(() => {});
    return rodada;
  }

  app.post('/concierge/roteiro/anexos', async (req, res) => {
    try {
      const { viagemId } = req.body || {};
      const r = await sincronizar({ viagemId: viagemId ? String(viagemId) : '', forcar: true });
      if (viagemId && !r.viagens) return res.status(404).json({ ok: false, erro: 'Viagem sem roteiro publicado' });
      res.json({ ok: true, ...r });
    } catch (e) {
      console.error('[concierge/roteiro/anexos]', e.message);
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  const rodar = () => sincronizar().then(r => {
    if (r.copiados) console.log(`[roteiro-anexos] rodada: ${r.copiados} anexo(s) copiado(s) em ${r.viagens} viagem(ns)`);
  }).catch(e => console.error('[roteiro-anexos] rodada', e.message));
  setTimeout(rodar, 3 * 60 * 1000);
  setInterval(rodar, INTERVALO_MIN * 60 * 1000);

  return { sincronizar };
}

module.exports = { registrar, extrairRoteiroData, categoriaDaReserva };
