/**
 * Local DSH bundle auditing and bounded Loader lifecycle observation.
 * @module dsh-plugin-observatory
 */

import { Context, FiberState, Service } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, JsonValue } from '@deepseek-ai/dsh-tools'
import { auditPackageDirectory, resolveAllowedRoots, resolveHostVersions } from './audit.js'
import type { HostVersionSnapshot } from './audit.js'
import type {
  PluginAuditReport,
  PluginRuntimeEntryObservation,
  PluginRuntimePhase,
  PluginRuntimeSnapshot,
  PluginRuntimeTransition,
} from './types.js'

export type * from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Read-only local plugin audit and Loader lifecycle observation. */
    pluginObservatory: PluginObservatoryService
  }
}

/** Observatory deployment configuration. */
export interface Config {
  /** Package directories must resolve beneath one of these roots. Defaults to the process working directory. */
  readonly allowedRoots?: string[]
  /** Inclusive UTF-8 byte limit for package.json. Defaults to 256 KiB. */
  readonly maxManifestBytes?: number
  /** Inclusive UTF-8 byte limit for the declared bundle patch. Defaults to 1 MiB. */
  readonly maxPatchBytes?: number
  /** Maximum object/array nesting depth accepted in a parsed bundle patch. Defaults to 64. */
  readonly maxPatchDepth?: number
  /** Maximum object/array visits accepted while traversing a parsed bundle patch. Defaults to 10,000. */
  readonly maxPatchNodes?: number
  /** Maximum entry histories retained in memory. Defaults to 256. */
  readonly maxObservedEntries?: number
  /** Maximum recent transitions retained for one entry. Defaults to 64. */
  readonly maxTransitionsPerEntry?: number
}

interface ResolvedConfig {
  readonly allowedRoots: readonly string[]
  readonly maxManifestBytes: number
  readonly maxPatchBytes: number
  readonly maxPatchDepth: number
  readonly maxPatchNodes: number
  readonly hostVersions: HostVersionSnapshot
  readonly maxObservedEntries: number
  readonly maxTransitionsPerEntry: number
}

const DEFAULT_MAX_MANIFEST_BYTES = 256 * 1024
const DEFAULT_MAX_PATCH_BYTES = 1024 * 1024
const DEFAULT_MAX_PATCH_DEPTH = 64
const DEFAULT_MAX_PATCH_NODES = 10_000
const DEFAULT_MAX_OBSERVED_ENTRIES = 256
const DEFAULT_MAX_TRANSITIONS_PER_ENTRY = 64
const MAX_AUDIT_FILE_BYTES = 32 * 1024 * 1024
const MAX_PATCH_DEPTH = 256
const MAX_PATCH_NODES = 100_000

const FIBER_STATE = {
  PENDING: 0 as FiberState.PENDING,
  LOADING: 1 as FiberState.LOADING,
  ACTIVE: 2 as FiberState.ACTIVE,
  FAILED: 3 as FiberState.FAILED,
  DISPOSED: 4 as FiberState.DISPOSED,
  UNLOADING: 5 as FiberState.UNLOADING,
} as const

const RUNTIME_PHASE: Record<FiberState, PluginRuntimePhase> = {
  [FIBER_STATE.PENDING]: 'pending',
  [FIBER_STATE.LOADING]: 'loading',
  [FIBER_STATE.ACTIVE]: 'active',
  [FIBER_STATE.FAILED]: 'failed',
  [FIBER_STATE.DISPOSED]: 'disposed',
  [FIBER_STATE.UNLOADING]: 'unloading',
}

function positiveInteger(name: string, value: number, maximum?: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || (maximum !== undefined && value > maximum)) {
    const bound = maximum === undefined ? 'a positive safe integer' : `a positive safe integer no greater than ${maximum}`
    throw new Error(`observatory: ${name} must be ${bound}, got ${String(value)}`)
  }
  return value
}

function rootEntry(fiber: Fiber): Entry | undefined {
  const entry = fiber.entry
  if (entry === undefined || fiber.parent.fiber.entry === entry) return undefined
  return entry
}

function presentAuditCall(args: { package_path: string }): GenericCallView {
  return {
    card: 'generic',
    title: `Audit DSH plugin ${args.package_path}`,
    kind: 'search',
    locations: [{ path: args.package_path }],
  }
}

