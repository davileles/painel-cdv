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
  if (Preferences) {
    var setOrig = Storage.prototype.setItem, remOrig = Storage.prototype.removeItem;
    Storage.prototype.setItem = function (k, v) {
      setOrig.apply(this, arguments);
      if (this === window.localStorage && k === CHAVE_SESSAO) falhaSilenciosa(Preferences.set({ key: k, value: String(v) }));
    };
    Storage.prototype.removeItem = function (k) {
      remOrig.apply(this, arguments);
      if (this === window.localStorage && k === CHAVE_SESSAO) {
        // Saiu (ou sessão expirou): não restaurar nesta abertura do app,
        // mesmo que a remoção nativa ainda não tenha terminado.
        try { sessionStorage.setItem('cdv_app_sem_restaurar', '1'); } catch (e) {}
        falhaSilenciosa(Preferences.remove({ key: k }));
      }
    };
    // Sessão sumiu do navegador interno mas existe no nativo → devolve e recarrega
    // (uma vez só por abertura do app, para nunca entrar em ciclo).
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
    if (!navigator.onLine) avisoRede();
    if (SplashScreen) setTimeout(function () { falhaSilenciosa(SplashScreen.hide()); }, 150);
  });
})();
