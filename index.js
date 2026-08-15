/**
 * dsh-agentmemory — DSH ↔ agentmemory session-memory bridge (static host plugin).
 *
 * Backend-only: no browser half, no settings UI, no config persistence file. All
 * configuration comes from the cordis.yml row; editing the row's `config` (or the
 * file that carries it) is how you change configuration.
 *
 * Responsibilities:
 *   - mirror the DSH session lifecycle into agentmemory with standard hookTypes
 *     (compression-friendly, dedup-safe);
 *   - expose memory_recall / memory_remember model tools;
 *   - inject agentmemory context into the model request via the agent/pre-step
 *     waterfall (project recall once per session, optional semantic recall, and a
 *     pre-compaction re-inject).
 *
 * The daemon is a hard dependency: when the plugin loads it verifies the daemon is
 * reachable (livez) and fails loudly if it is not, rather than silently carrying on.
 *
 * Transport: the host sandbox has no `fetch`/require/timers, so outbound HTTP runs
 * one curl per call with the JSON body on stdin (`--data-binary @-`) through the
 * `shell` capability seam. Runtime daemon failures are logged and contained — they
 * never veto a session lifecycle event or fail a model step.
 *
 * Install: mount `name: "dsh-agentmemory"` in a cordis.yml row (see
 * cordis-row.example.yml). Requires Node >= 20 and a `shell` seam on the host.
 */
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'agentmemory'

/** Validated, default-filled configuration accepted from the cordis.yml row. */
export const Config = Schema.object({
  baseUrl: Schema.string().default('http://localhost:3111'),
  /** Bearer token. A bare string is used verbatim; `${VAR}` (`${VAR:default}` / `${VAR:?error}`) reads an environment variable, resolved via the shell seam at load. */
  secret: Schema.string().default(''),
  /** Master switch for the observation bridge. When false the bridge writes nothing but tools and injection stay live. */
  enabled: Schema.boolean().default(true),
  /** Register memory_recall / memory_remember. */
  enableTools: Schema.boolean().default(true),
  /** Mirror session/start and session/end rows. */
  enableSessionStartEnd: Schema.boolean().default(true),
  /** Per-request curl deadline. */
  curlTimeoutMs: Schema.number().min(1).max(60000).default(4000),
  /** Flush a session buffer at this many buffered observations. */
  observeBatchLimit: Schema.number().min(1).max(200).default(20),
  /** Per-observation content cap. */
  maxContentChars: Schema.number().min(1).max(100000).default(4000),
  /** Tool-call arguments cap. */
  maxArgsChars: Schema.number().min(1).max(50000).default(2000),
  /** Project recall: inject the /context window once per session. */
  injectContext: Schema.boolean().default(true),
  /** Cap on the injected project context window text. */
  injectContextMaxChars: Schema.number().min(1).max(200000).default(6000),
  /** Re-inject /context right before compaction so the compressed history keeps it. */
  injectContextOnCompaction: Schema.boolean().default(true),
  /** Semantic recall: per-user-message /smart-search injection. */
  injectSemantic: Schema.boolean().default(false),
  /** Cap on smart-search results folded into the semantic block. */
  injectSemanticMaxResults: Schema.number().min(1).max(50).default(8),
  /** Cap on the rendered semantic recall text. */
  injectSemanticMaxChars: Schema.number().min(1).max(100000).default(3000),
})

export const inject = ['tools']

// ── pure helpers ─────────────────────────────────────────────────────────────

const str = (v) => (typeof v === 'string' ? v : '')

function iso(ms) {
  return new Date(ms).toISOString()
}

function projectOf(cwd) {
  const c = str(cwd).trim()
  if (!c) return 'DSH'
  const seg = c.split(/[\\\/]/).filter(Boolean).pop()
  return seg || 'DSH'
}

/** Dig the human-readable text out of ContentBlock[] (or any block-ish value). */
function blockText(blocks, cap, depth = 0) {
  if (!Array.isArray(blocks)) return ''
  if (depth > 4) return ''
  const parts = []
  for (const block of blocks) {
    if (typeof block === 'string') {
      if (block) parts.push(block)
    } else if (block && typeof block === 'object') {
      if (typeof block.text === 'string' && block.text) {
        parts.push(block.text)
      } else if (Array.isArray(block.content)) {
        const inner = blockText(block.content, cap, depth + 1)
        if (inner) parts.push(inner)
      }
    }
  }
  const joined = parts.join('\n')
  return joined.length > cap ? joined.slice(0, cap) : joined
}

