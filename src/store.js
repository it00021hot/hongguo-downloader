/**
 * store.js - 精简持久化模块
 * 用单个 JSON 文件保存「设置」与「下载任务」，替代原项目里的 sql.js 数据库 + electron-store，
 * 减少依赖，方便独立打包。
 */
const fs = require('fs');
const path = require('path');

let dataFile = null;
let cache = null; // { settings, tasks }

function loadCache() {
  if (!dataFile) throw new Error('store 未初始化');
  if (cache) return cache;
  try {
    if (fs.existsSync(dataFile)) {
      cache = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    }
  } catch (e) {
    // 解析失败说明文件已损坏（写一半掉电、被外部工具改坏等）。
    // 这里绝不能直接丢掉：先备份一份，用户还能手工捞回下载记录。
    console.error('[Store] 读取数据文件失败，已备份并使用空数据:', e.message);
    try {
      if (fs.existsSync(dataFile)) {
        const backup = `${dataFile}.corrupt-${Date.now()}`;
        fs.renameSync(dataFile, backup);
        console.error(`[Store] 损坏文件已备份到: ${backup}`);
      }
    } catch (be) {
      console.error('[Store] 备份损坏文件失败:', be.message);
    }
    cache = {};
  }
  if (!cache || typeof cache !== 'object') cache = {};
  if (!Array.isArray(cache.tasks)) cache.tasks = [];
  if (!cache.settings || typeof cache.settings !== 'object') cache.settings = {};
  return cache;
}

/**
 * 原子写：先写同目录临时文件，再 rename 覆盖。
 *
 * 直接 writeFileSync 会先把目标文件截断，若此刻进程被杀 / 掉电，
 * data.json 就停在「写了一半」的状态，下次启动解析失败 → 下载记录、
 * 设置、剧集档案全部归零。rename 在同一文件系统内是原子的，
 * 读到的永远是「改动前」或「改动后」的完整文件。
 */
function flush() {
  if (!dataFile) return;
  const tmp = `${dataFile}.tmp`;
  try {
    fs.mkdirSync(path.dirname(dataFile), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(cache || {}, null, 2), 'utf8');
    fs.renameSync(tmp, dataFile);
  } catch (e) {
    console.error('[Store] 写入数据文件失败:', e.message);
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch (_) {
      /* 临时文件清理失败不影响主流程 */
    }
  }
}

function init(filePath) {
  dataFile = filePath;
  loadCache();
}

function getSettings() {
  return loadCache().settings;
}

function saveSettings(settings) {
  loadCache().settings = settings || {};
  flush();
}

function getTasks() {
  return loadCache().tasks;
}

function saveTasks(tasks) {
  loadCache().tasks = tasks || [];
  flush();
}

// ===== 短剧档案（让播放页在没有下载任务时也能列出完整分集）=====
function getSeries() {
  const c = loadCache();
  if (!Array.isArray(c.series)) c.series = [];
  return c.series;
}

function saveSeries(list) {
  loadCache().series = list || [];
  flush();
}

// ===== 播放进度（断点续播）=====
function getPlayback() {
  const c = loadCache();
  if (!c.playback || typeof c.playback !== 'object') c.playback = {};
  return c.playback;
}

function savePlayback(map) {
  loadCache().playback = map || {};
  flush();
}

// ===== 合并任务记录 =====
function getMergeTasks() {
  const c = loadCache();
  if (!Array.isArray(c.mergeTasks)) c.mergeTasks = [];
  return c.mergeTasks;
}

function saveMergeTasks(list) {
  loadCache().mergeTasks = list || [];
  flush();
}

module.exports = {
  init,
  getSettings,
  saveSettings,
  getTasks,
  saveTasks,
  getSeries,
  saveSeries,
  getPlayback,
  savePlayback,
  getMergeTasks,
  saveMergeTasks,
};

