#!/usr/bin/env node
'use strict';

/**
 * 收藏站点合并逻辑回归测试
 *
 * 背景：/links/ 的数据有三个来源——`source/_data/bookmarks.yml`（新格式，
 * 平铺）、`source/_data/links.yml`（老格式，分组，同时供文章页友链组件
 * 使用）、以及 hub 的 `GET /api/bookmarks/public`。三者要合成一份分组列表，
 * 而合并是这个功能里最容易「看着对、实际错一行」的部分：
 *
 *   - 去重的身份是**归一化后的 url**（尾斜杠、主机大小写、fragment 都不算差异）
 *   - 两个本地文件优先级不同（新格式在前），同 URL 只保留优先级高的那条
 *   - 远程只补本地没有的站，同 URL 时本地优先（契约 6.4 节）
 *   - 分组顺序 = 分类首次出现的顺序；未分类固定排最后
 *   - 组内有 sort 的按 sort→id 升序在前，没写 sort 的保持出现顺序在后
 *   - 图标缺失时按域名首字母给一个字符底座，绝不留空
 *
 * 这些规则没法靠跑 `hexo generate` 观察——真实的 yml 恰好没有重名、
 * 没有缺 sort 的项、没有坏 URL，测试就永远发现不了。所以合并被抽成
 * scripts/lib/bookmark-merge.js 的纯函数，这里直接钉住。
 *
 * 用法：
 *   node tools/test-bookmark-merge.js
 *
 * 退出码 0 = 全部通过，1 = 有场景失败。
 * 不依赖 hexo / 网络：只 require 那个纯函数文件。
 */

const assert = require('assert');
const path = require('path');
const bm = require(path.join(__dirname, '..', 'scripts', 'lib', 'bookmark-merge.js'));

const {
  normalizeUrl,
  isUsableUrl,
  initialOf,
  mergeBookmarks,
  groupBookmarks,
} = bm;

const results = [];

/**
 * 跑一个场景。断言用 assert，失败即抛；这里统一收口成一行报告。
 * @param {string} name 场景名（报告里显示）
 * @param {string} rule 一句话说明这条规则在防什么
 * @param {function} fn 断言函数
 */
function scenario(name, rule, fn) {
  let pass = true;
  let detail = '';
  try {
    fn();
  } catch (err) {
    pass = false;
    detail = String(err.message || err).split('\n').join('\n      ');
  }
  results.push(pass);
  console.log('  ' + (pass ? '✓' : '✗') + ' ' + name.padEnd(12) + ' ' + rule);
  if (!pass) console.log('      ' + detail);
}

/** 只取展示用的 name 数组，断言顺序时报告更易读 */
const names = list => list.map(s => s.name);
/** 只取分组名数组 */
const categories = groups => groups.map(g => g.category);

/* ===== fixture ===== */

const NEW_FORMAT = [
  { name: '维基百科', url: 'https://www.wikipedia.org', description: '自由、开放的人类知识总汇', icon: '📚', category: '常去之地', sort: 0 },
  { name: 'Hacker News', url: 'https://news.ycombinator.com', description: '技术社区的精神灯塔', icon: '🚀', category: '常去之地', sort: 1 },
];

const OLD_FORMAT = [
  {
    category: '常去之地',
    items: [
      // 与 NEW_FORMAT 第一条同 URL（只差尾斜杠与 www 大小写），应被去重
      { name: '维基百科(旧)', url: 'https://WWW.Wikipedia.org/', icon: '📕' },
      { name: 'V2EX', url: 'https://www.v2ex.com', description: '分享和探索', icon: '💬' },
    ],
  },
  {
    category: '设计资源',
    items: [
      { name: 'wallhaven', url: 'https://wallhaven.cc', icon: '🖼️' },
    ],
  },
];

/* ===== 场景 ===== */

console.log('收藏站点合并回归测试');
console.log('实现: scripts/lib/bookmark-merge.js');
console.log('');

