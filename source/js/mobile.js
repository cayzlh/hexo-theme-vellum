/**
 * Vellum — 移动端专有 JavaScript
 *
 * 所有逻辑通过 matchMedia 或 window.innerWidth 判断设备类型，
 * 仅在移动端（< 768px）执行，不对 PC 端产生任何影响。
 *
 * 悬浮球（dock）是站点导航与文章目录的统一入口：
 *   · 「导航」格 → 展开右侧导航抽屉（.nav-drawer，样式与交互沿用原实现）
 *   · 「目录」格 → 升起底部目录面板（.toc-panel，样式与交互沿用原实现）
 * 两个面板互斥，同一时刻只允许一个打开，避免遮罩叠加、body 锁死。
 */
(function () {
  'use strict';

  if (typeof window === 'undefined') return;

  // =============================================
  // 设备判断
  // =============================================
  var isMobile = window.matchMedia('(max-width: 767px)');
  var isTablet = window.matchMedia('(min-width: 768px) and (max-width: 1023px)');

  function isMobileView() {
    return isMobile.matches;
  }

  function isTabletView() {
    return isTablet.matches;
  }

  function isMobileOrTablet() {
    return isMobileView() || isTabletView();
  }

  // =============================================
  // 面板状态
  //
  // 抽屉与目录面板都是 fixed 全高/半高浮层，body 一旦 overflow:hidden
  // 就必须保证「谁锁的谁开」。这里用一个显式状态对象收敛两处，
  // 而不是让每个 init 各写一遍 —— 否则 A 打开时关 B，B 的清理回调
  // 会把 A 刚设上的 overflow 一起清掉。
  // =============================================
  var state = { nav: false, toc: false };

  function lockBody() {
    document.body.style.overflow = 'hidden';
  }

  function unlockBodyIfIdle() {
    if (!state.nav && !state.toc) document.body.style.overflow = '';
  }

  // =============================================
  // 2.3 导航 — 抽屉
  // =============================================
  var navEls = null;

  function navParts() {
    if (navEls) return navEls;
    navEls = {
      drawer: document.querySelector('.nav-drawer'),
      overlay: document.querySelector('.nav-overlay'),
      toggle: document.querySelector('.nav-toggle'),
      btn: document.getElementById('dockNav')
    };
    return navEls;
  }

  function setNavOpen(open) {
    var p = navParts();
    if (!p.drawer) return;
    state.nav = open;
    p.drawer.classList.toggle('open', open);
    if (p.overlay) p.overlay.classList.toggle('active', open);
    if (p.toggle) p.toggle.classList.toggle('open', open);
    if (p.btn) {
      p.btn.classList.toggle('is-active', open);
      p.btn.setAttribute('aria-expanded', String(open));
    }
    // 抽屉打开时把胶囊藏掉（样式见 mobile.css）：抽屉是不透明全高侧栏，
    // 本来就会盖住它，这里再收一次焦点，键盘 Tab 就不会落进看不见的按钮。
    document.body.classList.toggle('nav-open', open);
    if (open) lockBody(); else unlockBodyIfIdle();
  }

  function initMobileNav() {
    var p = navParts();
    if (!p.drawer) return;

    if (p.btn) {
      p.btn.addEventListener('click', function (e) {
        e.stopPropagation();
        // 互斥：开导航前先收起目录面板
        if (state.toc) setTocOpen(false);
        setNavOpen(!state.nav);
      });
    }

    // 顶部汉堡按钮在移动端已隐藏（空间让给悬浮球），但保留绑定：
    // 平板 / 未来布局回退时仍然可用，成本只是一个事件监听。
    if (p.toggle) {
      p.toggle.addEventListener('click', function (e) {
        e.stopPropagation();
        setNavOpen(!state.nav);
      });
    }

    if (p.overlay) {
      p.overlay.addEventListener('click', function () { setNavOpen(false); });
    }

    // 点击导航链接后关闭抽屉
    p.drawer.querySelectorAll('a').forEach(function (link) {
      link.addEventListener('click', function () { setNavOpen(false); });
    });

    // 移动端子菜单切换
    p.drawer.querySelectorAll('.drawer-sub-toggle').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        e.preventDefault();
        var submenu = this.parentElement.nextElementSibling;
        if (submenu && submenu.classList.contains('drawer-submenu')) {
          submenu.classList.toggle('open');
          this.classList.toggle('open');
        }
      });
    });
  }

  // =============================================
  // 2.7 TOC — 底部面板
  // =============================================
  var tocEls = null;

  function tocParts() {
    if (tocEls) return tocEls;
    tocEls = {
      panel: document.getElementById('tocPanel') || document.querySelector('.toc-panel'),
      overlay: document.querySelector('.toc-panel-overlay'),
      close: document.querySelector('.toc-panel-close'),
      btn: document.getElementById('dockToc')
    };
    return tocEls;
  }

  function setTocOpen(open) {
    var p = tocParts();
    if (!p.panel) return;
    state.toc = open;
    p.panel.classList.toggle('open', open);
    if (p.overlay) p.overlay.classList.toggle('active', open);
    if (p.btn) {
      p.btn.classList.toggle('is-active', open);
      p.btn.setAttribute('aria-expanded', String(open));
    }
    // 面板升起时让出底部空间（样式见 mobile.css），胶囊浮在它上面。
    document.body.classList.toggle('toc-open', open);
    // 面板是 modal：打开时把焦点送进去，关闭时还给触发它的那一格。
    // 不做这一步，键盘用户打开面板后按 Tab 会跑到面板背后的正文里。
    if (open) {
      lockBody();
      if (!p.panel.contains(document.activeElement)) {
        var first = p.close || p.panel.querySelector('.toc-link');
        if (first) first.focus({ preventScroll: true });
      }
    } else {
      unlockBodyIfIdle();
      if (p.btn && p.btn !== document.activeElement && p.panel.contains(document.activeElement)) {
        p.btn.focus({ preventScroll: true });
      }
    }
  }

  /* 给 /js/toc.js 用的关闭回调。目录链接的跳转由它统一处理，
     处理完再回头把面板收起来——两个脚本各管一件事，不互相调用内部函数。 */
  window.__vellumCloseToc = function () { setTocOpen(false); };

  function initMobileToc() {
    var p = tocParts();
    if (!p.panel) return;

    if (p.btn) {
      p.btn.addEventListener('click', function (e) {
        e.stopPropagation();
        // 互斥：开目录前先收起导航抽屉
        if (state.nav) setNavOpen(false);
        setTocOpen(!state.toc);
      });
    }

    if (p.overlay) {
      p.overlay.addEventListener('click', function () { setTocOpen(false); });
    }

    if (p.close) {
      p.close.addEventListener('click', function (e) {
        e.stopPropagation();
        setTocOpen(false);
      });
    }

    /* 面板里的跳转不在这里绑定：定位与平滑滚动统一由 /js/toc.js 处理
       （它给面板的 onNavigate 回调会调下面的 __vellumCloseToc）。
       两处都绑会各自滚一次，而且两边的偏移常量一旦不同步就会互相抢。 */

    p.panel.addEventListener('click', function (e) { e.stopPropagation(); });
  }

  // =============================================
  // 2.8 Dossier — 侧边栏折叠
  // =============================================
  function initDossierSidebar() {
    var sidebarHeader = document.querySelector('.dossier-sidebar-header');
    var sidebarBody = document.querySelector('.dossier-sidebar-body');
    var arrow = document.querySelector('.dossier-sidebar-arrow');

    if (!sidebarHeader || !sidebarBody) return;

    sidebarHeader.addEventListener('click', function () {
      var isOpen = sidebarBody.classList.toggle('open');
      if (arrow) arrow.classList.toggle('open', isOpen);
    });
  }

  // =============================================
  // 2.15 Dossier — 移动端顶部下拉导航
  // =============================================
  function initDossierMobileNav() {
    var navCurrent = document.querySelector('.dossier-mobile-nav-current');
    var navList = document.querySelector('.dossier-mobile-nav-list');
    var arrow = document.querySelector('.dossier-mobile-nav-arrow');

    if (!navCurrent || !navList) return;

    // 点击头部展开/收起
    navCurrent.addEventListener('click', function (e) {
      e.stopPropagation();
      var isOpen = navList.classList.toggle('open');
      if (arrow) arrow.classList.toggle('open', isOpen);
    });

    // 点击列表项后关闭
    navList.querySelectorAll('.dossier-mobile-nav-item').forEach(function (item) {
      item.addEventListener('click', function () {
        navList.classList.remove('open');
        if (arrow) arrow.classList.remove('open');
      });
    });

    // 点击页面其他区域关闭
    document.addEventListener('click', function (e) {
      if (!e.target.closest('.dossier-mobile-nav')) {
        navList.classList.remove('open');
        if (arrow) arrow.classList.remove('open');
      }
    });
  }

  // =============================================
  // 全局：ESC 关闭、点页面空白处关闭
  // =============================================
  function initDismissers() {
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (state.nav) setNavOpen(false);
      if (state.toc) setTocOpen(false);
    });
  }

  // =============================================
  // 初始化
  // =============================================
  function init() {
    initMobileNav();
    initMobileToc();
    initDossierSidebar();
    initDossierMobileNav();
    initDismissers();

    // 监听视口变化：从移动端切到 PC 端时清理可能残留的浮层状态
    var mql = window.matchMedia('(min-width: 768px)');
    mql.addEventListener('change', function (e) {
      if (!e.matches) return;
      setNavOpen(false);
      setTocOpen(false);
      document.body.style.overflow = '';
    });
  }

  // DOM 就绪后执行
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
