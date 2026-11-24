// 保证配置归一化对普通值和 Loader 的 volatile 引用 {get()} 都成立，且默认值/夹取规则稳定。
import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULTS, settingsFrom } from '../lib/config.js'
import { DEFAULT_PROMPT, PROMPT_TEMPLATE } from '../lib/prompt.js'

const volatile = value => ({ get: () => value })

test('settingsFrom fills every default from an empty or missing config', () => {
  assert.deepEqual(settingsFrom({}), DEFAULTS)
  assert.deepEqual(settingsFrom(undefined), DEFAULTS)
  assert.deepEqual(settingsFrom(null), DEFAULTS)
})

test('settingsFrom reads volatile references field by field', () => {
  const config = {
    readerMode: volatile('fixed'),
    readerProvider: volatile('  provider-a  '),
    readerModel: volatile('  model-b  '),
    preferProviders: volatile(['one', 'two']),
    promptTemplate: volatile('P {{purpose}}'),
    defaultPrompt: volatile('D {{maxChars}}'),
    maxChars: volatile(123),
    timeoutSeconds: volatile(45),
    bridgeAdmission: volatile(false),
    pathImport: volatile(false),
    cacheEntries: volatile(7),
  }

  assert.deepEqual(settingsFrom(config), {
    readerMode: 'fixed',
    readerProvider: 'provider-a',
    readerModel: 'model-b',
    preferProviders: ['one', 'two'],
    promptTemplate: 'P {{purpose}}',
    defaultPrompt: 'D {{maxChars}}',
    maxChars: 123,
    timeoutSeconds: 45,
    bridgeAdmission: false,
    pathImport: false,
    cacheEntries: 7,
  })
})

test('pathImport defaults to true and only an explicit false turns it off', () => {
  assert.equal(settingsFrom({}).pathImport, true)
  assert.equal(settingsFrom({ pathImport: false }).pathImport, false)
  assert.equal(settingsFrom({ pathImport: 0 }).pathImport, true)
  assert.equal(settingsFrom({ pathImport: volatile(false) }).pathImport, false)
})

test('settingsFrom can mix plain values and volatile references', () => {
  const settings = settingsFrom({
    readerMode: 'fixed',
    readerProvider: volatile(' p '),
    readerModel: 'm',
    maxChars: volatile(50),
  })

  assert.equal(settings.readerMode, 'fixed')
  assert.equal(settings.readerProvider, 'p')
  assert.equal(settings.readerModel, 'm')
  assert.equal(settings.maxChars, 50)
})

test('a volatile reference is read at call time, so a later save is visible', () => {
  let mode = 'auto'
  const config = { readerMode: volatile(mode) }
  config.readerMode = { get: () => mode }

  assert.equal(settingsFrom(config).readerMode, 'auto')
  mode = 'fixed'
  assert.equal(settingsFrom(config).readerMode, 'fixed')
})

test('settingsFrom trims strings and rejects non-string reader fields', () => {
  const settings = settingsFrom({
    readerProvider: '  gcai  ',
    readerModel: 42,
    preferProviders: [' a ', '', 3, null, 'b'],
  })

  assert.equal(settings.readerProvider, 'gcai')
  assert.equal(settings.readerModel, '')
  assert.deepEqual(settings.preferProviders, [' a ', 'b'])
})

test('readerMode only accepts the literal fixed; anything else is auto', () => {
  assert.equal(settingsFrom({ readerMode: 'fixed' }).readerMode, 'fixed')
  for (const value of ['FIXED', 'auto', ' fixed ', undefined, null, 1]) {
    assert.equal(settingsFrom({ readerMode: value }).readerMode, 'auto')
  }
})

test('settingsFrom clamps maxChars, timeoutSeconds, and cacheEntries', () => {
  assert.equal(settingsFrom({ maxChars: 0 }).maxChars, 8000)
  assert.equal(settingsFrom({ maxChars: -5 }).maxChars, 8000)
  assert.equal(settingsFrom({ maxChars: Number.NaN }).maxChars, 8000)
  assert.equal(settingsFrom({ maxChars: 12.9 }).maxChars, 12)

  assert.equal(settingsFrom({ timeoutSeconds: 0 }).timeoutSeconds, 180)
  assert.equal(settingsFrom({ timeoutSeconds: -1 }).timeoutSeconds, 180)
  assert.equal(settingsFrom({ timeoutSeconds: 3.7 }).timeoutSeconds, 3)

  assert.equal(settingsFrom({ cacheEntries: -1 }).cacheEntries, 200)
  assert.equal(settingsFrom({ cacheEntries: 1.5 }).cacheEntries, 1)
  assert.equal(settingsFrom({ cacheEntries: 0 }).cacheEntries, 0)
})

test('bridgeAdmission is only off when explicitly false', () => {
  assert.equal(settingsFrom({ bridgeAdmission: false }).bridgeAdmission, false)
  for (const value of [true, 0, 'false', undefined, null]) {
    assert.equal(settingsFrom({ bridgeAdmission: value }).bridgeAdmission, true)
  }
})

test('blank prompt fields fall back to the built-in prompts', () => {
  const settings = settingsFrom({ promptTemplate: '', defaultPrompt: '' })
  assert.equal(settings.promptTemplate, PROMPT_TEMPLATE)
  assert.equal(settings.defaultPrompt, DEFAULT_PROMPT)

  const custom = settingsFrom({ promptTemplate: 'custom', defaultPrompt: 'fallback' })
  assert.equal(custom.promptTemplate, 'custom')
  assert.equal(custom.defaultPrompt, 'fallback')
})
