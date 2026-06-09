# fnytdlp - 飞牛 NAS 视频下载器

> 集成 [yt-dlp](https://github.com/yt-dlp/yt-dlp) (1872+ 站点) 的 fnOS 视频下载工具，零依赖、纯 Node.js。

## 特性

- **1000+ 视频站**：YouTube / B 站 / 抖音 / 微博 / X / 西瓜 / 推特 / Twitch / Vimeo / 任意 yt-dlp 支持的站
- **yt-dlp 完整参数**：格式选择、字幕下载、缩略图、SponsorBlock 广告跳过、元数据嵌入、Cookie 认证、代理
- **自适应架构**：x86_64 binary 内置（fnOS 服务器主流），aarch64 待补
- **统一网关模式**：Unix socket + HTTP 双端口，fnOS 网关原生代理
- **现代 UI**：8 项 UI 重构（KPI Dashboard / Toolbar / Task Card / Settings sidebar / Cookie modal / 5 主题）
- **实时进度**：SSE 推送 + 2s 轮询双备份
- **安全**：SSRF 防护（只 http/https）/ 路径白名单 / Cookie 加密存储
- **零运行时依赖**：纯 Node.js ESM 模块，fpk 解包即跑

## 安装

1. 在 fnOS 应用中心上传 `fnytdlp.fpk`
2. 启用应用，浏览器访问桌面图标
3. 首次进入"设置"，配置下载路径（建议 `/vol2/1000/fnytdlp/`）
4. 点"+"粘贴视频链接开始下载

## 10 大核心参数

| 参数 | 作用 | 默认 |
|------|------|------|
| `--format` | 格式选择 (bv*+ba/b) | bv*+ba/b |
| `--output` | 文件名模板 | %(title)s [%(id)s].%(ext)s |
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

## SponsorBlock

自动跳过视频里的广告/赞助/自我介绍片段：

- 设置 → 高级 → `sponsor,selfpromo,intro,outro` (用逗号分隔)
- 标记的片段会写入视频元数据，播放器识别后自动跳过

## 项目结构

```
fnytdlp/
├── ui/                          # 前端 + Node.js server
│   ├── server.js                # 后端 HTTP+UNIX socket
│   ├── main.js                  # 前端逻辑
│   ├── index.html               # 入口
│   ├── styles/                  # HSL 设计系统 (tokens/components/layout)
│   └── util/sparkline.js        # KPI 趋势小图
├── cmd/
│   ├── bin/yt-dlp               # 内置 yt-dlp 3.1MB binary
│   └── main                     # fnpack 启动脚本
├── config/
│   ├── privilege                # run-as 用户配置
│   └── resource                 # 资源配额
├── wizard/uninstall             # 卸载向导
├── manifest                     # fnpack 配置
└── fnytdlp.fpk                  # 打包产物
```

## 开发

```bash
# 启动测试服务器
TRM_PKGVAR=/tmp/fnytdlp-test PORT=19634 node ui/server.js

# 打包
fnpack build .
```

## 数据目录

应用运行时数据存放在 `${TRM_PKGVAR}/`：
- `config.json` - 用户设置
- `tasks.json` - 任务列表
- `cookies.txt` - Cookie 文件 (mode 0600)
- `info.log` - fnOS 框架日志
- `data/downloads/` - 默认下载目录

## 系统依赖

- Node.js 20+ (fnOS 框架自带)
- Python 3.7+ (yt-dlp zipimport 模式需要)
- ffmpeg (`/usr/bin/ffmpeg`，fnOS 系统内置)

## 许可

MIT（注意：yt-dlp 本身是 Unlicense，fpk 打包后依然是 MIT）
