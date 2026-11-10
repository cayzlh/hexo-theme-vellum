/**
 * Vellum — 目录（TOC）交互
 * ===========================================================================
 * 一套代码服务三处目录：
 *   .toc                文章页 / 页面页的桌面侧栏（≥1024px 可见）
 *   #dossier-toc        档案页的右侧栏（≥768px 可见）
 *   #tocPanel           窄屏底部面板（两个页面类型共用）
 *
 * 为什么从模板里搬出来
 * --------------------
 * 原来这段逻辑有两份内联 <script>：toc.ejs 一份、dossier_page.ejs 一份，
 * 除了选择器和变量前缀几乎逐字相同。两份已经漂移出真实差异——档案页那份
 * 把「禁用折叠时要显示全部层级」的分支包在了 highlight_on_scroll 里，
 * 于是 highlight_on_scroll:false + auto_collapse:true 时所有 h3 永久消失。
 * 搬到外部文件后：一份实现、可缓存、两边的行为不可能再分叉。
 *
 * 折叠策略（配合 style.css 里的 .toc-collapsible）
 * -----------------------------------------------
 * 默认**全展开**，脚本跑起来才加 .toc-collapsible 开始折叠。JS 挂了最坏
 * 情况是目录变长，而不是变空——这是刻意的降级方向。
 *
 * 高亮策略
 * --------
 * 只监听 scroll + rAF，用「二分找最后一个顶边越过基准线的标题」定位当前
 * 章节。以前的实现每次滚动都遍历全部标题算 Math.abs 距离（114 条的页面上
 * 一次滚轮读 114 次布局），还叠了一个 11 阈值的 IntersectionObserver 调
 * 同一个函数，纯属重复开销。
 */
