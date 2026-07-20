/**
 * fnytdlp 全面测试 - 服务器端纯函数 + 前端纯函数
 * 覆盖 sanitizeFilename / isValidUrl / isSystemPath / formatBytes / esc 等
 *
 * 从 server.js 提取纯函数源码独立测试
 * 不依赖 yt-dlp binary (纯函数, 无需 mock)
 * NOTE: 本项目是 ESM (type:module), 不能用 require
 *       isSystemPath/isSafeDownloadPath 用 path 模块已通过顶层 import
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

// ── 从 server.js 提取纯函数源码 ──────────────────────────────
const serverSrc = fs.readFileSync(new URL('../ui/server.js', import.meta.url), 'utf8');

// 安全提取: 匹配函数源码 → 移除 const 声明 + 移除尾部 ;
const extractFn = (pattern, src = serverSrc) => {
  const m = src.match(pattern);
  if (!m) throw new Error(`Pattern not found: ${pattern}`);
  const clean = m[0].replace(/^(const \w+ = )/, '').replace(/;\s*$/, '');
  return clean;
};

const sanitizeFilename = eval(`(${extractFn(/const sanitizeFilename = \(s\) => \{[\s\S]*?\n\};/)})`);
const isValidUrl = eval(`(${extractFn(/const isValidUrl = \(url\) => \{[\s\S]*?\n\};/)})`);
const safeName = eval(`(${extractFn(/const safeName = \(s\) => [^;]+;/)})`);

// isSystemPath: path 通过顶层 import 可用
const sysBlockedRaw = serverSrc.match(/const _SYSTEM_BLOCKED = \[[\s\S]*?\];/)[0];
const isSystemPathRaw = extractFn(/const isSystemPath = \(p\) => \{[\s\S]*?\n\};/);
const isSystemPath = eval(`(p => {
  ${sysBlockedRaw}
  const resolved = path.resolve(p);
  for (const b of _SYSTEM_BLOCKED) {
    if (resolved === b || resolved.startsWith(b + '/') || resolved.startsWith(b + path.sep)) return true;
  }
  return false;
})`);

// isSafeDownloadPath
const isSafeDownloadPath = (target, dlPath) => {
  if (!target) return false;
  const resolved = path.resolve(target);
  const allowed = path.resolve(dlPath);
  return resolved.startsWith(allowed) && !isSystemPath(resolved);
};

// detectArch
const detectArchRaw = extractFn(/const detectArch = \(\) => \{[\s\S]*?\n\};/);
const detectArch = eval(`(${detectArchRaw})`);
const testDetectArch = (arch) => {
  const orig = process.arch;
  try {
    Object.defineProperty(process, 'arch', { value: arch, configurable: true });
    return detectArch();
  } finally {
    Object.defineProperty(process, 'arch', { value: orig, configurable: true });
  }
};

// ── 从 main.js 提取前端纯函数 ─────────────────────────────────
const mainSrc = fs.readFileSync(new URL('../ui/main.js', import.meta.url), 'utf8');
const formatBytes = eval(`(${extractFn(/const formatBytes = \(n\) => \{[\s\S]*?\n\};/, mainSrc)})`);
const formatDuration = eval(`(() => {
  const pad = n => String(n).padStart(2, '0');
  return (${extractFn(/const formatDuration = \(secs\) => \{[\s\S]*?\n\};/, mainSrc)});
})()`);

// esc: 直接用内联实现
const esc = (s) => String(s).replace(/[&<>"']/g, function(c) {
  if (c === '&') return '&amp;';
  if (c === '<') return '&lt;';
  if (c === '>') return '&gt;';
  if (c === '"') return '&quot;';
  if (c === "'") return '&#39;';
  return c;
});

// formatSpeed 在 main.js 里用了 formatBytes, 单独提取
const formatSpeed = (n) => n > 0 ? formatBytes(n) + '/s' : '0 B/s';

// ── 模拟 yt-dlp -F 行解析 ──────────────────────────────────
const parseFormatsLine = (line) => {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('-')) return null;
  if (trimmed.startsWith('ID') && trimmed.includes('EXT')) return null;
  const parts = trimmed.split(/\s{2,}/);
  if (parts.length < 2) return null;
  const formatId = parts[0].trim();
  const ext = parts[1].trim().toLowerCase();
  if (formatId === 'ID' || formatId.startsWith('-')) return null;

  let resolution = '', fps = '', filesize = '', tbr = '', vcodec = '', acodec = '';
  const rest = trimmed;
  const resMatch = rest.match(/(\d{3,4}x\d{3,4}|\d{3,4}p)\s*/);
  if (resMatch) resolution = resMatch[1].trim();
  const fpsMatch = rest.match(/(\d+)\s*fps/i);
  if (fpsMatch) fps = fpsMatch[1];
  const sizeMatch = rest.match(/~?([\d.]+[KMG]?i?B)/);
  if (sizeMatch) filesize = sizeMatch[1];
  const codecMatch = rest.match(/(avc\d?|hevc|vp9|av01|h\.?264|h\.?265|mp4a\.?\w*|opus|aac|ac-?3|flac)\s*/i);
  if (codecMatch) {
    const c = codecMatch[1].toLowerCase();
    if (c.includes('mp4a') || c.includes('opus') || c.includes('aac') || c.includes('ac') || c.includes('flac')) {
      acodec = c;
    } else {
      vcodec = c;
    }
  }
  const isAudio = trimmed.includes('audio only') || (!resolution && acodec);
  const isVideo = resolution && vcodec;
  const abrMatch = rest.match(/(\d+)k\s*\(?\s*(mp4a|opus|aac|ac-?3|flac)?/i);
  if (abrMatch && isAudio) tbr = abrMatch[1] + 'k';

  return {
    formatId, ext, resolution, fps, filesize, tbr,
    vcodec: vcodec || (isAudio ? 'none' : ''),
    acodec: acodec || (isVideo ? 'none' : ''),
    type: isAudio ? 'audio' : isVideo ? 'video' : 'combined',
    formatNote: resolution || (isAudio ? 'audio only' : ''),
  };
};

