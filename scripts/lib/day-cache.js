'use strict';

/**
 * Vellum — 构建期「按天」缓存（脚本间共享）
 *
 * 用途：一天内重复 `hexo generate`（`hexo server` 的热重载、本地反复调样式）
 * 不必反复打外部接口。缓存文件写在站点根目录，文件名由调用方指定，
 * 主题的 .gitignore 已经把这些文件列进去。
 *
 * 为什么要有这个文件而不是再抄一遍 zaobao.js 里那段：
 * 按天缓存最容易错的不是读写文件，而是**「今天」怎么算**。GitHub Actions 的
 * ubuntu-latest 默认 TZ=UTC，用 getDate() 读本地时间会得到比北京时间早 8 小时
 * 的日期；北京时间 00:00–08:00 之间构建，就会把昨天的缓存当成今天的、或者把
 * 今天的缓存判成过期的。所以日期一律按 Asia/Shanghai（UTC+8，无夏令时）算，
 * 用 UTC 时间戳加固定偏移，不依赖运行时的 tzdata 与 TZ 环境变量。
 *
 * 用法：
 *   var dayCache = require('./lib/day-cache');
 *   var cache = dayCache.load(hexo.base_dir, '.banner_cache.json', log, 'banner');
 *   if (cache) { ... }            // cache.data 是上次存进去的内容
 *   dayCache.save(hexo.base_dir, '.banner_cache.json', data, log, 'banner');
 *
 * 读写失败一律吞掉（只打 warn）：缓存是加速手段，不是正确性的一部分，
 * 磁盘只读或并行构建抢写时宁可打接口，也不该让构建失败。
 */

var fs = require('fs');
var path = require('path');

/* Asia/Shanghai 相对 UTC 的固定偏移（分钟）。中国不实行夏令时，
   所以这里可以是常数，不需要 tzdata。 */
var TZ_OFFSET_MIN = 8 * 60;

/** 把日期拆成北京时间下的年月日时分。 */
function shanghaiParts(date) {
  var d = date || new Date();
  var shifted = new Date(d.getTime() + TZ_OFFSET_MIN * 60 * 1000);
  function pad(n) { return String(n).padStart(2, '0'); }
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    pad: pad
  };
}

/** 北京时间的 YYYY-MM-DD，用作缓存的新鲜度键。 */
function today(date) {
  var p = shanghaiParts(date);
  return p.year + '-' + p.pad(p.month) + '-' + p.pad(p.day);
}

/** 北京时间的 YYYY-MM-DD HH:mm，只用于页面上的「更新于」。 */
function now(date) {
  var p = shanghaiParts(date);
  return today(date) + ' ' + p.pad(p.hour) + ':' + p.pad(p.minute);
}

/** 缓存文件的绝对路径。 */
function filePath(baseDir, name) {
  return path.join(baseDir || process.cwd(), name);
}

/**
 * 读缓存。只认**今天**写的那份：昨天的数据意味着今天应该重新抓一次
 * （壁纸每天换一张），拿旧数据顶上就等于页面永远慢一天。
 *
 * @returns {object|null} 形如 { date, time, data }，过期/不存在/坏文件都是 null
 */
function load(baseDir, name, log, tag) {
  var prefix = '[' + (tag || 'cache') + '] ';
  try {
    var file = filePath(baseDir, name);
    if (!fs.existsSync(file)) return null;
    var raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!raw || raw.date !== today()) return null;
    return raw;
  } catch (e) {
    /* 坏 JSON 不该让构建挂掉，也不值得报警——下一次 save 就会覆盖它。
       但打一行 info 有助于解释「为什么这次又打接口了」。 */
    if (log && log.info) log.info(prefix + '缓存不可用（' + (e && e.message) + '），改为重新抓取。');
    return null;
  }
}

/**
 * 写缓存。date / time 自动补上，调用方只管 data。
 *
 * @returns {boolean} 是否写成功（失败不抛错）
 */
function save(baseDir, name, data, log, tag) {
  var prefix = '[' + (tag || 'cache') + '] ';
  try {
    fs.writeFileSync(
      filePath(baseDir, name),
      JSON.stringify({ date: today(), time: now(), data: data }, null, 2),
      'utf-8'
    );
    return true;
  } catch (e) {
    if (log && log.warn) log.warn(prefix + '缓存写入失败（' + (e && e.message) + '），下次构建会重新抓取。');
    return false;
  }
}

module.exports = {
  today: today,
  now: now,
  load: load,
  save: save
};
