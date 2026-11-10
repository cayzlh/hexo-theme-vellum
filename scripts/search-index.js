'use strict';

/**
 * 全站搜索索引生成器
 * ===========================================================================
 * 产出 /search.json —— 前端 /search/ 页用它做正文检索。
 *
 * 为什么不做倒排索引
 * ------------------
 * 实测过：181 篇文档建中文二元组倒排索引后，词项 45887 个、posting 13.6 万条，
 * JSON 951 KB（gzip 325 KB）——比正排大将近一倍，因为中文二元组太碎。
 * 而索引本身不适合分片惰性加载（一个查询要查所有分片）。
 *
 * 所以走正排 + 前端子串扫描：1500 字截断后 527 KB（gzip 202 KB），
 * 180 篇的量级下扫一遍是毫秒级，不值得为它引入倒排的复杂度与体积。
 *
 * 截断的原因
 * ----------
 * 不限长度是 977 KB。截到 1500 字之后体积减半而命中率几乎不变——
 * 读者搜一个词，命中的证据在前半篇就足够，没必要为「正文第 8000 字出现过
 * 这个词」而让每页都多下 500 KB。
 *
 * 结构
 * ----
 * 数组套数组，不用对象：[[title, url, tags, date, text], ...]
 * 省掉每篇重复的四个键名，180 篇省下约 20 KB。
 *
 * 分片
 * ----
 * 超过 shard_size 篇就切成 search-0.json、search-1.json……，首页只记分片清单。
 * 前端先拿清单再并发取分片，首屏等待时间不随文章数线性增长。
 * 这一点现在 180 篇还用不上（单文件 200 KB gzip），但留着是为了文章涨到
 * 500 篇时不至于重构一次前端。
 */

var SEARCH_PATH = 'search';

/** 默认值，可被 theme.search.text_limit / shard_size 覆盖。 */
var DEFAULT_TEXT_LIMIT = 1500;
var DEFAULT_SHARD_SIZE = 120;

/* 每次运行读一次配置。放模块级是为了让下面的收集函数也能拿到——
   它们没有 locals 参数可传。 */
function searchCfg() {
  return (hexo.theme.config && hexo.theme.config.search) || {};
}

function textLimit() {
  var v = parseInt(searchCfg().text_limit, 10);
  return v > 0 ? v : DEFAULT_TEXT_LIMIT;
}

/**
 * Markdown → 纯文本。
 *
 * 目标只是「能被搜到」，不追求排版还原，所以：
 *   · 代码块整块丢掉（搜 `for` 会命中每一篇，噪音大于信号）
 *   · 行内代码丢掉反引号但保留内容（`Nacos` 这种术语是重要的搜索目标）
 *   · 链接只留文字、图片整个丢掉
 */
