/**
 * Pterodactyl 面板 Host 半边。
 *
 * 职责：
 *  - 唯一持有 Client API 凭证与网络访问（浏览器侧不接触 API Key）；
 *  - 向 Agent 注册 5 个工具：pterodactyl_servers / pterodactyl_power / pterodactyl_backups /
 *    pterodactyl_files / pterodactyl_console（WebSocket 控制台）。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'

export const inject = ['tools', 'webServer', 'approval']

const POWER_SIGNALS = ['start', 'stop', 'restart', 'kill']
// 这些控制台命令会停机、改权限或封禁玩家，执行前要求调用方显式 confirm，并额外向会话申请一次人工授权。
const DANGEROUS_COMMANDS = new Set(['stop', 'kill', 'op', 'deop', 'ban', 'ban-ip', 'pardon', 'pardon-ip'])

export const Config = z.object({
  baseUrl: z.string().default('').description('面板根地址，例如 https://panel.example.com'),
  apiKeyRef: z
    .string()
    .default('PTERODACTYL_API_KEY')
    .description('Client API Key 的凭证名，值保存在 DSH 凭证库（~/.dsh/.credentials.yaml）；面板里的“设置”可写入'),
  allowInsecure: z.boolean().default(false).description('跳过 TLS 证书校验（自签名面板）'),
  requestTimeoutMs: z.number().default(15000).description('单次请求超时（毫秒）'),
  approvalPolicy: z
    .union([z.const('strict'), z.const('fallback')])
    .default('strict')
    .description(
      '危险操作的人工授权策略。strict：拿不到明确同意就不执行（当前环境没有可用的授权应答方也拒绝）；fallback：没有应答方时退回到“调用方显式 confirm 即可执行”，用户主动拒绝仍然拦。',
    ),
})

const DEFAULT_API_KEY_REF = 'PTERODACTYL_API_KEY'

// 插件版本，从同目录的 package.json 读。工具返回里带上它，便于在会话中确认“跑的是哪一版”：
// 插件更新后旧会话仍持有旧的工具定义，只有版本号能当场揭穿。
const PLUGIN_VERSION = (() => {
  try {
    const here = fileURLToPath(new URL('./package.json', import.meta.url))
    return JSON.parse(readFileSync(here, 'utf8')).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
})()

/** 凭证名：配置里可改，留空回退默认名。 */
function apiKeyRefOf(config) {
  const ref = String(config?.apiKeyRef ?? '').trim()
  return ref || DEFAULT_API_KEY_REF
}

/**
 * 读取 Client API Key。顺序：DSH 凭证库 → 环境变量。
 * 每次调用都重新解析，所以面板里改完 key 立即生效，无需重启。
 */
async function readApiKey(ctx, config) {
  const ref = apiKeyRefOf(config)
  const credentials = ctx.get('credentials')
  if (credentials) {
    try {
      const hit = await credentials.resolve(ref)
      if (hit && typeof hit.value === 'string' && hit.value.trim() !== '') {
        return { value: hit.value.trim(), source: 'credentials', ref }
      }
    } catch {
      /* 凭证服务异常时继续走回退层 */
    }
  }
  const ambient = String(process.env[ref] ?? '').trim()
  if (ambient !== '') return { value: ambient, source: 'env', ref }
  return { value: '', source: 'none', ref }
}

/** 只描述 key 的配置状态、绝不返回值：给插件设置页与 status 用。 */
async function describeApiKey(ctx, config) {
  const ref = apiKeyRefOf(config)
  const credentials = ctx.get('credentials')
  let configured = false
  let source = 'none'
  let writable = false
  if (credentials) {
    try {
      const info = await credentials.describe(ref)
      configured = Boolean(info && info.configured)
      writable = Boolean(info && info.writable)
      if (configured) source = String(info?.source ?? 'credentials')
    } catch {
      /* 忽略：下面按回退层判断 */
    }
  }
  if (!configured && String(process.env[ref] ?? '').trim() !== '') {
    configured = true
    source = 'env'
  }
  return { ref, configured, source, writable, credentialService: credentials !== undefined }
}

class PanelError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'PanelError'
    this.code = code
    this.details = details
  }
}

/** 归一化面板地址：允许省略 /api/client，也允许带尾斜杠。 */
function normalizeBaseUrl(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return ''
  let value = text.replace(/\/+$/, '')
  if (!/\/api\/client$/.test(value)) value += '/api/client'
  return value
}

/** 面板网页根地址（去掉 /api/client 后缀），用于“点击跳转网页管理”。 */
function panelUrlOf(config) {
  const baseUrl = normalizeBaseUrl(config?.baseUrl)
  if (!baseUrl) return ''
  return baseUrl.replace(/\/api\/client$/, '')
}

function resolveEndpoint(config, apiKey) {
  const baseUrl = normalizeBaseUrl(config?.baseUrl)
  if (!baseUrl) {
    throw new PanelError('not-configured', '尚未配置面板地址：请在插件面板的“设置”里填写面板地址。')
  }
  if (!apiKey) {
    throw new PanelError(
      'missing-api-key',
      '尚未配置 Client API Key：请在插件面板的“设置”里粘贴 API Key（保存进 DSH 凭证库），或设置环境变量 PTERODACTYL_API_KEY。',
    )
  }
  const parsed = new URL(baseUrl)
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new PanelError('invalid-base-url', `面板地址协议不受支持：${parsed.protocol}`)
  }
  return { baseUrl, apiKey }
}

/** 用 node:https 发请求：不依赖 undici，且可以按配置关闭证书校验。 */
function requestJson(config, apiPath, options = {}) {
  const { method = 'GET', body, rawBody, contentType, expectText, signal, apiKey: rawApiKey } = options
  const { baseUrl, apiKey } = resolveEndpoint(config, rawApiKey)
  const base = new URL(baseUrl)
  const target = new URL(base.href.replace(/\/+$/, '') + apiPath)
  const transport = target.protocol === 'https:' ? https : http
  const timeoutMs = Number(config?.requestTimeoutMs) > 0 ? Number(config.requestTimeoutMs) : 15000
  const rejectUnauthorized = !config?.allowInsecure

  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      fn(value)
    }
    const request = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || undefined,
        path: `${target.pathname}${target.search}`,
        method,
        rejectUnauthorized,
        timeout: timeoutMs,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/vnd.pterodactyl.v1+json',
          'Content-Type': contentType ?? 'application/json',
          'User-Agent': 'dsh-pterodactyl/0.12.0',
        },
      },
      (response) => {
        const chunks = []
        let size = 0
        response.on('data', (chunk) => {
          size += chunk.length
          if (size > 4 * 1024 * 1024) {
            request.destroy(new Error('响应体过大'))
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          const status = response.statusCode ?? 0
          if (status < 200 || status >= 300) {
            let message = `面板返回 HTTP ${status}`
            try {
              const parsed = JSON.parse(text)
              const errors = parsed?.errors
              if (Array.isArray(errors) && errors.length > 0) {
                const details = errors
                  .map((item) => item?.detail ?? item?.code ?? '')
                  .filter((item) => typeof item === 'string' && item !== '')
                if (details.length > 0) message = details.join('；')
              } else if (parsed?.error) {
                message = String(parsed.error)
              }
            } catch {
              const trimmed = text.trim()
              if (trimmed) message = `${message}：${trimmed.slice(0, 300)}`
            }
            const code =
              status === 401 || status === 403
                ? 'unauthorized'
                : status === 404
                  ? 'not-found'
                  : status === 429
                    ? 'rate-limited'
                    : 'http-error'
            if (status === 429) {
              message = `面板限流（HTTP 429）：请求太频繁，等 30–60 秒再试。原始信息：${message}`
            }
            finish(reject, new PanelError(code, message, { status }))
            return
          }
          if (expectText) {
            finish(resolve, text)
            return
          }
          if (!text.trim()) {
            finish(resolve, null)
            return
          }
          try {
            finish(resolve, JSON.parse(text))
          } catch (error) {
            finish(reject, new PanelError('invalid-response', `面板响应不是合法 JSON：${error.message}`))
          }
        })
        response.on('error', (error) => finish(reject, new PanelError('network-error', error.message)))
      },
    )
    request.on('timeout', () => request.destroy(new Error(`请求超时（${timeoutMs}ms）`)))
    request.on('error', (error) => {
      const raw = String(error?.message ?? error)
      const message = /certificate|self[- ]signed/i.test(raw)
        ? `TLS 证书校验失败：${raw}。若面板使用自签名证书，请在插件设置里开启 allowInsecure。`
        : `无法连接面板：${raw}`
      finish(reject, new PanelError('network-error', message))
    })
    if (signal) {
      if (signal.aborted) {
        request.destroy(new Error('已取消'))
      } else {
        signal.addEventListener('abort', () => request.destroy(new Error('已取消')), { once: true })
      }
    }
    if (rawBody !== undefined) request.write(rawBody)
    else if (body !== undefined) request.write(JSON.stringify(body))
    request.end()
  })
}


function mapResources(payload) {
  const attributes = payload?.attributes ?? {}
  const resources = attributes.resources ?? {}
  return {
    name: typeof attributes.name === 'string' ? attributes.name : '',
    state: typeof attributes.current_state === 'string' ? attributes.current_state : 'unknown',
    suspended: attributes.is_suspended === true,
    memoryBytes: Number(resources.memory_bytes ?? 0),
    cpuPercent: Number(resources.cpu_absolute ?? 0),
    diskBytes: Number(resources.disk_bytes ?? 0),
    networkRxBytes: Number(resources.network_rx_bytes ?? 0),
    networkTxBytes: Number(resources.network_tx_bytes ?? 0),
    uptimeMs: Number(resources.uptime ?? 0),
  }
}


