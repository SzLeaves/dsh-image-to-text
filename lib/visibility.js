/**
 * Visibility for `ask_image` and its prompt section: both exist only while the
 * step's model is known to accept text and nothing else.
 *
 * The decision is applied while the prompt is assembled rather than by
 * registering and unregistering the tool on model switches. Every step
 * assembles the prompt and tool table before `agent/pre-step`, and the request
 * is built from that assembly, so a registration made during the step is too
 * late, while a registration made at load time cannot follow a switch. The
 * assembly listener has no such race: whatever it returns is the tool table and
 * section list the model sees on that step.
 *
 * The section text is evaluated before the assemble waterfall runs (the kernel
 * renders each section, then hands the rendered assembly to the waterfall), so
 * a conditional `text` would answer for the previous step. The section is
 * therefore registered empty and its text is filled in inside the waterfall.
 */

import { originalResolveModelInfo } from './bridge.js'

export const SECTION_NAME = 'image-to-text:how-to-read'

/** A text-only model cannot use `read_image`: it only round-trips placeholders. */
const HIDDEN_WHEN_TEXT_ONLY = new Set(['read_image'])

/** A model that sees images itself has no use for `ask_image`. */
const HIDDEN_WHEN_IMAGE_CAPABLE = new Set(['ask_image'])

const GUARD_REASON = 'ask_image only applies to models that cannot see images'

/**
 * Resolved route capabilities, keyed by `${provider}\u0000${model}`. The
 * adapter catalog is static between `llm/adapters-updated` events, so one
 * lookup per route is enough; the listener below drops the cache when the
 * catalog changes (for example when a model's declared modalities are edited).
 */
const routeCache = new Map()

/**
 * Recent decisions, newest last, bounded so a long session cannot grow it.
 * Exposed read-only at `GET /plugins/image-to-text/status`: when the tool is
 * missing on a model that should have it, this says which route was used and
 * whether the capability lookup failed.
 */
const decisions = []
const MAX_DECISIONS = 50

function recordDecision(entry) {
  decisions.push({ at: new Date().toISOString(), ...entry })
  if (decisions.length > MAX_DECISIONS) decisions.shift()
}

/** Never throws: diagnostics must not be able to break an assembly. */
function agentIdOf(agent) {
  try {
    return String(agent?.session?.id ?? agent?.id ?? '?')
  } catch {
    return '?'
  }
}

/** Never throws: a malformed route is exactly what this is meant to reveal. */
function routeLabel(route) {
  if (route === undefined || route === null) return undefined
  try {
    return `${String(route.provider)}/${String(route.model)}`
  } catch {
    return '?'
  }
}

/** The recent visibility decisions, newest last. Read-only diagnostic. */
export function recentDecisions() {
  return decisions.map(entry => ({ ...entry }))
}

/** Test-only hook: forget every resolved route so the next assembly asks again. */
export function __routeCacheClear() {
  routeCache.clear()
}

/**
 * Accept only a usable provider/model pair; anything else counts as "no route"
 * so the next source in the chain gets a turn.
 */
function normaliseRoute(value) {
  const provider = value?.provider
  const model = value?.model
  if (typeof provider !== 'string' || provider.length === 0) return undefined
  if (typeof model !== 'string' || model.length === 0) return undefined
  return { provider, model }
}

/** The selection queued for the next request, when one is pending. */
function pendingRoute(ctx, agent) {
  const projections = typeof ctx.get === 'function' ? ctx.get('sessionProjections') : undefined
  if (projections === undefined || typeof projections.stateOf !== 'function') return undefined
  const state = projections.stateOf(agent.session, 'modelSelection')
  if (state?.pending === null || state?.pending === undefined) return undefined
  return normaliseRoute(state.pending)
}

/** The route recorded on the session's latest request header. */
function headerRoute(agent) {
  if (typeof agent.session?.requestHeader !== 'function') return undefined
  const config = agent.session.requestHeader()?.config
  return normaliseRoute(config)
}

/**
 * The route this agent was created with. A subagent gets its own provider/model
 * here (`resolveChildAgentOptions` in dsh-subagent) and never records it in the
 * session projection, so before its first request this is the only source that
 * names the model the first assembly will actually call.
 */
function optionsRoute(agent) {
  return normaliseRoute(agent?.options)
}

/** The deployment default, used before the session has any request history. */
function defaultRoute(ctx) {
  const defaultModel = typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : undefined
  if (defaultModel === undefined || typeof defaultModel.currentSelection !== 'function') return undefined
  return normaliseRoute(defaultModel.currentSelection())
}

/**
 * The route this assembly was actually built for. The kernel's model-selection
 * listener writes the chosen provider/model into `assembly.variables` while the
 * same waterfall runs, so this is the same value the request will carry — it
 * covers per-agent routes (subagents, presets) that never reach the session
 * projection or the recorded request header.
 */
function assemblyRoute(assembly) {
  const variables = assembly?.variables
  if (variables === null || typeof variables !== 'object') return undefined
  return normaliseRoute(variables)
}

/**
 * The route this step will actually use, read the same way the kernel's own
 * session controller reads it (pending selection, then the recorded request
 * header, then the agent's own creation route, then the deployment default).
 * Each source is optional: a profile without the service or projection simply
 * falls through, and a changed service shape is a reason to try the next source
 * rather than to fail the assembly.
 */
function currentRoute(ctx, agent) {
  const sources = [
    () => pendingRoute(ctx, agent),
    () => headerRoute(agent),
    () => optionsRoute(agent),
    () => defaultRoute(ctx),
  ]
  for (const read of sources) {
    try {
      const route = read()
      if (route !== undefined) return route
    } catch {
      // Fall through to the next source; the caller treats "no route" as unknown.
    }
  }
  return undefined
}

