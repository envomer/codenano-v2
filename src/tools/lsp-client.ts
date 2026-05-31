/**
 * lsp-client.ts — Node.js JSON-RPC LSP client
 *
 * Spawns a language server process (e.g. typescript-language-server),
 * communicates via the LSP wire protocol (Content-Length framed JSON-RPC
 * over stdin/stdout), and exposes a single `lspRequest` helper that the
 * LSPTool execute function can call.
 *
 * Design:
 *  - One server process per (command, cwd) pair, kept alive across tool calls
 *  - Request/response correlated by incrementing integer ids
 *  - Files are opened with textDocument/didOpen before the first query
 *  - Results are returned as formatted plain text
 */

import { spawn, execSync, type ChildProcess } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { resolve, extname, relative } from 'path'

// ─── Types ────────────────────────────────────────────────────────────────────

interface PendingRequest {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface LspClient {
  readonly key: string
  readonly cwd: string
  readonly process: ChildProcess
  requestId: number
  readonly pending: Map<number, PendingRequest>
  buffer: Buffer
  readonly openFiles: Set<string>
  readonly ready: Promise<void>
}

// LSP Location / Range
interface Position { line: number; character: number }
interface Range { start: Position; end: Position }
interface Location { uri: string; range: Range }

// ─── Constants ────────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 30_000
const INIT_TIMEOUT_MS = 20_000

const CLIENT_CAPABILITIES = {
  textDocument: {
    definition: { linkSupport: false },
    references: {},
    hover: { contentFormat: ['plaintext', 'markdown'] },
    documentSymbol: { hierarchicalDocumentSymbolSupport: false },
    implementation: { linkSupport: false },
    callHierarchy: {},
  },
  workspace: {
    symbol: { resolveSupport: { properties: [] } },
  },
}

// ─── Client pool ─────────────────────────────────────────────────────────────

const pool = new Map<string, LspClient>()

// Kill all servers on exit so we don't leave orphan processes.
process.on('exit', () => {
  for (const c of pool.values()) {
    try { c.process.kill() } catch { /* ignore */ }
  }
})

// ─── Server detection ─────────────────────────────────────────────────────────

function commandExists(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: 'ignore', timeout: 2_000 })
    return true
  } catch {
    return false
  }
}

function findServerCommand(cwd: string): { command: string; args: string[] } | null {
  // Local node_modules first (no shell lookup needed)
  const localCandidates = [
    resolve(cwd, 'node_modules/.bin/typescript-language-server'),
    resolve(cwd, '../node_modules/.bin/typescript-language-server'),
    resolve(cwd, 'node_modules/.bin/vtsls'),
  ]
  for (const cmd of localCandidates) {
    if (existsSync(cmd)) return { command: cmd, args: ['--stdio'] }
  }

  // Global fallback — only return if the binary is actually on PATH
  for (const cmd of ['typescript-language-server', 'vtsls']) {
    if (commandExists(cmd)) return { command: cmd, args: ['--stdio'] }
  }

  return null
}

function languageId(filePath: string): string {
  const ext = extname(filePath).toLowerCase()
  switch (ext) {
    case '.ts': return 'typescript'
    case '.tsx': return 'typescriptreact'
    case '.js': return 'javascript'
    case '.jsx': return 'javascriptreact'
    case '.vue': return 'vue'
    case '.json': return 'json'
    default: return 'plaintext'
  }
}

function pathToUri(absPath: string): string {
  return `file://${absPath.startsWith('/') ? absPath : '/' + absPath}`
}

