#!/usr/bin/env node
'use strict';

/**
 * 一行笔记页前端行为回归测试（/snippets/）
 *
 * 为什么要真跑 DOM 而不是只测纯函数：过滤与复制都是「绑事件 + 改 DOM」的
 * 逻辑，最容易错的地方全在浏览器侧——选择器写错、hidden 被 CSS 的
 * display:flex 压过、分组空壳没清干净。这些在纯函数测试里一条都测不到，
 * 而肉眼验收一次也就只看得到「我现在这几个词搜得出来」。
 *
 * 跑法：拿构建好的 public/snippets/index.html，在 jsdom 里加载
 * 主题的 source/js/snippets.js，然后模拟输入与点击。
 *
 *   node tools/test-snippets-page.js [站点根目录]
 *
 * 默认站点根目录取 ../../.. 相对本文件（即 cayzlh-blog），因为 public/
 * 是站点产物，不在主题仓库里。site 根目录下找不到 public/snippets/index.html
 * 时跳过（退出码 0），避免在主题单独 clone 时误报失败。
 *
 * 退出码 0 = 全部通过（或跳过），1 = 有场景失败。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const THEME_ROOT = path.join(__dirname, '..');
const JS_FILE = path.join(THEME_ROOT, 'source', 'js', 'snippets.js');

/* public/ 是站点产物：允许从上两级/三级找，找不到就跳过。 */
function findPage() {
  const arg = process.argv[2];
  const candidates = [];
  if (arg) candidates.push(path.join(arg, 'public', 'snippets', 'index.html'));
  candidates.push(path.join(THEME_ROOT, '..', '..', 'public', 'snippets', 'index.html'));
  candidates.push(path.join(process.cwd(), 'public', 'snippets', 'index.html'));
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

const pagePath = findPage();
if (!pagePath) {
  console.log('\n一行笔记页前端测试：找不到 public/snippets/index.html，跳过。');
  console.log('先 cd cayzlh-blog && npx hexo generate，或在主题仓库单独跑纯函数测试：');
  console.log('  node tools/test-snippet-lib.js\n');
  process.exit(0);
}

let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch (e) {
  console.log('\n一行笔记页前端测试：缺少 jsdom，跳过（npm i -D jsdom 后可运行）。\n');
  process.exit(0);
}

const html = fs.readFileSync(pagePath, 'utf8');
const script = fs.readFileSync(JS_FILE, 'utf8');

const results = [];

/**
 * 每个场景都从一个干净的 DOM 开始，避免「上一个场景改了 hidden」这种
 * 跨场景污染——那样失败原因会指向错误的场景。
 */
function withPage(fn) {
  const dom = new JSDOM(html, {
    url: 'http://localhost/snippets/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;

  /* 页面里 window.tr 是 head 内联脚本注入的；这里把它要的词典键补上，
     因为没有真实加载 head 内的 <script>。 */
  window.__VELLUM_I18N = {
    'snippets.no_match': '没有匹配的记录',
    'snippets.match_count': '匹配 %d 条',
    'snippets.copied': '已复制',
    'common.copy_failed': '复制失败',
  };
  window.tr = function (key) {
    const args = Array.prototype.slice.call(arguments, 1);
    const str = window.__VELLUM_I18N[key];
    if (str == null) return '';
    let i = 0;
    return String(str).replace(/%(s|d|%)/g, (m, kind) => {
      if (kind === '%') return '%';
      if (i >= args.length) return m;
      return String(args[i++]);
    });
  };

  /* jsdom 默认没有剪贴板：给一个可观测的替身，用来断言「复制的确实是命令原文」。 */
  const clip = { written: [] };
  Object.defineProperty(window.navigator, 'clipboard', {
    value: {
      writeText(t) {
        clip.written.push(t);
        return Promise.resolve();
      },
    },
    configurable: true,
  });

  window.eval(script);
  return fn(window, dom, clip);
}

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

/* 防抖是 120ms，等 200ms 再断言，留足余量。 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\n一行笔记页前端行为（' + pagePath.replace(process.cwd(), '.') + '）\n');

/* 同步场景：初始化状态 */

scenario('清空按钮初始', '输入为空时清除按钮不显示（hidden 必须真的隐身）', () => {
  withPage((window) => {
    const btn = window.document.getElementById('snippetsFilterClear');
    assert.ok(btn, '找不到清除按钮');
    assert.strictEqual(btn.hidden, true, '初始应为 hidden');
  });
});

scenario('卡片锚点', '每张卡片都有 id，且页面里没有重复锚点', () => {
  withPage((window) => {
    const cards = window.document.querySelectorAll('.snippet-card');
    assert.ok(cards.length > 0, '页面里没有卡片');
    const ids = [];
    cards.forEach((c) => ids.push(c.id));
    assert.ok(ids.every((x) => x), '存在没有 id 的卡片');
    assert.strictEqual(new Set(ids).size, ids.length, '存在重复 id');
  });
});

scenario('卡片有副本', '每张有命令的卡片都带一个 data-copy 非空的复制按钮', () => {
  withPage((window) => {
    const pres = window.document.querySelectorAll('.snippet-card__pre');
    assert.ok(pres.length > 0, '没有命令块');
    window.document.querySelectorAll('.snippet-card__copy').forEach((btn) => {
      assert.ok((btn.getAttribute('data-copy') || '').trim(), '复制按钮的 data-copy 是空的');
    });
  });
});

/* 异步场景：过滤 + 复制 */

(async () => {
  await (async () => {
    let pass = true;
    let detail = '';
    try {
      await withPage(async (window) => {
        const input = window.document.getElementById('snippetsFilterInput');
        assert.ok(input, '找不到过滤输入框');

        input.value = 'zzz-不可能匹配-zzz';
        input.dispatchEvent(new window.Event('input'));
        await wait(200);

        const status = window.document.getElementById('snippetsStatus');
        assert.strictEqual(status.textContent, '没有匹配的记录', '应提示无匹配');

        const visible = Array.prototype.filter.call(
          window.document.querySelectorAll('.snippet-card'),
          (c) => !c.hidden
        );
        assert.strictEqual(visible.length, 0, '无匹配时不应有卡片可见');
      });
    } catch (err) {
      pass = false;
      detail = String(err.message || err);
    }
    results.push(pass);
    console.log('  ' + (pass ? '✓' : '✗') + ' ' + '无匹配'.padEnd(12) + ' 搜不到任何东西时：卡片全隐藏 + 状态行给出提示');
    if (!pass) console.log('      ' + detail);
  })();

  await (async () => {
    let pass = true;
    let detail = '';
    try {
      await withPage(async (window) => {
        const input = window.document.getElementById('snippetsFilterInput');
        input.value = 'irm';
        input.dispatchEvent(new window.Event('input'));
        await wait(200);

        const status = window.document.getElementById('snippetsStatus');
        assert.strictEqual(status.textContent, '匹配 1 条', '应提示匹配 1 条');

        const clear = window.document.getElementById('snippetsFilterClear');
        assert.strictEqual(clear.hidden, false, '有输入时清除按钮应显示');

        const groups = window.document.querySelectorAll('.snippets-group');
        groups.forEach((g) => {
          const any = g.querySelector('.snippet-card:not([hidden])');
          assert.strictEqual(g.hidden, !any, '分组显隐与组内是否还有可见卡片不一致');
        });
      });
    } catch (err) {
      pass = false;
      detail = String(err.message || err);
    }
    results.push(pass);
    console.log('  ' + (pass ? '✓' : '✗') + ' ' + '命令可搜'.padEnd(12) + ' 搜命令正文能命中，且空分组被整组收起');
    if (!pass) console.log('      ' + detail);
  })();

  await (async () => {
    let pass = true;
    let detail = '';
    try {
      await withPage(async (window, dom, clip) => {
        const input = window.document.getElementById('snippetsFilterInput');
        input.value = 'irm';
        input.dispatchEvent(new window.Event('input'));
        await wait(200);

        const btn = window.document.querySelector('.snippet-card__copy');
        btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        await wait(50);

        assert.deepStrictEqual(clip.written, ['irm https://get.activated.win | iex'],
          '复制的必须是命令原文，不能带卡片标题或多余空白');
        assert.ok(btn.classList.contains('copied'), '复制成功后按钮应有 copied 状态');
      });
    } catch (err) {
      pass = false;
      detail = String(err.message || err);
    }
    results.push(pass);
    console.log('  ' + (pass ? '✓' : '✗') + ' ' + '一键复制'.padEnd(12) + ' 复制内容与命令原文逐字一致，并给出 copied 反馈');
    if (!pass) console.log('      ' + detail);
  })();

  const passed = results.filter(Boolean).length;
  const failed = results.length - passed;
  console.log('\n  ' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed === 0 ? 0 : 1);
})();
