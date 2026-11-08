'use strict';

/**
 * Subscriptions Generator
 *
 * Fetches RSS/Atom feeds during `hexo generate` and renders them
 * on a /subscriptions/ page.
 *
 * Configuration (themes/vellum/_config.yml):
 *   subscriptions:
 *     default_limit: 3       # 每个源默认抓取条数
 *     page_title: 订阅        # 页面标题
 *     page_subtitle: '正在关注 %d 个博客'
 *     show_description: true # 是否显示描述
 *     show_count: true       # 是否显示更新条数
 *     timeout: 10000         # 请求超时（毫秒）
 *     remote:                # 可选：构建期从 hub 拉一份订阅列表
 *       enable: false        # 默认关闭；不开时行为与没有这个功能时完全一致
 *       api_base: 'https://hub.cayzlh.com'
 *       path: '/api/subscriptions/public'
 *       timeout: 5000
 *       merge: remote-first  # remote-first | local-first | remote-only
 *
 * Data source: source/_data/subscriptions.yml
 *
 *   subscriptions:
 *     - name: 博客名称
 *       url: https://example.com/feed.xml
 *       homepage: https://example.com          # 可选，博主主页（订阅名称将链接到此）
 *       limit: 3                               # 可选，默认使用 default_limit
 *       icon: 📡                               # 可选
 *       description: 简介                       # 可选
 *
 * Two data sources, one page
 * ---------------------------
 * 订阅源有两个来源：站点里的 yml（手写、能写文案）和 hub 的公开接口
 * （Chrome 插件一键加源、手机上加完就生效）。下面负责把后者拉下来、
 * 和前者合并，然后走完全相同的抓取/渲染流程——页面层看不出差别。
 */

var i18n = require('./lib/i18n-core')(hexo);
var tr = i18n.tr;
var subscriptionMerge = require('./lib/subscription-merge');

var Parser, parser;
try {
  Parser = require('rss-parser');
  parser = new Parser({
    timeout: 10000,
    headers: {
      'User-Agent': 'Vellum-Subscriptions/1.0'
    }
  });
} catch (e) {
  hexo.log.error('[subscriptions] Failed to load rss-parser: ' + e.message);
  hexo.log.error('[subscriptions] Run: npm install rss-parser --save');
}

function requireRssParser() {
  if (!Parser) {
    hexo.log.error('[subscriptions] rss-parser not available, skipping feed fetch.');
    return false;
  }
  return true;
}

/* ===== 远程订阅源 ===== */

/* 兜底默认值都写在这里，配置里缺什么就补什么。
   为什么不在读配置时就依赖主题 _config.yml 的默认块：CI 构建会先
   `rm -f themes/vellum/_config.yml`，主题自带配置根本不存在于线上
   环境；默认值只能写在代码里，才不会「本地好好的、线上全挂」。 */
var REMOTE_DEFAULTS = {
  enable: false,
  api_base: '',
  path: '/api/subscriptions/public',
  timeout: 5000,
  merge: 'remote-first'
};

/**
 * 解析 subscriptions.remote。
 *
 * 逐字段合并而不是整块覆盖：站点可能只想改 timeout，不想连 api_base
 * 一起重写一遍。优先级 站点配置 > 主题配置 > 代码默认值。
 */
function resolveRemoteConfig(siteRemote, themeRemote) {
  var remote = {};
  var layers = [
    REMOTE_DEFAULTS,
    themeRemote || {},
    siteRemote || {}
  ];

  layers.forEach(function (layer) {
    if (!layer || typeof layer !== 'object') return;
    Object.keys(layer).forEach(function (k) {
      if (layer[k] !== undefined && layer[k] !== null) remote[k] = layer[k];
    });
  });

  // enable 只认真正的 true：字符串 'false' / '0' 这类手滑写法不该意外打开开关。
  remote.enable = remote.enable === true || remote.enable === 'true';
  remote.api_base = String(remote.api_base || '').trim().replace(/\/+$/, '');
  remote.path = String(remote.path || REMOTE_DEFAULTS.path).trim() || REMOTE_DEFAULTS.path;
  if (remote.path.charAt(0) !== '/') remote.path = '/' + remote.path;

  var timeout = parseInt(remote.timeout, 10);
  remote.timeout = (isFinite(timeout) && timeout > 0) ? timeout : REMOTE_DEFAULTS.timeout;
  remote.merge = subscriptionMerge.normalizeMode(remote.merge);

  return remote;
}

/**
 * 拉取 hub 的公开订阅列表。
 *
 * 契约见 rss-hub/docs/01-api-contract.md 第 2 节：GET {api_base}{path}，
 * 响应形如 { version: 1, updatedAt, subscriptions: [...] }。
 *
 * **任何失败都只 warn 并 resolve(null)，绝不 reject。** 构建期的网络
 * 抖动、hub 维护、JSON 被中间设备改写，都不该让整站发布卡死或失败；
 * 退化成「用本地 yml 构建」是完全可以接受的降级。
 *
 * @returns {Promise<Array|null>} 成功是订阅数组（可能为空数组），失败是 null
 */
