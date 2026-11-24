// 保证 ask_image 与提示段只出现在纯文本模型上，路由判定按 pending→请求头→默认模型，且有缓存和 guard 兜底。
import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { __routeCacheClear, installVisibility, SECTION_NAME } from '../lib/visibility.js'

beforeEach(() => {
  __routeCacheClear()
})

function setup({ resolve, text = 'SECTION BODY' } = {}) {
  const services = {}
  const state = {
    sections: [],
    events: new Map(),
    guards: [],
    warnings: [],
    resolveCalls: [],
    disposers: [],
  }

  const ctx = {
    get(name) {
      return services[name]
    },
    systemPrompt: {
      section(options) {
        state.sections.push(options)
        return () => state.disposers.push('section')
      },
      getSectionOrder(name) {
        state.orderFor = name
        return 10
      },
    },
    on(event, handler) {
      state.events.set(event, handler)
      return () => state.disposers.push(`on:${event}`)
    },
    tools: {
      guard(check) {
        state.guards.push(check)
        return () => state.disposers.push('guard')
      },
    },
    llm: {
      async resolveModelInfo(provider, model) {
        state.resolveCalls.push([provider, model])
        if (resolve !== undefined) return resolve(provider, model)
        const modalities = { 'text-model': ['text'], 'vision-model': ['text', 'image'] }[model]
        return { provider, id: model, inputModalities: modalities }
      },
    },
    logger: () => ({
      info() {},
      warn(message) {
        state.warnings.push(message)
      },
    }),
  }

  const dispose = installVisibility(ctx, { text })
  return { ctx, services, state, dispose }
}

function headerAgent(model, { provider = 'provider', session = {} } = {}) {
  return {
    session: {
      ...session,
      requestHeader: () => ({ config: { provider, model } }),
    },
  }
}

function makeAssembly() {
  return {
    tools: [{ name: 'read_image' }, { name: 'ask_image' }, { name: 'bash' }],
    sections: [
      { name: SECTION_NAME, text: '' },
      { name: 'other:section', text: 'keep me' },
    ],
    contexts: [{ name: 'ctx' }],
    variables: { a: 1 },
  }
}

function assemble(setupResult, assembly, context = {}) {
  const handler = setupResult.state.events.get('system-prompt/assemble')
  assert.equal(typeof handler, 'function')
  return handler(assembly, context, async () => assembly)
}

test('install registers the placeholder section once, at TOOL_READ + 1, with empty text', () => {
  const { state } = setup()
  assert.equal(state.sections.length, 1)
  assert.deepEqual(state.sections[0], {
    name: SECTION_NAME,
    order: 11,
    text: '',
    interpolate: false,
  })
  assert.equal(state.orderFor, 'TOOL_READ')
})

test('a text-only model keeps ask_image, loses read_image, and receives the section text', async () => {
  const { state } = setup()
  const agent = headerAgent('text-model')
  const assembly = makeAssembly()

  const result = await assemble({ state }, assembly, { agent })

  assert.notEqual(result, assembly)
  assert.deepEqual(result.tools.map(tool => tool.name), ['ask_image', 'bash'])
  assert.equal(result.sections[0].text, 'SECTION BODY')
  assert.equal(result.sections[1].text, 'keep me')

  assert.equal(assembly.tools.length, 3, 'the input assembly is not mutated')
  assert.equal(assembly.sections[0].text, '')
  assert.deepEqual(state.resolveCalls, [['provider', 'text-model']])
})

test('an image-capable model loses ask_image and keeps the section empty', async () => {
  const { state } = setup()
  const agent = headerAgent('vision-model')
  const assembly = makeAssembly()

  const result = await assemble({ state }, assembly, { agent })

  assert.notEqual(result, assembly)
  assert.deepEqual(result.tools.map(tool => tool.name), ['read_image', 'bash'])
  assert.equal(result.sections[0].text, '')
  assert.equal(assembly.sections[0].text, '')
})

test('unknown or empty modalities are treated as image capable, not text only', async () => {
  for (const modalities of [undefined, []]) {
    __routeCacheClear()
    const { state } = setup({
      resolve: async (provider, model) => ({ provider, id: model, inputModalities: modalities }),
    })
    const agent = headerAgent('mystery-model')
    const assembly = makeAssembly()

    const result = await assemble({ state }, assembly, { agent })
    assert.deepEqual(result.tools.map(tool => tool.name), ['read_image', 'bash'])
    assert.equal(result.sections[0].text, '')
  }
})

test('an assembly without context.agent is handed through unchanged', async () => {
  const { state } = setup()
  const sentinel = { sections: [], tools: [] }
  const handler = state.events.get('system-prompt/assemble')

  const result = await handler(makeAssembly(), {}, async () => sentinel)

  assert.equal(result, sentinel)
  assert.deepEqual(state.resolveCalls, [])
})

test('the pending model selection wins over the session request header', async () => {
  const { services, state } = setup()
  const agent = headerAgent('vision-model', { session: { id: 's1' } })
  services.sessionProjections = {
    stateOf(session, key) {
      assert.equal(session, agent.session)
      assert.equal(key, 'modelSelection')
      return { pending: { provider: 'provider', model: 'text-model' }, lastUsed: null }
    },
  }

  const result = await assemble({ state }, makeAssembly(), { agent })

  assert.deepEqual(state.resolveCalls, [['provider', 'text-model']])
  assert.equal(result.sections[0].text, 'SECTION BODY')
  assert.ok(result.tools.some(tool => tool.name === 'ask_image'))
})

