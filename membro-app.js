// ═══════════════════════════════════════════════════════════════════════════
// membro-app.js — celulares do membro (Face ID/digital e push) e alertas
// pessoais de passagem e de transferência bonificada.
//
// Arquivos (repo PRIVADO de dados — ARQUIVOS_SENSIVEIS no index.js):
//   dispositivos.json    { dispositivos: [{ id, email, plataforma, modelo,
//                          segredoHash, expiraEm, pushToken, criadoEm, ultimoUso }] }
//   alertas-membros.json { passagens: [...], transferencias: [...] }
//
// Face ID/digital: no 1º login (código por e-mail) o app pede uma chave deste
// celular (/membros/dispositivo/registrar). O segredo volta UMA vez, fica no
// cofre do celular protegido pela biometria e aqui só o hash. Nas próximas
// aberturas o app lê o segredo com o Face ID e troca por uma sessão nova
// (/membros/dispositivo/entrar). Vale 180 dias; membro inativo não entra.
//
// Alertas: quem casa é o proxy, no momento em que a passagem é registrada
// (/passagens/registrar) ou a transferência é aprovada/publicada. Aviso vai por
// push aos celulares do membro; se nenhum push sair, vai por e-mail.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const crypto = require('crypto');
const { enviarPush, pushConfigurado } = require('./push.js');

const DISPOSITIVOS_PATH = 'dispositivos.json';
const ALERTAS_PATH = 'alertas-membros.json';
const CHAVE_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const MAX_ALERTAS_POR_TIPO = 20;
const MAX_CELULARES = 10;

