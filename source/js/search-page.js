/**
 * Vellum — 全站搜索页（/search/）
 * ===========================================================================
 * 索引由构建期生成（scripts/search-index.js），这里是纯前端检索。
 *
 * 排序模型
 * --------
 * 每条结果算一个分数，按分数降序：
 *   标题命中        100（每个词 100，命中越多分越高）
 *   标题开头命中    额外 +50（「搜索」开头的文章比中间提到一次更相关）
 *   标签/分类命中   40
 *   正文命中       10（只算一次，不按出现次数加权——正文里刷 100 次同一个词
 *                   的文章并不比提到 1 次的相关）
 *   全部关键词命中  额外 ×1.5（AND 的强信号）
 *
 * 为什么不做 TF-IDF：180 篇的语料上 IDF 权重差异极小，而它需要额外存
 * 词频表（体积翻倍）。这个五档加权已经能把「标题精确命中」稳定顶到第一。
 *
 * URL 参数
 * --------
 * ?q=关键词   分享 / 刷新可复现；输入时用 replaceState 同步（不刷历史栈，
 *             否则每敲一个字就多一条后退记录）。
 */
(function () {
  'use strict';

  var input = document.getElementById('searchPageInput');
  var resultsEl = document.getElementById('searchResults');
  var statusEl = document.getElementById('searchStatus');
  var emptyEl = document.getElementById('searchEmpty');
  var clearBtn = document.getElementById('searchPageClear');

  if (!input || !resultsEl) return;

  var INDEX_URL = '/search.json';
  var docs = null;      // [[title, url, tags, date, text], ...]
  var loading = null;   // Promise，避免重复请求
  var MAX_RESULTS = 50;

  /* =========================================================================
     索引加载
     ========================================================================= */

  function fetchJson(url) {
    return fetch(url, { credentials: 'same-origin' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function loadIndex() {
    if (docs) return Promise.resolve(docs);
    if (loading) return loading;

    loading = fetchJson(INDEX_URL).then(function (head) {
      /* 两种形态：单文件直接带 docs，分片带 files 清单。
         分片是为了文章数上去之后首屏不必等一整个大文件。 */
      if (head.docs) {
        docs = head.docs;
        return docs;
      }
      if (!head.files || !head.files.length) {
        docs = [];
        return docs;
      }
      return Promise.all(head.files.map(function (f) {
        return fetchJson('/' + f.replace(/^\//, ''));
      })).then(function (parts) {
        docs = parts.reduce(function (acc, part) {
          return acc.concat(part);
        }, []);
        return docs;
      });
    }).catch(function (err) {
      loading = null;
      throw err;
    });

    return loading;
  }

  /* =========================================================================
     查询解析
     ========================================================================= */

  /** 小写 + 全角标点折半角。与归档页的 normalize 保持同一套规则。 */
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

  /* =========================================================================
     打分
     ========================================================================= */

  function scoreDoc(doc, keywords) {
    var title = normalize(doc[0]);
    var tags = normalize(doc[2]);
    var text = normalize(doc[4]);

    var score = 0;
    var hitAll = true;

    for (var i = 0; i < keywords.length; i++) {
      var kw = keywords[i];
      var hit = false;

      if (title.indexOf(kw) !== -1) {
        score += 100;
        if (title.indexOf(kw) === 0) score += 50;
        hit = true;
      }
      if (tags.indexOf(kw) !== -1) {
        score += 40;
        hit = true;
      }
      if (text.indexOf(kw) !== -1) {
        score += 10;
        hit = true;
      }

      if (!hit) { hitAll = false; }
    }

    if (!hitAll) return 0;          // AND：有一个词没命中就整体排除
    if (keywords.length > 1) score = Math.round(score * 1.5);
    return score;
  }

  /**
   * 从正文里抠出命中词附近的片段做摘要。
   *
   * ★ 每个关键词都取一段，再把重叠/相邻的窗口合并 —— 不能只围绕「最早出现的
   * 那个关键词」截。实测：搜 "spring boot" 时，「Spring统一异常返回」这类文章
   * 的 boot 出现在正文更靠后的位置，单窗口摘要只截到 Spring 附近，读者在结果里
   * 看不到 boot，会怀疑是不是匹配错了。
   *
   * 合并规则：按起点排序，后一段的起点落在前一段范围内（或紧邻 20 字内）就并成
   * 一段。这样「两个词挨得近」产出一段连贯的话，离得远才产出带省略号的多段。
   */
  function snippet(text, keywords, radius) {
    if (!text) return '';

    var lower = text.toLowerCase();
    var spans = [];

    for (var i = 0; i < keywords.length; i++) {
      var kw = keywords[i];
      if (!kw) continue;
      var from = 0;
      var p = lower.indexOf(kw, from);
      /* 同一个关键词只取第一处：正文里刷几十次同一个词的文章，
         摘要里堆满同样的窗口没有信息量。 */
      if (p === -1) continue;
      spans.push({ start: Math.max(0, p - radius), end: Math.min(text.length, p + kw.length + radius) });
    }

    if (!spans.length) {
      var head = text.slice(0, radius * 2).trim();
      return head + (text.length > radius * 2 ? '…' : '');
    }

    spans.sort(function (a, b) { return a.start - b.start; });

    var merged = [spans[0]];
    for (var s = 1; s < spans.length; s++) {
      var prev = merged[merged.length - 1];
      // 重叠或间距 < 20 字 → 并段，避免出现「…xxx…yyy…」这种被切碎的短句
      if (spans[s].start <= prev.end + 20) {
        prev.end = Math.max(prev.end, spans[s].end);
      } else {
        merged.push(spans[s]);
      }
    }

    var parts = merged.map(function (m) {
      var piece = text.slice(m.start, m.end).trim();
      return (m.start > 0 ? '…' : '') + piece + (m.end < text.length ? '…' : '');
    });

    return parts.join(' ');
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /** 给文本里的关键词包 <mark>。先转义再替换，避免注入。 */
  function highlight(str, keywords) {
    var safe = escapeHtml(str);
    if (!keywords.length) return safe;
    var pattern = keywords
      .filter(Boolean)
      .sort(function (a, b) { return b.length - a.length; })
      .map(function (k) { return escapeRegExp(escapeHtml(k)); })
      .join('|');
    if (!pattern) return safe;
    return safe.replace(new RegExp('(' + pattern + ')', 'gi'), '<mark>$1</mark>');
  }

  /* =========================================================================
     渲染
     ========================================================================= */

  function renderResults(list, keywords) {
    if (!list.length) {
      resultsEl.innerHTML = '';
      return;
    }

    var html = '';
    for (var i = 0; i < list.length; i++) {
      var doc = list[i];
      var title = doc[0];
      var url = doc[1];
      var tags = doc[2];
      var date = doc[3];
      var text = doc[4];

      html += '<li class="search-result">';
      html += '<a class="search-result__title" href="' + escapeHtml(url) + '">'
        + highlight(title, keywords) + '</a>';

      var meta = [];
      if (date) meta.push('<time>' + escapeHtml(date) + '</time>');
      if (tags) {
        meta.push('<span class="search-result__tags">'
          + highlight(tags.split(',').join(' · '), keywords) + '</span>');
      }
      if (meta.length) html += '<div class="search-result__meta">' + meta.join('') + '</div>';

      var snip = snippet(text, keywords, 60);
      if (snip) {
        html += '<p class="search-result__snippet">' + highlight(snip, keywords) + '</p>';
      }
      html += '</li>';
    }
    resultsEl.innerHTML = html;
  }

  /* =========================================================================
     主流程
     ========================================================================= */

  var runTimer = null;

  function run(rawQuery) {
    var keywords = parseQuery(rawQuery);

    // 同步 URL（不刷历史栈）
    var qs = keywords.length ? '?q=' + encodeURIComponent(rawQuery.trim()) : location.pathname;
    if (history.replaceState) history.replaceState(null, '', qs);

    if (clearBtn) clearBtn.hidden = !rawQuery.trim();

    if (!keywords.length) {
      resultsEl.innerHTML = '';
      if (emptyEl) emptyEl.hidden = true;
      if (statusEl) statusEl.textContent = '';
      return;
    }

    if (statusEl) statusEl.textContent = window.tr('search_page.loading');

    loadIndex().then(function (all) {
      var scored = [];
      for (var i = 0; i < all.length; i++) {
        var s = scoreDoc(all[i], keywords);
        if (s > 0) scored.push({ doc: all[i], score: s });
      }
      scored.sort(function (a, b) { return b.score - a.score; });

      var top = scored.slice(0, MAX_RESULTS).map(function (x) { return x.doc; });

      renderResults(top, keywords);

      if (statusEl) {
        statusEl.textContent = scored.length
          ? window.tr('search_page.result_count', scored.length, all.length)
          : '';
      }
      if (emptyEl) emptyEl.hidden = scored.length > 0;

      /* 结果超过上限时明说，否则读者以为只有这些 */
      if (scored.length > MAX_RESULTS && statusEl) {
        statusEl.textContent += ' ' + window.tr('search_page.truncated', MAX_RESULTS);
      }
    }).catch(function () {
      if (statusEl) statusEl.textContent = window.tr('search_page.error');
    });
  }

  /* =========================================================================
     事件
     ========================================================================= */

  input.addEventListener('input', function () {
    clearTimeout(runTimer);
    var v = input.value;
    /* 输入时略长一点的防抖（250ms）：搜索页每次都要跑全量扫描，
       比归档页的纯 DOM 过滤重，但仍然远低于人眼可感的卡顿阈值。 */
    runTimer = setTimeout(function () { run(v); }, 250);
  });

  /* 回车立刻执行，不等防抖 —— 用户明确表达了「就搜这个」。 */
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      clearTimeout(runTimer);
      run(input.value);
    }
  });

  if (clearBtn) {
    clearBtn.addEventListener('click', function () {
      input.value = '';
      input.focus();
      run('');
    });
  }

  /* 打开页面时若有 ?q=，直接出结果 */
  var initial = new URLSearchParams(location.search).get('q') || '';
  if (initial) {
    input.value = initial;
    run(initial);
  } else {
    input.focus();
  }
})();
