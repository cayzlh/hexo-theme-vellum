/**
 * Vellum — 归档页右侧刻度尺
 * ===========================================================================
 * 把 .archive-marker（每组的第一条）换算成百分比位置，画成右侧的一条刻度尺。
 * 默认极淡，滚动到某组时该组刻度变清晰，悬停也变清晰。
 *
 * 相对旧版的改动：
 *   1. 刻度可点击了。以前 cursor:default、没有任何点击处理——它看起来
 *      像导航，实际只是装饰。现在点一下滚到对应月份分组。
 *   2. 当前组定位不再用 IntersectionObserver。旧实现取「entries 里第一个
 *      isIntersecting 的」，但 entries 的顺序不保证是文档顺序，多组同时进
 *      入视口时会选错；向上滚出所有区间时高亮也不再更新。改成和文章目录
 *      同一套「最后一个越线元素」的算法，语义确定。
 */
(function () {
  'use strict';

  var ruler = document.querySelector('.timeline-ruler');
  var body = document.querySelector('.archive-timeline-body');
  var itemsContainer = body ? body.querySelector('.archive-items') : null;
  if (!ruler || !itemsContainer) return;

  /* 分组标题由模板渲染（.archive-marker），不再是靠 data-date 去重算。
     这样「分组」的唯一事实来源是模板，JS 只负责画刻度。 */
  var groups = [];
  var markers = itemsContainer.querySelectorAll('.archive-marker');
  for (var i = 0; i < markers.length; i++) {
    groups.push({
      el: markers[i],
      date: markers[i].getAttribute('data-date') || '',
      label: (markers[i].textContent || '').trim(),
      tickEl: null
    });
  }
  if (!groups.length) return;

  /* =========================================================================
     1. 画刻度
     ========================================================================= */
  var GEO = []; // 缓存每个刻度的文档纵坐标，滚动时只做比较
  var activeEl = null; // 当前高亮的刻度，positionTicks 里会清空它

  /* 当前有没有任何可见条目。
     ★ 不能用 itemsContainer.offsetHeight 判断：ruler 自己有写死的 height，
     会把 flex 行高撑开，.archive-items 吃 stretch 被一起拉高，
     offsetHeight 于是永远不为 0（实测筛到 0 条时仍是 4833）——用高度做守卫
     会形成自持死锁。直接看条目本身的可见性才是唯一可靠的信号。
     （CSS 那边也给 .archive-items 加了 align-self: flex-start 解耦，
       两道保险：任一处失效另一处仍能兜住。） */
  function isHidden(el) {
    /* 只看 computed display，不用 offsetParent / getClientRects：
       offsetParent 在 position:fixed 或 sticky 祖先下会是 null，
       而 getClientRects 在未布局时（首帧、jsdom）也是空的 —— 两个都会
       把「其实可见」的条目误判成隐藏。search.js 过滤用的正是 style.display，
       这里读同一个信号，两边语义严格对齐。 */
    return window.getComputedStyle(el).display === 'none';
  }

  function hasVisibleItems() {
    var nodes = itemsContainer.children;
    for (var i = 0; i < nodes.length; i++) {
      if (!isHidden(nodes[i])) return true;
    }
    return false;
  }

  function positionTicks() {
    var containerTop = itemsContainer.getBoundingClientRect().top + window.pageYOffset;
    var containerHeight = itemsContainer.offsetHeight;

    /* 一条可见的都没有 → 清掉 ruler 的写死高度，让它回到 CSS 的自动高度。
       否则它会继续撑着 .archive-timeline-body，把下方的空态推到屏幕之外
       （本站实测空态被顶到 4833px 处，读者首屏只看到一片空白）。 */
    if (!hasVisibleItems()) {
      ruler.style.height = '';
      GEO = [];
      /* 刻度全部藏掉：此时没有可跳转的目标，留着还会盖住空态。 */
      for (var t = 0; t < groups.length; t++) {
        if (groups[t].tickEl) groups[t].tickEl.style.display = 'none';
      }
      return;
    }

    /* 恢复显示（筛选条件变松后要能重新出现） */
    for (var v = 0; v < groups.length; v++) {
      if (groups[v].tickEl) groups[v].tickEl.style.display = '';
    }

    if (!containerHeight) {
      ruler.style.height = '';
      return;
    }

    ruler.style.height = containerHeight + 'px';
    GEO = [];

    for (var g = 0; g < groups.length; g++) {
      var group = groups[g];

      /* 分组标题被筛掉（display:none）时它的 getBoundingClientRect 是全 0，
         算出来的 percent 会是很大的负数，刻度就跑到 ruler 外面去了。
         这类分组直接跳过：它下面没有任何可见条目，刻度也没有意义。 */
      if (isHidden(group.el)) {
        if (group.tickEl) group.tickEl.style.display = 'none';
        continue;
      }

      var elTop = group.el.getBoundingClientRect().top + window.pageYOffset;
      var offsetInContainer = elTop - containerTop;
      var percent = (offsetInContainer / containerHeight) * 100;

      /* 夹到 0~100：内容高度变化时 offsetInContainer 可能略超出边界，
         不夹的话刻度会浮到尺子之外。 */
      if (percent < 0) percent = 0;
      if (percent > 100) percent = 100;

      var tick = group.tickEl;
      if (!tick) {
        tick = document.createElement('button');
        tick.type = 'button';
        tick.className = 'ruler-tick';
        tick.setAttribute('data-date', group.date);
        tick.setAttribute('data-label', group.label);
        tick.setAttribute('aria-label', group.label);
        /* 可点击：滚到该分组。这里用 button 而不是 div，
           键盘 Tab 也能到、回车也能触发，不需要额外补 role 和 tabindex。 */
        tick.addEventListener('click', (function (target) {
          return function () {
            var top = target.getBoundingClientRect().top + window.pageYOffset - 80;
            window.scrollTo({
              top: top,
              behavior: prefersReducedMotion() ? 'auto' : 'smooth'
            });
            if (history.replaceState) {
              history.replaceState(null, '', '#' + target.id);
            }
          };
        })(group.el));
        ruler.appendChild(tick);
        group.tickEl = tick;
      }
      tick.style.top = percent + '%';
      tick.style.display = '';
      GEO.push({ tick: tick, top: elTop });
    }

    /* GEO 必须按文档顺序排列才能做「最后一个越线」的判定。
       visible 的分组本来就按顺序遍历，但跳过隐藏项后要再排一次，
       防止筛选反复切换时残留顺序错乱。 */
    GEO.sort(function (a, b) { return a.top - b.top; });

    /* 没有可见刻度时把 active 清掉，否则滚动到空页时还会指着一个已隐藏的标记 */
    if (!GEO.length) activeEl = null;
  }

  function prefersReducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  /* =========================================================================
     2. 滚动时高亮当前分组
     ========================================================================= */
  function findActiveIndex() {
    var line = window.pageYOffset + 100;
    var found = 0;
    for (var i = 0; i < GEO.length; i++) {
      if (GEO[i].top <= line) found = i;
      else break;
    }
    return found;
  }

  function updateActive() {
    if (!GEO.length) return;
    var idx = findActiveIndex();
    var target = GEO[idx] ? GEO[idx].tick : null;
    if (target === activeEl) return;
    for (var i = 0; i < GEO.length; i++) GEO[i].tick.classList.toggle('active', GEO[i].tick === target);
    activeEl = target;
  }

  /* =========================================================================
     3. 启动
     ========================================================================= */
  positionTicks();
  updateActive();

  var ticking = false;
  window.addEventListener('scroll', function () {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(function () {
      updateActive();
      ticking = false;
    });
  }, { passive: true });

  /* 布局变化要重算位置：窗口宽度、字体、图片加载都会改变分组纵坐标。 */
  var resizeTimer = null;
  function scheduleReposition() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      positionTicks();
      activeEl = null;
      updateActive();
    }, 150);
  }
  window.addEventListener('resize', scheduleReposition);

  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(scheduleReposition);
  }

  var imgs = document.querySelectorAll('.archive-items img');
  for (var k = 0; k < imgs.length; k++) {
    if (!imgs[k].complete) imgs[k].addEventListener('load', scheduleReposition, { once: true });
  }

  /* 给 search.js 用：归档页筛选之后条目的可见性变了，刻度必须跟着重算。
     不暴露一个公共 API 让两个脚本互相 import —— 它们各自是独立文件，
     靠 window 上的一个具名钩子通信，和 mobile.js 的 __vellumCloseToc 同一种做法。 */
  window.__vellumRulerReposition = scheduleReposition;
})();
