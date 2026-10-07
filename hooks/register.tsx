import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Brief, HandoffStep, CacheState, ContextState, DevState, DiffView, FileStat, GitState, LimitState, NextState } from '../types'

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
const DIFF_PANE = 'oneliner-diff'
const SMART_MODEL = 'claude-sonnet-5-5' // the brief, the handoff note, commit and PR texts, ideas off the cache (effort low)
// "✦ 3 more ideas" leaves the cached conversation for SMART_MODEL when the 5h limit is this full,
// or the cache has less than this share of its lifetime left (or is cold).
const IDEAS_SMART_LIMIT_PCT = 80
const IDEAS_SMART_CACHE_SHARE = 0.1
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
const cache = atom({ plugin: 'oneliner', key: 'cache' } as const, { lastTurnAt: null, readPercent: null, reportedTtl: null, resetReason: null } as CacheState)
const context = atom({ plugin: 'oneliner', key: 'context' } as const, { percent: null, tokens: null, window: null } as ContextState)
const nextSteps = atom({ plugin: 'oneliner', key: 'next' } as const, {
  isOpen: false, fromAnswer: [], ai: [], aiGrades: [], optionGrades: [], aiStatus: 'idle', aiVia: null, answerTail: '', view: 'main', model: null,
} as NextState)
const remoteSeen = atom({ plugin: 'oneliner', key: 'remoteSeen' } as const, null as string | null)
const isWritingHandoff = atom({ plugin: 'oneliner', key: 'isWritingHandoff' } as const, false)
const autoUpdateOffer = atom({ plugin: 'oneliner', key: 'autoUpdateOffer' } as const, false)
const rowAsk = atom({ plugin: 'oneliner', key: 'rowAsk' } as const, null as { text: string; options: string[] } | null)
const handoffStep = atom({ plugin: 'oneliner', key: 'handoffStep' } as const, null as HandoffStep | null)
const demo = atom({ plugin: 'oneliner', key: 'demo' } as const, null as string | null)
const hidden = atom({ plugin: 'oneliner', key: 'hidden' } as const, [] as string[])
const stripMenu = atom({ plugin: 'oneliner', key: 'isStripMenuOpen' } as const, false)
const isChangesOpen = atom({ plugin: 'oneliner', key: 'isChangesOpen' } as const, false)
const diffView = atom({ plugin: 'oneliner', key: 'diffView' } as const, null as DiffView | null)
const now = atom({ plugin: 'oneliner', key: 'now' } as const, 0)
const brief = atom({ plugin: 'oneliner', key: 'brief' } as const, null)
const isShipping = atom({ plugin: 'oneliner', key: 'isShipping' } as const, false)

type $ = EngineInterface
/** Per project: what a brief needs when you come back (your last asks, how Claude's last answer ended). */
type Stored = { lastAt: number; prompts: string[]; cacheAt?: number; answerTail?: string; options?: string[] }
type BriefCache = { forAt: number; goal: string | null; done: string | null; next: string[] }
const briefCacheKey = (cwd: string) => `briefSummary:${cwd.toLowerCase()}`

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
    if (!wanted.test(lines[i] ?? '')) continue
    for (let j = i + 1; j < lines.length && !isHeading(lines[j] ?? '') && out.length < 3; j++) {
      const m = topItem.exec(lines[j] ?? '')
      if (m?.[1]) out.push(m[1])
    }
  }
  // 2. Unchecked tasks anywhere: "- [ ] …".
  if (out.length === 0) {
    for (const l of lines) {
      const m = /^\s*[-*]\s+\[ \]\s+(.+)$/.exec(l)
      if (m?.[1] && out.length < 3) out.push(m[1])
    }
  }
  // 3. Dated-log handoffs: the first "Next …" sentence.
  if (out.length === 0) {
    const m = /(?:^|\s)(Next\b[^.\n]{10,160})/m.exec(markdown)
    if (m?.[1]) out.push(m[1])
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
    if (m?.[1]) out.push(m[1].replace(/\*\*/g, '').replace(/:\s*$/, ''))
    if (out.length >= 3) break
  }
  return out.map(t => shortLabel(t, 90))
}

// ── /handoff: update YOUR handoff file from the conversation ────

const HANDOFF_BACKUP = '.claude/handoff-backup.md'

/** After a handoff: /clear, and optionally start the fresh conversation from the handoff file. */
async function clearAfterHandoff($: $, name: string, isContinuing: boolean) {
  await update($, handoffStep, () => null)
  try {
    await $.command.run({ command: 'clear' })
  } catch {
    void $.prompt.fill({ text: '/clear', mode: 'replace' })
    return void $.ui.toast('Press Enter to clear; then ask Claude to continue from the handoff.', { timeoutMs: 8000 })
  }
  if (!isContinuing) return
  // Sent as your own words (no plugin frame). The ./ path keeps a fresh conversation from guessing
  // another one; it reports and proposes, and you confirm, since a handoff can misread the next step.
  const text = `Read ./${name.replace(/\\/g, '/')} and then tell me briefly where we left off and propose the next steps. Don't start any work until I confirm which step to take.`
  try { await $.prompt.submit({ text, asUser: true }) } catch { void $.prompt.fill({ text, mode: 'replace' }) }
}

/** The draft from the strip's Write button: saved (the previous copy kept), then Clear & continue / Clear is offered. */
async function saveHandoff($: $, cwd: string) {
  const step = await read($, handoffStep)
  if (!step || step.stage !== 'draft') return
  try {
    if (step.previous) await $.fs.write(`${cwd}/${HANDOFF_BACKUP}`, step.previous)
    await $.fs.write(step.path, step.text)
  } catch {
    await update($, handoffStep, () => null)
    return void $.ui.toast(`Couldn't write ${step.path}`, { timeoutMs: 8000 })
  }
  await update($, handoffStep, (): HandoffStep => ({ stage: 'saved', path: step.path, name: step.name }))
}

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
      ? `Update the project's handoff document so another session or AI agent can continue this work. Current ${name}:\n<<<\n${before}\n>>>\nRewrite it with everything this conversation changed: completed work, decisions, open issues and the exact next actions. Keep its structure, headings, tone and language; keep what is still true, remove what no longer is. Reply with the complete updated file only, starting with its first line: no commentary, no chat, no code fences.`
      : 'Write a handoff document (Markdown) of this conversation, so a fresh session can pick it up. Any conversation counts, coding or not: never refuse, never answer in chat. Start with "# Handoff", then: "## Topic" (what this conversation is about), "## Current state" (what was done or found), "## Decisions", "## Open questions", "## Next steps" (numbered; "None" when there are none). Concrete, current, no commentary, no code fences.'
    const r = await $.model.fork({ prompt: ask })
    if (!r.isAnswered) {
      return $.ui.toast(r.reason === 'nothing-to-fork'
        ? `Couldn't write ${name} yet: send one message in this session first, then try again`
        : `Couldn't write ${name}: the model gave no answer (${r.reason})`, { timeoutMs: 8000 })
    }
    if (!r.text.trim()) return $.ui.toast(`Couldn't write ${name}: the model gave no answer`)
    const after = r.text.trim().replace(/^```(?:markdown|md)?\n|\n```$/g, '') + '\n'
    // A document starts with a heading (or, for an update, the old file's first line); anything else is a chat reply.
    const firstLine = (t: string) => t.trimStart().split('\n')[0]?.trim() ?? ''
    if (!/^#/.test(firstLine(after)) && !(before && firstLine(after) === firstLine(before))) {
      return $.ui.toast(`The model answered instead of writing ${name}. Try again, or ask Claude to write it.`, { timeoutMs: 8000 })
    }
    const { added, removed } = lineDiff(before, after)
    // Asked in a row under the strip, not a dialog: Write / Cancel, then Clear & continue / Clear.
    await update($, handoffStep, (): HandoffStep => ({ stage: 'draft', path, name, text: after, previous: before, added, removed, isNew: !existing }))
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
    // The three git calls run side by side: each one costs a process start (slow on Windows).
    const [r, op, log, numstat] = await Promise.all([
      runGit($, ['status', '--porcelain=v2', '--branch']),
      gitOperation($).catch(() => null),
      runGit($, ['log', '-1', '--format=%ct', '--name-only']).catch(() => null), // the age is drawn from the time, kept current
      runGit($, ['diff', '--numstat', 'HEAD']).catch(() => null),
    ])
    if (r.exitCode === 0) {
      next.isRepo = true
      const untracked: string[] = []
      for (const line of r.stdout.split('\n')) {
        if (line.startsWith('# branch.head ')) next.branch = line.slice(14).trim()
        else if (line.startsWith('# branch.upstream ')) next.hasUpstream = true
        else if (line.startsWith('# branch.ab ')) {
          const m = /\+(\d+) -(\d+)/.exec(line)
          if (m) { next.ahead = Number(m[1]); next.behind = Number(m[2]) }
        } else if (line.trim() && !line.startsWith('#')) {
          next.changed += 1
          if (line.startsWith('u ')) next.conflicts += 1
          if (line.startsWith('? ')) untracked.push(line.slice(2).trim())
        }
      }
      next.operation = op
      // Line counts per file against HEAD (numstat: "added<TAB>removed<TAB>path", "-" for binary).
      const stats: FileStat[] = []
      for (const line of numstat && numstat.exitCode === 0 ? numstat.stdout.split('\n') : []) {
        const [a, d, ...rest] = line.split('\t')
        const path = rest.join('\t').trim()
        if (!path) continue
        const isBinary = a === '-'
        stats.push({ path, added: isBinary ? 0 : Number(a) || 0, removed: isBinary ? 0 : Number(d) || 0, kind: isBinary ? 'binary' : 'edit' })
      }
      for (const path of untracked) stats.push({ path, added: 0, removed: 0, kind: 'new' })
      next.stats = stats.slice(0, 50)
      next.added = stats.reduce((n, s) => n + s.added, 0)
      next.removed = stats.reduce((n, s) => n + s.removed, 0)
      if (log && log.exitCode === 0) {
        const [secs, ...names] = log.stdout.split('\n').map(l => l.trim()).filter(Boolean)
        if (secs) {
          next.lastAt = Number(secs)
          next.lastFiles = names.slice(0, 3).map(baseName)
          next.lastFilesMore = Math.max(0, names.length - 3)
        }
      }
      if (next.ahead > 0) {
        const p = await runGit($, ['log', '@{u}..HEAD', '--format=%s', '-n', '5']).catch(() => null)
        if (p && p.exitCode === 0) next.toPush = p.stdout.split('\n').map(l => l.trim()).filter(Boolean)
      }
    }
  } catch {}
  await update($, git, () => next)
  return next
}

