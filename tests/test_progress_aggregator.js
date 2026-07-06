// 测试 progress-aggregator: 多流下载的 stream 识别 + 进度聚合
// 模拟真实 yt-dlp 输出: video.f100026.mp4 → PROGRESS 0%→100% → audio.f30280.m4a → PROGRESS 0%→100% → Merger

import test from 'node:test';
import assert from 'node:assert';
import { parseLine, applyLine, newTask, parseSpeed, describeFormatIds } from '../ui/util/progress-aggregator.js';

// ── parseSpeed ──
test('parseSpeed: 前导空格', () => {
  assert.strictEqual(parseSpeed('  1.05MiB/s'), 1024 * 1024 * 1.05);
});
test('parseSpeed: 0KiB/s → 0', () => {
  assert.strictEqual(parseSpeed('0KiB/s'), 0);
});
test('parseSpeed: Unknown B/s → 0', () => {
  assert.strictEqual(parseSpeed('Unknown B/s'), 0);
});

// ── parseLine 基础 ──
test('parseLine: PROGRESS 行', () => {
  const ev = parseLine('PROGRESS| 13.1%|  15.79MiB/s|00:00|2096128|16043660|NA|DONE');
  assert.strictEqual(ev.kind, 'progress');
  assert.strictEqual(Math.round(ev.pct * 10) / 10, 13.1);
  assert.strictEqual(ev.downloaded, 2096128);
  assert.strictEqual(ev.total, 16043660);
});
test('parseLine: video destination (临时) → streamType=video', () => {
  const ev = parseLine('[download] Destination: 【官方 MV】Never Gonna Give You Up - Rick Astley.f100026.mp4');
  assert.strictEqual(ev.kind, 'destination');
  assert.strictEqual(ev.isTemp, true);
  assert.strictEqual(ev.streamType, 'video');
});
test('parseLine: audio destination (临时) → streamType=audio', () => {
  const ev = parseLine('[download] Destination: 【官方 MV】Never Gonna Give You Up - Rick Astley.f30280.m4a');
  assert.strictEqual(ev.kind, 'destination');
  assert.strictEqual(ev.isTemp, true);
  assert.strictEqual(ev.streamType, 'audio');
});
test('parseLine: 合并后 destination → isTemp=false, 不带 streamType', () => {
  const ev = parseLine('[download] Destination: 【官方 MV】Never Gonna Give You Up - Rick Astley.mp4');
  assert.strictEqual(ev.kind, 'destination');
  assert.strictEqual(ev.isTemp, false);
  assert.strictEqual(ev.name, '【官方 MV】Never Gonna Give You Up - Rick Astley.mp4');
});
test('parseLine: 封面图 destination 跳过', () => {
  const ev = parseLine('[download] Destination: foo.jpg');
  assert.strictEqual(ev, null);
});
test('parseLine: Merger 行', () => {
  const ev = parseLine('[Merger] Merging formats into "foo.mp4"');
  assert.strictEqual(ev.kind, 'merger');
});

// ── 完整多流下载流程 ──
// _streamTypeCount 默认 2 (cap 50% 单流), 这是核心反"两次 100%"机制
test('多流下载: 视频 0%→50%, 任务进度 0%→25% (各占 50%)', () => {
  const t = newTask();
  applyLine(t, '[download] Destination: foo.f100026.mp4'); // _currentStream=video
  applyLine(t, 'PROGRESS|  0.0%|  1.05MiB/s|00:14|1024|16043660|NA|DONE');
  assert.strictEqual(t._currentStream, 'video');
  assert.strictEqual(t.progress, 0); // 视频 0% → 总 0%
  applyLine(t, 'PROGRESS| 50.0%|  5.00MiB/s|00:01|8000000|16043660|NA|DONE');
  // video 50% * 50% cap = 25%
  assert.strictEqual(Math.round(t.progress * 10) / 10, 25);
  assert.strictEqual(t.speed, 5 * 1024 * 1024);
  assert.strictEqual(t._streamPhases.video.pct, 50);
  assert.strictEqual(t._streamPhases.audio.pct, 0);
});

test('多流下载: 视频 100% 后切到音频, 任务进度 50%→75% (无独立 100%)', () => {
  const t = newTask();
  applyLine(t, '[download] Destination: foo.f100026.mp4');
  applyLine(t, 'PROGRESS|100.0%|30.00MiB/s|00:00|16043660|16043660|NA|DONE');
  // video 100% * 50% cap = 50% (不会跳到 100%)
  assert.strictEqual(Math.round(t.progress * 10) / 10, 50);
  assert.strictEqual(t._streamPhases.video.done, true);
  applyLine(t, '[download] Destination: foo.f30280.m4a'); // 切到 audio
  assert.strictEqual(t._currentStream, 'audio');
  applyLine(t, 'PROGRESS|  0.0%|  2.00MiB/s|00:02|1024|5408198|NA|DONE');
  // 视频 100 + 音频 0, 双流聚合 (50% * (100+0) / 100) = 50%
  assert.strictEqual(Math.round(t.progress * 10) / 10, 50);
  applyLine(t, 'PROGRESS| 50.0%|  3.00MiB/s|00:01|2704099|5408198|NA|DONE');
  // 视频 100 + 音频 50 = 150, * 50% / 100 = 75%
  assert.strictEqual(Math.round(t.progress * 10) / 10, 75);
});

