/**
 * anim.js — anime.js 动画模块
 * 依赖: anime.js v4 (UMD, window.AnimeJS)
 * 加载顺序: anime.js → anim.js → main.js
 *
 * 提供 8 种动画效果:
 * 1. pageEntrance — 首页加载入场
 * 2. modalIn/Out — 弹窗缩放
 * 3. toastIn/Out — 通知滑入/滑出
 * 4. kpiCounter — 数字计数动画
 * 5. kpiBump — KPI 值变化脉冲
 * 6. taskIn/Out — 任务项新增/删除
 * 7. btnClick — 按钮点击波纹
 * 8. pulse — 通用高亮脉冲
 */
'use strict';

(function() {
  const A = typeof AnimeJS !== 'undefined' ? AnimeJS : null;
  const isReady = () => A !== null && typeof A.animate === 'function';

  // ── 工具: 安全获取 DOM 元素 ──────────────────────────
  const $ = id => document.getElementById(id);

  // ── 1. 首页入场动画 ─────────────────────────────────
  // 在 DOMContentLoaded 后调用
  window.animatePageEntrance = function() {
    if (!isReady()) return;
    // KPI 卡片: 从下方依次飞入 + 透明度
    const kpiCards = document.querySelectorAll('.kpi-card');
    if (kpiCards.length > 0) {
      A.animate(kpiCards, {
        opacity: [0, 1],
        translateY: [24, 0],
        duration: 550,
        delay: A.stagger(80, { from: 'first' }),
        ease: 'outBack(1.2)',
      });
    }
    // 工具栏: 淡入
    const toolbar = document.querySelector('.toolbar');
    if (toolbar) {
      A.animate(toolbar, {
        opacity: [0, 1],
        translateY: [-8, 0],
        duration: 400,
        delay: 200,
        ease: 'out(2)',
      });
    }
    // 空状态: 淡入 + 上移
    const emptyState = $('emptyState');
    if (emptyState && emptyState.style.display !== 'none') {
      A.animate(emptyState, {
        opacity: [0, 1],
        translateY: [16, 0],
        duration: 500,
        delay: 350,
        ease: 'out(2)',
      });
    }
  };

  // ── 2. 弹窗入场/出场 ─────────────────────────────────
  window.animateModalIn = function(modalId) {
    if (!isReady()) return;
    const overlay = $(modalId);
    if (!overlay) return;
    // 遮罩层淡入 (overlay 本身)
    A.animate(overlay, {
      opacity: [0, 1],
      duration: 200,
      ease: 'out(2)',
    });
    // 弹窗主体缩放 + 上移
    const modalBody = overlay.querySelector('.modal, .modal-overlay-inner, .modal-content');
    if (modalBody) {
      A.animate(modalBody, {
        scale: [0.92, 1],
        opacity: [0, 1],
        translateY: [-12, 0],
        duration: 280,
        ease: 'outBack(1.15)',
      });
    }
  };

  window.animateModalOut = function(modalId, callback) {
    if (!isReady()) { if (callback) callback(); return; }
    const overlay = $(modalId);
    if (!overlay) { if (callback) callback(); return; }
    const modalBody = overlay.querySelector('.modal, .modal-overlay-inner, .modal-content');
    if (modalBody) {
      A.animate(modalBody, {
        scale: 0.92,
        opacity: 0,
        translateY: 12,
        duration: 180,
        ease: 'in(2)',
        onComplete: () => {
          overlay.style.opacity = ''; // 重置内联样式
          if (callback) callback();
        },
      });
    } else {
      A.animate(overlay, {
        opacity: 0,
        duration: 150,
        onComplete: () => {
          overlay.style.opacity = '';
          if (callback) callback();
        },
      });
    }
  };

  // ── 3. Toast 通知 ─────────────────────────────────────
  window.animateToastIn = function(el) {
    if (!isReady() || !el) return;
    A.animate(el, {
      translateX: [60, 0],
      opacity: [0, 1],
      duration: 300,
      ease: 'outBack(1.2)',
    });
  };

  window.animateToastOut = function(el, callback) {
    if (!isReady() || !el) { if (callback) callback(); return; }
    A.animate(el, {
      translateX: 60,
      opacity: 0,
      duration: 200,
      ease: 'in(2)',
      onComplete: () => {
        el.style.transform = '';
        el.style.opacity = '';
        if (callback) callback();
      },
    });
  };

  // ── 4. KPI 数字计数动画 ──────────────────────────────
  window.animateKpiCounter = function(el, fromVal, toVal, suffix) {
    if (!isReady() || !el) return;
    // 只对纯数字 KPI 做计数动画 (id 含 kpiActive, kpiCompleted, kpiTotal)
    // speed 显示文字, 跳过
    const id = el.id || '';
    if (!id.match(/kpiActive|kpiCompleted|kpiTotal|kpiCount/)) return;
    fromVal = typeof fromVal === 'number' ? Math.round(fromVal) : 0;
    toVal = typeof toVal === 'number' ? Math.round(toVal) : 0;
    if (fromVal === toVal) return;
    const data = { value: fromVal };
    A.animate(data, {
      value: toVal,
      duration: 500,
      ease: 'outExpo',
      onUpdate: () => {
        el.textContent = Math.round(data.value) + (suffix || '');
      },
    });
  };

  // ── 5. KPI bump 动画 (替代 CSS bump) ────────────────
  // 保持与 CSS class 'bump' 兼容, 但用 anime.js 做更平滑的缩放
  window.animateKpiBump = function(el) {
    if (!isReady() || !el) return;
    // 如果正在动画中, 先重置
    A.animate(el, {
      scale: [1.15, 1],
      duration: 350,
      ease: 'outBack(1.3)',
    });
  };

  // ── 6. 任务项新增/删除 ───────────────────────────────
  window.animateTaskIn = function(el) {
    if (!isReady() || !el) return;
    A.animate(el, {
      opacity: [0, 1],
      translateX: [-20, 0],
      duration: 350,
      ease: 'out(2)',
    });
  };

  window.animateTaskOut = function(el, callback) {
    if (!isReady() || !el) { if (callback) callback(); return; }
    A.animate(el, {
      opacity: 0,
      translateX: 20,
      scale: 0.95,
      duration: 250,
      ease: 'in(2)',
      onComplete: () => {
        el.style.transform = '';
        el.style.opacity = '';
        if (callback) callback();
      },
    });
  };

  // ── 7. 按钮点击波纹 ─────────────────────────────────
  window.animateBtnClick = function(btn) {
    if (!isReady() || !btn) return;
    // 快速缩放脉冲
    A.animate(btn, {
      scale: [1, 0.95, 1],
      duration: 200,
      ease: 'outBack(2)',
    });
  };

  // ── 8. 通用高亮脉冲 ─────────────────────────────────
  window.animatePulse = function(el) {
    if (!isReady() || !el) return;
    A.animate(el, {
      scale: [1, 1.04, 1],
      opacity: [1, 0.8, 1],
      duration: 400,
      ease: 'out(2)',
    });
  };

  // ── 9. Tab 切换动画 ─────────────────────────────────
  window.animateTabSwitch = function(activeTabEl) {
    if (!isReady() || !activeTabEl) return;
    // 下划线滑动效果
    A.animate(activeTabEl, {
      scale: [0.95, 1],
      duration: 200,
      ease: 'outBack(1.3)',
    });
  };

  console.log('[anim] 动画模块已加载, anime.js 可用:', isReady());
})();