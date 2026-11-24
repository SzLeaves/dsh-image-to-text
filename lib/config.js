import z from '@deepseek-ai/schemastery'

import { DEFAULT_PROMPT, PROMPT_TEMPLATE } from './prompt.js'

/**
 * Plugin configuration. Every leaf is `.volatile()` on purpose: `dsh-settings`
 * only lists an entry whose schema has at least one volatile field, and the
 * Configure page writes through that path.
 */
export const Config = z.object({
  readerMode: z.union([z.const('auto'), z.const('fixed')]).default('auto').volatile()
    .description('auto picks an image-capable model from the registry; fixed always uses readerProvider/readerModel.'),
  readerProvider: z.string().default('').volatile()
    .description('Provider id of the reader model. Required when readerMode is fixed.'),
  readerModel: z.string().default('').volatile()
    .description('Model id of the reader model. Required when readerMode is fixed.'),
  preferProviders: z.array(z.string()).default([]).volatile()
    .description('Providers to try first in auto mode, in order.'),
  promptTemplate: z.string().default(PROMPT_TEMPLATE).volatile()
    .description('User message sent to the reader. {{purpose}} and {{maxChars}} are substituted once.'),
  defaultPrompt: z.string().default(DEFAULT_PROMPT).volatile()
    .description('Used when the conversation model calls ask_image without a purpose.'),
  maxChars: z.natural().default(8000).volatile()
    .description('Upper bound on the answer the reader may return, in characters.'),
  timeoutSeconds: z.natural().default(180).volatile()
    .description('How long one reader call may take before it is aborted.'),
  bridgeAdmission: z.boolean().default(true).volatile()
    .description('Report image support to prompt admission so images reach a text-only model as placeholders.'),
  pathImport: z.boolean().default(true).volatile()
    .description('Allow ask_image to read an image file by path, in addition to images already in the conversation.'),
  cacheEntries: z.natural().default(200).volatile()
    .description('How many reader answers to remember, keyed by session, image, model and purpose.'),
})

export const DEFAULTS = {
  readerMode: 'auto',
  readerProvider: '',
  readerModel: '',
  preferProviders: [],
  promptTemplate: PROMPT_TEMPLATE,
  defaultPrompt: DEFAULT_PROMPT,
  maxChars: 8000,
  timeoutSeconds: 180,
  bridgeAdmission: true,
  pathImport: true,
  cacheEntries: 200,
}

/**
 * A `.volatile()` field does not arrive as a value: schemastery hands the
 * runtime a frozen reference (`{ get() }`) that the Loader rewrites in place
 * when the Configure page saves. Unwrap here so every call site sees a plain
 * value, and so a save is visible on the next read without a restart.
 * `dsh-subagent` reads its volatile fields the same way (`this.config.maxDepth.get()`).
 */
function isReference(value) {
  return typeof value === 'object' && value !== null && typeof value.get === 'function' && value.get.length === 0
}

function read(source, key, fallback) {
  const value = isReference(source[key]) ? source[key].get() : source[key]
  return value === undefined || value === null ? fallback : value
}

/** A number inside `[min, max]`, floored; anything else falls back. */
function bounded(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback
  const whole = Math.floor(value)
  if (whole < min) return fallback
  return whole > max ? max : whole
}

/** Fill gaps so call sites can read fields without repeating `?? default`. */
export function settingsFrom(config) {
  const source = config ?? {}
  const readerProvider = read(source, 'readerProvider', '')
  const readerModel = read(source, 'readerModel', '')
  const maxChars = read(source, 'maxChars', 8000)
  const timeoutSeconds = read(source, 'timeoutSeconds', 180)
  const cacheEntries = read(source, 'cacheEntries', 200)
  const preferProviders = read(source, 'preferProviders', [])
  return {
    readerMode: read(source, 'readerMode', 'auto') === 'fixed' ? 'fixed' : 'auto',
    readerProvider: typeof readerProvider === 'string' ? readerProvider.trim() : '',
    readerModel: typeof readerModel === 'string' ? readerModel.trim() : '',
    preferProviders: Array.isArray(preferProviders)
      ? preferProviders.filter(entry => typeof entry === 'string' && entry.length > 0)
      : [],
    promptTemplate: read(source, 'promptTemplate', '') || PROMPT_TEMPLATE,
    defaultPrompt: read(source, 'defaultPrompt', '') || DEFAULT_PROMPT,
    // A budget of zero or less cannot mean "no limit": the answer is fed back into
    // a model context, so it always has a ceiling. Out-of-range values take the
    // default (8000) instead of silently meaning something else.
    maxChars: bounded(maxChars, 1, 100000, 8000),
    timeoutSeconds: bounded(timeoutSeconds, 1, 3600, 180),
    bridgeAdmission: read(source, 'bridgeAdmission', true) !== false,
    pathImport: read(source, 'pathImport', true) !== false,
    cacheEntries: bounded(cacheEntries, 0, 5000, 200),
  }
}
