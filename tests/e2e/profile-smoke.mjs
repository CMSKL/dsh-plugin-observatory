import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

const execFileAsync = promisify(execFile)
const projectRoot = fileURLToPath(new URL('../..', import.meta.url))
const packageManifest = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'))
const packageName = packageManifest.name
const packageVersion = packageManifest.version
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

function parseDump(text) {
  const parsed = yaml.load(text, { schema: entryListSchema })
  assert(Array.isArray(parsed), 'dsh --dump-config must return a top-level entry array')
  return parsed
}

function hasObservatoryRows(rows) {
  return rows.some(row => row?.id === 'observatory' && row.name === packageName)
    && rows.some(row => row?.id === 'observatory-invariant' && row.name === `${packageName}/invariant`)
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

  await run(pnpm, ['pack', '--pack-destination', artifactsDir], { cwd: projectRoot })
  const tarballName = `${packageName.replace(/^@/u, '').replaceAll('/', '-')}-${packageVersion}.tgz`
  const tarball = join(artifactsDir, tarballName)

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

  await run(dshBin, ['plugin', '--profile', profileName, 'add', tarball], { cwd: projectRoot, env })
  const installedDump = await run(dshBin, ['--profile', profileName, '--dump-config'], { env })
  assert(hasObservatoryRows(parseDump(installedDump.stdout)), 'installed profile is missing Observatory bundle rows')

  const profileDir = join(dshHome, 'profiles', profileName)
  const profileRequire = createRequire(join(profileDir, 'package.json'))
  const mainModule = await import(pathToFileURL(profileRequire.resolve(packageName)).href)
  const invariantModule = await import(pathToFileURL(profileRequire.resolve(`${packageName}/invariant`)).href)
  assert(typeof mainModule.default === 'function', 'package main export must be loadable')
  assert(typeof invariantModule.apply === 'function', 'package invariant export must be loadable')

  await run(dshBin, ['plugin', '--profile', profileName, 'remove', packageName], { env })
  const removedDump = await run(dshBin, ['--profile', profileName, '--dump-config'], { env })
  assert(!hasObservatoryRows(parseDump(removedDump.stdout)), 'removed profile still contains Observatory bundle rows')

  process.stdout.write(`DSH ${dshVersion} tarball/profile smoke test passed\n`)
} finally {
  await rm(root, { recursive: true, force: true })
}
