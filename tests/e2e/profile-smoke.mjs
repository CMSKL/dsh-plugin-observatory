import { execFile, spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

const execFileAsync = promisify(execFile)
const projectRoot = fileURLToPath(new URL('../..', import.meta.url))
const packageManifest = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'))
const packageName = packageManifest.name
const packageVersion = packageManifest.version
const packageSpec = process.env.PACKAGE_SPEC?.trim() || undefined
const expectedPackageName = process.env.EXPECTED_PACKAGE_NAME?.trim() || packageName
const expectedPackageVersion = process.env.EXPECTED_PACKAGE_VERSION?.trim() || packageVersion
const dshVersion = process.env.DSH_VERSION ?? '0.1.0-rc.6'
const profileName = 'observatory-e2e'
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function run(file, args, options = {}) {
  try {
    return await execFileAsync(file, args, {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      ...options,
    })
  } catch (error) {
    const stdout = typeof error.stdout === 'string' ? error.stdout : ''
    const stderr = typeof error.stderr === 'string' ? error.stderr : ''
    throw new Error(
      `command failed: ${file} ${args.join(' ')}\n${stdout}${stderr}`,
      { cause: error },
    )
  }
}

async function assertProfileBoots(file, args, options = {}) {
  const child = spawn(file, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  const earlyExit = await Promise.race([
    completion,
    delay(2_000).then(() => undefined),
  ])
  if (earlyExit !== undefined) {
    throw new Error(
      `profile exited before its activation smoke window: ${file} ${args.join(' ')}\n`
      + `${stdout}${stderr}`,
    )
  }
  child.kill('SIGTERM')
  const stopped = await Promise.race([
    completion,
    delay(5_000).then(() => undefined),
  ])
  if (stopped === undefined) {
    child.kill('SIGKILL')
    await completion
    throw new Error(`profile did not stop after its activation smoke test: ${file} ${args.join(' ')}`)
  }
}

function parseDump(text) {
  const parsed = yaml.load(text, { schema: entryListSchema })
  assert(Array.isArray(parsed), 'dsh --dump-config must return a top-level entry array')
  return parsed
}

function hasObservatoryRows(rows) {
  return rows.some(row => row?.id === 'observatory' && row.name === expectedPackageName)
    && rows.some(row => row?.id === 'observatory-invariant' && row.name === `${expectedPackageName}/invariant`)
}

const root = await mkdtemp(join(tmpdir(), 'dsh-observatory-e2e-'))
try {
  const artifactsDir = join(root, 'artifacts')
  const harnessDir = join(root, 'harness')
  const dshHome = join(root, 'dsh-home')
  await Promise.all([mkdir(artifactsDir), mkdir(harnessDir), mkdir(dshHome)])
  await writeFile(join(harnessDir, 'package.json'), JSON.stringify({ private: true }, null, 2))
  await writeFile(join(harnessDir, 'pnpm-workspace.yaml'), [
    'allowBuilds:',
    "  '@deepseek-ai/dsh-subprocess-local': true",
    "  '@google/genai': false",
    '  koffi: true',
    '  node-addon-require-builtin: false',
    '  node-pty: true',
    '  protobufjs: false',
    '',
  ].join('\n'))

  const dependencyRanges = Object.values({
    ...packageManifest.dependencies,
    ...packageManifest.peerDependencies,
    ...packageManifest.devDependencies,
  })
  assert(
    dependencyRanges.every(range => typeof range !== 'string' || !range.startsWith('workspace:')),
    'published manifest must not contain workspace: dependency ranges',
  )
  const dryRun = await run(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: projectRoot })
  const [{ files: packedFiles }] = JSON.parse(dryRun.stdout)
  const unexpected = packedFiles
    .map(file => file.path)
    .filter(path => ![
      'LICENSE',
      'README.md',
      'README.zh.md',
      'cordis.patch.yml',
      'package.json',
    ].includes(path) && !/^lib\/[^/]+\.(?:js|d\.ts)$/u.test(path))
  assert(unexpected.length === 0, `tarball contains unexpected files: ${unexpected.join(', ')}`)

  let installSpec = packageSpec
  if (!installSpec) {
    await run(pnpm, ['pack', '--pack-destination', artifactsDir], { cwd: projectRoot })
    const tarballName = `${packageName.replace(/^@/u, '').replaceAll('/', '-')}-${packageVersion}.tgz`
    installSpec = join(artifactsDir, tarballName)
  }

  await run(pnpm, ['--dir', harnessDir, 'add', '--save-exact', `@deepseek-ai/dsh@${dshVersion}`])
  const dshBin = join(
    harnessDir,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'dsh.CMD' : 'dsh',
  )
  const env = { ...process.env, DSH_HOME: dshHome }
  const version = await run(dshBin, ['--version'], { env })
  assert(version.stdout.trim() === dshVersion, `expected dsh ${dshVersion}, got ${version.stdout.trim()}`)

  await run(dshBin, ['plugin', '--profile', profileName, 'add', installSpec], { cwd: projectRoot, env })
  const installedDump = await run(dshBin, ['--profile', profileName, '--dump-config'], { env })
  assert(hasObservatoryRows(parseDump(installedDump.stdout)), 'installed profile is missing Observatory bundle rows')

  const profileDir = join(dshHome, 'profiles', profileName)
  const profileRequire = createRequire(join(profileDir, 'package.json'))
  const installedManifest = JSON.parse(
    await readFile(profileRequire.resolve(`${expectedPackageName}/package.json`), 'utf8'),
  )
  assert(installedManifest.name === expectedPackageName, `expected package ${expectedPackageName}, got ${installedManifest.name}`)
  assert(installedManifest.version === expectedPackageVersion, `expected package ${expectedPackageVersion}, got ${installedManifest.version}`)
  assert(
    installedManifest.peerDependenciesMeta?.['@deepseek-ai/dsh-invariants']?.optional === true,
    'published manifest must mark @deepseek-ai/dsh-invariants as an optional peer',
  )
  const mainModule = await import(pathToFileURL(profileRequire.resolve(expectedPackageName)).href)
  const invariantModule = await import(pathToFileURL(profileRequire.resolve(`${expectedPackageName}/invariant`)).href)
  assert(typeof mainModule.default === 'function', 'package main export must be loadable')
  assert(typeof invariantModule.apply === 'function', 'package invariant export must be loadable')
  await assertProfileBoots(dshBin, ['--profile', profileName], { env })

  await run(dshBin, ['plugin', '--profile', profileName, 'remove', expectedPackageName], { env })
  const removedDump = await run(dshBin, ['--profile', profileName, '--dump-config'], { env })
  assert(!hasObservatoryRows(parseDump(removedDump.stdout)), 'removed profile still contains Observatory bundle rows')

  process.stdout.write(`DSH ${dshVersion} package/profile smoke test passed for ${expectedPackageName}@${expectedPackageVersion}\n`)
} finally {
  await rm(root, { recursive: true, force: true })
}
