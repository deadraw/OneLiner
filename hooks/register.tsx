import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Brief, CacheState, ContextState, DevState, GitState, LimitState, NextState } from '../types'

const CACHE_TTL_MIN = 60 // subscription default
const CACHE_TTL_OVERAGE_MIN = 5 // extra usage / reported 5m
const LIMIT_WARN_PCT = 90 // popup
// Strip colors. Limit: ≤70 green, 71–85 yellow, ≥86 red.
const LIMIT_YELLOW_PCT = 71
const LIMIT_RED_PCT = 86
// Cache time, as a share of the cache lifetime (60m → ≥30m green, 15–29m yellow, <15m red).
const CACHE_GREEN_SHARE = 0.5
const CACHE_RED_SHARE = 0.25
// Context window: ≤49 green, 50–70 yellow, ≥71 red (+ Compact).
const CONTEXT_YELLOW_PCT = 50
const CONTEXT_RED_PCT = 71
// Cache running out: offer Compact only from this context fill; below it, letting the cache rebuild is cheaper.
const CACHE_COMPACT_MIN_PCT = 30
// Model-switch hint on the cache segment: wide strips, warm cache, big context only.
const SWITCH_HINT_COLS = 110
const SWITCH_HINT_TOKENS = 100_000
// Cache read %: ≥50 green, 20–49 yellow, <20 red.
const READ_GREEN_PCT = 50
const READ_RED_PCT = 20
const BRIEF_GAP_HOURS = 6
const FAST_TICK_MS = 15_000 // only while the 5m cache applies
const TICK_MS = 60_000 // cache + limit countdowns, limit %, dev probe; git every 2nd tick
const BRIEF_PANE = 'oneliner-brief'
const LIMITS_PANE = 'oneliner-limits'
const COMMIT_MODEL = 'claude-haiku-4-5-20251001'
const HANDOFF_FILES = [
  '.claude/handoff.md', 'Current.md', 'CURRENT.md', 'HANDOFF.md',
  'handsoff/CURRENT.md', 'handoff/CURRENT.md', 'docs/handoff.md',
]

const git = atom({ plugin: 'oneliner', key: 'git' } as const, {
  isRepo: false, branch: '', changed: 0, ahead: 0, behind: 0, hasUpstream: false, conflicts: 0, operation: null,
})
const dev = atom({ plugin: 'oneliner', key: 'dev' } as const, { port: null, status: 'none', error: null })
const limit = atom({ plugin: 'oneliner', key: 'limit' } as const, {
  percent: null, resetsAt: null, warnedFor: null, isOverage: false,
  samples: [], forecastWarnedFor: null, weekPercent: null, weekResetsAt: null,
} as LimitState)
const cache = atom({ plugin: 'oneliner', key: 'cache' } as const, { lastTurnAt: null, readPercent: null, reportedTtl: null })
const context = atom({ plugin: 'oneliner', key: 'context' } as const, { percent: null, tokens: null, window: null } as ContextState)
const nextSteps = atom({ plugin: 'oneliner', key: 'next' } as const, {
  isOpen: false, fromAnswer: [], ai: [], aiGrades: [], optionGrades: [], aiStatus: 'idle', aiVia: null, answerTail: '', view: 'main', model: null,
} as NextState)
const remoteSeen = atom({ plugin: 'oneliner', key: 'remoteSeen' } as const, null as string | null)
const isWritingHandoff = atom({ plugin: 'oneliner', key: 'isWritingHandoff' } as const, false)
const demo = atom({ plugin: 'oneliner', key: 'demo' } as const, null as string | null)
const hidden = atom({ plugin: 'oneliner', key: 'hidden' } as const, [] as string[])
const stripMenu = atom({ plugin: 'oneliner', key: 'isStripMenuOpen' } as const, false)
const now = atom({ plugin: 'oneliner', key: 'now' } as const, 0)
const brief = atom({ plugin: 'oneliner', key: 'brief' } as const, null)
const isShipping = atom({ plugin: 'oneliner', key: 'isShipping' } as const, false)

type $ = EngineInterface
type Stored = { lastAt: number; prompts: string[]; cacheAt?: number }

const isWindows = (cwd: string) => /^[A-Za-z]:[\\/]/.test(cwd)
const storeKey = (cwd: string) => `brief:${cwd.toLowerCase()}`

// ── handoff parsing ─────────────────────────────────────────────

/**
 * Picks the "where we left off" lines out of a handoff/Current.md file.
 * Returns at most 3 short lines, most important first; [] hides the row.
 */
function pickOpenItems(markdown: string): string[] {
  const lines = markdown.split('\n')
  const isHeading = (l: string) => /^#{1,4}\s/.test(l)
  const wanted = /^#{1,4}\s*(?:exact\s+)?(?:next|open items|to ?do|pending|remaining|in progress)/i
  const topItem = /^(?:\d+[.)]|[-*•])\s+(?:\[ \]\s*)?(.+)$/ // unindented: sub-points stay out
  const out: string[] = []

  // 1. Items under a "Next / Exact Next Actions / Open items / TODO / Pending" heading.
  for (let i = 0; i < lines.length && out.length < 3; i++) {
    if (!wanted.test(lines[i])) continue
    for (let j = i + 1; j < lines.length && !isHeading(lines[j]) && out.length < 3; j++) {
      const m = topItem.exec(lines[j])
      if (m) out.push(m[1])
    }
  }
  // 2. Unchecked tasks anywhere: "- [ ] …".
  if (out.length === 0) {
    for (const l of lines) {
      const m = /^\s*[-*]\s+\[ \]\s+(.+)$/.exec(l)
      if (m && out.length < 3) out.push(m[1])
    }
  }
  // 3. Dated-log handoffs: the first "Next …" sentence.
  if (out.length === 0) {
    const m = /(?:^|\s)(Next\b[^.\n]{10,160})/m.exec(markdown)
    if (m) out.push(m[1])
  }
  return out.map(t => shortLabel(t, 90))
}

/** Reads the most recently edited handoff file of the project. */
async function newestHandoff($: $, cwd: string, files = HANDOFF_FILES): Promise<string | null> {
  let newest: { path: string; mtimeMs: number } | null = null
  for (const file of files) {
    const path = `${cwd}/${file}`
    try {
      if (!(await $.fs.exists(path))) continue
      const { mtimeMs } = await $.fs.stat(path)
      if (!newest || mtimeMs > newest.mtimeMs) newest = { path, mtimeMs }
    } catch {}
  }
  return newest?.path ?? null
}

async function readHandoff($: $, cwd: string): Promise<string[]> {
  const path = await newestHandoff($, cwd)
  if (!path) return []
  try { return pickOpenItems(String(await $.fs.read(path))) } catch { return [] }
}

