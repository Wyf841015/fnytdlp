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
// M-7: 批量选中状态
const _batchSelected = new Set();
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
  const cssType = type === 'warn' ? 'warning' : type;
  // M-10: 4 种 type 对应 4 种 icon
  const icons = { success: '✓', error: '✕', warning: '!', info: 'i' };
  el.className = 'toast ' + cssType;
  el.innerHTML = `<span class="toast-icon">${icons[cssType] || 'i'}</span><span class="toast-msg">${esc(msg)}</span>`;
  c.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => el.classList.remove('show'), 2400);
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
    // a11y: 焦点陷阱 + Escape 关闭
    el._escListener = (e) => { if (e.key === 'Escape') hideModal(id); };
    document.addEventListener('keydown', el._escListener);
    // 记录打开前焦点, 关闭后还原
    el._prevFocus = document.activeElement;
    // 自动聚焦第一个可聚焦元素
    setTimeout(() => {
      const focusable = el.querySelector('input, textarea, select, button, [tabindex]:not([tabindex="-1"])');
      if (focusable) focusable.focus();
    }, 50);
  }
};
const hideModal = (id) => {
  const el = $(id);
  if (!el) return;
  el.classList.remove('active');
  // 清理 Escape 监听 + 还原焦点
  if (el._escListener) {
    document.removeEventListener('keydown', el._escListener);
    el._escListener = null;
  }
  if (el._prevFocus && el._prevFocus.focus) el._prevFocus.focus();
};
window.showModal = showModal;
window.hideModal = hideModal;

// ── 通用确认弹窗 ───────────────────────────────────────────────
let _confirmResolve = null;
const showConfirm = (title, message) => {
  return new Promise(resolve => {
    _confirmResolve = (val) => {
      _confirmResolve = null;
      hideModal('confirmModal');
      resolve(val);
    };
    $('confirmTitle').textContent = title;
    $('confirmMessage').textContent = message;
    showModal('confirmModal');
  });
};

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

// 版权年份
document.addEventListener('DOMContentLoaded', () => {
  const cy = document.getElementById('copyright-year');
  if (cy) cy.textContent = new Date().getFullYear();
});

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
    updateStatusBar();
  } catch (e) {
    console.error('loadTasks failed', e);
    // 后端故障 / 离线时给用户明确反馈 (P2 修复)
    const offline = !navigator.onLine;
    toast(offline ? '网络断开, 请检查连接' : `加载任务失败: ${e.message}`, 'error');
  }
};