scenario('URL 归一化', '尾斜杠 / 主机大小写 / fragment 不算差异；query 必须保留', () => {
  /* 规则来自契约 6.1 节，且与订阅侧 lib/subscription-merge.js 逐字一致——
     收藏与订阅在 hub 里就是同一个 normalizeUrl，主题这边若走两套算法，
     同一地址会在两种数据里算出不同的键。 */
  const cases = [
    ['https://Example.COM/feed/',   'https://example.com/feed'],
    ['https://example.com/feed#top', 'https://example.com/feed'],
    ['HTTPS://EXAMPLE.COM/feed',    'https://example.com/feed'],
    ['  https://example.com:443/feed/?alt=rss  ', 'https://example.com/feed?alt=rss'],
    ['https://a.com/?x=1',          'https://a.com?x=1'],
    ['https://a.com/feed?next=/x/', 'https://a.com/feed?next=/x/'],
    ['https://a.com/feed/?q=a/',    'https://a.com/feed?q=a/'],
    ['https://a.com/?',             'https://a.com'],
    ['https://a.com/',              'https://a.com'],
    ['https://a.com',               'https://a.com'],
    ['https://a.com//feed//',       'https://a.com//feed'],
  ];
  cases.forEach(([input, expected]) => {
    assert.strictEqual(normalizeUrl(input), expected, '「' + input + '」归一化不对');
  });

  // 路径大小写保留：/Feed 与 /feed 在 HTTP 里是两个地址
  assert.strictEqual(normalizeUrl('https://a.com/Feed'), 'https://a.com/Feed');
  // 解析不了的地址原样 trim 返回，不静默改写
  assert.strictEqual(normalizeUrl('  not a url '), 'not a url');
  assert.strictEqual(normalizeUrl(null), '');
  assert.strictEqual(normalizeUrl(undefined), '');
  assert.strictEqual(normalizeUrl('   '), '');

  // 归一化必须幂等，否则每次构建的键都可能不同
  ['https://A.com/Feed/#top', 'https://a.com/?x=1', 'https://a.com//feed//'].forEach(u => {
    const once = normalizeUrl(u);
    assert.strictEqual(normalizeUrl(once), once, '归一化不幂等：' + u);
  });
});

scenario('可点性', '只有 http(s) 绝对地址才算可用；javascript: / 相对路径 / 空值都不行', () => {
  assert.strictEqual(isUsableUrl('https://a.com'), true);
  assert.strictEqual(isUsableUrl('http://a.com/x'), true);
  assert.strictEqual(isUsableUrl('javascript:alert(1)'), false);
  assert.strictEqual(isUsableUrl('/relative/path'), false);
  assert.strictEqual(isUsableUrl('a.com'), false);
  assert.strictEqual(isUsableUrl(''), false);
  assert.strictEqual(isUsableUrl(null), false);
  assert.strictEqual(isUsableUrl('mailto:a@b.com'), false);
});

scenario('空/空', '三份来源都空 → 空数组，不报错；null/undefined 输入也不炸', () => {
  assert.deepStrictEqual(mergeBookmarks({}), []);
  assert.deepStrictEqual(mergeBookmarks({ bookmarks: [], links: [], remote: [] }), []);
  assert.deepStrictEqual(mergeBookmarks(null), []);
  assert.deepStrictEqual(mergeBookmarks({ bookmarks: null, links: undefined, remote: null }), []);
});

scenario('仅新格式', 'bookmarks.yml 平铺数组 → 逐条归一化，字段原样保留', () => {
  const out = mergeBookmarks({ bookmarks: NEW_FORMAT });
  assert.deepStrictEqual(names(out), ['维基百科', 'Hacker News']);
  assert.strictEqual(out[0].category, '常去之地');
  assert.strictEqual(out[0].icon, '📚');
  assert.strictEqual(out[1].sort, 1);
});

scenario('仅老格式', 'links.yml 分组 → 展平后继承组名做 category', () => {
  const out = mergeBookmarks({ links: OLD_FORMAT });
  assert.deepStrictEqual(names(out), ['维基百科(旧)', 'V2EX', 'wallhaven']);
  assert.strictEqual(out[0].category, '常去之地', '组名要落成 category');
  assert.strictEqual(out[2].category, '设计资源');
});

