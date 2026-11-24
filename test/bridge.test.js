// 保证准入桥只改“显式声明纯文本”的模态，二次安装不叠加，且卸载不会覆盖后装的包装。
import test from 'node:test'
import assert from 'node:assert/strict'

import { installAdmissionBridge, originalResolveModelInfo } from '../lib/bridge.js'

function setup(resolve) {
  const logs = []
  // One info object per model, so "untouched" can be asserted by identity: the
  // bridge must hand back the very object the resolver produced.
  const resolved = new Map()
  const llm = {
    resolveModelInfo: resolve ?? (async (provider, model) => {
      if (!resolved.has(model)) {
        const modalities = {
          'text-model': ['text'],
          'image-model': ['text', 'image'],
          'empty-model': [],
        }[model]
        resolved.set(model, { provider, id: model, inputModalities: modalities })
      }
      return resolved.get(model)
    }),
  }
  const ctx = {
    llm,
    logger: () => ({
      debug(message) {
        logs.push(message)
      },
      info() {},
      warn() {},
    }),
  }
  return { ctx, llm, logs }
}

test('the bridge appends image to an explicit, non-empty text-only modality list', async () => {
  const { ctx, llm } = setup()
  const original = llm.resolveModelInfo
  installAdmissionBridge(ctx)

  assert.notEqual(llm.resolveModelInfo, original)
  const info = await llm.resolveModelInfo('provider', 'text-model')
  assert.deepEqual(info.inputModalities, ['text', 'image'])
})

test('the bridge leaves image support, unknown, empty, and missing info untouched', async () => {
  const { ctx, llm } = setup()
  const original = llm.resolveModelInfo
  installAdmissionBridge(ctx)

  const imageInfo = await llm.resolveModelInfo('provider', 'image-model')
  assert.equal(imageInfo, await original('provider', 'image-model'))

  for (const model of ['unknown-model', 'empty-model']) {
    assert.equal(await llm.resolveModelInfo('provider', model), await original('provider', model))
  }
})

test('the bridge does not mutate the original info object or array', async () => {
  const originalInfo = { provider: 'p', id: 'text-model', inputModalities: ['text'] }
  const { ctx, llm } = setup(async () => originalInfo)
  installAdmissionBridge(ctx)

  const info = await llm.resolveModelInfo('p', 'text-model')
  assert.notEqual(info, originalInfo)
  assert.deepEqual(originalInfo.inputModalities, ['text'])
  assert.deepEqual(info.inputModalities, ['text', 'image'])
})

test('the bridge forwards provider, model, and signal to the original resolver', async () => {
  const calls = []
  const { ctx, llm } = setup(async (...args) => {
    calls.push(args)
    return { provider: args[0], id: args[1], inputModalities: ['text'] }
  })
  installAdmissionBridge(ctx)

  const signal = new AbortController().signal
  await llm.resolveModelInfo('p', 'm', signal)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], ['p', 'm', signal])
})

test('a second install is a no-op and its disposer does not restore the first bridge', async () => {
  const { ctx, llm } = setup()
  const original = llm.resolveModelInfo

  const disposeFirst = installAdmissionBridge(ctx)
  const bridged = llm.resolveModelInfo
  const disposeSecond = installAdmissionBridge(ctx)

  assert.equal(typeof disposeSecond, 'function')
  disposeSecond()
  assert.equal(llm.resolveModelInfo, bridged)
  assert.deepEqual((await llm.resolveModelInfo('p', 'text-model')).inputModalities, ['text', 'image'])

  disposeFirst()
  assert.equal(llm.resolveModelInfo, original)
})

test('the disposer restores the unpatched resolver', async () => {
  const { ctx, llm } = setup()
  const original = llm.resolveModelInfo
  const dispose = installAdmissionBridge(ctx)

  dispose()
  assert.equal(llm.resolveModelInfo, original)
  assert.deepEqual((await llm.resolveModelInfo('p', 'text-model')).inputModalities, ['text'])
})

test('uninstall leaves a third-party wrapper installed after us in place', async () => {
  const { ctx, llm } = setup()
  const dispose = installAdmissionBridge(ctx)
  const thirdParty = async () => ({ provider: 'p', id: 'third', inputModalities: ['text'] })
  llm.resolveModelInfo = thirdParty

  dispose()
  assert.equal(llm.resolveModelInfo, thirdParty)
})

test('an uninstall under a later wrapper keeps the unpatched resolver reachable', async () => {
  const { ctx, llm } = setup()
  const original = llm.resolveModelInfo
  const dispose = installAdmissionBridge(ctx)
  const thirdParty = async () => ({ provider: 'p', id: 'third', inputModalities: ['text'] })
  llm.resolveModelInfo = thirdParty

  dispose()
  assert.equal(llm.resolveModelInfo, thirdParty)
  // The bridge is still in the chain, so the slot has to survive: dropping it
  // here is what made the capability lookup read the fabricated answer.
  assert.deepEqual((await originalResolveModelInfo(ctx)('p', 'text-model')).inputModalities, ['text'])
})

test('a bridge left installed without its slot is adopted, not stacked', async () => {
  const { ctx, llm } = setup()
  const original = llm.resolveModelInfo
  installAdmissionBridge(ctx)
  const bridged = llm.resolveModelInfo
  delete llm[Symbol.for('@szleaves/dsh-image-to-text.admission-bridge')]

  // The marker on the function alone recovers the unpatched resolver.
  assert.deepEqual((await originalResolveModelInfo(ctx)('p', 'text-model')).inputModalities, ['text'])

  const dispose = installAdmissionBridge(ctx)
  assert.equal(llm.resolveModelInfo, bridged, 'the existing wrapper is adopted, not wrapped again')
  assert.deepEqual((await llm.resolveModelInfo('p', 'text-model')).inputModalities, ['text', 'image'])

  dispose()
  assert.equal(llm.resolveModelInfo, original)
})

test('after a real uninstall the bridge can be installed again', async () => {
  const { ctx, llm } = setup()
  const dispose = installAdmissionBridge(ctx)
  dispose()

  installAdmissionBridge(ctx)
  assert.deepEqual((await llm.resolveModelInfo('p', 'text-model')).inputModalities, ['text', 'image'])
})

test('originalResolveModelInfo bypasses the bridge', async () => {
  const { ctx, llm } = setup()
  const original = originalResolveModelInfo(ctx)
  assert.deepEqual((await original('p', 'text-model')).inputModalities, ['text'])

  installAdmissionBridge(ctx)
  assert.deepEqual((await llm.resolveModelInfo('p', 'text-model')).inputModalities, ['text', 'image'])
  assert.deepEqual((await originalResolveModelInfo(ctx)('p', 'text-model')).inputModalities, ['text'])
})

test('both exports reject a context without resolveModelInfo', () => {
  assert.throws(() => installAdmissionBridge({}), TypeError)
  assert.throws(() => originalResolveModelInfo({}), TypeError)
  assert.throws(() => installAdmissionBridge({ llm: {} }), TypeError)
  assert.throws(() => originalResolveModelInfo({ llm: {} }), TypeError)
})

test('a resolver error passes through the bridge unchanged', async () => {
  const failure = new Error('catalog unavailable')
  const { ctx, llm } = setup(async () => {
    throw failure
  })
  installAdmissionBridge(ctx)

  await assert.rejects(llm.resolveModelInfo('p', 'm'), error => error === failure)
})
