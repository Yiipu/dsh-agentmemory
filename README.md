# dsh-agentmemory

> **dsh-agentmemory** — a [DSH](/deepseek-harness) (DeepSeek Harness) Cordis plugin that bridges a session's activity into [agentmemory](https://github.com/rohitg00/agentmemory), a local, self-hosted memory daemon.

English | [中文](README.zh.md)

The plugin subscribes to the DSH **Session lifecycle** events, mirrors session activity into the agentmemory daemon (REST, default `http://localhost:3111`), and exposes **`memory_recall` / `memory_remember`** model tools. It additionally injects a memory window into model requests once per session through the **`agent/pre-step`** waterfall.

All configuration comes from the plugin's row in `cordis.yml` — editing the `config` field of that row (or the file that carries it) is how you change configuration. There is no browser UI and no persisted config file.

> **agentmemory is a hard dependency.** On load, the plugin checks `<baseUrl>/agentmemory/livez` before registering any capability (tools, listeners). If the daemon is unreachable or does not report `status: ok`, the plugin **fails to load loudly** — it does not silently degrade.

## Capability overview

| Capability | Implementation |
| --- | --- |
| Session lifecycle → agentmemory | `session/created` → `session/start`; `session/event` → `observe` (buffered); `session/flush` → flush to disk; `session/disposed` → `session/end` |
| Model tools (read) | `memory_recall` → `POST /agentmemory/search` (auto-locates `project` from the calling session) |
| Model tools (write) | `memory_remember` → `POST /agentmemory/remember` (decisions, preferences, architecture facts, and similar) |
| **Memory injection** | Sourced `user/message` via the `agent/pre-step` waterfall: ① **project recall** (`form: 'recall'`) injects the project-level `/context` cross-session window once per session; ② **semantic recall** (`form: 'semantic'`, optional) uses each user message to recall relevant memory titles via `/smart-search`; a pre-compaction re-inject keeps the project window when history compresses. The front end renders each injection as an independent "context injection" block (`ContextMessageNode`) |
| **Configuration source** | Read-only `config` from the `cordis.yml` row; no UI, no file persistence |

## Install (static composition)

