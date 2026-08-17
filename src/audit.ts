/** Static DSH bundle inspection without importing or evaluating target code. */

import { open, realpath, stat } from 'node:fs/promises'
import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { isJsExpr } from '@deepseek-ai/cordis-plugin-loader'
import { satisfies, validRange } from 'semver'
import type {
  PluginAuditBundle,
  PluginAuditEntry,
  PluginAuditExpression,
  PluginAuditIssue,
  PluginAuditManifest,
  PluginAuditReport,
  PluginAuditSeverity,
} from './types.js'

interface PackageManifestRecord {
  name?: unknown
  version?: unknown
  license?: unknown
  scripts?: unknown
  engines?: unknown
  dependencies?: unknown
  peerDependencies?: unknown
  dsh?: unknown
}

interface AuditOptions {
  readonly allowedRoots: readonly string[]
  readonly maxManifestBytes: number
  readonly maxPatchBytes: number
  readonly maxPatchDepth: number
  readonly maxPatchNodes: number
  readonly hostVersions: HostVersionSnapshot
}

interface AuditRequest {
  readonly packagePath: string
  readonly cwd: string
  readonly signal?: AbortSignal
}

const require = createRequire(import.meta.url)
const ownManifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string }

/** Version of the independently released Observatory package. */
export const OBSERVATORY_VERSION = ownManifest.version

const SEVERITY_ORDER: Record<PluginAuditSeverity, number> = {
  error: 0,
  warning: 1,
  info: 2,
}

const DSH_VERSION_PACKAGES = [
  '@deepseek-ai/dsh',
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-app-boot',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-invariants',
] as const

/** Package versions captured once from the active DSH process. */
export interface HostVersionSnapshot {
  readonly dshVersion: string
  readonly dshVersionConflict: boolean
  readonly packageVersions: Readonly<Record<string, string>>
}

type PackageVersionResolver = (packageName: string) => string | undefined

class AuditAccessError extends Error {}

class BoundedReadError extends Error {
  constructor(
    readonly code: 'file-too-large' | 'not-a-file' | 'invalid-utf8',
    readonly file: string,
    message: string,
  ) {
    super(message)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

function issue(
  issues: PluginAuditIssue[], severity: PluginAuditSeverity, code: string, message: string, path?: string,
): void {
  issues.push({ severity, code, message, ...path === undefined ? {} : { path } })
}

async function readBoundedUtf8(file: string, maxBytes: number, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  const handle = await open(file, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new BoundedReadError('not-a-file', file, `${file} is not a regular file`)
    if (info.size > maxBytes) {
      throw new BoundedReadError('file-too-large', file, `${file} is ${info.size} bytes; limit is ${maxBytes}`)
    }
    const buffer = Buffer.alloc(maxBytes + 1)
    let offset = 0
    while (offset < buffer.length) {
      signal?.throwIfAborted()
      const result = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (result.bytesRead === 0) break
      offset += result.bytesRead
    }
    if (offset > maxBytes) {
      throw new BoundedReadError('file-too-large', file, `${file} exceeds the ${maxBytes}-byte limit`)
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset))
    } catch {
      throw new BoundedReadError('invalid-utf8', file, `${file} is not valid UTF-8`)
    }
  } finally {
    await handle.close()
  }
}

function stringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
}

function manifestSummary(manifest: PackageManifestRecord): PluginAuditManifest {
  const dsh = isRecord(manifest.dsh) ? manifest.dsh : undefined
  const bundle = dsh !== undefined && isRecord(dsh.bundle) ? dsh.bundle : undefined
  const engines = isRecord(manifest.engines) ? manifest.engines : undefined
  return {
    ...typeof manifest.name === 'string' ? { name: manifest.name } : {},
    ...typeof manifest.version === 'string' ? { version: manifest.version } : {},
    ...typeof manifest.license === 'string' ? { license: manifest.license } : {},
    ...typeof bundle?.patch === 'string' ? { bundlePatch: bundle.patch } : {},
    ...typeof engines?.node === 'string' ? { nodeRange: engines.node } : {},
  }
}

