// 保证磁盘上的图片能安全地变成附件引用：先验路径与格式，再受字节上限约束，失败一律给出可执行的错误码。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  IMAGE_EXTENSIONS, ImageImportError, importImageFile, mediaTypeForPath, sniffMediaType,
} from '../lib/import.js'

const LIMITS = {
  maxImageBytes: 8 * 1024 * 1024, maxImagesPerMessage: 8, maxMessageImageBytes: 6 * 1024 * 1024,
  maxImagePixels: 40_000_000, maxImageDimension: 8192,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
}

const ascii = text => Uint8Array.from([...text].map(char => char.charCodeAt(0)))
const pngBytes = () => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00])
const jpegBytes = () => Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])
const webpBytes = () => Uint8Array.from([...ascii('RIFF'), 0x20, 0x00, 0x00, 0x00, ...ascii('WEBP')])

// 假宿主：每个服务都记录调用参数，个别行为用传入的函数覆盖，测试只关心差异。
function harness({
  limits = LIMITS,
  agent = { id: 'agent-1' },
  withFs = true,
  withAttachments = true,
  withWorkingDirectory = true,
  stat = async () => ({ type: 'file', version: 'v1' }),
  resolve,
  readBytes,
  bytes = pngBytes(),
  saveImage,
} = {}) {
  const calls = { get: [], resolve: [], stat: [], readBytes: [], saveImage: [], emit: [], ensure: [] }

  const fs = {
    async resolve(requestedPath, options) {
      calls.resolve.push({ requestedPath, options })
      if (resolve !== undefined) return resolve(requestedPath, options)
      return { displayPath: requestedPath.startsWith('/') ? requestedPath : `/work/${requestedPath}` }
    },
    async stat(target, signal) {
      calls.stat.push({ target, signal })
      return stat(target, signal)
    },
    async readBytes(target, signal, cap) {
      calls.readBytes.push({ target, signal, cap })
      return readBytes === undefined ? bytes : readBytes(target, signal, cap)
    },
  }

  const attachments = {
    imageLimits: limits,
    async saveImage(input) {
      calls.saveImage.push(input)
      if (saveImage !== undefined) return saveImage(input)
      return { attachmentId: 'sha256:ab12cd34', mediaType: input.mediaType, bytes: input.data.byteLength, width: 4, height: 4 }
    },
  }

  const workingDirectory = {
    async ensure(agentValue, signal) {
      calls.ensure.push({ agent: agentValue, signal })
      return '/work'
    },
  }

  const services = {
    fs: withFs ? fs : undefined,
    attachments: withAttachments ? attachments : undefined,
    workingDirectory: withWorkingDirectory ? workingDirectory : undefined,
  }

  const ctx = {
    get(name) {
      calls.get.push(name)
      return services[name]
    },
    emit(eventName, target, payload, exec) {
      calls.emit.push({ eventName, target, payload, exec })
    },
  }

  return { ctx, calls, agent }
}

const importPath = (h, path, exec = { agent: h.agent }) => importImageFile(h.ctx, { path, exec })

// 取回失败对象以便检查 code、message 与 cause；若反而成功则测试失败。
async function failure(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  assert.fail('expected the import to fail')
}

// 扩展名映射必须与 IMAGE_EXTENSIONS 完全一致，大小写不敏感，且绝不替未知后缀猜格式。
test('mediaTypeForPath maps every known extension and refuses unknown or missing ones', () => {
  for (const [extension, mediaType] of Object.entries(IMAGE_EXTENSIONS)) {
    assert.equal(mediaTypeForPath(`/work/shot${extension}`), mediaType)
    assert.equal(mediaTypeForPath(`/work/shot${extension.toUpperCase()}`), mediaType)
  }
  assert.equal(mediaTypeForPath('/work/SHOT.PNG'), 'image/png')
  assert.equal(mediaTypeForPath('/work/shot.bmp'), undefined)
  assert.equal(mediaTypeForPath('shot'), undefined)
})