const renderTasks = () => {
  const list = $('taskList');
  // M-3: 搜索 + 状态筛选
  const query = ($('searchInput')?.value || '').trim().toLowerCase();
  const byFilter = currentFilter === 'all' ? tasks : tasks.filter(t => t.status === currentFilter);
  const filtered = !query ? byFilter : byFilter.filter(t => {
    const url = (t.url || '').toLowerCase();
    const fname = (t.filename || t.title || '').toLowerCase();
    return url.includes(query) || fname.includes(query);
  });
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
  // M-7: 批量操作栏显隐 + 全选状态
  const _sel = $('selectAllCheckbox');
  if (_sel) {
    const visibleIds = new Set(filtered.map(t => t.id));
    const selectedVisible = [..._batchSelected].filter(id => visibleIds.has(id));
    _sel.checked = selectedVisible.length === visibleIds.length && visibleIds.size > 0;
    _sel.indeterminate = selectedVisible.length > 0 && selectedVisible.length < visibleIds.size;
  }
  // 用 .visible class 切显隐 (避免 backdrop-filter 破坏 [hidden])
  const _h = $('taskListHeader');
  if (_h) _h.classList.toggle('visible', filtered.length > 0);
  const _b = $('batchBar');
  if (_b) {
    $('batchCount').textContent = _batchSelected.size;
    _b.classList.toggle('visible', _batchSelected.size > 0);
  }
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
  // M-8: 已用时间 (用 t.createdAt 计算, downloading/processing 状态时显示)
  const isActive = t.status === 'downloading' || t.status === 'processing';
  let elapsed = '';
  if (isActive && t.createdAt) {
    const ms = Date.now() - new Date(t.createdAt).getTime();
    elapsed = `<span class="task-elapsed">⏳ 已用 ${formatDuration(Math.floor(ms / 1000))}</span>`;
  }
  // M-7: Cookie 任务徽章 (任务级 cookieName = 加密会员)
  const cookieBadge = t.cookieName ? `<span class="badge-encrypted" title="使用 Cookie: ${esc(t.cookieName)}">🔒 ${esc(t.cookieName)}</span>` : '';
  // M-7: 多选 checkbox
  const isSelected = _batchSelected.has(t.id);
  const checkbox = `<label class="task-checkbox" onclick="event.stopPropagation()"><input type="checkbox" data-id="${esc(t.id)}" ${isSelected ? 'checked' : ''} onchange="toggleBatchSelection('${esc(t.id)}', this.checked)"><span class="checkbox-mark"></span></label>`;

  return `
    <div class="task-item ${isSelected ? 'selected' : ''}" data-id="${esc(t.id)}" role="button" tabindex="0" aria-label="任务: ${esc(t.title || title)}" onclick="showTaskDetail('${esc(t.id)}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();showTaskDetail('${esc(t.id)}')}">
      <div class="task-row task-row-1">
        ${checkbox}
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
        ${cookieBadge}
      </div>
      ${isActive ? `
        <div class="task-progress">
          <div class="progress-track"><div class="progress-fill ${t.status === 'processing' ? 'tone-warning' : 'tone-success'}" style="width:${progressPct}%"></div></div>
          <div class="task-percent">${progressPct}%</div>
        </div>
        <div class="task-meta">
          <span class="task-speed">⚡ ${speed}</span>
          <span class="task-eta">⏱ 剩余 ${eta}</span>
          <span>${downloaded} / ${total}</span>
          ${elapsed}
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

  setKpi('kpiActive', active);
  setKpi('kpiSpeed', formatSpeed(totalSpeed));
  setKpi('kpiCompleted', completed);
  setKpi('kpiTotal', total);

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

// ── 底部状态栏更新 (M-2) ─────────────────────────────────────
const updateStatusBar = () => {
  const stats = $('statusStats');
  const text = $('statusText');
  const ind = $('statusIndicator');
  if (!stats || !text || !ind) return;
  const total = tasks.length;
  const downloading = tasks.filter(t => t.status === 'downloading' || t.status === 'recording').length;
  const completed = tasks.filter(t => t.status === 'completed').length;
  const error = tasks.filter(t => t.status === 'error').length;
  stats.textContent = `总计 ${total} · 下载 ${downloading} · 完成 ${completed}${error ? ' · 失败 ' + error : ''}`;
  // 状态指示
  ind.classList.remove('active', 'busy', 'idle');
  if (downloading > 0) {
    ind.classList.add('busy');
    text.textContent = `下载中 (${downloading})`;
  } else if (error > 0) {
    ind.classList.add('idle');
    text.textContent = `有 ${error} 个失败任务`;
  } else if (total === 0) {
    ind.classList.add('idle');
    text.textContent = '空闲';
  } else {
    ind.classList.add('active');
    text.textContent = `就绪 (${total})`;
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

// M-7: 批量选择 ──────────────────────────────────────────
const toggleBatchSelection = (id, checked) => {
  if (checked) _batchSelected.add(id);
  else _batchSelected.delete(id);
  renderTasks();
};
const toggleSelectAll = (checked) => {
  // 全选 = 当前可见 (filter + search 后) 全部
  const list = $('taskList');
  if (!list) return;
  const visible = list.querySelectorAll('.task-item');
  visible.forEach(el => {
    const id = el.dataset.id;
    if (!id) return;
    if (checked) _batchSelected.add(id);
    else _batchSelected.delete(id);
  });
  renderTasks();
};
const clearBatchSelection = () => {
  _batchSelected.clear();
  renderTasks();
};
const batchRetry = async () => {
  if (_batchSelected.size === 0) return;
  const ids = [..._batchSelected];
  for (const id of ids) {
    try { await API.post(`/api/tasks/${id}/retry`); } catch (e) { console.warn('batch retry failed', id, e); }
  }
  toast(`已重试 ${ids.length} 个任务`, 'success');
  clearBatchSelection();
  await loadTasks();
};
const batchStop = async () => {
  if (_batchSelected.size === 0) return;
  const ids = [..._batchSelected];
  for (const id of ids) {
    try { await API.post(`/api/tasks/${id}/stop`); } catch (e) { console.warn('batch stop failed', id, e); }
  }
  toast(`已停止 ${ids.length} 个任务`, 'success');
  clearBatchSelection();
  await loadTasks();
};
const batchDelete = async () => {
  if (_batchSelected.size === 0) return;
  const ids = [..._batchSelected];
  if (!await showConfirm('确认删除', `确认删除 ${ids.length} 个任务? (仅记录, 不删文件)`)) return;
  for (const id of ids) {
    try { await API.del(`/api/tasks/${id}`); } catch (e) { console.warn('batch delete failed', id, e); }
  }
  toast(`已删除 ${ids.length} 个任务`, 'success');
  clearBatchSelection();
  await loadTasks();
};
window.toggleBatchSelection = toggleBatchSelection;
window.toggleSelectAll = toggleSelectAll;
window.clearBatchSelection = clearBatchSelection;
window.batchRetry = batchRetry;
window.batchStop = batchStop;
window.batchDelete = batchDelete;

// 通用函数式 loading 守卫: 期间禁用按钮, 避免用户重复点击导致 N 次请求
const withButtonLoading = async (btn, fn) => {
  if (!btn) return fn();
  if (btn.disabled) return;  // 已在 loading, 静默忽略
  const orig = btn.textContent;
  btn.disabled = true;
  btn.classList.add('btn-loading');
  btn.textContent = '处理中...';
  try { return await fn(); } finally {
    btn.disabled = false;
    btn.classList.remove('btn-loading');
    btn.textContent = orig;
  }
};

const clearCompleted = async () => {
  return withButtonLoading(document.querySelector('button[onclick*="clearCompleted"]'), async () => {
    const completed = tasks.filter(t => t.status === 'completed' || t.status === 'error');
    let ok = 0;
    for (const t of completed) {
      try {
        await API.del(`/api/tasks/${t.id}`);
        ok++;
      } catch (e) { console.warn('clearCompleted task', t.id, 'failed', e); }
    }
    toast(`已清理 ${completed.length} 个任务${ok < completed.length ? ` (${ok} 成功)` : ''}`, ok === completed.length ? 'success' : 'warn');
    await loadTasks();
  });
};
window.clearCompleted = clearCompleted;

const stopAll = async () => {
  return withButtonLoading(document.querySelector('button[onclick*="stopAll"]'), async () => {
    const downloading = tasks.filter(t => t.status === 'downloading' || t.status === 'pending');
    let ok = 0;
    for (const t of downloading) {
      try {
        await API.post(`/api/tasks/${t.id}/stop`, {});
        ok++;
      } catch (e) { console.warn('stopAll task', t.id, 'failed', e); }
    }
    toast(`已停止 ${downloading.length} 个任务${ok < downloading.length ? ` (${ok} 成功)` : ''}`, ok === downloading.length ? 'success' : 'warn');
    await loadTasks();
  });
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
// ── Browse Directory Modal ────────────────────────────────────────
let _browsePath = '';

const openBrowseModal = () => {
  const input = $('setDownloadPath');
  if (!input) return;
  const currentPath = input.value.trim() || '/tmp/downloads';
  _browsePath = currentPath;
  showModal('browseModal');
  loadBrowseDir(currentPath);
};

const loadBrowseDir = async (dirPath) => {
  const list = $('browseList');
  const pathEl = $('browseCurrentPath');
  const selBtn = $('browseSelectBtn');
  if (!list || !pathEl) return;
  list.innerHTML = '<div class="browse-loading">加载中...</div>';
  pathEl.textContent = dirPath;
  if (selBtn) selBtn.disabled = true;
  try {
    const data = await API.get('/api/browse?path=' + encodeURIComponent(dirPath));
    if (!data) throw new Error('empty response');
    pathEl.textContent = data.currentPath;
    _browsePath = data.currentPath;
    if (selBtn) selBtn.disabled = false;
    let html = '';
    if (!data.isRoot && data.parentPath) {
      html += `<div class="browse-item browse-up" onclick="browseGoUp('${escapeHtml(data.parentPath)}')">
        <span class="browse-icon">📁</span>
        <span class="browse-name">.. / 上级目录</span>
      </div>`;
    }
    if (!data.directories || data.directories.length === 0) {
      html += '<div style="text-align:center;padding:24px;color:var(--text-dim)">此目录下没有子目录</div>';
    } else {
      for (const d of data.directories) {
        const safePath = escapeHtml(d.path);
        const safeName = escapeHtml(d.name);
        html += `<div class="browse-item" onclick="browseEnterDir('${safePath}')">
          <span class="browse-icon">📁</span>
          <span class="browse-name">${safeName}</span>
        </div>`;
      }
    }
    list.innerHTML = html;
  } catch (err) {
    const msg = (err && (err.error || err.message)) || '请求失败';
    list.innerHTML = `<div style="text-align:center;padding:24px;color:var(--color-danger, #f56c6c)">❌ ${escapeHtml(msg)}</div>`;
  }
};

const browseEnterDir = (path) => loadBrowseDir(path);
const browseGoUp = (path) => loadBrowseDir(path);

const browseSelectCurrent = () => {
  const input = $('setDownloadPath');
  if (input && _browsePath) input.value = _browsePath;
  hideModal('browseModal');
};

const escapeHtml = (str) => {
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(String(str)));
  return div.innerHTML;
};

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
  // 切回 basic tab (每次打开重置)
  switchSettingsTab('basic');
  showModal('settingsModal');
};

// ── Settings Tab 切换 (M-1) ────────────────────────────────────
const switchSettingsTab = (name) => {
  document.querySelectorAll('#settingsModal .settings-tab').forEach(t => {
    const active = t.dataset.tab === name;
    t.classList.toggle('active', active);
    t.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  document.querySelectorAll('#settingsModal .settings-panel').forEach(p => {
    const active = p.dataset.panel === name;
    p.classList.toggle('active', active);
    if (active) p.removeAttribute('hidden');
    else p.setAttribute('hidden', '');
  });
};
const initSettingsTabs = () => {
  document.querySelectorAll('#settingsModal .settings-tab').forEach(t => {
    t.addEventListener('click', () => switchSettingsTab(t.dataset.tab));
    t.addEventListener('keydown', (e) => {
      const tabs = Array.from(document.querySelectorAll('#settingsModal .settings-tab'));
      const i = tabs.indexOf(t);
      let next = -1;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % tabs.length;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + tabs.length) % tabs.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = tabs.length - 1;
      if (next >= 0) {
        e.preventDefault();
        tabs[next].focus();
        switchSettingsTab(tabs[next].dataset.tab);
      }
    });
  });
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
window.openBrowseModal = openBrowseModal;
window.browseEnterDir = browseEnterDir;
window.browseGoUp = browseGoUp;
window.browseSelectCurrent = browseSelectCurrent;
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
  if (!await showConfirm('删除 Cookie', `确认删除 Cookie "${name}"?`)) return;
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
  console.log('[fnytdlp] showImgFull called, src=', img && img.src);
  const overlay = document.getElementById('imgFullOverlay');
  const fullImg = document.getElementById('imgFull');
  console.log('[fnytdlp] overlay=', !!overlay, 'fullImg=', !!fullImg);
  if (!overlay || !fullImg) return;
  fullImg.src = img.src;
  overlay.classList.add('show');
  console.log('[fnytdlp] overlay.show=', overlay.classList.contains('show'),
    'computed display=', getComputedStyle(overlay).display);
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
const switchTab = (tab) => {
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.remove('active');
    t.setAttribute('aria-selected', 'false');
    t.setAttribute('tabindex', '-1');
  });
  tab.classList.add('active');
  tab.setAttribute('aria-selected', 'true');
  tab.setAttribute('tabindex', '0');
  currentFilter = tab.dataset.filter;
  renderTasks();
};
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => switchTab(tab));
  // 方向键 ←/→ 切换 + Home/End 跳首尾 (W3C ARIA tab pattern)
  tab.addEventListener('keydown', (e) => {
    const tabs = Array.from(document.querySelectorAll('.tab'));
    let idx = tabs.indexOf(tab);
    if (e.key === 'ArrowRight') idx = (idx + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') idx = (idx - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') idx = 0;
    else if (e.key === 'End') idx = tabs.length - 1;
    else return;
    e.preventDefault();
    switchTab(tabs[idx]);
    tabs[idx].focus();
  });
});

