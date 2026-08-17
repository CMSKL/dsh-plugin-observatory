import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { auditPackageDirectory, resolveAllowedRoots, resolveHostVersions } from '../src/audit.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-observatory-audit-'))
  roots.push(root)
  return root
}

async function writePackage(
  root: string,
  manifest: Record<string, unknown> | string,
  patch?: string | Uint8Array,
): Promise<string> {
  const dir = join(root, 'plugin')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest))
  if (patch !== undefined) await writeFile(join(dir, 'cordis.patch.yml'), patch)
  return dir
}

const DEFAULT_HOST_VERSIONS = resolveHostVersions([], name => ({
  '@deepseek-ai/cordis': '4.0.1',
  '@deepseek-ai/dsh-tools': '0.1.0-rc.6',
  '@deepseek-ai/dsh-invariants': '0.1.0-rc.6',
})[name])

function options(
  root: string,
  manifest = 262_144,
  patch = 1_048_576,
  overrides: {
    maxPatchDepth?: number
    maxPatchNodes?: number
    hostVersions?: ReturnType<typeof resolveHostVersions>
  } = {},
) {
  return {
    allowedRoots: resolveAllowedRoots([root]),
    maxManifestBytes: manifest,
    maxPatchBytes: patch,
    maxPatchDepth: 64,
    maxPatchNodes: 10_000,
    hostVersions: DEFAULT_HOST_VERSIONS,
    ...overrides,
  }
}

function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'test-plugin',
    version: '1.0.0',
    license: 'MIT',
    peerDependencies: { '@deepseek-ai/cordis': 'workspace:^' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    ...overrides,
  }
}

