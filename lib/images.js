/**
 * Image lookup over a session's message log. Pure on purpose: the tool layer
 * needs to resolve "which image" before it decides whether a reader call is
 * worth making, and testing that decision should not require a host.
 *
 * Tags are derived from `attachmentId` exactly the way the kernel's text-only
 * placeholder derives them (`textOnlyImageText`, dsh-llm/lib/index.js:558), so
 * the eight hex characters a model sees in the log are the same ones it can
 * pass back to us.
 */

/** Strip an optional `sha256:` prefix and take the short, lower-case tag. */
function tagOf(attachmentId) {
  const bare = attachmentId.replace(/^sha256:/i, '')
  return bare.slice(0, 8).toLowerCase()
}

/**
 * Collect every readable image in order, oldest first. `offloaded` images are
 * kept: that flag only means the bytes were moved out of the request to keep it
 * small, the durable attachment is still readable.
 */
export function collectImages(messages) {
  const images = []
  if (!Array.isArray(messages)) return images

  for (const message of messages) {
    const content = message?.content
    if (!Array.isArray(content)) continue

    for (const block of content) {
      if (block?.type !== 'image') continue
      const attachment = block.attachment
      // A non-string id would silently produce a garbage tag and a cache key
      // collision, so such a block is not addressable at all.
      if (!attachment || typeof attachment.attachmentId !== 'string') continue
      images.push({
        ref: attachment,
        tag: tagOf(attachment.attachmentId),
        index: images.length + 1,
      })
    }
  }

  return images
}

/**
 * Resolve a model-supplied selector against collected images.
 *
 * An absent selector means "the image we were just talking about", which is the
 * latest one. Numeric selectors address position, everything else addresses the
 * short tag; multiple prefix hits resolve to the newest occurrence, since that
 * is the one the conversation is looking at.
 */
export function pickImage(images, selector) {
  if (!Array.isArray(images) || images.length === 0) return undefined
  if (selector === undefined || selector === null) return images[images.length - 1]

  const raw = typeof selector === 'string' ? selector.trim() : String(selector).trim()
  if (raw === '') return images[images.length - 1]

  if (/^\d+$/.test(raw)) {
    const wanted = Number(raw)
    return images.find(image => image.index === wanted)
  }

  let needle = raw.toLowerCase()
  if (needle.startsWith('sha256:')) needle = needle.slice('sha256:'.length)

  let match
  for (const image of images) {
    if (image.tag.startsWith(needle)) match = image
  }
  return match
}

/** Stable user-facing identity of one collected image. */
export function imageIdentity(image) {
  return `sha256:${image.tag}`
}