function presentObserveCall(args: { entry_id?: string }): GenericCallView {
  return {
    card: 'generic',
    title: args.entry_id === undefined ? 'Observe DSH plugins' : `Observe DSH plugin ${args.entry_id}`,
    kind: 'search',
    ...args.entry_id === undefined ? {} : { rawInput: args.entry_id },
  }
}

/** Local audit service and Loader lifecycle history owner. */
export class PluginObservatoryService extends Service {
  static inject = ['loader', 'tools']

  static Config: z<Config> = z.object({
    allowedRoots: z.array(z.string().min(1)).min(1).default([process.cwd()]),
    maxManifestBytes: z.number().step(1).min(1).max(MAX_AUDIT_FILE_BYTES).default(DEFAULT_MAX_MANIFEST_BYTES),
    maxPatchBytes: z.number().step(1).min(1).max(MAX_AUDIT_FILE_BYTES).default(DEFAULT_MAX_PATCH_BYTES),
    maxPatchDepth: z.number().step(1).min(1).max(MAX_PATCH_DEPTH).default(DEFAULT_MAX_PATCH_DEPTH),
    maxPatchNodes: z.number().step(1).min(1).max(MAX_PATCH_NODES).default(DEFAULT_MAX_PATCH_NODES),
    maxObservedEntries: z.number().step(1).min(1).default(DEFAULT_MAX_OBSERVED_ENTRIES),
    maxTransitionsPerEntry: z.number().step(1).min(1).default(DEFAULT_MAX_TRANSITIONS_PER_ENTRY),
  })

  private readonly resolved: ResolvedConfig
  private readonly histories = new Map<string, PluginRuntimeTransition[]>()

