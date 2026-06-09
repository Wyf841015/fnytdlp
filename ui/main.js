/**
 * fnytdlp 前端
 * - 复用 fnm3u8dl 的 8 项 UI 模式 (KPI / Toolbar / Task Card / Settings modal / Cookie modal)
 * - API 调用 fetch + SSE 实时进度
 */

'use strict';

console.log('[fnytdlp] main.js loaded, version=0.1.0');

// ── API client (统一网关模式) ──────────────────────────────────────
const GATEWAY_BASE = (typeof window !== 'undefined' && window.GATEWAY_BASE) || '/app/fnytdlp';
const API = {
  _url(path) {
    // 绝对路径: 直接拼 GATEWAY_BASE + path
    // 例: '/app/fnytdlp' + '/api/tasks' = '/app/fnytdlp/api/tasks'
    return GATEWAY_BASE + (path.startsWith('/') ? path : '/' + path);
  },
  async get(path) {
    const url = this._url(path);
    try {
      const r = await fetch(url, { credentials: 'same-origin' });
      if (!r.ok) {
        let errMsg = 'HTTP ' + r.status;
        try { const j = await r.json(); if (j && j.error) errMsg = j.error; } catch (e) {}
        console.error('[API.get] HTTP', r.status, url, errMsg);
        throw new Error(errMsg);
      }
      return r.json();
    } catch (e) {
      console.error('[API.get] failed', url, e);
      throw e;
    }
  },
  async post(path, body) {
    const url = this._url(path);
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body || {}),
      });
      if (!r.ok) {
        let errMsg = 'HTTP ' + r.status;
        try { const j = await r.json(); if (j && j.error) errMsg = j.error; } catch (e) {}
        console.error('[API.post] HTTP', r.status, url, errMsg);
        throw new Error(errMsg);
      }
      return r.json();
    } catch (e) {
      console.error('[API.post] failed', url, e);
      throw e;
    }
  },
  async put(path, body) {
    const url = this._url(path);
    const r = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body || {}),
    });
    if (!r.ok) {
      let errMsg = 'HTTP ' + r.status;
      try { const j = await r.json(); if (j && j.error) errMsg = j.error; } catch (e) {}
      throw new Error(errMsg);
    }
    return r.json();
  },
  async del(path) {
    const url = this._url(path);
    const r = await fetch(url, { method: 'DELETE', credentials: 'same-origin' });
    if (!r.ok) {
      let errMsg = 'HTTP ' + r.status;
      try { const j = await r.json(); if (j && j.error) errMsg = j.error; } catch (e) {}
      throw new Error(errMsg);
    }
    return r.json();
  },
};

// ── state ───────────────────────────────────────────────────────────
let tasks = [];
let currentFilter = 'all';
let deleteTargetId = null;

// ── Sparkline instances ────────────────────────────────────────────
let sparkActive, sparkSpeed, sparkCompleted, sparkTotal;

// ── DOM helpers ────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));
const pad = n => String(n).padStart(2, '0');

