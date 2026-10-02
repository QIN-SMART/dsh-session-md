# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的写法，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-10-02

首个版本：把 DSH 会话导出成一份干净的 Markdown 或自包含 HTML。

### Added

- 模型工具 `export_session_md`：默认导出当前会话，也可 `sessionId` 指定、`all` 批量、`includeSubagents` 连子会话。
- 四种导出预设，工具与界面按钮共用同一套实现：
  - `full` 全部 —— 工具参数与结果都在，给别的 agent 接手或复现问题；
  - `handoff` 交接 —— 保留工具调用链，去掉思维链，超长结果截断；
  - `readable` 简洁 —— 工具只留名字，给人读；
  - `audit` 审计 —— 不截断，并附系统提示词与机器注入的上下文。
  - `both` —— 一次写出 `full` 与 `readable` 两份。
- 显式参数覆盖预设（例如 `mode: 'readable'` + `includeToolDetails: true`）。
- 会话标题栏的「导出为 Markdown」模式菜单（7 项），以及认证下载路由
  `GET|HEAD /api/session.export-md?sessionId=…&mode=…&format=md|html`；浏览器直接下载，不受会话文件沙箱限制。
- `format: 'html'`：零依赖渲染成**自包含单文件**（内联 CSS、零外部请求、跟随深浅色、顶部「全部展开」），
  打印样式会展开 `<details>`，所以「浏览器打印 → 存储为 PDF」不会丢掉思维链与工具调用。
- 渲染细节：按 Turn 分组；思维链、工具调用（名称/参数/结果）、待办、压缩摘要、交付文件都可折叠；
  未返回结果的工具调用单列一节；被中断的回复会标注。
- 会话正文里的 `<details>` / `<summary>` 会被转义，未闭合的代码围栏会被转义成字面反引号，
  正文标题下沉三级 —— 内容无法破坏导出文档的结构。
- 插件列表元数据：`icon.svg` 与 `locale/{zh,en}.json`。

### Fixed

- 元信息块此前是缺分隔行的「表格」，在 GFM 里不成立，所有 Markdown 阅读器都会显示成裸竖线；现在输出合法的
  `| 项目 | 内容 |` + `| --- | --- |`。
- 导出文件名在 Windows 上不安全：保留设备名（`CON`/`NUL`/`COM1`…）、末尾的点或空格都会导致文件无法创建；
  `slugify` 现在会处理这几种情况。

### Notes

- 零 `@deepseek-ai/*` 依赖、零 `peerDependencies`，因此不会被 DSH 的插件兼容性闸门拒绝。
- 附件（图片/文件）只记录一行说明，不复制二进制；要原图请用官方 `/export` 的 ZIP。
- 改插件源码后，运行中的 host 不会重新 import，需要重启 `dsh web`；客户端 bundle 只需刷新页面。

[0.1.0]: https://github.com/QIN-SMART/dsh-session-md/releases/tag/v0.1.0
