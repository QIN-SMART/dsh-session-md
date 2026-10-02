# dsh-session-md

[![verify](https://github.com/QIN-SMART/dsh-session-md/actions/workflows/verify.yml/badge.svg)](https://github.com/QIN-SMART/dsh-session-md/actions/workflows/verify.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> DSH 插件：把一次会话导出成**人读的 Markdown 或自包含 HTML**（按 Turn 分组：用户消息 / 助手回复 / 思维链 /
> 工具调用与结果 / 待办 / 压缩摘要 / 交付文件），直接发给别人、贴周报、存归档都行。
> 官方 `@deepseek-ai/dsh-session-log-export` 只给 raw JSONL 的 ZIP，本插件补齐「一段对话一份干净文档」的缺口。

English → [README_EN.md](README_EN.md)

![导出效果](docs/demo.png)

*上图为合成会话的导出效果（`scripts/make-demo-screenshot.mjs` 生成，不含任何真实会话内容）。*

---

## 安装

```sh
dsh plugin --profile web add github:QIN-SMART/dsh-session-md
```

插件声明了 `dsh.bundle.patch`，`add` 会自动把 `session-md` 这一行写进 profile 的 patch 层，无需手工编辑
`cordis.yml`。装完**刷新浏览器页面**即可看到会话标题栏的导出菜单。

> 改了插件源码之后，运行中的 host 不会重新 import 已加载的模块，需要重启 `dsh web`；只刷新页面只能更新浏览器半边。

零 `@deepseek-ai/*` 依赖、零 `peerDependencies`，因此 DSH 的插件兼容性闸门（`evaluatePluginCompatibility`）
没有任何可拒绝的项。Node 版本要求 `^22.19.0 || >=24`。

### 三个平台

Windows / macOS / Linux 行为一致：写进会话工作区的导出走 `ctx.fs`（受会话沙箱约束），浏览器下载走认证路由
（落点由浏览器决定）。文件名统一由 `slugify` 处理：Windows 禁止的 `\ / : * ? " < > |`、控制字符、
**末尾的点或空格**、以及 `CON` / `NUL` / `COM1` 这类保留设备名都不会出现，导出在 Windows 上不会因为文件名写不出来。
CI 在 ubuntu / windows / macos × Node 22/24 上跑同一套自测。

## 开发本仓库

```sh
git clone https://github.com/QIN-SMART/dsh-session-md
cd dsh-session-md
node --test test/verify.mjs     # 自测（零依赖，不需要 DSH）
npm run ci                     # 上面这些 + 夹具 / 浏览器半 / 真实 Cordis / 真实会话巡检（缺会话日志时自动跳过）
npm run dump -- --list         # 离线把会话日志转成 Markdown，不启动 DSH
dsh plugin --profile web add "link:$PWD"   # 本机联调；PowerShell 里路径要加引号
```

给编码 agent 的约定（结构、硬约束、常用命令、隐私红线）见 [AGENTS.md](AGENTS.md)。


## 热插拔（Cordis 生命周期）

**插件本体是标准 Cordis 插件，支持热插拔**，实测证据在 `scripts/hotplug-test.mjs`：用 DSH 自带的真实
`@deepseek-ai/cordis` **按 loader 的规则**（`exports.default ?? exports`）装载本插件、挂上 stub 服务并真的执行一次导出，
`load → unload → load` 全绿——卸载插件 fiber 时工具立刻从注册表消失，重新装载不会撞重复名，
执行期间访问任何未声明的服务会当场抛错。

两条踩过的坑，现在都有回归测试盯着：

1. **绝对不能有 `export default`**。`cordis-plugin-loader` 对模块做 `exports = exports.default ?? exports`，
   一旦有 default 导出，loader 拿到的就是**裸 `apply` 函数**，`name` / `inject` 被丢掉，挂载时报
   `cannot get property "tools" without inject`。DSH 自家包一律只做具名导出（`export { apply, inject, name }`）。
2. **读 `ctx.<service>` 必须先 `inject`**。Cordis 对**任何**未声明的属性读取都会抛（连不存在的名字也抛），
   可选链 `?.` 救不了。所以四个真正依赖的服务（`tools` / `sessions` / `sessionPersistence` / `fs`）写进
   `inject`，只有真正可选的 `sandboxPolicy` 走 `ctx.get('sandboxPolicy')`——`ctx.get` 不要求 inject，缺失时返回 `undefined`。

机制：Cordis 的 `Service` 用 tracker 把 `this.ctx` 解析成**调用方上下文**，而 `ctx.tools.register()`
内部就是 `layers.effect(this.ctx, …)`，所以注册被记在**我这条插件 fiber** 的 effect 上。
这也解释了为什么 `register()` 的返回值不接住也不会泄漏（DSH 自家的 `dsh-tool-todo` / `dsh-tool-present`
/ `dsh-tool-jobs` 同样不接）。插件本身没有模块级可变状态、没有 `setInterval`、没有 `ctx.on` 监听、
不注册任何服务，`apply` 可重复执行，唯一动作就是一次可销毁的注册。

一处需要注意：**"插件可热插拔" ≠ "新装的 bundle 行会立刻出现"**。`dsh plugin add` 写入的是
`package.json` 的 `dsh.profile.bundles` 与 `node_modules` 链接；运行中的 host 是在**组合 profile 树那一刻**
把 bundle patch 里的 `session-md` 行 mount 进去的。`scripts/compose-check.mjs` 在一次性 `DSH_HOME` 里
复现组合（不碰真实 `~/.dsh`）并断言该行存在，所以下次 boot 一定会挂载；而在**已运行的进程**里是否立刻生效，
取决于 host 侧 HMR 是否重放了 profile manifest（本机这次没有，`cordis.yml` 未被重新 materialize）。

## 用法

### 方式一：界面按钮（一点即下载）

会话标题栏右侧的更多操作区（和官方「下载 Session 日志」同一处）有一个 ⬇ 图标按钮，点开是**模式菜单**：

| 菜单项 | 下载的文档 |
|---|---|
| 全部（给 agent 接手/复现） | `mode=full`：工具参数与结果都在 |
| 交接版（保留工具调用，去掉思维链） | `mode=handoff`：省 token 的接手版 |
| 简洁（人读，工具只留名字） | `mode=readable`：最短 |
| 审计版（不截断 + 系统提示词 + 注入上下文） | `mode=audit`：留档用 |
| 两份都要（全部 + 简洁） | 连续下载 `full` 与 `readable` 两份 |
| HTML·全部（自包含，可打印成 PDF） | `format=html&mode=full` |
| HTML·简洁（人读） | `format=html&mode=readable` |

文件名由 Host 的 `Content-Disposition` 指定（中文标题也能正确命名）；`两份都要` 会让浏览器下两个文件
（Chrome 首次会问「是否允许下载多个文件」）。底层是认证下载路由 `GET|HEAD /api/session.export-md?sessionId=…&mode=…&format=md|html`。

> 浏览器下载由浏览器决定落点，因此不受会话文件沙箱限制；需要**写进会话工作区**时用下面的工具。

### 导出模式

四种模式就是四组渲染预设，工具与按钮共用同一套实现（`lib/render.mjs` 的 `MODES`）：

| 模式 | 工具调用 | 思维链 | 系统提示词 / 注入上下文 | 截断 |
|---|---|---|---|---|
| `full` 全部 | 参数 + 结果 | 保留 | 不含 | 参数 4k / 结果 20k / 思考 20k 字符 |
| `handoff` 交接 | 参数 + 结果 | **去掉** | 不含 | 参数 1.5k / 结果 4k |
| `readable` 简洁 | **只留名字** | 保留（折叠） | 不含 | 思考 6k |
| `audit` 审计 | 参数 + 结果 | 保留 | **都含** | **不截断** |
| `both` 两份 | — | — | — | 写出 `full` + `readable` 两个文件 |

显式参数永远覆盖模式（例如 `mode: 'readable'` 同时给 `includeToolDetails: true`）。

### 方式二：让模型导出（写进工作区）

对模型说「把这个对话导出成 md」，模型会调用工具：

```text
export_session_md({})                                   # 当前会话 → 会话工作目录/<sessionId>.md
export_session_md({ path: '/abs/dir' })                 # 指定目录
export_session_md({ path: '/abs/dir/chat.md' })         # 指定文件（单会话）
export_session_md({ includeToolDetails: false })        # 对外分享的干净版：工具只留名字
export_session_md({ all: true, path: '/abs/dir' })      # 批量导出全部会话（含子会话）
export_session_md({ sessionId: 'session-xxxx' })        # 指定会话（冷会话也能读）
```

### 参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `mode` | `full` | `full` / `handoff` / `readable` / `audit` / `both`，见上文「导出模式」 |
| `format` | `md` | `md` 或 `html`（自包含单文件，可直接发给别人 / 打印成 PDF） |
| `sessionId` | 当前会话 | 要导出的会话 id；不在内存中的已持久化会话同样可读 |
| `all` | `false` | 导出本进程可见的全部会话（根会话 + 各自子会话） |
| `path` | 会话工作目录 | 以 `.md` 结尾视为精确文件（仅单会话）；否则视为目录 |
| `includeSubagents` | `true` | 子代理会话写到 `<sessionId>.subagents/` |
| `includeToolDetails` | `true` | `false` = 只保留工具名（隐藏参数与结果），适合发人 |
| `includeReasoning` | `true` | 是否包含思维链（默认折叠在 `<details>` 里） |
| `includeSystemPrompt` | `false` | 是否附上系统提示词 |
| `includeInjectedContext` | `false` | 是否包含机器注入的 user 角色上下文（时间、运行时、技能目录、记忆等） |
| `maxToolResultChars` | `4000` | 单个工具结果截断上限 |
| `maxToolArgChars` | `1200` | 单个工具参数截断上限 |
| `maxReasoningChars` | `8000` | 单个思维链块截断上限 |

默认输出（`includeToolDetails: true`）适合复盘；`includeToolDetails: false` 是「干净分享版」，
体积通常只有几十分之一（实测同一会话 467 KB → 14.5 KB）。

## 产出长什么样

```markdown
# <会话标题>

| 会话 | `session-xxxx` |
| 创建时间 | 2026-09-30 14:55 |
| 模型 | `deepseek-official/deepseek-flash` |
| 工作目录 | `/path/to/your/project` |
| 规模 | 3 轮 · 754 事件 |
| 用量 | 输入 ... · 输出 ... · 合计 ... tokens（按事件累计） |

## Turn 1

### 👤 用户

<用户正文>

### 🤖 助手

<助手正文>

<details><summary>🧠 思考过程</summary> ... </details>
<details><summary>🔧 工具调用：`bash` · 列出文件</summary>

**参数** ```json ... ```
**结果** ```text ... ```

</details>
```

另外会渲染 `📝 待办清单`、`🗜️ 上下文压缩摘要`、`📦 交付文件`、`🤝 协作消息（agent-message / team-message / subagent-report）`，
末尾补一节 `## 未完成的工具调用`，用于标注被中断、没有结果的调用。

## 离线验证

```sh
npm run check   # = render-test + client-test + hotplug-test + render-check + plugin-smoke + compose-check
```

- `test/verify.mjs` — `node --test` 12 项：模块形状与无 `default` 导出、清单/图标/locale 元数据、模式预设与覆盖、
  每个模式实际渲染出的内容、工具 `both` 写两份、下载路由四种模式与 `400/404`、浏览器半菜单与 URL 生成。
- `scripts/render-test.mjs` — 合成夹具单测 14 项：标题/元信息表、Turn 分组、思维链、工具参数与结果、附件行、
  待办、压缩摘要、交付文件、错误与中断、选项开关、截断、文件名 slug。
- `scripts/render-check.mjs` — 语料巡检：把本机 `~/.dsh/sessions` 下**全部真实会话**渲染一遍并做结构断言
  （H1、元信息表、代码围栏平衡、`<details>` 平衡且必有 `<summary>`、标题层级、确定性、选项方向、耗时）。
  最近一次：**132 个会话、97,431 个事件、29.9 MB Markdown、0 失败、最慢单篇 61 ms**。
- `scripts/client-test.mjs` — 浏览器侧 6 项（不需要浏览器）：用假的 `window.__ModuleLoader__` / `document` / React
  加载 `lib/client.js`，断言注册 id、挂到 Session Header 槽位、渲染无障碍按钮、点击生成正确的下载 URL 与 ⌥ 干净版 URL。
- `scripts/hotplug-test.mjs` — 真实 Cordis 集成 11 项：按 loader 规则解析模块（**断言没有 default 导出**）、
  校验 `dsh.client.inject` 里每个模块都真有浏览器 half、装载/卸载/重装、卸载无残留、并发重复装载被拒绝，
  在真实 cordis context（stub 服务复刻真实契约）里**实际执行导出**（活会话 + 冷会话），并断言下载路由注册、
  `clean` 开关、`HEAD` 空体、`400/404` 与**卸载后路由随之消失**。
- `scripts/plugin-smoke.mjs` — 端到端：用 stub cordis context（`sessions` / `sessionPersistence` 由真实日志支撑）
  装载 `index.mjs`，执行注册出来的工具，验证参数处理、活/冷会话读取、子会话收集、路径解析、落盘、输出 schema、
  错误信息，共 7 项。
- `scripts/compose-check.mjs` — 组合检查：把真实 profile 复制到一次性 `DSH_HOME`（`node_modules` 只软链），
  `dsh --dump-config` 断言 `- id: session-md / name: dsh-session-md` 确实出现在组合树里、未被兼容性闸门跳过，
  并校验 `files[]` 与 `lib/` 完整；真实 `~/.dsh` 全程只读。

离线单跑一篇文章：

```sh
node scripts/dump.mjs --list                      # 最近的会话
node scripts/dump.mjs --session cd0e5114 --out a.md
node scripts/dump.mjs --session cd0e5114 --clean --out share.md
```

## 设计要点

- **不读文件格式，只走服务。** 会话内容来自 `ctx.sessions`（活会话，导出前先 `flush`，因此包含刚发生的工具调用）
  与 `ctx.sessionPersistence`（已持久化会话），不解析 `.jsonl.zstd`，所以物理格式升级不影响它。
  离线脚本里的 zstd 解码仅用于开发验证（DSH 是**多帧拼接**写入，必须逐帧解，`zstdDecompressSync` 默认只解第一帧）。
- **写入受沙箱约束。** 走 `ctx.fs` + `resolve`/`writeText`，并带上调用方会话自己的 `sandboxPolicy`
  （`ctx.sandboxPolicy.resolve({ session })`），显式写意图 `createIfAbsent` / `replaceIfVersion` 保证并发安全、
  且不绕过「先读后写」策略。
- **内容不能破坏文档结构。** 会话正文里出现的 `<details>` / `<summary>` 会被转义（围栏内除外），
  正文里**未闭合的代码围栏**会被转义成字面反引号；平衡的代码块原样保留。正文标题统一下沉三级，
  避免与 `## Turn N` / `### 👤 用户` 抢层级。这些正是 132 个真实会话巡检抓出来的问题。
- **零依赖换来零兼容风险。** 工具定义按 `dsh-tools` 的 `ToolDefinition` 契约手写
  （`name` / `description` / `parameters`(JSON Schema) / `output.schema|render` / `execute`），
  不 import `@deepseek-ai/dsh-tools`，也不声明 peer，因此在 0.2.0-rc.1 上不会被 fail-closed。

## HTML 导出（已实现）

`format: 'html'`（工具）或菜单里的两项 HTML（界面）会输出**自包含单文件**：内联 CSS、无任何外部请求
（无外链字体/脚本/图片），跟随系统深浅色，顶部有「全部展开」按钮。

- **打印成 PDF**：打开 HTML → ⌘P → 存储为 PDF。打印样式会把 `<details>` 展开，
  所以思维链与工具调用**不会**被印成空壳（这一点做了实测验证）。
- **实现**：`lib/html.mjs` 是零依赖的 Markdown→HTML 渲染器，只吃本插件自己生成的语法子集
  （标题 / GFM 表格 / 围栏代码 / 引用 / 列表 / 任务列表 / 引用块 / `<details>` / 行内格式），
  内容一律转义，链接只允许 `http(s)`/`mailto`/相对地址。
- **不做一键 PDF**：宿主侧 headless Chrome 是可行的（本机已装 Chrome），但要多探测三平台路径、拉子进程，
  且检测不到时仍要退回打印。按你的选择，这一版只做 HTML；要 PDF 就 ⌘P 一下。

> 顺带修掉一个真 bug：元信息块原本是**缺分隔行**的「表格」，在 GFM 里根本不成立，
> 所有 Markdown 阅读器里都会显示成裸竖线。现在输出合法的 `| 项目 | 内容 |` + `| --- | --- |`。

## 已知边界

- **附件只留说明行。** 图片/文件按 `📎 图片：shot.png，401 KB，1170×827（sha256:…）` 记录，不复制二进制。
  需要原图请用官方 `/export`（ZIP 里含 `media/`、`files/`）。
- **导出位置受沙箱限制。** 默认写在会话工作目录内；写工作区外（如 `/tmp`）会被文件沙箱按当前会话策略拒绝，
  这是有意为之，不是 bug。
- **不做 HTML。** 需要自包含 HTML 时可另加 `format` 参数（当前未实现）。
- **`all: true` 的根会话判定** 是「父会话不在可见集合内」，导入的孤立会话也会被当作根。

## 与第三方替代品的关系

npm 上 `@dsh-suite/plugin-session-export@0.2.0` 功能相近（提供 `export_session` 工具 + HTML），
但它声明 `@deepseek-ai/dsh-session@^0.1.0-rc.6`、`@deepseek-ai/dsh-tools@^0.1.0-rc.6`，
`^0.1.x` 在语义化版本上排除了 `0.2.0-rc.1`，实测 `semver.satisfies('0.2.0-rc.1', '^0.1.0-rc.6') === false`，
所以在 DSH 0.2.0-rc.1 上会被 `evaluatePluginCompatibility` fail-closed 拒绝，除非授予精确版本豁免
（`dsh plugin --profile web allow-version … --accept-risk`）。本插件是零依赖重写，工具名用 `export_session_md`
以避免与它冲突，两者可以并存。

## 文件

```text
index.mjs               # 宿主半：export_session_md 工具 + /api/session.export-md 下载路由
lib/render.mjs          # 纯函数：SessionEvent[] → Markdown（无 IO、无 DSH 依赖）
lib/html.mjs            # 纯函数：Markdown → 自包含 HTML（打印时展开折叠块）
lib/client.js           # 浏览器半：Session Header 的「导出为 Markdown」模式菜单
locale/{zh,en}.json     # 插件列表显示用的标题/描述（icon.svg 在根目录）
cordis.patch.yml        # bundle patch：insert 一行 session-md
test/verify.mjs         # node --test 主自测（19 项，零依赖）
scripts/                # 夹具渲染 / 浏览器半 / 真实 Cordis / 真实会话巡检 / profile 组合 / 离线 dump
tools/publish-to-github.mjs  # 走 REST API 发布（--release 打 tag + 建 Release）
docs/demo.{html,png}    # 合成数据的样例与截图
AGENTS.md               # 给编码 agent 的约定（结构 / 硬约束 / 隐私红线）
```

## License

MIT