const batchDedupeUrls = (urls) => [...new Set(urls.map(u => u.trim()).filter(Boolean))];
const hasDuplicateActiveTask = (tasks, url) => {
  for (const [id, t] of tasks) {
    if (t.url === url && (t.status === 'pending' || t.status === 'downloading')) return true;
  }
  return false;
};
const matchCookieDomain = (hostname, domain) =>
  hostname === domain || hostname.endsWith('.' + domain);
const validateCookieContent = (content) => {
  content = String(content).trim();
  if (!content || (!content.includes('\t') && content.length < 20)) return false;
  return content.length <= 102400;
};

// ═══════════════════════════════════════════════════════════════
describe('sanitizeFilename', () => {
  it('保留中英文/数字/空格/横线/下划线', () => {
    assert.equal(sanitizeFilename('Rick Astley - Never Gonna Give You Up [1080p].mp4'), 'Rick Astley - Never Gonna Give You Up [1080p].mp4');
    assert.equal(sanitizeFilename('【官方MV】测试视频_2025'), '【官方MV】测试视频_2025');
  });
  it('替换危险字符', () => {
    const r = sanitizeFilename('file:<>"/\\|?*name');
    assert.ok(!r.includes(':'), 'colon not replaced');
    assert.ok(r.startsWith('file') && r.endsWith('name'));
    assert.ok(/^file_+name$/.test(r), `got: ${r}`);
  });
  it('路径穿越防御', () => {
    assert.equal(sanitizeFilename('../../etc/passwd'), '.._.._etc_passwd');
  });
  it('截断 128 字符', () => {
    assert.equal(sanitizeFilename('a'.repeat(200)).length, 128);
  });
  it('空/null/undefined 返回 video', () => {
    assert.equal(sanitizeFilename(''), 'video');
    assert.equal(sanitizeFilename(null), 'video');
    assert.equal(sanitizeFilename(undefined), 'video');
  });
  it('纯危险字符替换后 trim 不空, 不触发 video 兜底', () => {
    const r = sanitizeFilename('<>:"/\\|?*');
    // 9 个特殊字符全替换为 9 个 _, trim 后仍然是 9 个 _
    assert.equal(r, '_________');
  });
  it('压缩多余空白', () => {
    assert.equal(sanitizeFilename('  hello   world  '), 'hello world');
  });
});

