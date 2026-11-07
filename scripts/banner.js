'use strict';

/**
 * Banner Generator — 首页窄幅每日壁纸
 *
 * 在 `hexo generate` 期间抓一张必应每日壁纸，把图片地址与标题**静态写进**
 * 首页 HTML。首页是每 4 小时重建一次的静态产物，不需要每个访客各自去请求
 * 一次接口，也不需要让首屏多等一个网络往返。
 *
 * 数据源：{banner.api_base 或 daily.api_base}/v2/bing，响应形如
 *   { code: 200, data: { title, headline, description, cover, cover_4k, copyright, ... } }
 *
 * 配置（themes/vellum/_config.yml 或站点 _config.<theme>.yml）：
 *   banner:
 *     enable: true
 *     api_base: ''        # 留空则回落到 daily.api_base
 *     height: 200px       # 窄幅高度（桌面）
 *     position: top       # top（intro 之前）| after-intro（「近日所思」之前）
 *     link: true          # 点击是否跳到必应每日壁纸页
 *     overlay: true       # 图上是否压一层暗渐变，保证标题可读
 *     show_title: true
 *     show_copyright: true
 *
 * 缓存：结果写入 .banner_cache.json（站点根目录，已在主题 .gitignore），
 *       同一天内重复构建不再请求接口。
 *
 * 降级策略：接口挂了 / 图不可用 / 数据不成形，**整块 banner 不渲染**。
 * 首页绝不能出现一块灰底、一张裂图，或者一行「加载失败」——这块内容本来
 * 就是锦上添花，缺了它首页依然完整，硬撑着渲染反而更难看。
 *
 * 为什么单独一个生成器、而不是并进 bookmarks.js：
 * 两者唯一的共同点是「都在构建期打一个外部接口」，除此之外数据、缓存键、
 * 失败后的产物完全不同（一个是整页，一个是首页的一小块）。合在一个文件里
 * 只会让「改 banner 时得读完收藏逻辑」。
 *
 * 为什么用 generator.register 而不是走渲染钩子：
 * 走注入器（injector）的话，模板拿不到数据，只能靠挂 theme.config 再让
 * index.ejs 去读——那和 subscriptions_latest 是同一种手法，但它只对
 * 「首页唯一」这一件事成立。生成器注册在这里的意义是把「抓取」与「渲染」
 * 分开：抓取在本文件，渲染在 index.ejs，中间的数据就是 theme.banner_today。
 */

var remoteFetch = require('./lib/remote-fetch');
var dayCache = require('./lib/day-cache');

var CACHE_FILE = '.banner_cache.json';
var LOG_TAG = 'banner';

/* 必应壁纸页：点击图片时的去处。这是必应官方的每日壁纸页面，
   不是某个第三方图站——外链要指向内容的真正来源。 */
var BING_WALLPAPER_PAGE = 'https://www.bing.com/';

/* 兜底默认值写在代码里，理由同 bookmarks.js：CI 会先删掉主题 _config.yml，
   线上环境根本不存在主题自带配置。 */
var DEFAULTS = {
  enable: true,
  api_base: '',
  height: '200px',
  position: 'top',
  link: true,
  overlay: true,
  show_title: true,
  show_copyright: true
};

var VALID_POSITIONS = ['top', 'after-intro'];

/**
 * 逐字段分层合并：代码默认值 < 主题配置 < 站点配置。
 *
 * 布尔字段用 `!== false` 判：这几个开关都是「默认开、明确关」的语义，
 * 写成 `!!cfg.x` 会让一个手滑的 'false' 字符串当真值，开关就关不掉了。
 */
function layerConfig() {
  var themeCfg = (hexo.theme.config && hexo.theme.config.banner) || {};
  var siteCfg = hexo.config.banner || {};

  var cfg = {};
  [DEFAULTS, themeCfg, siteCfg].forEach(function (layer) {
    if (!layer || typeof layer !== 'object') return;
    Object.keys(layer).forEach(function (k) {
      if (layer[k] !== undefined && layer[k] !== null) cfg[k] = layer[k];
    });
  });

  cfg.enable = cfg.enable !== false && cfg.enable !== 'false';
  cfg.link = cfg.link !== false && cfg.link !== 'false';
  cfg.overlay = cfg.overlay !== false && cfg.overlay !== 'false';
  cfg.show_title = cfg.show_title !== false && cfg.show_title !== 'false';
  cfg.show_copyright = cfg.show_copyright !== false && cfg.show_copyright !== 'false';

  /* height 是直接写进 style 的 CSS 长度。只接受「数字 + 单位」这种形状，
     其余一律回落默认值——把一个来路不明的字符串拼进 <img style> 是在
     给自己开一个 HTML 注入的口子（配置文件也是外部输入）。 */
  var height = String(cfg.height || '').trim();
  cfg.height = /^\d+(\.\d+)?(px|rem|em|vh|vw)$/.test(height) ? height : DEFAULTS.height;

  cfg.position = VALID_POSITIONS.indexOf(String(cfg.position || '').trim()) >= 0
    ? String(cfg.position).trim()
    : DEFAULTS.position;

  // api_base 留空时回落到 daily.api_base —— 壁纸和资讯是同一个上游。
  var dailyCfg = hexo.config.daily || (hexo.theme.config && hexo.theme.config.daily) || {};
  var apiBase = String(cfg.api_base || '').trim() || String(dailyCfg.api_base || '').trim();
  cfg.api_base = apiBase.replace(/\/+$/, '');

  return cfg;
}

