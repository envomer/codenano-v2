/**
 * AgentTool — Spawn sub-agents for parallel or complex tasks.
 *
 * 受 Claude Code 设计灵感启发
 *
 * Now functional: spawns a child agent via createAgent() with the parent's
 * tools and a scoped system prompt. Inspired by Claude Code's forkSubagent pattern.
 */

import { z } from 'zod'
import { defineTool } from '../tool-builder.js'
import type { AgentConfig, ToolDef } from '../types.js'

const inputSchema = z.object({
  description: z.string().describe('A short (3-5 word) description of the task'),
  prompt: z.string().describe('The task for the agent to perform'),
  subagent_type: z
    .string()
    .optional()
    .describe('The type of specialized agent to use for this task'),
  model: z
    .enum(['sonnet', 'opus', 'haiku'])
    .optional()
    .describe('Optional model override for this agent'),
  maxTurns: z
    .number()
    .optional()
    .describe('Max turns for the sub-agent (default: 20)'),
})

export type AgentToolInput = z.infer<typeof inputSchema>

const MODEL_MAP: Record<string, string> = {
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-6',
  haiku: 'claude-haiku-4-5-20251001',
}

const SUBAGENT_SYSTEM_PROMPT = `You are a sub-agent spawned to handle a specific task. Follow these rules:
- Focus strictly on the assigned task — do not go beyond scope.
- Use tools as needed to accomplish the task.
- Do NOT ask questions or converse — just execute silently and report results.
- Keep your final response concise (under 500 words).
- If you encounter errors, try to resolve them. Only report failure if you cannot proceed.`

/**
 * Create a functional AgentTool that can spawn child agents.
 * Requires the parent's config to inherit tools and API settings.
 */
export function createAgentTool(parentConfig: AgentConfig): ToolDef<AgentToolInput> {
  return defineTool({
    name: 'Agent',
    description:
      'Launch a new agent to handle complex, multi-step tasks autonomously. Each agent runs in its own context with access to tools.',
    input: inputSchema,

    async execute(input) {
      // Lazy import to avoid circular dependency
      const { createAgent } = await import('../agent.js')

      const model = input.model
        ? MODEL_MAP[input.model] ?? parentConfig.model
        : parentConfig.model

      const childAgent = createAgent({
        model,
        apiKey: parentConfig.apiKey,
        baseURL: parentConfig.baseURL,
        provider: parentConfig.provider,
        awsRegion: parentConfig.awsRegion,
        tools: parentConfig.tools,
        systemPrompt: SUBAGENT_SYSTEM_PROMPT,
        maxTurns: input.maxTurns ?? 20,
        maxOutputTokens: parentConfig.maxOutputTokens,
        autoCompact: parentConfig.autoCompact,
        toolResultBudget: parentConfig.toolResultBudget,
        streamingToolExecution: parentConfig.streamingToolExecution,
        cwd: parentConfig.cwd,
      })

      try {
        const result = await childAgent.ask(input.prompt)
        return `[Sub-agent: ${input.description}]\n\n${result.text}\n\n(${result.numTurns} turns, ${result.durationMs}ms, $${result.costUSD.toFixed(4)})`
      } catch (err: any) {
        return { content: `Sub-agent error: ${err.message}`, isError: true }
      }
    },
  })
}

/**
 * Default AgentTool stub — returns an error asking users to use createAgentTool().
 * Used when the tool is included in presets without parent config.
 */
export const AgentTool = defineTool({
  name: 'Agent',
  description:
    'Launch a new agent to handle complex, multi-step tasks autonomously. Each agent runs in its own context with access to tools.',
  input: inputSchema,

  async execute(_input) {
    return {
      content:
        'AgentTool requires parent config to spawn sub-agents. Use createAgentTool(parentConfig) to create a functional version.',
      isError: true,
    }
  },
})
