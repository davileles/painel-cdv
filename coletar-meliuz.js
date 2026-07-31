// coletar-meliuz.js
// Executado pelo GitHub Action (coletar-historico.yml — mesmo workflow do
// Comparemania e do Inter, mas só nas janelas de 09h e 18h UTC).
// 1. Lê meliuz-lojas.json (catálogo gerado por catalogo-meliuz.js)
// 2. Consulta o cashback de cada loja via proxy Railway, em lotes de 20
// 3. Salva/atualiza historico.json com snapshot do dia no programa "meliuz"
// 4. Detecta aumentos de cashback e gera ofertas:
//    - 1 oferta agrupada por programa (todos os parceiros que subiram)
//    - 1 oferta individual para cada parceiro Tier 1 que subiu
//    Todas sao publicadas automaticamente no grupo (mesma regra do coletar.js e
//    do coletar-inter.js), caindo em ofertas-pendentes.json apenas se o
//    enfileiramento falhar.
//
// O cashback do Méliuz é % sobre o valor gasto, igual ao Inter — por isso ele
// NUNCA compete com pts/R$ pela "melhor opção" no Comparador (a exclusão fica
// no index.html, via flag cashback:true em PROGRAMS).

const fs   = require('fs');
const path = require('path');

const { publicarOfertas, MAX_OFERTAS_APROVADAS } = require('./mensagem-radar');

const HISTORICO_FILE = path.join(__dirname, 'historico.json');
const LOJAS_FILE     = path.join(__dirname, 'meliuz-lojas.json');
const PENDENTES_FILE = path.join(__dirname, 'ofertas-pendentes.json');
const OFERTAS_FILE   = path.join(__dirname, 'ofertas.json');
const NOTIF_FILE     = path.join(__dirname, 'variacoes-notificadas.json');

const PROXY_URL = process.env.CDV_PROXY_URL || 'https://cdv-proxy-production.up.railway.app';
const API_URL   = `${PROXY_URL}/meliuz/cashback`;

const LOTE = 20; // limite aceito pelo endpoint /meliuz/cashback

// Parceiros com mensagem individual detalhada (Tier 1 Méliuz).
// Chaves devem corresponder ao campo `chave` do meliuz-lojas.json.
const PARCEIROS_TIER1_MELIUZ = new Set([
  'all accor',
  'booking',
  'decolar',
  'airbnb',
  'hoteis.com',
  'localiza',
  'movida',
  'hertz',
  'avis',
  'rentcars',
  'assist card',
  'porto seguro',
  'hero seguro viagem',
  'beach park ingressos',
  'uber',
]);

// ── HTTP helper ───────────────────────────────────────────────────────────────
async function fetchDirect(url, timeoutMs = 90000) {
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

// Nome de exibição capitalizado
function nomeExibicao(chave) {
  return chave.charAt(0).toUpperCase() + chave.slice(1);
}

// Hash simples para gerar IDs de oferta
function hashId(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return 'meliuz_' + h.toString(36);
}

// Formata percentual sem casa decimal inútil (3.0 → "3", 3.5 → "3,5")
function fmtPct(v) {
  return String(Number(v)).replace('.', ',');
}

// Calcula, para um parceiro (programa "meliuz"), a frequência média (em dias)
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
    const pts = historico[d]?.[chave]?.programs?.meliuz?.pts;
    if (pts != null) serie.push({ data: d, pts });
  }
  // Inclui a leitura de hoje quando informada — historico[hoje] só é gravado
  // depois que gerarOfertasVariacao termina.
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

