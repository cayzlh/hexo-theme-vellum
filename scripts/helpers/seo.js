'use strict';

// SEO Helpers for Vellum theme
// Generates title, description, keywords, JSON-LD
//
// <title> 和 meta description 也是主题产出的界面文案：它们不该硬编码中文，
// 否则站点切到英文后，浏览器标签仍是「归档 · 站点名」。因此统一走 tr()。

var tr = require('../lib/i18n-core')(hexo).tr;

/* ================================================================
   文本清洗
   ----------------------------------------------------------------
   这里曾经有一个会污染全站 meta description 的 bug，记录在此避免回退：
   **顺序错了**。旧实现先跑 `.replace(/[*_`>]/g, '')`（本意是去掉
   Markdown 的强调符号和引用号），这会把 HTML 里所有的 `>` 提前吃掉，
   于是后面那条 `<[^>]*>` 永远匹配不上——标签没被删掉，反而被削成
   `<h2 id="x"` 这样的残句，连同属性里的中文一起进了 description。
   线上实测 53 个页面的 description 是 HTML 碎片。

   正确顺序只有一条：**先去标签，再去 Markdown 符号**，而且去标签的
   量词必须是 `+`（`[^>]*` 能匹配空串，`<>` 也会被当成标签）。
   ================================================================ */

/* 常见 HTML 实体。正文里 `&amp;` `&#39;` 进 meta 会被再转义一次，
   搜索结果里就显示成 `&amp;quot;`。这里只解最常出现的一批。 */
var ENTITIES = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&hellip;': '…',
  '&mdash;': '—',
  '&ndash;': '–',
  '&middot;': '·',
  '&laquo;': '«',
  '&raquo;': '»'
};

function decodeEntities(str) {
  return String(str)
    .replace(/&#(\d+);/g, function (m, code) {
      var n = parseInt(code, 10);
      return n > 0 && n < 0x10ffff ? String.fromCodePoint(n) : m;
    })
    .replace(/&#x([0-9a-f]+);/gi, function (m, code) {
      var n = parseInt(code, 16);
      return n > 0 && n < 0x10ffff ? String.fromCodePoint(n) : m;
    })
    .replace(/&[a-z]+;|&#\d+;/gi, function (m) {
      return Object.prototype.hasOwnProperty.call(ENTITIES, m.toLowerCase())
        ? ENTITIES[m.toLowerCase()]
        : ' ';
    });
}

