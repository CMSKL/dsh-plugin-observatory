import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import Observatory from '../src/index.ts'
import * as ObservatoryInvariant from '../src/invariant.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('real Loader composition', () => {
  it('boots the service row through Include while the test host mounts its invariant', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-observatory-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@deepseek-ai/cordis-plugin-include'",
      '  config:',
      "    path: './bundle.yml'",
      "- name: '@deepseek-ai/dsh-invariants'",
      '',
    ].join('\n'))
    await writeFile(join(root, 'bundle.yml'), [
      '- id: observatory',
      "  name: 'dsh-plugin-observatory'",
      '  config:',
      `    allowedRoots: [${JSON.stringify(root)}]`,
      '- id: observatory-invariant',
      "  name: 'dsh-plugin-observatory/invariant'",
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
      ['@deepseek-ai/dsh-tools', ToolRuntime],
      ['@deepseek-ai/cordis-plugin-include', Include],
      ['@deepseek-ai/dsh-invariants', InvariantRegistry],
      ['dsh-plugin-observatory', Observatory],
      ['dsh-plugin-observatory/invariant', ObservatoryInvariant],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()

    expect(context.tools.schemas().map(schema => schema.name)).toEqual(['plugin_audit', 'plugin_observe'])
    expect([...context.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)).toEqual([])
    expect(context.pluginObservatory.snapshot().entries.find(
      entry => entry.moduleName === 'dsh-plugin-observatory',
    )).toMatchObject({
      moduleName: 'dsh-plugin-observatory', enabled: true, phase: 'active',
    })
  })
})
