'use strict';

/**
 * Vellum — 收藏站点合并核心（纯函数）
 *
 * 为什么单独抽一个文件，而不是塞在 scripts/bookmarks.js 里：
 *   1. **要能单测**。这里的规则（两种本地格式、远程并入、URL 归一化去重、
 *      组内排序、图标兜底）全是「看着对、实际错一行」的地方，而它们几乎
 *      没法靠跑 `hexo generate` 观察——真实的 yml 恰好没有重名、没有脏数据、
 *      没有缺 sort 的项，测试就永远发现不了。抽成纯函数后
 *      `node tools/test-bookmark-merge.js` 能把每条规则单独钉住。
 *   2. **契约归属清楚**。URL 归一化规则来自 cayzlh-hub 的
 *      01-api-contract.md 第 6.1 节，hub 侧存库、插件侧查重、主题侧合并
 *      必须是同一套算法；独立文件方便以后别人抄/对照。
 *
 * 本文件不 require hexo、不读配置、不打日志、不发请求——给定输入就有确定输出。
 *
 * 用法：
 *   var bm = require('./lib/bookmark-merge');
 *   bm.normalizeUrl('HTTPS://Example.com/#top');   // 'https://example.com'
 *   bm.mergeBookmarks({ bookmarks: flatList, links: groupedList, remote: remoteList });
 *   bm.groupBookmarks(flat);                        // [{ category, items }]
 *
 * 数据来源与优先级
 * ----------------
 *   1. source/_data/bookmarks.yml  平铺，每条自带 category / sort —— 新格式
 *   2. source/_data/links.yml      分组（category + items）—— 老格式，
 *                                  同时喂着文章页的 show_links 友链组件
 *   3. hub 的 GET /api/bookmarks/public —— 插件随手一存，下次构建自动出现
 *
 * 合并规则：**本地优先，远程只补本地没有的站点**（契约 6.4 节）。两个本地
 * 文件按 url 归一化去重，bookmarks.yml 在前（新格式更明确，将来加站都往这
 * 里加）；同 url 时后出现的整条丢弃，不做字段互补——两处写同一条记录本身
 * 就是重复配置，混着来源补字段只会让「为什么名字是这个」更难解释。
 */

/* 缺 id 的远程记录排到同 sort 的末尾。契约里 id 是主键，正常都有；
   真缺了不猜它该在哪，和 subscription-merge.js 对 sort/id 的处理一致。 */
var MAX_INT = Number.MAX_SAFE_INTEGER;

/**
 * URL 归一化 —— 合并去重的唯一身份。
 *
 * 规则照抄契约 6.1 节（原文：trim、协议与主机小写、去尾部 `/`、去 fragment）：
 *   · trim
 *   · 协议与主机小写（WHATWG URL 已做，这里显式写一遍好让继承者一眼看到）
 *   · 只削**路径**尾部的斜杠，绝不碰 query
 *   · 丢掉 fragment（`#top` 不是地址的一部分，留着会让同一站算两条）
 *
 * 解析不了的字符串原样返回（只 trim）：宁可两条坏 URL 不合并，也不要把用户
 * 的地址静默改成别的样子——「能不能用」是另一件事，见 isUsableUrl。
 *
 * 本函数是**三处共用口径**（hub / Chrome 插件 / 主题），实现与 subscriptions
 * 侧的 lib/subscription-merge.js#normalizeFeedUrl 逐字一致：收藏与订阅在 hub
 * 里就是同一个 normalizeUrl 函数（bookmarks.ts 直接 import 订阅那份），主题
 * 这边若走两套算法，会出现「同一地址在两种数据里算出不同的键」。
 * 改这里之前先确认 hub 与插件也一起改。
 */
function normalizeUrl(raw) {
  if (raw === null || raw === undefined) return '';
  var s = String(raw).trim();
  if (!s) return '';

  var u;
  try {
    u = new URL(s);
  } catch (e) {
    return s;
  }

  u.hash = '';
  u.protocol = u.protocol.toLowerCase();
  u.hostname = u.hostname.toLowerCase();

  /* 只削路径尾部的斜杠，再手工拼 search。
     图省事写成 `u.toString().replace(/\/$/, '')` 会把 query 值一起削：
     `https://a.com/?next=/x/` 变成 `...?next=/x`，键就跟 hub 对不上了。
     根路径 '/' 削成空串，所以 `https://a.com/` 与 `https://a.com` 一致。 */
  var path = u.pathname.replace(/\/+$/, '');

  return u.protocol + '//' + u.host + path + u.search;
}

/**
 * 这个地址能不能真的当链接渲染。
 *
 * 与 normalizeUrl 分开是因为两者回答的问题不同：归一化回答「这是不是同一个
 * 站点」，这里回答「点得动吗」。契约要求 url 是 http(s) 绝对地址，但本地 yml
 * 是手写的，写漏协议、写成 `javascript:`、留着 `#` 占位的都有。
 *
 * 为什么要拦：整张卡片就是一个 <a href>，坏地址在页面上表现为「一张点不动
 * 的假卡片」，比直接不显示更让人困惑；而 zaobao.js 里记过的教训是，无法解析
 * 的 href 还会在渲染后过滤器（nofollow 之类）里抛错，一个坏链接能换掉整页。
 */
