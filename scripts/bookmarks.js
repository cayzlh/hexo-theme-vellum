'use strict';

/**
 * Bookmarks Generator — /links/ 收藏站点页
 *
 * 在 `hexo generate` 期间把三份收藏数据合成一份，渲染成一页分组卡片。
 *
 * 数据来源（按优先级从高到低）
 * ----------------------------
 *   1. source/_data/bookmarks.yml   平铺，每条自带 category / sort —— 新格式
 *   2. source/_data/links.yml       分组（category + items）—— 老格式
 *   3. bookmarks.remote             构建期 GET hub 的公开接口
 *
 * 两个本地文件**同时**生效，按 URL 归一化后去重（同一个站只出现一次）。
 * links.yml 不能删也不能改格式——文章页的 show_links 友链组件还在读它；
 * 收藏页只是换一个形状把它读一遍。远程按 URL 去重后只补本地没有的站点，
 * 同一条记录**本地优先**（手写的文案比插件抓的标题贴切，契约 6.4 节）。
 *
 * 配置（themes/vellum/_config.yml 或站点 _config.<theme>.yml）：
 *   bookmarks:
 *     enable: true
 *     page_title: ''          # 留空 = 用语言包 links.title
 *     page_intro: ''          # 标题下的一句话；留空不渲染
 *     show_count: true        # 是否显示「N 个站 · M 个分类」
 *     remote:
 *       enable: false         # 默认关闭；不开时行为与没有这个功能时完全一致
 *       api_base: 'https://hub.cayzlh.com'
 *       path: '/api/bookmarks/public'
 *       timeout: 5000
 *
 * 降级策略
 * --------
 * **任何失败都只 warn**：接口挂了、JSON 坏了、超时了，一律退化成「只用本地
 * yml」。构建期的网络状况不该是「整站能不能发布」的前提条件；收藏页数据过期
 * 一小时的代价，远小于发布流程卡死。
 */

/* 界面文案取词器。脚本（跑在 loadPlugin 的 vm 里）拿不到 helper，只能
   require 共享核心；提到模块级是为了让词典缓存全程复用。 */
var i18n = require('./lib/i18n-core')(hexo);
var bookmarkMerge = require('./lib/bookmark-merge');
var remoteFetch = require('./lib/remote-fetch');

var PAGE_PATH = 'links/index.html';
var LOG_TAG = 'bookmarks';

/* 兜底默认值都写在这里，配置里缺什么就补什么。
   为什么不在读配置时就依赖主题 _config.yml 的默认块：CI 构建会先
   `rm -f themes/vellum/_config.yml`，主题自带配置根本不存在于线上环境；
   默认值只能写在代码里，才不会「本地好好的、线上全挂」。 */
var REMOTE_DEFAULTS = {
  enable: false,
  api_base: '',
  path: '/api/bookmarks/public',
  timeout: 5000
};

var PAGE_DEFAULTS = {
  enable: true,
  page_title: '',
  page_intro: '',
  show_count: true
};

/**
 * 逐字段分层合并：代码默认值 < 主题配置 < 站点配置。
 *
 * 逐字段而不是整块覆盖，是因为站点常常只想改 timeout，不想连 api_base
 * 一起重写一遍；整块覆盖会让「主题里配好的 api_base 被一个只写了
 * `remote: { timeout: 8000 }` 的站点配置悄悄清空」。
 */
function layerConfig() {
  var themeCfg = (hexo.theme.config && hexo.theme.config.bookmarks) || {};
  var siteCfg = hexo.config.bookmarks || {};

  var cfg = {};
  [PAGE_DEFAULTS, themeCfg, siteCfg].forEach(function (layer) {
    if (!layer || typeof layer !== 'object') return;
    Object.keys(layer).forEach(function (k) {
      if (layer[k] !== undefined && layer[k] !== null) cfg[k] = layer[k];
    });
  });

  /* enable 只认真正的 true / false：「false」这种字符串手滑写法不该意外
     打开开关，同理 '0' 也不该。默认值是开的（收藏页是主题能力，不是
     需要额外打开的插件），所以只有明确写 false 才关。 */
  cfg.enable = cfg.enable !== false && cfg.enable !== 'false';
  cfg.show_count = cfg.show_count !== false && cfg.show_count !== 'false';

  var remote = {};
  [REMOTE_DEFAULTS, themeCfg.remote, siteCfg.remote].forEach(function (layer) {
    if (!layer || typeof layer !== 'object') return;
    Object.keys(layer).forEach(function (k) {
      if (layer[k] !== undefined && layer[k] !== null) remote[k] = layer[k];
    });
  });

  remote.enable = remote.enable === true || remote.enable === 'true';
  remote.api_base = String(remote.api_base || '').trim().replace(/\/+$/, '');
  remote.path = String(remote.path || REMOTE_DEFAULTS.path).trim() || REMOTE_DEFAULTS.path;
  if (remote.path.charAt(0) !== '/') remote.path = '/' + remote.path;

  var timeout = parseInt(remote.timeout, 10);
  remote.timeout = (isFinite(timeout) && timeout > 0) ? timeout : REMOTE_DEFAULTS.timeout;

  cfg.remote = remote;
  return cfg;
}

/**
 * 拉 hub 的公开收藏列表。
 *
 * 契约见 cayzlh-hub/chromeextension/docs/01-api-contract.md 第 6.3 节：
 * GET {api_base}{path} → { version: 1, updatedAt, bookmarks: [...] }。
 *
 * @returns {Promise<Array|null>} 成功是记录数组（可能为空），失败是 null
 */
