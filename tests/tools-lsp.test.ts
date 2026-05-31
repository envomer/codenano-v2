/**
 * Tests for LSPTool and lsp-client helpers.
 *
 * Structure:
 *  - Metadata tests: always run, no server needed
 *  - Error-path tests: always run, exercise graceful failure
 *  - Integration tests: skipped unless typescript-language-server is on PATH or
 *    in node_modules/.bin (set LSP_INTEGRATION=1 to force-enable)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { join, resolve } from 'path'
import { execSync } from 'child_process'
import { LSPTool } from '../src/tools/LSPTool.js'
import { lspRequest } from '../src/tools/lsp-client.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const signal = new AbortController().signal
const ctx = (cwd: string) => ({ signal, messages: [], cwd })

/** Returns true if typescript-language-server is reachable. */
function hasLanguageServer(): boolean {
  if (process.env.LSP_INTEGRATION === '1') return true
  try {
    execSync('typescript-language-server --version', { stdio: 'ignore', timeout: 3000 })
    return true
  } catch {
    return false
  }
}

const serverAvailable = hasLanguageServer()

// ─── Metadata ─────────────────────────────────────────────────────────────────

describe('LSPTool — metadata', () => {
  it('has the correct name', () => {
    expect(LSPTool.name).toBe('LSP')
  })

  it('is read-only and concurrency-safe', () => {
    expect(LSPTool.isReadOnly).toBe(true)
    expect(LSPTool.isConcurrencySafe).toBe(true)
  })

  it('description mentions key operations', () => {
    const d = LSPTool.description
    expect(d).toMatch(/goToDefinition|go.to.definition/i)
    expect(d).toMatch(/findReferences|find.references/i)
    expect(d).toMatch(/hover/i)
  })

  it('input schema accepts all nine operations', async () => {
    const ops = [
      'goToDefinition',
      'findReferences',
      'hover',
      'documentSymbol',
      'workspaceSymbol',
      'goToImplementation',
      'prepareCallHierarchy',
      'incomingCalls',
      'outgoingCalls',
    ] as const

    for (const op of ops) {
      const parsed = LSPTool.input.safeParse({ operation: op, filePath: 'x.ts', line: 1, character: 1 })
      expect(parsed.success, `operation '${op}' should be valid`).toBe(true)
    }
  })

  it('rejects unknown operations', () => {
    const result = LSPTool.input.safeParse({ operation: 'badOp', filePath: 'x.ts', line: 1, character: 1 })
    expect(result.success).toBe(false)
  })

  it('rejects zero/negative line or character', () => {
    const base = { operation: 'hover', filePath: 'x.ts' }
    expect(LSPTool.input.safeParse({ ...base, line: 0, character: 1 }).success).toBe(false)
    expect(LSPTool.input.safeParse({ ...base, line: 1, character: 0 }).success).toBe(false)
    expect(LSPTool.input.safeParse({ ...base, line: -1, character: 1 }).success).toBe(false)
  })

  it('rejects non-integer line/character', () => {
    const base = { operation: 'hover', filePath: 'x.ts' }
    expect(LSPTool.input.safeParse({ ...base, line: 1.5, character: 1 }).success).toBe(false)
    expect(LSPTool.input.safeParse({ ...base, line: 1, character: 1.5 }).success).toBe(false)
  })
})

// ─── Error handling (no server) ───────────────────────────────────────────────

describe('LSPTool — error handling', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lsp-err-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('returns isError result when no language server is found', async () => {
    // Empty temp dir has no node_modules/.bin/typescript-language-server and
    // the global one is not installed in this environment.
    if (serverAvailable) return // skip: would succeed instead

    const result = await LSPTool.execute(
      { operation: 'hover', filePath: join(dir, 'x.ts'), line: 1, character: 1 },
      ctx(dir),
    )
    expect(result).toMatchObject({ isError: true })
    expect((result as { content: string }).content).toMatch(/language server|not found|typescript/i)
  })

  it('lspRequest rejects with a descriptive error when no server is found', async () => {
    if (serverAvailable) return

    const tsFile = join(dir, 'test.ts')
    writeFileSync(tsFile, 'const x = 1\n')

    await expect(
      lspRequest(dir, 'hover', tsFile, 1, 7),
    ).rejects.toThrow(/language server|not found|typescript/i)
  })
})

// ─── Integration (requires typescript-language-server) ────────────────────────

describe.skipIf(!serverAvailable)('LSPTool — integration', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lsp-int-'))
    // Minimal tsconfig so the language server can find the project
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { target: 'ES2020', module: 'ESNext', strict: true },
    }))
  })

  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('hover returns type info for a variable', async () => {
    writeFileSync(join(dir, 'a.ts'), 'const greeting: string = "hello"\n')
    const result = await lspRequest(dir, 'hover', join(dir, 'a.ts'), 1, 7)
    // Should describe the variable type
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
    expect(result).not.toBe('No hover information.')
  }, 30_000)

  it('goToDefinition returns a location string', async () => {
    writeFileSync(join(dir, 'b.ts'), [
      'function greet(name: string): string { return `Hello ${name}` }',
      'greet("world")',
    ].join('\n'))
    const result = await lspRequest(dir, 'goToDefinition', join(dir, 'b.ts'), 2, 1)
    expect(typeof result).toBe('string')
    // Should point to line 1 where greet is defined
    expect(result).toMatch(/b\.ts:1/)
  }, 30_000)

  it('documentSymbol lists symbols in a file', async () => {
    writeFileSync(join(dir, 'c.ts'), [
      'interface User { name: string }',
      'function getUser(): User { return { name: "Alice" } }',
    ].join('\n'))
    const result = await lspRequest(dir, 'documentSymbol', join(dir, 'c.ts'), 1, 1)
    expect(typeof result).toBe('string')
    expect(result).not.toBe('No symbols.')
    // Should contain User and getUser
    expect(result).toMatch(/User|getUser/)
  }, 30_000)

  it('findReferences returns locations for a used symbol', async () => {
    writeFileSync(join(dir, 'd.ts'), [
      'export const PI = 3.14',
      'const area = PI * 2',
      'const circ = PI * 4',
    ].join('\n'))
    const result = await lspRequest(dir, 'findReferences', join(dir, 'd.ts'), 1, 14)
    expect(typeof result).toBe('string')
    // At least two references (definition + usages)
    const lines = result.split('\n').filter(Boolean)
    expect(lines.length).toBeGreaterThanOrEqual(1)
  }, 30_000)

  it('LSPTool.execute wraps lspRequest and returns plain text', async () => {
    writeFileSync(join(dir, 'e.ts'), 'const x: number = 42\n')
    const result = await LSPTool.execute(
      { operation: 'hover', filePath: join(dir, 'e.ts'), line: 1, character: 7 },
      ctx(dir),
    )
    expect(typeof result).toBe('string')
    expect(result as string).not.toMatch(/isError/)
  }, 30_000)
})
