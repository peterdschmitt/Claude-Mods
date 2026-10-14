import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AutoShip, Readiness, ShipAction, ShipFix, ShipItem, ShipLog, Shipped } from '../types'

// ── State ─────────────────────────────────────────────────────────────
const items = atom({ plugin: 'ship-queue', key: 'items' } as const, [])
const checkedAt = atom({ plugin: 'ship-queue', key: 'checkedAt' } as const, 0)
const isScanning = atom({ plugin: 'ship-queue', key: 'isScanning' } as const, false)
const confirming = atom({ plugin: 'ship-queue', key: 'confirming' } as const, '')
const shipping = atom({ plugin: 'ship-queue', key: 'shipping' } as const, '')
const asked = atom({ plugin: 'ship-queue', key: 'asked' } as const, [])
const shipped = atom({ plugin: 'ship-queue', key: 'shipped' } as const, [])
const autoShip = atom({ plugin: 'ship-queue', key: 'autoShip' } as const, [])
const log = atom({ plugin: 'ship-queue', key: 'log' } as const, [])
const errors = atom({ plugin: 'ship-queue', key: 'errors' } as const, [])

// ── Settings ──────────────────────────────────────────────────────────
const PANE = 'ship-queue'
const REFRESH_MS = 3 * 60 * 1000
const MAX_BRANCHES = 40
const OK = new Set(['success', 'skipped', 'neutral'])
const ORDER: Readiness[] = ['ready', 'waiting', 'blocked', 'wip']
const LABEL: Record<Readiness, string> = {
  ready: 'Ready to ship — needs your OK',
  waiting: 'Waiting on checks',
  blocked: 'Blocked',
  wip: 'In progress',
}
const COLOR: Record<Readiness, 'success' | 'warning' | 'error' | 'inactive'> = {
  ready: 'success',
  waiting: 'warning',
  blocked: 'error',
  wip: 'inactive',
}

type $T = EngineInterface

// ── Helpers ───────────────────────────────────────────────────────────
async function run($: $T, argv: string[], cwd?: string) {
  return $.process.run(argv, { cwd, timeoutMs: 90_000 })
}

async function gh<T>($: $T, path: string, extra: string[] = []): Promise<T> {
  const r = await run($, ['gh', 'api', ...extra, path])
  if (r.exitCode !== 0) {
    throw new Error(`${path}: ${(r.stderr || r.stdout).trim().slice(0, 160)}`)
  }
  return JSON.parse(r.stdout) as T
}

