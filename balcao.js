'use strict';
// ── BALCÃO DO CLUBE DO VIAJANTE — formulário de verificação ────────────────────
// Página pública: painel.clubedoviajante.com.br/balcao/ (balcao/index.html).
// Tudo o que chega aqui é dado pessoal sensível (CPF, documento com foto,
// selfie, comprovante de endereço, chave PIX, termo assinado), então nada vai
// para o painel-cdv (público): registros e arquivos vão para o repo PRIVADO de
// dados (`davileles/dados`):
//   balcao/verificacoes.json              lista de pedidos (sem os arquivos)
//   balcao/arquivos/<id>/<campo>.<ext>    cada documento, em binário
//
// Rotas:
//   POST /balcao/verificacao                       pública (formulário)
//   GET  /balcao/verificacoes                      X-CDV-Op
//   GET  /balcao/arquivo/:id/:campo                X-CDV-Op (devolve o arquivo)
//   POST /balcao/verificacoes/status {id, status, obs}   X-CDV-Op

const REGISTROS = 'balcao/verificacoes.json';
const PASTA_ARQ = 'balcao/arquivos/';

// campo → tipos aceitos
const ARQUIVOS = {
  documento:   { rotulo: 'Documento com foto (RG ou CNH)', tipos: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] },
  selfie:      { rotulo: 'Selfie com o documento',          tipos: ['image/jpeg', 'image/png', 'image/webp'] },
  comprovante: { rotulo: 'Comprovante de endereço',         tipos: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] },
  instagram:   { rotulo: 'Print do Instagram',              tipos: ['image/jpeg', 'image/png', 'image/webp'] },
  termo:       { rotulo: 'Termo de uso assinado (GOV.BR)',  tipos: ['application/pdf'] },
};
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
const MAX_ARQ_BYTES = 6 * 1024 * 1024;
const STATUS = ['pendente', 'aprovado', 'reprovado'];