const formatBytes = (n) => {
  if (!n || n <= 0) return '0 B';
  const units = ['B','KB','MB','GB','TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return n.toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
};
const formatSpeed = (n) => n > 0 ? formatBytes(n) + '/s' : '0 B/s';
const formatDuration = (secs) => {
  secs = Math.max(0, parseInt(secs) || 0);
  if (secs === 0) return '-';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
};

// ── toast ──────────────────────────────────────────────────────────
const toast = (msg, type = 'info') => {
  const c = $('toastContainer');
  if (!c) return;
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(() => el.classList.add('toast-out'), 2400);
  setTimeout(() => el.remove(), 3000);
};

// ── modal helpers ──────────────────────────────────────────────────
const showModal = (id) => {
  const el = $(id);
  console.log('[fnytdlp] showModal(' + id + ') el=', el ? el.tagName + '.' + el.className : 'NULL');
  if (el) {
    el.classList.add('active');
    console.log('[fnytdlp]   → classList after:', Array.from(el.classList).join(','));
    console.log('[fnytdlp]   → display:', getComputedStyle(el).display);
  }
};
const hideModal = (id) => $(id)?.classList.remove('active');
window.showModal = showModal;
window.hideModal = hideModal;

// ── 主题切换 (HSL 系统, 跟 fnm3u8dl 一致) ──────────────────────
const THEMES = ['dark', 'light'];
let _themeIdx = THEMES.indexOf('dark');
const toggleTheme = () => {
  _themeIdx = (_themeIdx + 1) % THEMES.length;
  const t = THEMES[_themeIdx];
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('fnytdlp_theme', t); } catch (e) {}
  $('themeBtn').textContent = t === 'dark' ? '🌙' : '☀️';
};
window.toggleTheme = toggleTheme;
// 启动时恢复主题
try {
  const saved = localStorage.getItem('fnytdlp_theme');
  if (saved && THEMES.includes(saved)) {
    _themeIdx = THEMES.indexOf(saved);
    document.documentElement.dataset.theme = saved;
    $('themeBtn').textContent = saved === 'dark' ? '🌙' : '☀️';
  }
} catch (e) {}

// ── 时钟 ──────────────────────────────────────────────────────────
const updateClock = () => {
  const d = new Date();
  $('headerClockTime').textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  $('headerClockDate').textContent = `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日`;
};
setInterval(updateClock, 1000);
updateClock();

// ── 任务加载 + 渲染 ──────────────────────────────────────────────
const loadTasks = async () => {
  try {
    const data = await API.get('/api/tasks');
    tasks = data.tasks || [];
    renderTasks();
    updateKpi();
  } catch (e) {
    console.error('loadTasks failed', e);
  }
};

const renderTasks = () => {
  const list = $('taskList');
  const filtered = currentFilter === 'all' ? tasks : tasks.filter(t => t.status === currentFilter);
  if (filtered.length === 0) {
    list.innerHTML = '';
    $('emptyState').style.display = 'block';
  } else {
    $('emptyState').style.display = 'none';
    list.innerHTML = filtered.map(renderTask).join('');
  }
  // Tabs counts
  $('countAll').textContent = tasks.length;
  $('countActive').textContent = tasks.filter(t => t.status === 'downloading' || t.status === 'pending').length;
  $('countDone').textContent = tasks.filter(t => t.status === 'completed').length;
  $('countError').textContent = tasks.filter(t => t.status === 'error').length;
};

const renderTask = (t) => {
  const statusBadge = {
    pending: '<span class="badge badge-pending">⏳ 等待</span>',
    downloading: '<span class="badge badge-active">⏬ 下载中</span>',
    processing: '<span class="badge badge-active">🔄 处理</span>',
    completed: '<span class="badge badge-success">✅ 已完成</span>',
    error: '<span class="badge badge-danger">❌ 出错</span>',
    paused: '<span class="badge badge-warning">⏸ 暂停</span>',
    stopped: '<span class="badge badge-warning">⏹ 停止</span>',
  }[t.status] || `<span class="badge">${esc(t.status)}</span>`;

  const progressPct = (t.progress || 0).toFixed(1);
  const downloaded = formatBytes(t.downloadedBytes);
  const total = t.totalBytes ? formatBytes(t.totalBytes) : '?';
  const speed = formatSpeed(t.speed);
  const eta = t.eta ? formatDuration(t.eta) : '-';

  const title = t.filename || t.url;
  const showActions = t.status === 'error' || t.status === 'stopped' || t.status === 'paused';
  const canStop = t.status === 'downloading' || t.status === 'pending' || t.status === 'processing';

  return `
    <div class="task-item" data-id="${esc(t.id)}" onclick="showTaskDetail('${esc(t.id)}')">
      <div class="task-row task-row-1">
        <div class="task-title">${esc(t.title || title)}</div>
        <div class="task-actions" onclick="event.stopPropagation()">
          ${showActions ? `<button class="btn-icon-sm" title="重试" onclick="retryTask('${esc(t.id)}')">🔄</button>` : ''}
          ${canStop ? `<button class="btn-icon-sm" title="停止" onclick="stopTask('${esc(t.id)}')">⏹</button>` : ''}
          <button class="btn-icon-sm" title="删除" onclick="deleteTask('${esc(t.id)}')">🗑</button>
        </div>
      </div>
      <div class="task-row-2">
        <span class="task-url-text" title="${esc(t.url)}">${esc(t.url)}</span>
        ${statusBadge}
      </div>
      ${t.status === 'downloading' || t.status === 'processing' ? `
        <div class="task-progress">
          <div class="progress-track"><div class="progress-fill" style="width:${progressPct}%"></div></div>
          <div class="task-percent">${progressPct}%</div>
        </div>
        <div class="task-meta">
          <span class="task-speed">⚡ ${speed}</span>
          <span class="task-eta">⏱ 剩余 ${eta}</span>
          <span>${downloaded} / ${total}</span>
        </div>
      ` : ''}
      ${t.error ? `<div class="task-error">${esc(t.error)}</div>` : ''}
    </div>
  `;
};