function ago(now: number, iso: string | number): string {
  const t = typeof iso === 'number' ? iso : Date.parse(iso)
  const m = Math.max(0, Math.round((now - t) / 60000))
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`
}

function day(iso: string): string {
  const d = new Date(iso)
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]
  return `${mon} ${String(d.getDate()).padStart(2, ' ')}`
}

function short(text: string, n = 70): string {
  return text.length > n ? `${text.slice(0, n - 1)}…` : text
}

function repoName(slug: string): string {
  return slug.split('/')[1] ?? slug
}

// ── GitHub shapes (only the fields read) ──────────────────────────────
type Pull = {
  number: number
  state: string
  draft: boolean
  title: string
  merged_at: string | null
  updated_at: string
  head: { ref: string; sha: string }
  base?: { ref: string }
}
type PullDetail = {
  mergeable: boolean | null
  mergeable_state: string
  additions: number
  deletions: number
  changed_files: number
}
type CheckRuns = { check_runs: { name: string; status: string; conclusion: string | null }[] }
type Branch = { name: string; commit: { sha: string } }
type Compare = { ahead_by: number; commits: { commit: { committer: { date: string } } }[] }

// ── Classification: the "system recommendation" ──────────────────────
export function classifyPull(
  pull: Pull,
  detail: PullDetail,
  checks: CheckRuns['check_runs'],
): { readiness: Readiness; reason: string } {
  const failed = checks.filter(c => c.status === 'completed' && !OK.has(c.conclusion ?? ''))
  const pending = checks.filter(c => c.status !== 'completed')
  const state = detail.mergeable_state

  const problems: string[] = []
  if (failed.length > 0) problems.push(`Failing: ${failed.map(c => c.name).join(', ')}`)
  if (state === 'dirty' || detail.mergeable === false) problems.push('Merge conflicts with main')
  if (problems.length > 0) {
    return {
      readiness: 'blocked',
      reason: (pull.draft ? ['Draft', ...problems] : problems).join(' · '),
    }
  }
  if (pull.draft) return { readiness: 'wip', reason: 'Draft PR — clean, ready to come out of draft' }
  if (pending.length > 0) {
    return { readiness: 'waiting', reason: `${pending.length} check(s) still running` }
  }
  if (state === 'clean' || state === 'has_hooks') {
    return {
      readiness: 'ready',
      reason: checks.length > 0 ? 'All checks passed, no conflicts' : 'No conflicts (no checks ran)',
    }
  }
  if (state === 'behind') return { readiness: 'waiting', reason: 'Behind main — needs an update' }
  if (state === 'blocked') return { readiness: 'blocked', reason: 'Branch protection: needs review or required check' }
  if (state === 'unstable') return { readiness: 'waiting', reason: 'Non-required checks unsettled' }
  return { readiness: 'waiting', reason: 'GitHub is still computing mergeability' }
}

function prFix(slug: string, pull: Pull, readiness: Readiness, reason: string): ShipFix | undefined {
  const ref = `PR #${pull.number} in ${slug} (branch \`${pull.head.ref}\`, "${pull.title}")`
  const tail = 'Push the fixes to the same branch. Do not merge — the Ship queue will ask me for approval once it is green. If fixing it needs a product decision, stop and ask me.'
  if (readiness === 'blocked') {
    return {
      label: 'Fix',
      prompt: `Unblock ${ref}. Status: ${reason}. Resolve merge conflicts by merging or rebasing on the base branch, and fix any failing checks (read their logs first). ${pull.draft ? 'If it is then complete, mark it ready for review. ' : ''}${tail}`,
    }
  }
  if (readiness === 'waiting' && reason.startsWith('Behind')) {
    return { label: 'Update', prompt: `Update ${ref} with the latest base branch and resolve any conflicts. ${tail}` }
  }
  if (readiness === 'wip' && pull.draft) {
    return {
      label: 'Finish',
      prompt: `Review draft ${ref}: check whether the work is complete against its FR ticket. If it is, mark it ready for review; if not, finish what is missing. ${tail}`,
    }
  }
  return undefined
}

// ── Scanning ──────────────────────────────────────────────────────────
async function findRepos($: $T): Promise<{ dir: string; slug: string }[]> {
  // The project Claude Code was opened in, plus any repos up to three levels below it.
  const dirs = new Set<string>()
  const top = await run($, ['git', 'rev-parse', '--show-toplevel'])
  if (top.exitCode === 0 && top.stdout.trim()) dirs.add(top.stdout.trim())
  const found = await run($, ['find', '.', '-maxdepth', '3', '-name', '.git', '-prune'])
  for (const p of found.stdout.split('\n').filter(Boolean)) dirs.add(p.replace(/\/\.git$/, ''))
  const out: { dir: string; slug: string }[] = []
  for (const dir of dirs) {
    const url = (await run($, ['git', 'remote', 'get-url', 'origin'], dir)).stdout.trim()
    const m = url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/)
    if (m?.[1]) out.push({ dir, slug: m[1] })
  }
  return out
}

