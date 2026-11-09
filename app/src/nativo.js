/* ════════════════════════════════════════════════════════════════════════════
   nativo.js — ponte entre o painel (index.html) e o app Android/iOS.

   Carregado no <head> do www/index.html pelo montar.mjs, DEPOIS de
   capacitor-plugins.js (core do Capacitor + plugins em build IIFE, que deixa
   os globais capacitorExports, capacitorApp, capacitorBrowser…).

   Fora do app (site normal) este arquivo não é carregado. Mesmo assim tudo
   aqui confere isNativePlatform() antes de agir.

   O que faz:
     1. marca <html class="app-nativo plat-android|plat-ios"> (nativo.css)
     2. abre links externos dentro do app (Browser) e apps de terceiros
        (WhatsApp, Instagram, Telegram, YouTube, e-mail, telefone) fora dele
     3. navigator.share → folha de compartilhar nativa
     4. botão voltar do Android: fecha janela → menu → volta ao Início → sai
     5. cor dos ícones da barra de status acompanha o tema claro/escuro
     6. vibração leve ao tocar na barra inferior
     7. guarda a sessão (cdv_auth) também no armazenamento nativo, para o
        sistema não deslogar o membro ao limpar dados do navegador interno
     7b. entrar com Face ID / Touch ID / digital (chave do celular no cofre
        do sistema, trocada por sessão em /membros/dispositivo/entrar)
     8. aviso de "sem internet"
   ════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var CAP = window.Capacitor;
  if (!CAP || !CAP.isNativePlatform || !CAP.isNativePlatform()) return;

  var PLATAFORMA = CAP.getPlatform(); // 'android' | 'ios'
  var html = document.documentElement;
  html.classList.add('app-nativo', 'plat-' + PLATAFORMA);
  window.CDV_APP = { plataforma: PLATAFORMA, versao: '__VERSAO_APP__' };

  function plugin(global, nome) {
    var mod = window[global];
    return mod && mod[nome] ? mod[nome] : null;
  }
  var App = plugin('capacitorApp', 'App');
  var Browser = plugin('capacitorBrowser', 'Browser');
  var Share = plugin('capacitorShare', 'Share');
  var StatusBar = plugin('capacitorStatusBar', 'StatusBar');
  var SplashScreen = plugin('capacitorSplashScreen', 'SplashScreen');
  var Haptics = plugin('capacitorHaptics', 'Haptics');
  var Preferences = plugin('capacitorPreferences', 'Preferences');

  function falhaSilenciosa(p) { if (p && p.catch) p.catch(function () {}); }

  /* ── 2. Links externos ─────────────────────────────────────────────────── */
  // Domínios que têm app próprio: vão para fora (o sistema abre o app certo).
  var HOSTS_APP_EXTERNO = [
    'wa.me', 'api.whatsapp.com', 'chat.whatsapp.com', 'whatsapp.com',
    't.me', 'telegram.me', 'instagram.com', 'youtube.com', 'youtu.be',
    'maps.google.com', 'maps.apple.com', 'apps.apple.com', 'play.google.com',
  ];
  function hostCasa(host, lista) {
    host = String(host || '').toLowerCase().replace(/^www\./, '');
    for (var i = 0; i < lista.length; i++) {
      var d = lista[i];
      if (host === d || host.slice(-(d.length + 1)) === '.' + d) return true;
    }
    return false;
  }

  function abrirExterno(url) {
    var u;
    try { u = new URL(url, location.href); } catch (e) { return false; }
    if (u.protocol === 'mailto:' || u.protocol === 'tel:' || u.protocol === 'sms:') {
      location.href = u.href; // o Capacitor entrega ao sistema
      return true;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (u.host === location.host) return false; // arquivo do próprio app
    if (hostCasa(u.host, HOSTS_APP_EXTERNO) || !Browser) {
      location.href = u.href; // fora do app (Capacitor manda ao sistema)
      return true;
    }
    falhaSilenciosa(Browser.open({ url: u.href, presentationStyle: 'popover', toolbarColor: '#262e42' }));
    return true;
  }
  window.cdvAbrirExterno = abrirExterno;

  document.addEventListener('click', function (ev) {
    if (ev.defaultPrevented || ev.button !== 0) return;
    var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
    if (!a || a.hasAttribute('download')) return;
    var href = a.getAttribute('href');
    if (!href || href.charAt(0) === '#' || /^javascript:/i.test(href)) return;
    if (abrirExterno(a.href)) ev.preventDefault();
  }, true);

  // window.open('https://…') → navegador do app. Devolve um objeto parecido
  // com uma janela para o código do painel que testa "if (w)".
  var abrirOriginal = window.open;
  window.open = function (url) {
    if (url && abrirExterno(String(url))) {
      return { closed: false, opener: null, close: function () { if (Browser) falhaSilenciosa(Browser.close()); }, focus: function () {} };
    }
    return abrirOriginal.apply(window, arguments);
  };

  /* ── 3. Compartilhar ───────────────────────────────────────────────────── */
  if (Share) {
    navigator.share = function (dados) {
      dados = dados || {};
      return Share.share({
        title: dados.title || undefined,
        text: dados.text || undefined,
        url: dados.url || undefined,
        dialogTitle: 'Compartilhar',
      }).then(function () {});
    };
    navigator.canShare = function () { return true; };
  }

  /* ── 4. Botão voltar (Android) ─────────────────────────────────────────── */
  function visivel(el) {
    if (!el || !el.isConnected) return false;
    var cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && el.getClientRects().length > 0;
  }
  // Janela aberta = elemento fixo que cobre a tela inteira (fundo escuro).
  function janelaAberta() {
    var cands = document.querySelectorAll('[id$="overlay"],[class*="overlay"],[class*="modal"]');
    var topo = null, zTopo = -1;
    for (var i = 0; i < cands.length; i++) {
      var el = cands[i];
      if (el.id === 'login-screen' || !visivel(el)) continue;
      var cs = getComputedStyle(el);
      if (cs.position !== 'fixed') continue;
      var r = el.getBoundingClientRect();
      if (r.width < innerWidth * 0.9 || r.height < innerHeight * 0.9) continue;
      var z = parseInt(cs.zIndex, 10) || 0;
      if (z >= zTopo) { zTopo = z; topo = el; }
    }
    return topo;
  }
  function voltar() {
    var j = janelaAberta();
    if (j) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      setTimeout(function () {
        if (visivel(j)) j.click(); // fundo clicável fecha (onclick target===this)
        setTimeout(function () { if (visivel(j)) j.style.display = 'none'; }, 60);
      }, 30);
      return;
    }
    var menu = document.getElementById('main-tabs');
    if (menu && menu.classList.contains('open') && typeof window.toggleSidebar === 'function') {
      window.toggleSidebar(false);
      return;
    }
    var ativa = document.querySelector('.main-tab.active');
    var login = document.getElementById('login-screen');
    var logado = !login || !visivel(login);
    if (logado && ativa && ativa.dataset.tab && ativa.dataset.tab !== 'inicio' && typeof window.switchTab === 'function') {
      window.switchTab('inicio');
      return;
    }
    if (App) falhaSilenciosa(App.minimizeApp());
  }
  if (App && PLATAFORMA === 'android') App.addListener('backButton', voltar);

  /* ── 5. Barra de status acompanha o tema ───────────────────────────────── */
  function ajustarBarra() {
    if (!StatusBar) return;
    var claro = html.getAttribute('data-theme') !== 'dark';
    // Style.Light = ícones escuros (fundo claro); Style.Dark = ícones claros.
    falhaSilenciosa(StatusBar.setStyle({ style: claro ? 'LIGHT' : 'DARK' }));
  }
  new MutationObserver(ajustarBarra).observe(html, { attributes: true, attributeFilter: ['data-theme'] });

  /* ── 6. Vibração leve na barra inferior e no menu ──────────────────────── */
  document.addEventListener('click', function (ev) {
    if (!Haptics || !ev.target || !ev.target.closest) return;
    if (ev.target.closest('.cdv-bottom-nav button, .main-tab')) {
      falhaSilenciosa(Haptics.impact({ style: 'LIGHT' }));
    }
  }, true);

  /* ── 7. Sessão também no armazenamento nativo ──────────────────────────── */
  var CHAVE_SESSAO = 'cdv_auth';
  var setOrig = Storage.prototype.setItem, remOrig = Storage.prototype.removeItem;
  if (Preferences) {
    Storage.prototype.setItem = function (k, v) {
      setOrig.apply(this, arguments);
      if (this === window.localStorage && k === CHAVE_SESSAO) falhaSilenciosa(Preferences.set({ key: k, value: String(v) }));
    };
    Storage.prototype.removeItem = function (k) {
      remOrig.apply(this, arguments);
      if (this === window.localStorage && k === CHAVE_SESSAO) {
        // Saiu (ou sessão expirou): não restaurar nem pedir Face ID sozinho
        // nesta abertura do app, mesmo que a remoção nativa ainda não tenha terminado.
        try { sessionStorage.setItem('cdv_app_sem_restaurar', '1'); } catch (e) {}
        falhaSilenciosa(Preferences.remove({ key: k }));
      }
    };
  }
  // Sessão sumiu do navegador interno mas existe no nativo → devolve e recarrega
  // (uma vez só por abertura do app, para nunca entrar em ciclo).
  function restaurarSessaoNativa() {
    if (!Preferences) return;
    var atual = null, podeRestaurar = true;
    try { atual = localStorage.getItem(CHAVE_SESSAO); } catch (e) {}
    try { podeRestaurar = !sessionStorage.getItem('cdv_app_sem_restaurar'); } catch (e) {}
    Preferences.get({ key: CHAVE_SESSAO }).then(function (r) {
      var salvo = r && r.value;
      if (!atual && salvo && podeRestaurar) {
        try { sessionStorage.setItem('cdv_app_sem_restaurar', '1'); } catch (e) {}
        try {
          var s = JSON.parse(salvo);
          if (s && s.token && s.ts && (Date.now() - s.ts) < 7 * 864e5) {
            setOrig.call(localStorage, CHAVE_SESSAO, salvo);
            location.reload();
          }
        } catch (e) {}
      } else if (atual && atual !== salvo) {
        falhaSilenciosa(Preferences.set({ key: CHAVE_SESSAO, value: atual }));
      }
    }).catch(function () {});
  }

  /* ── 7b. Entrar com Face ID / Touch ID / digital ───────────────────────── */
  // 1º acesso: código por e-mail. Logo depois o app oferece a biometria; se o
  // membro aceita, o proxy entrega uma chave deste celular (vale 180 dias) que
  // fica no cofre do sistema, só liberada pelo Face ID/digital. Nas próximas
  // aberturas a chave é trocada por uma sessão nova (/membros/dispositivo/entrar).
  // Voltar ao app depois de 5 min em segundo plano pede a biometria de novo.
  var Bio = plugin('capacitorCapacitorBiometric', 'NativeBiometric');
  var PROXY = 'https://cdv-proxy-production.up.railway.app';
  var BIO_SERVIDOR = 'painel.clubedoviajante.com.br';
  var BIO_PREF = 'cdv_bio';
  var bioInfo = null;      // { id, nome } quando ativado neste celular
  var bioNome = 'Face ID'; // rótulo pelo tipo de biometria do aparelho
  var bioPronto = false;

  function nomeBiometria(t) {
    if (t === 2) return 'Face ID';
    if (t === 1) return 'Touch ID';
    if (t === 3) return 'digital';
    if (t === 4) return 'reconhecimento facial';
    return 'biometria';
  }
  function sessaoAtual() {
    try { var s = JSON.parse(localStorage.getItem(CHAVE_SESSAO) || 'null'); return s && s.token ? s : null; } catch (e) { return null; }
  }
  function postProxy(caminho, corpo) {
    return fetch(PROXY + caminho, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo || {}) })
      .then(function (r) { return r.json().catch(function () { return {}; }); });
  }
  function bioDisponivel() {
    if (!Bio) return Promise.resolve(false);
    return Bio.isAvailable({ useFallback: false }).then(function (r) {
      if (r && r.isAvailable) bioNome = nomeBiometria(r.biometryType);
      return !!(r && r.isAvailable);
    }).catch(function () { return false; });
  }
  function bioEsquecer() {
    bioInfo = null;
    if (Preferences) falhaSilenciosa(Preferences.remove({ key: BIO_PREF }));
    if (Bio) falhaSilenciosa(Bio.deleteCredentials({ server: BIO_SERVIDOR }));
  }

  function el(tag, attrs, filhos) {
    var e = document.createElement(tag);
    for (var k in (attrs || {})) {
      if (k === 'onclick') e.addEventListener('click', attrs[k]);
      else if (k === 'text') e.textContent = attrs[k];
      else e.setAttribute(k, attrs[k]);
    }
    (filhos || []).forEach(function (f) { if (f) e.appendChild(f); });
    return e;
  }
  function aviso(texto) {
    var t = el('div', { 'class': 'cdv-bio-toast', text: texto });
    document.body.appendChild(t);
    setTimeout(function () { t.classList.add('on'); }, 10);
    setTimeout(function () { t.classList.remove('on'); setTimeout(function () { t.remove(); }, 300); }, 2600);
  }

  // Tela de desbloqueio por cima de tudo.
  var trava = null;
  function mostrarTrava(automatico) {
    if (!bioInfo) return;
    if (!trava) {
      var msg = el('div', { 'class': 'cdv-bio-msg', text: '' });
      trava = el('div', { id: 'cdv-bio-trava', role: 'dialog', 'aria-label': 'Desbloquear' }, [
        el('div', { 'class': 'cdv-bio-caixa' }, [
          el('img', { src: 'logocdv.png', alt: '', 'class': 'cdv-bio-logo' }),
          el('div', { 'class': 'cdv-bio-titulo', text: 'Clube do Viajante' }),
          el('div', { 'class': 'cdv-bio-sub', text: 'Painel do Membro' }),
          el('button', { 'class': 'cdv-bio-btn', type: 'button', onclick: function () { desbloquear(); } }, [
            el('span', { 'class': 'cdv-bio-btn-txt', text: 'Entrar com ' + bioNome }),
          ]),
          msg,
          el('button', { 'class': 'cdv-bio-link', type: 'button', text: 'Entrar com e-mail', onclick: function () {
            esconderTrava();
            try { localStorage.removeItem(CHAVE_SESSAO); } catch (e) {}
            if (typeof window.fazerLogout === 'function') window.fazerLogout();
          } }),
        ]),
      ]);
      trava._msg = msg;
      document.body.appendChild(trava);
    }
    trava.querySelector('.cdv-bio-btn-txt').textContent = 'Entrar com ' + bioNome;
    trava._msg.textContent = '';
    trava.style.display = 'flex';
    if (automatico) setTimeout(desbloquear, 250);
  }
  function esconderTrava() { if (trava) trava.style.display = 'none'; }

  var desbloqueando = false;
  function desbloquear() {
    if (desbloqueando || !bioInfo || !Bio) return;
    desbloqueando = true;
    var msg = trava && trava._msg;
    if (msg) msg.textContent = '';
    Bio.getSecureCredentials({
      server: BIO_SERVIDOR,
      reason: 'Entrar no Painel do Viajante',
      title: 'Entrar no Painel do Viajante',
      negativeButtonText: 'Cancelar',
    }).then(function (cred) {
      if (msg) msg.textContent = 'Entrando…';
      return postProxy('/membros/dispositivo/entrar', { id: cred.username, segredo: cred.password });
    }).then(function (r) {
      desbloqueando = false;
      if (r && r.ok && r.token) {
        var tinhaSessao = !!sessaoAtual();
        localStorage.setItem(CHAVE_SESSAO, JSON.stringify({ email: r.email, nome: r.nome || '', token: r.token, ts: Date.now() }));
        if (!tinhaSessao) { location.reload(); return; }
        esconderTrava();
        setTimeout(iniciarPush, 800);
        return;
      }
      var motivo = r && r.motivo;
      if (motivo === 'chave' || motivo === 'expirada' || motivo === 'inativo') {
        bioEsquecer();
        esconderTrava();
        try { localStorage.removeItem(CHAVE_SESSAO); } catch (e) {}
        if (typeof window.fazerLogout === 'function') window.fazerLogout();
        alert(motivo === 'inativo'
          ? 'Sua assinatura não está ativa. Entre com seu e-mail para conferir.'
          : 'O acesso por ' + bioNome + ' venceu neste celular. Entre com o código por e-mail e ative de novo.');
        return;
      }
      if (msg) msg.textContent = 'Não foi possível entrar agora. Confira a internet e toque de novo.';
    }).catch(function (e) {
      desbloqueando = false;
      var cod = e && (e.code || e.errorCode);
      // 21 = credencial sumiu (biometria do aparelho mudou ou app reinstalado)
      if (String(cod) === '21' || /No protected credentials|not found|invalidated/i.test(String(e && e.message))) {
        bioEsquecer();
        esconderTrava();
        if (!sessaoAtual() && typeof window.fazerLogout === 'function') window.fazerLogout();
        alert('O ' + bioNome + ' foi alterado neste celular. Entre com o código por e-mail e ative de novo.');
        return;
      }
      if (msg) msg.textContent = 'Toque no botão para tentar de novo.';
    });
  }

  // Convite depois do login por código (index.html marca cdv_bio_oferecer).
  function oferecerBiometria() {
    var s = sessaoAtual();
    if (!s || bioInfo) return;
    var fundo;
    function fechar() { if (fundo) fundo.remove(); }
    function ativar(btn) {
      btn.disabled = true;
      btn.textContent = 'Ativando…';
      postProxy('/membros/dispositivo/registrar', { plataforma: PLATAFORMA, modelo: '' })
        .then(function (r) {
          if (!r || !r.ok || !r.id || !r.segredo) throw new Error((r && r.erro) || 'falha');
          return Bio.setCredentials({
            username: r.id, password: r.segredo, server: BIO_SERVIDOR,
            accessControl: 2, // BIOMETRY_ANY: sobrevive a cadastrar outro dedo/rosto
            title: 'Confirme para ativar o ' + bioNome, negativeButtonText: 'Cancelar',
          }).then(function () { return r; });
        })
        .then(function (r) {
          bioInfo = { id: r.id, email: s.email };
          if (Preferences) falhaSilenciosa(Preferences.set({ key: BIO_PREF, value: JSON.stringify(bioInfo) }));
          fechar();
          aviso(bioNome + ' ativado. Na próxima vez é só olhar/tocar.');
        })
        .catch(function () {
          btn.disabled = false;
          btn.textContent = 'Tentar de novo';
        });
    }
    var btnSim = el('button', { 'class': 'cdv-bio-btn', type: 'button', text: 'Ativar ' + bioNome });
    btnSim.addEventListener('click', function () { ativar(btnSim); });
    fundo = el('div', { id: 'cdv-bio-convite' }, [
      el('div', { 'class': 'cdv-bio-caixa' }, [
        el('div', { 'class': 'cdv-bio-titulo', text: 'Entrar com ' + bioNome + '?' }),
        el('div', { 'class': 'cdv-bio-sub', text: 'Nas próximas vezes você entra sem precisar do código por e-mail.' }),
        btnSim,
        el('button', { 'class': 'cdv-bio-link', type: 'button', text: 'Agora não', onclick: fechar }),
      ]),
    ]);
    document.body.appendChild(fundo);
  }

  // Na tela de login (depois de "Sair"): botão para voltar com a biometria.
  function botaoNoLogin() {
    var passo = document.getElementById('login-step1');
    if (!passo || !bioInfo || document.getElementById('cdv-bio-login')) return;
    var bloco = el('div', { id: 'cdv-bio-login' }, [
      el('button', { 'class': 'login-btn', type: 'button', text: 'Entrar com ' + bioNome, onclick: function () { mostrarTrava(true); } }),
      el('button', { 'class': 'cdv-bio-link', type: 'button', text: 'Desativar ' + bioNome + ' neste celular', onclick: function () {
        if (!confirm('Desativar a entrada por ' + bioNome + ' neste celular?')) return;
        var id = bioInfo && bioInfo.id;
        bioEsquecer();
        bloco.remove();
        if (id) falhaSilenciosa(postProxy('/membros/dispositivo/remover', { id: id }));
      } }),
      el('div', { 'class': 'cdv-bio-ou', text: 'ou receba um código por e-mail' }),
    ]);
    passo.insertBefore(bloco, passo.firstChild);
  }
  // fazerLogout() mostra a tela de login sem recarregar: põe o botão nela.
  function vigiarTelaLogin() {
    var tela = document.getElementById('login-screen');
    if (!tela) return;
    new MutationObserver(function () {
      if (bioPronto && visivel(tela)) botaoNoLogin();
    }).observe(tela, { attributes: true, attributeFilter: ['style'] });
  }

  var emSegundoPlanoDesde = 0;
  if (App) App.addListener('appStateChange', function (st) {
    if (!st.isActive) { emSegundoPlanoDesde = Date.now(); return; }
    if (bioInfo && sessaoAtual() && emSegundoPlanoDesde && Date.now() - emSegundoPlanoDesde > 5 * 60 * 1000) mostrarTrava(true);
    emSegundoPlanoDesde = 0;
  });

  function iniciarBiometria() {
    var oferecer = false, semAuto = false;
    try { oferecer = sessionStorage.getItem('cdv_bio_oferecer') === '1'; sessionStorage.removeItem('cdv_bio_oferecer'); } catch (e) {}
    try { semAuto = !!sessionStorage.getItem('cdv_app_sem_restaurar'); } catch (e) {}
    var lerPref = Preferences ? Preferences.get({ key: BIO_PREF }) : Promise.resolve(null);
    Promise.all([lerPref.catch(function () { return null; }), bioDisponivel()]).then(function (res) {
      var pref = res[0] && res[0].value, disponivel = res[1];
      try { bioInfo = pref ? JSON.parse(pref) : null; } catch (e) { bioInfo = null; }
      if (bioInfo && !disponivel) bioInfo = null; // biometria desligada no aparelho: só e-mail
      bioPronto = true;
      vigiarTelaLogin();
      if (!bioInfo) {
        restaurarSessaoNativa();
        if (oferecer && disponivel) setTimeout(oferecerBiometria, 600);
        return;
      }
      // Com biometria a sessão é renovada pelo Face ID: não restaura a antiga.
      var s = sessaoAtual();
      if (s && s.email && bioInfo.email && s.email !== bioInfo.email) { bioEsquecer(); return; }
      if (semAuto) { botaoNoLogin(); return; }
      mostrarTrava(true);
    });
  }
  window.cdvBiometria = {
    ativa: function () { return !!bioInfo; },
    nome: function () { return bioNome; },
  };

  /* ── 7c. Notificações push (alertas do membro) ─────────────────────────── */
  // Só iPhone por enquanto (APNs direto do proxy). No Android o push depende do
  // Firebase (google-services.json), ainda não configurado: não registra lá.
  // Permissão: pedida quando o membro cria um alerta (window.cdvPushPedir, chamado
  // pelo index.html) ou na 1ª abertura logada; se já liberada, registra a cada
  // abertura (o token pode mudar) e manda ao proxy (/membros/dispositivo/push).
  var Push = plugin('capacitorPushNotifications', 'PushNotifications');
  var PUSH_ATIVO = !!Push && PLATAFORMA === 'ios';
  var pushTokenEnviado = '';
  function enviarTokenPush(token) {
    if (!token || !sessaoAtual()) return;
    var chave = token + '|' + ((sessaoAtual() || {}).email || '');
    if (pushTokenEnviado === chave) return;
    postProxy('/membros/dispositivo/push', { id: bioInfo ? bioInfo.id : '', plataforma: PLATAFORMA, pushToken: token })
      .then(function (r) { if (r && r.ok) pushTokenEnviado = chave; })
      .catch(function () {});
  }
  function registrarPush() {
    if (!PUSH_ATIVO) return Promise.resolve(false);
    return Push.register().then(function () { return true; }).catch(function () { return false; });
  }
  function pedirPush() {
    if (!PUSH_ATIVO || !sessaoAtual()) return Promise.resolve(false);
    return Push.checkPermissions().then(function (st) {
      if (st.receive === 'granted') return registrarPush();
      if (st.receive === 'denied') return false;
      return Push.requestPermissions().then(function (r) {
        return r.receive === 'granted' ? registrarPush() : false;
      });
    }).catch(function () { return false; });
  }
  window.cdvPushPedir = pedirPush;
  if (PUSH_ATIVO) {
    Push.addListener('registration', function (t) { enviarTokenPush(t && t.value); });
    Push.addListener('registrationError', function () {});
    // Toque na notificação: abre a aba do alerta (passagens, radar, comparador).
    Push.addListener('pushNotificationActionPerformed', function (ev) {
      var d = (ev && ev.notification && ev.notification.data) || {};
      var aba = d.aba;
      if (!aba) return;
      var abrir = function () { if (typeof window.switchTab === 'function') window.switchTab(aba); };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(abrir, 400); });
      else abrir();
    });
    // Com o app aberto o sistema não mostra o banner: mostra um aviso no rodapé.
    Push.addListener('pushNotificationReceived', function (n) {
      if (n && (n.title || n.body) && document.body) aviso((n.title || '') + (n.body ? ' — ' + n.body : ''));
    });
  }
  function iniciarPush() {
    if (!PUSH_ATIVO || !sessaoAtual()) return;
    Push.checkPermissions().then(function (st) {
      if (st.receive === 'granted') { registrarPush(); return; }
      if (st.receive === 'denied' || !Preferences) return;
      // Pergunta uma vez, com explicação antes do pedido do sistema.
      Preferences.get({ key: 'cdv_push_perguntado' }).then(function (r) {
        if (r && r.value) return;
        Preferences.set({ key: 'cdv_push_perguntado', value: '1' });
        setTimeout(convitePush, 1500);
      }).catch(function () {});
    }).catch(function () {});
  }
  function convitePush() {
    if (document.getElementById('cdv-bio-convite')) { setTimeout(convitePush, 4000); return; }
    var fundo;
    function fechar() { if (fundo) fundo.remove(); }
    fundo = el('div', { id: 'cdv-bio-convite' }, [
      el('div', { 'class': 'cdv-bio-caixa' }, [
        el('div', { 'class': 'cdv-bio-titulo', text: 'Receber avisos no celular?' }),
        el('div', { 'class': 'cdv-bio-sub', text: 'Avisamos aqui quando aparecer a passagem, a transferência ou a pontuação que você pediu nos seus alertas.' }),
        el('button', { 'class': 'cdv-bio-btn', type: 'button', text: 'Ativar avisos', onclick: function () { fechar(); pedirPush(); } }),
        el('button', { 'class': 'cdv-bio-link', type: 'button', text: 'Agora não', onclick: fechar }),
      ]),
    ]);
    document.body.appendChild(fundo);
  }

  /* ── 8. Sem internet ───────────────────────────────────────────────────── */
  function avisoRede() {
    var el = document.getElementById('cdv-offline');
    if (!el) {
      if (!document.body) return;
      el = document.createElement('div');
      el.id = 'cdv-offline';
      el.setAttribute('role', 'status');
      el.textContent = 'Sem internet. Você está vendo o que já tinha carregado.';
      document.body.appendChild(el);
    }
    el.classList.toggle('on', !navigator.onLine);
  }
  window.addEventListener('online', avisoRede);
  window.addEventListener('offline', avisoRede);

  /* ── Ao terminar de carregar ───────────────────────────────────────────── */
  document.addEventListener('DOMContentLoaded', function () {
    ajustarBarra();
    iniciarBiometria();
    setTimeout(iniciarPush, 1200);
    if (!navigator.onLine) avisoRede();
    if (SplashScreen) setTimeout(function () { falhaSilenciosa(SplashScreen.hide()); }, 150);
  });
})();
