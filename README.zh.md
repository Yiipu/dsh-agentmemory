# dsh-agentmemory

> 一个 DSH（DeepSeek Harness）的 Cordis 插件，让每个 dsh 会话都拥有 [agentmemory](https://github.com/rohitg00/agentmemory) —— 一个本地自托管、带 REST API 的记忆守护进程 —— 中的持久、可搜索记忆。

[English](README.md) | 中文

> **⚠️ 已废弃。** 本插件不再维护。agentmemory 0.9.29+ 自带官方 dsh 连接器，请迁移：
>
> ```bash
> agentmemory connect dsh --with-hooks
> ```
>
> 官方连接器提供自动捕获（hook 经第一方 `dsh-hooks-claude-code` 桥接）与 MCP 记忆工具；本插件的 `agent/pre-step` 上下文注入无官方等价物。已写入的记忆与观察留在 daemon 中（按 project/agentId 组织），迁移后仍可查询——但官方连接器写入的 project/agentId 可能与本插件不同（本插件用 git toplevel 项目名、`dsh` agentId）。过渡期内每个 profile 二选一：daemon 去重无法合并两路捕获，同时开启会产生重复行。

dsh 会话是短暂的：会话一结束，agent 学到的一切——做过的工具调用、恢复过的错误、定下的决策——都随之消失。agentmemory 用跨会话、跨 harness 的持久化解决这一点（它已在服务 Claude Code、OpenCode、Hermes 等）。本插件就是 dsh 侧的那一环：把每个会话的活动**写入** daemon 成为观察记录，在恰当的时机把记忆**读回**模型，并向 agent 暴露显式的**记忆工具**。

一个插件，三个面：

| 面            | 做什么                                                                                                                   |
| ------------ | --------------------------------------------------------------------------------------------------------------------- |
| **写**（观察桥）   | 把每个 DSH 会话事件映射为 agentmemory **标准 hookType**，让 daemon 的压缩管线、搜索索引、viewer 都能读到真实内容——见[映射注册表](#dsh-事件--agentmemory-映射注册表) |
| **读**（上下文注入） | 经 `agent/pre-step` waterfall 追加 sourced `user/message`：每会话一次的项目 recall 窗口、可选的逐消息语义 recall、压缩前的补注入                     |
| **Agent 工具** | `memory_recall` / `memory_remember`，注册为模型工具，用于显式精确召回与主动写入                                                             |

> **agentmemory 是硬依赖。** 插件在加载时、注册任何能力（工具、监听器）之前就先检查 `<baseUrl>/agentmemory/livez`。如果守护进程不可达或未报告 `status: ok`，插件会**加载失败并抛出明确错误**——绝不静默降级。

所有配置都放在插件 `cordis.yml` 行的 `config` 字段里。没有浏览器 UI，也没有持久化的配置文件。

## 安装（静态组合）

先把 agentmemory daemon 跑起来——插件的加载硬门要求它在线。daemon 默认 REST 端口为 `3111`；安装方式见 [agentmemory 快速上手](https://github.com/rohitg00/agentmemory#install)（`npx -y @agentmemory/agentmemory@latest`）。已在 agentmemory 0.9.29 上验证；要求 ≥ 0.9.29：

> - 更早的 0.9.x 会在 `/agentmemory/remember` 上丢弃 `agentId`，agent 作用域的 recall 会因此漏掉所有已保存的记忆。
> - 更早的 0.9.x 的 observe 去重会把不带 `tool_input` 的行（本插件的 approval → notification 行）折叠到同一把 key、5 分钟窗口内静默丢弃第二次审批。

然后从 GitHub 把包装进 profile：

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

> 需要 Node >= 20、一个 `shell` 能力接缝（capability seam，标准 bash/pwsh 执行器），以及与 [package.json](package.json) 中 `peerDependencies` 范围匹配的 dsh harness（已验证版本：dsh-tools 0.1.1-rc.2 与 0.1.2-rc.1）。行可接受的全部键见[配置键](#配置键)。校验命令见[验证](#验证)。

## DSH 事件 → agentmemory 映射注册表

这张表是桥接向 daemon 发送内容的权威注册表。每条观察都使用 agentmemory 的**标准 hookType**：daemon 的 `mem::observe` 只对 `prompt_submit` / `post_tool_use` / `post_tool_failure` 提取可搜索字段（`prompt`、`tool_name`、`tool_input`、`tool_output`）；其他 hookType 的数据留在 `raw.raw`，永远进不了搜索与压缩读取的合成 narrative。因此本插件不使用任何自定义 hookType——每条记录都落在 daemon 本就认识的桶里。

| DSH 事件               | agentmemory 调用                                                                                                       | hookType            | `data` 字段                                                                                                                                                                             | dedup 判别                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `session/created`    | `POST /agentmemory/session/start`（`enableSessionStartEnd` 开启时）；否则在 `injectContext` 开启时直接 `POST /agentmemory/context` | —                   | `sessionId`、`project`、`cwd`、`agentId`；响应中的 `context` 被缓存用于注入                                                                                                                          | —                                                          |
| `user/message`       | `observe`                                                                                                            | `prompt_submit`     | `prompt=content`、`source`（另含原始 `content`）                                                                                                                                             | `tool_input=content`（同 prompt 自然合并）                        |
| `assistant/message`  | `observe`                                                                                                            | `post_tool_use`     | `tool_name='assistant_message'`、`tool_output=content`、`provider`、`model`（另含原始 `content`）                                                                                              | `tool_input='#'+seq`（唯一；内容不进 input）                        |
| `tool/call`          | **不发观察行**（见下）                                                                                                        | —                   | —                                                                                                                                                                                     | —                                                          |
| `tool/result`（ok）    | `observe`                                                                                                            | `post_tool_use`     | 来自 `callMeta` stash 的 `tool_name`/`tool_input`/`tool_output`（`tool_name` 兜底取事件的 `name`；`tool_input` 兜底为 `'result#'+callId`），另含 `callId`、原始 `content`、`isError: false`、`errorName: ''` | `tool_input=args`                                          |
| `tool/result`（err）   | `observe`                                                                                                            | `post_tool_failure` | 同上，但 `isError: true`、`errorName` 有值                                                                                                                                                   | `tool_input=args`                                          |
| `turn/end`           | `observe`                                                                                                            | `post_tool_use`     | `tool_name='turn_end'`、`tool_output=reason`（如 `completed`）                                                                                                                            | `tool_input='turn#'+seq`（唯一）                               |
| `approval/asked`     | `observe`                                                                                                            | `notification`      | `notification_type='permission_prompt'` + `tool_name`、`request_id`、`call_id`、`reason`                                                                                                 | 无 `tool_input`：dedup 哈希覆盖整个 `data`，其中唯一的 request id 区分不同审批 |
| `compaction/start`   | `POST /agentmemory/context` 刷新 + 补注入标记（`injectContext` + `injectContextOnCompaction` 开启时）                            | —                   | —                                                                                                                                                                                     | —                                                          |
| `compaction/summary` | `POST /agentmemory/remember`（`compactionBridge` 开启时）                                                                 | —                   | `content='[dsh compaction] '+summary`、`type='fact'`、`concepts=['compaction']`、`project`、`agentId`                                                                                     | —                                                          |
| `session/flush`      | 缓冲观察落库                                                                                                               | —                   | —                                                                                                                                                                                     | —                                                          |
| `session/disposed`   | 最终 flush；`POST /agentmemory/session/end`（`enableSessionStartEnd` 开启时）                                                | —                   | —                                                                                                                                                                                     | —                                                          |

未列出的事件（boundaries、chunks、todo/write、request/\*）是纯日志噪音，不产生任何输出。

### 为什么 `tool/call` 不发观察行

`tool/result` 行已经携带 name + args（经 `callMeta`，在 call 事件经过时 stash）加上输出，合成一条标准 `post_tool_use`。单独的 call 行要么落在 daemon 提取的字段范围之外（见表格上方的说明），要么与结果行撞 dedup key（相同 `tool_name` + args）导致结果行的输出被静默丢弃。所以 call 被记录，但只作为结果行的元数据。

### 为什么 `turn/end` 借壳 `post_tool_use`

纯粹为了让 turn 的 `reason` 进 `tool_output`、从而进可搜索的合成 narrative（自定义 hookType 会让它不可见——同上）。`assistant/message` 对其内容做同样的事。

### 为什么 `approval/asked` 映射为 `notification`

`notification` 正是 Claude Code 的 Notification hook 与 OpenCode 的 permission 事件产生的 hookType，dsh 的审批提示因此落入 daemon 本就认识的同一个类型化、可渲染桶。daemon 设计上不对 notification 做内容索引，所以这里的字段无需为提取而摆放。

### 为什么 `compaction/summary` 走 `/remember`

蒸馏出的摘要是免费的、daemon 侧的记忆——把它持久化为 durable fact，意味着它在产生它的那次历史压缩之后依然存活，而不是随被压缩的 transcript 一起消亡。上限 6000 字符，`compactionBridge: false` 可关闭。

### 去重安全设计（Dedup-safe）

agentmemory 的 `mem::observe` 对 `sha256(sessionId, tool_name||hookType, tool_input[0..500])` 做 5 分钟 TTL 去重，命中即整条丢弃。桥接用每会话单调 `seq` 与自然内容/`callId` 做 `tool_input` 判别，保证同类多条都落库，同时保留「相同 prompt / 相同 (tool,args) 结果」的自然合并。`tool_input` 缺失时 daemon 改为哈希整个 `data` 对象。

## 记忆注入（读侧）

桥接走 DSH 原生的 **`agent/pre-step`** 注入通道（与 harness 内置的 `dsh-time-context` 插件同一范式），把 sourced `user/message` append 到进入 step 的消息批次尾部。两条路线都做事件级去重，**不在每个 tool step 重复注入**。前端把每次注入渲染为独立的「上下文注入」块（`ContextMessageNode`）。

### 路线 1 —— 项目 recall（`form: 'recall'`，默认开）

每会话把 agentmemory 的 **`/context`** **项目级跨会话窗口**（「这个项目之前干过啥」，排除当前会话）注入**一次**。`session/created` → `/session/start` 从响应缓存 `context`；`enableSessionStartEnd` 关闭（或 cwd 为空）时改为直接 `POST /agentmemory/context` 取窗口。`agent/pre-step` 的首个有缓存的 step append 一次（`injectedContext` 去重）；每条 `user/message` 仍异步刷新缓存。

### 路线 2 —— 语义 recall（`form: 'semantic'`，默认关）

每条 `user/message` 用原文（查询截断到 2000 字符）做一次 `/smart-search`（BM25+向量+图），把召回记忆的**标题**组装成一条注入消息（`semanticSeq` 逐消息去重）。精确召回（`/search`）仍留给 agent 显式调用 `memory_recall` 工具。

### 压缩前补注入（`injectContextOnCompaction`，默认开）

`compaction/start` 触发一次 `/context` 刷新，并在下一个 `agent/pre-step` 把最新项目窗口再注入一次，避免项目背景随历史压缩丢失。

## 模型工具

| 工具                | 参数                                                             | 说明                                                                                             |
| ----------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `memory_recall`   | `query` (必填), `limit?` (默认 8，钳制到 1–50), `project?`, `agentId?` | 按调用会话自动定位 project，跨会话召回。按 project 过滤，可选按 `agentId`（不传 = 项目的所有 agent，包含历史无 agent 的记录）           |
| `memory_remember` | `content` (必填), `type?`, `concepts?` (最多 20 个), `ttlDays?`     | 主动固化记忆；type ∈ pattern/preference/architecture/bug/workflow/fact。写入行带插件 `agentId`（见[配置键](#配置键)） |

工具用 `defineTool` 定义、经 `ctx.tools.register` 注册，守护进程传输走 host `shell` seam（`inject: ['tools', 'shell']`）；二者随插件 Fiber 生命周期自动清理。`execute` 失败返回 `{ok:false,error}` 而非抛错。

## 配置键

所有键都放在行的 `config` 下；省略的键会自动填默认值——无需把默认值手抄进行里。Cordis 原生校验：非法值（例如 `curlTimeoutMs: -5`）会让插件**加载失败**并给出明确错误。

| 键                           | 默认值                     | 范围       | 用途                                                 |
| --------------------------- | ----------------------- | -------- | -------------------------------------------------- |
| `baseUrl`                   | `http://localhost:3111` | —        | daemon 基地址                                         |
| `secret`                    | `''`                    | —        | Bearer token——明文或环境变量引用（见下）                        |
| `enabled`                   | `true`                  | —        | 生命周期桥总开关；`false` = 不再产生观察、session 行与注入数据源（模型工具仍可用） |
| `enableTools`               | `true`                  | —        | 注册 `memory_recall` / `memory_remember`             |
| `enableSessionStartEnd`     | `true`                  | —        | 镜像 `session/start` 与 `session/end` 行               |
| `compactionBridge`          | `true`                  | —        | 经 `/remember` 持久化压缩摘要                              |
| `agentId`                   | `'dsh'`                 | —        | 写入行的身份标识；解析顺序：env `AGENT_ID` → 该值                  |
| `curlTimeoutMs`             | `4000`                  | 1–60000  | 单次 curl 超时                                         |
| `observeBatchLimit`         | `20`                    | 1–200    | 缓冲观察达到该数量时落库                                       |
| `maxContentChars`           | `4000`                  | 1–100000 | 单条观察内容上限                                           |
| `maxArgsChars`              | `2000`                  | 1–50000  | 工具调用参数上限                                           |
| `injectContext`             | `true`                  | —        | 项目 recall 开关（路线 1）                                 |
| `injectContextMaxChars`     | `6000`                  | 1–200000 | 注入项目窗口文本上限                                         |
| `injectContextOnCompaction` | `true`                  | —        | 压缩前补注入 `/context`                                  |
| `injectSemantic`            | `false`                 | —        | 语义 recall 开关（路线 2）                                 |
| `injectSemanticMaxResults`  | `8`                     | 1–50     | smart-search 结果并入语义块的上限                            |
| `injectSemanticMaxChars`    | `3000`                  | 1–100000 | 渲染后语义 recall 文本上限                                  |

### secret：明文或环境变量引用

`secret` 支持两种形式——明文或环境变量引用（后者有三种变体）。注意明文 secret 会原样留在 `cordis.yml` 里——若该文件会被共享或纳入版本管理，请优先用环境变量引用：

| 形式                                              | 行为                            |
| ----------------------------------------------- | ----------------------------- |
| `secret: "xxx"`                                 | 明文，原样用作 Bearer token          |
| `secret: '${AGENTMEMORY_SECRET}'`               | 读环境变量；未定义 → 加载失败并报错           |
| `secret: '${AGENTMEMORY_SECRET:default}'`       | 读环境变量；未定义 → 用 `default`       |
| `secret: '${AGENTMEMORY_SECRET:?goes nowhere}'` | 读环境变量；未定义 → 报错 `goes nowhere` |

环境变量经 `shell` 能力接缝在 `apply()` 开始时解析（沙箱无直接 env 访问）。

## 模型体验

**模型看到什么。** 桥接不改动已接收的输入；其影响是追加式的——每个去重边界附加一条 sourced `user/message`（见[记忆注入](#记忆注入读侧)），加上 `enableTools` 为 true 时的两个模型工具。

**Token 影响。** 有条件。注入只在去重边界贡献额外输入 token——项目 recall 每会话一次、开启语义 recall 时每条用户消息一次、每次压缩一次，而非每个 tool step。上限由 `injectContextMaxChars` / `injectSemanticMaxChars` 控制。`enableTools` 为 true 时工具 schema 增加少量固定 token 成本。工具响应正常回到模型的上下文窗口。

**KV cache 影响。** 追加式、前缀稳定。注入消息 append 到 step 消息批次的尾部，因此之前的前缀保留且可复用；再注入只改变后缀。去重条件（`injectedContext`、`injectedSemanticKey`、`compactionInject`）防止同一块在同一边界重复追加，所以桥接自身的活动不会使稳定前缀失效。

## 传输与失败语义

- 沙箱无 `fetch`/require/timers；出网走 `shell` 能力接缝，每次调用一个 curl，JSON body 走 stdin（`--data-binary @-`）。
- **缓冲**：观察按会话缓冲，达到 `observeBatchLimit`（20）条、`session/flush` 或 `session/disposed` 时逐条落库；多个并发会话各自持有独立缓冲。
- **绝不 veto 生命周期**：生命周期监听器有错误防护（观察发送失败在 flush 循环内被捕获）；工具调用尊重 `AbortSignal`。
- 基础设施失败（curl 非零退出）重排队列、下一个 checkpoint 重试。daemon 返回的 HTTP 错误响应目前**不会**为观察行检查——这类行会被静默丢弃；一次性调用（压缩 / context / session 行）则记录后丢弃。
- flush 竞态：flush 在途时新事件经 `dirty` 标志被在途循环补发，不丢。

**日志。** 所有运行时错误都以 `[agentmemory]` 前缀写入 dsh 宿主进程的 stdout/stderr——如 `daemon unreachable at …`（加载门）、`secret env … is unset`（secret 解析）、`observe failed, re-queuing tail`（发送失败）、`session/start failed` / `context refresh failed`（一次性调用）。加载横幅（`[agentmemory] bridge active: …`）确认 `apply()` 成功。

## 验证

```bash
node scripts/boot-check.mjs   # 模块 + Config schema + daemon livez + peer deps（7 项）
node test/smoke.mjs           # 端到端（需 daemon 在 :3111）
```

冒烟测试覆盖上表注册表的大部分内容：schema 校验、livez 硬门、工具注册、secret 三种 env 引用、观察落库（title/type/narrative 形状）、approval → notification 行、`turn/end` reason 可在 narrative 搜索、无幽灵 `tool/call` 行、compaction → `/remember` 桥接、以及 `agent/pre-step` 注入形状。未覆盖：`tool/result` 错误路径（`post_tool_failure`）与压缩前补注入。

本地开发——peer 依赖链接、冒烟 fixture 清理、ESM 缓存——见 [DEVELOPMENT.md](DEVELOPMENT.md)。

## 已知边界

- **工具侧与桥接侧的 project 解析不一致**：观察桥按 `AGENTMEMORY_PROJECT_NAME` 环境变量 → git toplevel → cwd basename 解析 project，而 `memory_recall` / `memory_remember` 默认只取会话 cwd basename。当会话 cwd 位于 git 仓库子目录时，观察落在 toplevel 项目名下、工具却查 cwd basename——此时请显式传 `project`。
- **无只读模式**：`enabled: false` 同时切断观察桥与注入数据源（只有模型工具保持可用）。只注入上下文、不写观察目前做不到。
- **记忆默认跨会话共享**（观察记录打的是插件 agentId，不是 DSH session id）；需要隔离某个 agent 时，设置 `agentId` 或让 `memory_recall` 按它过滤。
- **Agent 隔离为可选**：写入记录都带插件 agentId（见[配置键](#配置键)）；早于 agentId 标记功能的插件版本写入的记录 `agentId` 为 undefined，不传过滤时仍可召回。
- **环境变量**（`AGENT_ID`、`AGENTMEMORY_PROJECT_NAME`）经 `shell` seam 从 dsh 宿主进程环境读取——在启动 dsh 的地方设置，而不是写在 `cordis.yml` 里。
- 未改动任何 `@deepseek-ai` 包；未改动随 dsh 发布的 preset 安装目录。

## 许可证

MIT——见 [LICENSE](LICENSE)。
