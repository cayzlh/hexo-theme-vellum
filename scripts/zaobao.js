'use strict';

/* 界面文案取词器（提到模块级以复用词典缓存）。 */
var tr = require('./lib/i18n-core')(hexo).tr;

/**
 * Daily News Generator (60s-API)
 *
 * Fetches data from a 60s-API instance during `hexo generate`:
 *   - 每日早报  /v2/60s
 *   - 历史上的今天  /v2/today-in-history
 *   - 知乎热榜  /v2/zhihu
 *   - 微博热搜  /v2/weibo
 *   - AI 资讯  /v2/ai-news
 *   - 摸鱼进度  /v2/moyu
 *   - 今日运势  /v2/luck
 *
 * Configuration (themes/vellum/_config.yml 或站点 _config.vellum.yml):
 *   daily:
 *     enable: true
 *     api_base: 'https://60s.viki.moe'   # 任何兼容 60s-API 的实例
 *     zaobao: { enable: true }
 *     zhihu:  { enable: true }
 *     weibo:  { enable: true }
 *
 * Cache: 结果写入 .daily_cache.json，同一天重复构建不再请求 API。
 */

var https = require('https');
var http  = require('http');
var fs    = require('fs');
var path  = require('path');

var PAGE_PATH  = 'news/index.html';
var CACHE_FILE = '.daily_cache.json';

// 官方公共实例。自部署可换成自己的域名，例如 https://60s.example.com
var DEFAULT_API_BASE = 'https://60s.viki.moe';

hexo.extend.generator.register('zaobao', function () {

  /* ---- read config ---- */
  var themeCfg = (hexo.theme.config && hexo.theme.config.daily) || {};
  var siteCfg  = hexo.config.daily || {};
  var cfg = {};
  for (var k in themeCfg) cfg[k] = themeCfg[k];
  for (var k in siteCfg)  cfg[k] = siteCfg[k];

  var enabled = cfg.enable !== false;
  var apiBase = (cfg.api_base || DEFAULT_API_BASE).replace(/\/+$/, '');


  /* ---- cache first ---- */
  var cache = loadCache();
  if (cache) {
    hexo.log.info('[daily] Using cache from ' + cache.date + ', skip API requests.');
    return formatPage(cache.data, cache.date, cache.time);
  }

  if (!enabled) {
    hexo.log.info('[daily] Disabled by config');
    return emptyPage();
  }

  /* ---- branch switches ---- */
  var fetchZaobao = !(cfg.zaobao && cfg.zaobao.enable === false);
  var fetchZhihu  = !(cfg.zhihu  && cfg.zhihu.enable  === false);
  var fetchWeibo  = !(cfg.weibo  && cfg.weibo.enable  === false);
  // 新增模块默认启用
  var fetchHistory = cfg.history === undefined || cfg.history.enable !== false;
  var fetchAiNews  = cfg.ai_news === undefined || cfg.ai_news.enable !== false;
  var fetchMoyu    = cfg.moyu === undefined || cfg.moyu.enable !== false;
  var fetchLuck    = cfg.luck === undefined || cfg.luck.enable !== false;
  var fetchHackerNews = cfg.hacker_news === undefined || cfg.hacker_news.enable !== false;

  hexo.log.info('[daily] Fetching from ' + apiBase + '...');

  var tasks = {};

  if (fetchZaobao)  tasks.zaobao = fetchJson(apiBase + '/v2/60s');
  if (fetchHistory) tasks.history = fetchJson(apiBase + '/v2/today-in-history');
  if (fetchZhihu)   tasks.zhihu = fetchJson(apiBase + '/v2/zhihu');
  if (fetchWeibo)   tasks.weibo = fetchJson(apiBase + '/v2/weibo');
  if (fetchAiNews)  tasks.aiNews = fetchJson(apiBase + '/v2/ai-news');
  if (fetchMoyu)    tasks.moyu = fetchJson(apiBase + '/v2/moyu');
  if (fetchLuck)    tasks.luck = fetchJson(apiBase + '/v2/luck');
  if (fetchHackerNews) tasks.hackerNews = fetchJson(apiBase + '/v2/hacker-news/top');

  var entries = Object.keys(tasks).map(function (k) { return tasks[k]; });
  var keys = Object.keys(tasks);

  // fetchJson 不 reject（失败 resolve null），所以这里用 all 而不是 allSettled：
  // 单个栏目挂掉只会让它自己的键为 null，buildData 会退化成空栏目。
  return Promise.all(entries).then(function (results) {
    var raw = {};
    for (var i = 0; i < keys.length; i++) raw[keys[i]] = results[i];

    var data = buildData(raw);
    var now = new Date();
    var dateStr = fmtDate(now);
    var timeStr = nowStr(now);

    /* write cache */
    saveCache({ date: dateStr, time: timeStr, data: data });

    return formatPage(data, dateStr, timeStr);
  }).catch(function (err) {
    hexo.log.error('[daily] Fatal: ' + err.message);
    return emptyPage();
  });
});