async function scanLocal($: $T, dir: string, slug: string, defaultBranch: string): Promise<ShipItem[]> {
  const out: ShipItem[] = []
  const branch = (await run($, ['git', 'rev-parse', '--abbrev-ref', 'HEAD'], dir)).stdout.trim()
  const dirty = (await run($, ['git', 'status', '--porcelain'], dir)).stdout.split('\n').filter(Boolean)

  if (dirty.length > 0) {
    out.push({
      id: `local-dirty:${dir}`,
      repo: slug,
      where: 'local-uncommitted',
      title: `${dirty.length} uncommitted file(s) on ${branch}`,
      readiness: 'wip',
      reason: 'Not committed yet',
      detail: dir,
      fix: {
        label: 'Commit',
        prompt: `In ${dir} (${slug}) there are ${dirty.length} uncommitted file(s) on \`${branch}\`. Review them, commit the intended changes on a feature branch (not ${defaultBranch}) with a clear message, push it and open a PR. Do not merge. Ask me about anything that looks unintended.`,
      },
    })
  }

  let ahead = await run($, ['git', 'rev-list', '--count', '@{u}..HEAD'], dir)
  if (ahead.exitCode !== 0) ahead = await run($, ['git', 'rev-list', '--count', 'HEAD', '--not', '--remotes'], dir)
  const n = Number(ahead.stdout.trim()) || 0
  if (n > 0) {
    const onDefault = branch === defaultBranch
    out.push({
      id: `local-ahead:${dir}:${branch}`,
      repo: slug,
      where: 'local-unpushed',
      title: `${n} commit(s) on ${branch} not on GitHub`,
      readiness: onDefault ? 'blocked' : 'ready',
      reason: onDefault
        ? `Committed straight to ${defaultBranch}`
        : 'Not pushed — push to run checks and a preview',
      detail: dir,
      action: onDefault ? undefined : { kind: 'push-branch', dir, branch },
      fix: onDefault
        ? {
            label: 'Fix',
            prompt: `In ${dir} (${slug}) there are ${n} local commit(s) on ${defaultBranch} that are not on GitHub. Move them onto a new feature branch, reset local ${defaultBranch} to origin, push the branch and open a PR. Do not push to ${defaultBranch} and do not merge.`,
          }
        : undefined,
    })
  }
  return out
}

