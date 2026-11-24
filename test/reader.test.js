// 保证读图调用只累加文本增量、按 finish 原因决定成败，并且缓存/超时/空回答的语义不走样。
import test from 'node:test'
import assert from 'node:assert/strict'

import { settingsFrom } from '../lib/config.js'
import { promptFor, READER_SYSTEM } from '../lib/prompt.js'
import { createReader } from '../lib/reader.js'

const ref = {
  attachmentId: 'sha256:aaaa1111',
  mediaType: 'image/png',
  bytes: 1024,
  width: 640,
  height: 480,
}

const baseConfig = {
  readerMode: 'fixed',
  readerProvider: 'reader-provider',
  readerModel: 'reader-model',
  maxChars: 100,
  timeoutSeconds: 5,
  cacheEntries: 200,
}

function harness({ config = {}, stream } = {}) {
  const settings = { ...baseConfig, ...config }
  const prepareCalls = []
  const streamCalls = []

  const ctx = {
    llm: {
      async resolveModelInfo(provider, model) {
        return { provider, id: model, inputModalities: ['text', 'image'] }
      },
      async prepareCall(callConfig, signal, configure) {
        prepareCalls.push({ config: callConfig, signal, configure })
        return {
          config: { ...callConfig },
          stream(options) {
            streamCalls.push(options)
            return stream(options)
          },
        }
      },
    },
    logger: () => ({ warn() {} }),
  }

  const reader = createReader(ctx, () => settings)
  return { reader, settings, prepareCalls, streamCalls }
}

function chunks(list) {
  return async function* streamChunks() {
    for (const chunk of list) yield chunk
  }
}

const finish = reason => ({ type: 'finish', reason })

test('a successful read concatenates text-delta and ignores the repeated block text', async () => {
  const { reader, settings, prepareCalls, streamCalls } = harness({
    stream: chunks([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Hello' },
      { type: 'text-delta', index: 0, text: ' world' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello world' } },
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } },
      finish({ kind: 'stop' }),
    ]),
  })

  const result = await reader.read({ ref, purpose: 'summarize it', signal: undefined, sessionId: 'session-1' })
  assert.deepEqual(result, { model: 'reader-provider/reader-model', text: 'Hello world', truncated: false })

  assert.equal(prepareCalls.length, 1)
  assert.deepEqual(prepareCalls[0].config, {
    provider: 'reader-provider',
    model: 'reader-model',
    temperature: 0,
    maxTokens: 512,
  })
  assert.equal(typeof prepareCalls[0].configure, 'function')
  assert.deepEqual(prepareCalls[0].configure({ a: 1 }), { a: 1 })

  const options = streamCalls[0]
  assert.equal(options.provider, prepareCalls[0].config.provider)
  assert.equal(options.model, prepareCalls[0].config.model)
  assert.equal(options.temperature, prepareCalls[0].config.temperature)
  assert.equal(options.maxTokens, prepareCalls[0].config.maxTokens)
  assert.equal(options.system, READER_SYSTEM)
  assert.equal(options.sessionId, 'session-1')

  const message = options.messages[0]
  assert.equal(typeof message.id, 'string')
  assert.ok(message.id.length > 0)
  assert.equal(message.role, 'user')
  assert.deepEqual(message.content[0], { type: 'image', attachment: ref })
  assert.equal(message.content[1].type, 'text')
  assert.equal(message.content[1].text, promptFor(settingsFrom(settings), 'summarize it'))
})

test('max-tokens still counts as a complete answer', async () => {
  const { reader } = harness({
    stream: chunks([
      { type: 'text-delta', index: 0, text: 'partial answer' },
      finish({ kind: 'max-tokens' }),
    ]),
  })

  const result = await reader.read({ ref, signal: undefined })
  assert.equal(result.text, 'partial answer')
  assert.equal(result.truncated, false)
})

test('a finish error is thrown with the provider failure message and code', async () => {
  const { reader } = harness({
    stream: chunks([
      finish({ kind: 'error', failure: { message: 'upstream exploded', code: 'E_UPSTREAM' } }),
    ]),
  })

  await assert.rejects(
    reader.read({ ref, signal: undefined }),
    error => error.code === 'E_UPSTREAM' && error.message === 'upstream exploded',
  )
})

test('a finish tool-calls is thrown as IMAGE_READER_TOOL_CALLS', async () => {
  const { reader } = harness({ stream: chunks([finish({ kind: 'tool-calls' })]) })

  await assert.rejects(
    reader.read({ ref, signal: undefined }),
    error => error.code === 'IMAGE_READER_TOOL_CALLS' && /tool calls/.test(error.message),
  )
})