/**
 * 列服务器：返回 identifier / 名字 / 状态。会话没有历史时，模型靠它拿到 identifier 再用其它工具。
 * 面板列表接口的 state 可能为空（真实状态只在 resources 里），这里保持原样，不额外补查询。
 */
/** 服务器条目的统一映射，列表与授权文案共用。 */
function mapServerBrief(attributes) {
  const attributesSafe = attributes ?? {}
  const limits = attributesSafe.limits ?? {}
  return {
    identifier: String(attributesSafe.identifier ?? ''),
    name: String(attributesSafe.name ?? attributesSafe.identifier ?? ''),
    state:
      attributesSafe.is_suspended === true
        ? 'suspended'
        : typeof attributesSafe.status === 'string'
          ? attributesSafe.status
          : '',
    suspended: attributesSafe.is_suspended === true,
    memoryMb: Number(limits.memory ?? 0),
    diskMb: Number(limits.disk ?? 0),
    cpuPercent: Number(limits.cpu ?? 0),
  }
}

async function listServers(config, ctx, signal) {
  const key = await readApiKey(ctx, config)
  const payload = await requestJson(config, '?per_page=100', { signal, apiKey: key.value })
  const data = Array.isArray(payload?.data) ? payload.data : []
  return data
    .map((item) => mapServerBrief(item?.attributes))
    .filter((item) => item.identifier !== '')
}

async function serverResources(config, ctx, identifier, signal) {
  const id = String(identifier ?? '').trim()
  if (!id) throw new PanelError('invalid-argument', '缺少服务器 identifier')
  const key = await readApiKey(ctx, config)
  const payload = await requestJson(config, `/servers/${encodeURIComponent(id)}/resources`, { signal, apiKey: key.value })
  return { identifier: id, ...mapResources(payload) }
}

async function serverPower(config, ctx, identifier, signalName, signal) {
  const id = String(identifier ?? '').trim()
  if (!id) throw new PanelError('invalid-argument', '缺少服务器 identifier')
  const action = String(signalName ?? '').trim()
  if (!POWER_SIGNALS.includes(action)) {
    throw new PanelError('invalid-argument', `不支持的电源动作：${action}（可选 ${POWER_SIGNALS.join(' / ')}）`)
  }
  const key = await readApiKey(ctx, config)
  await requestJson(config, `/servers/${encodeURIComponent(id)}/power`, {
    method: 'POST',
    body: { signal: action },
    signal,
    apiKey: key.value,
  })
  return { identifier: id, signal: action, ok: true }
}

// —— 备份 ——

function mapBackup(item) {
  const attributes = item?.attributes ?? {}
  const bytes = Number(attributes.bytes ?? 0)
  return {
    uuid: String(attributes.uuid ?? ''),
    name: String(attributes.name ?? '').trim(),
    bytes,
    bytesText: formatBytes(bytes),
    createdAt: typeof attributes.created_at === 'string' ? attributes.created_at : null,
    completedAt: typeof attributes.completed_at === 'string' ? attributes.completed_at : null,
    isSuccessful: attributes.is_successful === true,
    isLocked: attributes.is_locked === true,
    checksum: typeof attributes.checksum === 'string' ? attributes.checksum : '',
  }
}

async function listBackups(config, ctx, identifier, signal) {
  const id = requireIdentifier(identifier)
  const key = await readApiKey(ctx, config)
  const payload = await requestJson(config, `/servers/${encodeURIComponent(id)}/backups`, {
    signal,
    apiKey: key.value,
  })
  const data = Array.isArray(payload?.data) ? payload.data : []
  const backups = data.map(mapBackup).filter((item) => item.uuid !== '')
  return { identifier: id, count: backups.length, backups }
}

async function createBackup(config, ctx, identifier, name, signal) {
  const id = requireIdentifier(identifier)
  const key = await readApiKey(ctx, config)
  const body = {}
  const trimmed = String(name ?? '').trim()
  if (trimmed !== '') body.name = trimmed
  const payload = await requestJson(config, `/servers/${encodeURIComponent(id)}/backups`, {
    method: 'POST',
    body,
    signal,
    apiKey: key.value,
  })
  return { identifier: id, ok: true, backup: payload?.attributes ? mapBackup(payload) : null }
}

async function deleteBackup(config, ctx, identifier, backupUuid, signal) {
  const id = requireIdentifier(identifier)
  const uuid = String(backupUuid ?? '').trim()
  if (!uuid) throw new PanelError('invalid-argument', '缺少备份 uuid')
  const key = await readApiKey(ctx, config)
  await requestJson(config, `/servers/${encodeURIComponent(id)}/backups/${encodeURIComponent(uuid)}`, {
    method: 'DELETE',
    signal,
    apiKey: key.value,
  })
  return { identifier: id, uuid, ok: true }
}


/**
 * multipart/form-data 流式上传：边读磁盘边发，内存占用与文件大小无关，
 * 因此这里的大小上限只受面板/磁盘约束，和「读文件进上下文」是两件不同的事。
 */
