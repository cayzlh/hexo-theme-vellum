'use strict';

/* 界面文案取词器。放在顶部：helper 拿不到，脚本只能 require 共享核心；
   提到模块级是为了让词典缓存全程复用，而不是每次调用重建一份。 */
var tr = require('./lib/i18n-core')(hexo).tr;

/**
 * Vellum Dossier System v4
 * Auto-scans source/dossier/ directory tree, registers routes, builds nav tree.
 * Features:
 * - index.md as project README (required, supplies project config via front-matter)
 * - Multi-level sorting: index.md first → sort → date → title
 * - Front-matter title display (fallback to formatted filename)
 * - Backward compatible: _config.yml and _data/dossier/*.yml still supported
 */

const fs = require('fs');
const tocCore = require('./lib/toc-core');
const path = require('path');

// ============================================
// Front-matter Parser
// ============================================

function parseFrontMatter(raw) {
  const fm = { title: '', description: '', tags: [], sort: undefined, date: '' };
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  let content = raw;
  if (fmMatch) {
    content = fmMatch[2];
    const lines = fmMatch[1].split('\n');
    let inArr = false, arrKey = '';
    for (const line of lines) {
      if (inArr) {
        if (line.trim().startsWith('- ')) {
          fm[arrKey].push(line.trim().substring(2).trim());
          continue;
        } else { inArr = false; }
      }
      const kv = line.match(/^(\w[\w_-]*):\s*(.*)/);
      if (kv) {
        const k = kv[1], v = kv[2].trim();
        if (v === '') { inArr = true; arrKey = k; if (!fm[k]) fm[k] = []; }
        else fm[k] = v;
      }
    }
  }
  return { frontMatter: fm, content };
}

function readFile(fullPath) {
  const raw = fs.readFileSync(fullPath, 'utf8');
  return parseFrontMatter(raw);
}

// ============================================
// Title helper: from front-matter or formatted filename
// ============================================

function formatFileNameToTitle(name) {
  return name
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, function(c) { return c.toUpperCase(); });
}

function getPageTitle(frontMatter, fileName) {
  if (frontMatter && frontMatter.title) {
    return frontMatter.title;
  }
  return formatFileNameToTitle(fileName);
}

// ============================================
// File System Scanner (reads front-matter for titles)
// ============================================

function scanDir(basePath, relPath) {
  const fullPath = path.join(basePath, relPath);
  if (!fs.existsSync(fullPath)) return { dirs: [], files: [] };
  const entries = fs.readdirSync(fullPath);
  const dirs = [], files = [];
  for (const name of entries) {
    if (name.startsWith('.') || name === '_config.yml') continue;
    const itemPath = path.join(fullPath, name);
    const rel = relPath ? path.join(relPath, name) : name;
    if (fs.statSync(itemPath).isDirectory()) {
      const children = scanDir(basePath, rel);
      if (children.files.length > 0 || children.dirs.length > 0) {
        const indexFile = children.files.find(function(f) { return f.isIndex; });
        dirs.push({
          name: name,
          path: rel,
          children: children,
          title: indexFile ? indexFile.title : formatFileNameToTitle(name),
          url: '/dossier/' + rel.replace(/\\/g, '/') + '/'
        });
      }
    } else if (name.endsWith('.md')) {
      const fileName = name.replace('.md', '');
      const isIndex = (fileName === 'index' || fileName === 'README' || fileName === 'readme');
      // Read front-matter for title
      var fm = { title: '' };
      try {
        var parsed = readFile(itemPath);
        fm = parsed.frontMatter;
      } catch (e) { /* use defaults */ }
      files.push({
        name: fileName,
        path: rel.replace(/\\/g, '/'),
        title: getPageTitle(fm, fileName),
        isIndex: isIndex,
        sort: fm.sort !== undefined ? (Number(fm.sort) || 0) : undefined,
        date: fm.date || fm.updated || '',
        frontMatter: fm
      });
    }
  }
  return { dirs, files };
}

// ============================================
// Project Config Reader (index.md first, then _config.yml, then _data/*.yml)
// ============================================

