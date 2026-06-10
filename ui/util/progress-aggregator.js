// 纯函数: 解析一行 yt-dlp 输出, 更新 task._streamPhases + task.progress
// 从 server.js 的 PROGRESS / Destination / Merger 解析逻辑中抽出, 便于单测

const _SPEED_RE = /^([\d.]+)\s*(KiB|MiB|GiB|KB|MB|GB|B)\s*\/s$/i;
const _SPEED_K = { B: 1, KB: 1000, KiB: 1024, MB: 1000 ** 2, MiB: 1024 ** 2, GB: 1000 ** 3, GiB: 1024 ** 3 };
export function parseSpeed(s) {
  if (!s || s === 'Unknown B/s' || s === 'N/A') return 0;
  s = String(s).trim();
  const m = s.match(_SPEED_RE);
  if (!m) {
    // 防御: 0KiB/s 这类
    if (s.startsWith('0')) return 0;
    return 0;
  }
  const n = parseFloat(m[1]);
  if (isNaN(n)) return 0;
  return n * (_SPEED_K[m[2]] || 1);
}

export function parseDuration(s) {
  if (!s || s === 'Unknown' || s === 'NA') return 0;
  s = String(s).trim();
  if (/^(\d+):(\d+):(\d+)$/.test(s)) {
    const [h, m, sec] = s.split(':').map(Number);
    return h * 3600 + m * 60 + sec;
  }
  if (/^(\d+):(\d+)$/.test(s)) {
    const [m, sec] = s.split(':').map(Number);
    return m * 60 + sec;
  }
  const n = parseInt(s, 10);
  return isNaN(n) ? 0 : n;
}

// 解析一行: 返回 {kind, ...payload} 或 null
// kind: 'progress' | 'destination' | 'merger' | 'format'
export function parseLine(line) {
  if (!line) return null;
  if (line.startsWith('PROGRESS|')) {
    const parts = line.split('|');
    if (parts.length < 8) return null;
    return {
      kind: 'progress',
      pct: parseFloat(parts[1].replace('%','')) || 0,
      speed: parseSpeed(parts[2]),
      eta: parseDuration(parts[3]),
      downloaded: parseInt(parts[4], 10) || 0,
      total: parseInt(parts[5], 10) || 0,
      totalEst: parseInt(parts[6], 10) || 0,
    };
  }
  if (line.startsWith('[download] Destination:')) {
    const fp = line.substring('[download] Destination: '.length).trim();
    if (!fp || /\.(webp|jpe?g|png|gif|info\.json)$/i.test(fp)) return null;
    const base = fp.split('/').pop();
    if (!/\.(mp4|mkv|webm|m4a|mp3|opus|flac|wav|ts)$/i.test(base)) return null;
    const tmpMatch = base.match(/\.f(\d+)\.(mp4|mkv|webm|m4a|mp3|opus|flac|wav|ts)$/i);
    if (tmpMatch) {
      const ext = tmpMatch[2].toLowerCase();
      const isAudio = /^(m4a|mp3|opus|flac|wav)$/.test(ext);
      return { kind: 'destination', name: base, streamType: isAudio ? 'audio' : 'video', isTemp: true };
    }
    return { kind: 'destination', name: base, isTemp: false };
  }
  if (line.startsWith('[Merger]') || line.includes('Merging formats into')) {
    return { kind: 'merger' };
  }
  if (line.includes('Downloading') && line.includes('format(s):')) {
    const fm = line.match(/format\(s\):\s*(.+)/);
    if (fm) return { kind: 'format', value: fm[1].trim() };
  }
  return null;
}

// 创建初始 task 状态
export function newTask() {
  return {
    progress: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    speed: 0,
    eta: 0,
    filename: '',
    _streamPhases: {
      video: { pct: 0, downloaded: 0, total: 0, speed: 0, eta: 0, done: false },
      audio: { pct: 0, downloaded: 0, total: 0, speed: 0, eta: 0, done: false },
    },
    _currentStream: null,
    _phase: 'downloading',
    _pendingFilenames: [],
    _streamTypeCount: 2, // 默认 2 (双流: B站/YouTube 等), 看到只下载 1 个流时降回 1
  };
}

