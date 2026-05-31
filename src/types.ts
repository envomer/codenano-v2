/**
 * types.ts — Public types for Agent-Core SDK
 *
 * These are the types developers interact with.
 * Internal engine types are hidden in engine/types.ts.
 */

import type { ZodType } from 'zod'

/**
 * Reason for Agent.abort() / Session.abort().
 * `'interrupt'` — graceful stop (e.g. PlanTaskDone); not treated as user cancel.
 */
export type AgentAbortReason = 'interrupt'

// ─── Agent Configuration ────────────────────────────────────────────────────

/** Configuration for creating an Agent */
export interface AgentConfig {
  /** Claude model to use (e.g. 'claude-sonnet-4-6', 'claude-opus-4-6') */
  model: string

  /**
   * Primary working directory path for the agent.
   * Used as the default for file tools, Bash, CLAUDE.md discovery, memory scoping,
   * and system prompt environment context. Defaults to process.cwd().
   */
  cwd?: string

  /** Anthropic API key. Defaults to ANTHROPIC_API_KEY env var */
  apiKey?: string

  /** Custom base URL for API requests (e.g. proxy endpoints) */
  baseURL?: string

  /** Tools available to the agent */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools?: ToolDef<any>[]

  /** System prompt — plain string or built via prompt system */
  systemPrompt?: string

  /** Agent identity (used by prompt builder, e.g. "You are a coding assistant") */
  identity?: string

  /** Language preference for responses (e.g. "Chinese", "Japanese") */
  language?: string

  /** Override system prompt — replaces everything when set */
  overrideSystemPrompt?: string

  /** Append to system prompt — always added at end */
  appendSystemPrompt?: string

  /** Maximum number of agent loop turns (default: 30) */
  maxTurns?: number

  /** Thinking configuration (default: 'disabled') */
  thinkingConfig?: 'adaptive' | 'disabled'

  /** Maximum output tokens per model call (default: 16384) */
  maxOutputTokens?: number

  /** Permission callback — controls which tool calls are allowed */
  canUseTool?: PermissionFn

  /** Stop hook — called when agent finishes a turn without tool use */
  onTurnEnd?: StopHookFn

  /** Called when a session is created */
  onSessionStart?: NotifyHookFn

  /** Called at the start of each agent loop turn */
  onTurnStart?: NotifyHookFn

  /** Called before each tool executes. Return { block: reason } to prevent execution. */
  onPreToolUse?: PreToolUseHookFn

  /** Called after each tool executes with the result */
  onPostToolUse?: PostToolUseHookFn

  /** Called when auto-compact summarizes conversation history */
  onCompact?: CompactHookFn

  /** Called when an error occurs during the agent loop */
  onError?: ErrorHookFn

  /** Called when the agent reaches the maximum number of turns */
  onMaxTurns?: NotifyHookFn

  /** Provider override (default: auto-detected from env) */
  provider?: 'anthropic' | 'bedrock'

  /** AWS region for Bedrock provider */
  awsRegion?: string

  /**
   * Enable auto-compact when conversation approaches context window limit.
   * Defaults to true. Set to false to disable.
   *
   * When enabled, the agent will summarize the conversation history before
   * the next model call if the estimated token count exceeds the threshold
   * (context window - 13k buffer). Mirrors codenano's auto-compact behavior.
   */
  autoCompact?: boolean

  /**
   * Context window size in tokens for the model being used.
   * Used to calculate the auto-compact threshold.
   * Defaults to 200_000 (Claude's context window).
   * Set this when using non-Anthropic models via OpenRouter or other providers
   * (e.g. 128_000 for GPT-4o, 60_000 for a conservative cross-model default).
   */
  contextWindow?: number

  /**
   * Fallback model to use when the primary model is overloaded (529 errors).
   * After 3 consecutive 529 errors, the agent switches to this model.
   *
   * Example: 'claude-haiku-4-5-20251001' as fallback for 'claude-sonnet-4-6'
   */
  fallbackModel?: string

  /**
   * Max output tokens recovery: number of retry attempts when the model
   * hits its output token limit (stop_reason = 'max_tokens').
   * Each retry injects a "resume" message asking the model to continue.
   * Default: 3 (matches codenano's MAX_OUTPUT_TOKENS_RECOVERY_LIMIT).
   * Set to 0 to disable.
   */
  maxOutputRecoveryAttempts?: number

  /**
   * Auto-load CLAUDE.md project instructions from the filesystem.
   * When true, discovers and loads CLAUDE.md, .claude/CLAUDE.md,
   * .claude/rules/*.md, and CLAUDE.local.md files from the project
   * directory hierarchy. Instructions are appended to the system prompt.
   * Default: false.
   */
  autoLoadInstructions?: boolean

