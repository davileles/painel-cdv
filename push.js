// ═══════════════════════════════════════════════════════════════════════════
// push.js — envio de notificação push ao app do Painel do Viajante.
//
// iPhone: direto na Apple (APNs, HTTP/2, chave .p8). Não usa Firebase.
//   APNS_KEY_P8       conteúdo do arquivo AuthKey_XXXX.p8 (com BEGIN/END)
//   APNS_KEY_ID       ID da chave (10 caracteres)
//   APNS_TEAM_ID      Team ID da conta Apple (cai em APPLE_TEAM_ID se faltar)
//   APNS_BUNDLE_ID    padrão br.com.clubedoviajante.app
//   APNS_AMBIENTE     production (TestFlight e App Store) | sandbox
// Android: Firebase Cloud Messaging (API HTTP v1).
//   FCM_SERVICE_ACCOUNT  JSON da conta de serviço do projeto Firebase (texto inteiro)
//
// Sem as variáveis de uma plataforma, o envio para ela é pulado em silêncio
// (o chamador cai no e-mail). Nada aqui grava arquivo: quem guarda os tokens
// dos celulares é dispositivos.js.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const crypto = require('crypto');
const http2 = require('http2');
const https = require('https');

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

// ── APNs (iPhone) ───────────────────────────────────────────────────────────
function cfgApns() {
  const p8 = (process.env.APNS_KEY_P8 || '').replace(/\\n/g, '\n').trim();
  const keyId = (process.env.APNS_KEY_ID || '').trim();
  const teamId = (process.env.APNS_TEAM_ID || process.env.APPLE_TEAM_ID || '').trim();
  if (!p8 || !keyId || !teamId) return null;
  return {
    p8, keyId, teamId,
    bundle: (process.env.APNS_BUNDLE_ID || 'br.com.clubedoviajante.app').trim(),
    host: (process.env.APNS_AMBIENTE || 'production') === 'sandbox' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com',
  };
}

// O JWT da Apple vale 1 h; renova a cada 40 min.
let _apnsJwt = { valor: '', ts: 0 };
function jwtApns(cfg) {
  if (_apnsJwt.valor && Date.now() - _apnsJwt.ts < 40 * 60 * 1000) return _apnsJwt.valor;
  const cab = b64url(JSON.stringify({ alg: 'ES256', kid: cfg.keyId }));
  const corpo = b64url(JSON.stringify({ iss: cfg.teamId, iat: Math.floor(Date.now() / 1000) }));
  const assinatura = crypto.sign('sha256', Buffer.from(cab + '.' + corpo), { key: cfg.p8, dsaEncoding: 'ieee-p1363' });
  _apnsJwt = { valor: cab + '.' + corpo + '.' + b64url(assinatura), ts: Date.now() };
  return _apnsJwt.valor;
}

function enviarApns(token, msg) {
  const cfg = cfgApns();
  if (!cfg) return Promise.resolve({ ok: false, pulado: true, motivo: 'apns_sem_config' });
  return new Promise((resolve) => {
    let sessao;
    const fim = (r) => { try { sessao && sessao.close(); } catch (e) {} resolve(r); };
    try {
      sessao = http2.connect(cfg.host);
      sessao.on('error', (e) => fim({ ok: false, motivo: 'conexao: ' + e.message }));
      const payload = JSON.stringify({
        aps: { alert: { title: msg.titulo, body: msg.corpo }, sound: 'default', 'thread-id': msg.grupo || 'cdv' },
        ...(msg.dados || {}),
      });
      const req = sessao.request({
        ':method': 'POST',
        ':path': '/3/device/' + token,
        authorization: 'bearer ' + jwtApns(cfg),
        'apns-topic': cfg.bundle,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'content-type': 'application/json',
      });
      let status = 0, resp = '';
      req.setTimeout(15000, () => { req.close(); fim({ ok: false, motivo: 'timeout' }); });
      req.on('response', (h) => { status = h[':status']; });
      req.on('data', (d) => { resp += d; });
      req.on('end', () => {
        if (status === 200) return fim({ ok: true });
        let razao = '';
        try { razao = JSON.parse(resp).reason || ''; } catch (e) {}
        // 410 = app desinstalado; BadDeviceToken = token de outro ambiente ou lixo.
        const invalido = status === 410 || razao === 'BadDeviceToken' || razao === 'Unregistered';
        fim({ ok: false, invalido, motivo: 'apns ' + status + ' ' + razao });
      });
      req.on('error', (e) => fim({ ok: false, motivo: 'apns: ' + e.message }));
      req.end(payload);
    } catch (e) {
      fim({ ok: false, motivo: 'apns: ' + e.message });
    }
  });
}