function installedPackageVersion(packageName: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(require.resolve(`${packageName}/package.json`), 'utf8')) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : undefined
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') return undefined
    throw error
  }
}

function isHostPackage(packageName: string): boolean {
  return packageName === '@deepseek-ai/dsh'
    || packageName === '@deepseek-ai/cordis'
    || packageName.startsWith('@deepseek-ai/dsh-')
}

/** Capture DSH release-family and mounted host package versions once at service activation. */
export function resolveHostVersions(
  mountedSpecifiers: readonly string[] = [],
  resolveVersion: PackageVersionResolver = installedPackageVersion,
): HostVersionSnapshot {
  const names = new Set<string>([...DSH_VERSION_PACKAGES, '@deepseek-ai/cordis'])
  for (const specifier of mountedSpecifiers) {
    const packageName = packageNameFromSpecifier(specifier)
    if (packageName !== undefined && isHostPackage(packageName)) names.add(packageName)
  }
  const packageVersions: Record<string, string> = {}
  for (const name of names) {
    const version = resolveVersion(name)
    if (version !== undefined) packageVersions[name] = version
  }

  const cliVersion = packageVersions['@deepseek-ai/dsh']
  const familyVersions = DSH_VERSION_PACKAGES.flatMap(name => {
    const version = packageVersions[name]
    return version === undefined ? [] : [version]
  })
  const distinctFamilyVersions = [...new Set(familyVersions)]
  const dshVersionConflict = distinctFamilyVersions.length > 1
  const dshVersion = cliVersion ?? (distinctFamilyVersions.length === 1 ? distinctFamilyVersions[0] : undefined) ?? 'unknown'
  return Object.freeze({
    dshVersion,
    dshVersionConflict,
    packageVersions: Object.freeze(packageVersions),
  })
}

function inspectCompatibility(
  manifest: PackageManifestRecord,
  hostVersions: HostVersionSnapshot,
  issues: PluginAuditIssue[],
): void {
  const dependencies = stringMap(manifest.dependencies)
  const peers = stringMap(manifest.peerDependencies)
  const scripts = stringMap(manifest.scripts)
  const summary = manifestSummary(manifest)

  if (hostVersions.dshVersionConflict) {
    issue(
      issues,
      'warning',
      'host-dsh-version-conflict',
      'resolved DSH release-family packages do not share one version',
      'host.dshVersion',
    )
  } else if (hostVersions.dshVersion === 'unknown') {
    issue(
      issues,
      'warning',
      'host-dsh-version-unavailable',
      'DSH launcher version could not be resolved from the active release-family packages',
      'host.dshVersion',
    )
  }

  if (summary.name === undefined || summary.name.trim() === '') {
    issue(issues, 'error', 'manifest-name-missing', 'package.json must declare a non-empty name', 'package.json')
  }
  if (summary.version === undefined) {
    issue(issues, 'warning', 'manifest-version-missing', 'package.json does not declare a version', 'package.json')
  }
  if (summary.license === undefined) {
    issue(issues, 'warning', 'manifest-license-missing', 'package.json does not declare a license', 'package.json')
  }
  if (summary.bundlePatch === undefined || summary.bundlePatch.trim() === '') {
    issue(issues, 'error', 'bundle-manifest-missing', 'package.json must declare dsh.bundle.patch', 'package.json')
  }
  if (peers['@deepseek-ai/cordis'] === undefined) {
    issue(issues, 'warning', 'cordis-peer-missing', '@deepseek-ai/cordis should be a peerDependency', 'package.json')
  }
  if (dependencies['@deepseek-ai/cordis'] !== undefined) {
    issue(
      issues,
      'error',
      'cordis-runtime-copy',
      '@deepseek-ai/cordis in dependencies can load a second runtime copy; declare it as a peerDependency',
      'package.json',
    )
  }

  for (const name of ['preinstall', 'install', 'postinstall', 'prepare']) {
    if (scripts[name] !== undefined) {
      issue(
        issues,
        'warning',
        'lifecycle-script',
        `package script ${name} executes during common install or source-package flows`,
        `package.json#scripts.${name}`,
      )
    }
  }

  for (const [name, range] of Object.entries(peers).sort(([left], [right]) => left.localeCompare(right))) {
    if (range.startsWith('workspace:')) continue
    if (validRange(range) === null) {
      issue(issues, 'warning', 'peer-range-invalid', `${name} peer range ${JSON.stringify(range)} is not valid semver`, `package.json#peerDependencies.${name}`)
      continue
    }
    if (!isHostPackage(name)) continue
    const installed = name === '@deepseek-ai/dsh'
      ? hostVersions.dshVersion === 'unknown' ? undefined : hostVersions.dshVersion
      : hostVersions.packageVersions[name]
    if (installed === undefined) {
      issue(
        issues,
        'warning',
        'peer-version-unavailable',
        `${name} version could not be resolved from the active host`,
        `package.json#peerDependencies.${name}`,
      )
    } else if (!satisfies(installed, range, { includePrerelease: true })) {
      issue(
        issues,
        'error',
        'peer-range-mismatch',
        `${name} ${installed} does not satisfy declared peer range ${range}`,
        `package.json#peerDependencies.${name}`,
      )
    }
  }

  if (summary.nodeRange !== undefined) {
    if (validRange(summary.nodeRange) === null) {
      issue(issues, 'warning', 'node-range-invalid', `engines.node ${JSON.stringify(summary.nodeRange)} is not valid semver`, 'package.json#engines.node')
    } else if (!satisfies(process.version, summary.nodeRange, { includePrerelease: true })) {
      issue(
        issues,
        'error',
        'node-range-mismatch',
        `Node ${process.version} does not satisfy engines.node ${summary.nodeRange}`,
        'package.json#engines.node',
      )
    }
  }
}

