/**
 * Vellum — 一行笔记页（/snippets/）
 * ===========================================================================
 * 两件事：即时过滤、一键复制。都是纯前端、无网络请求。
 *
 * 过滤为什么用 DOM 遍历而不是建索引
 * ---------------------------------
 * 条数在几十量级（这是「一行就够」的笔记，不是文章），每次输入扫一遍全部
 * 卡片、读它们已经预渲染好的 data-key 做 indexOf，是毫秒级的事。为一个
 * 几百 KB 都用不上的页面预先建倒排表，是拿复杂度换不存在的问题。
 *
 * 检索文本 `data-key` 由服务端在渲染时拼好（标题 + 说明 + 命令 + 标签 +
 * 分类，已转小写），前端只做子串匹配——「搜什么能中」的口径因此在服务端
 * 只定义一次，前后端不会各算一套。
 *
 * 分组标题的空壳清理
 * ------------------
 * 过滤后某个分类下一条都不剩时，那个 <h2> 连同整个 <section> 都要藏起来，
 * 否则页面上会留下一排孤零零的分类名，看着像过滤坏了。
 */
(function () {
  'use strict';

  var input = document.getElementById('snippetsFilterInput');
  var statusEl = document.getElementById('snippetsStatus');
  var clearBtn = document.getElementById('snippetsFilterClear');

  /* =========================================================================
     过滤
     ========================================================================= */

  /** 与归档页 / 搜索页同一套归一化：小写 + 全角标点折半角。 */
  function normalize(str) {
    return String(str || '')
      .toLowerCase()
      .replace(/[\u3000]/g, ' ')
      .replace(/[，、；：（）【】「」《》]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function parseQuery(raw) {
    var q = normalize(raw);
    if (!q) return [];
    return q.split(' ').filter(function (w) { return w.length > 0; });
  }

  function applyFilter(rawQuery) {
    var keywords = parseQuery(rawQuery);
    var cards = document.querySelectorAll('.snippet-card');
    var groups = document.querySelectorAll('.snippets-group');
    var visible = 0;

    Array.prototype.forEach.call(cards, function (card) {
      var key = card.getAttribute('data-key') || '';
      var hit = keywords.every(function (kw) { return key.indexOf(kw) !== -1; });
      card.hidden = !hit;
      if (hit) visible += 1;
    });

    /* 分类标题：组内一张卡都不剩就整组隐藏。
       注意读的是 card.hidden 而不是自己再算一遍匹配——两处各算一次，
       将来改了匹配规则必然漏改一处。 */
    Array.prototype.forEach.call(groups, function (group) {
      var any = group.querySelector('.snippet-card:not([hidden])');
      group.hidden = !any;
    });

    if (clearBtn) clearBtn.hidden = !rawQuery.trim();

    if (statusEl) {
      if (!keywords.length) {
        statusEl.textContent = '';
      } else if (visible === 0) {
        statusEl.textContent = window.tr('snippets.no_match');
      } else {
        statusEl.textContent = window.tr('snippets.match_count', visible);
      }
    }
  }

  if (input) {
    var timer = null;

    input.addEventListener('input', function () {
      clearTimeout(timer);
      var v = input.value;
      /* 与归档页相同的 120ms 防抖：纯 DOM 操作很快，但每敲一个键就重排
         一次布局仍会让低端机上的输入有轻微顿挫。 */
      timer = setTimeout(function () { applyFilter(v); }, 120);
    });

    /* 回车立刻执行，不等防抖 —— 用户明确表达了「就搜这个」。 */
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        clearTimeout(timer);
        applyFilter(input.value);
      }
      /* Esc 清空：search 输入框在部分浏览器上自带这个行为，但不统一，
         这里显式做一遍。 */
      if (e.key === 'Escape') {
        input.value = '';
        clearTimeout(timer);
        applyFilter('');
      }
    });

    if (clearBtn) {
      clearBtn.addEventListener('click', function () {
        input.value = '';
        input.focus();
        applyFilter('');
      });
    }
  }

  /* =========================================================================
     复制
     ========================================================================= */

  /* 单例 live region：读屏器播报「已复制」。文案变、视觉不变——
     复制按钮的宽度在点击前后必须一致，否则那一行会抖。 */
  var liveRegion = (function () {
    var el = document.getElementById('snippets-copy-live');
    if (!el) {
      el = document.createElement('span');
      el.id = 'snippets-copy-live';
      el.className = 'sr-only';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      document.body.appendChild(el);
    }
    return el;
  })();

  document.querySelectorAll('.snippet-card__copy').forEach(function (btn) {
    var resetTimer = null;

    function setState(state) {
      btn.classList.toggle('copied', state === 'copied');
      btn.classList.toggle('failed', state === 'failed');
      if (state === 'copied') liveRegion.textContent = window.tr('snippets.copied');
      else if (state === 'failed') liveRegion.textContent = window.tr('common.copy_failed');
      if (resetTimer) clearTimeout(resetTimer);
      resetTimer = setTimeout(function () {
        btn.classList.remove('copied');
        btn.classList.remove('failed');
        liveRegion.textContent = '';
        resetTimer = null;
      }, 2000);
    }

    btn.addEventListener('click', function () {
      var text = btn.getAttribute('data-copy') || '';

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () {
          setState('copied');
        }).catch(function () {
          legacyCopy(text);
        });
        return;
      }
      legacyCopy(text);

      /* 老浏览器 / 非安全上下文（http）没有 Clipboard API，退回 execCommand。 */
      function legacyCopy(t) {
        var ta = document.createElement('textarea');
        ta.value = t;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
        document.body.appendChild(ta);
        ta.select();
        var ok = false;
        try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
        document.body.removeChild(ta);
        setState(ok ? 'copied' : 'failed');
      }
    });
  });
})();