let _renderTimer = null;
const scheduleRender = () => {
  if (_renderTimer) return;
  _renderTimer = requestAnimationFrame(() => {
    _renderTimer = null;
    renderTasks();
    updateKpi();
    updateStatusBar();
  });
};
// ── SSE 指数退避 ──────────────────────────────────────────────
let _eventSource = null;  // for beforeunload cleanup
let _sseReconnecting = false;  // P2: 重连闭锁
let sseRetryCount = 0;
const SSE_RETRY_MAX = 60000;  // 最大 60s
const startSSE = () => {
  sseRetryCount = 0;
  if (_eventSource) _eventSource.close();
  _sseReconnecting = false;  // 重置闭锁
  _eventSource = new EventSource(GATEWAY_BASE + '/api/events');
  _eventSource.addEventListener('task-created', () => loadTasks());
  _eventSource.addEventListener('task-updated', () => loadTasks());
  _eventSource.addEventListener('task-progress', (e) => {
    let t;
    try { t = JSON.parse(e.data); } catch (err) { console.warn('SSE task-progress parse failed', e.data?.slice?.(0, 200), err); return; }
    const i = tasks.findIndex(x => x.id === t.id);
    if (i >= 0) tasks[i] = { ...tasks[i], ...t };
    else tasks.push(t);
    scheduleRender();
  });
  _eventSource.addEventListener('task-deleted', (e) => {
    let payload;
    try { payload = JSON.parse(e.data); } catch (err) { console.warn('SSE task-deleted parse failed', e.data?.slice?.(0, 200), err); return; }
    tasks = tasks.filter(x => x.id !== payload.id);
    scheduleRender();
  });
  _eventSource.onerror = (e) => {
    if (_sseReconnecting) return;  // P2: 闭锁, 防重复
    _sseReconnecting = true;
    sseRetryCount++;
    const delay = Math.min(5000 * Math.pow(2, sseRetryCount - 1), SSE_RETRY_MAX);
    console.warn(`SSE error (attempt ${sseRetryCount}), retrying in ${delay/1000}s`, e);
    _eventSource.close();
    _eventSource = null;
    _sseRetryTimer = setTimeout(startSSE, delay);  // 保存 timer 句柄供 beforeunload 清理
  };
};
// 跟踪 SSE 重连 timer 供 beforeunload 清理
let _sseRetryTimer = null;

