/**
 * Reader routing: which registered model actually reads the image.
 *
 * Why this file exists: the conversation model is often text-only, so the image
 * has to be handed to some other route. "fixed" is the user's explicit choice
 * and must never silently fall back; "auto" has to be deterministic, because the
 * chosen route decides the bill, the latency and whether an image ever leaves
 * the machine. Both return only `{ provider, model }`: that is exactly what
 * `llm.prepareCall` takes, and returning a whole `LlmModelInfo` would invite
 * callers to pass along metadata that the call itself does not accept.
 *
 * Capability is always read through `originalResolveModelInfo`, never through
 * the admission bridge, which deliberately overstates image support.
 */

import { originalResolveModelInfo } from './bridge.js'

/** Names that usually mean the route was built for images. Ranking hint only. */
const VISUAL_NAME = /vl|vision|llava|omni/i

/** Routing failures a tool result can explain to the model without a stack. */
export class ImageReaderError extends Error {
  /**
   * @param message - Model-readable English sentence(s).
   * @param code - `'NO_READER' | 'NO_SUCH_MODEL' | 'TEXT_ONLY_READER'`.
   */
  constructor(message, code) {
    super(message)
    this.name = 'ImageReaderError'
    this.code = code
  }
}

/**
 * Pick the route that reads one image.
 *
 * @param ctx - Cordis context that exposes `llm` (and optionally `logger`).
 * @param config - Plugin config (raw schema value or `settingsFrom()` output).
 * @param options - `{ signal?, preferSameProvider? }`. `preferSameProvider` is
 *   the conversation's current route; staying on the same provider saves a
 *   second gateway authentication and round trip in auto mode.
 * @returns `{ provider, model }` ready for `llm.prepareCall`.
 * @throws {ImageReaderError} with a `code` callers can branch on.
 */
export async function readerRoute(ctx, config, options = {}) {
  const settings = normalize(config)
  const signal = options?.signal
  throwIfAborted(signal)

  if (settings.readerMode === 'fixed') {
    return fixedRoute(ctx, settings, signal)
  }
  return autoRoute(ctx, settings, options?.preferSameProvider, signal)
}

/** `fixed` mode: the user named the route, so a mismatch is an error, not a fallback. */
async function fixedRoute(ctx, settings, signal) {
  const { readerProvider: provider, readerModel: model } = settings
  if (!provider || !model) {
    throw new ImageReaderError(
      'Reader mode is "fixed" but readerProvider and readerModel are not both set. '
        + 'Set both in the plugin settings, or switch reader mode to "auto".',
      'NO_SUCH_MODEL')
  }

  let info
  try {
    info = await originalResolveModelInfo(ctx)(provider, model, signal)
  } catch (error) {
    if (isAbort(error, signal)) throw signal?.aborted ? abortReason(signal) : error
    throw notFound(
      `Reader model "${provider}/${model}" is not available: ${messageOf(error)}. `
        + 'Fix readerProvider/readerModel in the plugin settings, or switch reader mode to "auto".',
      error)
  }
  if (!info) {
    throw notFound(
      `Reader model "${provider}/${model}" is not registered. `
        + 'Fix readerProvider/readerModel in the plugin settings, or switch reader mode to "auto".')
  }

  // Unknown modalities pass: fixed is an explicit instruction, so the user's
  // intent wins over the catalog's silence. Only a negative declaration stops it.
  if (isExplicitlyTextOnly(info.inputModalities)) {
    throw new ImageReaderError(
      `Reader model "${provider}/${model}" only accepts text input, so it cannot read images. `
        + 'Pick an image-capable model in the plugin settings, or switch reader mode to "auto".',
      'TEXT_ONLY_READER')
  }

  return {
    provider: typeof info.provider === 'string' && info.provider ? info.provider : provider,
    model: typeof info.id === 'string' && info.id ? info.id : model,
  }
}

