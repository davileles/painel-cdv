// coletar-inter.js
// Executado pelo GitHub Action (coletar-historico.yml — mesmo workflow do Comparemania).
// 1. Acessa a API pública do Shopping Inter via proxy Railway (evita bloqueio ASN)
// 2. Extrai cashbackValue (%) de cada Gift Card
// 3. Salva/atualiza historico.json com snapshot do dia no programa "inter"
// 4. Detecta aumentos de cashback e gera ofertas pendentes:
//    - 1 oferta agrupada por programa (todos os parceiros que subiram)
//    - 1 oferta individual para cada parceiro Tier 1 que subiu

const fs   = require('fs');
const path = require('path');

const HISTORICO_FILE   = path.join(__dirname, 'historico.json');
const PENDENTES_FILE   = path.join(__dirname, 'ofertas-pendentes.json');
const NOTIF_FILE       = path.join(__dirname, 'variacoes-notificadas.json');

const PROXY_URL = process.env.CDV_PROXY_URL || 'https://cdv-proxy-production.up.railway.app';
const API_URL   = `${PROXY_URL}/inter/gift-cards`;

// Parceiros com mensagem individual detalhada (Tier 1 Inter)
// Chaves devem corresponder ao resultado de normalizarChave(gc.name)
const PARCEIROS_TIER1_INTER = new Set([
  'bacio di latte',
  'outback steakhouse',
  'airbnb',
  'uber',
  'assaí',
  'zift',
  'zé delivery',
  'madero',
  '99 food',
  '99 mobilidade',
  'coco bambu',
]);

// ── HTTP helper ───────────────────────────────────────────────────────────────
async function fetchDirect(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, */*',
        'Accept-Language': 'pt-BR,pt;q=0.9',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} para ${url}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// Normaliza nome do gift card para chave do historico.json
function normalizarChave(name) {
  return (name || '')
    .replace(/^Gift Card\s*/i, '')
    .toLowerCase()
    .trim();
}

// Nome de exibição capitalizado
function nomeExibicao(chave) {
  return chave.charAt(0).toUpperCase() + chave.slice(1);
}

// Hash simples para gerar IDs de oferta
function hashId(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return 'inter_' + h.toString(36);
}

// Calcula, para um parceiro (programa "inter"), a frequência média (em dias)
// com que o cashback costuma subir e estima a data da próxima alta — usando
// os últimos 12 meses de historico.json. Mesmo critério do modal do Comparador
// (painel-cdv/index.html → calcularPadraoAltas), pra manter os números
// consistentes entre o painel e as mensagens do gerador de ofertas.
function calcularFrequenciaAltas(historico, chave, hoje, pontosHoje) {
  const corteDate = new Date();
  corteDate.setMonth(corteDate.getMonth() - 12);
  const corte = corteDate.toISOString().split('T')[0];
  const datas = Object.keys(historico).filter(d => d >= corte && d <= hoje && d !== hoje).sort();

  const serie = [];
  for (const d of datas) {
    const pts = historico[d]?.[chave]?.programs?.inter?.pts;
    if (pts != null) serie.push({ data: d, pts });
  }
  // Inclui a leitura de hoje quando informada — historico[hoje] só é gravado
  // depois que gerarOfertasVariacao termina, então sem isso a alta detectada
  // agora ficava de fora do cálculo e a "próxima alta" saía defasada.
  if (pontosHoje != null) serie.push({ data: hoje, pts: pontosHoje });

  const altas = [];
  for (let i = 1; i < serie.length; i++) {
    if (serie[i].pts > serie[i - 1].pts) altas.push(serie[i].data);
  }
  if (altas.length < 2) return null;

  const datasAltas = altas.map(d => new Date(d + 'T00:00:00'));
  const gaps = [];
  for (let i = 1; i < datasAltas.length; i++) gaps.push((datasAltas[i] - datasAltas[i - 1]) / 86400000);
  const mediaGap = Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length);
  const ultimaAlta = datasAltas[datasAltas.length - 1];
  const proximaEstimada = new Date(ultimaAlta.getTime() + mediaGap * 86400000);

  return {
    frequenciaDias: mediaGap,
    qtdAltas: altas.length,
    ultimaAltaData: altas[altas.length - 1],
    proximaEstimadaData: proximaEstimada.toISOString().split('T')[0],
  };
}

