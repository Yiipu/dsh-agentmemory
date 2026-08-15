/**
 * dsh-agentmemory — DSH ↔ agentmemory session-memory bridge (static host plugin).
 *
 * Backend-only. Exports the Cordis plugin (`name` / `inject` / `Config` / `apply`)
 * following the DSH plugin development manual. All configuration comes from the
 * cordis.yml row; there is no browser half and no persisted config file.
 */
import type Plugin from './index.js'
import type Schema from '@deepseek-ai/schemastery'

/** Configuration accepted from the cordis.yml row (the Schemastery `Config` schema in index.js). */
export interface AgentmemoryConfig {
  /** agentmemory REST base. */
  baseUrl?: string
  /** Bearer token; a bare string or a ${VAR} / ${VAR:default} / ${VAR:?error} env reference. */
  secret?: string
  /** Master switch for the observation bridge. */
  enabled?: boolean
  /** Register memory_recall / memory_remember. */
  enableTools?: boolean
  /** Mirror session/start and session/end rows. */
  enableSessionStartEnd?: boolean
  /** Per-request curl deadline. */
  curlTimeoutMs?: number
  /** Flush a session buffer at this many buffered observations. */
  observeBatchLimit?: number
  /** Per-observation content cap. */
  maxContentChars?: number
  /** Tool-call arguments cap. */
  maxArgsChars?: number
  /** Project recall: inject the /context window once per session. */
  injectContext?: boolean
  /** Cap on the injected project context window text. */
  injectContextMaxChars?: number
  /** Re-inject /context right before compaction. */
  injectContextOnCompaction?: boolean
  /** Semantic recall: per-user-message /smart-search injection. */
  injectSemantic?: boolean
  /** Cap on smart-search results folded into the semantic block. */
  injectSemanticMaxResults?: number
  /** Cap on the rendered semantic recall text. */
  injectSemanticMaxChars?: number
}

export const name: 'agentmemory'
export const inject: ['tools', 'shell']
export const Config: Schema<AgentmemoryConfig>
export function apply(ctx: Parameters<typeof Plugin['apply']>[0], config: AgentmemoryConfig): void | Promise<void>
