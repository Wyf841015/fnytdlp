/**
 * fnytdlp - fnOS 视频下载器
 * 集成 yt-dlp binary, Node.js 进程管理 + 任务调度 + 进度推送
 *
 * 架构:
 *   - 单一 UNIX socket 给 fnOS 网关代理
 *   - 单一 HTTP 端口给本地调试
 *   - SSE 推送实时进度给前端
 *   - spawn() 启 yt-dlp 子进程, parse --newline --progress-template 进度行
 *
 * 数据存储:
 *   - 配置: ${TRM_PKGVAR}/config.json
 *   - 任务: ${TRM_PKGVAR}/tasks.json
 *   - 日志: ${TRM_PKGVAR}/info.log (fnOS 框架约定的位置)
 *
 * 安全:
 *   - URL 只允许 http(s) 协议 (防 file:///etc/passwd 类攻击)
 *   - 路径白名单: 下载路径必须在已注册的 downloadPath 列表内
 *   - cookie 文件: 用户上传, 限 ${TRM_PKGVAR}/cookies.txt 单文件
 */

'use strict';

// ══════════════════════════════════════════════════════════════════
// 模块 1: 导入 + 常量
// ══════════════════════════════════════════════════════════════════

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyLine as _applyProgressLine, newTask as _newProgressTask } from './util/progress-aggregator.js';

// ── version (保持与 manifest 一致 ────────────────────────────────────────
const VERSION = '0.2.2';
// ── paths ──────────────────────────────────────────────────────────────
const PKGVAR    = process.env.TRM_PKGVAR || process.env.TRIM_PKGVAR || null;
const APPDEST   = process.env.TRIM_APPDEST || null;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR    = __dirname;
const TARGET_DIR = path.dirname(__dirname);
const APP_DIR    = path.dirname(TARGET_DIR);

const DATA_DIR  = PKGVAR ? path.join(PKGVAR, 'data') : path.join(APP_DIR, 'data');
const LOG_FILE  = PKGVAR ? path.join(PKGVAR, 'info.log') : path.join(DATA_DIR, 'server.log');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const TASKS_FILE  = path.join(DATA_DIR, 'tasks.json');
const COOKIES_DIR = PKGVAR ? path.join(PKGVAR, 'cookies') : path.join(DATA_DIR, 'cookies');

const SOCK_NAME = 'fnytdlp.sock';
const SOCK_PATH = path.join(TARGET_DIR, SOCK_NAME);
const PORT      = parseInt(process.env.PORT || '0') || 9634;
const BASE_PATH = '/app/fnytdlp';

// ── yt-dlp binary 路径 (自适应 x86_64 / aarch64) ─────────────────
// 启动时根据 process.arch 选对应 binary:
//   - x64   → bin/yt-dlp-x86_64
//   - arm64 → bin/yt-dlp-aarch64
//   - 其他  → 兜底 bin/yt-dlp
// 注: zipimport 模式 binary 内容是平台无关 Python 脚本, 同份文件可在 x86_64 / aarch64 都跑
// 但保留两个不同文件名方便用户/系统明确知道运行在哪个架构, 未来可替换为 musl native binary
const BIN_DIR = path.join(__dirname, 'bin');
const pickYtDlpBin = () => {
  if (process.env.YT_DLP_BIN) return process.env.YT_DLP_BIN;  // 用户环境变量优先
  const arch = process.arch;  // 'x64' / 'arm64' / 'ia32' / ...
  if (arch === 'arm64') {
    const a = path.join(BIN_DIR, 'yt-dlp-aarch64');
    if (fs.existsSync(a)) return a;
  }
  if (arch === 'x64' || arch === 'ia32') {
    const x = path.join(BIN_DIR, 'yt-dlp-x86_64');
    if (fs.existsSync(x)) return x;
  }
  // 兜底: 通用名 (兼容老版本)
  return path.join(BIN_DIR, 'yt-dlp');
};
const YT_DLP_BIN = pickYtDlpBin();
// ffmpeg 路径 (fnOS 系统自带 /usr/bin/ffmpeg, 也允许环境变量覆盖)
const FFMPEG_BIN = process.env.FFMPEG_BIN || '/usr/bin/ffmpeg';

fs.mkdirSync(DATA_DIR, { recursive: true });

// ══════════════════════════════════════════════════════════════════
// 模块 2: 工具函数 (parseSpeed, parseDuration, sanitizeFilename, LOG)
// ══════════════════════════════════════════════════════════════════
// ── logging ────────────────────────────────────────────────────────────
const pad = n => String(n).padStart(2, '0');
const ts = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
// yt-dlp _speed_str 示例: "1.23MiB/s", "500KiB/s", "12.3MB/s", "Unknown B/s", "0KiB/s"
const parseSpeed = (s) => {
  if (!s || s === 'Unknown B/s' || s === 'N/A') return 0;
  // yt-dlp _speed_str 格式: " 752.21KiB/s" (前导空格) 或 " 1.05MiB/s"
  // 兼容: 1)前导空格 2)NaN 3)未知单位
  const m = String(s).trim().match(/^([\d.]+)\s*(KiB|MiB|GiB|KB|MB|GB|B)\/s$/i);
  if (!m) return 0;
  const v = parseFloat(m[1]);
  if (isNaN(v)) return 0;
  const unit = m[2].toUpperCase();
  const mult = { B: 1, KB: 1024, MB: 1024**2, GB: 1024**3, KIB: 1024, MIB: 1024**2, GIB: 1024**3 }[unit] || 1;
  return Math.round(v * mult);
};
// yt-dlp _eta_str 示例: "00:01:23", "01:23", "Unknown", "N/A"
const parseDuration = (s) => {
  if (!s || s === 'Unknown' || s === 'N/A') return 0;
  const parts = String(s).split(':').map(n => parseInt(n, 10) || 0);
  if (parts.length === 3) return parts[0]*3600 + parts[1]*60 + parts[2];
  if (parts.length === 2) return parts[0]*60 + parts[1];
  if (parts.length === 1) return parts[0];
  return 0;
};
const sanitizeFilename = (s) => {
  // 保留中文/字母/数字/空格/横线/下划线/点/括号, 移除危险字符
  return String(s || 'video').replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim().substring(0, 128) || 'video';
};
const LOG = (...args) => {
  const line = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  fs.appendFileSync(LOG_FILE, ts() + ' ' + line + '\n');
  console.log('[fnytdlp]', line);
};

LOG('=== server starting ===');
LOG('PKGVAR=' + PKGVAR);
LOG('TARGET_DIR=' + TARGET_DIR);
LOG('YT_DLP_BIN=' + YT_DLP_BIN);
LOG('FFMPEG_BIN=' + FFMPEG_BIN);

// P2-3: 启动时检测 yt-dlp 版本
if (fs.existsSync(YT_DLP_BIN)) {
  try {
    const { spawnSync } = await import('node:child_process');
    const result = spawnSync(YT_DLP_BIN, ['--version'], { timeout: 5000, encoding: 'utf8' });
    if (result.status === 0) {
      LOG('yt-dlp version: ' + result.stdout.trim());
    } else {
      LOG('yt-dlp version check failed: exit ' + result.status);
    }
  } catch (e) {
    LOG('yt-dlp version check error: ' + e.message);
  }
}

// ── helpers ────────────────────────────────────────────────────────────
const sendJSON = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
};

const detectArch = () => {
  const arch = process.arch;  // 'x64' / 'arm64' / 'ia32'
  // 优先用 process.arch, 避免 fnOS uname 权限问题
  if (arch === 'x64') return 'x86_64';
  if (arch === 'arm64') return 'aarch64';
  if (arch === 'ia32') return 'i686';
  return arch;
};
const ARCH = detectArch();
LOG('detected arch=' + ARCH + ' (process.arch=' + process.arch + ')');

// ── 订阅检查 ─────────────────────────────────────────────────
const _subCheckRunning = { current: false };
const checkSubscriptions = async () => {
  if (_subCheckRunning.current) { LOG('[sub] check already running, skip'); return []; }
  _subCheckRunning.current = true;
  const subs = config.subscriptions || [];
  const results = [];
  try {
    for (const sub of subs) {
      if (!sub.enabled) continue;
      const lastCheck = sub._lastCheck || 0;
      if (Date.now() - lastCheck < (sub.interval || 3600) * 1000) continue;
      LOG('[sub] checking:', sub.name, sub.url);
      try {
        const newIds = await getLatestIds(sub.url, sub.cookieName, sub.lastId);
        if (newIds.length > 0) {
          LOG('[sub] found', newIds.length, 'new items for', sub.name);
          sub.lastId = newIds[0].id;
          for (const item of newIds) {
            try {
              const opts = {};
              if (sub.cookieName) opts.cookieName = sub.cookieName;
              if (sub.format) opts.format = sub.format;
              const task = await parseAndCreateTask(item.url || sub.url, opts);
              results.push({ name: sub.name, title: item.title || item.id, taskId: task.id });
            } catch (e) {
              LOG('[sub] createTask failed for', item.id, e.message);
            }
          }
        }
        sub._lastCheck = Date.now();
      } catch (e) {
        LOG('[sub] check failed for', sub.name, e.message);
      }
    }
    saveConfig();
  } finally {
    _subCheckRunning.current = false;
  }
  return results;
};