describe('auditPackageDirectory', () => {
  it('audits the Observatory package itself without executing its expressions', async () => {
    const packageDir = fileURLToPath(new URL('..', import.meta.url))
    const report = await auditPackageDirectory(options(packageDir), {
      packagePath: '.',
      cwd: packageDir,
    })
    expect(report).toMatchObject({
      reportVersion: 1,
      verdict: 'needs-review',
      manifest: { name: 'dsh-plugin-observatory', bundlePatch: './cordis.patch.yml' },
      bundle: {
        insertedEntries: [
          { id: 'observatory', moduleName: 'dsh-plugin-observatory' },
          { id: 'observatory-invariant', moduleName: 'dsh-plugin-observatory/invariant' },
        ],
      },
      issues: [{
        severity: 'warning',
        code: 'lifecycle-script',
        path: 'package.json#scripts.prepare',
      }],
    })
    expect(report.bundle?.expressions.map(entry => entry.path)).toEqual([
      'patches[0].insert[0].config.allowedRoots',
    ])
  })

  it('reports manifest, install-script, runtime-copy, peer, and Node compatibility findings', async () => {
    const root = await tempRoot()
    const dir = await writePackage(root, validManifest({
      name: '',
      version: undefined,
      license: undefined,
      scripts: { preinstall: 'x', install: 'x', postinstall: 'x', prepare: 'x' },
      dependencies: { '@deepseek-ai/cordis': '1.0.0' },
      peerDependencies: {
        '@deepseek-ai/cordis': 'not-semver',
        '@deepseek-ai/dsh-tools': '>=9.0.0',
      },
      engines: { node: '>=99' },
    }), '[]\n')
    const report = await auditPackageDirectory(options(root), { packagePath: dir, cwd: root })
    expect(report.verdict).toBe('incompatible')
    expect(report.issues.map(entry => entry.code)).toEqual(expect.arrayContaining([
      'manifest-name-missing',
      'cordis-runtime-copy',
      'peer-range-mismatch',
      'node-range-mismatch',
      'lifecycle-script',
      'manifest-version-missing',
      'manifest-license-missing',
      'peer-range-invalid',
    ]))
    expect(report.issues.filter(entry => entry.code === 'lifecycle-script')).toHaveLength(4)
  })

  it('reports invalid Node ranges and a missing Cordis peer as review findings', async () => {
    const root = await tempRoot()
    const dir = await writePackage(root, validManifest({
      peerDependencies: {},
      engines: { node: 'not-semver' },
    }), '[]\n')
    const report = await auditPackageDirectory(options(root), { packagePath: dir, cwd: root })
    expect(report.verdict).toBe('needs-review')
    expect(report.issues.map(entry => entry.code)).toEqual(['cordis-peer-missing', 'node-range-invalid'])
  })

  it('extracts nested rows, targets, and dynamic-expression risk signals', async () => {
    const root = await tempRoot()
    const dir = await writePackage(root, validManifest({
      dependencies: { 'child-plugin': '1.0.0' },
    }), [
      '- insert:',
      '    - id: group',
      "      name: 'test-plugin'",
      '      group: true',
      '      config:',
      '        - id: child',
      "          name: 'child-plugin/subpath'",
      '          config:',
      '            token: !!js process.env.PLUGIN_TOKEN',
      '            loader: !!js eval("x")',
      '- id: existing',
      '  disabled: true',
      '- id: existing',
      '  config: {}',
      '',
    ].join('\n'))
    const report = await auditPackageDirectory(options(root), { packagePath: dir, cwd: root })
    expect(report.verdict).toBe('needs-review')
    expect(report.bundle).toMatchObject({
      insertedEntries: [
        { id: 'group', moduleName: 'test-plugin' },
        { id: 'child', moduleName: 'child-plugin/subpath', nestedUnder: 'group' },
      ],
      targetedEntryIds: ['existing'],
    })
    expect(report.issues.map(entry => entry.code)).toEqual([
      'environment-config-expression',
      'executable-config-expression',
    ])
  })

  it('rejects cyclic aliases without overflowing recursive inspection', async () => {
    const patches = [
      [
        '- id: existing',
        '  config: &loop',
        '    self: *loop',
        '',
      ].join('\n'),
      [
        '- id: existing',
        '  config: &left',
        '    right: &right',
        '      left: *left',
        '',
      ].join('\n'),
      [
        '- insert:',
        '    - &group',
        '      id: group',
        "      name: 'test-plugin'",
        '      group: true',
        '      config:',
        '        - *group',
        '',
      ].join('\n'),
    ]
    for (const patch of patches) {
      const root = await tempRoot()
      const dir = await writePackage(root, validManifest(), patch)
      const report = await auditPackageDirectory(options(root), { packagePath: dir, cwd: root })
      expect(report.verdict).toBe('incompatible')
      expect(report.bundle).toBeUndefined()
      expect(report.issues.map(entry => entry.code)).toContain('patch-cycle-detected')
    }
  })

  it('enforces inclusive patch depth and node-visit limits while allowing repeated non-cyclic aliases', async () => {
    const root = await tempRoot()
    const deep = await writePackage(root, validManifest(), [
      '- id: existing',
      '  config:',
      '    one:',
      '      two:',
      '        three: true',
      '',
    ].join('\n'))
    const depthReport = await auditPackageDirectory(
      options(root, 262_144, 1_048_576, { maxPatchDepth: 3 }),
      { packagePath: deep, cwd: root },
    )
    expect(depthReport.issues.map(entry => entry.code)).toContain('patch-depth-exceeded')
    expect(depthReport.bundle).toBeUndefined()

    await writeFile(join(deep, 'cordis.patch.yml'), '- insert: []\n')
    const boundary = await auditPackageDirectory(
      options(root, 262_144, 1_048_576, { maxPatchNodes: 3 }),
      { packagePath: deep, cwd: root },
    )
    expect(boundary.verdict).toBe('compatible')
    const nodeReport = await auditPackageDirectory(
      options(root, 262_144, 1_048_576, { maxPatchNodes: 2 }),
      { packagePath: deep, cwd: root },
    )
    expect(nodeReport.issues.map(entry => entry.code)).toContain('patch-node-limit-exceeded')

    await writeFile(join(deep, 'cordis.patch.yml'), [
      '- id: existing',
      '  config:',
      '    first: &shared',
      '      enabled: true',
      '    second: *shared',
      '',
    ].join('\n'))
    const aliasReport = await auditPackageDirectory(
      options(root, 262_144, 1_048_576, { maxPatchNodes: 5 }),
      { packagePath: deep, cwd: root },
    )
    expect(aliasReport).toMatchObject({ verdict: 'compatible', bundle: { targetedEntryIds: ['existing'] } })
  })

  it('reports explicit DSH host version availability, conflicts, and peer compatibility', async () => {
    const consistent = resolveHostVersions([], name => ({
      '@deepseek-ai/cordis': '4.0.1',
      '@deepseek-ai/dsh-tools': '0.1.0-rc.6',
      '@deepseek-ai/dsh-invariants': '0.1.0-rc.6',
    })[name])
    expect(consistent).toMatchObject({ dshVersion: '0.1.0-rc.6', dshVersionConflict: false })

    const authoritativeConflict = resolveHostVersions([], name => ({
      '@deepseek-ai/dsh': '0.1.0-rc.6',
      '@deepseek-ai/dsh-tools': '0.1.0-rc.3',
    })[name])
    expect(authoritativeConflict).toMatchObject({ dshVersion: '0.1.0-rc.6', dshVersionConflict: true })

    const unavailable = resolveHostVersions([], () => undefined)
    expect(unavailable).toMatchObject({ dshVersion: 'unknown', dshVersionConflict: false })

    const root = await tempRoot()
    const dir = await writePackage(root, validManifest({
      peerDependencies: {
        '@deepseek-ai/cordis': '>=4.0.0 <5',
        '@deepseek-ai/dsh': '^0.1.0-rc.6',
        '@deepseek-ai/dsh-tools': '>=0.1.0-rc.6 <0.2.0',
      },
    }), '[]\n')
    const compatible = await auditPackageDirectory(
      options(root, 262_144, 1_048_576, { hostVersions: consistent }),
      { packagePath: dir, cwd: root },
    )
    expect(compatible).toMatchObject({ verdict: 'compatible', host: { dshVersion: '0.1.0-rc.6' } })

    await writeFile(join(dir, 'package.json'), JSON.stringify(validManifest({
      peerDependencies: { '@deepseek-ai/cordis': 'workspace:^', '@deepseek-ai/dsh': '>=0.2.0' },
    })))
    const mismatch = await auditPackageDirectory(
      options(root, 262_144, 1_048_576, { hostVersions: consistent }),
      { packagePath: dir, cwd: root },
    )
    expect(mismatch.issues.map(entry => entry.code)).toContain('peer-range-mismatch')
    expect(mismatch.verdict).toBe('incompatible')

    const unavailableReport = await auditPackageDirectory(
      options(root, 262_144, 1_048_576, { hostVersions: unavailable }),
      { packagePath: dir, cwd: root },
    )
    expect(unavailableReport.issues.map(entry => entry.code)).toEqual(expect.arrayContaining([
      'host-dsh-version-unavailable',
      'peer-version-unavailable',
    ]))

    const conflictReport = await auditPackageDirectory(
      options(root, 262_144, 1_048_576, { hostVersions: authoritativeConflict }),
      { packagePath: dir, cwd: root },
    )
    expect(conflictReport.issues.map(entry => entry.code)).toContain('host-dsh-version-conflict')
  })

  it('reports malformed patch entries and undeclared or relative plugin modules', async () => {
    const root = await tempRoot()
    const dir = await writePackage(root, validManifest(), [
      '- 42',
      '- insert: nope',
      '- insert: []',
      '  id: 7',
      '- insert:',
      '    - nope',
      '    - id: ""',
      "      name: ''",
      '    - id: duplicate',
      "      name: './local.js'",
      '    - id: duplicate',
      "      name: 'undeclared-plugin'",
      '    - id: group',
      "      name: 'test-plugin'",
      '      group: true',
      '      config: {}',
      '- config: {}',
      '',
    ].join('\n'))
    const report = await auditPackageDirectory(options(root), { packagePath: dir, cwd: root })
    expect(report.verdict).toBe('incompatible')
    expect(report.issues.map(entry => entry.code)).toEqual(expect.arrayContaining([
      'patch-entry-invalid',
      'patch-insert-invalid',
      'patch-target-invalid',
      'entry-invalid',
      'entry-id-missing',
      'entry-module-missing',
      'entry-id-duplicate',
      'relative-plugin-specifier',
      'runtime-dependency-missing',
      'group-config-invalid',
      'patch-target-missing',
    ]))
  })

  it('reports manifest and bundle parse failures as domain results', async () => {
    const root = await tempRoot()
    const malformed = await writePackage(root, '{')
    expect((await auditPackageDirectory(options(root), { packagePath: malformed, cwd: root })).issues[0]?.code)
      .toBe('manifest-json-invalid')

    await writeFile(join(malformed, 'package.json'), '[]')
    expect((await auditPackageDirectory(options(root), { packagePath: malformed, cwd: root })).issues[0]?.code)
      .toBe('manifest-root-invalid')

    await writeFile(join(malformed, 'package.json'), JSON.stringify(validManifest()))
    await writeFile(join(malformed, 'cordis.patch.yml'), '[:')
    expect((await auditPackageDirectory(options(root), { packagePath: malformed, cwd: root })).issues[0]?.code)
      .toBe('bundle-patch-yaml-invalid')

    await writeFile(join(malformed, 'cordis.patch.yml'), '{}')
    expect((await auditPackageDirectory(options(root), { packagePath: malformed, cwd: root })).issues[0]?.code)
      .toBe('patch-root-invalid')
  })

  it('reports missing paths, non-directories, missing manifests, and missing bundle declarations', async () => {
    const root = await tempRoot()
    const missing = await auditPackageDirectory(options(root), { packagePath: 'missing', cwd: root })
    expect(missing.issues[0]?.code).toBe('package-not-found')

    const file = join(root, 'file')
    await writeFile(file, 'x')
    expect((await auditPackageDirectory(options(root), { packagePath: file, cwd: root })).issues[0]?.code)
      .toBe('package-not-directory')

    const empty = join(root, 'empty')
    await mkdir(empty)
    expect((await auditPackageDirectory(options(root), { packagePath: empty, cwd: root })).issues[0]?.code)
      .toBe('manifest-missing')

    const noBundle = await writePackage(root, { name: 'x' })
    const report = await auditPackageDirectory(options(root), { packagePath: noBundle, cwd: root })
    expect(report.issues.map(entry => entry.code)).toEqual([
      'bundle-manifest-missing',
      'cordis-peer-missing',
      'manifest-license-missing',
      'manifest-version-missing',
    ])
  })

  it('contains symlinked manifests and patch files inside the package directory', async () => {
    const root = await tempRoot()
    const outsideManifest = join(root, 'outside.json')
    await writeFile(outsideManifest, JSON.stringify(validManifest()))
    const manifestEscape = join(root, 'manifest-escape')
    await mkdir(manifestEscape)
    await symlink(outsideManifest, join(manifestEscape, 'package.json'))
    expect((await auditPackageDirectory(options(root), { packagePath: manifestEscape, cwd: root })).issues[0]?.code)
      .toBe('manifest-path-escape')

    const patchEscape = await writePackage(root, validManifest({ dsh: { bundle: { patch: './patch-link.yml' } } }))
    const outsidePatch = join(root, 'outside.yml')
    await writeFile(outsidePatch, '[]\n')
    await symlink(outsidePatch, join(patchEscape, 'patch-link.yml'))
    expect((await auditPackageDirectory(options(root), { packagePath: patchEscape, cwd: root })).issues[0]?.code)
      .toBe('bundle-patch-path-escape')
  })

  it('bounds and validates UTF-8 for both audited files', async () => {
    const root = await tempRoot()
    const dir = await writePackage(root, validManifest(), '[]\n')
    expect((await auditPackageDirectory(options(root, 2), { packagePath: dir, cwd: root })).issues[0]?.code)
      .toBe('manifest-file-too-large')

    await writeFile(join(dir, 'package.json'), Uint8Array.of(0xff))
    expect((await auditPackageDirectory(options(root), { packagePath: dir, cwd: root })).issues[0]?.code)
      .toBe('manifest-invalid-utf8')

    await writeFile(join(dir, 'package.json'), JSON.stringify(validManifest()))
    expect((await auditPackageDirectory(options(root, 262_144, 1), { packagePath: dir, cwd: root })).issues[0]?.code)
      .toBe('bundle-patch-file-too-large')

    await writeFile(join(dir, 'cordis.patch.yml'), Uint8Array.of(0xff))
    expect((await auditPackageDirectory(options(root), { packagePath: dir, cwd: root })).issues[0]?.code)
      .toBe('bundle-patch-invalid-utf8')
  })

  it('rejects paths outside allowed roots, including symlink escapes, and honors cancellation', async () => {
    const root = await tempRoot()
    const outside = await tempRoot()
    const dir = await writePackage(outside, validManifest(), '[]\n')
    await expect(auditPackageDirectory(options(root), { packagePath: dir, cwd: root }))
      .rejects.toThrow('outside configured allowedRoots')

    const link = join(root, 'link')
    await symlink(dir, link)
    await expect(auditPackageDirectory(options(root), { packagePath: link, cwd: root }))
      .rejects.toThrow('resolves outside configured allowedRoots')

    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(auditPackageDirectory(options(root), { packagePath: '.', cwd: root, signal: controller.signal }))
      .rejects.toThrow('cancelled')
  })
})

describe('resolveAllowedRoots', () => {
  it('canonicalizes and deduplicates configured roots', async () => {
    const root = await tempRoot()
    expect(resolveAllowedRoots([root, join(root, '.')])).toEqual([await realpath(root)])
  })

  it('rejects blank and inaccessible roots at activation', () => {
    expect(() => resolveAllowedRoots([' '])).toThrow('must not be blank')
    expect(() => resolveAllowedRoots(['/definitely/missing/dsh-observatory-root'])).toThrow('is not accessible')
  })
})
