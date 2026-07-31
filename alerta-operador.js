// alerta-operador.js
// Módulo compartilhado pelos coletores (coletar.js, coletar-inter.js,
// coletar-meliuz.js, coletar-topcashback.js) para avisar o operador quando uma
// coleta degrada — programa que zerou, queda abrupta de cobertura, parser que
// parou de casar com o HTML da fonte.
//
// Por que existe: o LATAM Pass ficou ~5 meses retornando 0 parceiros sem que
// ninguém percebesse. A URL do Comparemania passou a redirecionar para /erro,
// que responde 200 e contém a palavra "ponto" — então a checagem `hasContent`
// do coletar.js passava, o parser extraía zero linhas e o coletor seguia como se
// estivesse tudo certo. Contagem por programa é o sinal que faltava.
//
// Vai para o grupo INTERNO do operador (mesmo dos avisos de "Novo cupom
// capturado"), nunca para grupos de cliente, e nunca passa pela filaRadar.
// Nunca lança: um alerta que falha não pode derrubar a coleta.

const PROXY_URL = process.env.CDV_PROXY_URL || process.env.CDV_PROXY || 'https://cdv-proxy-production.up.railway.app';

// Kill switch sem redeploy, no mesmo espírito de AUTO_PUBLICAR_VARIACOES.
const ALERTAS_ATIVOS = process.env.ALERTAS_OPERADOR !== 'false';

async function alertarOperador(titulo, linhas = []) {
  if (!ALERTAS_ATIVOS) {
    console.log('[Alerta] ALERTAS_OPERADOR=false — alerta suprimido:', titulo);
    return { ok: false, motivo: 'desativado' };
  }

  const corpo = Array.isArray(linhas) ? linhas.filter(Boolean) : [String(linhas)];
  const mensagem = [
    `⚠️ *${titulo}*`,
    '',
    ...corpo,
    '',
    `_Alerta automático do pipeline de coleta — ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}_`,
  ].join('\n');

  try {
    const r = await fetch(`${PROXY_URL}/alertas/operador`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mensagem }),
      signal: AbortSignal.timeout(25000),
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok && d.ok) {
      console.log(`[Alerta] ✓ Enviado ao operador: "${titulo}"`);
      return { ok: true };
    }
    console.warn(`[Alerta] ✗ Falha ao enviar "${titulo}":`, d.erro || `status ${r.status}`);
    return { ok: false, erro: d.erro || `status ${r.status}` };
  } catch (e) {
    console.warn(`[Alerta] ✗ Falha ao enviar "${titulo}":`, e.message);
    return { ok: false, erro: e.message };
  }
}

// Compara a contagem de itens por programa contra o último snapshot anterior que
// tinha dados daquele programa, e devolve as quedas relevantes.
//
// `contagemHoje`  → { livelo: 252, latam: 0, ... }
// `historico`     → objeto completo do historico.json
// `hoje`          → 'YYYY-MM-DD'
// `nomes`         → { livelo: 'Livelo', latam: 'LATAM Pass', ... }
//
// Regras: só alerta se o programa tinha pelo menos MIN_BASE ontem (evita ruído
// de programas naturalmente pequenos) e caiu a zero ou perdeu mais da metade.
function detectarQuedas(contagemHoje, historico, hoje, nomes = {}, MIN_BASE = 10) {
  const datas = Object.keys(historico).filter(d => d < hoje).sort().reverse();
  const quedas = [];

  for (const [progId, atual] of Object.entries(contagemHoje)) {
    // Última data em que esse programa teve QUALQUER dado
    let anterior = 0;
    let dataRef = null;
    for (const d of datas) {
      const n = Object.values(historico[d] || {})
        .filter(p => p?.programs?.[progId] != null).length;
      if (n > 0) { anterior = n; dataRef = d; break; }
    }

    if (anterior < MIN_BASE) continue;

    if (atual === 0) {
      quedas.push({
        progId, nome: nomes[progId] || progId, atual, anterior, dataRef,
        gravidade: 'zerado',
      });
    } else if (atual < anterior * 0.5) {
      quedas.push({
        progId, nome: nomes[progId] || progId, atual, anterior, dataRef,
        gravidade: 'queda',
      });
    }
  }

  return quedas;
}

module.exports = { alertarOperador, detectarQuedas, ALERTAS_ATIVOS };
