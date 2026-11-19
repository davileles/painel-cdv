'use strict';
// ── NFS-e Nacional (Emissor Nacional / Sefin Nacional) ──────────────────────
// Monta a DPS (leiaute 1.00), assina (XMLDSig enveloped, RSA-SHA1, C14N — o
// mesmo formato que o eNotas usava nas notas autorizadas da empresa), envia com
// o certificado A1 da empresa (mTLS) e lê a NFS-e autorizada.
//
// Certificado: env NFSE_CERT_PFX (arquivo .pfx em base64) + NFSE_CERT_SENHA.
// Nada do certificado é gravado em arquivo nem devolvido em rota.
//
// Ambientes: 'producao' (tpAmb 1, vale fiscalmente) e 'homologacao' (tpAmb 2,
// produção restrita — sem valor fiscal, para testes).

const zlib = require('zlib');
const crypto = require('crypto');
const https = require('https');
const tls = require('tls');

let forge = null;
try { forge = require('node-forge'); } catch (e) { forge = null; }

const NS_NFSE = 'http://www.sped.fazenda.gov.br/nfse';
const NS_DSIG = 'http://www.w3.org/2000/09/xmldsig#';
const C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';

const URLS = {
  producao: {
    sefin: 'https://sefin.nfse.gov.br/SefinNacional',
    adn: 'https://adn.nfse.gov.br',
  },
  homologacao: {
    sefin: 'https://sefin.producaorestrita.nfse.gov.br/SefinNacional',
    adn: 'https://adn.producaorestrita.nfse.gov.br',
  },
};

// ── Certificado ──────────────────────────────────────────────────────────────
let _cert = null;      // { keyPem, certPem, chainPem, certB64, titular, cnpj, validoAte, validoDe }
let _certErro = null;
let _agente = null;

function carregarCertificado() {
  if (_cert || _certErro) return _cert;
  try {
    if (!forge) throw new Error('dependência node-forge não instalada');
    const b64 = String(process.env.NFSE_CERT_PFX || '').replace(/\s+/g, '');
    if (!b64) throw new Error('NFSE_CERT_PFX não configurada no Railway');
    const der = forge.util.decode64(b64);
    const p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(der), String(process.env.NFSE_CERT_SENHA || ''));
    const bagsK = []
      .concat(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] || [])
      .concat(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] || []);
    const chave = bagsK.map(b => b.key).find(Boolean);
    if (!chave) throw new Error('certificado sem chave privada');
    const certs = (p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || []).map(b => b.cert).filter(Boolean);
    const mod = chave.n.toString(16);
    const folha = certs.find(c => c.publicKey && c.publicKey.n && c.publicKey.n.toString(16) === mod) || certs[0];
    if (!folha) throw new Error('certificado não encontrado no arquivo');
    const outros = certs.filter(c => c !== folha);
    const cn = (folha.subject.getField('CN') || {}).value || '';
    const m = cn.match(/:(\d{14})$/);
    _cert = {
      keyPem: forge.pki.privateKeyToPem(chave),
      certPem: forge.pki.certificateToPem(folha),
      chainPem: outros.map(c => forge.pki.certificateToPem(c)).join(''),
      certB64: forge.util.encode64(forge.asn1.toDer(forge.pki.certificateToAsn1(folha)).getBytes()),
      titular: cn.replace(/:\d{14}$/, ''),
      cnpj: m ? m[1] : '',
      validoDe: folha.validity.notBefore.toISOString(),
      validoAte: folha.validity.notAfter.toISOString(),
    };
  } catch (e) {
    _certErro = e.message;
    console.error('[nfse] certificado:', e.message);
  }
  return _cert;
}

function estadoCertificado() {
  const c = carregarCertificado();
  if (!c) return { ok: false, erro: _certErro || 'sem certificado' };
  const dias = Math.floor((new Date(c.validoAte).getTime() - Date.now()) / 864e5);
  return { ok: true, titular: c.titular, cnpj: c.cnpj, validoDe: c.validoDe, validoAte: c.validoAte, diasRestantes: dias };
}

