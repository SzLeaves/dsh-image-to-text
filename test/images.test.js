// 保证模型能从会话日志里定位到正确的图片：标签与占位符一致，序号、省略、大小写都不歧义。
import test from 'node:test'
import assert from 'node:assert/strict'

import { collectImages, imageIdentity, pickImage } from '../lib/images.js'

const attachment = (attachmentId, extra = {}) => ({
  attachmentId,
  mediaType: 'image/png',
  bytes: 1024,
  width: 640,
  height: 480,
  ...extra,
})

const imageBlock = (attachmentId, extra = {}) => ({
  type: 'image',
  attachment: attachment(attachmentId),
  ...extra,
})

const message = (...content) => ({ id: 'm', role: 'user', content })

test('collectImages keeps order, starts index at 1, and lower-cases the 8-char tag', () => {
  const messages = [
    message({ type: 'text', text: 'hi' }),
    message(imageBlock('sha256:ABCDEF0123456789'), imageBlock('sha256:1122334455')),
    message({ type: 'image' }, { type: 'image', attachment: {} }, { type: 'image', attachment: { attachmentId: 7 } }),
    null,
    { role: 'user' },
  ]

  const images = collectImages(messages)
  assert.equal(images.length, 2)
  assert.deepEqual(images.map(image => image.index), [1, 2])
  assert.deepEqual(images.map(image => image.tag), ['abcdef01', '11223344'])
  assert.equal(images[0].ref.attachmentId, 'sha256:ABCDEF0123456789')
})

test('collectImages tolerates a non-array message list', () => {
  assert.deepEqual(collectImages(undefined), [])
  assert.deepEqual(collectImages(null), [])
  assert.deepEqual(collectImages('nope'), [])
})

test('collectImages keeps offloaded images, since the durable attachment is still readable', () => {
  const images = collectImages([message(imageBlock('sha256:aabbccdd', { offloaded: true }))])
  assert.equal(images.length, 1)
  assert.equal(images[0].tag, 'aabbccdd')
})

test('pickImage: absent, null, or blank selector means the most recent image', () => {
  const images = collectImages([
    message(imageBlock('sha256:aaaa1111')),
    message(imageBlock('sha256:bbbb2222')),
  ])

  for (const selector of [undefined, null, '', '   ']) {
    assert.equal(pickImage(images, selector)?.tag, 'bbbb2222')
  }
})

test('pickImage: a numeric selector addresses the 1-based position', () => {
  const images = collectImages([
    message(imageBlock('sha256:aaaa1111')),
    message(imageBlock('sha256:bbbb2222')),
  ])

  assert.equal(pickImage(images, '1')?.tag, 'aaaa1111')
  assert.equal(pickImage(images, 2)?.tag, 'bbbb2222')
  assert.equal(pickImage(images, '0'), undefined)
  assert.equal(pickImage(images, '9'), undefined)
})

test('pickImage: tags match case-insensitively and accept a sha256: prefix', () => {
  const images = collectImages([
    message(imageBlock('sha256:AAAA1111')),
    message(imageBlock('sha256:BBBB2222')),
  ])

  assert.equal(pickImage(images, 'aaaa')?.tag, 'aaaa1111')
  assert.equal(pickImage(images, 'bbbb2222')?.tag, 'bbbb2222')
  assert.equal(pickImage(images, 'sha256:BBBB')?.tag, 'bbbb2222')
  assert.equal(pickImage(images, 'sha256:aaaa1111')?.tag, 'aaaa1111')
  assert.equal(pickImage(images, 'ffff'), undefined)
})

test('pickImage: multiple prefix hits resolve to the newest occurrence', () => {
  const images = collectImages([
    message(imageBlock('sha256:abcd1111')),
    message(imageBlock('sha256:abcd9999')),
  ])

  assert.equal(pickImage(images, 'abcd')?.tag, 'abcd9999')
  assert.equal(pickImage(images, 'abc')?.tag, 'abcd9999')
})

test('pickImage: an empty collection has no answer', () => {
  assert.equal(pickImage([], '1'), undefined)
  assert.equal(pickImage([], undefined), undefined)
})

test('imageIdentity uses the same sha256:tag shape the model sees', () => {
  assert.equal(imageIdentity({ tag: 'ab12cd34' }), 'sha256:ab12cd34')
})
