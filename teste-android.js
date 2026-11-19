'use strict';
// ── TESTE DO APP ANDROID — candidatura de testadores ───────────────────────────
// Página pública: painel.clubedoviajante.com.br/teste-android/
// (teste-android/index.html). Desde 19/11/2026.
//
// O Google Play só publica o app depois de um teste fechado com testadores
// cadastrados pelo e-mail da CONTA GOOGLE de cada um (a do celular/Play Store).
// O formulário pede só nome, e-mail (Google) e telefone e lembra que o app é
// exclusivo de assinantes do Clube do Viajante Premium.
//
// Dados pessoais: nada vai para o painel-cdv (público). Registros no repo
// PRIVADO de dados:  app/testes-android.json  (lista)
//
// Rotas:
//   POST /app/teste-android                      pública (formulário)
//   GET  /app/teste-android/candidaturas         X-CDV-Op (lista; ?formato=csv →
//        só os e-mails, um por linha, pronto para a lista de testadores do Play Console)

//
// Conferência do Premium (desde 19/11/2026, decisão do Davi): só entra quem tem
// assinatura ATIVA do Clube do Viajante Premium na Hubla (oferta ou produto com
// "premium" no nome: Premium, Experimental, Ex-membros; vigente, em teste ou
// vitalícia — calcularSituacao) ou acesso ativo sem fatura numa oferta Premium
// (acessosPorProduto + ofertasAcesso). Casa pelo e-mail OU pelo telefone
// informado, porque o e-mail da conta Google pode não ser o da compra.

const { calcularSituacao, membroAtivo } = require('./hubla-assinaturas');
const { chaveTelefone } = require('./hubla-grupos-auditoria');

const ARQUIVO = 'app/testes-android.json';

function texto(v, max) { return String(v == null ? '' : v).trim().slice(0, max || 200); }
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const ehPremium = (...nomes) => nomes.some(n => /premium/.test(norm(n)));

// Assinantes Premium ativos → { emails: Map(email → nome), tels: Map(chave → email) }
function premiumAtivos(hubla, agora = Date.now()) {
  const emails = new Map(), tels = new Map();
  const add = (email, tel, nome) => {
    const e = String(email || '').toLowerCase().trim();
    if (e) emails.set(e, nome || '');
    const k = chaveTelefone(tel);
    if (k) tels.set(k, e || '');
  };
  for (const a of Object.values((hubla && hubla.assinaturas) || {})) {
    if (!a || !ehPremium(a.ofertaNome, a.produtoNome)) continue;
    const { situacao } = calcularSituacao(a, agora);
    if (situacao === 'vigente' || situacao === 'teste' || situacao === 'vitalicio') add(a.email, a.telefone, a.nome);
  }
  const ofAcesso = (hubla && hubla.ofertasAcesso) || {};
  for (const [pid, p] of Object.entries((hubla && hubla.acessosPorProduto) || {})) {
    for (const [email, m] of Object.entries((p && p.membros) || {})) {
      const oa = ofAcesso[pid + '|' + email];
      if (!m || !oa || !ehPremium(oa.ofertaNome) || !membroAtivo(m, agora)) continue;
      add(email, m.telefone, m.nome);
    }
  }
  return { emails, tels };
}

function registrar(app, d) {
  const { fetch, putRetry, lerLista, soDigitos, nomeApresentavel, limiteIp, opAutorizado, BAILEYS_URL, hublaArquivo } = d;

  let _premium = null;
  async function premium() {
    if (_premium && Date.now() - _premium.em < 5 * 60 * 1000) return _premium.dados;
    const dados = premiumAtivos(await hublaArquivo());
    _premium = { em: Date.now(), dados };
    return dados;
  }

  async function avisarGrupo(reg) {
    try {
      const mensagem = [
        '🤖 *Nova candidatura — teste do app Android*',
        `👤 ${reg.nome}`,
        `📧 ${reg.email}`,
        `📱 ${reg.tel}`,
        `✅ Premium ativo (conferido pelo ${reg.premium.por}${reg.premium.por === 'telefone' && reg.premium.email ? ' — ' + reg.premium.email : ''})`,
        reg.repetida ? '🔁 Já havia candidatura com este e-mail' : '',
      ].filter(Boolean).join('\n');
      await fetch(`${BAILEYS_URL}/enviar`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grupo: 'operador', mensagem, direto: true }),
        signal: AbortSignal.timeout(25000),
      });
    } catch (e) { console.warn('[teste-android] aviso WA falhou:', e.message); }
  }

  app.post('/app/teste-android', async (req, res) => {
    try {
      const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
      if (!limiteIp(ip)) return res.status(429).json({ ok: false, erro: 'Muitas tentativas. Tente novamente em uma hora.' });

      const b = req.body || {};
      if (texto(b.website)) return res.json({ ok: true }); // honeypot
      const nome = nomeApresentavel(texto(b.nome, 140));
      const email = texto(b.email, 160).toLowerCase();
      const tel = soDigitos(b.tel);

      if (nome.split(/\s+/).length < 2) return res.status(400).json({ ok: false, erro: 'Informe o nome completo.' });
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ ok: false, erro: 'E-mail inválido.' });
      if (tel.length < 10) return res.status(400).json({ ok: false, erro: 'Telefone inválido — inclua o DDD.' });
      if (b.premium !== true) return res.status(400).json({ ok: false, erro: 'O app é exclusivo para assinantes do Clube do Viajante Premium.' });

      // Confere a assinatura Premium ativa pelo e-mail ou pelo telefone.
      const pm = await premium();
      const kTel = chaveTelefone(tel);
      let assinatura = null;
      if (pm.emails.has(email)) assinatura = { por: 'email', email };
      else if (kTel && pm.tels.has(kTel)) assinatura = { por: 'telefone', email: pm.tels.get(kTel) };
      if (!assinatura) {
        return res.status(403).json({ ok: false, motivo: 'sem_premium',
          erro: 'Não encontramos uma assinatura ativa do Clube do Viajante Premium com esse e-mail ou telefone. Confira se usou o telefone ou o e-mail da sua compra na Hubla. O teste do app é exclusivo para assinantes Premium.' });
      }

      const reg = {
        id: 'and-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
        recebidoEm: new Date().toISOString(), ip, nome, email, tel, premium: assinatura,
      };
      await putRetry(ARQUIVO, (lista) => {
        reg.repetida = lista.some(x => x && x.email === email);
        lista.push(reg);
        return lista;
      });
      avisarGrupo(reg); // best-effort
      res.json({ ok: true, id: reg.id });
    } catch (e) {
      console.error('[teste-android]', e.message);
      res.status(500).json({ ok: false, erro: 'Não foi possível registrar agora. Tente novamente em instantes.' });
    }
  });

  app.get('/app/teste-android/candidaturas', async (req, res) => {
    if (!opAutorizado(req, res)) return;
    try {
      const { lista } = await lerLista(ARQUIVO);
      if (req.query.formato === 'csv') {
        const emails = [...new Set(lista.map(x => x && x.email).filter(Boolean))];
        res.set('Content-Type', 'text/csv; charset=utf-8');
        return res.send(emails.join('\n') + '\n');
      }
      res.json({ ok: true, total: lista.length, candidaturas: lista.slice().reverse() });
    } catch (e) {
      res.status(500).json({ ok: false, erro: e.message });
    }
  });
}

module.exports = { registrar, ARQUIVO };