  /** Register the service, read-only tools, and the root-Fiber observer. */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'pluginObservatory')
    this.resolved = {
      allowedRoots: resolveAllowedRoots(config.allowedRoots ?? [process.cwd()]),
      maxManifestBytes: positiveInteger('maxManifestBytes', config.maxManifestBytes ?? DEFAULT_MAX_MANIFEST_BYTES, MAX_AUDIT_FILE_BYTES),
      maxPatchBytes: positiveInteger('maxPatchBytes', config.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES, MAX_AUDIT_FILE_BYTES),
      maxPatchDepth: positiveInteger('maxPatchDepth', config.maxPatchDepth ?? DEFAULT_MAX_PATCH_DEPTH, MAX_PATCH_DEPTH),
      maxPatchNodes: positiveInteger('maxPatchNodes', config.maxPatchNodes ?? DEFAULT_MAX_PATCH_NODES, MAX_PATCH_NODES),
      maxObservedEntries: positiveInteger('maxObservedEntries', config.maxObservedEntries ?? DEFAULT_MAX_OBSERVED_ENTRIES),
      maxTransitionsPerEntry: positiveInteger(
        'maxTransitionsPerEntry',
        config.maxTransitionsPerEntry ?? DEFAULT_MAX_TRANSITIONS_PER_ENTRY,
      ),
      hostVersions: resolveHostVersions([...ctx.loader.entries()].map(entry => entry.options.name)),
    }
    const seededAt = Date.now()
    for (const entry of ctx.loader.entries()) {
      if (entry.options.group || entry.fiber === undefined) continue
      this.storeTransition(entry.id, {
        from: 'not-loaded',
        to: RUNTIME_PHASE[entry.fiber.state],
        at: seededAt,
      })
    }
    ctx.on('internal/status', (fiber, oldState) => {
      const entry = rootEntry(fiber)
      if (entry === undefined || entry.options.group) return
      const history = this.histories.get(entry.id)
      const now = Date.now()
      const previous = history?.at(-1)
      this.storeTransition(entry.id, {
        from: RUNTIME_PHASE[oldState],
        to: RUNTIME_PHASE[fiber.state],
        at: now,
        ...previous === undefined ? {} : { durationMs: Math.max(0, now - previous.at) },
      })
    }, { global: true })
    this.registerTools(ctx)
  }

  /**
   * Inspect one local package without importing its code or evaluating patch expressions.
   * @param packagePath - absolute path, or a path resolved from `cwd`.
   * @param cwd - resolution base for a relative package path.
   * @param signal - caller cancellation.
   * @returns deterministic compatibility and risk findings.
   * @throws when the requested path falls outside configured roots or file I/O fails unexpectedly.
   */
  audit(packagePath: string, cwd: string, signal?: AbortSignal): Promise<PluginAuditReport> {
    return auditPackageDirectory(this.resolved, {
      packagePath,
      cwd,
      ...signal === undefined ? {} : { signal },
    })
  }

  /**
   * Read current Loader entries with their retained lifecycle transitions.
   * @param entryId - exact Loader entry id, or omitted for every current non-group entry.
   * @returns a detached point-in-time snapshot in Loader order.
   */
  snapshot(entryId?: string): PluginRuntimeSnapshot {
    const entries: PluginRuntimeEntryObservation[] = []
    for (const entry of this.ctx.loader.entries()) {
      if (entry.options.group || (entryId !== undefined && entry.id !== entryId)) continue
      entries.push({
        entryId: entry.id,
        moduleName: entry.options.name,
        enabled: !entry.disabled,
        phase: entry.fiber === undefined ? 'not-loaded' : RUNTIME_PHASE[entry.fiber.state],
        transitions: [...(this.histories.get(entry.id) ?? [])],
      })
    }
    return { capturedAt: Date.now(), entries }
  }

  /**
   * Assert that the latest retained transition represents one just-delivered root-Fiber status event.
   * The invariant companion calls this after the service's earlier listener records the event.
   * @param fiber - Fiber from `internal/status`.
   * @param oldState - state before the delivered transition.
   * @param fail - package-attributed invariant reporter.
   */
  assertObservedTransition(fiber: Fiber, oldState: FiberState, fail: (message: string) => never): void {
    const entry = rootEntry(fiber)
    if (entry === undefined || entry.options.group) return
    const latest = this.histories.get(entry.id)?.at(-1)
    const expectedFrom = RUNTIME_PHASE[oldState]
    const expectedTo = RUNTIME_PHASE[fiber.state]
    if (latest === undefined || latest.from !== expectedFrom || latest.to !== expectedTo) {
      fail(`Loader entry ${JSON.stringify(entry.id)} latest transition must be ${expectedFrom} -> ${expectedTo}`)
    }
  }

  private storeTransition(entryId: string, transition: PluginRuntimeTransition): void {
    let history = this.histories.get(entryId)
    if (history === undefined) {
      if (this.histories.size >= this.resolved.maxObservedEntries) {
        const oldest = this.histories.keys().next().value
        if (oldest !== undefined) this.histories.delete(oldest)
      }
      history = []
    } else {
      this.histories.delete(entryId)
    }
    history.push(transition)
    if (history.length > this.resolved.maxTransitionsPerEntry) history.splice(0, history.length - this.resolved.maxTransitionsPerEntry)
    this.histories.set(entryId, history)
  }

  private registerTools(ctx: Context): void {
    ctx.tools.register(defineTool({
      name: 'plugin_audit',
      description:
        'Statically inspect a local DSH plugin package before installation or activation. The report checks the '
        + 'dsh.bundle manifest, patch rows, runtime dependency declarations, DSH/Cordis/Node peer ranges, install '
        + 'scripts, path containment, and unevaluated !!js expressions. It never imports target JavaScript or '
        + 'evaluates patch expressions. Use an absolute path for an installed package, or a workspace-relative path.',
      parameters: {
        package_path: { type: 'string', required: true, description: 'Local package directory beneath a configured audit root.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      isConcurrencySafe: () => true,
      execute: async (args, exec) => {
        const packagePath = args.package_path.trim()
        if (packagePath === '') throw new Error('plugin_audit package_path must not be blank')
        const cwd = exec.agent?.session.header.cwd ?? process.cwd()
        return await this.audit(packagePath, cwd, exec.signal) as unknown as JsonValue
      },
      presentCall: presentAuditCall,
    }))

    ctx.tools.register(defineTool({
      name: 'plugin_observe',
      description:
        'Read the current DSH Loader entries and the bounded root-Fiber lifecycle transitions observed since this '
        + 'plugin loaded. The report is read-only and can be filtered by exact Loader entry id.',
      parameters: {
        entry_id: { type: 'string', description: 'Exact Loader entry id; omit it to list every current non-group entry.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      isConcurrencySafe: () => true,
      execute: (args) => {
        const entryId = args.entry_id?.trim()
        if (entryId === '') throw new Error('plugin_observe entry_id must not be blank')
        return Promise.resolve(this.snapshot(entryId) as unknown as JsonValue)
      },
      presentCall: presentObserveCall,
    }))
  }
}

export default PluginObservatoryService
