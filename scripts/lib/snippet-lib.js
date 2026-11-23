'use strict';

/**
 * Vellum — 一行笔记规整核心（纯函数）
 *
 * 为什么单独抽一个文件，而不是塞在 scripts/snippets.js 里：
 *   1. **要能单测**。这里的规则（脏数据清洗、空条目剔除、slug 生成与去重、
 *      分组顺序、未分类排最后、搜索文本拼装）全是「看着对、实际错一行」的
 *      地方，而它们几乎没法靠跑 `hexo generate` 观察——真实的 yml 恰好没有
 *      缺 title 的条目、没有重名 slug，测试就永远发现不了。
 *   2. **契约归属清楚**。同一个 slug 会同时出现在三处：页面上卡片的锚点
 *      （#slug）、全站搜索索引里那条记录的 url（/snippets/#slug）、以及
 *      前端 filter 用的 data-key。三处必须由同一份算法产出，否则「从搜索
 *      结果点进来却跳不到那一条」。
 *
 * 本文件不 require hexo、不读配置、不打日志——给定输入就有确定输出。
 *
 * 用法：
 *   var sn = require('./lib/snippet-lib');
 *   sn.normalizeAll(rawData);   // 清洗 yml 读出来的数组
 *   sn.groupSnippets(list);     // [{ category, items }]
 *   sn.toSearchEntries(list, '/snippets/');  // 搜索索引条目
 */

/* 未分类的条目固定排在所有分组最后。用一个不可能与真实分类重名的哨兵
   值来标记，而不是在排序里特判 null——特判会在「用户真建了一个叫
   '未分类' 的分类」时把两批条目混到一起。 */
var UNCATEGORIZED = null;

/**
 * 一条记录里所有对外可见的文本来源，按「越靠前越像标题」排列。
 * 拼搜索文本时用得到，也让「哪几处能搜到」这件事只在这里定义一次。
 */
function textPieces(item) {
  return [item.title, item.desc, item.command, (item.tags || []).join(' ')];
}