// 应用一行解析结果到 task (原地修改)
// 返回 task 方便链式
export function applyLine(task, line) {
  const ev = parseLine(line);
  if (!ev) return task;
  if (ev.kind === 'destination') {
    if (ev.isTemp) {
      task._pendingFilenames.push(ev.name);
      task._currentStream = ev.streamType;
      // _streamTypeCount 保持默认 2 (双流假设), 不在此处修改
      // 单流场景 (audio-only): 视频流不会来, 视频流位置会卡 0% — 等 PROGRESS 总数稳定后由 close handler 修正
    } else {
      task.filename = ev.name;
    }
    return task;
  }
  if (ev.kind === 'merger') {
    task._phase = 'merging';
    task._streamPhases.video.done = true;
    task._streamPhases.audio.done = true;
    task.progress = 99;
    task.speed = 0;
    task.eta = 0;
    return task;
  }
  if (ev.kind === 'format') {
    task.format = ev.value;
    return task;
  }
  if (ev.kind === 'progress') {
    const { pct, speed, eta, downloaded } = ev;
    const total = ev.total || ev.totalEst;
    if (task._currentStream && task._streamPhases[task._currentStream]) {
      const ph = task._streamPhases[task._currentStream];
      ph.pct = pct; ph.downloaded = downloaded; ph.total = total; ph.speed = speed; ph.eta = eta;
      if (pct >= 100) ph.done = true;
      const v = task._streamPhases.video, a = task._streamPhases.audio;
      const vPct = v.done ? 100 : v.pct, aPct = a.done ? 100 : a.pct;
      // 关键: cap 单流进度上限 = 100 / _streamTypeCount
      // 1 流时上限 100% (audio-only / video-only)
      // 2 流时上限 50% (即使 audio 还没开始, 视频也只算一半)
      // _streamTypeCount 默认 2, 因为大多数 B 站/YouTube 下载都是双流
      const cap = task._streamTypeCount > 0 ? (100 / task._streamTypeCount) : 100;
      // 单流: 暂时不知道是否还有另一流, 用 cap * pct / 100 缩放
      if (!v.total && a.total) {
        task.progress = Math.min(aPct * cap / 100, cap);
        task.speed = a.speed; task.eta = a.eta;
        task.downloadedBytes = a.downloaded; task.totalBytes = a.total;
      } else if (!a.total && v.total) {
        task.progress = Math.min(vPct * cap / 100, cap);
        task.speed = v.speed; task.eta = v.eta;
        task.downloadedBytes = v.downloaded; task.totalBytes = v.total;
      } else if (v.total && a.total) {
        // 双流: 各占 1/_streamTypeCount 比例
        const weight = 100 / task._streamTypeCount;
        task.progress = (vPct + aPct) * weight / 100;
        const active = v.done ? a : (a.done ? v : (v.pct <= a.pct ? v : a));
        task.speed = active.speed; task.eta = active.eta;
        task.downloadedBytes = v.downloaded + a.downloaded;
        task.totalBytes = v.total + a.total;
      } else {
        task.progress = Math.min(pct * cap / 100, cap);
        task.speed = speed; task.eta = eta;
        task.downloadedBytes = downloaded; task.totalBytes = total;
      }
    } else {
      // 单流 (无 _currentStream): cap 50% 默认
      const cap = task._streamTypeCount > 0 ? (100 / task._streamTypeCount) : 50;
      task.progress = Math.min(pct, cap);
      task.speed = speed; task.eta = eta;
      task.downloadedBytes = downloaded; task.totalBytes = total;
    }
    return task;
  }
  return task;
}