scenario('两格式并存', '同 URL 只保留一条：bookmarks.yml 在前，links.yml 里的重复项整条丢弃', () => {
  const out = mergeBookmarks({ bookmarks: NEW_FORMAT, links: OLD_FORMAT });
  // 3 条新 + 2 条旧独有（V2EX / wallhaven）；维基百科在两边都有，只算新格式那条
  assert.deepStrictEqual(names(out), ['维基百科', 'Hacker News', 'V2EX', 'wallhaven']);
  assert.strictEqual(out[0].icon, '📚', '重复时用新格式那条的字段，不混着补');
  assert.strictEqual(out[0].description, '自由、开放的人类知识总汇');
  // 老格式那条的 description 是空的，不该被「补」到新格式记录上
  assert.strictEqual(out[2].description, '分享和探索');
});

scenario('本地优先', '同 URL 本地与远程都有 → 保留本地记录，远程那条整个不要', () => {
  const local = [{ name: '本地名', url: 'https://x.com', description: '本地描述', icon: '🅻', category: '工具' }];
  const remote = [{ id: 1, name: '远程名', url: 'https://x.com/', description: '远程描述', icon: '🌐', category: '远程组' }];
  const out = mergeBookmarks({ bookmarks: local, remote });
  assert.strictEqual(out.length, 1, '应合并成 1 条');
  assert.strictEqual(out[0].name, '本地名');
  assert.strictEqual(out[0].description, '本地描述');
  assert.strictEqual(out[0].category, '工具', '分组也跟本地，不能被远程的组名带走');
});

scenario('远程补全', '远程独有的站并入并带上自己的分类；本地那条不因远程有同名记录而被补字段', () => {
  const local = [{ name: '本地', url: 'https://a.com' }];           // 没有 category
  const remote = [
    { id: 7, name: '远程', url: 'https://b.com', category: '远程组', sort: 0 },
    { id: 9, name: '远程重复', url: 'https://a.com/', category: '别的组' },
  ];
  const out = mergeBookmarks({ bookmarks: local, remote });
  assert.deepStrictEqual(names(out), ['本地', '远程']);
  assert.strictEqual(out[0].category, '', '本地记录不补远程的字段，只在远程独有时整条并入');
  assert.strictEqual(out[1].category, '远程组', '远程独有条目要带上自己的分类');
});

scenario('远程顺序', '远程并入时保持服务端给的顺序（契约 6.2 节已排好 category/sort/id）', () => {
  const remote = [
    { id: 1, name: '第一个', url: 'https://a.com', category: 'A', sort: 0 },
    { id: 2, name: '第二个', url: 'https://b.com', category: 'A', sort: 0 },
    { id: 3, name: '第三个', url: 'https://c.com', category: 'B', sort: 0 },
  ];
  assert.deepStrictEqual(names(mergeBookmarks({ remote })), ['第一个', '第二个', '第三个']);
});

scenario('分组顺序', '分组按分类首次出现的顺序；未分类固定排最后', () => {
  const flat = mergeBookmarks({
    bookmarks: [
      { name: 'a', url: 'https://a.com', category: '常去之地' },
      { name: 'b', url: 'https://b.com' },                    // 未分类，但它先于「设计资源」出现
      { name: 'c', url: 'https://c.com', category: '设计资源' },
      { name: 'd', url: 'https://d.com', category: '常去之地' },
    ],
  });
  const groups = groupBookmarks(flat);
  /* 未分类排在最后这一条很关键：它若按出现顺序插到中间，页面就会出现
     一个「未分类」夹在两个正经分类之间，像漏配了某个字段。 */
  assert.deepStrictEqual(categories(groups), ['常去之地', '设计资源', '']);
  assert.deepStrictEqual(names(groups[0].items), ['a', 'd']);
  assert.deepStrictEqual(names(groups[2].items), ['b']);
});

scenario('分组兼容', '没有 category 的旧数据（纯平铺 links.yml）→ 全归未分类，不报警不丢条', () => {
  const flat = mergeBookmarks({
    bookmarks: [
      { name: 'x', url: 'https://x.com' },
      { name: 'y', url: 'https://y.com' },
    ],
  });
  const groups = groupBookmarks(flat);
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].category, '');
  assert.deepStrictEqual(names(groups[0].items), ['x', 'y']);
});

