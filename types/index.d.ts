export type GitState = {
  isRepo: boolean
  branch: string
  changed: number
  ahead: number
  behind: number
  hasUpstream: boolean
  /** Unmerged files (porcelain v2 `u` lines). */
  conflicts: number
  /** An unfinished merge / rebase / cherry-pick / revert, else null. */
  operation: string | null
}

export type DevState = {
  port: number | null
  status: 'none' | 'down' | 'up' | 'error' | 'starting'
  error: string | null
}

export type LimitState = {
  percent: number | null
  resetsAt: string | null
  warnedFor: string | null
  /** Any window at 100%+: extra usage, where the prompt cache drops to 5 minutes. */
  isOverage: boolean
  /** Recent 5h readings (last 30 min of this window) for the fill-time forecast. */
  samples: { at: number; pct: number }[]
  forecastWarnedFor: string | null
  /** The weekly window, shown only when it gets high. */
  weekPercent: number | null
  weekResetsAt: string | null
}

export type ContextState = {
  /** Share of the model's context window the last response used, 0–100. */
  percent: number | null
  tokens: number | null
  window: number | null
}

export type CacheState = {
  lastTurnAt: number | null
  readPercent: number | null
  /** Cache lifetime the engine last reported (model-switch hooks), in minutes. */
  reportedTtl: number | null
  /** Set when a setting change (effort, thinking, fast mode) empties the conversation cache. */
  resetReason: string | null
}

export type NextState = {
  isOpen: boolean
  /** Options Claude itself offered at the end of its last answer (free). */
  fromAnswer: string[]
  /** Model suggestions, generated only on request, at most once per turn. */
  ai: string[]
  /** Absolute grade per idea: 3 gold, 2 silver, 1 bronze, 0 ungraded. */
  aiGrades: number[]
  /** Grade per fromAnswer option: a free "I recommend" guess, replaced by the model's grade once ideas run. */
  optionGrades: number[]
  aiStatus: 'idle' | 'loading' | 'done' | 'error'
  aiVia: 'cache' | 'haiku' | null
  /** End of the last answer, for the Haiku digest. */
  answerTail: string
  /** Which screen of the slide-up: Claude's own options, or the model suggestions. */
  view: 'main' | 'suggest'
  /** The model that answered the last turn (what a cached suggestion runs on). */
  model: string | null
}

export type Brief = {
  project: string
  awayHours: number
  openItems: string[]
  lastPrompts: string[]
  commits: string[]
  changed: number
}

declare module 'claude-code' {
  interface PluginState {
    oneliner: {
      git: GitState
      dev: DevState
      limit: LimitState
      cache: CacheState
      context: ContextState
      next: NextState
      /** Strip parts switched off with /strip (mirrors the global $.store value). */
      hidden: string[]
      isStripMenuOpen: boolean
      /** The upstream commit last seen after a fetch (for the "someone pushed" popup). */
      remoteSeen: string | null
      /** True while /handoff is writing. */
      isWritingHandoff: boolean
      /** /strip demo: sample values for screenshots (green, yellow, red, next, ideas), or null. */
      demo: string | null
      now: number
      brief: Brief | null
      isShipping: boolean
    }
  }
}