const updateKpi = () => {
  const active = tasks.filter(t => t.status === 'downloading' || t.status === 'pending' || t.status === 'processing').length;
  const completed = tasks.filter(t => t.status === 'completed').length;
  const total = tasks.length;
  const totalSpeed = tasks.reduce((sum, t) => sum + (t.speed || 0), 0);

  $('kpiActive').textContent = active;
  $('kpiSpeed').textContent = formatSpeed(totalSpeed);
  $('kpiCompleted').textContent = completed;
  $('kpiTotal').textContent = total;

  // Sparkline push
  if (sparkActive) sparkActive.push(active);
  if (sparkSpeed) sparkSpeed.push(totalSpeed);
  if (sparkCompleted) sparkCompleted.push(completed);
  if (sparkTotal) sparkTotal.push(total);
};

const setKpi = (id, value) => {
  const el = $(id);
  if (!el) return;
  if (el.textContent !== String(value)) {
    el.textContent = value;
    el.classList.add('bump');
    setTimeout(() => el.classList.remove('bump'), 300);
  }
};

// ── 任务操作 ──────────────────────────────────────────────────────
const loadCookieSelect = async () => {
  const sel = $('addCookieName');
  if (!sel) return;
  try {
    const r = await API.get('/api/cookies');
    const cookies = (r && r.cookies) || [];
    sel.innerHTML = '<option value="">无 (不使用 Cookie)</option>' +
      cookies.map(c => `<option value="${esc(c.name)}">${esc(c.name)}${c.domain ? ' · ' + esc(c.domain) : ''}</option>`).join('');
  } catch (e) {
    sel.innerHTML = '<option value="">无 (不使用 Cookie)</option>';
  }
};
window.loadCookieSelect = loadCookieSelect;

const showAddTaskModal = () => {
  console.log('[fnytdlp] showAddTaskModal() called');
  $('addUrls').value = '';
  $('addFormat').value = '';
  $('addOutputTemplate').value = '';
  $('addSponsorBlock').value = '';
  $('addEmbedMetadata').checked = true;
  $('addWriteSubs').checked = false;
  $('addWriteThumbnail').checked = true;
  $('addNoPlaylist').checked = false;
  $('addCookieName').value = '';
  $('addPreview').textContent = '点 "解析" 按钮查看元数据';
  loadCookieSelect();
  showModal('addTaskModal');
  setTimeout(() => $('addUrls').focus(), 100);
};
window.showAddTaskModal = showAddTaskModal;

