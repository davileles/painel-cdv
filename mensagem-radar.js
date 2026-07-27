// mensagem-radar.js
// Modulo compartilhado por coletar.js (variacoes de pontuacao) e
// coletar-inter.js (variacoes de cashback do Shopping Inter).
//
// Centraliza a montagem da mensagem de WhatsApp e a publicacao automatica das
// ofertas de variacao, para que os dois coletores enviem exatamente a mesma
// coisa, do mesmo jeito, com o mesmo kill switch.

// ── Publicacao automatica das ofertas de variacao ────────────────────────────
// O envio usa exatamente o mesmo caminho da aprovacao manual:
//   POST /ofertas/enviar (proxy) → POST /radar/enviar (baileys-server)
// A filaRadar do baileys-server ja espaca os envios em 3 minutos, com retry 3x
// e espera de conexao do WhatsApp. Por isso NAO existe sleep aqui: o Action
// enfileira tudo e encerra em segundos, enquanto o worker envia no ritmo certo.
const CDV_PROXY             = process.env.CDV_PROXY || 'https://cdv-proxy-production.up.railway.app';
const GRUPO_OFERTA          = 'cdv_ofertas';
const MAX_OFERTAS_APROVADAS = 100;   // mesmo teto usado pelo proxy em /ofertas/aprovar
// Kill switch sem redeploy: basta setar AUTO_PUBLICAR_VARIACOES=false no workflow
// para tudo voltar a cair na aba "Aprovar Ofertas".
const AUTO_PUBLICAR         = process.env.AUTO_PUBLICAR_VARIACOES !== 'false';
// ── Montagem da mensagem de WhatsApp ─────────────────────────────────────────
// PORTE FIEL de gerador-cdv/index.html (stripEmojis / compactarLinhasTeto /
// agruparCondicoes / montarMensagemRadar). Se uma das duas mudar, a outra
// precisa acompanhar — senao a mensagem publicada automaticamente deixa de ser
// identica a que era revisada na aba "Aprovar Ofertas".
// blocoHistoricoTransferencia() nao foi portado de proposito: ele so produz
// saida quando categoria === 'transferencia', e ofertas de variacao sao sempre
// 'compra_bonificada'.
const RODAPE_OFERTA = '`Faça parte do Clube do Viajante e economize até 90% nas suas passagens: https://clubedoviajante.com.br/`';

function stripEmojis(str) {
  if (!str) return '';
  return str.replace(/[\u{1F000}-\u{1FFFF}]|[\u{2600}-\u{27BF}]|[\u{2300}-\u{23FF}]|[\u{FE00}-\u{FE0F}]|[\u{1F900}-\u{1F9FF}]|\u{20E3}/gu, '').replace(/^\s*[-–]\s*/, '').trim();
}

function compactarLinhasTeto(str) {
  if (!str) return [];
  return str.split('\n').map(function (l) {
    var limpo = stripEmojis(l.trim()).replace(/^-\s*/, '');
    var m = limpo.match(/^(Bônus de .+?)\s*[:：]\s*transfira\s+até\s+([\d.,]+\s+pontos?).*$/i);
    if (m) return m[1] + ': até ' + m[2];
    return limpo;
  }).filter(Boolean);
}

function agruparCondicoes(restricoes) {
  var volume = [], tempo = [], gerais = [];
  (restricoes || []).forEach(function (r) {
    var s = stripEmojis(r).replace(/^-\s*/, '').trim();
    if (!s) return;
    if (/^transferências? (?:de \d|acima)/i.test(s)) volume.push(s);
    else if (/^\+\d+%|adicional.*tempo|há mais|entre \d.*ano/i.test(s)) tempo.push(s);
    else gerais.push(s);
  });
  return { volume: volume, tempo: tempo, gerais: gerais };
}

