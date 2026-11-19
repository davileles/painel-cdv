'use strict';
// danfse.cjs — DANFSe (PDF da NFS-e Nacional) gerado a partir do XML autorizado.
//
// A API de DANFSe do Ambiente de Dados Nacional (adn.nfse.gov.br/danfse/{chave})
// foi desativada em 03/08/2026 pela NT SE/CGNFS-e 008 e responde 503 para sempre;
// desde então quem emite por sistema próprio monta o PDF a partir do XML.
//
// MESMO ARQUIVO em painel-cdv/danfse.cjs (Gestão CDV) e baileys-server/danfse.cjs
// (Tica Promos) — regra "mesma função, mesmo código". Mudou um, copie no outro.
// Sem dependência nova: PDF escrito à mão com as fontes padrão do PDF (Helvetica);
// o QR Code usa a biblioteca "qrcode" se ela estiver instalada.
const zlib = require('zlib');

// Larguras das fontes padrão do PDF (Adobe Core 14, Helvetica e Helvetica-Bold),
// em milésimos do corpo, para os códigos 32 a 255 da codificação WinAnsi.
const LARG_N = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584,0,556,0,222,556,333,1000,556,556,333,1000,667,333,1000,0,611,0,0,222,222,333,333,350,556,1000,333,1000,500,333,944,0,500,667,278,333,556,556,556,556,260,556,333,737,370,556,584,333,737,333,400,584,333,333,333,556,537,278,333,333,365,556,834,834,834,611,667,667,667,667,667,667,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,500,556,556,556,556,278,278,278,278,556,556,556,556,556,556,556,584,611,556,556,556,556,500,556,500];
const LARG_B = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584,0,556,0,278,556,500,1000,556,556,333,1000,667,333,1000,0,611,0,0,278,278,500,500,350,556,1000,333,1000,556,333,944,0,500,667,278,333,556,556,556,556,280,556,333,737,370,556,584,333,737,333,400,584,333,333,333,611,556,278,333,333,365,556,834,834,834,611,722,722,722,722,722,722,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,556,556,556,556,556,278,278,278,278,611,611,611,611,611,611,611,584,611,611,611,611,611,556,611,556];

