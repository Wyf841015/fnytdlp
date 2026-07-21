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
const VERSION = '0.7.0';
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
// aria2c 外部下载器 (可选, 不存在时降级 yt-dlp 内置)
const ARIA2C_BIN = process.env.ARIA2C_BIN || '/usr/bin/aria2c';

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
LOG('ARIA2C_BIN=' + ARIA2C_BIN + ' (exists=' + fs.existsSync(ARIA2C_BIN) + ')');

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

// v0.5.0: yt-dlp GitHub 最新版本 (异步, 不阻塞启动)
let _ytDlpLatestVersion = '';
let _ytDlpLatestCheckedAt = 0;
const checkYtDlpUpdate = async () => {
  // 缓存 6h 避免反复请求 GitHub
  if (_ytDlpLatestCheckedAt && Date.now() - _ytDlpLatestCheckedAt < 6 * 3600 * 1000) return _ytDlpLatestVersion;
  try {
    const { execFile } = await import('node:child_process');
    const r = await new Promise((resolve) => {
      execFile('curl', ['-sL', '--max-time', '15', 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest'],
        { timeout: 20000 }, (err, stdout) => {
          if (err) return resolve(null);
          try { resolve(JSON.parse(stdout)); } catch (e) { resolve(null); }
        });
    });
    if (r && r.tag_name) {
      _ytDlpLatestVersion = String(r.tag_name);
      _ytDlpLatestCheckedAt = Date.now();
      LOG('[yt-dlp-update] latest=' + _ytDlpLatestVersion);
    }
  } catch (e) { LOG('[yt-dlp-update] check failed:', e.message); }
  return _ytDlpLatestVersion;
};
// 后台触发一次 (不 await, 启动不等)
setTimeout(() => { checkYtDlpUpdate().catch(() => {}); }, 3000);

// v0.5.0: 从 archive 文件读已下载的 videoId 集合 (--download-archive)
const readArchiveIds = (archivePath) => {
  const ids = new Set();
  try {
    if (!archivePath || !fs.existsSync(archivePath)) return ids;
    const content = fs.readFileSync(archivePath, 'utf8');
    for (const line of content.split('\n')) {
      const m = line.trim().match(/^[a-z]+\s+(\S+)/i);
      if (m) ids.add(m[1]);
    }
  } catch (e) { LOG('[archive] read failed:', e.message); }
  return ids;
};

// v0.5.0: URL 提取 videoId (简化版, 用于 archive 查重)
const extractVideoIdFromUrl = (url) => {
  if (!url) return '';
  try {
    const u = new URL(url);
    // YouTube:  v=XXX / youtu.be/XXX / /shorts/XXX
    const host = (u.hostname || '').toLowerCase();
    if (host.includes('youtube.com') || host.includes('youtu.be')) {
      return u.searchParams.get('v') || u.pathname.split('/').filter(Boolean).pop() || '';
    }
    if (host.includes('bilibili.com')) {
      // BV... 或 av... 形式
      const m = u.pathname.match(/\/(BV\w+|av\d+)/i);
      if (m) return m[1];
    }
    return '';  // 其他站点暂不解析, yt-dlp 内部会做
  } catch (e) { return ''; }
};

// v0.5.0: 添加任务时检查 archive 是否已下载过 (避免重复)
const checkArchiveDuplicate = (url, archivePath) => {
  const id = extractVideoIdFromUrl(url);
  if (!id) return null;
  const ids = readArchiveIds(archivePath);
  return ids.has(id) ? id : null;
};

// v0.5.0: 解析 yt-dlp.conf 格式 (KEY="value" 或 KEY=value 每行一条, # 开头注释)
// 仅解析已知白名单 keys, 未知 key 忽略
const parseYtDlpConf = (content) => {
  const result = {};
  if (!content || typeof content !== 'string') return result;
  const KEY_MAP = {
    'format': 'format',
    'output': 'outputTemplate',
    'limit-rate': 'limitRate',
    'proxy': 'proxyUrl',
    'no-playlist': 'noPlaylist',
    'write-subs': 'writeSubs',
    'write-auto-subs': 'writeAutoSubs',
    'write-thumbnail': 'writeThumbnail',
    'embed-metadata': 'embedMetadata',
    'embed-subs': 'embedSubs',
    'embed-thumbnail': 'embedThumbnail',
    'extract-audio': 'extractAudio',
    'audio-format': 'audioFormat',
    'audio-quality': 'audioQuality',
    'merge-output-format': 'mergeOutputFormat',
    'convert-subs': 'convertSubs',
    'download-archive': 'downloadArchive',
    'match-filters': 'matchFilters',
    'dateafter': 'dateAfter',
    'datebefore': 'dateBefore',
    'min-filesize': 'minFilesize',
    'max-filesize': 'maxFilesize',
    'max-downloads': 'maxDownloads',
    'concurrent-fragments': 'concurrentFragments',
    'retries': 'retries',
    'no-mtime': 'mtime',
    'sub-langs': 'subLangs',
    'audio-multistreams': 'audioMultistreams',
    'recode-video': 'recodeVideo',
    'recode-video-format': 'recodeFormat',
    'download-sections': 'downloadSections',
    'force-keyframes-at-cuts': 'forceKeyframesAtCuts',
  };
  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/^\s*#.*$/, '').trim();  // 去注释
    if (!line) continue;
    // 支持 -o / --option / bare
    const m = line.match(/^--?([\w-]+)\s+(.+)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim().replace(/^["']|["']$/g, '');  // 去引号
    const mapped = KEY_MAP[key];
    if (!mapped) continue;
    // bool 解析
    if (key === 'no-playlist' || key === 'no-mtime') result[mapped] = !val || val === 'true';
    else if (['write-subs','write-auto-subs','write-thumbnail','embed-metadata','embed-subs','embed-thumbnail','extract-audio','audio-multistreams','force-keyframes-at-cuts'].includes(key)) {
      result[mapped] = !val || val === 'true' || val === '1';
    }
    else result[mapped] = val;
  }
  return result;
};

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
const checkSubscriptions = async (targetName) => {
  if (_subCheckRunning.current) { LOG('[sub] check already running, skip'); return []; }
  _subCheckRunning.current = true;
  const subs = config.subscriptions || [];
  const results = [];
  try {
    for (const sub of subs) {
      // 指定单订阅时跳过其他
      if (targetName && sub.name !== targetName) continue;
      if (!sub.enabled) continue;
      // 单订阅强制检查（绕过 interval 节流）；全局检查走节流
      const lastCheck = sub._lastCheck || 0;
      if (!targetName && Date.now() - lastCheck < (sub.interval || 3600) * 1000) continue;
      LOG('[sub] checking:', sub.name, sub.url);
      try {
        // lastCheckAt 用作时间窗口 fallback（hour-ago）
        const lastCheckAt = sub._lastCheck || sub.addedAt || 0;
        const { items: newItems, total, usedFallback } = await getLatestIds(sub.url, sub.cookieName, sub.lastId, lastCheckAt);
        if (usedFallback) {
          LOG('[sub] lastId not found in', total, 'items, fallback to time window for', sub.name);
        }
        if (newItems.length > 0) {
          LOG('[sub] found', newItems.length, 'new items for', sub.name);
          // 更新 lastId 为最新一项（items 已按升序，最后一项是最新）
          const newest = newItems[newItems.length - 1];
          sub.lastId = newest.id;
          for (const item of newItems) {
            try {
              if (!item.url) {
                // Bug 5 修复：不 fallback 到订阅 URL，避免重新下载整个 playlist
                LOG('[sub] skip item without url: id=' + item.id);
                continue;
              }
              const opts = {};
              if (sub.cookieName) opts.cookieName = sub.cookieName;
              if (sub.format) opts.format = sub.format;
              const task = await parseAndCreateTask(item.url, opts);
              results.push({ name: sub.name, title: item.title || item.id, taskId: task.id });
            } catch (e) {
              LOG('[sub] createTask failed for', item.id, e.message);
            }
          }
        }
        sub._lastCheck = Date.now();
        sub._lastCheckAt = sub._lastCheck;  // 记录时间窗口 fallback 用的时间戳
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

// 时间窗口增量策略：
//   1) 优先用 lastId（最准，匹配 id 立即停止）
//   2) lastId 失效时（视频被删/下架/换 id）→ fallback 到时间窗口：
//      保留 _lastCheckAt 之前 1 小时的项作为安全余量（避免时区/解析误差漏掉边界）
//   3) 输出按时间倒序（最新→最旧），newItems 为本次应新增的（最旧→最新，方便按顺序入队）
//   4) newItems 按 id 去重
//   5) item.url 为空时 throw，让上层记录错误而非 silent 重新下载整个 playlist
const getLatestIds = (url, cookieName, lastId, lastCheckAt) => {
  return new Promise((resolve, reject) => {
    const args = ['--flat-playlist', '--dump-json', '--no-warnings', '--playlist-reverse', '--playlist-start', '1', '--playlist-end', '500'];
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
      reject(new Error('timeout'));
    }, 60000);
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(err.trim() || `exit ${code}`));

      // 解析所有条目，按 timestamp 倒序（最新→最旧）
      const items = [];
      for (const line of out.trim().split('\n').filter(Boolean)) {
        try {
          const e = JSON.parse(line);
          if (e._type === 'playlist') continue;   // 跳过 playlist 元数据本身
          if (!e.id) continue;
          // 解析时间戳（多种来源兼容）
          let ts = 0;
          if (typeof e.timestamp === 'number') ts = e.timestamp;
          else if (typeof e.release_timestamp === 'number') ts = e.release_timestamp;
          else if (e.upload_date && /^\d{8}$/.test(e.upload_date)) {
            const s = e.upload_date;
            ts = Math.floor(Date.UTC(+s.slice(0,4), +s.slice(4,6)-1, +s.slice(6,8)) / 1000);
          }
          items.push({ id: e.id, title: e.title || '', url: e.url || e.webpage_url || '', _ts: ts });
        } catch (e) { /* skip parse error */ }
      }
      // 按 timestamp 倒序（无 ts 的排后面）
      items.sort((a, b) => b._ts - a._ts);

      // 增量判断：lastId 优先；找不到时用时间窗口
      let newItems = [];
      let usedFallback = false;
      const lastIdIdx = lastId ? items.findIndex(i => i.id === lastId) : -1;

      if (lastId && lastIdIdx >= 0) {
        // 主路径：lastId 找到了
        newItems = items.slice(0, lastIdIdx);
      } else if (lastId) {
        // lastId 设置了但找不到 → fallback 到时间窗口
        usedFallback = true;
        const cutoff = (lastCheckAt || 0) - 3600;  // 安全余量 -1h
        newItems = items.filter(i => i._ts > cutoff || (cutoff === 0 && i._ts === 0));
      } else {
        // 从未检查过 → 不应该调到这里（外层会跳过），但兜底
        newItems = items;
      }

      // 按 id 去重（同一 videoId 多次出现）
      const seen = new Set();
      newItems = newItems.filter(i => {
        if (seen.has(i.id)) return false;
        seen.add(i.id);
        return true;
      });

      // 按 timestamp 升序返回（最旧→最新），方便顺序入队处理
      newItems.sort((a, b) => a._ts - b._ts);

      LOG('[sub] getLatestIds: total=' + items.length + ', new=' + newItems.length + ', usedFallback=' + usedFallback);
      resolve({ items: newItems, total: items.length, usedFallback });
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
  // 磁盘配额 (0 = 关闭)
  quotaBytes: 0,                   // 配额字节数, 0=不限制; 例 50GB = 50 * 1024^3
  quotaAutoClean: false,           // 配额超出时自动删最旧已完成任务
  // v0.5.0: 视频裁剪 (--download-sections, 空=不裁剪)
  // 格式: "00:00:30-00:05:00" 或 "*00:00:30-00:05:00" (全格式裁剪)
  downloadSections: '',
  forceKeyframesAtCuts: false,    // --force-keyframes-at-cuts (裁剪精度提升, 速度略慢)
  // v0.5.0: 主题跟随系统 (prefers-color-scheme)
  themeFollowSystem: false,
  // v0.5.0: ETA 显示精度 (true=01h23m45s, false=1:23:45)
  etaVerbose: false,
  // v0.5.0: aria2c 外部下载器 (大文件提速, 默认自动检测)
  useAria2c: 'auto',                // 'auto'/'always'/'never'
  aria2cConnections: 16,           // --external-downloader-args aria2c:-x16 (单文件 16 连接)
  // v0.5.0: 视频转码 (--recode-video mp4 等, 空=不转码)
  recodeVideo: '',                  // 例: 'mp4' / 'mkv' / 'mp4,mkv'
  recodeFormat: '',                 // --recode-video-format 限定容器
  // v0.5.0: yt-dlp 启动时自动检查更新 (提示用户, 不自动升级)
  checkYtDlpUpdate: false,
  // v0.6.0: AI 视频总结 (借鉴 uvd, 零运行时依赖用 Node 内置 fetch)
  // 配置可走 process.env 也可走 fnOS Web 界面填的字段
  aiEnabled: false,                // 总开关 (避免用户没配 API key 时误触发)
  aiProvider: 'custom',            // 'openai' / 'glm' / 'deepseek' / 'custom'
  aiBaseUrl: '',                   // 例: https://open.bigmodel.cn/api/paas/v4
  aiApiKey: '',                    // API key (环境变量 AI_API_KEY 覆盖)
  aiModel: 'gpt-3.5-turbo',        // 默认模型
  aiMaxTokens: 4000,
  aiTemperature: 0.3,
  // v0.5.0: 速度限制模板 (按时段自动切换, JSON: [{"start":"22:00","end":"07:00","limit":"10M"},{"start":"07:00","end":"22:00","limit":""}])
  // 空数组 = 不启用; 当前时间在 [start,end) 内使用对应 limit
  speedSchedule: [],
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

// v0.6.0: URL 预处理 (借鉴 uvd) — 把平台特殊 URL 转为标准格式
// 抖音: /jingxuan?modal_id=XXX / /note/XXX → /video/XXX
// 短链接 (v.douyin.com) yt-dlp 内部已 follow redirect, 不需要处理
const normalizeUrl = (url) => {
  if (!url || typeof url !== 'string') return url;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    // 抖音精选页 → 标准 video URL
    if (host === 'www.douyin.com' || host === 'douyin.com') {
      const m = u.pathname.match(/^\/(\w+)$/);
      if (m && u.searchParams.get('modal_id')) {
        return `https://www.douyin.com/video/${u.searchParams.get('modal_id')}`;
      }
      // 笔记页 → video URL (抖音笔记内容就是 video)
      const note = u.pathname.match(/^\/note\/(\d+)/);
      if (note) {
        return `https://www.douyin.com/video/${note[1]}`;
      }
    }
    return url;
  } catch (e) { return url; }
};

// ── path whitelist (下载路径必须在合理的系统路径下) ──────────
const _SYSTEM_BLOCKED = ['/etc', '/proc', '/sys', '/dev', '/boot', '/lost+found', '/root', '/var/run', '/var/log', '/var/cache', '/snap', '/lib', '/lib64', '/bin', '/sbin', '/usr/bin', '/usr/sbin', '/usr/lib', '/usr/lib64'];
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
    uploader: '',
    extractor: '',
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
    tags: Array.isArray(options.tags) ? options.tags.slice(0, 10) : [],   // v0.5.0 标签 (上限 10 个)
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
  // 下载历史: 删除已完成/出错的任务时保存到历史记录
  if (task.status === 'completed' || task.status === 'error') {
    addToHistory(task);
  }
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
  // 输出模板 (任务级优先)
  const outTpl = opts.outputTemplate || config.outputTemplate || DEFAULT_CONFIG.outputTemplate;
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
  // 字幕 (任务级/配置级)
  const subsEnabled = opts.writeSubs !== undefined ? opts.writeSubs : config.writeSubs;
  const autoSubsEnabled = opts.writeAutoSubs !== undefined ? opts.writeAutoSubs : config.writeAutoSubs;
  if (subsEnabled) {
    args.push('--write-subs');
    if (autoSubsEnabled) args.push('--write-auto-subs');
    // 字幕语言 (任务级优先)
    const subLangs = opts.subLangs || config.subLangs || '';
    if (subLangs) args.push('--sub-langs', String(subLangs));
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
  // v0.5.0: 限速 (优先 schedule 时间窗口, 否则用 limitRate)
  const _activeLimit = (() => {
    if (Array.isArray(config.speedSchedule) && config.speedSchedule.length > 0) {
      const now = new Date();
      const cur = now.getHours() * 60 + now.getMinutes();
      const toMin = (hhmm) => {
        const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
        if (!m) return -1;
        return parseInt(m[1]) * 60 + parseInt(m[2]);
      };
      for (const w of config.speedSchedule) {
        const s = toMin(w.start), e = toMin(w.end);
        if (s < 0 || e < 0) continue;
        // 处理跨天 (e.g. 22:00-07:00)
        const inWindow = s <= e ? (cur >= s && cur < e) : (cur >= s || cur < e);
        if (inWindow) return w.limit || '';
      }
    }
    return config.limitRate || '';
  })();
  if (_activeLimit) args.push('--limit-rate', String(_activeLimit));
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
  // v0.5.0: 视频裁剪 (任务级优先)
  const sections = opts.downloadSections || config.downloadSections || '';
  if (sections) args.push('--download-sections', String(sections));
  if (opts.forceKeyframesAtCuts !== undefined ? opts.forceKeyframesAtCuts : config.forceKeyframesAtCuts) args.push('--force-keyframes-at-cuts');
  // v0.5.0: aria2c 外部下载器 (auto = 存在就用; always = 强制; never = 不用)
  const useA = config.useAria2c || 'auto';
  if (useA !== 'never' && (useA === 'always' || fs.existsSync(ARIA2C_BIN))) {
    const conns = parseInt(config.aria2cConnections || 16);
    args.push('--external-downloader', ARIA2C_BIN);
    args.push('--external-downloader-args', `aria2c:-x${conns} -j${conns} -s${conns}`);
  }
  // v0.5.0: 视频转码
  if (config.recodeVideo) args.push('--recode-video', String(config.recodeVideo));
  if (config.recodeFormat) args.push('--recode-video-format', String(config.recodeFormat));
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
      // v0.6.0: 速度历史采样 (任务详情 modal 渲染速度曲线)
      if (typeof task.speed === 'number' && task.speed >= 0) {
        if (!task._speedHistory) task._speedHistory = [];
        task._speedHistory.push({ t: Date.now(), bps: task.speed, p: task.progress || 0 });
        // 上限 200 个采样点 (避免内存爆掉)
        if (task._speedHistory.length > 200) task._speedHistory.shift();
      }
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
      // 添加到下载历史
      addToHistory(task);
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
  url = normalizeUrl(url);  // v0.6.0: 抖音 modal_id/note URL 转标准格式
  let title = '';
  let rawInfo = null;
  // 0. 配额自动清理 (quotaAutoClean=true 且 quotaBytes>0 时, 先清理旧任务腾空间)
  // 失败容错: 清理失败不阻塞添加任务
  if (config.quotaAutoClean && parseInt(config.quotaBytes || 0) > 0) {
    try {
      const en = await enforceQuota();
      if (en.enforced) {
        LOG('[parseAndCreateTask] autoClean freed=' + en.freedBytes + ' deleted=' + en.deletedCount);
      }
    } catch (e) { LOG('[parseAndCreateTask] autoClean failed:', e.message); }
  }
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
  task.uploader = rawInfo?.uploader || '';
  task.extractor = rawInfo?.extractor || '';
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
    url = normalizeUrl(url);  // v0.6.0
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

// ── /api/search (YouTube 搜索, 借鉴 ytDownloader) ──────────────────────
const searchYoutube = (query, cookieName) => {
  return new Promise((resolve, reject) => {
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return reject(new Error('query is required'));
    }
    const args = ['--flat-playlist', '--dump-json', '--no-warnings', '--playlist-end', '30'];
    if (cookieName && config.cookies && config.cookies.some(c => c.name === cookieName)) {
      const fp = getCookieFile(cookieName);
      if (fs.existsSync(fp)) args.push('--cookies', fp);
    }
    args.push(`ytsearch30:${query.trim()}`);
    const proc = spawn(YT_DLP_BIN, args, {
      env: { ...process.env, PATH: process.env.PATH + ':/usr/bin:/usr/local/bin' },
      timeout: 30000,
    });
    let out = '', err = '';
    proc.stdout.on('data', c => out += c);
    proc.stderr.on('data', c => err += c);
    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch (e) {}
      reject(new Error('yt-dlp search timeout (30s)'));
    }, 30000);
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(err.trim() || `exit ${code}`));
      const results = [];
      for (const line of out.trim().split('\n').filter(Boolean)) {
        try {
          const e = JSON.parse(line);
          if (e._type === 'playlist') continue;
          results.push({
            id: e.id,
            title: e.title || '',
            url: e.url || e.webpage_url || '',
            thumbnail: e.thumbnail || '',
            duration: e.duration || 0,
            uploader: e.uploader || e.channel || '',
            uploadDate: e.upload_date || '',
            viewCount: e.view_count || 0,
            extractor: e.extractor || '',
          });
        } catch (e) { /* skip parse error */ }
      }
      resolve(results);
    });
    proc.on('error', reject);
  });
};

// ── 下载历史持久化 (借鉴 ytDownloader DownloadHistory) ────────────────
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const HISTORY_MAX = 500;
let _downloadHistory = [];

const loadHistory = () => {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      _downloadHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      if (!Array.isArray(_downloadHistory)) _downloadHistory = [];
    }
  } catch (e) { LOG('[history] load failed:', e.message); _downloadHistory = []; }
};
const saveHistory = () => {
  try {
    _atomicWrite(HISTORY_FILE, JSON.stringify(_downloadHistory, null, 2));
  } catch (e) { LOG('[history] save failed:', e.message); }
};
const addToHistory = (task) => {
  if (!task) return;
  // 去重: 相同 id 的已有记录先移除 (避免完成时和删除时两次写入)
  const existingIdx = _downloadHistory.findIndex(h => h.id === task.id);
  if (existingIdx >= 0) _downloadHistory.splice(existingIdx, 1);
  const entry = {
    id: task.id,
    url: task.url,
    title: task.title || '',
    filename: task.filename || '',
    fileSize: task.totalBytes || 0,
    format: task.format || task.ext || '',
    thumbnail: task.thumbnail || '',
    duration: task.duration || 0,
    status: task.status || 'completed',
    error: task.error || '',
    downloadDate: new Date().toISOString(),
    timestamp: Date.now(),
    cookieName: task.options?.cookieName || '',
    extractor: task.extractor || '',
    uploader: task.uploader || '',
  };
  _downloadHistory.unshift(entry);
  if (_downloadHistory.length > HISTORY_MAX) {
    _downloadHistory = _downloadHistory.slice(0, HISTORY_MAX);
  }
  saveHistory();
};
loadHistory();