function cnpjValido(v) {
  const c = String(v || '').replace(/\D/g, '');
  if (c.length !== 14 || /^(\d)\1+$/.test(c)) return false;
  const calc = (base) => {
    const pesos = base.length === 12 ? [5,4,3,2,9,8,7,6,5,4,3,2] : [6,5,4,3,2,9,8,7,6,5,4,3,2];
    const s = base.split('').reduce((a, d, i) => a + Number(d) * pesos[i], 0);
    const r = s % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const d1 = calc(c.slice(0, 12));
  const d2 = calc(c.slice(0, 12) + d1);
  return c.endsWith(String(d1) + String(d2));
}

function texto(v, max) { return String(v == null ? '' : v).trim().slice(0, max || 200); }

function registrar(app, d) {
  const { fetch, GITHUB_TOKEN, REPO, putRetry, lerLista, getArquivoJson, cpfValido, soDigitos,
          nomeApresentavel, limiteIp, opAutorizado, BAILEYS_URL } = d;

  const ghHeaders = () => ({
    'Authorization': `token ${GITHUB_TOKEN}`,
    'User-Agent': 'cdv-proxy',
    'Accept': 'application/vnd.github+json',
  });

  async function gravarArquivo(caminho, base64, mensagem) {
    const url = `https://api.github.com/repos/${REPO}/contents/${caminho}`;
    const r = await fetch(url, {
      method: 'PUT',
      headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: mensagem, content: base64 }),
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(e.message || `GitHub PUT ${caminho} falhou (${r.status})`);
    }
  }

  async function avisarGrupo(reg) {
    try {
      let grupo = '';
      try { const { content: cfg } = await getArquivoJson('cfg.json'); grupo = (cfg && cfg.grupoAlertas) || ''; } catch (e) {}
      if (!grupo) return;
      const mensagem = [
        '🛡️ *Nova verificação do Balcão*',
        `👤 ${reg.nome}`,
        reg.reenvio ? '🔁 Reenvio (já havia pedido com este CPF)' : '',
        `🆔 ${reg.id}`,
        '⏳ Prazo de validação: até 5 dias úteis',
      ].filter(Boolean).join('\n');
      await fetch(`${BAILEYS_URL}/enviar`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grupo, mensagem }),
      });
    } catch (e) { console.warn('[balcao] aviso WA falhou:', e.message); }
  }

  // ── POST /balcao/verificacao (pública) ──────────────────────────────────
  app.post('/balcao/verificacao', async (req, res) => {
    try {
      const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
      if (!limiteIp(ip)) return res.status(429).json({ ok: false, erro: 'Muitas tentativas. Tente novamente em uma hora.' });

      const b = req.body || {};
      if (texto(b.website)) return res.json({ ok: true }); // honeypot
      if (b.consentimento !== true) return res.status(400).json({ ok: false, erro: 'É necessário concordar com o termo de consentimento (LGPD) para acessar o Balcão.' });

      const dd = b.dados || {};
      const nome = nomeApresentavel(texto(dd.nome, 140));
      const cpf = soDigitos(dd.cpf);
      const email = texto(dd.email, 160).toLowerCase();
      const tel = soDigitos(dd.tel);
      const nascimento = texto(dd.nascimento, 10);
      const instagram = texto(dd.instagram, 60).replace(/^@+/, '');
      const pixTipo = dd.pixTipo === 'cnpj' ? 'cnpj' : 'cpf';
      const pixChave = soDigitos(dd.pixChave);
      const pixBanco = texto(dd.pixBanco, 80);

      if (nome.split(/\s+/).length < 2) return res.status(400).json({ ok: false, erro: 'Informe o nome completo.' });
      if (!cpfValido(cpf)) return res.status(400).json({ ok: false, erro: 'CPF inválido.' });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(nascimento)) return res.status(400).json({ ok: false, erro: 'Data de nascimento inválida.' });
      const idade = (Date.now() - Date.parse(nascimento + 'T12:00:00-03:00')) / (365.25 * 86400000);
      if (!(idade >= 18 && idade < 110)) return res.status(400).json({ ok: false, erro: 'É preciso ser maior de 18 anos para participar do Balcão.' });
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ ok: false, erro: 'E-mail inválido.' });
      if (tel.length < 10) return res.status(400).json({ ok: false, erro: 'WhatsApp inválido — inclua o DDD.' });
      if (pixTipo === 'cpf') {
        if (pixChave !== cpf) return res.status(400).json({ ok: false, erro: 'A chave PIX do tipo CPF precisa ser o seu próprio CPF.' });
      } else if (!cnpjValido(pixChave)) return res.status(400).json({ ok: false, erro: 'CNPJ da chave PIX inválido.' });
      if (!pixBanco) return res.status(400).json({ ok: false, erro: 'Informe o banco da conta PIX.' });

      // Arquivos
      const arqs = b.arquivos || {};
      const prontos = [];
      for (const campo of Object.keys(ARQUIVOS)) {
        const a = arqs[campo] || {};
        const tipo = String(a.tipo || '');
        const base64 = String(a.base64 || '').replace(/^data:[^,]*,/, '');
        if (!base64) return res.status(400).json({ ok: false, erro: `Envie: ${ARQUIVOS[campo].rotulo}.` });
        if (!ARQUIVOS[campo].tipos.includes(tipo)) return res.status(400).json({ ok: false, erro: `Formato não aceito em: ${ARQUIVOS[campo].rotulo}.` });
        const bytes = Math.floor(base64.length * 3 / 4);
        if (bytes > MAX_ARQ_BYTES) return res.status(413).json({ ok: false, erro: `Arquivo grande demais em: ${ARQUIVOS[campo].rotulo} (máx. 6 MB).` });
        prontos.push({ campo, tipo, base64, bytes, nomeOriginal: texto(a.nome, 120) });
      }

      const id = 'bal-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
      const arquivos = {};
      for (const p of prontos) {
        const caminho = `${PASTA_ARQ}${id}/${p.campo}.${EXT[p.tipo]}`;
        await gravarArquivo(caminho, p.base64, `balcao: ${id} ${p.campo}`);
        arquivos[p.campo] = { caminho, tipo: p.tipo, bytes: p.bytes, nomeOriginal: p.nomeOriginal };
      }

      const reg = {
        id, recebidoEm: new Date().toISOString(), ip, status: 'pendente',
        nome, cpf, nascimento, email, tel, instagram,
        pix: { tipo: pixTipo, chave: pixChave, banco: pixBanco },
        arquivos,
        consentimento: { aceito: true, em: new Date().toISOString(), versao: '2026-11' },
      };
      await putRetry(REGISTROS, (lista) => {
        reg.reenvio = lista.some(x => x && x.cpf === cpf);
        lista.push(reg);
        return lista;
      });
      avisarGrupo(reg); // best-effort
      res.json({ ok: true, id });
    } catch (e) {
      console.error('[balcao/verificacao]', e.message);
      res.status(500).json({ ok: false, erro: 'Não foi possível registrar agora. Tente novamente em instantes.' });
    }
  });

  // ── GET /balcao/verificacoes (operador) ─────────────────────────────────
  app.get('/balcao/verificacoes', async (req, res) => {
    if (!opAutorizado(req, res)) return;
    try {
      const { lista } = await lerLista(REGISTROS);
      const st = texto(req.query.status, 20);
      res.json({ ok: true, data: st ? lista.filter(x => x && x.status === st) : lista });
    } catch (e) {
      console.error('[balcao/verificacoes GET]', e.message);
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // ── GET /balcao/arquivo/:id/:campo (operador) ───────────────────────────
  app.get('/balcao/arquivo/:id/:campo', async (req, res) => {
    if (!opAutorizado(req, res)) return;
    try {
      const { lista } = await lerLista(REGISTROS);
      const reg = lista.find(x => x && x.id === req.params.id);
      const a = reg && reg.arquivos && reg.arquivos[req.params.campo];
      if (!a) return res.status(404).json({ ok: false, erro: 'arquivo não encontrado' });
      const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${a.caminho}`, {
        headers: { ...ghHeaders(), 'Accept': 'application/vnd.github.raw' },
      });
      if (!r.ok) return res.status(502).json({ ok: false, erro: `GitHub ${r.status}` });
      res.setHeader('Content-Type', a.tipo);
      res.setHeader('Cache-Control', 'no-store');
      res.send(await r.buffer());
    } catch (e) {
      console.error('[balcao/arquivo GET]', e.message);
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // ── POST /balcao/verificacoes/status (operador) ─────────────────────────
  app.post('/balcao/verificacoes/status', async (req, res) => {
    if (!opAutorizado(req, res)) return;
    const { id, status } = req.body || {};
    if (!id || !STATUS.includes(status)) return res.status(400).json({ ok: false, erro: 'id e status (pendente|aprovado|reprovado) obrigatórios' });
    try {
      let achou = false;
      await putRetry(REGISTROS, (lista) => {
        const k = lista.findIndex(x => x && x.id === id);
        if (k === -1) return null;
        achou = true;
        lista[k].status = status;
        lista[k].statusEm = new Date().toISOString();
        lista[k].obs = texto(req.body.obs, 1000);
        return lista;
      });
      if (!achou) return res.status(404).json({ ok: false, erro: 'verificação não encontrada' });
      res.json({ ok: true });
    } catch (e) {
      console.error('[balcao/verificacoes/status]', e.message);
      res.status(500).json({ ok: false, erro: e.message });
    }
  });
}

module.exports = { registrar, cnpjValido };