test('多流下载: 视频 100% 后音频 100% → 任务 100% (Merger 前)', () => {
  const t = newTask();
  applyLine(t, '[download] Destination: foo.f100026.mp4');
  applyLine(t, 'PROGRESS|100.0%|30.00MiB/s|00:00|16043660|16043660|NA|DONE');
  applyLine(t, '[download] Destination: foo.f30280.m4a');
  applyLine(t, 'PROGRESS|100.0%|10.00MiB/s|00:00|5408198|5408198|NA|DONE');
  // 视频 100 + 音频 100 = 200, * 50% / 100 = 100%
  assert.strictEqual(Math.round(t.progress * 10) / 10, 100);
  assert.strictEqual(t._streamPhases.video.done, true);
  assert.strictEqual(t._streamPhases.audio.done, true);
});

test('多流下载: 不会出现两次独立 100% — video 100% 时 task.progress 永远 ≤ 50%', () => {
  const t = newTask();
  applyLine(t, '[download] Destination: foo.f100026.mp4');
  applyLine(t, 'PROGRESS|100.0%|30.00MiB/s|00:00|16043660|16043660|NA|DONE');
  // 关键: 视频 100% → task.progress=50 (不是 100)
  assert.strictEqual(Math.round(t.progress * 10) / 10, 50);
  applyLine(t, '[download] Destination: foo.f30280.m4a');
  applyLine(t, 'PROGRESS|100.0%|10.00MiB/s|00:00|5408198|5408198|NA|DONE');
  // 音频 100% → task.progress=100 (中间值, 用户看到一次 100%, 不是两次)
  assert.strictEqual(Math.round(t.progress * 10) / 10, 100);
  applyLine(t, '[Merger] Merging formats into "foo.mp4"');
  // 合并阶段 → 99 (不是 100)
  assert.strictEqual(t.progress, 99);
  assert.strictEqual(t._phase, 'merging');
  applyLine(t, '[download] Destination: foo.mp4');
  // 合并后 destination 才覆盖 filename
  assert.strictEqual(t.filename, 'foo.mp4');
});

test('单流下载 (audio-only): _streamTypeCount 默认 2, cap 50% 需 close handler 修正', () => {
  const t = newTask();
  // _streamTypeCount 默认 2 (双流假设), 单流场景 close handler 会改成 1
  assert.strictEqual(t._streamTypeCount, 2);
  applyLine(t, '[download] Destination: foo.f30280.m4a');
  applyLine(t, 'PROGRESS| 50.0%|  3.00MiB/s|00:01|2704099|5408198|NA|DONE');
  // audio 50% * 50% cap = 25% (单流但默认 2, 进度被压低)
  assert.strictEqual(Math.round(t.progress * 10) / 10, 25);
  // 模拟 close handler 修正: _streamTypeCount = 1 → cap = 100%
  t._streamTypeCount = 1;
  applyLine(t, 'PROGRESS|100.0%|  5.00MiB/s|00:00|5408198|5408198|NA|DONE');
  // audio 100% * 100% cap = 100%
  assert.strictEqual(Math.round(t.progress * 10) / 10, 100);
});

test('临时 filename 不覆盖 task.filename, 只暂存到 _pendingFilenames', () => {
  const t = newTask();
  applyLine(t, '[download] Destination: foo.f100026.mp4');
  assert.strictEqual(t.filename, ''); // 不覆盖
  assert.deepStrictEqual(t._pendingFilenames, ['foo.f100026.mp4']);
  applyLine(t, '[download] Destination: foo.f30280.m4a');
  assert.strictEqual(t.filename, ''); // 还是空
  assert.deepStrictEqual(t._pendingFilenames, ['foo.f100026.mp4', 'foo.f30280.m4a']);
  applyLine(t, '[download] Destination: foo.mp4');
  assert.strictEqual(t.filename, 'foo.mp4'); // 合并后才覆盖
});