// ── FCM (Android) ───────────────────────────────────────────────────────────
function cfgFcm() {
  const bruto = process.env.FCM_SERVICE_ACCOUNT || '';
  if (!bruto) return null;
  try {
    const conta = JSON.parse(bruto);
    if (!conta.client_email || !conta.private_key || !conta.project_id) return null;
    return conta;
  } catch (e) {
    console.error('[push] FCM_SERVICE_ACCOUNT não é um JSON válido');
    return null;
  }
}

function postJson(url, corpo, cabecalhos) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const dados = typeof corpo === 'string' ? corpo : JSON.stringify(corpo);
    const req = https.request({
      method: 'POST', hostname: u.hostname, path: u.pathname + u.search,
      headers: { 'Content-Length': Buffer.byteLength(dados), ...cabecalhos },
      timeout: 15000,
    }, (res) => {
      let txt = '';
      res.on('data', (d) => { txt += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(txt); } catch (e) {}
        resolve({ status: res.statusCode, json, txt });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => resolve({ status: 0, json: null, txt: e.message }));
    req.end(dados);
  });
}

let _fcmToken = { valor: '', exp: 0 };
async function tokenFcm(conta) {
  if (_fcmToken.valor && Date.now() < _fcmToken.exp - 60000) return _fcmToken.valor;
  const agora = Math.floor(Date.now() / 1000);
  const cab = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const corpo = b64url(JSON.stringify({
    iss: conta.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token', iat: agora, exp: agora + 3600,
  }));
  const assinatura = crypto.sign('RSA-SHA256', Buffer.from(cab + '.' + corpo), conta.private_key);
  const jwt = cab + '.' + corpo + '.' + b64url(assinatura);
  const r = await postJson('https://oauth2.googleapis.com/token',
    'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + jwt,
    { 'Content-Type': 'application/x-www-form-urlencoded' });
  if (r.status !== 200 || !r.json || !r.json.access_token) throw new Error('token FCM: ' + r.status + ' ' + String(r.txt).slice(0, 200));
  _fcmToken = { valor: r.json.access_token, exp: Date.now() + (Number(r.json.expires_in) || 3600) * 1000 };
  return _fcmToken.valor;
}

async function enviarFcm(token, msg) {
  const conta = cfgFcm();
  if (!conta) return { ok: false, pulado: true, motivo: 'fcm_sem_config' };
  try {
    const acesso = await tokenFcm(conta);
    const dados = {};
    for (const [k, v] of Object.entries(msg.dados || {})) dados[k] = String(v);
    const r = await postJson(`https://fcm.googleapis.com/v1/projects/${conta.project_id}/messages:send`, {
      message: {
        token,
        notification: { title: msg.titulo, body: msg.corpo },
        data: dados,
        android: { priority: 'HIGH', notification: { channel_id: 'alertas', tag: msg.grupo || undefined } },
      },
    }, { 'Content-Type': 'application/json', Authorization: 'Bearer ' + acesso });
    if (r.status === 200) return { ok: true };
    const erro = (r.json && r.json.error) || {};
    const detalhe = JSON.stringify(erro.details || '');
    const invalido = r.status === 404 || /UNREGISTERED|INVALID_ARGUMENT/.test(detalhe + (erro.status || ''));
    return { ok: false, invalido, motivo: 'fcm ' + r.status + ' ' + (erro.status || '') };
  } catch (e) {
    return { ok: false, motivo: e.message };
  }
}

function pushConfigurado() {
  return { ios: !!cfgApns(), android: !!cfgFcm() };
}

// msg = { titulo, corpo, dados?: {url, tipo…}, grupo? }
function enviarPush(plataforma, token, msg) {
  if (!token) return Promise.resolve({ ok: false, motivo: 'sem_token' });
  return plataforma === 'ios' ? enviarApns(token, msg) : enviarFcm(token, msg);
}

module.exports = { enviarPush, pushConfigurado };
