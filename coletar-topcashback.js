// coletar-topcashback.js
// Executado pelo GitHub Action (coletar-historico.yml — mesma janela do Méliuz).
// 1. Lê topcashback-lojas.json (catálogo manual, poucas lojas)
// 2. Consulta o cashback de cada loja via proxy Railway, agrupado por país
// 3. Salva/atualiza historico.json nos programas "tcbuk" e "tcbus"
// 4. Detecta aumentos e gera ofertas, seguindo as MESMAS regras do Inter e do
//    Méliuz: 1 oferta agrupada + 1 oferta individual por parceiro Tier 1, com
//    supressão da agrupada quando todos os que subiram forem Tier 1.
//
// O cashback (%) NUNCA compete com pts/R$ pela "melhor opção" no Comparador —
// a exclusão vem da flag cashback:true em PROGRAMS (painel-cdv/index.html).
//
// Diferença em relação ao Méliuz: o TopCashback publica VÁRIAS faixas por loja
// (por categoria de produto ou tipo de cliente). Guardamos o máximo como
// pontuação e o detalhamento em `categorias`, que vai para a mensagem Tier 1.

const fs   = require('fs');
const path = require('path');

const { publicarOfertas, MAX_OFERTAS_APROVADAS } = require('./mensagem-radar');
const { alertarOperador } = require('./alerta-operador');

const HISTORICO_FILE = path.join(__dirname, 'historico.json');
const LOJAS_FILE     = path.join(__dirname, 'topcashback-lojas.json');
const PENDENTES_FILE = path.join(__dirname, 'ofertas-pendentes.json');
const OFERTAS_FILE   = path.join(__dirname, 'ofertas.json');
const NOTIF_FILE     = path.join(__dirname, 'variacoes-notificadas.json');

const PROXY_URL = process.env.CDV_PROXY_URL || 'https://cdv-proxy-production.up.railway.app';
const API_URL   = `${PROXY_URL}/topcashback/cashback`;

const LOTE = 10; // limite aceito pelo endpoint /topcashback/cashback

// Rótulos por programa — usados nos títulos e resumos das ofertas
const PROGRAMAS = {
  tcbuk: { nome: 'TopCashback UK', pais: 'uk' },
  tcbus: { nome: 'TopCashback US', pais: 'us' },
};