test('empty or whitespace-only text is IMAGE_READER_EMPTY', async () => {
  for (const list of [
    [finish({ kind: 'stop' })],
    [{ type: 'text-delta', index: 0, text: '   \n' }, finish({ kind: 'stop' })],
  ]) {
    const { reader } = harness({ stream: chunks(list) })
    await assert.rejects(
      reader.read({ ref, signal: undefined }),
      error => error.code === 'IMAGE_READER_EMPTY' && /no text/.test(error.message),
    )
  }
})

test('a repeated read with the same key is served from cache', async () => {
  const { reader, prepareCalls } = harness({
    stream: chunks([{ type: 'text-delta', index: 0, text: 'cached' }, finish({ kind: 'stop' })]),
  })

  const input = { ref, purpose: 'same question', signal: undefined, sessionId: 'session-1' }
  const first = await reader.read(input)
  const second = await reader.read(input)

  assert.deepEqual(second, first)
  assert.equal(prepareCalls.length, 1)
})

test('cacheEntries=0 disables caching', async () => {
  const { reader, prepareCalls } = harness({
    config: { cacheEntries: 0 },
    stream: chunks([{ type: 'text-delta', index: 0, text: 'fresh' }, finish({ kind: 'stop' })]),
  })

  await reader.read({ ref, signal: undefined })
  await reader.read({ ref, signal: undefined })
  assert.equal(prepareCalls.length, 2)
})

test('clear() drops every cached answer', async () => {
  const { reader, prepareCalls } = harness({
    stream: chunks([{ type: 'text-delta', index: 0, text: 'answer' }, finish({ kind: 'stop' })]),
  })

  await reader.read({ ref, signal: undefined })
  reader.clear()
  await reader.read({ ref, signal: undefined })
  assert.equal(prepareCalls.length, 2)
})

test('the cache evicts the oldest entry first (FIFO)', async () => {
  let count = 0
  const stream = async function* () {
    count += 1
    yield { type: 'text-delta', index: 0, text: `answer-${count}` }
    yield finish({ kind: 'stop' })
  }
  const { reader, prepareCalls } = harness({ config: { cacheEntries: 1 }, stream })

  const firstRef = { ...ref, attachmentId: 'sha256:aaaa1111' }
  const secondRef = { ...ref, attachmentId: 'sha256:bbbb2222' }

  assert.equal((await reader.read({ ref: firstRef, signal: undefined })).text, 'answer-1')
  assert.equal((await reader.read({ ref: secondRef, signal: undefined })).text, 'answer-2')
  assert.equal((await reader.read({ ref: firstRef, signal: undefined })).text, 'answer-3')
  assert.equal(prepareCalls.length, 3)
})

test('a different purpose is a different cache key', async () => {
  const { reader, prepareCalls } = harness({
    stream: chunks([{ type: 'text-delta', index: 0, text: 'answer' }, finish({ kind: 'stop' })]),
  })

  await reader.read({ ref, purpose: 'first question', signal: undefined })
  await reader.read({ ref, purpose: 'second question', signal: undefined })
  assert.equal(prepareCalls.length, 2)
})

test('the reader timeout maps to IMAGE_READER_TIMEOUT', { timeout: 5000 }, async () => {
  const slowStream = async function* (options) {
    yield { type: 'text-delta', index: 0, text: 'partial' }
    await new Promise((resolve, reject) => {
      const signal = options.signal
      if (signal.aborted) {
        reject(signal.reason)
        return
      }
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  }
  const { reader } = harness({ config: { timeoutSeconds: 1 }, stream: slowStream })

  const started = Date.now()
  await assert.rejects(
    reader.read({ ref, signal: undefined }),
    error => error.code === 'IMAGE_READER_TIMEOUT' && /timed out/.test(error.message),
  )
  assert.ok(Date.now() - started >= 900)
})

test('caller cancellation maps to IMAGE_READER_ABORTED', { timeout: 5000 }, async () => {
  const slowStream = async function* (options) {
    await new Promise((resolve, reject) => {
      const signal = options.signal
      if (signal.aborted) {
        reject(signal.reason)
        return
      }
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  }
  const { reader } = harness({ stream: slowStream })
  const controller = new AbortController()
  setTimeout(() => controller.abort(new Error('user stopped')), 20)

  await assert.rejects(
    reader.read({ ref, signal: controller.signal }),
    error => error.code === 'IMAGE_READER_ABORTED' && /aborted/.test(error.message),
  )
})
