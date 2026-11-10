/**
 * Vellum — 归档页右侧刻度尺
 * ===========================================================================
 * 把 .archive-marker（每组的第一条）换算成百分比位置，画成右侧的一条刻度尺。
 * 默认极淡，滚动到某组时该组刻度变清晰，悬停也变清晰。
 *
 * 相对旧版的改动：
 *   1. 刻度**可点击**了。以前 cursor:default、没有任何点击处理——它看起来
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

  function positionTicks() {
    var containerTop = itemsContainer.getBoundingClientRect().top + window.pageYOffset;
    var containerHeight = itemsContainer.offsetHeight;
    if (!containerHeight) return;

    ruler.style.height = containerHeight + 'px';
    GEO = [];

    for (var g = 0; g < groups.length; g++) {
      var group = groups[g];
      var elTop = group.el.getBoundingClientRect().top + window.pageYOffset;
      var offsetInContainer = elTop - containerTop;
      var percent = (offsetInContainer / containerHeight) * 100;

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
      GEO.push({ tick: tick, top: elTop });
    }
  }

  function prefersReducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  /* =========================================================================
     2. 滚动时高亮当前分组
     ========================================================================= */
  var activeEl = null;

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
})();
