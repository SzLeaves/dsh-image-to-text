/**
 * One reader call: resolve a route, ask an image-capable model, clamp, cache.
 *
 * Reading an image is a separate LLM request instead of a second content block
 * on the main conversation because the conversation model may not accept images
 * at all: the image has to be turned into text once, by a model that can see it,
 * and that text is what the conversation model reasons over. Keeping it separate
 * also lets the answer be scoped to one question (`purpose`) instead of paying
 * for a full caption on every turn.
 *
 * The plugin never touches image bytes. It forwards the durable attachment
 * reference and lets the LLM service and its adapter fetch, downscale, and
 * serialize the image; that keeps this module free of size and format policy and
 * avoids a second, divergent copy of the host's limits.
 */

import { createHash, randomUUID } from 'node:crypto'

import { settingsFrom } from './config.js'
import { readerRoute } from './route.js'
import { clamp, promptFor, READER_SYSTEM } from './prompt.js'

const TIMEOUT_CODE = 'IMAGE_READER_TIMEOUT'
const ABORTED_CODE = 'IMAGE_READER_ABORTED'
const EMPTY_CODE = 'IMAGE_READER_EMPTY'
const TOOL_CALLS_CODE = 'IMAGE_READER_TOOL_CALLS'

function failure(message, code) {
  const error = new Error(message)
  if (code !== undefined) error.code = code
  return error
}

/**
 * Map a post-mortem signal state to the error the caller should see. Timeout is
 * checked first because the per-call deadline is the more specific cause: when
 * both fire, the caller still wants to know the reader ran out of time.
 */
function signalFailure(timeout, callerSignal) {
  if (timeout.aborted) return failure('image reader timed out', TIMEOUT_CODE)
  if (callerSignal?.aborted === true) return failure('image reader was aborted', ABORTED_CODE)
  return undefined
}

/** One flow-control failure chunk, translated into the error we throw. */
function finishFailure(reason) {
  if (reason?.kind === 'tool-calls') {
    return failure('the reader returned tool calls instead of text', TOOL_CALLS_CODE)
  }
  return failure(reason?.failure?.message ?? 'reader call failed', reason?.failure?.code)
}

export function createReader(ctx, getConfig) {
  /** Insertion order is the eviction order; a hit never reshuffles it. */
  const cache = new Map()
  const logger = typeof ctx.logger === 'function' ? ctx.logger('image-to-text') : undefined

  function warn(error) {
    // Provider messages only: the prompt, the image, and the answer are caller
    // content and never belong in a log line.
    logger?.warn?.(`${error.code ?? 'IMAGE_READER_ERROR'}: ${error.message}`)
  }

  async function read(input) {
    const config = settingsFrom(getConfig())
    const callerSignal = input.signal
    const timeout = AbortSignal.timeout(Math.max(1, config.timeoutSeconds) * 1000)
    const signal = callerSignal === undefined ? timeout : AbortSignal.any([callerSignal, timeout])

    try {
      const route = await readerRoute(ctx, config, {
        signal,
        preferSameProvider: input.preferSameProvider,
      })
      const { provider, model } = route
      const prompt = promptFor(config, input.purpose)
      // Everything that changes the answer is part of the key: an edited template
      // or a smaller answer budget must not be served from an older entry.
      const key = [
        input.sessionId ?? '',
        input.ref.attachmentId,
        `${provider}/${model}`,
        input.purpose ?? '',
        String(config.maxChars),
        createHash('sha1').update(prompt).digest('hex').slice(0, 12),
      ].join('\u0000')

      if (config.cacheEntries > 0) {
        const hit = cache.get(key)
        if (hit !== undefined) return { ...hit }
      }

      // The output budget follows the answer limit the caller configured: one
      // token per character is generous for Chinese and harmless for English
      // (maxTokens only caps, it does not reserve), so a small maxChars still
      // allows a complete answer.
      const maxTokens = Math.min(8192, Math.max(512, Math.ceil(config.maxChars) + 256))
      const call = await ctx.llm.prepareCall(
        { provider, model, temperature: 0, maxTokens },
        signal,
        controls => controls,
      )
      const options = {
        ...call.config,
        messages: [{
          // The kernel treats a message as identified; adapters replay or log it
          // by id, so a plain role/content object is not enough everywhere.
          id: randomUUID(),
          role: 'user',
          content: [
            { type: 'image', attachment: input.ref },
            { type: 'text', text: prompt },
          ],
          source: { kind: 'plugin:image-to-text' },
        }],
        system: READER_SYSTEM,
        sessionId: input.sessionId,
        signal,
      }

      // text-delta already carries the whole answer: block-end repeats it, so
      // accumulating both would double every word.
      let text = ''
      for await (const chunk of call.stream(options)) {
        if (chunk.type === 'text-delta') {
          text += chunk.text
          continue
        }
        if (chunk.type !== 'finish') continue

        const reason = chunk.reason
        // A truncated answer is still an answer; the caller learns about the cut
        // from `truncated` after clamping.
        if (reason?.kind === 'stop' || reason?.kind === 'max-tokens') continue
        throw finishFailure(reason)
      }

      const stopped = signalFailure(timeout, callerSignal)
      if (stopped !== undefined) throw stopped

      if (text.trim().length === 0) throw failure('The reader returned no text', EMPTY_CODE)

      const { text: clamped, truncated } = clamp(text, config.maxChars)
      const value = { model: `${provider}/${model}`, text: clamped, truncated }

      if (config.cacheEntries > 0) {
        cache.set(key, value)
        while (cache.size > config.cacheEntries) {
          const oldest = cache.keys().next().value
          if (oldest === undefined) break
          cache.delete(oldest)
        }
      }

      return value
    } catch (error) {
      // Timeout and user cancellation reach us either as thrown aborts or as a
      // finish chunk; both must surface with their own code so callers can tell
      // "give up" from "the model misbehaved".
      const mapped = signalFailure(timeout, callerSignal)
      const final = mapped ?? error
      warn(final)
      throw final
    }
  }

  function clear() {
    cache.clear()
  }

  return { read, clear }
}