/**
 * 从接口响应里取出首页真正要用的四个字段。
 *
 * 形状不对（code !== 200、没有 data、没有图片地址）一律返回 null：
 * 调用方据此整块不渲染。这里不做「猜一个默认图」之类的兜底——一张
 * 与当天无关的图挂在首页上，比没有这块更奇怪。
 *
 * 为什么用 cover（1920×1080）而不是 cover_4k：
 * banner 在桌面最高只铺 680 CSS px，2 倍屏即 1360 物理像素，1920 已经够用；
 * 实测同一张壁纸 cover 约 330KB、cover_4k 约 3.7MB——为了一个 200px 高、
 * 明确「不抢注意力」的窄条多下 3.4MB，是这块最不该犯的错。
 * 4K 地址留作兜底：极少数情况下上游只给 cover_4k。
 */
function extractBanner(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.code !== undefined && payload.code !== 200) return null;

  var d = payload.data;
  if (!d || typeof d !== 'object') return null;

  var image = String(d.cover || d.cover_4k || '').trim();
  if (!image) return null;

  /* 只接受 http(s) 绝对地址。上游返回相对路径或 data URI 时宁可不渲染：
     这两种都意味着接口行为变了，静默用它只会让问题更晚才被发现。 */
  if (!/^https?:\/\//i.test(image)) return null;

  return {
    image: image,
    /* title 是壁纸的主题词，headline 与它通常相同；description 偶尔更长，
       三个都缺时标题留空（模板会因此不渲染标题那一行）。 */
    title: String(d.title || d.headline || '').trim(),
    copyright: String(d.copyright || '').trim(),
    /* update_date 只用来做人工核对数据新鲜度，不上页面。 */
    date: String(d.update_date || '').trim()
  };
}

/**
 * 校验一份**已归一化**的 banner 数据还能不能用。
 *
 * 缓存文件是上个版本的代码写的，它的字段形状可能已经变了（比如旧版存
 * cover_4k、新版只认 cover）。所以从缓存读出来的东西不能直接信，必须重新
 * 过一遍和网络数据相同的尺子——否则一次版本升级会让「缓存命中」把页面
 * 变成一张破图，而且要等到第二天缓存自然过期才恢复。
 *
 * @returns {boolean}
 */
function isUsableBanner(banner) {
  if (!banner || typeof banner !== 'object') return false;
  var image = String(banner.image || '').trim();
  if (!image) return false;
  return /^https?:\/\//i.test(image);
}

/**
 * 抓当天壁纸。命中当天缓存就直接用，不打接口。
 *
 * @returns {Promise<object|null>} 归一化后的 banner 数据，或 null
 */
function loadBanner(cfg) {
  var cached = dayCache.load(hexo.base_dir, CACHE_FILE, hexo.log, LOG_TAG);
  if (cached && isUsableBanner(cached.data)) {
    hexo.log.info('[banner] 使用 ' + cached.date + ' 的缓存，跳过壁纸请求。');
    return Promise.resolve(cached.data);
  }
  if (cached) {
    hexo.log.warn('[banner] 缓存里没有可用的壁纸地址（可能是旧版本写的），改为重新抓取。');
  }

  if (!cfg.api_base) {
    hexo.log.warn('[banner] 没配 api_base（banner.api_base 与 daily.api_base 都为空），跳过壁纸。');
    return Promise.resolve(null);
  }

  var url = cfg.api_base + '/v2/bing';

  return remoteFetch.json(url, {
    timeout: 10000,
    log: hexo.log,
    tag: LOG_TAG
  }).then(function (payload) {
    if (payload === null) return null;

    var banner = extractBanner(payload);
    if (!banner) {
      hexo.log.warn('[banner] 接口响应里没有可用的壁纸地址，本次不渲染 banner。');
      return null;
    }

    dayCache.save(hexo.base_dir, CACHE_FILE, banner, hexo.log, LOG_TAG);
    return banner;
  });
}

hexo.extend.generator.register('banner', function () {
  var cfg = layerConfig();

  if (!cfg.enable) {
    hexo.log.info('[banner] 已由配置关闭。');
    /* 关掉时显式把占位清空：theme.config 是跨构建复用的对象，上一次构建
       留下的 banner_today 会让「关了还在显示」。 */
    hexo.theme.config.banner_today = null;
    return [];
  }

  return loadBanner(cfg).then(function (banner) {
    /* 把结果挂到 theme.config 上供 index.ejs 读取。
       为什么挂在 theme.config 而不是 hexo.locals：模板拿到的 site 是所有
       生成器跑之前拍好的快照，生成器之间又没有结果传递通道；theme.config
       是同一个对象，生成器里写、模板里立刻能读到。subscriptions.js 早就
       用这个方式传 subscriptions_latest，dossier.js 传 projects，保持一致。
       存的是**拷贝**，且 banner 本身是个新建的扁平对象，没有共享引用的风险。 */
    if (!hexo.theme.config) hexo.theme.config = {};
    hexo.theme.config.banner_today = banner
      ? {
        image: banner.image,
        title: cfg.show_title ? banner.title : '',
        copyright: cfg.show_copyright ? banner.copyright : '',
        height: cfg.height,
        position: cfg.position,
        link: cfg.link ? BING_WALLPAPER_PAGE : '',
        overlay: cfg.overlay
      }
      : null;

    if (banner) {
      hexo.log.info('[banner] 今日壁纸：' + (banner.title || banner.image));
    }
    /* 这个生成器不产出路由，产物由 index.ejs 渲染——注册它的唯一目的
       是拿到「在页面渲染之前」这个时机。返回空数组即「没有新路由」。 */
    return [];
  });
});