async function scanRemote($: $T, slug: string, now: number): Promise<{ items: ShipItem[]; defaultBranch: string; shipped: Shipped[] }> {
  const R = `repos/${slug}`
  const { default_branch: def } = await gh<{ default_branch: string }>($, R)
  const [pulls, branches] = await Promise.all([
    gh<Pull[]>($, `${R}/pulls?state=all&per_page=100&sort=updated&direction=desc`),
    gh<Branch[]>($, `${R}/branches?per_page=100`),
  ])
  const open = pulls.filter(p => p.state === 'open')
  const out: ShipItem[] = []

  await Promise.all(
    open.map(async pull => {
      const [detail, checks] = await Promise.all([
        gh<PullDetail>($, `${R}/pulls/${pull.number}`),
        gh<CheckRuns>($, `${R}/commits/${pull.head.sha}/check-runs?per_page=100`),
      ])
      const { readiness, reason } = classifyPull(pull, detail, checks.check_runs)
      const passed = checks.check_runs.filter(c => OK.has(c.conclusion ?? '')).length
      out.push({
        id: `pr:${slug}#${pull.number}`,
        repo: slug,
        where: 'pr',
        title: `#${pull.number} ${short(pull.title)}`,
        readiness,
        reason,
        detail: `${detail.changed_files} files +${detail.additions}/−${detail.deletions} · checks ${passed}/${checks.check_runs.length} · ${ago(now, pull.updated_at)}`,
        action:
          readiness === 'ready'
            ? { kind: 'merge-pr', repo: slug, number: pull.number, sha: pull.head.sha }
            : undefined,
        fix: prFix(slug, pull, readiness, reason),
        ref: pull.head.ref,
      })
    }),
  )

  const openRefs = new Set(open.map(p => p.head.ref))
  const candidates = branches
    .filter(b => b.name !== def && !openRefs.has(b.name))
    .filter(b => {
      const last = pulls.find(p => p.head.ref === b.name)
      // Its last PR closed or merged at this very commit: already decided.
      return !(last && last.head.sha === b.commit.sha)
    })
    .slice(0, MAX_BRANCHES)

  await Promise.all(
    candidates.map(async b => {
      const cmp = await gh<Compare>($, `${R}/compare/${def}...${encodeURIComponent(b.name)}`)
      if (cmp.ahead_by === 0) return
      const lastDate = cmp.commits.at(-1)?.commit.committer.date
      out.push({
        id: `branch:${slug}:${b.name}`,
        repo: slug,
        where: 'branch-no-pr',
        title: short(b.name),
        readiness: 'wip',
        reason: `${cmp.ahead_by} commit(s) pushed, no PR`,
        detail: lastDate ? `last commit ${ago(now, lastDate)}` : '',
        ref: b.name,
        fix: {
          label: 'Open PR',
          confirm: 'Open a PR and ship it to production as soon as all checks pass?',
          autoShip: { repo: slug, ref: b.name, at: now },
          prompt: `In ${slug}, branch \`${b.name}\` has ${cmp.ahead_by} commit(s) not on ${def} and no pull request. I have approved it for production. Bring it up to date with ${def} (resolve any conflicts), make sure it builds and its tests pass, push, then open a ready-for-review (not draft) PR against ${def} that satisfies the repo's PR checks (FR reference, evidence). Do not merge it yourself: the Ship queue merges it automatically the moment every check is green. If the branch looks abandoned, superseded or unfinished, do not open the PR — tell me instead.`,
        },
      })
    }),
  )
  const merged: Shipped[] = pulls
    .filter((p): p is Pull & { merged_at: string } => p.merged_at !== null && p.base?.ref === def)
    .map(p => ({ repo: slug, number: p.number, title: p.title, mergedAt: p.merged_at }))
  return { items: out, defaultBranch: def, shipped: merged }
}

let scanningNow = false

async function scan($: $T): Promise<void> {
  if (scanningNow) return
  scanningNow = true
  await update($, isScanning, () => true)
  const now = await $.clock.now()
  const found: ShipItem[] = []
  const live: Shipped[] = []
  const problems: string[] = []
  try {
    const repos = await findRepos($)
    if (repos.length === 0) problems.push('No GitHub repo in this folder — open Claude Code in a project folder.')
    const seen = new Set<string>()
    for (const { dir, slug } of repos) {
      let def = 'main'
      if (!seen.has(slug)) {
        seen.add(slug)
        try {
          const remote = await scanRemote($, slug, now)
          def = remote.defaultBranch
          found.push(...remote.items)
          live.push(...remote.shipped)
        } catch (err) {
          problems.push(`${slug}: ${String((err as Error).message ?? err)}`)
        }
      }
      try {
        found.push(...(await scanLocal($, dir, slug, def)))
      } catch (err) {
        problems.push(`${dir}: ${String((err as Error).message ?? err)}`)
      }
    }
  } catch (err) {
    problems.push(`Scan failed: ${String((err as Error)?.message ?? err)}`)
  } finally {
    const before = new Set((await read($, items)).filter(i => i.readiness === 'ready').map(i => i.id))
    const fresh = found.filter(i => i.readiness === 'ready' && !before.has(i.id))
    await update($, items, () => found)
    if (live.length > 0 || problems.length === 0) {
      await update($, shipped, () =>
        live.sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt)).slice(0, 15),
      )
    }
    await update($, errors, () => problems)
    await update($, checkedAt, () => now)
    await update($, isScanning, () => false)
    scanningNow = false

    const approved = await read($, autoShip)
    const toShip = found.filter(
      i => i.readiness === 'ready' && i.action?.kind === 'merge-pr' && approved.some(a => a.repo === i.repo && a.ref === i.ref),
    )
    if (toShip.length > 0) {
      await update($, autoShip, list => list.filter(a => !toShip.some(i => i.repo === a.repo && i.ref === a.ref)))
      $.clock.after(100, () => {
        void (async () => {
          for (const item of toShip) await ship($, item)
        })()
      })
    }
    const ready = found.filter(i => i.readiness === 'ready').length
    $.ui.status(ready > 0 ? `● ${ready} ready to ship` : undefined)
    if (fresh.length > 0 && before.size + fresh.length > 0) {
      $.ui.toast(`Ready to ship: ${fresh.map(i => i.title).join(', ')}`)
    }
  }
}