function hash(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function iguais(a, b) {
  const x = Buffer.from(String(a || ''), 'hex'), y = Buffer.from(String(b || ''), 'hex');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}
function novoId(prefixo) { return prefixo + '-' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'); }
function semAcento(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim(); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function fmtPts(n) { return Number(n || 0).toLocaleString('pt-BR'); }
function fmtData(iso) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; }

// Cabine em 4 grupos (o texto das emissões varia: "Executiva", "ECONOMICA", "Business"…)
function grupoCabine(c) {
  const t = semAcento(c);
  if (!t) return '';
  if (/prim|first/.test(t)) return 'primeira';
  if (/premium/.test(t)) return 'premium';
  if (/exec|business/.test(t)) return 'executiva';
  return 'economica';
}
const NOME_CABINE = { economica: 'Econômica', executiva: 'Executiva', premium: 'Premium Economy', primeira: 'Primeira' };

module.exports = function montarMembroApp(app, d) {
  const { ghGetJson, ghPutJson, membroAtivo, assinarSessaoMembro, opAutorizado, fetch, MEMBROS_PATH } = d;

  async function mutar(path, fallback, fn, msg) {
    let erro = null;
    for (let t = 0; t < 4; t++) {
      const atual = await ghGetJson(path, fallback);
      const dados = atual.data && typeof atual.data === 'object' ? atual.data : JSON.parse(JSON.stringify(fallback));
      const r = fn(dados);
      if (r === false) return { mudou: false };
      try {
        await ghPutJson(path, dados, atual.sha, msg);
        return { mudou: true, resultado: r };
      } catch (e) {
        erro = e;
        await new Promise((ok) => setTimeout(ok, 700 * (t + 1)));
      }
    }
    throw erro || new Error('falha ao gravar ' + path);
  }

  // Cache curto: alertas e celulares são lidos a cada passagem registrada.
  const _cache = {};
  async function ler(path, fallback) {
    const c = _cache[path];
    if (c && Date.now() - c.ts < 60 * 1000) return c.data;
    const { data } = await ghGetJson(path, fallback);
    const val = data && typeof data === 'object' ? data : JSON.parse(JSON.stringify(fallback));
    _cache[path] = { data: val, ts: Date.now() };
    return val;
  }
  function invalidar(path) { delete _cache[path]; }

  const VAZIO_DISP = { dispositivos: [] };
  const VAZIO_AL = { passagens: [], transferencias: [] };

  // ── Celulares ─────────────────────────────────────────────────────────────
  app.post('/membros/dispositivo/registrar', async (req, res) => {
    const email = res.locals.membroEmail;
    const b = req.body || {};
    const plataforma = b.plataforma === 'ios' ? 'ios' : b.plataforma === 'android' ? 'android' : '';
    if (!plataforma) return res.status(400).json({ ok: false, erro: 'plataforma inválida' });
    const segredo = crypto.randomBytes(32).toString('hex');
    const id = novoId('dev');
    try {
      await mutar(DISPOSITIVOS_PATH, VAZIO_DISP, (dd) => {
        const lista = dd.dispositivos = Array.isArray(dd.dispositivos) ? dd.dispositivos : [];
        // Mesmo celular registrando de novo (reinstalou o app) substitui o anterior.
        if (b.substituir) {
          const i = lista.findIndex((x) => x.id === b.substituir && x.email === email);
          if (i >= 0) {
            if (!b.pushToken && lista[i].pushToken) b.pushToken = lista[i].pushToken;
            lista.splice(i, 1);
          }
        }
        const meus = lista.filter((x) => x.email === email).sort((a, z) => String(a.ultimoUso || a.criadoEm).localeCompare(String(z.ultimoUso || z.criadoEm)));
        while (meus.length >= MAX_CELULARES) lista.splice(lista.indexOf(meus.shift()), 1);
        lista.push({
          id, email, plataforma, modelo: String(b.modelo || '').slice(0, 60),
          segredoHash: hash(segredo), expiraEm: new Date(Date.now() + CHAVE_TTL_MS).toISOString(),
          pushToken: b.pushToken ? String(b.pushToken).slice(0, 400) : '',
          criadoEm: new Date().toISOString(), ultimoUso: new Date().toISOString(),
        });
      }, 'chore: registra celular de membro');
      invalidar(DISPOSITIVOS_PATH);
      res.json({ ok: true, id, segredo, expiraEm: new Date(Date.now() + CHAVE_TTL_MS).toISOString() });
    } catch (e) {
      console.error('[dispositivo/registrar]', e.message);
      res.status(500).json({ ok: false, erro: 'Não foi possível ativar agora.' });
    }
  });

  const _tentativas = new Map(); // ip → { n, ts }
  app.post('/membros/dispositivo/entrar', async (req, res) => {
    const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    const t = _tentativas.get(ip) || { n: 0, ts: Date.now() };
    if (Date.now() - t.ts > 10 * 60 * 1000) { t.n = 0; t.ts = Date.now(); }
    t.n++; _tentativas.set(ip, t);
    if (t.n > 40) return res.status(429).json({ ok: false, motivo: 'tentativas' });

    const { id, segredo } = req.body || {};
    if (!id || !segredo) return res.status(400).json({ ok: false, motivo: 'dados' });
    try {
      const { data, sha } = await ghGetJson(DISPOSITIVOS_PATH, VAZIO_DISP);
      const lista = (data && Array.isArray(data.dispositivos)) ? data.dispositivos : [];
      const disp = lista.find((x) => x.id === id);
      if (!disp || !iguais(disp.segredoHash, hash(segredo))) return res.json({ ok: false, motivo: 'chave' });
      if (!(new Date(disp.expiraEm).getTime() > Date.now())) return res.json({ ok: false, motivo: 'expirada' });
      if (!(await membroAtivo(disp.email, false))) return res.json({ ok: false, motivo: 'inativo' });
      const token = assinarSessaoMembro(disp.email);
      if (!token) return res.status(500).json({ ok: false, erro: 'Segredo de sessão não configurado no servidor' });
      let nome = '';
      try {
        const m = await ghGetJson(MEMBROS_PATH, { membros: [] });
        const reg = ((m.data && m.data.membros) || []).find((x) => String(x.email || '').toLowerCase().trim() === disp.email);
        nome = (reg && reg.nome) || '';
      } catch (e) {}
      res.json({ ok: true, email: disp.email, nome, token });
      // Uso diário renova o prazo da chave; grava no máximo 1x por dia por celular.
      if (Date.now() - new Date(disp.ultimoUso || 0).getTime() > 24 * 60 * 60 * 1000) {
        disp.ultimoUso = new Date().toISOString();
        disp.expiraEm = new Date(Date.now() + CHAVE_TTL_MS).toISOString();
        ghPutJson(DISPOSITIVOS_PATH, data, sha, 'chore: uso de celular de membro')
          .then(() => invalidar(DISPOSITIVOS_PATH))
          .catch((e) => console.warn('[dispositivo/entrar] ultimoUso:', e.message));
      }
    } catch (e) {
      console.error('[dispositivo/entrar]', e.message);
      res.status(500).json({ ok: false, motivo: 'erro' });
    }
  });

  app.post('/membros/dispositivo/remover', async (req, res) => {
    const email = res.locals.membroEmail;
    const id = (req.body || {}).id;
    try {
      await mutar(DISPOSITIVOS_PATH, VAZIO_DISP, (dd) => {
        const lista = dd.dispositivos || [];
        const i = lista.findIndex((x) => x.id === id && x.email === email);
        if (i < 0) return false;
        lista.splice(i, 1);
      }, 'chore: remove celular de membro');
      invalidar(DISPOSITIVOS_PATH);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // Guarda o token de push do celular. Sem id (membro não usa Face ID), cria um
  // registro só de push, sem chave de entrada.
  app.post('/membros/dispositivo/push', async (req, res) => {
    const email = res.locals.membroEmail;
    const b = req.body || {};
    const plataforma = b.plataforma === 'ios' ? 'ios' : b.plataforma === 'android' ? 'android' : '';
    const pushToken = String(b.pushToken || '').slice(0, 400);
    if (!plataforma || !pushToken) return res.status(400).json({ ok: false, erro: 'dados' });
    try {
      let idFinal = b.id || '';
      await mutar(DISPOSITIVOS_PATH, VAZIO_DISP, (dd) => {
        const lista = Array.isArray(dd.dispositivos) ? dd.dispositivos : [];
        let disp = idFinal ? lista.find((x) => x.id === idFinal && x.email === email) : null;
        // Sem id: reaproveita o registro que já tem este token (mesmo celular, mesmo membro).
        if (!disp) disp = lista.find((x) => x.email === email && x.pushToken === pushToken);
        let mudou = false;
        // O mesmo token em outro registro (outro membro entrou neste celular) sai de lá.
        for (const x of lista) if (x !== disp && x.pushToken === pushToken) { x.pushToken = ''; mudou = true; }
        if (!disp) {
          disp = { id: novoId('dev'), email, plataforma, modelo: String(b.modelo || '').slice(0, 60), segredoHash: '', expiraEm: '', pushToken: '', criadoEm: new Date().toISOString(), ultimoUso: new Date().toISOString() };
          lista.push(disp);
        }
        idFinal = disp.id;
        if (disp.pushToken !== pushToken) { disp.pushToken = pushToken; disp.plataforma = plataforma; mudou = true; }
        if (!mudou) return false;
        // Registro sem chave de entrada e sem token não serve para nada: limpa.
        dd.dispositivos = lista.filter((x) => x.segredoHash || x.pushToken);
      }, 'chore: token de push de membro');
      invalidar(DISPOSITIVOS_PATH);
      res.json({ ok: true, id: idFinal });
    } catch (e) {
      console.error('[dispositivo/push]', e.message);
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // ── Envio ao membro: push nos celulares; sem push entregue, e-mail ────────
  async function enviarEmail(para, assunto, titulo, linhas, botao) {
    const chave = process.env.RESEND_API_KEY;
    if (!chave) return false;
    const corpo = `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:28px;background:#ffffff;border:1px solid #e3e7f0;border-radius:14px;color:#17203a">
      <div style="font-size:12px;font-weight:700;letter-spacing:1.5px;color:#ff585e;text-transform:uppercase">Clube do Viajante · Alerta</div>
      <h2 style="margin:10px 0 14px;font-size:20px">${esc(titulo)}</h2>
      ${linhas.map((l) => `<p style="margin:0 0 8px;font-size:14px;line-height:1.5;color:#3a4560">${l}</p>`).join('')}
      <a href="${esc(botao.url)}" style="display:inline-block;margin-top:14px;background:#ff585e;color:#fff;text-decoration:none;font-weight:700;padding:12px 18px;border-radius:10px">${esc(botao.texto)}</a>
      <p style="margin-top:22px;font-size:11px;color:#8a93a8">Você recebe este aviso porque criou um alerta no Painel do Viajante. Para parar, apague o alerta no painel.</p>
    </div>`;
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + chave, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'Clube do Viajante <alertas@clubedoviajante.com.br>', to: [para], subject: assunto, html: corpo }),
      });
      return r.ok;
    } catch (e) {
      console.error('[alerta e-mail]', e.message);
      return false;
    }
  }

  // msg = { titulo, corpo, dados: { aba, ... }, grupo }
  async function pushParaEmail(email, msg) {
    const dd = await ler(DISPOSITIVOS_PATH, VAZIO_DISP);
    const alvos = (dd.dispositivos || []).filter((x) => x.email === email && x.pushToken);
    let entregues = 0;
    const invalidos = [];
    for (const disp of alvos) {
      const r = await enviarPush(disp.plataforma, disp.pushToken, msg);
      if (r.ok) entregues++;
      else {
        if (r.invalido) invalidos.push(disp.pushToken);
        if (!r.pulado) console.warn('[push]', disp.plataforma, r.motivo);
      }
    }
    if (invalidos.length) {
      mutar(DISPOSITIVOS_PATH, VAZIO_DISP, (x) => {
        let mudou = false;
        for (const disp of x.dispositivos || []) if (invalidos.includes(disp.pushToken)) { disp.pushToken = ''; mudou = true; }
        if (!mudou) return false;
        x.dispositivos = x.dispositivos.filter((y) => y.segredoHash || y.pushToken);
      }, 'chore: remove token de push inválido').then(() => invalidar(DISPOSITIVOS_PATH)).catch(() => {});
    }
    return { entregues, celulares: alvos.length };
  }

  // Usado pelo coletar.js (alertas de compra bonificada): só push; o e-mail o coletar já manda.
  app.post('/push/notificar', async (req, res) => {
    if (!opAutorizado(req, res)) return;
    const { email, titulo, corpo, dados, grupo } = req.body || {};
    if (!email || !titulo) return res.status(400).json({ ok: false, erro: 'email e titulo obrigatórios' });
    try {
      const r = await pushParaEmail(String(email).toLowerCase().trim(), { titulo: String(titulo), corpo: String(corpo || ''), dados: dados || {}, grupo });
      res.json({ ok: true, ...r });
    } catch (e) {
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  app.get('/push/status', async (req, res) => {
    if (!opAutorizado(req, res)) return;
    try {
      const dd = await ler(DISPOSITIVOS_PATH, VAZIO_DISP);
      const lista = dd.dispositivos || [];
      const al = await ler(ALERTAS_PATH, VAZIO_AL);
      res.json({
        ok: true, configurado: pushConfigurado(),
        celulares: lista.length,
        comFaceId: lista.filter((x) => x.segredoHash).length,
        comPush: { ios: lista.filter((x) => x.pushToken && x.plataforma === 'ios').length, android: lista.filter((x) => x.pushToken && x.plataforma === 'android').length },
        alertas: { passagens: (al.passagens || []).length, transferencias: (al.transferencias || []).length },
      });
    } catch (e) {
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // ── Alertas do membro ─────────────────────────────────────────────────────
  function limparPassagem(a) {
    const ida = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? String(s) : '');
    const r = {
      origem: String(a.origem || '').trim().slice(0, 60),
      destino: String(a.destino || '').trim().slice(0, 60),
      programas: (Array.isArray(a.programas) ? a.programas : []).map((p) => String(p).trim().slice(0, 40)).filter(Boolean).slice(0, 12),
      cabine: ['economica', 'executiva', 'premium', 'primeira'].includes(a.cabine) ? a.cabine : '',
      maxPontos: Math.max(0, Math.round(Number(a.maxPontos) || 0)),
      idaDe: ida(a.idaDe), idaAte: ida(a.idaAte),
    };
    if (r.idaDe && r.idaAte && r.idaAte < r.idaDe) [r.idaDe, r.idaAte] = [r.idaAte, r.idaDe];
    return r;
  }
  function limparTransferencia(a) {
    return {
      origem: String(a.origem || '').trim().slice(0, 60),
      destino: String(a.destino || '').trim().slice(0, 60),
      bonusMin: Math.max(0, Math.min(500, Math.round(Number(a.bonusMin) || 0))),
    };
  }

  app.get('/membros/alertas/listar', async (req, res) => {
    const email = res.locals.membroEmail;
    try {
      const { data } = await ghGetJson(ALERTAS_PATH, VAZIO_AL);
      const al = data || VAZIO_AL;
      const dd = await ler(DISPOSITIVOS_PATH, VAZIO_DISP);
      const meus = (l) => (l || []).filter((x) => x.email === email).map(({ email: _e, avisos, ...resto }) => ({ ...resto, totalAvisos: (avisos || []).length }));
      res.json({
        ok: true,
        passagens: meus(al.passagens),
        transferencias: meus(al.transferencias),
        temPush: (dd.dispositivos || []).some((x) => x.email === email && x.pushToken),
      });
    } catch (e) {
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  app.post('/membros/alertas/salvar', async (req, res) => {
    const email = res.locals.membroEmail;
    const b = req.body || {};
    const tipo = b.tipo === 'transferencia' ? 'transferencias' : b.tipo === 'passagem' ? 'passagens' : '';
    if (!tipo) return res.status(400).json({ ok: false, erro: 'tipo inválido' });
    const campos = tipo === 'passagens' ? limparPassagem(b.alerta || {}) : limparTransferencia(b.alerta || {});
    if (tipo === 'passagens' && (!campos.origem || !campos.destino)) return res.status(400).json({ ok: false, erro: 'Informe origem e destino.' });
    if (tipo === 'transferencias' && (!campos.destino || !campos.bonusMin)) return res.status(400).json({ ok: false, erro: 'Informe o programa de destino e o bônus mínimo.' });
    try {
      let idFinal = '';
      let limite = false;
      await mutar(ALERTAS_PATH, VAZIO_AL, (al) => {
        al.passagens = al.passagens || []; al.transferencias = al.transferencias || [];
        const lista = al[tipo];
        const existente = b.alerta && b.alerta.id ? lista.find((x) => x.id === b.alerta.id && x.email === email) : null;
        if (existente) { Object.assign(existente, campos, { atualizadoEm: new Date().toISOString() }); idFinal = existente.id; return; }
        if (lista.filter((x) => x.email === email).length >= MAX_ALERTAS_POR_TIPO) { limite = true; return false; }
        idFinal = novoId(tipo === 'passagens' ? 'ap' : 'at');
        lista.push({ id: idFinal, email, ...campos, criadoEm: new Date().toISOString(), avisos: [] });
      }, `chore: alerta de ${tipo === 'passagens' ? 'passagem' : 'transferência'} de membro`);
      if (limite) return res.json({ ok: false, erro: `Limite de ${MAX_ALERTAS_POR_TIPO} alertas deste tipo. Apague algum para criar outro.` });
      invalidar(ALERTAS_PATH);
      res.json({ ok: true, id: idFinal });
    } catch (e) {
      console.error('[alertas/salvar]', e.message);
      res.status(500).json({ ok: false, erro: 'Não foi possível salvar o alerta agora.' });
    }
  });

  app.post('/membros/alertas/excluir', async (req, res) => {
    const email = res.locals.membroEmail;
    const b = req.body || {};
    const tipo = b.tipo === 'transferencia' ? 'transferencias' : 'passagens';
    try {
      await mutar(ALERTAS_PATH, VAZIO_AL, (al) => {
        const lista = al[tipo] || [];
        const i = lista.findIndex((x) => x.id === b.id && x.email === email);
        if (i < 0) return false;
        lista.splice(i, 1);
      }, 'chore: apaga alerta de membro');
      invalidar(ALERTAS_PATH);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // Marca o aviso no alerta (não repete a mesma passagem/oferta).
  async function marcarAvisos(tipo, pares) {
    if (!pares.length) return;
    await mutar(ALERTAS_PATH, VAZIO_AL, (al) => {
      let mudou = false;
      for (const { id, ref } of pares) {
        const a = (al[tipo] || []).find((x) => x.id === id);
        if (!a) continue;
        a.avisos = [ref, ...(a.avisos || []).filter((r) => r !== ref)].slice(0, 30);
        a.ultimoAviso = new Date().toISOString();
        mudou = true;
      }
      if (!mudou) return false;
    }, `chore: avisos de alertas de membro (${tipo})`);
    invalidar(ALERTAS_PATH);
  }

  // ── Casamento: passagem registrada ────────────────────────────────────────
  // p = registro gravado em passagens.json (origem/destino já normalizados).
  async function avaliarPassagem(p) {
    if (!p || !p.id) return;
    const al = await ler(ALERTAS_PATH, VAZIO_AL);
    const lista = al.passagens || [];
    if (!lista.length) return;
    const cidade = (c) => d.chaveTexto(d.normalizarCidade(c));
    const o = cidade(p.origem), de = cidade(p.destino), prog = d.chaveTexto(p.programa);
    const cab = grupoCabine(p.cabine);
    let datas = null; // calculadas só se algum alerta pedir data
    const atingidos = lista.filter((a) => {
      if ((a.avisos || []).includes(p.id)) return false;
      if (cidade(a.origem) !== o || cidade(a.destino) !== de) return false;
      if (a.programas && a.programas.length && !a.programas.some((x) => d.chaveTexto(x) === prog)) return false;
      if (a.cabine && cab && a.cabine !== cab) return false;
      if (a.cabine && !cab) return false;
      if (a.maxPontos && Number(p.pontos) > a.maxPontos) return false;
      if (a.idaDe || a.idaAte) {
        if (!datas) {
          const r = d.normalizarDatas(p.datas_ida, p.enviadoEm || new Date().toISOString());
          datas = r.status === 'ok' ? r : { datas: [], precisao: null };
        }
        const de0 = a.idaDe || '0000-01-01', ate = a.idaAte || '9999-12-31';
        const bate = datas.datas.some((x) => {
          if (datas.precisao === 'mes') return x.slice(0, 7) >= de0.slice(0, 7) && x.slice(0, 7) <= ate.slice(0, 7);
          return x >= de0 && x <= ate;
        });
        if (!bate) return false;
      }
      return true;
    });
    if (!atingidos.length) return;

    const marcados = [];
    for (const a of atingidos) {
      const titulo = `${p.origem} → ${p.destino}: ${fmtPts(p.pontos)} pts`;
      const corpo = [p.programa, p.cabine || '', p.datas_ida ? '🛫 ' + p.datas_ida : ''].filter(Boolean).join(' · ').slice(0, 170);
      try {
        const r = await pushParaEmail(a.email, { titulo, corpo, dados: { aba: 'passagens', passagem: p.id }, grupo: 'passagens' });
        if (!r.entregues) {
          await enviarEmail(a.email, `✈️ Alerta: ${p.origem} → ${p.destino} por ${fmtPts(p.pontos)} pts`, `${p.origem} → ${p.destino} por ${fmtPts(p.pontos)} pontos`, [
            `<b>Programa:</b> ${esc(p.programa)}${p.cia ? ' · ' + esc(p.cia) : ''}`,
            p.cabine ? `<b>Cabine:</b> ${esc(p.cabine)}` : '',
            p.datas_ida ? `<b>🛫 Ida:</b> ${esc(p.datas_ida)}` : '',
            p.datas_volta ? `<b>🛬 Volta:</b> ${esc(p.datas_volta)}` : '',
            `Seu alerta: ${esc(a.origem)} → ${esc(a.destino)}${a.maxPontos ? ' até ' + fmtPts(a.maxPontos) + ' pts' : ''}${a.idaDe || a.idaAte ? ' · ida ' + (fmtData(a.idaDe) || '…') + ' a ' + (fmtData(a.idaAte) || '…') : ''}.`,
          ].filter(Boolean), { texto: 'Ver no painel', url: 'https://painel.clubedoviajante.com.br/?aba=passagens' });
        }
        marcados.push({ id: a.id, ref: p.id });
      } catch (e) {
        console.error('[alerta passagem]', a.id, e.message);
      }
    }
    await marcarAvisos('passagens', marcados);
    console.log(`[alertas membro] passagem ${p.id} → ${marcados.length} aviso(s)`);
  }

  // ── Casamento: transferência bonificada aprovada/publicada ────────────────
  async function avaliarTransferencia(item) {
    if (!item || item.categoria !== 'transferencia' || !item.destino) return;
    const bonus = Number(item.bonusMax);
    if (!(bonus > 0)) return;
    const al = await ler(ALERTAS_PATH, VAZIO_AL);
    const lista = al.transferencias || [];
    if (!lista.length) return;
    const n = d.normalizarChaveHist;
    const destino = n(item.destino), origem = n(item.origem);
    const origens = d.origensDaOferta(item).map(n);
    const ref = item.id || (origem + '>' + destino + '>' + (item.prazo || ''));
    const atingidos = lista.filter((a) => {
      if ((a.avisos || []).includes(ref)) return false;
      if (n(a.destino) !== destino) return false;
      const oa = n(a.origem);
      if (oa && oa !== 'todos' && origem !== 'todos' && !origens.includes(oa)) return false;
      return bonus >= Number(a.bonusMin || 0);
    });
    if (!atingidos.length) return;
    const marcados = [];
    for (const a of atingidos) {
      const de = (item.origem === 'Bancos selecionados' && a.origem) ? a.origem : item.origem;
      const titulo = `${bonus}% de bônus: ${de || 'Transferência'} → ${item.destino}`;
      const corpo = [item.titulo || '', item.prazo ? '⏳ até ' + item.prazo : ''].filter(Boolean).join(' · ').slice(0, 170);
      try {
        const r = await pushParaEmail(a.email, { titulo, corpo, dados: { aba: 'radar', oferta: item.id || '' }, grupo: 'transferencias' });
        if (!r.entregues) {
          await enviarEmail(a.email, `🔁 ${titulo}`, titulo, [
            item.titulo ? esc(item.titulo) : '',
            item.prazo ? `<b>Prazo:</b> ${esc(item.prazo)}` : '',
            `Seu alerta: ${esc(a.origem || 'qualquer origem')} → ${esc(a.destino)} com bônus a partir de ${a.bonusMin}%.`,
          ].filter(Boolean), { texto: 'Ver no Radar', url: 'https://painel.clubedoviajante.com.br/?aba=radar' });
        }
        marcados.push({ id: a.id, ref });
      } catch (e) {
        console.error('[alerta transferência]', a.id, e.message);
      }
    }
    await marcarAvisos('transferencias', marcados);
    console.log(`[alertas membro] transferência ${ref} → ${marcados.length} aviso(s)`);
  }

  return { avaliarPassagem, avaliarTransferencia, pushParaEmail };
};
