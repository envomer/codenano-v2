/**
 * snip-compact.ts — Lightweight history trimming
 *
 * Removes old messages to prevent context overflow.
 * No LLM calls, instant execution, zero cost.
 */

import type { MessageParam } from '@anthropic-ai/sdk/resources/messages.js'

// Configuration
const SNIP_THRESHOLD = 50 // Start snipping after 50 messages
const KEEP_HEAD = 2 // Keep first 2 messages (initial context)
const KEEP_TAIL = 20 // Keep last 20 messages (recent context)

/**
 * Snip old messages if conversation is too long.
 * Returns { messages, snipped: boolean }
 */
export function snipIfNeeded(messages: MessageParam[]): {
  messages: MessageParam[]
  snipped: boolean
} {
  if (messages.length <= SNIP_THRESHOLD) {
    return { messages, snipped: false }
  }

  // Keep head (initial context) + tail (recent context)

  // Guard (head): if the last head message is an assistant with tool_use blocks,
  // the next message (tool_results) would be dropped → orphaned tool call.
  // Extend headEnd by one to include it.
  let headEnd = KEEP_HEAD
  if (headEnd < messages.length) {
    const lastHead = messages[headEnd - 1]
    const hasToolUse =
      lastHead &&
      lastHead.role === 'assistant' &&
      Array.isArray(lastHead.content) &&
      lastHead.content.some((b) => typeof b === 'object' && b !== null && (b as any).type === 'tool_use')
    if (hasToolUse) {
      headEnd = Math.min(messages.length, headEnd + 1)
    }
  }
  const head = messages.slice(0, headEnd)

  // Guard (tail): if tailStart lands on a user message with tool_result blocks,
  // the preceding assistant (tool_use) was dropped → orphaned tool result.
  // Walk back one step to include that assistant message.
  let tailStart = messages.length - KEEP_TAIL
  if (tailStart > headEnd) {
    const first = messages[tailStart]
    const hasToolResult =
      first &&
      first.role === 'user' &&
      Array.isArray(first.content) &&
      first.content.some((b) => typeof b === 'object' && b !== null && (b as any).type === 'tool_result')
    if (hasToolResult) {
      tailStart = Math.max(headEnd, tailStart - 1)
    }
  }

  // Exclude head entries that overlap with the tail slice
  const finalHead = head.filter((_, i) => i < tailStart)
  const tail = messages.slice(tailStart)

  return {
    messages: [...finalHead, ...tail],
    snipped: true,
  }
}