/** A path's last part: "hooks/register.tsx" → "register.tsx" (a folder keeps its name). */
function baseName(path: string): string {
  return path.replace(/\/$/, '').split('/').pop() ?? path
}

/** "register.tsx +12 −3", "logo.png new", "font.woff binary". */
function fileLine(s: FileStat): string {
  const name = baseName(s.path)
  return s.kind === 'new' ? `${name} new` : s.kind === 'binary' ? `${name} binary` : `${name} +${s.added} −${s.removed}`
}

async function commitMessage($: $): Promise<string> {
  const stat = await runGit($, ['status', '--short'])
  const diff = await runGit($, ['diff', 'HEAD', '--no-color'])
  const fallback = `Update ${stat.stdout.trim().split('\n').length} files`
  const r = await $.model.complete({
    model: SMART_MODEL,
    effort: 'low',
    maxTokens: 200,
    timeoutMs: 20_000,
    system: 'You write git commit messages. Reply with the message only: one imperative subject line under 72 chars, optionally a blank line and up to 3 short bullet lines.',
    prompt: `Files:\n${stat.stdout.slice(0, 3000)}\n\nDiff (truncated):\n${diff.stdout.slice(0, 8000)}`,
  })
  return r.isAnswered && r.text.trim() ? r.text.trim() : fallback
}

// ── questions in a row under the strip ──────────────────────────
// Never Claude Code's question dialog: that one adds "Other" / "Skip", and asked
// near the end of a turn its answer reaches the model.

let answerRowAsk: ((choice: string | null) => void) | null = null

/** Asks in a row under the strip; resolves to the chosen option, or null when dismissed. */
async function askInRow($: $, text: string, options: string[]): Promise<string | null> {
  answerRowAsk?.(null) // a newer question replaces an unanswered one
  const choice = new Promise<string | null>(resolve => { answerRowAsk = resolve })
  await update($, rowAsk, () => ({ text, options }))
  const result = await choice
  await update($, rowAsk, () => null)
  return result
}

