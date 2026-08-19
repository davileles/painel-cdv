/* ============================================================================
   CDV — camada de comportamento do redesenho
   ----------------------------------------------------------------------------
   Carregue depois do cdv-redesign.css e depois dos scripts do app:
     <script defer src="cdv-redesign.js"></script>

   O que faz (nada além disto — não toca em nenhuma função de dados):
   1. Tema claro como padrão quando o membro ainda não tem preferência salva.
   2. Barra inferior de navegação no celular, montada a partir das abas
      existentes e usando o próprio switchTab().
   3. Atalho ⌘K / Ctrl+K para a busca do Comparador.
   4. Normalização de densidade: sobe para 12px os tamanhos de fonte inline
      menores que isso e limita o peso em 800 (os cards e KPIs são gerados
      por template string no index.html, então isto roda depois de cada render).
      Desligue com window.CDV_DENSIDADE = false antes deste script.
   ========================================================================== */
(function () {
  'use strict';

  var ABAS_PRINCIPAIS = ['inicio', 'comparador', 'radar', 'milhas'];
  var ICONES = { inicio: '🏠', comparador: '🏆', radar: '📡', milhas: '📋' };
  var ROTULOS = { inicio: 'Início', comparador: 'Comparar', radar: 'Radar', milhas: 'Milhas' };

  /* 1 ─ Tema padrão claro ------------------------------------------------- */
  function temaPadrao() {
    var html = document.documentElement;
    if (!html.getAttribute('data-theme')) html.setAttribute('data-theme', 'light');
    var btn = document.getElementById('btn-tema');
    if (btn) btn.textContent = html.getAttribute('data-theme') === 'light' ? '☀️' : '🌙';
  }

  /* 2 ─ Barra inferior ---------------------------------------------------- */
  function montarBottomNav() {
    if (document.querySelector('.cdv-bottom-nav')) return;
    var tabs = document.getElementById('main-tabs');
    if (!tabs) return;

    var nav = document.createElement('nav');
    nav.className = 'cdv-bottom-nav';
    nav.setAttribute('aria-label', 'Navegação principal');

    ABAS_PRINCIPAIS.forEach(function (id) {
      var b = document.createElement('button');
      b.type = 'button';
      b.dataset.cdvTab = id;
      b.innerHTML = '<span class="cdv-bn-ico">' + ICONES[id] + '</span><span>' + ROTULOS[id] + '</span>';
      b.addEventListener('click', function () {
        if (typeof window.switchTab === 'function') window.switchTab(id);
        sincronizar();
        window.scrollTo(0, 0);
      });
      nav.appendChild(b);
    });

    var mais = document.createElement('button');
    mais.type = 'button';
    mais.dataset.cdvTab = '__mais';
    mais.innerHTML = '<span class="cdv-bn-ico">⋯</span><span>Mais</span>';
    mais.addEventListener('click', function () {
      if (typeof window.toggleSidebar === 'function') window.toggleSidebar(true);
      else tabs.classList.add('open');
    });
    nav.appendChild(mais);

    document.body.appendChild(nav);
    sincronizar();
  }

  function sincronizar() {
    var ativa = document.querySelector('#main-tabs .main-tab.active');
    var atual = ativa ? ativa.getAttribute('data-tab') : null;
    document.querySelectorAll('.cdv-bottom-nav button').forEach(function (b) {
      b.classList.toggle('on', b.dataset.cdvTab === atual);
    });
  }

  function envolverSwitchTab() {
    if (typeof window.switchTab !== 'function' || window.switchTab.__cdvWrapped) return;
    var original = window.switchTab;
    var wrapper = function () {
      var r = original.apply(this, arguments);
      sincronizar();
      return r;
    };
    wrapper.__cdvWrapped = true;
    window.switchTab = wrapper;
  }

  /* 3 ─ Atalho de busca -------------------------------------------------- */
  function atalhoBusca() {
    document.addEventListener('keydown', function (e) {
      var combo = (e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K');
      if (!combo) return;
      e.preventDefault();
      if (typeof window.switchTab === 'function') window.switchTab('comparador');
      var campo = document.getElementById('search');
      if (campo) { campo.focus(); campo.select(); }
    });
  }

  /* 4 ─ Densidade -------------------------------------------------------- */
  var MIN_PX = 12;
  function normalizar(raiz) {
    if (window.CDV_DENSIDADE === false) return;
    var alvos = raiz.querySelectorAll('[style*="font-size"],[style*="font-weight"]');
    for (var i = 0; i < alvos.length; i++) {
      var el = alvos[i];
      var fs = el.style.fontSize;
      if (fs && fs.indexOf('px') > -1) {
        var v = parseFloat(fs);
        if (v && v < MIN_PX) el.style.fontSize = MIN_PX + 'px';
      }
      if (el.style.fontWeight === '900') el.style.fontWeight = '800';
    }
  }

  function observar() {
    var alvo = document.getElementById('shell-main') || document.body;
    var pendente = null;
    var obs = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        if (muts[i].addedNodes && muts[i].addedNodes.length) {
          clearTimeout(pendente);
          pendente = setTimeout(function () { normalizar(alvo); sincronizar(); }, 120);
          return;
        }
      }
    });
    obs.observe(alvo, { childList: true, subtree: true });
  }

  function iniciar() {
    temaPadrao();
    montarBottomNav();
    envolverSwitchTab();
    atalhoBusca();
    normalizar(document.body);
    observar();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
  else iniciar();
})();
