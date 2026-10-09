import { test, expect } from 'claude-code/testing'
import { parse, splitStatus, status } from './register'

test('parse: custom title wins, tail keeps recent text', () => {
  const lines = [
    JSON.stringify({ type: 'user', message: { content: 'hello there' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }),
    JSON.stringify({ type: 'custom-title', customTitle: 'My Title' }),
  ]
  const r = parse(lines, 'C--a-b')
  expect(r.title).toBe('My Title')
  expect(r.tail).toContain('assistant: hi')
  expect(parse(lines.slice(0, 1), 'C--a-b').title).toBe('hello there [a-b]')
})

test('status: recent change is working; pending tool or WAITING reply is waiting; else idle', () => {
  const now = 1_000_000
  const base = { title: 't', text: 'x' }
  expect(status({ ...base, mtime: now - 10_000 }, now)).toBe('working')
  expect(status({ ...base, mtime: 0, pendingTool: true }, now)).toBe('waiting')
  expect(status({ ...base, mtime: 0, ...splitStatus('WAITING: asked which option') }, now)).toBe('waiting')
  expect(status({ ...base, mtime: 0, ...splitStatus('IDLE: finished the fix') }, now)).toBe('idle')
  expect(splitStatus('IDLE: finished the fix').text).toBe('finished the fix')
  const tool = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } })
  expect(parse([tool], 'p').pendingTool).toBe(true)
  const result = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result' }] } })
  expect(parse([tool, result], 'p').pendingTool).toBe(false)
})
