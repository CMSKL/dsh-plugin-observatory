/** Package-owned runtime invariant companion. @module dsh-plugin-observatory/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type {} from './index.js'

const PACKAGE_NAME = 'dsh-plugin-observatory'

/** Cordis companion plugin name. */
export const name = 'observatory-invariant'
/** Main service required before this companion starts waiting for the optional registry. */
export const inject = ['pluginObservatory']

const install: InvariantInstaller = Object.assign((ctx: Context, fail: Parameters<InvariantInstaller>[1]) => {
  ctx.on('internal/status', (fiber, oldState) => {
    ctx.pluginObservatory.assertObservedTransition(fiber, oldState, fail)
  }, { global: true })
}, { inject: ['pluginObservatory'] })

/**
 * Register the invariant when the host exposes its optional registry.
 * The outer companion remains active while the inner injection waits, so a
 * default profile without `ctx.invariants` still passes DSH's activation gate.
 * @param ctx - Cordis context carrying the Observatory service.
 */
export const apply = (ctx: Context): void => {
  void ctx.inject(['invariants'], invariantCtx =>
    invariantCtx.invariants.register(PACKAGE_NAME, install))
}