// ── Detectar variações e gerar ofertas ────────────────────────────────────────
async function gerarOfertasVariacao(snapHoje, historico, hoje, nomesPorChave) {
  const datasAnteriores = Object.keys(historico)
    .filter(d => d < hoje)
    .sort()
    .reverse();

  if (!datasAnteriores.length) {
    console.log('[Méliuz] Sem snapshot anterior — pulando comparação.');
    return;
  }

  const dataAnterior = datasAnteriores[0];
  const snapAnterior = historico[dataAnterior] || {};
  console.log(`[Méliuz] Comparando com snapshot de ${dataAnterior}`);

  // Controle de notificações do dia (evita duplicatas)
  let notifRaw = {};
  if (fs.existsSync(NOTIF_FILE)) {
    try { notifRaw = JSON.parse(fs.readFileSync(NOTIF_FILE, 'utf8')); } catch (e) {}
  }
  const notifAtual = {};
  for (const [data, entries] of Object.entries(notifRaw)) {
    if (data >= hoje) notifAtual[data] = entries;
  }
  const notifHoje = notifAtual[hoje] || {};

  // Detectar aumentos
  const variacoes = [];

  for (const [chave, dadosHoje] of Object.entries(snapHoje)) {
    const progHoje = dadosHoje.programs?.meliuz;
    const ptsHoje = progHoje?.pts;
    if (!ptsHoje) continue;

    const ptsAntes = snapAnterior[chave]?.programs?.meliuz?.pts;
    if (!ptsAntes || ptsHoje <= ptsAntes) continue;

    const chaveNotif = `meliuz__${chave}`;
    if (notifHoje[chaveNotif] === ptsHoje) continue; // já notificado hoje

    variacoes.push({
      chave,
      nome: nomesPorChave[chave] || nomeExibicao(chave),
      ptsAntes,
      ptsAgora: ptsHoje,
      delta: Math.round((ptsHoje - ptsAntes) * 100) / 100,
      ate: !!progHoje.ate,
      link: dadosHoje.links?.meliuz || 'https://www.meliuz.com.br/desconto',
    });

    notifHoje[chaveNotif] = ptsHoje;
  }

  if (!variacoes.length) {
    console.log('[Méliuz] Nenhuma variação nova de cashback.');
    return;
  }

  console.log(`[Méliuz] ${variacoes.length} parceiro(s) com aumento de cashback`);

  // Carrega ofertas pendentes
  let pendentesDados = { geradoEm: null, items: [] };
  if (fs.existsSync(PENDENTES_FILE)) {
    try { pendentesDados = JSON.parse(fs.readFileSync(PENDENTES_FILE, 'utf8')); } catch (e) {}
  }
  const itensPendentes = Array.isArray(pendentesDados.items) ? pendentesDados.items : [];
  const novasOfertas = [];

  // ── Oferta agrupada (todos os parceiros) ────────────────────────────────────
  const count = variacoes.length;

  // Se TODOS os parceiros que subiram forem Tier 1, cada um já gera mensagem
  // exclusiva e detalhada — a mensagem agrupada seria pura duplicação.
  const todosTier1 = variacoes.every(v => PARCEIROS_TIER1_MELIUZ.has(v.chave));

  const linhas = variacoes
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'))
    .map(v => `💸 ${v.nome} — ${fmtPct(v.ptsAntes)}% → ${v.ate ? 'até ' : ''}${fmtPct(v.ptsAgora)}% (+${fmtPct(v.delta)}%)`)
    .join('\n');

  const tituloAgrupado = `${count} parceiro${count > 1 ? 's tiveram' : ' teve'} aumento de cashback no Méliuz`;

  const ofertaAgrupada = {
    id: hashId(`meliuz-grupo-${hoje}-${Date.now()}`),
    titulo: tituloAgrupado,
    emoji: '💸',
    resumo: `${count} parceiro${count > 1 ? 's' : ''} do Méliuz ${count > 1 ? 'tiveram' : 'teve'} aumento de cashback na última atualização do Painel do Clube do Viajante.\n\n${linhas}`,
    descricao: '',
    programa: 'Méliuz',
    bonus: '',
    prazo: '',
    categoria: 'compra_bonificada',
    loja: 'Méliuz',
    cupom: '',
    link: 'https://painel.clubedoviajante.com.br',
    importante: '',
    milheiro: '',
    tetoTransferencia: '',
    restricoes: [],
    publicadoEm: new Date().toISOString(),
    tipoVariacao: true,
  };

  if (todosTier1) {
    console.log(`[Méliuz] Oferta agrupada suprimida — ${count} parceiro(s) com variação, todos Tier 1 (já têm mensagem exclusiva).`);
  } else {
    novasOfertas.push(ofertaAgrupada);
    console.log(`[Méliuz] Oferta agrupada: "${tituloAgrupado}"`);
  }

  // ── Ofertas individuais Tier 1 ───────────────────────────────────────────────
  for (const v of variacoes) {
    if (!PARCEIROS_TIER1_MELIUZ.has(v.chave)) continue;

    // Estatísticas históricas (últimos 6 meses)
    const hoje6m = new Date();
    hoje6m.setMonth(hoje6m.getMonth() - 6);
    const corte6m = hoje6m.toISOString().split('T')[0];

    const pts6m = Object.entries(historico)
      .filter(([d]) => d >= corte6m && d < hoje)
      .map(([, snap]) => snap[v.chave]?.programs?.meliuz?.pts)
      .filter(x => x != null);

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

    const tituloT1 = `${v.ate ? 'Até ' : ''}${fmtPct(v.ptsAgora)}% de cashback em ${v.nome} no Méliuz`;

    const linhasResumoT1 = [
      `${v.nome} aumentou o cashback no Méliuz.`,
      '',
      `* Cashback anterior: ${fmtPct(v.ptsAntes)}%`,
      `* Cashback atual: ${v.ate ? 'até ' : ''}${fmtPct(v.ptsAgora)}% (+${fmtPct(v.delta)}%)`,
      `* Maior cashback (últimos 6 meses): ${fmtPct(maxPts6m)}%`,
      `* Média (últimos 6 meses): ${fmtPct(mediaPts6m)}%`,
    ];
    if (padraoAltasT1 && padraoAltasT1.frequenciaDias && padraoAltasT1.proximaEstimadaData) {
      const [, mmProxT1, ddProxT1] = padraoAltasT1.proximaEstimadaData.split('-');
      linhasResumoT1.push(`* Sobe a cada ~${padraoAltasT1.frequenciaDias} dias. Possível próxima alta: ${ddProxT1}/${mmProxT1}`);
    }
    const resumoT1 = linhasResumoT1.join('\n');

    novasOfertas.push({
      id: hashId(`meliuz-t1-${v.chave}-${hoje}-${Date.now()}`),
      titulo: tituloT1,
      emoji: '⭐',
      resumo: resumoT1,
      descricao: '',
      programa: 'Méliuz',
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
        programa: 'Méliuz',
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

    console.log(`[Méliuz Tier 1] Oferta individual: "${tituloT1}"`);
  }

  // Salva controle de notificações
  notifAtual[hoje] = notifHoje;
  fs.writeFileSync(NOTIF_FILE, JSON.stringify(notifAtual, null, 2));

  // ── Publicação automática ───────────────────────────────────────────────────
  const { publicadas, naoPublicadas } = await publicarOfertas(novasOfertas, 'Méliuz');

  if (publicadas.length > 0) {
    let aprovadas = { geradoEm: null, items: [] };
    if (fs.existsSync(OFERTAS_FILE)) {
      try { aprovadas = JSON.parse(fs.readFileSync(OFERTAS_FILE, 'utf8')); } catch (e) {}
    }
    const itensAprovados = Array.isArray(aprovadas.items) ? aprovadas.items : [];
    const idsPublicados = new Set(publicadas.map(o => o.id));
    const itensRadar = [
      ...publicadas,
      ...itensAprovados.filter(o => !idsPublicados.has(o.id)),
    ].slice(0, MAX_OFERTAS_APROVADAS);

    fs.writeFileSync(OFERTAS_FILE, JSON.stringify(
      { geradoEm: new Date().toISOString(), items: itensRadar }, null, 2
    ));
    console.log(`[Méliuz] ${publicadas.length} oferta(s) publicada(s) no Radar (ofertas.json: ${itensRadar.length} itens).`);
  }

  if (naoPublicadas.length > 0) {
    fs.writeFileSync(PENDENTES_FILE, JSON.stringify({
      geradoEm: new Date().toISOString(),
      items: [...naoPublicadas, ...itensPendentes],
    }, null, 2));
    console.log(`[Méliuz] ${naoPublicadas.length} oferta(s) adicionada(s) às pendentes.`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  // Data no fuso de Brasília — precisa casar com a chave usada em coletar.js
  const hoje = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  console.log(`[Méliuz] Iniciando coleta para ${hoje}`);

  // 1. Carrega historico.json
  let historico = {};
  if (fs.existsSync(HISTORICO_FILE)) {
    try {
      historico = JSON.parse(fs.readFileSync(HISTORICO_FILE, 'utf8'));
    } catch (e) {
      console.warn('[Méliuz] historico.json corrompido — iniciando vazio.');
    }
  }

  // 2. Carrega catálogo de lojas
  if (!fs.existsSync(LOJAS_FILE)) {
    console.error('[Méliuz] meliuz-lojas.json não encontrado — rode catalogo-meliuz.js primeiro.');
    process.exit(1);
  }
  const { lojas } = JSON.parse(fs.readFileSync(LOJAS_FILE, 'utf8'));
  if (!Array.isArray(lojas) || !lojas.length) {
    console.error('[Méliuz] Catálogo vazio — abortando.');
    process.exit(1);
  }
  const porSlug = Object.fromEntries(lojas.map(l => [l.slug, l]));
  const nomesPorChave = Object.fromEntries(lojas.map(l => [l.chave, l.nome]));
  console.log(`[Méliuz] ${lojas.length} lojas no catálogo`);

  // 3. Consulta o proxy em lotes
  const resultados = [];
  for (let i = 0; i < lojas.length; i += LOTE) {
    const slugs = lojas.slice(i, i + LOTE).map(l => l.slug).join(',');
    const n = Math.floor(i / LOTE) + 1;
    const total = Math.ceil(lojas.length / LOTE);
    try {
      const d = await fetchDirect(`${API_URL}?slugs=${encodeURIComponent(slugs)}`);
      resultados.push(...(d.lojas || []));
      console.log(`[Méliuz] Lote ${n}/${total} ok`);
    } catch (e) {
      console.error(`[Méliuz] Lote ${n}/${total} falhou: ${e.message}`);
    }
  }

  const comCashback = resultados.filter(l => l.temCashback && l.pts > 0);
  console.log(`[Méliuz] ${comCashback.length}/${resultados.length} lojas com cashback ativo`);

  // Guarda de sanidade — nunca grava snapshot degradado por falha de rede/WAF
  if (resultados.length < lojas.length * 0.7 || comCashback.length < lojas.length * 0.2) {
    console.error('[Méliuz] Retorno abaixo do esperado — abortando sem salvar.');
    process.exit(1);
  }

  // 4. Monta snapshot do dia — usa a MESMA chave do Comparemania, então o
  //    merge no Comparador é automático.
  if (!historico[hoje]) historico[hoje] = {};
  const snapHoje = historico[hoje];

  for (const l of comCashback) {
    const loja = porSlug[l.slug];
    if (!loja) continue;
    const chave = loja.chave;

    if (!snapHoje[chave]) snapHoje[chave] = { programs: {} };
    if (!snapHoje[chave].programs) snapHoje[chave].programs = {};

    snapHoje[chave].programs.meliuz = {
      pts: l.pts,
      dollar: false,
      ate: !!l.ate,
      slug: l.slug,
    };

    if (!snapHoje[chave].links) snapHoje[chave].links = {};
    snapHoje[chave].links.meliuz = l.link || `https://www.meliuz.com.br/desconto/${l.slug}`;
  }

  console.log(`[Méliuz] ${comCashback.length} parceiros atualizados no historico.json`);

  // 5. Detecta variações e gera ofertas
  await gerarOfertasVariacao(snapHoje, historico, hoje, nomesPorChave);

  // 6. Remove dias com mais de 180 dias
  const corte = new Date();
  corte.setDate(corte.getDate() - 180);
  const corteStr = corte.toISOString().split('T')[0];
  for (const data of Object.keys(historico)) {
    if (data < corteStr) delete historico[data];
  }

  // 7. Salva historico.json
  fs.writeFileSync(HISTORICO_FILE, JSON.stringify(historico, null, 2));
  console.log(`[Méliuz] historico.json salvo com ${Object.keys(historico).length} dias.`);

  // Resumo top 5
  const top5 = [...comCashback].sort((a, b) => b.pts - a.pts).slice(0, 5);
  console.log('\n🏆 Top 5 cashbacks Méliuz hoje:');
  top5.forEach(l => console.log(`  ${l.ate ? 'até ' : ''}${fmtPct(l.pts)}% — ${porSlug[l.slug]?.nome || l.slug}`));
}

main().catch(e => {
  console.error('[Méliuz] Erro fatal:', e.message);
  process.exit(1);
});