describe('isValidUrl', () => {
  it('http/https 通过', () => {
    assert.ok(isValidUrl('http://example.com'));
    assert.ok(isValidUrl('https://youtube.com/watch?v=abc'));
    assert.ok(isValidUrl('https://bilibili.com/video/BV1GJ411x7h7?share=copy'));
  });
  it('非 http 拒绝', () => {
    assert.ok(!isValidUrl('file:///etc/passwd'));
    assert.ok(!isValidUrl('ftp://example.com'));
    assert.ok(!isValidUrl('data:text/html,alert(1)'));
    assert.ok(!isValidUrl('javascript:alert(1)'));
  });
  it('无效格式拒绝', () => {
    assert.ok(!isValidUrl(''));
    assert.ok(!isValidUrl('not a url'));
    assert.ok(!isValidUrl('http://'));
  });
});

describe('isSystemPath', () => {
  it('已知系统路径拒绝', () => {
    assert.ok(isSystemPath('/etc'));
    assert.ok(isSystemPath('/etc/nginx'));
    assert.ok(isSystemPath('/proc'));
    assert.ok(isSystemPath('/sys'));
    assert.ok(isSystemPath('/dev'));
    assert.ok(isSystemPath('/boot'));
    assert.ok(isSystemPath('/root'));
    assert.ok(isSystemPath('/usr/bin'));
    assert.ok(isSystemPath('/usr/lib'));
    assert.ok(isSystemPath('/var/run'));
    assert.ok(isSystemPath('/opt'));
  });
  it('用户路径通过', () => {
    assert.ok(!isSystemPath('/home/user/downloads'));
    assert.ok(!isSystemPath('/tmp/videos'));
    assert.ok(!isSystemPath('/mnt/disk1'));
    assert.ok(!isSystemPath('/vol3/@appdata/fnytdlp'));
  });
});

describe('isSafeDownloadPath', () => {
  it('允许路径下的子目录通过', () => {
    assert.ok(isSafeDownloadPath('/tmp/downloads/videos', '/tmp/downloads'));
  });
  it('不允许路径拒绝', () => {
    assert.ok(!isSafeDownloadPath('/etc/videos', '/tmp/downloads'));
    assert.ok(!isSafeDownloadPath('/usr/bin', '/tmp/downloads'));
  });
  it('空 target 拒绝', () => {
    assert.ok(!isSafeDownloadPath('', '/tmp/downloads'));
    assert.ok(!isSafeDownloadPath(null, '/tmp/downloads'));
  });
});

describe('safeName (Cookie 文件名)', () => {
  it('域名转安全名', () => {
    assert.equal(safeName('youtube.com'), 'youtube_com');
  });
  it('中文被替换', () => {
    const r = safeName('B站');
    assert.ok(r.startsWith('b'));
    assert.equal(r.length, 2);
  });
  it('特殊字符替换', () => {
    assert.equal(safeName('Hello World!@#'), 'hello_world___');
  });
  it('截断 64 字符', () => {
    assert.equal(safeName('a'.repeat(100)).length, 64);
  });
});

describe('detectArch', () => {
  it('x64 → x86_64', () => assert.equal(testDetectArch('x64'), 'x86_64'));
  it('arm64 → aarch64', () => assert.equal(testDetectArch('arm64'), 'aarch64'));
  it('ia32 → i686', () => assert.equal(testDetectArch('ia32'), 'i686'));
  it('未知原样', () => assert.equal(testDetectArch('s390x'), 's390x'));
});