function fetchRemoteBookmarks(remote) {
  if (!remote.api_base) {
    hexo.log.warn('[bookmarks] remote.enable 已打开但没配 api_base，跳过远程拉取，使用本地配置。');
    return Promise.resolve(null);
  }

  return remoteFetch.json(remote.api_base + remote.path, {
    timeout: remote.timeout,
    log: hexo.log,
    tag: LOG_TAG
  }).then(function (payload) {
    if (payload === null) return null;

    /* 契约大改时 version 会升。不因为版本号不认识就放弃（字段向后兼容，
       未知字段消费者必须忽略），只提醒一下便于排查。 */
    if (payload && payload.version !== undefined && payload.version !== 1) {
      hexo.log.warn('[bookmarks] 远程数据 version=' + payload.version + '（契约当前为 1），仍按当前字段解析。');
    }

    var list = payload && payload.bookmarks;
    if (!Array.isArray(list)) {
      /* 响应是 JSON 但形状不对——这时不能当成「远程有 0 条」：
         那会让下面把本地数据也照常用上，看起来一切正常，实际是接口悄悄坏了。
         返回 null 走「远程拉取失败」这条路，日志里能看见原因。 */
      hexo.log.warn('[bookmarks] 远程响应里没有 bookmarks 数组，本次构建使用本地配置。');
      return null;
    }

    /* 公开接口本来只返回 enabled=1，这里再挡一次：hub 哪天回错了，
       也不该把停用的站点漏到页面上。 */
    return list.filter(function (item) {
      if (!item || typeof item !== 'object') return false;
      return item.enabled !== false;
    });
  });
}

/** 组装生成器要返回的路由对象。 */
function buildPage(cfg, merged) {
  var groups = bookmarkMerge.groupBookmarks(merged);

  /* 只留点得动的记录。放在分组之后再过滤，是为了让「分类里所有站都坏掉」
     时那个分类整个消失，而不是留下一个空标题。 */
  groups = groups
    .map(function (group) {
      return {
        category: group.category,
        items: group.items.filter(function (item) {
          return bookmarkMerge.isUsableUrl(item.url);
        })
      };
    })
    .filter(function (group) {
      return group.items.length > 0;
    });

  var total = groups.reduce(function (sum, group) { return sum + group.items.length; }, 0);

  return {
    path: PAGE_PATH,
    layout: 'links',
    data: {
      /* title 供 <title>/SEO 用；页面上是否再画一遍大标题由模板决定
         （现在不画——导航已经标明了位置，和 /subscriptions/ 的处理一致）。 */
      title: i18n.pick(cfg.page_title, 'links.title'),
      intro: cfg.page_intro || '',
      groups: groups,
      total: total,
      categoryCount: groups.length,
      showCount: cfg.show_count && total > 0
    }
  };
}

hexo.extend.generator.register('bookmarks', function () {
  var cfg = layerConfig();
  var data = hexo.locals.get('data') || {};

  /* 两个本地文件都读：links.yml 是友链组件的数据源（老格式、不能动），
     bookmarks.yml 是新建站点用的（新格式、带 sort）。合并去重交给纯函数。 */
  var localBookmarks = data.bookmarks || [];
  var localLinks = data.links || [];

  /* 总开关关掉时仍然**生成页面**，但渲染成空状态（不渲染任何站点、
     不抓远程）。为什么不干脆不注册路由：站点若已经把 /links/ 放进了
     导航或页脚，路由消失就是一个 404——那比一个写着「还没收藏站点」的
     空页糟糕得多。这条与 daily.enable / news 页的处理保持一致。 */
  if (!cfg.enable) {
    hexo.log.info('[bookmarks] 已由配置关闭，/links/ 渲染为空状态。');
    return buildPage(cfg, []);
  }

  /* 同步路径：远程开关没打开。不新增 Promise 层、不发任何请求，
     日志与产物与「没有远程功能」时逐字节一致。 */
  if (!cfg.remote.enable) {
    var merged = bookmarkMerge.mergeBookmarks({
      bookmarks: localBookmarks,
      links: localLinks,
      remote: []
    });
    hexo.log.info('[bookmarks] 本地 ' + merged.length + ' 个站点（bookmarks.yml + links.yml 去重后）');
    return buildPage(cfg, merged);
  }

  return fetchRemoteBookmarks(cfg.remote).then(function (remoteList) {
    /* remoteList === null 表示拉取失败。退回本地而不是拿空数组去合并：
       空数组会让每个站点都变成「远程独有」→ 不过滤也看不出来，但会把
       「远程挂了」这件事抹平，以后排查时没有任何线索。 */
    if (remoteList === null) {
      var localOnly = bookmarkMerge.mergeBookmarks({
        bookmarks: localBookmarks,
        links: localLinks,
        remote: []
      });
      hexo.log.info('[bookmarks] 使用本地配置的 ' + localOnly.length + ' 个站点。');
      return buildPage(cfg, localOnly);
    }

    var merged = bookmarkMerge.mergeBookmarks({
      bookmarks: localBookmarks,
      links: localLinks,
      remote: remoteList
    });

    hexo.log.info('[bookmarks] 收藏站点合并：远程 ' + remoteList.length +
      ' 条 + 本地 ' + (localBookmarks.length + localLinks.length) +
      ' 条 → ' + merged.length + ' 个站点');

    return buildPage(cfg, merged);
  });
});
