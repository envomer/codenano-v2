/**
 * HashEditTool — Line-anchored file editing via content hash.
 *
 * Inspired by oh-my-pi's Hashline package.
 *
 * Problem with old_string/new_string edits:
 *   - The model must reproduce exact old content (token cost)
 *   - No protection against stale edits (file changed since read)
 *
 * How HashEdit works:
 *   1. Call `read`  → returns numbered lines + a 4-hex hash tag of the file
 *   2. Call `edit`  → supply the same hash + line-based edits
 *      If the file changed since step 1, the hash won't match and the edit
 *      is rejected before any bytes are written.
 *
 * Token savings: the model references line numbers + new content only —
 * no need to repeat old_string, which can be large.
 *
 * Supported edit types:
 *   replace      start_line..end_line → new content
 *   delete       start_line..end_line
 *   insert_before line → new content inserted before that line
 *   insert_after  line → new content inserted after that line
 *   insert_head   → prepend to file
 *   insert_tail   → append to file
 */

import { z } from 'zod'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { basename } from 'path'
import { defineTool } from '../tool-builder.js'
import { resolveToolPath } from '../cwd.js'

// ─── Hash ─────────────────────────────────────────────────────────────────────

/**
 * Normalize file content before hashing:
 * strip trailing whitespace and CR from every line, matching oh-my-pi behavior.
 */
function normalize(text: string): string {
  return text.split('\n').map(l => l.replace(/[\r \t]+$/, '')).join('\n')
}

/**
 * FNV-1a 32-bit hash — pure JS, no native deps, deterministic.
 * We take the lower 16 bits → 4 uppercase hex chars, matching the
 * 4-hex-digit tag format used by oh-my-pi's Hashline.
 */
function fnv1a32(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

export function computeFileHash(text: string): string {
  const h = fnv1a32(normalize(text))
  return (h & 0xffff).toString(16).toUpperCase().padStart(4, '0')
}

// ─── Edit types ───────────────────────────────────────────────────────────────
// Flat object schema (no z.union) — Bedrock / some OpenRouter backends reject
// oneOf/anyOf/allOf at the top level of tool input_schema.

const EDIT_TYPES = [
  'replace',
  'delete',
  'insert_before',
  'insert_after',
  'insert_head',
  'insert_tail',
] as const

const editSchema = z
  .object({
    type: z.enum(EDIT_TYPES).describe('Edit operation type'),
    start_line: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('First line to replace or delete (1-based, inclusive)'),
    end_line: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Last line to replace or delete (1-based, inclusive)'),
    line: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Line number for insert_before / insert_after (1-based)'),
    content: z
      .string()
      .optional()
      .describe('New or inserted content (not used for delete)'),
  })
  .superRefine((edit, ctx) => {
    const req = (field: 'start_line' | 'end_line' | 'line' | 'content') => {
      ctx.addIssue({
        code: 'custom',
        path: [field],
        message: `${field} is required for edit type "${edit.type}"`,
      })
    }
    switch (edit.type) {
      case 'replace':
        if (edit.start_line == null) req('start_line')
        if (edit.end_line == null) req('end_line')
        if (edit.content == null) req('content')
        break
      case 'delete':
        if (edit.start_line == null) req('start_line')
        if (edit.end_line == null) req('end_line')
        break
      case 'insert_before':
      case 'insert_after':
        if (edit.line == null) req('line')
        if (edit.content == null) req('content')
        break
      case 'insert_head':
      case 'insert_tail':
        if (edit.content == null) req('content')
        break
    }
  })

type Edit =
  | { type: 'replace'; start_line: number; end_line: number; content: string }
  | { type: 'delete'; start_line: number; end_line: number }
  | { type: 'insert_before'; line: number; content: string }
  | { type: 'insert_after'; line: number; content: string }
  | { type: 'insert_head'; content: string }
  | { type: 'insert_tail'; content: string }

/** Parsed edit rows are validated by superRefine; narrow for applyEdits. */
function asValidatedEdits(edits: z.infer<typeof editSchema>[]): Edit[] {
  return edits as Edit[]
}

// ─── Edit application ─────────────────────────────────────────────────────────

/**
 * Returns a numeric sort key so edits can be applied bottom-to-top,
 * keeping original line numbers valid for each successive operation.
 * insert_tail (Infinity) goes first; insert_head (-Infinity) goes last.
 */
function editAnchor(e: Edit): number {
  switch (e.type) {
    case 'replace':
    case 'delete':
      return e.start_line
    case 'insert_before':
    case 'insert_after':
      return e.line
    case 'insert_tail':
      return Infinity
    case 'insert_head':
      return -Infinity
  }
}

function splitContent(content: string): string[] {
  // Strip trailing newline before splitting so we don't create a spurious blank line
  return content.replace(/\n$/, '').split('\n')
}

export function applyEdits(text: string, edits: Edit[]): string {
  // Strip trailing newline before splitting so insert_tail doesn't create a
  // spurious blank line (split('\n') on 'a\n' produces ['a', '']). Restore it.
  const trailingNewline = text.endsWith('\n')
  const lines = (trailingNewline ? text.slice(0, -1) : text).split('\n')

  // Process bottom-to-top so earlier line numbers remain valid after each splice.
  // Ties broken arbitrarily — the model should not overlap edits.
  const sorted = [...edits].sort((a, b) => editAnchor(b) - editAnchor(a))

  for (const edit of sorted) {
    switch (edit.type) {
      case 'replace':
        lines.splice(edit.start_line - 1, edit.end_line - edit.start_line + 1, ...splitContent(edit.content))
        break
      case 'delete':
        lines.splice(edit.start_line - 1, edit.end_line - edit.start_line + 1)
        break
      case 'insert_before':
        lines.splice(edit.line - 1, 0, ...splitContent(edit.content))
        break
      case 'insert_after':
        lines.splice(edit.line, 0, ...splitContent(edit.content))
        break
      case 'insert_head':
        lines.unshift(...splitContent(edit.content))
        break
      case 'insert_tail':
        lines.push(...splitContent(edit.content))
        break
    }
  }

  const result = lines.join('\n')
  return trailingNewline ? result + '\n' : result
}

// ─── Output formatting ────────────────────────────────────────────────────────

function formatRead(filePath: string, content: string, hash: string): string {
  const name = basename(filePath)
  const lines = content.split('\n')
  const width = String(lines.length).length
  const numbered = lines
    .map((l, i) => `${String(i + 1).padStart(width)}  ${l}`)
    .join('\n')
  return `${name}  #${hash}\n${numbered}`
}

// ─── Tool schema ──────────────────────────────────────────────────────────────

const inputSchema = z
  .object({
    operation: z
      .enum(['read', 'edit'])
      .describe(
        'read: return numbered lines + hash tag; edit: apply line-based edits validated against hash',
      ),
    file_path: z.string().describe('Path to the file to read or edit'),
    hash: z
      .string()
      .regex(/^[0-9A-Fa-f]{4}$/)
      .optional()
      .describe(
        'Required for edit — 4-hex hash tag from the last read of this file (stale-edit guard)',
      ),
    edits: z
      .array(editSchema)
      .min(1)
      .optional()
      .describe(
        'Required for edit — one or more line-based edits (original line numbers from read)',
      ),
  })
  .superRefine((input, ctx) => {
    if (input.operation !== 'edit') return
    if (!input.hash) {
      ctx.addIssue({ code: 'custom', path: ['hash'], message: 'hash is required when operation is edit' })
    }
    if (!input.edits?.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['edits'],
        message: 'edits is required when operation is edit',
      })
    }
  })

