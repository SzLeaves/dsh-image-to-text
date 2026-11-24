import { Config, settingsFrom } from './lib/config.js'
import { installAdmissionBridge } from './lib/bridge.js'
import { installVisibility, recentDecisions } from './lib/visibility.js'
import { createReader } from './lib/reader.js'
import { createAskImageTool } from './lib/tool.js'
import { SECTION_TEXT } from './lib/prompt.js'

export const name = 'image-to-text'
// `attachments` is deliberately not listed: the plugin never touches image bytes,
// the LLM service and its adapter own every attachment operation.
export const inject = ['llm', 'tools', 'systemPrompt']

export { Config }

const MODELS_PATH = '/plugins/image-to-text/models'
const STATUS_PATH = '/plugins/image-to-text/status'

/**
 * Wiring only. Everything that needs a decision lives in `lib/`:
 * the bridge decides what admission sees, `route` picks the reader,
 * `visibility` decides who may see the tool, `reader` performs the call.
 */
export function apply(ctx, config) {
  const settings = settingsFrom(config)
  const getConfig = () => settingsFrom(config)
  const logger = ctx.logger('image-to-text')

  // Admission runs before a message enters the session, so it has to be bridged
  // before anything can arrive. `installAdmissionBridge` is idempotent for the
  // hot-reload case.
  if (settings.bridgeAdmission) {
    ctx.effect(() => installAdmissionBridge(ctx), 'image-to-text: admission bridge')
  } else {
    logger.info('admission bridge disabled; image messages will be rejected for text-only models')
  }

  const reader = createReader(ctx, getConfig)
  const tool = createAskImageTool(ctx, { getConfig, reader })

  // Registered once, globally: which agents actually receive it is decided per
  // request assembly, not here.
  ctx.effect(() => ctx.tools.register(tool), 'image-to-text: ask_image')

  ctx.effect(() => installVisibility(ctx, { text: SECTION_TEXT }), 'image-to-text: visibility')

  // Configuration page and the model list it needs. Both are optional: a headless
  // profile still gets the tool, it just has no page.
  ctx.inject(['settings', 'webServer'], scope => {
    // Keyed by the plugin entry's own fiber: `dsh-settings` looks the policy up by
    // `entry.fiber` when it builds the descriptor, so a child scope's fiber would
    // silently leave `autoGenerate` at its default.
    scope.effect(() => scope.settings.configure({ auto: false }, ctx.fiber), 'image-to-text: settings policy')
    scope.effect(
      () => scope.webServer.register({ kind: 'exact', path: MODELS_PATH, handler: (req, res) => models(scope, req, res) }),
      'image-to-text: ' + MODELS_PATH,
    )
    scope.effect(
      () => scope.webServer.register({ kind: 'exact', path: STATUS_PATH, handler: (req, res) => status(scope, req, res) }),
      'image-to-text: ' + STATUS_PATH,
    )
  })
}

/**
 * The web server has no server-wide authentication: each route owner enforces
 * its own request policy. Delegate to Connection's Host/Origin and
 * browser-credential check, as first-party routes do. Without that service the
 * page is not reachable over HTTP anyway, so refuse rather than serve
 * unauthenticated reads.
 */
function rejected(ctx, request, response) {
  const connection = ctx.get('connection')
  if (connection === undefined) {
    response.writeHead(503, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: 'connection service unavailable' }))
    return true
  }
  const rejection = connection.requestRejection(request)
  if (rejection === undefined) return false
  response.writeHead(rejection, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ error: 'untrusted request' }))
  return true
}

/**
 * Read-only model list for the Configure page. Shaped for a `<select>`: providers
 * in registry order, each with the models that declared image input.
 *
 * The page uses this instead of the session model catalog because the catalog
 * carries no modality information (dsh-api-session-controller types: ModelCatalogModel
 * has only id/name/description/reasoning).
 */
async function models(ctx, request, response) {
  if (rejected(ctx, request, response)) return
  if (request.method !== 'GET') {
    response.writeHead(405, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: 'method not allowed' }))
    return
  }
  try {
    const providers = []
    for (const provider of ctx.llm.listProviders()) {
      const catalog = await ctx.llm.listModels(provider.id).catch(() => [])
      const capable = catalog
        .filter(model => Array.isArray(model.inputModalities) && model.inputModalities.includes('image'))
        .map(model => ({ id: model.id, name: model.name ?? model.id }))
      if (capable.length > 0) providers.push({ id: provider.id, name: provider.name ?? provider.id, models: capable })
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ providers }))
  } catch (error) {
    ctx.logger('image-to-text').warn(`model list failed: ${error?.message ?? error}`)
    response.writeHead(500, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: 'model list unavailable' }))
  }
}

/**
 * Read-only diagnostics: the last visibility decisions, newest last. Answers
 * "why did my text-only model not get ask_image" without a debug build.
 */
function status(ctx, request, response) {
  if (rejected(ctx, request, response)) return
  if (request.method !== 'GET') {
    response.writeHead(405, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: 'method not allowed' }))
    return
  }
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ decisions: recentDecisions() }))
}