const getLatestIds = (url, cookieName, lastId) => {
  return new Promise((resolve, reject) => {
    const args = ['--flat-playlist', '--dump-json', '--no-warnings', '--playlist-reverse'];
    if (cookieName && config.cookies && config.cookies.some(c => c.name === cookieName)) {
      const fp = getCookieFile(cookieName);
      if (fs.existsSync(fp)) args.push('--cookies', fp);
    }
    args.push(url);
    const proc = spawn(YT_DLP_BIN, args, {
      env: { ...process.env, PATH: process.env.PATH + ':/usr/bin:/usr/local/bin' },
      timeout: 30000,
    });
    let out = '', err = '';
    proc.stdout.on('data', c => out += c);
    proc.stderr.on('data', c => err += c);
    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch (e) {}
      reject(new Error('timeout'));
    }, 30000);
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(err.trim() || `exit ${code}`));
      const lines = out.trim().split('\n').filter(Boolean).reverse();
      const newItems = [];
      let foundOld = false;
      for (const line of lines) {
        try {
          const e = JSON.parse(line);
          if (foundOld || e._type === 'playlist') continue;
          if (lastId && e.id === lastId) { foundOld = true; continue; }
          newItems.push({ id: e.id, title: e.title, url: e.url || e.webpage_url || '' });
        } catch (e) { /* skip */ }
      }
      resolve(newItems);
    });
    proc.on('error', reject);
  });
};
// ══════════════════════════════════════════════════════════════════
// 模块 3: 配置 + 任务存储 + SSE
// ══════════════════════════════════════════════════════════════════
const DEFAULT_CONFIG = {
  downloadPath: path.join(DATA_DIR, 'downloads'),
  concurrentDownloads: 3,         // 同时下载任务数
  embedMetadata: true,             // 嵌入元数据 (标题/上传者/日期)
  writeSubs: false,                // 下载字幕
  writeAutoSubs: false,            // 下载自动生成字幕
  writeThumbnail: true,            // 下载缩略图
  sponsorblockMark: [],            // SponsorBlock 标记: ['sponsor','selfpromo','interaction','intro','outro','preview','music_offtopic']
  outputTemplate: '%(title)s [%(id)s].%(ext)s',
  format: 'bv*+ba/b',              // 默认 bestvideo+bestaudio / best
  formatSort: null,                // 例: 'res:1080,ext:mp4:m4a'
  retries: 3,
  concurrentFragments: 4,
  proxyUrl: '',
  noPlaylist: false,
  // Cookie 多网站列表: [{name, domain}] (文件存于 cookies/<safeName>.txt)
  cookies: [],
  // 新增 12 个参数 (2025-06-09 批量增强)
  limitRate: '',                   // --limit-rate 例 '5M' '500K', 空=不限速
  subLangs: '',                    // --sub-langs 例 'zh-Hans,en,en-US' 或 'all,-live_chat'
  extractAudio: false,             // -x 提取音频
  audioFormat: '',                 // --audio-format 例 'mp3' 'm4a' 'opus' 'flac'
  audioQuality: '',                // --audio-quality 例 '128K' '0' (0=best 10=worst)
  embedSubs: false,                // --embed-subs 把字幕嵌入视频文件
  embedThumbnail: false,           // --embed-thumbnail 把缩略图嵌入视频
  mergeOutputFormat: '',           // --merge-output-format 例 'mp4' 'mkv' 'mp4/mkv'
  downloadArchive: '',             // --download-archive 文件路径, 空=不启用
  mtime: true,                     // --no-mtime 反向: true=用 Last-Modified, false=用下载时间
  matchFilters: '',                // --match-filters 例 '!is_live & like_count>?100'
  dateAfter: '',                   // --dateafter YYYYMMDD 或 'today-1week'
  dateBefore: '',                  // --datebefore YYYYMMDD
  minFilesize: '',                 // --min-filesize 例 '50k' '10M'
  maxFilesize: '',                 // --max-filesize 例 '2G'
  maxDownloads: 0,                 // --max-downloads 0=不限
  convertSubs: '',                 // --convert-subs 例 'srt' 'vtt' (空=不转换)
  audioMultistreams: false,        // --audio-multistreams 多音轨合并
  // 频道订阅
  subscriptions: [],               // [{url, name, lastId, interval, cookieName, format, enabled}]
};