async function ship($: $T, item: ShipItem): Promise<void> {
  const action: ShipAction | undefined = item.action
  if (!action || (await read($, shipping))) return
  await update($, shipping, () => item.id)
  await update($, confirming, () => '')
  const at = await $.clock.now()
  let entry: ShipLog
  try {
    if (action.kind === 'merge-pr') {
      const res = await gh<{ merged: boolean; message: string }>(
        $,
        `repos/${action.repo}/pulls/${action.number}/merge`,
        ['-X', 'PUT', '-f', 'merge_method=squash', '-f', `sha=${action.sha}`],
      )
      entry = res.merged
        ? { at, text: `Merged ${repoName(action.repo)} #${action.number} — production deploy starting`, isError: false }
        : { at, text: `Not merged: ${res.message}`, isError: true }
    } else {
      const r = await run($, ['git', 'push', '-u', 'origin', action.branch], action.dir)
      entry =
        r.exitCode === 0
          ? { at, text: `Pushed ${action.branch} to GitHub`, isError: false }
          : { at, text: `Push failed: ${(r.stderr || r.stdout).trim().slice(0, 160)}`, isError: true }
    }
  } catch (err) {
    entry = { at, text: `Failed: ${String((err as Error).message ?? err)}`, isError: true }
  }
  await update($, log, list => [entry, ...list].slice(0, 8))
  await update($, shipping, () => '')
  $.ui.toast(entry.text)
  await scan($)
}

async function askClaude($: $T, item: ShipItem, fix: ShipFix): Promise<void> {
  await update($, asked, list => [...list.filter(id => id !== item.id), item.id])
  await update($, confirming, () => '')
  const auto = fix.autoShip
  if (auto) {
    await update($, autoShip, list => [...list.filter(a => !(a.repo === auto.repo && a.ref === auto.ref)), auto])
  }
  await $.prompt.submit({ text: `[Ship queue] ${fix.prompt}` })
  $.ui.toast(`Asked Claude: ${fix.label} — ${item.title}`)
}