  /**
   * Enable tool result size budgeting.
   * When true, tool results exceeding 50KB are truncated with a preview.
   * Per-message aggregate is capped at 200KB.
   * Default: true.
   */
  toolResultBudget?: boolean

  /**
   * Enable max output token cap with escalation.
   * When true, initial requests use 8K max_tokens (saving API slot capacity).
   * If the model hits max_tokens, the agent first escalates to 64K and retries
   * with the same messages (no recovery message). Only if that also hits the
   * limit does the recovery inject ("resume directly...") kick in.
   * Default: false.
   */
  maxOutputTokensCap?: boolean

  /**
   * Enable streaming tool execution.
   * When true, tools start executing as soon as their content_block completes
   * in the stream, rather than waiting for the entire model response.
   * This reduces per-turn latency when the model calls multiple tools.
   * Default: true.
   */
  streamingToolExecution?: boolean

  /**
   * MCP servers to connect to.
   * Tools from these servers become available to the agent with prefixed names (mcp__<server>__<tool>).
   */
  mcpServers?: import('./mcp.js').MCPServerConfig[]

  /**
   * Session persistence configuration.
   * When enabled, session messages are saved to JSONL files and can be resumed later.
   */
  persistence?: {
    /** Enable persistence. Default: false */
    enabled: boolean
    /** Directory to store session JSONL files. Default: ~/.agent-core/sessions/ */
    storageDir?: string
    /** Existing session ID to resume. Loads messages from the JSONL file. */
    resumeSessionId?: string
  }

  /**
   * Memory configuration for persistent agent memory.
   * When enabled, the agent can save and load memories across sessions.
   */
  memory?: {
    /** Custom memory directory path. Defaults to ~/.agent-core/memory/<project-hash>/ */
    memoryDir?: string
    /** Auto-load memories into system prompt. Default: true */
    autoLoad?: boolean
    /**
     * Memory extraction strategy. Default: 'disabled'
     * - 'disabled': No automatic extraction
     * - 'auto': Extract after every completed turn (fire-and-forget, like Claude Code)
     * - { interval: N }: Extract every N completed turns
     */
    extractStrategy?: import('./memory/types.js').ExtractStrategy
    /** Max turns for the extraction agent. Default: 3 */
    extractMaxTurns?: number
    /** Use forked agent with prompt caching for extraction. Default: false (use direct API) */
    useForkedAgent?: boolean
  }
}

// ─── Tool Definition ────────────────────────────────────────────────────────

/** Developer-facing tool definition */
export interface ToolDef<TInput = unknown> {
  /** Unique tool name (PascalCase recommended) */
  name: string

  /** Human-readable description — this is shown to the model */
  description: string

  /** Zod schema for input validation */
  input: ZodType<TInput>

  /** Execute the tool — receives validated input, returns result */
  execute: (input: TInput, context: ToolContext) => Promise<ToolOutput>

  /** Whether this tool only reads data (enables concurrent execution) */
  isReadOnly?: boolean | ((input: TInput) => boolean)

  /** Whether this tool is safe to run concurrently with other read-only tools */
  isConcurrencySafe?: boolean | ((input: TInput) => boolean)
}

/** Context passed to tool execute functions */
export interface ToolContext {
  /** Current working directory */
  cwd?: string

  /** Abort signal for cooperative cancellation */
  signal: AbortSignal

  /** All messages in the current conversation */
  messages: readonly MessageParam[]
}

/** Return value from a tool's execute function */
export type ToolOutput = string | { content: string; isError?: boolean }

// ─── Permission System ──────────────────────────────────────────────────────

/** Permission check function */
export type PermissionFn = (
  toolName: string,
  input: Record<string, unknown>,
) => PermissionDecision | Promise<PermissionDecision>

/** Permission decision */
export type PermissionDecision = { behavior: 'allow' } | { behavior: 'deny'; message?: string }

// ─── Query Tracking ─────────────────────────────────────────────────────────

/** Query chain tracking for debugging and analytics */
export interface QueryTracking {
  /** Unique identifier for this query chain */
  chainId: string
  /** Nesting depth (0 for main query, increments for recursive calls) */
  depth: number
}

// ─── Stop Hook ──────────────────────────────────────────────────────────────

/** Called when agent completes a turn without tool use */
export type StopHookFn = (context: {
  messages: readonly MessageParam[]
  lastResponse: string
}) => StopHookResult | Promise<StopHookResult>

