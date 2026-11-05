import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Op, Tally, Turn } from '../types'

const PANE = 'token-meter'
const turns = atom({ plugin: 'token-meter', key: 'turns' } as const, [], {
  shape: 'turns-1',
})
// answer tail -> the turn drawn under that answer
const lines = atom(
  { plugin: 'token-meter', key: 'lines' } as const,
  {},
  {
    shape: 'lines-2',
  },
)
const open = atom(
  { plugin: 'token-meter', key: 'open' } as const,
  null as string | null,
)

// Colours are the dataviz categorical slots, in slot order (adjacent pairs are
// colour-blind safe), one set that passes on both light and dark surfaces.
const ACTION: Record<string, { icon: string; short: string; color: string }> = {
  'Read files': { icon: '▤', short: 'Read', color: '#3987e5' },
  'Write code': { icon: '✎', short: 'Write', color: '#d95926' },
  Explore: { icon: '◎', short: 'Explore', color: '#199e70' },
  Shell: { icon: '❯', short: 'Shell', color: '#c98500' },
  Subagents: { icon: '◈', short: 'Agents', color: '#d55181' },
  Web: { icon: '⊕', short: 'Web', color: '#008300' },
  'Prompt + history': { icon: '❖', short: 'Prompt', color: '#9085e9' },
  Reply: { icon: '✦', short: 'Reply', color: '#e66767' },
  Other: { icon: '•', short: 'Other', color: 'subtle' },
}
const ORDER = Object.keys(ACTION)
const styleOf = (name: string) => ACTION[name] ?? ACTION.Other!

const TOOLS: [RegExp, string][] = [
  [/^(Read|NotebookRead)$/, 'Read files'],
  [/^(Grep|Glob|LS|LSP|ToolSearch)$/, 'Explore'],
  [/^(Edit|Write|MultiEdit|NotebookEdit)$/, 'Write code'],
  [/^(Bash|BashOutput|KillShell|Monitor)$/, 'Shell'],
  [/^(Agent|Task|SendMessage)$/, 'Subagents'],
  [/^(WebFetch|WebSearch)$|browser|chrome/i, 'Web'],
]
const actionOf = (tool: string) =>
  TOOLS.find(([re]) => re.test(tool))?.[1] ?? 'Other'

const clip = (text: string, n = 100) =>
  text.replace(/\s+/g, ' ').trim().slice(0, n)

// `Bash · npm test`, `Read · hooks/register.tsx`, `ccd_turn update_plan`
const labelOf = (tool: string, input: unknown) => {
  const args = (input ?? {}) as Record<string, unknown>
  const name = tool.startsWith('mcp__')
    ? tool.split('__').slice(1).join(' ')
    : tool
  const path = [args.file_path, args.notebook_path].find(
    v => typeof v === 'string',
  ) as string | undefined
  const arg = path
    ? path.split('/').slice(-3).join('/')
    : ['command', 'pattern', 'url', 'query', 'skill', 'description', 'prompt']
        .map(k => args[k])
        .find(v => typeof v === 'string')

  return clip(arg ? `${name} · ${arg}` : name)
}

// Slash commands and notifications arrive as tagged text.
const promptLabel = (prompt: string) =>
  clip(
    prompt
      .replace(/<command-name>(.*?)<\/command-name>.*/, '$1')
      .replace(/<task-notification>.*/, 'task notification')
      .replace(/<[^>]+>/g, ' '),
  ) || '(continuation)'

const ZERO: Tally = { fresh: 0, cached: 0, out: 0 }
const add = (a: Tally = ZERO, b: Tally): Tally => ({
  fresh: a.fresh + b.fresh,
  cached: a.cached + b.cached,
  out: a.out + b.out,
})
const scale = (t: Tally, k: number): Tally => ({
  fresh: t.fresh * k,
  cached: t.cached * k,
  out: t.out * k,
})
const spent = (t: Tally) => t.fresh + t.out

const fmt = (n: number) =>
  n >= 1e6
    ? `${(n / 1e6).toFixed(1)}M`
    : n >= 1e3
      ? `${(n / 1e3).toFixed(1)}k`
      : `${Math.round(n)}`
const cells = (f: number, w: number) => Math.round(Math.min(1, f) * w)
// ponytail: matched on the answer's tail; two turns ending in identical text share the newer line
const tailOf = (text: string) => text.replace(/\s+/g, ' ').trim().slice(-120)

