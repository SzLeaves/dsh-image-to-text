/**
 * Turn one image file on disk into a durable attachment reference.
 *
 * `ask_image` reads images that are already in the conversation, addressed by
 * the eight hex characters of their attachment id. That leaves one gap: an
 * image the model produced or found as a file (a rendered slide, a screenshot)
 * is on disk and not in the log, so it has no handle to pass. Reading it here
 * closes the gap in a single call instead of asking the model to import the
 * file with `read_image` first and then address the imported copy.
 *
 * Everything about paths, formats, and size limits is delegated to the host:
 * `ctx.fs` resolves paths inside the backend's execution world and owns the
 * byte cap, `ctx.attachments` sniffs, validates, stores, and reports the
 * dimensions. This module only decides the order and turns rejections into
 * sentences a model can act on.
 */

import { basename, extname } from 'node:path'

/** Formats the attachment service is expected to accept; filtered by its own limits below. */
export const IMAGE_EXTENSIONS = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff]

/** A failure the tool explains to the model in its own words. */
export class ImageImportError extends Error {
  constructor(code, message, options) {
    super(message, options)
    this.name = 'ImageImportError'
    this.code = code
  }
}

function matchesBytes(data, offset, expected) {
  if (data.byteLength < offset + expected.length) return false
  return expected.every((byte, index) => data[offset + index] === byte)
}

function matchesAscii(data, offset, value) {
  if (data.byteLength < offset + value.length) return false
  for (let index = 0; index < value.length; index += 1) {
    if (data[offset + index] !== value.charCodeAt(index)) return false
  }
  return true
}

/** The format an extension claims, or `undefined` when the name claims nothing. */
export function mediaTypeForPath(filePath) {
  return IMAGE_EXTENSIONS[extname(String(filePath)).toLowerCase()]
}

/**
 * The format the bytes actually are. Used when the name claims nothing (a
 * temp file without an extension) and to catch a name that lies about content.
 */
export function sniffMediaType(data) {
  if (data === null || data === undefined || typeof data.byteLength !== 'number') return undefined
  if (matchesBytes(data, 0, PNG_SIGNATURE)) return 'image/png'
  if (matchesBytes(data, 0, JPEG_SIGNATURE)) return 'image/jpeg'
  if (matchesAscii(data, 0, 'GIF87a') || matchesAscii(data, 0, 'GIF89a')) return 'image/gif'
  if (matchesAscii(data, 0, 'RIFF') && matchesAscii(data, 8, 'WEBP')) return 'image/webp'
  return undefined
}

/** Human size for refusal messages; never used to decide anything. */
function megabytes(bytes) {
  const value = bytes / (1024 * 1024)
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} MB`
}

/** One sentence for each attachment rejection the model can recover from. */
function describeAttachmentFailure(error, displayPath) {
  const code = typeof error?.code === 'string' ? error.code : ''
  switch (code) {
    case 'IMAGE_DIMENSION_TOO_LARGE':
      return `cannot read "${displayPath}": at least one side is larger than this deployment's pixel limit; downscale the image and read the smaller copy`
    case 'IMAGE_TOO_MANY_PIXELS':
      return `cannot read "${displayPath}": the image is larger than this deployment's decoded-pixel limit; downscale it and read the smaller copy`
    case 'IMAGE_TOO_LARGE':
      return `cannot read "${displayPath}": the image does not fit this deployment's byte limits; downscale it and read the smaller copy`
    case 'IMAGE_TYPE_MISMATCH':
      return `cannot read "${displayPath}": the bytes are a different format from the one the file name claims; rename or convert it to PNG/JPEG/WebP/GIF`
    case 'INVALID_IMAGE':
      return `cannot read "${displayPath}": the bytes do not decode as a PNG/JPEG/WebP/GIF image; the file may be truncated or corrupt`
    default:
      return `cannot read "${displayPath}" as an image: ${typeof error?.message === 'string' && error.message.length > 0 ? error.message : 'the attachment store rejected it'}`
  }
}

/**
 * Resolve a path, read the bytes within the deployment's limits, and store them
 * as a durable attachment.
 *
 * @param ctx - plugin context; `fs`, `attachments`, and optionally
 *   `workingDirectory` are looked up lazily so the plugin still mounts on a
 *   profile that lacks either service.
 * @param input - `{ path, exec }`: the model-supplied path and the tool
 *   execution whose agent, cwd, and abort signal apply.
 * @returns `{ ref, displayPath, mediaType, bytes }`.
 * @throws ImageImportError for every refusal; nothing partial is left behind.
 */