function isUsableUrl(raw) {
  if (raw === null || raw === undefined) return false;
  var s = String(raw).trim();
  if (!s) return false;
  var u;
  try {
    u = new URL(s);
  } catch (e) {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  return !!u.hostname;
}

/** 字符串字段的取值口径：非字符串一律当没填，避免把对象/数字塞进模板。 */
function trimText(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

/** 宽松取整数：'3' / 3 都算 3，其余回落 fallback。 */
function toInt(value, fallback) {
  var n = parseInt(value, 10);
  return isFinite(n) ? n : fallback;
}

/** 有没有显式写 sort。sort: 0 是合法值，不能用真假判断。 */
function hasSort(item) {
  if (!item || item.sort === null || item.sort === undefined) return false;
  if (item.sort === '') return false;
  return isFinite(parseInt(item.sort, 10));
}

/** 取主机名（去 www.）；解析不了返回空串。 */
function hostOf(url) {
  if (!url) return '';
  try {
    return new URL(String(url)).hostname.replace(/^www\./i, '').toLowerCase();
  } catch (e) {
    return '';
  }
}

/**
 * 卡片标题：优先 name；没写就用去掉 www. 的主机名。
 * 返回空串交给调用方决定怎么兜（模板那边是整条不显示）。
 */
function titleOf(record) {
  var name = trimText(record && record.name);
  if (name) return name;
  return hostOf(record && record.url);
}

/**
 * 图标缺失时的「字符底座」。
 *
 * 用域名首字母而不是标题首字母：标题是中文、图标却是「维」字，看起来像乱码；
 * 域名首字母（W、H、V）至少和地址栏里那串一致，扫一眼能认。
 *
 * 两个例外：
 *   · 主机名以 `xn--` 开头（IDN 的 punycode 形式）——首字母永远是 `x`，
 *     等于把一堆中文站全标成 X，这时退用标题首字。
 *   · 没有可用域名（相对地址、坏 URL）——同样退用标题首字。
 * 兜底是 '?'，不会返回空串让模板画出空底座。
 */
function initialOf(record) {
  var host = hostOf(record && record.url);
  if (host && !/^xn--/i.test(host)) {
    return host.charAt(0).toUpperCase();
  }
  var title = titleOf(record) || trimText(record && record.name);
  if (title) return title.charAt(0).toUpperCase();
  return '?';
}

/**
 * 把一条记录整理成页面上真正用得到的字段。
 *
 * 只留展示字段，不透传 id/createdAt 这类管理信息：它们进不了模板，
 * 进了只会让「这个字段是谁在用」多一层疑问。
 *
 * @param {object} raw   原始记录（本地 yml 或 hub 响应里的元素）
 * @param {string} fallCategory 调用方给定的分组名（老格式的组名走这里）
 */
function normalizeRecord(raw, fallCategory) {
  var category = trimText(raw && raw.category);
  if (!category) category = trimText(fallCategory);

  var record = {
    url: normalizeUrl(raw && raw.url),
    name: titleOf(raw),
    description: trimText(raw && raw.description),
    icon: trimText(raw && raw.icon),
    category: category,
    sort: hasSort(raw) ? toInt(raw.sort, 0) : null,
    id: raw && raw.id !== undefined && raw.id !== null ? raw.id : null
  };

  /* 图标与兜底字符在合并层就算好：模板里只做 `icon || initial` 这一件事，
     不必再把「域名怎么取」的判断写进 EJS。 */
  record.initial = initialOf(record);

  return record;
}

/** source/_data/bookmarks.yml —— 平铺数组，每条自带 category。 */
function flattenBookmarks(list) {
  if (!Array.isArray(list)) return [];
  var out = [];
  list.forEach(function (item) {
    if (!item || typeof item !== 'object') return;
    out.push(normalizeRecord(item));
  });
  return out;
}

/**
 * source/_data/links.yml —— 分组数组 `[{ category, items: [...] }]`。
 *
 * 这个文件同时喂着文章页的 show_links 友链组件，格式不能动；这里只是换个
 * 形状读一遍。分组顺序就是作者手排的顺序，由 groupBookmarks 原样保留。
 */
function flattenLinks(groups) {
  if (!Array.isArray(groups)) return [];
  var out = [];
  groups.forEach(function (group) {
    if (!group || typeof group !== 'object') return;
    if (!Array.isArray(group.items)) return;
    group.items.forEach(function (item) {
      if (!item || typeof item !== 'object') return;
      out.push(normalizeRecord(item, group.category));
    });
  });
  return out;
}

/**
 * 同一批记录内按归一化 URL 去重，保留**第一条**（即优先级最高的那条）。
 * 顺手丢掉没有 url 的记录：收藏站点的全部意义就是那个地址。
 */
function dedupeByUrl(list) {
  var out = [];
  var seen = Object.create(null);
  list.forEach(function (item) {
    var key = item.url;
    if (!key) return;
    if (seen[key]) return;
    seen[key] = true;
    out.push(item);
  });
  return out;
}

/**
 * 合并三种来源。
 *
 * @param {object} options
 * @param {Array}  [options.bookmarks] 新格式（bookmarks.yml），优先级最高
 * @param {Array}  [options.links]     老格式（links.yml 的分组数组）
 * @param {Array}  [options.remote]    hub 公开接口返回的 bookmarks 数组
 * @returns {Array} 平铺的展示记录；入参的数组与对象都不会被修改
 *
 * 远程只补「本地没有的站点」，不做字段互补——本地手写的文案比插件抓的标题
 * 贴切，这是契约 6.4 节的原话。远程列表本身按 category / sort / id 升序
 * （契约 6.2 节 GET /api/bookmarks 的返回顺序），这里不再重排，保持服务端
 * 的顺序就等于保持管理台里看到的顺序。
 */
function mergeBookmarks(options) {
  var opts = options || {};

  var local = flattenBookmarks(opts.bookmarks).concat(flattenLinks(opts.links));
  var merged = dedupeByUrl(local);

  var seen = Object.create(null);
  merged.forEach(function (item) { seen[item.url] = true; });

  var remote = Array.isArray(opts.remote) ? opts.remote : [];
  remote.forEach(function (item) {
    if (!item || typeof item !== 'object') return;
    var record = normalizeRecord(item);
    if (!record.url) return;
    if (seen[record.url]) return;
    seen[record.url] = true;
    merged.push(record);
  });

  return merged;
}

/**
 * 组内排序：有 sort 的按 (sort, id) 升序排在**前面**，没写 sort 的保持
 * 出现顺序排在后面。
 *
 * 为什么「没写 sort 的排后面」而不是把缺省值当 0：本地 yml 是作者手排的，
 * 一组里前两条写了 sort、后五条没写，若把没写的当 0，它们会全部插到最前面，
 * 作者排的顺序当场失效。当「未指定」处理，既保住了手排顺序，也和
 * subscription-merge.js「缺 id 排到最后」是同一个思路。
 */
function sortWithin(items) {
  return items
    .map(function (item, index) { return { item: item, seq: index }; })
    .sort(function (a, b) {
      var aHas = hasSort(a.item);
      var bHas = hasSort(b.item);
      if (aHas !== bHas) return aHas ? -1 : 1;
      if (aHas && bHas) {
        if (a.item.sort !== b.item.sort) return a.item.sort - b.item.sort;
        var ia = a.item.id === null ? MAX_INT : toInt(a.item.id, MAX_INT);
        var ib = b.item.id === null ? MAX_INT : toInt(b.item.id, MAX_INT);
        if (ia !== ib) return ia - ib;
      }
      return a.seq - b.seq;
    })
    .map(function (entry) { return entry.item; });
}

/**
 * 分组。
 *
 * · 分组顺序 = 该分类第一次出现的顺序（作者在 yml 里的排法就是页面上的排法，
 *   按字母重排会把「常去之地」这种手写的语义顺序打乱）。
 * · 没写 category 的记录归入一个空分组，**固定排在最后**——「未分类」是
 *   兜底，不该因为它恰好第一条出现就顶到页面最上方。
 *
 * @returns {Array<{category: string, items: Array}>} category 为空串表示未分类，
 *          显示文案由模板取语言包（纯函数不做 i18n）。
 */
function groupBookmarks(flat) {
  var groups = [];
  var index = Object.create(null);
  var uncategorized = null;

  (Array.isArray(flat) ? flat : []).forEach(function (item) {
    if (!item) return;
    var key = trimText(item.category);
    var bucket;

    if (!key) {
      if (!uncategorized) uncategorized = { category: '', items: [] };
      bucket = uncategorized;
    } else {
      if (!(key in index)) {
        index[key] = { category: key, items: [] };
        groups.push(index[key]);
      }
      bucket = index[key];
    }
    bucket.items.push(item);
  });

  groups.forEach(function (group) { group.items = sortWithin(group.items); });
  if (uncategorized) {
    uncategorized.items = sortWithin(uncategorized.items);
    groups.push(uncategorized);
  }

  return groups;
}

module.exports = {
  normalizeUrl: normalizeUrl,
  isUsableUrl: isUsableUrl,
  initialOf: initialOf,
  hostOf: hostOf,
  mergeBookmarks: mergeBookmarks,
  groupBookmarks: groupBookmarks,
  /* 下面几个不是页面直接用的入口，留给测试与调用方观察中间结果 */
  flattenBookmarks: flattenBookmarks,
  flattenLinks: flattenLinks,
  sortWithin: sortWithin
};