/* ===== Data builder ===== */

/**
 * 净化一个外链。
 *
 * 上游 60s-API 的资讯条目偶尔会带出**无法解析的 URL**，实测最长见的是
 * Hacker News 里形如
 *   https://xn--69f31l4t57c0mag4b613h.xn--7uh4898msjaso/🆆🆃🅵/
 * 的地址：punycode 主机名本身不合法，路径里还带 emoji，url.parse 直接抛
 * ERR_INVALID_URL。
 *
 * 这类链接一旦原样写进 <a href>，hexo-autonofollow 在 after_render 阶段
 * 解析它就会抛错，而那个错误会把**整页**（/news/）的渲染打断——一个坏
 * 链接换掉一整页内容，代价完全不对等。所以这里是唯一入口：解析失败就退
 * 回 '#'，让条目照常显示标题，只是点不动。
 */
function safeLink(url) {
  if (!url) return '';
  var s = String(url).trim();
  if (!s) return '';
  try {
    require('url').parse(s);
    return s;
  } catch (e) {
    hexo.log.warn('[daily] Dropped unparsable link: ' + s.slice(0, 120));
    return '';
  }
}

function buildData(raw) {
  var data = {};
  var now = new Date();

  /* ---- 日签（从 60s + moyu + luck 提取） ---- */
  var s = raw.zaobao && raw.zaobao.code === 200 ? raw.zaobao.data : null;
  var m = raw.moyu   && raw.moyu.code   === 200 ? raw.moyu.data   : null;
  var l = raw.luck   && raw.luck.code   === 200 ? raw.luck.data   : null;

  data.daily = {
    date:        s ? s.date : fmtDate(now),
    dateDisplay: s ? formatDateDisplay(s.date) : '',
    dayOfWeek:   s ? (s.day_of_week || '') : '',
    lunarDate:   s ? (s.lunar_date || '') : '',
    tip:         s ? (s.tip || '') : '',
    nextWeekend: m && m.nextWeekend ? m.nextWeekend.daysUntil : null,
    luckRank:    l ? l.luck_rank : null,
    luckDesc:    l ? l.luck_desc : '',
  };

  /* ---- 每日早报 ---- */
  if (s && Array.isArray(s.news)) {
    data.zaobao = {
      news: s.news.map(function (t) { return { title: String(t).replace(/^\d+[、.．\s]\s*/, '') }; }),
      date: s.date || '',
    };
  } else {
    data.zaobao = { news: [], date: '' };
  }

  /* ---- 历史上的今天 ---- */
  if (raw.history && raw.history.code === 200) {
    var hi = raw.history.data;
    data.todayInHistory = {
      items: (hi && hi.items || []).map(function (item) {
        return {
          year: String(item.year || ''),
          title: item.title || '',
          description: item.description || '',
          event_type: item.event_type || '',
          link: safeLink(item.link),
        };
      }),
    };
  } else {
    data.todayInHistory = { items: [] };
  }

  /* ---- 知乎热榜 ---- */
  if (raw.zhihu && raw.zhihu.code === 200) {
    var zData = raw.zhihu.data;
    data.zhihu = {
      news: (Array.isArray(zData) ? zData : []).map(function (item) {
        var hint = item.hot_value_desc || '';
        if (item.answer_cnt) hint = (hint ? hint + ' · ' : '') + tr('daily.answer_count', item.answer_cnt);
        return {
          title: item.title || '',
          url: safeLink(item.link),
          hint: hint,
          image: item.cover || (item.images && item.images[0]) || '',
        };
      }),
    };
  } else {
    data.zhihu = { news: [] };
  }

  /* ---- 微博热搜 ---- */
  if (raw.weibo && raw.weibo.code === 200) {
    var wData = raw.weibo.data;
    data.weibo = {
      news: (Array.isArray(wData) ? wData : []).map(function (item) {
        return {
          title: item.title || '',
          hot: item.hot_value || item.hot_num || 0,
          url: safeLink(item.link),
        };
      }),
    };
  } else {
    data.weibo = { news: [] };
  }

  /* ---- AI 资讯 ---- */
  if (raw.aiNews && raw.aiNews.code === 200) {
    var aData = raw.aiNews.data;
    data.aiNews = {
      news: (aData && aData.news || []).map(function (item) {
        return {
          title: item.title || '',
          detail: item.detail || '',
          link: safeLink(item.link),
          source: item.source || '',
        };
      }),
    };
  } else {
    data.aiNews = { news: [] };
  }

  /* ---- Hacker News ---- */
  if (raw.hackerNews && raw.hackerNews.code === 200) {
    data.hackerNews = {
      news: (Array.isArray(raw.hackerNews.data) ? raw.hackerNews.data : []).map(function (item) {
        return {
          title: item.title || '',
          link: safeLink(item.link),
          score: item.score || 0,
          author: item.author || '',
        };
      }),
    };
  } else {
    data.hackerNews = { news: [] };
  }

  return data;
}

