/** How far a piece of work is from being live, and what the system recommends. */
export type Readiness = 'ready' | 'waiting' | 'blocked' | 'wip'

/** What pressing Ship does for this item. */
export type ShipAction =
  | { kind: 'merge-pr'; repo: string; number: number; sha: string }
  | { kind: 'push-branch'; dir: string; branch: string }

export type ShipItem = {
  /** Stable id: repo plus PR number, branch or local path. */
  id: string
  repo: string
  /** Where the code sits today. */
  where: 'local-uncommitted' | 'local-unpushed' | 'branch-no-pr' | 'pr'
  title: string
  readiness: Readiness
  /** One line: why it has this readiness. */
  reason: string
  /** Size, checks, age: drawn dim. */
  detail: string
  action?: ShipAction
  /** The branch behind it, for matching a new PR to an auto-ship request. */
  ref?: string
  /** The Claude chat that wrote this code, from a Claude-Session line in its commits or PR. */
  chat?: string
  /** A button that hands the item to Claude to move it forward. */
  fix?: ShipFix
}

/** What the Fix button asks Claude to do; Claude's work comes back through the queue. */
export type ShipFix = {
  label: string
  prompt: string
  /** When set, pressing asks this first, and on Confirm the PR ships itself once green. */
  confirm?: string
  autoShip?: AutoShip
}

/** A branch the person approved for production: merged as soon as its PR is green. */
export type AutoShip = { repo: string; ref: string; at: number }

/** A PR merged into the default branch: live. */
export type Shipped = { repo: string; number: number; title: string; mergedAt: string; chat?: string }

export type ShipLog = { at: number; text: string; isError: boolean }

declare module 'claude-code' {
  interface PluginState {
    'ship-queue': {
      items: ShipItem[]
      checkedAt: number
      isScanning: boolean
      /** The item whose Ship button was pressed and awaits Confirm. */
      confirming: string
      /** The item being shipped right now. */
      shipping: string
      log: ShipLog[]
      /** Recently merged PRs, newest first. */
      shipped: Shipped[]
      /** Items handed to Claude with a Fix button this session. */
      asked: string[]
      errors: string[]
      /** Branches approved to ship once their PR is green. */
      autoShip: AutoShip[]
    }
  }
}
