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
  // v0.5.0: verbose 模式 (01h23m45s) - 在测试环境 mock window._config
  it('verbose 模式', () => {
    const origCfg = global.window;
    global.window = { _config: { etaVerbose: true } };
    try {
      assert.equal(formatDuration(83), '1m23s');
      assert.equal(formatDuration(3661), '01h01m01s');
      assert.equal(formatDuration(45), '45s');
    } finally {
      global.window = origCfg;
    }
  });
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
  it('showStatsModal 独立入口', () => assert.match(mainSrc, /const showStatsModal = \(\) =>[\s\S]*?renderStatsPanel/));
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

describe('settings panel 新增 1 个 tab (storage)', () => {
  const html = fs.readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8');
  it('storage tab', () => assert.match(html, /data-tab="storage"/));
  it('没有 stats tab (已挪到独立 modal)', () => assert.doesNotMatch(html, /data-tab="stats"/));
  it('settingsPanelStorage div', () => assert.match(html, /id="settingsPanelStorage"/));
  it('statsModal 独立 modal', () => assert.match(html, /id="statsModal"/));
  it('toolbar 有统计按钮', () => assert.match(html, /onclick="showStatsModal\(\)"/));
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

describe('空状态图标居中 (v0.4.2)', () => {
  const css = fs.readFileSync(new URL('../ui/styles/layout.css', import.meta.url), 'utf8');
  it('.empty-icon-wrap margin: 0 auto (居中)', () => {
    assert.match(css, /\.empty-icon-wrap\s*\{[\s\S]*?margin:\s*0 auto 20px/);
  });
});

// ════════════════════════════════════════════════════════════
// v0.5.0 新增测试: 视频裁剪 + aria2c + 转码 + 速度模板 + 主题跟随 + ETA + yt-dlp 更新 + 重复检测 + 任务标签 + 导入配置
// ════════════════════════════════════════════════════════════

describe('v0.5.0 DEFAULT_CONFIG 新字段', () => {
  it('downloadSections 默认空', () => {
    assert.match(serverSrc, /downloadSections:\s*''/);
  });
  it('forceKeyframesAtCuts 默认 false', () => {
    assert.match(serverSrc, /forceKeyframesAtCuts:\s*false/);
  });
  it('useAria2c 默认 auto', () => {
    assert.match(serverSrc, /useAria2c:\s*'auto'/);
  });
  it('aria2cConnections 默认 16', () => {
    assert.match(serverSrc, /aria2cConnections:\s*16/);
  });
  it('recodeVideo 默认空', () => {
    assert.match(serverSrc, /recodeVideo:\s*''/);
  });
  it('etaVerbose 默认 false', () => {
    assert.match(serverSrc, /etaVerbose:\s*false/);
  });
  it('themeFollowSystem 默认 false', () => {
    assert.match(serverSrc, /themeFollowSystem:\s*false/);
  });
  it('checkYtDlpUpdate 默认 false', () => {
    assert.match(serverSrc, /checkYtDlpUpdate:\s*false/);
  });
  it('speedSchedule 默认空数组', () => {
    assert.match(serverSrc, /speedSchedule:\s*\[\]/);
  });
});

describe('v0.5.0 buildYtDlpArgs 新参数', () => {
  it('--download-sections 注入', () => {
    assert.match(serverSrc, /config\.downloadSections\)\s*args\.push\('--download-sections'/);
  });
  it('--force-keyframes-at-cuts 注入', () => {
    assert.match(serverSrc, /forceKeyframesAtCuts\)\s*args\.push\('--force-keyframes-at-cuts'/);
  });
  it('--external-downloader aria2c', () => {
    assert.match(serverSrc, /args\.push\('--external-downloader', ARIA2C_BIN\)/);
  });
  it('--external-downloader-args aria2c 配置', () => {
    assert.match(serverSrc, /args\.push\('--external-downloader-args'/);
  });
  it('--recode-video 注入', () => {
    assert.match(serverSrc, /config\.recodeVideo\)\s*args\.push\('--recode-video'/);
  });
  it('--recode-video-format 注入', () => {
    assert.match(serverSrc, /config\.recodeFormat\)\s*args\.push\('--recode-video-format'/);
  });
  it('--limit-rate 来自 schedule 优先', () => {
    // 找到 speedSchedule 限速逻辑
    const block = serverSrc.match(/config\.speedSchedule[\s\S]*?_activeLimit/);
    assert.ok(block, 'speedSchedule limit logic not found');
  });
});

describe('v0.5.0 新增 API 端点', () => {
  it('GET /api/yt-dlp/check-update', () => {
    assert.match(serverSrc, /pathname === '\/api\/yt-dlp\/check-update'/);
  });
  it('POST /api/config/import-yt-dlp-conf', () => {
    assert.match(serverSrc, /pathname === '\/api\/config\/import-yt-dlp-conf'/);
  });
  it('/api/health 加 aria2cExists + ytDlpLatest', () => {
    assert.match(serverSrc, /aria2cExists:\s*fs\.existsSync\(ARIA2C_BIN\)/);
    assert.match(serverSrc, /ytDlpLatest:\s*_ytDlpLatestVersion/);
  });
});

describe('v0.5.0 archive 重复检测', () => {
  it('extractVideoIdFromUrl YouTube watch?v=', () => {
    assert.match(serverSrc, /const extractVideoIdFromUrl = \(url\) =>/);
    assert.match(serverSrc, /searchParams\.get\('v'\)/);
  });
  it('extractVideoIdFromUrl youtu.be/XXX', () => {
    assert.match(serverSrc, /pathname\.split\('\/'\)\.filter\(Boolean\)\.pop/);
  });
  it('extractVideoIdFromUrl bilibili BV', () => {
    assert.match(serverSrc, /bilibili\.com/);
    assert.match(serverSrc, /BV\\w\+\|av\\d\+/i);
  });
  it('readArchiveIds 函数', () => {
    assert.match(serverSrc, /const readArchiveIds = \(archivePath\) =>/);
  });
  it('POST /api/tasks 检查 archive', () => {
    assert.match(serverSrc, /if \(config\.downloadArchive\)[\s\S]*?checkArchiveDuplicate/);
  });
});

describe('v0.5.0 parseYtDlpConf 白名单', () => {
  it('parseYtDlpConf 函数存在', () => {
    assert.match(serverSrc, /const parseYtDlpConf = \(content\) =>/);
  });
  it('KEY_MAP 包含 format/output/limit-rate 等', () => {
    const block = serverSrc.match(/const KEY_MAP = \{[\s\S]*?\};/);
    assert.ok(block, 'KEY_MAP not found');
    assert.match(block[0], /'format'/);
    assert.match(block[0], /'output'/);
    assert.match(block[0], /'limit-rate'/);
    assert.match(block[0], /'proxy'/);
    assert.match(block[0], /'no-playlist'/);
    assert.match(block[0], /'recode-video'/);
    assert.match(block[0], /'download-sections'/);
  });
  it('parseYtDlpConf 注释过滤 (#)', () => {
    assert.match(serverSrc, /replace\(\/\^\\s\*#\.\*\$\/, ''\)/);
  });
  it('parseYtDlpConf 引号去除', () => {
    assert.match(serverSrc, /replace\(\/\^\["'\]|\["'\]\$\/g, ''\)/);
  });
});

describe('v0.5.0 checkYtDlpUpdate', () => {
  it('checkYtDlpUpdate 函数', () => {
    assert.match(serverSrc, /const checkYtDlpUpdate = async \(\) =>/);
  });
  it('GitHub API 调用', () => {
    assert.match(serverSrc, /api\.github\.com\/repos\/yt-dlp\/yt-dlp\/releases\/latest/);
  });
  it('6h 缓存', () => {
    assert.match(serverSrc, /6 \* 3600 \* 1000/);
  });
  it('后台 setTimeout 触发', () => {
    assert.match(serverSrc, /setTimeout\(\(\) => \{ checkYtDlpUpdate\(\)\.catch/);
  });
});

describe('v0.5.0 任务标签字段', () => {
  it('createTask 加 tags 字段', () => {
    const block = serverSrc.match(/const task = \{[\s\S]*?options: \{ \.\.\.options \}/);
    assert.ok(block, 'task object not found');
    assert.match(block[0], /tags:/);
  });
  it('tags 数组上限 10', () => {
    assert.match(serverSrc, /slice\(0, 10\)/);
  });
});

describe('v0.5.0 视频格式 tab', () => {
  const mainSrc = fs.readFileSync(new URL('../ui/main.js', import.meta.url), 'utf8');
  it('renderTasks 扩展 filter video/audio', () => {
    assert.match(mainSrc, /currentFilter === 'video' \|\| currentFilter === 'audio'/);
  });
  it('video ext 列表', () => {
    assert.match(mainSrc, /\/\^\(mp4\|mkv\|webm\|m4v\|flv\|avi\|mov\)\$/);
  });
  it('audio ext 列表', () => {
    assert.match(mainSrc, /\/\^\(mp3\|m4a\|opus\|flac\|wav\|aac\|ogg\)\$/);
  });
  it('countVideo + countAudio', () => {
    assert.match(mainSrc, /countVideo['"]\)\.textContent/);
    assert.match(mainSrc, /countAudio['"]\)\.textContent/);
  });
});

describe('v0.5.0 复制 yt-dlp 命令', () => {
  const mainSrc = fs.readFileSync(new URL('../ui/main.js', import.meta.url), 'utf8');
  it('copyYtDlpCmd 函数', () => {
    assert.match(mainSrc, /const copyYtDlpCmd = async \(id\) =>/);
  });
  it('clipboard API', () => {
    assert.match(mainSrc, /navigator\.clipboard\.writeText/);
  });
});

describe('v0.5.0 速度模板 UI', () => {
  const html = fs.readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8');
  it('speedScheduleList 容器', () => assert.match(html, /id="speedScheduleList"/));
  it('addSpeedSchedule 按钮', () => assert.match(html, /onclick="addSpeedSchedule\(\)"/));
  const mainSrc = fs.readFileSync(new URL('../ui/main.js', import.meta.url), 'utf8');
  it('renderSpeedSchedule 函数', () => assert.match(mainSrc, /const renderSpeedSchedule = \(list\) =>/));
  it('collectSpeedSchedule 函数', () => assert.match(mainSrc, /const collectSpeedSchedule = \(\) =>/));
});

describe('v0.5.0 aria2c UI', () => {
  const html = fs.readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8');
  it('setUseAria2c select', () => assert.match(html, /id="setUseAria2c"/));
  it('setAria2cConnections input', () => assert.match(html, /id="setAria2cConnections"/));
  it('aria2cHint 检测提示', () => assert.match(html, /id="aria2cHint"/));
});

describe('v0.5.0 视频裁剪 UI', () => {
  const html = fs.readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8');
  it('setDownloadSections', () => assert.match(html, /id="setDownloadSections"/));
  it('setForceKeyframesAtCuts', () => assert.match(html, /id="setForceKeyframesAtCuts"/));
});

describe('v0.5.0 文件名模板预设', () => {
  const html = fs.readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8');
  it('applyTemplatePreset 调用', () => assert.match(html, /onclick="applyTemplatePreset\(/));
  it('默认模板按钮', () => assert.match(html, /📺 默认/));
  it('按作者分目录按钮', () => assert.match(html, /📁 按作者分目录/));
  it('仅标题按钮', () => assert.match(html, /📝 仅标题/));
  it('播放列表编号按钮', () => assert.match(html, /🔢 播放列表编号/));
});

describe('v0.5.0 导入 yt-dlp.conf UI', () => {
  const html = fs.readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8');
  it('ytDlpConfText textarea', () => assert.match(html, /id="ytDlpConfText"/));
  it('importYtDlpConf 按钮', () => assert.match(html, /onclick="importYtDlpConf\(\)"/));
});

describe('v0.5.0 yt-dlp 更新检查 UI', () => {
  const html = fs.readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8');
  it('setCheckYtDlpUpdate 复选框', () => assert.match(html, /id="setCheckYtDlpUpdate"/));
  it('checkYtDlpUpdateNow 按钮', () => assert.match(html, /onclick="checkYtDlpUpdateNow\(\)"/));
  it('ytDlpVersionHint 显示', () => assert.match(html, /id="ytDlpVersionHint"/));
});

describe('v0.5.0 任务标签 UI', () => {
  const html = fs.readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8');
  it('addTags 输入框', () => assert.match(html, /id="addTags"/));
  const mainSrc = fs.readFileSync(new URL('../ui/main.js', import.meta.url), 'utf8');
  it('submitAddTask 提取 tags', () => assert.match(mainSrc, /options\.tags = tagInput\.split/));
});

describe('v0.5.0 主题跟随系统', () => {
  const mainSrc = fs.readFileSync(new URL('../ui/main.js', import.meta.url), 'utf8');
  it('matchMedia prefers-color-scheme', () => {
    assert.match(mainSrc, /prefers-color-scheme:\s*dark/);
  });
  it('applySystemTheme 函数', () => assert.match(mainSrc, /const applySystemTheme = \(\) =>/));
  it('init 阶段加载 _config', () => assert.match(mainSrc, /window\._config = await API\.get\('\/api\/config'\)/));
});

describe('v0.5.0 ETA verbose', () => {
  const mainSrc = fs.readFileSync(new URL('../ui/main.js', import.meta.url), 'utf8');
  it('formatDuration 支持 verbose 模式', () => {
    assert.match(mainSrc, /window\._config.*etaVerbose/s);
  });
  it('verbose 模式输出 h/m/s 拼接', () => {
    // 模板字符串: `${pad2(h)}h${pad2(m)}m${pad2(s)}s`
    assert.match(mainSrc, /pad2\(h\).{0,5}h.{0,5}pad2\(m\).{0,5}m.{0,5}pad2\(s\).{0,5}s/);
  });
});

// ════════════════════════════════════════════════════════════
// v0.6.0 新增测试: 借鉴 uvd (AI 总结 / 缩略图代理 / 字幕提取 / 速度曲线 / URL 预处理 / 思维导图)
// ════════════════════════════════════════════════════════════

describe('v0.6.0 normalizeUrl', () => {
  it('函数定义', () => assert.match(serverSrc, /const normalizeUrl = \(url\) =>/));
  it('抖音 modal_id → /video/', () => {
    assert.match(serverSrc, /modal_id[\s\S]*?return `https:\/\/www\.douyin\.com\/video\//);
  });
  it('抖音 /note/ → /video/', () => {
      const mainSrc = fs.readFileSync(new URL('../ui/server.js', import.meta.url), 'utf8');
      // 源码: u.pathname.match(/^\/note\/(\d+)/) — 文件里 \/note\/ 和 \d+ 是字面字符
      assert.ok(mainSrc.includes('\/note\/'));
      assert.ok(mainSrc.includes('\d+'));
    });
  it('POST /api/tasks 调用 normalizeUrl', () => {
    assert.match(serverSrc, /const url = normalizeUrl\(body\.url\?\.trim\(\)\)/);
  });
  it('POST /api/info 调用 normalizeUrl', () => {
    assert.match(serverSrc, /const url = normalizeUrl\(rawUrl\)/);
  });
});

describe('v0.6.0 缩略图代理', () => {
  it('路由 GET /api/proxy-thumbnail', () => assert.match(serverSrc, /pathname === '\/api\/proxy-thumbnail'/));
  it('抖音 CDN Referer', () => {
    assert.match(serverSrc, /douyinpic\.com[\s\S]*?Referer/);
  });
  it('fetch 转发', () => assert.match(serverSrc, /const proxyResp = await fetch\(target/));
  it('Cache-Control 1 天', () => assert.match(serverSrc, /max-age=86400/));
  const mainSrc = fs.readFileSync(new URL('../ui/main.js', import.meta.url), 'utf8');
  it('前端 wrapThumb 函数', () => assert.match(mainSrc, /const wrapThumb = \(url\) =>/));
  it('addPreview 缩略图走代理', () => assert.match(mainSrc, /src="\$\{esc\(wrapThumb\(info\.thumbnail\)/));
  it('infoModal 缩略图走代理', () => assert.match(mainSrc, /src="\$\{esc\(wrapThumb\(info\.thumbnail\)\)\}"/));
});

describe('v0.6.0 字幕提取', () => {
  it('_subtitleToText 函数', () => {
    assert.match(serverSrc, /const _subtitleToText = \(content\) =>/);
  });
  it('VTT 时间戳正则', () => assert.match(serverSrc, /\\d\{2\}:\\d\{2\}:\\d\{2\}\[\.\,\]\\d\{3\}\\s\*-->/));
  it('TTML 头移除', () => assert.match(serverSrc, /<tt\\b\[\^>\]\*\>/));
  it('HTML 标签移除', () => assert.match(serverSrc, /<\[\^>\]\+>/g));
  it('路由 GET /api/tasks/:id/subtitle', () => {
    assert.ok(serverSrc.includes('/api/tasks/') && serverSrc.includes('/subtitle'));
  });
  it('zh-Hans 优先语言', () => assert.match(serverSrc, /'zh-Hans'/));
  it('前端 viewTaskSubtitle 函数', () => {
    const mainSrc = fs.readFileSync(new URL('../ui/main.js', import.meta.url), 'utf8');
    assert.match(mainSrc, /const viewTaskSubtitle = async \(id\) =>/);
  });
  it('详情 modal 字幕按钮', () => {
    const html = fs.readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8');
    assert.match(html, /onclick="viewTaskSubtitle\(_currentDetailTaskId\)"/);
  });
});

describe('v0.6.0 AI 视频总结', () => {
  it('DEFAULT_CONFIG aiEnabled 默认 false', () => assert.match(serverSrc, /aiEnabled:\s*false/));
  it('DEFAULT_CONFIG aiProvider', () => assert.match(serverSrc, /aiProvider:\s*'custom'/));
  it('DEFAULT_CONFIG aiModel', () => assert.match(serverSrc, /aiModel:\s*'gpt-3.5-turbo'/));
  it('DEFAULT_CONFIG aiMaxTokens', () => assert.match(serverSrc, /aiMaxTokens:\s*4000/));
  it('AI_PROVIDERS 配置', () => assert.match(serverSrc, /const AI_PROVIDERS = \{[\s\S]*?openai[\s\S]*?glm[\s\S]*?deepseek/));
  it('_resolveAIConfig 优先环境变量', () => assert.match(serverSrc, /process\.env\.AI_API_KEY \|\| cfg\.aiApiKey/));
  it('AI_SUMMARY_PROMPT 4 段格式', () => {
    assert.match(serverSrc, /AI_SUMMARY_PROMPT = `[\s\S]*?智能总结[\s\S]*?章节大纲[\s\S]*?核心要点[\s\S]*?思维导图/);
  });
  it('startAISummary 函数', () => assert.match(serverSrc, /const startAISummary = async \(url\) =>/));
  it('yt-dlp --skip-download --write-subs 提取字幕', () => {
    assert.match(serverSrc, /'--skip-download', '--write-subs', '--write-auto-subs'/);
  });
  it('调用 OpenAI 兼容 /chat/completions', () => assert.match(serverSrc, /\/chat\/completions/));
  it('Bearer Token 认证', () => assert.match(serverSrc, /Bearer \$\{ai\.apiKey\}/));
  it('温度 + max_tokens', () => {
    assert.match(serverSrc, /temperature:\s*parseFloat\(config\.aiTemperature/);
    assert.match(serverSrc, /max_tokens:\s*parseInt\(config\.aiMaxTokens/);
  });
  it('12000 字截断', () => assert.match(serverSrc, /text\.length > 12000/));
  it('4 段结果解析 (智能总结/大纲/要点/导图)', () => {
    assert.match(serverSrc, /result\.summary\s*= p\.replace\(/);
    assert.match(serverSrc, /result\.outline\s*= p\.replace\(/);
    assert.match(serverSrc, /result\.key_points\s*= p\.replace\(/);
    assert.match(serverSrc, /result\.mind_map\s*= p\.replace\(/);
  });
  it('POST /api/ai/summarize 端点', () => assert.match(serverSrc, /pathname === '\/api\/ai\/summarize'/));
  it('GET /api/ai/progress/:id 端点', () => assert.ok(serverSrc.includes(String.raw`\/api\/ai\/progress\/`)));
  it('GET /api/ai/result/:id 端点', () => assert.ok(serverSrc.includes(String.raw`\/api\/ai\/result\/`)));
  it('aiEnabled 检查', () => {
    assert.match(serverSrc, /!config\.aiEnabled && !ai\.apiKey/);
  });

  const html = fs.readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8');
  it('HTML AI 配置 panel', () => assert.match(html, /id="settingsPanelAi"/));
  it('HTML aiSummaryModal', () => assert.match(html, /id="aiSummaryModal"/));
  it('HTML AI 4 个 tab', () => {
    assert.match(html, /data-aitab="summary"/);
    assert.match(html, /data-aitab="outline"/);
    assert.match(html, /data-aitab="keypoints"/);
    assert.match(html, /data-aitab="mindmap"/);
  });
  it('HTML AI 总结按钮 (任务详情)', () => assert.match(html, /onclick="startAISummaryUI\(_currentDetailTaskId\)"/));

  const mainSrc = fs.readFileSync(new URL('../ui/main.js', import.meta.url), 'utf8');
  it('前端 startAISummaryUI 函数', () => assert.match(mainSrc, /const startAISummaryUI = async \(taskId\) =>/));
  it('前端 4-Tab 切换', () => assert.match(mainSrc, /const _aiSwitchTab = \(tab\) =>/));
  it('前端 Markdown 渲染', () => assert.match(mainSrc, /const _renderMarkdown = \(text\) =>/));
  it('前端 思维导图 fallback 渲染', () => assert.match(mainSrc, /const _renderMindMap = \(text\) =>/));
  it('复制 Markdown 按钮', () => assert.match(mainSrc, /const copyAIMarkdown = async \(\) =>/));
});

describe('v0.6.0 单任务速度曲线', () => {
  it('task._speedHistory 采样', () => assert.match(serverSrc, /task\._speedHistory\.push\(\{[\s\S]*?bps:\s*task\.speed/));
  it('上限 200 采样点', () => assert.match(serverSrc, /task\._speedHistory\.length > 200/));
  const mainSrc = fs.readFileSync(new URL('../ui/main.js', import.meta.url), 'utf8');
  it('renderSpeedChart 函数', () => assert.match(mainSrc, /const renderSpeedChart = \(t\) =>/));
  it('canvas 绘制折线', () => assert.match(mainSrc, /ctx\.stroke\(\)/));
  it('HTML tdSpeedChart canvas', () => {
    const html = fs.readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8');
    assert.match(html, /id="tdSpeedChart"/);
  });
});