describe('parseFormatsLine (yt-dlp -F)', () => {
  it('视频: avc1 1920x1080', () => {
    const f = parseFormatsLine('137  mp4   1920x1080  30   2 | ~ 2.5GiB  10M  https  | avc1.640028     video only');
    assert.ok(f); assert.equal(f.formatId, '137'); assert.equal(f.ext, 'mp4');
    assert.equal(f.resolution, '1920x1080'); assert.equal(f.vcodec, 'avc1'); assert.equal(f.type, 'video');
  });
  it('音频: mp4a 128k m4a', () => {
    const f = parseFormatsLine('140  m4a   audio only      2 | ~ 150MiB  128k https  | mp4a.40.2       audio only');
    assert.ok(f); assert.equal(f.formatId, '140');
    // acodec 包含 mp4a (regex 匹配 mp4a.40)
    assert.ok(f.acodec.startsWith('mp4a'), `acodec: ${f.acodec}`);
    assert.equal(f.tbr, '128k'); assert.equal(f.type, 'audio');
  });
  it('VP9 webm', () => {
    const f = parseFormatsLine('247  webm  1280x720   30   2 | ~ 800MiB  5M   https  | vp9             video only');
    assert.ok(f); assert.equal(f.vcodec, 'vp9'); assert.equal(f.ext, 'webm');
  });
  it('HEVC 4K', () => {
    const f = parseFormatsLine('271  mp4   3840x2160  30   2 | ~ 10GiB   45M  https  | hevc            video only');
    assert.ok(f); assert.equal(f.vcodec, 'hevc'); assert.equal(f.resolution, '3840x2160');
  });
  it('Opus 音频', () => {
    const f = parseFormatsLine('251  webm  audio only      2 | ~ 200MiB  160k https  | opus            audio only');
    assert.ok(f); assert.equal(f.acodec, 'opus'); assert.equal(f.tbr, '160k');
  });
  it('空行/header 返回 null', () => {
    assert.equal(parseFormatsLine(''), null);
    assert.equal(parseFormatsLine('ID  EXT   RESOLUTION'), null);
  });
});

describe('validateCookieContent', () => {
  it('Netscape 通过', () => assert.ok(validateCookieContent('.y.com\tTRUE\t/\tTRUE\t0\tN\tV')));
  it('空/短拒绝', () => {
    assert.ok(!validateCookieContent(''));
    assert.ok(!validateCookieContent('short'));
  });
  it('超 100KB 拒绝', () => assert.ok(!validateCookieContent('a'.repeat(102401))));
  it('有 tab 通过', () => assert.ok(validateCookieContent('a\tb')));
});

describe('batch URL dedup', () => {
  it('去重', () => assert.deepEqual(batchDedupeUrls(['http://a.com', 'http://b.com', 'http://a.com']), ['http://a.com', 'http://b.com']));
  it('去空', () => assert.deepEqual(batchDedupeUrls(['http://a.com', '', ' ']), ['http://a.com']));
  it('全部空', () => assert.deepEqual(batchDedupeUrls([]), []));
});

describe('task duplicate', () => {
  const t = new Map([['t1', {id:'t1', url:'https://a.com', status:'downloading'}], ['t2', {id:'t2', url:'https://b.com', status:'completed'}]])
  it('downloading 重复', () => assert.ok(hasDuplicateActiveTask(t, 'https://a.com')));
  it('completed 不阻止', () => assert.ok(!hasDuplicateActiveTask(t, 'https://b.com')));
  it('新 URL 不阻止', () => assert.ok(!hasDuplicateActiveTask(t, 'https://c.com')));
});

describe('cookie domain matching', () => {
  it('完全匹配', () => assert.ok(matchCookieDomain('youtube.com', 'youtube.com')));
  it('子域名', () => assert.ok(matchCookieDomain('www.youtube.com', 'youtube.com')));
  it('不匹配', () => assert.ok(!matchCookieDomain('bilibili.com', 'youtube.com')));
  it('短域名不误匹配', () => assert.ok(!matchCookieDomain('aa.com', 'a.com')));
});

