/**
 * Configuration page for the image-to-text plugin, browser half.
 *
 * Hand-written React with no build step: the module loader hands us React and
 * the page renders into the Plugins page's `plugins.row.config` slot while the
 * Host serves the `image-to-text` settings namespace. The Host half owns the
 * schema; this page only stages edits and sends them back in one mutation.
 */
window.__ModuleLoader__.load({
  id: '@szleaves/dsh-image-to-text',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Settings namespace: the Host plugin's entry id, which is also this row's id. */
    const NS = 'image-to-text'
    /** Key format for keyed page slots: `<package name>#<row id>`. */
    const ROW_KEY = '@szleaves/dsh-image-to-text#image-to-text'
    /** Read-only model list registered by this plugin's Host half. */
    const MODELS_ROUTE = '/plugins/image-to-text/models'

    /** Simplified Chinese copy. */
    const zh = {
      title: '读图设置',
      summaryAuto: '读图模型：自动选择',
      summaryFixed: '读图模型：{provider} / {model}',
      summaryNoProvider: '未指定提供方',
      summaryUnavailable: '读图设置未加载',
      summaryWhat: '纯文本模型的读图通道：模型调用 ask_image，由已声明支持图片的模型读图并返回文字。',
      loading: '正在读取设置…',
      unavailable: '该插件当前未加载，暂时无法配置。',
      readOnly: '本部署的设置为只读，无法保存。',
      sectionReader: '读图模型',
      readerMode: '选择方式',
      readerModeHint: '自动选择会在声明支持图片输入的模型里挑一个；指定会固定使用下面的模型。',
      modeAuto: '自动选择',
      modeFixed: '指定模型',
      readerProvider: '提供方',
      readerModel: '模型',
      readerPairHint: '列表只含声明支持图片输入的模型。',
      modelsLoading: '正在读取模型列表…',
      modelsFailed: '模型列表读取失败，可以重新加载，或保留当前值。',
      modelsEmpty: '没有找到声明支持图片输入的模型，请先在模型设置里配置一个。',
      retry: '重新加载',
      notInList: '{value}（不在当前列表中）',
      chooseProvider: '请选择提供方',
      chooseModel: '请选择模型',
      preferProviders: '优先提供方',
      preferProvidersHint: '自动选择时优先尝试的提供方 id，用英文逗号分隔，靠前的先试；留空表示不限定。',
      sectionPrompt: '提示词',
      defaultPrompt: '通用提示词',
      defaultPromptHint: '调用方没有说明读图目的时使用；{{maxChars}} 会替换成下面的返回上限。留空时使用插件内置的通用提示词。',
      advanced: '进阶：带目的的提示词模板',
      promptTemplate: '提示词模板',
      promptTemplateHint: '调用方说明目的时使用；{{purpose}} 替换成目的，{{maxChars}} 替换成返回上限，各替换一次。留空时使用插件内置模板。',
      sectionLimits: '调用限制',
      maxChars: '返回字符上限',
      maxCharsHint: '读图模型一次最多返回的字符数，留空使用默认值 8000。',
      timeoutSeconds: '超时（秒）',
      timeoutSecondsHint: '单次读图调用最长等待时间，留空使用默认值 180。',
      cacheEntries: '缓存条数',
      cacheEntriesHint: '最多保留多少条读图结果，0 表示不缓存，留空使用默认值 200。',
      bridgeAdmission: '向提示准入声明图片支持',
      bridgeAdmissionHint: '关闭后，纯文本模型不再收到图片占位提示；一般只用于排查问题。保存后需重新加载插件才生效。',
      save: '保存并应用',
      saving: '保存中…',
      discard: '撤销修改',
      saved: '已保存。',
      conflict: '设置已被其他改动更新，已重新载入，请确认后再保存。',
      saveFailed: '保存失败：{message}',
      nothingChanged: '没有需要保存的修改。',
      invalidNumber: '请填不小于 0 的整数，或留空使用默认值。',
      invalidPositive: '请填不小于 1 的整数，或留空使用默认值。',
      fixedNeedsModel: '指定模型时，提供方和模型都要选择。',
    }

    /** English copy. */
    const en = {
      title: 'Image reading settings',
      summaryAuto: 'Reader: chosen automatically',
      summaryFixed: 'Reader: {provider} / {model}',
      summaryNoProvider: 'no provider',
      summaryUnavailable: 'Image reading settings are not loaded',
      summaryWhat:
        'How a text-only model reads images: it calls ask_image and a model that declares image input returns the text.',
      loading: 'Loading settings…',
      unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
      readOnly: 'This deployment stores settings read-only, so nothing can be saved.',
      sectionReader: 'Reader model',
      readerMode: 'Selection',
      readerModeHint: 'Automatic picks among models that declare image input; Fixed always uses the model below.',
      modeAuto: 'Automatic',
      modeFixed: 'Fixed model',
      readerProvider: 'Provider',
      readerModel: 'Model',
      readerPairHint: 'Only models that declare image input are listed.',
      modelsLoading: 'Loading the model list…',
      modelsFailed: 'The model list could not be read. Reload it, or keep the current values.',
      modelsEmpty: 'No model declares image input. Configure one in the model settings first.',
      retry: 'Reload',
      notInList: '{value} (not in the current list)',
      chooseProvider: 'Select a provider',
      chooseModel: 'Select a model',
      preferProviders: 'Preferred providers',
      preferProvidersHint: 'Provider ids to try first in automatic mode, comma separated; the earliest comes first. Leave blank to accept any provider.',
      sectionPrompt: 'Prompts',
      defaultPrompt: 'Fallback prompt',
      defaultPromptHint: 'Used when the caller states no purpose. {{maxChars}} is replaced with the character limit below. Leave blank to use the built-in prompt.',
      advanced: 'Advanced: prompt template',
      promptTemplate: 'Prompt template',
      promptTemplateHint: 'Used when the caller states a purpose. {{purpose}} and {{maxChars}} are replaced once each. Leave blank to use the built-in template.',
      sectionLimits: 'Call limits',
      maxChars: 'Answer length limit',
      maxCharsHint: 'Most characters a reader answer may contain. Leave blank for the default of 8000.',
      timeoutSeconds: 'Timeout (seconds)',
      timeoutSecondsHint: 'Longest wait for one reader call. Leave blank for the default of 180.',
      cacheEntries: 'Cached answers',
      cacheEntriesHint: 'How many reader answers to keep, 0 disables caching. Leave blank for the default of 200.',
      bridgeAdmission: 'Report image support to prompt admission',
      bridgeAdmissionHint: 'When off, text-only models no longer receive image placeholders. Turn it off only to investigate a problem. Takes effect after the plugin is reloaded.',
      save: 'Save and apply',
      saving: 'Saving…',
      discard: 'Discard changes',
      saved: 'Saved.',
      conflict: 'These settings changed elsewhere. The latest values were reloaded; check them before saving again.',
      saveFailed: 'Saving failed: {message}',
      nothingChanged: 'Nothing to save.',
      invalidNumber: 'Enter a whole number of at least 0, or leave blank for the default.',
      invalidPositive: 'Enter a whole number of at least 1, or leave blank for the default.',
      fixedNeedsModel: 'Fixed mode needs both a provider and a model.',
    }

    const styles = {
      page: {
        display: 'grid',
        gap: '20px',
        maxWidth: '720px',
        padding: '4px 0',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '13px',
        lineHeight: 1.5,
      },
      section: { display: 'grid', gap: '10px' },
      sectionTitle: {
        margin: 0,
        fontSize: '13px',
        fontWeight: 600,
        color: 'var(--dsw-alias-label-primary)',
      },
      field: { display: 'grid', gap: '4px' },
      label: {
        fontSize: '12px',
        fontWeight: 500,
        color: 'var(--dsw-alias-label-secondary)',
      },
      control: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '6px 8px',
        border: '1px solid var(--dsw-alias-border-l3, #d0d5dd)',
        borderRadius: '6px',
        background: 'var(--dsw-alias-bg-base, transparent)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '13px',
        lineHeight: 1.4,
      },
      textarea: {
        width: '100%',
        boxSizing: 'border-box',
        minHeight: '96px',
        padding: '8px',
        border: '1px solid var(--dsw-alias-border-l3, #d0d5dd)',
        borderRadius: '6px',
        background: 'var(--dsw-alias-bg-base, transparent)',
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: '12px',
        lineHeight: 1.5,
        resize: 'vertical',
      },
      grid: { display: 'grid', gap: '10px', gridTemplateColumns: '1fr 1fr' },
      hint: {
        margin: 0,
        fontSize: '12px',
        lineHeight: 1.5,
        color: 'var(--dsw-alias-label-tertiary)',
      },
      notice: { margin: 0, fontSize: '12px', lineHeight: 1.5 },
      ok: {
        margin: 0,
        fontSize: '12px',
        lineHeight: 1.5,
        color: 'var(--dsw-alias-state-success-primary)',
      },
      error: {
        margin: 0,
        fontSize: '12px',
        lineHeight: 1.5,
        color: 'var(--dsw-alias-state-error-primary)',
      },
      warn: {
        margin: 0,
        fontSize: '12px',
        lineHeight: 1.5,
        color: 'var(--dsw-alias-state-warn-label, var(--dsw-alias-state-warn-primary))',
      },
      details: { display: 'grid', gap: '8px' },
      summary: {
        cursor: 'pointer',
        fontSize: '12px',
        fontWeight: 500,
        color: 'var(--dsw-alias-label-secondary)',
      },
      checkRow: {
        display: 'flex',
        gap: '8px',
        alignItems: 'flex-start',
        fontSize: '13px',
        color: 'var(--dsw-alias-label-primary)',
      },
      actions: { display: 'flex', gap: '8px', alignItems: 'center' },
      primary: {
        padding: '6px 14px',
        border: '1px solid var(--dsw-alias-button-primary-fill, #4d6bfe)',
        borderRadius: '6px',
        background: 'var(--dsw-alias-button-primary-fill, #4d6bfe)',
        color: 'var(--dsw-alias-label-primary-inverted, #ffffff)',
        fontSize: '13px',
        cursor: 'pointer',
      },
      secondary: {
        padding: '6px 14px',
        border: '1px solid var(--dsw-alias-border-l3, #d0d5dd)',
        borderRadius: '6px',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '13px',
        cursor: 'pointer',
      },
      retry: {
        padding: 0,
        border: 'none',
        background: 'none',
        color: 'var(--dsw-alias-link)',
        fontSize: '12px',
        cursor: 'pointer',
        textDecoration: 'underline',
      },
    }

    /**
     * One labelled control with its hint.
     * @param props - the control id its label points at, the copy, and the control.
     * @returns the field element.
     */
    function Field(props) {
      return h(
        'div',
        { style: styles.field },
        h('label', { htmlFor: props.id, style: styles.label }, props.label),
        props.children,
        props.hint === undefined || props.hint === null
          ? null
          : h('p', { style: styles.hint }, props.hint),
      )
    }

    /**
     * One titled group of fields.
     * @param props - the section heading and its fields.
     * @returns the section element.
     */
    function Section(props) {
      return h(
        'section',
        { style: styles.section },
        h('h2', { style: styles.sectionTitle }, props.title),
        props.children,
      )
    }

    /**
     * A number staged as text, so a half-typed value survives a render.
     * @param value - the accepted number, if any.
     * @returns the input text.
     */
    function numberText(value) {
      return typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
    }

    /**
     * The staged form corresponding to one accepted section.
     * @param value - the section's resolved values.
     * @returns a fresh draft.
     */
    function draftOf(value) {
      const source = value ?? {}
      return {
        readerMode: source.readerMode === 'fixed' ? 'fixed' : 'auto',
        readerProvider: typeof source.readerProvider === 'string' ? source.readerProvider : '',
        readerModel: typeof source.readerModel === 'string' ? source.readerModel : '',
        preferProviders: Array.isArray(source.preferProviders)
          ? source.preferProviders.filter(entry => typeof entry === 'string' && entry !== '').join(', ')
          : '',
        defaultPrompt: typeof source.defaultPrompt === 'string' ? source.defaultPrompt : '',
        promptTemplate: typeof source.promptTemplate === 'string' ? source.promptTemplate : '',
        maxChars: numberText(source.maxChars),
        timeoutSeconds: numberText(source.timeoutSeconds),
        cacheEntries: numberText(source.cacheEntries),
        bridgeAdmission: source.bridgeAdmission !== false,
      }
    }

    /**
     * Whether two drafts hold the same staged values.
     * @param left - one draft.
     * @param right - the other draft.
     * @returns true when every field matches.
     */
    function sameDraft(left, right) {
      return (
        left.readerMode === right.readerMode &&
        left.readerProvider === right.readerProvider &&
        left.readerModel === right.readerModel &&
        left.preferProviders === right.preferProviders &&
        left.defaultPrompt === right.defaultPrompt &&
        left.promptTemplate === right.promptTemplate &&
        left.maxChars === right.maxChars &&
        left.timeoutSeconds === right.timeoutSeconds &&
        left.cacheEntries === right.cacheEntries &&
        left.bridgeAdmission === right.bridgeAdmission
      )
    }

    /**
     * Split the comma-separated field into the stored array, keeping order and
     * dropping blanks and repeats so a duplicated id cannot make the Host store
     * the same provider twice.
     * @param text - the staged text.
     * @returns provider ids.
     */
    function parseProviders(text) {
      const seen = new Set()
      const out = []
      for (const raw of text.split(',')) {
        const id = raw.trim()
        if (id === '' || seen.has(id)) continue
        seen.add(id)
        out.push(id)
      }
      return out
    }

    /**
     * Stage one number field. A blank field clears the value so the Host's schema
     * default applies again; anything else must be a whole number in range.
     * @param ops - the mutation being built.
     * @param invalid - the first blocking copy key, appended in place.
     * @param path - the field path.
     * @param text - the staged text.
     * @param minimum - the smallest accepted value.
     * @param message - the copy key reported when the text is unusable.
     * @param accepted - the value the Host currently holds for the field.
     */
    function stageNumber(ops, invalid, path, text, minimum, message, accepted) {
      const current = Number.isSafeInteger(accepted) ? accepted : undefined
      const trimmed = text.trim()
      if (trimmed === '') {
        if (current !== undefined) ops.push({ op: 'unset', path })
        return
      }
      const value = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN
      if (!Number.isSafeInteger(value) || value < minimum) {
        if (invalid.length === 0) invalid.push(message)
        return
      }
      if (value !== current) ops.push({ op: 'set', path, value })
    }

    /**
     * Build the single mutation the Save button sends, skipping fields whose
     * staged value still matches the accepted section.
     * @param draft - the staged values.
     * @param value - the accepted section.
     * @returns the ordered operations and the first blocking copy key.
     */
    function planOf(draft, value) {
      const source = value ?? {}
      const ops = []
      const invalid = []

      const acceptedMode = source.readerMode === 'fixed' ? 'fixed' : 'auto'
      if (draft.readerMode !== acceptedMode) {
        ops.push({ op: 'set', path: ['readerMode'], value: draft.readerMode })
      }

      if (draft.readerMode === 'fixed') {
        const provider = draft.readerProvider
        const model = draft.readerModel
        if (provider === '' || model === '') invalid.push('fixedNeedsModel')
        const acceptedProvider = typeof source.readerProvider === 'string' ? source.readerProvider.trim() : ''
        const acceptedModel = typeof source.readerModel === 'string' ? source.readerModel.trim() : ''
        if (provider !== acceptedProvider) ops.push({ op: 'set', path: ['readerProvider'], value: provider })
        if (model !== acceptedModel) ops.push({ op: 'set', path: ['readerModel'], value: model })
      }

      const preferred = parseProviders(draft.preferProviders)
      const acceptedPreferred = Array.isArray(source.preferProviders)
        ? source.preferProviders.filter(entry => typeof entry === 'string' && entry !== '')
        : []
      const samePreferred =
        preferred.length === acceptedPreferred.length &&
        preferred.every((entry, index) => entry === acceptedPreferred[index])
      if (!samePreferred) ops.push({ op: 'set', path: ['preferProviders'], value: preferred })

      const acceptedDefault = typeof source.defaultPrompt === 'string' ? source.defaultPrompt : ''
      if (draft.defaultPrompt !== acceptedDefault) {
        ops.push({ op: 'set', path: ['defaultPrompt'], value: draft.defaultPrompt })
      }
      const acceptedTemplate = typeof source.promptTemplate === 'string' ? source.promptTemplate : ''
      if (draft.promptTemplate !== acceptedTemplate) {
        ops.push({ op: 'set', path: ['promptTemplate'], value: draft.promptTemplate })
      }

      stageNumber(ops, invalid, ['maxChars'], draft.maxChars, 1, 'invalidPositive', source.maxChars)
      stageNumber(ops, invalid, ['timeoutSeconds'], draft.timeoutSeconds, 1, 'invalidPositive', source.timeoutSeconds)
      stageNumber(ops, invalid, ['cacheEntries'], draft.cacheEntries, 0, 'invalidNumber', source.cacheEntries)

      if (draft.bridgeAdmission !== (source.bridgeAdmission !== false)) {
        ops.push({ op: 'set', path: ['bridgeAdmission'], value: draft.bridgeAdmission })
      }

      return { ops, invalid: invalid.length > 0 ? invalid[0] : null }
    }

    /**
     * Narrow the model route's response. A malformed answer is treated as an
     * empty catalog, never as rows the page cannot render.
     * @param body - the parsed response.
     * @returns providers that each carry at least one model.
     */
    function normalizeProviders(body) {
      if (body === null || typeof body !== 'object' || !Array.isArray(body.providers)) return []
      const out = []
      for (const entry of body.providers) {
        if (entry === null || typeof entry !== 'object') continue
        const id = typeof entry.id === 'string' ? entry.id : ''
        if (id === '' || !Array.isArray(entry.models)) continue
        const models = []
        for (const model of entry.models) {
          if (model === null || typeof model !== 'object') continue
          const modelId = typeof model.id === 'string' ? model.id : ''
          if (modelId === '') continue
          models.push({
            id: modelId,
            name: typeof model.name === 'string' && model.name !== '' ? model.name : modelId,
          })
        }
        if (models.length === 0) continue
        out.push({
          id,
          name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : id,
          models,
        })
      }
      return out
    }

    /**
     * The one-line summary the Plugins page shows when the row carries none.
     * @param snapshot - the namespace's current snapshot.
     * @param t - the page's locale reader.
     * @returns the summary line.
     */
    function summaryText(snapshot, t) {
      if (snapshot.status !== 'ready' || snapshot.value === undefined) return t('summaryUnavailable')
      const value = snapshot.value
      if (value.readerMode === 'fixed' && typeof value.readerModel === 'string' && value.readerModel !== '') {
        const provider =
          typeof value.readerProvider === 'string' && value.readerProvider !== ''
            ? value.readerProvider
            : t('summaryNoProvider')
        return t('summaryFixed', { provider, model: value.readerModel })
      }
      return t('summaryAuto')
    }

    /**
     * Build the page component over one namespace form. The form is owned by the
     * settings provider, so this page only subscribes to it and never disposes it.
     * @param form - the shared form for the `image-to-text` namespace.
     * @returns the slot component.
     */
    function createPage(form) {
      const subscribe = listener => form.subscribe(listener)
      const read = () => form.getSnapshot()

      function ConfigPage(props) {
        const t = props.t
        const view = props.view
        const snapshot = React.useSyncExternalStore(subscribe, read, read)
        const [draft, setDraft] = React.useState(null)
        const [notice, setNotice] = React.useState(null)
        const [saving, setSaving] = React.useState(false)
        const [catalog, setCatalog] = React.useState({ status: 'loading', providers: [] })
        const abortRef = React.useRef(null)
        const prefix = React.useId()

        const ready = snapshot.status === 'ready'
        const writable = snapshot.writable !== false
        const blocked = !ready || !writable
        const blockedReason =
          snapshot.status === 'loading'
            ? t('loading')
            : snapshot.status === 'unavailable'
              ? t('unavailable')
              : !writable
                ? t('readOnly')
                : null

        // Follow the accepted values: a first ready snapshot seeds the draft, and
        // a later one replaces it only while it still matches what is staged, so
        // an edit in progress is never overwritten by an unrelated write.
        React.useEffect(() => {
          if (snapshot.status !== 'ready' || snapshot.value === undefined) return
          const incoming = draftOf(snapshot.value)
          setDraft(current => (current === null ? incoming : sameDraft(current, incoming) ? incoming : current))
        }, [snapshot.status, snapshot.revision, snapshot.value])

        const loadModels = React.useCallback(() => {
          if (abortRef.current !== null) abortRef.current.abort()
          const controller = typeof AbortController === 'function' ? new AbortController() : null
          abortRef.current = controller
          setCatalog(current => ({ status: 'loading', providers: current.providers }))
          const init = { credentials: 'same-origin', headers: { accept: 'application/json' } }
          if (controller !== null) init.signal = controller.signal
          fetch(MODELS_ROUTE, init)
            .then(response => {
              if (!response.ok) throw new Error('HTTP ' + String(response.status))
              return response.json()
            })
            .then(body => {
              setCatalog({ status: 'ready', providers: normalizeProviders(body) })
            })
            .catch(() => {
              if (controller !== null && controller.signal.aborted) return
              setCatalog(current => ({ status: 'failed', providers: current.providers }))
            })
        }, [])

        React.useEffect(() => {
          if (view !== 'page') return undefined
          loadModels()
          return () => {
            if (abortRef.current !== null) abortRef.current.abort()
          }
        }, [view, loadModels])

        if (view === 'summary') return t('summaryWhat') + ' ' + summaryText(snapshot, t)

        const update = patch => {
          setDraft(current => (current === null ? current : { ...current, ...patch }))
        }

        const save = () => {
          if (blocked || saving || draft === null) return
          const latest = form.getSnapshot()
          if (latest.status !== 'ready' || latest.writable === false) return
          const plan = planOf(draft, latest.value ?? {})
          if (plan.invalid !== null) {
            setNotice({ kind: 'invalid', key: plan.invalid })
            return
          }
          if (plan.ops.length === 0) {
            setNotice({ kind: 'none' })
            return
          }
          setSaving(true)
          setNotice(null)
          form
            .mutate(plan.ops, latest.revision)
            .then(accepted => {
              setSaving(false)
              const settled = form.getSnapshot()
              if (settled.status === 'ready' && settled.value !== undefined) {
                setDraft(draftOf(settled.value))
              }
              setNotice(accepted ? { kind: 'saved' } : { kind: 'conflict' })
            })
            .catch(error => {
              setSaving(false)
              setNotice({ kind: 'failed', message: error instanceof Error ? error.message : String(error) })
            })
        }

        const discard = () => {
          const latest = form.getSnapshot()
          setDraft(draftOf(latest.value ?? {}))
          setNotice(null)
        }

        if (draft === null) {
          return h(
            'p',
            { style: styles.hint, role: 'status' },
            blockedReason === null ? t('loading') : blockedReason,
          )
        }

        const controlsDisabled = blocked || saving
        const modeControl = h(
          'select',
          {
            id: prefix + '-mode',
            style: styles.control,
            value: draft.readerMode,
            disabled: controlsDisabled,
            onChange: event => update({ readerMode: event.target.value === 'fixed' ? 'fixed' : 'auto' }),
          },
          h('option', { value: 'auto' }, t('modeAuto')),
          h('option', { value: 'fixed' }, t('modeFixed')),
        )

        const providerIds = catalog.providers.map(entry => entry.id)
        const providerOptions = catalog.providers.map(entry =>
          h('option', { key: entry.id, value: entry.id }, entry.name),
        )
        if (draft.readerProvider !== '' && !providerIds.includes(draft.readerProvider)) {
          providerOptions.push(
            h(
              'option',
              { key: draft.readerProvider, value: draft.readerProvider },
              t('notInList', { value: draft.readerProvider }),
            ),
          )
        }
        providerOptions.unshift(h('option', { key: '', value: '' }, t('chooseProvider')))

        const group = catalog.providers.find(entry => entry.id === draft.readerProvider)
        const modelIds = group === undefined ? [] : group.models.map(model => model.id)
        const modelOptions = group === undefined
          ? []
          : group.models.map(model => h('option', { key: model.id, value: model.id }, model.name))
        if (draft.readerModel !== '' && !modelIds.includes(draft.readerModel)) {
          modelOptions.push(
            h(
              'option',
              { key: draft.readerModel, value: draft.readerModel },
              t('notInList', { value: draft.readerModel }),
            ),
          )
        }
        modelOptions.unshift(h('option', { key: '', value: '' }, t('chooseModel')))

        const chooseProvider = providerId => {
          const chosen = catalog.providers.find(entry => entry.id === providerId)
          setDraft(current => {
            if (current === null) return current
            const keepsModel =
              chosen !== undefined && chosen.models.some(model => model.id === current.readerModel)
            const nextModel = keepsModel
              ? current.readerModel
              : chosen === undefined
                ? ''
                : chosen.models[0] === undefined
                  ? ''
                  : chosen.models[0].id
            return { ...current, readerProvider: providerId, readerModel: nextModel }
          })
        }

        const modelsLine =
          catalog.status === 'loading'
            ? h('p', { style: styles.hint, role: 'status' }, t('modelsLoading'))
            : catalog.status === 'failed'
              ? h(
                  'div',
                  null,
                  h('p', { style: styles.error, role: 'alert' }, t('modelsFailed')),
                  h(
                    'button',
                    { type: 'button', style: styles.retry, onClick: loadModels },
                    t('retry'),
                  ),
                )
              : catalog.providers.length === 0
                ? h('div', null,
                    h('p', { style: styles.hint }, t('modelsEmpty')),
                    h('button', { type: 'button', style: styles.retry, onClick: loadModels }, t('retry')),
                  )
                : null

        const noticeLine =
          notice === null
            ? null
            : notice.kind === 'saved'
              ? h('p', { style: styles.ok, role: 'status' }, t('saved'))
              : notice.kind === 'conflict'
                ? h('p', { style: styles.error, role: 'alert' }, t('conflict'))
                : notice.kind === 'failed'
                  ? h('p', { style: styles.error, role: 'alert' }, t('saveFailed', { message: notice.message }))
                  : notice.kind === 'invalid'
                    ? h('p', { style: styles.error, role: 'alert' }, t(notice.key))
                    : h('p', { style: styles.hint, role: 'status' }, t('nothingChanged'))

        const readerFields =
          draft.readerMode === 'fixed'
            ? h(
                'div',
                { style: styles.grid },
                h(
                  Field,
                  { id: prefix + '-provider', label: t('readerProvider') },
                  h(
                    'select',
                    {
                      id: prefix + '-provider',
                      style: styles.control,
                      value: draft.readerProvider,
                      disabled: controlsDisabled,
                      onChange: event => chooseProvider(event.target.value),
                    },
                    providerOptions,
                  ),
                ),
                h(
                  Field,
                  { id: prefix + '-model', label: t('readerModel'), hint: t('readerPairHint') },
                  h(
                    'select',
                    {
                      id: prefix + '-model',
                      style: styles.control,
                      value: draft.readerModel,
                      disabled: controlsDisabled,
                      onChange: event => update({ readerModel: event.target.value }),
                    },
                    modelOptions,
                  ),
                ),
              )
            : null

        return h(
          'form',
          {
            style: styles.page,
            'aria-label': t('title'),
            onSubmit: event => {
              event.preventDefault()
              save()
            },
          },
          blockedReason === null ? null : h('p', { style: styles.warn, role: 'status' }, blockedReason),
          h(
            Section,
            { title: t('sectionReader') },
            h(Field, { id: prefix + '-mode', label: t('readerMode'), hint: t('readerModeHint') }, modeControl),
            readerFields,
            modelsLine,
            h(
              Field,
              { id: prefix + '-prefer', label: t('preferProviders'), hint: t('preferProvidersHint') },
              h('input', {
                id: prefix + '-prefer',
                type: 'text',
                style: styles.control,
                value: draft.preferProviders,
                disabled: controlsDisabled,
                onChange: event => update({ preferProviders: event.target.value }),
              }),
            ),
          ),
          h(
            Section,
            { title: t('sectionPrompt') },
            h(
              Field,
              { id: prefix + '-default-prompt', label: t('defaultPrompt'), hint: t('defaultPromptHint') },
              h('textarea', {
                id: prefix + '-default-prompt',
                style: styles.textarea,
                rows: 5,
                value: draft.defaultPrompt,
                disabled: controlsDisabled,
                onChange: event => update({ defaultPrompt: event.target.value }),
              }),
            ),
            h(
              'details',
              { style: styles.details },
              h('summary', { style: styles.summary }, t('advanced')),
              h(
                Field,
                { id: prefix + '-template', label: t('promptTemplate'), hint: t('promptTemplateHint') },
                h('textarea', {
                  id: prefix + '-template',
                  style: styles.textarea,
                  rows: 6,
                  value: draft.promptTemplate,
                  disabled: controlsDisabled,
                  onChange: event => update({ promptTemplate: event.target.value }),
                }),
              ),
            ),
          ),
          h(
            Section,
            { title: t('sectionLimits') },
            h(
              'div',
              { style: styles.grid },
              h(
                Field,
                { id: prefix + '-max-chars', label: t('maxChars'), hint: t('maxCharsHint') },
                h('input', {
                  id: prefix + '-max-chars',
                  type: 'number',
                  inputMode: 'numeric',
                  min: 1,
                  step: 1,
                  style: styles.control,
                  value: draft.maxChars,
                  disabled: controlsDisabled,
                  onChange: event => update({ maxChars: event.target.value }),
                }),
              ),
              h(
                Field,
                { id: prefix + '-timeout', label: t('timeoutSeconds'), hint: t('timeoutSecondsHint') },
                h('input', {
                  id: prefix + '-timeout',
                  type: 'number',
                  inputMode: 'numeric',
                  min: 1,
                  step: 1,
                  style: styles.control,
                  value: draft.timeoutSeconds,
                  disabled: controlsDisabled,
                  onChange: event => update({ timeoutSeconds: event.target.value }),
                }),
              ),
              h(
                Field,
                { id: prefix + '-cache', label: t('cacheEntries'), hint: t('cacheEntriesHint') },
                h('input', {
                  id: prefix + '-cache',
                  type: 'number',
                  inputMode: 'numeric',
                  min: 0,
                  step: 1,
                  style: styles.control,
                  value: draft.cacheEntries,
                  disabled: controlsDisabled,
                  onChange: event => update({ cacheEntries: event.target.value }),
                }),
              ),
            ),
          ),
          h(
            'section',
            { style: styles.section },
            h(
              'label',
              { style: styles.checkRow, htmlFor: prefix + '-bridge' },
              h('input', {
                id: prefix + '-bridge',
                type: 'checkbox',
                checked: draft.bridgeAdmission,
                disabled: controlsDisabled,
                onChange: event => update({ bridgeAdmission: event.target.checked }),
              }),
              h('span', null, t('bridgeAdmission')),
            ),
            h('p', { style: styles.hint }, t('bridgeAdmissionHint')),
          ),
          h(
            'div',
            { style: styles.actions },
            h(
              'button',
              {
                type: 'submit',
                style: styles.primary,
                disabled: controlsDisabled,
                'aria-busy': saving,
              },
              saving ? t('saving') : t('save'),
            ),
            h(
              'button',
              {
                type: 'button',
                style: styles.secondary,
                disabled: controlsDisabled,
                onClick: discard,
              },
              t('discard'),
            ),
          ),
          noticeLine,
        )
      }

      return ConfigPage
    }

    /**
     * Mount the page while the Host serves the namespace, so a profile that never
     * composed the Host half shows no trace of it.
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      const form = ctx.configForms.get(NS)
      const ConfigPage = createPage(form)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'image-to-text: dictionaries')
      ctx.inject(['slots', 'locale', 'configForms'], scope => {
        scope.effect(
          () =>
            scope.configForms.whileServed([NS], () =>
              scope.slots.inject('plugins.row.config', () =>
                scope.slots.register(
                  { name: 'plugins.row.config', key: ROW_KEY, locale: NS },
                  ConfigPage,
                ),
              ),
            ),
          'image-to-text: settings page',
        )
      })
    }

    return { inject: ['slots', 'locale', 'configForms'], apply }
  },
})