/** 把任意值收敛成去首尾空白的字符串；null / undefined → ''。 */
function str(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

/**
 * 生成锚点 slug。
 *
 * 中文标题在浏览器的 `id` 里完全合法，但直接把中文塞进 URL fragment 会让
 * 复制出来的链接变成一长串百分号编码（`#%E7%B3%BB%E7%BB%9F`），既不可读也
 * 容易被某些 IM 截断。所以规则是：
 *   · 只保留 ASCII 字母数字，转小写，连续非字母数字压成单个 '-'；
 *   · 中文/日文等非 ASCII 标题会因此得到空串——这时**退回序号**
 *     （snippet-1、snippet-2），保证仍然可寻址。
 *
 * 注意：slug 只用于锚点，不参与「唯一性之外」的任何判断。
 */
function slugify(title) {
  var s = str(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s;
}

/**
 * 给整份列表分配唯一 slug。
 *
 * 去重规则：重名的第 2 条起追加 `-2`、`-3`……；空 slug 用 `snippet-<序号>`。
 * 分配顺序就是输入顺序，所以同一份 yml 每次构建出来的锚点完全一样
 * （搜索索引和页面锚点不会因为构建顺序漂移而对不上）。
 */
function assignSlugs(list) {
  var used = Object.create(null);
  var counter = 0;

  list.forEach(function (item) {
    counter += 1;
    var base = slugify(item.title) || ('snippet-' + counter);
    var slug = base;
    var n = 1;
    while (used[slug]) {
      n += 1;
      slug = base + '-' + n;
    }
    used[slug] = true;
    item.slug = slug;
  });

  return list;
}

/**
 * 清洗一条原始记录。返回 null 表示这条该被整条丢掉。
 *
 * 丢掉的判断只有一条：**没有 title**。没有 title 的条目在页面上只剩一行
 * 代码，读者无从知道它是干什么的；而 command / desc 都可能是空的
 * （纯提示类笔记也合法），所以只以 title 为准。
 *
 * 容错都在这里收口：yml 里 tag 写成逗号串、sort 写成字符串数字、
 * url 带首尾空格——这些是手写数据文件最常见的形态，不该让整站构建挂掉。
 */
function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;

  var title = str(raw.title);
  if (!title) return null;

  /* 单值也会被 YAML 读成字符串；这里统一成数组，下游就不用再判一次类型。 */
  var tags = raw.tags;
  if (typeof tags === 'string') {
    tags = tags.split(',').map(str).filter(Boolean);
  } else if (!Array.isArray(tags)) {
    tags = [];
  }
  tags = tags.map(str).filter(Boolean);

  var sort = parseInt(raw.sort, 10);

  return {
    title: title,
    command: str(raw.command),
    desc: str(raw.desc),
    category: str(raw.category) || UNCATEGORIZED,
    tags: tags,
    lang: str(raw.lang) || 'text',
    url: str(raw.url),
    sort: isFinite(sort) ? sort : null,
    /* 保留原始顺序，组内排序用得上（没写 sort 的保持出场顺序）。 */
    order: 0
  };
}

/**
 * 清洗整份数据并分配锚点。
 *
 * @param {Array} raw yml 读出来的数组
 * @returns {Array} 已清洗、已分配 slug 的列表（可能为空数组）
 */
function normalizeAll(raw) {
  var out = [];
  if (!Array.isArray(raw)) return out;

  raw.forEach(function (rawItem) {
    var item = normalizeItem(rawItem);
    if (item) {
      item.order = out.length;
      out.push(item);
    }
  });

  return assignSlugs(out);
}

/**
 * 组内排序：有 sort 的按 sort 升序在前，没写的保持出场顺序排在后面。
 *
 * 为什么没写的排后面而不是按 0 处理：写了 sort 的人是明确表达过顺序意图的，
 * 让没表态的条目插到他们中间，等于把精心排好的顺序打乱。
 */
function sortWithin(items) {
  return items.slice().sort(function (a, b) {
    var as = a.sort === null || a.sort === undefined;
    var bs = b.sort === null || b.sort === undefined;
    if (as && bs) return a.order - b.order;
    if (as) return 1;
    if (bs) return -1;
    if (a.sort !== b.sort) return a.sort - b.sort;
    return a.order - b.order;
  });
}

/**
 * 按 category 分组。
 *
 * 分组顺序 = 分类**首次出现**的顺序（不按名称字典序）：作者在 yml 里
 * 先写哪个分类，页面上就先把哪个分类摆出来，这是最可控的人工排序。
 * 未分类固定压到最后。
 *
 * @returns {Array<{category: string, items: Array}>}
 */
function groupSnippets(list) {
  var order = [];
  var buckets = Object.create(null);

  list.forEach(function (item) {
    var key = item.category || UNCATEGORIZED;
    if (!buckets[key]) {
      buckets[key] = [];
      order.push(key);
    }
    buckets[key].push(item);
  });

  /* 未分类移到末尾；order 里本来没有它就不动。 */
  var idx = order.indexOf(UNCATEGORIZED);
  if (idx !== -1) order.splice(idx, 1), order.push(UNCATEGORIZED);

  return order.map(function (key) {
    return {
      category: key,
      items: sortWithin(buckets[key])
    };
  });
}

/**
 * 把一行笔记转成搜索索引的**中间条目对象**。
 *
 * 返回对象而不是数组，是为了对齐 scripts/search-index.js 内部
 * collectDocs / collectDossierDocs 的形状：那两处都产出
 * `{ title, url, tags, date, text }`，最后统一由生成器映射成
 * `[title, url, tags, date, text]` 的紧凑数组。
 *
 * ★ 这里曾经直接返回数组，结果两套形状在生成器里对撞——生成器按对象取
 *   `d.title`，拿到 undefined，索引里就出现 `[null, null, '', '', null]`
 *   这一行。形状只有一个来源才不会重演。
 *
 * 几个刻意的选择：
 *   · **url 带 `#slug` 锚点**。点搜索结果应当直接落到那一条，而不是页面
 *     顶部再让读者自己找。锚点由本文件的 assignSlugs 产出，与模板里渲染的
 *     id 同源。
 *   · **date 留空**。一行笔记不是文章，没有「发布时间」这回事；硬塞一个
 *     构建日期会让搜索结果显示成一个误导性的时间。
 *   · **text 里必须包含 command**。这是整个功能里最容易被搜的东西
 *     （「我上次那条激活命令是什么命令来着」），丢掉它等于白做。
 */
function toSearchEntries(list, pagePath) {
  var base = str(pagePath) || '/snippets/';
  if (base.charAt(base.length - 1) !== '/') base += '/';

  return list.map(function (item) {
    var text = textPieces(item).filter(Boolean).join(' · ');
    return {
      title: item.title,
      url: base + '#' + item.slug,
      tags: item.tags || [],
      date: '',
      text: text
    };
  });
}

/** 统计用：总条数与分组数。页头 kicker 用得到。 */
function countStats(list) {
  var cats = Object.create(null);
  list.forEach(function (item) {
    cats[item.category || ''] = true;
  });
  return {
    total: list.length,
    categoryCount: Object.keys(cats).length
  };
}

module.exports = {
  UNCATEGORIZED: UNCATEGORIZED,
  str: str,
  slugify: slugify,
  assignSlugs: assignSlugs,
  normalizeItem: normalizeItem,
  normalizeAll: normalizeAll,
  sortWithin: sortWithin,
  groupSnippets: groupSnippets,
  toSearchEntries: toSearchEntries,
  countStats: countStats
};
