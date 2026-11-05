// fresh: uncached input + cache writes; cached: cache reads; out: generated
export type Tally = { fresh: number; cached: number; out: number }

// One tool call (or the prompt, or a reply) and the tokens charged to it.
export type Op = { id: string; action: string; label: string; tally: Tally }

export type Turn = {
  id: string
  prompt: string
  total: Tally
  subagents: Tally
  byAction: Record<string, Tally>
  // absent on turns recorded before ops were kept
  ops?: Op[]
  // the account-wide 5h reading at the turn's start and end
  limitStart?: number
  limitEnd?: number
  // the window the 5h change covers, in $.clock.now() ms
  since?: number
  endedAt?: number
  // this session's part (0 to 1) of what all local sessions spent in it;
  // null when the scan failed
  share?: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'token-meter': {
      turns: Shaped<Turn[]>
      lines: Shaped<Record<string, Turn>>
      // the expanded pane row: `action:<name>` or `turn:<id>`
      open: string | null
    }
  }
}