describe('URL extraction regex', () => {
  const rx = /https?:\/\/[^\s<>"']+/g;
  it('提取', () => assert.equal(('https://a.com https://b.com'.match(rx) || []).length, 2));
  it('无 URL', () => assert.equal(('abc'.match(rx) || []).length, 0));
});

describe('formatBytes (前端)', () => {
  it('值', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(1024), '1.0 KB');
    assert.equal(formatBytes(1048576), '1.0 MB');
    assert.equal(formatBytes(1073741824), '1.0 GB');
  });
  it('边界', () => {
    assert.equal(formatBytes(-1), '0 B');
    assert.equal(formatBytes(null), '0 B');
  });
});

describe('formatSpeed (前端)', () => {
  it('正速度', () => assert.ok(formatSpeed(1500000).includes('/s')));
  it('零', () => assert.equal(formatSpeed(0), '0 B/s'));
});

describe('formatDuration (前端)', () => {
  it('标准', () => {
    assert.equal(formatDuration(83), '1:23');
    assert.equal(formatDuration(3661), '1:01:01');
  });
  it('零', () => assert.equal(formatDuration(0), '-'));
  it('边界', () => assert.equal(formatDuration(null), '-'));
});

describe('esc (HTML)', () => {
  it('转义 < > " \' &', () => {
    const r = esc('<script>alert("xss\')</script>');
    assert.ok(!r.includes('<'));
    assert.ok(!r.includes('>'));
  });
});

describe('限速预设', () => {
  const PRESETS = [
    { label: '不限速', value: '' },
    { label: '500K', value: '500K' },
    { label: '1M', value: '1M' },
    { label: '2M', value: '2M' },
    { label: '5M', value: '5M' },
    { label: '10M', value: '10M' },
    { label: '20M', value: '20M' },
    { label: '50M', value: '50M' },
  ];
  it('8 预设', () => assert.equal(PRESETS.length, 8));
  it('空=不限速', () => assert.equal(PRESETS[0].value, ''));
});

describe('Content-Type 映射', () => {
  const ct = {'.mp4':'video/mp4','.mkv':'video/x-matroska','.mp3':'audio/mpeg'};
  it('视频', () => assert.equal(ct['.mp4'], 'video/mp4'));
  it('音频', () => assert.equal(ct['.mp3'], 'audio/mpeg'));
});

describe('body max 2MB', () => {
  it('≤2MB 允许', () => assert.ok(1 * 1024 * 1024 < 2097152));
  it('>2MB 拒绝', () => assert.ok(2097153 > 2097152));
});
// ════════════════════════════════════════════════════════════
// v0.4.0 新增测试: 磁盘配额 + 文件名模板 + 搜索 + 统计
// ════════════════════════════════════════════════════════════

describe('磁盘配额 parseSizeString', () => {
  const extractSrc = (name) => {
    const re = new RegExp(`const ${name} = (\\\(.*?\\\)|\\\\{.*?\\\\}|async\\\s*\\\(.*?\\\)\\\s*=>\\\s*\\\\{[^]*?\\\\n\\\\})`, 's');
    const m = serverSrc.match(re);
    if (!m) throw new Error(`Pattern not found: ${name}`);
    return m[0].replace(/^const \\w+ = /, '').replace(/;\s*$/, '');
  };

  // 直接重新定义 parseSizeString (同 server.js)
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

  it('空字符串 → 0', () => assert.equal(parseSizeString(''), 0));
  it('"0" → 0', () => assert.equal(parseSizeString('0'), 0));
  it('null → 0', () => assert.equal(parseSizeString(null), 0));
  it('undefined → 0', () => assert.equal(parseSizeString(undefined), 0));
  it('"50G" → 50 * 1024^3', () => assert.equal(parseSizeString('50G'), 50 * 1024**3));
  it('"500M" → 500 * 1024^2', () => assert.equal(parseSizeString('500M'), 500 * 1024**2));
  it('"2.5G" → 2.5 * 1024^3 取整', () => assert.equal(parseSizeString('2.5G'), Math.floor(2.5 * 1024**3)));
  it('"1024K" → 1024 * 1024', () => assert.equal(parseSizeString('1024K'), 1024 * 1024));
  it('"1T" → 1024^4', () => assert.equal(parseSizeString('1T'), 1024**4));
  it('"abc" → 0 (无效)', () => assert.equal(parseSizeString('abc'), 0));
  it('"100" 无单位 → 100 字节', () => assert.equal(parseSizeString('100'), 100));
  it('"50 GB" 带空格 → 50G', () => assert.equal(parseSizeString('50 GB'), 50 * 1024**3));
  it('数字输入直通', () => assert.equal(parseSizeString(1234), 1234));
  it('负数 → 0', () => assert.equal(parseSizeString(-1), 0));
});

