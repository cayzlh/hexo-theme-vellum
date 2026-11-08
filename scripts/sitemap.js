'use strict';

/**
 * Sitemap 生成器。
 *
 * 为什么自己写：官方 hexo-generator-sitemap 只知道 posts / pages / tags /
 * categories 四类，本站有两类页面它拿不到——
 *   · 主题自己在生成器里造的 /links/、/news/、/subscriptions/、/dossier/
 *     以及 /dossier/tags/*（这些不是 source 里的页面文件，不进 locals.pages）
 *   · 归档的年份/月份分页（/archives/2022/03/）
 * 反过来它又会把 README.html 这类实际 404 的产物扫进去。
 *
 * ── 实现方式：以「实际产物路由」为唯一事实来源 ──────────────────────
 * 早期版本按 locals 逐个模型遍历，结果是「模型里有、线上不存在」和
 * 「线上存在、模型里没有」两头都会错，本站线上真的出现过：
 *   ✗ /css/footer-seal.css/   —— 一个 CSS 文件被当成页面收进 sitemap
 *   ✗ /tags/Maven/ /tags/maven/ 同时存在（大小写不同的同名标签各生成一份）
 *   ✓ /links/ /news/ /subscriptions/ /dossier/ 全部缺席
 *
 * 现在改成在 after_generate 阶段读 `hexo.route.list()`——那是 Hexo 即将
 * 写进 public/ 的完整清单，不多不少。凡是 .html 产出就考虑收录，再从
 * locals 里补 front-matter 的排除标记（sitemap: false / robots: noindex）。
 */

// 只在本文件里用，所以不额外引依赖。
function xmlEscape(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 把 Hexo 的路由 key 折算成托管实际服务的 URL。
 *
 * 两种形态托管处理不同，写错就吃 307：
 *   目录页 `/dir/`   → 结尾斜杠必须有
 *   单页   `/file`  → 结尾斜杠不能有
 *
 * pretty_urls 已经把 index.html / .html 从 permalink 里剥了，但 route key
 * 仍然是 `about/index.html`、`dossier/x/y.html` 这种带文件名的形态。
 */
function routeToPath(route) {
  var p = String(route || '').replace(/^\/+/, '');
  var isDir = /index\.html$/i.test(p);
  p = p.replace(/index\.html$/i, '').replace(/\.html?$/i, '');
  p = p.replace(/\/+$/, '');
  return { path: p, isDir: isDir };
}

/** 拼绝对 URL。非 ASCII（中文标签/分类）必须 percent-encode。 */
function absoluteUrl(siteUrl, path, isDir) {
  var encoded = path === '' ? '' : encodeURI(path);
  if (isDir && encoded !== '') encoded += '/';
  return siteUrl.replace(/\/+$/, '') + '/' + encoded;
}

/**
 * 永远不进 sitemap 的路由。
 *
 * 判据只有「这页该不该被搜索引擎收录」，不是「这页好不好看」。
 */
function isExcluded(route) {
  var p = String(route || '');

  // 只收 HTML。css/js/字体/图片/feed/sitemap 都是资源或清单。
  if (!/\.html$/i.test(p)) return true;

  // 构建产物与错误页
  if (/^(README|LICENSE)(\.html)?$/i.test(p)) return true;
  if (/^404\.html$/i.test(p)) return true;

  // 搜索引擎/站点所有权验证文件。它们是纯文本口令，不是页面：
  //   google<hex>.html（Google Search Console）
  //   BingSiteAuth.xml / <hex>.txt（IndexNow 密钥）
  // 收进 sitemap 只会让爬虫抓到一个没有 <title> 的空白文档。
  if (/^google[a-f0-9]{16}\.html$/i.test(p)) return true;
  if (/^(BingSiteAuth\.xml|IndexNow\.txt|[a-f0-9]{32}\.txt)$/i.test(p)) return true;

  // 分页页（/page/2/、/subscriptions/page/2/…）**照收**。
  // 曾经想按「和内页重复」把它们剔掉，但那是错的：它们各自有 canonical、
  // 各自能被翻页链接爬到，剔掉之后反而是「可索引但没申报」。真正该做的是
  // 让每页的 title/description 各不相同——这件事在 seo.js 里做（页码进标题）。
  return false;
}

/**
 * 站点自己的排除标记：front-matter 的 `sitemap: false`，或
 * `robots: noindex`（含 "noindex" 字样）。
 *
 * 这两条是页面作者显式表达的意愿，优先于上面的默认规则。
 */
function markedNoIndex(page) {
  if (!page) return false;
  if (page.sitemap === false) return true;
  var robots = String(page.robots || '');
  return /noindex/i.test(robots);
}

hexo.extend.filter.register('after_generate', function () {
  var config = this.config;
  var siteUrl = (config.url || '').replace(/\/+$/, '');
  if (!siteUrl) {
    this.log.warn('[sitemap] 站点 config.url 为空，跳过生成');
    return;
  }

  // front-matter 级别的排除清单。route key ↔ page.path 一一对应。
  var excludedPaths = Object.create(null);
  var lastmodByPath = Object.create(null);

  function notePage(page) {
    if (!page || !page.path) return;
    var key = routeToPath(page.path);
    if (markedNoIndex(page)) excludedPaths[key.path] = true;
    var stamp = page.updated || page.date;
    if (stamp) {
      var t = stamp instanceof Date ? stamp.getTime() : new Date(stamp).getTime();
      if (!isNaN(t)) lastmodByPath[key.path] = t;
    }
  }

  try {
    var locals = this.locals.toObject();
    (locals.pages || []).forEach(notePage);
    (locals.posts || []).forEach(notePage);
    (locals.tags || []).forEach(notePage);
    (locals.categories || []).forEach(notePage);
  } catch (e) {
    this.log.warn('[sitemap] 读取 locals 失败，将只按路由清单输出：' + e.message);
  }

  var entries = [];
  var seen = Object.create(null);

  this.route.list().forEach(function (route) {
    if (isExcluded(route)) return;

    var norm = routeToPath(route);
    if (excludedPaths[norm.path]) return;

    var url = absoluteUrl(siteUrl, norm.path, norm.isDir);
    if (seen[url]) return;
    seen[url] = true;

    entries.push({
      loc: url,
      lastmod: lastmodByPath[norm.path] || 0
    });
  });

  // 首页补进去：route key 是 'index.html'，会被 routeToPath 折成空串，
  // 上面循环能收下它，但 lastmod 取不到，单独兜一下。
  if (!seen[absoluteUrl(siteUrl, '', true)]) {
    entries.push({ loc: absoluteUrl(siteUrl, '', true), lastmod: 0 });
  }

  var fallback = Date.now();
  var body = entries
    .sort(function (a, b) {
      return (b.lastmod || fallback) - (a.lastmod || fallback);
    })
    .map(function (e) {
      return (
        '  <url>\n' +
        '    <loc>' + xmlEscape(e.loc) + '</loc>\n' +
        '    <lastmod>' + new Date(e.lastmod || fallback).toISOString() + '</lastmod>\n' +
        '  </url>'
      );
    })
    .join('\n');

  var xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    body +
    '\n</urlset>\n';

  // 百度那边要同一份 URL 集合，一份数据出两个文件，避免两边漂移。
  this.route.set('sitemap.xml', xml);
  this.route.set('baidusitemap.xml', xml);

  this.log.info('[sitemap] 收录 %d 个 URL', entries.length);
});
