# 详情弹窗按钮绑定一致性 — 关闭/删除按钮改用 DOM 0 onclick

Written against: `9833ede`

## Evidence chain

- **Surface**: `ui/index.html` 950–951 行, `ui/main.js` `showTaskDetail` 函数
- **Problem**: 详情弹窗 footer 中 5 个按钮有 2 种绑定方式:
  - `tdPlayBtn`/`tdCopyCmdBtn`/`tdSubtitleBtn`/`tdAISummaryBtn`: `id` + `showTaskDetail` 内 DOM 0 onclick, 传正确 `id` 变量
  - "关闭"按钮 (950) 和 "删除"按钮 (951): inline `onclick`, 被 `rewireInlineOnclick` 处理, `_currentDetailTaskId` 变量名被当成字符串字面量
- **Design evidence**: 应用存在 `rewireInlineOnclick` 机制, 但其解析 `onclick="deleteTask(_currentDetailTaskId)"` 时, 正则 `/([a-zA-Z_]\w*)\((.*)\)/` 将 `_currentDetailTaskId` 解析为字符串 `'_currentDetailTaskId'` 而非全局变量。`rewireInlineOnclick` 的 `replace(/^['"]|['"]$/g, '')` 去掉了不存在的引号, 保留原样 → 导致 `deleteTask('_currentDetailTaskId')` 调用失败。
- **Owner**: `ui/index.html`, `ui/main.js`
- **Scope and affected surfaces**: 任务详情弹窗的关闭和删除按钮
- **Uncertainty**: 无 — 修复方案已通过 `tdPlayBtn`/`tdCopyCmdBtn`/`tdSubtitleBtn`/`tdAISummaryBtn` 的现有实现验证

## Design decision

为"关闭"和"删除"按钮添加 `id`, 在 `showTaskDetail` 中使用 DOM 0 onclick 绑定, 传正确 `id` 变量。与已修复的 4 个按钮保持一致。

## Reuse

- 现有模式: `showTaskDetail` 中 4 个按钮的 DOM 0 onclick 绑定方式
- Exemplar: `ui/main.js` 2440-2446 行

```js
const _copyBtn = $('tdCopyCmdBtn');
if (_copyBtn) _copyBtn.onclick = (e) => { e.preventDefault(); copyYtDlpCmd(id); return false; };
```

## Changes

### 1. `ui/index.html` — 为关闭/删除按钮加 id, 去掉 inline onclick

```html
<button class="btn btn-ghost" id="tdCloseBtn">关闭</button>
<button class="btn btn-danger" id="tdDeleteBtn">🗑 删除</button>
```

### 2. `ui/main.js` `showTaskDetail` 函数 — 绑定关闭/删除按钮

在现有绑定代码后追加:

```js
const _closeBtn = $('tdCloseBtn');
if (_closeBtn) _closeBtn.onclick = (e) => { e.preventDefault(); hideModal('taskDetailModal'); return false; };
const _deleteBtn = $('tdDeleteBtn');
if (_deleteBtn) _deleteBtn.onclick = (e) => {
  e.preventDefault();
  deleteTask(id);
  hideModal('taskDetailModal');
  return false;
};
```

## Scope

- **Inherit**: 关闭和删除按钮在所有 fnOS WebView 场景下正常工作
- **Verify**: 打开详情弹窗 → 点击关闭 → 弹窗关闭; 点击删除 → 确认弹窗 → 任务删除
- **Exclude**: 其他 inline onclick 按钮 (如 settings modal 中的按钮)

## Validation

1. **Product**: 关闭按钮 → 详情弹窗关闭; 删除按钮 → 确认后任务删除
2. **Interface**: 任务详情弹窗 footer 操作正常
3. **System**: 确认 `rewireInlineOnclick` 不再处理关闭/删除按钮 (无 inline onclick 属性)
4. **Repository**: `node --test tests/*.js` → 279/279 passing

## Stop conditions

- 如果 `$('tdCloseBtn')` 或 `$('tdDeleteBtn')` 返回 null (id 冲突), 停止并检查 id 唯一性

## Design documentation

- 不需要更新文档