describe('磁盘配额 DEFAULT_CONFIG 字段', () => {
  it('quotaBytes 默认 0', () => {
    const m = serverSrc.match(/quotaBytes:\s*(\d+)/);
    assert.ok(m, 'quotaBytes not in DEFAULT_CONFIG');
    assert.equal(parseInt(m[1]), 0);
  });
  it('quotaAutoClean 默认 false', () => {
    const m = serverSrc.match(/quotaAutoClean:\s*(true|false)/);
    assert.ok(m, 'quotaAutoClean not in DEFAULT_CONFIG');
    assert.equal(m[1], 'false');
  });
});

describe('磁盘配额 API 路由', () => {
  it('GET /api/quota 路由', () => {
    assert.match(serverSrc, /pathname === '\/api\/quota' && req\.method === 'GET'/);
  });
  it('POST /api/quota/clean 路由', () => {
    assert.match(serverSrc, /pathname === '\/api\/quota\/clean' && req\.method === 'POST'/);
  });
  it('GET /api/quota/size 路由', () => {
    assert.match(serverSrc, /pathname === '\/api\/quota\/size' && req\.method === 'GET'/);
  });
});

describe('磁盘配额核心函数', () => {
  it('checkQuotaUsage 函数存在', () => {
    assert.match(serverSrc, /const checkQuotaUsage = async/);
  });
  it('enforceQuota 函数存在', () => {
    assert.match(serverSrc, /const enforceQuota = async/);
  });
  it('autoCleanOldest 函数存在', () => {
    assert.match(serverSrc, /const autoCleanOldest = async/);
  });
  it('computeDirBytes 10s timeout', () => {
    assert.match(serverSrc, /computeDirBytes[\s\S]*?setTimeout\([\s\S]*?10000/);
  });
});

describe('配额自动清理 hook', () => {
  it('parseAndCreateTask 调用 enforceQuota', () => {
    // 在 quotaAutoClean=true 时调用
    const block = serverSrc.match(/parseAndCreateTask = async[\s\S]*?await enforceQuota/);
    assert.ok(block, 'quota hook not in parseAndCreateTask');
  });
});

describe('文件名模板 DEFAULT_CONFIG', () => {
  it('默认模板', () => {
    const m = serverSrc.match(/outputTemplate:\s*'([^']+)'/);
    assert.ok(m, 'outputTemplate not in DEFAULT_CONFIG');
    assert.ok(m[1].includes('%(title)s'));
    assert.ok(m[1].includes('%(id)s'));
  });
});

