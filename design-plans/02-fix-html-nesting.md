# 修复 HTML 嵌套断裂 — 详情弹窗 info-value 未闭合

Written against: `9833ede`

## Evidence chain

- **Surface**: `ui/index.html` 931–943 行
- **Problem**: `<div class="info-value">` 在 933 行开启, 但 `<details>` 在 937 闭合后缺少 `</div>` 闭合 info-value, 导致 938 行的 `<div class="form-group">` 被渲染为 `info-value` 的子元素而非兄弟元素
- **Design evidence**: HTML5 规范要求元素嵌套正确闭合。其他 `info-row` 结构 (如 918-930 行) 都有正确的 `info-label` + `info-value` 闭合模式
- **Owner**: `ui/index.html`
- **Scope**: 仅任务详情弹窗的 `tdInfoRow` 区域
- **Uncertainty**: 无 — 修复是明确的 HTML 语法修正

## Design decision

补全缺失的 `</div>` 闭合标签, 使 HTML 结构合法。

## Reuse

- 不涉及新组件/令牌, 仅补全现有 HTML 结构
- Exemplar: 918-930 行的其他 `info-row` 结构

## Changes

### 1. `ui/index.html` line 937

在 `</details>` 后补 `</div>` 闭合 `info-value`:

```html
          </details>
        </div>   <!-- ← 新增: 闭合 info-value -->
        <div class="form-group">
```

## Scope

- **Inherit**: 当 `tdInfoRow` 显示时, 速度曲线不再受 `info-value` 的样式影响
- **Verify**: 打开详情弹窗, 确认速度曲线 canvas 渲染位置正确
- **Exclude**: 其他 HTML 结构

## Validation

1. **Product**: 详情弹窗 info-row 解析信息区域展开后, 速度曲线在正确位置渲染
2. **Interface**: 点击任务 → 详情弹窗 → 确认速度曲线区域不在 info-value 的文本样式内
3. **System**: 不影响其他功能
4. **Repository**: `node --test tests/*.js` → 279/279 passing

## Stop conditions

- 无 — 修复是明确的 HTML 语法修正

## Design documentation

- 不需要更新文档