// AC extra para o TLS do servidor (cadeia ICP-Brasil), se o Railway não confiar
// nela por padrão: env NFSE_TLS_CA (PEM, um ou mais certificados).
function agente() {
  if (_agente) return _agente;
  const c = carregarCertificado();
  if (!c) throw new Error(_certErro || 'certificado indisponível');
  const opts = { key: c.keyPem, cert: c.certPem + c.chainPem, keepAlive: true, maxSockets: 4 };
  const extra = String(process.env.NFSE_TLS_CA || '').trim();
  if (extra) opts.ca = tls.rootCertificates.concat([extra]);
  _agente = new https.Agent(opts);
  return _agente;
}

// ── XML ──────────────────────────────────────────────────────────────────────
// O documento é escrito já na forma canônica (sem espaços entre tags, sem tag
// vazia auto-fechada, só &, < e > escapados no texto), então a C14N do trecho
// assinado é o próprio texto — com o namespace herdado declarado no topo.
function esc(v) {
  return String(v == null ? '' : v)
    .replace(/\r/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function el(nome, valor) { return `<${nome}>${esc(valor)}</${nome}>`; }
function limpar(s, max) {
  const t = String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/\s+/g, ' ').trim();
  return max ? t.slice(0, max) : t;
}
const soDig = (s) => String(s == null ? '' : s).replace(/\D/g, '');

// Data/hora em America/Sao_Paulo (-03:00 fixo), 1 min no passado (a Sefin
// recusa dhEmi à frente do relógio dela).
function dhEmiAgora() {
  const d = new Date(Date.now() - 60 * 1000 - 3 * 3600 * 1000);
  return d.toISOString().slice(0, 19) + '-03:00';
}
function dataSP(d) {
  const x = new Date((d ? new Date(d).getTime() : Date.now()) - 3 * 3600 * 1000);
  return x.toISOString().slice(0, 10);
}

function idDps({ cMun, cnpj, serie, numero }) {
  return 'DPS' + String(cMun).padStart(7, '0') + '2' + soDig(cnpj).padStart(14, '0') +
    String(serie).padStart(5, '0') + String(numero).padStart(15, '0');
}

function valor2(v) { return (Math.round(Number(v) * 100) / 100).toFixed(2); }

// dados = { ambiente, serie, numero, competencia (AAAA-MM-DD),
//   empresa: {cnpj, im, fone, email, cMun, opSimpNac, regApTribSN, regEspTrib, pTotTribSN},
//   tomador: {doc, nome, fone, email},
//   servico: {cTribNac, cTribMun, cNBS, descricao, infoCompl},
//   valor }
// Leiaute NT-009 (finNFSe em infDPS e cNBS antes de xDescServ): a produção
// restrita já exige; a produção (11/2026) ainda aceita o anterior, que é o das
// notas autorizadas da empresa. Env NFSE_LEIAUTE_NT009 = 1|0 força um dos dois
// na produção; emitir() troca de leiaute sozinho se a Sefin recusar o esquema.
function usaNt009(ambiente) {
  const env = String(process.env.NFSE_LEIAUTE_NT009 || '').trim();
  if (ambiente === 'producao') return env === '1';
  return env !== '0';
}

function montarDps(dados) {
  const nt009 = dados.nt009 != null ? !!dados.nt009 : usaNt009(dados.ambiente);
  const emp = dados.empresa || {};
  const tom = dados.tomador || {};
  const srv = dados.servico || {};
  const cMun = soDig(emp.cMun) || '3106200';
  const id = idDps({ cMun, cnpj: emp.cnpj, serie: dados.serie, numero: dados.numero });
  const tpAmb = dados.ambiente === 'producao' ? '1' : '2';
  const doc = soDig(tom.doc);
  if (doc.length !== 11 && doc.length !== 14) throw new Error('tomador sem CPF/CNPJ válido');
  if (!(Number(dados.valor) > 0)) throw new Error('valor da nota inválido');
  if (!srv.cTribNac || !srv.cNBS) throw new Error('produto fiscal sem código de serviço ou NBS');
  const descricao = limpar(srv.descricao, 2000);
  if (!descricao) throw new Error('nota sem descrição do serviço');

  let fone = soDig(tom.fone);
  if (fone.length > 11 && fone.startsWith('55')) fone = fone.slice(2);
  const foneOk = fone.length >= 6 && fone.length <= 20;
  const email = limpar(tom.email, 80);

  let prest = el('CNPJ', soDig(emp.cnpj));
  if (soDig(emp.im)) prest += el('IM', soDig(emp.im));
  if (soDig(emp.fone)) prest += el('fone', soDig(emp.fone));
  if (limpar(emp.email)) prest += el('email', limpar(emp.email, 80));
  prest += '<regTrib>' + el('opSimpNac', emp.opSimpNac || 3) + el('regApTribSN', emp.regApTribSN || 1) +
    el('regEspTrib', emp.regEspTrib == null ? 0 : emp.regEspTrib) + '</regTrib>';

  let toma = el(doc.length === 11 ? 'CPF' : 'CNPJ', doc) + el('xNome', limpar(tom.nome, 300) || 'Consumidor');
  if (foneOk) toma += el('fone', fone);
  if (email && /@/.test(email)) toma += el('email', email);

  let serv = '<locPrest>' + el('cLocPrestacao', cMun) + '</locPrest>' +
    '<cServ>' + el('cTribNac', soDig(srv.cTribNac)) + el('cTribMun', soDig(srv.cTribMun) || '001') +
    (nt009 ? el('cNBS', soDig(srv.cNBS)) + el('xDescServ', descricao) : el('xDescServ', descricao) + el('cNBS', soDig(srv.cNBS))) + '</cServ>';
  const info = limpar(srv.infoCompl, 2000);
  if (info) serv += '<infoCompl>' + el('xInfComp', info) + '</infoCompl>';

  const pTot = Number(emp.pTotTribSN);
  const valores = '<vServPrest>' + el('vServ', valor2(dados.valor)) + '</vServPrest>' +
    '<trib><tribMun>' + el('tribISSQN', 1) + el('tpRetISSQN', 1) + '</tribMun>' +
    '<tribFed><piscofins>' + el('CST', '00') + el('tpRetPisCofins', 0) + '</piscofins></tribFed>' +
    '<totTrib>' + el('pTotTribSN', valor2(pTot > 0 ? pTot : 0)) + '</totTrib></trib>';

  const corpo = el('tpAmb', tpAmb) + el('dhEmi', dados.dhEmi || dhEmiAgora()) + el('verAplic', 'CDV_1.0') +
    el('serie', String(Number(dados.serie))) + el('nDPS', String(Number(dados.numero))) +
    el('dCompet', dados.competencia || dataSP()) + el('tpEmit', 1) + (nt009 ? el('finNFSe', 0) : '') + el('cLocEmi', cMun) +
    '<prest>' + prest + '</prest>' + '<toma>' + toma + '</toma>' +
    '<serv>' + serv + '</serv>' + '<valores>' + valores + '</valores>';

  const infDps = `<infDPS Id="${id}">${corpo}</infDPS>`;
  return { id, nt009, infDps, infDpsC14n: `<infDPS xmlns="${NS_NFSE}" Id="${id}">${corpo}</infDPS>` };
}

// Assinatura XMLDSig do elemento `c14n` (texto canônico, com o namespace herdado
// declarado) referenciado por `id`. Devolve o elemento <Signature>.
function assinatura(id, c14n) {
  const c = carregarCertificado();
  if (!c) throw new Error(_certErro || 'certificado indisponível');
  const digest = crypto.createHash('sha1').update(c14n, 'utf8').digest('base64');
  const signedInfo = (ns) => `<SignedInfo${ns ? ` xmlns="${NS_DSIG}"` : ''}>` +
    `<CanonicalizationMethod Algorithm="${C14N}"></CanonicalizationMethod>` +
    `<SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"></SignatureMethod>` +
    `<Reference URI="#${id}"><Transforms>` +
    `<Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"></Transform>` +
    `<Transform Algorithm="${C14N}"></Transform></Transforms>` +
    `<DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"></DigestMethod>` +
    `<DigestValue>${digest}</DigestValue></Reference></SignedInfo>`;
  const valor = crypto.sign('sha1', Buffer.from(signedInfo(true), 'utf8'), c.keyPem).toString('base64');
  return `<Signature xmlns="${NS_DSIG}">${signedInfo(false)}<SignatureValue>${valor}</SignatureValue>` +
    `<KeyInfo><X509Data><X509Certificate>${c.certB64}</X509Certificate></X509Data></KeyInfo></Signature>`;
}

function assinar(m) {
  const sig = assinatura(m.id, m.infDpsC14n);
  return `<?xml version="1.0" encoding="UTF-8"?><DPS xmlns="${NS_NFSE}" versao="${m.nt009 ? '1.01' : '1.00'}">${m.infDps}${sig}</DPS>`;
}

// ── HTTP com mTLS ────────────────────────────────────────────────────────────
function requisicao(url, { metodo = 'GET', corpo = null, aceitar = 'application/json', timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const dados = corpo ? Buffer.from(JSON.stringify(corpo), 'utf8') : null;
    const req = https.request({
      method: metodo, hostname: u.hostname, path: u.pathname + u.search, agent: agente(),
      headers: Object.assign({ Accept: aceitar, 'User-Agent': 'CDV-Notas/1.0' },
        dados ? { 'Content-Type': 'application/json', 'Content-Length': dados.length } : {}),
      timeout,
    }, (res) => {
      const partes = [];
      res.on('data', (b) => partes.push(b));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, corpo: Buffer.concat(partes) }));
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('tempo esgotado'), { code: 'ETIMEDOUT' })));
    req.on('error', (e) => reject(e));
    if (dados) req.write(dados);
    req.end();
  });
}
function json(buf) { try { return JSON.parse(buf.toString('utf8')); } catch (e) { return null; } }
function gunzipB64(b64) { return zlib.gunzipSync(Buffer.from(String(b64), 'base64')).toString('utf8'); }
function tag(xml, nome) { const m = String(xml || '').match(new RegExp(`<${nome}>([^<]*)</${nome}>`)); return m ? m[1] : ''; }
function errosDe(j) {
  const l = (j && (j.erros || j.Erros || j.erro)) || [];
  return (Array.isArray(l) ? l : [l]).map(e => ({
    codigo: e.Codigo || e.codigo || '', descricao: e.Descricao || e.descricao || '', complemento: e.Complemento || e.complemento || '',
  }));
}
function infoNfse(xml) {
  return {
    numero: tag(xml, 'nNFSe'), chave: ((String(xml).match(/<infNFSe Id="NFS(\d+)"/) || [])[1]) || '',
    autorizadaEm: tag(xml, 'dhProc'), cStat: tag(xml, 'cStat'),
  };
}