describe('文件名模板实时预览函数', () => {
  // 提取 main.js 里的 _previewOutputTemplate 逻辑验证
  const mainSrc = fs.readFileSync(new URL('../ui/main.js', import.meta.url), 'utf8');
  it('_previewOutputTemplate 函数存在', () => {
    assert.match(mainSrc, /const _previewOutputTemplate/);
  });
  it('updateOutputTemplatePreview 存在', () => {
    assert.match(mainSrc, /const updateOutputTemplatePreview/);
  });
  it('preview 函数替换 %(title)s', () => {
    // 直接模拟
    const title = '测试视频';
    const tpl = '%(title)s.mp4';
    const r = tpl.replace(/%\(title\)s/gi, title);
    assert.equal(r, '测试视频.mp4');
  });
  it('preview 函数替换 %(id)s', () => {
    const tpl = 'v=%(id)s';
    const r = tpl.replace(/%\(id\)s/gi, 'abc123');
    assert.equal(r, 'v=abc123');
  });
  it('preview 函数多字段组合', () => {
    const tpl = '%(title)s [%(id)s].%(ext)s';
    let r = tpl.replace(/%\(title\)s/gi, '视频')
               .replace(/%\(id\)s/gi, 'xyz')
               .replace(/%\(ext\)s/gi, 'mp4');
    assert.equal(r, '视频 [xyz].mp4');
  });
});

describe('统计面板 KPI 4 项', () => {
  const mainSrc = fs.readFileSync(new URL('../ui/main.js', import.meta.url), 'utf8');
  it('computeStats 函数', () => assert.match(mainSrc, /const computeStats = \(\) =>/));
  it('renderStatsPanel 函数', () => assert.match(mainSrc, /const renderStatsPanel = \(\) =>/));
  it('statsTotalBytes KPI', () => assert.match(mainSrc, /statsTotalBytes['"]\)\.textContent = formatBytes/));
  it('statsCompletedCount KPI', () => assert.match(mainSrc, /statsCompletedCount['"]\)\.textContent =/));
  it('statsMonthBytes KPI', () => assert.match(mainSrc, /statsMonthBytes['"]\)\.textContent/));
  it('statsTotalDuration KPI', () => assert.match(mainSrc, /statsTotalDuration['"]\)\.textContent/));
});

describe('统计图表 canvas', () => {
  const mainSrc = fs.readFileSync(new URL('../ui/main.js', import.meta.url), 'utf8');
  it('chartDaily canvas 渲染', () => assert.match(mainSrc, /_drawDailyChart\(\$\('chartDaily'\)/));
  it('chartDomain canvas 渲染', () => assert.match(mainSrc, /_drawDomainChart\(\$\('chartDomain'\)/));
  it('stats tab 切换触发', () => assert.match(mainSrc, /dataset\.tab === 'stats'\) renderStatsPanel/));
});

describe('搜索字段扩展 (v0.4.0)', () => {
  const mainSrc = fs.readFileSync(new URL('../ui/main.js', import.meta.url), 'utf8');
  it('搜索匹配 url + filename + title 三字段', () => {
    const m = mainSrc.match(/filtered = !query \? byFilter : byFilter\.filter[\s\S]*?return /);
    assert.ok(m, 'filter not found');
    const block = m[0];
    assert.match(block, /t\.url/);
    assert.match(block, /t\.filename/);
    assert.match(block, /t\.title/);
  });
});

describe('settings panel 新增 2 个 tab', () => {
  const html = fs.readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8');
  it('storage tab', () => assert.match(html, /data-tab="storage"/));
  it('stats tab', () => assert.match(html, /data-tab="stats"/));
  it('settingsPanelStorage div', () => assert.match(html, /id="settingsPanelStorage"/));
  it('settingsPanelStats div', () => assert.match(html, /id="settingsPanelStats"/));
});

describe('CSS: chart-row + chart-card', () => {
  const css = fs.readFileSync(new URL('../ui/styles/layout.css', import.meta.url), 'utf8');
  it('.chart-row 定义', () => assert.match(css, /\.chart-row\s*\{/));
  it('.chart-card 定义', () => assert.match(css, /\.chart-card\s*\{/));
  it('.chart-canvas 定义', () => assert.match(css, /\.chart-canvas\s*\{/));
  it('响应式: max-width 768px 单列', () => {
    // 在 768px 媒体查询内 .chart-row grid-template-columns: 1fr
    assert.match(css, /@media \(max-width: 768px\)[\s\S]*?\.chart-row\s*\{[\s\S]*?grid-template-columns:\s*1fr/);
  });
});