const fiveHour = async ($: EngineInterface) =>
  (await $.session.usage()).rateLimits.find(l => l.kind === 'five_hour')
    ?.percentUsed

// The 5h window is account-wide: the turn's change times this session's share
// of what every local session spent meanwhile. A failed scan (share null)
// leaves the account's change, an upper bound; no share recorded, nothing.
const limitDelta = ({ limitStart: a, limitEnd: b, share }: Turn) =>
  a === undefined || b === undefined || share === undefined
    ? undefined
    : (b >= a ? b - a : b) * (share ?? 1)

const limitText = (t: Turn, delta: number) =>
  `5h ${t.share === null ? '≤ ' : ''}+${delta.toFixed(1)}%`

// Rough list-price weights (uncached input = 1), so a share of tokens is a
// share of what the limit counts. ponytail: one price for every model.
const weigh = (t: Tally) => t.fresh * 1.25 + t.cached * 0.1 + t.out * 5

const READ_MAX = 4 * 1024 * 1024

type Usage = {
  input_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  output_tokens?: number
}

// Another session may be mid-write: its last line can be cut short.
const parse = (line: string) => {
  try {
    return JSON.parse(line) as {
      timestamp?: string
      message?: { id?: string; usage?: Usage }
    }
  } catch {
    return undefined
  }
}

// A transcript is appended in time order, so it is read back from the end
// until `since`; a response is stored once per content block, counted once.
const spentIn = (text: string, since: number, until: number) => {
  const seen = new Set<string>()
  let total = 0
  const rows = text.split('\n')
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = parse(rows[i]!)
    const at = Date.parse(row?.timestamp ?? '')
    if (at < since) {
      break
    }

    const { id, usage: u } = row?.message ?? {}
    if (!id || !u || at > until || seen.has(id)) {
      continue
    }

    seen.add(id)
    total += weigh({
      fresh: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
      cached: u.cache_read_input_tokens ?? 0,
      out: u.output_tokens ?? 0,
    })
  }

  return total
}

// What the other sessions on this machine spent between `since` and `until`.
// ponytail: local transcripts only; use from another machine or claude.ai
// still lands in this session's share. A session's subagents are counted
// only while its own transcript moved too.
const othersSpent = async (
  $: EngineInterface,
  since: number,
  until: number,
) => {
  const home =
    (await $.env.get('CLAUDE_CONFIG_DIR')) ??
    `${await $.env.get('HOME')}/.claude`
  const root = `${home}/projects`
  const self = await $.session.id()
  const recent = async (dir: string) =>
    (await $.fs.list(dir)).filter(
      f => f.kind === 'file' && f.name.endsWith('.jsonl') && f.mtimeMs >= since,
    )
  // $.fs.read refuses a file over 4 MiB; a transcript's recent end is enough.
  // ponytail: assumes no session writes 4 MiB in one turn; `tail` is POSIX-only
  const spentInFile = async (path: string, size: number) =>
    spentIn(
      size <= READ_MAX
        ? await $.fs.read(path)
        : (await $.process.run(['tail', '-c', String(READ_MAX), path])).stdout,
      since,
      until,
    )

  let total = 0
  for (const project of await $.fs.list(root)) {
    if (project.kind !== 'dir') {
      continue
    }

    const dir = `${root}/${project.name}`
    for (const file of await recent(dir)) {
      const session = file.name.slice(0, -'.jsonl'.length)
      if (session === self) {
        continue
      }

      total += await spentInFile(`${dir}/${file.name}`, file.size)
      const agents = `${dir}/${session}/subagents`
      if (await $.fs.exists(agents)) {
        for (const agent of await recent(agents)) {
          total += await spentInFile(`${agents}/${agent.name}`, agent.size)
        }
      }
    }
  }

  return total
}

// The dataviz status steps: good, warning, serious, critical.
const statusOf = (percent: number) =>
  percent >= 90
    ? '#d03b3b'
    : percent >= 75
      ? '#ec835a'
      : percent >= 50
        ? '#fab219'
        : '#0ca30c'

// Older data may hold names from before the fold (Skills, MCP, raw tools).
const actionKey = (name: string) => (name in ACTION ? name : 'Other')

const fold = (byAction: Record<string, Tally>) => {
  const out: Record<string, Tally> = {}
  for (const [name, tally] of Object.entries(byAction)) {
    out[actionKey(name)] = add(out[actionKey(name)], tally)
  }

  return out
}

