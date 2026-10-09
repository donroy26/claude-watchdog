import { atom, read, update } from 'claude-code'
import type { Register, EngineInterface } from 'claude-code'

import type { Info } from '../types'

type $ = EngineInterface
type F = { id: string; path: string; mtime: number; project: string }

const PANE = 'session-watchdog'
const watched = atom({ plugin: 'session-watchdog', key: 'watched' } as const, [] as string[])
const info = atom({ plugin: 'session-watchdog', key: 'info' } as const, {} as Record<string, Info>)
const addOpen = atom({ plugin: 'session-watchdog', key: 'addOpen' } as const, false)
const now = atom({ plugin: 'session-watchdog', key: 'now' } as const, 0)

const PILL = {
  working: { color: 'claude', label: '● Working' },
  waiting: { color: 'warning', label: '● Waiting on you' },
  idle: { color: 'inactive', label: '○ Idle' },
} as const

let timer: { cancel: () => void } | undefined

const open = ($: $) => $.ui.open({ id: PANE, title: 'Watching' })

// All transcripts, newest first. Only <projects>/<slug>/<id>.jsonl (subagent folders ignored).
async function scan($: $): Promise<F[]> {
  const home = (await $.env.get('USERPROFILE')) ?? ''
  const root = `${home}/.claude/projects`
  const out: F[] = []
  for (const d of await $.fs.list(root).catch(() => [])) {
    if (d.kind !== 'dir') continue
    for (const f of await $.fs.list(`${root}/${d.name}`).catch(() => [])) {
      if (f.kind === 'file' && f.name.endsWith('.jsonl'))
        out.push({ id: f.name.slice(0, -6), path: `${root}/${d.name}/${f.name}`, mtime: f.mtimeMs, project: d.name })
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

// Last ~2MB of the file: big enough to get past pasted images (base64 lines run hundreds of KB). fs.read rejects over 4 MiB, so prefer tail.
async function tail($: $, path: string): Promise<string[]> {
  // ponytail: Windows has no tail on PATH; Git for Windows ships one. Missing both → big files fail.
  let text = ''
  for (const bin of ['tail', 'C:/Program Files/Git/usr/bin/tail.exe']) {
    try {
      text = (await $.process.run([bin, '-c', '2000000', path])).stdout
      if (text) break
    } catch {}
  }
  if (!text) text = (await $.fs.read(path)).slice(-2_000_000)
  return text.split('\n').slice(1).filter(Boolean)
}

const textOf = (c: unknown): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map(b => (b?.type === 'text' ? b.text : '')).join(' ') : ''

export function parse(lines: string[], project: string) {
  let title = ''
  let first = ''
  let pendingTool = false // last message is a tool call with no result yet: likely a permission prompt
  const msgs: string[] = []
  for (const l of lines) {
    let j: any
    try { j = JSON.parse(l) } catch { continue }
    if (j.type === 'custom-title') title = j.customTitle
    else if (j.type === 'ai-title' && !title) title = j.aiTitle
    else if (j.type === 'user' || j.type === 'assistant') {
      const c = j.message?.content
      pendingTool = j.type === 'assistant' && Array.isArray(c) && c.some((b: any) => b?.type === 'tool_use')
      const t = textOf(c).replace(/\s+/g, ' ').trim()
      if (!t || t.startsWith('<')) continue
      if (!first && j.type === 'user') first = t
      msgs.push(`${j.type}: ${t.slice(0, 600)}`)
    }
  }
  const short = project.split('-').filter(Boolean).slice(-2).join('-')
  return { title: title || `${first.slice(0, 50) || '(untitled)'} [${short}]`, tail: msgs.slice(-6).join('\n'), pendingTool }
}

// "WAITING: did X" → { wait, text }. Anything unprefixed counts as idle.
export function splitStatus(reply: string) {
  const m = reply.trim().match(/^(WAITING|IDLE)\s*[:|-]\s*(.*)$/is)
  return m ? { wait: m[1]?.toUpperCase() === 'WAITING', text: (m[2] ?? '').trim() } : { wait: false, text: reply.trim() }
}

const WORKING_MS = 90_000

export function status(i: Info, now: number): 'working' | 'waiting' | 'idle' {
  if (now - i.mtime < WORKING_MS) return 'working'
  return i.pendingTool || i.wait ? 'waiting' : 'idle'
}

async function summarize($: $, f: F) {
  const prev = (await read($, info))[f.id]
  if (prev && prev.mtime === f.mtime && prev.wait !== undefined) return // cache hit: transcript unchanged (entries from before status pills re-run once)
  const { title, tail: t, pendingTool } = parse(await tail($, f.path).catch(() => []), f.project)
  if (!t) {
    // Nothing readable to summarize: keep the last summary rather than asking Haiku about nothing.
    const entry: Info = { ...(prev ?? { text: '(no recent text)', wait: false }), mtime: f.mtime, title, pendingTool }
    await update($, info, m => ({ ...m, [f.id]: entry }))
    return
  }
  const r = await $.model.complete({
    model: 'haiku',
    maxTokens: 70,
    prompt: `Start with WAITING: if this Claude Code session ended its turn asking the user a question or for a decision, otherwise IDLE:. Then ONE sentence (max 25 words) on what it is doing or last did. Transcript tail:\n${t}`,
  })
  const s = r.isAnswered ? splitStatus(r.text) : undefined
  const text = s?.text ?? (prev?.text && prev.text !== '(summary failed)' ? prev.text : '(summary failed)')
  const entry: Info = { mtime: f.mtime, title, text, wait: s?.wait ?? prev?.wait ?? false, pendingTool }
  await update($, info, m => ({ ...m, [f.id]: entry }))
  // ponytail: last-writer-wins on the shared store; two sessions summarizing the same change at once just both pay.
  await $.store.set('info', { ...(((await $.store.get('info')) as Record<string, Info>) ?? {}), [f.id]: entry })
}

// Pull the shared list + summaries other sessions wrote, so every pane shows the same thing.
async function sync($: $) {
  const ids = await $.store.get('watched')
  if (Array.isArray(ids)) await update($, watched, () => ids.map(String))
  const shared = (await $.store.get('info')) as Record<string, Info> | undefined
  if (shared) await update($, info, m => ({ ...m, ...shared }))
}

async function refresh($: $) {
  await sync($)
  const t = await $.clock.now()
  await update($, now, () => t) // redraws each tick so Working flips to Idle/Waiting once a session goes quiet
  const ids = await read($, watched)
  if (!ids.length) return
  for (const f of (await scan($)).filter(f => ids.includes(f.id))) await summarize($, f)
}

// Poll only while the pane is up, so sessions without it never spend Haiku calls.
function start($: $) {
  if (timer) return
  timer = $.clock.every(45_000, () => void refresh($))
  void refresh($)
}

async function toggle($: $, id: string, on: boolean) {
  await update($, watched, l => (on ? [...l.filter(x => x !== id), id] : l.filter(x => x !== id)))
  await $.store.set('watched', await read($, watched))
  if (on) await refresh($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'watch', description: 'Open the session-watchdog pane' })
    const saved = await $.store.get('watched')
    if (Array.isArray(saved)) await update($, watched, () => saved.map(String))
    return next(e)
  })

  on('command.run', { command: 'watch' }, async $ => {
    await open($)
    start($)
    return { text: 'Session watch pane opened.' }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) { timer?.cancel(); timer = undefined }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    start($) // a reload drops the timer while the pane stays up; drawing the pane restarts it
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const ids = await read($, watched)
    const infos = await read($, info)
    const isOpen = await read($, addOpen)
    const t = (await read($, now)) || (await $.clock.now())
    const cands = isOpen ? (await scan($)).filter(f => !ids.includes(f.id)).slice(0, 15) : []
    const titles = new Map<string, string>()
    for (const f of cands) titles.set(f.id, infos[f.id]?.title ?? parse(await tail($, f.path).catch(() => []), f.project).title)

    return (
      <Box flexDirection="column">
        <Text dimColor>
          session-watchdog plugin created at <Link href="https://donsbookshelf.com/" label="Don's Bookshelf" />
        </Text>
        <Text bold>Watching</Text>
        {ids.length === 0 && <Text dimColor>Nothing watched yet.</Text>}
        {ids.map(id => (
          <Box flexDirection="column">
            <Box>
              <Button key={`rm-${id}`} label="×" onPress={() => void toggle($, id, false)} />
              <Text bold> {infos[id]?.title ?? id.slice(0, 8)}</Text>
            </Box>
            {infos[id] && (() => {
              const p = PILL[status(infos[id], t)]
              return <Box><Text> </Text><Text bold color="inverseText" backgroundColor={p.color}> {p.label} </Text></Box>
            })()}
            <Text dimColor>  {infos[id]?.text ?? '(summarizing…)'}</Text>
          </Box>
        ))}
        <Button key="toggle-add" label={isOpen ? '- Hide sessions' : '+ Add sessions'} onPress={() => void update($, addOpen, v => !v)} />
        {cands.map(f => (
          <Box>
            <Button key={`add-${f.id}`} label="+" onPress={() => void toggle($, f.id, true)} />
            <Text> {titles.get(f.id)}</Text>
          </Box>
        ))}
      </Box>
    )
  })
}
