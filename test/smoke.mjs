/**
 * Smoke test for the dsh-agentmemory bridge plugin (backend-only rewrite).
 *
 * Drives the static host plugin with a mock Cordis ctx whose `shell` seam runs
 * REAL curl against the live agentmemory daemon (must be up on :3111):
 *
 *   1. Config schema validation (fail-loud on bad values).
 *   2. apply() with the async liveness gate (passes against the live daemon).
 *   3. memory_recall / memory_remember register through ctx.tools via defineTool.
 *   4. secret env-reference resolution: ${VAR} / ${VAR:default} / ${VAR:?error}.
 *   5. Liveness gate fails loudly when the daemon is unreachable.
 *   6. Session lifecycle → standard hookTypes stored in the real daemon.
 *   7. agent/pre-step context injection shape.
 *
 * Run:  node test/smoke.mjs   (agentmemory daemon on :3111)
 *
 * Requires the @deepseek-ai/* peer deps to be resolvable from this package.
 * In a pnpm profile they come from the harness install; for local runs use the
 * node_modules symlink set up in the repo (see README).
 */
import { spawn } from 'node:child_process'

const BASE = 'http://localhost:3111'
const SESSION_ID = 'dsh-bridge-smoke-' + Date.now()

// ── fake shell seam: resolve() fills defaults, run() execs real curl ────────
const fakeShell = {
  resolve(req) { return { ...req, workdir: req.workdir ?? process.cwd(), sandboxPolicy: undefined } },
  run(spec) {
    return new Promise((resolve, reject) => {
      const child = spawn('/bin/sh', ['-c', spec.command], { cwd: spec.workdir })
      let stdout = ''; let stderr = ''
      child.stdout.on('data', (d) => (stdout += d.toString()))
      child.stderr.on('data', (d) => (stderr += d.toString()))
      child.on('error', reject)
      child.on('close', (code) => {
        resolve({ exitCode: code, signal: null, timedOut: false, aborted: false, stdout: { text: stdout }, stderr: { text: stderr } })
      })
      if (spec.stdin) child.stdin.write(spec.stdin)
      child.stdin.end()
    })
  },
};

// ── mock ctx factory ────────────────────────────────────────────────────────
function makeCtx(tools) {
  const listeners = {}; const onOptions = {}
  const ctx = {
    get(name) { if (name === 'shell') return fakeShell; return undefined },
    on(name, fn, opts) { listeners[name] = fn; if (opts) onOptions[name] = opts; return () => {} },
    effect() { return () => {} },
    tools,
  };
  ctx.listeners = listeners; ctx.onOptions = onOptions
  return ctx
}

const session = { id: SESSION_ID, header: { cwd: '/Users/opal/workspace/DSH', createdAt: Date.now() } }
const ev = (type, data) => ({ type, seq: 0, time: Date.now(), data })
const execCtx = { agent: { session }, signal: new AbortController().signal }

const expectHookTypes = new Set(['prompt_submit', 'post_tool_use', 'dsh_tool_call', 'dsh_turn_end'])

async function fetchJson(path) {
  const res = await fetch(BASE + path)
  return res.json()
}

let failures = 0
const check = (label, ok, extra) => {
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (extra ? ' — ' + extra : ''))
  if (!ok) failures++
};

const mod = await import('../index.js')
const { name, Config, inject, apply } = mod

// ══ 1) Config schema validation ─────────────────────────────────────────────
console.log('── 1) Config schema (fail-loud) ──')
check('plugin exports name/Config/inject/apply', name === 'agentmemory' && !!Config && Array.isArray(inject) && typeof apply === 'function')
check('inject requires tools', inject.includes('tools'))
const bad = Config['~standard'].validate({ curlTimeoutMs: -5 })
check('invalid numeric config rejected (fail loud)', !!bad.issues, bad.issues && bad.issues[0] && bad.issues[0].message)
const good = Config['~standard'].validate({})
check('valid config fills defaults', !good.issues && good.value.observeBatchLimit === 20 && good.value.injectContext === true)

// ══ 2) apply + liveness gate ────────────────────────────────────────────────
console.log('── 2) apply() against live daemon ──')
const registeredTools = []
const toolsRegistry = { register: (def) => { registeredTools.push(def); return () => {} } }
const ctxA = makeCtx(toolsRegistry)
await apply(ctxA, Config['~standard'].validate({}).value)
check('apply resolves (liveness gate passed), 4 session + pre-step listeners',
  ['session/created', 'session/event', 'session/flush', 'session/disposed'].every((n) => typeof ctxA.listeners[n] === 'function') && typeof ctxA.listeners['agent/pre-step'] === 'function')
