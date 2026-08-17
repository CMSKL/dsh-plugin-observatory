/** Package-owned runtime invariant companion. @module dsh-plugin-observatory/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type {} from './index.js'

const PACKAGE_NAME = 'dsh-plugin-observatory'

/** Cordis companion plugin name. */
export const name = 'observatory-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

const install: InvariantInstaller = Object.assign((ctx: Context, fail: Parameters<InvariantInstaller>[1]) => {
  ctx.on('internal/status', (fiber, oldState) => {
    ctx.pluginObservatory.assertObservedTransition(fiber, oldState, fail)
  }, { global: true })
}, { inject: ['pluginObservatory'] })

/**
 * Register the invariant that every retained latest transition matches the delivered root-Fiber status event.
 * @param ctx - Cordis context carrying the invariant registry and Observatory service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
