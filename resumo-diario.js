// resumo-diario.js
// Executado pelo GitHub Action diariamente às 19h (SP).
// 1. Lê ofertas.json e passagens.json do checkout local
// 2. Monta o resumo de ofertas do dia (novidades + vigentes) — condensado com IA
// 3. Monta o resumo de emissões do dia (dedup + 🔥 menor valor histórico) — template
// 4. Envia os dois via Baileys com agendarEm fixado nas 20h00 (SP)
//    → grupo cdv_ofertas (News CDV) e grupo cdv_emissao (Emissões CDV)
//
// Variáveis de ambiente:
//   ANTHROPIC_API_KEY → chave da API Anthropic (mesma do radar)
//
// Uso: node resumo-diario.js
//      node resumo-diario.js --dry-run   (só imprime as mensagens, não envia)

const fs = require('fs');
const path = require('path');

const BAILEYS = 'https://baileys-server-production-ebfe.up.railway.app';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const DRY_RUN = process.argv.includes('--dry-run');

const OFERTAS_FILE = path.join(__dirname, 'ofertas.json');
const PASSAGENS_FILE = path.join(__dirname, 'passagens.json');

const RODAPE = '`Confira tudo com detalhes no Painel CDV: https://painel.clubedoviajante.com.br`';

// ── Datas (America/Sao_Paulo, UTC-3 fixo desde 2019) ─────────────────────────
function hojeSP() {
  // RESUMO_DATA=YYYY-MM-DD permite simular outro dia (testes / reprocessamento)
  if (process.env.RESUMO_DATA && /^\d{4}-\d{2}-\d{2}$/.test(process.env.RESUMO_DATA)) return process.env.RESUMO_DATA;
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }); // YYYY-MM-DD
}
function diaSP(iso) {
  try { return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }); }
  catch { return ''; }
}
function hojeDDMM() {
  const [y, m, d] = hojeSP().split('-');
  return `${d}/${m}`;
}
// 20h00 de hoje em SP → ISO UTC (para agendarEm do Baileys)
function agendar20hSP() {
  return new Date(`${hojeSP()}T20:00:00-03:00`).toISOString();
}

