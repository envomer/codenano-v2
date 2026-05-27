/**
 * cwd.ts — Resolve the agent's primary working directory.
 */

import { resolve } from 'path'
import { realpathSync } from 'fs'
import type { AgentConfig } from './types.js'
import { getMemoryDir } from './memory/storage.js'

/** Resolve the configured working directory, or fall back to process.cwd(). */
export function resolveAgentCwd(config: Pick<AgentConfig, 'cwd'>): string {
  const cwd = config.cwd ? resolve(config.cwd) : process.cwd()
  try {
    return realpathSync.native(cwd)
  } catch {
    return cwd
  }
}

/** Resolve the effective memory directory for an agent config. */
export function resolveMemoryDir(config: AgentConfig): string {
  if (config.memory?.memoryDir) {
    return resolve(config.memory.memoryDir)
  }
  return getMemoryDir(undefined, resolveAgentCwd(config))
}
