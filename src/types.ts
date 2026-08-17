/** Machine-readable results produced by the DSH Observatory. */

/** Audit severity; only `error` makes a package incompatible. */
export type PluginAuditSeverity = 'info' | 'warning' | 'error'

/** Overall static compatibility result. */
export type PluginAuditVerdict = 'compatible' | 'needs-review' | 'incompatible'

/** One deterministic compatibility or risk finding. */
export interface PluginAuditIssue {
  readonly severity: PluginAuditSeverity
  readonly code: string
  readonly message: string
  readonly path?: string
}

/** Manifest fields relevant to installation and compatibility. */
export interface PluginAuditManifest {
  readonly name?: string
  readonly version?: string
  readonly license?: string
  readonly bundlePatch?: string
  readonly nodeRange?: string
}

/** One plugin row inserted by the audited patch layer. */
export interface PluginAuditEntry {
  readonly id: string
  readonly moduleName: string
  readonly nestedUnder?: string
}

/** One unevaluated `!!js` expression found in the bundle patch. */
export interface PluginAuditExpression {
  readonly path: string
  readonly expression: string
}

/** Static bundle facts extracted without loading package code. */
export interface PluginAuditBundle {
  readonly patchPath: string
  readonly insertedEntries: readonly PluginAuditEntry[]
  readonly targetedEntryIds: readonly string[]
  readonly expressions: readonly PluginAuditExpression[]
}

/** Reproducible package audit report; it deliberately carries no timestamp. */
export interface PluginAuditReport {
  readonly reportVersion: 1
  readonly packageDir: string
  readonly host: {
    readonly dshVersion: string
    readonly nodeVersion: string
  }
  readonly verdict: PluginAuditVerdict
  readonly manifest?: PluginAuditManifest
  readonly bundle?: PluginAuditBundle
  readonly issues: readonly PluginAuditIssue[]
}

/** Lifecycle phase projected from one Loader entry's root Fiber. */
export type PluginRuntimePhase =
  | 'not-loaded'
  | 'pending'
  | 'loading'
  | 'active'
  | 'failed'
  | 'unloading'
  | 'disposed'

/** One observed root-Fiber phase transition. */
export interface PluginRuntimeTransition {
  readonly from: PluginRuntimePhase
  readonly to: PluginRuntimePhase
  readonly at: number
  readonly durationMs?: number
}

/** Current Loader entry plus its bounded in-process transition history. */
export interface PluginRuntimeEntryObservation {
  readonly entryId: string
  readonly moduleName: string
  readonly enabled: boolean
  readonly phase: PluginRuntimePhase
  readonly transitions: readonly PluginRuntimeTransition[]
}

/** Point-in-time Loader lifecycle report. */
export interface PluginRuntimeSnapshot {
  readonly capturedAt: number
  readonly entries: readonly PluginRuntimeEntryObservation[]
}
