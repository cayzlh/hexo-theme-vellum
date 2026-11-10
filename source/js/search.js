/**
 * Vellum — 归档页实时过滤
 * ===========================================================================
 * 支持两种容器（两种都存在，按页面上实际有什么来定）：
 *   .archive-item  连续时间线（本主题的 /archives/ 及其年/月页）
 *   .archive-list li  旧式列表（分类页、标签页）
 *
 * 匹配范围只有 标题 + 标签 + 分类。
 * ---------------------------------------------------------------------------
 * 以前每个条目还塞了一个 data-content（正文前 200 字），全站归档页为此多背
 * 51 KB 标记，而收益很小：200 字的片段极易误命中（搜「配置」几乎命中每一篇），
 * 而且它让「搜索」看起来能查正文、实际上查的只是一小截开头。
 * 正文检索交给独立的 /search/ 页（构建期生成全文索引），这里只管归档页的
 * 快速筛标题。
 *
 * 多关键词：空格分隔，全部命中才算（AND）。
 * 以前是整串 indexOf，搜「spring boot」匹配不到「SpringBoot」，搜
 * 「docker 镜像」也匹配不到任何东西——两个词都被当成一个连续的字符串。
 */
(function () {
  'use strict';

  var input = document.querySelector('.archive-search-input');
  if (!input) return;

  /* =========================================================================
     下划线波浪：聚焦态
     =========================================================================
     直线与波浪是同一个 <svg> 里的两条图元，靠 CSS 透明度切换。
     用 JS 切 class 而不是 CSS 的 :focus-within —— 因为 src/style.css 里
     .archive-search 下还有 <input> 的兄弟选择器可用，但 SVG 的 <line>/<path>
     是 svg 的子节点，外层选择器跨不进 SVG 内部（:has() 同样匹配不到），
     加密口令框（scripts/vault.js + vault/vault.css）也是同一个原因走 JS。

     ★ 这段必须放在下面 `if (!items.length) return` 之前：输入框的视觉反馈
     与「本页有没有条目可筛」无关，分页到空页时动效也得在。 */
  var searchBox = input.closest('.archive-search');

  if (searchBox) {
    input.addEventListener('focus', function () { searchBox.classList.add('is-focused'); });
    input.addEventListener('blur', function () { searchBox.classList.remove('is-focused'); });
  }

  var timeline = document.querySelector('.archive-timeline');
  var list = document.querySelector('.archive-list');
  var countEl = document.querySelector('.archive-search-count');
  var emptyEl = document.querySelector('.archive-empty');

  var isTimeline = !!timeline;
  var items = isTimeline
    ? timeline.querySelectorAll('.archive-item')
    : (list ? list.querySelectorAll('li') : []);
  if (!items.length) return;

  var debounceDelay = parseInt(input.getAttribute('data-debounce'), 10) || 200;
  var highlightEnabled = input.getAttribute('data-highlight') !== 'false';
  var totalCount = items.length;

  /* =========================================================================
     工具
     ========================================================================= */

  function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /* 归一化：小写 + 把常见全角标点折成半角 + 去掉分隔符。
     中文读者输入「，"、顿号、斜杠都是常态，不归一化就等于不匹配。 */
  function normalize(str) {
    return String(str || '')
      .toLowerCase()
      .replace(/[\u3000\s]+/g, ' ')
      .replace(/[，、；：（）【】「」《》]/g, ' ')
      .trim();
  }

  /** 把查询拆成关键词组。每个词内部再拆「连续串」和「中文二元组」两种形态。 */
  function parseQuery(raw) {
    var q = normalize(raw);
    if (!q) return [];
    return q.split(' ').filter(Boolean);
  }

  /**
   * 单个关键词是否命中文本。
   * 纯 ASCII 词直接子串匹配（web 开发 里的 docker）；
   * 含中文时同时试「整词子串」，因为中文没有词边界，二元组反而会漏。
   */
  function keywordHit(haystack, kw) {
    return haystack.indexOf(kw) !== -1;
  }

  function highlightText(el, keywords) {
    if (!el) return;
    if (!el.hasAttribute('data-original')) {
      el.setAttribute('data-original', el.textContent);
    }
    var original = el.getAttribute('data-original');
    if (!keywords.length) {
      el.textContent = original;
      return;
    }
    /* 一次替换全部关键词：先把原文按所有关键词切分，再包 span。
       逐个关键词 replace 会让后一个词匹配到前一个词插入的标签里。 */
    var pattern = keywords
      .filter(function (k) { return k && k.length; })
      .sort(function (a, b) { return b.length - a.length; })
      .map(escapeRegExp)
      .join('|');
    if (!pattern) { el.textContent = original; return; }
    var regex = new RegExp('(' + pattern + ')', 'gi');
    /* 原文来自 textContent，不含标签，可以直接拼 innerHTML */
    el.innerHTML = original.replace(regex, '<span class="search-highlight">$1</span>');
  }

  function clearHighlights() {
    var scope = isTimeline ? timeline : list;
    if (!scope) return;
    var titles = scope.querySelectorAll('.archive-title');
    for (var i = 0; i < titles.length; i++) {
      var t = titles[i];
      if (t.hasAttribute('data-original')) t.textContent = t.getAttribute('data-original');
    }
  }

  /** 分组标题（.archive-marker）在它下面一条都不剩时隐藏掉。 */
  function updateMarkers() {
    if (!isTimeline) return;
    var markers = timeline.querySelectorAll('.archive-marker');
    for (var m = 0; m < markers.length; m++) {
      var marker = markers[m];
      var node = marker.nextElementSibling;
      var hasVisible = false;
      while (node && !node.classList.contains('archive-marker')) {
        if (node.classList.contains('archive-item') && node.style.display !== 'none') {
          hasVisible = true;
          break;
        }
        node = node.nextElementSibling;
      }
      marker.style.display = hasVisible ? '' : 'none';
    }
  }

  /* =========================================================================
     主流程
     ========================================================================= */

  function performSearch(rawQuery) {
    var keywords = parseQuery(rawQuery);
    var matchCount = 0;

    clearHighlights();

    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var haystack = normalize(
        (item.getAttribute('data-title') || '') + ' ' +
        (item.getAttribute('data-tags') || '') + ' ' +
        (item.getAttribute('data-categories') || '')
      );

      /* AND：所有关键词都要命中 */
      var hit = true;
      for (var k = 0; k < keywords.length; k++) {
        if (!keywordHit(haystack, keywords[k])) { hit = false; break; }
      }

      if (hit) {
        item.style.display = '';
        matchCount++;
        if (highlightEnabled && keywords.length) {
          var titleEl = item.querySelector('.archive-title');
          var title = normalize(item.getAttribute('data-title') || '');
          /* 只有标题真的命中了才高亮，否则把标题拆碎没有意义 */
          var titleHit = keywords.some(function (kw) { return keywordHit(title, kw); });
          if (titleEl && titleHit) highlightText(titleEl, keywords);
        }
      } else {
        item.style.display = 'none';
      }
    }

    updateMarkers();

    if (countEl) {
      countEl.textContent = keywords.length
        ? window.tr('archive.count_found', matchCount)
        : window.tr('archive.count_all', totalCount);
    }

    if (emptyEl) {
      emptyEl.style.display = (matchCount === 0 && keywords.length) ? 'block' : 'none';
    }
  }

  function debounce(fn, delay) {
    var timer = null;
    return function () {
      var ctx = this;
      var args = arguments;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(ctx, args); }, delay);
    };
  }

  var run = debounce(function () { performSearch(input.value); }, debounceDelay);
  input.addEventListener('input', run);

  /* Esc 清空并复位：过滤后想回到全量视图，逐个删字符很烦。 */
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && input.value) {
      e.preventDefault();
      input.value = '';
      performSearch('');
      return;
    }
    /* 回车：升级到全站正文检索。
       ------------------------------------------------------------------
       这个框平时是「筛本页标题」的快捷方式，但它筛的范围只有当前归档页的
       十几到几十条。读者搜一个词却没能找到时，下一步该去全站正文里找——
       以前那是一个单独的「搜正文 →」链接，要读者自己意识到才点。
       现在按回车就走，和浏览器的地址栏、各种站内搜索的心智一致。

       不拦截空查询：没输入内容时回车什么也不该发生，而不是跳到一个
       空的搜索页。 */
    if (e.key === 'Enter') {
      var q = input.value.trim();
      if (!q) { e.preventDefault(); return; }
      /* form 的 action 是 /search/、input 的 name 是 q —— 原生提交就够了，
         浏览器会拼成 /search/?q=…。这里只在 search 关掉时阻止（没有落地页）。 */
      var form = input.form || searchBox;
      var fulltextOn = form && form.getAttribute('data-fulltext') !== 'false';
      if (!fulltextOn) e.preventDefault();
    }
  });

  performSearch('');
})();
