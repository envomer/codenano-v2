/**
 * agent.ts — Core Agent implementation
 *
 * Thin wrapper around the shared runLoop() from loop.ts.
 * State management only — all loop logic lives in loop.ts.
 */

import Anthropic from '@anthropic-ai/sdk'
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages.js'
import type {
  AgentConfig,
  Agent,
  AgentAbortReason,
  Result,
  StreamEvent,
  ToolDef,
  QueryTracking,
} from './types.js'
import { SessionImpl } from './session.js'
import { createClient, toolDefsToAPISchemas } from './provider.js'
import { createMemoryExtractor } from './memory/index.js'
import { resolveAgentCwd, resolveMemoryDir } from './cwd.js'
import { runLoop, resolveSystemPrompt } from './loop.js'

// ─── Default Configuration ───────────────────────────────────────────────────

const DEFAULT_MAX_TURNS = 30
const DEFAULT_MODEL = 'claude-sonnet-4-6'

// ─── createAgent ─────────────────────────────────────────────────────────────

/**
 * Create an Agent instance.
 *
 * @example
 * ```typescript
 * const agent = createAgent({
 *   model: 'claude-sonnet-4-6',
 *   tools: [readFile, writeFile],
 *   systemPrompt: 'You are a helpful coding assistant.',
 * })
 *
 * const result = await agent.ask('What files are in /tmp?')
 * ```
 */
export function createAgent(config: AgentConfig): Agent {
  const resolvedConfig: AgentConfig = {
    ...config,
    cwd: config.cwd ? resolveAgentCwd(config) : undefined,
    model: config.model ?? DEFAULT_MODEL,
    maxTurns: config.maxTurns ?? DEFAULT_MAX_TURNS,
    tools: config.tools ?? [],
  }
  return new AgentImpl(resolvedConfig)
}

// ─── AgentImpl ───────────────────────────────────────────────────────────────

class AgentImpl implements Agent {
  private config: AgentConfig
  private client: Anthropic
  private toolSchemas: Anthropic.Messages.Tool[]
  private toolMap: Map<string, ToolDef>
  private abortController: AbortController
  private resolvedSystemPrompt: string | null = null
  private activeModel: string
  private queryTracking: QueryTracking | null = null
  private stopHookRetryCount = 0
  private memoryExtractor: ReturnType<typeof createMemoryExtractor> | null = null

  constructor(config: AgentConfig) {
    this.config = config
    this.activeModel = config.model
    this.client = createClient(config)
    this.toolSchemas = toolDefsToAPISchemas(config.tools ?? [])
    this.toolMap = new Map((config.tools ?? []).map(t => [t.name, t]))
    this.abortController = new AbortController()

    const strategy = config.memory?.extractStrategy
    if (strategy && strategy !== 'disabled') {
      this.memoryExtractor = createMemoryExtractor({
        client: this.client,
        model: config.model,
        memoryDir: resolveMemoryDir(config),
        extractStrategy: strategy,
        extractMaxTurns: config.memory?.extractMaxTurns,
        useForkedAgent: config.memory?.useForkedAgent,
      })
    }
  }

  private async getSystemPrompt(): Promise<string> {
    if (this.resolvedSystemPrompt !== null) return this.resolvedSystemPrompt
    this.resolvedSystemPrompt = await resolveSystemPrompt(this.config)
    return this.resolvedSystemPrompt
  }

  async ask(prompt: string): Promise<Result> {
    let result: Result | undefined
    for await (const event of this.runAgentLoop(prompt, [])) {
      if (event.type === 'result') result = event.result
    }
    if (!result) throw new Error('Agent loop completed without producing a result')
    return result
  }

  stream(prompt: string): AsyncIterable<StreamEvent> {
    return this.runAgentLoop(prompt, [])
  }

  session(sessionId?: string): SessionImpl {
    const config = sessionId
      ? {
          ...this.config,
          persistence: {
            ...this.config.persistence,
            enabled: true,
            resumeSessionId: sessionId,
          },
        }
      : this.config
    return new SessionImpl(config, this.client, this.toolSchemas, this.toolMap)
  }

  abort(reason?: AgentAbortReason): void {
    if (reason === 'interrupt') {
      this.abortController.abort('interrupt')
    } else {
      this.abortController.abort()
    }
    this.abortController = new AbortController()
  }

  private async *runAgentLoop(
    prompt: string,
    existingMessages: MessageParam[],
  ): AsyncGenerator<StreamEvent, void> {
    const systemPrompt = await this.getSystemPrompt()
    const messagesHolder = {
      messages: [...existingMessages, { role: 'user' as const, content: prompt }],
    }
    // Mutable refs so runLoop can update agent state (e.g. model fallback)
    const activeModelRef = { value: this.activeModel }
    const queryTrackingRef = { value: this.queryTracking }
    const stopHookRetryCountRef = { value: this.stopHookRetryCount }

    yield* runLoop({
      config: this.config,
      client: this.client,
      toolSchemas: this.toolSchemas,
      toolMap: this.toolMap,
      systemPrompt,
      messagesHolder,
      signal: this.abortController.signal,
      activeModelRef,
      queryTrackingRef,
      stopHookRetryCountRef,
      memoryExtractor: this.memoryExtractor,
    })

    // Sync mutable state back from refs
    this.activeModel = activeModelRef.value
    this.queryTracking = queryTrackingRef.value
    this.stopHookRetryCount = stopHookRetryCountRef.value
  }
}

// Re-export for session.ts
export { AgentImpl }