function readProjectConfig(basePath, projectId, indexFm) {
  // 1. Start with index.md front-matter (if available)
  var config = {
    title: projectId,
    description: '',
    tags: [],
    sort: 0,
    source: 'default'
  };

  if (indexFm && indexFm.title) {
    config.title = indexFm.title;
    config.description = indexFm.description || '';
    config.tags = indexFm.tags || [];
    config.sort = parseInt(indexFm.sort) || 0;
    config.source = 'index.md';
  }

  // 2. _config.yml overrides (project-level config takes priority)
  const cfgPath1 = path.join(basePath, projectId, '_config.yml');
  if (fs.existsSync(cfgPath1)) {
    const raw = fs.readFileSync(cfgPath1, 'utf8');
    raw.split('\n').forEach(function(line) {
      const m = line.match(/^(\w[\w_-]*):\s*(.*)/);
      if (m) {
        var key = m[1];
        var value = m[2].trim();
        if (key === 'tags') {
          // Support comma-separated: "tag1, tag2"
          config.tags = value.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t; });
        } else if (key === 'title') {
          config.title = value;
        } else if (key === 'description') {
          config.description = value;
        } else if (key === 'sort') {
          config.sort = parseInt(value) || 0;
        }
      }
    });
    config.source = '_config.yml';
    return config;
  }

  // 3. Fallback: _data/dossier/{project}.yml
  try {
    const data = hexo.locals.get ? hexo.locals.get('data') : {};
    const yd = data['dossier/' + projectId];
    if (yd) {
      if (typeof yd.tags === 'string') yd.tags = [yd.tags];
      yd.title = yd.title || yd.name || projectId;
      yd.source = '_data/dossier/*.yml';
      return yd;
    }
  } catch (e) { /* ignore */ }

  // 4. 回到 index.md front-matter（若可用），否则用目录名兜底
  //
  // 这里必须返回 config 本身，不能无条件返回一个新的空对象：
  // 项目里既没有 _config.yml、也没有 _data/dossier/*.yml 时（这是最常见的情形，
  // 约定优于配置就是鼓励这么写），上面第 1 步读到的 front-matter 会在这里
  // 被整个丢掉 —— 表现为索引页卡片和项目首页都显示目录名，
  // 而 description / tags / sort 全部失效。
  return config;
}

// ============================================
// Multi-level Sort for Dossier Pages
// ============================================

function isIndexPage(page) {
  return page.name === 'index' || page.name === 'README' || page.name === 'readme';
}

function sortDossierPages(pages) {
  return pages.sort(function(a, b) {
    // 1. index.md / README.md always first
    var aIsIndex = isIndexPage(a);
    var bIsIndex = isIndexPage(b);
    if (aIsIndex && !bIsIndex) return -1;
    if (!aIsIndex && bIsIndex) return 1;

    // 2. By sort field (small → large)
    var aSort = (a.sort !== undefined && !isNaN(a.sort)) ? a.sort : Number.MAX_SAFE_INTEGER;
    var bSort = (b.sort !== undefined && !isNaN(b.sort)) ? b.sort : Number.MAX_SAFE_INTEGER;
    if (aSort !== bSort) return aSort - bSort;

    // 3. By date (new → old)
    var aTime = a.date ? new Date(a.date).getTime() : NaN;
    var bTime = b.date ? new Date(b.date).getTime() : NaN;
    if (!isNaN(aTime) && !isNaN(bTime)) {
      var dateCmp = bTime - aTime;
      if (dateCmp !== 0) return dateCmp;
    }
    if (!isNaN(aTime) && isNaN(bTime)) return -1;
    if (isNaN(aTime) && !isNaN(bTime)) return 1;

    // 4. By title alphabetically
    var aTitle = a.title || a.name || '';
    var bTitle = b.title || b.name || '';
    return aTitle.localeCompare(bTitle, 'zh-CN');
  });
}

// ============================================
// Nav Tree Builder (with front-matter titles)
// ============================================

function buildNavTree(scan, projectId, prefix) {
  prefix = prefix || ('/' + projectId + '/');
  const children = [];

  // Add files in this dir (sorted)
  var sortedFiles = sortDossierPages(scan.files.slice());
  sortedFiles.forEach(function(f) {
    var url = '/dossier/' + prefix.replace(/\/+$/, '') + '/' + f.name + '.html';
    children.push({ title: f.title || f.name, url: url, type: 'page', name: f.name });
  });

  // Add sub-dirs recursively
  scan.dirs.forEach(function(d) {
    var subPrefix = prefix + d.name + '/';
    var sub = buildNavTree(d.children, projectId, subPrefix);
    children.push({ title: d.title || d.name, url: '/dossier/' + subPrefix, type: 'section', children: sub });
  });

  return children;
}

function flattenNav(nav) {
  const result = [];
  nav.forEach(function(item) {
    if (item.type === 'page') result.push(item);
    if (item.children) result.push.apply(result, flattenNav(item.children));
  });
  return result;
}

// ============================================
// Custom Generator — registers all dossier routes
// ============================================