function inspectPatchGraph(value: unknown, maxDepth: number, maxNodes: number): PluginAuditIssue | undefined {
  const ancestors = new WeakSet<object>()
  let nodes = 0

  const visit = (current: unknown, path: string, depth: number): PluginAuditIssue | undefined => {
    if (current === null || typeof current !== 'object') return undefined
    if (depth > maxDepth) {
      return {
        severity: 'error',
        code: 'patch-depth-exceeded',
        message: `bundle patch nesting depth exceeds the configured limit of ${maxDepth}`,
        path,
      }
    }
    nodes += 1
    if (nodes > maxNodes) {
      return {
        severity: 'error',
        code: 'patch-node-limit-exceeded',
        message: `bundle patch object and array visits exceed the configured limit of ${maxNodes}`,
        path,
      }
    }
    if (ancestors.has(current)) {
      return {
        severity: 'error',
        code: 'patch-cycle-detected',
        message: 'bundle patch contains a cyclic YAML alias',
        path,
      }
    }

    ancestors.add(current)
    try {
      if (Array.isArray(current)) {
        for (let index = 0; index < current.length; index += 1) {
          const found = visit(current[index], `${path}[${index}]`, depth + 1)
          if (found !== undefined) return found
        }
      } else {
        for (const [key, child] of Object.entries(current)) {
          const found = visit(child, `${path}.${key}`, depth + 1)
          if (found !== undefined) return found
        }
      }
      return undefined
    } finally {
      ancestors.delete(current)
    }
  }

  return visit(value, 'patches', 0)
}

function packageNameFromSpecifier(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.includes('\\')) return undefined
  if (specifier.startsWith('cordis:')) return specifier
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