function capped(v, cap) {
  const s = str(v)
  return s.length > cap ? s.slice(0, cap) : s
}

const ENV_REF = /^\$\{([A-Za-z_][A-Za-z0-9_]*)(?::(-?[^}]*))?\}$/

/**
 * Resolve the configured secret, honoring an environment-variable reference.
 * A plain string is returned unchanged. `${VAR}` reads the variable (error if
 * unset); `${VAR:default}` falls back to the default; `${VAR:?err}` throws
 * `err` when the variable is unset. Env reads happen through the `shell` seam
 * (the sandbox has no direct env access); a missing seam fails loudly.
 */
async function resolveSecret(secret, getShell) {
  const s = str(secret)
  if (!s) return ''
  if (!ENV_REF.test(s)) return s
  const match = s.match(ENV_REF)
  const name = match[1]
  const spec = match[2]
  const shell = getShell()
  if (!shell || typeof shell.resolve !== 'function' || typeof shell.run !== 'function') {
    throw new Error('[agentmemory] secret references env ' + name + ' but no shell seam is available to read it')
  }
  let command
  if (spec === undefined) {
    command = 'printenv ' + name + ' || { echo "missing"; exit 1; }'
  } else if (spec.startsWith('?')) {
    command = 'printenv ' + name + ' || { echo "' + spec.slice(1) + '"; exit 1; }'
  } else {
    command = 'printenv ' + name + ' || echo "' + spec + '"'
  }
  const res = await shell.run(shell.resolve({ command, timeoutMs: 3000, stdoutMaxBytes: 8192 }))
  const value = (res && res.exitCode === 0 && res.stdout && res.stdout.text.trim()) || ''
  if (value) return value
  if (spec === undefined) {
    throw new Error('[agentmemory] secret env ' + name + ' is unset and the reference declares no default')
  }
  if (spec.startsWith('?')) throw new Error(spec.slice(1))
  return spec
}

// ── event → observation mapping (dedup-safe) ────────────────────────────────
// Maps each session event to standard agentmemory hookTypes so the daemon's
// compression pipeline reads real content (mem::observe extracts compression
// fields ONLY for these hookTypes; custom ones collapse to "only timestamp and hook").
// Dedup safety: mem::observe drops duplicates by sha256(sessionId, tool_name||hookType,
// tool_input[0..500]) with a 5-min TTL, so every stored observation needs a distinct
// (tool_name, tool_input) in the window or it is silently lost. Per-observation unique
// discriminators (`#'+seq`, callId, turn#seq) live in tool_input; natural dedup (identical
// prompts, identical (tool,args) results) is preserved.
function observationFor(event, st) {
  const cfg = st.cfg
  const d = event && event.data ? event.data : {}
  const seq = ++st.seq
  switch (event.type) {
    case 'user/message': {
      const m = messagePayload(d)
      const content = blockText(m.content, cfg.maxContentChars)
      return { hookType: 'prompt_submit', data: { source: str(m.source.kind) || 'user', prompt: content, tool_input: content, content } }
    }
    case 'assistant/message': {
      const m = messagePayload(d)
      const content = blockText(m.content, cfg.maxContentChars)
      return { hookType: 'post_tool_use', data: { tool_name: 'assistant_message', tool_output: content, tool_input: '#' + seq, content, provider: str(m.source.provider), model: str(m.source.model) } }
    }
    case 'tool/call':
      return { hookType: 'dsh_tool_call', data: { tool_name: 'dsh_call', tool_input: 'call#' + (capped(d.callId, 200) || String(seq)), name: capped(d.name, 200), arguments: capped(d.arguments, cfg.maxArgsChars), callId: capped(d.callId, 200) } }
    case 'tool/result': {
      const m = messagePayload(d)
      const callId = capped(d.callId || (m.source && m.source.callId), 200)
      const isError = !!(d.error || (d.message && typeof d.message === 'object' && d.message.isError))
      const errorName = d.error && typeof d.error === 'object' ? capped(d.error.name, 200) : ''
      const content = blockText(m.content, cfg.maxContentChars)
      let toolName = ''; let toolInput = ''
      if (callId && st.callMeta) { const meta = st.callMeta.get(callId); if (meta) { toolName = meta.name; toolInput = meta.args } }
      if (!toolName) toolName = (typeof d.name === 'string' && d.name) ? capped(d.name, 200) : 'tool'
      if (!toolInput) toolInput = 'result#' + (callId || seq)
      return { hookType: isError ? 'post_tool_failure' : 'post_tool_use', data: { tool_name: toolName, tool_input: toolInput, tool_output: content, callId, content, isError, errorName } }
    }
    case 'turn/end':
      return { hookType: 'dsh_turn_end', data: { tool_name: 'dsh_turn_end', tool_input: 'turn#' + seq, reason: d.reason && typeof d.reason === 'object' ? str(d.reason.kind) : 'completed' } }
    default:
      return null // boundaries, chunks, todo/write, request/* are log-only noise
  }
}