export async function importImageFile(ctx, input) {
  const requestedPath = String(input?.path ?? '').trim()
  if (requestedPath.length === 0) throw new ImageImportError('IMAGE_PATH_INVALID', 'path must be a non-empty string')

  const fs = typeof ctx?.get === 'function' ? ctx.get('fs') : undefined
  const attachments = typeof ctx?.get === 'function' ? ctx.get('attachments') : undefined
  if (fs === undefined || attachments === undefined) {
    throw new ImageImportError(
      'IMAGE_PATH_UNAVAILABLE',
      `cannot read "${requestedPath}" as an image: this profile has no filesystem or attachment service`,
    )
  }

  const extension = extname(requestedPath).toLowerCase()
  const declared = mediaTypeForPath(requestedPath)
  if (declared === undefined && extension !== '') {
    throw new ImageImportError(
      'IMAGE_PATH_UNSUPPORTED',
      `cannot read "${requestedPath}": the ${extension} extension does not name a supported image format (PNG/JPEG/WebP/GIF, or a file without an extension)`,
    )
  }
  const accepted = attachments.imageLimits?.mediaTypes
  if (declared !== undefined && Array.isArray(accepted) && !accepted.includes(declared)) {
    throw new ImageImportError(
      'IMAGE_PATH_UNSUPPORTED',
      `cannot read "${requestedPath}": this deployment does not accept ${declared} images`,
    )
  }

  const exec = input?.exec
  const signal = exec?.signal
  const cwd = exec?.agent === undefined
    ? undefined
    : await ctx.get('workingDirectory')?.ensure?.(exec.agent, signal)

  let target
  try {
    target = await fs.resolve(requestedPath, { ...(cwd === undefined ? {} : { cwd }), signal })
  } catch (error) {
    throw new ImageImportError('IMAGE_PATH_INVALID', `cannot read "${requestedPath}": ${error?.message ?? 'the path could not be resolved'}`, { cause: error })
  }

  const info = await fs.stat(target, signal)
  if (info === undefined) {
    if (typeof ctx?.emit === 'function') ctx.emit('fs/observed', target, { kind: 'absent' }, exec)
    throw new ImageImportError('IMAGE_PATH_NOT_FOUND', `cannot read "${target.displayPath}": not found`)
  }
  if (info.type !== 'file') {
    throw new ImageImportError('IMAGE_PATH_NOT_FILE', `cannot read "${target.displayPath}": not a regular file`)
  }

  const displayPath = target.displayPath ?? requestedPath
  const limits = attachments.imageLimits ?? {}
  // The cap is whatever the deployment publishes; a partial implementation that
  // omits one of the two limits must not turn the cap into NaN.
  const caps = [limits.maxImageBytes, limits.maxMessageImageBytes].filter(value => Number.isFinite(value) && value > 0)
  const byteCap = caps.length === 0 ? undefined : Math.min(...caps)

  let data
  try {
    data = await fs.readBytes(target, signal, byteCap)
  } catch (error) {
    if (error?.code === 'FS_TOO_LARGE') {
      throw new ImageImportError(
        'IMAGE_PATH_TOO_LARGE',
        `cannot read "${displayPath}": the file is larger than this deployment's${byteCap === undefined ? '' : ` ${megabytes(byteCap)}`} image limit; downscale it and read the smaller copy`,
        { cause: error },
      )
    }
    throw new ImageImportError('IMAGE_PATH_UNREADABLE', `cannot read "${displayPath}": ${error?.message ?? 'the read failed'}`, { cause: error })
  }

  const mediaType = declared ?? sniffMediaType(data)
  if (mediaType === undefined) {
    throw new ImageImportError(
      'IMAGE_PATH_FORMAT',
      `cannot read "${displayPath}": the content is not a PNG/JPEG/WebP/GIF image`,
    )
  }

  let ref
  try {
    ref = await attachments.saveImage({ data, mediaType, name: basename(displayPath) })
  } catch (error) {
    throw new ImageImportError(
      'IMAGE_PATH_REJECTED',
      describeAttachmentFailure(error, displayPath),
      { cause: error },
    )
  }

  // Tell the filesystem layer the file was read, exactly as the built-in image
  // and text readers do: the host's observed-state policy otherwise forgets a
  // file the model has already seen.
  if (typeof ctx?.emit === 'function') ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)

  return { ref, displayPath, mediaType, bytes: ref.bytes ?? data.byteLength }
}