function formatDateDisplay(dateStr) {
  if (!dateStr) return '';
  var p = dateStr.split('-');
  if (p.length !== 3) return dateStr;
  return tr('daily.date_display', parseInt(p[1], 10), parseInt(p[2], 10));
}

/* ===== Page builder ===== */

function formatPage(data, newsDate, updateTime) {
  /* 栏目数量用实际抓到的数据算，不用写死的 8——
     接口挂了几个的时候，摘要里说「8 个栏目」就是在撒谎。 */
  var sections = 0;
  if (data.zaobao && data.zaobao.news && data.zaobao.news.length) sections++;
  if (data.aiNews && data.aiNews.news && data.aiNews.news.length) sections++;
  if (data.todayInHistory && data.todayInHistory.items && data.todayInHistory.items.length) sections++;
  if (data.zhihu && data.zhihu.news && data.zhihu.news.length) sections++;
  if (data.weibo && data.weibo.news && data.weibo.news.length) sections++;
  if (data.hackerNews && data.hackerNews.news && data.hackerNews.news.length) sections++;

  return {
    path: PAGE_PATH,
    layout: 'daily',
    data: {
      title: tr('daily.page_title'),
      /* 这一页不是 source 里的文件，没有 front-matter。不给 description
         就会回落到站点那句 16 字的 tagline，Bing 判「太短」。 */
      description: tr('daily.page_description', newsDate || '', sections),
      newsDate: newsDate,
      updateTime: updateTime,
      daily: data.daily || {},
      zaobao: data.zaobao || { news: [] },
      todayInHistory: data.todayInHistory || { items: [] },
      zhihu: data.zhihu || { news: [] },
      weibo: data.weibo || { news: [] },
      aiNews: data.aiNews || { news: [] },
      hackerNews: data.hackerNews || { news: [] },
    },
  };
}

/* ===== HTTP fetch ===== */

/**
 * 抓一个 JSON 端点。
 *
 * **永不 reject** —— 失败时 resolve(null)，由 buildData 把该栏目当空处理。
 *
 * 这一点很关键：资讯页有 8 个独立接口，之前用 Promise.all 串联，
 * 只要其中一个超时 / 返回 5xx / 回了 HTML 错误页，整条链就 reject，
 * 页面直接变成空状态——7 个接口抓到的内容跟着一起丢掉。
 * 单个栏目挂掉不该惩罚整页，所以这里把「失败」降级成「这个栏目没有数据」。
 *
 * 另外显式处理了 gzip/deflate：官方实例和多数 CDN 会对 JSON 开压缩，
 * 不 request 压缩时通常没问题，但反代/CDN 有时会无条件压缩，
 * 这时按 utf8 读会得到乱码，JSON.parse 必然失败。
 */
