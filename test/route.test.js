// 保证 fixed 选路不静默降级、auto 选路排序稳定，并且一个 provider 失败不会淹没其它候选。
import test from 'node:test'
import assert from 'node:assert/strict'

import { ImageReaderError, readerRoute } from '../lib/route.js'

function fakeCtx({ providers = [], models = {}, resolve } = {}) {
  const resolveCalls = []
  const listModelsCalls = []
  const warnings = []

  const ctx = {
    llm: {
      listProviders() {
        return providers.map(provider => (typeof provider === 'string' ? { id: provider } : provider))
      },
      async listModels(providerId) {
        listModelsCalls.push(providerId)
        const entry = models[providerId]
        if (entry instanceof Error) throw entry
        if (typeof entry === 'function') return entry()
        return entry ?? []
      },
      async resolveModelInfo(provider, model) {
        resolveCalls.push([provider, model])
        return typeof resolve === 'function' ? resolve(provider, model) : resolve
      },
    },
    logger: () => ({
      debug() {},
      info() {},
      warn(message) {
        warnings.push(message)
      },
    }),
  }

  return { ctx, resolveCalls, listModelsCalls, warnings }
}

const fixed = (overrides = {}) => ({
  readerMode: 'fixed',
  readerProvider: 'reader-provider',
  readerModel: 'reader-model',
  ...overrides,
})

const imageModel = (id, extra = {}) => ({ id, inputModalities: ['text', 'image'], ...extra })

const rejectsWithCode = code => error => error instanceof ImageReaderError && error.code === code

test('fixed mode returns the configured route when the model accepts images', async () => {
  const { ctx, resolveCalls } = fakeCtx({
    resolve: async (provider, model) => ({ provider, id: model, inputModalities: ['text', 'image'] }),
  })

  assert.deepEqual(await readerRoute(ctx, fixed()), { provider: 'reader-provider', model: 'reader-model' })
  assert.deepEqual(resolveCalls, [['reader-provider', 'reader-model']])
})

test('fixed mode accepts a model whose modalities are unknown', async () => {
  const { ctx } = fakeCtx({ resolve: async (provider, model) => ({ provider, id: model }) })
  assert.deepEqual(await readerRoute(ctx, fixed()), { provider: 'reader-provider', model: 'reader-model' })
})

test('fixed mode rejects an explicitly text-only reader instead of falling back', async () => {
  const { ctx, listModelsCalls } = fakeCtx({
    resolve: async (provider, model) => ({ provider, id: model, inputModalities: ['text'] }),
  })

  await assert.rejects(
    readerRoute(ctx, fixed()),
    error => rejectsWithCode('TEXT_ONLY_READER')(error) && /only accepts text input/.test(error.message),
  )
  assert.deepEqual(listModelsCalls, [], 'fixed mode must not scan the catalog after a negative declaration')
})

test('fixed mode reports an unregistered reader when resolveModelInfo throws', async () => {
  const { ctx } = fakeCtx({
    resolve: async () => {
      throw new Error('model not found')
    },
  })

  await assert.rejects(
    readerRoute(ctx, fixed()),
    error => rejectsWithCode('NO_SUCH_MODEL')(error)
      && /not available/.test(error.message)
      && /model not found/.test(error.message),
  )
})

test('fixed mode reports missing readerProvider/readerModel without asking the llm service', async () => {
  const { ctx, resolveCalls } = fakeCtx({ resolve: async () => undefined })

  for (const config of [
    fixed({ readerProvider: '' }),
    fixed({ readerModel: '' }),
    fixed({ readerProvider: '   ', readerModel: '  ' }),
  ]) {
    await assert.rejects(
      readerRoute(ctx, config),
      error => rejectsWithCode('NO_SUCH_MODEL')(error) && /not both set/.test(error.message),
    )
  }
  assert.deepEqual(resolveCalls, [])
})

test('auto mode ranks preferProviders in list order', async () => {
  const { ctx } = fakeCtx({
    providers: ['a', 'b', 'c'],
    models: {
      a: [imageModel('a-vision')],
      b: [imageModel('b-vision')],
      c: [imageModel('c-vision')],
    },
  })

  assert.deepEqual(
    await readerRoute(ctx, { readerMode: 'auto', preferProviders: ['c', 'b'] }),
    { provider: 'c', model: 'c-vision' },
  )
  assert.deepEqual(
    await readerRoute(ctx, { readerMode: 'auto', preferProviders: ['b', 'c'] }),
    { provider: 'b', model: 'b-vision' },
  )
})

test('auto mode prefers the conversation provider over a visual-looking name', async () => {
  const { ctx } = fakeCtx({
    providers: ['conversation', 'other'],
    models: {
      conversation: [imageModel('plain-model')],
      other: [imageModel('some-vl-model')],
    },
  })

  assert.deepEqual(
    await readerRoute(ctx, { readerMode: 'auto', preferProviders: [] }, {
      preferSameProvider: { provider: 'conversation', model: 'plain-model' },
    }),
    { provider: 'conversation', model: 'plain-model' },
  )
})

test('auto mode ranks visual-looking model ids or names above generic ones', async () => {
  const { ctx } = fakeCtx({
    providers: ['a', 'b'],
    models: {
      a: [imageModel('plain-model', { name: 'General Chat' })],
      b: [imageModel('m2', { name: 'Vision Large' })],
    },
  })

  assert.deepEqual(
    await readerRoute(ctx, { readerMode: 'auto' }),
    { provider: 'b', model: 'm2' },
  )
})

test('auto mode keeps catalog order when nothing else distinguishes candidates', async () => {
  const { ctx } = fakeCtx({
    providers: ['a', 'b'],
    models: {
      a: [imageModel('first')],
      b: [imageModel('second')],
    },
  })

  assert.deepEqual(
    await readerRoute(ctx, { readerMode: 'auto' }),
    { provider: 'a', model: 'first' },
  )
})

test('one failing provider listing does not hide another provider’s models', async () => {
  const { ctx, warnings } = fakeCtx({
    providers: ['broken', 'good'],
    models: {
      broken: new Error('network down'),
      good: [imageModel('good-vl')],
    },
  })

  assert.deepEqual(
    await readerRoute(ctx, { readerMode: 'auto' }),
    { provider: 'good', model: 'good-vl' },
  )
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /broken/)
  assert.match(warnings[0], /network down/)
})

test('auto mode rejects with NO_READER when no model declares image input', async () => {
  const { ctx } = fakeCtx({
    providers: ['a'],
    models: { a: [{ id: 'text-model', inputModalities: ['text'] }, { id: 'unknown-model' }] },
  })

  await assert.rejects(
    readerRoute(ctx, { readerMode: 'auto' }),
    error => rejectsWithCode('NO_READER')(error) && /No image-capable model/.test(error.message),
  )
})

test('auto mode rejects with NO_READER when the llm service is unavailable', async () => {
  await assert.rejects(
    readerRoute({}, { readerMode: 'auto' }),
    rejectsWithCode('NO_READER'),
  )
})

test('auto mode ignores duplicate and malformed provider entries', async () => {
  const { ctx } = fakeCtx({
    providers: ['a', 'a', { name: 'no id' }],
    models: { a: [imageModel('only')] },
  })

  assert.deepEqual(await readerRoute(ctx, { readerMode: 'auto' }), { provider: 'a', model: 'only' })
})

test('ImageReaderError carries a name and a code', () => {
  const error = new ImageReaderError('nope', 'NO_READER')
  assert.equal(error.name, 'ImageReaderError')
  assert.equal(error.code, 'NO_READER')
  assert.equal(error.message, 'nope')
})
