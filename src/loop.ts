/**
 * loop.ts — Shared agent loop implementation
 *
 * The core agentic while-loop, used by both AgentImpl (agent.ts) and
 * SessionImpl (session.ts).  The two callers used to each maintain their own
 * copy of this loop (~400 lines each); this module is the single source of
 * truth.
 *
 * Fixes over the previous per-file implementations:
 *   - onPreToolUse is now fired in the streaming-executor path (was silently
 *     skipped — tools could not be blocked when streaming execution was on)
 *   - firePostToolUse receives the correct tool name (not the tool-use UUID)
 *   - turn_start is emitted consistently for both agent and session modes
 *   - dead empty for-loops in the old agent.ts streaming section are gone
 */

import Anthropic from '@anthropic-ai/sdk'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.js'
import type {
  AgentConfig,
  Result,
  StreamEvent,
  ToolDef,
  Usage,
  QueryTracking,
  MessageParam,
} from './types.js'
import {
  callModelStreamingWithRetry,
  mergeConsecutiveUserMessages,
  FallbackTriggeredError,
  CAPPED_DEFAULT_MAX_TOKENS,
  ESCALATED_MAX_TOKENS,
  type ModelCallResult,
} from './provider.js'
import { toPublicEvent } from './events.js'
import {
  buildSystemPrompt,
  buildEffectiveSystemPrompt,
  detectEnvironment,
  getEnvironmentSection,
} from './prompt/index.js'
import { shouldAutoCompact, compactMessages, isPromptTooLongError } from './compact.js'
import { loadInstructions } from './instructions.js'
import { applyMessageBudget } from './tool-budget.js'
import { StreamingToolExecutor } from './streaming-tool-executor.js'
import { partitionToolCalls, executeSingleTool, executeBatchConcurrently } from './tool-executor.js'
import { snipIfNeeded } from './snip-compact.js'
import { microcompact } from './microcompact.js'
import { getMemorySection } from './prompt/sections/memory.js'
import {
  buildHookContext,
  fireNotify,
  firePreToolUse,
  firePostToolUse,
  fireError,
  fireCompact,
} from './hooks.js'
import { CostTracker } from './cost-tracker.js'
import { resolveAgentCwd, resolveMemoryDir } from './cwd.js'

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_MAX_TURNS = 30
const MAX_OUTPUT_RECOVERY_LIMIT = 3
const MAX_HOOK_RETRIES = 3

const MAX_OUTPUT_RECOVERY_MESSAGE =
  'Output token limit hit. Resume directly — no apology, no recap of what you were doing. ' +
  'Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.'

// ─── System Prompt Resolution ─────────────────────────────────────────────────

/**
 * Build the full system prompt string for a given agent config.
 * Handles the priority chain: overrideSystemPrompt > systemPrompt > built prompt.
 * Appends environment context, CLAUDE.md instructions, and memory sections.
 */
export async function resolveSystemPrompt(config: AgentConfig): Promise<string> {
  const cwd = resolveAgentCwd(config)

  const defaultPrompt = await buildSystemPrompt({
    identity: config.identity,
    model: config.model,
    tools: config.tools,
    language: config.language,
    environment: detectEnvironment(cwd),
    memoryDir: config.memory?.autoLoad !== false ? resolveMemoryDir(config) : undefined,
  })

  const effective = buildEffectiveSystemPrompt({
    overridePrompt: config.overrideSystemPrompt,
    customPrompt: config.systemPrompt,
    defaultPrompt: [...defaultPrompt],
    appendPrompt: config.appendSystemPrompt,
  })

  let prompt = [...effective].filter(Boolean).join('\n\n')

  // Environment section survives custom/override prompts (same pattern as Claude Code)
  if (config.overrideSystemPrompt || config.systemPrompt) {
    prompt = prompt + '\n\n' + getEnvironmentSection(config.model, detectEnvironment(cwd))
  }

  if (config.autoLoadInstructions) {
    const instructions = await loadInstructions({ cwd })
    if (instructions) prompt = prompt + '\n\n' + instructions
  }

  if (config.memory?.autoLoad !== false) {
    const memoryPrompt = getMemorySection(resolveMemoryDir(config))
    if (memoryPrompt) prompt = prompt + '\n\n' + memoryPrompt
  }

  return prompt
}

// ─── Loop Options ─────────────────────────────────────────────────────────────

/** Thin interface for the memory extractor — avoids importing the full implementation. */
interface MemoryExtractor {
  triggerExtraction(messages: MessageParam[]): void
}

