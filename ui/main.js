/**
 * fnytdlp 前端
 * - 复用 fnm3u8dl 的 8 项 UI 模式 (KPI / Toolbar / Task Card / Settings modal / Cookie modal)
 * - API 调用 fetch + SSE 实时进度
 */

'use strict';

console.log('[fnytdlp] main.js loaded, version=0.3.0');

// ── API client (统一网关模式) ──────────────────────────────────────
const GATEWAY_BASE = (typeof window !== 'undefined' && window.GATEWAY_BASE) || (self.location?.pathname?.startsWith('/app/') ? '/app/fnytdlp' : '');
const API = {
  _url(path) {
    // 绝对路径: 直接拼 GATEWAY_BASE + path
    // 例: '/app/fnytdlp' + '/api/tasks' = '/app/fnytdlp/api/tasks'
    return GATEWAY_BASE + (path.startsWith('/') ? path : '/' + path);
  },
  async _fetch(url, options, timeoutMs = 30000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await fetch(url, { ...options, signal: controller.signal });
      return r;
    } finally {
      clearTimeout(timer);
    }
  },
  async get(path) {
    const url = this._url(path);
    try {
      const r = await this._fetch(url, { credentials: 'same-origin' });
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
      const r = await this._fetch(url, {
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
    try {
      const r = await this._fetch(url, {
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
    } catch (e) {
      console.error('[API.put] failed', url, e);
      throw e;
    }
  },
  async del(path) {
    const url = this._url(path);
    try {
      const r = await this._fetch(url, { method: 'DELETE', credentials: 'same-origin' });
      if (!r.ok) {
        let errMsg = 'HTTP ' + r.status;
        try { const j = await r.json(); if (j && j.error) errMsg = j.error; } catch (e) {}
        throw new Error(errMsg);
      }
      return r.json();
    } catch (e) {
      console.error('[API.del] failed', url, e);
      throw e;
    }
  },
};

// ── state ───────────────────────────────────────────────────────────
let tasks = [];
let currentFilter = 'all';
// M-7: 批量选中状态
const _batchSelected = new Set();
let deleteTargetId = null;
let _currentDetailTaskId = null;

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
const toast = (msg, type = 'info', duration = 2400) => {
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
  setTimeout(() => el.classList.remove('show'), duration);
  setTimeout(() => el.remove(), duration + 600);
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
      // P2-6: 确认后立即禁用按钮, 防止多次点击
      const btnConfirm = $('confirmModal')?.querySelector('.btn-danger');
      const btnCancel = $('confirmModal')?.querySelector('.btn-ghost');
      if (btnConfirm) btnConfirm.disabled = true;
      if (btnCancel) btnCancel.disabled = true;
      hideModal('confirmModal');
      resolve(val);
    };
    // P2-6: 打开时恢复按钮状态
    const btnConfirm = $('confirmModal')?.querySelector('.btn-danger');
    const btnCancel = $('confirmModal')?.querySelector('.btn-ghost');
    if (btnConfirm) btnConfirm.disabled = false;
    if (btnCancel) btnCancel.disabled = false;
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

// ── 添加任务弹窗辅助函数 ──────────────────────────────────────
const URL_RE = /^https?:\/\/.+/i;
const onUrlInput = (el) => {
  const status = $('addUrlStatus');
  const val = el.value.trim();
  if (!val) {
    status.textContent = '';
    return;
  }
  const lines = val.split('\n').filter(Boolean);
  const allUrls = lines.every(l => URL_RE.test(l));
  if (allUrls) {
    status.textContent = '✓ ' + lines.length + ' 个 URL';
    status.style.color = '';
    status.className = 'add-url-status url-ok';
  } else {
    status.textContent = '⚠ 部分行不是有效 URL';
    status.style.color = '';
    status.className = 'add-url-status url-warn';
  }
};
window.onUrlInput = onUrlInput;

const selectFormatPill = (btn) => {
  document.querySelectorAll('.format-pill').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  const custom = $('addFormatCustom');
  if (custom) custom.value = btn.dataset.value;
};
window.selectFormatPill = selectFormatPill;

// 版权年份
document.addEventListener('DOMContentLoaded', () => {
  const cy = document.getElementById('copyright-year');
  if (cy) cy.textContent = new Date().getFullYear();
});

// ── 键盘快捷键 ──────────────────────────────────────────
const SHORTCUTS = {
  'n': { label: '新建任务', action: () => showAddTaskModal() },
  's': { label: '搜索', action: () => { const i = $('searchInput'); if(i) { i.focus(); i.select(); } } },
  'r': { label: '刷新', action: () => loadTasks() },
  '?': { label: '快捷键帮助', action: () => showShortcutsHelp() },
  'Escape': { label: '关闭弹窗', action: () => {
      // 关闭最顶层的 modal
      const openModals = document.querySelectorAll('.modal-overlay.active');
      if (openModals.length > 0) {
        const last = openModals[openModals.length - 1];
        if (last.id) hideModal(last.id);
        return;
      }
      // 搜索框失焦
      const si = $('searchInput');
      if (si && document.activeElement === si) si.blur();
  }},
};
document.addEventListener('keydown', (e) => {
  // 不在 input/textarea/select 中触发单字符快捷键
  const tag = (e.target || {}).tagName || '';
  const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable;
  // Escape 永远有效
  if (e.key === 'Escape') { SHORTCUTS['Escape'].action(); return; }
  // 数字键 1-4 切换 tab (非输入状态)
  if (!isInput && e.key >= '1' && e.key <= '4') {
    e.preventDefault();
    const filters = ['all', 'downloading', 'completed', 'error'];
    const idx = parseInt(e.key) - 1;
    if (idx < filters.length) {
      const tabs = document.querySelectorAll('.tab');
      if (tabs[idx]) switchTab(tabs[idx]);
    }
    return;
  }
  // 单字符快捷键 (非输入状态)
  if (!isInput && SHORTCUTS[e.key]) {
    e.preventDefault();
    SHORTCUTS[e.key].action();
  }
});

const showShortcutsHelp = () => {
  toast('⌨ N 新建 · S 搜索 · R 刷新 · 1-4 筛选 · Esc 关闭', 'info', 4000);
};
window.showShortcutsHelp = showShortcutsHelp;


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
    // 后端故障 / 离线时给用户明确反馈
    const offline = !navigator.onLine;
    toast(offline ? '网络断开, 请检查连接' : `加载任务失败: ${e.message}`, 'error');
    // 在任务列表显示重试按钮
    const list = $('taskList');
    const empty = $('emptyState');
    if (list && empty) {
      empty.style.display = 'block';
      empty.querySelector('.empty-title').textContent = '⚠ 加载失败';
      empty.querySelector('.empty-text').textContent = offline ? '网络连接已断开' : e.message;
      empty.querySelector('.empty-actions').style.display = 'flex';
      empty.querySelector('.empty-actions').innerHTML = `<button class="btn btn-primary" onclick="loadTasks()">🔄 重试</button>`;
    }
  }
};

const renderTasks = () => {
  const list = $('taskList');
  // M-3: 搜索 + 状态筛选
  const query = ($('searchInput')?.value || '').trim().toLowerCase();
  const byFilter = currentFilter === 'all' ? tasks : tasks.filter(t => t.status === currentFilter);
  const filtered = !query ? byFilter : byFilter.filter(t => {
    const url = (t.url || '').toLowerCase();
    const fname = (t.filename || '').toLowerCase();
    const ttitle = (t.title || '').toLowerCase();
    return url.includes(query) || fname.includes(query) || ttitle.includes(query);
  });
  if (filtered.length === 0) {
    list.innerHTML = '';
    // 区分「没有任务」和「搜索无结果」
    if (tasks.length === 0) {
      $('emptyState').style.display = 'block';
      $('emptyState').querySelector('.empty-title').textContent = '还没有下载任务';
      $('emptyState').querySelector('.empty-text').textContent = '粘贴视频链接开始下载，支持 YouTube · B站 · 抖音 · 微博 · X 等 1000+ 站点';
      $('emptyState').querySelector('.empty-actions').style.display = 'flex';
    } else {
      $('emptyState').style.display = 'block';
      $('emptyState').querySelector('.empty-title').textContent = query ? `没有匹配 "${query}" 的任务` : '没有此状态的任务';
      $('emptyState').querySelector('.empty-text').textContent = query ? '试试其他关键词或清除搜索' : '切换其他筛选标签看看';
      $('emptyState').querySelector('.empty-actions').style.display = 'none';
    }
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
    downloading: '<span class="badge badge-downloading">⏬ 下载中</span>',
    processing: '<span class="badge badge-downloading">🔄 处理中</span>',
    completed: '<span class="badge badge-completed">✅ 已完成</span>',
    error: '<span class="badge badge-error">❌ 出错</span>',
    paused: '<span class="badge badge-paused">⏸ 暂停</span>',
    stopped: '<span class="badge badge-stopped">⏹ 已停止</span>',
  }[t.status] || `<span class="badge">${esc(t.status)}</span>`;

  // 多流下载进度: 视频 50% + 音频 50%, 合并 99% → 完成 100%
  // task.progress 已经是 server 聚合后的值, 直接显示
  const progressPct = (t.progress || 0).toFixed(1);
  const downloaded = formatBytes(t.downloadedBytes);
  const total = t.totalBytes ? formatBytes(t.totalBytes) : '?';
  const speed = formatSpeed(t.speed);
  const eta = t.eta ? formatDuration(t.eta) : '-';

  // 子进度: _streamPhases.video/audio 百分比, 给用户看"现在在下载哪个流"
  const sp = t._streamPhases || {};
  const vPct = sp.video ? (sp.video.done ? 100 : (sp.video.pct || 0)) : null;
  const aPct = sp.audio ? (sp.audio.done ? 100 : (sp.audio.pct || 0)) : null;
  const isMultiStream = vPct !== null && aPct !== null && (sp.video?.total > 0) && (sp.audio?.total > 0);
  const phaseLabel = t._phase === 'merging' ? '🔄 合并中...'
    : t._phase === 'done' ? '✅ 完成'
    : (isMultiStream
      ? (vPct < 100 ? `🎬 视频 ${vPct.toFixed(0)}%` : (aPct < 100 ? `🎵 音频 ${aPct.toFixed(0)}%` : '⏳ 准备合并'))
      : null);
  // 子进度条 HTML
  const subProgressHtml = isMultiStream ? `
    <div class="task-sub-progress">
      <div class="sub-row"><span class="sub-label">🎬 视频</span><div class="sub-track"><div class="sub-fill tone-primary" style="width:${vPct}%"></div></div><span class="sub-pct">${vPct.toFixed(0)}%</span></div>
      <div class="sub-row"><span class="sub-label">🎵 音频</span><div class="sub-track"><div class="sub-fill tone-success" style="width:${aPct}%"></div></div><span class="sub-pct">${aPct.toFixed(0)}%</span></div>
    </div>` : '';

  const title = t.filename || t.url;
  const showActions = t.status === 'error' || t.status === 'stopped' || t.status === 'paused';
  const canStop = t.status === 'downloading' || t.status === 'pending' || t.status === 'processing';
  const canPlay = t.status === 'completed' && t.filename;
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
        <div class="task-info-block">
          <div class="task-title-row">
            <div class="task-title">${esc(t.title || title)}</div>
            ${statusBadge}
            ${cookieBadge}
          </div>
          <div class="task-url-sub" title="${esc(t.url)}">${esc(t.url)}</div>
        </div>
        <div class="task-actions" onclick="event.stopPropagation()">
          ${showActions ? `<button class="btn-icon-sm" title="重试" onclick="retryTask('${esc(t.id)}')">🔄</button>` : ''}
          ${canStop ? `<button class="btn-icon-sm" title="停止" onclick="stopTask('${esc(t.id)}')">⏹</button>` : ''}
          ${canPlay ? `<button class="btn-icon-sm" title="播放" onclick="openPlayer('${esc(t.id)}')">▶</button>` : ''}
          <button class="btn-icon-sm" title="删除" onclick="deleteTask('${esc(t.id)}')">🗑</button>
        </div>
      </div>
      ${isActive ? `
        <div class="task-progress">
          <div class="progress-track"><div class="progress-fill ${t.status === 'processing' ? 'tone-warning' : 'tone-success'}" style="width:${progressPct}%"></div></div>
          <div class="task-percent">${progressPct}%</div>
        </div>
        ${subProgressHtml}
        <div class="task-meta">
          ${phaseLabel ? `<span class="task-phase">${phaseLabel}</span>` : ''}
          <span class="task-speed">⚡ ${speed}</span>
          <span class="task-sep">·</span>
          <span class="task-eta">⏱ ${eta}</span>
          <span class="task-sep">·</span>
          <span>${downloaded} / ${total}</span>
          ${elapsed ? `<span class="task-sep">·</span> ${elapsed}` : ''}
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

// ── Cookie 自动匹配 ─────────────────────────────────────────
const autoDetectCookie = (url, cookies) => {
  if (!url || !cookies || cookies.length === 0) return '';
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    let best = '', bestLen = 0;
    for (const c of cookies) {
      const domain = (c.domain || '').toLowerCase().replace(/^\./, '');
      if (!domain) continue;
      // hostname === domain 完全匹配, 或 hostname 以 .domain 结尾 (子域名)
      if (hostname === domain || hostname.endsWith('.' + domain)) {
        if (domain.length > bestLen) { best = c.name; bestLen = domain.length; }
      }
    }
    return best;
  } catch { return ''; }
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
    // 自动匹配: 如果已有 URL, 根据域名选择对应 Cookie
    const raw = $('addUrls').value.trim();
    if (raw) {
      const urlRegex = /https?:\/\/[^\s<>"']+/g;
      const urls = raw.match(urlRegex);
      if (urls && urls.length > 0) {
        const matched = autoDetectCookie(urls[0], cookies);
        if (matched) sel.value = matched;
      }
    }
  } catch (e) {
    sel.innerHTML = '<option value="">无 (不使用 Cookie)</option>';
  }
};
window.loadCookieSelect = loadCookieSelect;

const showAddTaskModal = () => {
  console.log('[fnytdlp] showAddTaskModal() called');
  $('addUrls').value = '';
  $('addFormatCustom').value = '';
  // 清除格式 pill 选中状态
  document.querySelectorAll('.format-pill').forEach(p => p.classList.remove('active'));
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
  const raw = $('addUrls').value.trim();
  const urlRegex = /https?:\/\/[^\s<>"']+/g;
  const urls = raw.match(urlRegex);
  if (!urls || urls.length === 0) { toast('未找到有效 URL', 'warn'); return; }
  const url = urls[0];
  // 自动匹配 Cookie (如果尚未手动选择)
  const sel = $('addCookieName');
  if (sel && sel.value === '') {
    API.get('/api/cookies').then(r => {
      const matched = autoDetectCookie(url, (r && r.cookies) || []);
      if (matched) sel.value = matched;
    }).catch(() => {});
  }
  $('addPreview').textContent = '⏳ 解析中...';
  const cookieName = $('addCookieName')?.value?.trim() || '';
  try {
    const info = await API.post('/api/info', { url, cookieName });
    _lastParsedInfo = info; // 缓存解析结果, 提交时复用
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
    // 自动检测播放列表
    setTimeout(parsePlaylist, 100);
  } catch (e) {
    $('addPreview').textContent = '❌ 解析失败: ' + e.message;
  }
};
window.parseUrls = parseUrls;
let _lastParsedInfo = null; // 缓存解析结果, 提交任务时传后端省去第二次 infoUrl

const submitAddTask = async () => {
  const raw = $('addUrls').value.trim();
  const urlRegex = /https?:\/\/[^\s<>"']+/g;
  const urls = raw.match(urlRegex) || [];
  if (urls.length === 0) { toast('未找到有效 URL (http/https)', 'warn'); return; }
  // 防双击: 禁用提交按钮
  const submitBtn = document.querySelector('#addTaskModal .btn-primary');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.classList.add('btn-loading');
    submitBtn.textContent = '⏳ 提交中...';
  }
  // 去重
  const unique = [...new Set(urls)];
  const options = {};
  const fmtCustom = $('addFormatCustom').value.trim();
  if (fmtCustom) options.format = fmtCustom;
  const ot = $('addOutputTemplate').value.trim();
  if (ot) options.outputTemplate = ot;
  const sb = $('addSponsorBlock').value.trim();
  if (sb) options.sponsorblockMark = sb.split(',').map(s => s.trim()).filter(Boolean);
  options.embedMetadata = $('addEmbedMetadata').checked;
  options.writeSubs = $('addWriteSubs').checked;
  options.writeThumbnail = $('addWriteThumbnail').checked;
  options.noPlaylist = $('addNoPlaylist').checked;
  const cookieName = $('addCookieName').value.trim();
  if (cookieName) {
    options.cookieName = cookieName;
  } else if (urls.length > 0) {
    // 自动匹配: 用户未手动选 Cookie, 从 URL 自动检测
    try {
      const r = await API.get('/api/cookies');
      const cookies = (r && r.cookies) || [];
      const detected = autoDetectCookie(urls[0], cookies);
      if (detected) options.cookieName = detected;
    } catch (e) { /* 静默 */ }
  }

  // 检测播放列表勾选: 如果检测到播放列表且用户勾选了部分集数
  const checkedPlaylist = [];
  if (_playlistEntries.length > 0) {
    const checkboxes = document.querySelectorAll('.playlist-checkbox:checked');
    checkboxes.forEach(cb => {
      const idx = parseInt(cb.dataset.index);
      if (idx > 0) checkedPlaylist.push(idx);
    });
    // 如果有勾选但数量小于总数, 传 playlistItems
    if (checkedPlaylist.length > 0 && checkedPlaylist.length < _playlistEntries.length) {
      options.playlistItems = checkedPlaylist.join(',');
    }
    // 清空缓存
    _playlistEntries = [];
    hidePlaylist();
  }

  let ok = 0, fail = 0, skipped = 0;
  // 如果超过 1 个 URL, 使用批量端点
  if (unique.length > 1) {
    try {
      const r = await API.post('/api/tasks/batch', { urls: unique, options });
      if (r.ok) ok = r.ok.length;
      if (r.fail) fail = r.fail.length;
      if (r.skipped) skipped = r.skipped.length;
    } catch (e) {
      fail = unique.length;
    }
  } else {
    for (const url of unique) {
      // 前端去重: 已有 downloading/pending 任务时跳过
      if (tasks.some(t => t.url === url && (t.status === 'pending' || t.status === 'downloading'))) {
        skipped++;
        continue;
      }
      try {
        const body = { url, options };
        // 传入已缓存的解析结果, 后端跳过第二次 infoUrl
        if (_lastParsedInfo?.title) body.parsedInfo = _lastParsedInfo;
        const r = await API.post('/api/tasks', body);
        if (r.task) ok++;
        else fail++;
      } catch (e) { fail++; }
    }
  }
  hideModal('addTaskModal');
  const msg = `已添加 ${ok} 个任务` + (skipped ? `（${skipped} 跳过）` : '') + (fail ? `，${fail} 失败` : '');
  toast(msg, (skipped || fail) ? 'warn' : 'success');
  await loadTasks();
  // 恢复按钮状态
  if (submitBtn) {
    submitBtn.disabled = false;
    submitBtn.classList.remove('btn-loading');
    submitBtn.textContent = '📥 开始下载';
  }
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
      ${t.downloadFolder ? `<div>文件夹: ${esc(t.downloadFolder)}</div>` : ''}
    `;
  }
  showModal('deleteModal');
};
window.deleteTask = deleteTask;

const confirmDelete = async (withFile) => {
  if (!deleteTargetId) return;
  const id = deleteTargetId;
  await API.del(`/api/tasks/${id}${withFile ? '?deleteFile=1' : ''}`);
  deleteTargetId = null;
  hideModal('deleteModal');
  toast(withFile ? '已删除任务和文件夹' : '已删除任务记录', 'success');
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
const batchStart = async () => {
  if (_batchSelected.size === 0) return;
  const ids = [..._batchSelected];
  for (const id of ids) {
    try { await API.post(`/api/tasks/${id}/retry`); } catch (e) { console.warn('batch start failed', id, e); }
  }
  toast(`已启动 ${ids.length} 个任务`, 'success');
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
window.batchStart = batchStart;
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
  const completed = tasks.filter(t => t.status === 'completed' || t.status === 'error');
  if (completed.length === 0) { toast('没有已完成或出错的任务', 'info'); return; }
  if (!await showConfirm('确认清理', `确认清理 ${completed.length} 个已完成/出错的任务? (仅记录, 不删文件)`)) return;
  return withButtonLoading(document.querySelector('button[onclick*="clearCompleted"]'), async () => {
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

// ── 限速滑块同步 ──────────────────────────────────────────
const LIMIT_RATE_PRESETS = [
  { label: '不限速', value: '' },
  { label: '500K', value: '500K' },
  { label: '1M', value: '1M' },
  { label: '2M', value: '2M' },
  { label: '5M', value: '5M' },
  { label: '10M', value: '10M' },
  { label: '20M', value: '20M' },
  { label: '50M', value: '50M' },
  { label: '自定义', value: '__custom__' },
];
const syncLimitRateSlider = (sliderVal) => {
  const idx = parseInt(sliderVal);
  const preset = LIMIT_RATE_PRESETS[idx] || LIMIT_RATE_PRESETS[0];
  const input = $('setLimitRate');
  const hint = $('setLimitRateHint');
  if (!input || !hint) return;
  if (preset.value === '__custom__') {
    // 自定义模式: 不覆盖输入框
    hint.textContent = '手动输入自定义值';
  } else {
    input.value = preset.value;
    hint.textContent = preset.label;
  }
};
window.syncLimitRateSlider = syncLimitRateSlider;

// 将 currentMode 值映射到滑块位置 (在 showSettingsModal 中使用)
const _limitRateToSliderIdx = (val) => {
  if (!val) return 0;
  const idx = LIMIT_RATE_PRESETS.findIndex(p => p.value === val);
  return idx >= 0 ? idx : LIMIT_RATE_PRESETS.length - 1;
};

// ── 格式预览 + 播放列表 (P0 enhance) ──────────────────────────
let _lastFormats = []; // 缓存格式列表

const fetchFormats = async () => {
  const raw = $('addUrls').value.trim();
  const urlRegex = /https?:\/\/[^\s<>"']+/g;
  const urls = raw.match(urlRegex);
  if (!urls || urls.length === 0) { toast('请先输入 URL', 'warn'); return; }
  const url = urls[0];
  const cookieName = $('addCookieName')?.value?.trim() || '';
  const container = $('formatListContainer');
  const list = $('formatList');
  if (!list || !container) return;
  container.style.display = 'block';
  list.innerHTML = '<div class="info-preview" style="padding:12px;text-align:center">⏳ 加载格式列表...</div>';
  try {
    const r = await API.post('/api/formats', { url, cookieName });
    if (!r || !r.formats || r.formats.length === 0) {
      list.innerHTML = '<div class="info-preview" style="padding:12px;text-align:center">未找到可用格式</div>';
      return;
    }
    _lastFormats = r.formats;
    // 按视频/音频/合并分组
    const videos = r.formats.filter(f => f.type === 'video');
    const audios = r.formats.filter(f => f.type === 'audio');
    const combined = r.formats.filter(f => f.type === 'combined' || (!f.type && f.vcodec && f.acodec));
    
    let html = '';
    const renderGroup = (title, items, icon) => {
      if (items.length === 0) return '';
      let g = `<div class="format-group"><div class="format-group-title">${icon} ${title} (${items.length})</div>`;
      for (const f of items) {
        const label = `${f.formatId} · ${f.resolution || f.formatNote || '-'} · .${f.ext}${f.filesize ? ' · ' + f.filesize : ''}${f.tbr ? ' · ' + f.tbr : ''}${f.fps ? ' · ' + f.fps + 'fps' : ''}`;
        g += `<div class="format-item selectable" onclick="selectFormat('${f.formatId}')" title="点击使用此格式">
          <span class="format-id">${f.formatId}</span>
          <span class="format-res">${f.resolution || '-'}</span>
          <span class="format-ext">.${f.ext}</span>
          <span class="format-size">${f.filesize || (f.tbr || '')}</span>
          <span class="format-codec">${f.vcodec || f.acodec || '-'}</span>
        </div>`;
      }
      return g + '</div>';
    };
    html += renderGroup('视频流', videos, '🎬');
    html += renderGroup('音频流', audios, '🎵');
    html += renderGroup('合并流', combined, '📦');
    if (!html) html = '<div class="info-preview" style="padding:12px;text-align:center">无可用格式数据</div>';
    list.innerHTML = html;
    toast(`已加载 ${r.formats.length} 个格式`, 'info');
  } catch (e) {
    list.innerHTML = `<div class="info-preview" style="padding:12px;text-align:center;color:var(--color-danger)">❌ ${esc(e.message)}</div>`;
  }
};
window.fetchFormats = fetchFormats;

const hideFormatList = () => {
  const c = $('formatListContainer');
  if (c) c.style.display = 'none';
};
window.hideFormatList = hideFormatList;

const selectFormat = (formatId) => {
  $('addFormatCustom').value = formatId;
  toast(`已选格式: ${formatId}`, 'success');
};
window.selectFormat = selectFormat;

// ── 播放列表解析 ──────────────────────────────────────────────
let _playlistEntries = [];

const parsePlaylist = async () => {
  const raw = $('addUrls').value.trim();
  const urlRegex = /https?:\/\/[^\s<>"']+/g;
  const urls = raw.match(urlRegex);
  if (!urls || urls.length === 0) return;
  const url = urls[0];
  const cookieName = $('addCookieName')?.value?.trim() || '';
  const container = $('playlistContainer');
  const items = $('playlistItems');
  if (!container || !items) return;
  try {
    const r = await API.post('/api/playlist', { url, cookieName });
    if (!r || !r.entries || r.entries.length <= 1) {
      container.style.display = 'none';
      _playlistEntries = [];
      return;
    }
    _playlistEntries = r.entries;
    container.style.display = 'block';
    let html = '';
    for (const e of r.entries) {
      const checked = 'checked';
      const duration = e.duration ? formatDuration(e.duration) : '';
      html += `<label class="playlist-item" onclick="event.stopPropagation()">
        <input type="checkbox" class="playlist-checkbox" data-index="${e.index}" ${checked}>
        <span class="playlist-index">#${e.index}</span>
        <span class="playlist-title">${esc(e.title || e.id)}</span>
        ${duration ? `<span class="playlist-duration">${duration}</span>` : ''}
      </label>`;
    }
    items.innerHTML = html;
    toast(`检测到播放列表 (${r.entries.length} 集)`, 'info');
  } catch (e) {
    container.style.display = 'none';
    _playlistEntries = [];
  }
};
window.parsePlaylist = parsePlaylist;

const hidePlaylist = () => {
  const c = $('playlistContainer');
  if (c) c.style.display = 'none';
};
window.hidePlaylist = hidePlaylist;

const selectAllPlaylist = (checked) => {
  document.querySelectorAll('.playlist-checkbox').forEach(cb => cb.checked = checked);
};
window.selectAllPlaylist = selectAllPlaylist;

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
    list.innerHTML = `<div style="text-align:center;padding:24px;color:var(--color-danger)">❌ ${escapeHtml(msg)}</div>`;
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
  // 同步限速滑块
  const slider = $('setLimitRateSlider');
  if (slider) {
    slider.value = _limitRateToSliderIdx(cfg.limitRate || '');
    syncLimitRateSlider(slider.value);
  }
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
  // v0.4.0: 配额 + 文件名模板 (storage panel)
  if ($('setQuotaSize')) {
    // 把字节回填成人类可读 (50G / 500M)
    const qb = parseInt(cfg.quotaBytes || 0);
    $('setQuotaSize').value = qb > 0 ? formatBytes(qb) : '';
  }
  if ($('setQuotaAutoClean')) $('setQuotaAutoClean').checked = !!cfg.quotaAutoClean;
  if ($('setOutputTemplate')) $('setOutputTemplate').value = cfg.outputTemplate || '';
  updateOutputTemplatePreview();
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
      // v0.4.0 配额 + 文件名模板
      quotaBytes: parseInt(_humanQuota($('setQuotaSize')?.value || '')) || 0,
      quotaAutoClean: $('setQuotaAutoClean')?.checked || false,
      outputTemplate: $('setOutputTemplate')?.value.trim() || '%(title)s [%(id)s].%(ext)s',
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
window.showSettingsModal = showSettingsModal;

// ── v0.4.0 磁盘配额 (检查 + 清理) ─────────────────────────
const checkQuotaNow = async () => {
  const hint = $('quotaUsageHint');
  if (hint) hint.textContent = '扫描中…';
  try {
    const u = await API.get('/api/quota');
    const used = formatBytes(u.bytes || 0);
    const quota = u.quotaBytes > 0 ? formatBytes(u.quotaBytes) : '不限';
    const pct = u.percent;
    const bar = pct > 0 ? ' [' + pct + '%]' : '';
    if (hint) {
      hint.textContent = `已用 ${used} / ${quota}${bar} · ${u.files} 文件 · ${esc(u.path)}`;
      hint.style.color = pct >= 90 ? 'var(--color-danger)' : (pct >= 70 ? 'var(--color-warning)' : '');
    }
  } catch (e) {
    if (hint) { hint.textContent = '检查失败: ' + e.message; hint.style.color = 'var(--color-danger)'; }
  }
};
window.checkQuotaNow = checkQuotaNow;

const cleanQuotaNow = async () => {
  const hint = $('quotaUsageHint');
  if (hint) hint.textContent = '清理中…';
  try {
    const r = await API.post('/api/quota/clean', {});
    if (r.enforced) {
      toast(`已清理 ${r.deletedCount} 个旧任务, 释放 ${formatBytes(r.freedBytes)}`, 'success');
    } else {
      toast('未超配额, 无需清理', 'info');
    }
    await checkQuotaNow();
  } catch (e) {
    toast('清理失败: ' + e.message, 'error');
  }
};
window.cleanQuotaNow = cleanQuotaNow;

// 把人类可读尺寸 "50G" 转字节回填 hidden field
const _humanQuota = (v) => {
  if (!v) return '';
  const s = String(v).trim();
  const m = s.match(/^(\d+(?:\.\d+)?)([KMGT]?)$/i);
  if (!m) return s;
  const n = parseFloat(m[1]);
  const unit = (m[2] || '').toUpperCase();
  const mult = unit === 'T' ? 1024**4 : unit === 'G' ? 1024**3 : unit === 'M' ? 1024**2 : unit === 'K' ? 1024 : 1;
  return String(Math.floor(n * mult));
};

// ── v0.4.0 文件名模板实时预览 ─────────────────────────
const _previewOutputTemplate = (tpl) => {
  // 找一个已完成任务的真实样本做替换
  const sample = (typeof tasks !== 'undefined' ? tasks : []).find(t => t.status === 'completed' && (t.title || t.filename));
  const title = sample?.title || '示例视频标题';
  const id = sample?.id || 'dQw4w9WgXcQ';
  const ext = sample?.ext || 'mp4';
  const uploader = sample?.uploader || '示例UP主';
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  let r = tpl || '%(title)s [%(id)s].%(ext)s';
  r = r.replace(/%\(title\)s/gi, title)
       .replace(/%\(id\)s/gi, id)
       .replace(/%\(ext\)s/gi, ext)
       .replace(/%\(uploader\)s/gi, uploader)
       .replace(/%\(upload_date\)s/gi, date);
  return r;
};
const updateOutputTemplatePreview = () => {
  const el = $('outputTemplatePreviewText');
  if (!el) return;
  el.textContent = _previewOutputTemplate($('setOutputTemplate')?.value || '');
};
window.updateOutputTemplatePreview = updateOutputTemplatePreview;

// ── v0.4.0 统计 (KPI 累计 + 双图) ─────────────────────────
const computeStats = () => {
  const all = (typeof tasks !== 'undefined' ? tasks : []);
  const completed = all.filter(t => t.status === 'completed');
  const totalBytes = completed.reduce((s, t) => s + (t.totalBytes || 0), 0);
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0,0,0,0);
  const ms = monthStart.getTime();
  const monthBytes = completed.filter(t => (t.completedAt || t.updatedAt || 0) >= ms)
                              .reduce((s, t) => s + (t.totalBytes || 0), 0);
  // 总耗时: completed 任务的 completedAt - createdAt 之和
  let totalDurMs = 0;
  for (const t of completed) {
    const a = t.createdAt || 0, b = t.completedAt || t.updatedAt || 0;
    if (a && b && b > a) totalDurMs += (b - a);
  }
  return {
    totalBytes, monthBytes, completedCount: completed.length, totalDurMs,
    tasks: all,
  };
};

const _drawDailyChart = (canvas, daily) => {
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  // 找最大值
  const max = Math.max(1, ...daily.map(d => d.bytes));
  const pad = 24, barW = (w - pad*2) / daily.length;
  const colors = getComputedStyle(document.body).getPropertyValue('--kpi-accent-h') || '220';
  daily.forEach((d, i) => {
    const bh = (h - pad*2) * d.bytes / max;
    const x = pad + i*barW + 2;
    const y = h - pad - bh;
    ctx.fillStyle = `hsl(${colors}, 80%, 60%)`;
    ctx.fillRect(x, y, barW - 4, bh);
    // 日期标签 (每 5 天)
    if (i % 5 === 0) {
      ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--text-dim') || '#888';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(d.label, x + (barW-4)/2, h - 4);
    }
  });
};

const _drawDomainChart = (canvas, byDomain) => {
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const entries = Object.entries(byDomain).sort((a,b) => b[1] - a[1]).slice(0, 8);
  if (entries.length === 0) {
    ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--text-dim') || '#888';
    ctx.font = '12px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('暂无数据', w/2, h/2);
    return;
  }
  const total = entries.reduce((s, [,v]) => s+v, 0);
  let cy = 16;
  entries.forEach(([dom, bytes], i) => {
    const pct = (bytes / total * 100).toFixed(1);
    ctx.fillStyle = `hsl(${(i*47)%360}, 70%, 60%)`;
    ctx.fillRect(8, cy+2, 10, 10);
    ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--text') || '#fff';
    ctx.font = '11px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(`${dom}  ${pct}%`, 24, cy+11);
    cy += 18;
  });
};

const renderStatsPanel = () => {
  const s = computeStats();
  $('statsTotalBytes').textContent = formatBytes(s.totalBytes);
  $('statsCompletedCount').textContent = s.completedCount.toString();
  $('statsMonthBytes').textContent = formatBytes(s.monthBytes);
  $('statsTotalDuration').textContent = formatDuration(Math.floor(s.totalDurMs / 1000));
  // 每日 (近 30 天)
  const now = new Date();
  const daily = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now); d.setDate(now.getDate() - i);
    const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const dayEnd = dayStart + 86400000;
    const bytes = s.tasks.filter(t => {
      if (t.status !== 'completed') return false;
      const ts = t.completedAt || t.updatedAt || 0;
      return ts >= dayStart && ts < dayEnd;
    }).reduce((sum, t) => sum + (t.totalBytes || 0), 0);
    daily.push({ label: String(d.getDate()), bytes });
  }
  _drawDailyChart($('chartDaily'), daily);
  // 按域名 (从 URL 取 hostname)
  const byDomain = {};
  for (const t of s.tasks) {
    if (t.status !== 'completed') continue;
    try { const h = new URL(t.url || '').hostname || 'unknown'; byDomain[h] = (byDomain[h] || 0) + (t.totalBytes || 0); }
    catch (e) { byDomain['unknown'] = (byDomain['unknown'] || 0) + (t.totalBytes || 0); }
  }
  _drawDomainChart($('chartDomain'), byDomain);
};
window.renderStatsPanel = renderStatsPanel;

// 监听 storage tab 切换触发 (initSettingsTabs 在 DOMContentLoaded 调用,
// 这里直接 attach click listener 即可)
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('#settingsModal .settings-tab').forEach(t => {
    if (t.dataset._statsHooked) return;
    t.dataset._statsHooked = '1';
    t.addEventListener('click', () => {
      if (t.dataset.tab === 'storage') {
        // 切到 storage 时显示已配的 quota 字节回填到输入框 (只读显示)
        const cfg = window._config || {};
        const input = $('setQuotaSize');
        if (input && cfg.quotaBytes && !input.value) {
          input.value = cfg.quotaBytes;
        }
      }
    });
  });
});

// 独立 stats modal 入口 (v0.4.1: 跟设置同一级别)
const showStatsModal = () => {
  showModal('statsModal');
  // 打开后立即渲染一次
  renderStatsPanel();
};
window.showStatsModal = showStatsModal;

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

// ── 订阅管理 ──────────────────────────────────────────────────
let _subscriptions = [];

const showSubscriptionModal = async () => {
  showModal('subModal');
  $('subName').value = '';
  $('subUrl').value = '';
  $('subFormat').value = '';
  $('subCheckResult').textContent = '';
  // 加载 Cookie 列表到选择框
  const cookieSel = $('subCookieName');
  if (cookieSel) {
    try {
      const r = await API.get('/api/cookies');
      const cookies = (r && r.cookies) || [];
      cookieSel.innerHTML = '<option value="">无</option>' +
        cookies.map(c => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('');
    } catch (e) {
      cookieSel.innerHTML = '<option value="">无</option>';
    }
  }
  await loadSubscriptions();
};
window.showSubscriptionModal = showSubscriptionModal;

const loadSubscriptions = async () => {
  const list = $('subList');
  if (!list) return;
  try {
    const r = await API.get('/api/subscriptions');
    _subscriptions = (r && r.subscriptions) || [];
    if (_subscriptions.length === 0) {
      list.innerHTML = '<div class="sub-empty">📭 暂无订阅, 在下方表单添加第一个订阅</div>';
      return;
    }
    list.innerHTML = `<table class="sub-table">
      <thead>
        <tr>
          <th style="width:32px"></th>
          <th>名称</th>
          <th>URL</th>
          <th>Cookie</th>
          <th>间隔</th>
          <th>格式</th>
          <th>最新ID</th>
          <th style="width:110px">操作</th>
        </tr>
      </thead>
      <tbody>${_subscriptions.map(s => renderSubRow(s)).join('')}</tbody>
    </table>`;
  } catch (e) {
    list.innerHTML = '<div class="sub-empty" style="color:var(--color-danger)">加载失败: ' + esc(e.message) + '</div>';
  }
};

const renderSubRow = (s) => {
  const intervalMin = Math.round((s.interval || 3600) / 60);
  const fullUrl = s.url || '';
  const urlDisplay = fullUrl.length > 50 ? fullUrl.substring(0, 48) + '…' : fullUrl;
  const cookieDisplay = s.cookieName ? esc(s.cookieName) : '<span style="color:var(--text-dim)">—</span>';
  const formatDisplay = s.format ? esc(s.format) : '<span style="color:var(--text-dim)">默认</span>';
  const lastIdDisplay = s.lastId ? esc(String(s.lastId).substring(0, 20)) : '<span style="color:var(--text-dim)">—</span>';
  return `<tr class="sub-row${s.enabled ? '' : ' sub-disabled'}" data-name="${esc(s.name)}">
    <td>
      <button class="sub-toggle ${s.enabled ? 'on' : 'off'}" title="${s.enabled ? '已启用, 点击暂停' : '已暂停, 点击启用'}" onclick="toggleSubscription('${esc(s.name)}')" aria-label="切换启用状态">
        <span class="sub-toggle-dot"></span>
      </button>
    </td>
    <td><strong>${esc(s.name)}</strong></td>
    <td class="sub-url" title="${esc(fullUrl)}">${esc(urlDisplay)}</td>
    <td>${cookieDisplay}</td>
    <td class="sub-interval">${intervalMin} 分钟</td>
    <td class="sub-format" title="${s.format ? esc(s.format) : ''}">${formatDisplay}</td>
    <td class="sub-lastid" title="${s.lastId ? esc(String(s.lastId)) : ''}">${lastIdDisplay}</td>
    <td class="sub-row-actions">
      <button class="btn-icon-sm sub-action-btn" title="立即检查此订阅" onclick="checkOneSubscription('${esc(s.name)}')" aria-label="检查">🔍</button>
      <button class="btn-icon-sm sub-action-btn sub-action-del" title="删除订阅" onclick="deleteSubscription('${esc(s.name)}')" aria-label="删除">🗑</button>
    </td>
  </tr>`;
};

// 立即检查单个订阅（轮询时也能用）
const checkOneSubscription = async (name) => {
  const result = $('subCheckResult');
  if (result) result.textContent = `⏳ 检查 "${name}"...`;
  try {
    const r = await API.post('/api/subscriptions/check', { name });
    const count = (r && r.results && r.results.length) || 0;
    if (result) result.textContent = `✅ "${name}" 检查完成, 新增 ${count} 条任务`;
    toast(`"${name}" 检查完成, ${count} 个新任务`, count > 0 ? 'success' : 'info');
    if (count > 0) await loadTasks();
  } catch (e) {
    if (result) result.textContent = '❌ ' + e.message;
    toast('检查失败: ' + e.message, 'error');
  }
};
window.checkOneSubscription = checkOneSubscription;

const saveSubscription = async () => {
  const name = $('subName').value.trim();
  const url = $('subUrl').value.trim();
  if (!name || !url) { toast('名称和 URL 不能为空', 'warn'); return; }
  const cookieName = $('subCookieName')?.value || '';
  const interval = parseInt($('subInterval')?.value) || 3600;
  const format = $('subFormat').value.trim();
  try {
    const r = await API.post('/api/subscriptions', { name, url, cookieName, interval, format });
    if (r && r.ok) {
      toast(`订阅 \"${name}\" 已保存`, 'success');
      $('subName').value = '';
      $('subUrl').value = '';
      $('subFormat').value = '';
      await loadSubscriptions();
    } else {
      toast('保存失败', 'error');
    }
  } catch (e) {
    toast('保存失败: ' + e.message, 'error');
  }
};
window.saveSubscription = saveSubscription;

const toggleSubscription = async (name) => {
  // 启用/禁用: 读取当前列表, 找到反转 enabled
  const sub = _subscriptions.find(s => s.name === name);
  if (!sub) return;
  sub.enabled = !sub.enabled;
  try {
    await API.post('/api/subscriptions', sub);
    await loadSubscriptions();
  } catch (e) {
    toast('操作失败', 'error');
  }
};
window.toggleSubscription = toggleSubscription;

const deleteSubscription = async (name) => {
  if (!await showConfirm('删除订阅', `确认删除订阅 \"${name}\"?`)) return;
  try {
    const r = await API.del('/api/subscriptions/' + encodeURIComponent(name));
    if (r && r.ok) {
      toast(`订阅 \"${name}\" 已删除`, 'success');
      await loadSubscriptions();
    }
  } catch (e) {
    toast('删除失败: ' + e.message, 'error');
  }
};
window.deleteSubscription = deleteSubscription;

const checkSubscriptions = async () => {
  const result = $('subCheckResult');
  if (!result) return;
  result.textContent = '⏳ 检查中...';
  try {
    const r = await API.post('/api/subscriptions/check');
    const count = (r && r.results && r.results.length) || 0;
    result.textContent = `✅ 检查完成, 发现 ${count} 个新内容`;
    toast(`订阅检查完成, ${count} 个新任务已添加`, count > 0 ? 'success' : 'info');
    if (count > 0) await loadTasks();
  } catch (e) {
    result.textContent = '❌ ' + e.message;
  }
};
window.checkSubscriptions = checkSubscriptions;

// ── Image Full Zoom ────────────────────────────────────────────────
function showImgFull(img) {
  console.log('[fnytdlp] showImgFull called, src=', img && img.getAttribute('src'));
  const overlay = document.getElementById('imgFullOverlay');
  const fullImg = document.getElementById('imgFull');
  if (!overlay || !fullImg) return;
  fullImg.src = img.getAttribute('src');
  overlay.classList.add('show');
}
window.showImgFull = showImgFull;

// ── Task Detail Modal ──────────────────────────────────────────────
function showTaskDetail(id) {
  _currentDetailTaskId = id;
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
    // 真实路径 = dlPath + _downloadFolder (子目录) + filename
    // 多流下载 (B 站/YouTube) 时 yt-dlp 在 _downloadFolder 子目录里下载分片
    const folder = t._downloadFolder ? t._downloadFolder.replace(dlPath, '').replace(/^\//, '') : '';
    const folderSuffix = folder ? (folder.endsWith('/') ? folder : folder + '/') : '';
    if (dlPath) {
      setText('tdLocation', t.filename ? (dlPath + '/' + folderSuffix + t.filename) : (dlPath + '/' + folderSuffix || dlPath));
    } else {
      setText('tdLocation', '(默认下载目录)');
    }
  }).catch(() => {
    const folder = t._downloadFolder ? t._downloadFolder.split('/').pop() : '';
    setText('tdLocation', t.filename ? (folder ? folder + '/' + t.filename : t.filename) : (folder || '(默认下载目录)'));
  });
  setText('tdStatus', ({pending:'⏳ 等待',downloading:'⏬ 下载中',processing:'🔄 处理',completed:'✅ 已完成',error:'❌ 出错',paused:'⏸ 暂停',stopped:'⏹ 停止'})[t.status] || t.status);
  setText('tdProgress', (t.progress || 0).toFixed(1) + '%' + (t.speed ? ` · ⚡ ${formatSpeed(t.speed)}` : ''));
  setText('tdFormat', t.formatDescription || t.format || t.ext || '-');
  setText('tdCreated', t.createdAt ? new Date(t.createdAt).toLocaleString('zh-CN') : '-');
  setText('tdCompleted', t.completedAt ? new Date(t.completedAt).toLocaleString('zh-CN') : '-');
  const errRow = $('tdErrorRow');
  if (t.error) {
    setText('tdError', t.error);
    if (errRow) errRow.style.display = 'flex';
  } else if (errRow) {
    errRow.style.display = 'none';
  }
  // feat4: 加载 info.txt 内容
  const infoRow = $('tdInfoRow');
  if (infoRow) {
    const hasFolder = t.options?._downloadFolder || t.downloadFolder;
    if (hasFolder) {
      infoRow.style.display = 'flex';
      const pre = $('tdInfoContent');
      if (pre) pre.textContent = '(加载中...)';
      API.get(`/api/tasks/${t.id}/info_content`).then(r => {
        if (r && r.content) {
          if (pre) {
            try {
              const parsed = JSON.parse(r.content);
              // 格式化显示: 只显示关键字段, 不显示 raw formats/subtitles
              const display = {
                标题: parsed.title || '',
                视频ID: parsed.id || '',
                地址: parsed.webpage_url || parsed.url || '',
                时长: parsed.duration ? formatDuration(parsed.duration) : '',
                上传者: parsed.uploader || '',
                发布日期: parsed.uploadDate || '',
                观看: parsed.viewCount || 0,
                点赞: parsed.likeCount || 0,
                简介: parsed.description ? parsed.description.substring(0, 500) : '',
                提取器: parsed.extractor || '',
                Cookie: parsed.cookieName || '',
                解析时间: parsed.parsedAt ? new Date(parsed.parsedAt).toLocaleString('zh-CN') : '',
                下载开始: parsed.downloadStartedAt ? new Date(parsed.downloadStartedAt).toLocaleString('zh-CN') : '',
                格式数量: (parsed.formats || []).length + ' 个',
              };
              pre.textContent = Object.entries(display)
                .filter(([, v]) => v !== '' && v !== 0 && v !== '0')
                .map(([k, v]) => `${k}: ${v}`)
                .join('\n');
            } catch (e) {
              pre.textContent = r.content.substring(0, 2000);
            }
          }
        } else {
          if (pre) pre.textContent = '(info.txt 不存在)';
        }
      }).catch(() => {
        if (pre) pre.textContent = '(加载失败)';
      });
    } else {
      infoRow.style.display = 'none';
    }
  }
  showModal('taskDetailModal');
  // 已完成的任务显示播放按钮
  const playBtn = $('tdPlayBtn');
  if (playBtn) {
    playBtn.style.display = (t.status === 'completed' && t.filename) ? '' : 'none';
  }
}
window.showTaskDetail = showTaskDetail;

// ── 视频播放器 ──────────────────────────────────────────────
const openPlayer = (id) => {
  const t = tasks.find(x => x.id === id);
  if (!t || t.status !== 'completed' || !t.filename) { toast('无可播放的文件', 'warn'); return; }
  const video = $('playerVideo');
  const info = $('playerInfo');
  if (!video || !info) return;
  // 通过 /api/play/:id 流式加载视频
  const src = API._url(`/api/play/${id}`);
  video.src = src;
  video.load();
  info.textContent = `${esc(t.filename)} · ${t.totalBytes ? formatBytes(t.totalBytes) : ''}`;
  showModal('playerModal');
  // 自动播放
  video.play().catch(() => {});
};
window.openPlayer = openPlayer;

const closePlayer = () => {
  const video = $('playerVideo');
  if (video) { video.pause(); video.src = ''; }
  hideModal('playerModal');
};
window.closePlayer = closePlayer;
window._currentDetailTaskId = _currentDetailTaskId;
window._confirmResolve = _confirmResolve;

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
  _eventSource.addEventListener('task-created', (e) => {
    let t;
    try { t = JSON.parse(e.data); } catch (err) { console.warn('SSE task-created parse failed', e.data?.slice?.(0, 200), err); return; }
    const i = tasks.findIndex(x => x.id === t.id);
    if (i >= 0) tasks[i] = { ...tasks[i], ...t };
    else tasks.push(t);
    scheduleRender();
  });
  _eventSource.addEventListener('task-updated', (e) => {
    let t;
    try { t = JSON.parse(e.data); } catch (err) { console.warn('SSE task-updated parse failed', e.data?.slice?.(0, 200), err); return; }
    const i = tasks.findIndex(x => x.id === t.id);
    if (i >= 0) tasks[i] = { ...tasks[i], ...t };
    else tasks.push(t);
    scheduleRender();
  });
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
    sparkActive = new Sparkline('sparkActive', { max: 30, color: 'hsl(220, 100%, 60%)' });
    sparkSpeed = new Sparkline('sparkSpeed', { max: 30, color: 'hsl(170, 100%, 42%)' });
    sparkCompleted = new Sparkline('sparkCompleted', { max: 30, color: 'hsl(280, 60%, 65%)' });
    sparkTotal = new Sparkline('sparkTotal', { max: 30, color: 'hsl(45, 100%, 50%)' });
    // 启动滚动采样 (200ms 间隔, sparkline.js start() 才真正启动 setInterval _tick)
    sparkActive.start(0);
    sparkSpeed.start(0);
    sparkCompleted.start(0);
    sparkTotal.start(0);
  } catch (e) { console.warn('Sparkline init failed', e); }
  // M-1: Settings Tab 切换初始化
  initSettingsTabs();
  // v0.4.0: 文件名模板实时预览
  const _setOutputTemplate = $('setOutputTemplate');
  if (_setOutputTemplate) {
    _setOutputTemplate.addEventListener('input', updateOutputTemplatePreview);
    updateOutputTemplatePreview();
  }
  // M-3: 搜索栏实时过滤
  const _searchInput = $('searchInput');
  if (_searchInput) _searchInput.addEventListener('input', () => renderTasks());
  // feat1: 粘贴时自动提取 URL (过滤非 URL 文本)
  const _addUrls = $('addUrls');
  if (_addUrls) {
    _addUrls.addEventListener('paste', function() {
      // 延迟执行让粘贴内容先写入 textarea
      setTimeout(() => {
        const raw = _addUrls.value.trim();
        if (!raw) return;
        // 提取 http/https URL
        const urlRegex = /https?:\/\/[^\s<>"']+/g;
        const urls = raw.match(urlRegex);
        if (urls && urls.length > 0) {
          _addUrls.value = urls.join('\n');
          // 自动匹配 Cookie
          const sel = $('addCookieName');
          if (sel && sel.value === '') {
            API.get('/api/cookies').then(r => {
              const matched = autoDetectCookie(urls[0], (r && r.cookies) || []);
              if (matched) sel.value = matched;
            }).catch(() => {});
          }
          // 自动触发解析 (只对单 URL)
          if (urls.length === 1 && typeof parseUrls === 'function') {
            parseUrls();
          }
          // 多 URL 自动触发批量解析格式
          if (urls.length > 1 && typeof fetchFormats === 'function') {
            setTimeout(fetchFormats, 200);
          }
        }
      }, 10);
    });
  }
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
            const args = raw.split(',').map(function(s) {
              s = s.trim();
              if (s === 'this') return this; // 实际 DOM 元素
              if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
                return s.slice(1, -1);
              }
              // 数字/布尔/对象
              try { return JSON.parse(s); } catch (e) { return s; }
            }, this); // <-- 把 this (当前元素) 传给 map 的 thisArg
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
  // poll every 30s as fallback (SSE 主, 轮询备)
  setInterval(loadTasks, 30000);
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