/** `auto` mode: any registered route that explicitly accepts images, ranked. */
async function autoRoute(ctx, settings, preferSameProvider, signal) {
  const llm = ctx?.llm
  if (!llm || typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') {
    throw new ImageReaderError(
      'Cannot look for an image-capable model: the llm service is unavailable. '
        + 'Enable the llm service, or set readerProvider and readerModel in the plugin settings.',
      'NO_READER')
  }

  const providerIds = providerIdsOf(await llm.listProviders())
  // One failing provider (network, credentials, stale adapter) must not hide the
  // models the other providers do advertise.
  const listings = await Promise.allSettled(providerIds.map(async id => ({
    id,
    models: await llm.listModels(id),
  })))

  throwIfAborted(signal)

  const candidates = []
  listings.forEach((listing, index) => {
    const id = providerIds[index]
    if (listing.status === 'rejected') {
      log(ctx, 'warn', `cannot list models for provider "${id}": ${messageOf(listing.reason)}`)
      return
    }
    const models = Array.isArray(listing.value.models) ? listing.value.models : []
    for (const model of models) {
      // Absent or empty means unknown, not "accepts images": only an explicit
      // declaration that includes `image` is trustworthy here.
      if (!Array.isArray(model?.inputModalities) || !model.inputModalities.includes('image')) continue
      if (typeof model.id !== 'string' || model.id.length === 0) continue
      candidates.push({
        provider: id,
        model: model.id,
        name: typeof model.name === 'string' ? model.name : '',
        order: candidates.length,
      })
    }
  })

  if (candidates.length === 0) {
    throw new ImageReaderError(
      'No image-capable model is registered. Register a provider that accepts image input, '
        + 'or set readerProvider and readerModel to one in the plugin settings.',
      'NO_READER')
  }

  const sameProvider = typeof preferSameProvider?.provider === 'string'
    ? preferSameProvider.provider
    : undefined
  const prefer = settings.preferProviders
  const ranked = candidates.map(candidate => {
    const rank = prefer.indexOf(candidate.provider)
    return {
      ...candidate,
      preferRank: rank === -1 ? Number.POSITIVE_INFINITY : rank,
      sameProvider: candidate.provider === sameProvider,
      looksVisual: VISUAL_NAME.test(`${candidate.provider} ${candidate.model} ${candidate.name}`),
    }
  })
  ranked.sort(compareCandidates)

  const chosen = ranked[0]
  log(ctx, 'debug', `auto reader route: ${chosen.provider}/${chosen.model}`)
  return { provider: chosen.provider, model: chosen.model }
}

/**
 * Stable, level-by-level ranking:
 *   1. providers listed in `preferProviders` (earlier wins),
 *   2. the conversation's own provider (no second gateway auth),
 *   3. ids/names that look visual,
 *   4. catalog order.
 */
function compareCandidates(a, b) {
  if (a.preferRank !== b.preferRank) return a.preferRank < b.preferRank ? -1 : 1
  if (a.sameProvider !== b.sameProvider) return a.sameProvider ? -1 : 1
  if (a.looksVisual !== b.looksVisual) return a.looksVisual ? -1 : 1
  return a.order - b.order
}

/**
 * Read config defensively. `settingsFrom()` already fills gaps, but routing is
 * also reachable from tests and from a partially written settings page, so the
 * same defaults apply here.
 */
function normalize(config) {
  const source = config ?? {}
  return {
    readerMode: source.readerMode === 'fixed' ? 'fixed' : 'auto',
    readerProvider: trim(source.readerProvider),
    readerModel: trim(source.readerModel),
    preferProviders: Array.isArray(source.preferProviders)
      ? source.preferProviders
        .filter(entry => typeof entry === 'string' && entry.trim().length > 0)
        .map(entry => entry.trim())
      : [],
  }
}

/** Provider listings may be plain ids or `{ id }`; keep only usable ids. */
function providerIdsOf(providers) {
  const list = Array.isArray(providers) ? providers : []
  const ids = []
  for (const provider of list) {
    const id = typeof provider === 'string' ? provider : provider?.id
    if (typeof id === 'string' && id.length > 0 && !ids.includes(id)) ids.push(id)
  }
  return ids
}

/** `inputModalities` is a tri-state: absent/empty = unknown, omission = negative. */
function isExplicitlyTextOnly(modalities) {
  return Array.isArray(modalities) && modalities.length > 0 && !modalities.includes('image')
}

function notFound(message, cause) {
  const error = new ImageReaderError(message, 'NO_SUCH_MODEL')
  if (cause !== undefined) error.cause = cause
  return error
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return
  throw abortReason(signal)
}

function abortReason(signal) {
  if (signal?.reason !== undefined) return signal.reason
  const error = new Error('The image reader request was aborted')
  error.name = 'AbortError'
  return error
}

function isAbort(error, signal) {
  if (signal?.aborted) return true
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR'
}

function messageOf(error) {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return message || 'unknown error'
}

function trim(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** One debug/warn line through the plugin logger; never console, never fatal. */
function log(ctx, level, message) {
  if (typeof ctx?.logger !== 'function') return
  const logger = ctx.logger('image-to-text')
  const write = logger?.[level]
  if (typeof write === 'function') write.call(logger, message)
}