hexo.extend.generator.register('dossier_routes', function(locals) {
  const src = hexo.source_dir;
  const dossierPath = path.join(src, 'dossier');
  const theme = hexo.theme.config;
  const dossierCfg = theme.dossier || {};
  if (!dossierCfg.enable) return [];

  const routes = [];
  const projects = {};
  const allTags = {};

  // --- 1. Scan filesystem projects ---
  if (fs.existsSync(dossierPath)) {
    const entries = fs.readdirSync(dossierPath);
    for (const entry of entries) {
      const projPath = path.join(dossierPath, entry);
      if (!fs.statSync(projPath).isDirectory()) continue;

      // Require index.md — warn if missing
      const indexPath = path.join(projPath, 'index.md');
      const readmePath = path.join(projPath, 'README.md');
      var indexFilePath = null;
      if (fs.existsSync(indexPath)) {
        indexFilePath = indexPath;
      } else if (fs.existsSync(readmePath)) {
        indexFilePath = readmePath;
      } else {
        hexo.log.warn('[Dossier] Project "' + entry + '" is missing index.md or README.md. Skipping.');
        continue;
      }

      // Read index.md front-matter as project config
      const indexSrc = readFile(indexFilePath);
      const indexFm = indexSrc.frontMatter;

      // Read project config (priority: index.md > _config.yml > _data/dossier/*.yml)
      const projCfg = readProjectConfig(dossierPath, entry, indexFm);
      if (projCfg.enable === 'false') continue;

      const scan = scanDir(dossierPath, entry);
      if (scan.files.length === 0 && scan.dirs.length === 0) continue;

      const title = projCfg.title || entry;
      var tags = projCfg.tags || [];
      if (typeof tags === 'string') tags = [tags];
      const nav = buildNavTree(scan, entry, entry + '/');
      const flatList = flattenNav(nav);

      // Find the first non-index article for "开始阅读" button
      var firstNonIndex = flatList.find(function(f) { return !isIndexPage(f); });
      var firstArticleUrl = firstNonIndex ? firstNonIndex.url : null;
      if (!firstArticleUrl) {
        firstArticleUrl = '/dossier/' + entry + '/';
      }

      projects[entry] = {
        id: entry,
        title: title,
        name: entry,
        description: projCfg.description || '',
        tags: tags,
        sort: parseInt(projCfg.sort) || 0,
        nav: nav,
        flatList: flatList,
        scan: scan,
        source: projCfg.source || 'fs',
        firstArticleUrl: firstArticleUrl,
        pageCount: flatList.filter(function(f) { return !isIndexPage(f); }).length
      };

      // Collect tags
      tags.forEach(function(t) {
        if (!allTags[t]) allTags[t] = [];
        if (allTags[t].indexOf(entry) === -1) allTags[t].push(entry);
      });

      // --- Project homepage (index page) ---
      routes.push({
        path: 'dossier/' + entry + '/index.html',
        layout: ['dossier_page'],
        data: {
          layout: 'dossier_page',
          type: 'project_home',
          title: title,
          project_id: entry,
          project: projects[entry],
          content: indexSrc.content,
          frontMatter: indexFm,
          /* front-matter 的 description 必须显式挂到路由数据上。
             原来只落在 `frontMatter.description` 里，而 seo_description()
             读的是 `page.description`——于是每个专题首页的 meta description
             都退化成正文首段（线上出现过「简介 图片来源于网络，侵删。
             SpringCloud学习记录。」这种把正文小标题抠进去的残句），
             index.md 里精心写的那句 120+ 字介绍从未被搜索引擎看到。 */
          description: indexFm.description || '',
          keywords: indexFm.keywords,
          seo_title: indexFm.seo_title,
          nav: projects[entry].nav,
          tags: tags,
          toc: null,
          updated: indexFm.updated || indexFm.date || '',
          prev: null,
          next: null
        }
      });

      // --- Individual doc pages (excluding index/README) ---
      const docPages = [];
      for (var fi = 0; fi < flatList.length; fi++) {
        var f = flatList[fi];
        // Skip index/readme pages (handled as project home above)
        if (isIndexPage(f)) continue;

        const filePath = path.join(dossierPath, entry, f.url.replace('/dossier/' + entry + '/', '').replace('.html', '.md'));
        if (!fs.existsSync(filePath)) continue;
        const doc = readFile(filePath);
        const rendered = hexo.render.renderSync({ text: doc.content, engine: 'markdown' });
        // 对代码块应用 DeepSeek 风格转换
        var transformed = rendered;
        if (typeof global.__transformCodeBlocks === 'function') {
          transformed = global.__transformCodeBlocks(rendered, true);
        }
        const tocData = extractToc(rendered);

        var docSort = doc.frontMatter.sort !== undefined ? parseInt(doc.frontMatter.sort) : undefined;
        var docDate = doc.frontMatter.updated || doc.frontMatter.date || '';

        docPages.push({
          url: f.url,
          title: doc.frontMatter.title || f.title || f.name,
          sort: docSort,
          date: docDate,
          name: f.name,
          routeData: {
            layout: 'dossier_page',
            type: 'doc',
            title: doc.frontMatter.title || f.title || f.name,
            project_id: entry,
            project: projects[entry],
            content: doc.content,
            content_html: transformed,
            frontMatter: doc.frontMatter,
            /* 同项目首页：章节自己写的 description 要能被 seo_description
               读到，否则每章都退化成正文首段，几十个页面共用同一段开头。 */
            description: doc.frontMatter.description || '',
            keywords: doc.frontMatter.keywords,
            seo_title: doc.frontMatter.seo_title,
            nav: projects[entry].nav,
            tags: tags,
            toc: tocData,
            updated: docDate
          }
        });
      }

      // Multi-level sort: index first → sort → date → title
      sortDossierPages(docPages);

      // Assign prev/next pagination
      for (var pi = 0; pi < docPages.length; pi++) {
        docPages[pi].routeData.prev = pi > 0
          ? { url: docPages[pi - 1].url, title: docPages[pi - 1].title }
          : null;
        docPages[pi].routeData.next = pi < docPages.length - 1
          ? { url: docPages[pi + 1].url, title: docPages[pi + 1].title }
          : null;
      }

      // Push paginated doc routes
      docPages.forEach(function(dp) {
        routes.push({
          path: dp.url.replace(/^\//, ''),
          layout: ['dossier_page'],
          data: dp.routeData
        });
      });
    }
  }

  // --- 3. Dossier home ---
  routes.push({
    path: 'dossier/index.html',
    layout: ['index_dossier'],
    data: {
      layout: 'index_dossier',
      title: tr('dossier.page_title'),
      projects: projects,
      allTags: allTags,
      filter: false
    }
  });

  // --- 4. Tag pages ---
  for (const tag of Object.keys(allTags)) {
    if (allTags[tag].length === 0) continue;
    routes.push({
      path: 'dossier/tags/' + tag + '/index.html',
      layout: ['index_dossier'],
      data: {
        layout: 'index_dossier',
        title: tag,
        projects: projects,
        allTags: allTags,
        filter: true,
        tagName: tag
      }
    });
  }

  // Store on theme.config for template access
  hexo.theme.config.dossier = Object.assign({}, dossierCfg, {
    projects: projects,
    allTags: allTags,
    tree: projects,
    shelf: Object.keys(projects),
    path: dossierCfg.path || 'dossier'
  });

  return routes;
});

// ============================================
// Render markdown helper
// ============================================
hexo.extend.helper.register('render_md', function(content) {
  if (!content) return '';
  try {
    var html = hexo.render.renderSync({ text: content, engine: 'markdown' });
    // 对代码块应用 DeepSeek 风格转换
    if (typeof global.__transformCodeBlocks === 'function') {
      html = global.__transformCodeBlocks(html, true);
    }
    return html;
  } catch (e) {
    return '<p>' + content + '</p>';
  }
});

// ============================================
// TOC —— 复用共享实现（scripts/lib/toc-core.js）
// ============================================
/* 以前这里和 scripts/helpers/toc.js 各有一份一模一样的「抽标题建树」代码，
   连正则都相同；两边只要有一边修 bug 另一边就静默保持原样。
   现在统一走 toc-core，配置在调用处传进去。 */

function extractToc(html) {
  var maxDepth = (hexo.theme.config.toc && hexo.theme.config.toc.max_depth) || 3;
  return tocCore.extractToc(html, maxDepth);
}

/* 档案页的目录 HTML。属性与文章页那份保持一致（toc-link + data-toc），
   这样 /js/toc.js 一套选择器就能同时驱动两处，不用再按页面类型分支。 */
hexo.extend.helper.register('render_toc', function (toc) {
  if (!toc || toc.length === 0) return '';
  function render(items) {
    var h = '<ul class="toc-list">';
    items.forEach(function (item) {
      var hasChildren = !!(item.children && item.children.length > 0);
      h += '<li class="toc-item toc-level-' + item.level
        + (hasChildren ? ' has-children' : '') + '">';
      h += '<a href="#' + item.id + '" class="toc-link" data-toc="' + item.id + '">'
        + item.text + '</a>';
      if (hasChildren) h += render(item.children);
      h += '</li>';
    });
    h += '</ul>';
    return h;
  }
  return render(toc);
});
