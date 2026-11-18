// ── ANO DO PRAZO DAS OFERTAS ─────────────────────────────────────────────────
// A IA que reescreve as ofertas nao sabe a data de hoje. Quando a origem diz so
// "02 de dezembro", ela completava o ano com um chute (2025 em nov/2026), e a
// oferta entrava com prazo no passado. Duas travas:
//   1. textoDataHoje(): linha com a data de hoje para ir no prompt;
//   2. corrigirAnoPrazo(): depois da IA, toda data dd/mm/aaaa vencida ha mais
//      de 60 dias cujo
//      ano NAO aparece escrito na origem ganha o primeiro ano em que ela ainda
//      nao passou. Ano escrito na origem e respeitado (oferta vencida de
//      verdade continua vencida).
// Copia espelhada em baileys-server/server.js (corrigirAnoPrazoOferta). Mudou
// uma, muda a outra.

const TZ_OFFSET_MS = -3 * 3600e3; // America/Sao_Paulo, -03:00 fixo

function hojeSP(agora) {
  const d = new Date((agora || Date.now()) + TZ_OFFSET_MS);
  return { dia: d.getUTCDate(), mes: d.getUTCMonth() + 1, ano: d.getUTCFullYear() };
}

function textoDataHoje(agora) {
  const h = hojeSP(agora);
  const p = (n) => String(n).padStart(2, '0');
  return 'Data de hoje: ' + p(h.dia) + '/' + p(h.mes) + '/' + h.ano
    + '. Quando a origem trouxer data sem ano (ex.: "02 de dezembro"), use o ano em que essa data ainda não passou.';
}

function corrigirAnoPrazo(prazo, textoOrigem, agora) {
  const s = String(prazo || '');
  if (!s) return s;
  const h = hojeSP(agora);
  const hojeNum = h.ano * 10000 + h.mes * 100 + h.dia;
  const origem = String(textoOrigem || '');
  return s.replace(/\b(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/g, (tudo, dd, mm, aa) => {
    const dia = Number(dd), mes = Number(mm);
    let ano = Number(aa);
    if (aa.length === 2) ano += 2000;
    if (!dia || !mes || dia > 31 || mes > 12) return tudo;
    if (ano * 10000 + mes * 100 + dia >= hojeNum) return tudo;
    // Vencida ha pouco (ate 60 dias) e plausivel: captura atrasada. So o chute
    // de ano (meses no passado) e corrigido.
    const diasPassados = (Date.UTC(h.ano, h.mes - 1, h.dia) - Date.UTC(ano, mes - 1, dia)) / 864e5;
    if (diasPassados <= 60) return tudo;
    // Ano escrito na origem: vencida de verdade, nao mexe.
    if (new RegExp('\\b' + ano + '\\b').test(origem)) return tudo;
    let novo = h.ano;
    if (novo * 10000 + mes * 100 + dia < hojeNum) novo += 1;
    return dd + '/' + mm + '/' + novo;
  });
}

module.exports = { hojeSP, textoDataHoje, corrigirAnoPrazo };