function stripHtml(str) {
  if (!str) return '';
  return String(str)
    // 1. 先剥 HTML 标签。`<[^>]+>` 而不是 `<[^>]*>`：后者会把 `<>` 也当标签。
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    // 2. Markdown 图片/链接 → 只留 alt/锚文本
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // 3. 标题前缀与引用号（行首的 > 才是引用，正文里的 > 必须留着，
    //    比如 `a > b`、`容器 > 镜像`，它在中文技术文里很常见）
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    // 4. 行内代码围栏符号与强调符号。反引号/星号/下划线成对出现时删掉，
    //    单个下划线是标识符的一部分（如 `snake_case`），保留。
    .replace(/```[a-z]*\n?/gi, ' ')
    .replace(/`{1,3}/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    // 5. 收尾
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 截断到目标长度，尽量停在句读处。
 *
 * 直接 substring 会把句子切在半路（「…使用 Docker 部」），搜索结果里的
 * 摘要读起来像坏掉。这里先找目标长度内最后一个中文句号/问号/感叹号/分号，
 * 找不到再退到逗号，再退到空格，实在没有才硬切。
 *
 * 注意：**不补省略号**。原来的 `...` 占 3 个字符，让 160 的上限实际只剩
 * 157，而且英文省略号出现在中文摘要末尾很突兀。截断位置本身就说明它被截断了。
 */
function truncate(str, len) {
  len = len || 160;
  if (!str) return '';
  str = decodeEntities(stripHtml(str)).replace(/\s+/g, ' ').trim();
  if (str.length <= len) return str;

  var slice = str.substring(0, len);
  var stops = ['。', '！', '？', '；', '.', '!', '?', ';'];
  for (var i = 0; i < stops.length; i++) {
    var at = slice.lastIndexOf(stops[i]);
    // 太靠前的句号不算（否则一句话的摘要会被砍成词组）
    if (at >= Math.floor(len * 0.6)) return str.substring(0, at + 1);
  }
  var comma = Math.max(slice.lastIndexOf('，'), slice.lastIndexOf(','), slice.lastIndexOf('、'));
  if (comma >= Math.floor(len * 0.6)) return str.substring(0, comma);
  var space = slice.lastIndexOf(' ');
  if (space >= Math.floor(len * 0.6)) return str.substring(0, space);
  return slice;
}

/* ================================================================
   标题
   ----------------------------------------------------------------
   Bing 站长工具报「站点上的许多页面标题太短」。实测本站 340 个页面里
   137 个 <title> 不足 20 个字符，最典型的是首页（就一个 "CAYZLH"）和
   标签/分类/归档页（"WSL 标签 · CAYZLH"）。

   修法不是给所有页面统一加长尾词——那会把标签页变成一串雷同的句子，
   反而制造新的重复标题问题。这里只做一件事：**把页面上真实存在、
   但没进标题的信息补进标题**。标签页有文章数、归档页有年份和篇数、
   档案首页有专题数、翻页有页码，这些本来就该出现在标题里。

   两条硬约束：
     1. 上限 65（Bing 的「too long」阈值约 70，留 5 个字符余量）。
     2. 超出时按「先丢可选部分、再丢站点名」的顺序裁剪，
        绝不把标题硬切成半句话。
   ================================================================ */

/** <title> 的长度上限。Bing 超 70 字符报「too long」，取 65 留余量。 */
var TITLE_MAX = 65;

/** 站点副标题：优先 config.subtitle，其次 config.description，都取首句 */
function siteTagline() {
  var raw = hexo.config.subtitle || '';
  return String(raw).split(/[。！？\n]/)[0].trim();
}

/**
 * 把若干段拼成标题，并在超长时按优先级裁剪。
 *
 * `parts` 的排列约定：**核心在前、可丢弃的在后**。裁剪从尾部开始，
 * 所以调用方要把最关键的信息放前面（页面标题 → 分类 → 站点名）。
 * 站点名通常希望保留，所以它在数组里最后，但如果只有它能丢，也照丢——
 * 宁可标题短一点，也不要被截断成「…排查全记」。
 */
function fitTitle(parts) {
  var sep = tr('seo.title_separator');
  var list = parts.filter(function (p) {
    return p !== undefined && p !== null && String(p).trim() !== '';
  });
  while (list.length > 0) {
    var joined = list.join(sep);
    if (joined.length <= TITLE_MAX) return joined;
    list.pop();
  }
  return '';
}

/** 取 page.posts 的条数；不是集合就返回 -1 */
function postCount(page) {
  var posts = page.posts;
  if (!posts) return -1;
  if (typeof posts.length === 'number') return posts.length;
  if (typeof posts.count === 'number') return posts.count;
  return -1;
}

/** 翻页页码。首页、订阅页、标签页…凡是分了页的都该在标题里体现。 */
function pageNumber(page) {
  var cur = parseInt(page.current, 10);
  return cur > 1 ? cur : 0;
}

hexo.extend.helper.register('seo_title', function (page) {
  var config = hexo.config;
  var site = config.title || 'Untitled';
  var sep = tr('seo.title_separator');
  var pn = pageNumber(page);

  // Front-matter seo_title 直接赢，不做任何拼接
  if (page.seo_title) return page.seo_title;

  // ---- 首页（含 /page/N/ 翻页）----
  if (page.__index) {
    // 翻页页原来和首页共用同一个 "CAYZLH"，8 个页面标题完全相同。
    if (pn) return fitTitle([site, tr('seo.page_number', pn), tr('seo.page_listing')]);
    var tagline = siteTagline();
    return fitTitle(tagline ? [site, tagline] : [site]);
  }

  // ---- 档案（dossier）----
  // 主题生成的 dossier 路由挂的是 `page.project`，不是老的 `page.dossier`。
  // 旧实现只认 `page.dossier`，于是档案页全部退化成「文档标题 · 站点名」，
  // 其中 /dossier/vellum/news.html 与 /news/ 撞成了完全相同的标题。
  if (page.project) {
    var projName = page.project.title || page.project.id || '';
    var docTitle = page.title || '';
    var isProjectHome = page.type === 'project_home' || docTitle === projName;
    if (isProjectHome) {
      var docs = page.project.pageCount;
      return fitTitle([
        projName,
        tr('seo.dossier_suffix'),
        docs > 0 ? tr('seo.doc_count', docs) : '',
        site
      ]);
    }
    return fitTitle([docTitle, projName, tr('seo.dossier_suffix'), site]);
  }

  // 档案聚合页（/dossier/ 与 /dossier/tags/x/）
  if (page.layout === 'index_dossier') {
    if (page.filter && page.tagName) {
      // 档案标签页：和同名的项目页区分开（「设计模式」曾经两边一模一样）
      var seriesCount = page.projects ? Object.keys(page.projects).length : 0;
      return fitTitle([
        page.tagName,
        tr('seo.dossier_tag_suffix'),
        seriesCount > 0 ? tr('seo.projects_count', seriesCount) : '',
        site
      ]);
    }
    var projectTotal = page.projects ? Object.keys(page.projects).length : 0;
    return fitTitle([
      tr('seo.dossier_index'),
      projectTotal > 0 ? tr('seo.projects_count', projectTotal) : '',
      site
    ]);
  }

  // ---- 文章：标题 + 分类 ----
  // 「Gson简易指南 · CAYZLH」(17) 偏短；补上所属分类既够长，
  // 又是搜索者真正想知道的定位信息，不是硬凑的修饰词。
  if (page.layout === 'post' && page.title) {
    var primaryCat = (page.categories && page.categories.length)
      ? page.categories.toArray()[0].name
      : '';
    return fitTitle([page.title, primaryCat, site]);
  }

  // ---- 分类 / 标签：补上文章数 ----
  var count = postCount(page);
  if (page.category) {
    return fitTitle([
      tr('seo.category_suffix', page.category),
      count > 0 ? tr('seo.posts_count', count) : '',
      pn ? tr('seo.page_number', pn) : '',
      site
    ]);
  }
  if (page.tag) {
    return fitTitle([
      tr('seo.tag_suffix', page.tag),
      count > 0 ? tr('seo.posts_count', count) : '',
      pn ? tr('seo.page_number', pn) : '',
      site
    ]);
  }
  if (page.path === 'tags/' || page.path === 'tags/index.html') {
    var tagTotal = hexo.locals.get('tags') ? hexo.locals.get('tags').length : 0;
    return fitTitle([
      tr('seo.tags_index'),
      tagTotal > 0 ? tr('seo.tag_total', tagTotal) : '',
      site
    ]);
  }
  if (page.path === 'categories/' || page.path === 'categories/index.html') {
    var catTotal = hexo.locals.get('categories') ? hexo.locals.get('categories').length : 0;
    return fitTitle([
      tr('seo.categories_index'),
      catTotal > 0 ? tr('seo.category_total', catTotal) : '',
      site
    ]);
  }

  // ---- 归档：年份/月份进标题，并补上篇数 ----
  var archiveMatch = /^archives\/(\d{4})(?:\/(\d{2}))?/.exec(page.path || '');
  if (archiveMatch) {
    var when = archiveMatch[2]
      ? tr('seo.archive_year_month', archiveMatch[1], parseInt(archiveMatch[2], 10))
      : tr('seo.archive_year', archiveMatch[1]);
    return fitTitle([
      when + tr('seo.archive'),
      count > 0 ? tr('seo.posts_count', count) : '',
      pn ? tr('seo.page_number', pn) : '',
      site
    ]);
  }
  if (page.path === 'archives/index.html' || page.path === 'archives/') {
    return fitTitle([
      tr('seo.archive'),
      count > 0 ? tr('seo.posts_count', count) : '',
      site
    ]);
  }

  // ---- 其它有标题的页面 ----
  // 这一类（关于、订阅、资讯、收藏站点、工具页…）没有分类也没有集合，
  // 标题天然短。用站点副标题兜一次底——它是站点自己的定位，比任何
  // 拼凑的修饰词都诚实；站点不想用时把 subtitle 留空即可。
  if (page.title) {
    var base = [page.title, site];
    if ((page.title + sep + site).length < 20) {
      var tag = siteTagline();
      if (tag) base = [page.title, tag, site];
    }
    return fitTitle(base);
  }

  return site;
});

/* ================================================================
   描述
   ================================================================ */

/**
 * 从列表页实际包含的文章里再挤出几句「只有这一页才成立」的话。
 *
 * 这是把描述从 100 字符推到 120+ 的主要手段，而且不是凑字数：时间跨度、
 * 分类分布本来就该出现在列表页摘要里。对只有 1 篇文章的标签页尤其有用
 * ——那类页面单靠「1 篇文章：xxx」永远到不了 120。
 *
 * 返回一个候选句子数组，调用方按顺序追加，够长就停。
 */
function listingExtras(page) {
  var posts = page.posts;
  if (!posts || typeof posts.forEach !== 'function') return [];

  var dates = [];
  var cats = [];
  var hashes = [];
  posts.forEach(function (p) {
    if (!p) return;
    if (p.date) dates.push(p.date);
    if (p.description) hashes.push(p.description);
    else if (p.excerpt) hashes.push(p.excerpt);
    if (p.categories && typeof p.categories.forEach === 'function') {
      p.categories.forEach(function (c) {
        if (c && c.name && cats.indexOf(c.name) === -1) cats.push(c.name);
      });
    }
  });

  var out = [];
  var span = monthSpan(dates.map(toTime));
  if (span) out.push(span);
  if (cats.length) {
    out.push(tr('seo.topic_clause', cats.slice(0, 4).join(tr('seo.list_separator'))));
  }

  /* ★ 最后才用文章自己的 description。
     这一批 description 是逐篇手写/审过的（120–155 字符），比任何
     模板句都更贴近内容；对「只有 1 篇文章的标签页」尤其关键，
     否则这类页面只能靠「1 篇文章：xxx」+ 一句通用尾巴，永远到不了 120。
     只取前两条并截短，避免整段糊上去。 */
  for (var i = 0; i < hashes.length && i < 2; i++) {
    var h = truncate(hashes[i], 90);
    if (h && out.indexOf(h) === -1) out.push(h);
  }
  return out;
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

/**
 * 把 Hexo 的日期字段安全地转成毫秒时间戳。
 *
 * page.date 可能是 Date、moment 对象，也可能（在某些 locals 视角下）是
 * 字符串。直接调 .getTime() 会在 archives 总览页抛
 * "p.date.getTime is not a function"，整页渲染失败——所以统一走这里。
 */
function toTime(v) {
  if (!v) return NaN;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  if (typeof v.getTime === 'function') return v.getTime();
  return new Date(v).getTime();
}

/** 一组时间戳里最早/最晚的 YYYY-MM；不足两条不同月份就返回 '' */
function monthSpan(times) {
  var ts = times.filter(function (t) { return !isNaN(t); });
  if (ts.length < 2) return '';
  var min = new Date(Math.min.apply(null, ts));
  var max = new Date(Math.max.apply(null, ts));
  var a = min.getFullYear() + '-' + pad2(min.getMonth() + 1);
  var b = max.getFullYear() + '-' + pad2(max.getMonth() + 1);
  return a === b ? '' : tr('seo.span_clause', a, b);
}

/**
 * 把描述补到 Bing 的实用下限（约 120 字符）。
 *
 * ★ 关键约束：补白必须**尽量用这一页独有的信息**。
 *   第一版实现偷懒，短描述一律追加站点 tagline，结果 22 个页面的
 *   meta description 变成完全一样的
 *   「多读书，多看报，少吃零食多睡觉～ CODE IS POETRY 作者 Ant丶。」——
 *   从「太短」变成了「重复」，两个问题一样糟，等于没修。
 *
 *   所以这里只接受「本页独有」的片段（专题名、文档数、分类、篇数…），
 *   站点 tagline 仅作为最后一步、且只加一次。
 */
function padDescription(desc, page, config) {
  var MIN = 120;
  var MAX = 160;
  desc = (desc || '').trim();
  if (desc.length >= MIN) return truncate(desc, MAX);

  var clauses = [];

  // 1) 档案专题页：篇数 + 这个专题下有哪些章节
  /**
   * 之前这里拼的是 project.tags，可 dossier 的 tags 和 page.tags 常常是
   * 同一份数据，于是同一句话会连着出现两遍：
   *   「专题方向包括设计模式、札记。 涉及设计模式、札记等技术标签。」
   * 换成章节标题列表——那是专题页真正独有、且读者想看到的信息。
   */
  if (page.project) {
    var pdocs = page.project.pageCount;
    if (pdocs > 0) clauses.push(tr('seo.clause_dossier', pdocs));

    var chapterTitles = [];
    if (Array.isArray(page.project.flatList)) {
      page.project.flatList.forEach(function (f) {
        if (f && f.title && chapterTitles.indexOf(f.title) === -1) chapterTitles.push(f.title);
      });
    }
    if (chapterTitles.length >= 2) {
      clauses.push(tr('seo.clause_chapters', chapterTitles.slice(0, 4).join(tr('seo.list_separator'))));
    }
  }

  // 2) 文章：分类与标签
  var cats = [];
  if (page.categories && page.categories.length) {
    cats = page.categories.toArray
      ? page.categories.toArray().map(function (c) { return c.name; })
      : page.categories.map(function (c) { return c.name; });
  }
  if (cats.length) clauses.push(tr('seo.clause_category', cats.join(tr('seo.list_separator'))));

  /* 标签在两类页面里形状不同：
       · posts / tags 页：是 Tag 模型实例，要取 .name；
       · dossier 路由：直接是一串字符串（见 dossier.js 的 tags 字段）。
     早期统一按 .name 取，档案页就拼出「涉及、、等技术标签」——三个空值。
     这里两种形状都认。 */
  var tags = [];
  if (page.tags && page.tags.length) {
    var list = page.tags.toArray ? page.tags.toArray() : Array.prototype.slice.call(page.tags);
    tags = list.map(function (t) {
      if (t == null) return '';
      return typeof t === 'string' ? t : (t.name || '');
    }).filter(function (t) { return t !== ''; });
  }
  if (tags.length) clauses.push(tr('seo.clause_tags', tags.slice(0, 5).join(tr('seo.list_separator'))));

  /* ★ 这里刻意**不再**追加站点 tagline。
     站点那句「多读书，多看报，少吃零食多睡觉～」对每个页面都一样，
     一旦拿它补长度，就把「描述太短」直接换成了「描述重复」——Bing 对
     后者的降权更狠。宁可短一点，也要保证每页描述指向这一页自己。
     真正需要更长的场合，由各条分支在更上游用本页数据拼够。 */
  return appendUpTo(desc, clauses, MIN, MAX);
}

/**
 * 依次追加候选句子，直到达到 MIN 或超 MAX。
 *
 * ★ 最后一条用「剩余预算」裁剪，而不是整条丢弃。
 *   这里踩过一个坑：文章 description 是 120–155 字符的整段话，若原样追加
 *   必然超过 160 的上限，于是被 `if (next.length <= MAX)` 整个跳过——
 *   结果那些只有 1 篇文章的标签页始终停在 80–99 字符，明明有可用的独有
 *   内容却用不上。现在按剩余空间截断后再拼接。
 *
 *   20 字符是下限：再短的尾巴接上去只是碎片（「涉及运维等方」），不如不加。
 */
function appendUpTo(desc, clauses, MIN, MAX) {
  var sep = tr('seo.clause_separator');
  desc = (desc || '').trim();
  for (var i = 0; i < clauses.length && desc.length < MIN; i++) {
    var c = clauses[i];
    if (!c || desc.indexOf(c) !== -1) continue;

    var next = desc ? desc + sep + c : c;
    if (next.length <= MAX) { desc = next; continue; }

    // 超了就截到剩余预算内；剩余空间太小则放弃这一条
    var budget = MAX - (desc ? desc.length + sep.length : 0);
    if (budget < 20) continue;
    var clipped = truncate(c, budget);
    if (clipped && clipped.length > (budget * 0.6)) {
      desc = (desc ? desc + sep : '') + clipped;
    }
  }
  return truncate(desc, MAX);
}

/**
 * 从页面实际包含的文章生成列表页描述。
 *
 * 没有这段时，73 个标签页和 49 个归档页共用站点那一句 tagline，搜索引擎
 * 判定为重复内容。有了它，每页描述都是独有的、且真的描述了这页内容。
 *
 * 返回 '' 表示这不是列表页，调用方继续走后面的优先级。
 */
function listingDescription(page, siteName) {
  var count = postCount(page);
  if (count <= 0) return '';

  var titles = [];
  var posts = page.posts;
  if (posts && typeof posts.forEach === 'function') {
    posts.forEach(function (post) {
      if (post && post.title) titles.push(post.title);
    });
  }

  /**
   * 挑标题填到够长为止。
   *
   * 固定取 3 个的做法对短描述没用：1 篇文章的标签页只列得出 1 个标题，
   * 一句话永远停在 60 字符。这里改成「先取 3 个，不够长就继续加」，
   * 篇数多时自然停得早，篇数少时列表本身就把长度撑起来了。
   */
  function compose(template, tail) {
    var picked = [];
    for (var i = 0; i < titles.length; i++) {
      picked.push(titles[i]);
      var more = count > picked.length ? tr('seo.more_suffix') : '';
      var text = template(picked.join(tr('seo.list_separator')), more);
      if (text.length >= 120 || picked.length >= titles.length) {
        return appendUpTo(text, [tail].concat(listingExtras(page)), 120, 160);
      }
    }
    var more2 = count > picked.length ? tr('seo.more_suffix') : '';
    return appendUpTo(
      template(picked.join(tr('seo.list_separator')), more2),
      [tail].concat(listingExtras(page)),
      120,
      160
    );
  }

  if (page.tag) {
    return compose(function (preview, more) {
      return tr('seo.tag_desc', siteName, page.tag, count, preview, more);
    }, tr('seo.tag_tail'));
  }
  if (page.category) {
    return compose(function (preview, more) {
      return tr('seo.category_desc', siteName, page.category, count, preview, more);
    }, tr('seo.category_tail'));
  }

  var m = /^archives\/(\d{4})(?:\/(\d{2}))?/.exec(page.path || '');
  if (m) {
    var when = m[2] ? tr('seo.archive_year_month', m[1], parseInt(m[2], 10)) : tr('seo.archive_year', m[1]);
    return compose(function (preview, more) {
      return tr('seo.archive_desc', siteName, when, count, preview, more);
    }, tr('seo.archive_tail'));
  }

  return '';
}

/** 没有 posts 集合的索引页：归档总览、档案总览、档案标签页 */
function indexPageDescription(page, siteName) {
  var path = page.path || '';

  if (path === 'archives/' || path === 'archives/index.html') {
    var all = hexo.locals.get('posts');
    var total = all ? all.length : 0;
    var span = '';
    if (all && total > 1) {
      span = monthSpan(all.toArray().map(function (p) { return toTime(p && p.date); }));
    }
    /* 年份分布是归档页独有的、也是读者真正想知道的：
       「2019 起笔、2022 最密集」这种信息比一句「按年份整理」有用得多。 */
    var yearCounts = {};
    if (all && total > 0) {
      all.forEach(function (p) {
        var t = toTime(p && p.date);
        if (isNaN(t)) return;
        var y = new Date(t).getFullYear();
        yearCounts[y] = (yearCounts[y] || 0) + 1;
      });
    }
    var years = Object.keys(yearCounts).sort();
    var yearClause = '';
    if (years.length >= 2) {
      var peak = years.slice().sort(function (a, b) { return yearCounts[b] - yearCounts[a]; })[0];
      yearClause = tr('seo.clause_years', years.length, years[0], years[years.length - 1],
        peak, yearCounts[peak]);
    }
    return appendUpTo(
      tr('seo.archive_all_desc', siteName) + (
        total > 0 ? tr('seo.archive_total_clause', total) : ''
      ),
      [yearClause, tr('seo.archive_tail'), span],
      120,
      160
    );
  }

  if (page.layout === 'index_dossier') {
    var keys = page.projects ? Object.keys(page.projects) : [];

    // 档案标签页：列出这标签下有哪些专题、共多少篇。这是这页独有的信息。
    if (page.filter && page.tagName) {
      var matched = keys.filter(function (k) {
        var p = page.projects[k];
        return p && p.tags && p.tags.indexOf(page.tagName) !== -1;
      });
      var names = matched.map(function (k) { return page.projects[k].title || k; });
      var docs = matched.reduce(function (sum, k) {
        return sum + ((page.projects[k] && page.projects[k].pageCount) || 0);
      }, 0);
      var text = tr('seo.dossier_tag_desc', siteName, page.tagName, names.length,
        names.join(tr('seo.list_separator')), docs);
      var tails = [];
      if (matched.length === 1) {
        var onlyProj = page.projects[matched[0]];
        var intro = stripHtml((onlyProj && onlyProj.description) || '');
        if (intro) tails.push(intro);
      }
      /* 再补一句：这个标签下的专题分别有多少篇。
         档案标签页数量不多（本站 11 个），但每一个都该说清自己的构成。 */
      var breakdown = matched.map(function (k) {
        var pj = page.projects[k];
        return (pj.title || k) + '(' + ((pj.pageCount) || 0) + tr('seo.doc_unit') + ')';
      }).join(tr('seo.list_separator'));
      if (breakdown) tails.push(tr('seo.clause_breakdown', breakdown));
      return appendUpTo(text, tails, 120, 160);
    }

    var projects = keys.length;
    var totalDocs = keys.reduce(function (sum, k) {
      return sum + ((page.projects[k] && page.projects[k].pageCount) || 0);
    }, 0);
    var projectNames = keys.map(function (k) { return page.projects[k].title || k; });
    var base = tr('seo.dossier_base', siteName);
    if (projects === 0) return truncate(tr('seo.dossier_desc_plain', base), 160);

    /* 先列 4 个专题名，不足 120 就把剩下的也列出来。
       本站只有 6 个专题，全列也不过 100 出头，比硬凑一句空话实在。 */
    var text = tr('seo.dossier_desc_projects', base, projects, totalDocs,
      projectNames.slice(0, 4).join(tr('seo.list_separator')));
    if (text.length < 120 && projectNames.length > 4) {
      text = tr('seo.dossier_desc_projects', base, projects, totalDocs,
        projectNames.join(tr('seo.list_separator')));
    }
    return truncate(text, 160);
  }

  return '';
}

hexo.extend.helper.register('seo_description', function (page) {
  var config = hexo.config;
  var theme = hexo.theme.config;
  var siteName = config.title || '';

  // 1. Front-matter description（最高优先级，站点自己写的）
  if (page.description) return padDescription(truncate(page.description, 160), page, config);

  // 1b. 档案章节页：正文首段不能当描述用
  /**
   * 为什么单独处理：《MyBatis技术内幕》这一套的每一章都以同一段
   * 「MyBatis基础支持层位于…是整个框架的基石」开头（作者给整本书写的
   * 统一导语，逐章复制）。没有 front-matter description 的章节于是全部
   * 落到「正文前 160 字」这条兜底上——8 个页面拿到了完全相同的描述。
   *
   * 这里改用「项目名 + 章节标题 + 在系列中的位置」来拼，天然唯一，
   * 而且正是搜索者想知道的定位信息。作者若在 front-matter 里写了
   * description，走上面的第 1 条，不会被覆盖。
   */
  if (page.project && page.type === 'doc') {
    var projTitle = page.project.title || page.project.id || '';
    var docsTotal = page.project.pageCount || 0;
    // 章节序号：nav 里的扁平顺序即阅读顺序
    var index = -1;
    var flat = page.project.flatList;
    if (Array.isArray(flat)) {
      for (var fi = 0; fi < flat.length; fi++) {
        if (flat[fi] && flat[fi].url === '/' + (page.path || '')) { index = fi; break; }
      }
    }
    var pos = (index >= 0 && docsTotal > 0)
      ? tr('seo.clause_position', Math.min(index + 1, docsTotal), docsTotal)
      : '';
    var skeleton = tr('seo.project_doc_desc', siteName, projTitle, page.title || '', pos);

    /* 收尾用「这一章的小标题」而不是正文首段。
       档案章节的正文首段往往是作者给整本书写的统一导语（逐章复制），
       拿它补长度等于把唯一的描述又变回重复。小标题（TOC 一级）才是
       这一章真正讲了什么，而且天然唯一。 */
    /* 小标题要先筛一遍：这批档案里大量章节只用了「实例」「总结」
       「介绍」这种通用小节名，拼进描述会变成「本章依次讲了实例 这几节」，
       既没信息量又难读。低于 4 个字符、或落在通用词表里的标题一律丢弃。 */
    var GENERIC = {
      '实例': 1, '示例': 1, '举例': 1, '总结': 1, '小结': 1, '介绍': 1,
      '简介': 1, '概述': 1, '概述': 1, '参考': 1, '参考链接': 1, '结论': 1,
      '背景': 1, '前言': 1, '引言': 1, '说明': 1, '注意': 1, '其他': 1,
      'example': 1, 'summary': 1, 'intro': 1, 'reference': 1, 'conclusion': 1
    };
    var sectionNames = [];
    if (page.toc && page.toc.length) {
      page.toc.forEach(function (h) {
        var t = stripHtml(h.text || h.title || '');
        if (!t || t.length < 4) return;
        if (GENERIC[t] || GENERIC[t.toLowerCase()]) return;
        if (sectionNames.indexOf(t) === -1) sectionNames.push(t);
      });
    }

    var tails = [];

    /* 至少要两个有意义的小标题才值得写「本章依次讲了 A、B」。
       只有一个的时候，那句话几乎就是把章节标题再念一遍
       （「本章依次讲了策略模式 这几节」），既占长度又没信息。 */
    var usable = sectionNames.filter(function (t) {
      return t !== stripHtml(page.title || '');
    });
    if (usable.length >= 2) {
      tails.push(tr('seo.clause_sections', usable.slice(0, 4).join(tr('seo.list_separator'))));
    }

    /* 拿正文首句补齐。这些档案章节的正文首段彼此不同（不像 MyBatis 那套
       是逐章复制的统一导语），因此能提供 uniqueness。
       仍要求它没出现在已生成的句子里，避免把标题重复一遍。 */
    var lead = truncate(page.content || page.excerpt || '', 70);
    lead = lead.replace(/[。；，、\s]+$/, '');
    if (lead && lead.length >= 8 && skeleton.indexOf(lead) === -1) {
      tails.push(tr('seo.clause_opening', lead));
    }

    return appendUpTo(skeleton, tails, 120, 160);
  }

  // 2. 首页：用站点简介 + 最近内容，而不是那句 tagline。
  //    原来 30 个页面（首页 8 页 + 各列表页）共用 16 字的 tagline，
  //    是 Bing 判「太短」和「重复」的主因。
  if (page.__index) {
    var recentTitles = [];
    var all = hexo.locals.get('posts');
    if (all && all.length) {
      all.sort('-date').toArray().slice(0, 3).forEach(function (p) {
        if (p && p.title) recentTitles.push(p.title);
      });
    }
    var pn = pageNumber(page);

    /* 翻页的首页必须有不同的描述。
       原来 8 个页面的描述完全一样（都取「最近更新有 A、B、C」），
       只是最后一页多一句页码——Bing 认得出来这是重复内容。
       翻页页改成报「这一页上有哪几篇」，那是它自己独有的信息。 */
    if (pn && page.posts && typeof page.posts.forEach === 'function') {
      var pageTitles = [];
      page.posts.forEach(function (post) {
        if (post && post.title) pageTitles.push(post.title);
      });
      /* 取到够长为止（最多 6 个）。固定 4 个时，标题都很短的第 3/6 页
         只有 104 字符，而标题长的那几页早就过 120 了——按长度自适应。 */
      var picked = [];
      var text = '';
      for (var ti = 0; ti < pageTitles.length && ti < 6; ti++) {
        picked.push(pageTitles[ti]);
        text = tr('seo.home_page_listing', siteName, pn,
          picked.join(tr('seo.list_separator')).replace(/、([^、]+)$/, '和$1'));
        if (text.length >= 120) break;
      }
      return truncate(text, 160);
    }

    var homeDesc = tr(
      'seo.home_desc',
      siteName,
      stripHtml(config.description || ''),
      config.author || '',
      recentTitles.join(tr('seo.list_separator'))
    );
    return truncate(homeDesc, 160);
  }

  // 3. 列表页：从页面实际包含的文章生成
  var listing = listingDescription(page, siteName);
  if (listing) return listing;

  // 3a. 标签总览 / 分类总览：没有 posts 集合，但集合本身是可统计的
  /**
   * 这两页原来一路落到「站点级兜底」，用的就是那句 31 字符的 tagline，
   * Bing 判「太短」。它们的集合（site.tags / site.categories）是现成的，
   * 篇数、Top 标签都是这页独有的信息，拼出来天然唯一。
   */
  if (page.path === 'tags/' || page.path === 'tags/index.html') {
    var allTags = hexo.locals.get('tags');
    var tagArr = allTags ? allTags.toArray().filter(function (t) { return t.length > 0; }) : [];
    tagArr.sort(function (a, b) { return b.length - a.length; });
    var topNames = tagArr.slice(0, 6).map(function (t) {
      return t.name + '(' + t.length + ')';
    });
    var postsCovered = hexo.locals.get('posts') ? hexo.locals.get('posts').length : 0;
    return truncate(tr(
      'seo.tags_index_desc',
      siteName,
      tagArr.length,
      postsCovered,
      topNames.join(tr('seo.list_separator'))
    ), 160);
  }

  if (page.path === 'categories/' || page.path === 'categories/index.html') {
    var allCats = hexo.locals.get('categories');
    var catArr = allCats ? allCats.toArray().filter(function (c) { return c.length > 0; }) : [];
    catArr.sort(function (a, b) { return b.length - a.length; });
    var catNames = catArr.slice(0, 6).map(function (c) {
      return c.name + '(' + c.length + ')';
    });
    var catPosts = catArr.reduce(function (sum, c) { return sum + c.length; }, 0);
    var catTimes = [];
    catArr.forEach(function (c) {
      if (typeof c.forEach === 'function') {
        c.forEach(function (p) { if (p && p.date) catTimes.push(p.date); });
      }
    });
    var catSpan = monthSpan(catTimes.map(toTime));
    return appendUpTo(
      tr('seo.categories_index_desc', siteName, catArr.length, catPosts,
         catNames.join(tr('seo.list_separator'))),
      [catSpan],
      120,
      160
    );
  }

  // 3b. 没有 posts 集合的索引页
  var indexDesc = indexPageDescription(page, siteName);
  if (indexDesc) return indexDesc;

  // 4. 摘要 / 正文首段
  if (page.excerpt) return padDescription(truncate(page.excerpt, 160), page, config);
  if (page.content) return padDescription(truncate(page.content, 160), page, config);

  // 5. 站点级兜底
  if (config.description) return padDescription(truncate(config.description, 160), page, config);
  if (theme.description) return padDescription(truncate(theme.description, 160), page, config);

  return '';
});

// SEO keywords
hexo.extend.helper.register('seo_keywords', function (page) {
  // 1. Front-matter keywords
  if (page.keywords) {
    if (Array.isArray(page.keywords)) return page.keywords.join(', ');
    return page.keywords;
  }

  // 2. Tags
  if (page.tags && page.tags.length) {
    return page.tags.map(function (t) { return t.name; }).join(', ');
  }

  // 3. Dossier project tags
  if (page.project && page.project.tags && page.project.tags.length) {
    return page.project.tags.join(', ');
  }
  if (page.dossier && hexo.theme.config.dossier && hexo.theme.config.dossier.tree) {
    var dkey = page.dossier;
    var proj = hexo.theme.config.dossier.tree[dkey];
    if (proj && proj.tags && proj.tags.length) return proj.tags.join(', ');
  }

  return '';
});

// JSON-LD structured data
hexo.extend.helper.register('json_ld', function (page, config) {
  var theme = hexo.theme.config;
  var sd = theme.structured_data;
  if (!sd || !sd.enable) return '';

  var siteUrl = (config.url || '').replace(/\/+$/, '');

  function absolute(u) {
    if (!u) return '';
    if (/^https?:\/\//i.test(u)) return u;
    return siteUrl + (u.charAt(0) === '/' ? u : '/' + u);
  }

  // 文章页 → BlogPosting
  if (page.layout === 'post' && page.date) {
    var img = absolute(page.cover || page.banner || (sd.logo || ''));
    var canon = 'https://' + (theme.canonical && theme.canonical.originalHost
      ? theme.canonical.originalHost.replace(/\/+$/, '')
      : (config.url || '').replace(/^https?:\/\//, '').replace(/\/+$/, ''))
      + (page.path || '').replace(/index\.html$/, '');
    return JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'BlogPosting',
      headline: page.seo_title || page.title || '',
      datePublished: page.date.toISOString(),
      dateModified: (page.updated || page.date).toISOString(),
      author: {
        '@type': sd.site_type || 'Person',
        name: config.author || ''
      },
      publisher: {
        '@type': sd.site_type || 'Person',
        name: config.author || '',
        logo: sd.logo ? { '@type': 'ImageObject', url: absolute(sd.logo) } : undefined
      },
      description: truncate(page.description || page.excerpt || page.content, 160),
      mainEntityOfPage: { '@type': 'WebPage', '@id': canon },
      image: img || undefined
    }, null, 2);
  }

  // 首页 → WebSite
  if (page.__index && (!page.current || page.current === 1)) {
    return JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: config.title || '',
      url: siteUrl,
      description: truncate(config.description || config.subtitle || '', 160),
      inLanguage: Array.isArray(config.language) ? config.language[0] : config.language,
      author: {
        '@type': sd.site_type || 'Person',
        name: config.author || ''
      }
    }, null, 2);
  }

  return '';
});

// Canonical URL
hexo.extend.helper.register('canonical_url', function (page) {
  var config = hexo.config;
  var theme = hexo.theme.config;
  var canon = theme.canonical;
  if (!canon || !canon.originalHost) return '';

  var host = canon.originalHost.replace(/\/+$/, '');
  var path = page.path || '';
  if (path.charAt(0) !== '/') path = '/' + path;

  // `page.path` 对目录页带着 index.html，但托管会把该 URL 307 到带斜杠的
  // 形态；canonical 指向一个会重定向的地址会被搜索引擎忽略，所以剥掉文件名，
  // 让斜杠形态作规范——与 pretty_urls.trailing_index/trailing_html: false 一致。
  path = path.replace(/index\.html$/, '');
  // 托管也会把 `/foo.html` 重写到 `/foo`，所以 .html 结尾的 canonical 同样无效。
  path = path.replace(/\.html?$/, '');
  if (path === '') path = '/';

  return 'https://' + host + path;
});

// Replace tricky characters in description for meta tag safety
hexo.extend.helper.register('safe_meta', function (str) {
  if (!str) return '';
  return decodeEntities(String(str))
    .replace(/"/g, '&quot;')
    .replace(/[\r\n]+/g, ' ')
    .trim();
});