check('2 model tools registered', registeredTools.length === 2, JSON.stringify(registeredTools.map((t) => t.name)))

// ══ 3) tools against the real daemon ────────────────────────────────────────
console.log('── 3) model tools ──')
const recallTool = registeredTools.find((t) => t.name === 'memory_recall')
const rememberTool = registeredTools.find((t) => t.name === 'memory_remember')
const recallResult = await recallTool.execute({ query: 'auth middleware' }, execCtx)
check('memory_recall executes', recallResult && typeof recallResult === 'object')
const rememberResult = await rememberTool.execute({ content: 'DSH smoke: backend-only rewrite decision', type: 'architecture' }, execCtx)
check('memory_remember executes', rememberResult && typeof rememberResult === 'object')
check('memory_recall output.render returns blocks', Array.isArray(recallTool.output.render({ query: 'x' }, { results: [] })))

// contract guards: non-empty inputs and exec.signal short-circuit
const emptyRemember = await rememberTool.execute({ content: '   ' }, execCtx)
check('memory_remember rejects empty content', emptyRemember && emptyRemember.ok === false && /non-empty/.test(emptyRemember.error || ''))
const emptyRecall = await recallTool.execute({ query: '  ' }, execCtx)
check('memory_recall rejects empty query', emptyRecall && emptyRecall.ok === false && /non-empty/.test(emptyRecall.error || ''))
const aborted = new AbortController(); aborted.abort()
const cancelledRecall = await recallTool.execute({ query: 'anything' }, { agent: { session }, signal: aborted.signal })
check('memory_recall short-circuits on aborted exec.signal', cancelledRecall && cancelledRecall.ok === false && /cancelled/i.test(cancelledRecall.error || ''))
const cancelledRemember = await rememberTool.execute({ content: 'should not persist', type: 'fact' }, { agent: { session }, signal: aborted.signal })
check('memory_remember short-circuits on aborted exec.signal', cancelledRemember && cancelledRemember.ok === false && /cancelled/i.test(cancelledRemember.error || ''))

// ══ 4) secret env-reference resolution ──────────────────────────────────────
console.log('── 4) secret env resolution ──')
function shellEnvResolve(map) {
  const run = (spec) => {
    const cmd = spec.command
    const m = cmd.match(/printenv ([A-Za-z_][A-Za-z0-9_]*)/)
    if (!m) return fakeShell.run(spec) // non-printenv (e.g. the curl liveness probe) → real shell
    const v = map[m[1]]
    if (v) return Promise.resolve({ exitCode: 0, stdout: { text: v + '\n' }, stderr: { text: '' } })
    if (cmd.includes('exit 1')) {
      const errText = (cmd.match(/echo "([^"]*)"; exit 1/) || [])[1] || 'missing'
      return Promise.resolve({ exitCode: 1, stdout: { text: errText + '\n' }, stderr: { text: '' } })
    }
    if (cmd.includes('|| echo')) {
      const fb = (cmd.match(/echo "([^"]*)"/) || [])[1] || ''
      return Promise.resolve({ exitCode: 0, stdout: { text: fb + '\n' }, stderr: { text: '' } })
    }
    return Promise.resolve({ exitCode: 0, stdout: { text: '' }, stderr: { text: '' } })
  };
  return { resolve: (req) => req, run }
}
const ctxEnva = makeCtx(toolsRegistry); ctxEnva.get = () => shellEnvResolve({ AM_TOKEN: 'sekret' })
await apply(ctxEnva, Config['~standard'].validate({ secret: '${AM_TOKEN}' }).value)
check('${VAR} resolves from env (apply succeeds)', true)
const ctxEnvb = makeCtx(toolsRegistry); ctxEnvb.get = () => shellEnvResolve({})
await apply(ctxEnvb, Config['~standard'].validate({ secret: '${AM_TOKEN:fallback}' }).value)
check('${VAR:default} falls back when unset (apply succeeds)', true)
const ctxEnvc = makeCtx(toolsRegistry); ctxEnvc.get = () => shellEnvResolve({})
let threwError = false
try { await apply(ctxEnvc, Config['~standard'].validate({ secret: '${AM_TOKEN:?AM_TOKEN required}' }).value) } catch (e) { threwError = /AM_TOKEN required/.test(e.message) }
check('${VAR:?err} fails loudly with the custom message when unset', threwError)

