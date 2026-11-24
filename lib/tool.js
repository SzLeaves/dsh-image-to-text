/**
 * The `ask_image` tool definition.
 *
 * This file only decides which image the call is about and turns failures into
 * sentences a model can act on. Two sources are accepted: an image already in
 * the conversation (addressed by attachment tag or position) and an image file
 * on disk (addressed by path, imported through `lib/import.js`). Reading,
 * caching, and truncation belong to `lib/reader.js`: the tool never touches
 * `ctx.llm`. Keeping the split this way means the failure wording (which the
 * model reads) can be reviewed without reading the call plumbing.
 *
 * The definition is a plain object rather than a `defineTool()` result: the host
 * compiles a `defineTool` parameter map into JSON Schema, but a direct
 * `ctx.tools.register()` receives the schema as-is. `parameters` below is
 * therefore a JSON Schema object, not a per-key map.
 */

import { collectImages, imageIdentity, pickImage } from './images.js'
import { importImageFile } from './import.js'
import { ImageReaderError } from './route.js'

/** Reader failures the tool can explain without leaking a stack or a code. */
const TIMEOUT_CODE = 'IMAGE_READER_TIMEOUT'
const ABORTED_CODE = 'IMAGE_READER_ABORTED'
const EMPTY_CODE = 'IMAGE_READER_EMPTY'
const TOOL_CALLS_CODE = 'IMAGE_READER_TOOL_CALLS'

const DESCRIPTION = 'Read one image with an image-capable model and return its answer as text. The image is either one already in this conversation or a file on disk. Use it to find out what an image contains: visible text, layout, values, or the answer to a specific question about it.'

const IMAGE_PARAMETER = 'Which image. Pass the 8 hex characters shown after `sha256:` in the image\'s placeholder, or its 1-based position in the conversation. Omit for the most recent image.'

const PURPOSE_PARAMETER = 'What you need from this image, written in the user\'s language: the question to answer, the detail to extract, or the check to perform. The reader answers only from what is visible. Omit when the conversation names no goal yet; you then get a general description.'

const PATH_PARAMETER = 'Path to an image file on disk, for an image that is not in this conversation (for example one you just generated). Pass this instead of `image`; the file is read once and stored as an attachment. PNG, JPEG, WebP and GIF are accepted, within the deployment\'s size limits.'

/**
 * Build the `ask_image` tool.
 *
 * @param ctx - Host context. The reader owns the LLM call, so only the path
 *   branch uses it (`fs`, `attachments`, `workingDirectory`), and it looks them
 *   up lazily so a profile without them still gets the conversation branch.
 * @param dependencies - `{ getConfig, reader }`: the live settings reader and
 *   the reader created by `createReader(ctx, getConfig)`.
 * @returns A `ToolDefinition` ready for `ctx.tools.register()`.
 */
export function createAskImageTool(ctx, dependencies) {
  return {
    name: 'ask_image',
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        image: { type: 'string', description: IMAGE_PARAMETER },
        path: { type: 'string', description: PATH_PARAMETER },
        purpose: { type: 'string', description: PURPOSE_PARAMETER },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          image: { type: 'string' },
          model: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['image', 'model', 'text'],
      },
      // The first line names the image and the reader, so a conversation with
      // several images never confuses one answer for another, and the user can
      // see which model actually spent the call.
      render: (args, value) => [{ type: 'text', text: `[${value.image} via ${value.model}]\n${value.text}` }],
    },
    // The reader's own deadline (timeoutSeconds) must fire before the kernel's
    // per-call deadline; the extra 15s buys the specific message below instead
    // of the kernel's generic "tool call timed out".
    timeoutMs: Math.max(1, dependencies.getConfig().timeoutSeconds) * 1000 + 15000,
    // Reads session state only; the reader tolerates overlapping calls (its
    // cache map is the only mutation, and a duplicate entry just wins).
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('ask_image needs an agent context')

      const config = dependencies.getConfig()
      const path = typeof args?.path === 'string' ? args.path.trim() : ''

      let target
      try {
        // A path wins over a tag: the caller named a file it wants read, and
        // silently reading a different image instead would be worse than a miss.
        target = path.length > 0
          ? await fileTarget(ctx, exec, path, config)
          : sessionTarget(agent, args?.image)
      } catch (error) {
        throw new Error(describeFailure(error, config))
      }

      try {
        const result = await dependencies.reader.read({
          ref: target.ref,
          purpose: args?.purpose,
          signal: exec.signal,
          sessionId: agent.session.id,
          // The conversation's own route: in auto mode it is the cheapest reader
          // (no second gateway login) and the one whose limits the user already knows.
          preferSameProvider: agent.session?.requestHeader?.()?.config,
        })
        return { image: target.label, model: result.model, text: result.text }
      } catch (error) {
        throw new Error(describeFailure(error, config))
      }
    },
  }
}