export interface LoopOptions {
  config: AgentConfig
  client: Anthropic
  toolSchemas: Anthropic.Messages.Tool[]
  toolMap: Map<string, ToolDef>
  systemPrompt: string
  /**
   * Mutable message holder.  The loop reads and pushes to `holder.messages`
   * and may replace it entirely on compaction.  Callers sync back the final
   * array after `runLoop` returns.
   */
  messagesHolder: { messages: MessageParam[] }
  signal: AbortSignal
  sessionId?: string
  /** Called for every message the loop appends (after the initial user prompt). */
  persistMessage?: (msg: MessageParam) => void
  /** Mutable ref — loop updates on model fallback. */
  activeModelRef: { value: string }
  /** Mutable ref — loop updates on each new query. */
  queryTrackingRef: { value: QueryTracking | null }
  /** Mutable ref — loop updates on stop-hook retry counting. */
  stopHookRetryCountRef: { value: number }
  memoryExtractor: MemoryExtractor | null
}

// ─── runLoop ──────────────────────────────────────────────────────────────────

export async function* runLoop(opts: LoopOptions): AsyncGenerator<StreamEvent, void> {
  const {
    config,
    client,
    toolSchemas,
    toolMap,
    systemPrompt,
    messagesHolder,
    signal,
    sessionId,
    persistMessage,
    activeModelRef,
    queryTrackingRef,
    stopHookRetryCountRef,
    memoryExtractor,
  } = opts

  const startTime = Date.now()
  const maxTurns = config.maxTurns ?? DEFAULT_MAX_TURNS

  let turnCount = 0
  let lastStopReason = 'end_turn'
  let hasAttemptedCompact = false
  let maxOutputRecoveryCount = 0
  let maxOutputTokensOverride: number | undefined
  let lastUsage: Usage | undefined
  const totalUsage: Usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  }
  const costTracker = new CostTracker()

  const queryTracking: QueryTracking = queryTrackingRef.value
    ? { chainId: queryTrackingRef.value.chainId, depth: queryTrackingRef.value.depth + 1 }
    : { chainId: crypto.randomUUID(), depth: 0 }
  queryTrackingRef.value = queryTracking

  yield { type: 'query_start', queryTracking }

  const maxRecoveryAttempts = config.maxOutputRecoveryAttempts ?? MAX_OUTPUT_RECOVERY_LIMIT
  const useStreamingExecution = config.streamingToolExecution !== false
  const enableBudget = config.toolResultBudget !== false
  const capEnabled = config.maxOutputTokensCap === true

  if (capEnabled && !config.maxOutputTokens) {
    maxOutputTokensOverride = CAPPED_DEFAULT_MAX_TOKENS
  }

  const getActiveConfig = (): AgentConfig =>
    activeModelRef.value === config.model
      ? config
      : { ...config, model: activeModelRef.value }

  while (turnCount < maxTurns) {
    turnCount++

    if (signal.aborted) break

    // ── Turn start ────────────────────────────────────────────────────────
    yield { type: 'turn_start', turnNumber: turnCount }
    await fireNotify(config.onTurnStart, buildHookContext(sessionId, turnCount, messagesHolder.messages))

    // ── Message compression (fast, zero-cost) ─────────────────────────────
    const snipResult = snipIfNeeded(messagesHolder.messages)
    if (snipResult.snipped) messagesHolder.messages = snipResult.messages

    const microResult = microcompact(messagesHolder.messages)
    if (microResult.compressed > 0) messagesHolder.messages = microResult.messages

    // ── Auto-compact ──────────────────────────────────────────────────────
    if (config.autoCompact !== false && lastUsage) {
      if (shouldAutoCompact(messagesHolder.messages, config, lastUsage)) {
        const messagesBefore = messagesHolder.messages.length
        const compacted = await compactMessages(
          messagesHolder.messages, systemPrompt, client, config, signal,
        )
        if (compacted) {
          messagesHolder.messages = compacted
          hasAttemptedCompact = true
          await fireCompact(
            config.onCompact,
            buildHookContext(sessionId, turnCount, messagesHolder.messages),
            messagesBefore,
            messagesHolder.messages.length,
          )
        }
      }
    }

    // ── Call model ────────────────────────────────────────────────────────
    let modelResult: ModelCallResult | undefined
    let modelError: unknown = null
    const normalizedMessages = mergeConsecutiveUserMessages(messagesHolder.messages)

    const streamingExecutor =
      useStreamingExecution && (config.tools?.length ?? 0) > 0
        ? new StreamingToolExecutor(toolMap, config, signal, messagesHolder.messages, enableBudget)
        : null

    try {
      for await (const event of callModelStreamingWithRetry(
        client,
        normalizedMessages,
        systemPrompt,
        toolSchemas,
        getActiveConfig(),
        signal,
        maxOutputTokensOverride,
      )) {
        const publicEvent = toPublicEvent(event, turnCount)
        // Suppress tool_use and turn_end — we manage those manually
        if (publicEvent && publicEvent.type !== 'tool_use' && publicEvent.type !== 'turn_end') {
          yield publicEvent
        }
        if (event.type === 'message_complete') modelResult = event.result
      }
    } catch (error) {
      if (streamingExecutor) {
        for (const _ of streamingExecutor.discard()) { /* cancel in-flight tools */ }
      }

      if (error instanceof FallbackTriggeredError && config.fallbackModel) {
        activeModelRef.value = config.fallbackModel
        yield {
          type: 'error',
          error: new Error(
            `Switched to ${config.fallbackModel} due to high demand for ${config.model}`,
          ),
        }
        turnCount--
        continue
      }
      modelError = error
    }

    // ── 413 Recovery ──────────────────────────────────────────────────────
    if (modelError && isPromptTooLongError(modelError) && !hasAttemptedCompact) {
      const compacted = await compactMessages(
        messagesHolder.messages, systemPrompt, client, config, signal,
      )
      if (compacted) {
        messagesHolder.messages = compacted
        hasAttemptedCompact = true
        turnCount--
        continue
      }
      yield { type: 'error', error: toError(modelError) }
      break
    }

    if (modelError) {
      const err = toError(modelError)
      await fireError(config.onError, buildHookContext(sessionId, turnCount, messagesHolder.messages), err)
      yield { type: 'error', error: err }
      break
    }

    if (!modelResult) {
      const err = new Error('Model call produced no result')
      await fireError(config.onError, buildHookContext(sessionId, turnCount, messagesHolder.messages), err)
      yield { type: 'error', error: err }
      break
    }

    // ── Accumulate usage ──────────────────────────────────────────────────
    lastUsage = modelResult.usage
    totalUsage.inputTokens += modelResult.usage.inputTokens
    totalUsage.outputTokens += modelResult.usage.outputTokens
    totalUsage.cacheCreationInputTokens += modelResult.usage.cacheCreationInputTokens
    totalUsage.cacheReadInputTokens += modelResult.usage.cacheReadInputTokens
    costTracker.add(activeModelRef.value, modelResult.usage)
    lastStopReason = modelResult.stopReason ?? 'end_turn'

    const assistantMsg: MessageParam = {
      role: 'assistant',
      content: modelResult.assistantContent as ContentBlockParam[],
    }
    messagesHolder.messages.push(assistantMsg)
    persistMessage?.(assistantMsg)

    // ── Max output token escalation + recovery ────────────────────────────
    if (lastStopReason === 'max_tokens') {
      // Path 1: Escalate to 64K and retry (no recovery message)
      if (capEnabled && maxOutputTokensOverride !== ESCALATED_MAX_TOKENS && !config.maxOutputTokens) {
        maxOutputTokensOverride = ESCALATED_MAX_TOKENS
        messagesHolder.messages.pop()
        turnCount--
        continue
      }

      // Path 2: Inject resume message
      if (maxOutputRecoveryCount < maxRecoveryAttempts) {
        maxOutputRecoveryCount++
        if (capEnabled) maxOutputTokensOverride = undefined
        const resumeMsg: MessageParam = { role: 'user', content: MAX_OUTPUT_RECOVERY_MESSAGE }
        messagesHolder.messages.push(resumeMsg)
        persistMessage?.(resumeMsg)
        continue
      }
    }

    // ── Extract tool_use blocks ───────────────────────────────────────────
    const toolUseBlocks = modelResult.assistantContent.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    )

    if (toolUseBlocks.length > 0) {
      maxOutputRecoveryCount = 0
      if (capEnabled && !config.maxOutputTokens) maxOutputTokensOverride = CAPPED_DEFAULT_MAX_TOKENS
    }

    // ── No tool use → done ────────────────────────────────────────────────
    if (toolUseBlocks.length === 0) {
      if (config.onTurnEnd) {
        const lastText = extractText(modelResult.assistantContent)
        const hookResult = await config.onTurnEnd({
          messages: messagesHolder.messages,
          lastResponse: lastText,
        })

        if (hookResult?.preventContinuation) {
          stopHookRetryCountRef.value = 0
          yield { type: 'turn_end', stopReason: 'stop_hook_prevented', turnNumber: turnCount }
          yield {
            type: 'result',
            result: buildResult(
              lastText, messagesHolder.messages, totalUsage,
              'stop_hook_prevented', turnCount, startTime, costTracker, queryTracking,
            ),
          }
          return
        }

        if (hookResult?.continueWith) {
          if (stopHookRetryCountRef.value >= MAX_HOOK_RETRIES) {
            console.warn('Stop hook retry limit reached')
            stopHookRetryCountRef.value = 0
            yield { type: 'turn_end', stopReason: 'hook_retry_limit', turnNumber: turnCount }
            yield {
              type: 'result',
              result: buildResult(
                lastText, messagesHolder.messages, totalUsage,
                'hook_retry_limit', turnCount, startTime, costTracker, queryTracking,
              ),
            }
            return
          }
          stopHookRetryCountRef.value++
          const continueMsg: MessageParam = { role: 'user', content: hookResult.continueWith }
          messagesHolder.messages.push(continueMsg)
          persistMessage?.(continueMsg)
          continue
        }
      }

      stopHookRetryCountRef.value = 0
      memoryExtractor?.triggerExtraction(messagesHolder.messages)

      yield { type: 'turn_end', stopReason: lastStopReason, turnNumber: turnCount }
      yield {
        type: 'result',
        result: buildResult(
          extractText(modelResult.assistantContent), messagesHolder.messages, totalUsage,
          lastStopReason, turnCount, startTime, costTracker, queryTracking,
        ),
      }
      return
    }

    // ── Execute tools ─────────────────────────────────────────────────────
    yield { type: 'turn_end', stopReason: 'tool_use', turnNumber: turnCount }

    const hookCtx = buildHookContext(sessionId, turnCount, messagesHolder.messages)

    // Both helpers are sub-generators: they yield StreamEvents that flow through
    // this generator via yield*, and return the final ContentBlockParam[] array.
    const allToolResults: ContentBlockParam[] = streamingExecutor
      ? yield* executeStreamingPath(toolUseBlocks, streamingExecutor, config, hookCtx)
      : yield* executeBatchPath(
          toolUseBlocks, toolMap, config, signal, messagesHolder.messages, enableBudget, hookCtx,
        )

    const budgetedResults = enableBudget ? applyMessageBudget(allToolResults) : allToolResults
    const toolResultMsg: MessageParam = { role: 'user', content: budgetedResults }
    messagesHolder.messages.push(toolResultMsg)
    persistMessage?.(toolResultMsg)
  }

  // Max turns reached
  await fireNotify(config.onMaxTurns, buildHookContext(sessionId, turnCount, messagesHolder.messages))
  yield {
    type: 'result',
    result: buildResult(
      extractLastAssistantText(messagesHolder.messages), messagesHolder.messages, totalUsage,
      `max_turns (${maxTurns})`, turnCount, startTime, costTracker, queryTracking,
    ),
  }
}

