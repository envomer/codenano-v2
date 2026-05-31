/**
 * Tests for HashEditTool — line-anchored file editing via content hash.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { HashEditTool, computeFileHash, applyEdits } from '../src/tools/HashEditTool.js'

const signal = new AbortController().signal
const ctx = (cwd: string) => ({ signal, messages: [], cwd })

// ─── computeFileHash ──────────────────────────────────────────────────────────

describe('computeFileHash', () => {
  it('returns a 4-character uppercase hex string', () => {
    const h = computeFileHash('hello\nworld\n')
    expect(h).toMatch(/^[0-9A-F]{4}$/)
  })

  it('is deterministic', () => {
    const content = 'const x = 1\nconst y = 2\n'
    expect(computeFileHash(content)).toBe(computeFileHash(content))
  })

  it('differs for different content', () => {
    expect(computeFileHash('a\n')).not.toBe(computeFileHash('b\n'))
  })

  it('is insensitive to trailing whitespace on lines (CRLF/spaces)', () => {
    expect(computeFileHash('line1  \nline2\n')).toBe(computeFileHash('line1\nline2\n'))
    expect(computeFileHash('line1\r\nline2\r\n')).toBe(computeFileHash('line1\nline2\n'))
  })

  it('is sensitive to leading whitespace (indentation matters)', () => {
    expect(computeFileHash('  x\n')).not.toBe(computeFileHash('x\n'))
  })

  it('handles empty content', () => {
    const h = computeFileHash('')
    expect(h).toMatch(/^[0-9A-F]{4}$/)
  })
})

// ─── applyEdits ───────────────────────────────────────────────────────────────

describe('applyEdits', () => {
  const TEXT = 'line1\nline2\nline3\nline4\nline5'

  it('replace replaces a range of lines', () => {
    const result = applyEdits(TEXT, [{ type: 'replace', start_line: 2, end_line: 3, content: 'NEW' }])
    expect(result).toBe('line1\nNEW\nline4\nline5')
  })

  it('replace with multi-line content', () => {
    const result = applyEdits(TEXT, [{ type: 'replace', start_line: 2, end_line: 2, content: 'A\nB\nC' }])
    expect(result).toBe('line1\nA\nB\nC\nline3\nline4\nline5')
  })

  it('delete removes a range of lines', () => {
    const result = applyEdits(TEXT, [{ type: 'delete', start_line: 2, end_line: 3 }])
    expect(result).toBe('line1\nline4\nline5')
  })

  it('delete a single line', () => {
    const result = applyEdits(TEXT, [{ type: 'delete', start_line: 3, end_line: 3 }])
    expect(result).toBe('line1\nline2\nline4\nline5')
  })

  it('insert_before inserts before the given line', () => {
    const result = applyEdits(TEXT, [{ type: 'insert_before', line: 3, content: 'NEW' }])
    expect(result).toBe('line1\nline2\nNEW\nline3\nline4\nline5')
  })

  it('insert_after inserts after the given line', () => {
    const result = applyEdits(TEXT, [{ type: 'insert_after', line: 3, content: 'NEW' }])
    expect(result).toBe('line1\nline2\nline3\nNEW\nline4\nline5')
  })

  it('insert_head prepends to the file', () => {
    const result = applyEdits(TEXT, [{ type: 'insert_head', content: 'FIRST' }])
    expect(result).toBe('FIRST\nline1\nline2\nline3\nline4\nline5')
  })

  it('insert_tail appends to the file', () => {
    const result = applyEdits(TEXT, [{ type: 'insert_tail', content: 'LAST' }])
    expect(result).toBe('line1\nline2\nline3\nline4\nline5\nLAST')
  })

  it('multiple edits applied correctly (non-overlapping, various positions)', () => {
    // delete line 4, replace line 2, insert_tail — all reference original line numbers
    const result = applyEdits(TEXT, [
      { type: 'replace', start_line: 2, end_line: 2, content: 'TWO' },
      { type: 'delete', start_line: 4, end_line: 4 },
      { type: 'insert_tail', content: 'END' },
    ])
    expect(result).toBe('line1\nTWO\nline3\nline5\nEND')
  })

  it('content with trailing newline does not add blank line', () => {
    const result = applyEdits('a\nb\nc', [{ type: 'replace', start_line: 2, end_line: 2, content: 'X\n' }])
    expect(result).toBe('a\nX\nc')
  })
})

// ─── HashEditTool — read operation ────────────────────────────────────────────

describe('HashEditTool — read', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hashedit-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('returns numbered content with hash header', async () => {
    writeFileSync(join(dir, 'foo.ts'), 'const x = 1\nconst y = 2\n')
    const result = await HashEditTool.execute(
      { operation: 'read', file_path: join(dir, 'foo.ts') },
      ctx(dir),
    )
    expect(typeof result).toBe('string')
    expect(result as string).toMatch(/foo\.ts\s+#[0-9A-F]{4}/)
    expect(result as string).toContain('1  const x = 1')
    expect(result as string).toContain('2  const y = 2')
  })

  it('resolves relative paths against cwd', async () => {
    writeFileSync(join(dir, 'bar.ts'), 'hello\n')
    const result = await HashEditTool.execute(
      { operation: 'read', file_path: 'bar.ts' },
      ctx(dir),
    )
    expect(result as string).toContain('hello')
  })

  it('returns error for missing file', async () => {
    const result = await HashEditTool.execute(
      { operation: 'read', file_path: join(dir, 'nope.ts') },
      ctx(dir),
    )
    expect(result).toMatchObject({ isError: true })
  })
})

// ─── HashEditTool — edit operation ────────────────────────────────────────────

describe('HashEditTool — edit', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hashedit-edit-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  async function readHash(file: string): Promise<string> {
    const result = await HashEditTool.execute({ operation: 'read', file_path: file }, ctx(dir)) as string
    const m = result.match(/#([0-9A-F]{4})/)
    return m![1]!
  }

  it('replaces lines and returns updated hash', async () => {
    const file = join(dir, 'a.ts')
    writeFileSync(file, 'line1\nline2\nline3\n')
    const hash = await readHash(file)

    const result = await HashEditTool.execute({
      operation: 'edit',
      file_path: file,
      hash,
      edits: [{ type: 'replace', start_line: 2, end_line: 2, content: 'NEW' }],
    }, ctx(dir))

    expect(typeof result).toBe('string')
    expect(result as string).toMatch(/Edited.*1 edit.*#[0-9A-F]{4}/)
    expect(readFileSync(file, 'utf-8')).toBe('line1\nNEW\nline3\n')
  })

  it('deletes lines', async () => {
    const file = join(dir, 'b.ts')
    writeFileSync(file, 'a\nb\nc\nd\n')
    const hash = await readHash(file)

    await HashEditTool.execute({
      operation: 'edit', file_path: file, hash,
      edits: [{ type: 'delete', start_line: 2, end_line: 3 }],
    }, ctx(dir))

    expect(readFileSync(file, 'utf-8')).toBe('a\nd\n')
  })

  it('inserts before a line', async () => {
    const file = join(dir, 'c.ts')
    writeFileSync(file, 'first\nlast\n')
    const hash = await readHash(file)

    await HashEditTool.execute({
      operation: 'edit', file_path: file, hash,
      edits: [{ type: 'insert_before', line: 2, content: 'middle' }],
    }, ctx(dir))

    expect(readFileSync(file, 'utf-8')).toBe('first\nmiddle\nlast\n')
  })

  it('inserts after a line', async () => {
    const file = join(dir, 'd.ts')
    writeFileSync(file, 'first\nlast\n')
    const hash = await readHash(file)

    await HashEditTool.execute({
      operation: 'edit', file_path: file, hash,
      edits: [{ type: 'insert_after', line: 1, content: 'middle' }],
    }, ctx(dir))

    expect(readFileSync(file, 'utf-8')).toBe('first\nmiddle\nlast\n')
  })

  it('prepends with insert_head', async () => {
    const file = join(dir, 'e.ts')
    writeFileSync(file, 'body\n')
    const hash = await readHash(file)

    await HashEditTool.execute({
      operation: 'edit', file_path: file, hash,
      edits: [{ type: 'insert_head', content: '// header' }],
    }, ctx(dir))

    expect(readFileSync(file, 'utf-8')).toBe('// header\nbody\n')
  })

  it('appends with insert_tail', async () => {
    const file = join(dir, 'f.ts')
    writeFileSync(file, 'body\n')
    const hash = await readHash(file)

    await HashEditTool.execute({
      operation: 'edit', file_path: file, hash,
      edits: [{ type: 'insert_tail', content: '// footer' }],
    }, ctx(dir))

    expect(readFileSync(file, 'utf-8')).toBe('body\n// footer\n')
  })

  it('applies multiple edits in one call', async () => {
    const file = join(dir, 'g.ts')
    writeFileSync(file, 'a\nb\nc\nd\ne\n')
    const hash = await readHash(file)

    await HashEditTool.execute({
      operation: 'edit', file_path: file, hash,
      edits: [
        { type: 'delete', start_line: 2, end_line: 2 },
        { type: 'replace', start_line: 4, end_line: 4, content: 'FOUR' },
        { type: 'insert_tail', content: 'END' },
      ],
    }, ctx(dir))

    expect(readFileSync(file, 'utf-8')).toBe('a\nc\nFOUR\ne\nEND\n')
  })

  it('rejects edit when hash does not match current file', async () => {
    const file = join(dir, 'h.ts')
    writeFileSync(file, 'original\n')
    const staleHash = await readHash(file)

    // Mutate the file so hash is now stale
    writeFileSync(file, 'changed\n')

    const result = await HashEditTool.execute({
      operation: 'edit', file_path: file, hash: staleHash,
      edits: [{ type: 'replace', start_line: 1, end_line: 1, content: 'attempted' }],
    }, ctx(dir))

    expect(result).toMatchObject({ isError: true })
    expect((result as { content: string }).content).toMatch(/hash mismatch/i)
    // File must be unchanged
    expect(readFileSync(file, 'utf-8')).toBe('changed\n')
  })

  it('hash mismatch message includes expected and current hashes', async () => {
    const file = join(dir, 'i.ts')
    writeFileSync(file, 'v1\n')
    const staleHash = await readHash(file)
    writeFileSync(file, 'v2\n')
    const currentHash = computeFileHash('v2\n')

    const result = await HashEditTool.execute({
      operation: 'edit', file_path: file, hash: staleHash,
      edits: [{ type: 'delete', start_line: 1, end_line: 1 }],
    }, ctx(dir)) as { content: string }

    expect(result.content).toContain(staleHash)
    expect(result.content).toContain(currentHash)
  })

  it('returns error for missing file', async () => {
    const result = await HashEditTool.execute({
      operation: 'edit', file_path: join(dir, 'nope.ts'), hash: '0000',
      edits: [{ type: 'insert_tail', content: 'x' }],
    }, ctx(dir))
    expect(result).toMatchObject({ isError: true })
  })

  it('hash is case-insensitive', async () => {
    const file = join(dir, 'j.ts')
    writeFileSync(file, 'hello\n')
    const hash = await readHash(file) // uppercase from read

    // Provide lowercase hash
    const result = await HashEditTool.execute({
      operation: 'edit', file_path: file, hash: hash.toLowerCase(),
      edits: [{ type: 'insert_tail', content: 'world' }],
    }, ctx(dir))

    expect(typeof result).toBe('string')
    expect(readFileSync(file, 'utf-8')).toBe('hello\nworld\n')
  })
})

// ─── Input schema validation ──────────────────────────────────────────────────

describe('HashEditTool — schema validation', () => {
  it('rejects edit with non-hex hash', () => {
    const result = HashEditTool.input.safeParse({
      operation: 'edit', file_path: 'x.ts', hash: 'ZZZZ',
      edits: [{ type: 'insert_tail', content: 'x' }],
    })
    expect(result.success).toBe(false)
  })

  it('rejects edit with hash shorter than 4 chars', () => {
    const result = HashEditTool.input.safeParse({
      operation: 'edit', file_path: 'x.ts', hash: 'AB',
      edits: [{ type: 'insert_tail', content: 'x' }],
    })
    expect(result.success).toBe(false)
  })

  it('rejects empty edits array', () => {
    const result = HashEditTool.input.safeParse({
      operation: 'edit', file_path: 'x.ts', hash: 'ABCD', edits: [],
    })
    expect(result.success).toBe(false)
  })

  it('rejects replace with zero/negative start_line', () => {
    const result = HashEditTool.input.safeParse({
      operation: 'edit', file_path: 'x.ts', hash: 'ABCD',
      edits: [{ type: 'replace', start_line: 0, end_line: 1, content: 'x' }],
    })
    expect(result.success).toBe(false)
  })
})
