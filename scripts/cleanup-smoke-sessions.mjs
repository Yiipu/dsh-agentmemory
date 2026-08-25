#!/usr/bin/env node
/**
 * One-shot cleanup: remove dsh-bridge-smoke-* test sessions and their data from
 * the live agentmemory daemon (leftovers from test/smoke.mjs runs, which write
 * only to the isolated dsh-smoke-test / dsh-smoke test projects).
 *
 * Talks to the running iii engine over state::* (no daemon restart, no
 * state_store.db surgery). Dry-run by default; DRY_RUN=false performs deletes.
 */
import { execFileSync } from 'node:child_process'
const PORT = '49134'
const IS_SMOKE = (id) => /^dsh-bridge-smoke-/.test(id || '')
function trig(fn, payload) {
  const out = execFileSync('iii', ['trigger', fn, '--json', JSON.stringify(payload), '--port', PORT, '--timeout-ms', '20000'], { encoding: 'utf8' })
  if (!out || !out.trim()) return null
  try { return JSON.parse(out) } catch { return { raw: out } }
}
function unscoped(v) { return v && v.value !== undefined ? v.value : v }
function isErr(v) { return v && (v.success === false || !!v.error) }

const sessions = unscoped(trig('state::list', { scope: 'mem:sessions' })) || []
const smoke = sessions.filter((s) => IS_SMOKE(s.id))
console.log('smoke sessions found: ' + smoke.length)

const plan = []
for (const s of smoke) {
  const obsScope = 'mem:obs:' + s.id
  const obs = unscoped(trig('state::list', { scope: obsScope })) || []
  plan.push({ sessionId: s.id, obsScope, obsIds: obs.map((o) => o.id),
    hasSummary: !!unscoped(trig('state::get', { scope: 'mem:summaries', key: s.id })) })
}
const totalObs = plan.reduce((n, s) => n + s.obsIds.length, 0)
const totalSummaries = plan.filter((s) => s.hasSummary).length
const allObsIds = new Set(plan.flatMap((s) => s.obsIds))
console.log('total observations to remove: ' + totalObs + '; summaries: ' + totalSummaries + '; distinct obs ids: ' + allObsIds.size)

const memRefs = []
for (const obsId of allObsIds) {
  const m = unscoped(trig('state::get', { scope: 'mem:memories', key: obsId }))
  if (m) memRefs.push(obsId)
}
console.log('obs ids also present in mem:memories: ' + memRefs.length)

if (process.env.DRY_RUN !== 'false') { console.log('DRY RUN (set DRY_RUN=false to actually delete).'); process.exit(0) }

let deleted = 0, failed = 0
for (const s of plan) {
  for (const obsId of s.obsIds) {
    for (const [scope, key] of [[s.obsScope, obsId], ['mem:emb:' + obsId, 'default']]) {
      const r = trig('state::delete', { scope, key })
      if (isErr(r)) { failed++; console.log('  !! delete fail ' + scope + '/' + key + ': ' + JSON.stringify(r)) } else deleted++
    }
  }
  if (s.hasSummary) {
    const r = trig('state::delete', { scope: 'mem:summaries', key: s.sessionId })
    if (isErr(r)) { failed++; console.log('  !! summary delete fail: ' + JSON.stringify(r)) } else deleted++
  }
  const r = trig('state::delete', { scope: 'mem:sessions', key: s.sessionId })
  if (isErr(r)) { failed++; console.log('  !! session delete fail: ' + JSON.stringify(r)) } else deleted++
}
for (const obsId of memRefs) {
  const r = trig('state::delete', { scope: 'mem:memories', key: obsId })
  if (isErr(r)) { failed++ } else deleted++
}
console.log('deleted ' + deleted + ' kv entries, failures ' + failed)
try { trig('state::delete', { scope: 'mem:index:bm25', key: 'default' }); console.log('cleared mem:index:bm25 (rebuilds on next search)') }
catch (e) { console.log('note: could not clear bm25 index: ' + e.message) }
console.log('done.')