scenario('组内排序', '有 sort 的按 sort→id 升序在前；没写 sort 的保持出现顺序在后', () => {
  /* 这条防的是一个很容易犯的错：把「没写 sort」当成 0。那样一组里手排好的
     顺序会当场失效——没写 sort 的条目全部插到最前面。 */
  const flat = mergeBookmarks({
    bookmarks: [
      { name: '无sort-1', url: 'https://n1.com', category: 'G' },
      { name: 'sort-20', url: 'https://s20.com', category: 'G', sort: 20 },
      { name: '无sort-2', url: 'https://n2.com', category: 'G' },
      { name: 'sort-0', url: 'https://s0.com', category: 'G', sort: 0 },
      { name: 'sort-10', url: 'https://s10.com', category: 'G', sort: 10 },
    ],
  });
  const groups = groupBookmarks(flat);
  assert.deepStrictEqual(names(groups[0].items), [
    'sort-0',    // 0
    'sort-10',   // 10
    'sort-20',   // 20
    '无sort-1',  // 没写 sort，按出现顺序接在后面
    '无sort-2',
  ]);
});

scenario('同 sort 排序', 'sort 相同 → 按 id 升序；缺 id 排到同 sort 的末尾', () => {
  const remote = [
    { id: 3, name: 'id3', url: 'https://a.com', category: 'G', sort: 5 },
    { name: '无id', url: 'https://b.com', category: 'G', sort: 5 },
    { id: 1, name: 'id1', url: 'https://c.com', category: 'G', sort: 5 },
  ];
  assert.deepStrictEqual(names(groupBookmarks(mergeBookmarks({ remote }))[0].items), [
    'id1', 'id3', '无id',
  ]);
});

scenario('sort 边界', 'sort: 0 是合法值（不能当没写）；字符串 "0" 也认', () => {
  const flat = mergeBookmarks({
    bookmarks: [
      { name: '无sort', url: 'https://a.com', category: 'G' },
      { name: '零', url: 'https://b.com', category: 'G', sort: 0 },
      { name: '字符零', url: 'https://c.com', category: 'G', sort: '0' },
      { name: '负', url: 'https://d.com', category: 'G', sort: -1 },
    ],
  });
  assert.deepStrictEqual(names(groupBookmarks(flat)[0].items), ['负', '零', '字符零', '无sort']);
});

scenario('图标兜底', '有 icon 用 icon；没有则取域名首字母（去 www.、大写）', () => {
  assert.strictEqual(initialOf({ url: 'https://www.wikipedia.org' }), 'W');
  assert.strictEqual(initialOf({ url: 'https://v2ex.com' }), 'V');
  assert.strictEqual(initialOf({ url: 'https://news.ycombinator.com' }), 'N');
  /* IDN 的 punycode 形式（xn-- 开头）首字母永远是 x：一堆中文站会全变成 X，
     一片 X 底座等于没有图标。这种情况退用标题首字。 */
  assert.strictEqual(
    initialOf({ url: 'https://xn--fiqs8s.example', name: '中国' }),
    '中',
    'punycode 主机名不该一律标成 X'
  );
  // 解析不了的地址退到标题首字
  assert.strictEqual(initialOf({ url: 'nope', name: '某站' }), '某');
  // 什么都没有时不能返回空串（否则模板会画出空底座）
  assert.strictEqual(initialOf({}), '?');
});

scenario('缺字段', 'name 缺失时用主机名兜底；description/icon 缺失是空串不是 undefined', () => {
  const out = mergeBookmarks({
    bookmarks: [{ url: 'https://www.example.com/path' }],
  });
  assert.deepStrictEqual(out, [{
    url: 'https://www.example.com/path',
    name: 'example.com',       // 去掉 www. 的主机名
    description: '',
    icon: '',
    category: '',
    sort: null,
    id: null,
    initial: 'E',
  }]);
});