// Tier 1: no TopCashback o catálogo é curado manualmente e todas as lojas são
// parceiras estratégicas de viagem, então TODAS recebem mensagem individual.
// Deixar o Set explícito (em vez de "sempre true") mantém a mesma mecânica dos
// outros coletores e permite rebaixar uma loja sem mudar código.
const PARCEIROS_TIER1_TCB = new Set([
  'all accor',
  'viator',
  'getyourguide',
  'omio',
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
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} para ${url}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function nomeExibicao(chave) {
  return chave.charAt(0).toUpperCase() + chave.slice(1);
}

function hashId(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return 'tcb_' + h.toString(36);
}

function fmtPct(v) {
  return String(Number(v)).replace('.', ',');
}

// Frequência média de altas + próxima alta estimada, últimos 12 meses.
// Mesmo cálculo do modal do Comparador e dos outros coletores.
function calcularFrequenciaAltas(historico, chave, progId, hoje, pontosHoje) {
  const corteDate = new Date();
  corteDate.setMonth(corteDate.getMonth() - 12);
  const corte = corteDate.toISOString().split('T')[0];
  const datas = Object.keys(historico).filter(d => d >= corte && d <= hoje && d !== hoje).sort();

  const serie = [];
  for (const d of datas) {
    const pts = historico[d]?.[chave]?.programs?.[progId]?.pts;
    if (pts != null) serie.push({ data: d, pts });
  }
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
  const datasAnteriores = Object.keys(historico).filter(d => d < hoje).sort().reverse();
  if (!datasAnteriores.length) {
    console.log('[TopCashback] Sem snapshot anterior — pulando comparação.');
    return;
  }

  const dataAnterior = datasAnteriores[0];
  const snapAnterior = historico[dataAnterior] || {};
  console.log(`[TopCashback] Comparando com snapshot de ${dataAnterior}`);

  let notifRaw = {};
  if (fs.existsSync(NOTIF_FILE)) {
    try { notifRaw = JSON.parse(fs.readFileSync(NOTIF_FILE, 'utf8')); } catch (e) {}
  }
  const notifAtual = {};
  for (const [data, entries] of Object.entries(notifRaw)) {
    if (data >= hoje) notifAtual[data] = entries;
  }
  const notifHoje = notifAtual[hoje] || {};

  // Detectar aumentos em cada programa (UK e US) separadamente
  const variacoes = [];

  for (const progId of Object.keys(PROGRAMAS)) {
    for (const [chave, dadosHoje] of Object.entries(snapHoje)) {
      const progHoje = dadosHoje.programs?.[progId];
      const ptsHoje = progHoje?.pts;
      if (!ptsHoje) continue;

      const ptsAntes = snapAnterior[chave]?.programs?.[progId]?.pts;
      if (!ptsAntes || ptsHoje <= ptsAntes) continue;

      const chaveNotif = `${progId}__${chave}`;
      if (notifHoje[chaveNotif] === ptsHoje) continue;

      variacoes.push({
        progId,
        progNome: PROGRAMAS[progId].nome,
        chave,
        nome: nomesPorChave[chave] || nomeExibicao(chave),
        ptsAntes,
        ptsAgora: ptsHoje,
        delta: Math.round((ptsHoje - ptsAntes) * 100) / 100,
        ate: !!progHoje.ate,
        categorias: progHoje.categorias || [],
        link: dadosHoje.links?.[progId] || 'https://www.topcashback.com',
      });

      notifHoje[chaveNotif] = ptsHoje;
    }
  }

  if (!variacoes.length) {
    console.log('[TopCashback] Nenhuma variação nova de cashback.');
    return;
  }

  console.log(`[TopCashback] ${variacoes.length} parceiro(s) com aumento de cashback`);

  let pendentesDados = { geradoEm: null, items: [] };
  if (fs.existsSync(PENDENTES_FILE)) {
    try { pendentesDados = JSON.parse(fs.readFileSync(PENDENTES_FILE, 'utf8')); } catch (e) {}
  }
  const itensPendentes = Array.isArray(pendentesDados.items) ? pendentesDados.items : [];
  const novasOfertas = [];

  // ── Oferta agrupada ─────────────────────────────────────────────────────────
  const count = variacoes.length;
  const todosTier1 = variacoes.every(v => PARCEIROS_TIER1_TCB.has(v.chave));

  const linhas = variacoes
    .slice()
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR') || a.progNome.localeCompare(b.progNome))
    .map(v => `💷 ${v.nome} (${v.progNome}) — ${fmtPct(v.ptsAntes)}% → ${v.ate ? 'até ' : ''}${fmtPct(v.ptsAgora)}% (+${fmtPct(v.delta)}%)`)
    .join('\n');

  const tituloAgrupado = `${count} parceiro${count > 1 ? 's tiveram' : ' teve'} aumento de cashback no TopCashback`;

  const ofertaAgrupada = {
    id: hashId(`tcb-grupo-${hoje}-${Date.now()}`),
    titulo: tituloAgrupado,
    emoji: '💷',
    resumo: `${count} parceiro${count > 1 ? 's' : ''} do TopCashback ${count > 1 ? 'tiveram' : 'teve'} aumento de cashback na última atualização do Painel do Clube do Viajante.\n\n${linhas}`,
    descricao: '',
    programa: 'TopCashback',
    bonus: '',
    prazo: '',
    categoria: 'compra_bonificada',
    loja: 'TopCashback',
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
    console.log(`[TopCashback] Oferta agrupada suprimida — ${count} parceiro(s) com variação, todos Tier 1.`);
  } else {
    novasOfertas.push(ofertaAgrupada);
    console.log(`[TopCashback] Oferta agrupada: "${tituloAgrupado}"`);
  }

  // ── Ofertas individuais Tier 1 ──────────────────────────────────────────────
  for (const v of variacoes) {
    if (!PARCEIROS_TIER1_TCB.has(v.chave)) continue;

    const hoje6m = new Date();
    hoje6m.setMonth(hoje6m.getMonth() - 6);
    const corte6m = hoje6m.toISOString().split('T')[0];

    const pts6m = Object.entries(historico)
      .filter(([d]) => d >= corte6m && d < hoje)
      .map(([, snap]) => snap[v.chave]?.programs?.[v.progId]?.pts)
      .filter(x => x != null);

    const maxPts6m = Math.max(v.ptsAgora, ...(pts6m.length ? pts6m : [v.ptsAntes]));
    const mediaPts6m = pts6m.length
      ? Math.round(pts6m.reduce((a, b) => a + b, 0) / pts6m.length * 10) / 10
      : v.ptsAntes;

    let classificacaoT1 = 'dentro_padrao';
    if (mediaPts6m > 0) {
      if (v.ptsAgora >= mediaPts6m * 1.2) classificacaoT1 = 'acima_padrao';
      else if (v.ptsAgora <= mediaPts6m * 0.8) classificacaoT1 = 'abaixo_padrao';
    }

    const padraoAltasT1 = calcularFrequenciaAltas(historico, v.chave, v.progId, hoje, v.ptsAgora);

    const tituloT1 = `${v.ate ? 'Até ' : ''}${fmtPct(v.ptsAgora)}% de cashback em ${v.nome} no ${v.progNome}`;

    const linhasResumoT1 = [
      `${v.nome} aumentou o cashback no ${v.progNome}.`,
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
    // Detalhamento das faixas — o TopCashback quase sempre tem mais de uma, e a
    // diferença entre elas costuma ser o que decide a reserva. Quando a loja tem
    // mais de um bloco de tarifa (ex: ALL Accor UK: membros vs novos clientes),
    // resumimos cada bloco por faixa mín–máx; com um bloco só, listamos as
    // categorias. Sem isso a mensagem viraria 10 linhas de nomes de bandeiras.
    if (v.categorias.length > 1) {
      const grupos = [...new Set(v.categorias.map(c => c.grupo).filter(Boolean))];
      linhasResumoT1.push('', 'Faixas de cashback:');
      if (grupos.length > 1) {
        for (const g of grupos.slice(0, 4)) {
          const pcts = v.categorias.filter(c => c.grupo === g).map(c => c.pct);
          const mn = Math.min(...pcts), mx = Math.max(...pcts);
          linhasResumoT1.push(`* ${g}: ${mn === mx ? fmtPct(mx) + '%' : fmtPct(mn) + '% a ' + fmtPct(mx) + '%'}`);
        }
      } else {
        for (const cat of v.categorias.slice(0, 6)) {
          linhasResumoT1.push(`* ${cat.nome || 'Demais compras'}: ${fmtPct(cat.pct)}%`);
        }
      }
    }

    novasOfertas.push({
      id: hashId(`tcb-t1-${v.progId}-${v.chave}-${hoje}-${Date.now()}`),
      titulo: tituloT1,
      emoji: '⭐',
      resumo: linhasResumoT1.join('\n'),
      descricao: '',
      programa: v.progNome,
      bonus: '',
      prazo: '',
      categoria: 'compra_bonificada',
      loja: v.nome,
      cupom: '',
      link: v.link,
      importante: 'Cashback pago em moeda estrangeira e sujeito às regras do TopCashback do respectivo país. Verifique elegibilidade da conta, prazo de confirmação e exclusões antes de reservar.',
      milheiro: '',
      tetoTransferencia: '',
      restricoes: [],
      publicadoEm: new Date().toISOString(),
      tipoVariacao: true,
      tier1: true,
      historicoComparacao: {
        parceiro: v.nome,
        programa: v.progNome,
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

    console.log(`[TopCashback Tier 1] Oferta individual: "${tituloT1}"`);
  }

  notifAtual[hoje] = notifHoje;
  fs.writeFileSync(NOTIF_FILE, JSON.stringify(notifAtual, null, 2));

  const { publicadas, naoPublicadas } = await publicarOfertas(novasOfertas, 'TopCashback');

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
    console.log(`[TopCashback] ${publicadas.length} oferta(s) publicada(s) no Radar.`);
  }

  if (naoPublicadas.length > 0) {
    fs.writeFileSync(PENDENTES_FILE, JSON.stringify({
      geradoEm: new Date().toISOString(),
      items: [...naoPublicadas, ...itensPendentes],
    }, null, 2));
    console.log(`[TopCashback] ${naoPublicadas.length} oferta(s) adicionada(s) às pendentes.`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const hoje = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  console.log(`[TopCashback] Iniciando coleta para ${hoje}`);

  let historico = {};
  if (fs.existsSync(HISTORICO_FILE)) {
    try {
      historico = JSON.parse(fs.readFileSync(HISTORICO_FILE, 'utf8'));
    } catch (e) {
      console.warn('[TopCashback] historico.json corrompido — iniciando vazio.');
    }
  }

  if (!fs.existsSync(LOJAS_FILE)) {
    console.error('[TopCashback] topcashback-lojas.json não encontrado — abortando.');
    process.exit(1);
  }
  const { lojas } = JSON.parse(fs.readFileSync(LOJAS_FILE, 'utf8'));
  if (!Array.isArray(lojas) || !lojas.length) {
    console.error('[TopCashback] Catálogo vazio — abortando.');
    process.exit(1);
  }
  console.log(`[TopCashback] ${lojas.length} lojas no catálogo`);

  const nomesPorChave = Object.fromEntries(lojas.map(l => [l.chave, l.nome]));

  // Agrupa por país — o endpoint recebe um país por chamada
  const porPais = {};
  for (const l of lojas) (porPais[l.pais] = porPais[l.pais] || []).push(l);

  const resultados = []; // { loja, dados }
  for (const [pais, lista] of Object.entries(porPais)) {
    for (let i = 0; i < lista.length; i += LOTE) {
      const fatia = lista.slice(i, i + LOTE);
      const slugs = fatia.map(l => l.slug).join(',');
      try {
        const d = await fetchDirect(`${API_URL}?pais=${encodeURIComponent(pais)}&slugs=${encodeURIComponent(slugs)}`);
        for (const item of (d.lojas || [])) {
          const loja = fatia.find(l => l.slug === item.slug);
          if (loja) resultados.push({ loja, dados: item });
        }
        console.log(`[TopCashback] ${pais.toUpperCase()}: ${fatia.length} loja(s) consultada(s)`);
      } catch (e) {
        console.error(`[TopCashback] ${pais.toUpperCase()} falhou: ${e.message}`);
      }
    }
  }

  const validos = resultados.filter(r => r.dados.temCashback && r.dados.pts > 0);
  console.log(`[TopCashback] ${validos.length}/${lojas.length} lojas com cashback ativo`);

  // Guarda de sanidade — catálogo é pequeno e curado, então exigimos a maioria
  if (validos.length < Math.ceil(lojas.length * 0.5)) {
    const falhas = resultados.filter(r => !r.dados.temCashback || r.dados.erro)
      .map(r => `- ${r.loja.nome} (${r.loja.pais.toUpperCase()}): ${r.dados.erro || 'sem faixa de cashback'}`);
    await alertarOperador('Coleta TopCashback abaixo do esperado', [
      `Catálogo: ${lojas.length} lojas | com cashback: ${validos.length}`,
      '',
      ...falhas,
      '',
      'Nada foi salvo. Provável causa: mudança no HTML do TopCashback (merch-cat__rate) ou slug de loja alterado.',
    ]);
    console.error('[TopCashback] Retorno abaixo do esperado — abortando sem salvar.');
    process.exit(1);
  }

  if (!historico[hoje]) historico[hoje] = {};
  const snapHoje = historico[hoje];

  for (const { loja, dados } of validos) {
    const chave = loja.chave;
    if (!snapHoje[chave]) snapHoje[chave] = { programs: {} };
    if (!snapHoje[chave].programs) snapHoje[chave].programs = {};

    snapHoje[chave].programs[loja.programa] = {
      pts: dados.pts,
      dollar: false,
      ate: !!dados.ate,
      slug: loja.slug,
      pais: loja.pais,
      categorias: dados.categorias || [],
    };

    if (!snapHoje[chave].links) snapHoje[chave].links = {};
    snapHoje[chave].links[loja.programa] = dados.link;
  }

  console.log(`[TopCashback] ${validos.length} entradas atualizadas no historico.json`);

  await gerarOfertasVariacao(snapHoje, historico, hoje, nomesPorChave);

  const corte = new Date();
  corte.setDate(corte.getDate() - 180);
  const corteStr = corte.toISOString().split('T')[0];
  for (const data of Object.keys(historico)) {
    if (data < corteStr) delete historico[data];
  }

  fs.writeFileSync(HISTORICO_FILE, JSON.stringify(historico, null, 2));
  console.log(`[TopCashback] historico.json salvo com ${Object.keys(historico).length} dias.`);

  console.log('\n🏆 Cashbacks TopCashback hoje:');
  for (const { loja, dados } of validos.sort((a, b) => b.dados.pts - a.dados.pts)) {
    console.log(`  ${dados.ate ? 'até ' : ''}${fmtPct(dados.pts)}% — ${loja.nome} (${PROGRAMAS[loja.programa].nome})`);
  }
}

main().catch(e => {
  console.error('[TopCashback] Erro fatal:', e.message);
  process.exit(1);
});
