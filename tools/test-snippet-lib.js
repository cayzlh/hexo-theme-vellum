#!/usr/bin/env node
'use strict';

/**
 * 一行笔记规整逻辑回归测试
 *
 * 背景：/snippets/ 的数据全部来自手写的 `source/_data/snippets.yml`。
 * 手写数据文件的常态就是「有时候多打一个空格、有时候忘了写 title、有时候
 * 中文标题起得挺好但拿去做锚点就废了」。而这些恰好是没法靠跑
 * `hexo generate` 观察的——真实的那一条数据格式完全正常，跑一遍只会看到
 * 「一切正常」。
 *
 * 真正要钉死的是这四件事：
 *   1. **脏数据不能让构建挂掉**，也不能产出半条残废记录；
 *   2. **锚点必须稳定且唯一**——页面上的 `id` 与搜索索引里的 `#slug` 同源，
 *      一旦漂移，从搜索结果点进来就跳不到那一条；
 *   3. **分组顺序与组内顺序**要按作者在 yml 里写的意思来；
 *   4. **搜索文本必须含命令**——这是整个功能最主要的检索动机
 *      （「我上次那条激活命令是什么来着」）。
 *
 * 用法：
 *   node tools/test-snippet-lib.js
 *
 * 退出码 0 = 全部通过，1 = 有场景失败。
 * 不依赖 hexo / 网络：只 require 那个纯函数文件。
 */

const assert = require('assert');
const path = require('path');
const sn = require(path.join(__dirname, '..', 'scripts', 'lib', 'snippet-lib.js'));

const {
  normalizeAll,
  normalizeItem,
  slugify,
  assignSlugs,
  groupSnippets,
  sortWithin,
  toSearchEntries,
  countStats,
} = sn;

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

console.log('\n一行笔记规整逻辑\n');

/* ==========================================================================
   1. 清洗：脏数据不能让构建挂掉，也不能产出半条记录
   ========================================================================== */

scenario('缺 title', '没有 title 的记录整条丢掉，而不是渲染成一行孤零零的代码', () => {
  const list = normalizeAll([
    { command: 'echo hi' },                  // 无 title → 丢
    { title: '   ' },                        // 空白 title → 丢
    { title: '正常', command: 'ls' },
  ]);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].title, '正常');
});

scenario('非数组', 'yml 顶层写成对象/字符串时返回空数组，不抛错', () => {
  assert.deepStrictEqual(normalizeAll(null), []);
  assert.deepStrictEqual(normalizeAll({ title: 'x' }), []);
  assert.deepStrictEqual(normalizeAll('nonsense'), []);
});

scenario('tag 逗号串', 'tags 写成逗号串时自动切成数组，下游不必再判类型', () => {
  const item = normalizeItem({ title: 't', tags: ' Windows , 激活 ,, MAS ' });
  assert.deepStrictEqual(item.tags, ['Windows', '激活', 'MAS']);
});

scenario('tag 非数组', 'tags 写成数字/对象时不炸，收敛成空数组', () => {
  assert.deepStrictEqual(normalizeItem({ title: 't', tags: 123 }).tags, []);
  assert.deepStrictEqual(normalizeItem({ title: 't' }).tags, []);
});

scenario('sort 字符串', 'sort 写成字符串数字时按数字理解', () => {
  assert.strictEqual(normalizeItem({ title: 't', sort: '3' }).sort, 3);
  assert.strictEqual(normalizeItem({ title: 't', sort: 'abc' }).sort, null);
  assert.strictEqual(normalizeItem({ title: 't' }).sort, null);
});

scenario('字段修剪', '各字段首尾空白被去掉，url 里混进空格也不会坏', () => {
  const item = normalizeItem({
    title: '  t  ',
    command: '  ls -al  ',
    url: '  https://a.com  ',
    lang: '  ',
  });
  assert.strictEqual(item.title, 't');
  assert.strictEqual(item.command, 'ls -al');
  assert.strictEqual(item.url, 'https://a.com');
  assert.strictEqual(item.lang, 'text', 'lang 留空时回落 text');
});

