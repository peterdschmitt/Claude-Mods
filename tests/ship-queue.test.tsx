import { describe, expect, mock, test } from 'claude-code/testing'

import { classifyPull } from '../hooks/register'

const pull = {
  number: 68,
  state: 'open',
  draft: false,
  title: 'Supervision controls',
  merged_at: null,
  updated_at: '2026-10-10T21:27:45Z',
  head: { ref: 'b', sha: 'abc' },
}
const clean = { mergeable: true, mergeable_state: 'clean', additions: 1, deletions: 0, changed_files: 1 }
const ok = [{ name: 'gate', status: 'completed', conclusion: 'success' }]

describe('the recommendation', () => {
  test('green when checks pass and it merges cleanly', async () => {
    expect(classifyPull(pull, clean, ok).readiness).toBe('ready')
  })
  test('red when a check fails', async () => {
    const bad = [...ok, { name: 'require-fr', status: 'completed', conclusion: 'failure' }]
    const r = classifyPull(pull, clean, bad)
    expect(r.readiness).toBe('blocked')
    expect(r.reason).toContain('require-fr')
  })
  test('red on merge conflicts', async () => {
    expect(classifyPull(pull, { ...clean, mergeable: false, mergeable_state: 'dirty' }, ok).readiness).toBe('blocked')
  })
  test('amber while checks run', async () => {
    const running = [{ name: 'gate', status: 'in_progress', conclusion: null }]
    expect(classifyPull(pull, clean, running).readiness).toBe('waiting')
  })
  test('grey for clean drafts', async () => {
    expect(classifyPull({ ...pull, draft: true }, clean, ok).readiness).toBe('wip')
  })
  test('red for drafts with conflicts and failing checks, naming both', async () => {
    const bad = [...ok, { name: 'require-fr', status: 'completed', conclusion: 'failure' }]
    const r = classifyPull({ ...pull, draft: true }, { ...clean, mergeable: false, mergeable_state: 'dirty' }, bad)
    expect(r.readiness).toBe('blocked')
    expect(r.reason).toBe('Draft · Failing: require-fr · Merge conflicts with main')
  })
})

test('the pane draws on terminal and desktop before the first check', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'ship-queue',
      surface,
      component: 'Pane',
      requestId: 'ship-queue',
      props: {
        title: 'Ship queue',
        isFocused: true,
        bodyColumns: 70,
        placement: 'dock',
        scroll: { offset: 0, bodyRows: 30 },
        view: {},
      },
    })
    expect(await ui.find({ key: 'refresh' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /not checked/ })).toBeDefined()
    await ui.unmount()
  }
})
