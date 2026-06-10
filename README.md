# fnytdlp - 飞牛 NAS 视频下载器

> 集成 [yt-dlp](https://github.com/yt-dlp/yt-dlp) (1872+ 站点) 的 fnOS 视频下载工具，零依赖、纯 Node.js。

![fnytdlp 视频下载器](ICON_256.PNG)

## 功能特性

- **1000+ 视频站**：YouTube / B 站 / 抖音 / 微博 / X / 西瓜 / 推特 / Twitch / Vimeo / 任意 yt-dlp 支持的站
- **yt-dlp 完整参数**：格式选择、字幕下载、缩略图、SponsorBlock 广告跳过、元数据嵌入、Cookie 认证、代理
- **自适应架构**：x86_64 + aarch64 双 binary 打包，启动时按 `process.arch` 自动选
  - 当前 zipimport 模式 binary 是平台无关 Python 脚本（同一份内容两架构都能跑），但保留双文件方便未来替换为 musl native binary
  - 兜底逻辑：env `YT_DLP_BIN` > 架构匹配 > 通用 `yt-dlp`
- **统一网关模式**：Unix socket + HTTP 双端口，fnOS 网关原生代理
- **现代 UI**：8 项 UI 重构（KPI Dashboard / Toolbar / Task Card / Settings sidebar / Cookie modal / 5 主题）
- **实时进度**：SSE 推送 + 2s 轮询双备份，实时显示速度/ETA/进度
- **任务详情**：点击任务卡弹窗显示 ID/标题/URL/文件名/大小/已下载/存储位置/状态/进度/格式/创建/完成/错误等 13 字段
- **下载路径浏览**：设置面板支持 📂 按钮 + 弹窗选择目录（不限制白名单，可任意浏览后选择）
- **Cookie 多网站管理**：单文件 → 数组结构 + 任务级 cookieName 透传，浏览器扩展导入
- **页脚版权**：动态版本号 + 自动年份，yt-dlp 加原项目链接
- **安全**：SSRF 防护（只 http/https）/ 路径白名单 / Cookie 加密存储 / fetch 30s 超时 / 错误脱敏
- **零运行时依赖**：纯 Node.js ESM 模块，fpk 解包即跑

## 安装

### 在 FnOS 应用中心安装

1. 下载 `fnytdlp.fpk`（约 6.3 MB）
2. 在飞牛NAS应用中心 → 手动安装
3. 首次进入"设置"，配置下载路径（建议 `/vol2/1000/fnytdlp/`）
4. 点"+"粘贴视频链接开始下载

### 直接运行

```bash
cd /path/to/fnytdlp
PORT=19634 node ui/server.js
```

然后访问 `http://localhost:19634` 即可。

## 10 大核心参数

| 参数 | 作用 | 默认 |
|------|------|------|
| `--format` | 格式选择 (bv*+ba/b) | bv*+ba/b |
| `--output` | 文件名模板 | `%(title)s [%(id)s].%(ext)s` |
| `--cookies` | Cookie 文件 (会员内容) | 关闭 |
| `--write-subs` | 下载字幕 | 关闭 |
| `--write-thumbnail` | 下载缩略图 | 开启 |
| `--sponsorblock-mark` | 标记广告片段 | 关闭 |
| `--embed-metadata` | 嵌入标题/上传者/日期 | 开启 |
| `--no-playlist` | 单视频 (不下载播放列表) | 关闭 |
| `--concurrent-fragments` | 分片并发数 | 4 |
| `--retries` | 重试次数 | 3 |

## Cookie 认证

YouTube 会员 / B 站大会员等需要登录才能看的视频：

1. 浏览器装 "Get cookies.txt LOCALLY" 扩展
2. 登录目标站 → 导出 cookies.txt
3. 应用里点 🍪 Cookie → 粘贴 → 保存
4. 下次下载自动加载

### 多网站 Cookie

支持同时管理多个站点的 Cookie（YouTube 会员、B 站大会员、抖音登录等），任务级 `cookieName` 字段透传指定。

## SponsorBlock

自动跳过视频里的广告/赞助/自我介绍片段：

- 设置 → 高级 → `sponsor,selfpromo,intro,outro` (用逗号分隔)
- 标记的片段会写入视频元数据，播放器识别后自动跳过

## 实时监控

- KPI Dashboard：4 张卡片显示总任务/下载中/已完成/失败 + 实时速度/ETA/已用时间/平均速度
- SSE 实时推送：进度变化无延迟，配合 2s 轮询兜底
- 速度小图：6 个采样点滑动窗口绘制（Sparkline）

## 项目结构

```
fnytdlp/
├── ui/                          # 前端 + Node.js server
│   ├── server.js                # 后端 HTTP+UNIX socket (API 路由 + 任务管理)
│   ├── main.js                  # 前端逻辑 (任务管理 / 主题 / 设置 / 搜索 / 赞助 / 详情)
│   ├── index.html               # 入口 (响应式 + 5 主题 + 移动端适配)
│   ├── styles/                  # HSL 设计系统 (tokens/components/layout)
│   │   ├── tokens.css          # CSS 变量 (HSL 主色/灰阶/间距/圆角/阴影)
│   │   ├── components.css      # 组件样式 (button/card/modal/sponsor 等)
│   │   └── layout.css          # 布局 (header/main/aside/footer)
│   ├── util/
│   │   ├── sparkline.js        # KPI 趋势小图 (ESM 模块)
│   │   └── url-resolver.js     # 动态直播源解析 (PHP 路径嗅探 + SSRF 守卫)
│   └── bin/
│       ├── yt-dlp-x86_64        # x86_64 平台 (fnOS 服务器主流)
│       ├── yt-dlp-aarch64       # aarch64 平台 (ARM NAS)
│       └── LICENSE.txt          # yt-dlp Unlicense 全文
├── tests/                       # TDD 测试套件
│   ├── test_comprehensive.js   # 端到端 + API 集成测试
│   ├── test_modules.js         # 模块单元测试
│   ├── test_new_modules.js     # 新模块测试
│   └── test_*.js               # 20+ 专项测试
├── cmd/
│   ├── bin/yt-dlp-x86_64        # 跨平台 yt-dlp binary
│   ├── bin/yt-dlp-aarch64
│   └── main                     # fnpack 启动脚本
├── config/
│   ├── privilege                # run-as 用户配置
│   └── resource                 # 资源配额
├── wizard/uninstall             # 卸载向导
├── manifest                     # fnpack 配置
└── fnytdlp.fpk                  # 打包产物 (6.3 MB)
```

## API 端点

| 端点 | 方法 | 描述 |
|------|------|------|
| `/api/health` | GET | 健康检查（含 arch/ytDlpBin/version） |
| `/api/config` | GET | 获取配置 |
| `/api/config` | POST | 保存配置（下载路径/Cookie 目录/yt-dlp 参数） |
| `/api/tasks` | GET | 获取任务列表 |
| `/api/tasks` | POST | 添加下载任务（支持 options 透传） |
| `/api/tasks/:id` | GET | 获取单个任务 |
| `/api/tasks/:id` | DELETE | 删除任务（支持 `?deleteFiles=1`） |
| `/api/parse` | GET | 解析视频 URL 提取元数据 |
| `/api/browse` | GET | 浏览目录（白名单子目录列表） |
| `/api/cookies` | GET/POST/DELETE | Cookie 多文件管理 |
| `/api/events` | GET | SSE 实时进度推送 |
| `/api/progress` | GET | 任务进度（保留兼容） |

## 数据目录

应用运行时数据存放在 `${TRM_PKGVAR}/`：

- `config.json` - 用户设置
- `tasks.json` - 任务列表
- `cookies/` - 多 Cookie 文件目录 (mode 0600)
- `info.log` - fnOS 框架日志
- `data/downloads/` - 默认下载目录
- `data/manifests/` - 应用状态/审计数据

## 系统依赖

- Node.js 20+ (fnOS 框架自带)
- Python 3.7+ (yt-dlp zipimport 模式需要)
- ffmpeg (`/usr/bin/ffmpeg`，fnOS 系统内置 7.1.3-mediassr 带 VAAPI/CUDA 加速)

## 开发

```bash
# 启动测试服务器
TRM_PKGVAR=/tmp/fnytdlp-test PORT=19634 node ui/server.js

# 跑全部测试
node --test tests/*.js

# 打包
fnpack build .
```

## 架构亮点

### 跨架构 Binary 选择

`process.arch` (Go 风格: x64/arm64/ia32) + 4 优先级 (env `YT_DLP_BIN` > arch 匹配 > 通用 `yt-dlp`)。zipimport 模式 6.4MB 总，比 musl native 56MB 省 88% 体积，GitHub 下载快 10x。

### 动态直播源解析

PHP 动态直播源（如 `http://example.com/live.php?id=xxx`）自动检测 + 嗅探（URL 扩展名 / Content-Type / body 头 `#EXTM3U`）+ SSRF 5 层守卫 + redirect 二次验证。url-resolver.js 145 行 ESM 零依赖。

### 周期轮询 3 层架构

`initXxxDashboard` (幂等) / `loadTasks` (全量，结构变化) / `pollTasks` (增量，改 textContent 不 innerHTML)。比 `setInterval(loadTasks)` 强：无 focus 丢失 / 无 scroll 位置重置 / GPU 加速。

## 版本历史

### v0.2.5 (2026-06-11)

**Bug 修复**

- 多流下载友好界面：视频/音频两段子进度条（video cap 50% 防"两次 100%"），合并阶段显示 99%
- 临时文件名暂存：`xxx.f100026.mp4` 分片不覆盖 `task.filename`，合并后最终 `.mp4` 才展示
- 任务详情存储位置包含子目录：路径改为 `downloadPath/video_xxx/xxx.mp4`
- 格式显示改为人类可读：`100026+30280` → `1080p HEVC · mp4 + 128k mp4a · m4a`
- 部署目录权限修复：新加文件使用 `install -m 644 -o package -g package` 替代 cp

**新功能**

- `describeFormatIds()` 反查 formats 数组，formatId → 分辨率/编码/码率
- `showTaskDetail` 优先显示 `formatDescription`

### v0.2.0 (2026-06-10)

**Bug 修复**

- 文件名显示封面图：`[download] Destination:` 解析时过滤 `.webp/.jpg/.png/.gif` 封面扩展名；已完成旧任务兜底扫描也检查 filename 是否为封面图
- 工具栏清理按钮无确认框：`clearCompleted` 增加 `showConfirm` 弹窗
- 赞助大图点击不放大：inline onclick 重绑定不支持 `this` 关键字，箭头函数改 `function` + `thisArg`

**安全加固**

- 清理已完成任务前增加确认弹窗，防止误操作

### v0.1.0 (2026-06-09)

**核心功能**

- 集成 yt-dlp 1872+ 站点支持
- 自适应 x86_64 + aarch64 双 binary
- 4 张 KPI 卡片 + Sparkline 实时趋势
- SSE 实时进度推送 + 2s 轮询兜底
- 任务详情弹窗（13 字段含 ID/URL/文件名/大小/已下载/存储位置等）
- 下载路径浏览对话框（📂 按钮 + 弹窗选择任意目录）
- 多网站 Cookie 任务级透传
- SponsorBlock 广告跳过 / 字幕 / 缩略图 / 元数据嵌入
- 5 主题 + 明暗模式 + 响应式布局（桌面/移动端）
- SSRF 防护 / 路径白名单 / Cookie 加密存储 / 30s fetch 超时
- 20+ TDD 测试套件，集成 / 单元 / 端到端覆盖

**Bug 修复**

- sparkline.js ESM 模块加载：script 标签加 `type="module"` + main.js 用 `import`
- 实时速度 KPI 换行：字号 1.1→0.95rem + `white-space: nowrap` + ellipsis
- `r.pipeThrough is not a function` TypeError 500：ArrayBuffer 没 pipeThrough API 误用修复
- 空状态两个按钮等宽居中：`flex: 1` 替代 min-width
- 任务列表无闪烁刷新：去 spinner + SSE rAF 节流 + 5s 轮询 + CSS contain
- 版本号统一从 manifest → 改为 VERSION 常量（启动速度 + 0 失败）

**UI 优化**

- 8 项 UI 重构（KPI Dashboard / Toolbar / Task Card / Settings sidebar / Cookie modal / Batch bar / Empty state / Sparkline）
- 移动端 5 项适配（KPI 2 列 / Header 隐藏时钟 / 工具栏横滑 / Batch bar 紧凑 / 弹窗全屏）
- 工具栏 ghost 按钮背景色统一（var(--bg) 浅底 + emoji 字号规范）
- 页脚版权信息：动态版本号 + 自动年份 + yt-dlp / FnDepot 链接

**安全加固**

- CORS 白名单同源回退
- file:// URL 400 而非 500
- IPv4 映射 IPv6 内网地址绕过修复
- url-resolver 流式 body 限 1MB
- 错误信息路径泄露过滤

## 测试

```bash
# 运行全部测试
node --test tests/*.js

# 运行特定测试文件
node --test tests/test_comprehensive.js
node --test tests/test_modules.js
```

## 维护者

- 作者：[@再见一零一二](https://gitee.com/wyf1015)
- GitHub：[@Wyf841015](https://github.com/Wyf841015)
- Gitee：[@wyf1015](https://gitee.com/wyf1015)
- 第三方依赖：[yt-dlp](https://github.com/yt-dlp/yt-dlp) (Unlicense)

---

> 如果这个项目对您有帮助，欢迎赞助支持 ❤️
> 本应用打包了 [yt-dlp](https://github.com/yt-dlp/yt-dlp)（Unlicense 公共领域），保留完整 LICENSE 文本。

## 更新日志

### v0.2.0 (2026-06-10)
- fix: Destination 封面图过滤（实时解析 + 旧任务兜底）
- fix: toolbar 清理按钮加 showConfirm 确认框
- fix: 赞助大图点击不放大（inline onclick this 关键字修复）

### v0.1.0 (2026-06-09)
- 集成 yt-dlp 1872+ 站点支持
- 自适应 x86_64 + aarch64 双 binary
- KPI Dashboard + Sparkline 实时趋势
- SSE 实时进度推送
- 任务详情弹窗 13 字段
- 下载路径浏览对话框
- 多网站 Cookie 任务级透传
- SponsorBlock 广告跳过
- 5 主题 + 响应式布局
- 20+ TDD 测试套件
- sparkline ESM 加载修复 / Speed KPI 换行修复 / pipeThrough TypeError 修复