// ── Hooks ─────────────────────────────────────────────────────────────
export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'ship',
      description: 'Open the ship queue: code written but not live yet',
    })
    void $.ui.open({ id: PANE, title: 'Ship queue' })
    $.clock.after(200, () => void scan($))
    $.clock.every(REFRESH_MS, () => void scan($))
    return next(e)
  })

  on('command.run', { command: 'ship' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Ship queue' })
    $.clock.after(50, () => void scan($))
    return { text: 'Ship queue opened.' }
  })

  // Claude may have committed, pushed or opened PRs during a turn.
  on('turn.complete', async ($, e, next) => {
    $.clock.after(1500, () => void scan($))
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, items)
    const when = await read($, checkedAt)
    const busy = await read($, isScanning)
    const pending = await read($, confirming)
    const inFlight = await read($, shipping)
    const handed = new Set(await read($, asked))
    const approved = await read($, autoShip)
    const recent = (await read($, log)).filter(l => l.isError)
    const live = await read($, shipped)
    const problems = await read($, errors)
    const now = await $.clock.now()
    const width = Math.max(30, (e.props.bodyColumns ?? 60) - 2)
    const sorted = ORDER.flatMap(r => list.filter(i => i.readiness === r))

    return (
      <Box flexDirection="column" width={width}>
        <Box flexDirection="row" gap={1}>
          {ORDER.map(r => (
            <Text color={COLOR[r]} bold={r === 'ready'}>
              ●{list.filter(i => i.readiness === r).length}
            </Text>
          ))}
          <Text dimColor>
            {' '}
            {busy ? 'checking…' : when ? ago(now, when) : 'not checked'}
          </Text>
          <Button key="refresh" label="↻" plain onPress={() => void scan($)} />
        </Box>

        {problems.map(p => (
          <Text color="error" wrap="truncate-end">
            ! {p}
          </Text>
        ))}
        {list.length === 0 && when > 0 && problems.length === 0 && (
          <Text color="success">Everything written is live.</Text>
        )}

        {sorted.map(item => {
          const r = item.readiness
          const isConfirming = item.action && pending === item.id && inFlight !== item.id
          return (
            <Box key={`row:${item.id}`} flexDirection="column" marginTop={1}>
              <Box flexDirection="row" gap={1}>
                <Box flexGrow={1} flexShrink={1}>
                  <Text color={COLOR[r]} bold={r === 'ready'} wrap="truncate-end">
                    ● {item.title}
                  </Text>
                </Box>
                {approved.some(a => a.repo === item.repo && a.ref === item.ref) && (
                  <Text color="success">auto-ship</Text>
                )}
                {inFlight === item.id && <Text color="warning">shipping…</Text>}
                {item.action && inFlight !== item.id && !isConfirming && (
                  <Button
                    key={`ship:${item.id}`}
                    label={item.action.kind === 'merge-pr' ? 'Ship' : 'Push'}
                    variant="primary"
                    onPress={() => update($, confirming, () => item.id)}
                  />
                )}
                {item.fix && !item.action && pending !== `fix:${item.id}` && (
                  <Button
                    key={`fix:${item.id}`}
                    label={handed.has(item.id) ? `${item.fix.label} (asked)` : item.fix.label}
                    onPress={() =>
                      item.fix!.confirm ? update($, confirming, () => `fix:${item.id}`) : askClaude($, item, item.fix!)
                    }
                  />
                )}
              </Box>
              <Text dimColor wrap="truncate-end">
                {'  '}
                {item.reason}
                {item.detail ? ` · ${item.detail}` : ''}
              </Text>
              {item.fix?.confirm && pending === `fix:${item.id}` && (
                <Box flexDirection="row" gap={1} paddingLeft={2} flexWrap="wrap">
                  <Text color="warning">{item.fix.confirm}</Text>
                  <Button
                    key={`fixconfirm:${item.id}`}
                    label="Confirm"
                    variant="primary"
                    onPress={() => void askClaude($, item, item.fix!)}
                  />
                  <Button key={`fixcancel:${item.id}`} label="Cancel" onPress={() => update($, confirming, () => '')} />
                </Box>
              )}
              {isConfirming && (
                <Box flexDirection="row" gap={1} paddingLeft={2}>
                  <Text color="warning">
                    {item.action!.kind === 'merge-pr' ? 'Merge to main → production?' : 'Push branch to GitHub?'}
                  </Text>
                  <Button
                    key={`confirm:${item.id}`}
                    label="Confirm"
                    variant="primary"
                    onPress={() => void ship($, item)}
                  />
                  <Button key={`cancel:${item.id}`} label="Cancel" onPress={() => update($, confirming, () => '')} />
                </Box>
              )}
            </Box>
          )
        })}

        {recent.slice(0, 2).map(l => (
          <Text color="error" wrap="truncate-end">
            {ago(now, l.at)} · {l.text}
          </Text>
        ))}

        {live.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Shipped</Text>
            {live.map(p => (
              <Text wrap="truncate-end">
                <Text color="success">✓</Text>
                <Text dimColor> {day(p.mergedAt)} </Text>#{p.number} {p.title}
              </Text>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