function montarMensagemRadar(o) {
  var msg = '';

  if (o.titulo) msg += '*' + o.titulo + '*\n\n';
  if (o.resumo) msg += stripEmojis(o.resumo) + '\n\n';

  if (o.milheiro) {
    var lm = o.milheiro.split('\n').map(function (l) { return stripEmojis(l.trim()).replace(/^-\s*/, ''); }).filter(Boolean);
    if (lm.length) {
      msg += '*Custo do milheiro*\n';
      lm.forEach(function (l) { msg += '- ' + l + '\n'; });
      msg += '\n';
    }
  }

  if (o.tetoTransferencia) {
    var lt = compactarLinhasTeto(o.tetoTransferencia);
    if (lt.length) {
      msg += '*Teto de bônus — máximo a transferir por perfil*\n';
      lt.forEach(function (l) { msg += '- ' + l + '\n'; });
      msg += '\n';
    }
  }

  if (o.restricoes && o.restricoes.length) {
    var g = agruparCondicoes(o.restricoes);
    if (g.volume.length) {
      msg += '*Bônus por volume transferido*\n';
      g.volume.forEach(function (l) { msg += '- ' + l + '\n'; });
      msg += '\n';
    }
    if (g.tempo.length) {
      msg += '*Bônus adicional por tempo no Clube*\n';
      g.tempo.forEach(function (l) { msg += '- ' + l + '\n'; });
      msg += '\n';
    }
    if (g.gerais.length) {
      msg += '*Condições*\n';
      g.gerais.forEach(function (l) { msg += '- ' + l + '\n'; });
      msg += '\n';
    }
  }

  if (o.loja) msg += '🛒 *LOJA* ' + o.loja + '\n\n';
  if (o.cupom) msg += '🏷️ *CUPOM* ' + o.cupom + '\n\n';
  if (o.prazo && o.prazo.toLowerCase() !== 'não informado' && o.prazo !== '') {
    msg += '📆 *PRAZO* ' + o.prazo + '\n\n';
  }
  if (o.importante) msg += '⚠️ *IMPORTANTE* ' + stripEmojis(o.importante) + '\n\n';
  msg += '🔗 *LINK* ' + (o.link || '—') + '\n\n';
  msg += RODAPE_OFERTA;
  return msg;
}

// Enfileira a oferta na filaRadar do baileys-server (3 min entre mensagens).
// Nunca lanca: devolve { ok: false, erro } para que a oferta caia na fila
// manual em vez de sumir.
async function enfileirarOfertaWhatsApp(oferta) {
  const mensagem = montarMensagemRadar(oferta);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch(`${CDV_PROXY}/ofertas/enviar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: oferta.id, mensagem, grupo: GRUPO_OFERTA }),
      signal: ctrl.signal,
    });
    let d = {};
    try { d = await res.json(); } catch (e) { /* resposta nao-JSON */ }
    if (res.ok && d.ok) return { ok: true, posicao: d.posicao, minutos: d.minutos };
    return { ok: false, erro: d.erro || d.error || `status ${res.status}` };
  } catch (e) {
    return { ok: false, erro: e.message };
  } finally {
    clearTimeout(t);
  }
}

// ── Publicacao automatica ────────────────────────────────────────────────────
// Estas ofertas vem de dado proprio e deterministico (o historico coletado
// pelos proprios coletores), entao nao passam pela aba "Aprovar Ofertas": a
// mensagem e montada, enviada no grupo do WhatsApp e a oferta entra em
// ofertas.json — arquivo lido pela aba Radar de Ofertas do painel.
// Se o enfileiramento falhar (proxy ou Baileys fora do ar), a oferta volta em
// naoPublicadas e o chamador a joga em ofertas-pendentes.json, preservando a
// aprovacao manual como rede de seguranca.
async function publicarOfertas(novasOfertas, tag) {
  const prefixo = '[' + (tag || 'Variacao') + ']';
  const publicadas = [];
  const naoPublicadas = [];

  if (!AUTO_PUBLICAR) {
    console.log(`${prefixo} AUTO_PUBLICAR_VARIACOES=false — tudo segue para aprovacao manual.`);
    naoPublicadas.push(...novasOfertas);
    return { publicadas, naoPublicadas };
  }

  for (const oferta of novasOfertas) {
    const envio = await enfileirarOfertaWhatsApp(oferta);
    if (envio.ok) {
      publicadas.push({
        ...oferta,
        publicadaAutomaticamente: true,
        enfileiradaEm: new Date().toISOString(),
      });
      console.log(`${prefixo} ✓ Enfileirada: "${oferta.titulo}" (posicao ${envio.posicao}, ~${envio.minutos} min)`);
    } else {
      naoPublicadas.push(oferta);
      console.warn(`${prefixo} ✗ Falha ao enfileirar "${oferta.titulo}": ${envio.erro} — vai para aprovacao manual.`);
    }
  }

  return { publicadas, naoPublicadas };
}

module.exports = {
  CDV_PROXY,
  GRUPO_OFERTA,
  MAX_OFERTAS_APROVADAS,
  AUTO_PUBLICAR,
  RODAPE_OFERTA,
  stripEmojis,
  compactarLinhasTeto,
  agruparCondicoes,
  montarMensagemRadar,
  enfileirarOfertaWhatsApp,
  publicarOfertas,
};