const parseUrls = async () => {
  const urls = $('addUrls').value.trim().split('\n').map(s => s.trim()).filter(Boolean);
  if (urls.length === 0) { toast('请先粘贴 URL', 'warn'); return; }
  const url = urls[0];
  $('addPreview').textContent = '⏳ 解析中...';
  try {
    const info = await API.post('/api/info', { url });
    $('addPreview').innerHTML = `
      <div class="info-card">
        <img class="info-thumb" src="${esc(info.thumbnail || '')}" onerror="this.style.display='none'">
        <div class="info-meta">
          <div class="info-title">${esc(info.title)}</div>
          <div class="info-uploader">📺 ${esc(info.uploader || 'unknown')}</div>
          <div class="info-duration">⏱ ${formatDuration(info.duration)} · ${esc(info.extractor)}</div>
          <div class="info-formats">📦 ${(info.formats || []).length} 个格式可选</div>
        </div>
      </div>
    `;
  } catch (e) {
    $('addPreview').textContent = '❌ 解析失败: ' + e.message;
  }
};
window.parseUrls = parseUrls;

const submitAddTask = async () => {
  const urls = $('addUrls').value.trim().split('\n').map(s => s.trim()).filter(Boolean);
  if (urls.length === 0) { toast('请粘贴 URL', 'warn'); return; }
  const options = {};
  const fmt = $('addFormat').value.trim();
  if (fmt) options.format = fmt;
  const ot = $('addOutputTemplate').value.trim();
  if (ot) options.outputTemplate = ot;
  const sb = $('addSponsorBlock').value.trim();
  if (sb) options.sponsorblockMark = sb.split(',').map(s => s.trim()).filter(Boolean);
  options.embedMetadata = $('addEmbedMetadata').checked;
  options.writeSubs = $('addWriteSubs').checked;
  options.writeThumbnail = $('addWriteThumbnail').checked;
  options.noPlaylist = $('addNoPlaylist').checked;
  const cookieName = $('addCookieName').value.trim();
  if (cookieName) options.cookieName = cookieName;

  let ok = 0, fail = 0;
  for (const url of urls) {
    try {
      const r = await API.post('/api/tasks', { url, options });
      if (r.task) ok++;
      else fail++;
    } catch (e) { fail++; }
  }
  hideModal('addTaskModal');
  toast(`已添加 ${ok} 个任务${fail ? '，' + fail + ' 失败' : ''}`, fail ? 'warn' : 'success');
  await loadTasks();
};
window.submitAddTask = submitAddTask;

const stopTask = async (id) => {
  await API.post(`/api/tasks/${id}/stop`);
  await loadTasks();
};
window.stopTask = stopTask;

const retryTask = async (id) => {
  await API.post(`/api/tasks/${id}/retry`);
  await loadTasks();
};
window.retryTask = retryTask;

const deleteTask = (id) => {
  deleteTargetId = id;
  const t = tasks.find(x => x.id === id);
  if (t) {
    $('deleteTaskInfo').innerHTML = `
      <div>URL: ${esc(t.url)}</div>
      <div>状态: ${esc(t.status)}</div>
      ${t.filename ? `<div>文件: ${esc(t.filename)}</div>` : ''}
    `;
  }
  showModal('deleteModal');
};
window.deleteTask = deleteTask;

const confirmDelete = async (withFile) => {
  if (!deleteTargetId) return;
  const id = deleteTargetId;
  const url = `/api/tasks/${id}${withFile ? '?deleteFile=1' : ''}`;
  await API.del(url);
  deleteTargetId = null;
  hideModal('deleteModal');
  toast(withFile ? '已删除任务和文件' : '已删除任务记录', 'success');
  await loadTasks();
};
window.confirmDelete = confirmDelete;

const clearCompleted = async () => {
  const completed = tasks.filter(t => t.status === 'completed' || t.status === 'error');
  for (const t of completed) {
    await API.del(`/api/tasks/${t.id}`);
  }
  toast(`已清理 ${completed.length} 个完成/出错任务`, 'success');
  await loadTasks();
};
window.clearCompleted = clearCompleted;

const stopAll = async () => {
  const downloading = tasks.filter(t => t.status === 'downloading' || t.status === 'pending');
  for (const t of downloading) {
    await API.post(`/api/tasks/${t.id}/stop`, {});
  }
  toast(`已停止 ${downloading.length} 个任务`, 'success');
  await loadTasks();
};
window.stopAll = stopAll;