// ─── Tool Execution Sub-generators ───────────────────────────────────────────

/**
 * Streaming-executor path.
 *
 * Uses `yield*` from the caller so StreamEvents flow through seamlessly and the
 * returned ContentBlockParam[] is captured as the expression value.
 *
 * Fixes vs the old per-file implementation:
 *   - onPreToolUse is checked for every block before addTool()
 *   - firePostToolUse receives the correct tool name (not the UUID)
 *   - results are reconstructed in original toolUseBlocks order
 */
async function* executeStreamingPath(
  toolUseBlocks: Anthropic.ToolUseBlock[],
  executor: StreamingToolExecutor,
  config: AgentConfig,
  hookCtx: ReturnType<typeof buildHookContext>,
): AsyncGenerator<StreamEvent, ContentBlockParam[]> {
  const pendingResults = new Map<string, ContentBlockParam>()

  // Pre-hook check + enqueue (or block)
  for (const block of toolUseBlocks) {
    const blockReason = await firePreToolUse(config, hookCtx, {
      name: block.name,
      input: block.input as Record<string, unknown>,
      id: block.id,
    })
    if (blockReason) {
      const content = `Tool blocked: ${blockReason}`
      pendingResults.set(block.id, {
        type: 'tool_result',
        tool_use_id: block.id,
        content,
        is_error: true,
      } as ContentBlockParam)
      yield { type: 'tool_result', toolUseId: block.id, output: content, isError: true }
    } else {
      yield { type: 'tool_use', toolName: block.name, toolUseId: block.id, input: block.input }
      executor.addTool(block)
    }
  }

  // Collect executor results, fire post-hook with correct tool name
  for await (const result of executor.getRemainingResults()) {
    const evt = result.event
    if (evt.type !== 'tool_result') continue
    pendingResults.set(evt.toolUseId, result.apiResult)
    yield evt
    const block = toolUseBlocks.find(b => b.id === evt.toolUseId)
    await firePostToolUse(config, hookCtx, {
      name: block?.name ?? evt.toolUseId,
      input: (block?.input ?? {}) as Record<string, unknown>,
      id: evt.toolUseId,
      output: evt.output,
      isError: evt.isError,
    })
  }

  // Reconstruct in original order (API requires results match tool_use order)
  return toolUseBlocks.map(b => {
    const result = pendingResults.get(b.id)
    if (result) return result
    return {
      type: 'tool_result',
      tool_use_id: b.id,
      content: 'Internal error: no result for tool',
      is_error: true,
    } as ContentBlockParam
  })
}

