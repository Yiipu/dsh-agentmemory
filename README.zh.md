# dsh-agentmemory

> **dsh-agentmemory** —— 一个 [DSH](/deepseek-harness)（DeepSeek Harness）的 Cordis 插件，把会话活动桥接到 [agentmemory](https://github.com/rohitg00/agentmemory)，一个本地自托管的记忆守护进程。

[English](README.md) | 中文

插件订阅 DSH 的 **Session 生命周期事件**，把会话活动镜像到 agentmemory 守护进程（REST，默认 `http://localhost:3111`），并向模型暴露 **`memory_recall` / `memory_remember`** 工具。它还通过 **`agent/pre-step`** waterfall 在每会话把记忆窗口注入模型请求一次。

所有配置都来自插件在 `cordis.yml` 里的那一行——编辑该行的 `config`（或承载它的文件）就是改配置。没有浏览器 UI，也没有持久化的配置文件。

> **agentmemory 是硬依赖。** 插件在加载时、注册任何能力（工具、监听器）之前就先检查 `<baseUrl>/agentmemory/livez`。如果守护进程不可达或未报告 `status: ok`，插件会**响亮地加载失败**——绝不静默降级。

## 功能总览

| 能力 | 实现 |
| --- | --- |
| 会话生命周期 → agentmemory | `session/created` → `session/start`；`session/event` → `observe`（缓冲）；`session/flush` → 落库；`session/disposed` → `session/end` |
| 模型工具（读） | `memory_recall` → `POST /agentmemory/search`（按调用会话自动定位 sessionId/project） |
| 模型工具（写） | `memory_remember` → `POST /agentmemory/remember`（决策/偏好/架构事实等） |
| **记忆注入** | 经 `agent/pre-step` waterfall 注入 sourced `user/message`：①**项目 recall**（`form: 'recall'`）每会话把项目级 `/context` 跨会话窗口注入一次；②**自动语义 recall**（`form: 'semantic'`，可选）每条用户消息经 `/smart-search` 召回相关记忆标题注入一次；压缩前可再注入一次，避免项目窗口随历史压缩丢失。前端把每次注入渲染为独立的「上下文注入」块（`ContextMessageNode`） |
| **配置来源** | 只读 `cordis.yml` 行的 `config`；无 UI、无文件持久化 |

## 安装（静态组合）

把 `cordis-row.example.yml` 里的行挂进 host 组合 `cordis.yml`（或 `${DSH_HOME:-$HOME/.dsh}/.agent-presets/<id>/` 下的每会话 preset 组合）。先从 GitHub 把包装进 profile：

```bash
dsh plugin --profile web add github:Yiipu/dsh-agentmemory
```

（本地 dev 检出也可用：`dsh plugin --profile web add /path/to/checkout`。）

然后挂行（`@` 是 YAML 保留标量起始，包名必须加引号）：

```yaml
- insert:
    - id: agentmemory-bridge
      name: "dsh-agentmemory"
      config:
        baseUrl: http://localhost:3111
        enabled: true
```

校验：`node scripts/boot-check.mjs`（7 项，需 daemon 在 :3111）；`node test/smoke.mjs`（端到端，需 daemon 在 :3111）。

> 需要 Node >= 20 和一个 `shell` 能力缝（标准 bash/pwsh 执行器）。

## 硬依赖：daemon 必须在加载时可达

agentmemory 是此插件的**硬依赖**。`apply()` 在注册任何能力之前先用一次 curl 探测 `<baseUrl>/agentmemory/livez`：

- 可达且 `status: ok` → 继续加载；
- 不可达 / 非 ok → **插件加载失败（响亮）**，不静默降级；
- 无 `shell` 缝 → 直接失败。

> 这是**启动时**的硬门。运行期间 daemon 掉线仍被容忍——所有调用只记录、绝不 veto 会话生命周期或模型步。

## 配置键

`baseUrl`、`secret`（见下）、`enabled`（桥接总开关）、`enableTools`、`enableSessionStartEnd`、`curlTimeoutMs`、`observeBatchLimit`、`maxContentChars`、`maxArgsChars`、
`injectContext`（项目 recall 开关，默认 `true`）、`injectContextMaxChars`（默认 `6000`）、`injectContextOnCompaction`（压缩前补注入，默认 `true`）、
`injectSemantic`（自动语义 recall 开关，默认 `false`）、`injectSemanticMaxResults`（默认 `8`）、`injectSemanticMaxChars`（默认 `3000`）。

行里省略的键由 Cordis 按插件的 `Config` schema 填默认值——**不要手写合并逻辑**。Cordis 原生校验：非法值（例如 `curlTimeoutMs: -5`）会让插件**加载失败**并给出明确错误。每个键的完整数值边界（min/max）声明在 `index.js` 里。

### secret：明文或环境变量引用

`secret` 支持两种形式，写不写明文由你决定：

| 形式 | 行为 |
| --- | --- |
| `secret: "xxx"` | 明文，原样用作 Bearer token |
| `secret: '${AGENTMEMORY_SECRET}'` | 读环境变量；未定义 → 加载失败（响亮） |
| `secret: '${AGENTMEMORY_SECRET:default}'` | 读环境变量；未定义 → 用 `default` |
| `secret: '${AGENTMEMORY_SECRET:?goes nowhere}'` | 读环境变量；未定义 → 报错 `goes nowhere` |

环境变量经 `shell` 缝在 `apply()` 开始时解析（沙箱无直接 env 访问）。

## 记忆注入（read side → 模型 + 前端「上下文注入」块）

桥接走 DSH 原生的 **`agent/pre-step`** 注入通道（与 `dsh-time-context` 同一范式），把 sourced `user/message` append 到进入 step 的消息批次尾部。两条注入路线各司其职，都做事件级去重，**不在每个 tool step 重复注入**。

### 路线 1 —— 项目 recall（`form: 'recall'`，默认开）

每会话把 agentmemory 的 **`/context` 项目级跨会话窗口**（「这个项目之前干过啥」，排除当前会话）注入**一次**。`session/created` → `/session/start` 从响应缓存 `context`；`agent/pre-step` 的首个有缓存的 step append 一次（`st.injectedContext` 去重）；每条 `user/message` 仍异步刷新缓存。

### 路线 2 —— 自动语义 recall（`form: 'semantic'`，默认关）

每条 `user/message` 用原文做一次 `/smart-search`（BM25+向量+图），把召回记忆的**标题**组装成一条注入消息（`st.semanticSeq` 逐消息去重）。精确召回（`/search`）仍留给 agent 显式调用 `memory_recall` 工具。

### 压缩前补注入（`injectContextOnCompaction`，默认开）

`compaction/start` 触发一次 `/context` 刷新，并在下一个 `agent/pre-step` 把最新项目窗口再注入一次，避免项目背景随历史压缩丢失。

## 生命周期事件 → agentmemory 映射

桥接把每个 DSH 事件映射成 agentmemory 的 **标准 hookType**，让 daemon 的压缩管线能读到真实内容（自定义 hookType 只会收到 `{timestamp, hookType}`，摘要退化）：

| DSH 事件 | hookType | data 标准字段 | dedup 判别 |
| --- | --- | --- | --- |
| `user/message` | `prompt_submit` | `prompt=content` | `tool_input=content`（同 prompt 自然合并） |
| `assistant/message` | `post_tool_use` | `tool_name='assistant_message'`、`tool_output=content` | `tool_input='#'+seq`（唯一；内容不进 Input） |
| `tool/call` | `dsh_tool_call` | `tool_name='dsh_call'` | `tool_input='call#'+callId`（不与结果合并） |
| `tool/result`（ok） | `post_tool_use` | `tool_name/tool_input/tool_output`（callMeta 兜底） | `tool_input=args` |
| `tool/result`（err） | `post_tool_failure` | 同上 + `error` | `tool_input=args` |
| `turn/end` | `dsh_turn_end` | — | `tool_input='turn#'+seq`（唯一） |

**dedup-safe 设计**：agentmemory 的 `mem::observe` 对 `sha256(sessionId, tool_name||hookType, tool_input[0..500])` 做 5 分钟 TTL 去重，命中即丢弃。桥接用每会话单调 seq 与自然内容/`callId` 做 `tool_input` 判别，保证同类多条都落库，同时保留「相同 prompt / 相同 (tool,args) 结果」的自然合并。

## 模型工具

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `memory_recall` | `query` (必填), `limit?`, `sessionId?`, `project?` | 按调用会话自动定位 sessionId/project，跨会话召回 |
| `memory_remember` | `content` (必填), `type?`, `concepts?`, `ttlDays?` | 主动固化记忆；type ∈ pattern/preference/architecture/bug/workflow/fact |

工具用 `defineTool` 定义、经 `ctx.tools.register` 注册，守护进程传输走 host `shell` seam（`inject: ['tools', 'shell']`）；二者随插件 Fiber 生命周期自动清理。`execute` 失败返回 `{ok:false,error}` 而非抛错。

## Model Experience

### Common requests

#### What the model sees

桥接不改动已接收的输入。它对模型输入的可观察影响是批尾之后的**追加**：每个投影事件附加一条 sourced `user/message`，其 `text` 是项目 `/context` 窗口（路线 1）、语义召回标题（路线 2）、或压缩前的项目窗口再注入（`source.kind === 'plugin'`，`plugin === 'agentmemory'`，`form` 为 `'recall'` / `'semantic'`）。仅当 `enableTools` 为 true 时才注册 `memory_recall` 与 `memory_remember` 工具。

#### Token effect

有条件。注入只在去重边界贡献额外输入 token——项目 recall 每会话一次、开启语义 recall 时每条用户消息一次、每次压缩一次，而非每个 tool step。上限由 `injectContextMaxChars` / `injectSemanticMaxChars` 控制。`enableTools` 为 true 时工具 schema 增加少量固定 token 成本。工具响应正常回到模型的上下文窗口。

#### KV Cache effect

追加式、前缀稳定。注入消息 append 到 step 消息批次的尾部，因此之前的前缀保留且可复用；再注入只改变后缀。去重条件（`injectedContext`、`injectedSemanticKey`、`compactionInject`）防止同一块在同一边界重复追加，所以桥接自身的活动不会使稳定前缀失效。

## 传输与失败语义

- 沙箱无 `fetch`/require/timers；出网走 `shell` 能力缝，每次调用一个 curl，JSON body 走 stdin（`--data-binary @-`）。
- **绝不 veto 生命周期**：监听器全量 try/catch。
- 基础设施失败重排队列、下一个 checkpoint 重试；payload 级失败记录后丢弃。
- flush 竞态：flush 在途时新事件经 `dirty` 标志被在途循环补发，不丢。

## 验证

```bash
cd plugins/agentmemory
node scripts/boot-check.mjs   # 模块 + Config schema + daemon livez + peer deps（7 项）
node test/smoke.mjs           # 端到端（需 daemon 在 :3111）
```

冒烟测试覆盖：Config schema 校验（含非法值拒绝）、apply 的 livez 硬门（含不可达响亮失败）、`defineTool` 工具注册、secret 三种 env 引用、观察落库与 session 状态、`agent/pre-step` 注入形状与水印穿透。

## 本地开发：解析 peer 依赖

插件 import `@deepseek-ai/schemastery`、`@deepseek-ai/dsh-tools`（peer deps，运行时由 harness 安装解析）。要在本仓库用 plain Node 跑 boot-check / smoke 而不装整个 harness，把内置包链进来：

```bash
mkdir -p node_modules
ln -s <harness>/node_modules/@deepseek-ai node_modules/@deepseek-ai
```

（`<harness>` 指 dsh 全局安装目录；在 profile 里经 pnpm 安装时它们自动可解析，无需这一步。）

## 文件

| 文件 | 用途 |
| --- | --- |
| `index.js` | 单一静态入口：`Config` schema、`inject`、`apply`（生命周期 + 工具 + 注入 + livez 硬门） |
| `index.d.ts` | `Config` 类型与插件导出的类型面 |
| `cordis-row.example.yml` | 静态组合行示例（`name` 用可解析包名） |
| `scripts/boot-check.mjs` | 启动/CI 就绪检查（模块 + schema + daemon + peer deps，7 项） |
| `test/smoke.mjs` | 端到端冒烟测试 |
| `package.json` | 可发布结构（`dsh-agentmemory`，含 peer deps） |

## 已知边界

- **记忆默认跨会话共享**（未传 `agentId`）；需要隔离时给 observe/remember 加 `agentId`。
- **project 解析顺序**：`AGENTMEMORY_PROJECT_NAME` 环境变量 → git toplevel basename → cwd basename。
- **未改动任何 `@deepseek-ai` 包**；未改 shipped preset 安装目录。