// ── Info Modal ────────────────────────────────────────────────────
const showInfoModal = () => {
  $('infoUrl').value = '';
  $('infoResult').textContent = '输入 URL 点解析';
  showModal('infoModal');
  setTimeout(() => $('infoUrl').focus(), 100);
};
window.showInfoModal = showInfoModal;

const submitInfo = async () => {
  const url = $('infoUrl').value.trim();
  if (!url) { toast('请输入 URL', 'warn'); return; }
  $('infoResult').textContent = '⏳ 解析中...';
  try {
    const info = await API.post('/api/info', { url });
    let html = `
      <div class="info-card">
        ${info.thumbnail ? `<img class="info-thumb" src="${esc(info.thumbnail)}" onerror="this.style.display='none'">` : ''}
        <div class="info-meta">
          <div class="info-title">${esc(info.title)}</div>
          <div class="info-uploader">📺 ${esc(info.uploader || '')}</div>
          <div class="info-duration">⏱ ${formatDuration(info.duration)} · ${esc(info.extractor)}</div>
          ${info.uploadDate ? `<div>📅 ${esc(info.uploadDate)}</div>` : ''}
          ${info.viewCount ? `<div>👁 ${info.viewCount.toLocaleString()} 次观看</div>` : ''}
        </div>
      </div>
    `;
    if (info.formats && info.formats.length > 0) {
      html += '<div class="format-list">';
      info.formats.slice(0, 30).forEach(f => {
        html += `<div class="format-item">
          <span class="format-id">${esc(f.formatId)}</span>
          <span class="format-res">${esc(f.resolution || '-')}</span>
          <span class="format-ext">.${esc(f.ext || '-')}</span>
          <span class="format-size">${f.filesize ? formatBytes(f.filesize) : '?'}</span>
          <span class="format-codec">${esc(f.vcodec || f.acodec || '-')}</span>
        </div>`;
      });
      html += '</div>';
    }
    $('infoResult').innerHTML = html;
  } catch (e) {
    $('infoResult').textContent = '❌ ' + e.message;
  }
};
window.submitInfo = submitInfo;

