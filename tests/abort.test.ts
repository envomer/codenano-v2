import { describe, it, expect } from 'vitest'
import { isGracefulAbort, buildOrphanedToolResults } from '../src/abort.js'

describe('abort helpers', () => {
  it('isGracefulAbort is true only for interrupt reason', () => {
    const graceful = new AbortController()
    graceful.abort('interrupt')
    expect(isGracefulAbort(graceful.signal)).toBe(true)

    const user = new AbortController()
    user.abort()
    expect(isGracefulAbort(user.signal)).toBe(false)

    const idle = new AbortController()
    expect(isGracefulAbort(idle.signal)).toBe(false)
  })

  it('buildOrphanedToolResults uses different messages by reason', () => {
    const graceful = new AbortController()
    graceful.abort('interrupt')
    const user = new AbortController()
    user.abort()

    const content = [
      { type: 'tool_use' as const, id: 'tu_1', name: 'X', input: {} },
    ]

    expect(buildOrphanedToolResults(content, graceful.signal)[0]?.content).toBe(
      'Agent loop stopped',
    )
    expect(buildOrphanedToolResults(content, user.signal)[0]?.content).toBe(
      'Interrupted by user',
    )
  })
})
