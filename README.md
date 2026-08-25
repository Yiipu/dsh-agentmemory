# dsh-agentmemory

> A DSH (DeepSeek Harness) Cordis plugin that gives every dsh session a persistent, searchable memory in [agentmemory](https://github.com/rohitg00/agentmemory) — a local, self-hosted memory daemon with a REST API.

English | [中文](README.zh.md)

dsh sessions are ephemeral: once a session ends, everything the agent learned — the tool calls it made, the errors it recovered from, the decisions it settled on — is gone. agentmemory fixes that with cross-session, cross-harness persistence (it already serves Claude Code, OpenCode, Hermes and more). This plugin is the dsh side of that ecosystem: it **writes** every session's activity into the daemon as observations, **reads** memory back into the model at the right moments, and exposes explicit **memory tools** the agent can call.

Three surfaces, one plugin:

| Surface | What it does |
| --- | --- |
| **Write** (observation bridge) | Maps every DSH session event to an agentmemory **standard hookType** so the daemon's compression pipeline, search index, and viewer all read real content — see the [mapping registry](#dsh-event--agentmemory-mapping-registry) |
| **Read** (context injection) | Appends sourced `user/message` rows via the `agent/pre-step` waterfall: a project recall window once per session, optional per-message semantic recall, and a pre-compaction re-inject |
| **Agent tools** | `memory_recall` / `memory_remember`, registered as model tools for explicit, precise recall and curated writes |

> **agentmemory is a hard dependency.** On load, the plugin checks `<baseUrl>/agentmemory/livez` before registering any capability. If the daemon is unreachable or does not report `status: ok`, the plugin **fails to load loudly** — it does not silently degrade.

All configuration comes from the plugin's row in `cordis.yml` — editing the `config` field of that row (or the file that carries it) is how you change configuration. There is no browser UI and no persisted config file.

## Install (static composition)

Start the agentmemory daemon first (default `http://localhost:3111`) — the plugin's load gate requires it. Then install the package from GitHub into a profile:

```bash
dsh plugin --profile web add github:Yiipu/dsh-agentmemory
```

(A local dev checkout also works via `dsh plugin --profile web add /path/to/checkout`.)

Mount the row from [`cordis-row.example.yml`](cordis-row.example.yml) into a host composition `cordis.yml` (or into a per-session agent preset's composition under `${DSH_HOME:-$HOME/.dsh}/.agent-presets/<id>/`). The minimal row is just `{name}` — Cordis validates it against the plugin's `Config` schema and fills defaults (quote the name if it is a scoped package, i.e. starts with `@`, which YAML treats as a reserved scalar):

```yaml
- insert:
    - id: agentmemory-bridge
      name: "dsh-agentmemory"
      config:
        baseUrl: http://localhost:3111
        enabled: true
```

> Requires Node >= 20 and a `shell` capability seam (the standard bash/pwsh executors). Validation commands: see [Verification](#verification).

## DSH event → agentmemory mapping registry

This table is the authoritative registry of what the bridge sends to the daemon. Every observation uses an agentmemory **standard hookType** — the daemon's `mem::observe` extracts searchable fields (`prompt`, `tool_name`, `tool_input`, `tool_output`) only for `prompt_submit` / `post_tool_use` / `post_tool_failure`; anything else keeps data in `raw.raw` and never reaches the synthetic narrative (title + toolInput/output/prompt) that search and compression read. The plugin therefore emits no custom hookTypes — every row lands in a bucket the daemon already knows.

| DSH event | agentmemory call | hookType | `data` fields | dedup discriminator |
| --- | --- | --- | --- | --- |
| `session/created` | `POST /agentmemory/session/start` (when `enableSessionStartEnd`) | — | `sessionId`, `project`, `cwd`, `agentId`; the response's `context` is cached for injection | — |
| `user/message` | `observe` | `prompt_submit` | `prompt=content`, `source` (plus a raw `content`) | `tool_input=content` (identical prompts merge naturally) |
| `assistant/message` | `observe` | `post_tool_use` | `tool_name='assistant_message'`, `tool_output=content`, `provider`, `model` (plus a raw `content`) | `tool_input='#'+seq` (unique; content not in input) |
| `tool/call` | **no observation row** (see below) | — | — | — |
| `tool/result` (ok) | `observe` | `post_tool_use` | `tool_name`/`tool_input`/`tool_output` from the `callMeta` stash (falls back to event fields), plus `callId` and raw `content` | `tool_input=args` |
| `tool/result` (err) | `observe` | `post_tool_failure` | same, plus `isError: true` and `errorName` | `tool_input=args` |
| `turn/end` | `observe` | `post_tool_use` | `tool_name='turn_end'`, `tool_output=reason` (e.g. `completed`) | `tool_input='turn#'+seq` (unique) |
| `approval/asked` | `observe` | `notification` | `notification_type='permission_prompt'` + `tool_name`, `request_id`, `call_id`, `reason` | no `tool_input`: the dedup hash covers the whole `data`, whose unique request id keeps distinct prompts apart |
| `compaction/start` | `POST /agentmemory/context` refresh + re-inject flag (when `injectContext` + `injectContextOnCompaction`) | — | — | — |
| `compaction/summary` | `POST /agentmemory/remember` (when `compactionBridge`) | — | `content='[dsh compaction] '+summary`, `type='fact'`, `concepts=['compaction']` | — |
| `session/flush` | flush the buffered observations | — | — | — |
| `session/disposed` | final flush; `POST /agentmemory/session/end` (when `enableSessionStartEnd`) | — | — | — |

Events not listed (boundaries, chunks, todo/write, request/*) are log-only noise and emit nothing.

### Why `tool/call` emits no observation row

The `tool/result` row already carries name + args (via `callMeta`, stashed when the call event passes through) plus the output as one standard `post_tool_use`. A separate call row would either fall outside the fields the daemon extracts (custom hookType → empty narrative, unsearchable) or collide with the result row's dedup key (same `tool_name` + args) and silently drop the result's output. So the call is recorded, but only as metadata for the result row.

### Why `turn/end` borrows `post_tool_use`

Purely so the turn's `reason` reaches `tool_output` and thus the searchable synthetic narrative — a custom hookType would leave it invisible. `assistant/message` does the same for its content.

### Why `approval/asked` maps to `notification`

`notification` is the hookType Claude Code's Notification hook and OpenCode's permission events produce, so approval prompts from dsh land in the same typed, rendered bucket the daemon already knows. By design the daemon does not content-index notifications, so no field here needs extraction-friendly placement.

### Why `compaction/summary` goes to `/remember`

The distilled summary is free, daemon-adjacent memory — persisting it as a durable fact means it survives the very history compression that produced it, instead of dying with the compacted transcript. Capped at 6000 chars, off via `compactionBridge: false`.

### Dedup-safe design

agentmemory's `mem::observe` drops duplicates by `sha256(sessionId, tool_name||hookType, tool_input[0..500])` with a 5-minute TTL; a hit discards the observation entirely. The bridge uses a per-session monotonic `seq` and natural content/`callId` as the `tool_input` discriminator, so multiple rows of the same kind all persist while identical prompts / identical `(tool, args)` results still merge naturally.

## Memory injection (read side)

The bridge uses DSH's native **`agent/pre-step`** injection channel (the same pattern as the harness's built-in `dsh-time-context` plugin) and appends sourced `user/message` rows to the tail of the incoming message batch. Both routes deduplicate at the event level — they do **not** re-inject on every tool step. The front end renders each injection as an independent "context injection" block (`ContextMessageNode`).

### Route 1 — Project recall (`form: 'recall'`, on by default)

Injects **once** per session the agentmemory **`/context` project-level cross-session window** ("what this project has done before", excluding the current session). `session/created` → `/session/start` caches `context` from the response; the first step in `agent/pre-step` that has a cached window appends it once (`injectedContext` dedup); every `user/message` still refreshes the cache asynchronously.

### Route 2 — Semantic recall (`form: 'semantic'`, off by default)

Each `user/message` runs a `/smart-search` (BM25 + vector + graph) on the raw text and assembles the recalled memory **titles** into one injected message (`semanticSeq` dedups per message). Precise recall (`/search`) is still left to the agent's explicit `memory_recall` tool.

### Pre-compaction re-inject (`injectContextOnCompaction`, on by default)

`compaction/start` triggers a `/context` refresh and the next `agent/pre-step` re-injects the latest project window so project background survives history compression.

## Model tools

| Tool | Arguments | Description |
| --- | --- | --- |
| `memory_recall` | `query` (required), `limit?`, `project?`, `agentId?` | Auto-locates project from the calling session; recalls across sessions. Scope by project, and optionally by `agentId` (omit = across every agent of the project, so historical pre-agentId rows stay recallable). Written rows are stamped with the plugin agentId: env `AGENT_ID` → config `agentId` → default `"dsh"` |
| `memory_remember` | `content` (required), `type?`, `concepts?`, `ttlDays?` | Curated, durable memory; `type` ∈ pattern/preference/architecture/bug/workflow/fact |

Tools are defined with `defineTool` and registered through `ctx.tools.register`, and daemon transport runs over the host `shell` seam (`inject: ['tools', 'shell']`); both are cleaned up automatically with the plugin Fiber lifecycle. On failure, `execute` returns `{ok: false, error}` rather than throwing.

## Configuration keys

`baseUrl`, `secret` (below), `enabled` (lifecycle-bridge master switch: when false, no observations, session rows, or injection data sources — model tools stay live), `enableTools`, `enableSessionStartEnd` (mirror `session/start` and `session/end` rows), `compactionBridge` (persist compaction summaries via `/remember`, default `true`), `agentId` (identity stamped on written rows, default `"dsh"`), `curlTimeoutMs`, `observeBatchLimit`, `maxContentChars`, `maxArgsChars`,
`injectContext` (project recall switch, default `true`), `injectContextMaxChars` (default `6000`), `injectContextOnCompaction` (pre-compaction re-inject, default `true`),
`injectSemantic` (semantic recall switch, default `false`), `injectSemanticMaxResults` (default `8`), `injectSemanticMaxChars` (default `3000`).

Keys omitted from a row are filled with defaults by Cordis according to the plugin's `Config` schema — do **not** hand-write a merge. Cordis validates natively: an invalid value (such as `curlTimeoutMs: -5`) makes the plugin **fail to load** with a clear error. The full numeric bounds (min/max) are declared on each key in `index.js`.

### `secret`: plaintext or an environment-variable reference

`secret` accepts two forms — plaintext or an environment-variable reference (the latter with three variants); whether you write plaintext is your choice:

| Form | Behavior |
| --- | --- |
| `secret: "xxx"` | Plaintext, used verbatim as the Bearer token |
| `secret: '${AGENTMEMORY_SECRET}'` | Reads the env var; if unset → **load fails (loudly)** |
| `secret: '${AGENTMEMORY_SECRET:default}'` | Reads the env var; if unset → uses `default` |
| `secret: '${AGENTMEMORY_SECRET:?goes nowhere}'` | Reads the env var; if unset → fails with the message `goes nowhere` |

Environment variables are resolved through the `shell` seam at the start of `apply()` (the sandbox has no direct env access).

## Model experience

**What the model sees.** The bridge does not alter accepted input. Its observable model input is additive after the incoming batch: one injected sourced `user/message` per dedup boundary, whose `text` is the project `/context` window (route 1), the semantic recall titles (route 2), or a pre-compaction re-inject of the project window (`source.kind === 'plugin'`, `plugin === 'agentmemory'`, `form` `'recall'` / `'semantic'`). Tool calls `memory_recall` and `memory_remember` are registered only when `enableTools` is true.

**Token effect.** Conditional. Injection contributes extra input tokens only at the dedup boundaries — once per session for project recall, once per user message for semantic recall when enabled, and once per compaction — not per tool step. Capped by `injectContextMaxChars` / `injectSemanticMaxChars`. Tool schemas add a small fixed token cost while `enableTools` is true. Tool responses are returned to the model's context window normally.

**KV cache effect.** Append-only, prefix-stable. Injected messages are appended at the tail of the step's message batch, so the prior message prefix is preserved and reusable; re-injection changes the suffix. The dedup conditions (`injectedContext`, `injectedSemanticKey`, `compactionInject`) prevent repeated appends of the same block at the same boundary, so a stable prefix is not invalidated by the bridge's own activity across steps.

## Transport and failure semantics

- The sandbox has no `fetch`/require/timers; outbound traffic goes through the `shell` capability seam, one curl per call with the JSON body on stdin (`--data-binary @-`).
- **Never veto a lifecycle event**: listeners are fully try/catch guarded; an `AbortSignal` is honored on tool calls.
- Infrastructure failures re-queue and retry at the next checkpoint; payload-level failures are logged and dropped.
- Flush race: if a flush is in flight when new events arrive, the `dirty` flag makes the in-flight loop re-send them, so nothing is lost.

## Verification

```bash
node scripts/boot-check.mjs   # module + Config schema + daemon livez + peer deps (7 checks)
node test/smoke.mjs           # end-to-end (needs the daemon on :3111)
```

The smoke test covers the full registry above: schema validation, the livez hard gate, tool registration, all three secret env-reference forms, observation persistence (title/type/narrative shape), the approval → notification row, `turn/end` reason searchable in the narrative, no phantom `tool/call` row, the compaction → `/remember` bridge, and the `agent/pre-step` injection shape.

For local development — peer-dependency linking, smoke-fixture cleanup, the ESM cache — see [DEVELOPMENT.md](DEVELOPMENT.md).

## Known limitations

- **Tool-side vs bridge-side project resolution**: the observation bridge resolves the project as `AGENTMEMORY_PROJECT_NAME` env → git toplevel → cwd basename, but `memory_recall` / `memory_remember` default to the session cwd basename only. When the session cwd is a subdirectory of a git repo, observations land under the toplevel project name while the tools query the cwd basename — pass `project` explicitly to bridge the gap.
- **Memory is shared across sessions by default** (observations are stamped with the plugin agentId, not the DSH session id); to isolate one agent, set `agentId` or filter `memory_recall` by it.
- **Agent isolation is opt-in**: written rows carry the plugin agentId (env `AGENT_ID` → config `agentId` → default `"dsh"`); rows written by plugin versions that predate agentId stamping have `agentId` undefined and stay recallable when the filter is omitted.
- **The bridge does not modify any `@deepseek-ai` package** and does not touch the shipped preset install directory.
