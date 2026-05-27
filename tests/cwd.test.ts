/**
 * Unit tests for agent working directory resolution
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { resolveAgentCwd, resolveMemoryDir } from '../src/cwd.js'
import { detectEnvironment } from '../src/prompt/sections/environment.js'
import { getMemoryDir } from '../src/memory/storage.js'
import { GlobTool } from '../src/tools/GlobTool.js'
import { BashTool } from '../src/tools/BashTool.js'

describe('resolveAgentCwd', () => {
  it('returns process.cwd() when cwd is not configured', () => {
    expect(resolveAgentCwd({})).toBe(process.cwd())
  })

  it('resolves relative and absolute cwd paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-cwd-'))
    try {
      expect(resolveAgentCwd({ cwd: dir })).toBe(realpathSync.native(dir))
      expect(resolveAgentCwd({ cwd: '.' })).toBe(realpathSync.native(process.cwd()))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('resolveMemoryDir', () => {
  it('hashes the configured cwd when memoryDir is not set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memory-cwd-'))
    try {
      const expected = getMemoryDir(undefined, realpathSync.native(dir))
      expect(resolveMemoryDir({ model: 'test', cwd: dir })).toBe(expected)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('prefers memory.memoryDir over cwd hash', () => {
    const customDir = mkdtempSync(join(tmpdir(), 'memory-custom-'))
    try {
      expect(
        resolveMemoryDir({
          model: 'test',
          cwd: '/some/other/path',
          memory: { memoryDir: customDir },
        }),
      ).toBe(customDir)
    } finally {
      rmSync(customDir, { recursive: true, force: true })
    }
  })
})

describe('detectEnvironment', () => {
  it('uses the provided cwd and git state', () => {
    const env = detectEnvironment(process.cwd())
    expect(env.cwd).toBe(process.cwd())
    expect(env.isGitRepo).toBe(true)
  })
})

describe('tool cwd context', () => {
  let projectDir: string
  const signal = new AbortController().signal

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'tool-cwd-'))
    writeFileSync(join(projectDir, 'marker.txt'), 'hello')
  })

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true })
  })

  it('GlobTool defaults to context.cwd', async () => {
    const result = await GlobTool.execute(
      { pattern: 'marker.txt' },
      { signal, messages: [], cwd: projectDir },
    )
    expect(result).toContain('marker.txt')
  })

  it('BashTool runs in context.cwd', async () => {
    const result = await BashTool.execute(
      { command: 'pwd' },
      { signal, messages: [], cwd: resolveAgentCwd({ cwd: projectDir }) },
    )
    expect(result.trim()).toBe(resolveAgentCwd({ cwd: projectDir }))
  })
})
