'use strict';

/**
 * TOC 核心 —— 纯函数，无 hexo 依赖。
 * ---------------------------------------------------------------------------
 * 为什么单独抽出来：文章（after_post_render 过滤器）和档案（自有 generator）
 * 各有一套一模一样的「从 HTML 抽标题 → 建树」逻辑，两处各改一遍必然漂移。
 * 这里只留一份，两边 require 同一个模块。
 *
 * 必须保持纯函数：不读 hexo.theme.config、不写日志、不注册任何东西。
 * 配置由调用方算好当参数传进来。
 */

/** 常见 HTML 实体。标题里出现 &amp; / &#x2F; 时，不还原就成了字面噪音。 */
var ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' '
};

function decodeEntities(str) {
  if (!str) return '';
  var out = str.replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39);/g, function (m) {
    return ENTITIES[m] != null ? ENTITIES[m] : m;
  });
  // &#x2F; 这类数字实体（hexo-util 的 escapeHTML 会把 / 编成 &#x2F;）
  return out.replace(/&#x([0-9a-f]+);/gi, function (m, hex) {
    var code = parseInt(hex, 16);
    return isNaN(code) ? m : String.fromCharCode(code);
  }).replace(/&#(\d+);/g, function (m, dec) {
    var code = parseInt(dec, 10);
    return isNaN(code) ? m : String.fromCharCode(code);
  });
}

/**
 * 从渲染后的 HTML 里抽出标题树。
 *
 * @param {string} html      渲染后的正文 HTML
 * @param {number} maxDepth  收录到第几级（含），默认 3
 * @returns {Array} 形如 [{ level, id, text, children: [] }]
 *
 * 顶层规则：任何标题都能成为顶层（不强制必须是 h2）。站内有 19 篇文档
 * 直接从 h3 起手，以前的实现会把它们全塞进一个不存在的 h2 下面，结果
 * 移动端面板整块空白——这里按「层级只增不降」建树，首个标题始终是顶层。
 */
function extractToc(html, maxDepth) {
  if (!html) return [];

  var depthLimit = parseInt(maxDepth, 10);
  if (!depthLimit || depthLimit < 1 || depthLimit > 6) depthLimit = 3;

  var toc = [];
  var stack = [{ children: toc, level: 0 }];
  var re = /<h([1-6])\s+id="([^"]*)"[^>]*>([\s\S]*?)<\/h\1>/gi;
  var m;

  while ((m = re.exec(html)) !== null) {
    var level = parseInt(m[1], 10);
    if (level > depthLimit) continue;

    var id = m[2];
    if (!id) continue;

    /* 标题里的 <a class="headerlink"> 是空锚点，直接去标签就够了；
       剩下的实体在这里还原，避免目录里出现 &#x2F; 这种字面量。 */
    var text = decodeEntities(m[3].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim());
    if (!text) continue;

    var item = { level: level, id: id, text: text, children: [] };

    // 弹到第一个层级严格小于当前标题的节点，挂到它下面
    while (stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop();
    stack[stack.length - 1].children.push(item);
    stack.push(item);
  }

  return toc;
}

/** 扁平化，供搜索索引 / 校验用（跳过 children，只取同级序列）。 */
function flattenToc(toc) {
  var out = [];
  (function walk(items) {
    for (var i = 0; i < items.length; i++) {
      out.push(items[i]);
      if (items[i].children && items[i].children.length) walk(items[i].children);
    }
  })(toc || []);
  return out;
}

module.exports = {
  extractToc: extractToc,
  flattenToc: flattenToc,
  decodeEntities: decodeEntities
};