async function requestMultipart(config, target, options = {}) {
  const { filePath, fileName, signal, apiKey: rawApiKey, withAuth = true } = options
  const { baseUrl, apiKey } = resolveEndpoint(config, rawApiKey)

  let stat
  try {
    stat = await fs.promises.stat(filePath)
  } catch (error) {
    throw new PanelError('invalid-argument', `无法读取本机文件 ${filePath}：${error.message}`)
  }
  if (!stat.isFile()) throw new PanelError('invalid-argument', `不是普通文件：${filePath}`)
  if (stat.size > MAX_UPLOAD_BYTES) {
    throw new PanelError('invalid-argument', `文件过大：${formatBytes(stat.size)}（上限 ${formatBytes(MAX_UPLOAD_BYTES)}）`)
  }

  const base = new URL(baseUrl)
  // target 既可以是相对 API 路径，也可以是面板返回的签名直链（wings 上传地址）
  const endpoint = /^https?:\/\//i.test(String(target)) ? new URL(String(target)) : new URL(base.href.replace(/\/+$/, '') + String(target))
  const transport = endpoint.protocol === 'https:' ? https : http
  const timeoutMs = Number(config?.requestTimeoutMs) > 0 ? Number(config.requestTimeoutMs) : 15000
  const rejectUnauthorized = !config?.allowInsecure

  const boundary = `----dshpterodactyl${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`
  const safeName = String(fileName).replace(/["\r\n]/g, '_')
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="files"; filename="${safeName}"\r\n` +
      'Content-Type: application/octet-stream\r\n\r\n',
    'utf8',
  )
  // 结束分隔符前面必须是 CRLF，否则 RFC 7578 的解析器（wings/go 版）读不到 boundary，
  // 会回 400 "Failed to get multipart form data from request."。
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')

  return await new Promise((resolve, reject) => {
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      fn(value)
    }

    const request = transport.request(
      {
        protocol: endpoint.protocol,
        hostname: endpoint.hostname,
        port: endpoint.port || undefined,
        path: `${endpoint.pathname}${endpoint.search}`,
        method: 'POST',
        rejectUnauthorized,
        timeout: timeoutMs,
        headers: {
          // 签名直链不能带面板认证头：Authorization/Accept 会让 wings 直接 404。
          // 只有走面板 API 的相对路径时才需要它们。
          ...(withAuth
            ? { Authorization: `Bearer ${apiKey}`, Accept: 'application/vnd.pterodactyl.v1+json' }
            : {}),
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': String(head.length + stat.size + tail.length),
          // wings 会按 UA 分流：自定义 UA 被当成非浏览器请求，直接 400/404。
          'User-Agent': WINGS_UA,
        },
      },
      (response) => {
        const chunks = []
        let size = 0
        response.on('data', (chunk) => {
          size += chunk.length
          if (size > 4 * 1024 * 1024) {
            request.destroy(new Error('响应体过大'))
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          const status = response.statusCode ?? 0
          if (status < 200 || status >= 300) {
            const code = status === 401 || status === 403 ? 'unauthorized' : status === 404 ? 'not-found' : 'http-error'
            finish(reject, new PanelError(code, `面板返回 HTTP ${status}${text.trim() ? `：${text.trim().slice(0, 200)}` : ''}`, { status }))
            return
          }
          if (!text.trim()) {
            finish(resolve, { bytes: stat.size, response: null })
            return
          }
          try {
            finish(resolve, { bytes: stat.size, response: JSON.parse(text) })
          } catch {
            finish(resolve, { bytes: stat.size, response: null })
          }
        })
      },
    )

    request.on('error', (error) => finish(reject, new PanelError('network-error', `上传失败：${error.message}`)))
    request.on('timeout', () => request.destroy(new Error('请求超时')))

    const onAbort = () => request.destroy(new Error('已取消'))
    if (signal) {
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }

    request.write(head)
    const stream = fs.createReadStream(filePath)
    stream.on('error', (error) => request.destroy(error))
    stream.on('end', () => {
      request.write(tail)
      request.end()
    })
    stream.pipe(request, { end: false })
  })
}

// —— 文件管理 ——

// wings 的签名直链按 UA 分流，自定义 UA 会被当成非浏览器请求 404；统一用通用浏览器 UA。
const WINGS_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

const MAX_FILE_BYTES = 512 * 1024
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024
/** 上传上限：只受本机/面板承载能力约束，与「进上下文」无关。 */
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024

function requireIdentifier(identifier) {
  const id = String(identifier ?? '').trim()
  if (!id) throw new PanelError('invalid-argument', '缺少服务器 identifier')
  return id
}

/** 规范化面板内路径：补前导 /、消掉 . 与 ..，并禁止越出服务器根目录。 */
function normalizeRemotePath(raw, options = {}) {
  const allowEmpty = options.allowEmpty === true
  const text = String(raw ?? '').trim()
  if (text === '') {
    if (allowEmpty) return '/'
    throw new PanelError('invalid-argument', '缺少文件路径')
  }
  const parts = []
  for (const segment of text.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (parts.length === 0) throw new PanelError('invalid-argument', `路径不合法（越出服务器根目录）：${text}`)
      parts.pop()
      continue
    }
    parts.push(segment)
  }
  return `/${parts.join('/')}`
}

function mapFileEntry(item) {
  const attributes = item?.attributes ?? {}
  const size = Number(attributes.size ?? 0)
  return {
    name: String(attributes.name ?? ''),
    size,
    sizeText: formatBytes(size),
    isFile: attributes.is_file === true,
    isSymlink: attributes.is_symlink === true,
    mimeType: typeof attributes.mimetype === 'string' ? attributes.mimetype : '',
    mode: typeof attributes.mode === 'string' ? attributes.mode : '',
    modifiedAt: typeof attributes.modified_at === 'string' ? attributes.modified_at : null,
  }
}

async function listFiles(config, ctx, identifier, directory, signal) {
  const id = requireIdentifier(identifier)
  const dir = normalizeRemotePath(directory, { allowEmpty: true })
  const key = await readApiKey(ctx, config)
  const payload = await requestJson(
    config,
    `/servers/${encodeURIComponent(id)}/files/list?directory=${encodeURIComponent(dir)}`,
    { signal, apiKey: key.value },
  )
  const data = Array.isArray(payload?.data) ? payload.data : []
  const entries = data.map(mapFileEntry).filter((item) => item.name !== '')
  // 目录在前、文件在后，各自按名称排序
  entries.sort((left, right) => {
    if (left.isFile !== right.isFile) return left.isFile ? 1 : -1
    return left.name.localeCompare(right.name)
  })
  return { identifier: id, directory: dir, count: entries.length, entries }
}

async function readFile(config, ctx, identifier, file, signal) {
  const id = requireIdentifier(identifier)
  const path = normalizeRemotePath(file)
  const key = await readApiKey(ctx, config)
  const text = await requestJson(
    config,
    `/servers/${encodeURIComponent(id)}/files/contents?file=${encodeURIComponent(path)}`,
    { signal, apiKey: key.value, expectText: true },
  )
  const content = typeof text === 'string' ? text : ''
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > MAX_FILE_BYTES) {
    throw new PanelError(
      'invalid-argument',
      `文件 ${path} 有 ${formatBytes(bytes)}，超过读取上限 ${formatBytes(MAX_FILE_BYTES)}；请用 action=download 下载到本机查看。`,
    )
  }
  const replacementRatio = content.length === 0 ? 0 : (content.match(/\uFFFD/g) ?? []).length / content.length
  if (content.includes('\u0000') || replacementRatio > 0.01) {
    throw new PanelError(
      'invalid-argument',
      `文件 ${path} 看起来是二进制内容，无法按文本读取；请用 action=download 下载到本机。`,
    )
  }
  return { identifier: id, file: path, content, bytes }
}

/** 逐级补建目录；已存在的层级会被面板忽略，失败只在非 404 类错误时抛出。 */
async function ensureRemoteDirs(ctx, config, id, dirs, signal, apiKey) {
  let current = ''
  for (const segment of dirs) {
    current = current === '' ? segment : `${current}/${segment}`
    try {
      await requestJson(config, `/servers/${encodeURIComponent(id)}/files/create-folder`, {
        method: 'POST',
        body: { root: current.includes('/') ? current.slice(0, current.lastIndexOf('/')) : '/', name: segment },
        signal,
        apiKey,
      })
    } catch (error) {
      // 已存在通常返回 4xx（面板文案形如 "already exists"）；真正没建成时由下面的写入步骤暴露出来
      if (!(error instanceof PanelError)) throw error
    }
  }
}

async function writeFile(config, ctx, identifier, file, content, signal, options = {}) {
  const id = requireIdentifier(identifier)
  const path = normalizeRemotePath(file)
  const text = typeof content === 'string' ? content : String(content ?? '')
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > MAX_FILE_BYTES) {
    throw new PanelError('invalid-argument', `文件内容过大：${bytes} 字节（上限 ${MAX_FILE_BYTES} 字节）`)
  }
  const key = await readApiKey(ctx, config)
  const send = () =>
    requestJson(config, `/servers/${encodeURIComponent(id)}/files/write?file=${encodeURIComponent(path)}`, {
      method: 'POST',
      rawBody: text,
      contentType: 'text/plain; charset=utf-8',
      signal,
      apiKey: key.value,
    })
  // 默认先建父目录：目标目录不存在时面板会直接写失败，而 create-folder 对已存在层级是幂等的
  const dirs = path.split('/').slice(0, -1).filter((segment) => segment !== '')
  if (options.createParents !== false && dirs.length > 0) {
    await ensureRemoteDirs(ctx, config, id, dirs, signal, key.value)
  }
  await send()
  return { identifier: id, file: path, ok: true, bytes }
}

/**
 * 片段替换：自己读全文（不进上下文）、校验唯一出现、替换一次、整体写回。
 * 这样模型改局部时不需要拿到整份文件内容。
 */
async function editFile(config, ctx, identifier, file, oldText, newText, signal) {
  const id = requireIdentifier(identifier)
  const path = normalizeRemotePath(file)
  const needle = typeof oldText === 'string' ? oldText : ''
  if (needle === '') {
    throw new PanelError('invalid-argument', 'oldText 不能为空：edit 需要给一段要替换的原文。')
  }
  const target = typeof newText === 'string' ? newText : String(newText ?? '')
  const current = await readFile(config, ctx, id, path, signal)
  if (current.bytes > MAX_FILE_BYTES) {
    throw new PanelError(
      'invalid-argument',
      `文件 ${current.bytes} 字节，超过编辑上限 ${MAX_FILE_BYTES} 字节；请用 action=upload 上传替换版本。`,
    )
  }
  const occurrences = current.content.split(needle).length - 1
  if (occurrences === 0) {
    throw new PanelError('invalid-argument', `oldText 在 ${path} 中未找到，未做任何修改。`)
  }
  if (occurrences > 1) {
    throw new PanelError(
      'invalid-argument',
      `oldText 在 ${path} 中出现 ${occurrences} 次，无法确定改哪一处；请多带几行上下文使其唯一。`,
    )
  }
  // 用函数替换，避免 newText 里的 $& / $1 被当成替换模式
  const next = current.content.replace(needle, () => target)
  const written = await writeFile(config, ctx, id, path, next, signal)
  return { identifier: id, file: path, ok: true, replaced: 1, bytes: current.bytes, newBytes: written.bytes }
}


/** 授权文案里给人看的服务器称呼：优先「名字（identifier）」，查不到就退回 identifier。 */
async function serverLabel(config, ctx, identifier, signal) {
  const id = String(identifier ?? '').trim()
  if (id === '') return '（未指定服务器）'
  try {
    const servers = await listServers(config, ctx, signal)
    const hit = servers.find((item) => item.identifier === id)
    if (hit && hit.name && hit.name !== id) return `${hit.name}（${id}）`
  } catch {
    // 查名字失败不该挡住授权本身，退回 identifier。
  }
  return id
}

// 向宿主申请一次人工授权。只在真正要动手之前调用：用户点了允许才继续。
// 授权只对这一次生效（allowed-once），不会沉淀成以后自动通过的规则。
// 拒绝与取消在任何策略下都拦；只有「压根没有人能应答」这一种情况受 approvalPolicy 影响：
//   strict（默认）—— 视为拒绝；
//   fallback      —— 调用方已显式 confirm 过，退回现在的 confirm 语义放行。
async function requireHumanApproval(config, ctx, exec, description) {
  const outcome = await ctx.approval
    .request({
      agent: exec?.agent,
      toolName: exec?.name ?? 'pterodactyl',
      callId: exec?.callId,
      reason: description,
      displayReason: { en: description, 'zh-CN': description },
      signal: exec?.signal,
    })
    .catch(() => 'unavailable')
  if (outcome === 'allowed-once') return
  if (outcome === 'unavailable' && (config?.approvalPolicy ?? 'strict') === 'fallback') return
  const why =
    outcome === 'rejected'
      ? '用户拒绝了这次操作'
      : outcome === 'cancelled'
        ? '授权请求被取消'
        : '当前环境没有可用的授权应答方，无法取得人工同意（approvalPolicy=strict；要退回 confirm 语义请把它设为 fallback）'
  throw new PanelError('forbidden', `${why}，操作未执行：${description}`)
}

async function deleteFiles(config, ctx, identifier, root, names, signal) {
  const id = requireIdentifier(identifier)
  const parent = normalizeRemotePath(root, { allowEmpty: true })
  const list = (Array.isArray(names) ? names : [names])
    .map((item) => String(item ?? '').trim().replace(/\/+$/, ''))
    .filter((item) => item !== '')
  if (list.length === 0) throw new PanelError('invalid-argument', '缺少要删除的文件名')
  // 面板对「删不存在的文件」也回 204，不自己核对就会把没删成功报成成功。
  // 先列一次父目录，逐项确认存在；顺带拦住删根目录这种不可恢复的操作。
  if (list.some((item) => item === '.' || item === '..' || item.includes('/'))) {
    throw new PanelError('invalid-argument', 'names 里只放名字，不要带路径分隔符或 . / ..')
  }
  const listed = await listFiles(config, ctx, id, parent, signal)
  const present = new Set((listed.entries ?? []).map((entry) => entry.name))
  const missing = list.filter((item) => !present.has(item))
  if (missing.length > 0) {
    throw new PanelError('not-found', `以下条目在 ${parent} 中不存在，未做任何删除：${missing.join('、')}`)
  }
  const key = await readApiKey(ctx, config)
  await requestJson(config, `/servers/${encodeURIComponent(id)}/files/delete`, {
    method: 'POST',
    body: { root: parent, files: list },
    signal,
    apiKey: key.value,
  })
  return { identifier: id, root: parent, deleted: list, ok: true }
}

/**
 * 把 root 下的一个条目改名/移动到同一台服务器的另一个相对路径。
 * `to` 允许带 `../` 或子目录（wings 会按它相对 root 解析），上传落盘就靠它把文件从根目录挪走。
 */
async function renameFile(config, ctx, identifier, root, from, to, signal, apiKey) {
  const id = requireIdentifier(identifier)
  const parent = normalizeRemotePath(root, { allowEmpty: true })
  const source = String(from ?? '').trim()
  const target = String(to ?? '').trim()
  if (!source || !target) throw new PanelError('invalid-argument', '重命名需要同时给出源与目标名')
  const key = apiKey ?? (await readApiKey(ctx, config)).value
  await requestJson(config, `/servers/${encodeURIComponent(id)}/files/rename`, {
    method: 'PUT',
    body: { root: parent, files: [{ from: source, to: target }] },
    signal,
    apiKey: key,
  })
  return { identifier: id, root: parent, from: source, to: target, ok: true }
}

/**
 * 把面板给的签名直链流式写到本机文件。字节不进上下文，也不整体进内存。
 */
function requestToFile(config, url, destination, options = {}) {
  const { signal } = options
  const target = new URL(url)
  const transport = target.protocol === 'https:' ? https : http
  const timeoutMs = Number(config?.requestTimeoutMs) > 0 ? Number(config.requestTimeoutMs) : 15000
  const rejectUnauthorized = !config?.allowInsecure

  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      fn(value)
    }
    const discard = () => {
      fs.promises.rm(destination, { force: true }).catch(() => {})
    }
    const request = transport.get(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || undefined,
        path: `${target.pathname}${target.search}`,
        rejectUnauthorized,
        timeout: timeoutMs,
        // 签名直链（wings）按 UA 分流：带自定义 UA 会被当成非浏览器请求返回 404，
        // 必须用浏览器 UA 或干脆不发 UA。这里用 Node 默认 UA 会被网关拦，显式给一个通用浏览器 UA。
        headers: { 'User-Agent': WINGS_UA },
      },
      (response) => {
        const status = response.statusCode ?? 0
        if (status < 200 || status >= 300) {
          response.resume()
          finish(reject, new PanelError('http-error', `下载失败：下载链接返回 HTTP ${status}`, { status }))
          return
        }
        const out = fs.createWriteStream(destination)
        let size = 0
        response.on('data', (chunk) => {
          size += chunk.length
          if (size > MAX_DOWNLOAD_BYTES) {
            request.destroy(new Error('文件过大'))
            out.destroy()
            discard()
            finish(
              reject,
              new PanelError('invalid-argument', `文件超过下载上限 ${MAX_DOWNLOAD_BYTES} 字节。`),
            )
          }
        })
        response.on('error', (error) => {
          out.destroy()
          discard()
          finish(reject, new PanelError('network-error', `下载中断：${error.message}`))
        })
        out.on('error', (error) => {
          discard()
          finish(reject, new PanelError('io-error', `无法写入 ${destination}：${error.message}`))
        })
        out.on('finish', () => finish(resolve, size))
        response.pipe(out)
      },
    )
    request.on('timeout', () => request.destroy(new Error(`下载超时（${timeoutMs}ms 无数据）`)))
    request.on('error', (error) => {
      discard()
      const raw = String(error?.message ?? error)
      const message = /certificate|self[- ]signed/i.test(raw)
        ? `TLS 证书校验失败：${raw}。若面板使用自签名证书，请在插件设置里开启 allowInsecure。`
        : `下载失败：${raw}`
      finish(reject, new PanelError('network-error', message))
    })
    if (signal) {
      if (signal.aborted) {
        request.destroy(new Error('已取消'))
      } else {
        signal.addEventListener('abort', () => request.destroy(new Error('已取消')), { once: true })
      }
    }
  })
}

/** 先把面板文件下到本机：默认 ~/Downloads，targetPath 可指定文件或目录。 */
async function downloadFile(config, ctx, identifier, file, targetPath, signal) {
  const id = requireIdentifier(identifier)
  const remotePath = normalizeRemotePath(file)
  const key = await readApiKey(ctx, config)
  const payload = await requestJson(
    config,
    `/servers/${encodeURIComponent(id)}/files/download?file=${encodeURIComponent(remotePath)}`,
    { signal, apiKey: key.value },
  )
  const url = String(payload?.attributes?.url ?? '')
  if (!url) throw new PanelError('invalid-response', '面板没有返回下载地址。')

  const name = path.posix.basename(remotePath) || 'download.bin'
  const rawTarget = String(targetPath ?? '').trim()
  // 注意：path.resolve 会吃掉尾斜杠，所以要在解析前判断“调用方是不是想给目录”
  const looksLikeDir = rawTarget === '' || /[\\/]$/.test(rawTarget)
  let destination = rawTarget === '' ? path.join(os.homedir(), 'Downloads', name) : path.resolve(rawTarget)
  let isDir = false
  try {
    isDir = fs.existsSync(destination) && fs.statSync(destination).isDirectory()
  } catch {
    isDir = false
  }
  if (looksLikeDir || isDir) destination = path.join(destination, name)
  await fs.promises.mkdir(path.dirname(destination), { recursive: true })
  const overwritten = fs.existsSync(destination)

  const bytes = await requestToFile(config, url, destination, { signal })
  return {
    identifier: id,
    file: remotePath,
    targetPath: destination,
    bytes,
    bytesText: formatBytes(bytes),
    overwritten,
  }
}

async function uploadFile(config, ctx, identifier, directory, sourcePath, fileName, signal) {
  const id = requireIdentifier(identifier)
  const dir = normalizeRemotePath(directory, { allowEmpty: true })
  const provided = String(sourcePath ?? '').trim()
  if (!provided) throw new PanelError('invalid-argument', '缺少 sourcePath（本机上要上传的文件路径）')
  const local = path.resolve(provided)
  const requested = String(fileName ?? '').trim().replace(/[\\/]/g, '_')
  const name = requested || path.basename(local)
  if (!name) throw new PanelError('invalid-argument', '无法确定上传后的文件名')
  const key = await readApiKey(ctx, config)
  // Pterodactyl 的上传是两段式：客户端 API 先返回 wings 的签名上传地址，再 POST 文件到该地址。
  // 但签名 URL 里的 token 并不携带目标目录（payload 只有 server_uuid/scope/exp），wings 一律把
  // 文件写进服务器根目录；把 directory 同时塞进 query 和表单字段反而会被判成参数冲突回 500。
  // 所以这里固定传到根目录，再 rename 到目标目录——只在上传动作和 rename 动作之间暴露文件名。
  const signed = await requestJson(
    config,
    `/servers/${encodeURIComponent(id)}/files/upload?directory=%2F`,
    { signal, apiKey: key.value },
  )
  const uploadUrl = String(signed?.attributes?.url ?? '')
  if (!uploadUrl) throw new PanelError('invalid-response', '面板没有返回上传地址。')
  const result = await requestMultipart(config, uploadUrl, {
    filePath: local,
    fileName: name,
    apiKey: key.value,
    signal,
    withAuth: false,
  })
  if (dir !== '/') {
    try {
      await renameFile(config, ctx, id, '/', name, `${dir.slice(1)}/${name}`, signal, key.value)
    } catch (error) {
      // 移动失败时把根目录下的中间产物删掉，避免在服务器根目录留下半成品。
      await deleteFiles(config, ctx, id, '/', [name], signal).catch(() => {})
      throw error
    }
  }
  return {
    identifier: id,
    directory: dir,
    path: dir === '/' ? `/${name}` : `${dir}/${name}`,
    name,
    sourcePath: local,
    bytes: result.bytes,
    bytesText: formatBytes(result.bytes),
  }
}

/** 设置页与 Web 载体共用同一套错误形状。 */
function toRpcError(error) {
  return {
    ok: false,
    error: {
      code: error instanceof PanelError ? error.code : 'internal-error',
      message: error instanceof Error ? error.message : String(error),
      details: error instanceof PanelError ? error.details : {},
    },
  }
}

/** 设置页走同源 fetch 的固定前缀。 */
const CHANNEL = '/dsh-pterodactyl'

function formatBytes(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let index = 0
  let scaled = value
  while (scaled >= 1024 && index < units.length - 1) {
    scaled /= 1024
    index += 1
  }
  return `${scaled.toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(Number(ms) / 1000))
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  if (days > 0) return `${days} 天 ${hours} 小时`
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`
  return `${minutes} 分钟`
}

// —— WebSocket 控制台 ——
//
// Pterodactyl 的控制台不是普通 HTTP：先 GET /servers/{id}/websocket 换一张
// 一次性票据，再连 wings 返回的 wss 地址，用 auth 事件完成握手，之后才是
// send command / console output 事件流。工具调用是无状态的，所以每次调用
// 开一条短连接：连上 → 认证 → 发命令 → 收集 waitMs 毫秒的输出 → 关闭。

const ANSI_CSI = /\u001b\[[0-9;?]*[A-Za-z]/g
const ANSI_OSC = /\u001b\][^\u0007]*\u0007/g
const ANSI_OTHER = /\u001b[@-Z\\-_]/g
const ANSI_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g
const CONSOLE_MAX_LINES = 120
const CONSOLE_LINE_MAX = 2000
const CONSOLE_ACTIVE_STATES = new Set(['running', 'starting'])

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const CONSOLE_USER_AGENT = 'dsh-pterodactyl/0.14.1'

/** 面板 origin：wings 的 CORS 只放行这个来源，WebSocket 握手必须带上。 */
function consoleOrigin(config) {
  try {
    return new URL(normalizeBaseUrl(config?.baseUrl)).origin
  } catch {
    return ''
  }
}

function encodeClientFrame(payload, opcode) {
  const data = Buffer.from(payload)
  const mask = crypto.randomBytes(4)
  const length = data.length
  let header
  if (length < 126) {
    header = Buffer.alloc(2)
    header[1] = 0x80 | length
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[1] = 0x80 | 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  header[0] = 0x80 | opcode
  const masked = Buffer.alloc(length)
  for (let index = 0; index < length; index += 1) masked[index] = data[index] ^ mask[index % 4]
  return Buffer.concat([header, mask, masked])
}

function decodeServerFrame(buffer) {
  if (buffer.length < 2) return null
  const first = buffer[0]
  const second = buffer[1]
  const fin = (first & 0x80) !== 0
  const opcode = first & 0x0f
  const masked = (second & 0x80) !== 0
  let length = second & 0x7f
  let offset = 2
  if (length === 126) {
    if (buffer.length < 4) return null
    length = buffer.readUInt16BE(2)
    offset = 4
  } else if (length === 127) {
    if (buffer.length < 10) return null
    length = Number(buffer.readBigUInt64BE(2))
    offset = 10
  }
  const maskLength = masked ? 4 : 0
  if (buffer.length < offset + maskLength + length) return null
  let payload = buffer.subarray(offset + maskLength, offset + maskLength + length)
  if (masked) {
    const mask = buffer.subarray(offset, offset + 4)
    const out = Buffer.alloc(length)
    for (let index = 0; index < length; index += 1) out[index] = payload[index] ^ mask[index % 4]
    payload = out
  }
  return { fin, opcode, payload, size: offset + maskLength + length }
}

/**
 * 最小 WebSocket 客户端。
 *
 * 不用运行时自带的全局 WebSocket，是因为它不能设请求头：wings 的握手按 CORS
 * 校验 Origin（只放行面板自己的域名），自签名面板还需要关掉证书校验，这两件
 * 事全局 API 都做不到。这里只实现控制台需要的部分：文本帧、分片、ping/pong、close。
 */
class ConsoleSocket {
  constructor(url, options = {}) {
    this.url = new URL(url)
    this.options = options
    this.socket = null
    this.buffer = Buffer.alloc(0)
    this.fragments = []
    this.closed = false
    this.listeners = new Map()
  }

  on(event, listener) {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
    return this
  }

  emit(event, ...args) {
    for (const listener of this.listeners.get(event) ?? []) {
      try {
        listener(...args)
      } catch {
        /* ignore */
      }
    }
  }

  connect() {
    const secure = this.url.protocol === 'wss:'
    const transport = secure ? https : http
    const key = crypto.randomBytes(16).toString('base64')
    const headers = {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': key,
      'User-Agent': this.options.userAgent ?? CONSOLE_USER_AGENT,
    }
    if (this.options.origin) headers.Origin = this.options.origin

    let request
    try {
      request = transport.request({
        hostname: this.url.hostname,
        port: this.url.port || (secure ? 443 : 80),
        path: this.url.pathname + this.url.search,
        method: 'GET',
        headers,
        rejectUnauthorized: this.options.rejectUnauthorized !== false,
        timeout: 15000,
      })
    } catch (error) {
      this.emit('error', error)
      return
    }

    request.on('upgrade', (response, socket, head) => {
      const expected = crypto.createHash('sha1').update(key + WS_GUID).digest('base64')
      if (response.headers['sec-websocket-accept'] !== expected) {
        try {
          socket.destroy()
        } catch {
          /* ignore */
        }
        this.emit('error', new Error('WebSocket 握手响应校验失败。'))
        return
      }
      this.socket = socket
      try {
        socket.setNoDelay?.(true)
      } catch {
        /* ignore */
      }
      socket.on('data', (chunk) => this.consume(chunk))
      socket.on('close', () => this.markClosed())
      socket.on('error', (error) => this.emit('error', error))
      this.emit('open')
      if (head && head.length > 0) this.consume(head)
    })

    request.on('response', (response) => {
      let body = ''
      response.setEncoding?.('utf8')
      response.on('data', (chunk) => {
        body += chunk
      })
      response.on('end', () => {
        const detail = body ? ` ${body.slice(0, 200)}` : ''
        this.emit('error', new Error(`WebSocket 握手被拒绝：HTTP ${response.statusCode}${detail}`))
      })
    })

    request.on('timeout', () => {
      request.destroy(new Error('WebSocket 握手超时。'))
    })
    request.on('error', (error) => this.emit('error', error))
    request.end()
  }

  consume(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      const frame = decodeServerFrame(this.buffer)
      if (frame === null) return
      this.buffer = this.buffer.subarray(frame.size)
      this.handle(frame)
    }
  }

  handle(frame) {
    if (frame.opcode === 0x0) {
      this.fragments.push(frame.payload)
      if (frame.fin) {
        const full = Buffer.concat(this.fragments)
        this.fragments = []
        this.emit('message', full.toString('utf8'))
      }
      return
    }
    if (frame.opcode === 0x1 || frame.opcode === 0x2) {
      if (frame.fin) {
        this.emit('message', frame.payload.toString('utf8'))
      } else {
        this.fragments = [frame.payload]
      }
      return
    }
    if (frame.opcode === 0x9) {
      this.write(frame.payload, 0xa)
      return
    }
    if (frame.opcode === 0x8) {
      this.markClosed()
      this.write(Buffer.alloc(0), 0x8)
      try {
        this.socket?.end()
      } catch {
        /* ignore */
      }
    }
  }

  write(payload, opcode) {
    if (!this.socket || this.closed) return
    try {
      this.socket.write(encodeClientFrame(payload, opcode))
    } catch {
      /* ignore */
    }
  }

  send(text) {
    this.write(text, 0x1)
  }

  markClosed() {
    if (this.closed) return
    this.closed = true
    this.emit('close')
  }

  close() {
    if (this.closed) return
    this.markClosed()
    try {
      this.socket?.destroy()
    } catch {
      /* ignore */
    }
  }
}


/**
 * 剥掉终端控制序列。wings 转发的是容器 stdout，Minecraft 等服务会输出
 * CSI 颜色码、光标/括号模式切换（如 ESC[?2004h）和回车刷新行。
 */
function stripAnsi(raw) {
  let text = String(raw ?? '')
    .replace(ANSI_OSC, '')
    .replace(ANSI_CSI, '')
    .replace(ANSI_OTHER, '')
  // 回车覆盖语义：终端里 \r 之后的内容会盖掉本行前面的内容
  const lastReturn = text.lastIndexOf('\r')
  if (lastReturn >= 0) text = text.slice(lastReturn + 1)
  return text.replace(ANSI_CONTROL, '').trim()
}

/** 向 Client API 换一张控制台连接票（wss 地址 + 一次性 token）。 */
async function consoleTicket(config, ctx, identifier, signal) {
  const id = requireIdentifier(identifier)
  const key = await readApiKey(ctx, config)
  const payload = await requestJson(config, `/servers/${encodeURIComponent(id)}/websocket`, {
    signal,
    apiKey: key.value,
  })
  const data = payload?.data ?? payload
  const socket = typeof data?.socket === 'string' ? data.socket : ''
  const token = typeof data?.token === 'string' ? data.token : ''
  if (socket === '' || token === '') {
    throw new PanelError('invalid-response', '面板没有返回控制台地址或令牌（服务器可能不在运行中）。')
  }
  return { id, socket, token }
}

function consoleUrl(socket, token) {
  const base = String(socket)
  const separator = base.includes('?') ? '&' : '?'
  return `${base}${separator}token=${encodeURIComponent(token)}`
}

/**
 * 开短连接跑一段控制台交互。
 * 发送 command（可为空，仅收集输出）后收集 waitMs 毫秒的返回。
 */
async function runConsole(config, ctx, identifier, options) {
  const { command = null, waitMs, signal } = options ?? {}
  const ticket = await consoleTicket(config, ctx, identifier, signal)
  const wait = Math.min(Math.max(Number(waitMs) || 3000, 500), 60000)

  return await new Promise((resolve, reject) => {
    const lines = []
    let state = null
    let settled = false
    let truncated = false
    let collectTimer = null
    let connectTimer = null

    const client = new ConsoleSocket(consoleUrl(ticket.socket, ticket.token), {
      origin: consoleOrigin(config),
      rejectUnauthorized: config?.allowInsecure !== true,
      userAgent: CONSOLE_USER_AGENT,
    })

    const cleanup = () => {
      if (collectTimer !== null) clearTimeout(collectTimer)
      if (connectTimer !== null) clearTimeout(connectTimer)
      collectTimer = null
      connectTimer = null
      if (signal) {
        try {
          signal.removeEventListener('abort', onAbort)
        } catch {
          /* ignore */
        }
      }
      client.close()
    }

    const finish = (error, extra) => {
      if (settled) return
      settled = true
      cleanup()
      if (error) {
        reject(error)
        return
      }
      resolve({
        server: ticket.id,
        // schema 只允许 string：没收到 status 事件时留空串，而不是 null
        command: command ?? '',
        state: state ?? '',
        lines,
        lineCount: lines.length,
        waitedMs: wait,
        truncated,
        ...(extra ?? {}),
      })
    }

    function onAbort() {
      finish(new PanelError('aborted', '控制台连接被取消。'))
    }

    if (signal?.aborted) {
      finish(new PanelError('aborted', '控制台连接被取消。'))
      return
    }
    if (signal) {
      try {
        signal.addEventListener('abort', onAbort, { once: true })
      } catch {
        /* ignore */
      }
    }

    connectTimer = setTimeout(() => {
      finish(new PanelError('console-timeout', '连接服务器控制台超时（10 秒）。'))
    }, 10000)

    const pushLine = (raw) => {
      const line = stripAnsi(raw).slice(0, CONSOLE_LINE_MAX)
      if (lines.length >= CONSOLE_MAX_LINES) {
        truncated = true
        lines.shift()
      }
      lines.push(line)
    }

    client.on('open', () => {
      client.send(JSON.stringify({ event: 'auth', args: [ticket.token] }))
    })

    client.on('message', (text) => {
      let payload
      try {
        payload = JSON.parse(text)
      } catch {
        return
      }
      const name = String(payload?.event ?? '')
      const args = Array.isArray(payload?.args) ? payload.args : []

      if (name === 'auth success') {
        if (connectTimer !== null) {
          clearTimeout(connectTimer)
          connectTimer = null
        }
        if (typeof command === 'string' && command !== '') {
          client.send(JSON.stringify({ event: 'send command', args: [command] }))
        }
        collectTimer = setTimeout(() => finish(null), wait)
        return
      }
      if (name === 'status') {
        state = stripAnsi(args[0] ?? '').trim()
        return
      }
      if (name === 'console output') {
        pushLine(args[0] ?? '')
        return
      }
      if (name === 'auth error' || name === 'jwt error' || name === 'daemon error') {
        finish(new PanelError('console-auth', '控制台认证失败：面板拒绝了本次连接（票据过期或服务器不可用）。'))
        return
      }
      if (name === 'ping') {
        client.send(JSON.stringify({ event: 'pong', args: [] }))
      }
    })

    client.on('error', (error) => {
      finish(new PanelError('console-error', `控制台连接出错：${error?.message ?? error}`))
    })

    client.on('close', () => {
      if (settled) return
      finish(null)
    })

    client.connect()
  })
}

function consoleTool(config, ctx) {
  return {
    name: 'pterodactyl_console',
    description:
      '向服务器的 WebSocket 控制台发送一条命令并取回随后的输出（例如 Minecraft 的 list、say、tps、whitelist）。命令会真实执行，stop / kill / op 之类不可逆操作请先确认。',
    parameters: {
      type: 'object',
      properties: {
        server: { type: 'string', description: '服务器 identifier（短 ID）。' },
        command: { type: 'string', description: '要执行的命令，不带前导斜杠，例如 list、say hello、tps。' },
        waitMs: { type: 'number', description: '收集输出的时长（毫秒），默认 3000，范围 500-60000。这只是命令发出后等回显的窗口，不是日志；要看日志请读 /logs/latest.log。' },
        confirm: {
          type: 'boolean',
          description: '发送 stop / kill / op / deop / ban 之类危险命令时必须显式设为 true。',
        },
      },
      required: ['server', 'command'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          server: { type: 'string' },
          command: { type: 'string' },
          state: { type: 'string' },
          lines: { type: 'array', items: { type: 'string' } },
          lineCount: { type: 'number' },
          waitedMs: { type: 'number' },
          truncated: { type: 'boolean' },
          note: { type: 'string' },
        },
        required: ['server', 'command'],
      },
      render(args, value) {
        const result = value ?? {}
        const head = `服务器 ${result.server ?? args?.server ?? ''}`
        const lines = Array.isArray(result.lines) ? result.lines : []
        const prefix = `${head} 执行命令 "${result.command ?? ''}"，收到 ${lines.length} 行控制台输出`
        const body = lines.length > 0 ? lines.join('\n') : '（这段时间没有控制台输出）'
        const truncatedNote = result.truncated ? '\n（输出过多，只保留最后若干行）' : ''
        const note = result.note ? `\n注意：${result.note}` : ''
        return [{ type: 'text', text: `${prefix}：\n${body}${truncatedNote}${note}` }]
      },
    },
    async execute(args, exec) {
      const server = args?.server
      const command = String(args?.command ?? '').trim().replace(/^\/+/, '')
      if (command === '') throw new Error('需要提供 command（要发送的控制台命令）。')
      if (command.includes('\n') || command.includes('\r')) {
        throw new Error('一次只能发送一条命令：command 里不能包含换行。')
      }
      const verb = command.split(/\s+/)[0].toLowerCase()
      if (DANGEROUS_COMMANDS.has(verb)) {
        if (args?.confirm !== true) {
          throw new Error(
            `「${verb}」属于危险操作（会停机、改权限或封禁玩家）。确认要执行就把 confirm 设为 true 再调用。`,
          )
        }
        const label = await serverLabel(config, ctx, server, exec?.signal)
        await requireHumanApproval(
          config,
          ctx,
          { ...exec, name: 'pterodactyl_console' },
          `在 ${label} 的控制台执行危险命令「${command}」`,
        )
      }
      const result = await runConsole(config, ctx, server, { command, waitMs: args?.waitMs, signal: exec?.signal })
      const idle = result.state !== '' && !CONSOLE_ACTIVE_STATES.has(result.state)
      return { ...result, ...(idle ? { note: `服务器当前状态是 ${result.state}，命令可能没有真正执行。` } : {}) }
    },
    // 宽于 waitMs 上限（60 秒），留出建连与清理的时间；否则 60 秒的窗口会被工具超时先掐断。
    timeoutMs: 75000,
  }
}

function serverTool(config, ctx) {
  return {
    name: 'pterodactyl_servers',
    description:
      '读取 Pterodactyl 面板上的服务器。不传 server 时列出全部服务器（identifier、名字、状态、限额）——不确定 identifier 时先用这个；传 server 时返回该服务器的实时资源用量（状态、CPU、内存、磁盘、网络、运行时长）。',
    parameters: {
      type: 'object',
      properties: {
        server: { type: 'string', description: '服务器 identifier；省略则列出全部服务器。' },
      },
      // 不能写 additionalProperties: false —— 省略 server 时必须传空对象 {}，
      // 而空对象在严格校验下会被判成“缺少 server”；这个参数本来就可选。
      additionalProperties: true,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          count: { type: 'number' },
          servers: { type: 'array', items: { type: 'object' } },
          identifier: { type: 'string' },
          name: { type: 'string' },
          state: { type: 'string' },
          cpuPercent: { type: 'number' },
          memoryBytes: { type: 'number' },
          diskBytes: { type: 'number' },
          networkRxBytes: { type: 'number' },
          networkTxBytes: { type: 'number' },
          uptimeMs: { type: 'number' },
        },
      },
      render(args, value) {
        const result = value ?? {}
        const servers = Array.isArray(result.servers) ? result.servers : null
        if (servers) {
          if (servers.length === 0) return [{ type: 'text', text: '面板上没有可访问的服务器。' }]
          const lines = [`共 ${servers.length} 台服务器：`]
          for (const server of servers) {
            const limits = server.memoryMb > 0 ? ` · 限额 ${server.memoryMb} MB 内存 / ${server.diskMb} MB 磁盘 / ${server.cpuPercent}% CPU` : ''
            lines.push(`- ${server.name}（${server.identifier}）：${server.state || 'unknown'}${limits}`)
          }
          return [{ type: 'text', text: lines.join('\n') }]
        }
        const memoryMb = Number(result.memoryBytes ?? 0) / 1024 / 1024
        const diskMb = Number(result.diskBytes ?? 0) / 1024 / 1024
        return [
          {
            type: 'text',
            text: [
              `服务器 ${result.identifier ?? ''}${result.name ? `（${result.name}）` : ''} 当前状态：${result.state ?? 'unknown'}`,
              `CPU ${Number(result.cpuPercent ?? 0).toFixed(1)}% · 内存 ${memoryMb.toFixed(1)} MB · 磁盘 ${diskMb.toFixed(1)} MB`,
              `网络 ↓${formatBytes(result.networkRxBytes)} ↑${formatBytes(result.networkTxBytes)} · 已运行 ${formatDuration(result.uptimeMs)}`,
            ].join('\n'),
          },
        ]
      },
    },
    async execute(args, exec) {
      const id = String(args?.server ?? '').trim()
      if (id === '') {
        const servers = await listServers(config, ctx, exec?.signal)
        // 必须带 count：render 靠它区分“列表”与“单台用量”两种返回形态
        return { count: servers.length, servers }
      }
      return await serverResources(config, ctx, id, exec?.signal)
    },
    timeoutMs: 60000,
  }
}

function powerTool(config, ctx) {
  return {
    name: 'pterodactyl_power',
    description: '对 Pterodactyl 面板上的服务器执行电源操作：start（启动）、stop（停机）、restart（重启）、kill（强制终止）。',
    parameters: {
      type: 'object',
      properties: {
        server: { type: 'string', description: '服务器 identifier。' },
        signal: { type: 'string', enum: POWER_SIGNALS, description: '电源动作。' },
        confirm: {
          type: 'boolean',
          description: 'signal 为 stop 或 kill 时必须显式设为 true（会立即中断服务器）。',
        },
      },
      required: ['server', 'signal'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          identifier: { type: 'string' },
          signal: { type: 'string' },
          ok: { type: 'boolean' },
        },
      },
      render(args, value) {
        const result = value ?? {}
        const labels = {
          start: '已发送启动信号',
          stop: '已发送停机信号',
          restart: '已发送重启信号',
          kill: '已发送强制终止信号',
        }
        return [
          {
            type: 'text',
            text: `服务器 ${result.identifier ?? args?.server ?? ''}：${labels[result.signal] ?? '已发送电源信号'}`,
          },
        ]
      },
    },
    async execute(args, exec) {
      const signal = String(args?.signal ?? '')
      if ((signal === 'stop' || signal === 'kill') && args?.confirm !== true) {
        throw new Error(`信号 ${signal} 会立即中断服务器，确认要执行就把 confirm 设为 true 再调用。`)
      }
      if (signal === 'stop' || signal === 'kill') {
        await requireHumanApproval(
          config,
          ctx,
          { ...exec, name: 'pterodactyl_power' },
          `对 ${await serverLabel(config, ctx, args?.server, exec?.signal)} 发送 ${signal} 信号，服务器会立刻${signal === 'kill' ? '被强制终止' : '停机'}`,
        )
      }
      return serverPower(config, ctx, args?.server, signal)
    },
    timeoutMs: 60000,
  }
}

function backupsTool(config, ctx) {
  return {
    name: 'pterodactyl_backups',
    description:
      '管理 Pterodactyl 服务器的备份。action=list 列出备份；action=create 创建新备份（可选 name）；action=delete 删除指定备份（需 backup uuid）。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'create', 'delete'],
          description: 'list 列出备份；create 创建；delete 删除。',
        },
        server: { type: 'string', description: '服务器 identifier。' },
        backup: { type: 'string', description: '备份 uuid（action=delete 时必填）。' },
        name: { type: 'string', description: '创建备份时的名称（可选）。' },
      },
      required: ['action', 'server'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          action: { type: 'string' },
          identifier: { type: 'string' },
          count: { type: 'number' },
          backups: { type: 'array', items: { type: 'object' } },
          uuid: { type: 'string' },
          ok: { type: 'boolean' },
        },
      },
      render(args, value) {
        const result = value ?? {}
        const identifier = result.identifier ?? args?.server ?? ''
        if (result.action === 'list') {
          const backups = Array.isArray(result.backups) ? result.backups : []
          if (backups.length === 0) return [{ type: 'text', text: `服务器 ${identifier} 目前没有备份。` }]
          const lines = [`服务器 ${identifier} 共 ${backups.length} 个备份：`]
          for (const backup of backups) {
            const state = backup.isSuccessful ? '完成' : '进行中/失败'
            const lock = backup.isLocked ? ' · 已锁定' : ''
            lines.push(`- ${backup.name || '(未命名)'}（${backup.uuid}）：${backup.bytesText} · ${state}${lock} · ${backup.createdAt ?? ''}`)
          }
          return [{ type: 'text', text: lines.join('\n') }]
        }
        if (result.action === 'create') {
          const backup = result.backup
          if (!backup) return [{ type: 'text', text: `已请求创建备份（服务器 ${identifier}），面板正在生成。` }]
          return [
            {
              type: 'text',
              text: `已在服务器 ${identifier} 创建备份「${backup.name || '(未命名)'}」（${backup.uuid}）。备份在后台生成，可用 list 查看进度。`,
            },
          ]
        }
        return [{ type: 'text', text: `已删除服务器 ${identifier} 的备份 ${result.uuid ?? args?.backup ?? ''}。` }]
      },
    },
    async execute(args, exec) {
      const action = String(args?.action ?? '')
      if (action === 'list') {
        return { action, ...(await listBackups(config, ctx, args?.server, exec?.signal)) }
      }
      if (action === 'create') {
        return { action, ...(await createBackup(config, ctx, args?.server, args?.name, exec?.signal)) }
      }
      if (action === 'delete') {
        const listed = await listBackups(config, ctx, args?.server, exec?.signal)
        const target = (listed.backups ?? []).find((item) => item.uuid === args?.backup)
        const label = target ? `「${target.name || '(未命名)'}」（${target.uuid}，${target.bytesText}）` : `备份 ${args?.backup ?? ''}`
        await requireHumanApproval(
          config,
          ctx,
          { ...exec, name: 'pterodactyl_backups' },
          `删除 ${await serverLabel(config, ctx, args?.server, exec?.signal)} 的${label}，删除后无法恢复`,
        )
        return { action, ...(await deleteBackup(config, ctx, args?.server, args?.backup, exec?.signal)) }
      }
      throw new Error(`不支持的 action：${action}（可选 list / create / delete）`)
    },
    timeoutMs: 300000,
  }
}

// 文件操作按 action 拆成独立工具：只展开用到的那一份参数说明，而不是每次全背。
const FILE_OP_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string' },
    identifier: { type: 'string' },
    directory: { type: 'string' },
    count: { type: 'number' },
    entries: { type: 'array', items: { type: 'object' } },
    file: { type: 'string' },
    content: { type: 'string' },
    name: { type: 'string' },
    sourcePath: { type: 'string' },
    bytes: { type: 'number' },
    bytesText: { type: 'string' },
    path: { type: 'string' },
    root: { type: 'string' },
    deleted: { type: 'array', items: { type: 'string' } },
    overwritten: { type: 'boolean' },
    ok: { type: 'boolean' },
  },
}

const FILES_SERVER = { type: 'string', description: '服务器 identifier。' }

/** 文件操作各成一个工具；execute 统一注入 action 后交给 filesToolHandler。 */
const FILE_ACTIONS = [
  { name: 'pterodactyl_files_list', action: 'list', description: '列出 Pterodactyl 服务器上某个目录的内容。',
    properties: { server: FILES_SERVER, path: { type: 'string', description: '目录路径，默认 /。' } }, required: ['server'] },
  { name: 'pterodactyl_files_read', action: 'read', description: '读取服务器上的文本文件内容。',
    properties: { server: FILES_SERVER, path: { type: 'string', description: '文件完整路径。' } }, required: ['server', 'path'] },
  { name: 'pterodactyl_files_write', action: 'write', description: '写入服务器上的文本文件。给 oldText 就是局部替换（Host 自己读全文再写回，无需提供全文）；不给 oldText 用 content 整体覆盖。父目录不存在会自动创建。',
    properties: {
      server: FILES_SERVER,
      path: { type: 'string', description: '文件完整路径。' },
      content: { type: 'string', description: '整体覆盖时的完整文本内容（不传 oldText 时必填）。' },
      oldText: { type: 'string', description: '局部替换模式：要被替换的原文片段，必须在文件中唯一出现。' },
      newText: { type: 'string', description: '局部替换模式：替换成的新内容；空串表示删除该片段。' },
    }, required: ['server', 'path'] },
  { name: 'pterodactyl_files_upload', action: 'upload', description: '上传本机文件到服务器（字节不经过上下文）。',
    properties: { server: FILES_SERVER, path: { type: 'string', description: '目标目录，默认 /。' }, sourcePath: { type: 'string', description: '本机文件路径（绝对路径，或相对当前工作目录）。' }, fileName: { type: 'string', description: '可选：上传后在面板上使用的文件名（默认取本机文件名）。' } }, required: ['server', 'sourcePath'] },
  { name: 'pterodactyl_files_download', action: 'download', description: '把服务器上的文件下载到本机（字节不经过上下文）。',
    properties: { server: FILES_SERVER, path: { type: 'string', description: '服务器上的文件完整路径。' }, targetPath: { type: 'string', description: '本机目标文件或已存在目录；省略则存到 ~/Downloads/<文件名>。' } }, required: ['server', 'path'] },
  { name: 'pterodactyl_files_delete', action: 'delete', description: '删除服务器上的文件或目录（不可恢复）。',
    properties: { server: FILES_SERVER, path: { type: 'string', description: '父目录路径，默认 /。' }, names: { type: 'array', items: { type: 'string' }, description: '要删除的名称列表（只写名字，不带路径）。' }, confirm: { type: 'boolean', description: '删除不可恢复。要真正执行必须显式传 true；不传则只列出将要删除、实际不删。' } }, required: ['server', 'names'] },
]

function fileActionTool(config, ctx, spec) {
  return {
    name: spec.name,
    description: spec.description,
    parameters: {
      type: 'object',
      properties: spec.properties,
      required: spec.required,
      additionalProperties: false,
    },
    output: {
      schema: FILE_OP_OUTPUT_SCHEMA,
      render: filesRender,
    },
    async execute(args, exec) {
      return filesToolHandler(config, ctx, { ...args, action: spec.action }, exec)
    },
    timeoutMs: 300000,
  }
}

function filesTools(config, ctx) {
  return FILE_ACTIONS.map((spec) => fileActionTool(config, ctx, spec))
}

// —— 以下为原 filesTool 的 render / execute 主体，改为公共函数复用 ——

function filesRender(args, value) {
    const result = value ?? {}
    const identifier = result.identifier ?? args?.server ?? ''
    if (result.action === 'list') {
      const entries = Array.isArray(result.entries) ? result.entries : []
      if (entries.length === 0) return [{ type: 'text', text: `目录 ${result.directory ?? '/'} 为空。` }]
      const lines = [`服务器 ${identifier} 的 ${result.directory ?? '/'} 共 ${entries.length} 项：`]
      for (const entry of entries) {
        lines.push(`- ${entry.isFile ? '' : '[目录] '}${entry.name}${entry.isFile ? ` · ${entry.sizeText}` : ''}`)
      }
      return [{ type: 'text', text: lines.join('\n') }]
    }
    if (result.action === 'read') {
      return [{ type: 'text', text: `文件 ${result.file ?? ''}（${result.bytes ?? 0} 字节）：\n${result.content ?? ''}` }]
    }
    if (result.action === 'write') {
      if (typeof result.replaced === 'number') {
        return [
          {
            type: 'text',
            text: `已编辑 ${result.file ?? ''}：替换 ${result.replaced} 处（${result.bytes ?? 0} → ${result.newBytes ?? 0} 字节）。`,
          },
        ]
      }
      return [{ type: 'text', text: `已写入 ${result.file ?? ''}（${result.bytes ?? 0} 字节）。` }]
    }
    if (result.action === 'upload') {
      return [
        {
          type: 'text',
          text: `已上传本机文件 ${result.sourcePath ?? ''} → 服务器 ${identifier} 的 ${result.path ?? ''}（${result.bytesText ?? result.bytes ?? 0}）。`,
        },
      ]
    }
    if (result.action === 'download') {
      return [
        {
          type: 'text',
          text: `已下载 ${result.file ?? ''} → 本机 ${result.targetPath ?? ''}（${result.bytesText ?? result.bytes ?? 0}）${result.overwritten ? '（覆盖了同名文件）' : ''}。`,
        },
      ]
    }
    if (result.action === 'delete') {
      const deleted = Array.isArray(result.deleted) ? result.deleted.join('、') : ''
      return [{ type: 'text', text: `已删除：${deleted}（位于 ${result.root ?? '/'}）。` }]
    }
    return [{ type: 'text', text: `已删除：${result.root ?? '/'}。` }]
}

async function filesToolHandler(config, ctx, args, exec) {
  const action = String(args?.action ?? '')
  const server = args?.server
  if (action === 'list') return { action, ...(await listFiles(config, ctx, server, args?.path, exec?.signal)) }
  if (action === 'read') return { action, ...(await readFile(config, ctx, server, args?.path, exec?.signal)) }
  if (action === 'write') {
    const oldText = typeof args?.oldText === 'string' ? args.oldText : ''
    if (oldText !== '') {
      return { action, ...(await editFile(config, ctx, server, args?.path, oldText, args?.newText, exec?.signal)) }
    }
    return { action, ...(await writeFile(config, ctx, server, args?.path, args?.content, exec?.signal)) }
  }
  if (action === 'upload') {
    return {
      action,
      ...(await uploadFile(config, ctx, server, args?.path, args?.sourcePath, args?.fileName, exec?.signal)),
    }
  }
  if (action === 'download') {
    return {
      action,
      ...(await downloadFile(config, ctx, server, args?.path, args?.targetPath, exec?.signal)),
    }
  }
  if (action === 'delete') {
    const names = (Array.isArray(args?.names) ? args.names : [args?.names]).filter(Boolean)
    if (args?.confirm !== true) {
      throw new PanelError(
        'invalid-argument',
        `删除不可恢复：将要删除 ${names.join('、') || '（空）'}。确认要删就把 confirm 设为 true 再调用。`,
      )
    }
    await requireHumanApproval(
      config,
      ctx,
      { ...exec, name: 'pterodactyl_files_delete' },
      `在 ${await serverLabel(config, ctx, server, exec?.signal)} 上删除 ${args?.path || '/'} 下的 ${names.join('、') || '（空）'}，删除后无法恢复`,
    )
    return { action, ...(await deleteFiles(config, ctx, server, args?.path, args?.names, exec?.signal)) }
  }
  throw new Error(`不支持的 action：${action}（可选 list / read / download / write / upload / delete）`)
}


/**
 * 给工具描述追加版本标记。插件更新后，旧会话仍持有旧的工具定义，
 * 描述里带上版本号，就能在会话中直接看出“跑的是哪一版”，不必靠猜。
 */
function withVersion(tool) {
  return { ...tool, description: `${tool.description ?? ''}\n\n（dsh-pterodactyl ${PLUGIN_VERSION}）` }
}

export function apply(ctx, config) {
  const disposers = []
  const setting = () => config ?? {}
  const entryOf = () => ctx.fiber?.entry


  /** 把设置写入正确的存储层：API Key → 凭证库，面板地址 → 插件 config。 */
  const saveSettings = async (payload) => {
    const inputKey = typeof payload?.apiKey === 'string' ? payload.apiKey.trim() : ''
    const inputBaseUrl = typeof payload?.baseUrl === 'string' ? payload.baseUrl.trim() : ''
    const ref = apiKeyRefOf(config)
    let keySaved = false
    let baseUrlSaved = false

    if (inputKey !== '') {
      const credentials = ctx.get('credentials')
      if (!credentials) {
        throw new PanelError(
          'credentials-unavailable',
          '当前部署没有挂载凭证服务（如 @deepseek-ai/dsh-credentials-local），无法保存 API Key。',
        )
      }
      await credentials.set(ref, inputKey)
      keySaved = true
    }

    if (inputBaseUrl !== '' && normalizeBaseUrl(inputBaseUrl) !== normalizeBaseUrl(config?.baseUrl)) {
      const editor = ctx.get('configEditor')
      const entry = entryOf()
      if (!editor || !entry) {
        throw new PanelError('config-editor-unavailable', '当前部署无法写回插件配置，请改为编辑 profile 的 cordis.patch.yml。')
      }
      await editor.edit(entry, (current) => ({ ...(current ?? {}), baseUrl: inputBaseUrl }))
      baseUrlSaved = true
    }

    const key = await describeApiKey(ctx, config)
    return {
      keySaved,
      baseUrlSaved,
      baseUrl: inputBaseUrl !== '' ? inputBaseUrl : normalizeBaseUrl(config?.baseUrl),
      apiKeyRef: key.ref,
      configured: key.configured,
      apiKeySource: key.source,
    }
  }

  // —— 设置页的只读查询与写入端点（与 Agent 工具共用同一套配置读取） ——
  const handler = async (endpoint, payload) => {
    try {
      switch (endpoint) {
        case 'status': {
          const baseUrl = normalizeBaseUrl(config?.baseUrl)
          const key = await describeApiKey(ctx, config)
          return {
            ok: true,
            value: {
              configured: baseUrl !== '' && key.configured,
              baseUrl,
              panelUrl: panelUrlOf(config),
              hasApiKey: key.configured,
              apiKeyRef: key.ref,
              apiKeySource: key.source,
              apiKeyWritable: key.writable,
              credentialService: key.credentialService,
            },
          }
        }
        case 'settings': {
          const key = await describeApiKey(ctx, config)
          return {
            ok: true,
            value: {
              baseUrl: normalizeBaseUrl(config?.baseUrl),
              baseUrlRaw: String(config?.baseUrl ?? ''),
              panelUrl: panelUrlOf(config),
              allowInsecure: Boolean(config?.allowInsecure),
              apiKeyRef: key.ref,
              apiKeyConfigured: key.configured,
              apiKeySource: key.source,
              apiKeyWritable: key.writable,
              credentialService: key.credentialService,
            },
          }
        }
        case 'settings/save':
          return { ok: true, value: await saveSettings(payload) }
        case 'settings/clear-key': {
          const credentials = ctx.get('credentials')
          if (!credentials) {
            throw new PanelError('credentials-unavailable', '当前部署没有挂载凭证服务，无法清除 API Key。')
          }
          await credentials.unset(apiKeyRefOf(config))
          const key = await describeApiKey(ctx, config)
          return { ok: true, value: { cleared: true, configured: key.configured, apiKeySource: key.source } }
        }
        default:
          return {
            ok: false,
            error: { code: 'unknown-endpoint', message: `未知的 endpoint：${endpoint}`, details: { endpoint } },
          }
      }
    } catch (error) {
      return toRpcError(error)
    }
  }

  // —— HTTP 路由：插件设置页通过同源 fetch 调用 ——
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: CHANNEL,
      handler: async (req, res) => {
        const json = (status, body) => {
          res.writeHead(status, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(JSON.stringify(body))
        }

        if (req.method !== 'POST') {
          json(405, { ok: false, error: { code: 'method-not-allowed', message: '仅支持 POST', details: {} } })
          return
        }

        let endpoint = ''
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          endpoint = url.pathname.slice(CHANNEL.length).replace(/^\/+|\/+$/g, '')
        } catch {
          endpoint = ''
        }

        let raw = ''
        try {
          for await (const chunk of req) {
            raw += chunk
            if (raw.length > 1 << 20) throw new Error('请求体过大')
          }
        } catch (error) {
          json(400, { ok: false, error: { code: 'bad-request', message: String(error?.message ?? error), details: {} } })
          return
        }

        let payload = null
        if (raw.trim() !== '') {
          try {
            payload = JSON.parse(raw)
          } catch {
            json(400, { ok: false, error: { code: 'bad-json', message: '请求体不是合法 JSON', details: {} } })
            return
          }
        }

        const result = await handler(endpoint, payload)
        json(result && result.ok ? 200 : 400, result)
      },
    }),
  )

  // —— Agent 工具（用闭包捕获 config，避免随插件行迁移时丢配置） ——
  // filesTool 已按 action 拆成独立工具，参数说明只在使用时展开对应的那一份。
  for (const factory of [serverTool, powerTool, backupsTool, consoleTool]) {
    disposers.push(ctx.tools.register(withVersion(factory(setting(), ctx))))
  }
  for (const tool of filesTools(setting(), ctx)) {
    disposers.push(ctx.tools.register(withVersion(tool)))
  }

  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* ignore */
      }
    }
  })
}