scenario('脏数据', '非对象项跳过；缺 url 的记录丢弃；坏 URL 保留但会被页面层过滤掉', () => {
  const out = mergeBookmarks({
    bookmarks: [null, 'oops', { name: '无url' }, { name: '正常', url: 'https://ok.com' }, { name: '坏', url: 'not a url' }],
    links: [null, { category: 'G' }, { category: 'G', items: [null, { name: '缺url' }] }],
    remote: [undefined, { id: 1, name: '远程', url: 'https://r.com' }],
  });
  /* 坏 URL 不在这里丢掉：合并层只负责「是不是同一个站」，能不能点由
     isUsableUrl 在页面组装时判断。分开的好处是测试能分别验证两件事，
     而不是在一处含糊地「有问题就吞掉」。 */
  assert.deepStrictEqual(names(out), ['正常', '坏', '远程']);
  assert.strictEqual(out.every(Boolean), true);
});

scenario('不改入参', '合并返回新数组/新对象，调用方的数据不得被就地改写', () => {
  const bookmarks = JSON.parse(JSON.stringify(NEW_FORMAT));
  const links = JSON.parse(JSON.stringify(OLD_FORMAT));
  const remote = [{ id: 1, name: '远程', url: 'https://remote.com', category: 'R' }];
  const snapshot = JSON.parse(JSON.stringify({ bookmarks, links, remote }));

  const out = mergeBookmarks({ bookmarks, links, remote });
  assert.deepStrictEqual({ bookmarks, links, remote }, snapshot, '入参被改动了');
  assert.notStrictEqual(out[0], bookmarks[0], '返回的应是新对象，不是入参的引用');
});

scenario('输出归一化', '合并结果的 url 必须是归一化形式（它同时是 href 与去重键）', () => {
  const out = mergeBookmarks({
    bookmarks: [{ name: 'A', url: 'https://A.example/Path/#top' }],
    links: [{ category: 'G', items: [{ name: 'B', url: 'https://b.example/' }] }],
    remote: [{ id: 1, name: 'C', url: 'HTTPS://C.example/x/' }],
  });
  out.forEach(item => {
    assert.strictEqual(normalizeUrl(item.url), item.url, '输出应已归一化：' + item.url);
    assert.strictEqual(isUsableUrl(item.url), true, '输出应可点：' + item.url);
  });
  assert.deepStrictEqual(names(out), ['A', 'B', 'C']);
});

scenario('空态', '全空 → groupBookmarks 返回空数组，模板据此渲染空状态', () => {
  const groups = groupBookmarks(mergeBookmarks({ bookmarks: [], links: [], remote: [] }));
  assert.deepStrictEqual(groups, []);
  // 传 null 也不能炸
  assert.deepStrictEqual(groupBookmarks(null), []);
  assert.deepStrictEqual(groupBookmarks([]), []);
});

scenario('与订阅同口径', '收藏与订阅的 URL 归一化必须逐字一致（同一个 normalizeUrl）', () => {
  /* hub 里书签与订阅共用同一个 normalizeUrl（bookmarks.ts 直接 import
     订阅那份）。主题这边若分叉，会出现「同一地址在两种数据里算出不同的键」，
     表现为收藏页与订阅页对同一个站给出不同的身份。这里直接对拍两份实现。 */
  const feeds = require(path.join(__dirname, '..', 'scripts', 'lib', 'subscription-merge.js'));
  const samples = [
    'https://a.com/feed/',
    'https://A.com/Feed/#top',
    'https://a.com/feed?next=/x/',
    'https://a.com/?x=1',
    'https://a.com//feed//',
    'http://a.com:8080/feed/',
    'not a url',
    '',
    null,
    'https://a.com/?',
  ];
  samples.forEach(s => {
    assert.strictEqual(
      normalizeUrl(s),
      feeds.normalizeFeedUrl(s),
      '两个模块对「' + s + '」的归一化结果不一致'
    );
  });
});

/* ===== 汇总 ===== */

const ok = results.filter(Boolean).length;
console.log('');
console.log(ok + '/' + results.length + ' 通过');
process.exit(ok === results.length ? 0 : 1);
