# dsh-agentmemory

> A DSH (DeepSeek Harness) Cordis plugin that gives every dsh session a persistent, searchable memory in [agentmemory](https://github.com/rohitg00/agentmemory) — a local, self-hosted memory daemon with a REST API.

English | [中文](README.zh.md)

> **⚠️ Deprecated.** This plugin is no longer maintained. agentmemory 0.9.29+ ships an official dsh connector that supersedes it — migrate with:
>
> ```bash
> agentmemory connect dsh --with-hooks
> ```
>
> The official connector covers auto-capture (hooks bridged through the first-party `dsh-hooks-claude-code`) and the MCP memory tools; this plugin's `agent/pre-step` context injection has no official equivalent. Already-written memories and observations stay in the daemon (keyed by project/agentId) and remain queryable after migration — though the project/agentId the official connector stamps may differ from this plugin's (git-toplevel project, `dsh` agentId). While transitioning, pick one per profile: the daemon's dedup cannot merge the two capture streams, so running both duplicates rows.

dsh sessions are ephemeral: once a session ends, everything the agent learned — the tool calls it made, the errors it recovered from, the decisions it settled on — is gone. agentmemory fixes that with cross-session, cross-harness persistence (it already serves Claude Code, OpenCode, Hermes and more). This plugin is the dsh side of that ecosystem: it **writes** every session's activity into the daemon as observations, **reads** memory back into the model at the right moments, and exposes explicit **memory tools** the agent can call.

Three surfaces, one plugin:

| Surface | What it does |
| --- | --- |
| **Write** (observation bridge) | Maps every DSH session event to an agentmemory **standard hookType** so the daemon's compression pipeline, search index, and viewer all read real content — see the [mapping registry](#dsh-event--agentmemory-mapping-registry) |
| **Read** (context injection) | Appends sourced `user/message` rows via the `agent/pre-step` waterfall: a project recall window once per session, optional per-message semantic recall, and a pre-compaction re-inject |
| **Agent tools** | `memory_recall` / `memory_remember`, registered as model tools for explicit, precise recall and curated writes |

> **agentmemory is a hard dependency.** On load, the plugin checks `<baseUrl>/agentmemory/livez` before registering any capability (tools, listeners). If the daemon is unreachable or does not report `status: ok`, the plugin **fails to load loudly** — it does not silently degrade.

All configuration lives in the `config` field of the plugin's `cordis.yml` row. There is no browser UI and no persisted config file.

## Install (static composition)

Start the agentmemory daemon first — the plugin's load gate requires it. The daemon's default REST port is `3111`; see the [agentmemory quickstart](https://github.com/rohitg00/agentmemory#install) for install options (`npx -y @agentmemory/agentmemory@latest`). Verified against agentmemory 0.9.29; ≥ 0.9.29 required:

> - Older 0.9.x drops `agentId` on `/agentmemory/remember`, so agent-scoped recall filters out every saved memory.
> - Older 0.9.x observe dedup collapses rows that carry no `tool_input` (this plugin's approval → notification rows) onto one shared key per 5-minute window, silently dropping the second approval.

Then install the package from GitHub into a profile:

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

> Requires Node >= 20, a `shell` capability seam (the standard bash/pwsh executors), and a dsh harness matching the `peerDependencies` ranges in [package.json](package.json) (verified against dsh-tools 0.1.1-rc.2 and 0.1.2-rc.1). Every key the row accepts is listed under [Configuration keys](#configuration-keys). Validation commands: see [Verification](#verification).

## DSH event → agentmemory mapping registry

This table is the authoritative registry of what the bridge sends to the daemon. Every observation uses an agentmemory **standard hookType**: the daemon's `mem::observe` extracts searchable fields (`prompt`, `tool_name`, `tool_input`, `tool_output`) only for `prompt_submit` / `post_tool_use` / `post_tool_failure`. Anything else keeps data in `raw.raw` and never reaches the synthetic narrative that search and compression read. The plugin therefore emits no custom hookTypes — every row lands in a bucket the daemon already knows.

| DSH event | agentmemory call | hookType | `data` fields | dedup discriminator |
| --- | --- | --- | --- | --- |
| `session/created` | `POST /agentmemory/session/start` (when `enableSessionStartEnd`); otherwise, when `injectContext` is on, `POST /agentmemory/context` directly | — | `sessionId`, `project`, `cwd`, `agentId`; the response's `context` is cached for injection | — |
| `user/message` | `observe` | `prompt_submit` | `prompt=content`, `source` (plus a raw `content`) | `tool_input=content` (identical prompts merge naturally) |
| `assistant/message` | `observe` | `post_tool_use` | `tool_name='assistant_message'`, `tool_output=content`, `provider`, `model` (plus a raw `content`) | `tool_input='#'+seq` (unique; content not in input) |
| `tool/call` | **no observation row** (see below) | — | — | — |
| `tool/result` (ok) | `observe` | `post_tool_use` | `tool_name`/`tool_input`/`tool_output` from the `callMeta` stash (`tool_name` falls back to the event's `name`; `tool_input` falls back to `'result#'+callId`), plus `callId`, raw `content`, `isError: false`, `errorName: ''` | `tool_input=args` |
| `tool/result` (err) | `observe` | `post_tool_failure` | same, with `isError: true` and `errorName` set | `tool_input=args` |
| `turn/end` | `observe` | `post_tool_use` | `tool_name='turn_end'`, `tool_output=reason` (e.g. `completed`) | `tool_input='turn#'+seq` (unique) |
| `approval/asked` | `observe` | `notification` | `notification_type='permission_prompt'` + `tool_name`, `request_id`, `call_id`, `reason` | no `tool_input`: the dedup hash covers the whole `data`, whose unique request id keeps distinct prompts apart |
| `compaction/start` | `POST /agentmemory/context` refresh + re-inject flag (when `injectContext` + `injectContextOnCompaction`) | — | — | — |
| `compaction/summary` | `POST /agentmemory/remember` (when `compactionBridge`) | — | `content='[dsh compaction] '+summary`, `type='fact'`, `concepts=['compaction']`, `project`, `agentId` | — |
| `session/flush` | flush the buffered observations | — | — | — |
| `session/disposed` | final flush; `POST /agentmemory/session/end` (when `enableSessionStartEnd`) | — | — | — |

Events not listed (boundaries, chunks, todo/write, request/*) are log-only noise and emit nothing.

### Why `tool/call` emits no observation row

The `tool/result` row already carries name + args (via `callMeta`, stashed when the call event passes through) plus the output as one standard `post_tool_use`. A separate call row would either sit outside the extraction set (see the note above the table) or collide with the result row's dedup key (same `tool_name` + args) and silently drop the result's output. So the call is recorded, but only as metadata for the result row.

### Why `turn/end` borrows `post_tool_use`

Purely so the turn's `reason` reaches `tool_output` and thus the searchable synthetic narrative (a custom hookType would leave it invisible — same reason as above). `assistant/message` does the same for its content.

### Why `approval/asked` maps to `notification`

`notification` is the hookType Claude Code's Notification hook and OpenCode's permission events produce, so approval prompts from dsh land in the same typed, rendered bucket the daemon already knows. By design the daemon does not content-index notifications, so no field here needs extraction-friendly placement.

### Why `compaction/summary` goes to `/remember`

The distilled summary is free, daemon-adjacent memory — persisting it as a durable fact means it survives the very history compression that produced it, instead of dying with the compacted transcript. Capped at 6000 chars, off via `compactionBridge: false`.

### Dedup-safe design

agentmemory's `mem::observe` drops duplicates by `sha256(sessionId, tool_name||hookType, tool_input[0..500])` with a 5-minute TTL; a hit discards the observation entirely. The bridge uses a per-session monotonic `seq` and natural content/`callId` as the `tool_input` discriminator, so multiple rows of the same kind all persist while identical prompts / identical `(tool, args)` results still merge naturally. When `tool_input` is absent the daemon hashes the whole `data` object instead.

## Memory injection (read side)

The bridge uses DSH's native **`agent/pre-step`** injection channel (the same pattern as the harness's built-in `dsh-time-context` plugin) and appends sourced `user/message` rows to the tail of the incoming message batch. Both routes deduplicate at the event level — they do **not** re-inject on every tool step. The front end renders each injection as an independent "context injection" block (`ContextMessageNode`).

### Route 1 — Project recall (`form: 'recall'`, on by default)

Injects **once** per session the agentmemory **`/context` project-level cross-session window** ("what this project has done before", excluding the current session). `session/created` → `/session/start` caches `context` from the response; when `enableSessionStartEnd` is off (or the cwd is empty), the window is fetched via a direct `POST /agentmemory/context` instead. The first step in `agent/pre-step` that has a cached window appends it once (`injectedContext` dedup); every `user/message` still refreshes the cache asynchronously.

### Route 2 — Semantic recall (`form: 'semantic'`, off by default)

Each `user/message` runs a `/smart-search` (BM25 + vector + graph) on the raw text (query capped at 2000 chars) and assembles the recalled memory **titles** into one injected message (`semanticSeq` dedups per message). Precise recall (`/search`) is still left to the agent's explicit `memory_recall` tool.

### Pre-compaction re-inject (`injectContextOnCompaction`, on by default)

`compaction/start` triggers a `/context` refresh and the next `agent/pre-step` re-injects the latest project window so project background survives history compression.

## Model tools

| Tool | Arguments | Description |
| --- | --- | --- |
| `memory_recall` | `query` (required), `limit?` (default 8, clamped to 1–50), `project?`, `agentId?` | Auto-locates project from the calling session; recalls across sessions. Scope by project, and optionally by `agentId` (omit = across every agent of the project, so historical pre-agentId rows stay recallable) |
| `memory_remember` | `content` (required), `type?`, `concepts?` (max 20), `ttlDays?` | Curated, durable memory; `type` ∈ pattern/preference/architecture/bug/workflow/fact. Stamped with the plugin `agentId` (see [Configuration keys](#configuration-keys)) |

Tools are defined with `defineTool` and registered through `ctx.tools.register`, and daemon transport runs over the host `shell` seam (`inject: ['tools', 'shell']`); both are cleaned up automatically with the plugin Fiber lifecycle. On failure, `execute` returns `{ok: false, error}` rather than throwing.

## Configuration keys

All keys live under the row's `config`; omitted keys are filled with defaults automatically — no need to copy default values into the row by hand. Cordis validates natively: an invalid value (such as `curlTimeoutMs: -5`) makes the plugin **fail to load** with a clear error.

| Key | Default | Range | Purpose |
| --- | --- | --- | --- |
| `baseUrl` | `http://localhost:3111` | — | daemon base URL |
| `secret` | `''` | — | Bearer token — plaintext or env reference (see below) |
| `enabled` | `true` | — | lifecycle-bridge master switch; `false` = no observations, session rows, or injection data sources (model tools stay live) |
| `enableTools` | `true` | — | register `memory_recall` / `memory_remember` |
| `enableSessionStartEnd` | `true` | — | mirror `session/start` and `session/end` rows |
| `compactionBridge` | `true` | — | persist compaction summaries via `/remember` |
| `agentId` | `'dsh'` | — | identity stamped on every written row; resolution: env `AGENT_ID` → this value |
| `curlTimeoutMs` | `4000` | 1–60000 | per-request curl deadline |
| `observeBatchLimit` | `20` | 1–200 | flush the session buffer at this many buffered observations |
| `maxContentChars` | `4000` | 1–100000 | per-observation content cap |
| `maxArgsChars` | `2000` | 1–50000 | tool-call arguments cap |
| `injectContext` | `true` | — | project recall switch (route 1) |
| `injectContextMaxChars` | `6000` | 1–200000 | cap on the injected project window text |
| `injectContextOnCompaction` | `true` | — | re-inject `/context` right before compaction |
| `injectSemantic` | `false` | — | semantic recall switch (route 2) |
| `injectSemanticMaxResults` | `8` | 1–50 | cap on smart-search results folded into the semantic block |
| `injectSemanticMaxChars` | `3000` | 1–100000 | cap on the rendered semantic recall text |

### `secret`: plaintext or an environment-variable reference

`secret` accepts two forms — plaintext or an environment-variable reference (the latter with three variants). Note a plaintext secret is stored verbatim in `cordis.yml` — prefer an env reference if the file is shared or version-controlled:

| Form | Behavior |
| --- | --- |
| `secret: "xxx"` | Plaintext, used verbatim as the Bearer token |
| `secret: '${AGENTMEMORY_SECRET}'` | Reads the env var; if unset → **load fails (loudly)** |
| `secret: '${AGENTMEMORY_SECRET:default}'` | Reads the env var; if unset → uses `default` |
| `secret: '${AGENTMEMORY_SECRET:?goes nowhere}'` | Reads the env var; if unset → fails with the message `goes nowhere` |

Environment variables are resolved through the `shell` seam at the start of `apply()` (the sandbox has no direct env access).

## Model experience

**What the model sees.** The bridge does not alter accepted input; its effect is additive — one injected sourced `user/message` per dedup boundary (see [Memory injection](#memory-injection-read-side)), plus the two model tools when `enableTools` is true.

**Token effect.** Injection contributes extra input tokens only at the dedup boundaries — once per session for project recall, once per user message for semantic recall when enabled, and once per compaction — not per tool step. Capped by `injectContextMaxChars` / `injectSemanticMaxChars`. Tool schemas add a small fixed token cost while `enableTools` is true. Tool responses are returned to the model's context window normally.

**KV cache effect.** Append-only, prefix-stable. Injected messages are appended at the tail of the step's message batch, so the prior message prefix is preserved and reusable; re-injection changes the suffix. The dedup conditions (`injectedContext`, `injectedSemanticKey`, `compactionInject`) prevent repeated appends of the same block at the same boundary, so a stable prefix is not invalidated by the bridge's own activity across steps.

## Transport and failure semantics

- The sandbox has no `fetch`/require/timers; outbound traffic goes through the `shell` capability seam, one curl per call with the JSON body on stdin (`--data-binary @-`).
- **Buffering**: observations are buffered per session and flushed one-by-one at `observeBatchLimit` (20) buffered rows, on `session/flush`, and at `session/disposed`; multiple concurrent sessions each keep their own buffer.
- **Never veto a lifecycle event**: lifecycle listeners are error-guarded (observation send failures are caught inside the flush loop); an `AbortSignal` is honored on tool calls.
- Infrastructure failures (curl non-zero exit) re-queue and retry at the next checkpoint. HTTP error responses from the daemon are currently **not** inspected for observations — such rows are dropped silently; one-shot calls (compaction / context / session rows) are logged and dropped.
- Flush race: if a flush is in flight when new events arrive, the `dirty` flag makes the in-flight loop re-send them, so nothing is lost.

**Logging.** All runtime errors are written to the dsh host process's stdout/stderr with an `[agentmemory]` prefix — e.g. `daemon unreachable at …` (load gate), `secret env … is unset` (secret resolution), `observe failed, re-queuing tail` (send failure), `session/start failed` / `context refresh failed` (one-shot calls). The load banner (`[agentmemory] bridge active: …`) confirms a successful `apply()`.

## Verification

```bash
node scripts/boot-check.mjs   # module + Config schema + daemon livez + peer deps (7 checks)
node test/smoke.mjs           # end-to-end (needs the daemon on :3111)
```

The smoke test covers most of the registry above: schema validation, the livez hard gate, tool registration, all three secret env-reference forms, observation persistence (title/type/narrative shape), the approval → notification row, `turn/end` reason searchable in the narrative, no phantom `tool/call` row, the compaction → `/remember` bridge, and the `agent/pre-step` injection shape. Not covered: the `tool/result` error path (`post_tool_failure`) and the pre-compaction re-inject.

For local development — peer-dependency linking, smoke-fixture cleanup, the ESM cache — see [DEVELOPMENT.md](DEVELOPMENT.md).

## Known limitations

- **Tool-side vs bridge-side project resolution**: the observation bridge resolves the project as `AGENTMEMORY_PROJECT_NAME` env → git toplevel → cwd basename, but `memory_recall` / `memory_remember` default to the session cwd basename only. When the session cwd is a subdirectory of a git repo, observations land under the toplevel project name while the tools query the cwd basename — pass `project` explicitly to bridge the gap.
- **No read-only mode**: `enabled: false` cuts both the observation bridge and the injection data sources (only the model tools stay live). Injecting context without writing observations is not currently possible.
- **Memory is shared across sessions by default** (observations are stamped with the plugin agentId, not the DSH session id); to isolate one agent, set `agentId` or filter `memory_recall` by it.
- **Agent isolation is opt-in**: written rows carry the plugin agentId (see [Configuration keys](#configuration-keys)); rows written by plugin versions that predate agentId stamping have `agentId` undefined and stay recallable when the filter is omitted.
- **Environment variables** (`AGENT_ID`, `AGENTMEMORY_PROJECT_NAME`) are read from the dsh host process environment via the `shell` seam — set them where dsh is launched, not in `cordis.yml`.
- **The bridge does not modify any `@deepseek-ai` package** and does not touch the shipped preset install directory.

## License

MIT — see [LICENSE](LICENSE).
