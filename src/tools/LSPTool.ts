/**
 * LSPTool — Code intelligence via Language Server Protocol.
 *
 * Spawns and manages a language server (typescript-language-server by default)
 * and exposes go-to-definition, find-references, hover, symbols, and call
 * hierarchy operations to the agent.
 */

import { z } from 'zod'
import { defineTool } from '../tool-builder.js'
import { lspRequest, type LspOperation } from './lsp-client.js'

const inputSchema = z.object({
  operation: z
    .enum([
      'goToDefinition',
      'findReferences',
      'hover',
      'documentSymbol',
      'workspaceSymbol',
      'goToImplementation',
      'prepareCallHierarchy',
      'incomingCalls',
      'outgoingCalls',
    ])
    .describe('The LSP operation to perform'),
  filePath: z.string().describe('Absolute or project-relative path to the file'),
  line: z.number().int().positive().describe('Line number (1-based)'),
  character: z.number().int().positive().describe('Character offset (1-based)'),
})

export type LSPInput = z.infer<typeof inputSchema>

export const LSPTool = defineTool({
  name: 'LSP',
  description:
    'Code intelligence via the Language Server Protocol. Use for: finding where a symbol is defined (goToDefinition), all call sites (findReferences), type info (hover), all symbols in a file (documentSymbol), symbols matching a name (workspaceSymbol), interface implementations (goToImplementation), and call graphs (incomingCalls / outgoingCalls). Faster and more accurate than grep for navigation.',
  input: inputSchema,
  isReadOnly: true,
  isConcurrencySafe: true,

  async execute(input, context) {
    const cwd = context.cwd ?? process.cwd()
    try {
      const result = await lspRequest(
        cwd,
        input.operation as LspOperation,
        input.filePath,
        input.line,
        input.character,
      )
      return result
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: msg, isError: true }
    }
  },
})