/**
 * Whether the route is known to accept text and nothing else. Unknown, empty,
 * or absent modalities are not text-only: guessing "text only" would hand a
 * note about a placeholder to a model that can see the image. Resolved answers
 * are cached; a failed lookup is not, so the next assembly can retry.
 */
async function isTextOnlyRoute(ctx, route) {
  if (route === undefined) return false
  const key = `${route.provider}\u0000${route.model}`
  const cached = routeCache.get(key)
  if (cached !== undefined) return cached

  // Deliberately not ctx.llm.resolveModelInfo: the admission bridge wraps it
  // and reports image support for text-only models, which is the opposite of
  // what this decision needs.
  const info = await originalResolveModelInfo(ctx)(route.provider, route.model)
  const modalities = info?.inputModalities
  const textOnly = Array.isArray(modalities) && modalities.length > 0 && !modalities.includes('image')
  routeCache.set(key, textOnly)
  return textOnly
}

/**
 * Rewrite one assembly in place (by copy) for the given decision. Positions are
 * preserved: tools are filtered, sections are mapped, nothing is pushed or
 * reordered. Returns the input object itself when nothing changed, so callers
 * can rely on identity to tell "we touched this" from "we did not".
 */
function applyVisibility(assembly, textOnly, text) {
  if (assembly === null || typeof assembly !== 'object') return assembly

  const hidden = textOnly ? HIDDEN_WHEN_TEXT_ONLY : HIDDEN_WHEN_IMAGE_CAPABLE

  let tools = assembly.tools
  if (Array.isArray(tools)) {
    const visible = tools.filter(tool => !hidden.has(tool?.name))
    if (visible.length !== tools.length) tools = visible
  }

  let sections = assembly.sections
  if (textOnly && text.length > 0 && Array.isArray(sections)) {
    let replaced = false
    const rewritten = sections.map(entry => {
      if (entry?.name !== SECTION_NAME || entry.text === text) return entry
      replaced = true
      return { ...entry, text }
    })
    if (replaced) sections = rewritten
  }

  if (tools === assembly.tools && sections === assembly.sections) return assembly
  return { ...assembly, tools, sections }
}

/**
 * Install the placeholder section, the assembly listener, and the guard.
 *
 * Not wrapped in `ctx.effect` here on purpose: the caller owns the lifecycle
 * (index.js hands the returned disposer to `ctx.effect`), so a failed install
 * unwinds exactly the way a disabled plugin does.
 *
 * @param ctx - plugin context.
 * @param options - `{ text }`, the section text shown to a text-only model.
 * @returns disposer that removes section, listener, cache listener, and guard.
 */
export function installVisibility(ctx, options) {
  const text = typeof options?.text === 'string' ? options.text : ''
  const logger = ctx.logger('image-to-text')

  // Per-install so a reload cannot inherit a decision taken for an old agent.
  const textOnlyByAgent = new WeakMap()

  // Registered once at a fixed position, with empty text. Empty sections are
  // dropped by the renderer, so "not text-only" means "section absent" without
  // unregistering anything; when the decision flips, the text is filled into
  // this already positioned entry during assembly.
  const disposeSection = ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: ctx.systemPrompt.getSectionOrder('TOOL_READ') + 1,
    text: '',
    interpolate: false,
  })

  const disposeAssembly = ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const agent = context?.agent
    // Diagnostic assemblies have no agent and are never sent to a model.
    if (agent === undefined) return next()

    // A failure below `next()` belongs to another listener. Returning a value
    // here would turn its error into a silently empty prompt, so let it throw.
    const inner = await next()

    // Decide afterwards: `next()` is what writes the assembled route into
    // `variables`, and the session sources are only a fallback for assemblies
    // where no selection listener ran.
    let textOnly = false
    const recorded = assemblyRoute(inner)
    let route = recorded
    try {
      route = recorded ?? currentRoute(ctx, agent)
      textOnly = await isTextOnlyRoute(ctx, route)
      recordDecision({ agent: agentIdOf(agent), via: 'assembly', recorded: routeLabel(recorded), route: routeLabel(route), textOnly })
    } catch (error) {
      recordDecision({ agent: agentIdOf(agent), via: 'assembly', recorded: routeLabel(recorded), route: routeLabel(route), textOnly: false, error: String(error) })
      logger.warn(`route check failed, treating model as image capable: ${String(error)}`)
    }
    textOnlyByAgent.set(agent, textOnly)

    try {
      return applyVisibility(inner, textOnly, text)
    } catch (error) {
      // Losing the tool or the notice is acceptable; failing the request is not.
      logger.warn(`assembly rewrite failed, leaving it untouched: ${String(error)}`)
      return inner
    }
  })

  // The adapter catalog changed, so cached capabilities may be stale.
  const disposeCatalog = ctx.on('llm/adapters-updated', () => routeCache.clear())

  // Last line of defense: a call decided under a text-only model can still be
  // queued when the model switches before it executes. The tool table no longer
  // lists it, but the executor still sees the call; deny it instead of spending
  // a reader request. Unknown agents are allowed through — a call cannot exist
  // without an assembly that populated the map.
  const disposeGuard = ctx.tools.guard(exec => {
    if (exec?.name !== 'ask_image') return undefined
    if (exec.agent === undefined || exec.agent === null) return undefined
    if (textOnlyByAgent.get(exec.agent) !== false) return undefined
    return GUARD_REASON
  })

  return () => {
    for (const dispose of [disposeSection, disposeAssembly, disposeCatalog, disposeGuard]) {
      try {
        dispose()
      } catch (error) {
        logger.warn(`disposing visibility failed: ${String(error)}`)
      }
    }
  }
}