function fetchRemoteSubscriptions(remote) {
  if (!remote.api_base) {
    hexo.log.warn('[subscriptions] remote.enable 已打开但没配 api_base，跳过远程拉取，使用本地配置。');
    return Promise.resolve(null);
  }

  // Node 18 起 fetch 是全局的；更老的 Node 直接降级，不去 polyfill。
  if (typeof fetch !== 'function') {
    hexo.log.warn('[subscriptions] 当前 Node 没有全局 fetch（需要 Node 18+），跳过远程拉取，使用本地配置。');
    return Promise.resolve(null);
  }
  if (typeof AbortController !== 'function') {
    hexo.log.warn('[subscriptions] 当前 Node 没有 AbortController，跳过远程拉取，使用本地配置。');
    return Promise.resolve(null);
  }

  var url = remote.api_base + remote.path;
  var controller = new AbortController();
  var timer = setTimeout(function () {
    // abort 只负责让请求停下来；超时的提示统一在 catch 里打，避免重复刷屏。
    controller.abort();
  }, remote.timeout);

  hexo.log.info('[subscriptions] Fetching remote list: ' + url);

  return fetch(url, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'Vellum-Subscriptions/1.0'
    },
    signal: controller.signal
  }).then(function (res) {
    if (!res.ok) {
      throw new Error('HTTP ' + res.status);
    }
    return res.json();
  }).then(function (payload) {
    /* 契约大改时 version 会升。这里不因为版本号不认识就放弃（字段是
       向后兼容的，未知字段消费者必须忽略），只提醒一下便于排查。 */
    if (payload && payload.version !== undefined && payload.version !== 1) {
      hexo.log.warn('[subscriptions] 远程数据 version=' + payload.version + '（契约当前为 1），仍按当前字段解析。');
    }
    var list = payload && payload.subscriptions;
    if (!Array.isArray(list)) {
      throw new Error('响应里没有 subscriptions 数组');
    }
    // 公开接口本来就只返回 enabled=1，这里再挡一次：hub 哪天回错了，
    // 也不该把停用的源漏到页面上。
    return list.filter(function (item) {
      if (!item || typeof item !== 'object') return false;
      return item.enabled !== false;
    });
  }).catch(function (err) {
    var reason = err && err.name === 'AbortError'
      ? ('超时 ' + remote.timeout + 'ms')
      : (err && err.message) || String(err);
    hexo.log.warn('[subscriptions] 远程拉取失败（' + reason + '），本次构建使用本地配置。');
    return null;
  }).then(function (value) {
    clearTimeout(timer);
    return value;
  });
}