// ── Detectar variações e gerar ofertas pendentes ──────────────────────────────
async function gerarOfertasVariacao(snapHoje, historico, hoje) {
  // Comparar com snapshot do dia ANTERIOR
  const datasAnteriores = Object.keys(historico)
    .filter(d => d < hoje)
    .sort()
    .reverse();

  if (!datasAnteriores.length) {
    console.log('[Inter] Sem snapshot anterior — pulando comparação.');
    return;
  }

  const dataAnterior = datasAnteriores[0];
  const snapAnterior = historico[dataAnterior] || {};
  console.log(`[Inter] Comparando com snapshot de ${dataAnterior}`);

  // Controle de notificações do dia (evita duplicatas)
  let notifRaw = {};
  if (fs.existsSync(NOTIF_FILE)) {
    try { notifRaw = JSON.parse(fs.readFileSync(NOTIF_FILE, 'utf8')); } catch(e) {}
  }
  const notifAtual = {};
  for (const [data, entries] of Object.entries(notifRaw)) {
    if (data >= hoje) notifAtual[data] = entries;
  }
  const notifHoje = notifAtual[hoje] || {};

  // Detectar aumentos
  const variacoes = []; // { chave, nome, ptsAntes, ptsAgora, delta, link }

  for (const [chave, dadosHoje] of Object.entries(snapHoje)) {
    const ptsHoje = dadosHoje.programs?.inter?.pts;
    if (!ptsHoje) continue;

    const dadosAnt = snapAnterior[chave];
    const ptsAntes = dadosAnt?.programs?.inter?.pts;
    if (!ptsAntes || ptsHoje <= ptsAntes) continue;

    const chaveNotif = `inter__${chave}`;
    if (notifHoje[chaveNotif] === ptsHoje) continue; // já notificado hoje

    variacoes.push({
      chave,
      nome: nomeExibicao(chave),
      ptsAntes,
      ptsAgora: ptsHoje,
      delta: ptsHoje - ptsAntes,
      link: dadosHoje.links?.inter || 'https://shopping.inter.co/gift-card',
    });

    notifHoje[chaveNotif] = ptsHoje;
  }

  if (!variacoes.length) {
    console.log('[Inter] Nenhuma variação nova de cashback.');
    return;
  }

  console.log(`[Inter] ${variacoes.length} parceiro(s) com aumento de cashback`);

  // Carrega ofertas pendentes
  let pendentesDados = { geradoEm: null, items: [] };
  if (fs.existsSync(PENDENTES_FILE)) {
    try { pendentesDados = JSON.parse(fs.readFileSync(PENDENTES_FILE, 'utf8')); } catch(e) {}
  }
  const itensPendentes = Array.isArray(pendentesDados.items) ? pendentesDados.items : [];
  const novasOfertas = [];

  // ── Oferta agrupada (todos os parceiros) ────────────────────────────────────
  const count = variacoes.length;
  const linhas = variacoes
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'))
    .map(v => `🏦 ${v.nome} — ${v.ptsAntes}% → ${v.ptsAgora}% (+${v.delta}%)`)
    .join('\n');

  const tituloAgrupado = `${count} parceiro${count > 1 ? 's tiveram' : ' teve'} aumento de cashback no Shopping Inter`;

  novasOfertas.push({
    id: hashId(`inter-grupo-${hoje}-${Date.now()}`),
    titulo: tituloAgrupado,
    emoji: '🏦',
    resumo: `${count} parceiro${count > 1 ? 's' : ''} do Shopping Inter ${count > 1 ? 'tiveram' : 'teve'} aumento de cashback na última atualização do Painel do Clube do Viajante.\n\n${linhas}`,
    descricao: '',
    programa: 'Inter',
    bonus: '',
    prazo: '',
    categoria: 'compra_bonificada',
    loja: 'Shopping Inter',
    cupom: '',
    link: 'https://shopping.inter.co/gift-card',
    importante: '',
    milheiro: '',
    tetoTransferencia: '',
    restricoes: [],
    publicadoEm: new Date().toISOString(),
    tipoVariacao: true,
  });

  console.log(`[Inter] Oferta agrupada: "${tituloAgrupado}"`);

  // ── Ofertas individuais Tier 1 ───────────────────────────────────────────────
  for (const v of variacoes) {
    if (!PARCEIROS_TIER1_INTER.has(v.chave)) continue;

    // Estatísticas históricas (últimos 6 meses)
    const hoje6m = new Date();
    hoje6m.setMonth(hoje6m.getMonth() - 6);
    const corte6m = hoje6m.toISOString().split('T')[0];

    const pts6m = Object.entries(historico)
      .filter(([d]) => d >= corte6m && d < hoje)
      .map(([, snap]) => snap[v.chave]?.programs?.inter?.pts)
      .filter(v => v != null);

    const maxPts6m = Math.max(v.ptsAgora, ...(pts6m.length ? pts6m : [v.ptsAntes]));
    const mediaPts6m = pts6m.length
      ? Math.round(pts6m.reduce((a, b) => a + b, 0) / pts6m.length * 10) / 10
      : v.ptsAntes;

    // Classificação vs. média histórica de 6 meses (mesmo critério de ±20%
    // usado pelo isAboveAverage() do Comparador, pra manter consistência)
    let classificacaoT1 = 'dentro_padrao';
    if (mediaPts6m > 0) {
      if (v.ptsAgora >= mediaPts6m * 1.2) classificacaoT1 = 'acima_padrao';
      else if (v.ptsAgora <= mediaPts6m * 0.8) classificacaoT1 = 'abaixo_padrao';
    }

    // Padrão de altas (frequência média + próxima alta estimada) — mesmo
    // cálculo do modal do Comparador, usando 12 meses de historico.json.
    const padraoAltasT1 = calcularFrequenciaAltas(historico, v.chave, hoje, v.ptsAgora);

    const tituloT1 = `${v.ptsAgora}% de cashback em ${v.nome} no Shopping Inter`;

    const linhasResumoT1 = [
      `${v.nome} aumentou o cashback no Shopping Inter.`,
      '',
      `* Cashback anterior: ${v.ptsAntes}%`,
      `* Cashback atual: ${v.ptsAgora}% (+${v.delta}%)`,
      `* Maior cashback (últimos 6 meses): ${maxPts6m}%`,
      `* Média (últimos 6 meses): ${mediaPts6m}%`,
    ];
    if (padraoAltasT1 && padraoAltasT1.frequenciaDias && padraoAltasT1.proximaEstimadaData) {
      const [, mmProxT1, ddProxT1] = padraoAltasT1.proximaEstimadaData.split('-');
      linhasResumoT1.push(`* Sobe a cada ~${padraoAltasT1.frequenciaDias} dias. Possível próxima alta: ${ddProxT1}/${mmProxT1}`);
    }
    const resumoT1 = linhasResumoT1.join('\n');

    novasOfertas.push({
      id: hashId(`inter-t1-${v.chave}-${hoje}-${Date.now()}`),
      titulo: tituloT1,
      emoji: '⭐',
      resumo: resumoT1,
      descricao: '',
      programa: 'Inter',
      bonus: '',
      prazo: '',
      categoria: 'compra_bonificada',
      loja: v.nome,
      cupom: '',
      link: v.link,
      importante: '',
      milheiro: '',
      tetoTransferencia: '',
      restricoes: [],
      publicadoEm: new Date().toISOString(),
      tipoVariacao: true,
      tier1: true,
      // Comparação com o histórico já pré-calculada aqui (fonte de verdade = historico.json),
      // pra não precisar reanalisar nada na hora da aprovação — só exibir.
      historicoComparacao: {
        parceiro: v.nome,
        programa: 'Inter',
        pontuacaoAtual: v.ptsAgora,
        pontuacaoAnterior: v.ptsAntes,
        mediaHistorica6m: mediaPts6m,
        maximoHistorico6m: maxPts6m,
        amostras6m: pts6m.length,
        classificacao: classificacaoT1,
        moeda: '%',
        dataDeteccao: hoje,
        frequenciaDias: padraoAltasT1 ? padraoAltasT1.frequenciaDias : null,
        proximaEstimadaData: padraoAltasT1 ? padraoAltasT1.proximaEstimadaData : null,
      },
    });

    console.log(`[Inter Tier 1] Oferta individual: "${tituloT1}"`);
  }

  // Salva controle de notificações
  notifAtual[hoje] = notifHoje;
  fs.writeFileSync(NOTIF_FILE, JSON.stringify(notifAtual, null, 2));

  // Adiciona novas ofertas no início das pendentes
  fs.writeFileSync(PENDENTES_FILE, JSON.stringify({
    geradoEm: new Date().toISOString(),
    items: [...novasOfertas, ...itensPendentes],
  }, null, 2));

  console.log(`[Inter] ${novasOfertas.length} oferta(s) adicionada(s) às pendentes.`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const hoje = new Date().toISOString().split('T')[0];
  console.log(`[Inter] Iniciando coleta para ${hoje}`);

  // 1. Carrega historico.json
  let historico = {};
  if (fs.existsSync(HISTORICO_FILE)) {
    try {
      historico = JSON.parse(fs.readFileSync(HISTORICO_FILE, 'utf8'));
    } catch (e) {
      console.warn('[Inter] historico.json corrompido — iniciando vazio.');
    }
  }

  // 2. Chama API do Inter via proxy Railway
  console.log('[Inter] Consultando API do Shopping Inter…');
  let giftCards = [];
  try {
    const data = await fetchDirect(API_URL);
    giftCards = data.giftCards || [];
    console.log(`[Inter] ${giftCards.length} gift cards encontrados`);
  } catch (e) {
    console.error('[Inter] Erro ao consultar API:', e.message);
    process.exit(1);
  }

  if (!giftCards.length) {
    console.error('[Inter] Nenhum gift card retornado — abortando.');
    process.exit(1);
  }

  // 3. Monta snapshot do dia
  if (!historico[hoje]) historico[hoje] = {};
  const snapHoje = historico[hoje];

  for (const gc of giftCards) {
    const chave = normalizarChave(gc.name);
    if (!chave) continue;

    if (!snapHoje[chave]) snapHoje[chave] = { programs: {} };
    if (!snapHoje[chave].programs) snapHoje[chave].programs = {};

    snapHoje[chave].programs.inter = {
      pts: gc.cashbackValue,
      dollar: false,
      slug: gc.slug,
    };

    if (!snapHoje[chave].links) snapHoje[chave].links = {};
    snapHoje[chave].links.inter = `https://shopping.inter.co/gift-card/${gc.slug}`;
  }

  console.log(`[Inter] ${giftCards.length} parceiros atualizados no historico.json`);

  // 4. Detecta variações e gera ofertas
  await gerarOfertasVariacao(snapHoje, historico, hoje);

  // 5. Remove dias com mais de 180 dias
  const corte = new Date();
  corte.setDate(corte.getDate() - 180);
  const corteStr = corte.toISOString().split('T')[0];
  for (const data of Object.keys(historico)) {
    if (data < corteStr) delete historico[data];
  }

  // 6. Salva historico.json
  fs.writeFileSync(HISTORICO_FILE, JSON.stringify(historico, null, 2));
  console.log(`[Inter] historico.json salvo com ${Object.keys(historico).length} dias.`);

  // Resumo top 5
  const top5 = [...giftCards].sort((a, b) => b.cashbackValue - a.cashbackValue).slice(0, 5);
  console.log('\n🏆 Top 5 cashbacks Inter hoje:');
  top5.forEach(gc => console.log(`  ${gc.cashbackValue}% — ${gc.name}`));
}

main().catch(e => {
  console.error('[Inter] Erro fatal:', e.message);
  process.exit(1);
});