Mount the row from `cordis-row.example.yml` into a host composition `cordis.yml` (or into a per-session agent preset's composition under `${DSH_HOME:-$HOME/.dsh}/.agent-presets/<id>/`). First install the package from GitHub into a profile:

```bash
dsh plugin --profile web add github:Yiipu/dsh-agentmemory
```

(A local dev checkout also works via `dsh plugin --profile web add /path/to/checkout`.)

Then add the row (`@` begins a YAML reserved scalar, so the package name must be quoted):

```yaml
- insert:
    - id: agentmemory-bridge
      name: "dsh-agentmemory"
      config:
        baseUrl: http://localhost:3111
        enabled: true
```

Validate: `node scripts/boot-check.mjs` (7 checks, needs the daemon on :3111); `node test/smoke.mjs` (end-to-end, needs the daemon on :3111).

> Requires Node >= 20 and a `shell` capability seam (the standard bash/pwsh executors).

## Hard dependency: the daemon must be reachable at load

agentmemory is a **hard dependency**. `apply()` probes `<baseUrl>/agentmemory/livez` with one curl before registering any capability:

- reachable and `status: ok` → loading continues;
- unreachable / not ok → **plugin load fails (loudly)**, no silent degradation;
- no `shell` seam → load fails.

> This is a **load-time** hard gate. If the daemon drops during a run the plugin is tolerant: every call is logged and contained, and it never vetoes a session lifecycle event or a model step.

## Configuration keys

`baseUrl`, `secret` (below), `enabled` (bridge master switch), `enableTools`, `enableSessionStartEnd`, `curlTimeoutMs`, `observeBatchLimit`, `maxContentChars`, `maxArgsChars`,
`injectContext` (project recall switch, default `true`), `injectContextMaxChars` (default `6000`), `injectContextOnCompaction` (pre-compaction re-inject, default `true`),
`injectSemantic` (semantic recall switch, default `false`), `injectSemanticMaxResults` (default `8`), `injectSemanticMaxChars` (default `3000`).

Keys omitted from a row are filled with defaults by Cordis according to the plugin's `Config` schema — do **not** hand-write a merge. Cordis validates natively: an invalid value (such as `curlTimeoutMs: -5`) makes the plugin **fail to load** with a clear error. The full numeric bounds (min/max) are declared on each key in `index.js`.

### `secret`: plaintext or an environment-variable reference

`secret` accepts two forms; whether you write plaintext is your choice:

| Form | Behavior |
| --- | --- |
| `secret: "xxx"` | Plaintext, used verbatim as the Bearer token |
| `secret: '${AGENTMEMORY_SECRET}'` | Reads the env var; if unset → **load fails (loudly)** |
| `secret: '${AGENTMEMORY_SECRET:default}'` | Reads the env var; if unset → uses `default` |
| `secret: '${AGENTMEMORY_SECRET:?goes nowhere}'` | Reads the env var; if unset → fails with the message `goes nowhere` |

Environment variables are resolved through the `shell` seam at the start of `apply()` (the sandbox has no direct env access).

## Memory injection (read side → model + "context injection" front-end block)

The bridge uses DSH's native **`agent/pre-step`** injection channel (the same pattern as `dsh-time-context`) and appends sourced `user/message` rows to the tail of the incoming message batch. The two injection routes each have a distinct job and both deduplicate at the event level — they do **not** re-inject on every tool step.

### Route 1 — Project recall (`form: 'recall'`, on by default)

Injects **once** per session the agentmemory **`/context` project-level cross-session window** ("what this project has done before", excluding the current session). `session/created` → `/session/start` caches `context` from the response; the first step in `agent/pre-step` that has a cached window appends it once (`st.injectedContext` dedup); every `user/message` still refreshes the cache asynchronously.

### Route 2 — Semantic recall (`form: 'semantic'`, off by default)

Each `user/message` runs a `/smart-search` (BM25 + vector + graph) on the raw text and assembles the recalled memory **titles** into one injected message (`st.semanticSeq` dedups per message). Precise recall (`/search`) is still left to the agent's explicit `memory_recall` tool.

### Pre-compaction re-inject (`injectContextOnCompaction`, on by default)

`compaction/start` triggers a `/context` refresh and the next `agent/pre-step` re-injects the latest project window so project background survives history compression.

## Session lifecycle → agentmemory mapping

The bridge maps every DSH event to an agentmemory **standard hookType** so the daemon's compression pipeline reads real content (custom hookTypes collapse to `{timestamp, hookType}`, degrading summaries):

| DSH event | hookType | standard `data` fields | dedup discriminator |
| --- | --- | --- | --- |
| `user/message` | `prompt_submit` | `prompt=content` | `tool_input=content` (identical prompts merge naturally) |
| `assistant/message` | `post_tool_use` | `tool_name='assistant_message'`, `tool_output=content` | `tool_input='#'+seq` (unique; content not in Input) |
| `tool/call` | `dsh_tool_call` | `tool_name='dsh_call'` | `tool_input='call#'+callId` (not merged with the result) |
| `tool/result` (ok) | `post_tool_use` | `tool_name/tool_input/tool_output` (callMeta fallback) | `tool_input=args` |
| `tool/result` (err) | `post_tool_failure` | same + `error` | `tool_input=args` |
| `turn/end` | `dsh_turn_end` | — | `tool_input='turn#'+seq` (unique) |

**Dedup-safe design**: agentmemory's `mem::observe` drops duplicates by `sha256(sessionId, tool_name||hookType, tool_input[0..500])` with a 5-minute TTL; a hit discards the observation. The bridge uses a per-session monotonic `seq` and natural content/`callId` as the `tool_input` discriminator, so multiple rows of the same kind all persist while identical prompts / identical `(tool, args)` results still merge naturally.

## Model tools

| Tool | Arguments | Description |
| --- | --- | --- |
| `memory_recall` | `query` (required), `limit?`, `project?`, `agentId?` | Auto-locates project from the calling session; recalls across sessions. Scope by project, and optionally by `agentId` (omit = across every agent of the project, so historical pre-agentId rows stay recallable). Written rows are stamped with the plugin agentId: env `AGENT_ID` → config `agentId` → default `"dsh"` |
| `memory_remember` | `content` (required), `type?`, `concepts?`, `ttlDays?` | Curated, durable memory; `type` ∈ pattern/preference/architecture/bug/workflow/fact |

Tools are defined with `defineTool` and registered through `ctx.tools.register`, and daemon transport runs over the host `shell` seam (`inject: ['tools', 'shell']`); both are cleaned up automatically with the plugin Fiber lifecycle. On failure, `execute` returns `{ok: false, error}` rather than throwing.

## Model Experience

### Common requests

#### What the model sees

The bridge does not alter accepted input. Its observable model input is additive after the incoming batch: one injected sourced `user/message` per projective event, whose `text` is the project `/context` window (route 1), the semantic recall titles (route 2), or a pre-compaction re-inject of the project window (`source.kind === 'plugin'`, `plugin === 'agentmemory'`, `form` `'recall'` / `'semantic'`). Tool calls `memory_recall` and `memory_remember` are registered only when `enableTools` is true.

#### Token effect

Conditional. Injection contributes extra input tokens only at the dedup boundaries — once per session for project recall, once per user message for semantic recall when enabled, and once per compaction — not per tool step. Capped by `injectContextMaxChars` / `injectSemanticMaxChars`. Tool schemas add a small fixed token cost while `enableTools` is true. Tool responses are returned to the model's context window normally.

#### KV Cache effect

Append-only, prefix-stable. Injected messages are appended at the tail of the step's message batch, so the prior message prefix is preserved and reusable; re-injection changes the suffix. The dedup conditions (`injectedContext`, `injectedSemanticKey`, `compactionInject`) prevent repeated appends of the same block at the same boundary, so a stable prefix is not invalidated by the bridge's own activity across steps.

## Transport and failure semantics

- The sandbox has no `fetch`/require/timers; outbound traffic goes through the `shell` capability seam, one curl per call with the JSON body on stdin (`--data-binary @-`).
- **Never veto a lifecycle event**: listeners are fully try/catch guarded.
- Infrastructure failures re-queue and retry at the next checkpoint; payload-level failures are logged and dropped.
- Flush race: if a flush is in flight when new events arrive, the `dirty` flag makes the in-flight loop re-send them, so nothing is lost.

## Verification

```bash
cd plugins/agentmemory
node scripts/boot-check.mjs   # module + Config schema + daemon livez + peer deps (7 checks)
node test/smoke.mjs           # end-to-end (needs the daemon on :3111)
```

The smoke test covers: Config schema validation (including rejecting invalid values), the `apply` liveness hard gate (including loud failure on an unreachable daemon), `defineTool` tool registration, the three secret env-reference forms, observation persistence and session state, and the `agent/pre-step` injection shape with watermark pass-through.

## Local development: resolving peer dependencies

The plugin imports `@deepseek-ai/schemastery` and `@deepseek-ai/dsh-tools` (peer deps, resolved by the harness at runtime). To run boot-check / smoke with plain Node from this repo without installing the whole harness, link the built-in packages in:

```bash
mkdir -p node_modules
ln -s <harness>/node_modules/@deepseek-ai node_modules/@deepseek-ai
```

(`<harness>` is the global dsh install directory; when installed via pnpm in a profile these resolve automatically and this step is unnecessary.)

## Files

| File | Purpose |
| --- | --- |
| `index.js` | Single static entry: `Config` schema, `inject`, `apply` (lifecycle + tools + injection + livez hard gate) |
| `index.d.ts` | `Config` type and the plugin's exported type surface |
| `cordis-row.example.yml` | Static composition row example (`name` uses a resolvable package name) |
| `scripts/boot-check.mjs` | Boot/CI readiness check (module + schema + daemon + peer deps, 7 checks) |
| `scripts/cleanup-smoke-sessions.mjs` | One-shot purge of `dsh-bridge-smoke-*` session/obs rows from the live daemon (dry-run default; `DRY_RUN=false` to delete) |
| `test/smoke.mjs` | End-to-end smoke test (writes to the isolated `dsh-smoke` project, never project `DSH`; self-cleans via the `iii` CLI when available) |
| `package.json` | Publishable structure (`dsh-agentmemory`, with peer deps) |

## Known Limitations and Deferred Work

- **Memory is shared across sessions by default** (no `agentId` is passed); to isolate, add an `agentId` to `observe`/remember calls.
- **Agent isolation is opt-in**: written rows carry the plugin agentId (env `AGENT_ID` → config `agentId` → default `"dsh"`), so `memory_recall` can filter by `agentId`. It does NOT pass the DSH session id as `agentId` (observations are stamped with the plugin agentId, not the session id).
- **Project resolution order**: `AGENTMEMORY_PROJECT_NAME` env var → git toplevel basename → cwd basename.
- **The bridge does not modify any `@deepseek-ai` package** and does not touch the shipped preset install directory.