function fetchJson(url) {
  return new Promise(function (resolve) {
    var settled = false;
    function done(v) {
      if (settled) return;
      settled = true;
      resolve(v);
    }

    var mod = url.indexOf('https://') === 0 ? https : http;
    var req = mod.get(url, { timeout: 10000 }, function (res) {
      if (res.statusCode !== 200) {
        hexo.log.warn('[daily] ' + url + ' -> HTTP ' + res.statusCode);
        res.resume();
        return done(null);
      }

      var stream = res;
      var enc = String(res.headers['content-encoding'] || '').toLowerCase();
      if (enc === 'gzip') {
        stream = res.pipe(require('zlib').createGunzip());
      } else if (enc === 'deflate') {
        stream = res.pipe(require('zlib').createInflate());
      } else if (enc === 'br') {
        stream = res.pipe(require('zlib').createBrotliDecompress());
      }

      var body = '';
      stream.setEncoding('utf8');
      stream.on('data', function (c) { body += c; });
      stream.on('end', function () {
        try { done(JSON.parse(body)); }
        catch (e) {
          hexo.log.warn('[daily] Invalid JSON from ' + url);
          done(null);
        }
      });
      stream.on('error', function (e) {
        hexo.log.warn('[daily] ' + url + ' decompress failed: ' + e.message);
        done(null);
      });
    });

    req.on('error', function (e) {
      hexo.log.warn('[daily] ' + url + ' request failed: ' + e.message);
      done(null);
    });
    req.on('timeout', function () {
      req.destroy();
      hexo.log.warn('[daily] Timeout: ' + url);
      done(null);
    });
  });
}

/* ===== Cache ===== */

function cachePath() {
  return path.join(hexo.base_dir, CACHE_FILE);
}

function loadCache() {
  try {
    var file = cachePath();
    if (!fs.existsSync(file)) return null;
    var raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    var today = fmtDate(new Date());
    if (raw.date === today) return raw;
    return null;
  } catch (e) {
    return null;
  }
}

function saveCache(obj) {
  try {
    fs.writeFileSync(cachePath(), JSON.stringify(obj, null, 2), 'utf-8');
  } catch (e) {
    // non-critical
  }
}

/* ===== Helpers ===== */

/**
 * 统一时间基准：Asia/Shanghai（UTC+8，无夏令时）。
 *
 * 不能直接用 d.getFullYear()/getHours() —— 那读的是 runner 的本地时区。
 * GitHub Actions 的 ubuntu-latest 默认 TZ=UTC，于是：
 *   - 北京 07:30 构建 → 拿到 UTC 的前一天 23:30
 *   - 「更新于」比北京时间少 8 小时
 *   - 缓存按 UTC 日期判断，跨日边界（北京 00:00~08:00）会把昨天的
 *     缓存当成今天的，或把今天的缓存判成过期的
 * 这里显式换算，不依赖 CI 是否设置了 TZ。
 */
var TZ_OFFSET_MIN = 8 * 60;

function shanghaiParts(d) {
  d = d || new Date();
  /* 用 UTC 时间戳加固定偏移，避免依赖运行时 tzdata */
  var t = new Date(d.getTime() + TZ_OFFSET_MIN * 60 * 1000);
  return {
    year:  t.getUTCFullYear(),
    month: t.getUTCMonth() + 1,
    day:   t.getUTCDate(),
    hour:  t.getUTCHours(),
    minute: t.getUTCMinutes(),
    pad: function (n) { return String(n).padStart(2, '0'); },
  };
}

function fmtDate(d) {
  var p = shanghaiParts(d);
  return p.year + '-' + p.pad(p.month) + '-' + p.pad(p.day);
}

function nowStr(d) {
  var p = shanghaiParts(d);
  return p.year + '-' + p.pad(p.month) + '-' + p.pad(p.day) +
    ' ' + p.pad(p.hour) + ':' + p.pad(p.minute);
}

function emptyPage() {
  return {
    path: PAGE_PATH,
    layout: 'daily',
    data: {
      title: tr('daily.page_title'),
      description: tr('daily.page_description', '', 0),
      newsDate: '',
      updateTime: '',
      daily: {},
      zaobao: { news: [] },
      todayInHistory: { items: [] },
      zhihu: { news: [] },
      weibo: { news: [] },
      aiNews: { news: [] },
      hackerNews: { news: [] },
    },
  };
}