/** A row button's answer; after a reload nobody waits for it, so the row just closes. */
async function answerRow($: $, choice: string | null) {
  const resolve = answerRowAsk
  answerRowAsk = null
  if (resolve) resolve(choice)
  else await update($, rowAsk, () => null)
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
  const choice = await askInRow($, question, options)
  if (!choice || !options.includes(choice)) return

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

// ── changes: the diff pane and pull requests ────────────────────

const DIFF_MAX_CHARS = 10_000 // what one Code element draws
const DEFAULT_BRANCHES = new Set(['main', 'master'])

/** Shows one changed file's diff against HEAD in the diff pane: its hunks only, cut at a hunk to fit. */
async function openDiff($: $, paths: string[], index: number) {
  const path = paths[index]
  if (!path) return
  const g = await read($, git)
  const isNew = g.stats?.find(s => s.path === path)?.kind === 'new'
  let text = ''
  let note: string | null = null
  try {
    // Status and numstat paths are the repository's, so the diff is asked by the full path.
    const top = (await runGit($, ['rev-parse', '--show-toplevel'])).stdout.trim()
    const r = await runGit($, isNew
      ? ['diff', '--no-color', '--no-index', '--', '/dev/null', `${top}/${path}`]
      : ['diff', '--no-color', 'HEAD', '--', `${top}/${path}`])
    const lines = r.stdout.split('\n')
    const first = lines.findIndex(l => l.startsWith('@@'))
    text = first === -1 ? '' : lines.slice(first).join('\n').replace(/\n+$/, '')
  } catch {}
  if (text.length > DIFF_MAX_CHARS) {
    // Cut between hunks: a hunk cut in the middle no longer draws as a diff.
    const cut = text.lastIndexOf('\n@@', DIFF_MAX_CHARS)
    text = text.slice(0, cut > 0 ? cut : text.lastIndexOf('\n', DIFF_MAX_CHARS))
    note = 'The rest of this diff is longer than the pane draws.'
  }
  if (!text) note = 'No text changes to show (a binary file, or a folder).'
  await update($, diffView, () => ({ paths, index, text, note }))
  await $.ui.open({ id: DIFF_PANE, title: baseName(path), closeOnEscape: true })
}

/** A pull request for this branch: Create or Draft asked in the strip row, the title and description from Sonnet. */
async function createPr($: $) {
  const g = await refreshGit($)
  if (!g.isRepo || DEFAULT_BRANCHES.has(g.branch)) return $.ui.toast(`A pull request starts from a branch other than ${g.branch || 'main'}`)
  const head = await runGit($, ['rev-parse', '--abbrev-ref', 'origin/HEAD']).catch(() => null)
  const base = head && head.exitCode === 0 && head.stdout.trim() ? head.stdout.trim().replace(/^origin\//, '') : 'main'
  const hasGh = await $.process.run(['gh', '--version'], { timeoutMs: 10_000 }).then(r => r.exitCode === 0, () => false)
  if (!hasGh) {
    // Without the GitHub CLI, Claude takes it from the prompt (filled, never sent).
    await $.prompt.fill({ text: `Create a pull request from ${g.branch} into ${base}, with a title and description from its commits.`, mode: 'replace' })
    return $.ui.toast('GitHub CLI (gh) not found: the request is in the prompt for Claude')
  }
  const open = await $.process.run(['gh', 'pr', 'view', '--json', 'url', '-q', '.url'], { timeoutMs: 20_000 }).catch(() => null)
  if (open && open.exitCode === 0 && open.stdout.trim()) return $.ui.toast(`A pull request is already open: ${open.stdout.trim()}`, { timeoutMs: 10_000 })

  const pushFirst = g.ahead > 0 || !g.hasUpstream
  const choice = await askInRow($, `Pull request ${g.branch} → ${base}${pushFirst ? ' (pushes the branch first)' : ''}?`, ['Create', 'Draft'])
  if (!choice) return
  await update($, isShipping, () => true)
  try {
    if (pushFirst) {
      const p = await runGit($, g.hasUpstream ? ['push'] : ['push', '-u', 'origin', g.branch], 120_000)
      if (p.exitCode !== 0) return $.ui.toast(`Push failed: ${p.stderr.trim().split('\n').pop()}`)
    }
    $.ui.toast('Writing the pull request…')
    const { title, body } = await prText($, base)
    const r = await $.process.run(
      ['gh', 'pr', 'create', '--base', base, '--title', title, '--body', body, ...(choice === 'Draft' ? ['--draft'] : [])],
      { timeoutMs: 60_000 },
    )
    const url = r.stdout.trim().split('\n').pop() ?? ''
    $.ui.toast(r.exitCode === 0
      ? `${choice === 'Draft' ? 'Draft pull request' : 'Pull request'} opened: ${url}`
      : `Pull request failed: ${(r.stderr || r.stdout).trim().split('\n').pop()}`, { timeoutMs: 10_000 })
  } finally {
    await update($, isShipping, () => false)
    await refreshGit($)
  }
}

/** The pull request's title and description, written by Sonnet from the branch's commits and files. */
async function prText($: $, base: string): Promise<{ title: string; body: string }> {
  const [log, stat] = await Promise.all([
    runGit($, ['log', `origin/${base}..HEAD`, '--format=- %s%n%b']),
    runGit($, ['diff', '--stat', `origin/${base}...HEAD`]),
  ])
  const subjects = log.stdout.split('\n').filter(l => l.startsWith('- '))
  const fallback = { title: (subjects[0] ?? '- Update').slice(2), body: subjects.join('\n') }
  const r = await $.model.complete({
    model: SMART_MODEL,
    effort: 'low',
    maxTokens: 800,
    timeoutMs: 30_000,
    system: 'You write GitHub pull request texts. Reply with the title on the first line (imperative, under 70 characters), a blank line, then the description in Markdown: a short summary paragraph and a "Changes" list. No sign-off, and no mention of AI or of who wrote it.',
    prompt: `Commits:\n${log.stdout.slice(0, 6000)}\n\nFiles changed:\n${stat.stdout.slice(0, 3000)}`,
  })
  if (!r.isAnswered || !r.text.trim()) return fallback
  const [title = '', ...rest] = r.text.trim().split('\n')
  return { title: title.replace(/^#+\s*/, '').trim() || fallback.title, body: rest.join('\n').trim() || fallback.body }
}

// ── loading the strip, and reloading it while developing ────────

let version = '' // from plugin.json, for the credit line

/** Every reading the strip shows, in the background: limit + ctx first, then git, dev and the rest. */
function loadReadings($: $, cwd: string, at: number) {
  void refreshLimit($).then(() => seedCache($, cwd, at))
  void refreshGit($).then(() => fetchRemote($)).then(() => refreshGit($))
  // A dev server that isn't running takes Windows ~2-4 s to refuse, so its probe never holds the rest.
  void (async () => {
    const found = await detectDev($, cwd)
    await update($, dev, (): DevState => ({ port: found?.port ?? null, status: found ? 'down' : 'none', error: null }))
    await probeDev($)
  })()
  void (async () => {
    try { version = String(JSON.parse(String(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`))).version ?? '') } catch {}
  })()
  void autoUpdateSettingsPath($).then(path => update($, autoUpdateOffer, () => path !== null))
}

/**
 * /strip reload: every panel and question closed, every reading taken again, as at a session's start.
 * (Edited code loads by itself with CLAUDE_CODE_PLUGIN_DIR_WATCH=1: each save reloads this plugin alone.)
 * Fresh also forgets the auto-update answer and this project's saved data, so first-run behavior shows again.
 */
async function reloadStrip($: $, cwd: string, isFresh: boolean) {
  await answerRow($, null)
  await Promise.all([
    update($, nextSteps, (s): NextState => ({ ...s, isOpen: false, view: 'main' })),
    update($, stripMenu, () => false),
    update($, isChangesOpen, () => false),
    update($, diffView, () => null),
    update($, handoffStep, () => null),
    update($, demo, () => null),
    update($, isShipping, () => false),
    update($, isWritingHandoff, () => false),
    update($, remoteSeen, () => null),
  ])
  if (isFresh) {
    await Promise.all([
      $.store.delete(AUTO_UPDATE_ASKED_KEY),
      $.store.delete(storeKey(cwd)),
      $.store.delete(briefCacheKey(cwd)),
      update($, cache, (c): CacheState => ({ ...c, lastTurnAt: null, resetReason: null })),
      update($, brief, () => null),
    ])
  }
  const at = await $.clock.now()
  await update($, now, () => at)
  loadReadings($, cwd, at)
  $.ui.toast(isFresh ? 'OneLiner reloaded fresh: saved answers and project data forgotten' : 'OneLiner reloaded')
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
    await update($, dev, (cur): DevState => ({ ...cur, status: error ? 'error' : 'up', error }))
  } catch {
    await update($, dev, (cur): DevState => ({ ...cur, status: 'down' }))
  }
}

function firstErrorLine(text: string): string {
  const plain = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
  const m = /([A-Za-z]*Error[^.]{0,100})/.exec(plain)
  return (m?.[1] ?? plain).trim().slice(0, 100) || 'server error'
}

async function startDev($: $, cwd: string) {
  const found = await detectDev($, cwd)
  if (!found) return
  await update($, dev, (cur): DevState => ({ ...cur, status: 'starting', error: null }))
  void (async () => {
    try {
      for await (const piece of $.process.spawn({ argv: found.argv })) {
        if ('text' in piece && /error/i.test(piece.text)) {
          await update($, dev, (cur): DevState => ({ ...cur, error: (piece.text.trim().split('\n')[0] ?? '').slice(0, 100) }))
        }
        if ('text' in piece && /localhost:\d+|ready in|started server/i.test(piece.text)) {
          await update($, dev, (cur): DevState => ({ ...cur, status: 'up' }))
        }
      }
    } catch {}
    await update($, dev, (cur): DevState => ({ ...cur, status: 'down' }))
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
    await update($, context, () => ({ percent: ctx.percent ?? null, tokens: ctx.tokens ?? null, window: ctx.window, usd: usage.cost?.usd ?? null }))
    const five = usage.rateLimits.find(r => r.kind === 'five_hour') ?? usage.rateLimits[0]
    if (!five) {
      // No limits until this session's first request (an old session just opened, or right after a reload):
      // the last reading saved by any session, while its window lasts. Past its reset the strip shows 0%.
      const [last, cur, at] = await Promise.all([$.store.get(LAST_LIMIT_KEY) as Promise<LastLimit | undefined>, read($, limit), $.clock.now()])
      const isCurrent = last && (last.resetsAt ? true : at - last.at < 5 * 3_600_000)
      if (last && isCurrent && cur.percent === null) {
        await update($, limit, l => ({
          ...l, percent: last.percent, resetsAt: last.resetsAt, weekPercent: last.weekPercent, weekResetsAt: last.weekResetsAt, samples: [],
        }))
      }
      return
    }
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
    const last: LastLimit = { percent: five.percentUsed, resetsAt: five.resetsAt ?? null, weekPercent: week?.percentUsed ?? null, weekResetsAt: week?.resetsAt ?? null, at }
    void $.store.set(LAST_LIMIT_KEY, last)
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
  if (!first || !last) return null
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
  if (m[3]?.toLowerCase() === 'pm') hour += 12
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
  const choice = await askInRow($, `That prompt didn't run (${(errorText.split(/[.·]/)[0] ?? errorText).trim()}). Send it again?`, options)
  if (!choice) return
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
// The last 5h / 7d reading, one per account: a session shows it before its own first request reports one.
const LAST_LIMIT_KEY = 'limit:last'
type LastLimit = { percent: number; resetsAt: string | null; weekPercent: number | null; weekResetsAt: string | null; at: number }
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

/** How long ago, the short way: 5s, 7m, 2h, 3d, 4mo, 1y. */
const shortAge = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86_400 ? `${Math.floor(s / 3600)}h`
    : s < 30 * 86_400 ? `${Math.floor(s / 86_400)}d` : s < 365 * 86_400 ? `${Math.floor(s / (30 * 86_400))}mo` : `${Math.floor(s / (365 * 86_400))}y`
}
/** Token counts as people say them: 482k, 1M, 1.2M. */
const tokensShort = (n: number) => n >= 999_500 ? `${+(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`
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
  $.ui.toast(`${reason.charAt(0).toUpperCase() + reason.slice(1)} changed: the next message re-sends ${tokens ? `~${tokensShort(tokens)} tokens` : 'the whole conversation'} without cache`, { timeoutMs: 8000 })
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
// The desktop app's strip frame, so a hover detail covers what is under it.
const STRIP_FRAME_BG = '#212121'
const CREDIT_COLOR = '#4a4a4a' // "v1.0.1 © deadraw" in the next list: darker than dim text, there if you look
const IDEAS_TO ='#e34a9e'

/** The color `t` (0–1) of the way from one #rrggbb to another. */
function mixHex(from: string, to: string, t: number): string {
  const a = from.match(/[0-9a-f]{2}/gi)!.map(h => parseInt(h, 16))
  const b = to.match(/[0-9a-f]{2}/gi)!.map(h => parseInt(h, 16))
  return '#' + a.map((v, i) => Math.round(v + ((b[i] ?? v) - v) * t).toString(16).padStart(2, '0')).join('')
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
    const head = cleanMd(bold[1] ?? '').replace(/[:.]$/, '')
    // A terse title ("Tier 3") gets the start of its sentence: "Tier 3: auto-pick by cache state".
    t = head.length < 20 && !head.endsWith('?') && bold[2] ? `${head}: ${firstClause(cleanMd(bold[2]))}` : head
  } else {
    t = firstClause(cleanMd(raw)) ?? raw
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
  for (let i = lines.length - 1; i >= 0; i--) if (item.test(lines[i] ?? '')) { end = i; break }
  if (end >= 0 && end >= lines.length - 6) {
    let start = end
    while (start > 0 && (item.test(lines[start - 1] ?? '') || /^\s{2,}\S/.test(lines[start - 1] ?? ''))) start--
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
    const t = cleanMd(m[1] ?? '')
    if (t) offers.push(t.charAt(0).toUpperCase() + t.slice(1))
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
    if (idea?.[2]) { out.ideas.push(idea[2].trim()); out.ideaGrades.push(Number(idea[1])) }
    else if (bare.length > 3 && !/^(IDEAS?|OPTIONS?)\b/i.test(bare)) { out.ideas.push(bare); out.ideaGrades.push(0) }
  }
  out.ideas = out.ideas.slice(0, 3)
  out.ideaGrades = out.ideaGrades.slice(0, 3)
  return out
}

/** Tier 3, on request only: green/yellow cache → ask over the cached conversation; red/cold → Haiku on a digest. */
/** Ideas over the cached conversation (cheap reads) while it pays off; SMART_MODEL on a digest when the limit is high or the cache nearly gone. */
function suggestVia(c: CacheState, l: LimitState, at: number): 'cache' | 'smart' {
  const isLimitHigh = (l.percent ?? 0) >= IDEAS_SMART_LIMIT_PCT
  return !isLimitHigh && cacheShare(c, l, at) >= IDEAS_SMART_CACHE_SHARE ? 'cache' : 'smart'
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
  await update($, nextSteps, (s): NextState => ({ ...s, aiStatus: 'loading', aiVia: via }))

  let text: string | null = null
  if (via === 'cache') {
    const r = await $.model.fork({ prompt: ask })
    if (r.isAnswered) text = r.text
    else via = 'smart' // nothing to fork, or it failed: fall back to the digest
  }
  if (text === null) {
    const stored = (await $.store.get(storeKey(cwd))) as Stored | undefined
    let status = ''
    try { status = (await runGit($, ['status', '--short'])).stdout.split('\n').slice(0, 30).join('\n') } catch {}
    const r = await $.model.complete({
      model: SMART_MODEL,
      effort: 'low',
      maxTokens: 2000, // thinking counts toward it
      timeoutMs: 30_000,
      system: 'You help a developer decide what to ask their coding agent next.',
      prompt: `${ask}\n\nThe developer's recent requests:\n${(stored?.prompts ?? []).map(p => `- ${p}`).join('\n')}\n\nEnd of the agent's last answer:\n${n.answerTail}\n\nUncommitted files:\n${status || '(none)'}`,
    })
    if (r.isAnswered) text = r.text
  }
  const g = text ? parseGraded(text) : { ideas: [], ideaGrades: [], optionGrades: new Map<number, number>() }
  await update($, nextSteps, (s): NextState => ({
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

/** ~/.claude/settings.json when OneLiner runs from a marketplace install; null for a git clone or plugin folder. */
function marketplaceSettingsPath(pluginRoot: string): string | null {
  const root = pluginRoot.replace(/\\/g, '/')
  const at = root.indexOf(`/plugins/cache/${MARKETPLACE}/`)
  return at < 0 ? null : `${root.slice(0, at)}/settings.json`
}

/** The settings path when OneLiner was installed from the marketplace and auto-update is undecided; else null. */
async function autoUpdateSettingsPath($: $): Promise<string | null> {
  const path = marketplaceSettingsPath($.plugin.root)
  if (!path) return null // git clone or plugin folder: updates come from git pull
  if (await $.store.get(AUTO_UPDATE_ASKED_KEY)) return null
  try {
    const settings = JSON.parse(String(await $.fs.read(path))) as Settings
    if (settings.extraKnownMarketplaces?.[MARKETPLACE]?.autoUpdate === undefined) return path
  } catch { return null }
  await $.store.set(AUTO_UPDATE_ASKED_KEY, true) // already decided in settings
  return null
}

/**
 * The answer from the strip's Yes / No row, written to ~/.claude/settings.json
 * (Claude Code leaves auto-update off for marketplaces outside Anthropic's own).
 * A row, not $.ui.ask: that dialog is a tool call; asked at the end of a turn, its answer went to the model.
 */
async function saveAutoUpdate($: $, isOn: boolean) {
  await update($, autoUpdateOffer, () => false)
  await $.store.set(AUTO_UPDATE_ASKED_KEY, true)
  const path = marketplaceSettingsPath($.plugin.root)
  if (!path) return
  try {
    const settings = JSON.parse(String(await $.fs.read(path))) as Settings
    const entry = settings.extraKnownMarketplaces?.[MARKETPLACE]
    settings.extraKnownMarketplaces = {
      ...settings.extraKnownMarketplaces,
      [MARKETPLACE]: { source: { source: 'git', url: MARKETPLACE_URL }, ...entry, autoUpdate: isOn },
    }
    await $.fs.write(path, JSON.stringify(settings, null, 2) + '\n')
    $.ui.toast(isOn ? 'OneLiner will update itself when Claude Code starts.' : 'Auto-update off. The Update button in Plugins gets new versions.', { timeoutMs: 6000 })
  } catch {
    $.ui.toast(`Couldn't save the choice to ${path}. See the README to set it by hand.`, { timeoutMs: 8000 })
  }
}

// ── brief ───────────────────────────────────────────────────────

/** Everything a brief or a handoff note is written from: your handoff file, your last asks, Claude's last answer, git. */
async function briefMaterial($: $, cwd: string, stored: Stored | undefined): Promise<string> {
  const parts: string[] = []
  const handoff = await newestHandoff($, cwd)
  if (handoff) {
    try { parts.push(`Handoff file (${handoff.slice(cwd.length + 1)}):\n${String(await $.fs.read(handoff)).slice(0, 3000)}`) } catch {}
  }
  if (stored?.prompts.length) parts.push(`The developer's last requests, oldest first:\n${stored.prompts.map(p => `- ${p}`).join('\n')}`)
  if (stored?.answerTail) parts.push(`End of the coding agent's last answer:\n${stored.answerTail}`)
  if (stored?.options?.length) parts.push(`Options the agent offered at the end:\n${stored.options.map(o => `- ${cleanMd(o)}`).join('\n')}`)
  try {
    const log = await runGit($, ['log', '-5', '--format=%s'])
    if (log.exitCode === 0 && log.stdout.trim()) parts.push(`Last commits:\n${log.stdout.trim()}`)
    const status = await runGit($, ['status', '--short'])
    if (status.exitCode === 0 && status.stdout.trim()) parts.push(`Uncommitted files:\n${status.stdout.split('\n').slice(0, 20).join('\n')}`)
  } catch {}
  return parts.join('\n\n')
}

const BRIEF_PROMPT = [
  'Write a short "where you left off" brief for a developer coming back to this project.',
  'Use only what the material shows. Be concrete: name files, features and versions. Plain words, no markdown.',
  'Reply with exactly these lines and nothing else:',
  'GOAL <what they are working towards, one line>',
  'DONE <the most recent finished work, one line>',
  'NEXT <a concrete next step, phrased as a request to their coding agent>   (1 to 3 lines, most important first)',
].join('\n')

/** GOAL / DONE / NEXT lines from the model's reply. */
function parseBriefReply(text: string): BriefCache | null {
  const line = (tag: string) => text.split('\n').map(l => l.trim()).filter(l => l.toUpperCase().startsWith(`${tag} `)).map(l => l.slice(tag.length + 1).trim())
  const next = line('NEXT').slice(0, 3)
  const goal = line('GOAL')[0] ?? null
  if (!goal && !next.length) return null
  return { forAt: 0, goal, done: line('DONE')[0] ?? null, next }
}

/** Goal / Done / Next from a handoff note written in that shape (headings), or null. */
function noteSections(markdown: string): BriefCache | null {
  const sections: Record<string, string[]> = {}
  let current = ''
  for (const raw of markdown.split('\n')) {
    const heading = /^#{1,4}\s*(.+?)\s*$/.exec(raw)
    if (heading) { current = (heading[1] ?? '').toLowerCase(); sections[current] = []; continue }
    if (current && raw.trim()) (sections[current] ??= []).push(raw.trim().replace(/^(?:[-*•]|\d+[.)])\s+/, ''))
  }
  const first = (name: string) => Object.entries(sections).find(([h]) => h.startsWith(name))?.[1] ?? []
  const next = first('next').slice(0, 3)
  const goal = first('goal')[0] ?? null
  if (!goal && !next.length) return null
  return { forAt: 0, goal, done: first('done')[0] ?? null, next }
}

/** The free part of the brief, shown at once; fillBrief adds Goal / Done / Next. Null when there is nothing to say. */
async function buildBrief($: $, cwd: string, stored: Stored | undefined, at: number): Promise<Brief | null> {
  const g = await refreshGit($)
  let commits: string[] = []
  try {
    const r = await runGit($, ['log', '-1', '--format=%s'])
    if (r.exitCode === 0) commits = r.stdout.trim().split('\n').filter(Boolean)
  } catch {}
  const hasHandoff = (await newestHandoff($, cwd)) !== null
  if (!stored?.prompts.length && !commits.length && !g.changed && !hasHandoff) return null
  return {
    project: cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd,
    awayHours: stored ? Math.round((at - stored.lastAt) / 3_600_000) : 0,
    goal: null,
    done: null,
    next: [],
    status: 'loading',
    branch: g.isRepo ? g.branch : null,
    ahead: g.ahead,
    commits,
    changed: g.changed,
  }
}

/**
 * Goal / Done / Next, cheapest first: a handoff note written after your last message (free),
 * a summary already made for the same point (free), else one SMART_MODEL call.
 */
async function fillBrief($: $, cwd: string, stored: Stored | undefined) {
  const forAt = stored?.lastAt ?? 0
  let found: BriefCache | null = null
  try {
    const notePath = `${cwd}/.claude/handoff.md`
    if (await $.fs.exists(notePath) && (await $.fs.stat(notePath)).mtimeMs >= forAt) {
      found = noteSections(String(await $.fs.read(notePath)))
    }
  } catch {}
  if (!found) {
    const cached = (await $.store.get(briefCacheKey(cwd))) as BriefCache | undefined
    if (cached && cached.forAt === forAt) found = cached
  }
  if (!found) {
    const material = await briefMaterial($, cwd, stored)
    if (material) {
      const r = await $.model.complete({
        model: SMART_MODEL, effort: 'low', maxTokens: 2000, timeoutMs: 30_000,
        system: 'You help a developer pick up their work where they left it.',
        prompt: `${BRIEF_PROMPT}\n\n${material}`,
      })
      if (r.isAnswered) found = parseBriefReply(r.text)
      if (found) await $.store.set(briefCacheKey(cwd), { ...found, forAt })
    }
  }
  // Nothing written: the handoff file's open items, or Claude's last options, still say what is next.
  const openItems = found?.next.length ? [] : await readHandoff($, cwd)
  const next = found?.next.length ? found.next : openItems.length ? openItems : (stored?.options ?? []).map(o => shortLabel(o, 90))
  const status: Brief['status'] = found || next.length ? 'done' : 'none'
  await update($, brief, b => b && { ...b, goal: found?.goal ?? null, done: found?.done ?? null, next, status })
}

async function showBrief($: $, b: Brief) {
  await update($, brief, () => b)
  await $.ui.open({ id: BRIEF_PANE, title: 'Where you left off' })
}

/** Builds, shows and fills the brief; nothing opens when there is nothing to say. */
async function openBrief($: $, cwd: string, stored: Stored | undefined, at: number, awayHours?: number) {
  const b = await buildBrief($, cwd, stored, at)
  if (!b) return false
  await showBrief($, awayHours === undefined ? b : { ...b, awayHours })
  await fillBrief($, cwd, stored)
  return true
}

// ── compaction ──────────────────────────────────────────────────

const NOTE_PROMPT = 'Write a handoff note so this work can continue after the context is compacted. Markdown only, no preamble. Sections: "## Goal" (one line), "## Done" (one line: the most recent finished work), "## Next" (1-3 "- " bullets, concrete, phrased as requests to the coding agent, most important first), "## Decisions" (max 5 "- " bullets).'

/**
 * Before compacting: a handoff note while the full transcript is still there (a fork over the cache).
 * Right after a resume there is nothing to fork yet: SMART_MODEL writes it from the same material as the brief.
 */
async function writeCompactNote($: $, cwd: string): Promise<boolean> {
  if (!cwd) return false
  let text = ''
  const r = await $.model.fork({ prompt: NOTE_PROMPT })
  if (r.isAnswered) text = r.text.trim()
  if (!text) {
    const stored = (await $.store.get(storeKey(cwd))) as Stored | undefined
    const material = await briefMaterial($, cwd, stored)
    if (!material) return false
    const s = await $.model.complete({
      model: SMART_MODEL, effort: 'low', maxTokens: 3000, timeoutMs: 30_000,
      system: 'You write handoff notes for a coding agent.',
      prompt: `${NOTE_PROMPT}\n\n${material}`,
    })
    if (s.isAnswered) text = s.text.trim()
  }
  if (!text) return false
  try {
    await $.fs.write(`${cwd}/.claude/handoff.md`, `<!-- oneliner ${new Date().toISOString()} -->\n${text}\n`)
    return true
  } catch { return false }
}

/** After compacting: the cache starts cold, and the brief shows Goal / Done / Next from the fresh note (no extra call). */
async function afterCompact($: $, cwd: string, messages: readonly { text: string }[], hasNote: boolean) {
  await update($, cache, c => ({ ...c, lastTurnAt: null, readPercent: null }))
  void refreshLimit($)
  if (!cwd) return
  const stored = (await $.store.get(storeKey(cwd))) as Stored | undefined
  const at = await $.clock.now()
  if (hasNote) return void (await openBrief($, cwd, stored, at, 0))
  // No note: the compaction summary's pending tasks, if it has any. Never a paid call here.
  const fromSummary = summaryItems(messages.map(m => m.text).join('\n'))
  const b = fromSummary.length ? await buildBrief($, cwd, stored, at) : null
  if (b) await showBrief($, { ...b, awayHours: 0, next: fromSummary, status: 'done' })
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

  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    // Only what the session needs before it starts is awaited, all at once; the strip's
    // readings fill in after, each part as soon as its own check answers.
    const [, saved, at] = await Promise.all([
      Promise.all([
        $.command.register({ name: 'ship', description: 'Commit (and optionally push) the working tree' }),
        $.command.register({ name: 'brief', description: 'Show where you left off in this project' }),
        $.command.register({ name: 'handoff', description: 'Update your handoff file (CURRENT.md / HANDOFF.md) from this conversation' }),
        $.command.register({ name: 'limits', description: 'Show today\'s 5h limit usage and forecast' }),
        $.command.register({
          name: 'strip',
          description: 'Turn strip parts on or off (all projects)',
          argumentHint: '[git|dev|limit|context|cache|next|all] or demo [green|yellow|red|next|ideas|play|off] or reload [fresh]',
        }),
      ]),
      $.store.get(HIDDEN_KEY),
      $.clock.now(),
    ])
    await Promise.all([
      update($, hidden, () => (Array.isArray(saved) ? saved.filter(x => typeof x === 'string') : [])),
      update($, now, () => at),
    ])

    loadReadings($, cwd, at)
    void (async () => {
      const stored = (await $.store.get(storeKey(cwd))) as Stored | undefined
      if (stored && (at - stored.lastAt) / 3_600_000 >= BRIEF_GAP_HOURS) await openBrief($, cwd, stored, at)
    })()

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
      const prompts = [...stored.prompts, e.text.trim().replace(/\s+/g, ' ').slice(0, 300)].slice(-5)
      await $.store.set(key, { ...stored, lastAt: await $.clock.now(), prompts }) // keep cacheAt
    }
    editedThisTurn = false
    if (e.text.trim() && !e.text.startsWith('/')) lastPrompt = e.text
    if ((await $.ui.panes()).some(p => p.id === BRIEF_PANE)) void $.ui.close({ id: BRIEF_PANE })
    if ((await read($, nextSteps)).isOpen) await update($, nextSteps, s => ({ ...s, isOpen: false }))
    if (await read($, stripMenu)) await update($, stripMenu, () => false)
    if (await read($, isChangesOpen)) await update($, isChangesOpen, () => false)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId) return result
    const options = extractNextSteps(e.answer)
    await update($, nextSteps, (): NextState => ({
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
      await $.store.set(storeKey(cwd), { ...stored, lastAt: at, cacheAt: cacheFrom, answerTail: e.answer.slice(-1500), options })
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
    if ('tool' in e && EDIT_TOOLS.has(e.tool) && !result.isError) {
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
      $.ui.toast(`Switching to ${e.to_model} drops the warm cache: ${tokensShort(e.context_tokens)} tokens re-cached (~$${e.estimated_cache_write_usd.toFixed(2)})`, { timeoutMs: 8000 })
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
    return {} // the pane or popup is the answer: no transcript line
  })

  on('command.run', { command: 'handoff' }, async $ => {
    void writeHandoff($, cwd)
    return { text: 'Writing the handoff from this conversation; you\'ll be asked before anything is saved.' }
  })

  on('command.run', { command: 'limits' }, async $ => {
    await $.ui.open({ id: LIMITS_PANE, title: '5h limit' })
    return {} // the pane or popup is the answer: no transcript line
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
      const first = s[0]
      const last = s[s.length - 1]
      if (!first || !last) return null
      const span = last.at - first.at
      return span >= FORECAST_MIN_SPAN_MS ? ((last.pct - first.pct) / span) * 3_600_000 : null
    })()
    const points = h.resetsAt === l.resetsAt ? h.points : []
    // Each column is a slice of the 5h window: past → last reading; future → the forecast line.
    const past: (number | null)[] = []
    const future: (number | null)[] = []
    for (let i = 0; i < width; i++) {
      const t = start + ((i + 1) / width) * WINDOW_MS
      if (t <= nowAt) {
        const before = points.filter(p => p.at <= t)
        past.push(before[before.length - 1]?.pct ?? null)
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
            <Text dimColor>{(axis[r] ?? '').padStart(3)} │</Text>
            <Text color={tone}>{row.slice(0, nowCol + 1)}</Text>
            <Text dimColor>{(futureRows[r] ?? '').slice(nowCol + 1)}</Text>
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
          const [lvl, ms] = DEMO_PLAY[i % DEMO_PLAY.length]!
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
    if (word === 'reload' || word === 'reload fresh') {
      await reloadStrip($, cwd, word === 'reload fresh')
      return {}
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
    const isOpened = await openBrief($, cwd, stored, await $.clock.now())
    // Opened: the pane says it all, no transcript line. Nothing to show: say why.
    return isOpened ? {} : { text: 'Nothing to brief yet in this folder: no earlier messages, git history or handoff file.' }
  })

  // ── the strip ─────────────────────────────────────────────────

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const [hiddenParts, isMenuOpen, writingHandoff, isOfferingUpdate] = await Promise.all([read($, hidden), read($, stripMenu), read($, isWritingHandoff), read($, autoUpdateOffer)])
    let [g, d, l, c, ctx, at, shipping, n] = await Promise.all([
      read($, git), read($, dev), read($, limit), read($, cache), read($, context), read($, now), read($, isShipping),
      read($, nextSteps),
    ])
    const demoLevel = (await read($, demo)) as DemoLevel | null
    const changesOpen = await read($, isChangesOpen)
    if (demoLevel) ({ g, d, l, c, ctx, n } = demoFixture(demoLevel, at || Date.now(), n))
    // Past its reset the window is empty, even before the next turn reports a new reading.
    if (l.resetsAt && (at || Date.now()) >= Date.parse(l.resetsAt)) l = { ...l, percent: 0, resetsAt: null, samples: [] }
    if (l.weekResetsAt && (at || Date.now()) >= Date.parse(l.weekResetsAt)) l = { ...l, weekPercent: 0, weekResetsAt: null }
    const cols = e.props.bodyColumns
    const isTight = cols < 60

    type Seg = {
      id: string; text: string; color?: string; dim?: boolean
      extras?: { text: string; color?: string; dim?: boolean; drop?: number }[] // more numbers, each with its own color; `drop`: lower goes first when narrow
      button?: { label: string; onPress: () => void }
      detail?: string // revealed after the text while the pointer is over the part (desktop)
      detailMode?: 'push' | 'over' // push the parts to its right aside, or cover them to the strip's end
      buttons?: { label: string; onPress: () => void }[] // more buttons after `button`
      detailButtons?: { label: string; onPress: () => void }[] // actions offered only on hover
      toggle?: { label: string; onPress: () => void } // a plain ▾ / ▴ right after the text (git's changes panel)
    }
    const segs: Seg[] = []
    const segTextLen = (s: Seg) => s.text.length + (s.extras ?? []).reduce((n, x) => n + x.text.length, 0)

    // The changes panel and next take turns: opening one closes the other.
    const toggleChanges = () => void (async () => {
      const isOpening = !(await read($, isChangesOpen))
      if (isOpening) {
        await update($, nextSteps, (s): NextState => ({ ...s, isOpen: false }))
        await update($, stripMenu, () => false)
        void refreshGit($)
      }
      await update($, isChangesOpen, () => isOpening)
    })()

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
        // Ship lives in the changes panel (▴), not on the strip.
        detail: [
          // One file: its name and line counts. More: how many, and the lines over all of them
          // (what's to push or pull is already on the strip).
          g.changed === 1 && g.stats?.[0] ? fileLine(g.stats[0])
            : g.changed > 1 ? `${g.changed} edits${g.added || g.removed ? ` +${g.added ?? 0} −${g.removed ?? 0}` : ''}` : '',
          !g.hasUpstream ? 'not on a remote yet' : '',
          // The last commit's files by name, and how long ago.
          g.lastFiles?.length
            ? `last: ${g.lastFiles.join(', ')}${g.lastFilesMore ? ` +${g.lastFilesMore} more` : ''}${g.lastAt ? ` · ${shortAge(at - g.lastAt * 1000)} ago` : ''}`
            : '',
        ].filter(Boolean).join(' · '),
        detailMode: 'push',
        toggle: { label: changesOpen ? '▾' : '▴', onPress: toggleChanges },
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
        detail: d.status === 'error' ? (d.error ?? 'see the dev server output')
          : d.status === 'up' ? `http://localhost:${d.port}`
          : d.status === 'down' ? `localhost:${d.port} is not running` : '',
        detailMode: 'push',
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
        detail: [
          l.resetsAt ? `resets ${hhmm(l.resetsAt)}` : '',
          fullAt !== null ? `full ~${hhmmAt(fullAt)}` : '',
          l.weekPercent !== null ? `7d ${Math.round(l.weekPercent)}%` : '',
          ctx.usd ? `$${ctx.usd.toFixed(2)}` : '',
        ].filter(Boolean).join(' · '),
      })
    }

    // context window
    const isContextRed = ctx.percent !== null && Math.round(ctx.percent) >= CONTEXT_RED_PCT
    if (ctx.percent !== null) {
      const pct = Math.round(ctx.percent)
      const k = ctx.tokens !== null && !isTight ? ` · ${tokensShort(ctx.tokens)}` : ''
      segs.push({
        id: 'context',
        text: `ctx ${pct}%${k}`,
        color: pct >= CONTEXT_RED_PCT ? 'error' : pct >= CONTEXT_YELLOW_PCT ? 'warning' : 'success',
        button: isContextRed && !writingHandoff ? { label: 'Handoff', onPress: () => void writeHandoff($, cwd) } : undefined,
        buttons: isContextRed ? [{ label: 'Compact', onPress: () => void compactNow($) }] : undefined,
        detail: [
          `${100 - pct}% free`,
          ctx.window ? `of ${tokensShort(ctx.window)}` : '',
        ].filter(Boolean).join(' '),
        // On hover at any fill: the same two, as icons (handoff, compact).
        detailButtons: isContextRed ? undefined : [
          ...(writingHandoff ? [] : [{ label: '📝', onPress: () => void writeHandoff($, cwd) }]),
          { label: '♻️', onPress: () => void compactNow($) },
        ],
        detailMode: 'push',
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
            ? [{ text: ` · switch re-sends ${tokensShort(ctx.tokens ?? 0)}`, dim: true, drop: 1 }] : []),
        ],
        // On a small context, re-sending it costs less than a compaction (which reads it all and writes a summary).
        button: timeTone === 'error' && !isContextRed && !c.resetReason && (ctx.percent ?? 0) >= CACHE_COMPACT_MIN_PCT ? { label: 'Compact', onPress: () => void compactNow($) } : undefined,
        detail: [
          cold || c.resetReason
            ? `the next message re-sends ${ctx.tokens ? `~${tokensShort(ctx.tokens)}` : 'the conversation'} at full price`
            : c.lastTurnAt ? `expires ${hhmmAt(c.lastTurnAt + ttl * 60_000)} if idle` : '',
          `${ttl}m lifetime${isShort ? ' (extra usage)' : ''}`,
        ].filter(Boolean).join(' · '),
        detailMode: 'push',
      })
    }

    // next steps toggle
    const toggleNext = () => {
      void update($, isChangesOpen, () => false)
      void update($, nextSteps, (s): NextState => ({ ...s, isOpen: !s.isOpen, view: 'main' }))
    }
    if (!changesOpen) segs.push({
      id: 'next', text: '',
      button: { label: n.isOpen ? 'next ▾' : n.fromAnswer.length ? `next ${n.fromAnswer.length} ▴` : 'next ▴', onPress: toggleNext },
    })

    if (demoLevel) {
      for (const s of segs) {
        if (s.button && s.id !== 'next') s.button = { ...s.button, onPress: () => $.ui.toast('Demo mode: buttons are off. /strip demo off to exit') }
        if (s.buttons) s.buttons = s.buttons.map(b => ({ ...b, onPress: () => $.ui.toast('Demo mode: buttons are off. /strip demo off to exit') }))
      }
    }

    // Narrow: first the optional extras (switch hint, then % read, then 7d), then whole parts:
    // dev, git, context, next. Limit + cache always stay.
    const width = (s: Seg) => s.text.length + (s.extras ?? []).reduce((w, x) => w + x.text.length, 0) + (s.button ? s.button.label.length + 5 : 0)
      + (s.toggle ? 2 : 0)
      + (s.buttons ?? []).reduce((w, b) => w + b.label.length + 5, 0) + 3
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
        {/* Clipped at its edge: a long hover detail pushes the parts after it out of view, never into "next". */}
        <Box flexDirection="row" flexShrink={1} overflow="hidden">
        {leftSegs.map((s, i) => (
          // No gaps between parts: each part's hover area runs up to the next one, so crossing never drops the details.
          <Box key={s.id} flexDirection="row" gap={1} paddingRight={1}>
            {i > 0 && <Text dimColor>│</Text>}
            {/* Keyed: the hover scope is the text alone, so ▾ and the buttons beside it take a click without the details opening. */}
            <Box key={`${s.id}-main`} flexDirection="row">
              {s.text !== '' && <Text color={s.color} dimColor={s.dim} wrap="truncate">{s.text}</Text>}
              {(s.extras ?? []).map(x => <Text color={x.color} dimColor={x.dim} wrap="truncate">{x.text}</Text>)}
              {s.detail && (
                s.detailMode === 'over'
                  // Written over the parts to its right while hovered, on the same line: nothing moves.
                  ? <Box display="none" position="absolute" top={0} left={segTextLen(s)} width={s.detail.length + 3} backgroundColor={STRIP_FRAME_BG} hover={{ display: 'flex' }}>
                      <Text dimColor wrap="truncate">{` · ${s.detail}`}</Text>
                    </Box>
                  // Pushes the parts to its right aside while hovered.
                  : <Box display="none" gap={1} hover={{ display: 'flex' }}>
                      <Text dimColor wrap="truncate">{` · ${s.detail}`}</Text>
                      {(s.detailButtons ?? []).map((b, i) => <Button key={`${s.id}-hover-btn-${i}`} label={b.label} onPress={b.onPress} />)}
                    </Box>
              )}
            </Box>
            {/* A button and the panel's arrow sit tight together, no gap. */}
            {s.button && s.toggle && (
              <Box flexDirection="row">
                <Button key={`${s.id}-btn`} label={s.button.label} onPress={s.button.onPress} />
                <Button key={`${s.id}-toggle`} plain label={s.toggle.label} onPress={s.toggle.onPress} />
              </Box>
            )}
            {s.button && !s.toggle && <Button key={`${s.id}-btn`} label={s.button.label} onPress={s.button.onPress} />}
            {s.toggle && !s.button && <Button key={`${s.id}-toggle`} plain label={s.toggle.label} onPress={s.toggle.onPress} />}
            {(s.buttons ?? []).map((b, i) => <Button key={`${s.id}-btn-${i}`} label={b.label} onPress={b.onPress} />)}
          </Box>
        ))}
        </Box>
        {nextSeg?.button && (
          // A Button can't be colored: "next" carries the gradient, the arrow is a full bracketed button.
          <Box flexDirection="row" gap={1} flexShrink={0} marginLeft={1}>
            {gradient(nextSeg.button.label.replace(/\s*[▾▴]$/, ''), IDEAS_FROM, IDEAS_TO)}
            <Button key="next-btn" plain label={n.isOpen ? ' ▾  ' : ' ▴  '} onPress={nextSeg.button.onPress} />
          </Box>
        )}
      </Box>
    )
    // Once after a marketplace install: auto-update, answered right here (never through the model).
    // A question in a row under the strip (Ship, resend): its options, the first one primary, and Cancel.
    const ask = demoLevel ? null : await read($, rowAsk)
    if (!n.isOpen && !isMenuOpen && !changesOpen && ask) {
      return (
        <Box flexDirection="column">
          {strip}
          <Box flexDirection="row" gap={1}>
            <Text dimColor wrap="truncate">{ask.text}</Text>
            {ask.options.map((option, i) => (
              <Button key={`ask-${i}`} variant={i === 0 ? 'primary' : undefined} label={option} onPress={() => void answerRow($, option)} />
            ))}
            <Button key="ask-cancel" label="Cancel" onPress={() => void answerRow($, null)} />
          </Box>
        </Box>
      )
    }
    // The handoff, one step at a time in a row under the strip: Write / Cancel, then start over from it or keep going.
    const step = demoLevel ? null : await read($, handoffStep)
    if (!n.isOpen && !isMenuOpen && !changesOpen && step) {
      const close = () => void update($, handoffStep, () => null)
      return (
        <Box flexDirection="column">
          {strip}
          {step.stage === 'draft' ? (
            <Box flexDirection="row" gap={1}>
              <Text dimColor>{`${step.name} ready · ${step.isNew ? `new file · ${step.added} lines` : `+${step.added} −${step.removed} lines`}`}</Text>
              <Button key="ho-write" variant="primary" label="Write" onPress={() => void saveHandoff($, cwd)} />
              <Button key="ho-cancel" label="Cancel" onPress={close} />
            </Box>
          ) : (
            <Box flexDirection="row" gap={1}>
              <Text dimColor>{`${step.name} saved`}</Text>
              <Button key="ho-continue" variant="primary" label="Clear & continue" onPress={() => void clearAfterHandoff($, step.name, true)} />
              <Button key="ho-clear" label="Clear" onPress={() => void clearAfterHandoff($, step.name, false)} />
              <Button key="ho-later" label="Not now" onPress={close} />
            </Box>
          )}
        </Box>
      )
    }
    if (!n.isOpen && !isMenuOpen && !changesOpen && isOfferingUpdate && !demoLevel) {
      return (
        <Box flexDirection="column">
          {strip}
          <Box flexDirection="row" gap={1}>
            {gradient('OneLiner', IDEAS_FROM, IDEAS_TO)}
            <Text dimColor>keep up to date automatically?</Text>
            <Button key="au-yes" label="Yes" onPress={() => void saveAutoUpdate($, true)} />
            <Button key="au-no" label="No" onPress={() => void saveAutoUpdate($, false)} />
          </Box>
        </Box>
      )
    }
    if (!n.isOpen && !isMenuOpen && !changesOpen) return strip

    // The slide-up: picks fill the prompt (never send), 1–4 / s / 0 as hotkeys.
    const pick = (text: string) => {
      void $.prompt.fill({ text: cleanMd(text), mode: 'replace' })
      void update($, nextSteps, (s): NextState => ({ ...s, isOpen: false, view: 'main' }))
    }
    const goTo = (view: 'main' | 'suggest') => update($, nextSteps, s => ({ ...s, view }))
    const via = n.aiVia ?? suggestVia(c, l, at)
    const runsOn = via === 'cache'
      ? `${shortModel(n.model)} · from cache${ctx.tokens ? ` ~${tokensShort(ctx.tokens)}` : ''}`
      : `${shortModel(SMART_MODEL)} · ~3k`

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
    const styledRow = (key: string, hotkey: string, content: RenderChildren, onPress: () => void) => (
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

    // Changes (git's ▾): each changed file with its line counts (a pick shows its diff), the commits
    // waiting to push, then Ship, the whole diff and a pull request.
    if (changesOpen) {
      const closeChanges = () => void update($, isChangesOpen, () => false)
      const stats = g.stats ?? []
      const paths = stats.map(s => s.path)
      const toPush = g.toPush ?? []
      const pathMax = Math.max(16, Math.min(48, cols - 24, Math.max(...stats.map(s => s.path.length), 0) + 2))
      const fitPath = (p: string) => (p.length > pathMax ? `…${p.slice(-(pathMax - 2))}` : p)
      // Fixed-width cells, so the numbers line up even where the font is proportional (desktop).
      const addW = Math.max(2, ...stats.map(s => `+${s.added}`.length))
      const delW = Math.max(2, ...stats.map(s => `−${s.removed}`.length))
      const canShip = (g.changed > 0 || g.ahead > 0) && !shipping
      const canPr = g.isRepo && !DEFAULT_BRANCHES.has(g.branch) && !g.conflicts && !g.operation && !shipping
      return (
        <Box flexDirection="column">
          {strip}
          {title('changes', [g.branch, g.ahead ? `${g.ahead} to push` : '', g.behind ? `${g.behind} to pull` : ''].filter(Boolean).join(' · '))}
          {stats.length === 0 && note('no changes since the last commit')}
          {stats.slice(0, 9).map((s, i) => styledRow(`ch-${i}`, String(i + 1), (
            <Box flexDirection="row">
              <Box width={pathMax} flexShrink={0}><Text wrap="truncate">{fitPath(s.path)}</Text></Box>
              {s.kind === 'edit' ? (
                <Box flexDirection="row" gap={1} flexShrink={0}>
                  <Box width={addW} justifyContent="flex-end"><Text color="success">{`+${s.added}`}</Text></Box>
                  <Box width={delW} justifyContent="flex-end"><Text color="error">{`−${s.removed}`}</Text></Box>
                </Box>
              ) : (
                <Box width={addW + 1 + delW} justifyContent="flex-end" flexShrink={0}><Text dimColor>{s.kind}</Text></Box>
              )}
            </Box>
          ), () => void openDiff($, paths, i)))}
          {stats.length > 9 && note(`+${stats.length - 9} more`)}
          {toPush.length > 0 && rule}
          {toPush.slice(0, 3).map((subject, i) => (
            <Box key={`push-${i}`} marginLeft={4}><Text dimColor wrap="truncate">{`↑ ${shortLabel(subject, labelMax)}`}</Text></Box>
          ))}
          {toPush.length > 3 && note(`+${toPush.length - 3} more to push`)}
          {rule}
          <Box flexDirection="row" width={cols} justifyContent="space-between">
            <Box flexDirection="row" gap={1} marginLeft={2}>
              {canShip && <Button key="ch-ship" variant="primary" label="Ship" onPress={() => { closeChanges(); void ship($) }} />}
              {stats.length > 0 && <Button key="ch-diff" label={`+${g.added ?? 0} −${g.removed ?? 0}`} onPress={() => void openDiff($, paths, 0)} />}
              {canPr && <Button key="ch-pr" label="Create PR" onPress={() => { closeChanges(); void createPr($) }} />}
            </Box>
            <Button key="ch-close" role="dismiss" label="Close" onPress={closeChanges} />
          </Box>
        </Box>
      )
    }

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
    const fill = (step: string) => void $.prompt.fill({ text: step, mode: 'replace' })
    const firstStep = b.next[0]
    const label = (text: string) => <Box flexShrink={0} width={6}><Text dimColor>{text}</Text></Box>
    // A labelled line whose text wraps in full instead of being cut off.
    const line = (name: string, text: string, isDim = false) => (
      <Box flexDirection="row">{label(name)}<Box flexShrink={1}><Text dimColor={isDim} wrap="wrap">{text}</Text></Box></Box>
    )
    const repo = b.branch
      ? [b.branch, b.ahead ? `${b.ahead} unpushed` : '', b.changed ? `${b.changed} changed` : ''].filter(Boolean).join(' · ')
      : ''
    return (
      <Box flexDirection="column" gap={0}>
        <Text bold>{b.project}{b.awayHours ? ` · away ${b.awayHours}h` : ''}</Text>
        {b.status === 'loading' && <Text dimColor italic>  summarizing…</Text>}
        {b.goal && line('Goal', b.goal)}
        {b.done && line('Done', b.done)}
        {b.next.length > 0 && label('Next')}
        {b.next.map((step, i) => (
          // One step per line, stacked; the number is the button (and hotkey), the text wraps in full beside it.
          <Box key={`next-${i}`} flexDirection="row" gap={1} marginLeft={2}>
            <Box flexShrink={0}><Button key={`next-${i}-b`} plain hotkey={String(i + 1)} label="›" onPress={() => fill(step)} /></Box>
            <Box flexShrink={1}><Text wrap="wrap">{step}</Text></Box>
          </Box>
        ))}
        {b.status === 'none' && <Text dimColor>  Nothing open found.</Text>}
        {repo && line('Repo', repo, true)}
        {b.commits[0] && line('Last', b.commits[0], true)}
        <Box flexDirection="row" gap={1} marginTop={1}>
          {firstStep && <Button key="continue" variant="primary" label="Continue with 1" onPress={() => fill(firstStep)} />}
          <Button key="dismiss" role="dismiss" label="Dismiss" onPress={() => void $.ui.close({ id: BRIEF_PANE })} />
        </Box>
      </Box>
    )
  })

  // ── the diff pane ─────────────────────────────────────────────

  on('ui.render', { component: 'Pane', requestId: DIFF_PANE }, async ($, e) => {
    const { Box, Text, Button, Code } = $.ui.resolve(e)
    const v = await read($, diffView)
    if (!v) return <Text dimColor>No diff open.</Text>
    const path = v.paths[v.index] ?? ''
    const count = v.paths.length
    const go = (i: number) => void openDiff($, v.paths, (i + count) % count)
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text bold>{path}</Text>
          {count > 1 && <Text dimColor>{`${v.index + 1} of ${count}`}</Text>}
        </Box>
        {v.text ? <Code source={v.text} format="diff" path={path} /> : null}
        {v.note && <Text dimColor italic>{v.note}</Text>}
        <Box flexDirection="row" gap={1} marginTop={1}>
          {count > 1 && <Button key="diff-prev" label="‹ Previous" onPress={() => go(v.index - 1)} />}
          {count > 1 && <Button key="diff-next" label="Next ›" onPress={() => go(v.index + 1)} />}
          <Button key="diff-close" role="dismiss" label="Close" onPress={() => void $.ui.close({ id: DIFF_PANE })} />
        </Box>
      </Box>
    )
  })
}