/** The open work from a compaction summary: bullets under its "Pending Tasks" / "Next Step" section. */
function summaryItems(summary: string): string[] {
  const lines = summary.split('\n')
  const section = /^\s*(?:\d+\.\s*|#{1,4}\s*)?(?:pending tasks|next steps?|optional next step)\b/i
  const nextSection = /^(?:\d+\.\s+[A-Z][^\n]*:\s*|#{1,4}\s.*)$/
  const start = lines.findIndex(l => section.test(l))
  if (start < 0) return []
  const out: string[] = []
  for (const l of lines.slice(start + 1)) {
    if (nextSection.test(l)) break
    const m = /^\s{0,3}[-*•]\s+(.+)$/.exec(l)
    if (m) out.push(m[1].replace(/\*\*/g, '').replace(/:\s*$/, ''))
    if (out.length >= 3) break
  }
  return out.map(t => shortLabel(t, 90))
}

// ── /handoff: update YOUR handoff file from the conversation ────

const HANDOFF_BACKUP = '.claude/handoff-backup.md'

async function writeHandoff($: $, cwd: string) {
  if (await read($, isWritingHandoff)) return
  // Your own file (the mod's auto note doesn't count); none yet → a new HANDOFF.md.
  const existing = await newestHandoff($, cwd, HANDOFF_FILES.filter(f => f !== '.claude/handoff.md'))
  const path = existing ?? `${cwd}/HANDOFF.md`
  const name = path.slice(cwd.length + 1)
  const before = existing ? String(await $.fs.read(existing)) : ''
  await update($, isWritingHandoff, () => true)
  $.ui.toast(`Writing ${name} from the conversation…`)
  try {
    const ask = before
      ? `Update the project's handoff document so another session or AI agent can continue this work. Current ${name}:\n<<<\n${before}\n>>>\nRewrite it with everything this conversation changed: completed work, decisions, open issues and the exact next actions. Keep its structure, headings, tone and language; keep what is still true, remove what no longer is. Reply with the complete updated file only: no commentary, no code fences.`
      : 'Write a handoff document (Markdown) so another session or AI agent can continue this project. Sections: "## Current state", "## Decisions", "## Known issues", "## Exact next actions" (numbered). Concrete, current, no commentary, no code fences.'
    const r = await $.model.fork({ prompt: ask })
    if (!r.isAnswered) {
      return $.ui.toast(r.reason === 'nothing-to-fork'
        ? `Couldn't write ${name} yet: send one message in this session first, then try again`
        : `Couldn't write ${name}: the model gave no answer (${r.reason})`, { timeoutMs: 8000 })
    }
    if (!r.text.trim()) return $.ui.toast(`Couldn't write ${name}: the model gave no answer`)
    const after = r.text.trim().replace(/^```(?:markdown|md)?\n|\n```$/g, '') + '\n'
    const { added, removed } = lineDiff(before, after)
    let choice: string
    try {
      choice = await $.ui.ask(`${existing ? 'Update' : 'Create'} ${name}? (+${added} −${removed} lines)`, { header: 'Handoff', options: ['Write it', 'Cancel'] })
    } catch { return }
    if (choice !== 'Write it') return
    if (before) await $.fs.write(`${cwd}/${HANDOFF_BACKUP}`, before)
    await $.fs.write(path, after)
    $.ui.toast(`${name} ${existing ? 'updated' : 'created'} (+${added} −${removed})${before ? ` · previous copy in ${HANDOFF_BACKUP}` : ''}`, { timeoutMs: 8000 })
  } finally {
    await update($, isWritingHandoff, () => false)
  }
}

/** Lines only in `after` (added) and only in `before` (removed); good enough for a summary. */
function lineDiff(before: string, after: string): { added: number; removed: number } {
  const count = (text: string) => {
    const m = new Map<string, number>()
    for (const l of text.split('\n')) if (l.trim()) m.set(l, (m.get(l) ?? 0) + 1)
    return m
  }
  const a = count(before)
  const b = count(after)
  let added = 0
  let removed = 0
  for (const [l, n] of b) added += Math.max(0, n - (a.get(l) ?? 0))
  for (const [l, n] of a) removed += Math.max(0, n - (b.get(l) ?? 0))
  return { added, removed }
}

// ── git ─────────────────────────────────────────────────────────

async function runGit($: $, args: string[], timeoutMs = 15_000) {
  // GIT_TERMINAL_PROMPT=0: a remote that wants credentials fails fast instead of hanging.
  return $.process.run(['git', ...args], { timeoutMs, env: { GIT_TERMINAL_PROMPT: '0' } })
}

/** Downloads remote refs only (never touches your files), so "behind" / "diverged" stay true. */
async function fetchRemote($: $) {
  const g = await read($, git)
  if (!g.isRepo || !g.hasUpstream) return
  try {
    await runGit($, ['fetch', '--quiet', '--no-tags'], 30_000)
    await noticeRemotePush($, g.branch)
  } catch {}
}

/** After a fetch: new upstream commits you don't have yet → one popup naming who pushed them. */
async function noticeRemotePush($: $, branch: string) {
  const up = (await runGit($, ['rev-parse', '@{u}'])).stdout.trim()
  if (!up) return
  const seen = await read($, remoteSeen)
  await update($, remoteSeen, () => up)
  if (seen === null || seen === up) return // first look this session, or nothing new
  const isAlreadyHere = (await runGit($, ['merge-base', '--is-ancestor', up, 'HEAD'])).exitCode === 0
  if (isAlreadyHere) return // your own push (Ship, terminal, GitKraken)
  const log = await runGit($, ['log', '--format=%an', `${seen}..${up}`])
  const authors = log.stdout.split('\n').map(a => a.trim()).filter(Boolean)
  if (authors.length === 0) return
  const names = [...new Set(authors)].slice(0, 2).join(' and ')
  $.ui.toast(`${names} pushed ${authors.length} commit${authors.length === 1 ? '' : 's'} to ${branch} - pull before you continue`, { timeoutMs: 10_000 })
}

const GIT_OPERATIONS: [string, string][] = [
  ['rebase-merge', 'rebase'], ['rebase-apply', 'rebase'], ['MERGE_HEAD', 'merge'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert'],
]

/** Which multi-step git operation is stopped halfway, if any (its marker in the git dir). */
async function gitOperation($: $): Promise<string | null> {
  const r = await runGit($, ['rev-parse', '--absolute-git-dir'])
  if (r.exitCode !== 0) return null
  const dir = r.stdout.trim()
  for (const [marker, name] of GIT_OPERATIONS) {
    if (await $.fs.exists(`${dir}/${marker}`)) return name
  }
  return null
}

async function refreshGit($: $): Promise<GitState> {
  const next: GitState = { isRepo: false, branch: '', changed: 0, ahead: 0, behind: 0, hasUpstream: false, conflicts: 0, operation: null }
  try {
    const r = await runGit($, ['status', '--porcelain=v2', '--branch'])
    if (r.exitCode === 0) {
      next.isRepo = true
      for (const line of r.stdout.split('\n')) {
        if (line.startsWith('# branch.head ')) next.branch = line.slice(14).trim()
        else if (line.startsWith('# branch.upstream ')) next.hasUpstream = true
        else if (line.startsWith('# branch.ab ')) {
          const m = /\+(\d+) -(\d+)/.exec(line)
          if (m) { next.ahead = Number(m[1]); next.behind = Number(m[2]) }
        } else if (line.trim() && !line.startsWith('#')) {
          next.changed += 1
          if (line.startsWith('u ')) next.conflicts += 1
        }
      }
      next.operation = await gitOperation($)
    }
  } catch {}
  await update($, git, () => next)
  return next
}

async function commitMessage($: $): Promise<string> {
  const stat = await runGit($, ['status', '--short'])
  const diff = await runGit($, ['diff', 'HEAD', '--no-color'])
  const fallback = `Update ${stat.stdout.trim().split('\n').length} files`
  const r = await $.model.complete({
    model: COMMIT_MODEL,
    maxTokens: 120,
    timeoutMs: 20_000,
    system: 'You write git commit messages. Reply with the message only: one imperative subject line under 72 chars, optionally a blank line and up to 3 short bullet lines.',
    prompt: `Files:\n${stat.stdout.slice(0, 3000)}\n\nDiff (truncated):\n${diff.stdout.slice(0, 8000)}`,
  })
  return r.isAnswered && r.text.trim() ? r.text.trim() : fallback
}

async function ship($: $) {
  if (await read($, isShipping)) return
  const g = await refreshGit($)
  if (!g.isRepo) return $.ui.toast('Not a git repository')
  if (g.conflicts || g.operation) return $.ui.toast(`Finish the ${g.operation ?? 'merge'} first: ${g.conflicts} conflicted file${g.conflicts === 1 ? '' : 's'}`)
  if (g.changed === 0 && g.ahead === 0) return $.ui.toast(`Nothing to ship on ${g.branch}`)

  const options = g.changed > 0 ? ['Commit', 'Commit + push'] : ['Push']
  const question = g.changed > 0
    ? `Ship ${g.changed} changed file${g.changed === 1 ? '' : 's'} on ${g.branch}?`
    : `Push ${g.ahead} commit${g.ahead === 1 ? '' : 's'} on ${g.branch}?`
  let choice: string
  try {
    choice = await $.ui.ask(question, { header: 'Ship', options })
  } catch {
    return // dismissed
  }
  if (!options.includes(choice)) return

  await update($, isShipping, () => true)
  try {
    if (choice !== 'Push') {
      const buildError = await buildCheck($)
      if (buildError) return $.ui.toast(`Build failed, nothing committed: ${buildError}`, { timeoutMs: 10_000 })
      const message = await commitMessage($)
      // Everything except the mod's own auto-written handoff note.
      await runGit($, ['add', '-A', '--', '.', ':(exclude).claude/handoff.md'])
      const c = await runGit($, ['commit', '-m', message])
      if (c.exitCode !== 0) return $.ui.toast(`Commit failed: ${(c.stderr || c.stdout).trim().split('\n')[0]}`)
      $.ui.toast(`Committed: ${message.split('\n')[0]}`)
    }
    if (choice !== 'Commit') {
      const p = await runGit($, g.hasUpstream ? ['push'] : ['push', '-u', 'origin', g.branch], 120_000)
      if (p.exitCode === 0) {
        const up = (await runGit($, ['rev-parse', '@{u}'])).stdout.trim()
        if (up) await update($, remoteSeen, () => up)
      }
      $.ui.toast(p.exitCode === 0 ? `Pushed ${g.branch}` : `Push failed: ${p.stderr.trim().split('\n').pop()}`)
    }
  } finally {
    await update($, isShipping, () => false)
    await refreshGit($)
  }
}

const SHIP_BUILD = true // run the project's build before Ship commits
const ANDROID_JAVA_HOME = 'C:/Program Files/Android/Android Studio/jbr'

/** Runs the project's build; resolves the first error line, or null when it passed or there is none. */
async function buildCheck($: $): Promise<string | null> {
  if (!SHIP_BUILD) return null
  const cwd = await $.session.cwd()
  const wrap = (argv: string[]) => (isWindows(cwd) ? ['cmd', '/c', ...argv] : argv)
  let argv: string[] | null = null
  let env: Record<string, string> | undefined
  const pkg = await readJson($, `${cwd}/package.json`)
  if (pkg?.scripts?.build) argv = wrap(['npm', 'run', 'build'])
  else if (await $.fs.exists(`${cwd}/gradlew.bat`) || await $.fs.exists(`${cwd}/gradlew`)) {
    argv = isWindows(cwd) ? ['cmd', '/c', 'gradlew.bat', 'assembleDebug'] : ['./gradlew', 'assembleDebug']
    if (await $.fs.exists(ANDROID_JAVA_HOME)) env = { JAVA_HOME: ANDROID_JAVA_HOME }
  }
  if (!argv) return null
  $.ui.toast(`Building before commit: ${argv.slice(isWindows(cwd) ? 2 : 0).join(' ')}…`)
  try {
    const r = await $.process.run(argv, { timeoutMs: 600_000, env })
    if (r.exitCode === 0) return null
    const lines = `${r.stderr}\n${r.stdout}`.split('\n').map(l => l.trim()).filter(Boolean)
    return (lines.find(l => /error/i.test(l)) ?? lines[lines.length - 1] ?? `exit ${r.exitCode}`).slice(0, 140)
  } catch (err) {
    return `build did not finish (${String(err).slice(0, 80)})`
  }
}

// ── dev server ──────────────────────────────────────────────────

type LaunchConfig = { runtimeExecutable?: string; runtimeArgs?: string[]; port?: number }

async function readJson($: $, path: string): Promise<any> {
  try { return (await $.fs.exists(path)) ? JSON.parse(String(await $.fs.read(path))) : null } catch { return null }
}

async function detectDev($: $, cwd: string): Promise<{ port: number; argv: string[] } | null> {
  const launch = await readJson($, `${cwd}/.claude/launch.json`)
  const cfg: LaunchConfig | undefined = launch?.configurations?.find((c: LaunchConfig) => c.port)
  const wrap = (argv: string[]) => (isWindows(cwd) ? ['cmd', '/c', ...argv] : argv)
  if (cfg?.port) {
    return { port: cfg.port, argv: wrap([cfg.runtimeExecutable ?? 'npm', ...(cfg.runtimeArgs ?? ['run', 'dev'])]) }
  }
  const pkg = await readJson($, `${cwd}/package.json`)
  const script: string | undefined = pkg?.scripts?.dev
  if (!script) return null
  const port = /astro/.test(script) ? 4321 : /vite/.test(script) ? 5173 : 3000
  return { port, argv: wrap(['npm', 'run', 'dev']) }
}

async function probeDev($: $) {
  const d = await read($, dev)
  if (d.port === null || d.status === 'starting') return
  try {
    const r = await $.http.fetch(`http://localhost:${d.port}/`)
    const error = r.status >= 500 ? firstErrorLine(r.text) : null
    await update($, dev, cur => ({ ...cur, status: error ? 'error' : 'up', error }))
  } catch {
    await update($, dev, cur => ({ ...cur, status: 'down' }))
  }
}

function firstErrorLine(text: string): string {
  const plain = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
  const m = /([A-Za-z]*Error[^.]{0,100})/.exec(plain)
  return (m ? m[1] : plain).trim().slice(0, 100) || 'server error'
}

async function startDev($: $, cwd: string) {
  const found = await detectDev($, cwd)
  if (!found) return
  await update($, dev, cur => ({ ...cur, status: 'starting', error: null }))
  void (async () => {
    try {
      for await (const piece of $.process.spawn({ argv: found.argv })) {
        if ('text' in piece && /error/i.test(piece.text)) {
          await update($, dev, cur => ({ ...cur, error: piece.text.trim().split('\n')[0].slice(0, 100) }))
        }
        if ('text' in piece && /localhost:\d+|ready in|started server/i.test(piece.text)) {
          await update($, dev, cur => ({ ...cur, status: 'up' }))
        }
      }
    } catch {}
    await update($, dev, cur => ({ ...cur, status: 'down' }))
  })()
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const REBUILD_CHECK_MS = 2500

/** After a turn that edited files: tells whether the running dev server rebuilt cleanly. */
async function reportRebuild($: $) {
  const before = await read($, dev)
  if (before.port === null || (before.status !== 'up' && before.status !== 'error')) return
  await probeDev($)
  const d = await read($, dev)
  if (d.status === 'up') $.ui.toast(`Dev server rebuilt · localhost:${d.port} - reload if the page didn't update`)
  else if (d.status === 'error') $.ui.toast(`Build error after the edit: ${d.error ?? 'see the dev server'}`, { timeoutMs: 10_000 })
}

// ── limits + cache ──────────────────────────────────────────────

async function refreshLimit($: $) {
  try {
    const usage = await $.session.usage()
    const ctx = usage.context
    await update($, context, () => ({ percent: ctx.percent ?? null, tokens: ctx.tokens ?? null, window: ctx.window }))
    const five = usage.rateLimits.find(r => r.kind === 'five_hour') ?? usage.rateLimits[0]
    if (!five) return
    const isOverage = usage.rateLimits.some(r => (r.kind === 'five_hour' || r.kind === 'seven_day') && r.percentUsed >= 100)
    const week = usage.rateLimits.find(r => r.kind === 'seven_day')
    const at = await $.clock.now()
    const cur = await update($, limit, l => {
      const isSameWindow = l.resetsAt === (five.resetsAt ?? null)
      const samples = [...(isSameWindow ? l.samples ?? [] : []), { at, pct: five.percentUsed }]
        .filter(s => at - s.at <= FORECAST_WINDOW_MS)
        .slice(-90)
      return {
        ...l, percent: five.percentUsed, resetsAt: five.resetsAt ?? null, isOverage, samples,
        weekPercent: week?.percentUsed ?? null, weekResetsAt: week?.resetsAt ?? null,
      }
    })
    await recordHistory($, five.resetsAt ?? null, five.percentUsed, at)
    const fullAt = limitFullAt(cur)
    if (fullAt !== null && fullAt - at < FORECAST_WARN_MS && cur.forecastWarnedFor !== (cur.resetsAt ?? 'now')) {
      await update($, limit, l => ({ ...l, forecastWarnedFor: l.resetsAt ?? 'now' }))
      $.ui.toast(`At this pace the 5h limit fills ~${hhmmAt(fullAt)}${cur.resetsAt ? ` (resets ${hhmm(cur.resetsAt)})` : ''} - ship or write a handoff`, { timeoutMs: 10_000 })
    }
    if (five.percentUsed >= LIMIT_WARN_PCT && cur.warnedFor !== (five.resetsAt ?? 'now')) {
      await update($, limit, l => ({ ...l, warnedFor: five.resetsAt ?? 'now' }))
      $.ui.toast(`5h limit at ${Math.round(five.percentUsed)}%${five.resetsAt ? ` · resets ${hhmm(five.resetsAt)}` : ''} - ship or write a handoff now`, { timeoutMs: 10_000 })
    }
  } catch {}
}

const FORECAST_WINDOW_MS = 30 * 60_000 // pace = the last 30 min of readings
const FORECAST_MIN_SPAN_MS = 5 * 60_000 // need at least 5 min of readings
const FORECAST_WARN_MS = 30 * 60_000 // popup when full in under 30 min
const WEEK_SHOW_PCT = 70

/** When the 5h window fills at the recent pace (epoch ms), or null if it won't before it resets. */
function limitFullAt(l: LimitState): number | null {
  const s = l.samples ?? []
  if (s.length < 2 || l.percent === null || !l.resetsAt) return null
  const first = s[0]
  const last = s[s.length - 1]
  const span = last.at - first.at
  const rise = last.pct - first.pct
  if (span < FORECAST_MIN_SPAN_MS || rise <= 0) return null
  const fullAt = last.at + ((100 - last.pct) / rise) * span
  return fullAt < Date.parse(l.resetsAt) ? fullAt : null
}

// ── a prompt a limit stopped: offer to send it again ────────────

const LIMIT_ERROR = /hit your (?:session|weekly|monthly spend) limit|out of usage credits|requires usage credits|usage limit reached/i

/** Next model down when the current one needs credits: fable → opus → sonnet. */
function fallbackModel(current: string): string | null {
  if (/fable/i.test(current)) return 'opus'
  if (/opus/i.test(current)) return 'sonnet'
  return null
}

/** "resets 4pm" / "resets 6:20am" → the next such time, epoch ms. */
function parseResetTime(text: string, at: number): number | null {
  const m = /resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(text)
  if (!m) return null
  let hour = Number(m[1]) % 12
  if (m[3].toLowerCase() === 'pm') hour += 12
  const d = new Date(at)
  d.setHours(hour, Number(m[2] ?? 0), 0, 0)
  if (d.getTime() <= at) d.setDate(d.getDate() + 1)
  return d.getTime()
}

async function offerResend($: $, errorText: string, prompt: string) {
  const at = await $.clock.now()
  const l = await read($, limit)
  // A session/weekly limit is account-wide: another model doesn't help, waiting does.
  const isAccountWide = /session limit|weekly limit/i.test(errorText)
  const resetAt = parseResetTime(errorText, at) ?? (l.resetsAt ? Date.parse(l.resetsAt) : null)
  let current = ''
  try { current = await $.session.model() } catch {}
  const target = isAccountWide ? null : fallbackModel(current)
  const options: string[] = []
  if (target) options.push(`Switch to ${target} & resend`)
  if (resetAt && isAccountWide) options.push(`Resend at ${hhmmAt(resetAt + 60_000)}`)
  if (options.length === 0) return
  let choice: string
  try {
    choice = await $.ui.ask(`That prompt didn't run (${errorText.split(/[.·]/)[0].trim()}). Send it again?`, { header: 'Resend', options: [...options, 'Leave it'] })
  } catch { return }
  if (target && choice === `Switch to ${target} & resend`) {
    try {
      await $.command.run({ command: 'model', args: target })
      await $.prompt.submit({ text: prompt })
    } catch {
      $.ui.toast(`Couldn't switch to ${target}. Your prompt is back in the box.`, { timeoutMs: 8000 })
      void $.prompt.fill({ text: prompt, mode: 'replace' })
    }
  } else if (resetAt && choice.startsWith('Resend at')) {
    $.clock.after(Math.max(0, resetAt + 60_000 - at), () => void $.prompt.submit({ text: prompt }))
    $.ui.toast(`Will resend at ${hhmmAt(resetAt + 60_000)}. Keep this session open until then.`, { timeoutMs: 8000 })
  }
}

// ── limit history (for /limits) ─────────────────────────────────

const HISTORY_KEY = 'limit:history' // one per account: every session adds to the same window
const WINDOW_MS = 5 * 60 * 60_000
type History = { resetsAt: string | null; points: { at: number; pct: number }[] }

async function recordHistory($: $, resetsAt: string | null, pct: number, at: number) {
  try {
    const h = ((await $.store.get(HISTORY_KEY)) as History | undefined) ?? { resetsAt, points: [] }
    const points = h.resetsAt === resetsAt ? h.points : []
    const last = points[points.length - 1]
    if (last && last.pct === pct && at - last.at < 5 * 60_000) return // unchanged: one point per 5 min is plenty
    await $.store.set(HISTORY_KEY, { resetsAt, points: [...points, { at, pct }].slice(-400) })
  } catch {}
}

const BLOCKS = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

/** One string per chart row (top first): each column filled up to its value, in eighths. */
function barRows(values: (number | null)[], rows: number): string[] {
  const out: string[] = []
  for (let r = rows - 1; r >= 0; r--) {
    out.push(values.map(v => {
      if (v === null) return ' '
      const eighths = Math.round((Math.min(100, Math.max(0, v)) / 100) * rows * 8) - r * 8
      return BLOCKS[Math.max(0, Math.min(8, eighths))]
    }).join(''))
  }
  return out
}

const hhmmAt = (ms: number) => hhmm(new Date(ms).toISOString())

const hhmm = (iso: string) => {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Overage forces 5m; otherwise trust what the engine reported; else the 1h subscription default. */
function cacheTtl(c: CacheState, l: LimitState): number {
  return l.isOverage ? CACHE_TTL_OVERAGE_MIN : c.reportedTtl ?? CACHE_TTL_MIN
}

function cacheMinutesLeft(c: CacheState, ttl: number, at: number): number | null {
  if (c.lastTurnAt === null) return null
  return Math.max(0, Math.ceil(ttl - (at - c.lastTurnAt) / 60_000))
}

/** Seconds left, rounded up to the fast tick, for the last 2 minutes of a short cache. */
function cacheSecondsLeft(c: CacheState, ttl: number, at: number): number | null {
  if (c.lastTurnAt === null) return null
  const secs = Math.max(0, ttl * 60 - (at - c.lastTurnAt) / 1000)
  return Math.ceil(secs / 15) * 15
}

/** The short form of a strip label: "main · 4Δ · 2↑" → "main 4Δ 2↑", "5h 78% · full ~03:03" → "5h 78% →03:03". */
function compactSeg<T extends { text: string }>(s: T): T {
  if (s.text.startsWith('cache reset')) return { ...s, text: 'cache reset' }
  const text = s.text
    .replace(/ · /g, ' ')
    .replace(/ full ~/, ' →')
    .replace(/^cache /, '⏱')
    .replace(/^(ctx \d+%) \d+k$/, '$1')
  return { ...s, text }
}

function secsLeftExact(c: CacheState, ttl: number, at: number): number | null {
  return c.lastTurnAt === null ? null : Math.max(0, ttl * 60 - (at - c.lastTurnAt) / 1000)
}

/** A setting change emptied the conversation cache: the next message re-sends everything. */
async function markCacheReset($: $, reason: string) {
  const c = await read($, cache)
  if (c.lastTurnAt === null) return // nothing cached yet
  await update($, cache, x => ({ ...x, resetReason: reason }))
  let tokens = 0
  try { tokens = (await $.session.usage()).context.tokens ?? 0 } catch {}
  $.ui.toast(`${reason[0].toUpperCase() + reason.slice(1)} changed: the next message re-sends ${tokens ? `~${Math.round(tokens / 1000)}k tokens` : 'the whole conversation'} without cache`, { timeoutMs: 8000 })
}

const ttlMinutes = (ttl: '5m' | '1h') => (ttl === '5m' ? 5 : 60)

async function seedCache($: $, cwd: string, at: number) {
  const c0 = await read($, cache)
  if (c0.lastTurnAt !== null) return // kept across a hot reload, or set by classic.SessionStart
  const stored = (await $.store.get(storeKey(cwd))) as Stored | undefined
  if (stored?.cacheAt) return void (await update($, cache, () => ({ ...c0, lastTurnAt: stored.cacheAt! })))
  try {
    // Nothing saved yet but a conversation is live: a mod loads as a turn ends, so the cache was just written.
    if (((await $.session.usage()).context.tokens ?? 0) > 0) await update($, cache, c => ({ ...c, lastTurnAt: at }))
  } catch {}
}

/** Share of the cache lifetime left, 0–1; 0 when cold or unknown. */
function cacheShare(c: CacheState, l: LimitState, at: number): number {
  const ttl = cacheTtl(c, l)
  return ((secsLeftExact(c, ttl, at) ?? 0) / 60) / ttl
}

// ── /strip demo: sample values for screenshots ──────────────────

const DEMO_LEVELS = ['green', 'yellow', 'red', 'next', 'ideas'] as const
// /strip demo play: the story a short GIF tells, looped. [level, how long it stays, ms]
const DEMO_PLAY: [(typeof DEMO_LEVELS)[number], number][] = [
  ['green', 2500], ['yellow', 2500], ['red', 2500], ['next', 2500], ['ideas', 3500],
]
type DemoLevel = (typeof DEMO_LEVELS)[number]

/** Sample state for one demo level, drawn by the real strip code. Times are relative to now. */
function demoFixture(level: DemoLevel, at: number, n: NextState): {
  g: GitState; d: DevState; l: LimitState; c: CacheState; ctx: ContextState; n: NextState
} {
  const min = 60_000
  const iso = (ms: number) => new Date(ms).toISOString()
  const base = level === 'next' || level === 'ideas' ? 'green' : level
  const g: GitState = {
    green: { isRepo: true, branch: 'main', changed: 0, ahead: 0, behind: 0, hasUpstream: true, conflicts: 0, operation: null },
    yellow: { isRepo: true, branch: 'main', changed: 4, ahead: 2, behind: 0, hasUpstream: true, conflicts: 0, operation: null },
    red: { isRepo: true, branch: 'main', changed: 5, ahead: 1, behind: 2, hasUpstream: true, conflicts: 3, operation: 'merge' },
  }[base]
  const d: DevState = {
    green: { port: 4321, status: 'up', error: null },
    yellow: { port: 4321, status: 'up', error: null },
    red: { port: 4321, status: 'error', error: 'Expected "}" but found end of file' },
  }[base] as DevState
  const limitBase = { warnedFor: null, isOverage: false, forecastWarnedFor: null, weekResetsAt: iso(at + 3 * 24 * 60 * min) }
  const l: LimitState = {
    green: { ...limitBase, percent: 34, resetsAt: iso(at + 190 * min), samples: [{ at: at - 30 * min, pct: 31 }, { at, pct: 34 }], weekPercent: 22 },
    // rising 12% in 20 min from 78% → fills before the reset in 2h
    yellow: { ...limitBase, percent: 78, resetsAt: iso(at + 125 * min), samples: [{ at: at - 20 * min, pct: 66 }, { at, pct: 78 }], weekPercent: 74 },
    red: { ...limitBase, percent: 93, resetsAt: iso(at + 23 * min), samples: [{ at: at - 20 * min, pct: 92 }, { at, pct: 93 }], weekPercent: 88 },
  }[base]
  const c: CacheState = {
    green: { lastTurnAt: at - 6 * min, readPercent: 98, reportedTtl: 60, resetReason: null },
    yellow: { lastTurnAt: at - 38 * min, readPercent: 41, reportedTtl: 60, resetReason: null },
    red: { lastTurnAt: at - 52 * min, readPercent: 12, reportedTtl: 60, resetReason: null },
  }[base]
  const ctx: ContextState = {
    green: { percent: 28, tokens: 56_000, window: 200_000 },
    yellow: { percent: 62, tokens: 124_000, window: 200_000 },
    red: { percent: 84, tokens: 168_000, window: 200_000 },
  }[base]
  const sampleNext: NextState = {
    ...n,
    isOpen: level === 'next' || level === 'ideas',
    view: level === 'ideas' ? 'suggest' : 'main',
    fromAnswer: [
      '**Add dark mode?** I recommend it: the design tokens are already in place.',
      'Let me add and rename habits',
      'Commit the habit tracker',
    ],
    optionGrades: [3, 0, 0],
    ai: ['Show weekly streaks on the home screen', 'Polish the empty state', 'Commit and push the habit tracker'],
    aiGrades: [3, 2, 1],
    aiStatus: 'done', // never 'idle' in demo: the ✦ row must not call a model
    aiVia: 'cache',
    model: 'claude-opus-5-5',
  }
  return { g, d, l, c, ctx, n: sampleNext }
}

// ── /strip: which parts show ────────────────────────────────────

/** Strip parts in strip order: id, label in the panel, words /strip <word> accepts. */
const STRIP_PARTS: { id: string; label: string; words: string[] }[] = [
  { id: 'git', label: 'git', words: ['git', 'ship'] },
  { id: 'dev', label: 'dev server', words: ['dev', 'server', 'devserver'] },
  { id: 'limit', label: '5h limit', words: ['limit', '5h', 'limits'] },
  { id: 'context', label: 'context', words: ['context', 'ctx'] },
  { id: 'cache', label: 'cache', words: ['cache', 'clock'] },
  { id: 'next', label: 'next', words: ['next', 'ideas', 'suggestions'] },
]
const HIDDEN_KEY = 'strip:hidden' // one $.store value: the same for every project and session

async function setHidden($: $, list: string[]) {
  await update($, hidden, () => list)
  await $.store.set(HIDDEN_KEY, list)
}

async function toggleHidden($: $, id: string): Promise<boolean> {
  const cur = await read($, hidden)
  const isNowHidden = !cur.includes(id)
  await setHidden($, isNowHidden ? [...cur, id] : cur.filter(x => x !== id))
  return isNowHidden
}

// ── next steps ──────────────────────────────────────────────────

const NEXT_MAX = 4
// Grades: 3 gold (best next move), 2 silver (useful), 1 bronze (low value), 0 ungraded.
const GRADE_COLORS: Record<number, string> = { 3: '#F7D35C', 2: '#C4D3E6', 1: '#EE9D5B' }
// 'text': whole label colored (the small › is what you click). 'dot': clickable label + a colored ●.
const GRADE_STYLE = 'text' as 'text' | 'dot'
// Screen 2 title gradient, left → right.
const IDEAS_FROM = '#6a6ae4'
const CREDIT_COLOR = '#4a4a4a' // "v1.0.1 © deadraw" in the next list: darker than dim text, there if you look
const IDEAS_TO ='#e34a9e'

/** The color `t` (0–1) of the way from one #rrggbb to another. */
function mixHex(from: string, to: string, t: number): string {
  const a = from.match(/[0-9a-f]{2}/gi)!.map(h => parseInt(h, 16))
  const b = to.match(/[0-9a-f]{2}/gi)!.map(h => parseInt(h, 16))
  return '#' + a.map((v, i) => Math.round(v + (b[i] - v) * t).toString(16).padStart(2, '0')).join('')
}
const SUGGEST_PROMPT = [
  'Suggest 3 things the user could ask you to do next, written the way the user would say them.',
  'Each one: short (under 60 characters), plain everyday words, about the result they would see, not the code.',
  'Never use function names, file paths, variable names, commands or jargon.',
  'Make the 3 different kinds: one that builds on or extends what was just made, one that improves how it looks or feels, one that wraps up (try it out, commit it, or note the progress).',
  'Examples of the right style: "Let me add and rename habits", "Polish the design", "Commit the habit tracker".',
].join(' ')

const GRADE_RULES = [
  'Grade each on its own merit, judged by how much it moves the user\'s current goal forward right now:',
  '3 = clearly the best next move, 2 = useful, 1 = fine but low value.',
  'Grades are absolute: several can share a grade, and none has to be 3.',
].join(' ')

/** Free guess for Claude's own options: the one it explicitly recommends is gold. */
const recommendedGrade = (option: string) =>
  /\brecommend|\(recommended\)|I'd (?:suggest|go with|pick)/i.test(option) ? 3 : 0

/** Tier 2: the options Claude offered at the end of its own answer. Costs nothing. */
/** Markdown off, whitespace collapsed: the text a pick puts in the prompt. */
const cleanMd = (t: string) => t.replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim()

/** Drops ★ Insight blocks (explanations, not choices): from the ★ line to the next ─── rule. */
function dropInsights(lines: string[]): string[] {
  const out: string[] = []
  let isInside = false
  for (const line of lines) {
    if (!isInside && line.includes('★ Insight')) { isInside = true; continue }
    if (isInside) { if (/─{10,}/.test(line)) isInside = false; continue }
    out.push(line)
  }
  return out
}

/** A short label for a long option: its bold title, else its first clause; ≤ 60 chars, cut at a word. */
function shortLabel(raw: string, max = 60): string {
  // Cut at the first clause break; a question keeps its "?".
  const firstClause = (text: string) =>
    text.split(/(?<=\?)\s|:\s|\s[—–-]\s|\.\s|,\s|\s(?:so|because|which)\s|\s\(/)[0]
  const bold = /^\s*\*\*(.+?)\*\*\s*(.*)$/.exec(raw)
  let t: string
  if (bold) {
    const head = cleanMd(bold[1]).replace(/[:.]$/, '')
    // A terse title ("Tier 3") gets the start of its sentence: "Tier 3: auto-pick by cache state".
    t = head.length < 20 && !head.endsWith('?') && bold[2] ? `${head}: ${firstClause(cleanMd(bold[2]))}` : head
  } else {
    t = firstClause(cleanMd(raw))
  }
  t = cleanMd(t).replace(/[:.,]$/, '')
  if (t.length <= max) return t
  const words = t.slice(0, max - 1)
  return `${words.slice(0, words.lastIndexOf(' ') > 20 ? words.lastIndexOf(' ') : words.length)}…`
}

function extractNextSteps(answer: string): string[] {
  const clean = (t: string) => t.trim()
  const lines = dropInsights(answer.trim().split('\n')).slice(-40)
  const item = /^\s*(?:\d+[.)]|[-*•])\s+(.+)$/
  const lead = /\b(next|options?|want me|should I|choose|pick|decide|decisions?|you can|I can|before I|which)\b/i

  // 1. The last list in the answer, if it sits near the end and the lines above it introduce choices.
  let end = -1
  for (let i = lines.length - 1; i >= 0; i--) if (item.test(lines[i])) { end = i; break }
  if (end >= 0 && end >= lines.length - 6) {
    let start = end
    while (start > 0 && (item.test(lines[start - 1]) || /^\s{2,}\S/.test(lines[start - 1]))) start--
    if (lead.test(lines.slice(Math.max(0, start - 3), start).join(' '))) {
      const items = lines.slice(start, end + 1)
        .map(l => item.exec(l)?.[1]).filter((x): x is string => !!x).map(clean)
      if (items.length) return items.slice(0, NEXT_MAX).map(x => x.slice(0, 300))
    }
  }

  // 2. Offers in the closing lines: "I can add X", "Want me to Y?"
  const offers: string[] = []
  const re = /\b(?:I can(?: also)?|I could|Want me to|Should I|If you want,? I can|Tell me and I(?:'ll| will))\s+([^.?!]{6,140})[.?!]/gi
  for (const m of lines.slice(-8).join(' ').matchAll(re)) {
    const t = cleanMd(m[1])
    offers.push(t[0].toUpperCase() + t.slice(1))
  }
  return [...new Set(offers)].slice(0, NEXT_MAX)
}

type Graded = { ideas: string[]; ideaGrades: number[]; optionGrades: Map<number, number> }

/** Reads "IDEA <grade> <text>" and "OPTION <n> <grade>" lines; a bare line counts as an ungraded idea. */
function parseGraded(text: string): Graded {
  const out: Graded = { ideas: [], ideaGrades: [], optionGrades: new Map() }
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\*\*|`/g, '').trim()
    const option = /^OPTION\s+(\d+)\s+([1-3])\b/i.exec(line)
    if (option) { out.optionGrades.set(Number(option[1]) - 1, Number(option[2])); continue }
    const idea = /^IDEA\s+([1-3])\s+(.+)$/i.exec(line)
    const bare = line.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, '')
    if (idea) { out.ideas.push(idea[2].trim()); out.ideaGrades.push(Number(idea[1])) }
    else if (bare.length > 3 && !/^(IDEAS?|OPTIONS?)\b/i.test(bare)) { out.ideas.push(bare); out.ideaGrades.push(0) }
  }
  out.ideas = out.ideas.slice(0, 3)
  out.ideaGrades = out.ideaGrades.slice(0, 3)
  return out
}

/** Tier 3, on request only: green/yellow cache → ask over the cached conversation; red/cold → Haiku on a digest. */
function suggestVia(c: CacheState, l: LimitState, at: number): 'cache' | 'haiku' {
  return cacheShare(c, l, at) >= CACHE_RED_SHARE ? 'cache' : 'haiku'
}

const shortModel = (id: string | null) =>
  id ? id.replace(/^claude-/, '').replace(/-\d{8}$/, '') : 'session model'

async function suggestWithModel($: $, cwd: string) {
  const [n, c, l] = await Promise.all([read($, nextSteps), read($, cache), read($, limit)])
  if (n.aiStatus !== 'idle') return // once per turn
  if (await read($, demo)) return // demo mode never spends tokens
  const offered = n.fromAnswer.length
    ? `\n\nOptions already offered to the user (your ideas must be different; grade these too):\n${n.fromAnswer.map((t, i) => `${i + 1}. ${cleanMd(t)}`).join('\n')}`
    : ''
  const format = [
    '\n\nReply with exactly these lines and nothing else:',
    'IDEA <grade> <idea>   (3 lines)',
    n.fromAnswer.length ? 'OPTION <number> <grade>   (one line per already offered option)' : '',
  ].filter(Boolean).join('\n')
  const ask = `${SUGGEST_PROMPT} ${GRADE_RULES}${offered}${format}`
  let via = suggestVia(c, l, await $.clock.now())
  await update($, nextSteps, s => ({ ...s, aiStatus: 'loading', aiVia: via }))

  let text: string | null = null
  if (via === 'cache') {
    const r = await $.model.fork({ prompt: ask })
    if (r.isAnswered) text = r.text
    else via = 'haiku' // nothing to fork, or it failed: fall back to the cheap path
  }
  if (text === null) {
    const stored = (await $.store.get(storeKey(cwd))) as Stored | undefined
    let status = ''
    try { status = (await runGit($, ['status', '--short'])).stdout.split('\n').slice(0, 30).join('\n') } catch {}
    const r = await $.model.complete({
      model: COMMIT_MODEL,
      maxTokens: 260,
      timeoutMs: 20_000,
      system: 'You help a developer decide what to ask their coding agent next.',
      prompt: `${ask}\n\nThe developer's recent requests:\n${(stored?.prompts ?? []).map(p => `- ${p}`).join('\n')}\n\nEnd of the agent's last answer:\n${n.answerTail}\n\nUncommitted files:\n${status || '(none)'}`,
    })
    if (r.isAnswered) text = r.text
  }
  const g = text ? parseGraded(text) : { ideas: [], ideaGrades: [], optionGrades: new Map<number, number>() }
  await update($, nextSteps, s => ({
    ...s,
    ai: g.ideas,
    aiGrades: g.ideaGrades,
    optionGrades: s.fromAnswer.map((_, i) => g.optionGrades.get(i) ?? s.optionGrades[i] ?? 0),
    aiVia: via,
    aiStatus: g.ideas.length ? 'done' : 'error',
  }))
}

// ── auto-update (marketplace installs) ──────────────────────────

const MARKETPLACE = 'deadraw'
const MARKETPLACE_URL = 'https://github.com/deadraw/OneLiner.git'
const AUTO_UPDATE_ASKED_KEY = 'autoUpdate:asked' // one $.store value: asked once per machine

type MarketplaceEntry = { source?: unknown; autoUpdate?: boolean }
type Settings = Record<string, unknown> & { extraKnownMarketplaces?: Record<string, MarketplaceEntry> }

/**
 * Installed from the marketplace, auto-update never decided: ask once and write the answer to
 * ~/.claude/settings.json (Claude Code leaves it off for marketplaces outside Anthropic's own).
 */
async function offerAutoUpdate($: $) {
  const root = $.plugin.root.replace(/\\/g, '/')
  const at = root.indexOf(`/plugins/cache/${MARKETPLACE}/`)
  if (at < 0) return // git clone or plugin folder: updates come from git pull
  if (await $.store.get(AUTO_UPDATE_ASKED_KEY)) return
  const path = `${root.slice(0, at)}/settings.json`
  let settings: Settings
  try { settings = JSON.parse(String(await $.fs.read(path))) as Settings } catch { return }
  const entry = settings.extraKnownMarketplaces?.[MARKETPLACE]
  if (entry?.autoUpdate !== undefined) return void (await $.store.set(AUTO_UPDATE_ASKED_KEY, true)) // already decided
  let choice: string
  try {
    choice = await $.ui.ask('Keep OneLiner up to date automatically? New versions install when Claude Code starts.', {
      header: 'OneLiner', options: ['Yes, auto-update', 'No, I\'ll update by hand'],
    })
  } catch { return }
  await $.store.set(AUTO_UPDATE_ASKED_KEY, true)
  const isOn = choice.startsWith('Yes')
  settings.extraKnownMarketplaces = {
    ...settings.extraKnownMarketplaces,
    [MARKETPLACE]: { source: { source: 'git', url: MARKETPLACE_URL }, ...entry, autoUpdate: isOn },
  }
  try {
    await $.fs.write(path, JSON.stringify(settings, null, 2) + '\n')
    $.ui.toast(isOn ? 'OneLiner will update itself when Claude Code starts.' : 'Auto-update off. The Update button in Plugins gets new versions.', { timeoutMs: 6000 })
  } catch {
    $.ui.toast(`Couldn't save the choice to ${path}. See the README to set it by hand.`, { timeoutMs: 8000 })
  }
}

// ── brief ───────────────────────────────────────────────────────

async function buildBrief($: $, cwd: string, stored: Stored | undefined, at: number): Promise<Brief> {
  const g = await refreshGit($)
  let commits: string[] = []
  try {
    const r = await runGit($, ['log', '-3', '--format=%s'])
    if (r.exitCode === 0) commits = r.stdout.trim().split('\n').filter(Boolean)
  } catch {}
  return {
    project: cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd,
    awayHours: stored ? Math.round((at - stored.lastAt) / 3_600_000) : 0,
    openItems: await readHandoff($, cwd),
    lastPrompts: stored?.prompts ?? [],
    commits,
    changed: g.changed,
  }
}

async function showBrief($: $, b: Brief) {
  if (!b.openItems.length && !b.lastPrompts.length && !b.commits.length && !b.changed) return
  await update($, brief, () => b)
  await $.ui.open({ id: BRIEF_PANE, title: 'Where you left off' })
}

// ── compaction ──────────────────────────────────────────────────

/** Before compacting: a handoff note while the full transcript is still there. Right after a resume there is nothing to fork yet; the compaction summary covers that case. */
async function writeCompactNote($: $, cwd: string): Promise<boolean> {
  if (!cwd) return false
  const r = await $.model.fork({
    prompt: 'Write a handoff note so this work can continue after the context is compacted. Markdown only, no preamble. Sections: "## Open items" (max 5 "- " bullets, most important first, concrete file/page names) and "## Decisions" (max 5 bullets).',
  })
  if (!r.isAnswered || !r.text.trim()) return false
  try {
    await $.fs.write(`${cwd}/.claude/handoff.md`, `<!-- oneliner ${new Date().toISOString()} -->\n${r.text.trim()}\n`)
    return true
  } catch { return false }
}

/** After compacting: the cache starts cold, and the brief shows what is still open. */
async function afterCompact($: $, cwd: string, messages: readonly { text: string }[], hasNote: boolean) {
  await update($, cache, c => ({ ...c, lastTurnAt: null, readPercent: null }))
  void refreshLimit($)
  if (!cwd) return
  const stored = (await $.store.get(storeKey(cwd))) as Stored | undefined
  const b = await buildBrief($, cwd, stored, await $.clock.now())
  const fromSummary = summaryItems(messages.map(m => m.text).join('\n'))
  if (!hasNote && fromSummary.length) b.openItems = fromSummary
  // Your last asks are no news right after a compaction: open the pane only for open work.
  if (b.openItems.length) await showBrief($, { ...b, awayHours: 0 })
}

/** The Compact button: runs /compact exactly as if typed, so Claude Code shows its own progress. */
async function compactNow($: $) {
  try {
    await $.command.run({ command: 'compact' })
  } catch {
    // Refused (e.g. mid-turn): leave it in the prompt box, one Enter away.
    void $.prompt.fill({ text: '/compact', mode: 'replace' })
  }
}

// ── register ────────────────────────────────────────────────────

export const register: Register = on => {
  let cwd = ''
  let editedThisTurn = false
  let lastPrompt = '' // what a limit error would have swallowed
  let offeredFor = '' // one resend offer per prompt
  // The cache timer runs from the START of a request (API docs), so remember when the last one started.
  let lastRequestAt: number | null = null
  let lastEffort: string | null = null // the effort the last main request used
  let demoTimer: { cancel: () => void } | null = null // /strip demo play
  let version = '' // from plugin.json, for the credit line
  let hasOfferedAutoUpdate = false // once per session, after the first answer (the UI is up by then)

  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    try { version = String(JSON.parse(String(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`))).version ?? '') } catch {}
    await $.command.register({ name: 'ship', description: 'Commit (and optionally push) the working tree' })
    await $.command.register({ name: 'brief', description: 'Show where you left off in this project' })
    await $.command.register({ name: 'handoff', description: 'Update your handoff file (CURRENT.md / HANDOFF.md) from this conversation' })
    await $.command.register({ name: 'limits', description: 'Show today\'s 5h limit usage and forecast' })
    await $.command.register({
      name: 'strip',
      description: 'Turn strip parts on or off (all projects)',
      argumentHint: '[git|dev|limit|context|cache|next|all] or demo [green|yellow|red|next|ideas|play|off]',
    })
    const saved = await $.store.get(HIDDEN_KEY)
    await update($, hidden, () => (Array.isArray(saved) ? saved.filter(x => typeof x === 'string') : []))

    const at = await $.clock.now()
    await update($, now, () => at)
    const found = await detectDev($, cwd)
    await update($, dev, () => ({ port: found?.port ?? null, status: found ? 'down' : 'none', error: null }))
    await Promise.all([refreshGit($), refreshLimit($), probeDev($)])
    await seedCache($, cwd, at)
    void fetchRemote($).then(() => refreshGit($))

    const stored = (await $.store.get(storeKey(cwd))) as Stored | undefined
    if (stored && (at - stored.lastAt) / 3_600_000 >= BRIEF_GAP_HOURS) {
      void buildBrief($, cwd, stored, at).then(b => showBrief($, b))
    }

    let ticks = 0
    $.clock.every(TICK_MS, () => {
      ticks += 1
      void (async () => {
        await update($, now, () => Date.now())
        await Promise.all([
          probeDev($),
          refreshLimit($),
          ticks % 5 === 0 ? fetchRemote($).then(() => refreshGit($)) : ticks % 2 === 0 ? refreshGit($) : null,
        ])
      })()
    })
    // Fast clock: redraws the cache countdown every 15 s, but only while the 5-minute cache applies.
    $.clock.every(FAST_TICK_MS, () => {
      void (async () => {
        const [c, l] = await Promise.all([read($, cache), read($, limit)])
        if (c.lastTurnAt !== null && cacheTtl(c, l) < CACHE_TTL_MIN) await update($, now, () => Date.now())
      })()
    })
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (cwd && e.text.trim() && !e.text.startsWith('/')) {
      const key = storeKey(cwd)
      const stored = ((await $.store.get(key)) as Stored | undefined) ?? { lastAt: 0, prompts: [] }
      const prompts = [...stored.prompts, e.text.trim().replace(/\s+/g, ' ').slice(0, 140)].slice(-3)
      await $.store.set(key, { ...stored, lastAt: await $.clock.now(), prompts }) // keep cacheAt
    }
    editedThisTurn = false
    if (e.text.trim() && !e.text.startsWith('/')) lastPrompt = e.text
    if ((await $.ui.panes()).some(p => p.id === BRIEF_PANE)) void $.ui.close({ id: BRIEF_PANE })
    if ((await read($, nextSteps)).isOpen) await update($, nextSteps, s => ({ ...s, isOpen: false }))
    if (await read($, stripMenu)) await update($, stripMenu, () => false)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId) return result
    if (!hasOfferedAutoUpdate) {
      hasOfferedAutoUpdate = true
      void offerAutoUpdate($)
    }
    const options = extractNextSteps(e.answer)
    await update($, nextSteps, () => ({
      isOpen: false, fromAnswer: options, ai: [], aiGrades: [], optionGrades: options.map(recommendedGrade), aiStatus: 'idle', aiVia: null,
      answerTail: e.answer.slice(-1500), view: 'main', model: e.usage?.model ?? null,
    }))
    const at = await $.clock.now()
    const u = e.usage
    const total = u ? u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens : 0
    const readPercent = u && total > 0 ? Math.round((u.cache_read_input_tokens / total) * 100) : null
    const cacheFrom = lastRequestAt ?? at
    await update($, cache, c => ({ ...c, lastTurnAt: cacheFrom, readPercent: readPercent ?? c.readPercent, resetReason: null }))
    await update($, now, () => at)
    if (cwd) {
      const stored = ((await $.store.get(storeKey(cwd))) as Stored | undefined) ?? { lastAt: 0, prompts: [] }
      await $.store.set(storeKey(cwd), { ...stored, lastAt: at, cacheAt: cacheFrom })
    }
    void Promise.all([refreshGit($), refreshLimit($), probeDev($)])
    if (editedThisTurn) {
      editedThisTurn = false
      // Give the dev server a moment to rebuild, then say whether the change made it.
      $.clock.after(REBUILD_CHECK_MS, () => void reportRebuild($))
    }
    return result
  })

  // A limit / credit error lands as a row of the conversation: catch it there and offer a resend.
  // Every main-thread model request: note when it starts (the cache timer's real start) and its effort.
  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) {
      lastRequestAt = await $.clock.now()
      if (e.effort !== undefined) lastEffort = String(e.effort)
    }
    return yield* next(e)
  })

  // /effort and /fast change the request in a way that empties the conversation cache.
  on('command.run', async ($, e, next) => {
    const result = await next(e)
    const isCacheSetting = e.command === 'effort' || e.command === 'fast'
    const asked = e.args.trim().toLowerCase()
    // "/effort high" while already on high changes nothing; a bare /effort opens a picker, so assume a change.
    const isSameEffort = e.command === 'effort' && asked !== '' && asked === lastEffort
    if (isCacheSetting && !isSameEffort && !result.exitCode) void markCacheReset($, e.command === 'fast' ? 'fast mode' : 'effort')
    return result
  })

  // The same settings changed from a settings row (effort level, thinking, fast mode).
  on('config.set', async ($, e, next) => {
    const result = await next(e)
    if (/effort|thinking|fast/i.test(e.key) && JSON.stringify(e.value) !== JSON.stringify(e.previous)) {
      void markCacheReset($, /thinking/i.test(e.key) ? 'thinking' : /fast/i.test(e.key) ? 'fast mode' : 'effort')
    }
    return result
  })

  on('session.append', async ($, e, next) => {
    const result = await next(e)
    const msg = e.message as { type?: string; content?: unknown }
    if (!e.agentId && msg.type === 'assistant' && lastPrompt && offeredFor !== lastPrompt) {
      const content = msg.content
      const text = typeof content === 'string' ? content
        : Array.isArray(content) ? content.map(b => (b as { text?: string }).text ?? '').join(' ') : ''
      if (LIMIT_ERROR.test(text)) {
        offeredFor = lastPrompt
        void offerResend($, text, lastPrompt)
      }
    }
    return result
  })

  // Remember that Claude changed project files this turn (notes and docs don't count).
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (EDIT_TOOLS.has(e.tool) && !result.isError) {
      const path = String((e as { file_path?: string; notebook_path?: string }).file_path ?? (e as { notebook_path?: string }).notebook_path ?? '')
      if (!/\.(md|txt)$/i.test(path)) editedThisTurn = true
    }
    return result
  })

  on('session.compact', async ($, e, next) => {
    const isMain = !e.agentId && e.trigger !== 'precompute'
    const hasNote = isMain ? await writeCompactNote($, cwd).catch(() => false) : false
    const result = await next(e)
    if (isMain && result.skip === undefined) await afterCompact($, cwd, result.messages, hasNote)
    return result
  })

  // Resume/fork: the engine knows how long the transcript sat idle and whether the cache expired.
  on('classic.SessionStart', async ($, e, next) => {
    if ((e.source === 'resume' || e.source === 'fork') && e.seconds_since_last_response !== undefined) {
      const at = await $.clock.now()
      const lastTurnAt = e.prompt_cache_likely_expired ? 0 : at - e.seconds_since_last_response * 1000
      await update($, cache, c => ({ ...c, lastTurnAt, readPercent: null }))
    }
    return next(e)
  })

  // Switching model: the engine reports the real cache lifetime, and the new model starts cold.
  on('classic.PreModelSwitch', async ($, e, next) => {
    await update($, cache, c => ({ ...c, reportedTtl: ttlMinutes(e.cache_ttl) }))
    if (e.prompt_cache_warm && e.context_tokens > 20_000) {
      $.ui.toast(`Switching to ${e.to_model} drops the warm cache: ${Math.round(e.context_tokens / 1000)}k tokens re-cached (~$${e.estimated_cache_write_usd.toFixed(2)})`, { timeoutMs: 8000 })
    }
    return next(e)
  })

  on('classic.PostModelSwitch', async ($, e, next) => {
    const isFresh = e.source !== 'resume'
    await update($, cache, c => ({ ...c, reportedTtl: ttlMinutes(e.cache_ttl), ...(isFresh ? { lastTurnAt: 0, readPercent: null } : {}) }))
    return next(e)
  })

  on('command.run', { command: 'ship' }, async $ => {
    await ship($)
    return { text: '' }
  })

  on('command.run', { command: 'handoff' }, async $ => {
    void writeHandoff($, cwd)
    return { text: 'Writing the handoff from this conversation; you\'ll be asked before anything is saved.' }
  })

  on('command.run', { command: 'limits' }, async $ => {
    await $.ui.open({ id: LIMITS_PANE, title: '5h limit' })
    return { text: '' }
  })

  on('ui.render', { component: 'Pane', requestId: LIMITS_PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const [l, at] = await Promise.all([read($, limit), read($, now)])
    const h = ((await $.store.get(HISTORY_KEY)) as History | undefined) ?? { resetsAt: null, points: [] }
    const width = Math.max(20, Math.min(72, ((e.props as { bodyColumns?: number }).bodyColumns ?? 60) - 8))
    const close = <Button key="limits-close" role="dismiss" label="Close" onPress={() => void $.ui.close({ id: LIMITS_PANE })} />
    if (l.percent === null || !l.resetsAt) {
      return <Box flexDirection="column"><Text dimColor>No limit reading yet: it arrives with the next reply.</Text>{close}</Box>
    }
    const end = Date.parse(l.resetsAt)
    const start = end - WINDOW_MS
    const nowAt = at || Date.now()
    const fullAt = limitFullAt(l)
    const pace = (() => {
      const s = l.samples ?? []
      if (s.length < 2) return null
      const span = s[s.length - 1].at - s[0].at
      return span >= FORECAST_MIN_SPAN_MS ? ((s[s.length - 1].pct - s[0].pct) / span) * 3_600_000 : null
    })()
    const points = h.resetsAt === l.resetsAt ? h.points : []
    // Each column is a slice of the 5h window: past → last reading; future → the forecast line.
    const past: (number | null)[] = []
    const future: (number | null)[] = []
    for (let i = 0; i < width; i++) {
      const t = start + ((i + 1) / width) * WINDOW_MS
      if (t <= nowAt) {
        const before = points.filter(p => p.at <= t)
        past.push(before.length ? before[before.length - 1].pct : null)
        future.push(null)
      } else {
        past.push(null)
        future.push(pace !== null && pace > 0 ? Math.min(100, l.percent + (pace * (t - nowAt)) / 3_600_000) : null)
      }
    }
    const pastRows = barRows(past, 5)
    const futureRows = barRows(future, 5)
    const pct = Math.round(l.percent)
    const tone = pct >= LIMIT_RED_PCT ? 'error' : pct >= LIMIT_YELLOW_PCT ? 'warning' : 'success'
    const axis = ['100', '', ' 50', '', '  0']
    const nowCol = Math.max(0, Math.min(width - 1, Math.floor(((nowAt - start) / WINDOW_MS) * width)))
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text color={tone} bold>5h {pct}%</Text>
          {pace !== null && <Text dimColor>· pace {pace >= 0 ? '+' : ''}{Math.round(pace)}%/h</Text>}
          {fullAt !== null
            ? <Text color="warning">· full ~{hhmmAt(fullAt)}</Text>
            : <Text dimColor>· won't fill before reset</Text>}
          <Text dimColor>· resets {hhmm(l.resetsAt)}</Text>
        </Box>
        {pastRows.map((row, r) => (
          <Box flexDirection="row">
            <Text dimColor>{axis[r].padStart(3)} │</Text>
            <Text color={tone}>{row.slice(0, nowCol + 1)}</Text>
            <Text dimColor>{futureRows[r].slice(nowCol + 1)}</Text>
          </Box>
        ))}
        <Text dimColor>{'    └' + '─'.repeat(width)}</Text>
        <Box flexDirection="row" width={width + 5} justifyContent="space-between">
          <Text dimColor>{'     ' + hhmmAt(start)}</Text>
          <Text dimColor>now {hhmmAt(nowAt)}</Text>
          <Text dimColor>{hhmmAt(end)}</Text>
        </Box>
        {l.weekPercent !== null && <Text dimColor>7-day window: {Math.round(l.weekPercent)}%{l.weekResetsAt ? ` · resets ${new Date(l.weekResetsAt).toLocaleDateString()}` : ''}</Text>}
        {points.length < 3 && <Text dimColor italic>The chart fills in as readings arrive (one per few minutes while you work).</Text>}
        {close}
      </Box>
    )
  })

  on('command.run', { command: 'strip' }, async ($, e) => {
    const word = e.args.trim().toLowerCase()
    if (word === '') {
      await update($, nextSteps, s => ({ ...s, isOpen: false }))
      await update($, stripMenu, () => true)
      return { text: 'Strip parts: press 1–6 to switch one on or off, 0 to close.' }
    }
    if (word.startsWith('demo')) {
      const level = word.split(/\s+/)[1] ?? 'green'
      demoTimer?.cancel() // any new demo command stops a running play
      demoTimer = null
      if (level === 'play') {
        await update($, stripMenu, () => false)
        let i = 0
        const step = () => {
          const [lvl, ms] = DEMO_PLAY[i]
          void update($, demo, () => lvl)
          demoTimer = $.clock.after(ms, () => { i = (i + 1) % DEMO_PLAY.length; step() })
        }
        step()
        return { text: 'Demo playing: green → yellow → red → next → ideas, looped. /strip demo off to stop.' }
      }
      if (level === 'off') {
        await update($, demo, () => null)
        return { text: 'Demo off: the strip shows your real values again.' }
      }
      if (!(DEMO_LEVELS as readonly string[]).includes(level)) {
        return { text: `Demo levels: ${DEMO_LEVELS.join(', ')}, play, or off.` }
      }
      await update($, stripMenu, () => false)
      await update($, demo, () => level)
      return { text: `Demo: ${level}. Sample values only; buttons are off. /strip demo off to exit.` }
    }
    if (word === 'all' || word === 'reset') {
      await setHidden($, [])
      return { text: 'All strip parts are on.' }
    }
    const part = STRIP_PARTS.find(p => p.words.includes(word))
    if (!part) return { text: `Unknown part "${word}". Try: ${STRIP_PARTS.map(p => p.words[0]).join(', ')}, or all.` }
    const isNowHidden = await toggleHidden($, part.id)
    return { text: `${part.label} ${isNowHidden ? 'hidden' : 'shown'} (all projects).` }
  })

  on('command.run', { command: 'brief' }, async $ => {
    const stored = (await $.store.get(storeKey(cwd))) as Stored | undefined
    await showBrief($, await buildBrief($, cwd, stored, await $.clock.now()))
    return { text: 'Brief opened.' }
  })

  // ── the strip ─────────────────────────────────────────────────

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const [hiddenParts, isMenuOpen, writingHandoff] = await Promise.all([read($, hidden), read($, stripMenu), read($, isWritingHandoff)])
    let [g, d, l, c, ctx, at, shipping, n] = await Promise.all([
      read($, git), read($, dev), read($, limit), read($, cache), read($, context), read($, now), read($, isShipping),
      read($, nextSteps),
    ])
    const demoLevel = (await read($, demo)) as DemoLevel | null
    if (demoLevel) ({ g, d, l, c, ctx, n } = demoFixture(demoLevel, at || Date.now(), n))
    const cols = e.props.bodyColumns
    const isTight = cols < 60

    type Seg = {
      id: string; text: string; color?: string; dim?: boolean
      extras?: { text: string; color?: string; dim?: boolean; drop?: number }[] // more numbers, each with its own color; `drop`: lower goes first when narrow
      button?: { label: string; onPress: () => void }
    }
    const segs: Seg[] = []

    // git
    if (g.isRepo) {
      const dirty = g.changed > 0 || g.ahead > 0
      const isDiverged = g.ahead > 0 && g.behind > 0
      const isBroken = g.conflicts > 0 || g.operation !== null
      const parts = [g.branch]
      if (g.changed) parts.push(`${g.changed}Δ`)
      if (g.ahead) parts.push(`${g.ahead}↑`)
      if (g.behind) parts.push(`${g.behind}↓`)
      segs.push({
        id: 'git',
        text: shipping ? `${g.branch} shipping…`
          : isBroken ? `${g.branch} · ${g.operation ?? 'merge'}${g.conflicts ? ` ${g.conflicts}✗` : ''}`
          : isDiverged ? `${g.branch} · diverged ${g.ahead}↑${g.behind}↓`
          : dirty ? parts.join(isTight ? ' ' : ' · ') : `${g.branch} ✓`,
        color: isBroken || isDiverged ? 'error' : dirty || g.behind ? 'warning' : g.hasUpstream ? 'success' : undefined,
        dim: !isBroken && !isDiverged && !dirty && !g.behind && !g.hasUpstream,
        button: dirty && !shipping && !isBroken && !isDiverged ? { label: 'Ship', onPress: () => void ship($) } : undefined,
      })
    }

    // dev server
    if (d.port !== null) {
      const map = {
        up: { text: `:${d.port}`, color: 'success' },
        down: { text: isTight ? `:${d.port} ↓` : `:${d.port} down`, dim: true },
        starting: { text: `:${d.port} starting…`, dim: true },
        error: { text: isTight ? 'build ✗' : `build error`, color: 'error' },
        none: { text: '', dim: true },
      } as const
      const s = map[d.status]
      segs.push({
        id: 'dev', text: s.text, color: 'color' in s ? s.color : undefined, dim: 'dim' in s && s.dim,
        button: d.status === 'down' ? { label: 'Start', onPress: () => void startDev($, cwd) } : undefined,
      })
    }

    // limit
    if (l.percent !== null) {
      const pct = Math.round(l.percent)
      const tone = pct >= LIMIT_RED_PCT ? 'error' : pct >= LIMIT_YELLOW_PCT ? 'warning' : 'success'
      const hot = tone !== 'success'
      const minsLeft = l.resetsAt ? Math.max(0, Math.ceil((Date.parse(l.resetsAt) - at) / 60_000)) : null
      const fullAt = limitFullAt(l)
      const reset = fullAt !== null ? ` · full ~${hhmmAt(fullAt)}`
        : minsLeft !== null && minsLeft < 60 ? ` · ${minsLeft} min`
        : hot && l.resetsAt && !isTight ? ` · ${hhmm(l.resetsAt)}` : ''
      const week = l.weekPercent !== null && l.weekPercent >= WEEK_SHOW_PCT ? Math.round(l.weekPercent) : null
      segs.push({
        id: 'limit',
        text: `5h ${pct}%${reset}`,
        color: tone,
        extras: week !== null
          ? [{ text: ` · 7d ${week}%`, color: week >= LIMIT_RED_PCT ? 'error' : 'warning', drop: 3 }]
          : undefined,
        // Close to the wall: offer to write the handoff while there's still room to.
        button: (tone === 'error' || (fullAt !== null && fullAt - at < 60 * 60_000)) && !writingHandoff
          ? { label: 'Handoff', onPress: () => void writeHandoff($, cwd) }
          : undefined,
      })
    }

    // context window
    const isContextRed = ctx.percent !== null && Math.round(ctx.percent) >= CONTEXT_RED_PCT
    if (ctx.percent !== null) {
      const pct = Math.round(ctx.percent)
      const k = ctx.tokens !== null && !isTight ? ` · ${Math.round(ctx.tokens / 1000)}k` : ''
      segs.push({
        id: 'context',
        text: `ctx ${pct}%${k}`,
        color: pct >= CONTEXT_RED_PCT ? 'error' : pct >= CONTEXT_YELLOW_PCT ? 'warning' : 'success',
        button: isContextRed ? { label: 'Compact', onPress: () => void compactNow($) } : undefined,
      })
    }

    // cache clock
    const ttl = cacheTtl(c, l)
    const isShort = ttl < CACHE_TTL_MIN
    const left = cacheMinutesLeft(c, ttl, at)
    if (left !== null) {
      const cold = left === 0 || c.resetReason != null
      const share = ((secsLeftExact(c, ttl, at) ?? 0) / 60) / ttl
      const timeTone = cold || share < CACHE_RED_SHARE ? 'error' : share < CACHE_GREEN_SHARE ? 'warning' : 'success'
      const readTone = c.readPercent === null ? undefined
        : c.readPercent >= READ_GREEN_PCT ? 'success' : c.readPercent >= READ_RED_PCT ? 'warning' : 'error'
      const of = isShort ? (isTight ? `/${ttl}` : ` of ${ttl}`) : ''
      const secs = isShort ? cacheSecondsLeft(c, ttl, at) : null
      const clock = secs !== null && secs < 120
        ? `${secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`}${of}${of ? 'm' : ''}`
        : `${left}${of}m`
      segs.push({
        id: 'cache',
        text: c.resetReason ? (isTight ? 'cache reset' : `cache reset · ${c.resetReason}`)
          : cold ? 'cache cold' : `${isTight ? '⏱' : 'cache '}${clock}`,
        color: timeTone,
        extras: [
          ...(!cold && !isTight && c.readPercent !== null ? [{ text: ` · ${c.readPercent}% read`, color: readTone, drop: 2 }] : []),
          // A /model switch throws this warm cache away; say how much it would re-send.
          ...(!cold && cols >= SWITCH_HINT_COLS && share >= CACHE_RED_SHARE && (ctx.tokens ?? 0) >= SWITCH_HINT_TOKENS
            ? [{ text: ` · switch re-sends ${Math.round((ctx.tokens ?? 0) / 1000)}k`, dim: true, drop: 1 }] : []),
        ],
        // On a small context, re-sending it costs less than a compaction (which reads it all and writes a summary).
        button: timeTone === 'error' && !isContextRed && !c.resetReason && (ctx.percent ?? 0) >= CACHE_COMPACT_MIN_PCT ? { label: 'Compact', onPress: () => void compactNow($) } : undefined,
      })
    }

    // next steps toggle
    const toggleNext = () => void update($, nextSteps, s => ({ ...s, isOpen: !s.isOpen, view: 'main' }))
    segs.push({
      id: 'next', text: '',
      button: { label: n.isOpen ? 'next ▴' : n.fromAnswer.length ? `next ${n.fromAnswer.length} ▾` : 'next ▾', onPress: toggleNext },
    })

    if (demoLevel) {
      for (const s of segs) {
        if (s.button && s.id !== 'next') s.button = { ...s.button, onPress: () => $.ui.toast('Demo mode: buttons are off. /strip demo off to exit') }
      }
    }

    // Narrow: first the optional extras (switch hint, then % read, then 7d), then whole parts:
    // dev, git, context, next. Limit + cache always stay.
    const width = (s: Seg) => s.text.length + (s.extras ?? []).reduce((w, x) => w + x.text.length, 0) + (s.button ? s.button.label.length + 5 : 0) + 3
    const total = (list: Seg[]) => list.reduce((n, s) => n + width(s), 0)
    let shown = segs.filter(s => !hiddenParts.includes(s.id))
    for (const level of [1, 2, 3]) {
      if (total(shown) <= cols) break
      shown = shown.map(s => (s.extras ? { ...s, extras: s.extras.filter(x => x.drop !== level) } : s))
    }
    // Still too wide: shorter labels before losing any part.
    if (total(shown) > cols) shown = shown.map(compactSeg)
    const dropOrder = ['dev', 'git', 'context', 'next']
    for (const id of dropOrder) {
      if (total(shown) <= cols) break
      shown = shown.filter(s => s.id !== id)
    }
    if (shown.length === 0 && !isMenuOpen) return next(e) // all parts off: no strip, /strip still opens the panel

    // One Text per character, each a step along the gradient (surfaces have no gradient style).
    const gradient = (text: string, from: string, to: string) => {
      const chars = [...text]
      return (
        <Box flexDirection="row">
          {chars.map((ch, i) => <Text color={mixHex(from, to, chars.length > 1 ? i / (chars.length - 1) : 0)}>{ch}</Text>)}
        </Box>
      )
    }
    // Segments on the left; the next button pinned to the right edge.
    const nextSeg = shown.find(s => s.id === 'next')
    const leftSegs = shown.filter(s => s.id !== 'next')
    const strip = (
      <Box flexDirection="row" width={cols} justifyContent="space-between">
        <Box flexDirection="row" gap={1}>
        {leftSegs.map((s, i) => (
          <Box key={s.id} flexDirection="row" gap={1}>
            {i > 0 && <Text dimColor>│</Text>}
            <Box flexDirection="row">
              {s.text !== '' && <Text color={s.color} dimColor={s.dim} wrap="truncate">{s.text}</Text>}
              {(s.extras ?? []).map(x => <Text color={x.color} dimColor={x.dim} wrap="truncate">{x.text}</Text>)}
            </Box>
            {s.button && <Button key={`${s.id}-btn`} label={s.button.label} onPress={s.button.onPress} />}
          </Box>
        ))}
        </Box>
        {nextSeg?.button && (
          // A Button can't be colored: "next" carries the gradient, the arrow is a full bracketed button.
          <Box flexDirection="row" gap={1}>
            {gradient(nextSeg.button.label.replace(/\s*[▾▴]$/, ''), IDEAS_FROM, IDEAS_TO)}
            <Button key="next-btn" plain label={n.isOpen ? ' ▴  ' : ' ▾  '} onPress={nextSeg.button.onPress} />
          </Box>
        )}
      </Box>
    )
    if (!n.isOpen && !isMenuOpen) return strip

    // The slide-up: picks fill the prompt (never send), 1–4 / s / 0 as hotkeys.
    const pick = (text: string) => {
      void $.prompt.fill({ text: cleanMd(text), mode: 'replace' })
      void update($, nextSteps, s => ({ ...s, isOpen: false, view: 'main' }))
    }
    const goTo = (view: 'main' | 'suggest') => update($, nextSteps, s => ({ ...s, view }))
    const via = n.aiVia ?? suggestVia(c, l, at)
    const runsOn = via === 'cache'
      ? `${shortModel(n.model)} · from cache${ctx.tokens ? ` ~${Math.round(ctx.tokens / 1000)}k` : ''}`
      : `${shortModel(COMMIT_MODEL)} · ~3k`

    // Layout shared by both screens: a title row (meta on the right), indented rows, a thin rule, the exit row.
    const labelMax = Math.max(24, Math.min(64, cols - 12))
    const rule = <Text dimColor>{'  ' + '─'.repeat(Math.max(10, Math.min(cols - 4, labelMax + 6)))}</Text>
    const title = (left: string, right?: string, isGradient = false) => (
      <Box flexDirection="row" width={cols} justifyContent="space-between" marginTop={1}>
        {isGradient
          ? <Box flexDirection="row"><Text>{'  '}</Text>{gradient(left, IDEAS_FROM, IDEAS_TO)}</Box>
          : <Text dimColor>{'  ' + left}</Text>}
        {right ? <Text dimColor>{right + ' '}</Text> : null}
      </Box>
    )
    const row = (key: string, hotkey: string, label: string, onPress: () => void) => (
      <Box key={key} flexDirection="row" marginLeft={2}>
        <Button key={`${key}-b`} plain hotkey={hotkey} label={label} onPress={onPress} />
      </Box>
    )
    // A row whose text is styled: a small › button carries the hotkey and the click, the content beside it the color.
    const styledRow = (key: string, hotkey: string, content: unknown, onPress: () => void) => (
      <Box key={key} flexDirection="row" marginLeft={2} gap={1}>
        <Button key={`${key}-b`} plain hotkey={hotkey} label="›" onPress={onPress} />
        {content}
      </Box>
    )
    // A Button has no text color of its own, so a graded 'text' row is a small › button + the colored label.
    const gradedRow = (key: string, hotkey: string, label: string, grade: number, onPress: () => void) => {
      const color = GRADE_COLORS[grade]
      if (!color) return row(key, hotkey, label, onPress)
      return GRADE_STYLE === 'dot' ? (
        <Box key={key} flexDirection="row" marginLeft={2} gap={1}>
          <Text color={color}>●</Text>
          <Button key={`${key}-b`} plain hotkey={hotkey} label={label} onPress={onPress} />
        </Box>
      ) : (
        <Box key={key} flexDirection="row" marginLeft={2} gap={1}>
          <Button key={`${key}-b`} plain hotkey={hotkey} label="›" onPress={onPress} />
          <Text color={color} wrap="truncate">{label}</Text>
        </Box>
      )
    }
    const note = (text: string) => <Box marginLeft={4}><Text dimColor italic>{text}</Text></Box>
    const credit = <Text color={CREDIT_COLOR}>{`${version ? `v${version} ` : ''}© deadraw `}</Text>

    // /strip panel: one row per part, ● on / ○ off, saved for every project.
    if (isMenuOpen) {
      const closeMenu = () => void update($, stripMenu, () => false)
      return (
        <Box flexDirection="column">
          {strip}
          {title('strip parts', 'saved for all projects')}
          {STRIP_PARTS.map((p, i) => {
            const isOn = !hiddenParts.includes(p.id)
            return styledRow(`part-${p.id}`, String(i + 1), (
              <Box flexDirection="row" gap={1}>
                <Text color={isOn ? 'success' : undefined} dimColor={!isOn}>{isOn ? '●' : '○'}</Text>
                <Text dimColor={!isOn}>{p.label.padEnd(11)}</Text>
                <Text color={isOn ? 'success' : undefined} dimColor={!isOn}>{isOn ? 'on' : 'off'}</Text>
              </Box>
            ), () => void toggleHidden($, p.id))
          })}
          {rule}
          {styledRow('part-0', '0', <Text color="error">close</Text>, closeMenu)}
        </Box>
      )
    }

    // Screen 2: three model suggestions. Generated once per turn; reopening shows the same three.
    if (n.view === 'suggest') {
      return (
        <Box flexDirection="column">
          {strip}
          {title('✦ ideas', runsOn, true)}
          {n.aiStatus === 'loading' && note('thinking…')}
          {n.aiStatus === 'error' && note('no ideas this time')}
          {n.ai.map((t, i) => gradedRow(`ai-${i}`, String(i + 1), shortLabel(t, labelMax), n.aiGrades?.[i] ?? 0, () => pick(t)))}
          {rule}
          <Box flexDirection="row" width={cols} justifyContent="space-between">
            {row('ai-0', '0', 'back', () => void goTo('main'))}
            {credit}
          </Box>
        </Box>
      )
    }

    // Screen 1: the options Claude offered in its last answer (free), shortened to labels.
    const openSuggest = () => {
      void goTo('suggest')
      void suggestWithModel($, cwd) // no-op when this turn's three already exist
    }
    return (
      <Box flexDirection="column">
        {strip}
        {title('next', n.fromAnswer.length ? 'from the last answer' : undefined)}
        {n.fromAnswer.length === 0 && note('no options in the last answer')}
        {n.fromAnswer.map((t, i) => gradedRow(`next-${i}`, String(i + 1), shortLabel(t, labelMax), n.optionGrades?.[i] ?? 0, () => pick(t)))}
        {rule}
        <Box flexDirection="row" width={cols} justifyContent="space-between">
          {styledRow('next-s', 's', gradient(n.aiStatus === 'done' ? `✦ ${n.ai.length} ideas` : '✦ 3 more ideas', IDEAS_FROM, IDEAS_TO), openSuggest)}
          {n.aiStatus !== 'done' ? <Text dimColor>{runsOn + ' '}</Text> : null}
        </Box>
        <Box flexDirection="row" width={cols} justifyContent="space-between">
          {styledRow('next-0', '0', <Text color="error">close</Text>, toggleNext)}
          {credit}
        </Box>
      </Box>
    )
  })

  // ── the brief pane ────────────────────────────────────────────

  on('ui.render', { component: 'Pane', requestId: BRIEF_PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const b = await read($, brief)
    if (!b) return <Text dimColor>No brief yet.</Text>
    const resume = b.openItems[0] ?? b.lastPrompts[b.lastPrompts.length - 1]
    return (
      <Box flexDirection="column" gap={0}>
        <Text bold>{b.project}{b.awayHours ? ` · away ${b.awayHours}h` : ''}</Text>
        {b.openItems.length > 0 && <Text dimColor>Open items</Text>}
        {b.openItems.map(item => <Text wrap="truncate">  ▸ {item}</Text>)}
        {b.lastPrompts.length > 0 && <Text dimColor>Your last asks</Text>}
        {b.lastPrompts.map(p => <Text wrap="truncate">  › {p}</Text>)}
        {b.commits.length > 0 && <Text dimColor>Last commits</Text>}
        {b.commits.map(cm => <Text wrap="truncate">  • {cm}</Text>)}
        {b.changed > 0 && <Text color="warning">{b.changed} uncommitted file{b.changed === 1 ? '' : 's'}</Text>}
        <Box flexDirection="row" gap={1} marginTop={1}>
          {resume && (
            <Button key="continue" variant="primary" label="Continue"
              onPress={() => void $.prompt.fill({ text: `Continue from where we left off: ${resume}`, mode: 'replace' })} />
          )}
          <Button key="dismiss" role="dismiss" label="Dismiss" onPress={() => void $.ui.close({ id: BRIEF_PANE })} />
        </Box>
      </Box>
    )
  })
}
