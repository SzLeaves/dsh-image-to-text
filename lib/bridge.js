/**
 * Admission bridge.
 *
 * Why this file exists: the Host decides whether an incoming image is allowed
 * exactly once, at prompt admission, by asking `llm.resolveModelInfo`. A model
 * whose catalog entry declares `input: [text]` therefore fails that check before
 * the message is persisted, so the image never enters the session and
 * `ask_image` would forever find nothing to read. This module changes only that
 * one admission answer: it appends `image` to a model's explicitly declared,
 * text-only modality list.
 *
 * It deliberately does not touch the adapter catalog. Request building goes
 * through `adapter.prepareCall`, and the LLM service keeps projecting images to
 * `[image omitted because this model accepts text only; ...]` for a text-only
 * route. So the bridge lets the image in; it does not claim the model can see.
 * Consumers that need the real capability must read it through
 * {@link originalResolveModelInfo}, never through the patched method.
 */

/** Slot holding `{ original }` on the llm service, so a second install is a no-op. */
const BRIDGE_SLOT = Symbol.for('@szleaves/dsh-image-to-text.admission-bridge')

/**
 * Marker carried by the bridging function itself. The service slot can be lost
 * independently of the wrapper (for example when an uninstall happens while a
 * later plugin sits on top of us), so the unpatched resolver is also recorded on
 * the function: {@link originalResolveModelInfo} then still finds it.
 */
const BRIDGE_ORIGINAL = Symbol.for('@szleaves/dsh-image-to-text.admission-bridge.original')

/**
 * Wrap `ctx.llm.resolveModelInfo` so text-only models pass image admission.
 *
 * The bridge is installed at most once per llm service. A second call returns a
 * no-op disposer on purpose: the first installer owns the lifetime, and a second
 * disposer restoring the method early would strand the first caller with an
 * image pipeline it no longer admits. Re-installing after a real restore works.
 *
 * The caller owns teardown. This function never calls `ctx.effect` itself, so
 * `index.js` can wrap the returned disposer in its own effect (or skip the
 * install when `bridgeAdmission` is off) without the bridge second-guessing the
 * plugin's lifecycle.
 *
 * @param ctx - Cordis context that exposes `llm` and `logger`.
 * @returns Disposer restoring the unpatched method (no-op when already installed).
 */
export function installAdmissionBridge(ctx) {
  const llm = ctx?.llm
  if (!llm || typeof llm.resolveModelInfo !== 'function') {
    throw new TypeError(
      'installAdmissionBridge needs ctx.llm.resolveModelInfo; declare "llm" in the plugin inject list')
  }

  const existing = llm[BRIDGE_SLOT]
  if (existing && typeof existing.original === 'function') {
    log(ctx, 'debug', 'admission bridge already installed; keeping the first install')
    return () => {}
  }

  // A previous instance may have been uninstalled while a later wrapper sat on
  // top: the slot was dropped, but the method still carries the marker. Adopt
  // that bridge instead of wrapping it again — a second wrap would append
  // `image` twice and hide the true original from originalResolveModelInfo.
  const current = llm.resolveModelInfo
  const inherited = current?.[BRIDGE_ORIGINAL]
  if (typeof inherited === 'function') {
    llm[BRIDGE_SLOT] = { original: inherited }
    log(ctx, 'debug', 'adopted an admission bridge already wrapping resolveModelInfo')
    return () => {
      if (llm.resolveModelInfo !== current) {
        // Wrapped again after adoption: leave the bridge in place and keep the
        // slot so the unpatched resolver stays discoverable.
        log(ctx, 'debug', 'admission bridge not restored: resolveModelInfo was wrapped again after adoption')
        return
      }
      llm.resolveModelInfo = inherited
      if (llm[BRIDGE_SLOT]?.original === inherited) delete llm[BRIDGE_SLOT]
      log(ctx, 'debug', 'admission bridge restored')
    }
  }

  const original = llm.resolveModelInfo
  const real = original.bind(llm)
  const bridged = async (provider, model, signal) => {
    const info = await real(provider, model, signal)
    if (!info) return info
    const modalities = info.inputModalities
    // Absent or empty means "unknown", not "text only": leave it alone. Only an
    // explicit, non-empty list that omits `image` is a negative declaration.
    if (!Array.isArray(modalities) || modalities.length === 0 || modalities.includes('image')) return info
    return { ...info, inputModalities: [...modalities, 'image'] }
  }

  bridged[BRIDGE_ORIGINAL] = original

  llm.resolveModelInfo = bridged
  llm[BRIDGE_SLOT] = { original }
  log(ctx, 'debug', 'admission bridge installed; text-only models now pass image admission')

  return () => {
    // Another plugin may have wrapped the method after us. Restoring the raw
    // original then would silently drop their wrapper, so leave the chain alone
    // — including the slot: the bridge is still in it, and dropping the slot
    // would make originalResolveModelInfo read the bridged answer, which is the
    // one thing that must never happen.
    const ours = llm.resolveModelInfo === bridged
    if (ours) {
      llm.resolveModelInfo = original
      if (llm[BRIDGE_SLOT]?.original === original) delete llm[BRIDGE_SLOT]
      log(ctx, 'debug', 'admission bridge restored')
      return
    }
    if (llm.resolveModelInfo === original) {
      // Already restored (dispose called twice, or someone restored for us).
      return
    }
    log(ctx, 'debug', 'admission bridge left installed: resolveModelInfo was wrapped again after install')
  }
}

/**
 * The unpatched resolver, used to judge a model's *real* input modalities.
 *
 * Without the bridge this is just a bound copy of the public method, so callers
 * can use it unconditionally: routing must never be decided by the answer the
 * bridge fabricates for admission.
 *
 * @param ctx - Cordis context that exposes `llm`.
 * @returns A resolver equivalent to the method as it existed before the bridge.
 */
export function originalResolveModelInfo(ctx) {
  const llm = ctx?.llm
  if (!llm || typeof llm.resolveModelInfo !== 'function') {
    throw new TypeError('originalResolveModelInfo needs ctx.llm.resolveModelInfo')
  }
  // The slot is the normal path. The marker on the function covers the case
  // where the slot was dropped while the bridge stayed installed (an uninstall
  // under a later wrapper), and the plain method is the no-bridge fallback.
  const slot = llm[BRIDGE_SLOT]?.original
  if (typeof slot === 'function') return slot.bind(llm)
  const marked = llm.resolveModelInfo?.[BRIDGE_ORIGINAL]
  if (typeof marked === 'function') return marked.bind(llm)
  return llm.resolveModelInfo.bind(llm)
}

/** One debug line through the plugin logger; never console, never fatal. */
function log(ctx, level, message) {
  if (typeof ctx?.logger !== 'function') return
  const logger = ctx.logger('image-to-text')
  const write = logger?.[level]
  if (typeof write === 'function') write.call(logger, message)
}
