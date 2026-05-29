/**
 * session.ts — Multi-turn session management
 *
 * A Session accumulates conversation history across multiple send() calls.
 * All loop logic lives in loop.ts — this file handles session-specific
 * concerns: message persistence, session ID, and history accumulation.
 */

import Anthropic from '@anthropic-ai/sdk'
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages.js'
import type {
  AgentConfig,
  Session,
  Result,
  StreamEvent,
  ToolDef,
  MessageParam as PublicMessageParam,
  QueryTracking,
} from './types.js'
import { createMemoryExtractor } from './memory/index.js'
import { appendEntry, loadSession } from './session-storage.js'
import { buildHookContext, fireNotify } from './hooks.js'
import { resolveMemoryDir } from './cwd.js'
import { runLoop, resolveSystemPrompt } from './loop.js'

// ─── SessionImpl ─────────────────────────────────────────────────────────────

export class SessionImpl implements Session {
  private config: AgentConfig
  private client: Anthropic
  private toolSchemas: Anthropic.Messages.Tool[]
  private toolMap: Map<string, ToolDef>
  private messages: MessageParam[] = []
  private abortController: AbortController = new AbortController()
  private resolvedSystemPrompt: string | null = null
  private activeModel: string
  private queryTracking: QueryTracking | null = null
  private stopHookRetryCount = 0
  private memoryExtractor: ReturnType<typeof createMemoryExtractor> | null = null
  private _sessionId: string

  constructor(
    config: AgentConfig,
    client: Anthropic,
    toolSchemas: Anthropic.Messages.Tool[],
    toolMap: Map<string, ToolDef>,
  ) {
    this.config = config
    this.activeModel = config.model
    this.client = client
    this.toolSchemas = toolSchemas
    this.toolMap = toolMap

    this._sessionId = config.persistence?.resumeSessionId ?? crypto.randomUUID()

    if (config.persistence?.enabled) {
      if (config.persistence.resumeSessionId) {
        const loaded = loadSession(this._sessionId, config.persistence)
        if (loaded) this.messages = loaded.messages
      } else {
        appendEntry(this._sessionId, {
          type: 'metadata',
          timestamp: new Date().toISOString(),
          metadata: {
            sessionId: this._sessionId,
            model: config.model,
            createdAt: new Date().toISOString(),
          },
        }, config.persistence)
      }
    }

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

    fireNotify(config.onSessionStart, buildHookContext(this._sessionId, 0, this.messages))
  }

  private async getSystemPrompt(): Promise<string> {
    if (this.resolvedSystemPrompt !== null) return this.resolvedSystemPrompt
    this.resolvedSystemPrompt = await resolveSystemPrompt(this.config)
    return this.resolvedSystemPrompt
  }

  get id(): string {
    return this._sessionId
  }

  get history(): readonly PublicMessageParam[] {
    return this.messages.map(m => ({ role: m.role, content: m.content }) as PublicMessageParam)
  }

  private persistMessage(msg: MessageParam): void {
    if (!this.config.persistence?.enabled) return
    appendEntry(this._sessionId, {
      type: 'message',
      timestamp: new Date().toISOString(),
      message: { role: msg.role, content: msg.content },
    }, this.config.persistence)
  }

  async send(prompt: string): Promise<Result> {
    let result: Result | undefined
    for await (const event of this.runSessionTurn(prompt)) {
      if (event.type === 'result') result = event.result
    }
    if (!result) throw new Error('Session turn completed without producing a result')
    return result
  }

  stream(prompt: string): AsyncIterable<StreamEvent> {
    return this.runSessionTurn(prompt)
  }

  abort(): void {
    this.abortController.abort()
    this.abortController = new AbortController()
  }

  evictToolResults(toolUseIds: string[]): void {
    if (toolUseIds.length === 0) return
    const ids = new Set(toolUseIds)

    this.messages = this.messages
      .map((msg) => {
        if (!Array.isArray(msg.content)) return msg

        if (msg.role === 'assistant') {
          const content = msg.content.filter(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (b: any) => !(b.type === 'tool_use' && ids.has(b.id)),
          )
          return content.length === 0 ? null : { ...msg, content }
        }

        if (msg.role === 'user') {
          const content = msg.content.filter(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (b: any) => !(b.type === 'tool_result' && ids.has(b.tool_use_id)),
          )
          return content.length === 0 ? null : { ...msg, content }
        }

        return msg
      })
      .filter((m): m is (typeof this.messages)[number] => m !== null)
  }

  // ─── Session Turn ─────────────────────────────────────────────────────────

  private async *runSessionTurn(prompt: string): AsyncGenerator<StreamEvent, void> {
    const userMsg: MessageParam = { role: 'user', content: prompt }
    this.messages.push(userMsg)
    this.persistMessage(userMsg)

    const systemPrompt = await this.getSystemPrompt()

    // messagesHolder starts with a reference to this.messages.
    // If the loop replaces it (on compaction), we sync back after.
    const messagesHolder = { messages: this.messages }
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
      sessionId: this._sessionId,
      persistMessage: (msg) => this.persistMessage(msg),
      activeModelRef,
      queryTrackingRef,
      stopHookRetryCountRef,
      memoryExtractor: this.memoryExtractor,
    })

    // Sync mutable state back from refs
    this.messages = messagesHolder.messages
    this.activeModel = activeModelRef.value
    this.queryTracking = queryTrackingRef.value
    this.stopHookRetryCount = stopHookRetryCountRef.value
  }
}
