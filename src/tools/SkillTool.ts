/**
 * SkillTool — Invoke saved skills (slash commands).
 *
 * Inspired by Claude Code architecture
 *
 * Now functional: createSkillTool() creates a SkillTool that can invoke
 * loaded skills. Skills expand inline or fork as sub-agents.
 */

import { z } from 'zod'
import { defineTool } from '../tool-builder.js'
import type { AgentConfig, ToolDef } from '../types.js'
import type { SkillDef } from '../skills.js'
import { expandSkillContent } from '../skills.js'

const inputSchema = z.object({
  skill: z.string().describe('The skill name (e.g., "commit", "review-pr", "pdf")'),
  args: z.string().optional().describe('Optional arguments for the skill'),
})

export type SkillInput = z.infer<typeof inputSchema>

/**
 * Create a functional SkillTool that can invoke loaded skills.
 *
 * - inline skills: returns expanded content for the model to process
 * - fork skills: spawns a sub-agent to execute the skill
 */
export function createSkillTool(
  skills: SkillDef[],
  parentConfig?: AgentConfig,
): ToolDef<SkillInput> {
  const skillMap = new Map(skills.map(s => [s.name, s]))

  const availableList = skills.map(s => `${s.name}: ${s.description}`).join('\n')

  return defineTool({
    name: 'Skill',
    description:
      `Execute a skill. Available skills:\n${availableList || '(none loaded)'}`,
    input: inputSchema,

    async execute(input) {
      const skill = skillMap.get(input.skill)
      if (!skill) {
        const names = [...skillMap.keys()].join(', ')
        return {
          content: `Skill "${input.skill}" not found. Available: ${names || '(none)'}`,
          isError: true,
        }
      }

      const expanded = expandSkillContent(skill, input.args)

      // Fork mode: run as sub-agent
      if (skill.context === 'fork' && parentConfig) {
        try {
          const { createAgent } = await import('../agent.js')

          const childAgent = createAgent({
            model: skill.model ?? parentConfig.model,
            apiKey: parentConfig.apiKey,
            baseURL: parentConfig.baseURL,
            provider: parentConfig.provider,
            tools: parentConfig.tools,
            systemPrompt: expanded,
            maxTurns: 20,
            cwd: parentConfig.cwd,
          })

          const result = await childAgent.ask(input.args ?? 'Execute the skill as described.')
          return `[Skill: ${skill.name} (forked)]\n\n${result.text}`
        } catch (err: any) {
          return { content: `Skill fork error: ${err.message}`, isError: true }
        }
      }

      // Inline mode (default): return expanded content for model to process
      return `[Skill: ${skill.name}]\n\n${expanded}`
    },
  })
}

/**
 * Default SkillTool stub — returns error asking users to use createSkillTool().
 */
export const SkillTool = defineTool({
  name: 'Skill',
  description:
    'Execute a skill within the current conversation. Skills provide specialized capabilities and domain knowledge.',
  input: inputSchema,

  async execute(_input) {
    return {
      content:
        'SkillTool requires loaded skills. Use createSkillTool(skills, config) to create a functional version.',
      isError: true,
    }
  },
})