// ══════════════════════════════════════════════════════════════════
// 模块 4b: 磁盘配额扫描 + 自动清理 (v0.4.0 新增)
// ══════════════════════════════════════════════════════════════════
// 扫描 downloadPath 内全部文件 (含子目录) 累计字节数
// timeout 10s 防大目录挂死
const computeDirBytes = (dir) => {
  return new Promise((resolve) => {
    let total = 0;
    let files = 0;
    const timer = setTimeout(() => {
      LOG('[quota] scan timeout, partial=' + total + ' files=' + files);
      resolve({ bytes: total, files });
    }, 10000);
    const walk = (d) => {
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); }
      catch (e) { return; }  // 权限/不存在容错
      for (const ent of entries) {
        const fp = path.join(d, ent.name);
        if (ent.isDirectory()) walk(fp);
        else if (ent.isFile()) {
          try {
            const st = fs.statSync(fp);
            total += st.size;
            files++;
          } catch (e) { /* 单文件失败跳过 */ }
        }
      }
    };
    try {
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) walk(dir);
      clearTimeout(timer);
      resolve({ bytes: total, files });
    } catch (e) {
      clearTimeout(timer);
      resolve({ bytes: 0, files: 0, error: e.message });
    }
  });
};

// 解析 "50G" "500M" "1024K" 之类字符串为字节数 (空/0/无效 = 0)
const parseSizeString = (s) => {
  if (!s && s !== 0) return 0;
  if (typeof s === 'number') return Math.max(0, s);
  const m = String(s).trim().match(/^(\d+(?:\.\d+)?)\s*([KMGT]?B?|)$/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = (m[2] || '').toUpperCase();
  const mult = unit === 'TB' || unit === 'T' ? 1024 ** 4
              : unit === 'GB' || unit === 'G' ? 1024 ** 3
              : unit === 'MB' || unit === 'M' ? 1024 ** 2
              : unit === 'KB' || unit === 'K' ? 1024
              : 1;
  return Math.floor(n * mult);
};

// 检查配额使用情况 (返回 bytes/files/quotaBytes/percent)
const checkQuotaUsage = async () => {
  const target = config.downloadPath || DEFAULT_CONFIG.downloadPath;
  const quota = parseInt(config.quotaBytes || 0);
  const scan = await computeDirBytes(target);
  return {
    bytes: scan.bytes,
    files: scan.files,
    quotaBytes: quota,
    percent: quota > 0 ? Math.min(100, Math.round(scan.bytes * 100 / quota)) : 0,
    path: target,
    scanError: scan.error || '',
  };
};

// 按 completedAt 升序 (最旧在前), 删除任务对应文件 + 任务记录
// 返回 {deleted: [{id, filename, freedBytes}], freedTotal}
const deleteTaskFiles = (taskIds) => {
  const deleted = [];
  let freed = 0;
  for (const id of taskIds) {
    const t = tasks.get(id);
    if (!t) continue;
    if (t.filename) {
      const fp = path.join(t._downloadFolder || config.downloadPath || DEFAULT_CONFIG.downloadPath, t.filename);
      try {
        if (fs.existsSync(fp)) {
          const sz = fs.statSync(fp).size;
          fs.unlinkSync(fp);
          freed += sz;
        }
      } catch (e) {
        LOG('[quota] unlink failed: ' + fp + ' - ' + e.message);
      }
    }
    tasks.delete(id);
    deleted.push({ id, filename: t.filename || '', freedBytes: freed });
  }
  if (deleted.length > 0) {
    saveTasks();
    for (const d of deleted) broadcast('task-removed', { id: d.id });
  }
  return { deleted, freedTotal: freed };
};

// 配额超出时清理最旧的 N 个已完成任务 (status='completed')
// 持续删除直到 bytes < quotaBytes (或任务清空)
// maxDelete 默认 100 防一次清太多
const autoCleanOldest = async (quotaBytes, maxDelete = 100) => {
  const completed = [];
  for (const t of tasks.values()) {
    if (t.status === 'completed') {
      completed.push({
        id: t.id,
        filename: t.filename || '',
        completedAt: t.completedAt || t.updatedAt || 0,
        size: t.totalBytes || 0,
      });
    }
  }
  completed.sort((a, b) => a.completedAt - b.completedAt);
  const toDelete = completed.slice(0, maxDelete).map(t => t.id);
  return deleteTaskFiles(toDelete);
};

// 强制清理直到满足配额 (返回清理结果)
const enforceQuota = async () => {
  const usage = await checkQuotaUsage();
  const quota = parseInt(config.quotaBytes || 0);
  if (quota <= 0 || usage.bytes <= quota) return { enforced: false, usage };
  const result = await autoCleanOldest(quota);
  const after = await checkQuotaUsage();
  return {
    enforced: true,
    freedBytes: result.freedTotal,
    deletedCount: result.deleted.length,
    before: usage,
    after,
  };
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
      const url = normalizeUrl(body.url?.trim());  // v0.6.0: 抖音 modal_id/note 转标准
      if (!url) return sendJSON(res, 400, { error: 'url is required' });
      if (!isValidUrl(url)) return sendJSON(res, 400, { error: `Invalid URL (only http/https allowed): ${url}` });
      // v0.5.0: archive 查重检测 (--download-archive 启用时)
      if (config.downloadArchive) {
        const ap = path.isAbsolute(config.downloadArchive) ? config.downloadArchive : path.join(DATA_DIR, config.downloadArchive);
        if (path.resolve(ap).startsWith(path.resolve(DATA_DIR + '/'))) {
          const dupId = checkArchiveDuplicate(url, ap);
          if (dupId) {
            // 不直接拒绝, 提示前端: 已下载过, 是否重下
            return sendJSON(res, 200, { duplicate: true, videoId: dupId, archive: ap });
          }
        }
      }
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
    // v0.6.0: 字幕 VTT/SRT 转纯文本 (借鉴 uvd subtitle_extractor)
const _subtitleToText = (content) => {
  if (!content || typeof content !== 'string') return '';
  let text = content;
  // 移除 VTT 头
  text = text.replace(/^WEBVTT.*?\n\n/s, '');
  // 移除 TTML/XML 头
  text = text.replace(/<\?xml.*?\?>/gs, '');
  text = text.replace(/<tt\b[^>]*>[\s\S]*?<\/tt>/g, '');
  // VTT 时间戳 (逗号或点分毫秒)
  text = text.replace(/\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[.,]\d{3}[^\n]*/g, '');
  // SRT 序号行
  text = text.replace(/^\d+\s*$/gm, '');
  // 移除位置/样式
  text = text.replace(/(align|position|line|size|color):[^\n<]*/g, '');
  // HTML 标签
  text = text.replace(/<[^>]+>/g, '');
  // { } 内部 YouTube 标记
  text = text.replace(/\{[^}]*\}/g, '');
  // 多空行合并
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
};

// v0.6.0: AI 视频总结模块 (借鉴 uvd ai_summarizer.py)
// 零运行时依赖: 用 Node 22 内置 fetch 调用 OpenAI 兼容 API
const AI_PROVIDERS = {
  openai: { base: 'https://api.openai.com/v1', models: ['gpt-4o-mini', 'gpt-4o', 'gpt-3.5-turbo'] },
  glm: { base: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4-flash', 'glm-4', 'glm-4-plus', 'glm-4.5-flash'] },
  deepseek: { base: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-coder'] },
  custom: { base: '', models: [] },
};
const _resolveAIConfig = () => {
  // 优先级: 进程环境变量 > config 字段
  const cfg = config || {};
  const baseUrl = process.env.AI_BASE_URL || cfg.aiBaseUrl || (AI_PROVIDERS[cfg.aiProvider]?.base || '');
  const apiKey = process.env.AI_API_KEY || cfg.aiApiKey || '';
  const model = process.env.AI_MODEL || cfg.aiModel || 'gpt-3.5-turbo';
  return { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, model, provider: cfg.aiProvider || 'custom' };
};

const AI_SUMMARY_PROMPT = `你是一个专业的视频内容分析助手。用户会提供视频的字幕文本或文案内容，请根据内容生成以下四个部分。

## 输出格式要求（严格按以下格式输出，每个部分用 ### 开头）

### 智能总结
用 3-5 句话概括视频的核心内容，让读者快速了解视频讲了什么。

### 章节大纲
按照视频内容的逻辑顺序，列出主要章节。每个章节用二级标题（##），章节下的要点用无序列表（- 开头）。

### 核心要点
提取 5-8 个最关键的知识点或观点，每个要点用 **加粗标题** + 简短说明的形式呈现。

### 思维导图
用 Markdown 嵌套列表的形式呈现内容的层级结构。从核心主题展开，用缩进表示层级关系。格式示例：
- 核心主题
  - 分支一
    - 子要点1
    - 子要点2
  - 分支二
    - 子要点1

请确保：
- 内容准确，忠于原始文本
- 语言简洁，结构清晰
- 适合学习和复习
- 如果文本内容过短（如少于50字），请基于现有内容尽量总结`;

const _aiTasks = new Map();  // task_id -> {status, progress, result, error, videoTitle}

// v0.6.0: 启动 AI 总结后台任务
const startAISummary = async (url) => {
  const taskId = 'ai_' + crypto.randomUUID().slice(0, 8);
  const t = { taskId, status: 'pending', progress: '准备中...', result: null, error: '', videoTitle: '' };
  _aiTasks.set(taskId, t);
  // 后台线程
  (async () => {
    try {
      // 1. 提取字幕 (复用 /api/info 解析, 然后用 yt-dlp --write-subs 临时下载)
      t.status = 'extracting';
      t.progress = '正在提取字幕...';
      const info = await infoUrl(url).catch(() => null);
      let text = '';
      let title = (info && info.title) || '';
      if (info) t.videoTitle = info.title;
      // 用 yt-dlp 一次性下载字幕到临时目录 (不下载视频)
      const tmpDir = path.join(os.tmpdir(), 'fnytdlp-ai-' + Date.now());
      fs.mkdirSync(tmpDir, { recursive: true });
      try {
        t.progress = '调用 yt-dlp 提取字幕 (可能需要 10-30s)...';
        await new Promise((resolve) => {
          const args = ['--skip-download', '--write-subs', '--write-auto-subs', '--sub-langs', 'zh-Hans,zh-CN,zh,zh-TW,en,en-US,en-GB', '--sub-format', 'vtt/srt/best', '-o', path.join(tmpDir, '%(title)s.%(ext)s'), '--no-warnings', '--no-playlist', url];
          // 用与 buildYtDlpArgs 一致的 cookie 支持
          if (config.cookies && Array.isArray(config.cookies) && config.cookies.length) {
            const matched = config.cookies.find(c => url.includes(c.domain) || c.domain === '');
            if (matched) {
              const fp = path.join(DATA_DIR, 'cookies', matched.name + '.txt');
              if (fs.existsSync(fp)) args.push('--cookies', fp);
            }
          }
          const proc = spawn(YT_DLP_BIN, args, { timeout: 30000 });
          proc.on('close', () => resolve());
          proc.on('error', () => resolve());
        });
        // 找下载的字幕文件
        const files = fs.readdirSync(tmpDir).filter(f => /\.(vtt|srt)$/i.test(f));
        if (files.length > 0) {
          const raw = fs.readFileSync(path.join(tmpDir, files[0]), 'utf8');
          text = _subtitleToText(raw);
        }
      } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
      }
      // fallback: 用 description
      if (!text && info && info.description && info.description.length >= 20) {
        text = info.description;
      }
      if (!text) {
        t.status = 'error';
        t.error = '该视频无可用字幕或文案';
        t.progress = '提取失败';
        return;
      }
      if (text.length > 12000) text = text.slice(0, 12000);  // 防止超 token
      // 2. 调用 AI
      t.status = 'summarizing';
      t.progress = `AI 总结中 (${text.length} 字)...`;
      const ai = _resolveAIConfig();
      if (!ai.apiKey) {
        t.status = 'error';
        t.error = 'AI API key 未配置 (请在设置中填 aiApiKey 或设置环境变量 AI_API_KEY)';
        t.progress = '配置缺失';
        return;
      }
      const resp = await fetch(`${ai.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ai.apiKey}` },
        body: JSON.stringify({
          model: ai.model,
          messages: [
            { role: 'system', content: AI_SUMMARY_PROMPT },
            { role: 'user', content: `视频标题：${t.videoTitle || '未知'}\n\n视频内容文本：\n${text}` },
          ],
          temperature: parseFloat(config.aiTemperature ?? 0.3),
          max_tokens: parseInt(config.aiMaxTokens ?? 4000),
        }),
      });
      if (!resp.ok) {
        const errTxt = await resp.text().catch(() => '');
        t.status = 'error';
        t.error = `AI API HTTP ${resp.status}: ${errTxt.slice(0, 200)}`;
        t.progress = 'AI 失败';
        return;
      }
      const data = await resp.json();
      const raw = data.choices?.[0]?.message?.content || '';
      // 3. 解析 4 段
      const result = { summary: '', outline: '', key_points: '', mind_map: '' };
      const parts = String(raw).split(/\n*###\s+/);
      for (const part of parts) {
        const p = part.trim();
        if (!p) continue;
        if (p.startsWith('智能总结') || p.startsWith('总结')) result.summary = p.replace(/^智能总结\s*\n*/, '').trim();
        else if (p.startsWith('章节大纲') || p.startsWith('大纲')) result.outline = p.replace(/^章节大纲\s*\n*/, '').trim();
        else if (p.startsWith('核心要点') || p.startsWith('要点')) result.key_points = p.replace(/^核心要点\s*\n*/, '').trim();
        else if (p.startsWith('思维导图') || p.startsWith('导图')) result.mind_map = p.replace(/^思维导图\s*\n*/, '').trim();
      }
      if (!result.summary && !result.outline) result.summary = String(raw).trim();
            t.result = result;
      t.status = 'completed';
      t.progress = '总结完成';
    } catch (e) {
      LOG('[ai-summarize]', e.message);
      t.status = 'error';
      t.error = e.message;
      t.progress = '失败';
    }
  })();
  return taskId;
};

// (AI 端点插入到下面 API 路由链里)

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
    }
    // v0.6.0: 字幕提取 (借鉴 uvd) — 读下载目录里 .vtt/.srt 文件并转纯文本
    else if (pathname.match(/^\/api\/tasks\/([^/]+)\/subtitle$/) && req.method === 'GET') {
      const id = pathname.split('/')[3];
      const task = getTask(id);
      if (!task) return sendJSON(res, 404, { error: 'not found' });
      const folder = task.options?._downloadFolder || (task.downloadFolder ? path.join(config.downloadPath, task.downloadFolder) : null);
      if (!folder || !fs.existsSync(folder)) return sendJSON(res, 404, { error: 'folder not found' });
      try {
        // 优先级: .vtt > .srt > .lrc > .ass (按语言偏好 zh-Hans/zh/en)
        const files = fs.readdirSync(folder).filter(f => /\.(vtt|srt)$/i.test(f));
        if (files.length === 0) return sendJSON(res, 404, { error: 'no subtitle files', hint: '请在设置中启用"下载字幕"或"下载自动字幕"再下载一次' });
        // 按优先级匹配语言
        const _PRIORITY = ['zh-Hans', 'zh-CN', 'zh-Hant', 'zh-TW', 'zh', 'en-US', 'en-GB', 'en'];
        let chosen = files[0];
        for (const lang of _PRIORITY) {
          const m = files.find(f => f.includes(`.${lang}.`) || f.includes(`-${lang}.`) || f.endsWith(`.${lang}.vtt`) || f.endsWith(`.${lang}.srt`));
          if (m) { chosen = m; break; }
        }
        const raw = fs.readFileSync(path.join(folder, chosen), 'utf8');
        const text = _subtitleToText(raw);
        sendJSON(res, 200, { file: chosen, text, length: text.length });
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
              if (e.code === 'EACCES') {
                sendJSON(res, 403, { error: '无权限访问该目录，请在设置中手动输入下载路径（应用运行用户无权读取此目录）' });
              } else {
                sendJSON(res, 500, { error: '读取目录失败: ' + e.message });
              }
          }
    }
    // ── quota (磁盘配额检查 + 自动清理, v0.4.0 新增) ─────────────
    else if (pathname === '/api/quota' && req.method === 'GET') {
      try {
        const usage = await checkQuotaUsage();
        sendJSON(res, 200, usage);
      } catch (e) {
        sendJSON(res, 500, { error: e.message });
      }
    }
    else if (pathname === '/api/quota/clean' && req.method === 'POST') {
      // POST /api/quota/clean  -> 手动触发自动清理 (超配额才生效)
      try {
        const result = await enforceQuota();
        sendJSON(res, 200, result);
      } catch (e) {
        sendJSON(res, 500, { error: e.message });
      }
    }
    else if (pathname === '/api/quota/size' && req.method === 'GET') {
      // GET /api/quota/size?value=50G  -> 把人类可读尺寸解析为字节数
      const u = new URL(req.url, 'http://localhost');
      const v = u.searchParams.get('value') || '';
      sendJSON(res, 200, { value: v, bytes: parseSizeString(v) });
    }
    // v0.5.0: yt-dlp 更新检查 (强制刷新)
    else if (pathname === '/api/yt-dlp/check-update' && req.method === 'GET') {
      try {
        _ytDlpLatestCheckedAt = 0;  // 跳过缓存
        const v = await checkYtDlpUpdate();
        sendJSON(res, 200, { latest: v, current: '' });
      } catch (e) {
        sendJSON(res, 500, { error: e.message });
      }
    }
    // v0.5.0: 导入 yt-dlp.conf 解析结果 (前端 POST 文本内容, 后端解析覆盖 config)
    else if (pathname === '/api/config/import-yt-dlp-conf' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const content = body.content || '';
        const parsed = parseYtDlpConf(content);
        // 合并到 config (parsed 优先, 但现有值不在空时保留)
        for (const [k, v] of Object.entries(parsed)) {
          config[k] = v;
        }
        saveConfig();
        sendJSON(res, 200, { ok: true, imported: parsed, count: Object.keys(parsed).length });
      } catch (e) {
        sendJSON(res, 500, { error: e.message });
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
    // ── /api/search (YouTube 搜索) ──
    else if (pathname === '/api/search' && req.method === 'POST') {
      const body = await parseBody(req);
      const query = (body.query || '').trim();
      if (!query) return sendJSON(res, 400, { error: 'query is required' });
      try {
        const results = await searchYoutube(query, body.cookieName);
        sendJSON(res, 200, { results, query });
      } catch (e) {
        sendJSON(res, 500, { error: e.message });
      }
    }
    // ── 下载历史 API ──
    else if (pathname === '/api/history' && req.method === 'GET') {
      const u = new URL(req.url, 'http://localhost');
      const limit = parseInt(u.searchParams.get('limit')) || 50;
      const search = (u.searchParams.get('search') || '').trim().toLowerCase();
      let items = _downloadHistory;
      if (search) {
        items = items.filter(h => (h.title || '').toLowerCase().includes(search) || (h.url || '').toLowerCase().includes(search));
      }
      sendJSON(res, 200, { history: items.slice(0, limit), total: _downloadHistory.length });
    }
    else if (pathname === '/api/history' && req.method === 'DELETE') {
      const body = await parseBodySafe(req);
      if (body.all) {
        _downloadHistory = [];
        saveHistory();
        sendJSON(res, 200, { ok: true, cleared: true });
      } else if (body.id) {
        _downloadHistory = _downloadHistory.filter(h => h.id !== body.id);
        saveHistory();
        sendJSON(res, 200, { ok: true });
      } else {
        sendJSON(res, 400, { error: 'id or all=true required' });
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
      const rawUrl = body.url?.trim();
      const url = normalizeUrl(rawUrl);  // v0.6.0
      if (!url) return sendJSON(res, 400, { error: 'url is required' });
      try {
        const info = await infoUrl(url, body.cookieName);
        sendJSON(res, 200, info);
      } catch (e) {
        sendJSON(res, 500, { error: e.message });
      }
    }
    // v0.6.0: AI 总结 (借鉴 uvd) — 3 个端点
    else if (pathname === '/api/ai/summarize' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const url = normalizeUrl((body.url || '').trim());
        if (!url || !isValidUrl(url)) return sendJSON(res, 400, { error: 'url is required' });
        const ai = _resolveAIConfig();
        if (!config.aiEnabled && !ai.apiKey) {
          return sendJSON(res, 400, { error: 'AI 功能未启用, 请在设置中启用 aiEnabled 并填写 AI API key' });
        }
        const taskId = await startAISummary(url);
        sendJSON(res, 200, { task_id: taskId, status: 'started' });
      } catch (e) {
        sendJSON(res, 500, { error: e.message });
      }
    }
    else if (pathname.match(/^\/api\/ai\/progress\/([^/]+)$/) && req.method === 'GET') {
      const id = pathname.split('/')[4];
      const t = _aiTasks.get(id);
      if (!t) return sendJSON(res, 404, { error: '任务不存在' });
      sendJSON(res, 200, { task_id: t.taskId, status: t.status, progress: t.progress, video_title: t.videoTitle, error: t.error });
    }
    else if (pathname.match(/^\/api\/ai\/result\/([^/]+)$/) && req.method === 'GET') {
      const id = pathname.split('/')[4];
      const t = _aiTasks.get(id);
      if (!t) return sendJSON(res, 404, { error: '任务不存在' });
      if (t.status === 'error') return sendJSON(res, 400, { error: t.error });
      if (t.status !== 'completed' || !t.result) return sendJSON(res, 202, { error: '总结尚未完成' });
      sendJSON(res, 200, { task_id: t.taskId, status: t.status, video_title: t.videoTitle, result: t.result });
    }
    // ── config API ──
    else if (pathname === '/api/config' && req.method === 'GET') {
      sendJSON(res, 200, { ...config });
    }
    // v0.6.0: 缩略图代理 (借鉴 uvd, 解决防盗链/跨域)
    else if (pathname === '/api/proxy-thumbnail' && req.method === 'GET') {
      try {
        const u = new URL(req.url, 'http://localhost');
        const target = u.searchParams.get('url') || '';
        if (!target || !/^https?:\/\//i.test(target)) {
          res.writeHead(400); res.end('Invalid url'); return;
        }
        const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' };
        // 抖音 CDN 需要固定 Referer
        if (target.includes('douyinpic.com') || target.includes('douyinvod.com') || target.includes('douyin.com')) {
          headers['Referer'] = 'https://www.douyin.com/';
        }
        const proxyResp = await fetch(target, { headers, redirect: 'follow' });
        if (!proxyResp.ok) {
          res.writeHead(502, { 'Content-Type': 'text/plain' });
          res.end(`Upstream error: ${proxyResp.status}`);
          return;
        }
        const contentType = proxyResp.headers.get('content-type') || 'image/jpeg';
        const buf = Buffer.from(await proxyResp.arrayBuffer());
        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': buf.length,
          'Cache-Control': 'public, max-age=86400',
        });
        res.end(buf);
      } catch (e) {
        LOG('[proxy-thumbnail]', e.message);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Proxy error: ' + e.message);
      }
      return;
    } else if (pathname === '/api/config' && req.method === 'POST') {
      const body = await parseBody(req);
      const newCfg = { ...config, ...body };
      if (newCfg.downloadPath) {
        const resolved = path.resolve(newCfg.downloadPath);
        if (!resolved || resolved === '/') {
          return sendJSON(res, 400, { error: 'Invalid downloadPath: cannot be root' });
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
      // 新建时默认 enabled=true；已存在时保留原有 enabled/lastId/addedAt 等运行时字段
      const isNew = idx < 0;
      const entry = {
        url, name,
        cookieName: cookieName || '',
        format: format || '',
        interval: parseInt(interval) || 3600,
        lastId: isNew ? '' : (subs[idx].lastId || ''),
        enabled: isNew ? true : (subs[idx].enabled !== false),
        addedAt: isNew ? Date.now() : (subs[idx].addedAt || Date.now())
      };
      if (isNew) { subs.push(entry); }
      else { subs[idx] = { ...subs[idx], ...entry }; }
      config.subscriptions = subs;
      saveConfig();
      LOG('[sub]', isNew ? 'added' : 'updated', 'subscription:', name, url);
      sendJSON(res, 200, { ok: true, subscriptions: config.subscriptions });
    }
    else if (pathname.startsWith('/api/subscriptions/') && req.method === 'DELETE') {
      const name = decodeURIComponent(pathname.substring('/api/subscriptions/'.length));
      config.subscriptions = (config.subscriptions || []).filter(s => s.name !== name);
      saveConfig();
      sendJSON(res, 200, { ok: true, subscriptions: config.subscriptions });
    }
    else if (pathname === '/api/subscriptions/check' && req.method === 'POST') {
      // 手动触发一次订阅检查：body 可选 {name} 指定单个，否则检查所有启用的
      const body = await parseBodySafe(req).catch(() => ({}));
      const targetName = body && body.name;
      const results = await checkSubscriptions(targetName);
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
      sendJSON(res, 200, { ok: true, arch: ARCH, processArch: process.arch, ytDlpBin: YT_DLP_BIN, ytDlpExists: fs.existsSync(YT_DLP_BIN), ffmpegExists: fs.existsSync(FFMPEG_BIN), aria2cExists: fs.existsSync(ARIA2C_BIN), ytDlpLatest: _ytDlpLatestVersion, version: VERSION });
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

// parseBody 容错版：空 body 返 {} 而非 reject
const parseBodySafe = (req) => parseBody(req).then(b => b || {}).catch(() => ({}));
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
  if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
    const idx = path.join(UI_DIR, 'index.html');
    if (fs.existsSync(idx)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(fs.readFileSync(idx));
    } else {
      res.writeHead(404); res.end('Not Found');
    }
    return;
  }
  const ext = path.extname(fp);
  const ct = {
    '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
    '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
  }[ext] || 'application/octet-stream';
  const size = fs.statSync(fp).size;
  // 大于 512KB 的用流式发送，避免大文件（如 yt-dlp binary）全量读内存
  if (size > 524288) {
    res.writeHead(200, { 'Content-Type': ct, 'Content-Length': size, 'Cache-Control': 'public, max-age=3600' });
    fs.createReadStream(fp).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': ct });
    res.end(fs.readFileSync(fp));
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
  // yt-dlp 版本已在启动时检查 (line 134), 此处不再重复
  LOG('=== server ready ===');
};

main();
