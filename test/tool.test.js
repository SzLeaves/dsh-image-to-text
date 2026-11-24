// 保证 ask_image 的参数解析、失败文案和传给 reader 的上下文符合模型与宿主约定。
import test from 'node:test'
import assert from 'node:assert/strict'

import { createAskImageTool } from '../lib/tool.js'
import { ImageReaderError } from '../lib/route.js'

const ref = attachmentId => ({
  attachmentId,
  mediaType: 'image/png',
  bytes: 1024,
  width: 640,
  height: 480,
})

const image = attachmentId => ({ type: 'image', attachment: ref(attachmentId) })
const text = value => ({ type: 'text', text: value })
const message = (...content) => ({ id: 'm', role: 'user', content })

function agentOf(messages, { id = 'session-1', header } = {}) {
  return {
    session: {
      id,
      deriveMessages: () => messages,
      requestHeader: header === undefined ? undefined : () => header,
    },
  }
}

function fakeReader(handler = async () => ({ model: 'reader-provider/reader-model', text: 'answer', truncated: false })) {
  const calls = []
  return {
    calls,
    async read(input) {
      calls.push(input)
      return handler(input)
    },
  }
}

function buildTool({ config = { timeoutSeconds: 180 }, reader = fakeReader(), ctx = {} } = {}) {
  const tool = createAskImageTool(ctx, {
    getConfig: () => config,
    reader,
  })
  return { tool, reader, config }
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

/**
 * 一个最小的宿主替身：只实现 import.js 会碰的那几个方法，并记录调用顺序，
 * 这样"按路径读图"这条分支可以在不装宿主的情况下被断言。
 */
function hostOf({ exists = true, writeFails } = {}) {
  const calls = { resolve: [], stat: [], readBytes: [], saveImage: [], emit: [] }
  const target = { displayPath: '/work/shot.png' }
  const ref = {
    attachmentId: 'sha256:1234abcd',
    mediaType: 'image/png',
    bytes: PNG_BYTES.byteLength,
    width: 4,
    height: 3,
  }
  const ctx = {
    get(name) {
      if (name === 'fs') {
        return {
          resolve: async (path, options) => {
            calls.resolve.push({ path, options })
            return target
          },
          stat: async () => {
            calls.stat.push(true)
            return exists ? { type: 'file', version: 'v1' } : undefined
          },
          readBytes: async (resolved, signal, maxBytes) => {
            calls.readBytes.push({ target: resolved, maxBytes })
            return PNG_BYTES
          },
          processPath: () => target.displayPath,
        }
      }
      if (name === 'attachments') {
        return {
          imageLimits: {
            maxImageBytes: 5_000_000,
            maxImagesPerMessage: 8,
            maxMessageImageBytes: 4_000_000,
            maxImagePixels: 40_000_000,
            maxImageDimension: 8000,
            mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
          },
          saveImage: async input => {
            calls.saveImage.push(input)
            if (writeFails !== undefined) throw writeFails
            return ref
          },
        }
      }
      return undefined
    },
    emit: (...args) => calls.emit.push(args),
  }
  return { ctx, calls, target, ref }
}

const exec = (agent, signal = undefined) => ({ agent, signal })

test('the definition exposes a JSON Schema parameter object and a readable output', () => {
  const { tool } = buildTool()
  assert.equal(tool.name, 'ask_image')
  assert.match(tool.description, /image-capable model/i)
  assert.equal(tool.parameters.type, 'object')
  assert.equal(tool.parameters.additionalProperties, false)
  assert.equal(tool.parameters.properties.image.type, 'string')
  assert.equal(tool.parameters.properties.path.type, 'string')
  assert.equal(tool.parameters.properties.purpose.type, 'string')
  assert.ok(tool.parameters.properties.image.description.length > 0)
  assert.ok(tool.parameters.properties.path.description.length > 0)
  assert.ok(tool.parameters.properties.purpose.description.length > 0)

  assert.deepEqual(tool.output.schema.required, ['image', 'model', 'text'])
  assert.deepEqual(
    tool.output.render({}, { image: 'sha256:ab12cd34', model: 'p/m', text: 'hello' }),
    [{ type: 'text', text: '[sha256:ab12cd34 via p/m]\nhello' }],
  )
})

test('omitting image selects the most recent image', async () => {
  const messages = [
    message(image('sha256:aaaa1111')),
    message(text('some words'), image('sha256:bbbb2222')),
  ]
  const { tool, reader } = buildTool()

  const result = await tool.execute({}, exec(agentOf(messages)))
  assert.equal(reader.calls.length, 1)
  assert.equal(reader.calls[0].ref.attachmentId, 'sha256:bbbb2222')
  assert.deepEqual(result, {
    image: 'sha256:bbbb2222',
    model: 'reader-provider/reader-model',
    text: 'answer',
  })
})

test('a numeric image selector addresses the 1-based position', async () => {
  const messages = [
    message(image('sha256:aaaa1111')),
    message(image('sha256:bbbb2222')),
  ]
  const { tool, reader } = buildTool()

  await tool.execute({ image: '1' }, exec(agentOf(messages)))
  assert.equal(reader.calls[0].ref.attachmentId, 'sha256:aaaa1111')
})

test('a tag selector is case-insensitive and accepts the sha256: prefix', async () => {
  const messages = [
    message(image('sha256:AAAA1111')),
    message(image('sha256:BBBB2222')),
  ]
  const { tool, reader } = buildTool()

  await tool.execute({ image: 'aaaa' }, exec(agentOf(messages)))
  assert.equal(reader.calls[0].ref.attachmentId, 'sha256:AAAA1111')

  await tool.execute({ image: 'sha256:BBBB' }, exec(agentOf(messages)))
  assert.equal(reader.calls[1].ref.attachmentId, 'sha256:BBBB2222')
})

test('a conversation without images fails before calling the reader', async () => {
  const { tool, reader } = buildTool()
  await assert.rejects(
    tool.execute({}, exec(agentOf([message(text('hello'))]))),
    /no images/i,
  )
  assert.equal(reader.calls.length, 0)
})

test('a call without an agent fails', async () => {
  const { tool, reader } = buildTool()
  await assert.rejects(tool.execute({}, {}), /agent context/i)
  assert.equal(reader.calls.length, 0)
})

test('a miss lists the tags and positions that would have matched', async () => {
  const messages = [
    message(image('sha256:aaaa1111')),
    message(image('sha256:bbbb2222')),
  ]
  const { tool, reader } = buildTool()

  await assert.rejects(
    tool.execute({ image: 'ffff' }, exec(agentOf(messages))),
    error => {
      assert.match(error.message, /No image matches "ffff"/)
      assert.match(error.message, /sha256:aaaa1111 \(1\)/)
      assert.match(error.message, /sha256:bbbb2222 \(2\)/)
      return true
    },
  )
  assert.equal(reader.calls.length, 0)
})

test('the reader receives the session id, the abort signal, and the conversation route', async () => {
  const header = { config: { provider: 'conversation-provider', model: 'conversation-model' } }
  const agent = agentOf([message(image('sha256:aaaa1111'))], { id: 'session-42', header })
  const signal = new AbortController().signal
  const { tool, reader } = buildTool()

  await tool.execute({ purpose: 'what is written here?' }, exec(agent, signal))

  assert.deepEqual(reader.calls[0], {
    ref: ref('sha256:aaaa1111'),
    purpose: 'what is written here?',
    signal,
    sessionId: 'session-42',
    preferSameProvider: header.config,
  })
})

const failureCases = [
  ['NO_READER', () => new ImageReaderError('no reader', 'NO_READER'), /No image-capable model/],
  ['NO_SUCH_MODEL', () => new ImageReaderError('missing', 'NO_SUCH_MODEL'), /reader model configured .* is not available/i],
  ['TEXT_ONLY_READER', () => new ImageReaderError('text only', 'TEXT_ONLY_READER'), /accepts text only/],
  ['IMAGE_READER_TIMEOUT', () => Object.assign(new Error('image reader timed out'), { code: 'IMAGE_READER_TIMEOUT' }), /within 42 seconds/],
  ['IMAGE_READER_ABORTED', () => Object.assign(new Error('image reader was aborted'), { code: 'IMAGE_READER_ABORTED' }), /was cancelled/],
  ['IMAGE_READER_EMPTY', () => Object.assign(new Error('empty'), { code: 'IMAGE_READER_EMPTY' }), /returned no text/],
  ['IMAGE_READER_TOOL_CALLS', () => Object.assign(new Error('tool calls'), { code: 'IMAGE_READER_TOOL_CALLS' }), /tool calls instead of text/],
]

for (const [label, makeError, expected] of failureCases) {
  test(`maps ${label} to a model-readable sentence`, async () => {
    const config = { timeoutSeconds: 42 }
    const reader = fakeReader(async () => {
      throw makeError()
    })
    const { tool } = buildTool({ config, reader })

    await assert.rejects(
      tool.execute({}, exec(agentOf([message(image('sha256:aaaa1111'))]))),
      error => expected.test(error.message),
    )
  })
}

test('an AbortError without a code is explained as a cancellation', async () => {
  const abort = new Error('aborted')
  abort.name = 'AbortError'
  const reader = fakeReader(async () => {
    throw abort
  })
  const { tool } = buildTool({ reader })

  await assert.rejects(
    tool.execute({}, exec(agentOf([message(image('sha256:aaaa1111'))]))),
    error => /was cancelled/.test(error.message),
  )
})

test('an unknown reader error keeps the provider message', async () => {
  const reader = fakeReader(async () => {
    throw new Error('provider exploded: bad key')
  })
  const { tool } = buildTool({ reader })

  await assert.rejects(
    tool.execute({}, exec(agentOf([message(image('sha256:aaaa1111'))]))),
    error => error.message === 'provider exploded: bad key',
  )
})

test('an unknown error without a message gets a generic sentence', async () => {
  const reader = fakeReader(async () => {
    throw new Error('')
  })
  const { tool } = buildTool({ reader })

  await assert.rejects(
    tool.execute({}, exec(agentOf([message(image('sha256:aaaa1111'))]))),
    error => /failed without a message/.test(error.message),
  )
})

test('timeoutMs follows timeoutSeconds and is fixed when the tool is registered', () => {
  const config = { timeoutSeconds: 30 }
  const { tool } = buildTool({ config })
  assert.equal(tool.timeoutMs, 30 * 1000 + 15000)

  config.timeoutSeconds = 1
  assert.equal(tool.timeoutMs, 30 * 1000 + 15000, 'changing settings does not rewrite an existing registration')

  const { tool: fallback } = buildTool({ config: { timeoutSeconds: 0 } })
  assert.equal(fallback.timeoutMs, 16 * 1000)
})

test('a path reads that file and never asks the conversation for images', async () => {
  const host = hostOf()
  const agent = agentOf([message(text('no images here'))])
  const signal = new AbortController().signal
  const { tool, reader } = buildTool({ ctx: host.ctx })

  const result = await tool.execute({ path: '  /work/shot.png  ', purpose: 'what is on it?' }, exec(agent, signal))

  assert.equal(host.calls.resolve.length, 1)
  assert.equal(host.calls.resolve[0].path, '/work/shot.png')
  assert.equal(host.calls.saveImage.length, 1)
  assert.equal(host.calls.saveImage[0].name, 'shot.png')
  assert.deepEqual(reader.calls[0].ref, host.ref)
  assert.equal(reader.calls[0].purpose, 'what is on it?')
  assert.equal(reader.calls[0].signal, signal)
  assert.deepEqual(result, {
    image: '/work/shot.png',
    model: 'reader-provider/reader-model',
    text: 'answer',
  })
})

test('a path wins over an image tag in the same call', async () => {
  const host = hostOf()
  const messages = [message(image('sha256:aaaa1111'))]
  const { tool, reader } = buildTool({ ctx: host.ctx })

  const result = await tool.execute({ path: '/work/shot.png', image: 'aaaa' }, exec(agentOf(messages)))

  assert.equal(host.calls.resolve.length, 1)
  assert.equal(reader.calls[0].ref.attachmentId, 'sha256:1234abcd')
  assert.equal(result.image, '/work/shot.png')
})

test('turning pathImport off refuses with a next step and touches no file', async () => {
  const host = hostOf()
  const { tool, reader } = buildTool({ ctx: host.ctx, config: { timeoutSeconds: 180, pathImport: false } })

  await assert.rejects(
    tool.execute({ path: '/work/shot.png' }, exec(agentOf([message(text('x'))]))),
    /turned off.*Configure/is,
  )
  assert.equal(host.calls.resolve.length, 0)
  assert.equal(reader.calls.length, 0)
})

test('a missing file surfaces the import message instead of the reader', async () => {
  const host = hostOf({ exists: false })
  const { tool, reader } = buildTool({ ctx: host.ctx })

  await assert.rejects(
    tool.execute({ path: '/work/shot.png' }, exec(agentOf([message(text('x'))]))),
    /cannot read "\/work\/shot.png": not found/,
  )
  assert.equal(host.calls.saveImage.length, 0)
  assert.equal(reader.calls.length, 0)
})

test('a profile without the filesystem service explains what is missing', async () => {
  const { tool, reader } = buildTool({ ctx: {} })

  await assert.rejects(
    tool.execute({ path: '/work/shot.png' }, exec(agentOf([message(text('x'))]))),
    /no filesystem or attachment service/i,
  )
  assert.equal(reader.calls.length, 0)
})

test('the conversation branch still tells the model that a path is the other way', async () => {
  const { tool } = buildTool()
  await assert.rejects(
    tool.execute({}, exec(agentOf([message(text('hello'))]))),
    /pass its `path`/i,
  )
})
