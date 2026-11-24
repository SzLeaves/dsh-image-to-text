/**
 * Model-facing texts. Kept in one file because they are edited together:
 * the section explains the placeholder, the template tells the reader what to
 * deliver, and both must agree about what the conversation model may expect.
 */

/** Fixed system prompt for the reader call. */
export const READER_SYSTEM = `You read images on behalf of a conversation model that cannot see them.

Answer the request in the user message. Work only from what is visible in the image:
never guess, never fill gaps with plausible content, never describe the image for its
own sake. Quote visible text verbatim -- error messages, stack traces, file paths,
numbers, labels, button captions -- because the reader will rely on the exact wording.
When something is unreadable, cropped, or absent, say which part and why. Answer in the
language the request is written in.`

/** Template used when the conversation model states a purpose. */
export const PROMPT_TEMPLATE = `{{purpose}}

Answer only from what is visible in the image. Quote visible text verbatim, including
error messages, stack traces, file paths, numbers and labels. If something is unreadable
or absent, say so instead of guessing. Keep the answer under {{maxChars}} characters.`

/** Fallback used when the conversation has named no goal yet. */
export const DEFAULT_PROMPT = `Describe this image so that a reader who cannot see it can act on it. Cover what kind
of image it is, the text it contains (verbatim where the wording matters), and anything
that looks wrong or unusual. Work only from what is visible, say when something is
unreadable, and keep it under {{maxChars}} characters.`

/** Prompt section shown to a conversation model that accepts text only. */
export const SECTION_TEXT = `This model cannot see images. An image the user sent appears in the log as a line like
[image omitted because this model accepts text only; attachment sha256:ab12cd34]. The
image is still stored and still shown to the user.

Call \`ask_image\` to learn what one contains. Put what you need from it in the call's
\`purpose\`: the question to answer, the text to extract, or the check to perform. A
reader answers that request instead of captioning the image. Read an image before
answering anything that depends on it, and call \`ask_image\` again with a new purpose
when a later question needs a different look.

An image that exists only as a file on disk -- a slide you rendered, a screenshot you
just captured -- has no line in the log. Pass its path in \`path\` instead of \`image\`:
ask_image reads that file once, stores it, and answers from it like any other image.`

/**
 * Build the user message for one reader call.
 *
 * Substitution is a single pass, so a purpose that itself contains `{{maxChars}}`
 * is passed through literally instead of being expanded twice.
 */
export function promptFor(config, purpose) {
  const stated = typeof purpose === 'string' ? purpose.trim() : ''
  const values = { maxChars: String(config.maxChars) }
  if (stated.length > 0) {
    values.purpose = stated
    return substitute(config.promptTemplate, values)
  }
  return substitute(config.defaultPrompt, values)
}

function substitute(template, values) {
  return String(template).replace(/\{\{(\w+)\}\}/g, (match, key) =>
    Object.hasOwn(values, key) ? values[key] : match)
}

/**
 * Keep a reader answer inside the configured budget. Cuts on a line boundary when
 * one is close enough to the limit, so a truncated log excerpt still ends cleanly.
 */
export function clamp(text, maxChars) {
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 8000
  if (text.length <= limit) return { text, truncated: false }

  const mark = '\n…[truncated]'
  // Below the marker length there is no room to announce the cut, so the answer is
  // cut to the budget exactly: a result longer than the configured limit would be
  // worse than an unmarked cut.
  if (limit <= mark.length) return { text: text.slice(0, limit), truncated: true }

  const room = limit - mark.length
  const head = text.slice(0, room)
  const breakAt = head.lastIndexOf('\n')
  const body = breakAt > room * 0.8 ? head.slice(0, breakAt) : head
  return { text: body + mark, truncated: true }
}