// ── Settings Modal ────────────────────────────────────────────────
const showSettingsModal = async () => {
  const cfg = await API.get('/api/config');
  $('setDownloadPath').value = cfg.downloadPath || '';
  $('setConcurrent').value = cfg.concurrentDownloads || 3;
  $('setConcurrentFragments').value = cfg.concurrentFragments || 4;
  $('setFormat').value = cfg.format || '';
  $('setFormatSort').value = cfg.formatSort || '';
  $('setRetries').value = cfg.retries || 3;
  $('setProxyUrl').value = cfg.proxyUrl || '';
  $('setEmbedMetadata').checked = !!cfg.embedMetadata;
  $('setWriteSubs').checked = !!cfg.writeSubs;
  $('setWriteAutoSubs').checked = !!cfg.writeAutoSubs;
  $('setWriteThumbnail').checked = !!cfg.writeThumbnail;
  $('setNoPlaylist').checked = !!cfg.noPlaylist;
  $('setEmbedSubs').checked = !!cfg.embedSubs;
  $('setEmbedThumbnail').checked = !!cfg.embedThumbnail;
  $('setExtractAudio').checked = !!cfg.extractAudio;
  $('setAudioMultistreams').checked = !!cfg.audioMultistreams;
  $('setMtime').checked = cfg.mtime !== false;  // 默认 true
  // 高级 8 字段
  $('setLimitRate').value = cfg.limitRate || '';
  $('setSubLangs').value = cfg.subLangs || '';
  $('setAudioFormat').value = cfg.audioFormat || '';
  $('setAudioQuality').value = cfg.audioQuality || '';
  $('setMergeOutputFormat').value = cfg.mergeOutputFormat || '';
  $('setConvertSubs').value = cfg.convertSubs || '';
  $('setDownloadArchive').value = cfg.downloadArchive || '';
  $('setMaxDownloads').value = cfg.maxDownloads || 0;
  $('setDateAfter').value = cfg.dateAfter || '';
  $('setDateBefore').value = cfg.dateBefore || '';
  $('setMinFilesize').value = cfg.minFilesize || '';
  $('setMaxFilesize').value = cfg.maxFilesize || '';
  $('setMatchFilters').value = cfg.matchFilters || '';
  showModal('settingsModal');
};
const saveSettings = async () => {
  try {
    const cfg = {
      downloadPath: $('setDownloadPath').value.trim(),
      concurrentDownloads: parseInt($('setConcurrent').value) || 3,
      concurrentFragments: parseInt($('setConcurrentFragments').value) || 4,
      format: $('setFormat').value.trim(),
      formatSort: $('setFormatSort').value.trim(),
      retries: parseInt($('setRetries').value) || 3,
      proxyUrl: $('setProxyUrl').value.trim(),
      embedMetadata: $('setEmbedMetadata').checked,
      writeSubs: $('setWriteSubs').checked,
      writeAutoSubs: $('setWriteAutoSubs').checked,
      writeThumbnail: $('setWriteThumbnail').checked,
      noPlaylist: $('setNoPlaylist').checked,
      embedSubs: $('setEmbedSubs').checked,
      embedThumbnail: $('setEmbedThumbnail').checked,
      extractAudio: $('setExtractAudio').checked,
      audioMultistreams: $('setAudioMultistreams').checked,
      mtime: $('setMtime').checked,
      limitRate: $('setLimitRate').value.trim(),
      subLangs: $('setSubLangs').value.trim(),
      audioFormat: $('setAudioFormat').value.trim(),
      audioQuality: $('setAudioQuality').value.trim(),
      mergeOutputFormat: $('setMergeOutputFormat').value.trim(),
      convertSubs: $('setConvertSubs').value.trim(),
      downloadArchive: $('setDownloadArchive').value.trim(),
      maxDownloads: parseInt($('setMaxDownloads').value) || 0,
      dateAfter: $('setDateAfter').value.trim(),
      dateBefore: $('setDateBefore').value.trim(),
      minFilesize: $('setMinFilesize').value.trim(),
      maxFilesize: $('setMaxFilesize').value.trim(),
      matchFilters: $('setMatchFilters').value.trim(),
    };
    const r = await API.post('/api/config', cfg);
    if (r && r.ok) { hideModal('settingsModal'); toast('设置已保存', 'success'); }
    else { toast('保存失败: ' + ((r && r.error) || '服务端返回异常'), 'error'); }
  } catch (e) {
    toast('保存失败: ' + e.message, 'error');
    console.error('saveSettings error', e);
  }
};
window.saveSettings = saveSettings;
// 工具栏设置按钮用 onclick="showSettingsModal()" 已在 HTML 绑定

// ── Cookie Modal (多网站) ─────────────────────────────────────────
const renderCookieList = (cookies) => {
  const list = $('cookieList');
  if (!list) return;
  if (!cookies || cookies.length === 0) {
    list.innerHTML = '';
    return;
  }
  list.innerHTML = cookies.map(c =>
    `<span class="cookie-chip">🍪 <strong>${esc(c.name)}</strong>${c.domain ? ` <span class="chip-domain">${esc(c.domain)}</span>` : ''}<button class="chip-del" title="删除" onclick="deleteCookie('${esc(c.name)}')">×</button></span>`
  ).join('');
};
const loadCookieList = async () => {
  try {
    const r = await API.get('/api/cookies');
    renderCookieList(r.cookies || []);
  } catch (e) {
    const list = $('cookieList');
    if (list) list.textContent = '加载失败: ' + e.message;
  }
};
window.loadCookieList = loadCookieList;

const showCookieModal = async () => {
  showModal('cookieModal');
  $('cookieStatus').textContent = '';
  $('cookieName').value = '';
  $('cookieDomain').value = '';
  $('cookieContent').value = '';
  await loadCookieList();
};
window.showCookieModal = showCookieModal;

