'use strict';

/**
 * Vellum — 构建期 JSON 拉取（脚本间共享）
 *
 * 为什么单独抽一个文件：/links/ 的收藏列表和首页的壁纸 banner 都要在
 * `hexo generate` 里打同一个外部接口，两处对「失败该怎么办」的答案必须
 * 完全一致——只 warn、不 reject、退化成「这次构建没有这块内容」。写在两个
 * 生成器里各抄一遍，迟早会出现一边 catch 了、另一边把构建搞挂的分叉。
 *
 * 设计要点
 * --------
 * · **永不 reject**。成功 resolve 响应体，任何失败 resolve(null)。构建期的
 *   网络抖动、接口维护、JSON 被中间设备改写，都不该让整站发布失败。
 * · **不 polyfill**。Node 18 起 fetch / AbortController 是全局的；更老的
 *   Node 直接降级，而不是偷偷 require 一个 undici 把体积和依赖塞进主题。
 * · **日志只打一次**。超时的提示统一在 catch 里打，abort 本身不吭声，
 *   否则一次超时会刷出两条互相矛盾的日志。
 *
 * 用法：
 *   var remoteFetch = require('./lib/remote-fetch');
 *   remoteFetch.json(url, { tag: 'bookmarks', timeout: 5000 }).then(function (data) {
 *     // data 是解析后的响应体，或 null
 *   });
 *
 * 所有函数都以「调用方给的一个 log 对象」为出口，不直接读 hexo —— 这样在
 * 测试或手工调用里也能构造。
 */

/** 默认 UA：让服务端日志里能一眼看出是主题在构建期抓的。 */
var USER_AGENT = 'Vellum-Build/1.0';

/**
 * 当前 Node 能不能跑这套拉取逻辑。
 *
 * 分成两条判断而不是一条，是因为它们对使用者的含义不同：缺 fetch 要升 Node，
 * 缺 AbortController 同样要升 Node，但两者出现在不同版本的运行时上，日志里
 * 分开写能省掉一轮排查。
 *
 * @param {object} log hexo.log 之类的对象（需要 warn 方法）
 * @returns {boolean}
 */
function isSupported(log) {
  if (typeof fetch !== 'function') {
    if (log) log.warn('当前 Node 没有全局 fetch（需要 Node 18+），跳过远程拉取。');
    return false;
  }
  if (typeof AbortController !== 'function') {
    if (log) log.warn('当前 Node 没有 AbortController（需要 Node 18+），跳过远程拉取。');
    return false;
  }
  return true;
}

/**
 * 拉一个 JSON 端点。
 *
 * @param {string} url 完整地址
 * @param {object} [options]
 * @param {number} [options.timeout=5000]  超时毫秒数
 * @param {object} [options.log]           提供 warn/info 的对象；省略则静默
 * @param {string} [options.tag='remote']  日志前缀，便于区分是哪个模块在抓
 * @returns {Promise<any|null>} 响应体，或 null（含所有失败情形）
 */
function json(url, options) {
  var opts = options || {};
  var log = opts.log || null;
  var tag = '[' + (opts.tag || 'remote') + '] ';
  var timeout = parseInt(opts.timeout, 10);
  if (!isFinite(timeout) || timeout <= 0) timeout = 5000;

  if (!url) {
    if (log) log.warn(tag + '没有配置接口地址，跳过远程拉取。');
    return Promise.resolve(null);
  }
  if (!isSupported(log)) return Promise.resolve(null);

  var controller = new AbortController();
  var timer = setTimeout(function () {
    /* abort 只负责让请求停下来；超时提示统一在 catch 里打。 */
    controller.abort();
  }, timeout);

  if (log && log.info) log.info(tag + 'Fetching ' + url);

  return fetch(url, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'User-Agent': USER_AGENT
    },
    signal: controller.signal
  }).then(function (res) {
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }).catch(function (err) {
    /* AbortError 是「我们主动停的」，其余是网络/解析问题。两种情况对使用者
       的结论一样（这次没拿到），但原因写清楚能省掉一次「接口是不是坏了」。 */
    var reason = err && err.name === 'AbortError'
      ? ('超时 ' + timeout + 'ms')
      : (err && err.message) || String(err);
    if (log) log.warn(tag + '远程拉取失败（' + reason + '），本次构建跳过。');
    return null;
  }).then(function (value) {
    clearTimeout(timer);
    return value;
  });
}

module.exports = {
  json: json,
  isSupported: isSupported
};