scenario('category 缺省', '没写 category 的落到未分类哨兵（null），不是空串', () => {
  assert.strictEqual(normalizeItem({ title: 't' }).category, null);
  assert.strictEqual(normalizeItem({ title: 't', category: '  ' }).category, null);
  assert.strictEqual(normalizeItem({ title: 't', category: '系统' }).category, '系统');
});

/* ==========================================================================
   2. 锚点：稳定、唯一、可寻址
   ========================================================================== */

scenario('slug 英文', 'ASCII 标题转成可读的小写连字符串', () => {
  assert.strictEqual(slugify('Windows Activation'), 'windows-activation');
  assert.strictEqual(slugify('  MAS / Windows!! '), 'mas-windows');
});

scenario('slug 中文', '纯中文标题得到空串——调用方必须退回序号，不能留空 id', () => {
  assert.strictEqual(slugify('系统激活'), '');
});

scenario('slug 唯一', '重名标题自动追加序号，不会产出重复 id', () => {
  const list = assignSlugs([
    { title: 'dup' },
    { title: 'dup' },
    { title: 'dup' },
  ]);
  assert.deepStrictEqual(list.map((x) => x.slug), ['dup', 'dup-2', 'dup-3']);
});

scenario('slug 兜底', '中文标题按输入序号拿到 snippet-N 锚点', () => {
  const list = assignSlugs([
    { title: '系统激活' },
    { title: '网络' },
  ]);
  assert.deepStrictEqual(list.map((x) => x.slug), ['snippet-1', 'snippet-2']);
});

scenario('slug 稳定', '同一份输入两次运行产出完全相同的锚点（搜索索引与页面不漂移）', () => {
  const input = [
    { title: '系统激活' },
    { title: 'npm cache' },
    { title: 'npm cache' },
  ];
  const a = assignSlugs(input.map((x) => ({ ...x })));
  const b = assignSlugs(input.map((x) => ({ ...x })));
  assert.deepStrictEqual(a.map((x) => x.slug), b.map((x) => x.slug));
});

scenario('中文不冲突', '中文标题的兜底锚点与显式 snippet-N 标题不会撞车', () => {
  const list = assignSlugs([
    { title: 'System activation' },  // → system-activation
    { title: '系统激活' },            // → snippet-2
    { title: 'Snippet 2' },           // → snippet-2 → 被占，变 snippet-2-2
  ]);
  const slugs = list.map((x) => x.slug);
  assert.strictEqual(new Set(slugs).size, slugs.length, '锚点必须互不相同');
});

/* ==========================================================================
   3. 分组与排序
   ========================================================================== */

scenario('分组顺序', '分组按分类首次出现的顺序排列，不是字典序', () => {
  const list = normalizeAll([
    { title: 'a', category: '系统' },
    { title: 'b', category: '网络' },
    { title: 'c', category: '系统' },
  ]);
  const groups = groupSnippets(list);
  assert.deepStrictEqual(groups.map((g) => g.category), ['系统', '网络']);
  assert.strictEqual(groups[0].items.length, 2);
});

scenario('未分类末位', '未分类固定排在所有分类最后，即使它最先出现', () => {
  const list = normalizeAll([
    { title: 'x' },                      // 无分类
    { title: 'a', category: '系统' },
  ]);
  const groups = groupSnippets(list);
  assert.strictEqual(groups[groups.length - 1].category, null);
});

scenario('组内排序', '写了 sort 的按 sort 升序在前，没写的保持出场顺序排后', () => {
  const list = normalizeAll([
    { title: 'no-sort-1', category: 'c' },
    { title: 's2', category: 'c', sort: 2 },
    { title: 'no-sort-2', category: 'c' },
    { title: 's0', category: 'c', sort: 0 },
  ]);
  const items = groupSnippets(list)[0].items.map((x) => x.title);
  assert.deepStrictEqual(items, ['s0', 's2', 'no-sort-1', 'no-sort-2']);
});