/**
 * The image the call is about when it is already in the conversation. Misses are
 * thrown, not returned, so the caller has one place to turn failures into text.
 */
function sessionTarget(agent, selector) {
  const images = collectImages(agent.session.deriveMessages())
  if (images.length === 0) {
    throw new Error('This conversation has no images. If the image is a file on disk, pass its `path` instead.')
  }
  const picked = pickImage(images, selector)
  if (picked === undefined) throw new Error(noMatchMessage(selector, images))
  return { ref: picked.ref, label: imageIdentity(picked) }
}

/**
 * The image the call is about when it is a file on disk. The file is stored as a
 * durable attachment so the reader receives a reference, never a second copy of
 * the bytes held by this plugin.
 */
async function fileTarget(ctx, exec, path, config) {
  if (config.pathImport === false) {
    throw new Error('Reading an image by `path` is turned off for this plugin. Ask the user to enable it under Plugins, Configure on dsh-image-to-text, or attach the image to the conversation and call ask_image without `path`.')
  }
  const imported = await importImageFile(ctx, { path, exec })
  return { ref: imported.ref, label: imported.displayPath }
}

/**
 * Explain a miss without hiding what would have worked. The first line is the
 * refusal; the list lets the model retry with a real tag instead of asking the
 * user again. Only the newest 20 are listed so a long conversation cannot turn
 * one tool error into a large request.
 */
function noMatchMessage(selector, images) {
  const shown = images.slice(-20).map(image => `  ${imageIdentity(image)} (${image.index})`)
  const omitted = images.length > shown.length
    ? `\n  and ${images.length - shown.length} earlier image(s)`
    : ''
  return `No image matches "${selector ?? ''}"; this conversation has ${images.length} image(s)\n${shown.join('\n')}${omitted}`
}

/**
 * One sentence the model can read and act on, chosen by failure kind. Route
 * failures already carry model-readable text, but it repeats the settings path
 * in every branch; the tool answers uniformly so the model learns one recovery
 * move. Unknown failures keep the provider's own message: the reader knows the
 * model and already adds context it can add, and a wrapper here would only
 * bury the provider's words.
 */
function describeFailure(error, config) {
  const said = messageOf(error)
  switch (codeOf(error)) {
    case 'NO_READER':
      return 'No image-capable model is available to read this image. Tell the user to open Plugins, click Configure on dsh-image-to-text, and make sure a reader model that accepts images is selected and enabled.'
    case 'NO_SUCH_MODEL':
      return 'The reader model configured for this plugin is not available. Tell the user to open Plugins, click Configure on dsh-image-to-text, and choose a model that is registered.'
    case 'TEXT_ONLY_READER':
      return 'The reader model configured for this plugin accepts text only, so it cannot read images. Tell the user to open Plugins, click Configure on dsh-image-to-text, and choose a model that accepts image input.'
    case TIMEOUT_CODE:
      return `The image reader did not answer within ${timeoutSecondsOf(config)} seconds. Retry once, or answer from the text you have.`
    case ABORTED_CODE:
      return 'The image read was cancelled before it answered. Retry the call if you still need this image, or continue without it.'
    case EMPTY_CODE:
      return 'The image reader returned no text. Retry once with a narrower purpose, or answer from the text you have.'
    case TOOL_CALLS_CODE:
      return 'The image reader answered with tool calls instead of text. Retry once, or answer from the text you have.'
    default:
      return said.length > 0
        ? said
        : 'The image reader failed without a message. Retry once, or answer from the text you have.'
  }
}

/** Route failures carry `code`; aborts may arrive as plain DOMExceptions. */
function codeOf(error) {
  if (error instanceof ImageReaderError) return error.code
  if (error !== null && typeof error === 'object') {
    if (typeof error.code === 'string') return error.code
    if (error.name === 'AbortError') return ABORTED_CODE
  }
  return ''
}

function messageOf(error) {
  if (typeof error === 'string') return error.trim()
  const message = error !== null && typeof error === 'object' && typeof error.message === 'string'
    ? error.message.trim()
    : ''
  return message
}

/** Same fallback the reader uses, so the two deadlines agree on the number. */
function timeoutSecondsOf(config) {
  const seconds = Number(config?.timeoutSeconds)
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 180
}
