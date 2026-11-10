'use strict';

/**
 * /search/ 搜索页路由
 * ===========================================================================
 * 这一页不是 source 里的 .md，没有 front-matter，所以 title / description
 * 必须在这里显式给：不给的话 SEO 会回落到站点那句十几个字的 tagline，
 * 搜索引擎判「太短 / 太泛」——和 /links/、/subscriptions/ 遇到的是同一个坑。
 *
 * 索引本身由 scripts/search-index.js 生成（/search.json），两者互不依赖：
 * 关掉 search.enable 时页面仍会渲染，只是输入框搜不出东西——比直接 404 好，
 * 因为导航里可能已经有这个入口。
 */

var i18n = require('./lib/i18n-core')(hexo);

var PAGE_PATH = 'search/index.html';

hexo.extend.generator.register('search_page', function () {
  var cfg = hexo.theme.config.search || {};

  /* 站点/主题配置里给了页面标题就用它，否则走语言包。
     pick() 只做「配置优先、语言包兜底」，不转占位符。 */
  var title = i18n.pick(cfg.page_title, 'search_page.title');

  return {
    path: PAGE_PATH,
    layout: 'search',
    data: {
      title: title,
      description: i18n.tr('search_page.description'),
      /* 不让搜索页进 sitemap：它没有自有内容，收录进去是薄页面。
         但也不要 noindex —— 用户会把它加书签、分享带 ?q= 的链接。 */
      sitemap: false,
      robots: 'noindex, follow'
    }
  };
});