const saveCookie = async () => {
  const name = $('cookieName').value.trim();
  const domain = $('cookieDomain').value.trim();
  const content = $('cookieContent').value.trim();
  console.log('[fnytdlp] saveCookie called, name=', name, 'len=', content.length);
  if (!name) { toast('请输入 Cookie 名称', 'warn'); return; }
  if (!content) { toast('Cookie 内容不能为空', 'warn'); return; }
  try {
    const r = await API.post('/api/cookies', { name, domain, content });
    if (r && r.ok) {
      toast(`Cookie "${name}" 已保存`, 'success');
      $('cookieName').value = '';
      $('cookieDomain').value = '';
      $('cookieContent').value = '';
      renderCookieList(r.cookies);
      loadCookieSelect().catch(() => {});
    } else {
      toast('保存失败: ' + (r && r.error || '未知错误'), 'error');
    }
  } catch (e) {
    console.error('[fnytdlp] saveCookie error:', e);
    toast('保存失败: ' + e.message, 'error');
  }
};
window.saveCookie = saveCookie;

const deleteCookie = async (name) => {
  if (!name) return;
  if (!confirm(`确认删除 Cookie "${name}"?`)) return;
  const r = await API.del('/api/cookies/' + encodeURIComponent(name));
  if (r.ok) {
    toast(`Cookie "${name}" 已删除`, 'success');
    renderCookieList(r.cookies);
    loadCookieSelect();
  } else {
    toast('删除失败', 'error');
  }
};
window.deleteCookie = deleteCookie;

// ── Image Full Zoom ────────────────────────────────────────────────
function showImgFull(img) {
  const overlay = document.getElementById('imgFullOverlay');
  const fullImg = document.getElementById('imgFull');
  if (!overlay || !fullImg) return;
  fullImg.src = img.src;
  overlay.classList.add('show');
}
window.showImgFull = showImgFull;

// ── Task Detail Modal ──────────────────────────────────────────────
function showTaskDetail(id) {
  const t = tasks.find(x => x.id === id);
  if (!t) return;
  const setText = (eid, v) => { const el = $(eid); if (el) el.textContent = v; };
  setText('tdId', t.id);
  setText('tdTitle', t.title || '(无标题)');
  setText('tdUrl', t.url);
  setText('tdFilename', t.filename || '(下载中...)');
  setText('tdSize', t.totalBytes ? formatBytes(t.totalBytes) : (t.downloadedBytes ? formatBytes(t.downloadedBytes) : '?'));
  setText('tdDownloaded', t.downloadedBytes ? formatBytes(t.downloadedBytes) : '0 B');
  setText('tdLocation', '(加载中...)');
  // 异步加载 downloadPath
  API.get('/api/config').then(cfg => {
    window._config = cfg;
    const dlPath = cfg.downloadPath;
    setText('tdLocation', dlPath ? (t.filename ? (dlPath + '/' + t.filename) : dlPath) : '(默认下载目录)');
  }).catch(() => {
    setText('tdLocation', t.filename ? t.filename : '(默认下载目录)');
  });
  setText('tdStatus', ({pending:'⏳ 等待',downloading:'⏬ 下载中',processing:'🔄 处理',completed:'✅ 已完成',error:'❌ 出错',paused:'⏸ 暂停',stopped:'⏹ 停止'})[t.status] || t.status);
  setText('tdProgress', (t.progress || 0).toFixed(1) + '%' + (t.speed ? ` · ⚡ ${formatSpeed(t.speed)}` : ''));
  setText('tdFormat', t.format || t.ext || '-');
  setText('tdCreated', t.createdAt ? new Date(t.createdAt).toLocaleString('zh-CN') : '-');
  setText('tdCompleted', t.completedAt ? new Date(t.completedAt).toLocaleString('zh-CN') : '-');
  const errRow = $('tdErrorRow');
  if (t.error) {
    setText('tdError', t.error);
    if (errRow) errRow.style.display = 'flex';
  } else if (errRow) {
    errRow.style.display = 'none';
  }
  showModal('taskDetailModal');
}
window.showTaskDetail = showTaskDetail;

// ── Tabs ──────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentFilter = tab.dataset.filter;
    renderTasks();
  });
});