export type HashEditInput = z.infer<typeof inputSchema>

// ─── Tool definition ──────────────────────────────────────────────────────────

export const HashEditTool = defineTool({
  name: 'HashEdit',
  description: `Line-anchored file editing — more token-efficient and safer than old_string/new_string edits.

Workflow:
1. HashEdit({ operation: "read",  file_path: "src/foo.ts" })
   → returns numbered lines + a 4-hex tag, e.g.  foo.ts  #3A2F
2. HashEdit({ operation: "edit",  file_path: "src/foo.ts", hash: "3A2F", edits: [...] })
   → applies edits; fails with the current hash if the file changed since step 1

Benefits over Edit (old_string/new_string):
- No need to repeat old content — reference by line number instead (token savings)
- Hash guard prevents silently corrupting a file that was modified since you read it
- Multiple edits in one call, applied atomically (all or nothing)

Edit types:
- replace      { type: "replace",       start_line, end_line, content }
- delete       { type: "delete",        start_line, end_line }
- insert_before{ type: "insert_before", line, content }
- insert_after { type: "insert_after",  line, content }
- insert_head  { type: "insert_head",   content }
- insert_tail  { type: "insert_tail",   content }

All line numbers are 1-based and refer to the original file state (as returned by read).
Batch all edits for a file into one call — the tool applies them correctly regardless of order.`,

  input: inputSchema,
  isReadOnly: false,
  isConcurrencySafe: false,

  async execute(input, context) {
    const filePath = resolveToolPath(input.file_path, context.cwd)

    if (!existsSync(filePath)) {
      return { content: `File not found: ${filePath}`, isError: true }
    }

    const text = readFileSync(filePath, 'utf-8')

    if (input.operation === 'read') {
      const hash = computeFileHash(text)
      return formatRead(filePath, text, hash)
    }

    // edit
    if (!input.hash || !input.edits?.length) {
      return { content: 'edit requires hash and edits', isError: true }
    }

    const currentHash = computeFileHash(text)
    if (currentHash.toUpperCase() !== input.hash.toUpperCase()) {
      return {
        content: [
          `Hash mismatch for ${input.file_path}:`,
          `  expected  #${input.hash.toUpperCase()}`,
          `  current   #${currentHash}`,
          '',
          'The file changed since you last read it. Call HashEdit({ operation: "read" }) again to get the current content and hash, then retry your edits.',
        ].join('\n'),
        isError: true,
      }
    }

    let updated: string
    try {
      updated = applyEdits(text, asValidatedEdits(input.edits))
    } catch (err) {
      return {
        content: `Failed to apply edits: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      }
    }

    writeFileSync(filePath, updated, 'utf-8')
    const newHash = computeFileHash(updated)
    const n = input.edits.length
    return `Edited ${input.file_path} (${n} edit${n === 1 ? '' : 's'} applied)  #${newHash}`
  },
})