/** Stop hook result */
export type StopHookResult = {
  /** If provided, inject this as a user message to continue the loop */
  continueWith?: string
  /** If true, force the agent to stop */
  preventContinuation?: boolean
}

// ─── Extended Hooks ────────────────────────────────────────────────────────

/** Context passed to all lifecycle hooks */
export interface HookContext {
  /** Session ID (available in session mode) */
  sessionId?: string
  /** Current turn number (0 before first turn) */
  turnNumber: number
  /** Conversation messages so far */
  messages: readonly MessageParam[]
}

/** Pre-tool-use hook — called before each tool executes. Can block execution. */
export type PreToolUseHookFn = (context: HookContext & {
  toolName: string
  toolInput: Record<string, unknown>
  toolUseId: string
}) => PreToolUseResult | Promise<PreToolUseResult>

/** Result from pre-tool-use hook */
export type PreToolUseResult = {
  /** Block this tool call. The reason is returned to the model as an error. */
  block?: string
} | void

/** Post-tool-use hook — called after each tool executes. Observe results. */
export type PostToolUseHookFn = (context: HookContext & {
  toolName: string
  toolInput: Record<string, unknown>
  toolUseId: string
  output: string
  isError: boolean
}) => void | Promise<void>

/** Notification hook (fire-and-forget, no return value) */
export type NotifyHookFn = (context: HookContext) => void | Promise<void>

/** Error hook — called when an error occurs during the agent loop */
export type ErrorHookFn = (context: HookContext & {
  error: Error
}) => void | Promise<void>

/** Compact hook — called when auto-compact summarizes conversation history */
export type CompactHookFn = (context: HookContext & {
  messagesBefore: number
  messagesAfter: number
}) => void | Promise<void>

// ─── Stream Events ──────────────────────────────────────────────────────────

/** Events yielded during agent.stream() */
export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; toolName: string; toolUseId: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; output: string; isError: boolean }
  | { type: 'turn_start'; turnNumber: number }
  | { type: 'turn_end'; stopReason: string; turnNumber: number }
  | { type: 'query_start'; queryTracking: QueryTracking }
  | { type: 'result'; result: Result }
  | { type: 'error'; error: Error }

// ─── Result ─────────────────────────────────────────────────────────────────

/** Final result returned from agent.ask() or session.send() */
export interface Result {
  /** The agent's final text response */
  text: string

  /** All messages in the conversation (including tool calls) */
  messages: MessageParam[]

  /** Token usage for this interaction */
  usage: Usage

  /** Why the agent stopped */
  stopReason: string

  /** Number of agent loop turns */
  numTurns: number

  /** Duration in milliseconds */
  durationMs: number

  /** Estimated API cost in USD */
  costUSD: number

  /** Query tracking information */
  queryTracking: QueryTracking
}

/** Token usage statistics */
export interface Usage {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
}

// ─── Messages ───────────────────────────────────────────────────────────────

/** Message in the conversation */
export type MessageParam = any

/** Content block within a message */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  | { type: 'thinking'; thinking: string }

// ─── Agent & Session Interfaces ─────────────────────────────────────────────

/** An Agent instance — the primary interface */
export interface Agent {
  /** One-shot: send a prompt and get back the final result */
  ask(prompt: string): Promise<Result>

  /** Streaming: yield events as the agent works */
  stream(prompt: string): AsyncIterable<StreamEvent>

  /** Create a multi-turn session with persistent history, or resume by ID */
  session(sessionId?: string): Session

  /**
   * Abort the current operation.
   * @param reason `'interrupt'` for graceful completion (e.g. PlanTaskDone) — does not
   *   inject user-interruption messages. Omit for user cancellation.
   */
  abort(reason?: AgentAbortReason): void
}

/** A multi-turn conversation session */
export interface Session {
  /** Unique session identifier (UUID). Use this to resume the session later. */
  readonly id: string

  /** Send a message and get the result (accumulates history) */
  send(prompt: string): Promise<Result>

  /** Send a message with streaming events */
  stream(prompt: string): AsyncIterable<StreamEvent>

  /**
   * Abort the current operation.
   * @param reason `'interrupt'` for graceful completion — see {@link Agent.abort}.
   */
  abort(reason?: AgentAbortReason): void

  /** Get conversation history */
  readonly history: readonly MessageParam[]

  /**
   * Remove specific tool calls and their results from conversation history.
   * Pass the toolUseIds of Read calls that were exploratory (file was read but
   * never subsequently edited). Both the tool_use block in the assistant message
   * and the matching tool_result block in the user message are stripped.
   * Messages that become empty after stripping are removed entirely.
   */
  evictToolResults(toolUseIds: string[]): void
}
