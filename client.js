// Pterodactyl 面板插件 —— 只提供「插件设置页」的配置 UI，不注册任何面板/侧栏入口。
window.__ModuleLoader__.load({
  id: 'dsh-pterodactyl',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-pterodactyl'
    const CHANNEL = '/dsh-pterodactyl'
    const PACKAGE_NAME = 'dsh-pterodactyl'

    const DICT = {
      zh: {
        'title': '连接设置',
        'subtitle': 'API Key 保存在 DSH 凭证库（~/.dsh/.credentials.yaml），不会写进配置文件，也不会出现在工具调用里。',
        'baseUrl': '面板地址',
        'baseUrlPlaceholder': 'https://panel.example.com',
        'baseUrlHint': '可省略 /api/client，插件会自动补齐。',
        'apiKey': 'Client API Key',
        'apiKeyPlaceholderNew': '粘贴新的 API Key（在面板 /account/api 生成）',
        'apiKeyPlaceholder': '已保存，留空表示不修改',
        'apiKeyHint': '只写入凭证库，不回显明文。',
        'ref': '凭证名',
        'configured': '已配置',
        'missing': '未配置',
        'source.credentials': '凭证库',
        'source.file': '凭证库',
        'source.config': '插件配置',
        'source.env': '环境变量',
        'source.none': '无',
        'save': '保存',
        'saving': '保存中…',
        'clearKey': '清除 Key',
        'clearConfirm': '确定要从凭证库删除这个 API Key 吗？删除后工具会不可用。',
        'saved': '已保存',
        'cleared': 'API Key 已清除',
        'noCredentials': '当前部署没有挂载凭证服务，无法保存 API Key。',
        'loading': '加载中…',
        'summaryConfigured': '已连接',
        'summaryMissing': '未配置',
        'tools': '这个插件没有 Web 界面，配置完成后直接让 Agent 使用 pterodactyl_servers / pterodactyl_power / pterodactyl_backups / pterodactyl_files 即可。',
      },
      en: {
        'title': 'Connection settings',
        'subtitle': 'The API key is stored in the DSH credential store (~/.dsh/.credentials.yaml); it never lands in config files or tool payloads.',
        'baseUrl': 'Panel URL',
        'baseUrlPlaceholder': 'https://panel.example.com',
        'baseUrlHint': 'The /api/client suffix is optional and added automatically.',
        'apiKey': 'Client API key',
        'apiKeyPlaceholderNew': 'Paste a new API key (create one under /account/api)',
        'apiKeyPlaceholder': 'Saved — leave blank to keep it',
        'apiKeyHint': 'Written to the credential store only; never echoed back.',
        'ref': 'Credential name',
        'configured': 'Configured',
        'missing': 'Not configured',
        'source.credentials': 'credential store',
        'source.file': 'credential store',
        'source.config': 'plugin config',
        'source.env': 'environment',
        'source.none': 'none',
        'save': 'Save',
        'saving': 'Saving…',
        'clearKey': 'Remove key',
        'clearConfirm': 'Remove this API key from the credential store? Tools will stop working.',
        'saved': 'Saved',
        'cleared': 'API key removed',
        'noCredentials': 'No credential service is mounted in this deployment, so the API key cannot be saved.',
        'loading': 'Loading…',
        'summaryConfigured': 'Connected',
        'summaryMissing': 'Not configured',
        'tools': 'This plugin has no web UI. Once configured, ask the agent to use pterodactyl_servers / pterodactyl_power / pterodactyl_backups / pterodactyl_files.',
      },
    }

    async function call(endpoint, payload) {
      let response
      try {
        response = await fetch(CHANNEL + '/' + endpoint, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload ?? null),
        })
      } catch (error) {
        throw new Error('无法连接插件后台：' + String(error && error.message ? error.message : error))
      }
      let result = null
      try {
        result = await response.json()
      } catch {
        result = null
      }
      if (result === null || typeof result !== 'object') {
        throw new Error('插件后台返回了非 JSON 响应（HTTP ' + response.status + '）')
      }
      if (!result.ok) {
        const message = result.error && result.error.message ? result.error.message : '请求失败'
        throw new Error(message)
      }
      return result.value
    }

    function sourceLabel(value, t) {
      const key = 'source.' + String(value || 'none')
      const label = t(key)
      return label === key ? String(value || '') : label
    }

    const STYLES = `
      .ptcfg { display: flex; flex-direction: column; gap: 12px; padding: 14px 16px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }
      .ptcfg-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
      .ptcfg-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
      .ptcfg-state { font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .ptcfg-hint { font-size: 11px; color: var(--dsw-alias-label-secondary); line-height: 1.5; }
      .ptcfg-note { font-size: 11px; color: var(--dsw-alias-label-secondary); }
      .ptcfg-fields { display: grid; grid-template-columns: 1fr; gap: 10px; }
      .ptcfg-label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .ptcfg-input { padding: 6px 9px; font-size: 13px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; outline: none; }
      .ptcfg-input:focus { border-color: var(--dsw-alias-brand-primary); }
      .ptcfg-meta { display: flex; flex-wrap: wrap; gap: 12px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
      .ptcfg-actions { display: flex; align-items: center; gap: 8px; }
      .ptcfg-btn { padding: 5px 12px; font-size: 12px; border-radius: 7px; cursor: pointer; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
      .ptcfg-btn:disabled { opacity: 0.5; cursor: default; }
      .ptcfg-primary { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); }
      .ptcfg-danger { color: var(--dsw-alias-state-error-primary); }
      .ptcfg-msg { font-size: 12px; }
      .ptcfg-ok { color: var(--dsw-alias-state-success-primary); }
      .ptcfg-bad { color: var(--dsw-alias-state-error-primary); }
      .ptcfg-summary { font-size: 12px; color: var(--dsw-alias-label-secondary); }
    `

    function SettingsPanel(props) {
      const t = props.t
      const view = props.view === 'summary' ? 'summary' : 'page'
      const [settings, setSettings] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [saved, setSaved] = React.useState(null)
      const [loading, setLoading] = React.useState(true)
      const [busy, setBusy] = React.useState(false)
      const [form, setForm] = React.useState({ baseUrl: '', apiKey: '' })

      const load = React.useCallback(async () => {
        setLoading(true)
        try {
          const value = await call('settings')
          setSettings(value)
          setForm({ baseUrl: value.baseUrlRaw || value.baseUrl || '', apiKey: '' })
          setError(null)
        } catch (failure) {
          setError(String(failure && failure.message ? failure.message : failure))
        } finally {
          setLoading(false)
        }
      }, [])

      React.useEffect(() => {
        void load()
      }, [load])

      if (view === 'summary') {
        if (loading) return h('span', { className: 'ptcfg-summary' }, t('loading'))
        if (error) return h('span', { className: 'ptcfg-summary' }, error)
        const configured = Boolean(settings && settings.apiKeyConfigured)
        return h('span', { className: 'ptcfg-summary' }, configured ? t('summaryConfigured') : t('summaryMissing'))
      }

      const submit = async () => {
        setBusy(true)
        setSaved(null)
        try {
          const value = await call('settings/save', { baseUrl: form.baseUrl, apiKey: form.apiKey })
          setSaved(t('saved'))
          try {
            const next = await call('settings')
            setSettings(next)
            setForm({ baseUrl: next.baseUrlRaw || next.baseUrl || '', apiKey: '' })
          } catch {
            /* 保存已成功，刷新失败不重要 */
          }
          if (value && value.configured === false) setError(null)
        } catch (failure) {
          setError(String(failure && failure.message ? failure.message : failure))
        } finally {
          setBusy(false)
        }
      }

      const clearKey = async () => {
        const ask = typeof globalThis.confirm === 'function' ? globalThis.confirm : null
        if (ask && !ask(t('clearConfirm'))) return
        setBusy(true)
        setSaved(null)
        try {
          await call('settings/clear-key')
          setSaved(t('cleared'))
          await load()
        } catch (failure) {
          setError(String(failure && failure.message ? failure.message : failure))
        } finally {
          setBusy(false)
        }
      }

      const configured = Boolean(settings && settings.apiKeyConfigured)
      const source = settings ? sourceLabel(settings.apiKeySource, t) : ''
      const ref = settings ? settings.apiKeyRef : ''

      return h(
        'div',
        { className: 'ptcfg' },
        h('style', { key: 'style' }, STYLES),
        h(
          'div',
          { className: 'ptcfg-head', key: 'head' },
          h('div', { className: 'ptcfg-title' }, t('title')),
          h('div', { className: 'ptcfg-state' }, loading ? t('loading') : configured ? t('configured') : t('missing')),
        ),
        h('div', { className: 'ptcfg-hint', key: 'subtitle' }, t('subtitle')),
        error ? h('div', { className: 'ptcfg-msg ptcfg-bad', key: 'err', role: 'alert' }, error) : null,
        saved ? h('div', { className: 'ptcfg-msg ptcfg-ok', key: 'ok' }, saved) : null,
        h(
          'div',
          { className: 'ptcfg-fields', key: 'fields' },
          h(
            'label',
            { className: 'ptcfg-label' },
            t('baseUrl'),
            h('input', {
              className: 'ptcfg-input',
              type: 'text',
              value: form.baseUrl,
              placeholder: t('baseUrlPlaceholder'),
              onChange: (event) => setForm({ ...form, baseUrl: event.target.value }),
            }),
            h('span', { className: 'ptcfg-note' }, t('baseUrlHint')),
          ),
          h(
            'label',
            { className: 'ptcfg-label' },
            t('apiKey'),
            h('input', {
              className: 'ptcfg-input',
              type: 'password',
              value: form.apiKey,
              placeholder: configured ? t('apiKeyPlaceholder') : t('apiKeyPlaceholderNew'),
              onChange: (event) => setForm({ ...form, apiKey: event.target.value }),
            }),
            h('span', { className: 'ptcfg-note' }, t('apiKeyHint')),
          ),
        ),
        ref
          ? h(
              'div',
              { className: 'ptcfg-meta', key: 'meta' },
              h('span', null, t('ref') + '：' + ref),
              h('span', null, configured ? t('configured') + '（' + source + '）' : t('missing')),
            )
          : null,
        h(
          'div',
          { className: 'ptcfg-actions', key: 'actions' },
          h(
            'button',
            { className: 'ptcfg-btn ptcfg-primary', type: 'button', disabled: busy, onClick: () => void submit() },
            busy ? t('saving') : t('save'),
          ),
          configured
            ? h(
                'button',
                { className: 'ptcfg-btn ptcfg-danger', type: 'button', disabled: busy, onClick: () => void clearKey() },
                t('clearKey'),
              )
            : null,
        ),
        h('div', { className: 'ptcfg-hint', key: 'tools' }, t('tools')),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.locale.register(NS, 'zh', DICT.zh)
        ctx.locale.register(NS, 'en', DICT.en)
        const t = ctx.locale.bind(NS)
        // 只占用插件详情页的「配置」位；不注册 main / sidebar.panellist，所以没有独立面板。
        ctx.slots.inject('plugins.bundle.config', () =>
          ctx.slots.register(
            {
              name: 'plugins.bundle.config',
              key: PACKAGE_NAME,
              locale: NS,
              inject: () => ({ t }),
            },
            SettingsPanel,
          ),
        )
      },
    }
  },
})