test('the route recorded during assembly wins over the session sources', async () => {
  const { services, state } = setup()
  // The session sources point at the deployment default: the choice made by the
  // kernel's own selection listener is what this step actually runs on.
  const agent = { session: { id: 's3' } }
  services.agentDefaultModel = {
    currentSelection: () => ({ provider: 'provider', model: 'vision-model' }),
  }
  const handler = state.events.get('system-prompt/assemble')
  const assembly = makeAssembly()

  const result = await handler(assembly, { agent }, async () => ({
    ...assembly,
    variables: { provider: 'provider', model: 'text-model' },
  }))

  assert.deepEqual(state.resolveCalls, [['provider', 'text-model']])
  assert.deepEqual(result.tools.map(tool => tool.name), ['ask_image', 'bash'])
  assert.equal(result.sections[0].text, 'SECTION BODY')
})

test('the agent creation route is used before the deployment default', async () => {
  const { services, state } = setup()
  const agent = { session: { id: 'child' }, options: { provider: 'provider', model: 'text-model' } }
  services.agentDefaultModel = {
    currentSelection: () => ({ provider: 'provider', model: 'vision-model' }),
  }

  const result = await assemble({ state }, makeAssembly(), { agent })

  assert.deepEqual(state.resolveCalls, [['provider', 'text-model']], 'the subagent route wins over the deployment default')
  assert.ok(result.tools.some(tool => tool.name === 'ask_image'))
  assert.equal(result.sections[0].text, 'SECTION BODY')
})

test('the request header wins over the agent creation route', async () => {
  const { services, state } = setup()
  services.sessionProjections = {
    stateOf() {
      return { pending: null }
    },
  }
  const agent = headerAgent('vision-model', { session: { id: 's3' } })
  agent.options = { provider: 'provider', model: 'text-model' }

  const result = await assemble({ state }, makeAssembly(), { agent })

  assert.deepEqual(state.resolveCalls, [['provider', 'vision-model']])
  assert.ok(!result.tools.some(tool => tool.name === 'ask_image'))
  assert.ok(result.tools.some(tool => tool.name === 'read_image'))
})

test('a failure below next() propagates and leaves the guard undecided', async () => {
  const { state } = setup()
  const agent = headerAgent('text-model')
  const handler = state.events.get('system-prompt/assemble')

  await assert.rejects(
    () => handler(makeAssembly(), { agent }, async () => { throw new Error('inner failed') }),
    /inner failed/,
  )
  assert.deepEqual(state.resolveCalls, [], 'no route lookup happens for a failed assembly')

  const executed = { name: 'ask_image', agent }
  assert.equal(state.guards[0](executed), undefined, 'a failed assembly does not silently hide the tool')
})

test('the request header is used when no selection is pending', async () => {
  const { services, state } = setup()
  const agent = headerAgent('text-model')

  services.sessionProjections = {
    stateOf() {
      return { pending: null }
    },
  }

  const result = await assemble({ state }, makeAssembly(), { agent })

  assert.deepEqual(state.resolveCalls, [['provider', 'text-model']])
  assert.equal(result.sections[0].text, 'SECTION BODY')
})

test('the deployment default is used when the session has neither pending nor header', async () => {
  const { services, state } = setup()
  const agent = { session: { id: 's2' } }
  services.agentDefaultModel = {
    currentSelection: () => ({ provider: 'provider', model: 'text-model' }),
  }

  const result = await assemble({ state }, makeAssembly(), { agent })

  assert.deepEqual(state.resolveCalls, [['provider', 'text-model']])
  assert.equal(result.sections[0].text, 'SECTION BODY')
  assert.ok(result.tools.some(tool => tool.name === 'ask_image'))
})

test('the same route is resolved once and reused', async () => {
  const { state } = setup()
  const agent = headerAgent('text-model')

  await assemble({ state }, makeAssembly(), { agent })
  await assemble({ state }, makeAssembly(), { agent })

  assert.deepEqual(state.resolveCalls, [['provider', 'text-model']])
})

test('llm/adapters-updated clears the route cache', async () => {
  const { state } = setup()
  const agent = headerAgent('text-model')

  await assemble({ state }, makeAssembly(), { agent })
  state.events.get('llm/adapters-updated')()
  await assemble({ state }, makeAssembly(), { agent })

  assert.equal(state.resolveCalls.length, 2)
})

test('the guard allows ask_image for a text-only agent and rejects it for an image-capable one', async () => {
  const { state } = setup()
  const textAgent = headerAgent('text-model')
  const visionAgent = headerAgent('vision-model')
  const guard = state.guards[0]

  assert.equal(guard({ name: 'ask_image', agent: textAgent }), undefined, 'unknown agents are allowed')

  await assemble({ state }, makeAssembly(), { agent: textAgent })
  await assemble({ state }, makeAssembly(), { agent: visionAgent })

  assert.equal(guard({ name: 'ask_image', agent: textAgent }), undefined)
  const reason = guard({ name: 'ask_image', agent: visionAgent })
  assert.equal(typeof reason, 'string')
  assert.match(reason, /only applies to models that cannot see images/)

  assert.equal(guard({ name: 'bash', agent: visionAgent }), undefined)
  assert.equal(guard({ name: 'ask_image' }), undefined)
  assert.equal(guard({ name: 'ask_image', agent: { session: { id: 'never-assembled' } } }), undefined)
})

test('dispose removes the section, both listeners, and the guard', () => {
  const { state, dispose } = setup()
  dispose()

  assert.deepEqual(
    state.disposers.sort(),
    ['guard', 'on:llm/adapters-updated', 'on:system-prompt/assemble', 'section'].sort(),
  )
})
