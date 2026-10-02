# dsh-session-md — agent 约定

**DSH 会话导出插件**：把一次会话导出成人读的 Markdown 或自包含 HTML（工具 `export_session_md` + 会话标题栏的
模式菜单 + 认证下载路由 `/api/session.export-md`）。仓库根就是 npm 包根（`package.json` 在第一层）。

给任何编码 agent（Codex / Claude Code / Cursor / DSH 自身）读；动手前先扫下面的硬约束。

## 结构

| 文件 | 作用 |
|---|---|
| `package.json` | 清单：`dsh.bundle.patch`、`dsh.client.platform`、`exports`、`icon`、`files` 白名单 |
| `cordis.patch.yml` | 一行 `insert`，让本包成为 enabled 的 Loader entry（id `session-md`） |
| `index.mjs` | 宿主半：注册 `export_session_md` 工具 + 认证下载路由 |
| `lib/render.mjs` | 纯函数：`SessionEvent[]` → Markdown（无 IO、无 DSH 依赖），含 `MODES` 预设与 `slugify` |
| `lib/html.mjs` | 纯函数：Markdown → 自包含 HTML（内联 CSS + 打印时展开 `<details>`） |
| `lib/client.js` | 浏览器半：`window.__ModuleLoader__.load({ id: 'dsh-session-md', factory })`，会话标题栏的模式菜单 |
| `locale/{en,zh}.json` | 插件列表里的标题/描述（en 是解析锚点） |
| `test/verify.mjs` | `node --test` 主自测（零依赖，不需要 DSH） |
| `scripts/*.mjs` | 夹具渲染、浏览器半、真实 Cordis、真实会话巡检、profile 组合检查、离线 dump |
| `tools/publish-to-github.mjs` | 走 GitHub REST API 发布（空仓库自动引导；`--release` 打 tag + 建 Release） |

## 关键标识（改名/重构时必须一起改）

| 项 | 值 |
|---|---|
| `ModuleLoader.load({ id })` | `dsh-session-md`（**必须等于 package.json 的 name**） |
| 宿主工具名 | `export_session_md` |
| 下载路由 | `/api/session.export-md`（查询参数 `sessionId` / `mode` / `format`） |
| Loader entry id | `session-md` |
| 模式 | `full` / `handoff` / `readable` / `audit` / `both` |
| 输出格式 | `md` / `html` |

## 硬约束（踩过的，逐条有现场）

1. **绝不 `export default`**：`cordis-plugin-loader` 会做 `exports = exports.default ?? exports`，default 会替换整个
   插件对象，`name` / `inject` 静默丢失，挂载即报 `cannot get property "tools" without inject`。只做平铺导出。
2. **凡读 `ctx.<service>` 必须先写进 `inject`**：Cordis 对任何未声明属性读取都抛错（连不存在的名字也抛），
   可选链救不了。可选依赖用 `ctx.get('name')`，晚提供的依赖用 `ctx.inject([...], cb)`。
3. **注册 Web 路由不要用一次性 `ctx.get('connection')`**：真实 web profile 里 `connection` 在 bundle 插件 apply
   之后才 provide，那一刻是 `undefined`，整段注册被静默跳过、按钮 404。必须 `ctx.inject(['connection'], scope => ...)`。
4. **`ctx.effect` 里注册，卸载才干净**：工具用 `ctx.tools.register`（fiber 绑定），路由用 `scope.effect(...)`。
5. **内容不能破坏文档结构**：正文里的 `<details>` / `<summary>` 转义；未闭合的代码围栏转义成字面反引号；
   正文标题下沉三级。改渲染器后必须跑 `scripts/render-check.mjs` 扫真实会话。
6. **Markdown 表格必须有分隔行**：缺 `| --- | --- |` 的「表格」在 GFM 里不成立，所有阅读器都显示成裸竖线。
7. **文件名要 Windows 安全**：`slugify` 处理 `\ / : * ? " < > |`、控制字符、末尾点/空格、`CON`/`NUL`/`COM1` 等保留名。
8. **不要在生产代码里拉子进程**：没有跨平台的 shell 假设问题（`where` vs `which`）留给 `scripts/` 里的 dev 脚本，
   并且它们在没有 DSH 会话日志时必须**打印 skip 并退出 0**（CI 上跑）。

## 常用命令

```sh
node --test test/verify.mjs                          # 自测
npm run ci                                           # 自测 + 夹具/浏览器半/真实 Cordis/真实会话巡检/profile 组合
npm run dump -- --session <id> --out a.md            # 离线导出（不启动 DSH）
GH_TOKEN=<PAT> npm run publish:github -- --release   # 推 GitHub + 打 tag + 建 Release（PAT 需 repo + workflow scope）
```

改插件源码后：重启 `dsh web` 才生效（host 半不会重新 import）；客户端 bundle 只需刷新页面。

## 隐私红线

`docs/` 只放**合成数据**的截图（`scripts/make-demo-screenshot.mjs` 生成）；真实会话截图会拍到真实标题与路径，
一律不入库。提交前扫一遍：

```sh
grep -rn "/Users/\|/home/" --exclude-dir=.git --exclude-dir=node_modules .
```

更完整的契约、踩坑库与验收清单见 DSH 的 `dsh-plugin-authoring` skill。
