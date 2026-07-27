# 清理死代码 + playerDialog 样式归一化

Written against: `9833ede`

## Evidence chain

- **Surface**: `ui/index.html` 984–1018 行, `ui/styles/components.css`
- **Problem**: 两个播放器组件共存:
  1. 新 `<dialog id="playerDialog">` (986–997) — 全 inline 样式, 实际使用
  2. 旧 `<div class="modal-overlay" id="playerModal">` (1000–1018) — 使用 CSS 类, 已废弃但未清理
- **Design evidence**: 应用使用 `tokens.css`+`components.css`+`layout.css` 作为设计系统。`playerDialog` 的 inline 样式完全绕过设计系统, 包含 14 个独立 inline style 属性, 与组件的 CSS 类体系不一致。`playerModal` 已废弃 (`openPlayer` 中只有 `if (false)` 死代码调用), 但仍在 DOM 中。
- **Owner**: `ui/index.html`, `ui/styles/components.css`
- **Scope and affected surfaces**: 播放器 dialog 渲染, 不涉及其他 modal
- **Uncertainty**: 无 — inline 样式值可直接迁移为 CSS 类, 视觉 1:1 对应

## Design decision

将 `playerDialog` 的 inline 样式提取为 `components.css` 中的 CSS 类, 与设计系统统一。删除 `playerModal` 死代码。

## Reuse

- 现有组件类: `.modal-overlay` (布局), `.modal` (布局), `.modal-header` (布局), `.modal-body` (布局), `.modal-footer` (布局)
- 新建类: `.player-dialog`, `.player-dialog-header`, `.player-dialog-video-wrapper`, `.player-dialog-info`
- Exemplar: 其他 modal 的样式结构 (`ui/styles/layout.css` 中 `.modal-overlay`, `.modal` 等)

## Changes

### 1. `ui/styles/components.css` — 新增 player-dialog 样式类

```css
/* ===== Player Dialog ===== */
.player-dialog {
  width: 90vw;
  height: 90vh;
  max-width: 90vw;
  max-height: 90vh;
  padding: 0;
  border: none;
  background: #000;
  color: #fff;
  position: fixed;
  top: 5vh;
  left: 5vw;
  margin: 0;
}
.player-dialog::backdrop {
  background: rgba(0,0,0,0.85);
}
.player-dialog-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 16px;
  background: rgba(20,20,20,0.95);
  border-bottom: 1px solid rgba(255,255,255,0.1);
}
.player-dialog-title {
  font-size: 14px;
  color: rgba(255,255,255,0.7);
}
.player-dialog-close-btn {
  padding: 6px 16px;
  background: rgba(255,255,255,0.1);
  color: #fff;
  border: 1px solid rgba(255,255,255,0.2);
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
}
.player-dialog-close-btn:hover {
  background: rgba(255,255,255,0.2);
}
.player-dialog-video-wrapper {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #000;
  min-height: 0;
}
.player-dialog-video {
  max-width: 100%;
  max-height: 100%;
  width: auto;
  height: auto;
  outline: none;
  display: block;
}
.player-dialog-info {
  padding: 6px 16px;
  background: rgba(20,20,20,0.95);
  border-top: 1px solid rgba(255,255,255,0.1);
  font-size: 11px;
  color: rgba(255,255,255,0.5);
  text-align: center;
}
```

### 2. `ui/index.html` — 删除 playerModal (1000–1018), 替换 playerDialog 的 inline style 为 CSS 类

```html
<!-- Video Player Dialog -->
<dialog id="playerDialog" class="player-dialog">
  <div style="display:flex;flex-direction:column;width:100%;height:100%">
    <div class="player-dialog-header">
      <span id="playerDialogTitle" class="player-dialog-title">▶ 加载中...</span>
      <button id="playerDialogCloseBtn" class="player-dialog-close-btn">关闭</button>
    </div>
    <div class="player-dialog-video-wrapper">
      <video id="playerDialogVideo" class="player-dialog-video" controls autoplay playsinline preload="auto">您的浏览器不支持视频播放</video>
    </div>
    <div id="playerDialogInfo" class="player-dialog-info">fnytdlp 视频播放器</div>
  </div>
</dialog>
```

删除 `playerModal` 整块 (1000–1018) 和 `dialog::backdrop` inline style 标签 (998)。

### 3. `ui/main.js` — 动态创建 dialog 时同步使用 CSS 类

在 `openPlayer` 函数中, 动态创建 dialog 的 innerHTML 也应使用 `class` 而非 `style` 属性。

## Scope

- **Inherit**: `playerDialog` 的视觉表现完全一致 (inline style 值直接迁移到 CSS 类)
- **Verify**: 任务栏和详情弹窗的播放按钮 → 弹出 dialog → 视觉无变化 → 关闭按钮工作
- **Exclude**: 其他 modal 样式, 播放器功能逻辑

## Validation

1. **Product**: 播放器 dialog 视觉与之前完全一致
2. **Interface**: 打开 playerDialog, 确认 header/关闭按钮/video 区域/info 栏布局正确
3. **System**: 确认 `playerModal` 不再存在于 DOM 中
4. **Repository**: `node --check ui/main.js && node --test tests/*.js` → 279/279 passing

## Stop conditions

- 如果 inline style 迁移后 dialog 视觉出现差异 (如 padding 计算不一致), 停止并比对原值

## Design documentation

- 执行后不需要更新 DESIGN.md (无 DESIGN.md 文件)