function inspectExpressions(value: unknown, path: string, expressions: PluginAuditExpression[], issues: PluginAuditIssue[]): void {
  if (isJsExpr(value)) {
    expressions.push({ path, expression: value.__jsExpr })
    if (/\bprocess\.env\b/u.test(value.__jsExpr)) {
      issue(issues, 'warning', 'environment-config-expression', 'bundle config expression reads process.env', path)
    }
    if (/\b(?:require|eval)\s*\(|\bimport\s*\(/u.test(value.__jsExpr)) {
      issue(issues, 'warning', 'executable-config-expression', 'bundle config expression performs dynamic code or module loading', path)
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      inspectExpressions(item, `${path}[${index}]`, expressions, issues)
    })
    return
  }
  if (!isRecord(value)) return
  for (const [key, item] of Object.entries(value)) inspectExpressions(item, `${path}.${key}`, expressions, issues)
}

function inspectEntry(
  value: unknown,
  path: string,
  parentId: string | undefined,
  manifestName: string | undefined,
  dependencies: Readonly<Record<string, string>>,
  seenIds: Set<string>,
  insertedEntries: PluginAuditEntry[],
  issues: PluginAuditIssue[],
): void {
  if (!isRecord(value)) {
    issue(issues, 'error', 'entry-invalid', 'inserted Loader entry must be a mapping', path)
    return
  }
  const id = value.id
  const moduleName = value.name
  if (typeof id !== 'string' || id.trim() === '') {
    issue(issues, 'error', 'entry-id-missing', 'inserted Loader entry must declare a non-empty id', `${path}.id`)
  }
  if (typeof moduleName !== 'string' || moduleName.trim() === '') {
    issue(issues, 'error', 'entry-module-missing', 'inserted Loader entry must declare a non-empty name', `${path}.name`)
  }
  if (typeof id === 'string' && id.trim() !== '') {
    if (seenIds.has(id)) issue(issues, 'error', 'entry-id-duplicate', `bundle inserts duplicate Loader entry id ${JSON.stringify(id)}`, `${path}.id`)
    seenIds.add(id)
  }
  if (typeof id === 'string' && id.trim() !== '' && typeof moduleName === 'string' && moduleName.trim() !== '') {
    insertedEntries.push({ id, moduleName, ...parentId === undefined ? {} : { nestedUnder: parentId } })
    const packageName = packageNameFromSpecifier(moduleName)
    if (packageName === undefined) {
      issue(
        issues,
        'error',
        'relative-plugin-specifier',
        `bundle entry ${id} uses ${JSON.stringify(moduleName)}; bundle rows resolve from the profile, not the bundle directory`,
        `${path}.name`,
      )
    } else if (!packageName.startsWith('cordis:') && packageName !== manifestName && dependencies[packageName] === undefined) {
      issue(
        issues,
        'error',
        'runtime-dependency-missing',
        `bundle entry ${id} loads ${JSON.stringify(packageName)} but package.json dependencies does not declare it`,
        `${path}.name`,
      )
    }
  }
  if (value.group === true) {
    if (!Array.isArray(value.config)) {
      issue(issues, 'error', 'group-config-invalid', 'group entry config must be an array of Loader entries', `${path}.config`)
      return
    }
    value.config.forEach((child, index) => {
      inspectEntry(
        child,
        `${path}.config[${index}]`,
        typeof id === 'string' ? id : parentId,
        manifestName,
        dependencies,
        seenIds,
        insertedEntries,
        issues,
      )
    })
  }
}

function inspectPatchList(
  parsed: unknown,
  manifest: PackageManifestRecord,
  issues: PluginAuditIssue[],
): Omit<PluginAuditBundle, 'patchPath'> | undefined {
  if (!Array.isArray(parsed)) {
    issue(issues, 'error', 'patch-root-invalid', 'bundle patch must be a top-level YAML array', 'cordis.patch.yml')
    return undefined
  }
  const insertedEntries: PluginAuditEntry[] = []
  const targetedEntryIds: string[] = []
  const expressions: PluginAuditExpression[] = []
  const dependencies = stringMap(manifest.dependencies)
  const manifestName = typeof manifest.name === 'string' ? manifest.name : undefined
  const seenIds = new Set<string>()

  parsed.forEach((candidate, index) => {
    const path = `patches[${index}]`
    inspectExpressions(candidate, path, expressions, issues)
    if (!isRecord(candidate)) {
      issue(issues, 'error', 'patch-entry-invalid', 'patch entry must be a mapping', path)
      return
    }
    if (candidate.insert !== undefined) {
      if (!Array.isArray(candidate.insert)) {
        issue(issues, 'error', 'patch-insert-invalid', 'patch insert must be an array of Loader entries', `${path}.insert`)
        return
      }
      if (candidate.id !== undefined && (typeof candidate.id !== 'string' || candidate.id.trim() === '')) {
        issue(issues, 'error', 'patch-target-invalid', 'group-targeted insert id must be a non-empty string', `${path}.id`)
      }
      candidate.insert.forEach((entry, entryIndex) => {
        inspectEntry(
          entry,
          `${path}.insert[${entryIndex}]`,
          typeof candidate.id === 'string' ? candidate.id : undefined,
          manifestName,
          dependencies,
          seenIds,
          insertedEntries,
          issues,
        )
      })
      return
    }
    if (typeof candidate.id !== 'string' || candidate.id.trim() === '') {
      issue(issues, 'error', 'patch-target-missing', 'non-insert patch must declare a non-empty id', `${path}.id`)
      return
    }
    targetedEntryIds.push(candidate.id)
  })
  return {
    insertedEntries,
    targetedEntryIds: [...new Set(targetedEntryIds)].sort(),
    expressions,
  }
}

function sortedIssues(issues: PluginAuditIssue[]): PluginAuditIssue[] {
  return issues.toSorted((left, right) =>
    SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity]
    || left.code.localeCompare(right.code)
    || (left.path ?? '').localeCompare(right.path ?? '')
    || left.message.localeCompare(right.message))
}