// Envia a DPS. Resultado: {ok:true, chave, numero, xml} | {ok:false, erros, status,
// ambiguo?} — ambiguo = não sabemos se a Sefin registrou (rede/timeout/5xx):
// conferir depois com consultarDps antes de reenviar.
async function emitir(ambiente, dados, _trocou) {
  const m = montarDps(Object.assign({}, dados, { ambiente }));
  const xml = assinar(m);
  const corpo = { dpsXmlGZipB64: zlib.gzipSync(Buffer.from(xml, 'utf8')).toString('base64') };
  let r;
  try {
    r = await requisicao(URLS[ambiente].sefin + '/nfse', { metodo: 'POST', corpo });
  } catch (e) {
    return { ok: false, ambiguo: true, idDps: m.id, status: 0, erros: [{ codigo: e.code || 'REDE', descricao: e.message }] };
  }
  const j = json(r.corpo);
  if ((r.status === 200 || r.status === 201) && j && j.nfseXmlGZipB64) {
    const nf = gunzipB64(j.nfseXmlGZipB64);
    const i = infoNfse(nf);
    return { ok: true, idDps: m.id, chave: j.chaveAcesso || i.chave, numero: i.numero, autorizadaEm: i.autorizadaEm || j.dataHoraProcessamento || null, xml: nf, alertas: j.alertas || null };
  }
  const erros = errosDe(j);
  // Esquema recusado por causa do leiaute (finNFSe/cNBS): tenta o outro uma vez.
  if (!_trocou && erros.some(e => /esquema|schema/i.test(e.descricao + e.complemento) && /finNFSe|cNBS|xDescServ|cLocEmi/.test(e.complemento))) {
    return emitir(ambiente, Object.assign({}, dados, { nt009: !m.nt009 }), true);
  }
  if (!erros.length) erros.push({ codigo: 'HTTP' + r.status, descricao: r.corpo.toString('utf8').slice(0, 400) });
  return { ok: false, idDps: m.id, status: r.status, ambiguo: r.status >= 500 || r.status === 0, erros };
}

