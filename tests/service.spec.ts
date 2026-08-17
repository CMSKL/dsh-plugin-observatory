import { afterEach, describe, expect, it } from 'vitest'
import { Context, type Plugin } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import Observatory, { type Config, PluginObservatoryService } from '../src/index.ts'
import * as ObservatoryInvariant from '../src/invariant.ts'

const contexts: Context[] = []
const signal = new AbortController().signal

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

const activePlugin: Plugin.Function = () => {}
const pendingPlugin: Plugin.Object = { inject: ['neverReady'], apply() {} }

async function mount(config: Config = {}): Promise<{
  ctx: Context
  fiber: Awaited<ReturnType<Context['plugin']>>
  service: PluginObservatoryService
}> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Loader)
  ctx.loader.builtins.active = activePlugin
  ctx.loader.builtins.pending = pendingPlugin
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(InvariantRegistry)
  const fiber = await ctx.plugin(Observatory, config)
  await ctx.plugin(ObservatoryInvariant)
  return { ctx, fiber, service: ctx.pluginObservatory }
}

function value(result: ToolExecutionResult): unknown {
  if (result.isError) throw new Error(result.content.map(block => block.type === 'text' ? block.text : '').join('\n'))
  return result.value
}

describe('PluginObservatoryService', () => {
  it('registers pure read-only tools and removes them with its Fiber', async () => {
    const mounted = await mount()
    expect(mounted.ctx.tools.schemas().map(schema => schema.name)).toEqual(['plugin_audit', 'plugin_observe'])
    expect(mounted.ctx.tools.get('plugin_audit')?.isConcurrencySafe?.({ package_path: '.' })).toBe(true)
    expect(mounted.ctx.tools.get('plugin_observe')?.isConcurrencySafe?.({})).toBe(true)
    expect(mounted.ctx.tools.get('plugin_audit')?.presentCall?.({ package_path: '/work/plugin' })).toEqual({
      card: 'generic',
      title: 'Audit DSH plugin /work/plugin',
      kind: 'search',
      locations: [{ path: '/work/plugin' }],
    })
    expect(mounted.ctx.tools.get('plugin_observe')?.presentCall?.({})).toEqual({
      card: 'generic', title: 'Observe DSH plugins', kind: 'search',
    })
    expect(mounted.ctx.tools.get('plugin_observe')?.presentCall?.({ entry_id: 'demo' })).toEqual({
      card: 'generic', title: 'Observe DSH plugin demo', kind: 'search', rawInput: 'demo',
    })
    expect(mounted.ctx.tools.get('plugin_audit')?.output.render({}, { verdict: 'compatible' }))
      .toEqual([{ type: 'text', text: '{\n  "verdict": "compatible"\n}' }])

    await mounted.fiber.dispose()
    expect(mounted.ctx.tools.schemas()).toEqual([])
  })

  it('audits the package through the model-facing tool and validates blank inputs', async () => {
    const packageDir = new URL('..', import.meta.url).pathname
    const mounted = await mount({ allowedRoots: [packageDir] })
    const report = value(await mounted.ctx.tools.execute({
      signal,
      callId: CallId('audit'),
      name: 'plugin_audit',
      arguments: { package_path: packageDir },
    })) as { verdict: string; manifest?: { name?: string } }
    expect(report).toMatchObject({
      verdict: 'needs-review',
      manifest: { name: 'dsh-plugin-observatory' },
    })

    const blankAudit = await mounted.ctx.tools.execute({
      signal, callId: CallId('blank-audit'), name: 'plugin_audit', arguments: { package_path: ' ' },
    })
    const blankObserve = await mounted.ctx.tools.execute({
      signal, callId: CallId('blank-observe'), name: 'plugin_observe', arguments: { entry_id: ' ' },
    })
    expect(blankAudit.isError).toBe(true)
    expect(blankObserve.isError).toBe(true)
  })

  it('projects current Loader state and retains a bounded transition history', async () => {
    const mounted = await mount({ maxTransitionsPerEntry: 2 })
    const activeId = await mounted.ctx.loader.create({ name: 'cordis:active' })
    const pendingId = await mounted.ctx.loader.create({ name: 'cordis:pending' })
    const disabledId = await mounted.ctx.loader.create({ name: 'cordis:active', disabled: true })

    expect(mounted.service.snapshot().entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ entryId: activeId, moduleName: 'cordis:active', enabled: true, phase: 'active' }),
      expect.objectContaining({ entryId: pendingId, moduleName: 'cordis:pending', enabled: true, phase: 'pending' }),
      expect.objectContaining({ entryId: disabledId, enabled: false, phase: 'not-loaded', transitions: [] }),
    ]))
    const active = mounted.service.snapshot(activeId).entries[0]
    expect(active?.transitions.length).toBeGreaterThan(0)
    expect(active?.transitions.length).toBeLessThanOrEqual(2)
    expect(active?.transitions.at(-1)).toMatchObject({ to: 'active' })

    await mounted.ctx.loader.update(activeId, { disabled: true })
    const disabled = mounted.service.snapshot(activeId).entries[0]
    expect(disabled).toMatchObject({ enabled: false, phase: 'not-loaded' })
    expect(disabled?.transitions).toHaveLength(2)
    expect(disabled?.transitions.at(-1)).toMatchObject({ to: 'disposed' })
    expect(disabled?.transitions.at(-1)?.durationMs).toBeGreaterThanOrEqual(0)

    const observed = value(await mounted.ctx.tools.execute({
      signal, callId: CallId('observe'), name: 'plugin_observe', arguments: { entry_id: activeId },
    })) as { entries: unknown[] }
    expect(observed.entries).toHaveLength(1)
    expect(mounted.service.snapshot('missing').entries).toEqual([])
  })

  it('evicts the least recently transitioned entry history at the configured cap', async () => {
    const mounted = await mount({ maxObservedEntries: 1 })
    const first = await mounted.ctx.loader.create({ name: 'cordis:active' })
    const second = await mounted.ctx.loader.create({ name: 'cordis:active' })
    expect(mounted.service.snapshot(first).entries[0]?.transitions).toEqual([])
    expect(mounted.service.snapshot(second).entries[0]?.transitions.length).toBeGreaterThan(0)
  })

  it('satisfies its package invariant during Loader transitions', async () => {
    const mounted = await mount()
    await mounted.ctx.loader.create({ name: 'cordis:active' })
    await mounted.ctx.loader.create({ name: 'cordis:pending' })
  })

  it('fails invalid direct configuration before registering tools', async () => {
    for (const [field, value] of [
      ['maxManifestBytes', 0],
      ['maxPatchBytes', Number.POSITIVE_INFINITY],
      ['maxObservedEntries', 1.5],
      ['maxTransitionsPerEntry', Number.NaN],
      ['maxManifestBytes', 32 * 1024 * 1024 + 1],
      ['maxPatchDepth', 257],
      ['maxPatchNodes', 100_001],
    ] as const) {
      const ctx = new Context()
      contexts.push(ctx)
      expect(() => new PluginObservatoryService(ctx, { [field]: value })).toThrow(field)
    }
    const ctx = new Context()
    contexts.push(ctx)
    expect(() => new PluginObservatoryService(ctx, { allowedRoots: ['/missing/observatory-root'] }))
      .toThrow('is not accessible')
  })
})