function report(
  packageDir: string,
  hostVersions: HostVersionSnapshot,
  issues: PluginAuditIssue[],
  manifest?: PluginAuditManifest,
  bundle?: PluginAuditBundle,
): PluginAuditReport {
  const ordered = sortedIssues(issues)
  const verdict = ordered.some(entry => entry.severity === 'error')
    ? 'incompatible'
    : ordered.some(entry => entry.severity === 'warning') ? 'needs-review' : 'compatible'
  return {
    reportVersion: 1,
    packageDir,
    host: { dshVersion: hostVersions.dshVersion, nodeVersion: process.version },
    verdict,
    ...manifest === undefined ? {} : { manifest },
    ...bundle === undefined ? {} : { bundle },
    issues: ordered,
  }
}

async function canonicalChild(packageDir: string, relativePath: string): Promise<string> {
  const requested = resolve(packageDir, relativePath)
  if (!isInside(packageDir, requested)) throw new AuditAccessError(`${relativePath} escapes package directory ${packageDir}`)
  const canonical = await realpath(requested)
  if (!isInside(packageDir, canonical)) throw new AuditAccessError(`${relativePath} resolves outside package directory ${packageDir}`)
  return canonical
}

async function canonicalRequestedPath(requested: string): Promise<{ path: string; exists: boolean }> {
  let cursor = requested
  const suffix: string[] = []
  while (true) {
    try {
      const existing = await realpath(cursor)
      return { path: resolve(existing, ...suffix.toReversed()), exists: suffix.length === 0 }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(cursor)
      if (parent === cursor) throw error
      suffix.push(basename(cursor))
      cursor = parent
    }
  }
}

/**
 * Read and analyze one local DSH bundle without importing its JavaScript.
 * @param options - canonical allowed roots and per-file byte limits.
 * @param request - target directory, relative-path base, and optional cancellation.
 * @returns deterministic compatibility findings and extracted bundle metadata.
 */