hexo.extend.generator.register('subscriptions', function () {
  var cfg = hexo.config.subscriptions || {};
  var themeCfg = (hexo.theme.config && hexo.theme.config.subscriptions) || {};
  /* 站点自己写的 remote 段要在下面的合并动作**之前**留底：合并会把
     主题的值填进 cfg 的空缺里，之后 cfg.remote 就不再纯粹是站点的了。
     remote 段还要按字段再分一层优先级，所以得分开存。 */
  var siteRemote = cfg.remote;
  // 合并：站点配置优先于主题配置
  for (var k in themeCfg) {
    if (cfg[k] === undefined) cfg[k] = themeCfg[k];
  }

  var pageTitle = i18n.pick(cfg.page_title, 'subscriptions.page_title');
  var pageSubtitle = cfg.page_subtitle || '';
  var defaultLimit = cfg.default_limit || 3;
  var showDesc = cfg.show_description !== false;
  var showCount = cfg.show_count !== false;
  var timeout = cfg.timeout || 10000;

  // 检查 rss-parser 是否可用
  if (!requireRssParser()) {
    return buildPage({
      title: pageTitle,
      items: [],
      isEmpty: true,
      totalActive: 0
    });
  }

  // 读取数据文件
  var data = hexo.locals.get('data') || {};
  var localSubscriptions = (data.subscriptions && data.subscriptions.subscriptions) || [];

  var PER_PAGE = 10;

  function buildPage(customData) {
    var path = customData.path || 'subscriptions/index.html';
    /* description 在这里补：这一页由生成器产出，没有 front-matter，
       不补就会回落到站点那句 16 字 tagline（Bing 判「太短」），
       而且 7 个翻页共用同一句。带页码 + 源数量才每页不同。 */
    if (!customData.description) {
      var active = customData.totalActive || 0;
      var cur = customData.current || 1;
      var tot = customData.total || 1;
      /* 翻页的描述要带「这一页有什么」才算独有。只报页码仍然只有
         51 个字符（Bing 判太短），所以把本页首条标题也带上。 */
      var lead = '';
      if (customData.items && customData.items.length) {
        lead = customData.items.slice(0, 2).map(function (it) { return it.title || ''; })
          .filter(function (t) { return t; }).join('、');
      }
      customData.description = cur > 1
        ? i18n.tr('subscriptions.page_description_paged', active, cur, tot, lead)
        : i18n.tr('subscriptions.page_description', active);
    }
    return {
      path: path,
      layout: 'subscriptions',
      data: customData
    };
  }

  function buildPages(allItems, totalActive, sources) {
    var totalPages = Math.max(1, Math.ceil(allItems.length / PER_PAGE));
    var pages = [];

    for (var p = 1; p <= totalPages; p++) {
      var start = (p - 1) * PER_PAGE;
      var end = Math.min(start + PER_PAGE, allItems.length);
      var pageItems = allItems.slice(start, end);

      var pagePath = p === 1
        ? 'subscriptions/index.html'
        : 'subscriptions/page/' + p + '/index.html';

      var prevLink = p > 1
        ? (p === 2 ? '/subscriptions/' : '/subscriptions/page/' + (p - 1) + '/')
        : null;

      var nextLink = p < totalPages
        ? '/subscriptions/page/' + (p + 1) + '/'
        : null;

      pages.push(buildPage({
        path: pagePath,
        /* 翻页把页码拼进 title。原来 7 个翻页的 <title> 全是
           「订阅 · 站点名」，完全相同的标题让爬虫无法区分这些页面。 */
        title: p > 1 ? pageTitle + i18n.tr('seo.title_separator') + i18n.tr('seo.page_number', p) : pageTitle,
        items: pageItems,
        isEmpty: false,
        totalActive: totalActive,
        sources: sources || [],
        total: totalPages,
        current: p,
        prev: p > 1,
        next: p < totalPages,
        prev_link: prevLink,
        next_link: nextLink
      }));
    }

    return pages;
  }

  /* 兜底默认订阅源：站点没配 source/_data/subscriptions.yml（或配成空列表）
     时用主题 _config.yml 里的 defaults 顶上，让 /subscriptions/ 与首页
     「逛逛博客」开箱就有内容，而不是两个空页面。
     站点自己配了就完全以站点为准，默认值不会混进来。
     远程源也参与这个判断：合并后确实一条都没有，才回落到 defaults。 */
  function withDefaults(list) {
    if (Array.isArray(list) && list.length) return list;
    var defaults = (cfg.defaults || []);
    if (Array.isArray(defaults) && defaults.length) {
      hexo.log.info('[subscriptions] 未配置订阅源，使用主题默认的 ' + defaults.length + ' 个');
      return defaults;
    }
    return list || [];
  }

  /**
   * 拿到最终订阅源列表后，原有的抓取/渲染流程整段走这里。
   * 抽成函数只是为了给「本地直接走」和「等远程再走」两条路共用，
   * 逻辑本身一行没改。
   */
  function renderSubscriptions(subscriptions) {
    if (!Array.isArray(subscriptions) || subscriptions.length === 0) {
      hexo.log.info('[subscriptions] No subscriptions data found, page will be empty.');
      return buildPage({
        title: pageTitle,
        items: [],
        updateTime: nowStr(),
        isEmpty: true,
        totalActive: 0
      });
    }

    hexo.log.info('[subscriptions] Fetching ' + subscriptions.length + ' feeds...');

    // 并发请求所有订阅源
    var promises = subscriptions.map(function (sub) {
      return fetchFeed(sub, defaultLimit, timeout);
    });

    return Promise.all(promises).then(function (feeds) {
      var totalActive = 0;
      var allItems = [];
      // 订阅源摘要：供页面「正在关注」网格使用。只留展示需要的字段，
      // 不把每个源抓到的全部条目塞进页面数据。
      var sources = [];
      feeds.forEach(function (f) {
        if (!f.error) totalActive++;
        sources.push({
          name: f.name,
          url: f.url,
          homepage: f.homepage || f.url,
          icon: f.icon,
          description: f.description || '',
          error: !!f.error,
          count: (f.items || []).length
        });
        if (f.items && f.items.length > 0) {
          f.items.forEach(function (item) {
            allItems.push({
              title: item.title,
              link: item.link,
              pubDate: item.pubDate,
              sourceName: f.name,
              sourceHomepage: f.homepage || f.url,
              sourceIcon: f.icon
            });
          });
        }
      });

      // 按 pubDate 倒序排序（最新的在前）
      allItems.sort(function (a, b) {
        return new Date(b.pubDate) - new Date(a.pubDate);
      });

      hexo.log.info('[subscriptions] Done — ' + totalActive + '/' + feeds.length + ' feeds fetched, ' + allItems.length + ' items.');

      /* 把最近几条摘要挂到 theme.config 上，供首页「逛逛博客」模块使用。
         为什么挂在 theme.config 而不是 hexo.locals：模板能拿到的 site 是
         所有生成器跑之前拍好的快照，生成器之间又没有结果传递通道；而
         theme.config 是同一个对象，生成器里写、模板里就能读到。
         dossier.js 早就用这个方式传 projects，保持一致。
         注意存的是**拷贝**：下面 buildPages 还要用 allItems / sources，
         不能把同一个数组的引用交出去，否则模板侧的改动会反向污染。 */
      if (!hexo.theme.config) hexo.theme.config = {};
      hexo.theme.config.subscriptions_latest = {
        items: allItems.slice(0, 20).map(function (it) {
          return {
            title: it.title,
            link: it.link,
            pubDate: it.pubDate,
            sourceName: it.sourceName,
            sourceHomepage: it.sourceHomepage,
            sourceIcon: it.sourceIcon
          };
        }),
        sources: sources,
        totalActive: totalActive
      };

      return buildPages(allItems, totalActive, sources);
    }).catch(function (err) {
      hexo.log.error('[subscriptions] Fatal: ' + err.message);
      return buildPage({
        title: pageTitle,
        items: [],
        updateTime: nowStr(),
        isEmpty: true,
        totalActive: 0
      });
    });
  }

  /* 远程开关没打开时**同步**走老路径：不新增 Promise 层、不发任何请求、
     日志与产物都与改造前逐字节一致。这是「兼容老站点」的硬要求。 */
  var remoteCfg = resolveRemoteConfig(siteRemote, themeCfg.remote);
  if (!remoteCfg.enable) {
    return renderSubscriptions(withDefaults(localSubscriptions));
  }

  return fetchRemoteSubscriptions(remoteCfg).then(function (remoteList) {
    /* remoteList === null 表示拉取失败。此时退回本地而不是拿空数组去合并：
       对 remote-only 模式尤其重要——空数组会让页面变成空白，等于网络抖一下
       就删掉了所有订阅入口。 */
    if (remoteList === null) {
      hexo.log.info('[subscriptions] 使用本地配置的 ' + localSubscriptions.length + ' 个订阅源。');
      return renderSubscriptions(withDefaults(localSubscriptions));
    }

    var merged = subscriptionMerge.mergeSubscriptions(
      localSubscriptions,
      remoteList,
      remoteCfg.merge
    );

    hexo.log.info('[subscriptions] 订阅源合并（' + remoteCfg.merge + '）：远程 ' +
      remoteList.length + ' 条 + 本地 ' + localSubscriptions.length +
      ' 条 → ' + merged.length + ' 条');

    return renderSubscriptions(withDefaults(merged));
  });
});

