/**
 * abort.ts — Cooperative abort reasons for the agent loop
 *
 * Mirrors codenano queryLoop behavior:
 *   abort('interrupt') → graceful stop (e.g. PlanTaskDone); no user-cancel messages
 *   abort()            → user cancellation; inject interruption meta-messages
 */

import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.js'
import type Anthropic from '@anthropic-ai/sdk'
import type { AgentAbortReason, MessageParam } from './types.js'

export type { AgentAbortReason }

const USER_INTERRUPT_MESSAGE = '[Request interrupted by user]'
const USER_INTERRUPT_DURING_TOOLS_MESSAGE =
  '[Request interrupted by user during tool execution]'

/** Graceful completion abort (PlanTaskDone, etc.) — not a user cancel */
export function isGracefulAbort(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason === 'interrupt'
}

export function orphanedToolResultMessage(signal: AbortSignal): string {
  return isGracefulAbort(signal) ? 'Agent loop stopped' : 'Interrupted by user'
}

export function buildOrphanedToolResults(
  assistantContent: Anthropic.ContentBlock[],
  signal: AbortSignal,
): ContentBlockParam[] {
  const message = orphanedToolResultMessage(signal)
  return assistantContent
    .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
    .map(
      b =>
        ({
          type: 'tool_result',
          tool_use_id: b.id,
          content: message,
          is_error: true,
        }) as ContentBlockParam,
    )
}

export function appendUserInterruptionMessage(
  messages: MessageParam[],
  duringToolExecution: boolean,
): MessageParam {
  const msg: MessageParam = {
    role: 'user',
    content: duringToolExecution
      ? USER_INTERRUPT_DURING_TOOLS_MESSAGE
      : USER_INTERRUPT_MESSAGE,
  }
  messages.push(msg)
  return msg
}

export function abortStopReason(
  signal: AbortSignal,
  phase: 'streaming' | 'tools' | 'turn',
): string {
  if (isGracefulAbort(signal)) return `aborted_${phase}_graceful`
  return phase === 'streaming' ? 'aborted_streaming' : phase === 'tools' ? 'aborted_tools' : 'aborted'
}