// The matching calls of these turns, the same call made twice summed, biggest first.
const opsOf = (match: (op: Op) => boolean, from: Turn[]) => {
  const merged = new Map<string, Op>()
  for (const op of from.flatMap(t => t.ops ?? []).filter(match)) {
    const key = `${op.action}\n${op.label}`
    merged.set(key, { ...op, tally: add(merged.get(key)?.tally, op.tally) })
  }

  return [...merged.values()].sort((a, b) => spent(b.tally) - spent(a.tally))
}

const ranked = (byAction: Record<string, Tally>) =>
  Object.entries(fold(byAction)).sort(([, a], [, b]) => spent(b) - spent(a))

// Splits `width` cells across actions by share, largest remainder first, in legend order.
const segments = (byAction: Record<string, Tally>, width: number) => {
  const folded = fold(byAction)
  const total = Object.values(folded).reduce((sum, t) => sum + spent(t), 0)
  if (!total) {
    return []
  }

  const parts = ORDER.filter(name => folded[name]).map(name => {
    const exact = (spent(folded[name]!) / total) * width

    return { name, cells: Math.floor(exact), rest: exact % 1 }
  })
  let left = width - parts.reduce((sum, p) => sum + p.cells, 0)
  for (const p of [...parts].sort((a, b) => b.rest - a.rest)) {
    if (left <= 0) {
      break
    }
    p.cells += 1
    left -= 1
  }

  return parts.filter(p => p.cells > 0)
}

const WINDOWS: Record<string, string> = { five_hour: '5h', seven_day: '7d' }

const resetsIn = (iso: string, now: number) => {
  const mins = Math.max(0, Math.round((Date.parse(iso) - now) / 60000))

  return mins >= 1440
    ? `${Math.floor(mins / 1440)}d ${Math.floor((mins % 1440) / 60)}h`
    : `${Math.floor(mins / 60)}h ${mins % 60}m`
}

