import { test, expect } from 'claude-code/testing'
import { parse } from './register'

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
