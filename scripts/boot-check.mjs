/**
 * boot-check.mjs — readiness gate for the dsh-agentmemory bridge (backend-only).
 * Run this at deployment boot (or CI) before relying on the bridge:
 *
 *   1. the plugin module loads and exports the Cordis plugin surface
 *      (name / inject / Config / apply);
 *   2. the Config schema fills defaults and rejects invalid values (fail-loud);
 *   3. the agentmemory daemon is reachable (livez) — a hard dependency;
 *   4. the package.json peer dependencies (@deepseek-ai/schemastery / dsh-tools)
 *      resolve (the local node_modules symlink is the dev convenience).
 *
 * Usage: node scripts/boot-check.mjs [--base-url http://localhost:3111]
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const require = createRequire(import.meta.url)
const baseUrl = (process.argv.find((a) => a.startsWith('--base-url=')) || '').split('=')[1] || 'http://localhost:3111'

let failures = 0
const fail = (msg) => { console.error('✗ ' + msg); failures++ }
const pass = (msg) => console.log('✓ ' + msg)

// 1. plugin module loads and exposes the manual-compliant surface
try {
  const mod = await import(join(root, 'index.js'))
  const okSurface = typeof mod.name === 'string' && Array.isArray(mod.inject) && mod.Config && typeof mod.Config['~standard'] === 'object' && typeof mod.apply === 'function'
  if (okSurface) pass('plugin exports name/inject/Config/apply')
  else fail('plugin missing part of the Cordis surface (name/inject/Config/apply)')
  if (Array.isArray(mod.inject) && mod.inject.includes('tools')) pass('inject requires tools')
  else fail('inject should include tools')

  // 2. Config schema validation
  const good = mod.Config['~standard'].validate({})
  if (!good.issues && good.value.baseUrl === 'http://localhost:3111' && good.value.injectContext === true) pass('Config fills defaults')
  else fail('Config defaults wrong: ' + JSON.stringify(good))
  const bad = mod.Config['~standard'].validate({ curlTimeoutMs: -5 })
  if (bad.issues && bad.issues.length > 0) pass('Config rejects invalid values (fail-loud)')
  else fail('Config accepted an invalid value')
} catch (err) {
  fail('plugin module failed to load: ' + (err && err.message ? err.message : err))
}

// 3. daemon reachable (hard dependency)
try {
  const res = await fetch(baseUrl + '/agentmemory/livez', { signal: AbortSignal.timeout(3000) })
  const body = await res.json()
  if (res.ok && body && body.status === 'ok') pass('agentmemory live at ' + baseUrl + ' (service=' + body.service + ')')
  else fail('agentmemory livez unexpected: HTTP ' + res.status + ' ' + JSON.stringify(body).slice(0, 200))
} catch (err) {
  fail('agentmemory unreachable at ' + baseUrl + ': ' + (err && err.message ? err.message : err))
}

// 4. peer deps declared in package.json and resolvable locally
try {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const peers = pkg.peerDependencies || {}
  const need = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/schemastery']
  const missingPkgs = need.filter((n) => !(n in peers))
  if (missingPkgs.length === 0) pass('package.json declares peer deps: ' + need.join(', '))
  else fail('package.json missing peer deps: ' + missingPkgs.join(', '))
  const resolvable = need.filter((n) => { try { require.resolve(n); return true } catch { return false } })
  if (need.every((n) => resolvable.includes(n))) pass('peer deps resolve locally:');
  else fail('peer deps not resolvable—link them: ln -s <harness>/node_modules/@deepseek-ai node_modules/@deepseek-ai');
} catch (err) {
  fail('peer-deps check failed: ' + (err && err.message ? err.message : err))
}

if (failures > 0) {
  console.error('boot-check FAILED (' + failures + ' issue(s))')
  process.exit(1)
}
console.log('boot-check OK — bridge ready to mount as a cordis.yml row.')