export const register: Register = on => {
  // What each loop's last request asked to run: the next request's input is
  // mostly those tools' results, so it is charged to them.
  const lastOps = new Map<string, Omit<Op, 'tally'>[]>()

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tokens',
      description: 'Show token use by message and by action',
    })

    return next(e)
  })

  on('command.run', { command: 'tokens' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Tokens' })

    return { text: 'Token pane opened.' }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      const limitStart = await fiveHour($)
      const now = await $.clock.now()
      // The start reading is the last response's, so the turn's window opens
      // where the previous turn closed.
      await update($, turns, list =>
        [
          ...list,
          {
            id: e.turnId,
            prompt: e.text.replace(/\s+/g, ' ').trim().slice(0, 80),
            total: ZERO,
            subagents: ZERO,
            byAction: {},
            limitStart,
            since: list.at(-1)?.endedAt ?? now,
          },
        ].slice(-100),
      )
    }

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const res = yield* next(e)
    if (!res.usage) {
      return res
    }

    const loop = e.agentId ?? 'main'
    const cause = (e.index > 0 && lastOps.get(loop)) || [
      e.agentId
        ? {
            id: `${e.turnId}:start`,
            action: 'Subagents',
            label: 'Subagent task + its context',
          }
        : {
            id: `${e.turnId}:prompt`,
            action: 'Prompt + history',
            label: 'Your prompt + the conversation so far',
          },
    ]
    const made = res.toolUses.length
      ? res.toolUses.map((t, i) => ({
          id: `${e.turnId}:${e.index}:${i}`,
          action: actionOf(t.name),
          label: labelOf(t.name, t.input),
        }))
      : [
          {
            id: `${e.turnId}:reply`,
            action: 'Reply',
            label: e.agentId ? 'Subagent report' : 'Written reply',
          },
        ]
    lastOps.set(loop, made)

    const u = res.usage
    const input: Tally = {
      fresh: u.input_tokens + u.cache_creation_input_tokens,
      cached: u.cache_read_input_tokens,
      out: 0,
    }
    const output: Tally = { fresh: 0, cached: 0, out: u.output_tokens }
    const step = add(input, output)

    // Subagent steps land on the main turn running now (the newest).
    await update($, turns, list => {
      const last = list.at(-1)
      if (!last) {
        return list
      }

      const byAction = { ...last.byAction }
      const ops = [...(last.ops ?? [])]
      const charge = (refs: Omit<Op, 'tally'>[], tally: Tally) => {
        const share = scale(tally, 1 / refs.length)
        for (const ref of refs) {
          byAction[ref.action] = add(byAction[ref.action], share)
          const at = ops.findIndex(op => op.id === ref.id)
          const op = { ...ref, tally: add(ops[at]?.tally, share) }
          if (at < 0) {
            ops.push(op)
          } else {
            ops[at] = op
          }
        }
      }
      charge(cause, input)
      charge(made, output)

      return [
        ...list.slice(0, -1),
        {
          ...last,
          byAction,
          ops,
          total: add(last.total, step),
          subagents: e.agentId ? add(last.subagents, step) : last.subagents,
        },
      ]
    })

    return res
  })

  on('turn.complete', async ($, e, next) => {
    const res = await next(e)
    if (e.agentId !== undefined) {
      return res
    }

    const limitEnd = await fiveHour($)
    const endedAt = await $.clock.now()
    const current = (await read($, turns)).find(t => t.id === e.turnId)
    const others = current
      ? await othersSpent($, current.since ?? endedAt, endedAt).catch(
          () => undefined,
        )
      : undefined
    const mine = current ? weigh(current.total) : 0
    const share =
      others === undefined
        ? null
        : mine + others > 0
          ? mine / (mine + others)
          : 1
    const list = await update($, turns, all =>
      all.map(t =>
        t.id === e.turnId ? { ...t, limitEnd, endedAt, share } : t,
      ),
    )
    const turn = list.find(t => t.id === e.turnId)
    const key = tailOf(e.answer)
    if (turn && key) {
      const { ops: _, ...brief } = turn
      await update($, lines, all =>
        Object.fromEntries(
          Object.entries({ ...all, [key]: brief }).slice(-100),
        ),
      )
    }

    return res
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.props.isSummary) {
      return next(e)
    }

    const turn = (await read($, lines))[tailOf(e.props.text)]
    if (!turn) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    const delta = limitDelta(turn)

    return (
      <Box flexDirection="column">
        {await next(e)}
        <Box flexDirection="row" flexWrap="wrap" columnGap={2} marginTop={1}>
          <Text size="footnote" dimColor>
            ⛁ {fmt(spent(turn.total))} new · {fmt(turn.total.cached)} cached
          </Text>
          <Box flexDirection="row">
            {segments(turn.byAction, 12).map(s => (
              <Text size="footnote" color={styleOf(s.name).color}>
                {'█'.repeat(s.cells)}
              </Text>
            ))}
          </Box>
          {ranked(turn.byAction)
            .slice(0, 3)
            .map(([name, t]) => (
              <Box flexDirection="row" gap={1}>
                <Text size="footnote" color={styleOf(name).color}>
                  {styleOf(name).icon}
                </Text>
                <Text size="footnote" dimColor>
                  {styleOf(name).short} {fmt(spent(t))}
                </Text>
              </Box>
            ))}
          {delta !== undefined && turn.limitEnd !== undefined && (
            <Box flexDirection="row" gap={1}>
              <Text size="footnote" color={statusOf(turn.limitEnd)}>
                ▲
              </Text>
              <Text size="footnote" dimColor>
                {limitText(turn, delta)}
              </Text>
            </Box>
          )}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, turns)
    const expanded = await read($, open)
    const usage = await $.session.usage()
    const now = await $.clock.now()
    const cols = e.props.bodyColumns
    const width = Math.max(6, Math.min(16, cols - 24))

    const byAction: Record<string, Tally> = {}
    for (const t of list) {
      for (const [name, tally] of Object.entries(t.byAction)) {
        byAction[name] = add(byAction[name], tally)
      }
    }
    const total = list.reduce((sum, t) => add(sum, t.total), ZERO)
    const session5h = list.reduce(
      (sum, t) =>
        sum + (typeof t.share === 'number' ? (limitDelta(t) ?? 0) : 0),
      0,
    )
    const rows = ranked(byAction)
    const top = Math.max(1, ...rows.map(([, t]) => spent(t)))

    const heading = (text: string) => (
      <Text size="caption" weight="semibold" dimColor>
        {text}
      </Text>
    )
    const bar = (filled: number, color: string) => (
      <Box flexDirection="row">
        <Text color={color}>{'█'.repeat(filled)}</Text>
        <Text dimColor>{'░'.repeat(width - filled)}</Text>
      </Box>
    )
    const stack = (of: Record<string, Tally>, w: number) => (
      <Box flexDirection="row">
        {segments(of, w).map(s => (
          <Text color={styleOf(s.name).color}>{'█'.repeat(s.cells)}</Text>
        ))}
      </Box>
    )
    const toggle = (id: string) => () =>
      void update($, open, cur => (cur === id ? null : id))
    const details = (items: Op[]) => (
      <Box flexDirection="column" marginLeft={2} marginBottom={1}>
        {items.length === 0 && (
          <Text size="caption" dimColor>
            No per-call detail: recorded before calls were kept.
          </Text>
        )}
        {items.slice(0, 8).map(op => (
          <Box flexDirection="row" gap={1}>
            <Text color={styleOf(op.action).color}>
              {styleOf(op.action).icon}
            </Text>
            <Text tabular dimColor>
              {fmt(spent(op.tally)).padStart(6)}
            </Text>
            <Text size="caption">
              {op.label.slice(0, Math.max(16, cols - 14))}
            </Text>
          </Box>
        ))}
        {items.length > 8 && (
          <Text size="caption" dimColor>
            +{items.length - 8} more
          </Text>
        )}
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          {ORDER.map(name => (
            <Box flexDirection="row" gap={1}>
              <Text color={styleOf(name).color}>{styleOf(name).icon}</Text>
              <Text size="caption" dimColor>
                {styleOf(name).short}
              </Text>
            </Box>
          ))}
        </Box>

        {usage.rateLimits.length > 0 && (
          <Box flexDirection="column">
            {heading('LIMITS')}
            {usage.rateLimits.map(l => (
              <Box flexDirection="row" gap={1}>
                <Text mono>{(WINDOWS[l.kind] ?? l.kind).padEnd(9)}</Text>
                {bar(
                  cells(l.percentUsed / 100, width),
                  statusOf(l.percentUsed),
                )}
                <Text tabular>{`${l.percentUsed}%`.padStart(6)}</Text>
                {l.resetsAt && (
                  <Text size="caption" dimColor>
                    ↻ {resetsIn(l.resetsAt, now)}
                  </Text>
                )}
              </Box>
            ))}
          </Box>
        )}

        <Box flexDirection="column">
          {heading(
            `SESSION · ${fmt(spent(total))} new · ${fmt(total.cached)} cached${
              session5h > 0 ? ` · 5h +${session5h.toFixed(1)}%` : ''
            }`,
          )}
          {rows.length === 0 && <Text dimColor>Nothing measured yet.</Text>}
          {rows.map(([name, t]) => {
            const id = `action:${name}`

            return (
              <Box flexDirection="column">
                <Box flexDirection="row" gap={1}>
                  <Box width={12}>
                    <Button key={id} plain onPress={toggle(id)}>
                      <Text dimColor>{expanded === id ? '▾' : '▸'}</Text>{' '}
                      <Text color={styleOf(name).color}>
                        {styleOf(name).icon}
                      </Text>{' '}
                      {styleOf(name).short}
                    </Button>
                  </Box>
                  {bar(cells(spent(t) / top, width), styleOf(name).color)}
                  <Text tabular>{fmt(spent(t)).padStart(6)}</Text>
                </Box>
                {expanded === id &&
                  details(opsOf(op => actionKey(op.action) === name, list))}
              </Box>
            )
          })}
        </Box>

        {list.length > 0 && (
          <Box flexDirection="column">
            {heading('MESSAGES')}
            {list
              .slice(-10)
              .reverse()
              .map(t => {
                const id = `turn:${t.id}`

                return (
                  <Box flexDirection="column">
                    <Box flexDirection="row" gap={1}>
                      {stack(t.byAction, 6)}
                      <Text tabular>{fmt(spent(t.total)).padStart(6)}</Text>
                      <Button key={id} plain dimColor onPress={toggle(id)}>
                        {expanded === id ? '▾' : '▸'}{' '}
                        {promptLabel(t.prompt).slice(
                          0,
                          Math.max(12, cols - 18),
                        )}
                      </Button>
                    </Box>
                    {expanded === id && details(opsOf(() => true, [t]))}
                  </Box>
                )
              })}
          </Box>
        )}
      </Box>
    )
  })
}