// ── describeFormatIds: 数字 formatId 翻译成人类可读描述 ──
test('describeFormatIds: B 站多流 "100026+30280" → 1080p HEVC + 128k', () => {
  const formats = [
    { formatId: '100026', ext: 'mp4', height: 1080, vcodec: 'hev1.1.6.L120.90', acodec: 'none', formatNote: '1080p' },
    { formatId: '30280', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', abr: 128 },
  ];
  const desc = describeFormatIds('100026+30280', formats);
  assert.match(desc, /1080p/);
  assert.match(desc, /HEVC/);
  assert.match(desc, /128k/);
  assert.match(desc, /\+/);
});

test('describeFormatIds: 单视频流 "233" → 1080p mp4', () => {
  const formats = [
    { formatId: '233', ext: 'mp4', height: 1080, vcodec: 'avc1.640028', acodec: 'none', formatNote: '1080p' },
  ];
  const desc = describeFormatIds('233', formats);
  assert.match(desc, /1080p/);
  assert.match(desc, /H\.264/);
});

test('describeFormatIds: 纯音频 "140" → 128k m4a', () => {
  const formats = [
    { formatId: '140', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', abr: 128 },
  ];
  const desc = describeFormatIds('140', formats);
  assert.match(desc, /128k/);
  assert.match(desc, /m4a/);
});

test('describeFormatIds: 找不到的 formatId 兜底显示原值', () => {
  const formats = [
    { formatId: '100026', ext: 'mp4', height: 1080, vcodec: 'hev1.1.6.L120.90', acodec: 'none' },
  ];
  const desc = describeFormatIds('100026+99999', formats);
  assert.match(desc, /1080p/);
  assert.match(desc, /99999/); // 兜底
});

test('describeFormatIds: formats 数组为空时返空字符串', () => {
  assert.strictEqual(describeFormatIds('100026+30280', []), '');
  assert.strictEqual(describeFormatIds('100026+30280', null), '');
});

test('applyLine: format 行触发 formatDescription 计算', () => {
  const t = newTask();
  t._infoFormats = [
    { formatId: '100026', ext: 'mp4', height: 1080, vcodec: 'hev1.1.6.L120.90', acodec: 'none', formatNote: '1080p' },
    { formatId: '30280', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', abr: 128 },
  ];
  applyLine(t, '[info] BV1xxx: Downloading 1 format(s): 100026+30280');
  assert.strictEqual(t.format, '100026+30280');
  assert.match(t.formatDescription, /1080p.*HEVC.*\+.*128k/);
});

test('完整场景: B 站实测多流下载完整 PROGRESS 序列', () => {
  const t = newTask();
  const lines = [
    '[info] BV1GJ411x7h7: Downloading 1 format(s): 100026+30280',
    '[download] Destination: Never Gonna Give You Up.f100026.mp4',
    'PROGRESS|  0.0%|  1.05MiB/s|00:14|1024|16043660|NA|DONE',
    'PROGRESS| 25.0%|  5.00MiB/s|00:05|4010915|16043660|NA|DONE',
    'PROGRESS| 50.0%|  8.00MiB/s|00:02|8021830|16043660|NA|DONE',
    'PROGRESS| 75.0%| 10.00MiB/s|00:01|12032745|16043660|NA|DONE',
    'PROGRESS|100.0%| 15.00MiB/s|00:00|16043660|16043660|NA|DONE',
    'PROGRESS|100.0%|28.20MiB/s|NA|16043660|16043660|NA|DONE', // 扫尾
    '[download] Destination: Never Gonna Give You Up.f30280.m4a',
    'PROGRESS|  0.0%|  1.00MiB/s|00:05|1024|5408198|NA|DONE',
    'PROGRESS| 50.0%|  3.00MiB/s|00:01|2704099|5408198|NA|DONE',
    'PROGRESS|100.0%|  5.00MiB/s|00:00|5408198|5408198|NA|DONE',
    'PROGRESS|100.0%|3.37MiB/s|NA|5408198|5408198|NA|DONE', // 扫尾
    '[Merger] Merging formats into "Never Gonna Give You Up.mp4"',
    'Deleting original file Never Gonna Give You Up.f100026.mp4 (pass -k to keep)',
    'Deleting original file Never Gonna Give You Up.f30280.m4a (pass -k to keep)',
    '[download] Destination: Never Gonna Give You Up.mp4',
  ];
  // 检查关键时间点
  applyLine(t, lines[1]); // video destination
  assert.strictEqual(t._currentStream, 'video');
  applyLine(t, lines[2]); // video 0%
  assert.strictEqual(t.progress, 0);
  applyLine(t, lines[3]); // video 25%
  // video 25% * 50% cap = 12.5%
  assert.strictEqual(Math.round(t.progress), 13);
  applyLine(t, lines[4]); // video 50%
  // video 50% * 50% cap = 25%
  assert.strictEqual(Math.round(t.progress), 25);
  applyLine(t, lines[6]); // video 100%
  // video 100% * 50% cap = 50%
  assert.strictEqual(Math.round(t.progress), 50);
  assert.strictEqual(t._streamPhases.video.done, true);
  applyLine(t, lines[7]); // 扫尾
  assert.strictEqual(Math.round(t.progress), 50);
  applyLine(t, lines[8]); // audio destination
  assert.strictEqual(t._currentStream, 'audio');
  applyLine(t, lines[10]); // audio 50%
  // (100+50) * 50% / 100 = 75%
  assert.strictEqual(Math.round(t.progress), 75);
  applyLine(t, lines[11]); // audio 100%
  // (100+100) * 50% / 100 = 100%
  assert.strictEqual(Math.round(t.progress), 100);
  applyLine(t, lines[13]); // Merger
  assert.strictEqual(t.progress, 99);
  assert.strictEqual(t._phase, 'merging');
  applyLine(t, lines[16]); // 最终 mp4
  assert.strictEqual(t.filename, 'Never Gonna Give You Up.mp4');
  // 验证: 全程 task.progress 走 0% → 13% → 25% → 50% → 75% → 100% → 99%
  // 不出现两次独立 100% 跳动 (video 100% 时只到 50%, 不是 100%)
});
