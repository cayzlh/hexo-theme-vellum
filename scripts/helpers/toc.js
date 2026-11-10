'use strict';

/**
 * TOC —— 抽取标题并挂到 page.toc
 * ---------------------------------------------------------------------------
 * 只负责「什么时候抽、抽多深」，具体怎么抽在 scripts/lib/toc-core.js 里，
 * 和档案系统（scripts/dossier.js）共用同一份实现。
 *
 * 渲染不在这里：模板各自要不同的属性（桌面侧栏带 data-toc、面板要 role），
 * 所以 HTML 由模板拼。这里以前还注册过一个 toc_tree helper，从来没被任何
 * 模板调用过（死代码），已删除。
 */

var tocCore = require('../lib/toc-core');

hexo.extend.filter.register('after_post_render', function (data) {
  var cfg = hexo.theme.config.toc || {};
  if (!cfg.enable) return data;
  if (data.layout !== 'post' && data.layout !== 'page') return data;
  if (!data.content) return data;

  data.toc = tocCore.extractToc(data.content, cfg.max_depth);
  return data;
});
