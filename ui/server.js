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

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

// ── logging ────────────────────────────────────────────────────────────
const pad = n => String(n).padStart(2, '0');
const ts = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
// yt-dlp _speed_str 示例: "1.23MiB/s", "500KiB/s", "12.3MB/s", "Unknown B/s", "0KiB/s"
const parseSpeed = (s) => {
  if (!s || s === 'Unknown B/s' || s === 'N/A') return 0;
  const m = String(s).match(/^([\d.]+)\s*(KiB|MiB|GiB|KB|MB|GB|B)\/s$/i);
  if (!m) return 0;
  const v = parseFloat(m[1]);
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

// ── default config ────────────────────────────────────────────────────
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
const saveConfig = () => {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
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
    fs.writeFileSync(TASKS_FILE, JSON.stringify(Array.from(tasks.values()), null, 2));
  } catch (e) { LOG('tasks save failed:', e.message); }
};
loadTasks();

// ── SSE clients ───────────────────────────────────────────────────────
const _sseClients = new Set();
const broadcast = (event, data) => {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of _sseClients) {
    try { client.write(msg); } catch (e) { /* dead client */ }
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

// ── URL validation ────────────────────────────────────────────────────
// ── Cookies 多网站管理 ─────────────────────────────────────────────
const safeName = (s) => String(s).toLowerCase().replace(/[^a-z0-9_-]/g, '_').substring(0, 64);
const ensureCookiesDir = () => { try { fs.mkdirSync(COOKIES_DIR, { recursive: true }); } catch (e) {} };
const getCookieFile = (name) => path.join(COOKIES_DIR, safeName(name) + '.txt');
const listCookies = () => (config.cookies || []).map(c => ({ name: c.name, domain: c.domain || '' }));
const addCookie = (name, domain, content) => {
  ensureCookiesDir();
  if (!name || typeof name !== 'string') throw new Error('name required');
  // 校验: 必须含 tab 分隔的 Netscape 格式; 若无 tab 至少 20 字符 (兜底)
  if (!content || (!content.includes('\t') && content.length < 20)) {
    throw new Error('Invalid cookie content (must be tab-separated Netscape format, e.g. ".example.com\\tTRUE\\t/\\tFALSE\\t0\\tNAME\\tVALUE")');
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

// ── path whitelist (下载路径必须在 config.downloadPath 下) ──────────
const isSafeDownloadPath = (target) => {
  if (!target) return false;
  const resolved = path.resolve(target);
  const allowed = path.resolve(config.downloadPath);
  return resolved.startsWith(allowed);
};

// ── create task ───────────────────────────────────────────────────────
const createTask = (url, options = {}) => {
  if (!isValidUrl(url)) {
    throw new Error(`Invalid URL (only http/https allowed): ${url}`);
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
  // 兜底: completed 任务若 filename 为空, 从 downloadPath 找最新文件
  for (const t of arr) {
    if (t.status === 'completed' && !t.filename) {
      try {
        const files = fs.readdirSync(config.downloadPath)
          .map(f => {
            try {
              const fp = path.join(config.downloadPath, f);
              const st = fs.statSync(fp);
              return { name: f, mtime: st.mtimeMs || 0, size: st.size };
            } catch (e) { return null; }
          })
          .filter(x => x && x.size > 0 && !x.name.endsWith('.part') && !x.name.endsWith('.ytdl') && !x.name.startsWith('.'))
          .sort((a, b) => b.mtime - a.mtime);
        if (files.length > 0) {
          t.filename = files[0].name;
          t.totalBytes = files[0].size;
          t.downloadedBytes = files[0].size;
        }
      } catch (e) {}
    } else if (t.status === 'completed' && (!t.totalBytes || t.totalBytes === 0) && t.filename) {
      try {
        const fp = path.join(config.downloadPath, t.filename);
        const st = fs.statSync(fp);
        if (st.isFile() && st.size > 0) {
          t.totalBytes = st.size;
          t.downloadedBytes = st.size;
        }
      } catch (e) {}
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
  // 删文件?
  if (opts.deleteFile && task.filename) {
    const fp = path.join(config.downloadPath, task.filename);
    try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch (e) {}
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
  args.push('-o', path.join(config.downloadPath, outTpl));
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
    args.push('--download-archive', ap);
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
  task.updatedAt = Date.now();
  saveTasks();
  broadcast('task-updated', task);
  const proc = spawn(YT_DLP_BIN, args, {
    cwd: TARGET_DIR,
    env: { ...process.env, PATH: process.env.PATH + ':/usr/bin:/usr/local/bin' },
  });
  _procs.set(id, proc);
  let stderrBuf = '';
  proc.stdout.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    for (const line of text.split('\n')) {
      // 解析 PROGRESS 行: PROGRESS|XX.X%|speed_str|eta_str|downloaded_bytes|total_bytes|total_bytes_estimate|DONE
      if (line.startsWith('PROGRESS|')) {
        const parts = line.split('|');
        if (parts.length >= 8) {
          task.progress = parseFloat(parts[1].replace('%','')) || 0;
          task.speed = parseSpeed(parts[2]);
          task.eta = parseDuration(parts[3]);
          task.downloadedBytes = parseInt(parts[4], 10) || 0;
          // total_bytes 为 0 时用 total_bytes_estimate (VOD 无 Content-Length 时)
          const tbExact = parseInt(parts[5], 10) || 0;
          const tbEst = parseInt(parts[6], 10) || 0;
          task.totalBytes = tbExact || tbEst;
          task.updatedAt = Date.now();
          broadcast('task-progress', task);
        }
      }
      // 解析 [download] Destination: ... → 获取文件名
      if (line.startsWith('[download] Destination:')) {
        const fp = line.substring('[download] Destination: '.length).trim();
        if (fp) task.filename = path.basename(fp);
      }
      // 解析 [info] ... format(s): XXp → 获取格式
      if (line.includes('Downloading') && line.includes('format(s):')) {
        const fm = line.match(/format\(s\):\s*(.+)/);
        if (fm) task.format = fm[1].trim();
      }
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
      if (!task.filename) {
        // 兜底 1: 下载目录里找最新文件 (yt-dlp --print 不可用时的备选)
        try {
          const files = fs.readdirSync(config.downloadPath)
            .map(f => {
              try {
                const fp = path.join(config.downloadPath, f);
                const st = fs.statSync(fp);
                return { name: f, mtime: st.mtimeMs || 0, size: st.size };
              } catch (e) { return null; }
            })
            .filter(x => x && x.size > 0 && !x.name.endsWith('.part') && !x.name.endsWith('.ytdl') && !x.name.startsWith('.'))
            .sort((a, b) => b.mtime - a.mtime);
          if (files.length > 0) task.filename = files[0].name;
        } catch (e) {}
      }
      if (task.filename) {
        const fp = path.join(config.downloadPath, task.filename);
        try {
          const st = fs.statSync(fp);
          if (st.isFile() && st.size > 0) {
            task.totalBytes = st.size;
            task.downloadedBytes = st.size;
          }
        } catch (e) {}
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
          } catch (e) {}
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

// ── /api/info (调用 yt-dlp --dump-json 解析单 URL 元数据) ──────────
const infoUrl = (url) => {
  return new Promise((resolve, reject) => {
    if (!isValidUrl(url)) return reject(new Error('Invalid URL'));
    const proc = spawn(YT_DLP_BIN, ['--dump-json', '--no-download', '--no-warnings', url], {
      env: { ...process.env, PATH: process.env.PATH + ':/usr/bin:/usr/local/bin' },
    });
    let out = '', err = '';
    proc.stdout.on('data', c => out += c);
    proc.stderr.on('data', c => err += c);
    proc.on('close', (code) => {
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
            fps: f.fps,
            vcodec: f.vcodec,
            acodec: f.acodec,
            filesize: f.filesize || f.filesize_approx,
            tbr: f.tbr,
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
      const task = createTask(url, body.options || {});
      startTask(task.id);
      sendJSON(res, 200, { task });
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
    // ── info / parse ──
    else if (pathname === '/api/info' && req.method === 'POST') {
      const body = await parseBody(req);
      const url = body.url?.trim();
      if (!url) return sendJSON(res, 400, { error: 'url is required' });
      try {
        const info = await infoUrl(url);
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
      // P1-4: 允许用户自由更改下载路径（不限制在旧路径下）
      if (newCfg.downloadPath) {
        const resolved = path.resolve(newCfg.downloadPath);
        if (!resolved || resolved === '/') {
          return sendJSON(res, 400, { error: 'Invalid downloadPath' });
        }
      }
      // 其他路径字段仍使用 isSafeDownloadPath 校验
      if (newCfg.otherPath && !isSafeDownloadPath(newCfg.otherPath)) {
        return sendJSON(res, 400, { error: 'otherPath must be inside ' + config.downloadPath });
      }
      config = newCfg;
      saveConfig();
      sendJSON(res, 200, { ok: true, config });
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
      sendJSON(res, 200, { ok: true, arch: ARCH, processArch: process.arch, ytDlpBin: YT_DLP_BIN, ytDlpExists: fs.existsSync(YT_DLP_BIN), ffmpegExists: fs.existsSync(FFMPEG_BIN) });
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
  req.on('data', c => body += c);
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

// ── main ──────────────────────────────────────────────────────────────
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
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  LOG('=== server ready ===');
};

main();