let config = { ...DEFAULT_CONFIG };
const loadConfig = () => {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      config = { ...DEFAULT_CONFIG, ...raw };
    }
  } catch (e) { LOG('config load failed:', e.message); }
};
const _atomicWrite = (filePath, data) => {
  const tmp = filePath + '.tmp.' + crypto.randomUUID().slice(0, 8);
  fs.writeFileSync(tmp, data, { mode: 0o644 });
  fs.renameSync(tmp, filePath);
};
const saveConfig = () => {
  try {
    _atomicWrite(CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch (e) { LOG('config save failed:', e.message); }
};
loadConfig();
LOG('config loaded, downloadPath=' + config.downloadPath);

// ── tasks store ───────────────────────────────────────────────────────
let tasks = new Map();   // id -> Task
let _taskIdCounter = 0;
const loadTasks = () => {
  try {
    if (fs.existsSync(TASKS_FILE)) {
      const arr = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
      for (const t of arr) {
        // 启动时所有 downloading 重置为 pending (让用户重新触发)
        if (['downloading', 'pending', 'processing'].includes(t.status)) {
          t.status = 'paused';
        }
        tasks.set(t.id, t);
        _taskIdCounter = Math.max(_taskIdCounter, parseInt(t.id.split('_')[1]) || 0);
      }
    }
  } catch (e) { LOG('tasks load failed:', e.message); }
};
const saveTasks = () => {
  try {
    _atomicWrite(TASKS_FILE, JSON.stringify(Array.from(tasks.values()), null, 2));
  } catch (e) { LOG('tasks save failed:', e.message); }
};
loadTasks();

// ── SSE clients ───────────────────────────────────────────────────────
const _sseClients = new Set();
const broadcast = (event, data) => {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of _sseClients) {
    try { client.write(msg); } catch (e) {
      _sseClients.delete(client);
    }
  }
};
const handleSSE = (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('event: ping\ndata: {}\n\n');
  _sseClients.add(res);
  LOG('[sse] client connected, total=' + _sseClients.size);
  req.on('close', () => {
    _sseClients.delete(res);
    LOG('[sse] client disconnected, total=' + _sseClients.size);
  });
};

// ── active download processes ────────────────────────────────────────
const _procs = new Map();   // taskId -> ChildProcess

// ══════════════════════════════════════════════════════════════════
// 模块 4: 任务 CRUD + yt-dlp 管理
// ══════════════════════════════════════════════════════════════════
// ── URL validation ────────────────────────────────────────────────────
// ── Cookies 多网站管理 ─────────────────────────────────────────────
const safeName = (s) => String(s).toLowerCase().replace(/[^a-z0-9_-]/g, '_').substring(0, 64);
const ensureCookiesDir = () => { try { fs.mkdirSync(COOKIES_DIR, { recursive: true }); } catch (e) { LOG('ensureCookiesDir failed:', e.message); } };
const getCookieFile = (name) => path.join(COOKIES_DIR, safeName(name) + '.txt');
const listCookies = () => (config.cookies || []).map(c => ({ name: c.name, domain: c.domain || '' }));
const addCookie = (name, domain, content) => {
  ensureCookiesDir();
  if (!name || typeof name !== 'string') throw new Error('name required');
  content = String(content).trim();
  // 校验: 大小限制 100KB
  if (content && content.length > 102400) {
    throw new Error('Cookie content too large (max 100KB)');
  }
  // 校验: 必须含 tab 分隔的 Netscape 格式; 若无 tab 至少 20 字符 (兜底)
  if (!content || (!content.includes('\\t') && content.length < 20)) {
    throw new Error('Invalid cookie content (must be tab-separated Netscape format, e.g. ".example.com\\\\tTRUE\\\\t/\\\\tFALSE\\\\t0\\\\tNAME\\\\tVALUE")');
  }
  const list = config.cookies || [];
  const idx = list.findIndex(c => c.name === name);
  const entry = { name, domain: domain || '' };
  if (idx >= 0) list[idx] = entry; else list.push(entry);
  config.cookies = list;
  fs.writeFileSync(getCookieFile(name), content, { mode: 0o600 });
  saveConfig();
};
const deleteCookie = (name) => {
  const list = config.cookies || [];
  config.cookies = list.filter(c => c.name !== name);
  const fp = getCookieFile(name);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  saveConfig();
};

const isValidUrl = (url) => {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (e) { return false; }
};

// ── path whitelist (下载路径必须在合理的系统路径下) ──────────
const _SYSTEM_BLOCKED = ['/etc', '/proc', '/sys', '/dev', '/boot', '/lost+found', '/root', '/var/run', '/var/log', '/var/cache', '/snap', '/lib', '/lib64', '/bin', '/sbin', '/usr/bin', '/usr/sbin', '/usr/lib', '/usr/lib64', '/opt'];
const isSystemPath = (p) => {
  const resolved = path.resolve(p);
  for (const b of _SYSTEM_BLOCKED) {
    if (resolved === b || resolved.startsWith(b + '/') || resolved.startsWith(b + path.sep)) return true;
  }
  return false;
};
const isSafeDownloadPath = (target) => {
  if (!target) return false;
  const resolved = path.resolve(target);
  const allowed = path.resolve(config.downloadPath);
  return resolved.startsWith(allowed) && !isSystemPath(resolved);
};

// ── create task ───────────────────────────────────────────────────────
const createTask = (url, options = {}) => {
  if (!isValidUrl(url)) {
    throw new Error(`Invalid URL (only http/https allowed): ${url}`);
  }
  // 去重: 相同 URL 且状态为 downloading/pending 时拒绝
  for (const [id, t] of tasks) {
    if (t.url === url && (t.status === 'pending' || t.status === 'downloading')) {
      throw new Error(`任务已存在: ${url} (${id})`);
    }
  }
  _taskIdCounter++;
  const id = `t_${crypto.randomUUID().slice(0, 8)}`;
  const task = {
    id,
    url,
    title: '',
    thumbnail: '',
    duration: 0,
    status: 'pending',    // pending → downloading → processing → completed / error / paused / stopped
    progress: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    speed: 0,
    eta: 0,
    format: '',
    ext: '',
    filename: '',
    error: '',
    options: { ...options },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    completedAt: 0,
  };
  tasks.set(id, task);
  saveTasks();
  broadcast('task-created', task);
  return task;
};

const listTasks = (filter = {}) => {
  let arr = Array.from(tasks.values());
  // 兜底: completed 任务若 filename 为空或是封面图, 从 downloadPath 找最新文件
  for (const t of arr) {
    // 暴露 _downloadFolder 给前端, 详情弹窗能拼出真实路径 (dlPath + folder + filename)
    if (t.options && t.options._downloadFolder) {
      t._downloadFolder = t.options._downloadFolder;
    }
    if (t.status === 'completed' && (!t.filename || /\.(webp|jpe?g|png|gif|info\.json)$/i.test(t.filename))) {
      try {
        const files = fs.readdirSync(config.downloadPath)
          .map(f => {
            try {
              const fp = path.join(config.downloadPath, f);
              const st = fs.statSync(fp);
              return { name: f, mtime: st.mtimeMs || 0, size: st.size };
            } catch (e) { return null; }
          })
          .filter(x => x && x.size > 0 && !x.name.endsWith('.part') && !x.name.endsWith('.ytdl') && !x.name.startsWith('.') && !/\.(webp|jpe?g|png|gif|info\.json)$/i.test(x.name))
          .sort((a, b) => b.mtime - a.mtime);
        if (files.length > 0) {
          t.filename = files[0].name;
          t.totalBytes = files[0].size;
          t.downloadedBytes = files[0].size;
        }
      } catch (e) { LOG('[listTasks] filename stat failed:', e.message); }
    } else if (t.status === 'completed' && (!t.totalBytes || t.totalBytes === 0) && t.filename) {
      try {
        const fp = path.join(config.downloadPath, t.filename);
        const st = fs.statSync(fp);
        if (st.isFile() && st.size > 0) {
          t.totalBytes = st.size;
          t.downloadedBytes = st.size;
        }
      } catch (e) { LOG('[listTasks] totalBytes stat failed:', e.message); }
    }
  }
  if (filter.status) arr = arr.filter(t => filter.status.includes(t.status));
  // 排序: 活跃任务在前, 然后按 createdAt 倒序
  arr.sort((a, b) => {
    const aActive = ['downloading', 'processing', 'pending'].includes(a.status) ? 0 : 1;
    const bActive = ['downloading', 'processing', 'pending'].includes(b.status) ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    return b.createdAt - a.createdAt;
  });
  return arr;
};

const getTask = (id) => tasks.get(id);

const deleteTask = (id, opts = {}) => {
  const task = tasks.get(id);
  if (!task) return false;
  if (_procs.has(id)) {
    try { _procs.get(id).kill('SIGTERM'); } catch (e) {}
    _procs.delete(id);
  }
  // 删除下载文件夹 (只有 deleteFile=true 时删)
  if (opts.deleteFile) {
    let folder = task.options?._downloadFolder;
    // 兜底: 如果 _downloadFolder 不存在, 尝试用 downloadFolder + downloadPath 拼
    if (!folder && task.downloadFolder && config.downloadPath) {
      folder = path.join(config.downloadPath, task.downloadFolder);
    }
    if (folder) {
      LOG('[deleteTask] attempting to delete folder:', folder);
      if (fs.existsSync(folder)) {
        try {
          fs.rmSync(folder, { recursive: true, force: true });
          LOG('[deleteTask] deleted folder:', folder);
        } catch (e) {
          LOG('[deleteTask] failed to delete folder:', e.message);
        }
      } else {
        LOG('[deleteTask] folder not found:', folder);
      }
    } else {
      LOG('[deleteTask] no folder path available for task:', task.id);
    }
  }
  tasks.delete(id);
  saveTasks();
  broadcast('task-deleted', { id });
  return true;
};

const stopTask = (id) => {
  const proc = _procs.get(id);
  if (proc) {
    try { proc.kill('SIGTERM'); } catch (e) {}
    const task = tasks.get(id);
    if (task) { task.status = 'stopped'; task.updatedAt = Date.now(); saveTasks(); broadcast('task-updated', task); }
    return true;
  }
  return false;
};

const pauseTask = (id) => {
  // yt-dlp 不支持暂停, 实现为 stop + 标记 paused
  // 用户重连时重新调度 (startTask 走 --no-part 续传逻辑暂未实现, 简化: 删除旧任务重建)
  return stopTask(id);
};

// ── yt-dlp spawn (核心) ──────────────────────────────────────────────
const buildYtDlpArgs = (task) => {
  const args = [];
  const opts = task.options || {};
  // 进度输出: --progress-template stdout (不用 --print, 它会让 yt-dlp 变 dry-run)
  args.push('--newline');
  args.push('--no-colors');
  args.push('--no-warnings');
  args.push('--progress-template', 'PROGRESS|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|DONE');
  // 输出模板
  const outTpl = config.outputTemplate || DEFAULT_CONFIG.outputTemplate;
  // feat3: 如果有下载文件夹则使用文件夹路径, 否则用默认 downloadPath
  const outputBase = opts._downloadFolder || config.downloadPath;
  args.push('-o', path.join(outputBase, outTpl));
  // Format
  if (opts.format) args.push('-f', opts.format);
  else if (config.format) args.push('-f', config.format);
  // Format sort
  if (config.formatSort) args.push('-S', config.formatSort);
  // 并发分片
  const cf = opts.concurrentFragments ?? config.concurrentFragments ?? 4;
  if (cf > 0) args.push('--concurrent-fragments', String(cf));
  // 重试
  args.push('--retries', String(opts.retries ?? config.retries ?? 3));
  // 嵌入元数据
  if (config.embedMetadata) args.push('--embed-metadata');
  // 字幕
  if (config.writeSubs) {
    args.push('--write-subs');
    if (config.writeAutoSubs) args.push('--write-auto-subs');
  }
  // 缩略图
  if (config.writeThumbnail) args.push('--write-thumbnail');
  // SponsorBlock
  // P1-3: 有具体分类时不加冗余的 --sponsorblock-mark all（all 会标记所有类型）
  if (Array.isArray(config.sponsorblockMark) && config.sponsorblockMark.length > 0) {
    for (const cat of config.sponsorblockMark) {
      args.push('--sponsorblock-mark', cat);
    }
  }
  // Cookie (按任务指定 cookieName)
  if (opts.cookieName && config.cookies && config.cookies.some(c => c.name === opts.cookieName)) {
    const fp = getCookieFile(opts.cookieName);
    if (fs.existsSync(fp)) args.push('--cookies', fp);
  }
  // 代理
  if (config.proxyUrl) args.push('--proxy', config.proxyUrl);
  // Playlist
  if (config.noPlaylist) args.push('--no-playlist');
  // 部分播放列表: 如果指定了 playlistItems, 传 --playlist-items
  if (opts.playlistItems) {
    args.push('--playlist-items', String(opts.playlistItems));
  }
  // ── 新增 12 参数 (2025-06-09) ───────────────────────────────────
  // 限速
  if (config.limitRate) args.push('--limit-rate', String(config.limitRate));
  // 字幕语言
  if (config.subLangs && (config.writeSubs || config.writeAutoSubs)) {
    args.push('--sub-langs', String(config.subLangs));
  }
  // 提取音频
  if (config.extractAudio) {
    args.push('-x');
    if (config.audioFormat) args.push('--audio-format', String(config.audioFormat));
    if (config.audioQuality) args.push('--audio-quality', String(config.audioQuality));
  }
  // 多音轨合并
  if (config.audioMultistreams) args.push('--audio-multistreams');
  // 嵌入字幕到视频
  if (config.embedSubs && (config.writeSubs || config.writeAutoSubs)) args.push('--embed-subs');
  // 嵌入缩略图到视频
  if (config.embedThumbnail) args.push('--embed-thumbnail');
  // 合并输出格式
  if (config.mergeOutputFormat) args.push('--merge-output-format', String(config.mergeOutputFormat));
  // 增量下载 (避免重复)
  if (config.downloadArchive) {
    const ap = path.isAbsolute(config.downloadArchive) ? config.downloadArchive : path.join(DATA_DIR, config.downloadArchive);
    // 限制 archive 文件必须在 DATA_DIR 下 (防止路径穿越)
    if (path.resolve(ap).startsWith(path.resolve(DATA_DIR + '/'))) {
      args.push('--download-archive', ap);
    }
  }
  // mtime: true=用 Last-Modified (默认), false=用下载时间
  if (!config.mtime) args.push('--no-mtime');
  // 复杂过滤
  if (config.matchFilters) args.push('--match-filters', String(config.matchFilters));
  // 日期范围
  if (config.dateAfter) args.push('--dateafter', String(config.dateAfter));
  if (config.dateBefore) args.push('--datebefore', String(config.dateBefore));
  // 大小过滤
  if (config.minFilesize) args.push('--min-filesize', String(config.minFilesize));
  if (config.maxFilesize) args.push('--max-filesize', String(config.maxFilesize));
  // 限数量
  if (config.maxDownloads && config.maxDownloads > 0) args.push('--max-downloads', String(config.maxDownloads));
  // 字幕格式转换
  if (config.convertSubs) args.push('--convert-subs', String(config.convertSubs));
  // URL
  args.push(task.url);
  return args;
};

const startTask = (id) => {
  const task = tasks.get(id);
  if (!task) return false;
  if (_procs.has(id)) {
    LOG('[start] task already running:', id);
    return false;
  }
  // 检查并发数
  const running = Array.from(tasks.values()).filter(t => t.status === 'downloading').length;
  if (running >= config.concurrentDownloads) {
    task.status = 'pending';
    task.updatedAt = Date.now();
    saveTasks();
    broadcast('task-updated', task);
    LOG('[start] concurrent limit reached, queued:', id);
    return true;
  }
  // 检查 yt-dlp binary
  if (!fs.existsSync(YT_DLP_BIN)) {
    task.status = 'error';
    task.error = `yt-dlp binary not found at ${YT_DLP_BIN}`;
    task.updatedAt = Date.now();
    saveTasks();
    broadcast('task-updated', task);
    return false;
  }
  // 确保下载目录存在
  try { fs.mkdirSync(config.downloadPath, { recursive: true }); } catch (e) {
    task.status = 'error';
    task.error = `mkdir downloadPath failed: ${e.message}`;
    task.updatedAt = Date.now();
    saveTasks();
    return false;
  }
  const args = buildYtDlpArgs(task);
  LOG('[start] yt-dlp', task.id, 'args count=' + args.length);
  task.status = 'downloading';
  task.error = '';
  task.progress = 0;
  task.downloadedBytes = 0;
  task.totalBytes = 0;
  task.speed = 0;
  task.eta = 0;
  // 多流下载阶段追踪: 用 progress-aggregator util 的 newTask 初始化
  // 字段: _streamPhases (video/audio) + _currentStream + _phase + _pendingFilenames + _streamTypeCount
  Object.assign(task, _newProgressTask());
  task.updatedAt = Date.now();
  saveTasks();
  broadcast('task-updated', task);
  const proc = spawn(YT_DLP_BIN, args, {
    cwd: TARGET_DIR,
    env: { ...process.env, PATH: process.env.PATH + ':/usr/bin:/usr/local/bin' },
    timeout: 86400000, // 24h 超时兜底
  });
  _procs.set(id, proc);
  let stderrBuf = '';
  let stdoutBuf = ''; // 跨 chunk 累积, 避免 PROGRESS 行被截断
  proc.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString('utf8');
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop() || ''; // 最后一段 (可能不完整) 留到下次
    let hasProgressUpdate = false;
    for (const line of lines) {
      // 全部解析逻辑 (PROGRESS / Destination / Merger / format) 都委托给 util
      // util 会原地更新 task._currentStream / _streamPhases / _phase / progress / filename
      const beforeProgress = task.progress;
      const beforeFilename = task.filename;
      _applyProgressLine(task, line);
      if (task.progress !== beforeProgress || task.filename !== beforeFilename) {
        task.updatedAt = Date.now();
        if (task._phase === 'merging') {
          broadcast('task-progress', task);
        } else if (task.filename !== beforeFilename) {
          broadcast('task-updated', task);
        } else {
          hasProgressUpdate = true;
        }
      }
    }
    if (hasProgressUpdate) {
      broadcast('task-progress', task);
    }
  });
  proc.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString('utf8');
  });
  proc.on('close', (code) => {
    _procs.delete(id);
    if (task.status === 'stopped' || task.status === 'paused') {
      // 用户主动停止/暂停, 不改状态
    } else if (code === 0) {
      task.status = 'completed';
      task.progress = 100;
      task.speed = 0;
      task.eta = 0;
      task.completedAt = Date.now();
      // 兜底: 用 fs.statSync 读真实文件大小 (progress 模板里 total_bytes_estimate 可能为 0)
      // 优先选最终合并产物 (mp4/mkv/webm/m4a 等), 排除中间分片 (.m4s/.tmp/.part)
      try {
        const downloadDir = task.options?._downloadFolder || config.downloadPath;
        const files = fs.readdirSync(downloadDir)
          .map(f => {
            try {
              const fp = path.join(downloadDir, f);
              const st = fs.statSync(fp);
              return { name: f, mtime: st.mtimeMs || 0, size: st.size };
            } catch (e) { return null; }
          })
          .filter(x => x && x.size > 0 && !x.name.endsWith('.part') && !x.name.endsWith('.ytdl') && !x.name.startsWith('.'));
        // 优先选最大文件 (通常是合并后的 mp4/mkv)
        const merged = files
          .filter(f => /\.(mp4|mkv|webm|m4a|mp3|opus|flac|wav|ts)$/i.test(f.name))
          .sort((a, b) => b.size - a.size);
        if (merged.length > 0) {
          task.filename = merged[0].name;
        } else if (files.length > 0) {
          // 没找到合并产物, 选最新文件
          files.sort((a, b) => b.mtime - a.mtime);
          task.filename = files[0].name;
        }
      } catch (e) { LOG('[yt-dlp close] readdir failed:', e.message); }
      if (task.filename) {
        const fileDir = task.options?._downloadFolder || config.downloadPath;
        const fp = path.join(fileDir, task.filename);
        try {
          const st = fs.statSync(fp);
          if (st.isFile() && st.size > 0) {
            task.totalBytes = st.size;
            task.downloadedBytes = st.size;
          }
        } catch (e) { LOG('[yt-dlp close] statSync failed:', e.message); }
      }
      // 异步获取元数据 (title/duration/thumbnail)
      if (!task.title) {
        execFile(YT_DLP_BIN, ['--dump-json', '--no-download', '--no-warnings', task.url], { timeout: 10000 }, (err, stdout) => {
          if (!err) try {
            const info = JSON.parse(stdout);
            if (info.title) task.title = info.title;
            if (info.duration) task.duration = info.duration;
            if (info.thumbnail && !task.thumbnail) task.thumbnail = info.thumbnail;
            // 优先用元数据里的 filesize (更准确)
            if (info.filesize && info.filesize > 0) {
              task.totalBytes = info.filesize;
              task.downloadedBytes = info.filesize;
            }
            task.updatedAt = Date.now();
            saveTasks();
            broadcast('task-updated', task);
          } catch (e) { LOG('[meta] dump-json parse failed:', e.message); }
        });
      } else {
        saveTasks();
        broadcast('task-updated', task);
      }
    } else {
      task.status = 'error';
      // P2: 错误脱敏 (提取最后一行有效 stderr)
      const lastLine = stderrBuf.trim().split('\n').filter(l => l.trim()).pop() || 'unknown error';
      task.error = `yt-dlp exit ${code}: ${lastLine.substring(0, 500)}`;
    }
    task.updatedAt = Date.now();
    saveTasks();
    broadcast('task-updated', task);
    LOG('[done] task ' + id + ' status=' + task.status);
    // 调度下一个 pending
    scheduleNext();
  });
  proc.on('error', (e) => {
    _procs.delete(id);
    task.status = 'error';
    task.error = 'spawn failed: ' + e.message;
    task.updatedAt = Date.now();
    saveTasks();
    broadcast('task-updated', task);
  });
  return true;
};