// ── init ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  console.log('[fnytdlp] init started, DOMContentLoaded OK');
  // init sparklines
  try {
    sparkActive = new Sparkline('sparkActive', { max: 30, color: 'hsl(217, 91%, 60%)' });
    sparkSpeed = new Sparkline('sparkSpeed', { max: 30, color: 'hsl(152, 58%, 53%)' });
    sparkCompleted = new Sparkline('sparkCompleted', { max: 30, color: 'hsl(280, 60%, 65%)' });
    sparkTotal = new Sparkline('sparkTotal', { max: 30, color: 'hsl(40, 96%, 53%)' });
    // 启动滚动采样 (200ms 间隔, sparkline.js start() 才真正启动 setInterval _tick)
    sparkActive.start(0);
    sparkSpeed.start(0);
    sparkCompleted.start(0);
    sparkTotal.start(0);
  } catch (e) { console.warn('Sparkline init failed', e); }
  // M-1: Settings Tab 切换初始化
  initSettingsTabs();
  // M-3: 搜索栏实时过滤
  const _searchInput = $('searchInput');
  if (_searchInput) _searchInput.addEventListener('input', () => renderTasks());
  // M-8: 每 30s 刷新一次"已用时间"显示
  setInterval(() => {
    if (tasks.some(t => t.status === 'downloading' || t.status === 'processing')) {
      scheduleRender();
    }
  }, 30000);
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
  // poll every 5s as fallback (SSE 主, 轮询备)
  setInterval(loadTasks, 5000);
  // SSE
  startSSE();
  // health
  try {
    const h = await API.get('/api/health');
    if (h.ytDlpExists) $('headerSubtitle').textContent = `yt-dlp ${h.arch} · ffmpeg ${h.ffmpegExists ? '✓' : '✗'}`;
    if (h.version) $('headerVersion').textContent = 'v' + h.version;
  } catch (e) {}
});
// cleanup on page unload
window.addEventListener('beforeunload', () => {
  if (_eventSource) _eventSource.close();
  if (_sseRetryTimer) clearTimeout(_sseRetryTimer);
  // 4 个 Sparkline 清理 setInterval
  [sparkActive, sparkSpeed, sparkCompleted, sparkTotal].forEach(s => s?.stop?.());
});

// 导出 updateKpi 的 setKpi 给 KPI 数字加 bump 动画
const _origUpdateKpi = updateKpi;
