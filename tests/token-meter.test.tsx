import { expect, test } from 'claude-code/testing'

const usage = (input: number, created: number, read: number, output: number) => ({
  input_tokens: input,
  cache_creation_input_tokens: created,
  cache_read_input_tokens: read,
  output_tokens: output,
  model: 'claude-opus-5-5',
})

test('a turn is charged to the actions that caused it', async ($, on) => {
  let percent = 10
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 200000 },
      rateLimits: [{ kind: 'five_hour', percentUsed: percent }],
    },
  }))
  on('clock.now', () => ({ value: 1000 }))
  on('session.id', () => ({ value: 'self' }))
  on('env.get', (_, e) => ({
    value: e.name === 'HOME' ? '/home/t' : undefined,
  }))
  on('fs.exists', () => ({ value: false }))
  const file = (name: string, mtimeMs: number) => ({
    name,
    kind: 'file' as const,
    size: 1,
    mtimeMs,
    isLink: false,
  })
  on('fs.list', (_, e) => ({
    value:
      e.path === '/home/t/.claude/projects'
        ? [{ ...file('proj', 0), kind: 'dir' as const }]
        : [file('self.jsonl', 2000), { ...file('other.jsonl', 2000), size: 5 * 1024 * 1024 }, file('old.jsonl', 10)],
  }))
  // Another session spent twice what this one did during the turn: a row from
  // before the turn, one response stored twice, a line cut mid-write. Its
  // transcript is over 4 MiB, so it is read through `tail`.
  const row = (at: string, id: string, output: number) =>
    JSON.stringify({
      timestamp: at,
      message: { id, usage: usage(0, 0, 0, output) },
    })
  on('fs.read', () => ({ value: '' }))
  on('process.run', (_, e) => ({
    value: {
      exitCode: 0,
      stdout: e.argv.at(-1)!.endsWith('/other.jsonl')
        ? [
            row('1970-01-01T00:00:00.500Z', 'early', 99999),
            row('1970-01-01T00:00:01.000Z', 'a', 3469),
            row('1970-01-01T00:00:01.000Z', 'a', 3469),
            '{"timest',
          ].join('\n')
        : '',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  const steps = [
    {
      index: 0,
      tools: [{ name: 'Read', input: { file_path: '/x/y/src/app.ts' } }],
      usage: usage(100, 2000, 0, 50),
    },
    {
      index: 0,
      agentId: 'a1',
      tools: [{ name: 'Grep', input: { pattern: 'TODO' } }],
      usage: usage(500, 0, 0, 40),
    },
    { index: 1, tools: [], usage: usage(10, 3000, 2100, 200) },
  ]
  on('turn.step', async function* (_, e) {
    const step = steps.find(s => s.index === e.index && s.agentId === e.agentId)!

    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: step.tools,
      stopReason: 'end_turn' as const,
      usage: step.usage,
    }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>{(e.props as { text: string }).text}</Text>
  })

  await $.turn.start({ turnId: 't1', text: 'fix the bug' })
  for (const s of steps) {
    const stream = $.turn.step({
      turnId: s.agentId ? 'sub' : 't1',
      index: s.index,
      model: 'opus',
      messageCount: 1,
      agentId: s.agentId,
    })
    for await (const _ of stream);
    await stream.result
  }
  percent = 11.5
  await $.turn.complete({
    turnId: 't1',
    answer: 'All done here.',
    durationMs: 1000,
    isAborted: false,
    reason: 'answer',
  })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const message = await $.ui.mount({
      plugin: 'token-meter',
      component: 'AssistantMessage',
      requestId: 'm1',
      surface,
      props: { text: 'All done here.', isFirstOfReply: true },
    })
    const text = async (re: RegExp) => (await message.find({ type: 'Text', text: re }))?.text
    expect(await text(/^All done here\.$/)).toBeDefined()
    expect(await text(/⛁/)).toBe('⛁ 5.9k new · 2.1k cached')
    expect(await text(/^Read /)).toBe('Read 3.1k')
    expect(await text(/^5h /)).toBe('5h +0.5%')
    await message.unmount()
  }

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const pane = await $.ui.mount({
      plugin: 'token-meter',
      component: 'Pane',
      requestId: 'token-meter',
      surface,
      props: {
        title: 'Tokens',
        isFocused: false,
        bodyColumns: 60,
        placement: 'dock',
        scroll: { offset: 0, bodyRows: 40 },
        view: {},
      },
    })
    expect(await pane.find({ type: 'Text', text: /^Explore\s*$/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^Prompt\s*$/ })).toBeDefined()
    expect((await pane.find({ key: 'turn:t1' }))?.text).toContain('fix the bug')

    // A message expands into its calls, biggest first.
    await pane.press({ key: 'turn:t1' })
    expect((await pane.find({ type: 'Text', text: /^Read · / }))?.text).toBe(
      'Read · y/src/app.ts',
    )
    expect(await pane.find({ type: 'Text', text: /^Your prompt/ })).toBeDefined()

    // An action expands into its calls across the session; one row open at a time.
    await pane.press({ key: 'action:Explore' })
    expect(await pane.find({ type: 'Text', text: /^Grep · TODO$/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^Read · / })).toBeUndefined()
    await pane.press({ key: 'action:Explore' })
    expect(await pane.find({ type: 'Text', text: /^Grep · / })).toBeUndefined()
    await pane.unmount()
  }
})

test('a failed scan shows the account change as an upper bound', async ($, on) => {
  let percent = 10
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 200000 },
      rateLimits: [{ kind: 'five_hour', percentUsed: percent }],
    },
  }))
  on('clock.now', () => ({ value: 1000 }))
  on('session.id', () => ({ value: 'self' }))
  on('env.get', () => ({ value: undefined }))
  on('fs.list', () => {
    throw new Error('no such directory')
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: usage(10, 0, 0, 10),
    }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>{(e.props as { text: string }).text}</Text>
  })

  await $.turn.start({ turnId: 't2', text: 'hi' })
  const stream = $.turn.step({ turnId: 't2', index: 0, model: 'opus', messageCount: 1 })
  for await (const _ of stream);
  await stream.result
  percent = 12
  await $.turn.complete({
    turnId: 't2',
    answer: 'Hello.',
    durationMs: 1,
    isAborted: false,
    reason: 'answer',
  })

  const message = await $.ui.mount({
    plugin: 'token-meter',
    component: 'AssistantMessage',
    requestId: 'm2',
    surface: 'desktop',
    props: { text: 'Hello.', isFirstOfReply: true },
  })
  expect((await message.find({ type: 'Text', text: /^5h / }))?.text).toBe('5h ≤ +2.0%')
  await message.unmount()
})
