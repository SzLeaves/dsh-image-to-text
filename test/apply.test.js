// 保证插件装配完整：工具、提示段、准入桥、设置策略与模型列表路由都在 apply 时接好。
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, inject, name } from '../index.js'
import { originalResolveModelInfo } from '../lib/bridge.js'
import { SECTION_NAME } from '../lib/visibility.js'

function response() {
  const state = { status: 0, headers: undefined, body: '' }
  return {
    state,
    writeHead(status, headers) {
      state.status = status
      state.headers = headers
    },
    end(body) {
      state.body = body
    },
  }
}

function host({ resolve, providers, catalogs } = {}) {
  const recorded = {
    effects: [],
    scopeEffects: [],
    tools: [],
    guards: [],
    sections: [],
    events: [],
    injections: [],
    settings: [],
    routes: [],
    logs: [],
    loggerNames: [],
  }

  const original = resolve ?? (async (provider, model) => ({ provider, id: model, inputModalities: ['text'] }))
  const modelCatalog = catalogs ?? {
    a: [
      { id: 'image-model', name: 'Image Model', inputModalities: ['text', 'image'] },
      { id: 'text-model', name: 'Text Model', inputModalities: ['text'] },
    ],
  }

  const ctx = {
    fiber: { id: 'plugin-fiber' },
    logger(moduleName) {
      recorded.loggerNames.push(moduleName)
      return {
        info(message) {
          recorded.logs.push(['info', message])
        },
        warn(message) {
          recorded.logs.push(['warn', message])
        },
        debug(message) {
          recorded.logs.push(['debug', message])
        },
      }
    },
    effect(fn) {
      const dispose = fn()
      recorded.effects.push({ fn, dispose })
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    inject(deps, callback) {
      recorded.injections.push(deps)
      callback({
        fiber: { id: 'child-fiber' },
        llm: ctx.llm,
        logger(moduleName) {
          recorded.loggerNames.push(moduleName)
          return {
            info(message) {
              recorded.logs.push(['info', message])
            },
            warn(message) {
              recorded.logs.push(['warn', message])
            },
            debug(message) {
              recorded.logs.push(['debug', message])
            },
          }
        },
        effect(fn) {
          const dispose = fn()
          recorded.scopeEffects.push({ fn, dispose })
          return () => {
            if (typeof dispose === 'function') dispose()
          }
        },
        settings: {
          configure(options, fiber) {
            recorded.settings.push({ options, fiber })
          },
        },
        webServer: {
          register(options) {
            const dispose = () => {}
            recorded.routes.push({ ...options, dispose })
            return dispose
          },
        },
      })
    },
    llm: {
      resolveModelInfo: original,
      listProviders: () => providers ?? [{ id: 'a', name: 'Provider A' }],
      listModels: async id => {
        if (!modelCatalog[id]) throw new Error('no catalog')
        return modelCatalog[id]
      },
    },
    tools: {
      register(tool) {
        recorded.tools.push(tool)
        return () => {}
      },
      guard(check) {
        recorded.guards.push(check)
        return () => {}
      },
    },
    systemPrompt: {
      section(options) {
        recorded.sections.push(options)
        return () => {}
      },
      getSectionOrder() {
        return 100
      },
    },
    on(event, handler) {
      recorded.events.push({ event, handler })
      return () => {}
    },
  }

  return { ctx, recorded, original }
}

test('the entry declares its name and injected services', () => {
  assert.equal(name, 'image-to-text')
  assert.deepEqual(inject, ['llm', 'tools', 'systemPrompt'])
})

test('apply installs the tool, the section, the admission bridge, and the page wiring', async () => {
  const { ctx, recorded, original } = host()

  apply(ctx, {})

  assert.equal(recorded.effects.length, 3)
  assert.equal(recorded.tools.length, 1)
  const tool = recorded.tools[0]
  assert.equal(tool.name, 'ask_image')
  assert.equal(tool.parameters.type, 'object')
  assert.equal(tool.parameters.additionalProperties, false)

  assert.equal(recorded.sections.length, 1)
  assert.equal(recorded.sections[0].name, SECTION_NAME)
  assert.equal(recorded.sections[0].text, '')
  assert.equal(recorded.sections[0].interpolate, false)

  assert.notEqual(ctx.llm.resolveModelInfo, original)
  assert.deepEqual((await ctx.llm.resolveModelInfo('p', 'text-model')).inputModalities, ['text', 'image'])
  assert.deepEqual((await originalResolveModelInfo(ctx)('p', 'text-model')).inputModalities, ['text'])

  assert.deepEqual(recorded.injections, [['settings', 'webServer']])
  assert.equal(recorded.scopeEffects.length, 3)
  assert.deepEqual(recorded.settings[0].options, { auto: false })
  assert.equal(recorded.settings[0].fiber, ctx.fiber)
  assert.equal(recorded.routes.length, 2)
  assert.equal(recorded.routes[0].kind, 'exact')
  assert.equal(recorded.routes[0].path, '/plugins/image-to-text/models')
  assert.equal(typeof recorded.routes[0].handler, 'function')
  assert.equal(recorded.routes[1].kind, 'exact')
  assert.equal(recorded.routes[1].path, '/plugins/image-to-text/status')
  assert.equal(typeof recorded.routes[1].handler, 'function')

  assert.ok(recorded.loggerNames.length >= 1)
  assert.ok(recorded.loggerNames.every(moduleName => moduleName === 'image-to-text'))
})

test('apply can skip the admission bridge without skipping the rest', () => {
  const { ctx, recorded, original } = host()

  apply(ctx, { bridgeAdmission: false })

  assert.equal(ctx.llm.resolveModelInfo, original)
  assert.equal(recorded.tools.length, 1)
  assert.equal(recorded.sections.length, 1)
  assert.ok(recorded.logs.some(([level, message]) => level === 'info' && /admission bridge disabled/.test(message)))
})

test('the model list route reports only models that declare image input', async () => {
  const { ctx, recorded } = host({
    providers: [{ id: 'a', name: 'Provider A' }, { id: 'b', name: 'Provider B' }],
    catalogs: {
      a: [
        { id: 'image-model', name: 'Image Model', inputModalities: ['text', 'image'] },
        { id: 'text-model', name: 'Text Model', inputModalities: ['text'] },
        { id: 'unknown-model' },
      ],
      b: [{ id: 'b-image', inputModalities: ['image'] }],
    },
  })
  apply(ctx, {})

  const res = response()
  await recorded.routes[0].handler({ method: 'GET' }, res)

  assert.equal(res.state.status, 200)
  assert.equal(res.state.headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(res.state.body), {
    providers: [
      { id: 'a', name: 'Provider A', models: [{ id: 'image-model', name: 'Image Model' }] },
      { id: 'b', name: 'Provider B', models: [{ id: 'b-image', name: 'b-image' }] },
    ],
  })
})

test('the model list route rejects non-GET methods without touching the catalog', async () => {
  let listCalls = 0
  const { ctx, recorded } = host()
  ctx.llm.listProviders = () => {
    listCalls += 1
    return []
  }
  apply(ctx, {})

  const res = response()
  await recorded.routes[0].handler({ method: 'POST' }, res)

  assert.equal(res.state.status, 405)
  assert.deepEqual(JSON.parse(res.state.body), { error: 'method not allowed' })
  assert.equal(listCalls, 0)
})

test('a failing provider is left out instead of failing the whole list', async () => {
  const { ctx, recorded } = host({
    providers: [{ id: 'a' }, { id: 'broken' }],
    catalogs: { a: [{ id: 'image', inputModalities: ['image'] }] },
  })
  apply(ctx, {})

  const res = response()
  await recorded.routes[0].handler({ method: 'GET' }, res)

  assert.equal(res.state.status, 200)
  assert.deepEqual(JSON.parse(res.state.body), {
    providers: [{ id: 'a', name: 'a', models: [{ id: 'image', name: 'image' }] }],
  })
})

test('a total catalog failure is reported as 500', async () => {
  const { ctx, recorded } = host()
  ctx.llm.listProviders = () => {
    throw new Error('registry down')
  }
  apply(ctx, {})

  const res = response()
  await recorded.routes[0].handler({ method: 'GET' }, res)

  assert.equal(res.state.status, 500)
  assert.deepEqual(JSON.parse(res.state.body), { error: 'model list unavailable' })
  assert.ok(recorded.logs.some(([level, message]) => level === 'warn' && /registry down/.test(message)))
})

test('the tool timeout follows timeoutSeconds and is fixed at registration', () => {
  const byDefault = host()
  apply(byDefault.ctx, {})
  assert.equal(byDefault.recorded.tools[0].timeoutMs, 180 * 1000 + 15000)

  const short = host()
  apply(short.ctx, { timeoutSeconds: 30 })
  assert.equal(short.recorded.tools[0].timeoutMs, 30 * 1000 + 15000)
})