// ── Texto em WinAnsi ─────────────────────────────────────────────────────────
const ESPECIAIS = { '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89,
  'Š': 0x8A, '‹': 0x8B, 'Œ': 0x8C, 'Ž': 0x8E, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96,
  '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9A, '›': 0x9B, 'œ': 0x9C, 'ž': 0x9E, 'Ÿ': 0x9F };
function codigos(txt) {
  const out = [];
  for (const ch of String(txt == null ? '' : txt)) {
    let c = ch.codePointAt(0);
    if (c === 9 || c === 10 || c === 13) c = 32;
    if (c >= 32 && c < 127) { out.push(c); continue; }
    if (c >= 160 && c <= 255) { out.push(c); continue; }
    if (ESPECIAIS[ch]) { out.push(ESPECIAIS[ch]); continue; }
    const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
    const b = base.codePointAt(0);
    out.push(base && b >= 32 && b < 127 ? b : 63);
  }
  return out;
}
function largura(txt, tam, negrito) {
  const t = negrito ? LARG_B : LARG_N;
  let s = 0;
  for (const c of codigos(txt)) s += t[c - 32] || 500;
  return s * tam / 1000;
}
function strPdf(txt) {
  let s = '(';
  for (const c of codigos(txt)) {
    if (c === 40 || c === 41 || c === 92) s += '\\' + String.fromCharCode(c);
    else if (c > 126) s += '\\' + c.toString(8).padStart(3, '0');
    else s += String.fromCharCode(c);
  }
  return s + ')';
}
// Quebra em linhas que cabem em `max` pontos (respeita as quebras do texto).
function quebrar(txt, tam, max, negrito) {
  const linhas = [];
  for (const par of String(txt == null ? '' : txt).replace(/\r/g, '').split('\n')) {
    let atual = '';
    for (let pal of par.split(/\s+/).filter(Boolean)) {
      while (largura(pal, tam, negrito) > max) {   // palavra maior que a linha
        let i = 1;
        while (i < pal.length && largura(pal.slice(0, i + 1), tam, negrito) <= max) i++;
        if (atual) { linhas.push(atual); atual = ''; }
        linhas.push(pal.slice(0, i)); pal = pal.slice(i);
      }
      const tent = atual ? atual + ' ' + pal : pal;
      if (largura(tent, tam, negrito) <= max) atual = tent;
      else { if (atual) linhas.push(atual); atual = pal; }
    }
    linhas.push(atual);
  }
  while (linhas.length > 1 && linhas[linhas.length - 1] === '') linhas.pop();
  return linhas;
}

// ── PDF mínimo (uma página A4, Helvetica, sem fontes embutidas) ──────────────
const LP = 595.28, AP = 841.89;
function num(n) { return (Math.round(n * 100) / 100).toString(); }
function cor(c) { return c.map(num).join(' '); }
class Pagina {
  constructor() { this.ops = []; }
  texto(x, y, txt, { tam = 8, negrito = false, rgb = [0, 0, 0] } = {}) {
    if (txt === '' || txt == null) return;
    this.ops.push(`BT ${cor(rgb)} rg /${negrito ? 'F2' : 'F1'} ${num(tam)} Tf 1 0 0 1 ${num(x)} ${num(AP - y)} Tm ${strPdf(txt)} Tj ET`);
  }
  retangulo(x, y, w, h, { preencher = null, contorno = [0, 0, 0], espessura = 0.6 } = {}) {
    const r = `${num(x)} ${num(AP - y - h)} ${num(w)} ${num(h)} re`;
    if (preencher && contorno) this.ops.push(`${cor(preencher)} rg ${cor(contorno)} RG ${num(espessura)} w ${r} B`);
    else if (preencher) this.ops.push(`${cor(preencher)} rg ${r} f`);
    else this.ops.push(`${cor(contorno)} RG ${num(espessura)} w ${r} S`);
  }
  linha(x1, y1, x2, y2, { rgb = [0, 0, 0], espessura = 0.4 } = {}) {
    this.ops.push(`${cor(rgb)} RG ${num(espessura)} w ${num(x1)} ${num(AP - y1)} m ${num(x2)} ${num(AP - y2)} l S`);
  }
  // Texto girado (marca d'água "CANCELADA"/"SUBSTITUÍDA").
  textoGirado(cx, cy, txt, graus, { tam = 60, rgb = [0.8, 0.8, 0.8] } = {}) {
    const a = graus * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    const w = largura(txt, tam, true);
    const x = cx - (c * w) / 2, y = (AP - cy) - (s * w) / 2;
    this.ops.push(`q BT ${cor(rgb)} rg /F2 ${num(tam)} Tf ${num(c)} ${num(s)} ${num(-s)} ${num(c)} ${num(x)} ${num(y)} Tm ${strPdf(txt)} Tj ET Q`);
  }
  pdf(titulo) {
    const conteudo = zlib.deflateSync(Buffer.from(this.ops.join('\n'), 'latin1'));
    const objs = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${LP} ${AP}] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>`,
      null,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
      `<< /Title ${strPdf(titulo || 'DANFSe')} /Producer (DANFSe CDV/Tica) >>`,
    ];
    const partes = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
    const posicoes = [];
    let tam = partes[0].length;
    objs.forEach((o, i) => {
      posicoes.push(tam);
      const b = o === null
        ? Buffer.concat([Buffer.from(`${i + 1} 0 obj\n<< /Length ${conteudo.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'), conteudo, Buffer.from('\nendstream\nendobj\n', 'latin1')])
        : Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, 'latin1');
      partes.push(b); tam += b.length;
    });
    let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    for (const p of posicoes) xref += String(p).padStart(10, '0') + ' 00000 n \n';
    xref += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info ${objs.length} 0 R >>\nstartxref\n${tam}\n%%EOF\n`;
    partes.push(Buffer.from(xref, 'latin1'));
    return Buffer.concat(partes);
  }
}

// ── Leitura do XML da NFS-e ──────────────────────────────────────────────────
function decodificar(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k === 'amp') return '&'; if (k === 'lt') return '<'; if (k === 'gt') return '>';
    if (k === 'quot') return '"'; if (k === 'apos') return "'";
    const n = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return Number.isFinite(n) ? String.fromCodePoint(n) : m;
  });
}
function bloco(xml, tag) {
  const m = new RegExp(`<(?:[\\w-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`).exec(String(xml || ''));
  return m ? m[1] : '';
}
function campo(xml, tag) { const b = bloco(xml, tag); return b && !/</.test(b) ? decodificar(b.trim()) : ''; }

function lerNfse(xml) {
  xml = String(xml || '').replace(/^﻿/, '');
  const iDps = xml.search(/<(?:[\w-]+:)?DPS[\s>]/);
  const nf = iDps > 0 ? xml.slice(0, iDps) : xml;
  const dps = iDps > 0 ? xml.slice(iDps) : '';
  const inf = bloco(dps, 'infDPS') || dps;
  const emit = bloco(nf, 'emit');
  const prest = bloco(inf, 'prest');
  const serv = bloco(inf, 'serv');
  const vDps = bloco(inf, 'valores');
  const vNf = bloco(nf, 'valores');
  const pessoa = (b) => {
    if (!b) return null;
    const end = bloco(b, 'end') || bloco(b, 'enderNac') || b;
    const nac = bloco(end, 'endNac') || end;
    const ext = bloco(end, 'endExt');
    return {
      cnpj: campo(b, 'CNPJ'), cpf: campo(b, 'CPF'), nif: campo(b, 'NIF'), im: campo(b, 'IM'),
      nome: campo(b, 'xNome'), fone: campo(b, 'fone'), email: campo(b, 'email'),
      lgr: campo(end, 'xLgr'), nro: campo(end, 'nro'), cpl: campo(end, 'xCpl'), bairro: campo(end, 'xBairro'),
      cMun: campo(nac, 'cMun'), uf: campo(nac, 'UF'), cep: campo(nac, 'CEP'),
      exterior: ext ? [campo(ext, 'xCidade'), campo(ext, 'xEstProvReg'), campo(ext, 'cPais')].filter(Boolean).join(' · ') : '',
    };
  };
  const fed = bloco(vDps, 'tribFed');
  const pc = bloco(fed, 'piscofins');
  const tot = bloco(vDps, 'totTrib');
  return {
    chave: ((/Id="NFS(\d{50})"/.exec(nf) || [])[1]) || '',
    xLocEmi: campo(nf, 'xLocEmi'), xLocPrestacao: campo(nf, 'xLocPrestacao'), xLocIncid: campo(nf, 'xLocIncid'),
    nNFSe: campo(nf, 'nNFSe'), xTribNac: campo(nf, 'xTribNac'), xTribMun: campo(nf, 'xTribMun'), xNBS: campo(nf, 'xNBS'),
    ambGer: campo(nf, 'ambGer'), cStat: campo(nf, 'cStat'), dhProc: campo(nf, 'dhProc'),
    emit: pessoa(emit),
    vBC: campo(vNf, 'vBC'), pAliqAplic: campo(vNf, 'pAliqAplic'), vISSQN: campo(vNf, 'vISSQN'),
    vTotalRet: campo(vNf, 'vTotalRet'), vLiq: campo(vNf, 'vLiq'), vCalcDR: campo(vNf, 'vCalcDR'),
    tpAmb: campo(inf, 'tpAmb'), dhEmi: campo(inf, 'dhEmi'), serie: campo(inf, 'serie'), nDPS: campo(inf, 'nDPS'),
    dCompet: campo(inf, 'dCompet'), tpEmit: campo(inf, 'tpEmit'), finNFSe: campo(inf, 'finNFSe'), cLocEmi: campo(inf, 'cLocEmi'),
    chSubstda: campo(bloco(inf, 'subst'), 'chSubstda'),
    prestDps: pessoa(prest),
    opSimpNac: campo(prest, 'opSimpNac'), regApTribSN: campo(prest, 'regApTribSN'), regEspTrib: campo(prest, 'regEspTrib'),
    toma: pessoa(bloco(inf, 'toma')), interm: pessoa(bloco(inf, 'interm')),
    cLocPrestacao: campo(serv, 'cLocPrestacao'), cPaisPrestacao: campo(serv, 'cPaisPrestacao'),
    cTribNac: campo(serv, 'cTribNac'), cTribMun: campo(serv, 'cTribMun'), cNBS: campo(serv, 'cNBS'),
    xDescServ: campo(serv, 'xDescServ'), xInfComp: campo(bloco(serv, 'infoCompl'), 'xInfComp'),
    vServ: campo(vDps, 'vServ'), vDescIncond: campo(vDps, 'vDescIncond'), vDescCond: campo(vDps, 'vDescCond'),
    tribISSQN: campo(vDps, 'tribISSQN'), tpRetISSQN: campo(vDps, 'tpRetISSQN'), tpSusp: campo(vDps, 'tpSusp'),
    vRetCP: campo(fed, 'vRetCP'), vRetIRRF: campo(fed, 'vRetIRRF'), vRetCSLL: campo(fed, 'vRetCSLL'),
    cstPisCofins: campo(pc, 'CST'), vPis: campo(pc, 'vPis'), vCofins: campo(pc, 'vCofins'), tpRetPisCofins: campo(pc, 'tpRetPisCofins'),
    pTotTribSN: campo(tot, 'pTotTribSN'), indTotTrib: campo(tot, 'indTotTrib'),
    vTotTribFed: campo(tot, 'vTotTribFed'), vTotTribEst: campo(tot, 'vTotTribEst'), vTotTribMun: campo(tot, 'vTotTribMun'),
  };
}

// ── Formatos e tabelas de códigos ────────────────────────────────────────────
const dig = (s) => String(s || '').replace(/\D/g, '');
function fmtDoc(p) {
  if (!p) return '';
  const c = dig(p.cnpj), f = dig(p.cpf);
  if (c.length === 14) return c.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  if (f.length === 11) return f.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  return p.nif ? 'NIF ' + p.nif : '';
}
function fmtData(s, hora) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(s || ''));
  if (!m) return s || '';
  return `${m[3]}/${m[2]}/${m[1]}` + (hora && m[4] ? ` ${m[4]}:${m[5]}:${m[6] || '00'}` : '');
}
function fmtDinheiro(v) {
  if (v === '' || v == null) return '-';
  const n = Number(String(v).replace(',', '.'));
  if (!Number.isFinite(n)) return String(v);
  return 'R$ ' + n.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}
function fmtPct(v) { if (v === '' || v == null) return '-'; const n = Number(v); return Number.isFinite(n) ? n.toFixed(2).replace('.', ',') + '%' : String(v); }
function fmtCep(v) { const d = dig(v); return d.length === 8 ? d.replace(/^(\d{5})(\d{3})$/, '$1-$2') : (v || ''); }
function fmtFone(v) {
  const d = dig(v);
  if (d.length === 11) return d.replace(/^(\d{2})(\d{5})(\d{4})$/, '($1) $2-$3');
  if (d.length === 10) return d.replace(/^(\d{2})(\d{4})(\d{4})$/, '($1) $2-$3');
  return v || '';
}
const T = {
  ambGer: { 1: 'Prefeitura', 2: 'Sistema Nacional NFS-e' },
  tpAmb: { 1: 'Produção', 2: 'Homologação' },
  tpEmit: { 1: 'Prestador', 2: 'Tomador', 3: 'Intermediário' },
  cStat: { 100: 'NFS-e Gerada', 101: 'NFS-e de Substituição Gerada', 102: 'NFS-e de Decisão Judicial', 103: 'NFS-e Avulsa' },
  finNFSe: { 0: 'NFS-e regular' },
  opSimpNac: { 1: 'Não Optante', 2: 'Optante - Microempreendedor Individual (MEI)', 3: 'Optante - Microempresa ou Empresa de Pequeno Porte (ME/EPP)' },
  regApTribSN: {
    1: 'Regime de apuração dos tributos federais e municipal pelo Simples Nacional',
    2: 'Tributos federais pelo Simples Nacional e ISSQN pela NFS-e, conforme a legislação municipal',
    3: 'Tributos federais e municipal pela NFS-e, conforme as legislações federal e municipal',
  },
  regEspTrib: { 0: 'Nenhum', 1: 'Ato Cooperado', 2: 'Estimativa', 3: 'Microempresa Municipal', 4: 'Notário ou Registrador', 5: 'Profissional Autônomo', 6: 'Sociedade de Profissionais' },
  tribISSQN: { 1: 'Operação Tributável', 2: 'Imunidade', 3: 'Exportação de Serviço', 4: 'Não Incidência' },
  tpRetISSQN: { 1: 'Não Retido', 2: 'Retido pelo Tomador', 3: 'Retido pelo Intermediário' },
  cst: { '00': 'Nenhum', '01': 'Operação Tributável com Alíquota Básica', '02': 'Operação Tributável com Alíquota Diferenciada',
    '03': 'Operação Tributável com Alíquota por Unidade de Medida', '04': 'Operação Tributável Monofásica (Alíquota Zero)',
    '05': 'Operação Tributável por Substituição Tributária', '06': 'Operação Tributável a Alíquota Zero',
    '07': 'Operação Isenta da Contribuição', '08': 'Operação sem Incidência da Contribuição', '09': 'Operação com Suspensão da Contribuição' },
};
const rot = (tab, v) => (v === '' || v == null) ? '-' : (T[tab][v] || T[tab][Number(v)] ? `${T[tab][v] || T[tab][Number(v)]}` : String(v));

// ── Desenho ──────────────────────────────────────────────────────────────────
const M = 22, LU = LP - 2 * M;              // margem e largura útil
const CINZA = [0.42, 0.42, 0.42], FUNDO = [0.93, 0.93, 0.93], VERMELHO = [0.8, 0.07, 0.07];
const TR = 6, TV = 8;                         // corpo do rótulo e do valor

function desenhar(d, opcoes = {}) {
  const pg = new Pagina();
  let y = M;
  const homolog = d.tpAmb === '2';
  // Marca d'água primeiro, para ficar atrás do conteúdo (NT 008, itens 2.5.1 e 2.5.2).
  if (opcoes.cancelada) pg.textoGirado(LP / 2, AP / 2, 'CANCELADA', 55, { tam: 96, rgb: [0.86, 0.86, 0.86] });
  else if (opcoes.substituida) pg.textoGirado(LP / 2, AP / 2, 'SUBSTITUÍDA', 55, { tam: 84, rgb: [0.86, 0.86, 0.86] });

  // 1. Cabeçalho, chave e QR Code
  const hCab = 92;
  pg.retangulo(M, y, LU, hCab);
  pg.texto(M + 8, y + 22, 'DANFSe v2.0', { tam: 15, negrito: true });
  pg.texto(M + 8, y + 34, 'Documento Auxiliar da NFS-e', { tam: 8 });
  const xMeio = M + 160;
  pg.texto(xMeio, y + 14, 'MUNICÍPIO EMITENTE', { tam: TR, rgb: CINZA });
  pg.texto(xMeio, y + 24, d.xLocEmi || d.cLocEmi || '-', { tam: 9, negrito: true });
  pg.texto(xMeio + 125, y + 14, 'AMBIENTE GERADOR', { tam: TR, rgb: CINZA });
  pg.texto(xMeio + 125, y + 24, rot('ambGer', d.ambGer), { tam: TV });
  pg.texto(xMeio + 225, y + 14, 'TIPO DE AMBIENTE', { tam: TR, rgb: CINZA });
  pg.texto(xMeio + 225, y + 24, rot('tpAmb', d.tpAmb), { tam: TV });
  pg.texto(M + 8, y + 52, 'CHAVE DE ACESSO DA NFS-e', { tam: TR, rgb: CINZA });
  pg.texto(M + 8, y + 64, d.chave || '-', { tam: 10, negrito: true });
  pg.texto(M + 8, y + 78, 'Consulte a autenticidade desta NFS-e na Consulta Pública do Portal Nacional: https://www.nfse.gov.br/consultapublica', { tam: 6.5, rgb: CINZA });
  if (homolog) pg.texto(M + 8, y + 88, 'NFS-e SEM VALIDADE JURÍDICA', { tam: 8, negrito: true, rgb: VERMELHO });
  const qr = matrizQr(d.chave ? URL_CONSULTA + d.chave : '');
  if (qr) {
    const lado = 78, m = lado / (qr.tam + 2), x0 = M + LU - lado - 7, y0 = y + 7;
    for (let r = 0; r < qr.tam; r++) for (let c = 0; c < qr.tam; c++)
      if (qr.escuro(r, c)) pg.retangulo(x0 + (c + 1) * m, y0 + (r + 1) * m, m + 0.05, m + 0.05, { preencher: [0, 0, 0], contorno: null });
  }
  y += hCab + 4;

  // Seções em grade: cada linha é uma lista de [rótulo, valor, fração da largura].
  const r0 = (ln) => ln.some(([r]) => r);   // linha com rótulo (senão o texto sobe)
  function secao(titulo, linhas, { semDados = '' } = {}) {
    const hTit = 12;
    let h = hTit;
    const medidas = linhas.map((ln) => {
      let alt = 21;
      for (const [, v, f, opt] of ln) {
        if (opt && opt.multi) {
          const l = quebrar(v || '-', TV, LU * f - 8).slice(0, opt.max || 99);
          alt = Math.max(alt, (r0(ln) ? 12 : 5) + l.length * 9.5);
        }
      }
      return alt;
    });
    if (semDados) h += 16; else h += medidas.reduce((a, b) => a + b, 0);
    pg.retangulo(M, y, LU, h);
    pg.retangulo(M, y, LU, hTit, { preencher: FUNDO, contorno: [0, 0, 0] });
    pg.texto(M + 5, y + 8.6, titulo, { tam: 7, negrito: true });
    let yy = y + hTit;
    if (semDados) {
      pg.texto(M + 5, yy + 10.5, semDados, { tam: 7.5 });
    } else {
      linhas.forEach((ln, i) => {
        let x = M;
        for (const [r, v, f, opt] of ln) {
          const w = LU * f;
          pg.texto(x + 4, yy + 7.5, r, { tam: TR, rgb: CINZA });
          if (opt && opt.multi) {
            const l = quebrar(v || '-', TV, w - 8);
            const max = opt.max || 99;
            const mostra = l.slice(0, max);
            if (l.length > max) mostra[max - 1] = mostra[max - 1].replace(/.{0,3}$/, '…');
            const y1 = r0(ln) ? 16.5 : 10;
            mostra.forEach((t, k) => pg.texto(x + 4, yy + y1 + k * 9.5, t, { tam: TV }));
          } else {
            let t = v === '' || v == null ? '-' : String(v);
            while (t.length > 1 && largura(t, TV, opt && opt.negrito) > w - 8) t = t.slice(0, -2) + '…';
            pg.texto(x + 4, yy + 17, t, { tam: TV, negrito: !!(opt && opt.negrito) });
          }
          x += w;
          if (x < M + LU - 1) pg.linha(x, yy, x, yy + medidas[i], { rgb: [0.75, 0.75, 0.75] });
        }
        yy += medidas[i];
        if (i < linhas.length - 1) pg.linha(M, yy, M + LU, yy, { rgb: [0.75, 0.75, 0.75] });
      });
    }
    y += h + 4;
  }
  const municipio = (p) => {
    if (!p) return '';
    if (p.exterior) return p.exterior;
    const nomeMun = p.cMun && (p.cMun === d.cLocEmi || p.cMun === d.cLocPrestacao) && d.xLocEmi ? d.xLocEmi : (p.cMun ? 'IBGE ' + p.cMun : '');
    return [nomeMun, p.uf].filter(Boolean).join(' - ');
  };
  const endereco = (p) => p ? [p.lgr, p.nro, p.cpl, p.bairro].filter(Boolean).join(', ') : '';
  const pessoaLinhas = (p, extra) => {
    const l = [
      [['CNPJ / CPF / NIF', fmtDoc(p), 0.25, { negrito: true }], ['Inscrição Municipal', p.im, 0.2], ['Telefone', fmtFone(p.fone), 0.2], ['E-mail', p.email, 0.35]],
      [['Nome / Nome Empresarial', p.nome, 1, { negrito: true }]],
    ];
    if (endereco(p) || p.cMun || p.cep || p.exterior)
      l.push([['Endereço', endereco(p), 0.55], ['Município', municipio(p), 0.3], ['CEP', fmtCep(p.cep), 0.15]]);
    if (extra) l.push(...extra);
    return l;
  };

  // 2. Dados da NFS-e e da DPS
  const situacao = opcoes.cancelada ? 'NFS-e Cancelada' : opcoes.substituida ? 'NFS-e Substituída' : rot('cStat', d.cStat);
  secao('DADOS DA NFS-e', [
    [['Número da NFS-e', d.nNFSe, 0.2, { negrito: true }], ['Competência da NFS-e', fmtData(d.dCompet), 0.2], ['Data e hora da emissão da NFS-e', fmtData(d.dhProc, true), 0.3], ['Situação da NFS-e', situacao, 0.3]],
    [['Número da DPS', d.nDPS, 0.2], ['Série da DPS', d.serie, 0.2], ['Data e hora da emissão da DPS', fmtData(d.dhEmi, true), 0.3], ['Emitente da NFS-e', rot('tpEmit', d.tpEmit), 0.15], ['Finalidade', d.finNFSe === '' ? 'NFS-e regular' : rot('finNFSe', d.finNFSe), 0.15]],
  ]);

  // 3. Prestador (dados da NFS-e, com o que só a DPS traz)
  const pr = Object.assign({}, d.prestDps || {}, ...Object.entries(d.emit || {}).filter(([, v]) => v).map(([k, v]) => ({ [k]: v })));
  secao('PRESTADOR / FORNECEDOR', pessoaLinhas(pr, [
    [['Simples Nacional na data de competência', rot('opSimpNac', d.opSimpNac), 0.4, { multi: true, max: 2 }], ['Regime de apuração tributária pelo SN', rot('regApTribSN', d.regApTribSN), 0.6, { multi: true, max: 2 }]],
  ]));

  // 4 e 5. Tomador e intermediário
  if (d.toma && (fmtDoc(d.toma) || d.toma.nome)) secao('TOMADOR / ADQUIRENTE', pessoaLinhas(d.toma));
  else secao('TOMADOR / ADQUIRENTE', [], { semDados: 'TOMADOR DO SERVIÇO NÃO IDENTIFICADO NA NFS-e' });
  if (d.interm && (fmtDoc(d.interm) || d.interm.nome)) secao('INTERMEDIÁRIO DA OPERAÇÃO', pessoaLinhas(d.interm));
  else secao('INTERMEDIÁRIO DA OPERAÇÃO', [], { semDados: 'INTERMEDIÁRIO DO SERVIÇO NÃO IDENTIFICADO NA NFS-e' });

  // 7. Serviço prestado
  const local = d.xLocPrestacao || (d.cLocPrestacao ? 'IBGE ' + d.cLocPrestacao : (d.cPaisPrestacao ? 'País ' + d.cPaisPrestacao : ''));
  secao('SERVIÇO PRESTADO', [
    [['Código de Tributação Nacional', [d.cTribNac, d.xTribNac].filter(Boolean).join(' - '), 0.7, { multi: true, max: 2 }], ['Código de Tributação Municipal', [d.cTribMun, d.xTribMun].filter(Boolean).join(' - '), 0.3]],
    [['Código NBS', [d.cNBS, d.xNBS].filter(Boolean).join(' - '), 0.7, { multi: true, max: 2 }], ['Local da Prestação', local, 0.3]],
    [['Descrição do Serviço', d.xDescServ, 1, { multi: true, max: 14 }]],
  ]);

  // 8. Tributação municipal
  const pelaSN = d.opSimpNac && d.opSimpNac !== '1' && (d.regApTribSN === '1' || d.regApTribSN === '');
  if (d.tribISSQN && d.tribISSQN !== '1') {
    secao('TRIBUTAÇÃO MUNICIPAL (ISSQN)', [
      [['Tributação do ISSQN', rot('tribISSQN', d.tribISSQN), 0.4], ['Município de Incidência do ISSQN', d.xLocIncid, 0.35], ['Regime Especial de Tributação', rot('regEspTrib', d.regEspTrib || '0'), 0.25]],
    ]);
  } else {
    secao('TRIBUTAÇÃO MUNICIPAL (ISSQN)', [
      [['Tributação do ISSQN', rot('tribISSQN', d.tribISSQN || '1'), 0.25], ['Município de Incidência do ISSQN', d.xLocIncid, 0.3], ['Regime Especial de Tributação', rot('regEspTrib', d.regEspTrib || '0'), 0.2], ['Retenção do ISSQN', rot('tpRetISSQN', d.tpRetISSQN || '1'), 0.25]],
      [['Valor do Serviço', fmtDinheiro(d.vServ), 0.25], ['Desconto Incondicionado', fmtDinheiro(d.vDescIncond || 0), 0.15], ['Base de Cálculo do ISSQN', pelaSN ? '-' : fmtDinheiro(d.vBC), 0.2], ['Alíquota Aplicada', pelaSN ? '-' : fmtPct(d.pAliqAplic), 0.15], ['ISSQN Apurado', pelaSN ? 'Apurado no Simples Nacional' : fmtDinheiro(d.vISSQN), 0.25]],
    ]);
  }

  // 9. Tributação federal
  const linhasFed = [[['IRRF retido', fmtDinheiro(d.vRetIRRF || 0), 0.25], ['Contribuição Previdenciária retida', fmtDinheiro(d.vRetCP || 0), 0.4], ['Contribuições Sociais retidas', fmtDinheiro(d.vRetCSLL || 0), 0.35]]];
  if (d.cstPisCofins && String(d.dCompet || '').slice(0, 7) <= '2026-12')
    linhasFed.push([['PIS/COFINS - Situação Tributária (CST)', `${d.cstPisCofins} - ${rot('cst', d.cstPisCofins)}`, 0.5], ['PIS', fmtDinheiro(d.vPis || 0), 0.25], ['COFINS', fmtDinheiro(d.vCofins || 0), 0.25]]);
  secao('TRIBUTAÇÃO FEDERAL', linhasFed);

  // 11. Valor total
  const desc = (Number(d.vDescIncond) || 0) + (Number(d.vDescCond) || 0);
  const liq = d.vLiq || d.vServ;
  const yTot = y;
  secao('VALOR TOTAL DA NFS-e', [
    [['Valor do Serviço', fmtDinheiro(d.vServ), 0.25], ['Desconto Condicionado/Incondicionado', fmtDinheiro(desc), 0.3], ['Total das Retenções', fmtDinheiro(d.vTotalRet || 0), 0.2], ['Valor Líquido da NFS-e', fmtDinheiro(liq), 0.25, { negrito: true }]],
  ]);
  pg.retangulo(M + LU * 0.75 + 0.3, yTot + 12.3, LU * 0.25 - 0.6, 20.4, { preencher: FUNDO, contorno: null });
  pg.texto(M + LU * 0.75 + 4, yTot + 12 + 7.5, 'Valor Líquido da NFS-e', { tam: TR, rgb: CINZA });
  pg.texto(M + LU * 0.75 + 4, yTot + 12 + 17, fmtDinheiro(liq), { tam: TV, negrito: true });

  // 12. Informações complementares
  const info = [];
  if (d.xInfComp) info.push(d.xInfComp);
  if (d.chSubstda) info.push('NFS-e Subst.: ' + d.chSubstda);
  if (d.pTotTribSN) info.push(`Tributos aproximados: ${fmtPct(d.pTotTribSN)} (alíquota do Simples Nacional; Lei 12.741/2012).`);
  else if (d.vTotTribFed || d.vTotTribEst || d.vTotTribMun)
    info.push(`Tributos aproximados (Lei 12.741/2012): federais ${fmtDinheiro(d.vTotTribFed || 0)}, estaduais ${fmtDinheiro(d.vTotTribEst || 0)}, municipais ${fmtDinheiro(d.vTotTribMun || 0)}.`);
  const espaco = AP - M - 18 - y;
  const maxInfo = Math.max(2, Math.floor((espaco - 12 - 12) / 9.5));
  secao('INFORMAÇÕES COMPLEMENTARES', [[['', info.join('\n') || '-', 1, { multi: true, max: maxInfo }]]]);

  pg.texto(M, AP - M - 4, 'DANFSe montado pelo sistema do emitente a partir do XML autorizado da NFS-e (NT SE/CGNFS-e 008). Representação gráfica, sem valor jurídico próprio: vale a NFS-e.', { tam: 6, rgb: CINZA });
  if (homolog) pg.texto(M, AP - M + 5, 'Ambiente de homologação (produção restrita): NFS-e SEM VALIDADE JURÍDICA.', { tam: 6, negrito: true, rgb: VERMELHO });
  return pg.pdf('DANFSe ' + (d.nNFSe ? 'NFS-e ' + d.nNFSe : d.chave));
}

// QR Code pela biblioteca "qrcode" (já usada no baileys-server); sem ela, sai sem QR.
const URL_CONSULTA = 'https://www.nfse.gov.br/ConsultaPublica/?tpc=1&chave=';
function matrizQr(texto) {
  if (!texto) return null;
  try {
    const QR = require('qrcode');
    const q = QR.create(texto, { errorCorrectionLevel: 'M' });
    const tam = q.modules.size, dados = q.modules.data;
    return { tam, escuro: (r, c) => !!dados[r * tam + c] };
  } catch (e) { return null; }
}

// xml = XML da NFS-e autorizada (o que a Sefin devolve em nfseXmlGZipB64).
// opcoes: { cancelada, substituida }. Devolve o PDF (Buffer).
function gerarDanfse(xml, opcoes = {}) {
  const d = lerNfse(xml);
  if (!d.chave && !d.nNFSe) throw new Error('XML não é de uma NFS-e autorizada');
  return desenhar(d, opcoes);
}

module.exports = { gerarDanfse, lerNfse, quebrar, largura };