// 嗅探只看真实签名：短缓冲、RIFF 却非 WEBP、以及不是字节数组的输入都不能猜出格式。
test('sniffMediaType reads real signatures only and shrugs at anything else', () => {
  assert.equal(sniffMediaType(pngBytes()), 'image/png')
  assert.equal(sniffMediaType(jpegBytes()), 'image/jpeg')
  assert.equal(sniffMediaType(ascii('GIF87a')), 'image/gif')
  assert.equal(sniffMediaType(ascii('GIF89a')), 'image/gif')
  assert.equal(sniffMediaType(webpBytes()), 'image/webp')
  assert.equal(sniffMediaType(Uint8Array.from([0x89, 0x50, 0x4e])), undefined)
  assert.equal(sniffMediaType(Uint8Array.from([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WAVE')])), undefined)
  assert.equal(sniffMediaType(undefined), undefined)
  assert.equal(sniffMediaType(null), undefined)
  assert.equal(sniffMediaType([0x89, 0x50, 0x4e, 0x47]), undefined)
  assert.equal(sniffMediaType('GIF89a'), undefined)
})

// 成功的导入必须按 resolve → stat → 限长 read → save → fs/observed 的顺序走完，参数一处都不能错。
test('an image file becomes an attachment through resolve, stat, capped read, save, and observation', async () => {
  const signal = new AbortController().signal
  const data = pngBytes()
  const saved = { attachmentId: 'sha256:ab12cd34', mediaType: 'image/png', bytes: data.byteLength, width: 4, height: 4, name: 'shot.png' }
  const h = harness({ bytes: data, saveImage: async () => saved })
  const exec = { agent: h.agent, signal }

  const result = await importImageFile(h.ctx, { path: '/work/shot.png', exec })
  assert.equal(h.calls.resolve.length, 1)
  assert.equal(h.calls.resolve[0].requestedPath, '/work/shot.png')
  assert.equal(h.calls.resolve[0].options.cwd, '/work')
  assert.equal(h.calls.resolve[0].options.signal, signal)
  const target = h.calls.stat[0].target
  assert.equal(target.displayPath, '/work/shot.png')
  assert.equal(h.calls.readBytes[0].cap, Math.min(LIMITS.maxImageBytes, LIMITS.maxMessageImageBytes))
  assert.equal(h.calls.saveImage.length, 1)
  assert.equal(h.calls.saveImage[0].data, data)
  assert.equal(h.calls.saveImage[0].mediaType, 'image/png')
  assert.equal(h.calls.saveImage[0].name, 'shot.png')
  assert.strictEqual(result.ref, saved)
  assert.equal(result.displayPath, '/work/shot.png')
  assert.equal(result.mediaType, 'image/png')
  assert.equal(result.bytes, data.byteLength)
  assert.equal(h.calls.emit.length, 1)
  assert.equal(h.calls.emit[0].eventName, 'fs/observed')
  assert.strictEqual(h.calls.emit[0].target, target)
  assert.deepEqual(h.calls.emit[0].payload, { kind: 'present', version: 'v1' })
  assert.strictEqual(h.calls.emit[0].exec, exec)
})

// 没有扩展名的临时文件要靠字节判断格式，不能因为名字没说法就拒绝。
test('a path without an extension takes its media type from the bytes, not the name', async () => {
  const h = harness({ bytes: pngBytes() })

  const result = await importPath(h, '/work/shot')
  assert.equal(result.mediaType, 'image/png')
  assert.equal(h.calls.saveImage[0].mediaType, 'image/png')
  assert.equal(h.calls.saveImage[0].name, 'shot')
})

// 没有 agent 就没有工作目录可对齐，resolve 的选项里不能凭空出现 cwd。
test('without an agent the resolve options carry no cwd and workingDirectory is never asked', async () => {
  const h = harness()

  await importPath(h, '/work/shot.png', {})
  assert.ok(!('cwd' in h.calls.resolve[0].options))
  assert.equal(h.calls.ensure.length, 0)
  assert.ok(!h.calls.get.includes('workingDirectory'))
})

// 文件不存在时要报 NOT_FOUND、把目标标记为 absent，而且绝不尝试保存。
test('a missing file is reported as IMAGE_PATH_NOT_FOUND and observed as absent', async () => {
  const h = harness({ stat: async () => undefined })

  const error = await failure(importPath(h, '/work/shot.png'))
  assert.ok(error instanceof ImageImportError)
  assert.equal(error.name, 'ImageImportError')
  assert.equal(error.code, 'IMAGE_PATH_NOT_FOUND')
  assert.match(error.message, /\/work\/shot\.png/)
  assert.equal(h.calls.saveImage.length, 0)
  assert.equal(h.calls.emit.length, 1)
  assert.equal(h.calls.emit[0].eventName, 'fs/observed')
  assert.strictEqual(h.calls.emit[0].target, h.calls.stat[0].target)
  assert.deepEqual(h.calls.emit[0].payload, { kind: 'absent' })
})

// 目录不是图片，要在读字节之前就拒绝，避免把整棵目录树当文件打开。
test('a directory is refused as IMAGE_PATH_NOT_FILE without reading bytes', async () => {
  const h = harness({ stat: async () => ({ type: 'directory' }) })

  const error = await failure(importPath(h, '/work/shot.png'))
  assert.equal(error.code, 'IMAGE_PATH_NOT_FILE')
  assert.match(error.message, /not a regular file/)
  assert.equal(h.calls.readBytes.length, 0)
})

// 明显不支持的扩展名要在碰文件系统之前就失败，省掉一次无意义的路径解析。
test('an unsupported extension fails before the path is resolved', async () => {
  const h = harness()

  const error = await failure(importPath(h, '/work/shot.bmp'))
  assert.equal(error.code, 'IMAGE_PATH_UNSUPPORTED')
  assert.match(error.message, /\.bmp/)
  assert.equal(h.calls.resolve.length, 0)
})

// 部署不收的格式即使名字合法也不该往下走：媒体类型白名单优先于扩展名。
test('a format outside the deployment limits is unsupported even when the name is valid', async () => {
  const h = harness({ limits: { ...LIMITS, mediaTypes: ['image/jpeg'] } })

  const error = await failure(importPath(h, '/work/shot.png'))
  assert.equal(error.code, 'IMAGE_PATH_UNSUPPORTED')
  assert.match(error.message, /image\/png/)
  assert.equal(h.calls.resolve.length, 0)
})

// 超限文件要单独报 TOO_LARGE，并把实际生效的字节上限写进提示，模型才知道要压到多小。
test('FS_TOO_LARGE becomes IMAGE_PATH_TOO_LARGE with the cap in the sentence', async () => {
  const tooLarge = Object.assign(new Error('too large'), { code: 'FS_TOO_LARGE' })
  const limits = { ...LIMITS, maxImageBytes: 2 * 1024 * 1024, maxMessageImageBytes: 1024 * 1024 }
  const h = harness({ limits, readBytes: async () => { throw tooLarge } })

  const error = await failure(importPath(h, '/work/shot.png'))
  assert.equal(error.code, 'IMAGE_PATH_TOO_LARGE')
  assert.match(error.message, /1\.0 MB/)
  assert.strictEqual(error.cause, tooLarge)
  assert.equal(h.calls.readBytes[0].cap, 1024 * 1024)
})

// 其他读取失败归为 UNREADABLE，并保留底层信息，否则模型无法判断是权限还是磁盘问题。
test('any other read failure becomes IMAGE_PATH_UNREADABLE and keeps the original words', async () => {
  const broken = Object.assign(new Error('disk on fire'), { code: 'EIO' })
  const h = harness({ readBytes: async () => { throw broken } })

  const error = await failure(importPath(h, '/work/shot.png'))
  assert.equal(error.code, 'IMAGE_PATH_UNREADABLE')
  assert.match(error.message, /disk on fire/)
  assert.strictEqual(error.cause, broken)
})

// 扩展名缺省而内容不是图片时必须报 FORMAT，且不能把垃圾字节存进附件库。
test('extension-less text is refused as IMAGE_PATH_FORMAT before anything is stored', async () => {
  const h = harness({ bytes: ascii('just some words') })

  const error = await failure(importPath(h, '/work/shot'))
  assert.equal(error.code, 'IMAGE_PATH_FORMAT')
  assert.equal(h.calls.saveImage.length, 0)
})

const rejectionCases = [
  ['IMAGE_DIMENSION_TOO_LARGE', /at least one side is larger/],
  ['IMAGE_TOO_MANY_PIXELS', /decoded-pixel limit/],
  ['IMAGE_TOO_LARGE', /byte limits/],
  ['IMAGE_TYPE_MISMATCH', /different format/],
  ['INVALID_IMAGE', /do not decode/],
  ['SOMETHING_ELSE', /quota exceeded/],
]

// 每种附件拒绝都要变成可执行的建议，并保留原始 cause 供上层诊断。
for (const [code, expected] of rejectionCases) {
  test(`saveImage rejection ${code} becomes IMAGE_PATH_REJECTED`, async () => {
    const original = Object.assign(new Error(code === 'SOMETHING_ELSE' ? 'quota exceeded' : 'rejected'), { code })
    const h = harness({ saveImage: async () => { throw original } })
    const error = await failure(importPath(h, '/work/shot.png'))
    assert.equal(error.code, 'IMAGE_PATH_REJECTED')
    assert.match(error.message, expected)
    assert.strictEqual(error.cause, original)
    assert.equal(h.calls.emit.length, 0)
  })
}

// 宿主服务缺失时要告诉模型这个 profile 不可用，而不是泄露 TypeError。
test('a profile without fs or attachments says the tool is unavailable', async () => {
  const h = harness({ withFs: false, withAttachments: false })

  const error = await failure(importPath(h, '/work/shot.png'))
  assert.equal(error.code, 'IMAGE_PATH_UNAVAILABLE')
})

// 空白路径在查任何服务之前就该被拒绝，避免拿空串去解析。
test('a blank path is invalid before any service is touched', async () => {
  const h = harness()

  const error = await failure(importPath(h, '   '))
  assert.equal(error.code, 'IMAGE_PATH_INVALID')
  assert.equal(h.calls.get.length, 0)
})

// resolve 本身的失败属于路径无效，原始错误要挂在 cause 上，方便区分越界与拼写错误。
test('a resolve failure becomes IMAGE_PATH_INVALID and keeps the cause', async () => {
  const broken = new Error('outside the sandbox')
  const h = harness({ resolve: async () => { throw broken } })

  const error = await failure(importPath(h, '/work/shot.png'))
  assert.equal(error.code, 'IMAGE_PATH_INVALID')
  assert.match(error.message, /outside the sandbox/)
  assert.strictEqual(error.cause, broken)
  assert.equal(h.calls.stat.length, 0)
})

// 附件库不回报 bytes 时要用刚读到的字节数兜底，返回值不能是 undefined。
test('the returned byte count falls back to the read data when the store omits it', async () => {
  const data = pngBytes()
  const h = harness({
    bytes: data,
    saveImage: async input => ({ attachmentId: 'sha256:ab12cd34', mediaType: input.mediaType, width: 4, height: 4 }),
  })

  const result = await importPath(h, '/work/shot.png')
  assert.equal(result.bytes, data.byteLength)
})
