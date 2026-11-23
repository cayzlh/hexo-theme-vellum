'use strict';

/**
 * Snippets Generator — /snippets/ 一行笔记页
 *
 * 在 `hexo generate` 期间把 `source/_data/snippets.yml` 渲染成一页
 * 分组卡片，每张卡片带一个可复制的命令。
 *
 * 和 /links/ 的区别
 * -----------------
 * 收藏页记住的是「去哪」，一行笔记记住的是「怎么干」。所以这一页的主体
 * 不是链接，而是**可复制的文本**：命令要能一键拿走，而不是让读者拿眼睛
 * 抄一遍。
 *
 * 数据来源
 * --------
 *   1. source/_data/snippets.yml   唯一来源，平铺，每条自带 category / sort
 *
 * 为什么不做远程合并（对比 bookmarks.remote / subscriptions.remote）：
 * 那两处接的是 hub 里「随手存一个站 / 一个源」的日常动作，远程能省下改
 * yml 的功夫。一行笔记的写入频率要低得多、内容也更要紧（命令写错会出事），
 * 不值得为它开一条接口通道。真需要时再加，形状已经留好了。
 *
 * 配置（themes/vellum/_config.yml 或站点 _config.<theme>.yml）：
 *   snippets:
 *     enable: true
 *     page_title: ''          # 留空 = 用语言包 snippets.title
 *     page_intro: ''          # 标题下的一句话；留空不渲染
 *     show_count: true        # 是否显示「N 条 · M 个分类」
 *     filter: true            # 是否渲染前端过滤输入框
 *
 * 降级策略
 * --------
 * yml 缺失、为空、全是脏数据——一律渲染成空状态，绝不 404：导航里可能
 * 已经有这个入口，一个写着「还没有记录」的页面远好过一个打不开的链接。
 */

/* 界面文案取词器。脚本（跑在 loadPlugin 的 vm 里）拿不到 helper，只能
   require 共享核心；提到模块级是为了让词典缓存全程复用。 */
var i18n = require('./lib/i18n-core')(hexo);
var snippetLib = require('./lib/snippet-lib');

var PAGE_PATH = 'snippets/index.html';
var LOG_TAG = 'snippets';

/* 兜底默认值都写在这里，配置里缺什么就补什么。
   为什么不在读配置时就依赖主题 _config.yml 的默认块：CI 构建会先
   `rm -f themes/vellum/_config.yml`，主题自带配置根本不存在于线上环境；
   默认值只能写在代码里，才不会「本地好好的、线上全挂」。 */
var PAGE_DEFAULTS = {
  enable: true,
  page_title: '',
  page_intro: '',
  show_count: true,
  filter: true
};

/**
 * 逐字段分层合并：代码默认值 < 主题配置 < 站点配置。
 *
 * 逐字段而不是整块覆盖，是因为站点常常只想关掉 filter，不想连 page_title
 * 一起重写一遍。
 */
function layerConfig() {
  var themeCfg = (hexo.theme.config && hexo.theme.config.snippets) || {};
  var siteCfg = hexo.config.snippets || {};

  var cfg = {};
  [PAGE_DEFAULTS, themeCfg, siteCfg].forEach(function (layer) {
    if (!layer || typeof layer !== 'object') return;
    Object.keys(layer).forEach(function (k) {
      if (layer[k] !== undefined && layer[k] !== null) cfg[k] = layer[k];
    });
  });

  /* 布尔项只认真正的 false / 字符串 'false'：「false」以外的任何手滑
     写法都不该意外关掉功能，同理 '0' 也不该。 */
  cfg.enable = cfg.enable !== false && cfg.enable !== 'false';
  cfg.show_count = cfg.show_count !== false && cfg.show_count !== 'false';
  cfg.filter = cfg.filter !== false && cfg.filter !== 'false';

  return cfg;
}

/**
 * 组装生成器要返回的路由对象。
 *
 * 注意 groups 里的 items 已经排好序，模板不需要再算任何规则——
 * 排序口径见 lib/snippet-lib.js#sortWithin。
 */
function buildPage(cfg, list) {
  var groups = snippetLib.groupSnippets(list);
  var stats = snippetLib.countStats(list);

  return {
    path: PAGE_PATH,
    layout: 'snippets',
    data: {
      /* title 供 <title>/SEO 用。 */
      title: i18n.pick(cfg.page_title, 'snippets.title'),
      /* description 必须显式给出：这一页不是 source 里的页面文件，
         没有 front-matter，不给的话 SEO 会回落到站点那句十几个字的
         tagline。用实际条数与分类数组成，才言之有物。 */
      description: i18n.tr('snippets.page_description', stats.total, stats.categoryCount),
      intro: i18n.pick(cfg.page_intro, 'snippets.intro'),
      groups: groups,
      total: stats.total,
      categoryCount: stats.categoryCount,
      showCount: cfg.show_count && stats.total > 0,
      showFilter: cfg.filter && stats.total > 0
    }
  };
}

hexo.extend.generator.register('snippets', function () {
  var cfg = layerConfig();

  /* 数据来源只有一个文件。hexo.locals.get('data') 已经把 _data/*.yml
     读进内存，这里拿到的就是原样 YAML 结构。 */
  var data = hexo.locals.get('data') || {};
  var raw = data.snippets || [];

  if (!Array.isArray(raw)) {
    /* yml 顶层写成对象（比如误写成 `snippets:` 再嵌套）时不是「空」而是
       「形状不对」，要说出来，否则作者只会看到一页空状态而不知道原因。 */
    hexo.log.warn('[snippets] source/_data/snippets.yml 顶层应为数组，实际是 ' +
      (raw === null ? 'null' : typeof raw) + '，本次渲染为空状态。');
    raw = [];
  }

  var list = snippetLib.normalizeAll(raw);

  if (list.length !== raw.length) {
    hexo.log.warn('[snippets] 丢弃了 %d 条没有 title 的记录（title 是必填项）。',
      raw.length - list.length);
  }

  /* 总开关关掉时仍然**生成页面**，但渲染成空状态。为什么不干脆不注册
     路由：站点若已经把 /snippets/ 放进了导航或页脚，路由消失就是一个
     404——那比一个写着「还没记过东西」的空页糟糕得多。这条与
     /links/、/news/ 的处理保持一致。 */
  if (!cfg.enable) {
    hexo.log.info('[snippets] 已由配置关闭，/snippets/ 渲染为空状态。');
    return buildPage(cfg, []);
  }

  hexo.log.info('[%s] %d 条一行笔记（%d 个分类）',
    LOG_TAG, list.length, snippetLib.countStats(list).categoryCount);

  return buildPage(cfg, list);
});