/** Unwrap the live event-data shape: the runtime nests payload under data.message. */
function messagePayload(d) {
  const m = d.message && typeof d.message === 'object' ? d.message : d
  return { content: m.content, source: m.source && typeof m.source === 'object' ? m.source : (d.source && typeof d.source === 'object' ? d.source : {}) }
}

// ── the plugin ──────────────────────────────────────────────────────────────

export async function apply(ctx, config) {
  const cfg = { ...config }
  const getShell = () => ctx.get('shell')

  // Secret: resolve an env reference before anything touches the daemon.
  cfg.secret = await resolveSecret(cfg.secret, getShell)

  // Hard-dependency gate: the daemon must be reachable at load (or the plugin
  // fails loudly). Uses one liveness probe with the configured curl deadline.
  {
    const shell = getShell()
    if (!shell || typeof shell.resolve !== 'function' || typeof shell.run !== 'function') {
      throw new Error('[agentmemory] agentmemory is a hard dependency but no shell seam is available to reach it')
    }
    const argv = ['curl', '-fsS', '-m', String(cfg.curlTimeoutMs), cfg.baseUrl + '/agentmemory/livez']
      .concat(cfg.secret ? ['-H', 'Authorization: Bearer ' + cfg.secret] : [])
    const res = await shell.run(shell.resolve({
      command: argv.map((a) => (a.includes(' ') ? "'" + a + "'" : a)).join(' '),
      timeoutMs: cfg.curlTimeoutMs + 1500,
      stdoutMaxBytes: 16384,
    }))
    if (res.exitCode !== 0) {
      const detail = (res.stderr && res.stderr.text || '').slice(0, 300)
      throw new Error('[agentmemory] daemon unreachable at ' + cfg.baseUrl + ' (curl ' + res.exitCode + '): ' + detail)
    }
    let body = null
    try { body = JSON.parse(res.stdout.text || '{}') } catch { throw new Error('[agentmemory] daemon at ' + cfg.baseUrl + ' returned a malformed livez payload') }
    if (!body || body.status !== 'ok') throw new Error('[agentmemory] daemon at ' + cfg.baseUrl + ' did not report a healthy livez')
  }

  const sessions = new Map() // sessionId -> bridge state

  function stateFor(session) {
    const id = String(session.id)
    let st = sessions.get(id)
    if (!st) {
      const cwd = session.header && typeof session.header.cwd === 'string' ? session.header.cwd : ''
      st = { id, cwd, cfg, project: projectOf(cwd), started: false, buffer: [], flushing: false, seq: 0, callMeta: new Map(), context: '', contextFetches: 0, injectedContext: false, semantic: null, injectedSemanticKey: '', semanticSeq: 0, compactionInject: false }
      sessions.set(id, st)
    }
    return st
  }

  // Canonical project identity: AGENTMEMORY_PROJECT_NAME env → git toplevel → cwd.
  // Best-effort via the shell seam; any failure keeps the cwd-basename fallback.
  async function resolveProject(cwd) {
    const fallback = projectOf(cwd)
    const shell = getShell()
    if (!shell || !cwd) return fallback
    try {
      const envRes = await shell.run(shell.resolve({ command: 'printenv AGENTMEMORY_PROJECT_NAME || true', timeoutMs: 2000, stdoutMaxBytes: 1024 }))
      const envVal = envRes && envRes.exitCode === 0 && envRes.stdout ? envRes.stdout.text.trim() : ''
      if (envVal) return envVal
      const gitRes = await shell.run(shell.resolve({ command: "git -C '" + cwd.replace(/'/g, "'\''") + "' rev-parse --show-toplevel", timeoutMs: 3000, stdoutMaxBytes: 4096 }))
      if (gitRes && gitRes.exitCode === 0 && gitRes.stdout) {
        const top = gitRes.stdout.text.trim()
        if (top) return top.split(/[\\\/]/).filter(Boolean).pop() || fallback
      }
    } catch (_resolveProjectFailure) { /* keep the cwd basename */ }
    return fallback
  }

  // One HTTP POST. Body rides on curl stdin so it never touches the command string.
  async function post(path, payload) {
    const shell = getShell()
    if (!shell) throw new Error('shell service unavailable')
    const argv = ['curl', '-sS', '-m', String(cfg.curlTimeoutMs), '-X', 'POST', '-H', 'Content-Type: application/json']
      .concat(cfg.secret ? ['-H', 'Authorization: Bearer ' + cfg.secret] : [], ['--data-binary', '@-', cfg.baseUrl + path])
    const res = await shell.run(shell.resolve({
      command: argv.map((a) => (a.includes(' ') ? "'" + a + "'" : a)).join(' '),
      stdin: JSON.stringify(payload),
      timeoutMs: cfg.curlTimeoutMs + 1500,
      stdoutMaxBytes: 131072,
    }))
    if (res.exitCode !== 0) throw new Error('curl exit ' + res.exitCode + ': ' + (res.stderr ? res.stderr.text : '').slice(0, 300))
    return res.stdout ? res.stdout.text : ''
  }

  async function postJson(path, payload) {
    const text = await post(path, payload)
    try { return JSON.parse(text) } catch { return { raw: text } }
  }

  async function postObserve(st, obs) {
    await post('/agentmemory/observe', { hookType: obs.hookType, sessionId: st.id, project: st.project, cwd: st.cwd, timestamp: obs.timestamp, data: obs.data })
  }

  async function flushSession(st) {
    if (st.flushing) { st.dirty = true; return }
    st.flushing = true
    try {
      do {
        st.dirty = false
        const batch = st.buffer
        if (!batch.length) break
        st.buffer = []
        for (let i = 0; i < batch.length; i++) {
          try { await postObserve(st, batch[i]) }
          catch (err) { console.error('[agentmemory] observe failed, re-queuing tail (' + err.message + ')'); st.buffer = batch.slice(i).concat(st.buffer); return }
        }
      } while (st.dirty && st.buffer.length)
    } finally { st.flushing = false }
  }

  async function announceSession(st) {
    if (!cfg.enableSessionStartEnd || !st.cwd) {
      if (cfg.injectContext && st.cwd) void refreshContext(st).catch(() => { /* best-effort */ })
      return
    }
    try {
      st.project = await resolveProject(st.cwd)
      const body = await postJson('/agentmemory/session/start', { sessionId: st.id, project: st.project, cwd: st.cwd })
      st.started = true
      if (cfg.injectContext && body && typeof body.context === 'string') st.context = body.context
    } catch (err) { console.error('[agentmemory] session/start failed: ' + err.message) }
  }

  async function endSession(st) {
    try { await flushSession(st) } catch (err) { console.error('[agentmemory] final flush failed: ' + err.message) }
    if (cfg.enableSessionStartEnd) {
      try { await post('/agentmemory/session/end', { sessionId: st.id }) }
      catch (err) { console.error('[agentmemory] session/end failed: ' + err.message) }
    }
  }

  async function refreshContext(st) {
    try {
      const body = await postJson('/agentmemory/context', { sessionId: st.id, project: st.project })
      const text = body && typeof body.context === 'string' ? body.context : ''
      st.context = (text.length > cfg.injectContextMaxChars ? text.slice(0, cfg.injectContextMaxChars) : text).replace(/\s+$/, '')
      st.contextFetches += 1
    } catch (err) { console.error('[agentmemory] context refresh failed: ' + err.message + ' (keeping previous window)') }
  }

  async function refreshSemantic(st, userText, seq) {
    try {
      const body = await postJson('/agentmemory/smart-search', { query: userText, limit: cfg.injectSemanticMaxResults, project: st.project, sessionId: st.id })
      const results = body && Array.isArray(body.results) ? body.results : []
      const lines = []
      for (const r of results.slice(0, cfg.injectSemanticMaxResults)) {
        if (!r || typeof r !== 'object') continue
        const title = str(r.title)
        if (title) lines.push('- ' + title)
      }
      if (lines.length === 0) return
      let text = lines.join('\n')
      if (text.length > cfg.injectSemanticMaxChars) text = text.slice(0, cfg.injectSemanticMaxChars)
      st.semantic = { key: 'semantic:' + seq, text }
    } catch (err) { console.error('[agentmemory] semantic recall failed: ' + err.message) }
  }

  // ── model tools ────────────────────────────────────────────────────────────
  if (cfg.enableTools) {
    ctx.tools.register(defineTool({
      name: 'memory_recall',
      description: 'Recall relevant memories and observations from agentmemory (persistent memory across sessions). Use when the task depends on past sessions, prior decisions, or established project facts. Returns matched entries with content, type, and timestamps.',
      parameters: {
        query: { type: 'string', required: true, description: 'What to recall — a phrase describing the memory you need.' },
        limit: { type: 'integer', description: 'Maximum number of results (default 8).' },
        sessionId: { type: 'string', description: 'Optional DSH session id to scope recall; defaults to the calling session.' },
        project: { type: 'string', description: 'Optional agentmemory project filter; defaults to the calling session cwd basename.' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render(args, value) { return [{ type: 'text', text: JSON.stringify(value, null, 2) }] } },
      async execute(args, exec) {
        try {
          const a = args && typeof args === 'object' ? args : {}
          const session = exec && exec.agent ? exec.agent.session : undefined
          const sid = str(a.sessionId) || (session ? String(session.id) : '')
          const project = str(a.project) || (session && session.header ? projectOf(session.header.cwd) : undefined)
          const body = { query: str(a.query), limit: typeof a.limit === 'number' ? Math.min(Math.max(1, Math.floor(a.limit)), 50) : 8 }
          if (project) body.project = project
          if (sid) body.agentId = sid
          const result = await postJson('/agentmemory/search', body)
          return result && typeof result === 'object' ? result : { results: [], raw: result }
        } catch (err) { return { ok: false, error: err.message } }
      },
    }))

    ctx.tools.register(defineTool({
      name: 'memory_remember',
      description: 'Explicitly persist a curated memory (decision, preference, architecture fact, bug, workflow, or general fact) to agentmemory. Use for durable facts worth recalling in future sessions; ordinary conversation is captured automatically by the observation bridge.',
      parameters: {
        content: { type: 'string', required: true, description: 'The memory text — the durable fact or decision to persist.' },
        type: { type: 'string', enum: ['pattern', 'preference', 'architecture', 'bug', 'workflow', 'fact'], description: 'Memory category (default fact).' },
        concepts: { type: 'array', items: { type: 'string' }, description: 'Optional concept tags for retrieval.' },
        ttlDays: { type: 'integer', description: 'Optional retention in days; omit for no expiry.' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render(args, value) { return [{ type: 'text', text: JSON.stringify(value, null, 2) }] } },
      async execute(args, exec) {
        try {
          const a = args && typeof args === 'object' ? args : {}
          const session = exec && exec.agent ? exec.agent.session : undefined
          const body = { content: str(a.content) }
          if (typeof a.type === 'string' && ['pattern', 'preference', 'architecture', 'bug', 'workflow', 'fact'].includes(a.type)) body.type = a.type
          if (Array.isArray(a.concepts)) body.concepts = a.concepts.filter((c) => typeof c === 'string').slice(0, 20)
          if (typeof a.ttlDays === 'number' && a.ttlDays > 0) body.ttlDays = Math.floor(a.ttlDays)
          if (session && session.header && typeof session.header.cwd === 'string') body.project = projectOf(session.header.cwd)
          const result = await postJson('/agentmemory/remember', body)
          return result && typeof result === 'object' ? result : { ok: false, raw: result }
        } catch (err) { return { ok: false, error: err.message } }
      },
    }))
  }

  // ── context injection (agent/pre-step waterfall) ───────────────────────────
  if (cfg.injectContext || cfg.injectSemantic) {
    ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      if (decision.kind === 'reject') return decision
      if (payload.signal && payload.signal.aborted) return decision
      const session = payload.agent && payload.agent.session
      const st = session ? sessions.get(String(session.id)) : undefined
      if (!st) return decision

      const appended = []
      if (cfg.injectContext && !st.injectedContext && st.context) {
        st.injectedContext = true
        appended.push({ role: 'user', content: [{ type: 'text', text: st.context }], source: { kind: 'plugin', plugin: 'agentmemory', form: 'recall' } })
      }
      if (cfg.injectContext && st.compactionInject && st.context) {
        st.compactionInject = false
        appended.push({ role: 'user', content: [{ type: 'text', text: st.context }], source: { kind: 'plugin', plugin: 'agentmemory', form: 'recall' } })
      }
      if (cfg.injectSemantic && st.semantic && st.semantic.key && st.semantic.key !== st.injectedSemanticKey) {
        st.injectedSemanticKey = st.semantic.key
        appended.push({ role: 'user', content: [{ type: 'text', text: st.semantic.text }], source: { kind: 'plugin', plugin: 'agentmemory', form: 'semantic' } })
      }

      if (appended.length === 0) return decision
      const messages = [...decision.messages]
      for (const msg of appended) messages.push({ id: crypto.randomUUID(), ...msg })
      return { kind: 'enter', messages }
    }, { prepend: true })
  }

  // ── session lifecycle wiring ───────────────────────────────────────────────
  ctx.on('session/created', (session) => {
    if (!cfg.enabled) return
    try { void announceSession(stateFor(session)) }
    catch (err) { console.error('[agentmemory] session/created handler failed: ' + err.message) }
  })

  ctx.on('session/event', (session, event) => {
    if (!cfg.enabled) return
    try {
      const st = stateFor(session)
      if (event.type === 'user/message') {
        if (cfg.injectContext) void refreshContext(st).catch(() => { /* best-effort */ })
        if (cfg.injectSemantic) {
          st.semanticSeq += 1
          const m = messagePayload(event.data)
          const userText = blockText(m.content, 2000)
          if (userText) void refreshSemantic(st, userText, st.semanticSeq).catch(() => { /* best-effort */ })
        }
      }
      if (event.type === 'compaction/start' && cfg.injectContext && cfg.injectContextOnCompaction) {
        void refreshContext(st).then(() => { st.compactionInject = !!st.context }).catch(() => { /* best-effort */ })
      }
      if (event.type === 'tool/call' && event.data && typeof event.data.callId === 'string') {
        if (st.callMeta.size >= 1000) { const oldest = st.callMeta.keys().next().value; if (oldest !== undefined) st.callMeta.delete(oldest) }
        st.callMeta.set(event.data.callId, { name: str(event.data.name), args: capped(event.data.arguments, cfg.maxArgsChars) })
      }
      const obs = observationFor(event, st)
      if (!obs) return
      obs.timestamp = iso(event.time || Date.now())
      st.buffer.push(obs)
      if (st.flushing) {
        st.dirty = true
      } else if (st.buffer.length >= cfg.observeBatchLimit) {
        void flushSession(st).catch((err) => console.error('[agentmemory] batch flush failed: ' + err.message))
      }
    } catch (err) { console.error('[agentmemory] session/event handler failed: ' + err.message) }
  })

  ctx.on('session/flush', async (session) => {
    if (!cfg.enabled) return
    const st = sessions.get(String(session.id))
    if (st) await flushSession(st)
  })

  ctx.on('session/disposed', (session) => {
    if (!cfg.enabled) return
    try {
      const st = sessions.get(String(session.id))
      if (!st) return
      sessions.delete(String(session.id))
      void endSession(st).catch((err) => console.error('[agentmemory] session/end failed: ' + err.message))
    } catch (err) { console.error('[agentmemory] session/disposed handler failed: ' + err.message) }
  })

  console.log('[agentmemory] bridge active: ' + cfg.baseUrl + ' (enabled=' + cfg.enabled + ', tools=' + cfg.enableTools + ', injectContext=' + cfg.injectContext + ', injectSemantic=' + cfg.injectSemantic + ')')
}