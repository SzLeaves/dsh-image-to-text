// 保证发给读图模型的提示词正确替换 purpose / maxChars，且截断不会悄悄丢掉整段文本。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  clamp,
  DEFAULT_PROMPT,
  PROMPT_TEMPLATE,
  promptFor,
  READER_SYSTEM,
} from '../lib/prompt.js'

const config = (overrides = {}) => ({
  maxChars: 100,
  promptTemplate: PROMPT_TEMPLATE,
  defaultPrompt: DEFAULT_PROMPT,
  ...overrides,
})

test('promptFor substitutes purpose and maxChars into the template', () => {
  const text = promptFor(config({ promptTemplate: 'P: {{purpose}} / {{maxChars}}' }), 'read the error')
  assert.equal(text, 'P: read the error / 100')
})

test('promptFor trims the purpose and falls back to the generic prompt when it is blank', () => {
  const custom = config({
    promptTemplate: 'P {{purpose}}',
    defaultPrompt: 'Describe it in {{maxChars}} chars',
  })

  assert.equal(promptFor(custom, '   '), 'Describe it in 100 chars')
  assert.equal(promptFor(custom, undefined), 'Describe it in 100 chars')
  assert.equal(promptFor(custom, 42), 'Describe it in 100 chars')
  assert.equal(promptFor(custom, '  question  '), 'P question')
})

test('promptFor substitutes only once, so purpose text is not expanded again', () => {
  const text = promptFor(config({ promptTemplate: '{{purpose}}' }), 'keep {{maxChars}} literal')
  assert.equal(text, 'keep {{maxChars}} literal')
})

test('promptFor leaves unknown placeholders untouched', () => {
  const text = promptFor(config({ promptTemplate: '{{purpose}} {{unknown}}' }), 'go')
  assert.equal(text, 'go {{unknown}}')
})

test('promptFor does not interpret $ replacement patterns in the purpose', () => {
  const text = promptFor(config({ promptTemplate: '{{purpose}}' }), 'cost $& $1')
  assert.equal(text, 'cost $& $1')
})

test('the fixed reader prompts are non-empty English text', () => {
  assert.match(READER_SYSTEM, /images/i)
  assert.match(PROMPT_TEMPLATE, /\{\{purpose\}\}/)
  assert.match(DEFAULT_PROMPT, /\{\{maxChars\}\}/)
})

test('clamp leaves text at or below the limit unchanged', () => {
  const exact = 'x'.repeat(10)
  assert.deepEqual(clamp(exact, 10), { text: exact, truncated: false })
  assert.deepEqual(clamp('short', 10), { text: 'short', truncated: false })
})

test('clamp falls back to 8000 for a missing or invalid limit', () => {
  const text = 'y'.repeat(8001)
  assert.equal(clamp(text, 0).truncated, true)
  assert.equal(clamp(text, NaN).truncated, true)
  assert.equal(clamp('tiny', 0).truncated, false)
})

test('clamp cuts a single long line by characters and marks the cut', () => {
  const { text, truncated } = clamp('x'.repeat(50), 20)
  assert.equal(truncated, true)
  assert.ok(text.length <= 20)
  assert.ok(text.endsWith('\n…[truncated]'))
  assert.ok(text.startsWith('xxxxxxx'))
})

test('clamp cuts at the last newline when it is close enough to the limit', () => {
  const { text, truncated } = clamp('aaaa\nbbbb\ncccc\ndddd\neeee\nffff', 24)
  assert.equal(truncated, true)
  assert.equal(text, 'aaaa\nbbbb\n…[truncated]')
})

test('clamp ignores a newline that is too far from the limit', () => {
  const { text, truncated } = clamp('abc\ndefghijklmnopqrstuvwxyz', 20)
  assert.equal(truncated, true)
  assert.equal(text, 'abc\ndef\n…[truncated]')
})
