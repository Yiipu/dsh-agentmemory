# Development

Local-development notes for the dsh-agentmemory bridge. End-user documentation lives in the [README](README.md).

## Prerequisites

- Node >= 20
- A live agentmemory daemon (the plugin's load-time livez gate makes it a hard dependency). The smoke test hardcodes `http://localhost:3111`; boot-check accepts `--base-url=` to point elsewhere.
- The `@deepseek-ai/*` peer deps resolvable from this package (see below)

## Resolving peer dependencies

The plugin imports `@deepseek-ai/schemastery` and `@deepseek-ai/dsh-tools`. They are declared as `peerDependencies` but not installed by this repo — the dsh harness resolves them at runtime. To run boot-check / smoke with plain Node from a checkout without installing the whole harness, link the harness's built-in packages in:

Peer ranges are split by upstream versioning style. `cordis` / `schemastery` release stable semver, so a plain caret suffices (`^4.0.1` / `^3.18.1`). The dsh harness's dsh-side packages ship lockstep rc waves (`dsh-tools` and friends share one version per wave; 0.1.1-rc.2 = dist-tag `latest`, 0.1.2-rc.1 = `next`), and strict semver never matches a prerelease against a range unless some comparator shares its [major, minor, patch] tuple — so the `dsh-tools` range floors at the oldest verified wave and ORs in each newer verified wave: `^0.1.1-rc.2 || ^0.1.2-rc.1`. A bare `*` matches no prerelease at all under strict semver and would pin nothing above 0.x, which is why it is not used. Maintenance rule: when a new lockstep wave lands (e.g. 0.1.3-rc.1), verify the plugin's surfaces against it (boot-check + smoke) and append `|| ^0.1.3-rc.1`; drop old clauses once no shipped harness uses them.

```bash
mkdir -p node_modules
ln -s <harness>/node_modules/@deepseek-ai node_modules/@deepseek-ai
```

`<harness>` is the global dsh install directory. When the plugin is installed into a dsh profile via pnpm, these resolve automatically and this step is unnecessary. `node_modules/` is git-ignored.

## Checks

```bash
node scripts/boot-check.mjs   # module + Config schema + daemon livez + peer deps (7 checks)
node test/smoke.mjs           # end-to-end against the live daemon (needs :3111)
```

The smoke test drives the static host plugin with a mock Cordis ctx whose `shell` seam runs real curl against the live daemon. It covers: Config schema validation (including rejecting invalid values), the `apply` liveness hard gate (including loud failure on an unreachable daemon), `defineTool` tool registration, the three secret env-reference forms, tool contract guards (empty `query`/`content` rejected, `AbortSignal` short-circuits), observation persistence and session state (title/type/narrative shape), the approval → notification row, turn/end reason searchable in the narrative, no phantom `tool/call` row, the compaction/summary → `/remember` bridge, and the `agent/pre-step` injection shape. Not covered: the `tool/result` error path (`post_tool_failure`) and the pre-compaction re-inject.

## Logs & debugging

All plugin errors surface in the dsh host process's stdout/stderr with an `[agentmemory]` prefix — a failed `apply()` (unreachable daemon, unset secret env) appears in the host startup log, and runtime failures (`observe failed, re-queuing tail`, `session/start failed`, `context refresh failed`) in the running log. The `[agentmemory] bridge active: …` banner confirms a successful load. Common paths: livez failure → check the daemon is up and `baseUrl` is right; `secret env … is unset` → set the variable where dsh is launched; repeated `observe failed` → the daemon restarted mid-session; buffered rows re-queue and flush at the next checkpoint.

## Smoke-test fixtures and cleanup

Every smoke run writes fixture data into the **live daemon** (never project `DSH` or any real repo — the test's fake cwd is `/nonexistent/dsh-smoke-test`, so project resolution is isolated): observations land under project `dsh-smoke-test` (the fake cwd's basename), and a seeded summary row uses project `dsh-smoke`. Session ids are `dsh-bridge-smoke-*`. The test self-cleans its session when the `iii` CLI is on PATH (`iii` is the iii engine's admin CLI, installed alongside the agentmemory daemon — see the [iii engine](https://github.com/iii-hq/iii); 49134 is its default trigger port — adjust `--port` if your engine listens elsewhere):

```bash
iii trigger state::delete --json '{"scope":"mem:sessions","key":"<sessionId>"}' --port 49134
```

and prints a notice otherwise. Leftover rows live only in those isolated test projects and can be purged with:

```bash
node scripts/cleanup-smoke-sessions.mjs            # dry run (default)
DRY_RUN=false node scripts/cleanup-smoke-sessions.mjs   # actually delete
```

When developing against a local agentmemory checkout, the same `state::delete` trigger with scopes `mem:sessions`, `mem:obs:<sessionId>`, or the stream keys removes individual rows by hand.

## HMR / loader cache

Host `index.js` edits take effect when the loader re-imports the plugin row — Node's ESM cache keys on the resolved module URL, so bump the row's package version (e.g. `dsh-agentmemory@0.4.1`) once to bust it.

## Repository layout

| File | Purpose |
| --- | --- |
| `index.js` | Single static entry: `Config` schema, `inject`, `apply` (lifecycle + tools + injection + livez hard gate) |
| `index.d.ts` | `Config` type and the plugin's exported type surface |
| `package.json` | peer-dependency ranges (`cordis` / `dsh-tools` / `schemastery`) and the `dsh.bundle.patch` declaration |
| `cordis-row.example.yml` | Static composition row example (`name` uses a resolvable package name) |
| `cordis.patch.yml` | dsh bundle patch declaration (see `package.json` → `dsh.bundle.patch`) |
| `scripts/boot-check.mjs` | Boot/CI readiness check (module + schema + daemon + peer deps, 7 checks; `--base-url=` to retarget) |
| `scripts/cleanup-smoke-sessions.mjs` | One-shot purge of `dsh-bridge-smoke-*` session/obs rows from the live daemon (dry-run default; `DRY_RUN=false` to delete) |
| `test/smoke.mjs` | End-to-end smoke test (writes only to the isolated `dsh-smoke-test` / `dsh-smoke` test projects; hardcodes `:3111`) |
