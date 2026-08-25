# dsh-agentmemory

> 一个 DSH（DeepSeek Harness）的 Cordis 插件，让每个 dsh 会话都拥有 [agentmemory](https://github.com/rohitg00/agentmemory) —— 一个本地自托管、带 REST API 的记忆守护进程 —— 中的持久、可搜索记忆。

[English](README.md) | 中文

dsh 会话是短暂的：会话一结束，agent 学到的一切——做过的工具调用、恢复过的错误、定下的决策——都随之消失。agentmemory 用跨会话、跨 harness 的持久化解决这一点（它已在服务 Claude Code、OpenCode、Hermes 等）。本插件就是 dsh 侧的那一环：把每个会话的活动**写入** daemon 成为观察记录，在恰当的时机把记忆**读回**模型，并向 agent 暴露显式的**记忆工具**。

一个插件，三个面：

| 面 | 做什么 |
| --- | --- |
| **写**（观察桥） | 把每个 DSH 会话事件映射为 agentmemory **标准 hookType**，让 daemon 的压缩管线、搜索索引、viewer 都能读到真实内容——见[映射注册表](#dsh-事件--agentmemory-映射注册表) |
| **读**（上下文注入） | 经 `agent/pre-step` waterfall 追加 sourced `user/message`：每会话一次的项目 recall 窗口、可选的逐消息语义 recall、压缩前的补注入 |
| **Agent 工具** | `memory_recall` / `memory_remember`，注册为模型工具，用于显式精确召回与主动写入 |

> **agentmemory 是硬依赖。** 插件在加载时、注册任何能力（工具、监听器）之前就先检查 `<baseUrl>/agentmemory/livez`。如果守护进程不可达或未报告 `status: ok`，插件会**加载失败并抛出明确错误**——绝不静默降级。

所有配置都来自插件在 `cordis.yml` 里的那一行——编辑该行的 `config`（或承载它的文件）就是改配置。没有浏览器 UI，也没有持久化的配置文件。

## 安装（静态组合）

先把 agentmemory daemon 跑起来（默认 `http://localhost:3111`）——插件的加载硬门要求它在线。然后从 GitHub 把包装进 profile：

```bash
dsh plugin --profile web add github:Yiipu/dsh-agentmemory
```

（本地 dev 检出也可用：`dsh plugin --profile web add /path/to/checkout`。）

把 [`cordis-row.example.yml`](cordis-row.example.yml) 里的行挂进 host 组合 `cordis.yml`（或 `${DSH_HOME:-$HOME/.dsh}/.agent-presets/<id>/` 下的每会话 preset 组合）。最小行就是 `{name}`——Cordis 按插件的 `Config` schema 校验并填默认值（scoped 包名以 `@` 开头时需加引号，因为 `@` 是 YAML 保留标量起始）：

```yaml
- insert:
    - id: agentmemory-bridge
      name: "dsh-agentmemory"
      config:
        baseUrl: http://localhost:3111
        enabled: true
```

> 需要 Node >= 20 和一个 `shell` 能力接缝（capability seam，标准 bash/pwsh 执行器）。校验命令见[验证](#验证)。

## DSH 事件 → agentmemory 映射注册表

这张表是桥接向 daemon 发送内容的权威注册表。每条观察都使用 agentmemory 的**标准 hookType**——daemon 的 `mem::observe` 只对 `prompt_submit` / `post_tool_use` / `post_tool_failure` 提取可搜索字段（`prompt`、`tool_name`、`tool_input`、`tool_output`）；其他 hookType 的数据留在 `raw.raw`，永远进不了搜索与压缩读取的合成 narrative（title + toolInput/output/prompt）。因此本插件不使用任何自定义 hookType——每条记录都落在 daemon 本就认识的桶里。

| DSH 事件 | agentmemory 调用 | hookType | `data` 字段 | dedup 判别 |
| --- | --- | --- | --- | --- |
| `session/created` | `POST /agentmemory/session/start`（`enableSessionStartEnd` 开启时） | — | `sessionId`、`project`、`cwd`、`agentId`；响应中的 `context` 被缓存用于注入 | — |
| `user/message` | `observe` | `prompt_submit` | `prompt=content`、`source`（另含原始 `content`） | `tool_input=content`（同 prompt 自然合并） |
| `assistant/message` | `observe` | `post_tool_use` | `tool_name='assistant_message'`、`tool_output=content`、`provider`、`model`（另含原始 `content`） | `tool_input='#'+seq`（唯一；内容不进 input） |
| `tool/call` | **不发观察行**（见下） | — | — | — |
| `tool/result`（ok） | `observe` | `post_tool_use` | 来自 `callMeta` stash 的 `tool_name`/`tool_input`/`tool_output`（事件字段兜底），另含 `callId` 与原始 `content` | `tool_input=args` |
| `tool/result`（err） | `observe` | `post_tool_failure` | 同上，另加 `isError: true` 与 `errorName` | `tool_input=args` |
| `turn/end` | `observe` | `post_tool_use` | `tool_name='turn_end'`、`tool_output=reason`（如 `completed`） | `tool_input='turn#'+seq`（唯一） |
| `approval/asked` | `observe` | `notification` | `notification_type='permission_prompt'` + `tool_name`、`request_id`、`call_id`、`reason` | 无 `tool_input`：dedup 哈希覆盖整个 `data`，其中唯一的 request id 区分不同审批 |
| `compaction/start` | `POST /agentmemory/context` 刷新 + 补注入标记（`injectContext` + `injectContextOnCompaction` 开启时） | — | — | — |
| `compaction/summary` | `POST /agentmemory/remember`（`compactionBridge` 开启时） | — | `content='[dsh compaction] '+summary`、`type='fact'`、`concepts=['compaction']` | — |
| `session/flush` | 缓冲观察落库 | — | — | — |
| `session/disposed` | 最终 flush；`POST /agentmemory/session/end`（`enableSessionStartEnd` 开启时） | — | — | — |

未列出的事件（boundaries、chunks、todo/write、request/*）是纯日志噪音，不产生任何输出。

### 为什么 `tool/call` 不发观察行

`tool/result` 行已经携带 name + args（经 `callMeta`，在 call 事件经过时 stash）加上输出，合成一条标准 `post_tool_use`。单独的 call 行要么落在 daemon 提取的字段范围之外（自定义 hookType → 空 narrative、不可搜索），要么与结果行撞 dedup key（相同 `tool_name` + args）导致结果行的输出被静默丢弃。所以 call 被记录，但只作为结果行的元数据。

### 为什么 `turn/end` 借壳 `post_tool_use`

纯粹为了让 turn 的 `reason` 进 `tool_output`、从而进可搜索的合成 narrative——自定义 hookType 会让它不可见。`assistant/message` 对其内容做同样的事。

### 为什么 `approval/asked` 映射为 `notification`

`notification` 正是 Claude Code 的 Notification hook 与 OpenCode 的 permission 事件产生的 hookType，dsh 的审批提示因此落入 daemon 本就认识的同一个类型化、可渲染桶。daemon 设计上不对 notification 做内容索引，所以这里的字段无需为提取而摆放。

### 为什么 `compaction/summary` 走 `/remember`

蒸馏出的摘要是免费的、daemon 侧的记忆——把它持久化为 durable fact，意味着它在产生它的那次历史压缩之后依然存活，而不是随被压缩的 transcript 一起消亡。上限 6000 字符，`compactionBridge: false` 可关闭。

### Dedup-safe 设计

agentmemory 的 `mem::observe` 对 `sha256(sessionId, tool_name||hookType, tool_input[0..500])` 做 5 分钟 TTL 去重，命中即整条丢弃。桥接用每会话单调 `seq` 与自然内容/`callId` 做 `tool_input` 判别，保证同类多条都落库，同时保留「相同 prompt / 相同 (tool,args) 结果」的自然合并。

## 记忆注入（读侧）

桥接走 DSH 原生的 **`agent/pre-step`** 注入通道（与 harness 内置的 `dsh-time-context` 插件同一范式），把 sourced `user/message` append 到进入 step 的消息批次尾部。两条路线都做事件级去重，**不在每个 tool step 重复注入**。前端把每次注入渲染为独立的「上下文注入」块（`ContextMessageNode`）。

### 路线 1 —— 项目 recall（`form: 'recall'`，默认开）

每会话把 agentmemory 的 **`/context` 项目级跨会话窗口**（「这个项目之前干过啥」，排除当前会话）注入**一次**。`session/created` → `/session/start` 从响应缓存 `context`；`agent/pre-step` 的首个有缓存的 step append 一次（`injectedContext` 去重）；每条 `user/message` 仍异步刷新缓存。

### 路线 2 —— 语义 recall（`form: 'semantic'`，默认关）

每条 `user/message` 用原文做一次 `/smart-search`（BM25+向量+图），把召回记忆的**标题**组装成一条注入消息（`semanticSeq` 逐消息去重）。精确召回（`/search`）仍留给 agent 显式调用 `memory_recall` 工具。

### 压缩前补注入（`injectContextOnCompaction`，默认开）

`compaction/start` 触发一次 `/context` 刷新，并在下一个 `agent/pre-step` 把最新项目窗口再注入一次，避免项目背景随历史压缩丢失。

## 模型工具

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `memory_recall` | `query` (必填), `limit?`, `project?`, `agentId?` | 按调用会话自动定位 project，跨会话召回。按 project 过滤，可选按 `agentId`（不传 = 项目的所有 agent，包含历史无 agent 的记录）。写入的记录都带插件 agentId：env `AGENT_ID` → config `agentId` → 默认 `"dsh"` |
| `memory_remember` | `content` (必填), `type?`, `concepts?`, `ttlDays?` | 主动固化记忆；type ∈ pattern/preference/architecture/bug/workflow/fact |

工具用 `defineTool` 定义、经 `ctx.tools.register` 注册，守护进程传输走 host `shell` seam（`inject: ['tools', 'shell']`）；二者随插件 Fiber 生命周期自动清理。`execute` 失败返回 `{ok:false,error}` 而非抛错。

## 配置键

`baseUrl`、`secret`（见下）、`enabled`（生命周期桥总开关：false 时不再产生观察、session 行与注入数据源，模型工具仍可用）、`enableTools`、`enableSessionStartEnd`（镜像 `session/start` 与 `session/end` 行）、`compactionBridge`（经 `/remember` 持久化压缩摘要，默认 `true`）、`agentId`（写入行的身份标识，默认 `"dsh"`）、`curlTimeoutMs`、`observeBatchLimit`、`maxContentChars`、`maxArgsChars`、
`injectContext`（项目 recall 开关，默认 `true`）、`injectContextMaxChars`（默认 `6000`）、`injectContextOnCompaction`（压缩前补注入，默认 `true`）、
`injectSemantic`（语义 recall 开关，默认 `false`）、`injectSemanticMaxResults`（默认 `8`）、`injectSemanticMaxChars`（默认 `3000`）。

行里省略的键由 Cordis 按插件的 `Config` schema 填默认值——**不要手写合并逻辑**。Cordis 原生校验：非法值（例如 `curlTimeoutMs: -5`）会让插件**加载失败**并给出明确错误。每个键的完整数值边界（min/max）声明在 `index.js` 里。

### secret：明文或环境变量引用

`secret` 支持两种形式——明文或环境变量引用（后者有三种变体），写不写明文由你决定：

| 形式 | 行为 |
| --- | --- |
| `secret: "xxx"` | 明文，原样用作 Bearer token |
| `secret: '${AGENTMEMORY_SECRET}'` | 读环境变量；未定义 → 加载失败并报错 |
| `secret: '${AGENTMEMORY_SECRET:default}'` | 读环境变量；未定义 → 用 `default` |
| `secret: '${AGENTMEMORY_SECRET:?goes nowhere}'` | 读环境变量；未定义 → 报错 `goes nowhere` |

环境变量经 `shell` 能力接缝在 `apply()` 开始时解析（沙箱无直接 env 访问）。

## 模型体验

**模型看到什么。** 桥接不改动已接收的输入。它对模型输入的可观察影响是批尾之后的**追加**：每个去重边界附加一条 sourced `user/message`，其 `text` 是项目 `/context` 窗口（路线 1）、语义召回标题（路线 2）、或压缩前的项目窗口再注入（`source.kind === 'plugin'`，`plugin === 'agentmemory'`，`form` 为 `'recall'` / `'semantic'`）。仅当 `enableTools` 为 true 时才注册 `memory_recall` 与 `memory_remember` 工具。

**Token 影响。** 有条件。注入只在去重边界贡献额外输入 token——项目 recall 每会话一次、开启语义 recall 时每条用户消息一次、每次压缩一次，而非每个 tool step。上限由 `injectContextMaxChars` / `injectSemanticMaxChars` 控制。`enableTools` 为 true 时工具 schema 增加少量固定 token 成本。工具响应正常回到模型的上下文窗口。

**KV cache 影响。** 追加式、前缀稳定。注入消息 append 到 step 消息批次的尾部，因此之前的前缀保留且可复用；再注入只改变后缀。去重条件（`injectedContext`、`injectedSemanticKey`、`compactionInject`）防止同一块在同一边界重复追加，所以桥接自身的活动不会使稳定前缀失效。

## 传输与失败语义

- 沙箱无 `fetch`/require/timers；出网走 `shell` 能力接缝，每次调用一个 curl，JSON body 走 stdin（`--data-binary @-`）。
- **绝不 veto 生命周期**：监听器全量 try/catch 防护；工具调用尊重 `AbortSignal`。
- 基础设施失败重排队列、下一个 checkpoint 重试；payload 级失败记录后丢弃。
- flush 竞态：flush 在途时新事件经 `dirty` 标志被在途循环补发，不丢。

## 验证

```bash
node scripts/boot-check.mjs   # 模块 + Config schema + daemon livez + peer deps（7 项）
node test/smoke.mjs           # 端到端（需 daemon 在 :3111）
```

冒烟测试覆盖上表注册表的全部内容：schema 校验、livez 硬门、工具注册、secret 三种 env 引用、观察落库（title/type/narrative 形状）、approval → notification 行、`turn/end` reason 可在 narrative 搜索、无幽灵 `tool/call` 行、compaction → `/remember` 桥接、以及 `agent/pre-step` 注入形状。

本地开发——peer 依赖链接、冒烟 fixture 清理、ESM 缓存——见 [DEVELOPMENT.md](DEVELOPMENT.md)。

## 已知边界

- **工具侧与桥接侧的 project 解析不一致**：观察桥按 `AGENTMEMORY_PROJECT_NAME` 环境变量 → git toplevel → cwd basename 解析 project，而 `memory_recall` / `memory_remember` 默认只取会话 cwd basename。当会话 cwd 位于 git 仓库子目录时，观察落在 toplevel 项目名下、工具却查 cwd basename——此时请显式传 `project`。
- **记忆默认跨会话共享**（观察记录打的是插件 agentId，不是 DSH session id）；需要隔离某个 agent 时，设置 `agentId` 或让 `memory_recall` 按它过滤。
- **Agent 隔离为可选**：写入记录都带插件 agentId（env `AGENT_ID` → config `agentId` → 默认 `"dsh"`）；早于 agentId 标记功能的插件版本写入的记录 `agentId` 为 undefined，不传过滤时仍可召回。
- **未改动任何 `@deepseek-ai` 包**；未改动随 dsh 发布的 preset 安装目录。