scenario('sort 稳定', 'sort 相同时按出场顺序，不会每次构建抖一次', () => {
  const items = [
    { title: 'a', sort: 1, order: 0 },
    { title: 'b', sort: 1, order: 1 },
    { title: 'c', sort: 1, order: 2 },
  ];
  const out = sortWithin(items);
  assert.deepStrictEqual(out.map((x) => x.title), ['a', 'b', 'c']);
});

/* ==========================================================================
   4. 搜索索引
   ========================================================================== */

scenario('搜索含命令', '命令文本必须进搜索正文——这是最主要的检索动机', () => {
  const list = normalizeAll([
    {
      title: 'Windows 激活',
      command: 'irm https://get.activated.win | iex',
      tags: ['Windows'],
    },
  ]);
  const docs = toSearchEntries(list, '/snippets/');
  assert.strictEqual(docs.length, 1);
  const row = docs[0];
  assert.ok(row.text.includes('irm https://get.activated.win | iex'), '正文里必须有命令原文');
  assert.strictEqual(row.title, 'Windows 激活');
});

scenario('搜索锚点', 'url 带 #slug 锚点，点搜索结果直接落到那一条', () => {
  const list = normalizeAll([{ title: 'Alpha' }, { title: 'Beta' }]);
  const docs = toSearchEntries(list, '/snippets/');
  assert.strictEqual(docs[0].url, '/snippets/#alpha');
  assert.strictEqual(docs[1].url, '/snippets/#beta');
});

/* ★ 回归：toSearchEntries 一度直接返回数组，而 search-index.js 按对象取
   d.title / d.url，两套形状对撞后索引里出现 [null, null, '', '', null]。
   这条钉住「必须是带字段名的对象」这个契约。 */
scenario('搜索条目形状', '返回带字段名的对象，与 collectDocs/collectDossierDocs 一致', () => {
  const list = normalizeAll([{ title: 'T', command: 'cmd', tags: ['a', 'b'] }]);
  const entry = toSearchEntries(list, '/snippets/')[0];
  assert.ok(!Array.isArray(entry), '不能是数组——生成器按对象字段取值');
  ['title', 'url', 'tags', 'date', 'text'].forEach((k) => {
    assert.ok(Object.prototype.hasOwnProperty.call(entry, k), '缺少字段 ' + k);
  });
  assert.deepStrictEqual(entry.tags, ['a', 'b'], 'tags 是数组，由生成器负责 join');
  assert.strictEqual(entry.date, '', 'date 必须留空：一行笔记没有发布时间');
});

scenario('搜索路径', 'pagePath 缺尾斜杠/传空时也能拼出正确 URL', () => {
  const list = normalizeAll([{ title: 'A' }]);
  assert.strictEqual(toSearchEntries(list, '/snippets')[0].url, '/snippets/#a');
  assert.strictEqual(toSearchEntries(list, '')[0].url, '/snippets/#a');
  assert.strictEqual(toSearchEntries(list, null)[0].url, '/snippets/#a');
});

/* ==========================================================================
   5. 统计
   ========================================================================== */

scenario('统计', '总条数与分类数（未分类也算一类）', () => {
  const list = normalizeAll([
    { title: 'a', category: '系统' },
    { title: 'b', category: '系统' },
    { title: 'c' },
  ]);
  assert.deepStrictEqual(countStats(list), { total: 3, categoryCount: 2 });
});

scenario('统计空', '空列表统计全为 0，页面可以据此走空状态', () => {
  assert.deepStrictEqual(countStats([]), { total: 0, categoryCount: 0 });
});

/* ==========================================================================
   汇总
   ========================================================================== */

const passed = results.filter(Boolean).length;
const failed = results.length - passed;
console.log('\n  ' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed === 0 ? 0 : 1);