// DPS já virou NFS-e? (para o caso ambíguo ou "DPS já existe").
async function consultarDps(ambiente, id) {
  const r = await requisicao(URLS[ambiente].sefin + '/dps/' + encodeURIComponent(id));
  const j = json(r.corpo);
  if (r.status === 200 && j && j.chaveAcesso) return { existe: true, chave: j.chaveAcesso };
  if (r.status === 404) return { existe: false };
  return { existe: null, status: r.status, erros: errosDe(j) };
}

async function baixarNfse(ambiente, chave) {
  const r = await requisicao(URLS[ambiente].sefin + '/nfse/' + encodeURIComponent(chave));
  const j = json(r.corpo);
  if (r.status === 200 && j && j.nfseXmlGZipB64) {
    const xml = gunzipB64(j.nfseXmlGZipB64);
    return Object.assign({ ok: true, xml }, infoNfse(xml));
  }
  return { ok: false, status: r.status, erros: errosDe(j) };
}

// ── Cancelamento (evento e101101) ────────────────────────────────────────────
// motivo: 1 = erro na emissão, 2 = serviço não prestado, 9 = outros.
// justificativa: 15 a 255 caracteres. Resultado: {ok, xml?} | {ok:false, erros, jaCancelada?}.
async function cancelar(ambiente, { cnpj, chave, motivo, justificativa }, _versao) {
  const versao = _versao || '1.01';
  const ch = soDig(chave);
  if (ch.length !== 50) throw new Error('chave de acesso inválida');
  const mot = [1, 2, 9].includes(Number(motivo)) ? Number(motivo) : 9;
  const just = limpar(justificativa, 255);
  if (just.length < 15) throw new Error('a justificativa precisa de pelo menos 15 caracteres');
  const id = 'PRE' + ch + '101101';
  const corpo = el('tpAmb', ambiente === 'producao' ? 1 : 2) + el('verAplic', 'CDV_1.0') + el('dhEvento', dhEmiAgora()) +
    el('CNPJAutor', soDig(cnpj)) + el('chNFSe', ch) +
    '<e101101>' + el('xDesc', 'Cancelamento de NFS-e') + el('cMotivo', mot) + el('xMotivo', just) + '</e101101>';
  const sig = assinatura(id, `<infPedReg xmlns="${NS_NFSE}" Id="${id}">${corpo}</infPedReg>`);
  const xml = `<?xml version="1.0" encoding="UTF-8"?><pedRegEvento xmlns="${NS_NFSE}" versao="${versao}"><infPedReg Id="${id}">${corpo}</infPedReg>${sig}</pedRegEvento>`;
  let r;
  try {
    r = await requisicao(URLS[ambiente].sefin + '/nfse/' + ch + '/eventos', { metodo: 'POST',
      corpo: { pedidoRegistroEventoXmlGZipB64: zlib.gzipSync(Buffer.from(xml, 'utf8')).toString('base64') } });
  } catch (e) {
    return { ok: false, ambiguo: true, erros: [{ codigo: e.code || 'REDE', descricao: e.message }] };
  }
  const j = json(r.corpo);
  if ((r.status === 200 || r.status === 201) && j && j.eventoXmlGZipB64) return { ok: true, xml: gunzipB64(j.eventoXmlGZipB64) };
  const erros = errosDe(j);
  if (!_versao && erros.some(e => /esquema|schema|vers[aã]o/i.test(e.descricao + ' ' + e.complemento))) {
    return cancelar(ambiente, { cnpj, chave, motivo, justificativa }, '1.00');
  }
  if (!erros.length) erros.push({ codigo: 'HTTP' + r.status, descricao: r.corpo.toString('utf8').slice(0, 400) });
  const jaCancelada = erros.some(e => /j[aá] (est[aá] )?cancelad|evento j[aá] (registrad|vinculad)/i.test(e.descricao + ' ' + e.complemento));
  return { ok: false, status: r.status, ambiguo: r.status >= 500, jaCancelada, erros };
}

async function baixarDanfse(ambiente, chave) {
  const r = await requisicao(URLS[ambiente].adn + '/danfse/' + encodeURIComponent(chave), { aceitar: 'application/pdf', timeout: 90000 });
  if (r.status === 200 && r.corpo.length > 100) return { ok: true, pdf: r.corpo };
  return { ok: false, status: r.status, texto: r.corpo.toString('utf8').slice(0, 300) };
}

module.exports = {
  estadoCertificado, carregarCertificado, montarDps, assinar, emitir, cancelar, consultarDps, baixarNfse, baixarDanfse,
  idDps, dataSP, dhEmiAgora, URLS,
};
