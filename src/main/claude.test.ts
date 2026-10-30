import { describe, expect, it } from 'vitest'
import { collectChanges, computeUsage, parseTranscript, sessionTitle } from './claude'

const line = (o: object): string => JSON.stringify(o)

const assistant = (id: string, usage: object, extra: object = {}): string =>
  line({ type: 'assistant', message: { id, model: 'claude-opus-5-5', usage }, ...extra })

describe('sessionTitle', () => {
  it('returns the first human prompt, skipping meta and command wrappers', () => {
    const jsonl = [
      line({ type: 'mode', mode: 'normal' }),
      line({ type: 'user', isMeta: true, message: { content: 'caveat' } }),
      line({ type: 'user', message: { content: '<command-name>/clear</command-name>' } }),
      line({ type: 'user', message: { content: [{ type: 'text', text: 'fix the login bug' }] } }),
      line({ type: 'user', message: { content: 'second prompt' } })
    ].join('\n')
    expect(sessionTitle(jsonl)).toBe('fix the login bug')
  })

  it('ignores a truncated last line', () => {
    expect(sessionTitle('{"type":"user","message":{"content":"abc')).toBeUndefined()
  })
})

describe('computeUsage', () => {
  it('counts each message id once and prices cache writes by TTL', () => {
    const usage = {
      input_tokens: 10,
      output_tokens: 100,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 500,
      cache_creation: { ephemeral_1h_input_tokens: 200, ephemeral_5m_input_tokens: 300 }
    }
    const jsonl = [assistant('m1', usage), assistant('m1', usage), assistant('m2', usage)].join('\n')
    const u = computeUsage(jsonl)!
    expect(u.input).toBe(20)
    expect(u.output).toBe(200)
    expect(u.cacheRead).toBe(2000)
    expect(u.cacheWrite).toBe(1000)
    expect(u.contextTokens).toBe(1510)
    expect(u.contextWindow).toBe(1_000_000)
    // per message: 10*4 + 100*20 + 1000*0.2 + 300*4*1.25 + 200*4*2 = 5340 (per million)
    expect(u.costUsd).toBeCloseTo((2 * 5340) / 1e6)
  })

  it('keeps context from the main thread, not sidechains', () => {
    const jsonl = [
      assistant('a', { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 100 }),
      assistant('b', { input_tokens: 9, output_tokens: 1, cache_read_input_tokens: 9000 }, { isSidechain: true })
    ].join('\n')
    expect(computeUsage(jsonl)!.contextTokens).toBe(105)
  })

  it('returns undefined without assistant messages', () => {
    expect(computeUsage(line({ type: 'user', message: { content: 'hi' } }))).toBeUndefined()
  })
})

describe('parseTranscript', () => {
  it('flattens prompts, replies and tool calls with their results', () => {
    const jsonl = [
      line({ type: 'user', uuid: 'u1', message: { content: 'add a test' } }),
      line({ type: 'user', uuid: 'u2', isMeta: true, message: { content: 'meta' } }),
      line({ type: 'assistant', uuid: 'a1', message: { content: [{ type: 'thinking', thinking: '' }] } }),
      line({ type: 'assistant', uuid: 'a2', message: { content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'x.ts' } }] } }),
      line({ type: 'user', uuid: 'u3', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }),
      line({ type: 'assistant', uuid: 'a3', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent' }] } }),
      line({ type: 'assistant', uuid: 'a4', message: { content: [{ type: 'text', text: 'Done.' }] } }),
      line({ type: 'user', uuid: 'u4', message: { content: '<command-name>/clear</command-name>' } }),
      line({ type: 'user', uuid: 'u5', message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } }),
      line({ type: 'user', uuid: 'u6', isCompactSummary: true, message: { content: 'This session is being continued' } }),
      line({ type: 'user', uuid: 'u7', message: { content: 'next <system-reminder>be brief</system-reminder>' } }),
      line({ type: 'user', uuid: 'u8', message: { content: '<task-notification>done</task-notification>' } })
    ].join('\n')
    expect(parseTranscript(jsonl)).toEqual([
      { kind: 'user', key: 'u1-0', text: 'add a test' },
      { kind: 'tool', key: 'a2-0', id: 't1', name: 'Edit', input: { file_path: 'x.ts' }, result: 'ok', isError: false },
      { kind: 'assistant', key: 'a4-0', text: 'Done.' },
      { kind: 'event', key: 'u4-0', text: '/clear' },
      { kind: 'event', key: 'u5-0', text: 'Interrupted' },
      { kind: 'event', key: 'u6', text: 'Conversation compacted' },
      { kind: 'user', key: 'u7-0', text: 'next' }
    ])
  })
})

describe('collectChanges', () => {
  it('keeps the content from before the first change of each file', () => {
    const result = (filePath: string, originalFile: string | null, extra: object = {}): string =>
      line({ type: 'user', toolUseResult: { filePath, originalFile }, ...extra })
    const jsonl = [
      result('a.ts', 'v1\r\nx'),
      result('b.ts', null),
      result('a.ts', 'v2'),
      result('c.ts', 'sub', { isSidechain: true })
    ].join('\n')
    const changes = collectChanges(jsonl)
    expect([...changes.keys()]).toEqual(['a.ts', 'b.ts'])
    expect(changes.get('a.ts')).toEqual({ before: 'v1\nx', order: 2 })
    expect(changes.get('b.ts')).toEqual({ before: null, order: 1 })
  })
})