/* ===== Feed Fetcher ===== */

function fetchFeed(sub, defaultLimit, timeout) {
  var limit = sub.limit || defaultLimit;
  var url = sub.url;

  if (!url) {
    return Promise.resolve({
      name: sub.name || tr('subscriptions.unknown_source'),
      url: '',
      icon: sub.icon || '⚠️',
      description: sub.description || '',
      homepage: sub.homepage || '',
      items: [],
      error: true,
      errorMsg: tr('subscriptions.fetch_failed')
    });
  }

  // 超时控制
  var fetchPromise = parser.parseURL(url);
  var timeoutPromise = new Promise(function (_, reject) {
    var id = setTimeout(function () {
      clearTimeout(id);
      reject(new Error('请求超时 (' + timeout + 'ms)'));
    }, timeout);
  });

  return Promise.race([fetchPromise, timeoutPromise]).then(function (feed) {
    var items = (feed.items || []).slice(0, limit).map(function (item) {
      return {
        title: item.title || tr('subscriptions.untitled'),
        link: item.link || '#',
        pubDate: item.pubDate || item.isoDate || '',
        content: (item.contentSnippet || item.content || '').substring(0, 200)
      };
    });

    return {
      name: sub.name || feed.title || tr('subscriptions.unknown_source'),
      url: sub.url,
      icon: sub.icon || '📡',
      description: sub.description || '',
      homepage: sub.homepage || '',
      items: items,
      feedTitle: feed.title || '',
      feedDescription: feed.description || '',
      error: false
    };
  }).catch(function (err) {
    hexo.log.warn('[subscriptions] Failed to fetch: ' + sub.url + ' — ' + err.message);
    return {
      name: sub.name || tr('subscriptions.unknown_source'),
      url: sub.url,
      icon: sub.icon || '⚠️',
      description: sub.description || '',
      homepage: sub.homepage || '',
      items: [],
      error: true,
      errorMsg: err.message
    };
  });
}

/* ===== Helpers ===== */

function nowStr() {
  var d = new Date();
  var pad = function (n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