function uriToPath(uri: string): string {
  return uri.replace(/^file:\/\//, '')
}

// ─── JSON-RPC wire protocol ───────────────────────────────────────────────────

function writeMessage(client: LspClient, msg: object): void {
  const body = JSON.stringify(msg)
  const header = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n`
  client.process.stdin!.write(header + body)
}

function processBuffer(client: LspClient): void {
  while (true) {
    const sep = client.buffer.indexOf('\r\n\r\n')
    if (sep === -1) break

    const header = client.buffer.subarray(0, sep).toString('utf8')
    const match = header.match(/Content-Length:\s*(\d+)/i)
    if (!match) { client.buffer = client.buffer.subarray(sep + 4); continue }

    const len = parseInt(match[1]!, 10)
    const bodyStart = sep + 4
    if (client.buffer.length < bodyStart + len) break

    const bodyStr = client.buffer.subarray(bodyStart, bodyStart + len).toString('utf8')
    client.buffer = client.buffer.subarray(bodyStart + len)

    try {
      handleMessage(client, JSON.parse(bodyStr))
    } catch { /* malformed — skip */ }
  }
}

function handleMessage(client: LspClient, msg: Record<string, unknown>): void {
  // Responses have an id
  if ('id' in msg && msg['id'] != null) {
    const id = msg['id'] as number
    const pending = client.pending.get(id)
    if (!pending) return
    client.pending.delete(id)
    clearTimeout(pending.timer)
    if ('error' in msg && msg['error']) {
      const err = msg['error'] as Record<string, unknown>
      pending.reject(new Error(`LSP error ${err['code']}: ${err['message']}`))
    } else {
      pending.resolve(msg['result'])
    }
  }
  // Notifications (diagnostics, progress, etc.) are ignored
}

// ─── Request / notification helpers ──────────────────────────────────────────

function sendRequest(client: LspClient, method: string, params: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = ++client.requestId
    const timer = setTimeout(() => {
      client.pending.delete(id)
      reject(new Error(`LSP request '${method}' timed out after ${REQUEST_TIMEOUT_MS}ms`))
    }, REQUEST_TIMEOUT_MS)

    client.pending.set(id, { resolve, reject, timer })
    writeMessage(client, { jsonrpc: '2.0', id, method, params })
  })
}

function sendNotification(client: LspClient, method: string, params: unknown): void {
  writeMessage(client, { jsonrpc: '2.0', method, params })
}

// ─── Client lifecycle ─────────────────────────────────────────────────────────

async function createClient(cwd: string): Promise<LspClient> {
  const serverCmd = findServerCommand(cwd)
  if (!serverCmd) {
    throw new Error(
      'No TypeScript language server found. Install it with: npm install -g typescript-language-server typescript',
    )
  }

  const key = `${serverCmd.command}:${cwd}`

  const proc = spawn(serverCmd.command, serverCmd.args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  })

  const client: LspClient = {
    key,
    cwd,
    process: proc,
    requestId: 0,
    pending: new Map(),
    buffer: Buffer.alloc(0),
    openFiles: new Set(),
    // ready is set below after initialization
    ready: undefined as unknown as Promise<void>,
  }

  // Wire stdout → processBuffer
  proc.stdout!.on('data', (chunk: Buffer) => {
    client.buffer = Buffer.concat([client.buffer, chunk])
    processBuffer(client)
  })

  proc.stderr!.on('data', () => { /* suppress language server logs */ })

  proc.on('exit', () => {
    pool.delete(key)
    // Reject all in-flight requests
    for (const p of client.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error('LSP server exited unexpectedly'))
    }
    client.pending.clear()
  })

  // Initialization handshake — race the request against a hard timeout so the
  // promise always settles (instead of a setTimeout callback throwing uncaught).
  const initRequest = async () => {
    await sendRequest(client, 'initialize', {
      processId: process.pid,
      rootUri: pathToUri(cwd),
      rootPath: cwd,
      capabilities: CLIENT_CAPABILITIES,
      workspaceFolders: [{ uri: pathToUri(cwd), name: cwd.split('/').pop() ?? 'workspace' }],
    })
    sendNotification(client, 'initialized', {})
  }

  const initTimeout = new Promise<void>((_, reject) =>
    setTimeout(() => {
      proc.kill()
      reject(new Error(`LSP server initialization timed out after ${INIT_TIMEOUT_MS}ms`))
    }, INIT_TIMEOUT_MS),
  )

  const readyPromise = Promise.race([initRequest(), initTimeout])

  // Patch ready after creation (object is already in scope via closure)
  ;(client as { ready: Promise<void> }).ready = readyPromise

  pool.set(key, client)
  return client
}

async function getClient(cwd: string): Promise<LspClient> {
  // Find an existing healthy client for this directory
  for (const [, c] of pool) {
    if (c.cwd === cwd && !c.process.killed) {
      await c.ready
      return c
    }
  }
  const client = await createClient(cwd)
  await client.ready
  return client
}

// ─── File management ──────────────────────────────────────────────────────────

function openFile(client: LspClient, absPath: string): void {
  if (client.openFiles.has(absPath)) return
  let text: string
  try { text = readFileSync(absPath, 'utf8') } catch { return }
  client.openFiles.add(absPath)
  sendNotification(client, 'textDocument/didOpen', {
    textDocument: {
      uri: pathToUri(absPath),
      languageId: languageId(absPath),
      version: 1,
      text,
    },
  })
}

// ─── Result formatters ────────────────────────────────────────────────────────

function formatLocation(loc: Location, cwd: string): string {
  const path = uriToPath(loc.uri)
  const rel = relative(cwd, path)
  const { line, character } = loc.range.start
  return `${rel}:${line + 1}:${character + 1}`
}

function formatLocations(locs: Location | Location[], cwd: string): string {
  const arr = Array.isArray(locs) ? locs : [locs]
  if (arr.length === 0) return 'No results.'
  return arr.map(l => formatLocation(l, cwd)).join('\n')
}

function formatHover(hover: { contents: unknown }): string {
  const c = hover.contents
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    return c.map((x: unknown) => (typeof x === 'string' ? x : (x as Record<string, string>)['value'] ?? '')).join('\n')
  }
  if (c && typeof c === 'object' && 'value' in c) return (c as { value: string }).value
  return JSON.stringify(c)
}

function formatSymbols(symbols: Array<{ name: string; kind: number; location?: Location; range?: Range }>): string {
  if (!symbols.length) return 'No symbols.'
  return symbols.map(s => `${s.name} (kind ${s.kind})`).join('\n')
}

// ─── Public API ───────────────────────────────────────────────────────────────

export type LspOperation =
  | 'goToDefinition'
  | 'findReferences'
  | 'hover'
  | 'documentSymbol'
  | 'workspaceSymbol'
  | 'goToImplementation'
  | 'prepareCallHierarchy'
  | 'incomingCalls'
  | 'outgoingCalls'

/**
 * Perform an LSP operation and return a human-readable string result.
 * @param cwd      Project root — determines which language server to use
 * @param op       LSP operation name (matches LSPTool schema)
 * @param filePath Absolute or project-relative file path
 * @param line     1-based line number
 * @param character 1-based character offset
 */
export async function lspRequest(
  cwd: string,
  op: LspOperation,
  filePath: string,
  line: number,
  character: number,
): Promise<string> {
  const absPath = filePath.startsWith('/') ? filePath : resolve(cwd, filePath)
  const client = await getClient(cwd)

  // Position is 0-based in LSP
  const position = { line: line - 1, character: character - 1 }
  const textDocumentId = { uri: pathToUri(absPath) }

  switch (op) {
    case 'goToDefinition': {
      openFile(client, absPath)
      const result = await sendRequest(client, 'textDocument/definition', {
        textDocument: textDocumentId, position,
      })
      return formatLocations(result as Location | Location[], cwd)
    }

    case 'findReferences': {
      openFile(client, absPath)
      const result = await sendRequest(client, 'textDocument/references', {
        textDocument: textDocumentId, position,
        context: { includeDeclaration: true },
      })
      return formatLocations(result as Location[], cwd)
    }

    case 'hover': {
      openFile(client, absPath)
      const result = await sendRequest(client, 'textDocument/hover', {
        textDocument: textDocumentId, position,
      })
      if (!result) return 'No hover information.'
      return formatHover(result as { contents: unknown })
    }

    case 'documentSymbol': {
      openFile(client, absPath)
      const result = await sendRequest(client, 'textDocument/documentSymbol', {
        textDocument: textDocumentId,
      })
      return formatSymbols(
        (result as Array<{ name: string; kind: number; location?: Location; range?: Range }>) ?? [],
      )
    }

    case 'workspaceSymbol': {
      // Use the last path segment (without extension) as the symbol query
      const query = absPath.split('/').pop()?.replace(/\.[^.]+$/, '') ?? ''
      const result = await sendRequest(client, 'workspace/symbol', { query })
      return formatSymbols(
        (result as Array<{ name: string; kind: number; location?: Location }>) ?? [],
      )
    }

    case 'goToImplementation': {
      openFile(client, absPath)
      const result = await sendRequest(client, 'textDocument/implementation', {
        textDocument: textDocumentId, position,
      })
      return formatLocations(result as Location | Location[], cwd)
    }

    case 'prepareCallHierarchy': {
      openFile(client, absPath)
      const result = await sendRequest(client, 'textDocument/prepareCallHierarchy', {
        textDocument: textDocumentId, position,
      })
      const items = (result as Array<{ name: string; uri: string; range: Range }>) ?? []
      if (!items.length) return 'No call hierarchy items at this location.'
      return items.map(i => `${i.name} @ ${formatLocation({ uri: i.uri, range: i.range }, cwd)}`).join('\n')
    }

    case 'incomingCalls': {
      openFile(client, absPath)
      const items = (await sendRequest(client, 'textDocument/prepareCallHierarchy', {
        textDocument: textDocumentId, position,
      })) as Array<{ name: string; uri: string; range: Range; selectionRange: Range }> | null

      if (!items?.length) return 'No call hierarchy items at this location.'
      const calls = (await sendRequest(client, 'callHierarchy/incomingCalls', {
        item: items[0],
      })) as Array<{ from: { name: string; uri: string; range: Range }; fromRanges: Range[] }> | null

      if (!calls?.length) return 'No incoming calls.'
      return calls.map(c => `${c.from.name} @ ${formatLocation({ uri: c.from.uri, range: c.from.range }, cwd)}`).join('\n')
    }

    case 'outgoingCalls': {
      openFile(client, absPath)
      const items = (await sendRequest(client, 'textDocument/prepareCallHierarchy', {
        textDocument: textDocumentId, position,
      })) as Array<{ name: string; uri: string; range: Range; selectionRange: Range }> | null

      if (!items?.length) return 'No call hierarchy items at this location.'
      const calls = (await sendRequest(client, 'callHierarchy/outgoingCalls', {
        item: items[0],
      })) as Array<{ to: { name: string; uri: string; range: Range }; fromRanges: Range[] }> | null

      if (!calls?.length) return 'No outgoing calls.'
      return calls.map(c => `${c.to.name} @ ${formatLocation({ uri: c.to.uri, range: c.to.range }, cwd)}`).join('\n')
    }

    default:
      return `Unknown operation: ${op}`
  }
}