(function () {
  'use strict';

  /** 标题顶边越过视口顶部多少像素算「当前章节」。 */
  var HEAD_OFFSET = 80;

  /* =========================================================================
     1. 通用：把一个容器的目录接上（高亮 + 折叠 + 平滑跳转）
     ========================================================================= */

  /**
   * @param {Element} root 目录根节点（.toc / #dossier-toc / #tocPanel）
   * @param {Object} opts
   *   opts.collapse  是否启用自动折叠
   *   opts.highlight 是否启用滚动高亮
   *   opts.onNavigate 点击链接后的回调（移动面板用来关闭自己）
   */
  function initToc(root, opts) {
    opts = opts || {};
    var links = root.querySelectorAll('.toc-link');
    if (!links.length) return;

    // ---- 建立「链接 ↔ 标题元素」映射，并缓存标题的文档坐标 ----
    var entries = [];
    for (var i = 0; i < links.length; i++) {
      var id = links[i].getAttribute('data-toc');
      if (!id) continue;
      var el = document.getElementById(id);
      if (!el) continue;
      entries.push({ link: links[i], el: el, top: 0 });
    }
    if (!entries.length) return;

    /* 文档坐标只在「布局可能变化时」重算（resize / 字体加载 / 开场），
       滚动过程中只读缓存值 + pageYOffset，避免每次滚动都触发重排。
       图片没设高度时加载完会把下面的内容整体推下去，所以要补一个重算时机。 */
    function measure() {
      var offset = window.pageYOffset;
      for (var k = 0; k < entries.length; k++) {
        entries[k].top = entries[k].el.getBoundingClientRect().top + offset;
      }
    }

    // ---- 折叠 ----
    var collapsible = false;
    var items = root.querySelectorAll('.toc-item');

    function setExpanded(li, on) {
      if (!li) return;
      li.classList.toggle('expanded', on);
    }

    /** 只展开当前章节，其余收起（auto_collapse 的默认行为）。 */
    function collapseTo(li) {
      if (!collapsible) return;
      for (var k = 0; k < items.length; k++) setExpanded(items[k], false);
      /* 沿父链一路展开：h3 的祖先 h2 也要展开，否则 h3 还是被藏着。 */
      var node = li;
      while (node && node !== root) {
        if (node.classList && node.classList.contains('toc-item')) {
          setExpanded(node, true);
        }
        node = node.parentElement;
      }
    }

    function setupCollapse() {
      if (!opts.collapse) return false;
      /* 没有可折叠的深层级就别进入折叠模式：只有一个层级的目录套上
         .toc-collapsible 也不会有任何视觉变化，反而多一层状态。 */
      if (!root.querySelector('.toc-level-3, .toc-level-4, .toc-level-5, .toc-level-6')) {
        return false;
      }
      root.classList.add('toc-collapsible');
      return true;
    }

    collapsible = setupCollapse();

    // ---- 当前章节定位 ----
    var activeLink = null;

    /* 二分：找最后一个 top <= 基准线的标题。
       基准线 = 视口顶 + HEAD_OFFSET，换算成文档坐标。 */
    function findActive() {
      var line = window.pageYOffset + HEAD_OFFSET;
      var lo = 0;
      var hi = entries.length - 1;
      var found = -1;
      while (lo <= hi) {
        var mid = (lo + hi) >> 1;
        if (entries[mid].top <= line) {
          found = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      // 还没滚过第一个标题时，高亮第一个（总比什么都不亮强）
      return found < 0 ? 0 : found;
    }

    function update() {
      var idx = findActive();
      var entry = entries[idx];
      if (!entry) return;
      if (entry.link === activeLink) return;

      if (activeLink) activeLink.classList.remove('active');
      entry.link.classList.add('active');
      activeLink = entry.link;

      if (collapsible) {
        /* 展开当前条目的**父章节**：h3 被高亮时展开它所在的 h2，
           而不是把 h3 自己的子级摊开——这里要的是「当前在读哪一节」。 */
        var anchor = entry.link.closest('.toc-item');
        var parent = anchor ? anchor.parentElement.closest('.toc-item') : null;
        collapseTo(parent || anchor);
      }

      /* 只在目录自己的滚动容器里滚，不用 scrollIntoView ——
         后者会连同页面一起滚，长文档上会把读者从当前位置拽走。 */
      var box = root.classList.contains('toc-fixed') ? root : root.querySelector('.toc-fixed') || root;
      var linkBox = entry.link.getBoundingClientRect();
      var boxRect = box.getBoundingClientRect();
      if (linkBox.top < boxRect.top || linkBox.bottom > boxRect.bottom) {
        box.scrollTop = entry.link.offsetTop - boxRect.height / 2;
      }
    }

    // ---- 平滑跳转（统一处理，面板点击后要关自己） ----
    for (var n = 0; n < links.length; n++) {
      links[n].addEventListener('click', function (e) {
        var id = this.getAttribute('data-toc');
        var target = id && document.getElementById(id);
        if (!target) return; // 让浏览器走原生锚点
        e.preventDefault();
        var top = target.getBoundingClientRect().top + window.pageYOffset - HEAD_OFFSET;
        window.scrollTo({ top: top, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
        // 地址栏同步 hash：刷新 / 复制链接后还能回到这一节
        if (history.replaceState) history.replaceState(null, '', '#' + id);
        if (opts.onNavigate) opts.onNavigate();
      });
    }

    // ---- 初始化 ----
    measure();
    if (collapsible) {
      /* 初始只展开「当前阅读位置所在章节」。滚到页面中部刷新时，
         读者看到的是自己所在那节，而不是从头开始的第一节。 */
      var startEntry = entries[findActive()];
      if (startEntry) {
        var startAnchor = startEntry.link.closest('.toc-item');
        collapseTo(startAnchor && startAnchor.parentElement.closest('.toc-item') || startAnchor);
      }
    }
    update();

    if (opts.highlight !== false) {
      var ticking = false;
      window.addEventListener('scroll', function () {
        if (ticking) return;
        ticking = true;
        window.requestAnimationFrame(function () {
          update();
          ticking = false;
        });
      }, { passive: true });
    }

    // 布局变化 → 坐标失效。节流后重算一次，顺手重定位高亮。
    var relayoutTimer = null;
    function scheduleRemeasure() {
      clearTimeout(relayoutTimer);
      relayoutTimer = setTimeout(function () {
        measure();
        activeLink = null; // 强制下一帧重新判定
        update();
      }, 120);
    }
    window.addEventListener('resize', scheduleRemeasure);

    /* 正文图片加载完会把内容整体下推。给还没 load 的图挂一次性监听，
       避免用 MutationObserver 大炮打蚊子。 */
    var body = document.querySelector('.post-body, .dossier-content');
    if (body) {
      var imgs = body.querySelectorAll('img');
      for (var q = 0; q < imgs.length; q++) {
        if (!imgs[q].complete) imgs[q].addEventListener('load', scheduleRemeasure, { once: true });
      }
    }

    /* 字体加载会改变标题高度。document.fonts 在老浏览器上没有，
       有就用——它是这类位移最靠谱的信号来源。 */
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(scheduleRemeasure);
    }

    return { update: update, remeasure: measure };
  }

  function prefersReducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  /* =========================================================================
     2. 挂载
     ========================================================================= */
  function boot() {
    // 桌面侧栏（文章 / 页面）
    var sidebar = document.querySelector('.toc');
    if (sidebar) {
      initToc(sidebar, {
        collapse: sidebar.getAttribute('data-toc-collapse') !== 'false',
        highlight: sidebar.getAttribute('data-toc-highlight') !== 'false'
      });

      // 回到顶部
      var backTop = sidebar.querySelector('.toc-back-top');
      if (backTop) {
        backTop.addEventListener('click', function () {
          window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
        });
      }
    }

    // 档案页侧栏
    var dossier = document.getElementById('dossier-toc');
    if (dossier) {
      initToc(dossier, { collapse: true, highlight: true });
      var dBackTop = dossier.querySelector('.toc-back-top');
      if (dBackTop) {
        dBackTop.addEventListener('click', function () {
          window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
        });
      }
    }

    // 窄屏底部面板：它自己的开合由 mobile.js 管，这里只要目录行为。
    /* ★ 面板**不做折叠**：它存在的意义就是「我想一次看清整篇结构」。
       传 collapse:false 后 initToc 不会加 .toc-collapsible，而新 CSS 的
       默认态就是全展开 —— 于是 h3 自然可见，不需要额外展开一轮。
       （以前的实现里面板根本没有折叠逻辑，h3 被全局 display:none 永久藏掉，
       53% 的条目看不见、16 个页面整块空白。） */
    var panel = document.getElementById('tocPanel');
    if (panel) {
      initToc(panel, {
        collapse: false,
        highlight: false,
        onNavigate: function () {
          if (window.__vellumCloseToc) window.__vellumCloseToc();
        }
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // 供 mobile.js 复用（同一份定位逻辑，别在那边再写一遍）
  window.__vellumToc = { initToc: initToc };
})();