const scheduleNext = () => {
  const running = Array.from(tasks.values()).filter(t => t.status === 'downloading').length;
  if (running >= config.concurrentDownloads) return;
  const pending = Array.from(tasks.values()).find(t => t.status === 'pending');
  if (pending) {
    LOG('[sched] start pending ' + pending.id);
    startTask(pending.id);
  }
};

const retryTask = (id) => {
  const task = tasks.get(id);
  if (!task) return false;
  task.status = 'pending';
  task.error = '';
  task.updatedAt = Date.now();
  saveTasks();
  broadcast('task-updated', task);
  return startTask(id);
};

// ── parseAndCreateTask: 先解析再建文件夹+info.txt, 然后开始下载 ──────────
const parseAndCreateTask = async (url, options = {}) => {
  let title = '';
  let rawInfo = null;
  // 如果前端已传解析结果, 直接复用, 跳过第二次 yt-dlp --dump-json
  if (options._parsedInfo?.title) {
    rawInfo = options._parsedInfo;
    title = rawInfo.title || '';
    delete options._parsedInfo; // 清理, 不存入持久化
  } else {
    try {
      rawInfo = await infoUrl(url, options.cookieName);
      title = rawInfo?.title || '';
    } catch (e) {
      LOG('[parseAndCreateTask] infoUrl failed (will use URL as folder):', e.message);
    }
  }
  // 2. 生成文件夹名 (safe folder name from title)
  let folderName = sanitizeFilename(title || path.basename(url).substring(0, 64));
  if (!folderName || folderName === 'video') {
    // 兜底: 用 URL 哈希短标识
    folderName = 'video_' + crypto.randomUUID().slice(0, 8);
  }
  let folderPath = path.join(config.downloadPath, folderName);
  // 3. 重名检测: 如果目录已存在, 追加时间戳
  if (fs.existsSync(folderPath)) {
    const now = new Date();
    const ts = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}${String(now.getSeconds()).padStart(2,'0')}`;
    folderName = `${folderName}_${ts}`;
    folderPath = path.join(config.downloadPath, folderName);
  }
  // 4. 创建目录
  fs.mkdirSync(folderPath, { recursive: true });
  LOG('[parseAndCreateTask] created folder:', folderPath);
  // 4.5 若后续步骤失败, 必须清理已创建的文件夹, 避免孤儿目录
  const cleanupOnFail = (e) => {
    try {
      fs.rmSync(folderPath, { recursive: true, force: true });
      LOG('[parseAndCreateTask] cleaned up folder after error:', folderPath, e?.message);
    } catch (rmErr) { LOG('cleanup folder failed:', rmErr.message); }
  };
  // 5. 写入 info.txt (包含完整元数据)
  try {
    const infoContent = {
      url,
      title: rawInfo?.title || '',
      id: rawInfo?.id || '',
      duration: rawInfo?.duration || 0,
      uploader: rawInfo?.uploader || '',
      uploadDate: rawInfo?.uploadDate || '',
      viewCount: rawInfo?.viewCount || 0,
      likeCount: rawInfo?.likeCount || 0,
      description: rawInfo?.description || '',
      extractor: rawInfo?.extractor || '',
      webpage_url: rawInfo?.webpage_url || '',
      formats: rawInfo?.formats || [],
      subtitles: rawInfo?.subtitles || [],
      parsedAt: new Date().toISOString(),
      downloadStartedAt: new Date().toISOString(),
      cookieName: options.cookieName || '',
    };
    fs.writeFileSync(path.join(folderPath, 'info.txt'), JSON.stringify(infoContent, null, 2), 'utf8');
  } catch (e) {
    cleanupOnFail(e);
    throw e;
  }
  // 6. 创建任务, 将 downloadFolder 写在 options 里
  let task;
  try {
    task = createTask(url, { ...options, _downloadFolder: folderPath });
  } catch (e) {
    cleanupOnFail(e);
    throw e;
  }
  // 在 task 上记录额外字段
  task.title = rawInfo?.title || '';
  task.duration = rawInfo?.duration || 0;
  task.thumbnail = rawInfo?.thumbnail || '';
  task.downloadFolder = folderName;
  // 缓存 formats 列表给 util 反查 formatId → 人类可读描述 ("1080p HEVC + 128k mp4a")
  if (rawInfo?.formats && Array.isArray(rawInfo.formats)) {
    task._infoFormats = rawInfo.formats;
  }
  saveTasks();
  // 7. 启动下载
  startTask(task.id);
  return task;
};

// ── /api/formats (调用 yt-dlp -F 获取格式列表) ─────────────────────
const listFormats = (url, cookieName) => {
  return new Promise((resolve, reject) => {
    if (!isValidUrl(url)) return reject(new Error('Invalid URL'));
    const args = ['-F', '--no-warnings'];
    if (cookieName && config.cookies && config.cookies.some(c => c.name === cookieName)) {
      const fp = getCookieFile(cookieName);
      if (fs.existsSync(fp)) args.push('--cookies', fp);
    }
    args.push(url);
    const proc = spawn(YT_DLP_BIN, args, {
      env: { ...process.env, PATH: process.env.PATH + ':/usr/bin:/usr/local/bin' },
      timeout: 30000,
    });
    let out = '', err = '';
    proc.stdout.on('data', c => out += c);
    proc.stderr.on('data', c => err += c);
    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch (e) {}
      reject(new Error('yt-dlp list-formats timeout (30s)'));
    }, 30000);
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(err.trim() || `exit ${code}`));
      // 解析 yt-dlp -F 文本输出为结构化格式列表
      const lines = out.split('\n');
      const formats = [];
      let headerPassed = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('-')) continue;
        if (trimmed.startsWith('ID') && trimmed.includes('EXT')) { headerPassed = true; continue; }
        if (!headerPassed) continue;
        // 格式: ID  EXT  RESOLUTION  FPS CH | FILESIZE  TBR  PROTO  | CODECS  MORE
        const parts = trimmed.split(/\s{2,}/);
        if (parts.length < 2) continue;
        const formatId = parts[0].trim();
        const ext = parts[1].trim().toLowerCase();
        if (formatId === 'ID' || formatId.startsWith('-')) continue;
        let resolution = '', fps = '', filesize = '', tbr = '', vcodec = '', acodec = '';
        const rest = trimmed;
        // 解析分辨率
        const resMatch = rest.match(/(\d{3,4}x\d{3,4}|\d{3,4}p)\s*/);
        if (resMatch) resolution = resMatch[1].trim();
        // 解析 FPS
        const fpsMatch = rest.match(/(\d+)\s*fps/i);
        if (fpsMatch) fps = fpsMatch[1];
        // 解析文件大小
        const sizeMatch = rest.match(/~?([\d.]+[KMG]?i?B)/);
        if (sizeMatch) filesize = sizeMatch[1];
        // 解析 codec
        const codecMatch = rest.match(/(avc\d?|hevc|vp9|av01|h\.?264|h\.?265|mp4a\.?\w*|opus|aac|ac-?3|flac)\s*/i);
        if (codecMatch) {
          const c = codecMatch[1].toLowerCase();
          if (c.includes('mp4a') || c.includes('opus') || c.includes('aac') || c.includes('ac') || c.includes('flac')) {
            acodec = c;
          } else {
            vcodec = c;
          }
        }
        // 音频 only / video only / 普通
        const isAudio = trimmed.includes('audio only') || (!resolution && acodec);
        const isVideo = resolution && vcodec;
        // 音频码率
        const abrMatch = rest.match(/(\d+)k\s*\(?\s*(mp4a|opus|aac|ac-?3|flac)?/i);
        if (abrMatch && isAudio) tbr = abrMatch[1] + 'k';

        formats.push({
          formatId, ext, resolution, fps,
          filesize, tbr,
          vcodec: vcodec || (isAudio ? 'none' : ''),
          acodec: acodec || (isVideo ? 'none' : ''),
          type: isAudio ? 'audio' : isVideo ? 'video' : 'combined',
          formatNote: resolution || (isAudio ? 'audio only' : ''),
        });
      }
      resolve(formats);
    });
    proc.on('error', reject);
  });
};

// ── /api/playlist (检测播放列表并返回条目) ──────────────────────
const listPlaylist = (url, cookieName) => {
  return new Promise((resolve, reject) => {
    if (!isValidUrl(url)) return reject(new Error('Invalid URL'));
    // --flat-playlist: 只列出 ID + title, 不下载元数据
    const args = ['--flat-playlist', '--dump-json', '--no-warnings'];
    if (cookieName && config.cookies && config.cookies.some(c => c.name === cookieName)) {
      const fp = getCookieFile(cookieName);
      if (fs.existsSync(fp)) args.push('--cookies', fp);
    }
    args.push(url);
    const proc = spawn(YT_DLP_BIN, args, {
      env: { ...process.env, PATH: process.env.PATH + ':/usr/bin:/usr/local/bin' },
      timeout: 60000,
    });
    let out = '', err = '';
    proc.stdout.on('data', c => out += c);
    proc.stderr.on('data', c => err += c);
    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch (e) {}
      reject(new Error('yt-dlp playlist info timeout (60s)'));
    }, 60000);
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(err.trim() || `exit ${code}`));
      // 解析每行 JSON
      const entries = [];
      const lines = out.trim().split('\n');
      for (const line of lines) {
        try {
          const e = JSON.parse(line);
          if (e._type === 'playlist') {
            // 顶层是 playlist 本身, 继续解析子项
            continue;
          }
          entries.push({
            id: e.id,
            title: e.title || '',
            url: e.url || e.webpage_url || '',
            duration: e.duration || 0,
            thumbnail: e.thumbnail || '',
            uploader: e.uploader || '',
            index: e.playlist_index || entries.length + 1,
          });
        } catch (e) { /* 跳过解析失败行 */ }
      }
      resolve(entries);
    });
    proc.on('error', reject);
  });
};

// ── /api/info (调用 yt-dlp --dump-json 解析单 URL 元数据) ──────────
const infoUrl = (url, cookieName) => {
  return new Promise((resolve, reject) => {
    if (!isValidUrl(url)) return reject(new Error('Invalid URL'));
    const args = ['--dump-json', '--no-download', '--no-warnings'];
    // Cookie support for parsing
    if (cookieName && config.cookies && config.cookies.some(c => c.name === cookieName)) {
      const fp = getCookieFile(cookieName);
      if (fs.existsSync(fp)) args.push('--cookies', fp);
    }
    args.push(url);
    const proc = spawn(YT_DLP_BIN, args, {
      env: { ...process.env, PATH: process.env.PATH + ':/usr/bin:/usr/local/bin' },
      timeout: 30000,
    });
    let out = '', err = '';
    proc.stdout.on('data', c => out += c);
    proc.stderr.on('data', c => err += c);
    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch (e) {}
      reject(new Error('yt-dlp info timeout (30s)'));
    }, 30000);
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(err.trim() || `exit ${code}`));
      try {
        const info = JSON.parse(out);
        resolve({
          id: info.id,
          title: info.title,
          thumbnail: info.thumbnail,
          duration: info.duration,
          uploader: info.uploader || info.channel,
          uploadDate: info.upload_date,
          viewCount: info.view_count,
          likeCount: info.like_count,
          description: info.description?.substring(0, 500),
          formats: (info.formats || []).filter(f => f.ext !== 'mhtml').slice(0, 50).map(f => ({
            formatId: f.format_id,
            ext: f.ext,
            resolution: f.resolution,
            height: f.height,
            width: f.width,
            fps: f.fps,
            vcodec: f.vcodec,
            acodec: f.acodec,
            abr: f.abr,           // 平均音频码率 (kbps)
            tbr: f.tbr,           // 总码率 (kbps)
            filesize: f.filesize || f.filesize_approx,
            formatNote: f.format_note, // yt-dlp 描述: "1080p", "720p", "audio only"
          })),
          subtitles: Object.keys(info.subtitles || {}),
          extractor: info.extractor,
          webpage_url: info.webpage_url,
        });
      } catch (e) { reject(new Error('parse failed: ' + e.message)); }
    });
    proc.on('error', reject);
  });
};

// ══════════════════════════════════════════════════════════════════
// 模块 5: HTTP 请求处理 (路由 + 静态文件)
// ══════════════════════════════════════════════════════════════════
// ── request handler ───────────────────────────────────────────────────
const handle = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,X-Trim-Userid',
    });
    res.end();
    return;
  }
  // P1-5: 基础网关认证 — 只对 /api/ 路径检查 X-Trim-Userid
  // fnOS 网关会透传此 header，本地调试时不强制
  let pathname = req.path;
  if (pathname.startsWith(BASE_PATH + '/')) {
    pathname = '/' + pathname.slice(BASE_PATH.length + 1);
  } else if (pathname === BASE_PATH) {
    pathname = '/';
  }
  // P1-5: /api/ 路径要求 X-Trim-Userid header（fnOS 网关透传）
  // 本地调试没有此 header 时放行（方便 curl 测试）
  // /api/health 和 /api/events(SSE) 放行
  if (pathname.startsWith('/api/') && pathname !== '/api/health' && pathname !== '/api/events') {
    const trimUid = req.headers['x-trim-userid'];
    if (!trimUid || trimUid === 'undefined') {
      sendJSON(res, 401, { error: 'Unauthorized: missing X-Trim-Userid header' });
      return;
    }
  }
  try {
    // ── 任务 API ──
    if (pathname === '/api/tasks' && req.method === 'GET') {
      sendJSON(res, 200, { tasks: listTasks() });
    } else if (pathname === '/api/tasks' && req.method === 'POST') {
      const body = await parseBody(req);
      const url = body.url?.trim();
      if (!url) return sendJSON(res, 400, { error: 'url is required' });
      if (!isValidUrl(url)) return sendJSON(res, 400, { error: `Invalid URL (only http/https allowed): ${url}` });
      // feat3: 使用解析→建文件夹→info.txt→下载 流程
      // 如果前端已传 parsedInfo, 注入到 options 中让 parseAndCreateTask 跳过第二次 infoUrl
      const opts = body.options || {};
      if (body.parsedInfo) opts._parsedInfo = body.parsedInfo;
      try {
        const task = await parseAndCreateTask(url, opts);
        sendJSON(res, 200, { task });
      } catch (e) {
        // fallback: 如果 parseAndCreateTask 失败, 回退到旧流程直接创建任务
        LOG('[POST /api/tasks] parseAndCreateTask failed, fallback:', e.message);
        const task = createTask(url, opts);
        startTask(task.id);
        sendJSON(res, 200, { task });
      }
    // ── info_content: 读取 info.txt ──
    } else if (pathname.match(/^\/api\/tasks\/([^/]+)\/info_content$/) && req.method === 'GET') {
      const id = pathname.split('/')[3];
      const task = getTask(id);
      if (!task) return sendJSON(res, 404, { error: 'not found' });
      const folder = task.options?._downloadFolder || (task.downloadFolder ? path.join(config.downloadPath, task.downloadFolder) : null);
      if (!folder) return sendJSON(res, 404, { error: 'no download folder' });
      const infoPath = path.join(folder, 'info.txt');
      try {
        if (!fs.existsSync(infoPath)) return sendJSON(res, 404, { error: 'info.txt not found' });
        const content = fs.readFileSync(infoPath, 'utf8');
        sendJSON(res, 200, { content });
      } catch (e) {
        sendJSON(res, 500, { error: e.message });
      }
    } else if (pathname.startsWith('/api/tasks/') && req.method === 'GET') {
      const id = pathname.split('/')[3];
      const task = getTask(id);
      if (!task) return sendJSON(res, 404, { error: 'not found' });
      sendJSON(res, 200, { task });
    } else if (pathname.startsWith('/api/tasks/') && pathname.endsWith('/start') && req.method === 'POST') {
      const id = pathname.split('/')[3];
      const task = getTask(id);
      if (!task) return sendJSON(res, 404, { error: 'not found' });
      if (task.status === 'error' || task.status === 'stopped') {
        task.status = 'pending';
        saveTasks();
      }
      startTask(id);
      sendJSON(res, 200, { ok: true, task: getTask(id) });
    } else if (pathname.startsWith('/api/tasks/') && pathname.endsWith('/stop') && req.method === 'POST') {
      const id = pathname.split('/')[3];
      const ok = stopTask(id);
      sendJSON(res, 200, { ok, task: getTask(id) });
    } else if (pathname.startsWith('/api/tasks/') && pathname.endsWith('/pause') && req.method === 'POST') {
      const id = pathname.split('/')[3];
      const ok = pauseTask(id);
      sendJSON(res, 200, { ok, task: getTask(id) });
    } else if (pathname.startsWith('/api/tasks/') && pathname.endsWith('/retry') && req.method === 'POST') {
      const id = pathname.split('/')[3];
      const ok = retryTask(id);
      sendJSON(res, 200, { ok, task: getTask(id) });
    } else if (pathname.startsWith('/api/tasks/') && req.method === 'DELETE') {
      const id = pathname.split('/')[3];
      const u = new URL(req.url, 'http://localhost');
      const delFile = u.searchParams.get('deleteFile') === '1';
      const ok = deleteTask(id, { deleteFile: delFile });
      sendJSON(res, 200, { ok });
    }
    // ── browse (目录浏览, 用于路径选择对话框) ──
    // 不限制白名单, 用户可浏览任意目录, "选择当前目录"通过 POST /api/config
    // 保存路径时由 P1-4 逻辑允许任何 downloadPath
    else if (pathname === '/api/browse' && req.method === 'GET') {
      const u = new URL(req.url, 'http://localhost');
      const browsePath = u.searchParams.get('path') || config.downloadPath || DATA_DIR;
      try {
        const resolved = path.resolve(browsePath);
        // P2-4: 使用 isSystemPath 禁止浏览系统敏感目录
        if (isSystemPath(resolved)) {
          return sendJSON(res, 403, { error: '禁止浏览系统目录' });
        }
        if (!fs.existsSync(resolved)) {
          return sendJSON(res, 404, { error: '路径不存在', path: resolved });
        }
        const stat = fs.statSync(resolved);
        if (!stat.isDirectory()) {
          return sendJSON(res, 400, { error: '不是目录', path: resolved });
        }
        const entries = fs.readdirSync(resolved);
        const dirs = [];
        for (const name of entries) {
          if (name.startsWith('.')) continue;
          try {
            const full = path.join(resolved, name);
            const s = fs.statSync(full);
            if (s.isDirectory()) dirs.push({ name, path: full });
          } catch (e) { LOG('[browse] stat readdir entry failed:', e.message); }
        }
        dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
        sendJSON(res, 200, {
          currentPath: resolved,
          parentPath: path.dirname(resolved),
          directories: dirs,
          isRoot: resolved === '/'
        });
      } catch (e) {
        sendJSON(res, 500, { error: '读取目录失败: ' + e.message });
      }
    }
    // ── play: 播放已完成任务的视频文件 ──────────────────────────
    else if (pathname.startsWith('/api/play/') && req.method === 'GET') {
      const id = pathname.split('/')[3];
      const task = getTask(id);
      if (!task) return sendJSON(res, 404, { error: 'not found' });
      if (task.status !== 'completed' || !task.filename) {
        return sendJSON(res, 400, { error: 'task not completed or no file' });
      }
      const fileDir = task.options?._downloadFolder || config.downloadPath;
      const fp = path.join(fileDir, task.filename);
      if (!fs.existsSync(fp)) return sendJSON(res, 404, { error: 'file not found' });
      try {
        const stat = fs.statSync(fp);
        const ext = path.extname(fp).toLowerCase();
        const ct = {
          '.mp4': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
          '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.opus': 'audio/opus',
          '.flac': 'audio/flac', '.wav': 'audio/wav', '.m4v': 'video/mp4',
        }[ext] || 'application/octet-stream';
        // 支持 Range 请求 (HTML5 视频拖拽/快进)
        const range = req.headers.range;
        if (range) {
          const parts = range.replace(/bytes=/, '').split('-');
          const start = parseInt(parts[0], 10);
          const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
          const chunkSize = end - start + 1;
          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${stat.size}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunkSize,
            'Content-Type': ct,
            'Cache-Control': 'no-cache',
          });
          const stream = fs.createReadStream(fp, { start, end });
          stream.pipe(res);
        } else {
          res.writeHead(200, {
            'Content-Type': ct,
            'Content-Length': stat.size,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-cache',
          });
          fs.createReadStream(fp).pipe(res);
        }
      } catch (e) {
        sendJSON(res, 500, { error: e.message });
      }
    }
    // ── info / parse ──
    else if (pathname === '/api/formats' && req.method === 'POST') {
      const body = await parseBody(req);
      const url = body.url?.trim();
      if (!url) return sendJSON(res, 400, { error: 'url is required' });
      try {
        const formats = await listFormats(url, body.cookieName);
        sendJSON(res, 200, { formats });
      } catch (e) {
        sendJSON(res, 500, { error: e.message });
      }
    }
    else if (pathname === '/api/playlist' && req.method === 'POST') {
      const body = await parseBody(req);
      const url = body.url?.trim();
      if (!url) return sendJSON(res, 400, { error: 'url is required' });
      try {
        const entries = await listPlaylist(url, body.cookieName);
        sendJSON(res, 200, { entries, isPlaylist: entries.length > 1 || (entries.length === 1 && entries[0].index > 0) });
      } catch (e) {
        sendJSON(res, 500, { error: e.message });
      }
    }
    else if (pathname === '/api/tasks/batch' && req.method === 'POST') {
      const body = await parseBody(req);
      const urlsInput = body.urls || [];
      const options = body.options || {};
      if (!Array.isArray(urlsInput) || urlsInput.length === 0) {
        return sendJSON(res, 400, { error: 'urls array is required' });
      }
      // 去重 + 去空
      const unique = [...new Set(urlsInput.map(u => u.trim()).filter(Boolean))];
      if (unique.length === 0) return sendJSON(res, 400, { error: 'no valid URLs' });
      const results = { ok: [], fail: [], skipped: [] };
      for (const url of unique) {
        // 去重: 已有 downloading/pending 任务时跳过
        let skip = false;
        for (const [id, t] of tasks) {
          if (t.url === url && (t.status === 'pending' || t.status === 'downloading')) {
            results.skipped.push(url);
            skip = true;
            break;
          }
        }
        if (skip) continue;
        try {
          const task = await parseAndCreateTask(url, { ...options });
          results.ok.push({ id: task.id, url });
        } catch (e) {
          results.fail.push({ url, error: e.message });
        }
      }
      sendJSON(res, 200, results);
    }
    else if (pathname === '/api/info' && req.method === 'POST') {
      const body = await parseBody(req);
      const url = body.url?.trim();
      if (!url) return sendJSON(res, 400, { error: 'url is required' });
      try {
        const info = await infoUrl(url, body.cookieName);
        sendJSON(res, 200, info);
      } catch (e) {
        sendJSON(res, 500, { error: e.message });
      }
    }
    // ── config API ──
    else if (pathname === '/api/config' && req.method === 'GET') {
      sendJSON(res, 200, { ...config });
    } else if (pathname === '/api/config' && req.method === 'POST') {
      const body = await parseBody(req);
      const newCfg = { ...config, ...body };
      // P2-2: 使用 isSystemPath 防止下载路径设为系统目录
      if (newCfg.downloadPath) {
        const resolved = path.resolve(newCfg.downloadPath);
        if (!resolved || resolved === '/' || isSystemPath(resolved)) {
          return sendJSON(res, 400, { error: 'Invalid downloadPath: cannot be a system directory' });
        }
      }
      config = newCfg;
      saveConfig();
      sendJSON(res, 200, { ok: true, config });
    }
    // ── 订阅管理 ──
    else if (pathname === '/api/subscriptions' && req.method === 'GET') {
      sendJSON(res, 200, { subscriptions: config.subscriptions || [] });
    }
    else if (pathname === '/api/subscriptions' && req.method === 'POST') {
      const body = await parseBody(req);
      const { url, name, cookieName, format, interval } = body;
      if (!url || !name) return sendJSON(res, 400, { error: 'url and name are required' });
      const subs = config.subscriptions || [];
      // 去重: 同名或同URL覆盖
      const idx = subs.findIndex(s => s.name === name || s.url === url);
      const entry = { url, name, cookieName: cookieName || '', format: format || '', interval: parseInt(interval) || 3600, lastId: '', enabled: true, addedAt: Date.now() };
      if (idx >= 0) { subs[idx] = { ...subs[idx], ...entry }; }
      else { subs.push(entry); }
      config.subscriptions = subs;
      saveConfig();
      LOG('[sub] added subscription:', name, url);
      sendJSON(res, 200, { ok: true, subscriptions: config.subscriptions });
    }
    else if (pathname.startsWith('/api/subscriptions/') && req.method === 'DELETE') {
      const name = decodeURIComponent(pathname.substring('/api/subscriptions/'.length));
      config.subscriptions = (config.subscriptions || []).filter(s => s.name !== name);
      saveConfig();
      sendJSON(res, 200, { ok: true, subscriptions: config.subscriptions });
    }
    else if (pathname === '/api/subscriptions/check' && req.method === 'POST') {
      // 手动触发一次订阅检查, 返回新内容数量
      const results = await checkSubscriptions();
      sendJSON(res, 200, { ok: true, results });
    }
    // ── cookies (多网站管理) ──
    else if (pathname === '/api/cookies' && req.method === 'GET') {
      sendJSON(res, 200, { cookies: listCookies() });
    }
    else if (pathname === '/api/cookies' && req.method === 'POST') {
      const body = await parseBody(req);
      const { name, domain, content } = body;
      try {
        addCookie(name, domain, content);
        sendJSON(res, 200, { ok: true, cookies: listCookies() });
      } catch (e) {
        sendJSON(res, 400, { error: e.message });
      }
    }
    else if (pathname.startsWith('/api/cookies/') && req.method === 'DELETE') {
      const name = decodeURIComponent(pathname.substring('/api/cookies/'.length));
      deleteCookie(name);
      sendJSON(res, 200, { ok: true, cookies: listCookies() });
    }
    // ── stats ──
    else if (pathname === '/api/stats' && req.method === 'GET') {
      const all = listTasks();
      sendJSON(res, 200, {
        total: all.length,
        downloading: all.filter(t => t.status === 'downloading').length,
        completed: all.filter(t => t.status === 'completed').length,
        error: all.filter(t => t.status === 'error').length,
        pending: all.filter(t => t.status === 'pending').length,
        paused: all.filter(t => t.status === 'paused').length,
      });
    }
    // ── system ──
    else if (pathname === '/api/health') {
      sendJSON(res, 200, { ok: true, arch: ARCH, processArch: process.arch, ytDlpBin: YT_DLP_BIN, ytDlpExists: fs.existsSync(YT_DLP_BIN), ffmpegExists: fs.existsSync(FFMPEG_BIN), version: VERSION });
    } else if (pathname === '/api/events') {
      handleSSE(req, res);
    }
    // ── 静态文件 ──
    else if (!pathname.startsWith('/api')) {
      serveStatic(pathname, res);
    } else {
      res.writeHead(404); res.end('Not Found');
    }
  } catch (e) {
    LOG('[ERROR]', pathname, e.message);
    sendJSON(res, 500, { error: e.message });
  }
};

const parseBody = (req) => new Promise((resolve, reject) => {
  let body = '';
  let bytes = 0;
  const MAX_BODY = 2097152; // 2MB
  req.on('data', c => {
    bytes += c.length;
    if (bytes > MAX_BODY) {
      req.destroy(new Error('Request body too large (max 2MB)'));
      return;
    }
    body += c;
  });
  req.on('end', () => {
    if (!body) return resolve({});
    try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('Invalid JSON')); }
  });
  req.on('error', reject);
});

const serveStatic = (reqPath, res) => {
  let fp = reqPath === '/' ? 'index.html' : reqPath.replace(/^\//, '');
  if (fp.includes('..')) { res.writeHead(403); res.end('Forbidden'); return; }
  fp = path.join(UI_DIR, fp);
  if (!fp.startsWith(UI_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  const ext = path.extname(fp);
  const ct = {
    '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
    '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
  }[ext] || 'application/octet-stream';
  if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
    res.writeHead(200, { 'Content-Type': ct });
    res.end(fs.readFileSync(fp));
  } else {
    const idx = path.join(UI_DIR, 'index.html');
    if (fs.existsSync(idx)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(fs.readFileSync(idx));
    } else {
      res.writeHead(404); res.end('Not Found');
    }
  }
};

// ══════════════════════════════════════════════════════════════════
// 模块 6: Server 启动 + 生命周期
// ══════════════════════════════════════════════════════════════════
// ── main ──────────────────────────────────────────────────────────────
// P1-4: 全局异常处理 — 防止 unhandled rejection / uncaught exception 静默崩溃
process.on('unhandledRejection', (reason) => {
  LOG('[FATAL] unhandledRejection:', reason instanceof Error ? reason.message : String(reason));
});
process.on('uncaughtException', (err) => {
  LOG('[FATAL] uncaughtException:', err.message);
  // 打印完整堆栈后正常退出, 由 fnOS 框架重启
  console.error('[fnytdlp] FATAL uncaughtException:', err.stack);
  process.exit(1);
});
const main = () => {
  // HTTP 端口 (本地调试 + fnOS 框架)
  const httpServer = http.createServer((req, res) => {
    req.path = req.url.split('?')[0];
    handle(req, res);
  });
  httpServer.on('error', (e) => { LOG('[FATAL] HTTP error:', e.message); process.exit(1); });
  httpServer.listen(PORT, '0.0.0.0', () => LOG('HTTP listening on ' + PORT));
  // UNIX socket (fnOS 网关代理)
  const sockServer = http.createServer((req, res) => {
    req.path = req.url.split('?')[0];
    handle(req, res);
  });
  if (fs.existsSync(SOCK_PATH)) {
    try { fs.unlinkSync(SOCK_PATH); LOG('[sock] removed stale socket'); } catch (e) { LOG('[sock] unlink failed:', e.message); }
  }
  sockServer.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      LOG('[sock] EADDRINUSE, retrying...');
      try { fs.unlinkSync(SOCK_PATH); } catch (e) {}
      sockServer.listen(SOCK_PATH);
    } else {
      LOG('[FATAL] sock error:', e.message); process.exit(1);
    }
  });
  sockServer.listen(SOCK_PATH, () => LOG('UNIX socket listening on ' + SOCK_PATH));
  // shutdown
  const shutdown = () => {
    LOG('shutting down');
    for (const [id, proc] of _procs) {
      try { proc.kill('SIGTERM'); } catch (e) {}
    }
    try { sockServer.close(); } catch (e) {}
    try { httpServer.close(); } catch (e) {}
    saveTasks();
    process.exit(0);
  };
  process.on('SIGTERM', () => { clearInterval(_subTimer); shutdown(); });
  process.on('SIGINT', () => { clearInterval(_subTimer); shutdown(); });
  // 订阅定时检查 (每 5 分钟)
  const _subTimer = setInterval(() => {
    checkSubscriptions().then(results => {
      if (results.length > 0) {
        LOG('[sub] auto-check found', results.length, 'new items');
        broadcast('task-created', { count: results.length, subscriptions: results });
      }
    }).catch(e => LOG('[sub] auto-check error:', e.message));
  }, 300000); // 5 分钟
  // yt-dlp 健康检查
  try {
    const testProc = spawn(YT_DLP_BIN, ['--version'], { timeout: 5000, env: { ...process.env, PATH: process.env.PATH + ':/usr/bin:/usr/local/bin' } });
    let vOut = '';
    testProc.stdout.on('data', c => vOut += c);
    testProc.on('close', (code) => {
      if (code === 0) LOG('[yt-dlp] version=' + vOut.trim());
      else LOG('[WARN] yt-dlp check exit=' + code);
    });
    testProc.on('error', (e) => LOG('[WARN] yt-dlp not available: ' + e.message));
  } catch (e) { LOG('[WARN] yt-dlp check failed: ' + e.message); }
  LOG('=== server ready ===');
};

main();