/**
 * Batch execution path (streaming executor disabled).
 * Handles concurrent and sequential batches with correct pre/post hooks.
 */
async function* executeBatchPath(
  toolUseBlocks: Anthropic.ToolUseBlock[],
  toolMap: Map<string, ToolDef>,
  config: AgentConfig,
  signal: AbortSignal,
  messages: MessageParam[],
  enableBudget: boolean,
  hookCtx: ReturnType<typeof buildHookContext>,
): AsyncGenerator<StreamEvent, ContentBlockParam[]> {
  const allToolResults: ContentBlockParam[] = []
  const batches = partitionToolCalls(toolUseBlocks, toolMap)

  for (const batch of batches) {
    if (batch.isConcurrencySafe && batch.blocks.length > 1) {
      const allowedBlocks: typeof batch.blocks = []
      for (const toolUse of batch.blocks) {
        const blockReason = await firePreToolUse(config, hookCtx, {
          name: toolUse.name,
          input: toolUse.input as Record<string, unknown>,
          id: toolUse.id,
        })
        if (blockReason) {
          const content = `Tool blocked: ${blockReason}`
          allToolResults.push({
            type: 'tool_result', tool_use_id: toolUse.id, content, is_error: true,
          } as ContentBlockParam)
          yield { type: 'tool_result', toolUseId: toolUse.id, output: content, isError: true }
        } else {
          allowedBlocks.push(toolUse)
          yield { type: 'tool_use', toolName: toolUse.name, toolUseId: toolUse.id, input: toolUse.input }
        }
      }

      if (allowedBlocks.length > 0) {
        const results = await executeBatchConcurrently(
          allowedBlocks, toolMap, config, signal, messages,
          Math.min(allowedBlocks.length, 10), enableBudget,
        )
        for (const r of results) {
          allToolResults.push(r.apiResult)
          yield r.event
          const evt = r.event
          if (evt.type === 'tool_result') {
            const block = allowedBlocks.find(b => b.id === evt.toolUseId)!
            await firePostToolUse(config, hookCtx, {
              name: block.name,
              input: block.input as Record<string, unknown>,
              id: evt.toolUseId,
              output: evt.output,
              isError: evt.isError,
            })
          }
        }
      }
    } else {
      for (const toolUse of batch.blocks) {
        const blockReason = await firePreToolUse(config, hookCtx, {
          name: toolUse.name,
          input: toolUse.input as Record<string, unknown>,
          id: toolUse.id,
        })
        if (blockReason) {
          const content = `Tool blocked: ${blockReason}`
          allToolResults.push({
            type: 'tool_result', tool_use_id: toolUse.id, content, is_error: true,
          } as ContentBlockParam)
          yield { type: 'tool_result', toolUseId: toolUse.id, output: content, isError: true }
        } else {
          const { apiResult, events } = await executeSingleTool(
            toolUse, toolMap, config, signal, messages, enableBudget,
          )
          for (const evt of events) {
            yield evt
            if (evt.type === 'tool_result') {
              await firePostToolUse(config, hookCtx, {
                name: toolUse.name,
                input: toolUse.input as Record<string, unknown>,
                id: toolUse.id,
                output: evt.output,
                isError: evt.isError,
              })
            }
          }
          allToolResults.push(apiResult)
        }
      }
    }
  }

  return allToolResults
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e))
}

function extractText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('')
}

function extractLastAssistantText(messages: MessageParam[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      return msg.content
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.text)
        .join('')
    }
  }
  return ''
}

function buildResult(
  text: string,
  messages: MessageParam[],
  usage: Usage,
  stopReason: string,
  numTurns: number,
  startTime: number,
  costTracker: CostTracker,
  queryTracking: QueryTracking,
): Result {
  return {
    text,
    messages: messages.map(m => ({ role: m.role, content: m.content }) as MessageParam),
    usage,
    stopReason,
    numTurns,
    durationMs: Date.now() - startTime,
    costUSD: costTracker.total,
    queryTracking,
  }
}