// ══ 5) liveness gate fails loudly on unreachable daemon ─────────────────────
console.log('── 5) liveness gate (unreachable daemon) ──')
const ctxDead = makeCtx(toolsRegistry)
ctxDead.get = () => ({ resolve: (r) => r, run: () => Promise.resolve({ exitCode: 7, stdout: { text: '' }, stderr: { text: 'Connection refused' } }) })
let deadThrew = false
try { await apply(ctxDead, Config['~standard'].validate({ baseUrl: 'http://127.0.0.1:9' }).value) } catch (e) { deadThrew = /unreachable/.test(e.message) }
check('unreachable daemon rejects apply (loud) — liveness gate', deadThrew)

// ══ 6) lifecycle → standard hookTypes stored ───────────────────────────────
console.log('── 6) session lifecycle → agentmemory ──')
ctxA.listeners['session/created'](session)
await new Promise((r) => setTimeout(r, 600))
for (const e of [
  ev('user/message', { content: [{ type: 'text', text: 'Refactor the auth middleware to use async verify.' }], source: { kind: 'user' } }),
  ev('tool/call', { callId: 'call_1', name: 'bash', arguments: '{"command":"ls"}' }),
  ev('tool/result', { message: { source: { kind: 'tool', callId: 'call_1' }, content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'lib index.js' }] }] } }),
  ev('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }], source: { kind: 'model', provider: 'deepseek', model: 'deepseek-v4' } } }),
  ev('turn/end', { reason: { kind: 'completed' } }),
  ev('todo/write', { todos: [{ content: 'x' }] }),
]) ctxA.listeners['session/event'](session, e);
await ctxA.listeners['session/flush'](session)
ctxA.listeners['session/disposed'](session)
await new Promise((r) => setTimeout(r, 900))

const obsBody = await fetchJson('/agentmemory/observations?sessionId=' + encodeURIComponent(SESSION_ID))
const stored = obsBody.observations ?? []
const storedHookTypes = stored.map((o) => o.hookType).sort()
check('all standard hookTypes stored', [...expectHookTypes].every((h) => storedHookTypes.includes(h)), 'stored=' + JSON.stringify(storedHookTypes))
const storedText = JSON.stringify(stored)
check('tool/result content extracted', storedText.includes('lib index.js'))
check('assistant message content extracted', storedText.includes('Done.'))
const callCount = storedHookTypes.filter((h) => h === 'dsh_tool_call').length
const resultCount = storedHookTypes.filter((h) => h === 'post_tool_use').length
check('tool/call and its result both survive (no cross-dedup collapse)', callCount === 1 && resultCount >= 2, 'call=' + callCount + ' result=' + resultCount)
const sessBody = await fetchJson('/agentmemory/sessions?sessionId=' + encodeURIComponent(SESSION_ID))
const sessRows = (sessBody.sessions ?? []).filter((s) => s.id === SESSION_ID)
check('session row completed', sessRows.length === 1 && sessRows[0].status === 'completed')

// ══ 7) context injection (agent/pre-step) ───────────────────────────────────
console.log('── 7) context injection (agent/pre-step) ──')
const ctxC = makeCtx(toolsRegistry)
await apply(ctxC, Config['~standard'].validate({ injectContext: true, injectSemantic: false }).value)
await ctxC.listeners['session/created'](session)
await new Promise((r) => setTimeout(r, 1200))
const preStepListener = ctxC.listeners['agent/pre-step']
check('pre-step listener registered', typeof preStepListener === 'function')
const baseDecision = { kind: 'enter', messages: [{ id: 'm0', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }] }
const injected = await preStepListener(
  { agent: { session }, turn: 1, step: 1, signal: new AbortController().signal },
  async () => baseDecision,
)
check('pre-step returns enter', injected && injected.kind === 'enter')
check('appends exactly one injected message', Array.isArray(injected.messages) && injected.messages.length === baseDecision.messages.length + 1)
const added = injected.messages[injected.messages.length - 1]
check('injected message is user-role with text + plugin source',
  added.role === 'user' && Array.isArray(added.content) && added.content[0].type === 'text' && added.source && added.source.kind === 'plugin' && added.source.plugin === 'agentmemory' && added.source.form === 'recall')
const rejected = await preStepListener({ agent: { session }, signal: new AbortController().signal }, async () => ({ kind: 'reject' }))
check('rejected decision passes through', rejected && rejected.kind === 'reject')

console.log(failures === 0 ? 'SMOKE PASS' : 'SMOKE FAIL (' + failures + ' failures)')
process.exit(failures === 0 ? 0 : 1)