const MESES = {
  janeiro: 1, fevereiro: 2, 'março': 3, marco: 3, abril: 4, maio: 5, junho: 6,
  julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
};
// Converte prazo livre ("22/07/2026", "22 de julho de 2026") → "YYYY-MM-DD" ou null
function parsePrazo(pz) {
  if (!pz) return null;
  let m = pz.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  m = pz.toLowerCase().match(/(\d{1,2})\s+de\s+([a-zç]+)\s+de\s+(\d{4})/);
  if (m && MESES[m[2]]) return `${m[3]}-${String(MESES[m[2]]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  return null;
}
function fmtPrazoCurto(isoDate) {
  const [, m, d] = isoDate.split('-');
  return `${d}/${m}`;
}

const norm = (s) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
const fmtPts = (n) => Number(n).toLocaleString('pt-BR');

// ══════════════════════════════════════════════════════════════════════════════
// RESUMO DE OFERTAS (News CDV)
// ══════════════════════════════════════════════════════════════════════════════

async function montarResumoOfertas() {
  const data = JSON.parse(fs.readFileSync(OFERTAS_FILE, 'utf8'));
  const items = data.items || [];
  const hoje = hojeSP();

  const novidades = items.filter((o) => o.publicadoEm && diaSP(o.publicadoEm) === hoje);
  const vigentes = items.filter((o) => {
    if (!o.publicadoEm || diaSP(o.publicadoEm) >= hoje) return false;
    const p = parsePrazo(o.prazo);
    return p && p >= hoje; // inclui o último dia
  });

  if (novidades.length === 0) {
    console.log('[Resumo] Nenhuma oferta nova hoje — resumo de ofertas não será enviado.');
    return null;
  }

  const compactar = (o) => ({
    titulo: o.titulo || '',
    categoria: o.categoria || 'geral',
    programa: o.programa || '',
    bonus: (o.bonus || '').slice(0, 160),
    loja: o.loja || '',
    cupom: o.cupom || '',
    milheiro: (o.milheiro || '').split('\n')[0].slice(0, 120),
    prazo: parsePrazo(o.prazo) || '',
  });

  const payload = {
    hoje,
    novidades: novidades.map(compactar),
    aindaValendo: vigentes.map(compactar),
  };

  try {
    const msg = await condensarOfertasComIA(payload);
    if (msg && msg.length > 100) return msg;
    console.warn('[Resumo] Resposta da IA inválida, usando fallback determinístico.');
  } catch (e) {
    console.warn('[Resumo] Falha na IA, usando fallback determinístico:', e.message);
  }
  return fallbackOfertas(payload);
}

async function condensarOfertasComIA(payload) {
  const prompt = `Você monta o resumo diário de ofertas do grupo de WhatsApp do Clube do Viajante.
Hoje é ${payload.hoje}. Abaixo, em JSON, as ofertas NOVAS de hoje e as de dias anteriores AINDA VÁLIDAS.

REGRAS OBRIGATÓRIAS:
- Use SOMENTE os dados fornecidos. NUNCA invente valores, prazos, cupons ou nomes.
- DEDUPLIQUE: a mesma oferta captada de fontes diferentes gera títulos parecidos (mesmo programa + mesmo bônus + mesma origem). Mantenha só uma versão, a de título mais claro.
- Formatação WhatsApp: *negrito* com asteriscos simples. Nada de markdown de link.
- Estrutura EXATA:

📋 *Resumo de ofertas — ${hojeDDMM()}*

🆕 *Novidades de hoje*

(seções na ordem, incluindo só as que tiverem itens:)
🔄 *Transferências bonificadas*  → categoria "transferencia". Formato: • Origem → Destino: até X% de bônus (até DD/MM)
🎫 *Clubes de assinatura*        → categoria "clube"
💰 *Compra de pontos*            → categoria "compra"
💳 *Cartões*                     → categoria "cartao"
🛍️ *Compras bonificadas*        → categoria "compra_bonificada". Itens do tipo "N parceiros tiveram aumento de pontuação com X" NÃO viram bullets individuais: condense TODOS num bullet final "• N parceiros subiram na Livelo, M na Esfera..." somando por programa. Lojas individuais viram bullets "• Loja: X pts/R$ (Programa)" — no máximo 4 bullets, escolha os de maior pontuação; pode juntar 2 lojas na mesma linha separadas por " | ".
📰 *Outras*                      → categoria "geral" e demais

- Cada bullet: 1 linha, terminando com "(até DD/MM)" quando houver prazo. Se o prazo for HOJE (${payload.hoje}), termine com "(⏰ último dia!)".
- Inclua cupom quando existir: "— cupom XXXX".
- Depois das novidades, se houver itens em aindaValendo:

♻️ *Ainda valendo*
(bullets no mesmo formato, sem subdividir por categoria, ordenados por prazo mais próximo primeiro)

- Última linha, exatamente:
${RODAPE}

- Nada antes do 📋 nem depois do rodapé. Sem preâmbulo, sem explicações.

DADOS:
${JSON.stringify(payload)}`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!r.ok) throw new Error(`Anthropic API ${r.status}`);
  const d = await r.json();
  return (d.content || []).map((c) => c.text || '').join('').trim();
}

// Fallback sem IA: listagem simples por categoria (sem dedup textual)
function fallbackOfertas(payload) {
  const CATS = [
    ['transferencia', '🔄 *Transferências bonificadas*'],
    ['clube', '🎫 *Clubes de assinatura*'],
    ['compra', '💰 *Compra de pontos*'],
    ['cartao', '💳 *Cartões*'],
    ['compra_bonificada', '🛍️ *Compras bonificadas*'],
    ['geral', '📰 *Outras*'],
  ];
  const hoje = payload.hoje;
  const linha = (o) => {
    let l = `• ${o.titulo}`;
    if (o.cupom) l += ` — cupom ${o.cupom}`;
    if (o.prazo) l += o.prazo === hoje ? ' (⏰ último dia!)' : ` (até ${fmtPrazoCurto(o.prazo)})`;
    return l;
  };
  const catValida = new Set(CATS.map(([c]) => c));
  const bucket = (o) => (catValida.has(o.categoria) ? o.categoria : 'geral');
  const partes = [`📋 *Resumo de ofertas — ${hojeDDMM()}*`, '', '🆕 *Novidades de hoje*'];
  for (const [cat, header] of CATS) {
    const doCat = payload.novidades.filter((o) => bucket(o) === cat);
    if (!doCat.length) continue;
    partes.push('', header);
    doCat.slice(0, 8).forEach((o) => partes.push(linha(o)));
    if (doCat.length > 8) partes.push(`• ...e mais ${doCat.length - 8} ofertas`);
  }
  if (payload.aindaValendo.length) {
    partes.push('', '♻️ *Ainda valendo*');
    [...payload.aindaValendo]
      .sort((a, b) => (a.prazo || '9999').localeCompare(b.prazo || '9999'))
      .slice(0, 8)
      .forEach((o) => partes.push(linha(o)));
  }
  partes.push('', RODAPE);
  return partes.join('\n');
}

// ══════════════════════════════════════════════════════════════════════════════
// RESUMO DE EMISSÕES (Emissões CDV)
// ══════════════════════════════════════════════════════════════════════════════

const CIDADES_BR = [
  'sao paulo', 'rio de janeiro', 'belo horizonte', 'brasilia', 'salvador', 'recife',
  'fortaleza', 'curitiba', 'porto alegre', 'florianopolis', 'goiania', 'vitoria',
  'maceio', 'natal', 'joao pessoa', 'aracaju', 'manaus', 'belem', 'sao luis',
  'teresina', 'campo grande', 'cuiaba', 'uberlandia', 'campinas', 'foz do iguacu',
  'navegantes', 'joinville', 'londrina', 'maringa', 'marilia', 'petrolina', 'ilheus',
  'porto seguro', 'juazeiro do norte', 'imperatriz', 'palmas', 'rio branco',
  'porto velho', 'boa vista', 'macapa', 'chapeco', 'caxias do sul', 'passo fundo',
  'santarem', 'jericoacoara', 'fernando de noronha', 'presidente prudente',
  'sao jose do rio preto', 'ribeirao preto', 'montes claros', 'governador valadares',
  'ipatinga', 'sinop', 'dourados', 'bauru', 'caldas novas', 'bonito', 'uberaba',
  'vitoria da conquista', 'feira de santana', 'caruaru', 'mossoro', 'cascavel',
  'ponta grossa', 'criciuma', 'lages', 'santa maria', 'pelotas', 'araguaina',
];
const isBR = (c) => CIDADES_BR.includes(norm(c));

function montarResumoEmissoes() {
  const data = JSON.parse(fs.readFileSync(PASSAGENS_FILE, 'utf8'));
  const all = (data.items || []).filter((p) => p.fonte !== 'alerta_rejeitado');
  const hoje = hojeSP();

  const doDia = all.filter((p) => p.enviadoEm && diaSP(p.enviadoEm) === hoje);
  if (doDia.length === 0) {
    console.log('[Resumo] Nenhuma passagem hoje — resumo de emissões não será enviado.');
    return null;
  }

  const chave = (p) => `${norm(p.origem)}>${norm(p.destino)}|${p.programa}|${norm(p.cabine)}`;

  // Dedup do dia: menor pontos por rota+programa+cabine
  const mapa = {};
  for (const p of doDia) {
    const k = chave(p);
    if (!mapa[k] || p.pontos < mapa[k].pontos) mapa[k] = p;
  }
  const unicos = Object.values(mapa);

  // Mínimo histórico (antes de hoje) por rota+programa+cabine
  const hist = {};
  for (const p of all) {
    if (!p.enviadoEm || diaSP(p.enviadoEm) >= hoje) continue;
    const k = chave(p);
    if (!(k in hist) || p.pontos < hist[k]) hist[k] = p.pontos;
  }

  // 🔥 = estritamente abaixo do mínimo histórico (rotas sem histórico não ganham selo)
  const quedaPct = (p) => (hist[chave(p)] - p.pontos) / hist[chave(p)];
  const fires = unicos
    .filter((p) => hist[chave(p)] !== undefined && p.pontos < hist[chave(p)])
    .sort((a, b) => quedaPct(b) - quedaPct(a))
    .slice(0, 8);
  const fireKeys = new Set(fires.map(chave));

  const exec = (p) => /exec/i.test(p.cabine || '');
  const restantes = unicos.filter((p) => !fireKeys.has(chave(p)));
  const nac = restantes.filter((p) => isBR(p.origem) && isBR(p.destino) && !exec(p)).sort((a, b) => a.pontos - b.pontos);
  const intl = restantes.filter((p) => !(isBR(p.origem) && isBR(p.destino)) && !exec(p)).sort((a, b) => a.pontos - b.pontos);
  const execs = restantes.filter(exec).sort((a, b) => a.pontos - b.pontos);

  const nacTotal = unicos.filter((p) => isBR(p.origem) && isBR(p.destino)).length;
  const intlTotal = unicos.length - nacTotal;
  const porPrograma = {};
  unicos.forEach((p) => { porPrograma[p.programa] = (porPrograma[p.programa] || 0) + 1; });
  const topProgs = Object.entries(porPrograma)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([prog, n]) => `${prog} (${n})`)
    .join(', ');

  const linhaFire = (p) => {
    const cab = exec(p) ? ' *Executiva*' : '';
    return `• ${p.origem} → ${p.destino}${cab}: ${fmtPts(p.pontos)} pts — antes ${fmtPts(hist[chave(p)])} (${p.programa})`;
  };
  const linha = (p) => `• ${p.origem} → ${p.destino}: ${fmtPts(p.pontos)} pts (${p.programa})`;

  const partes = [
    `✈️ *Resumo de emissões — ${hojeDDMM()}*`,
    '',
    `Foram *${unicos.length} oportunidades* divulgadas hoje. Destaques:`,
  ];
  if (fires.length) {
    partes.push('', '🔥 *MENOR VALOR HISTÓRICO*');
    fires.forEach((p) => partes.push(linhaFire(p)));
  }
  if (nac.length) {
    partes.push('', '🇧🇷 *Nacionais — menores valores do dia*');
    nac.slice(0, 5).forEach((p) => partes.push(linha(p)));
  }
  if (intl.length) {
    partes.push('', '🌎 *Internacionais — menores valores do dia*');
    intl.slice(0, 5).forEach((p) => partes.push(linha(p)));
  }
  if (execs.length) {
    partes.push('', '💺 *Executiva*');
    execs.slice(0, 3).forEach((p) => partes.push(linha(p)));
  }
  partes.push('', `📊 ${nacTotal} nacionais | ${intlTotal} internacionais | ${topProgs}`);
  partes.push('', RODAPE);
  return partes.join('\n');
}

// ══════════════════════════════════════════════════════════════════════════════
// ENVIO
// ══════════════════════════════════════════════════════════════════════════════

async function enviar(mensagem, grupo) {
  const agendarEm = agendar20hSP();
  if (DRY_RUN) {
    console.log(`\n──── [DRY RUN] grupo=${grupo} agendarEm=${agendarEm} ────\n${mensagem}\n`);
    return;
  }
  const r = await fetch(`${BAILEYS}/enviar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mensagem, grupo, agendarEm }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.ok) throw new Error(`Baileys /enviar grupo=${grupo}: ${d.erro || r.status}`);
  console.log(`[Resumo] ${grupo}: ${d.agendado ? `agendado para ${d.horario}` : 'enviado imediatamente'}`);
}

async function main() {
  console.log(`[Resumo] Dia ${hojeSP()} — montando resumos...`);

  const msgOfertas = await montarResumoOfertas();
  const msgEmissoes = montarResumoEmissoes();

  if (msgOfertas) await enviar(msgOfertas, 'cdv_ofertas');
  if (msgEmissoes) await enviar(msgEmissoes, 'cdv_emissao');

  if (!msgOfertas && !msgEmissoes) console.log('[Resumo] Nada a enviar hoje.');
  console.log('[Resumo] Concluído.');
}

main().catch((e) => {
  console.error('[Resumo] Erro fatal:', e);
  process.exit(1);
});