function toPlainText(md) {
  if (!md) return '';
  var t = String(md);

  t = t.replace(/```[\s\S]*?```/g, ' ');          // 围栏代码块
  t = t.replace(/~~~[\s\S]*?~~~/g, ' ');
  t = t.replace(/^(?: {4}|\t)[^\n]*$/gm, ' ');     // 缩进代码块
  t = t.replace(/`([^`]*)`/g, '$1');               // 行内代码保留内容
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');     // 图片
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');   // 链接留文字
  t = t.replace(/<[^>]+>/g, ' ');                  // 内联 HTML / 标签
  t = t.replace(/^#{1,6}\s*/gm, '');               // 标题符号
  t = t.replace(/^[>\s]*>[>\s]*/gm, '');           // 引用
  t = t.replace(/^\s*[-*+]\s+/gm, ' ');            // 列表符
  t = t.replace(/^\s*\d+\.\s+/gm, ' ');            // 有序列表
  t = t.replace(/^\s*\|.*\|\s*$/gm, function (row) { // 表格：只留内容
    return row.replace(/\|/g, ' ');
  });
  t = t.replace(/^\s*-{3,}\s*$/gm, ' ');           // 分割线
  t = t.replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1'); // 强调
  t = t.replace(/\s+/g, ' ');
  return t.trim();
}

function stripHtml(str) {
  return String(str || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 从 hexo locals 收集可检索的条目。
 *
 * 范围：文章 + 档案文档。
 * 不含独立页面（about / links / subscriptions）——那些是站点结构，
 * 不是「内容」，塞进搜索结果反而稀释命中。
 */
function collectDocs(locals) {
  var docs = [];
  var seen = {};

  function push(entry) {
    if (!entry || !entry.title) return;
    if (seen[entry.url]) return;
    seen[entry.url] = 1;
    docs.push(entry);
  }

  // ---- 文章 ----
  var posts = locals.posts;
  if (posts && posts.forEach) {
    posts.forEach(function (post) {
      if (!post || post.draft) return;
      var text = toPlainText(post.content || '');
      var limit = textLimit();
      if (text.length > limit) text = text.slice(0, limit);

      var tags = [];
      if (post.tags && post.tags.forEach) {
        post.tags.forEach(function (t) { tags.push(stripHtml(t.name)); });
      }
      var cats = [];
      if (post.categories && post.categories.forEach) {
        post.categories.forEach(function (c) { cats.push(stripHtml(c.name)); });
      }

      /* 标签与分类合并去重：同名的「随笔」既可能是标签又是分类，
         不去重会在结果元信息里出现「随笔 · 随笔」。 */
      var combined = tags.concat(cats).filter(function (t, idx, arr) {
        return t && arr.indexOf(t) === idx;
      });

      push({
        title: stripHtml(post.title),
        url: '/' + String(post.path || '').replace(/^\/+/, ''),
        tags: combined,
        date: post.date ? post.date.format('YYYY-MM-DD') : '',
        text: text
      });
    });
  }

  // ---- 档案文档 ----
  /* 档案的自有 generator 把路由推给 hexo.route，不进 locals.pages，
     所以这里从 route 清单里捞：凡是 dossier/**.html 就当档案文档。
     正文只能从路由渲染结果拿——那一步在 after_generate 里做更稳，
     所以这里只留 URL，内容在下面补。 */
  return docs;
}

/**
 * 档案文档的正文不在 locals 里，只能从渲染好的路由取。
 * 这个生成器注册在 after_generate 之前的 generator 阶段，
 * 拿不到最终 HTML，于是直接扫 source/dossier 目录自行渲染 ——
 * 和 scripts/dossier.js 用的是同一份数据源，不会漂移。
 */
function collectDossierDocs() {
  var fs = require('fs');
  var path = require('path');
  var docs = [];

  var srcDir = hexo.source_dir + 'dossier';
  if (!fs.existsSync(srcDir)) return docs;

  var cfg = hexo.theme.config.dossier || {};
  var basePath = cfg.path || 'dossier';

  function walk(dir, projectId, relParts) {
    var entries;
    try {
      entries = fs.readdirSync(dir);
    } catch (e) {
      return;
    }
    entries.forEach(function (name) {
      if (name.charAt(0) === '.' || name === 'README.md') return;
      var full = path.join(dir, name);
      var stat;
      try {
        stat = fs.statSync(full);
      } catch (e) {
        return;
      }
      if (stat.isDirectory()) {
        walk(full, projectId || name, relParts.concat(name));
        return;
      }
      if (!/\.md$/i.test(name)) return;

      var proj = projectId || path.basename(dir);
      var raw;
      try {
        raw = fs.readFileSync(full, 'utf8');
      } catch (e) {
        return;
      }

      // 拆 front-matter
      var fm = {};
      var body = raw;
      var m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
      if (m) {
        body = raw.slice(m[0].length);
        m[1].split(/\r?\n/).forEach(function (line) {
          var kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
          if (kv) fm[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
        });
      }

      var isIndex = /^(index|readme)\.md$/i.test(name);
      var title = fm.title || (isIndex ? proj : name.replace(/\.md$/i, ''));
      var rel = name.replace(/\.md$/i, '.html');
      /* index.md 是项目首页，路由是 /dossier/<proj>/ 而不是 /dossier/<proj>/index.html */
      var url = isIndex
        ? '/' + basePath + '/' + proj + '/'
        : '/' + basePath + '/' + proj + '/' + rel;

      var text = toPlainText(body);
      var limit = textLimit();
      if (text.length > limit) text = text.slice(0, limit);

      var tags = [];
      if (fm.tags) {
        String(fm.tags).replace(/^\[|\]$/g, '').split(',').forEach(function (t) {
          var v = t.trim().replace(/^["']|["']$/g, '');
          if (v) tags.push(v);
        });
      }

      docs.push({
        title: stripHtml(title),
        url: url,
        tags: tags,
        date: fm.updated || fm.date || '',
        text: text
      });
    });
  }

  // 顶层每个目录是一个专题
  var projects;
  try {
    projects = fs.readdirSync(srcDir);
  } catch (e) {
    return docs;
  }
  projects.forEach(function (name) {
    if (name.charAt(0) === '.' || name === 'README.md') return;
    var full = path.join(srcDir, name);
    var st;
    try {
      st = fs.statSync(full);
    } catch (e) {
      return;
    }
    if (!st.isDirectory()) return;
    walk(full, name, [name]);
  });

  return docs;
}

/**
 * 生成器：产出 /search.json（或分片清单）。
 *
 * 注册成 generator 而不是 after_generate 里手动写文件——走路由能得到
 * 正确的 public/ 路径、sitemap 的自动收录判定（.json 不收录，符合预期）。
 */
hexo.extend.generator.register('search_index', function (locals) {
  var cfg = hexo.theme.config.search || {};
  if (cfg.enable === false) return [];

  var docs = collectDocs(locals).concat(collectDossierDocs());

  /* 稳定排序：先按日期倒序，再把没有日期的（档案多数没有）放后面。
     搜索结果里同分条目按这个顺序出现，读者看到的是「新的在前」。 */
  docs.sort(function (a, b) {
    if (a.date && b.date) return a.date < b.date ? 1 : (a.date > b.date ? -1 : 0);
    if (a.date) return -1;
    if (b.date) return 1;
    return 0;
  });

  /* 紧凑数组格式：[title, url, tags(逗号串), date, text] */
  var rows = docs.map(function (d) {
    return [d.title, d.url, (d.tags || []).join(','), d.date || '', d.text];
  });

  var shardSize = parseInt(cfg.shard_size, 10) || DEFAULT_SHARD_SIZE;
  var routes = [];

  if (rows.length <= shardSize) {
    routes.push({
      path: SEARCH_PATH + '.json',
      data: JSON.stringify({ total: rows.length, shards: 1, docs: rows })
    });
  } else {
    var shardFiles = [];
    for (var i = 0; i < rows.length; i += shardSize) {
      var idx = Math.floor(i / shardSize);
      var name = SEARCH_PATH + '-' + idx + '.json';
      shardFiles.push(name);
      routes.push({
        path: name,
        data: JSON.stringify(rows.slice(i, i + shardSize))
      });
    }
    routes.push({
      path: SEARCH_PATH + '.json',
      data: JSON.stringify({ total: rows.length, shards: shardFiles.length, files: shardFiles })
    });
  }

  hexo.log.info('[search] 索引 %d 篇（%d 个分片，每篇正文上限 %d 字）',
    rows.length, routes.length, textLimit());

  return routes;
});