// ── SSE 实时进度 ─────────────────────────────────────────────────
// ── SSE 指数退避 ──────────────────────────────────────────────
let sseRetryCount = 0;
const SSE_RETRY_MAX = 60000;  // 最大 60s
const startSSE = () => {
  sseRetryCount = 0;  // P2-1: 成功连接后重置退避计数
  const es = new EventSource(GATEWAY_BASE + '/api/events');
  es.addEventListener('task-created', () => loadTasks());
  es.addEventListener('task-updated', () => loadTasks());
  es.addEventListener('task-progress', (e) => {
    const t = JSON.parse(e.data);
    const i = tasks.findIndex(x => x.id === t.id);
    if (i >= 0) tasks[i] = { ...tasks[i], ...t };
    else tasks.push(t);
    updateKpi();
    renderTasks();
  });
  es.addEventListener('task-deleted', (e) => {
    const { id } = JSON.parse(e.data);
    tasks = tasks.filter(x => x.id !== id);
    renderTasks();
    updateKpi();
  });
  // P2-1: SSE 指数退避（初始 5s, 逐次翻倍, 最大 60s）
  es.onerror = (e) => {
    sseRetryCount++;
    const delay = Math.min(5000 * Math.pow(2, sseRetryCount - 1), SSE_RETRY_MAX);
    console.warn(`SSE error (attempt ${sseRetryCount}), retrying in ${delay/1000}s`, e);
    es.close();
    setTimeout(startSSE, delay);
  };
};

// ── init ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  console.log('[fnytdlp] init started, DOMContentLoaded OK');
  // init sparklines
  try {
    sparkActive = new Sparkline('sparkActive', { max: 30, color: 'hsl(217, 91%, 60%)' });
    sparkSpeed = new Sparkline('sparkSpeed', { max: 30, color: 'hsl(152, 58%, 53%)' });
    sparkCompleted = new Sparkline('sparkCompleted', { max: 30, color: 'hsl(280, 60%, 65%)' });
    sparkTotal = new Sparkline('sparkTotal', { max: 30, color: 'hsl(40, 96%, 53%)' });
  } catch (e) { console.warn('Sparkline init failed', e); }
  // P0 修复: fnOS WebView inline onclick 失效
  // 排除 #settingsBtn（已在 addEventListener 单独绑定）
  document.querySelectorAll('[onclick]:not(#settingsBtn)').forEach(el => {
    const attr = el.getAttribute('onclick');
    el.removeAttribute('onclick');
    el.addEventListener('click', function(e) {
      try {
        // 如果含 event 引用 (modal overlay), 用 new Function + try-catch
        if (attr.includes('event.target')) {
          new Function('event', attr).call(this, e);
          return;
        }
        // 否则直接 window[fnName](...args) — 无 eval
        const m = attr.match(/^([a-zA-Z_]\w*)\((.*)\)$/);
        if (m && typeof window[m[1]] === 'function') {
          const raw = m[2].trim();
          if (raw) {
            // 支持单引号参数 (如 'sponsorModal', 't_xxx')
            const args = raw.split(',').map(s => {
              s = s.trim();
              if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
                return s.slice(1, -1);
              }
              // 数字/布尔/对象
              try { return JSON.parse(s); } catch (e) { return s; }
            });
            window[m[1]](...args);
          } else {
            window[m[1]]();
          }
        } else {
          // 兜底
          new Function('event', attr).call(this, e);
        }
      } catch(err) {
        console.error('[fnytdlp] onclick err:', attr, err);
      }
    });
  });
  // load initial
  await loadTasks();
  // poll every 3s as fallback
  setInterval(loadTasks, 3000);
  // SSE
  startSSE();
  // health
  try {
    const h = await API.get('/api/health');
    if (h.ytDlpExists) $('headerSubtitle').textContent = `yt-dlp ${h.arch} · ffmpeg ${h.ffmpegExists ? '✓' : '✗'}`;
  } catch (e) {}
});

// 导出 updateKpi 的 setKpi 给 KPI 数字加 bump 动画
const _origUpdateKpi = updateKpi;