export async function auditPackageDirectory(options: AuditOptions, request: AuditRequest): Promise<PluginAuditReport> {
  request.signal?.throwIfAborted()
  const requested = resolve(request.cwd, request.packagePath)
  const candidate = await canonicalRequestedPath(requested)
  const packageDir = candidate.path
  if (!options.allowedRoots.some(root => isInside(root, packageDir))) {
    throw new AuditAccessError(`plugin audit path ${requested} resolves outside configured allowedRoots`)
  }
  if (!candidate.exists) {
    return report(packageDir, options.hostVersions, [{ severity: 'error', code: 'package-not-found', message: `${packageDir} does not exist`, path: packageDir }])
  }
  const packageInfo = await stat(packageDir)
  if (!packageInfo.isDirectory()) {
    return report(packageDir, options.hostVersions, [{ severity: 'error', code: 'package-not-directory', message: `${packageDir} is not a directory`, path: packageDir }])
  }

  const issues: PluginAuditIssue[] = []
  let manifestPath: string
  try {
    manifestPath = await canonicalChild(packageDir, 'package.json')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    issue(
      issues,
      'error',
      error instanceof AuditAccessError ? 'manifest-path-escape' : 'manifest-missing',
      error instanceof AuditAccessError ? error.message : `${packageDir} has no readable package.json (${code ?? String(error)})`,
      'package.json',
    )
    return report(packageDir, options.hostVersions, issues)
  }

  let manifestText: string
  try {
    manifestText = await readBoundedUtf8(manifestPath, options.maxManifestBytes, request.signal)
  } catch (error) {
    if (!(error instanceof BoundedReadError)) throw error
    issue(issues, 'error', `manifest-${error.code}`, error.message, 'package.json')
    return report(packageDir, options.hostVersions, issues)
  }
  let parsedManifest: unknown
  try {
    parsedManifest = JSON.parse(manifestText)
  } catch (error) {
    issue(issues, 'error', 'manifest-json-invalid', `package.json is not valid JSON: ${String(error)}`, 'package.json')
    return report(packageDir, options.hostVersions, issues)
  }
  if (!isRecord(parsedManifest)) {
    issue(issues, 'error', 'manifest-root-invalid', 'package.json must contain a JSON object', 'package.json')
    return report(packageDir, options.hostVersions, issues)
  }
  const manifest = parsedManifest as PackageManifestRecord
  const summary = manifestSummary(manifest)
  inspectCompatibility(manifest, options.hostVersions, issues)
  if (summary.bundlePatch === undefined || summary.bundlePatch.trim() === '') {
    return report(packageDir, options.hostVersions, issues, summary)
  }

  let patchPath: string
  try {
    patchPath = await canonicalChild(packageDir, summary.bundlePatch)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    issue(
      issues,
      'error',
      error instanceof AuditAccessError ? 'bundle-patch-path-escape' : 'bundle-patch-missing',
      error instanceof AuditAccessError ? error.message : `declared bundle patch is not readable (${code ?? String(error)})`,
      'package.json#dsh.bundle.patch',
    )
    return report(packageDir, options.hostVersions, issues, summary)
  }

  let patchText: string
  try {
    patchText = await readBoundedUtf8(patchPath, options.maxPatchBytes, request.signal)
  } catch (error) {
    if (!(error instanceof BoundedReadError)) throw error
    issue(issues, 'error', `bundle-patch-${error.code}`, error.message, summary.bundlePatch)
    return report(packageDir, options.hostVersions, issues, summary)
  }
  let parsedPatch: unknown
  try {
    parsedPatch = yaml.load(patchText, { schema: entryListSchema })
  } catch (error) {
    issue(issues, 'error', 'bundle-patch-yaml-invalid', `bundle patch is not valid DSH YAML: ${String(error)}`, summary.bundlePatch)
    return report(packageDir, options.hostVersions, issues, summary)
  }
  const graphIssue = inspectPatchGraph(parsedPatch, options.maxPatchDepth, options.maxPatchNodes)
  if (graphIssue !== undefined) {
    issues.push(graphIssue)
    return report(packageDir, options.hostVersions, issues, summary)
  }
  const inspected = inspectPatchList(parsedPatch, manifest, issues)
  return report(
    packageDir,
    options.hostVersions,
    issues,
    summary,
    inspected === undefined ? undefined : { patchPath: summary.bundlePatch, ...inspected },
  )
}

/**
 * Resolve and validate configured audit roots once at service activation.
 * @param roots - configured directory paths.
 * @returns deduplicated canonical roots in configuration order.
 */
export function resolveAllowedRoots(roots: readonly string[]): string[] {
  const resolved = roots.map(root => realpathSyncForConfig(root))
  return [...new Set(resolved)]
}

function realpathSyncForConfig(root: string): string {
  if (root.trim() === '') throw new Error('observatory: allowedRoots entries must not be blank')
  try {
    return realpathSync(resolve(root))
  } catch (error) {
    throw new Error(`observatory: allowed root ${JSON.stringify(root)} is not accessible`, { cause: error })
  }
}
