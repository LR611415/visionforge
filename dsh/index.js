// VisionForge — DeepSeek Harness (DSH) plugin bridge.
// 自研桥接层：读图 / 生图 / 编辑 / 预览 / 下载 / 粘贴接管 / 设置页。
// 引擎能力（CLI: dist/main.js，provider 适配/schema/failover/guard/cooldown）
// 保留自 liustack/modlens（MIT），桥接层为本项目独立实现。

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnHidden } from './spawnHidden.js'
import { spawnSync } from 'node:child_process'
import {
  canonicalizeName,
  checkNameConflicts,
  parseSizeCap,
  readCustomProviders,
  suggestFamilyFromBaseUrl,
} from '../src/custom-providers.js'
import { inferGenImagePaths, inferGenRequestTemplate, inferReadContentPath, inferReadRequestTemplate } from '../src/request-template.js'

const CLI_PATH = fileURLToPath(new URL('../src/index.js', import.meta.url))
const CLI_TIMEOUT_MS = 260_000
const CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000
// C2：当前 DSH 会话生成/粘贴的文件（一键清理时保留，避免破坏对话内图片的放大/下载）
const sessionTracked = new Set()
const PASTE_MAX_BYTES = 25 * 1024 * 1024
const EVIDENCE_CACHE_LIMIT = 256
const EVIDENCE_RETRY_MS = 60_000
const RECENT_PASTE_CAP = 4
const VERDICT_TTL_MS = 15_000
const VERDICT_CAP = 32
const LOOPBACK_PORTS = [45999, 46999, 47999, 48999]
const REUSE_HARNESSES = ['claude', 'codex', 'opencode', 'pi', 'grok']

const ENGINES = ['antigravity-cli', 'gemini-api', 'openai', 'qwen', 'anthropic', 'claude-cli', 'kimi-cli']
const KEYLESS_ENGINES = ['antigravity-cli', 'claude-cli', 'kimi-cli']
const ENGINE_ALIASES = {
  antigravity: 'antigravity-cli',
  agy: 'antigravity-cli',
  gemini: 'gemini-api',
  'openai-compat': 'openai',
  'qwen-vl': 'qwen',
  dashscope: 'qwen',
  claude: 'anthropic',
  'claude-code': 'claude-cli',
}
const ENGINE_META = {
  qwen: { label: '千问（Qwen）', baseUrl: 'https://maas.qianwenaiapi.com/compatible-mode/v1', models: ['qwen3.8-max', 'qwen3.7-max', 'qwen3-vl-plus', 'qwen3-vl-flash', 'qwen-image-3.0', 'qwen-image-2.0', 'qwen-max', 'qwen-plus', 'qwen-flash', 'qwen-turbo'] },
  openai: { label: 'OpenAI 兼容', baseUrl: '', models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4-turbo'] },
  anthropic: { label: 'Anthropic（Claude）', baseUrl: '', models: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-5', 'claude-3-7-sonnet', 'claude-3-5-sonnet'] },
  'gemini-api': { label: 'Google Gemini', baseUrl: '', models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-pro'] },
  'antigravity-cli': { label: 'Antigravity（免密钥）', baseUrl: '', models: [] },
  'claude-cli': { label: 'Claude Code（免密钥）', baseUrl: '', models: [] },
  'kimi-cli': { label: 'Kimi Code（免密钥）', baseUrl: '', models: [] },
}
// 内置引擎能力表（读图 / 生图 / 编辑）。qwen 含 qwen-image 系列可生图+编辑、qwen-vl 可读图；
// 其余内置引擎按官方 API 能力只标读图（生图/编辑需自定义引擎按协议族配置）。
const BUILTIN_CAPS = {
  qwen: { read: true, generate: true, edit: true },
  openai: { read: true, generate: false, edit: false },
  anthropic: { read: true, generate: false, edit: false },
  'gemini-api': { read: true, generate: false, edit: false },
  'antigravity-cli': { read: true, generate: false, edit: false },
  'claude-cli': { read: true, generate: false, edit: false },
  'kimi-cli': { read: true, generate: false, edit: false },
}
// 免密钥引擎对应的本机 CLI 命令（需已安装并登录，否则不可用）。
const CLI_CMDS = { 'antigravity-cli': 'agy', 'claude-cli': 'claude', 'kimi-cli': 'kimi' }
function cliOnPath(cmd) {
  try {
    const probe = process.platform === 'win32' ? 'where.exe' : 'which'
    const r = spawnSync(probe, [cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return r.status === 0
  } catch { return false }
}
const ENGINE_ENV = {
  'gemini-api': { apiKey: 'GEMINI_API_KEY', baseUrl: 'GEMINI_BASE_URL' },
  openai: { apiKey: 'OPENAI_API_KEY', baseUrl: 'OPENAI_BASE_URL' },
  qwen: { apiKey: 'VISIONFORGE_QWEN_API_KEY', baseUrl: 'VISIONFORGE_QWEN_BASE_URL' },
  anthropic: { apiKey: 'ANTHROPIC_API_KEY', baseUrl: 'ANTHROPIC_BASE_URL' },
}
const MEDIA_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/heic': '.heic',
  'image/heif': '.heif',
}
const FAILURE_TEXT = {
  store: '[A pasted image could not be read: the attachment store did not return it. Tell the user, and suggest running `npx @lr611/visionforge doctor`.]',
  media: '[A pasted image could not be read: its media type is not supported. Tell the user, and suggest running `npx @lr611/visionforge doctor`.]',
  engine: '[A pasted image could not be read: the vision engine failed. Tell the user, and suggest running `npx @lr611/visionforge doctor`.]',
}
const ROUTE_REFUSAL = 'request refused: this route answers same-origin loopback only'

const OUTPUT_SCHEMA = JSON.parse(readFileSync(new URL('./vision-schema.json', import.meta.url), 'utf8'))
const IMAGE_GEN_SCHEMA = {
  type: 'object',
  properties: {
    provider: { type: 'string', description: 'Engine that produced the image (qwen or glm)' },
    model: { type: 'string' },
    url: { type: 'string', description: 'Temporary provider URL' },
    filePath: { type: 'string', description: 'Local saved file path' },
    urls: { type: 'array', items: { type: 'string' } },
    filePaths: { type: 'array', items: { type: 'string' } },
    previewMarkdown: { type: 'string', description: 'Ready preview+download markdown to echo verbatim' },
  },
  required: [],
}
const IMAGE_DOWNLOAD_SCHEMA = {
  type: 'object',
  properties: {
    filePath: { type: 'string', description: 'Absolute path where the image was permanently saved' },
    action: { type: 'string', enum: ['downloaded'] },
    message: { type: 'string' },
  },
  required: ['filePath', 'action'],
}
const IMAGE_PREVIEW_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    opened: { type: 'boolean' },
    message: { type: 'string' },
  },
  required: ['path', 'opened'],
}

export const name = 'visionforge'
export const inject = ['tools', 'agents', 'attachments', 'llm']

// ---- 配置层 -----------------------------------------------------------------
export function configPath() {
  return join(homedir(), '.visionforge', 'config.json')
}

export function readConfig() {
  let raw
  try {
    raw = readFileSync(configPath(), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return {}
    throw new Error(`cannot read ${configPath()}: ${error?.message ?? error}`)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`${configPath()} is not valid JSON: ${error?.message ?? error}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${configPath()} does not hold a JSON object`)
  }
  return parsed
}

function defaultOutputDir() {
  if (process.platform === 'win32') {
    return existsSync('D:\\') ? 'D:\\VisionForge\\out' : join(homedir(), 'VisionForge', 'out')
  }
  return join(homedir(), '.visionforge', 'out')
}

export function outputDir() {
  try {
    const shared = readConfig()
    if (typeof shared?.outputDir === 'string' && shared.outputDir.trim() !== '') return shared.outputDir
  } catch { /* fall through */ }
  return defaultOutputDir()
}

function ensureDefaults() {
  try {
    const file = configPath()
    if (!existsSync(file)) return
    const cfg = readConfig()
    if (typeof cfg.outputDir === 'string' && cfg.outputDir.trim() !== '') return
    cfg.outputDir = defaultOutputDir()
    try {
      if (lstatSync(file).isSymbolicLink()) return
    } catch (error) {
      if (error?.code !== 'ENOENT') return
    }
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 })
  } catch { /* best effort */ }
}

function canonicalEngine(id) {
  if (typeof id !== 'string') return ''
  const key = id.trim().toLowerCase()
  if (ENGINES.includes(key)) return key
  if (ENGINE_ALIASES[key]) return ENGINE_ALIASES[key]
  // 自定义引擎（含中文名）：保留规范化名称，保证设置卡片读回时能还原用户选择
  return key
}

function engineKeys(engine) {
  const aliases = Object.keys(ENGINE_ALIASES).filter((alias) => ENGINE_ALIASES[alias] === engine)
  return [...aliases, engine]
}

function hasKey(value) {
  return typeof value === 'string' && value.split(',').map((k) => k.trim()).some((k) => k !== '')
}

function envSettings(engine, env = process.env) {
  const out = {}
  for (const [field, variable] of Object.entries(ENGINE_ENV[engine] ?? {})) {
    const value = typeof env[variable] === 'string' ? env[variable].trim() : ''
    if (value !== '' && (field !== 'apiKey' || hasKey(value))) out[field] = value
  }
  return out
}

function engineInFile(engine, config) {
  return engineKeys(engine).some((key) => config.providers?.[key] !== undefined)
}

export function engineSummary() {
  const config = readConfig()
  const engines = {}
  for (const id of ENGINES) {
    const inFile = engineInFile(id, config)
    const settings = inFile
      ? Object.assign({}, ...engineKeys(id).map((key) => config.providers?.[key] ?? {}))
      : envSettings(id)
    const meta = ENGINE_META[id] ?? {}
    engines[id] = {
      label: typeof meta.label === 'string' ? meta.label : id,
      baseUrl: typeof settings.baseUrl === 'string' ? settings.baseUrl : '',
      model: typeof settings.model === 'string' ? settings.model : '',
      hasKey: hasKey(settings.apiKey),
      models: Array.isArray(meta.models) ? meta.models : [],
      keyless: KEYLESS_ENGINES.includes(id),
      proxyMode: !Object.hasOwn(settings, 'proxy') ? 'inherit' : typeof settings.proxy === 'string' && settings.proxy.trim() === '' ? 'direct' : 'custom',
      proxy: typeof settings.proxy === 'string' ? settings.proxy : '',
      structuredOutput: typeof settings.structuredOutput === 'boolean' ? settings.structuredOutput : '',
      timeoutMs: typeof settings.timeoutMs === 'number' ? settings.timeoutMs : '',
      extraBody: typeof settings.extraBody === 'object' && settings.extraBody ? JSON.stringify(settings.extraBody) : '',
      requestTemplate: typeof settings.requestTemplate === 'object' && settings.requestTemplate ? JSON.stringify(settings.requestTemplate) : '',
      source: inFile ? 'file' : Object.keys(settings).length > 0 ? 'env' : '',
      caps: BUILTIN_CAPS[id] ?? { read: true, generate: false, edit: false },
      maxRes: id === 'qwen' ? '2K' : '',
    }
    if (KEYLESS_ENGINES.includes(id)) {
      engines[id].cliCmd = CLI_CMDS[id] ?? id
      engines[id].cliReady = cliOnPath(CLI_CMDS[id] ?? id)
    }
  }
  const customs = readCustomProviders(config)
  for (const [id, entry] of Object.entries(customs)) {
    engines[id] = {
      label: entry.displayName + '（自定义）',
      baseUrl: typeof entry.baseUrl === 'string' ? entry.baseUrl : '',
      model: typeof entry.model === 'string' ? entry.model : '',
      hasKey: hasKey(entry.apiKey),
      models: Array.isArray(entry.models) ? entry.models.map((m) => (typeof m === 'string' ? m : (m?.name ?? ''))).filter(Boolean) : [],
      genCapable: entry.genFamily !== '' && Array.isArray(entry.models) && entry.models.some((m) => m && m.capabilities && m.capabilities.generate),
      sizeCap: typeof entry.sizeCap === 'string' ? entry.sizeCap : '',
      caps: { read: entry.readFamily !== '', generate: entry.genFamily !== '' && Array.isArray(entry.models) && entry.models.some((m) => m && m.capabilities && m.capabilities.generate), edit: false },
      maxRes: typeof entry.sizeCap === 'string' && entry.sizeCap ? entry.sizeCap : (entry.genFamily !== '' ? '2K' : ''),
      failedReason: typeof entry.failed?.reason === 'string' ? entry.failed.reason : '',
      keyless: false,
      custom: true,
      proxyMode: !Object.hasOwn(entry, 'proxy') ? 'inherit' : typeof entry.proxy === 'string' && entry.proxy.trim() === '' ? 'direct' : 'custom',
      proxy: typeof entry.proxy === 'string' ? entry.proxy : '',
      structuredOutput: typeof entry.structuredOutput === 'boolean' ? entry.structuredOutput : '',
      timeoutMs: typeof entry.timeoutMs === 'number' ? entry.timeoutMs : '',
      extraBody: typeof entry.extraBody === 'object' && entry.extraBody ? JSON.stringify(entry.extraBody) : '',
      requestTemplate: typeof entry.requestTemplate === 'object' && entry.requestTemplate ? JSON.stringify(entry.requestTemplate) : '',
      source: 'file',
    }
  }
  const reuse = {}
  for (const harness of REUSE_HARNESSES) {
    const granted = config.reuse?.[harness]
    reuse[harness] = typeof granted === 'boolean' ? granted : harness === 'claude'
  }
  const customsOut = Object.entries(customs).map(([id, entry]) => ({
    id,
    displayName: entry.displayName ?? id,
    readFamily: entry.readFamily ?? '',
    genFamily: entry.genFamily ?? '',
    sizeCap: typeof entry.sizeCap === 'string' ? entry.sizeCap : '',
    failedReason: typeof entry.failed?.reason === 'string' ? entry.failed.reason : '',
    baseUrl: typeof entry.baseUrl === 'string' ? entry.baseUrl : '',
    model: typeof entry.model === 'string' ? entry.model : '',
    hasKey: hasKey(entry.apiKey),
    requestTemplate: typeof entry.requestTemplate === 'object' && entry.requestTemplate ? JSON.stringify(entry.requestTemplate) : '',
  }))
  return {
    provider: canonicalEngine(config.provider),
    engines,
    customs: customsOut,
    keyless: KEYLESS_ENGINES,
    reuse,
    visionPriority: config.visionPriority === 'plugin' ? 'plugin' : 'official',
    outputDir: typeof config.outputDir === 'string' && config.outputDir.trim() !== '' ? config.outputDir : defaultOutputDir(),
    pasteToPath: config.pasteToPath !== false,
    debugLogs: config.debugLogs === true,
    enhanceEditPrompt: config.enhanceEditPrompt !== false,
  }
}

function inferGenFamily(readFamily) {
  // 读图协议族 → 默认生图协议族（可被 patch.genFamily 显式覆盖）
  if (readFamily === 'openai-compatible') return 'openai-image' // OpenAI 兼容网关最常见：POST /images/generations
  if (readFamily === 'gemini') return 'google-imagen'
  return ''
}

export function applySettings(patch) {
  const config = readConfig()
  if (patch?.provider !== undefined) {
    if (patch.provider === '') {
      delete config.provider
    } else if (ENGINES.includes(patch.provider)) {
      config.provider = patch.provider
    } else {
      // 自定义引擎也可以作为默认提供方（读图/生图默认引擎）
      let cid = ''
      try { cid = canonicalizeName(patch.provider) } catch { cid = '' }
      if (cid !== '' && Object.hasOwn(config.customProviders ?? {}, cid)) {
        config.provider = cid
      } else {
        throw new Error(`unknown engine: ${patch.provider}`)
      }
    }
  }
  if (patch?.visionPriority !== undefined) {
    if (patch.visionPriority === 'official' || patch.visionPriority === 'plugin') {
      config.visionPriority = patch.visionPriority
    } else {
      throw new Error(`unknown visionPriority: ${patch.visionPriority}`)
    }
  }
  let engine = patch?.engine
  if (engine === undefined && (Object.hasOwn(patch, 'baseUrl') || Object.hasOwn(patch, 'model') || Object.hasOwn(patch, 'apiKey') || Object.hasOwn(patch, 'proxyMode'))) {
    const prov = typeof config.provider === 'string' ? config.provider.trim() : ''
    const canon = canonicalEngine(prov)
    engine = canon || (prov !== '' && Object.hasOwn(config.customProviders ?? {}, prov.toLowerCase()) ? prov.toLowerCase() : '') || 'qwen'
  }
  if (engine !== undefined) {
    const rawEngine = typeof engine === 'string' ? engine.trim() : ''
    if (!rawEngine) throw new Error('engine 不能为空')
    const customId = canonicalizeName(rawEngine)
    const isCustom = customId !== '' && !ENGINES.includes(customId)
    if (!isCustom && !ENGINES.includes(rawEngine)) throw new Error(`unknown engine: ${rawEngine}`)
    if (isCustom) {
      // 自定义引擎：更新已有条目，或由主卡片"只填名称"后首次保存时创建。
      config.customProviders = { ...(config.customProviders ?? {}) }
      const existing = config.customProviders[customId]
      if (existing) {
        // 修改配置即解除验证/失败状态：下次调用重新验证
        delete existing.verified
        delete existing.failed
        if (Object.hasOwn(patch, 'baseUrl')) {
          const v = typeof patch.baseUrl === 'string' ? patch.baseUrl.trim() : ''
          if (v === '') throw new Error(`自定义引擎「${customId}」的接口地址不能为空`)
          existing.baseUrl = v
        } else if (typeof existing.baseUrl !== 'string' || existing.baseUrl.trim() === '') {
          throw new Error(`自定义引擎「${customId}」的接口地址不能为空`)
        }
        const model = typeof patch.model === 'string' ? patch.model.trim() : ''
        if (model !== '') {
          const models = Array.isArray(existing.models) ? existing.models.map((m) => ({ ...m })) : []
          const idx = models.findIndex((m) => m && m.capabilities && m.capabilities.read)
          if (idx >= 0) models[idx] = { ...models[idx], name: model }
          else models.push({ name: model, capabilities: { read: true, generate: false, edit: false } })
          existing.models = models
          existing.model = model
        }
        const apiKey = typeof patch.apiKey === 'string' ? patch.apiKey.trim() : ''
        if (apiKey !== '') existing.apiKey = apiKey
        if (Object.hasOwn(patch, 'genFamily')) {
          const gf = typeof patch.genFamily === 'string' ? patch.genFamily.trim() : ''
          if (gf === '') {
            delete existing.genFamily
          } else {
            if (!GEN_FAMILIES.includes(gf)) throw new Error(`未知的生图协议族：${gf}。可选：${GEN_FAMILIES.filter((f) => f !== '').join(', ')}。`)
            existing.genFamily = gf
          }
          const models = Array.isArray(existing.models) ? existing.models.map((m) => ({ ...m })) : []
          const idx = models.findIndex((m) => m && m.capabilities && (m.capabilities.generate || m.capabilities.read))
          if (idx >= 0) models[idx] = { ...models[idx], capabilities: { ...models[idx].capabilities, generate: gf !== '' } }
          else if (gf !== '' && existing.model) models.push({ name: existing.model, capabilities: { read: true, generate: true, edit: false } })
          existing.models = models
        }
        if (Object.hasOwn(patch, 'sizeCap')) {
          const sc = typeof patch.sizeCap === 'string' ? patch.sizeCap.trim() : ''
          if (sc === '') {
            delete existing.sizeCap
          } else {
            try { parseSizeCap(sc) } catch (e) { throw new Error(e.message) }
            existing.sizeCap = sc
          }
        }
      } else {
        const baseUrl = typeof patch.baseUrl === 'string' ? patch.baseUrl.trim() : ''
        if (!baseUrl) throw new Error(`自定义引擎「${customId}」的接口地址不能为空`)
        if (!/^https?:\/\//i.test(baseUrl)) throw new Error(`自定义引擎「${customId}」的接口地址必须以 http:// 或 https:// 开头`)
        const conflict = checkNameConflicts(customId, config)
        if (conflict) throw new Error(conflict.message)
        const model = typeof patch.model === 'string' ? patch.model.trim() : ''
        const apiKey = typeof patch.apiKey === 'string' ? patch.apiKey.trim() : ''
        const readFamily = suggestFamilyFromBaseUrl(baseUrl).family || 'openai-compatible'
        const genFamily = typeof patch.genFamily === 'string' && patch.genFamily.trim() !== '' ? patch.genFamily.trim() : inferGenFamily(readFamily)
        if (genFamily !== '' && !GEN_FAMILIES.includes(genFamily)) {
          throw new Error(`未知的生图协议族：${genFamily}。可选：${GEN_FAMILIES.filter((f) => f !== '').join(', ')}。`)
        }
        const sizeCap = typeof patch.sizeCap === 'string' ? patch.sizeCap.trim() : ''
        if (sizeCap !== '') {
          try { parseSizeCap(sizeCap) } catch (e) { throw new Error(e.message) }
        }
        config.customProviders[customId] = {
          displayName: customId,
          baseUrl,
          readFamily,
          ...(genFamily !== '' ? { genFamily } : {}),
          ...(sizeCap !== '' ? { sizeCap } : {}),
          ...(model !== '' ? { model, models: [{ name: model, capabilities: { read: true, generate: genFamily !== '', edit: false } }] } : {}),
          ...(apiKey !== '' ? { apiKey } : {}),
        }
        config.provider = customId
      }
    } else {
      config.providers = { ...config.providers }
      const holders = engineKeys(rawEngine).filter((key) => config.providers[key] !== undefined)
      const target = holders.length > 0 ? holders[holders.length - 1] : rawEngine
      const seed = holders.length > 0 ? {} : envSettings(rawEngine)
      const settings = { ...seed, ...config.providers[target] }
      for (const field of ['baseUrl', 'model']) {
        if (!Object.hasOwn(patch, field)) continue
        const value = typeof patch[field] === 'string' ? patch[field].trim() : ''
        if (value === '') delete settings[field]
        else settings[field] = value
      }
      const apiKey = typeof patch.apiKey === 'string' ? patch.apiKey.trim() : ''
      if (apiKey !== '') settings.apiKey = apiKey
      if (Object.hasOwn(patch, 'proxyMode')) {
        if (patch.proxyMode === 'inherit') {
          for (const holder of holders) {
            const stored = config.providers[holder]
            if (stored && typeof stored === 'object' && !Array.isArray(stored)) delete stored.proxy
          }
          delete settings.proxy
        } else if (patch.proxyMode === 'direct') {
          settings.proxy = ''
        } else if (patch.proxyMode === 'custom') {
          const proxy = typeof patch.proxy === 'string' ? patch.proxy.trim() : ''
          if (proxy !== '') settings.proxy = proxy
          else {
            const merged = Object.assign({}, ...holders.map((key) => config.providers[key]))
            if (typeof merged.proxy !== 'string' || merged.proxy.trim() === '') throw new Error('custom proxy mode needs a proxy URL')
          }
        } else {
          throw new Error(`unknown proxy mode: ${patch.proxyMode}`)
        }
      }
      config.providers[target] = settings
    }
  }
  // ---- 开发者选项：响应格式 / 请求超时 / 请求体扩展（写入当前引擎）----
  const hasDev = Object.hasOwn(patch, 'structuredOutput') || Object.hasOwn(patch, 'timeoutMs') || Object.hasOwn(patch, 'extraBody') || Object.hasOwn(patch, 'requestTemplate')
  if (hasDev) {
    const rawEngineDev = typeof engine === 'string' && engine.trim() !== '' ? engine.trim() : (typeof config.provider === 'string' ? config.provider.trim() : '')
    if (!rawEngineDev) throw new Error('未指定引擎，无法保存开发者选项')
    const customIdDev = canonicalizeName(rawEngineDev)
    const isCustomDev = customIdDev !== '' && !ENGINES.includes(customIdDev) && Object.hasOwn(config.customProviders ?? {}, customIdDev)
    const holder = isCustomDev ? config.customProviders[customIdDev] : config.providers[rawEngineDev]
    if (!holder) throw new Error(`unknown engine: ${rawEngineDev}`)
    if (Object.hasOwn(patch, 'structuredOutput')) {
      if (typeof patch.structuredOutput === 'boolean') holder.structuredOutput = patch.structuredOutput
      else delete holder.structuredOutput
    }
    if (Object.hasOwn(patch, 'timeoutMs')) {
      const v = patch.timeoutMs
      if (v === '' || v === null || v === undefined) delete holder.timeoutMs
      else {
        const n = Number(v)
        if (!Number.isFinite(n) || n < 1000 || n > 600000) throw new Error('请求超时必须在 1000–600000 毫秒之间')
        holder.timeoutMs = Math.round(n)
      }
    }
    if (Object.hasOwn(patch, 'extraBody')) {
      const raw = typeof patch.extraBody === 'string' ? patch.extraBody.trim() : ''
      if (raw === '') delete holder.extraBody
      else {
        let obj
        try { obj = JSON.parse(raw) } catch { throw new Error('请求体扩展（extraBody）必须是合法 JSON 对象') }
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('请求体扩展（extraBody）必须是 JSON 对象')
        holder.extraBody = { ...(holder.extraBody ?? {}), ...obj }
      }
    }
    if (Object.hasOwn(patch, 'requestTemplate')) {
      const raw = patch.requestTemplate
      if (raw === null || raw === undefined || raw === '' || (typeof raw === 'object' && Object.keys(raw).length === 0)) {
        delete holder.requestTemplate
      } else {
        let obj = raw
        if (typeof raw === 'string') {
          const trimmed = raw.trim()
          if (trimmed === '') delete holder.requestTemplate
          else {
            try { obj = JSON.parse(trimmed) } catch { throw new Error('自定义请求模板必须是合法 JSON') }
          }
        }
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
          if (obj.enabled !== undefined && typeof obj.enabled !== 'boolean') throw new Error('requestTemplate.enabled 必须是布尔值')
          for (const side of ['read', 'generate']) {
            if (obj[side] !== undefined) {
              if (!obj[side] || typeof obj[side] !== 'object' || typeof obj[side].url !== 'string' || obj[side].url.trim() === '') {
                throw new Error(`请求模板 ${side}.url 不能为空（应含 {{BASE_URL}} 或完整地址）`)
              }
            }
          }
          holder.requestTemplate = obj
        } else if (raw !== '') {
          throw new Error('自定义请求模板必须是 JSON 对象')
        }
      }
    }
  }
  if (patch?.reuse !== null && typeof patch?.reuse === 'object') {
    config.reuse = { ...config.reuse }
    for (const harness of REUSE_HARNESSES) {
      if (typeof patch.reuse[harness] === 'boolean') config.reuse[harness] = patch.reuse[harness]
    }
  }
  if (patch?.outputDir !== undefined) {
    const v = typeof patch.outputDir === 'string' ? patch.outputDir.trim() : ''
    if (v === '') delete config.outputDir
    else config.outputDir = v
  }
  if (patch?.pasteToPath !== undefined && typeof patch.pasteToPath === 'boolean') {
    config.pasteToPath = patch.pasteToPath
  }
  if (patch?.enhanceEditPrompt !== undefined && typeof patch.enhanceEditPrompt === 'boolean') {
    config.enhanceEditPrompt = patch.enhanceEditPrompt
  }
  if (patch?.debugLogs !== undefined && typeof patch.debugLogs === 'boolean') {
    config.debugLogs = patch.debugLogs
  }
  const file = configPath()
  try {
    if (lstatSync(file).isSymbolicLink()) throw new Error(`${file} is a symlink; edit the file it points at instead`)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  try {
    chmodSync(file, 0o600)
  } catch { /* Windows has no POSIX bits */ }
}

function openConfigInEditor() {
  const file = configPath()
  try {
    lstatSync(file)
  } catch {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, '{}\n', { mode: 0o600 })
  }
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [file]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', file]]
        : ['xdg-open', [file]]
  try {
    spawnHidden(cmd, args, { detached: true, stdio: 'ignore' }).unref()
  } catch { /* editor open is a nicety */ }
}

// ---- CLI 子进程 --------------------------------------------------------------
// signal：宿主的取消信号（DSH 停止按钮 / 工具超时都会触发 abort → 立即 kill 子进程）。
// 内部超时兜底：即使宿主没传 signal 或没 abort，CLI 挂死也不会永远占用（180s 后强杀）。
function runCli(args, signal, timeoutMs = CLI_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false
    let child = null
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { if (child) child.kill('SIGKILL') } catch { /* ignore */ }
      reject(new Error(`visionforge CLI timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    try {
      child = spawnHidden(process.execPath, [CLI_PATH, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        signal,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', VISIONFORGE_INTERNAL: '1' },
      })
    } catch (e) {
      settled = true
      clearTimeout(timer)
      return reject(e)
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout, stderr, code })
    })
  })
}

// ---- 渲染（证据 / 预览 markdown）---------------------------------------------
function renderEvidenceText(value) {
  const lines = [value.summary]
  const text = value.ocr?.full_text?.trim()
  if (text) lines.push('', 'Transcription:', text.length > 4000 ? `${text.slice(0, 4000)}…` : text)
  const uncertainty = value.uncertainty ?? []
  if (uncertainty.length > 0) lines.push('', `Uncertain: ${uncertainty.join('; ')}`)
  return lines.join('\n')
}

let renderServerPort = 0
let renderServer = null
const servedFiles = new Set()

function registerServed(file) {
  if (typeof file === 'string') {
    try {
      servedFiles.add(resolve(file))
    } catch { /* ignore */ }
  }
}

function buildPreviewMarkdown(value) {
  const v = value && typeof value === 'object' ? value : {}
  const urls = Array.isArray(v.urls) && v.urls.length > 0 ? v.urls : typeof v.url === 'string' ? [v.url] : []
  const files = Array.isArray(v.filePaths) && v.filePaths.length > 0 ? v.filePaths : typeof v.filePath === 'string' ? [v.filePath] : []
  for (const f of files) registerServed(f)
  const port = renderServerPort
  const lines = []
  urls.forEach((u, i) => {
    if (typeof u !== 'string') return
    const fp = files[i]
    if (port > 0 && typeof fp === 'string') {
      // 图片作为整体卡片：缩略图 src = 本地回环 /visionforge/image（渲染器可显示）；
      // 点击图片本体由 client.js 捕获 → /visionforge/open → 系统图片查看器（不经过侧边栏）。
      const local = `http://127.0.0.1:${port}/visionforge/image?path=${encodeURIComponent(fp)}`
      // 下载按钮：点击后把缓存图复制到 D 盘根目录（无 D 盘则用户目录 VisionForge）并在资源管理器中定位
      const dl = ` [保存图片 ${i + 1}](http://127.0.0.1:${port}/visionforge/save-local?path=${encodeURIComponent(fp)})`
      lines.push(`![生成图 ${i + 1}](${local})${dl}`)
    } else if (typeof fp === 'string') {
      // 本地预览服务未启动（端口被占用）：不输出远程临时 URL 图（无法放大/下载，且 agent 会误判失败重试），
      // 改为明确告知保存路径 —— agent 看到“已保存”就不会重试，用户可去缓存目录查看。
      lines.push(`生成图 ${i + 1} 已保存：${fp}`)
      lines.push(`（本地预览服务未启动，对话内暂时无法预览/下载；请到该路径查看，或重启 DSH 后重新生成即可获得完整预览）`)
    } else {
      lines.push(`![生成图 ${i + 1}](${u})`)
    }
  })
  if (typeof v.provider === 'string') lines.push(`Provider: ${v.provider}`)
  if (typeof v.model === 'string' && v.model !== '') lines.push(`Model: ${v.model}`)
  if (typeof v.size === 'string' && v.size !== '') lines.push(`分辨率: ${String(v.size).replace(/\*/g, '×')}`)
  if (typeof v.sizeNote === 'string' && v.sizeNote !== '') lines.push(`说明: ${v.sizeNote}`)
  if (typeof v.enhanceNotice === 'string' && v.enhanceNotice !== '') lines.push(`注意: ${v.enhanceNotice}`)
  return lines.join('\n')
}

function renderGenText(value) {
  const v = value && typeof value === 'object' ? value : {}
  const urls = Array.isArray(v.urls) && v.urls.length > 0 ? v.urls : typeof v.url === 'string' ? [v.url] : []
  let files = []
  if (Array.isArray(v.filePaths) && v.filePaths.length > 0) files = v.filePaths
  else if (typeof v.filePath === 'string') files = [v.filePath]
  const port = renderServerPort
  const lines = []
  urls.forEach((u, i) => {
    if (typeof u !== 'string') return
    const fp = files[i]
    if (port > 0 && typeof fp === 'string') {
      // 缩略图 src = 本地回环 /visionforge/image；点击图片本体由 client.js 捕获 → 系统图片查看器
      lines.push(`![生成图 ${i + 1}](http://127.0.0.1:${port}/visionforge/image?path=${encodeURIComponent(fp)})`)
    } else if (typeof fp === 'string') {
      lines.push(`生成图 ${i + 1} 已保存：${fp}（本地预览服务未启动，暂无法对话内预览）`)
    } else {
      lines.push(`![生成图 ${i + 1}](${u})`)
    }
  })
  if (port > 0 && files.length > 0) {
    lines.push('')
    files.forEach((fp, i) => {
      if (typeof fp === 'string') lines.push(`[保存图片 ${i + 1}](http://127.0.0.1:${port}/visionforge/save-local?path=${encodeURIComponent(fp)})`)
    })
  }
  if (urls.length > 0 || files.length > 0) {
    lines.push('', '【展示给用户】请在最终回复正文中【原样、完整】复制上面这一整段：缩略图在对话中显示小图（点击图片本体用电脑系统图片查看器打开缓存位置的原图放大，不经过侧边栏）；[保存图片 N] 是下载按钮，点击后把缓存图复制到 D 盘根目录并在资源管理器中定位。禁止只列文件路径；禁止把临时 URL 单独贴成文本或链接。')
  }
  if (typeof v.provider === 'string') lines.push(`Provider: ${v.provider}`)
  if (typeof v.model === 'string') lines.push(`Model: ${v.model}`)
  if (typeof v.size === 'string' && v.size !== '') lines.push(`分辨率: ${String(v.size).replace(/\*/g, '×')}`)
  if (typeof v.sizeNote === 'string' && v.sizeNote !== '') lines.push(`说明: ${v.sizeNote}`)
  if (typeof v.enhanceNotice === 'string' && v.enhanceNotice !== '') lines.push(`注意: ${v.enhanceNotice}`)
  return lines.join('\n') || JSON.stringify(value)
}


// ---- 循环回环服务（渲染 / 下载 / 打开 / 本地保存）----------------------------
function startRenderServer() {
  if (renderServer !== null) return renderServerPort
  try {
    const outDir = resolve(outputDir())
    const server = createServer((req, res) => {
      try {
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'access-control-allow-origin': '*',
            'access-control-allow-methods': 'GET, OPTIONS',
            'access-control-allow-headers': '*',
          })
          res.end()
          return
        }
        const debugLogs = (() => { try { return readConfig().debugLogs === true } catch { return false } })()
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const isImage = url.pathname === '/visionforge/image'
        const isDownload = url.pathname === '/visionforge/download'
        const isOpen = url.pathname === '/visionforge/open'
        const isSaveLocal = url.pathname === '/visionforge/save-local'
        const isDownloadLocal = url.pathname === '/visionforge/download-local'
        const isClickDebug = url.pathname === '/visionforge/click-debug'
        const isLog = url.pathname === '/visionforge/log'
        if (isLog) {
          // 诊断：client.js 上报（匹配统计/错误），写入 server.log 供排查 DOM 层盲区。
          try {
            mkdirSync(outDir, { recursive: true })
            appendFileSync(join(outDir, 'server.log'), `${new Date().toISOString()} diag msg=${url.searchParams.get('msg') ?? ''}\n`)
          } catch { /* log best-effort */ }
          res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
          res.end('{"ok":true}')
          return
        }
        if (isClickDebug) {
          // 诊断：client.js 点击捕获命中后上报，用于定位"点图无反应"卡在哪一环。
          try {
            if (debugLogs) {
              mkdirSync(outDir, { recursive: true })
              appendFileSync(join(outDir, 'click-debug.log'), `${new Date().toISOString()} click raw=${url.searchParams.get('path') ?? ''} ua=${req.headers?.['user-agent'] ?? ''}\n`)
            }
          } catch { /* log best-effort */ }
          res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
          res.end('{"ok":true}')
          return
        }
        if (!isImage && !isDownload && !isOpen && !isSaveLocal && !isDownloadLocal) {
          res.writeHead(404).end('not found')
          return
        }
        const raw = url.searchParams.get('path')
        if (!raw) {
          res.writeHead(400).end('missing path')
          return
        }
        const file = resolve(raw)
        try {
          // 请求日志：记录每次图片/下载请求，用于确认历史消息的图是否被 DOM 请求到。
          mkdirSync(outDir, { recursive: true })
          appendFileSync(join(outDir, 'server.log'), `${new Date().toISOString()} req path=${url.pathname} file=${basename(file)}\n`)
        } catch { /* log best-effort */ }
        const inOut = dirname(file) === outDir || dirname(file).startsWith(outDir + sep)
        // 白名单：out 目录或本会话生成图（servedFiles）。DSH 重启后 servedFiles 会清空，
        // 历史消息里保存到工作区的图（如 beach_1.png 不在 out）会 403 导致预览/放大/下载不可见。
        // 放宽为：文件真实存在 + 图片扩展名即服务（服务只绑定 127.0.0.1 回环 + 只读 GET，可接受）。
        if (!existsSync(file)) {
          res.writeHead(403).end('forbidden')
          return
        }
        if (!inOut && !servedFiles.has(file) && !/\.(png|jpe?g|webp|gif|heic|heif|bmp)$/i.test(file)) {
          res.writeHead(403).end('forbidden')
          return
        }
        if (isOpen) {
          // 系统默认图片查看器打开（不经过 DSH 自身打开方式）。
          try {
            if (debugLogs) {
              mkdirSync(outDir, { recursive: true })
              appendFileSync(join(outDir, 'open-debug.log'), `${new Date().toISOString()} open file=${file}\n`)
            }
          } catch { /* log best-effort */ }
          try {
            const child = spawn('cmd.exe', ['/c', 'start', '', file], { detached: true, stdio: 'ignore' })
            child.on('error', () => {})
            child.unref()
          } catch { /* open is a nicety */ }
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'access-control-allow-origin': '*' })
          res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>VisionForge 已打开</title><body style="font-family:system-ui;padding:24px"><h2 style="color:#166534">已在系统图片查看器中打开</h2><p>文件：${file}</p></body></html>`)
          return
        }
        if (isDownloadLocal) {
          // JSON API：client.js 拦截下载按钮后调用（复制缓存到 D 盘根 + 定位 + 返回 JSON，
          // 不经过宿主侧边栏）。save-local 保留为兜底页面。
          const base = basename(file)
          const ext = extname(file)
          const root = existsSync('D:\\') ? 'D:\\' : join(homedir(), 'VisionForge')
          let dest = join(root, base)
          if (dest !== file && existsSync(dest)) {
            const ts = new Date().toISOString().replace(/[:.]/g, '-')
            const stem = base.slice(0, base.length - ext.length) || 'visionforge'
            dest = join(dirname(dest), `${stem}-${ts}${ext}`)
          }
          const parent = dirname(dest)
          if (!existsSync(parent)) mkdirSync(parent, { recursive: true })
          copyFileSync(file, dest)
          try {
            const reveal = spawn('explorer.exe', ['/select,' + dest], { detached: true, stdio: 'ignore' })
            reveal.on('error', () => {
              try {
                const fb = spawn('cmd.exe', ['/c', 'start', '', dirname(dest)], { detached: true, stdio: 'ignore' })
                fb.on('error', () => {})
                fb.unref()
              } catch { /* nicety */ }
            })
            reveal.unref()
          } catch { /* reveal is a nicety */ }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' })
          res.end(JSON.stringify({ ok: true, file: dest }))
          return
        }
        if (isSaveLocal) {
          // 本地保存：复制到 D 盘根目录（无 D 盘则用户主目录 VisionForge）并定位。
          const base = basename(file)
          const ext = extname(file)
          const root = existsSync('D:\\') ? 'D:\\' : join(homedir(), 'VisionForge')
          let dest = join(root, base)
          if (dest !== file && existsSync(dest)) {
            const ts = new Date().toISOString().replace(/[:.]/g, '-')
            const stem = base.slice(0, base.length - ext.length) || 'visionforge'
            dest = join(dirname(dest), `${stem}-${ts}${ext}`)
          }
          const parent = dirname(dest)
          if (!existsSync(parent)) mkdirSync(parent, { recursive: true })
          copyFileSync(file, dest)
          try {
            const reveal = spawn('explorer.exe', ['/select,' + dest], { detached: true, stdio: 'ignore' })
            reveal.on('error', () => {
              try {
                const fb = spawn('cmd.exe', ['/c', 'start', '', dirname(dest)], { detached: true, stdio: 'ignore' })
                fb.on('error', () => {})
                fb.unref()
              } catch { /* nicety */ }
            })
            reveal.unref()
          } catch { /* reveal is a nicety */ }
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'access-control-allow-origin': '*' })
          res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>VisionForge 保存成功</title><body style="font-family:system-ui;padding:24px"><h2 style="color:#166534">保存成功</h2><p>文件：${dest}</p><p>已在资源管理器中定位该文件。</p><script>setTimeout(function(){try{window.close()}catch(e){}},900)</script></body></html>`)
          return
        }
        const ext = extname(file).toLowerCase()
        const mime =
          ext === '.png' ? 'image/png'
          : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
          : ext === '.webp' ? 'image/webp'
          : ext === '.gif' ? 'image/gif'
          : 'application/octet-stream'
        const headers = isImage
          ? {
              'Content-Type': mime,
              'Content-Length': statSync(file).size,
              'Cache-Control': 'private, max-age=3600',
            }
          : {
              'Content-Type': mime,
              'Content-Length': statSync(file).size,
              'Content-Disposition': `attachment; filename="image${ext}"; filename*=UTF-8''${encodeURIComponent(basename(file))}`,
            }
        res.writeHead(200, headers)
        const stream = createReadStream(file)
        stream.on('error', () => { res.destroy() })
        stream.pipe(res)
      } catch (err) {
        try {
          res.writeHead(500).end('internal error')
        } catch { /* socket gone */ }
        try {
          const rawUrl = (req.url && String(req.url)) || ''
          if (rawUrl.includes('/visionforge/save-local')) {
            if (debugLogs) {
              mkdirSync(outDir, { recursive: true })
              appendFileSync(join(outDir, 'save-debug.log'), `${new Date().toISOString()} url=${rawUrl} err=${(err && err.stack) || err}\n`)
            }
          }
        } catch { /* logging is best-effort */ }
      }
    })
    let candidateIndex = 0
    const onListenSuccess = () => {
      const addr = server.address()
      renderServerPort = typeof addr === 'object' && addr ? addr.port : 0
      try {
        mkdirSync(outDir, { recursive: true })
        appendFileSync(join(outDir, 'server.log'), `${new Date().toISOString()} listen OK port=${renderServerPort}\n`)
      } catch { /* logging best-effort */ }
      void sweepCaches()
    }
    const onListenError = (e) => {
      console.error(`[visionforge] render server listen failed: ${(e && e.code) || e}`)
      try {
        mkdirSync(outDir, { recursive: true })
        appendFileSync(join(outDir, 'server.log'), `${new Date().toISOString()} listen failed code=${(e && e.code) || e} candidates=${candidateIndex}\n`)
      } catch { /* logging best-effort */ }
      if (e && e.code === 'EADDRINUSE') {
        candidateIndex += 1
        if (candidateIndex < LOOPBACK_PORTS.length) {
          server.removeAllListeners('error')
          server.once('error', onListenError)
          server.listen(LOOPBACK_PORTS[candidateIndex], '127.0.0.1', onListenSuccess)
        } else {
          server.removeAllListeners('error')
          server.once('error', () => { renderServer = null })
          server.listen(0, '127.0.0.1', onListenSuccess)
        }
      } else {
        renderServer = null
      }
    }
    server.once('error', onListenError)
    server.listen(LOOPBACK_PORTS[0], '127.0.0.1', onListenSuccess)
    renderServer = server
    return renderServerPort
  } catch {
    return 0
  }
}

// 等待本地预览服务监听完成（server.listen 是异步的）。重启后立即调用生图工具时，
// renderServerPort 可能还是 0，导致 previewMarkdown 没有本地图 URL / 保存按钮。
function waitRenderServer(timeoutMs = 2500) {
  return new Promise((resolve) => {
    if (renderServerPort > 0) return resolve(renderServerPort)
    try { startRenderServer() } catch { /* ignore */ }
    if (renderServerPort > 0) return resolve(renderServerPort)
    const t0 = Date.now()
    const timer = setInterval(() => {
      if (renderServerPort > 0 || Date.now() - t0 >= timeoutMs) {
        clearInterval(timer)
        resolve(renderServerPort)
      }
    }, 60)
  })
}

// ---- 设置页服务 ---------------------------------------------------------------
let settingsPort = 0
let settingsServer = null

const READ_FAMILIES = ['openai-compatible', 'anthropic', 'gemini', 'raw-base64']
const GEN_FAMILIES = ['', 'dashscope-image', 'openai-image', 'chat-native', 'google-imagen']

function persistConfigLocal(config) {
  mkdirSync(dirname(configPath()), { recursive: true })
  writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
}

/** 设置卡片提交的自定义引擎操作：add / save / remove。服务端护栏与 CLI 完全一致。 */
function applyCustomSettings(patch) {
  if (!patch || typeof patch !== 'object') throw new Error('custom patch must be an object')
  const config = readConfig()
  if (patch.action === 'remove') {
    const id = canonicalizeName(patch.name)
    if (!Object.hasOwn(config.customProviders ?? {}, id)) throw new Error(`自定义引擎「${id}」不存在`)
    delete config.customProviders[id]
    if (config.provider === id) config.provider = ''
    persistConfigLocal(config)
    return { removed: id }
  }
  if (patch.action !== 'add' && patch.action !== 'save') throw new Error('custom action must be add / save / remove')
  const id = canonicalizeName(patch.name)
  const existing = Object.hasOwn(config.customProviders ?? {}, id)
  const conflict = checkNameConflicts(id, config)
  if (conflict && (!existing || patch.action === 'add')) {
    throw new Error(conflict.message)
  }
  const baseUrl = typeof patch.baseUrl === 'string' ? patch.baseUrl.trim() : ''
  if (!baseUrl) throw new Error('接口地址不能为空')
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error('接口地址必须以 http:// 或 https:// 开头')
  const readFamily = typeof patch.readFamily === 'string' && READ_FAMILIES.includes(patch.readFamily)
    ? patch.readFamily
    : suggestFamilyFromBaseUrl(baseUrl).family || 'openai-compatible'
  if (patch.genFamily !== undefined && patch.genFamily !== '' && !GEN_FAMILIES.includes(patch.genFamily)) {
    throw new Error(`未知的生图协议族：${patch.genFamily}`)
  }
  const entry = config.customProviders?.[id] ?? {}
  const models = Array.isArray(entry.models) ? entry.models.map((m) => ({ ...m, capabilities: { ...m.capabilities } })) : []
  const setReadModel = (name) => {
    const idx = models.findIndex((m) => m.capabilities.read)
    if (idx >= 0) { models[idx] = { ...models[idx], name, capabilities: { ...models[idx].capabilities, read: true } } }
    else models.push({ name, capabilities: { read: true, generate: false, edit: false } })
  }
  const setGenModel = (name) => {
    const idx = models.findIndex((m) => m.capabilities.generate || m.capabilities.edit)
    if (idx >= 0) { models[idx] = { ...models[idx], name, capabilities: { ...models[idx].capabilities, generate: true } } }
    else models.push({ name, capabilities: { read: false, generate: true, edit: false } })
  }
  if (typeof patch.model === 'string' && patch.model.trim() !== '') setReadModel(patch.model.trim())
  if (typeof patch.genModel === 'string' && patch.genModel.trim() !== '') setGenModel(patch.genModel.trim())
  const displayName = typeof patch.displayName === 'string' && patch.displayName.trim() !== '' ? patch.displayName.trim() : (entry.displayName || id)
  const apiKey = typeof patch.apiKey === 'string' && patch.apiKey.trim() !== '' ? patch.apiKey.trim() : entry.apiKey
  const sizeCap = typeof patch.sizeCap === 'string' && patch.sizeCap.trim() !== '' ? patch.sizeCap.trim() : (typeof entry.sizeCap === 'string' ? entry.sizeCap : '')
  if (sizeCap !== '') { try { parseSizeCap(sizeCap) } catch (e) { throw new Error(e.message) } }
  // 修改配置即解除验证/失败状态
  const { verified: _v, failed: _f, ...restEntry } = entry
  config.customProviders ??= {}
  config.customProviders[id] = {
    ...restEntry,
    displayName,
    baseUrl,
    readFamily,
    ...(patch.genFamily ? { genFamily: patch.genFamily } : entry.genFamily ? { genFamily: entry.genFamily } : {}),
    ...(sizeCap ? { sizeCap } : {}),
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(models.length > 0 ? { models } : {}),
    ...(models.find((m) => m.capabilities.read) ? { model: models.find((m) => m.capabilities.read).name } : {}),
  }
  persistConfigLocal(config)
  return { saved: id, readFamily, conflict: conflict && existing ? { folded: conflict.folded, distance: conflict.distance } : undefined }
}

/** 内置 + 自定义引擎的完整列表（设置页渲染用）。 */
function allEngineMeta(config) {
  const engines = {}
  const settings = {}
  const providers = config.providers ?? {}
  for (const id of ENGINES) {
    const meta = ENGINE_META[id] ?? { label: id, baseUrl: '', models: [] }
    const stored = providers[id] ?? {}
    engines[id] = {
      label: meta.label,
      keyless: KEYLESS_ENGINES.includes(id),
      baseUrl: typeof meta.baseUrl === 'string' ? meta.baseUrl : '',
      models: Array.isArray(meta.models) ? meta.models : [],
    }
    settings[id] = {
      baseUrl: typeof stored.baseUrl === 'string' ? stored.baseUrl : '',
      model: typeof stored.model === 'string' ? stored.model : '',
      hasKey: hasKey(stored.apiKey),
      structuredOutput: typeof stored.structuredOutput === 'boolean' ? stored.structuredOutput : '',
      timeoutMs: typeof stored.timeoutMs === 'number' ? stored.timeoutMs : '',
      extraBody: typeof stored.extraBody === 'object' && stored.extraBody ? JSON.stringify(stored.extraBody) : '',
      requestTemplate: typeof stored.requestTemplate === 'object' && stored.requestTemplate ? JSON.stringify(stored.requestTemplate) : '',
      proxyMode: !Object.hasOwn(stored, 'proxy') ? 'inherit' : typeof stored.proxy === 'string' && stored.proxy.trim() === '' ? 'direct' : 'custom',
      proxy: typeof stored.proxy === 'string' ? stored.proxy : '',
    }
  }
  const customs = readCustomProviders(config)
  for (const entry of Object.values(customs)) {
    engines[entry.id] = {
      label: entry.displayName + '（自定义）',
      keyless: false,
      baseUrl: entry.baseUrl ?? '',
      models: (entry.models ?? []).map((m) => m.name),
    }
    settings[entry.id] = {
      baseUrl: entry.baseUrl ?? '',
      model: entry.model ?? '',
      hasKey: hasKey(entry.apiKey),
      structuredOutput: typeof entry.structuredOutput === 'boolean' ? entry.structuredOutput : '',
      timeoutMs: typeof entry.timeoutMs === 'number' ? entry.timeoutMs : '',
      extraBody: typeof entry.extraBody === 'object' && entry.extraBody ? JSON.stringify(entry.extraBody) : '',
      requestTemplate: typeof entry.requestTemplate === 'object' && entry.requestTemplate ? JSON.stringify(entry.requestTemplate) : '',
      proxyMode: !Object.hasOwn(entry, 'proxy') ? 'inherit' : typeof entry.proxy === 'string' && entry.proxy.trim() === '' ? 'direct' : 'custom',
      proxy: typeof entry.proxy === 'string' ? entry.proxy : '',
    }
  }
  return { engines, settings, customs }
}

function settingsPageHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>VisionForge 视觉引擎设置</title>
<style>
  :root { color-scheme: light dark }
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 600px; margin: 40px auto; padding: 0 20px; color: #222 }
  h1 { font-size: 20px; margin: 0 0 4px }
  .sub { font-size: 13px; color: #888; margin-bottom: 16px }
  .card { border: 1px solid rgba(76,111,255,.30); border-radius: 12px; padding: 20px; background: linear-gradient(180deg, rgba(76,111,255,.05), transparent) }
  label { display: block; font-size: 13px; font-weight: 600; margin: 14px 0 6px; color: #555 }
  input, select { width: 100%; padding: 8px 10px; border: 1px solid #ccc; border-radius: 8px; font: inherit; font-size: 13px; box-sizing: border-box; background: transparent; color: inherit }
  .hint { font-size: 12px; color: #999; margin-top: 5px }
  .mask { font-size: 13px; color: #0a7; margin-top: 5px; font-family: ui-monospace, Consolas, monospace; letter-spacing: 1px }
  button { margin-top: 20px; padding: 10px 26px; border: 0; border-radius: 8px; background: #1668dc; color: #fff; font: inherit; cursor: pointer }
  button:disabled { opacity: .5 }
  #msg { margin-top: 12px; font-size: 13px; min-height: 18px }
  .ok { color: #0a7 } .err { color: #c33 }
  .hidden { display: none }
</style>
<h1>VisionForge 视觉引擎设置</h1>
<div class="sub">视觉理解 + 图片生成。配置由你自己填写，保存在本地（~/.visionforge/config.json），不会上传</div>
<div id="lastRead" class="sub"></div>
<div class="card">
  <label>引擎（提供方）</label>
  <select id="engine"></select>
  <div id="engineCaps" class="hint"></div>
  <label>API 密钥</label>
  <input id="apiKey" placeholder="多个用英文逗号分隔，失败自动轮换" autocomplete="off">
  <div class="mask" id="hasKey"></div>
  <div class="hint" id="keyHint">留空 = 保持当前密钥不变；填入 = 覆盖（支持 sk-a,sk-b 多 key）</div>
  <label>接口地址</label>
  <input id="baseUrl">
  <label>模型</label>
  <select id="model"></select>
  <input id="modelCustom" class="hidden" placeholder="输入模型名，例如 qwen3.8-max">
  <label>解析优先级</label>
  <select id="visionPriority">
    <option value="official">官方优先（默认）</option>
    <option value="plugin">插件优先</option>
  </select>
  <div class="hint">官方优先：官方视觉模型能看图时先解析，不能时自动走插件；插件优先：始终先用你配置的提供商密钥，全部失败才试官方</div>
  <details id="advanced" style="margin-top:10px;border-top:1px solid rgba(128,128,128,.25);padding-top:6px">
    <summary style="cursor:pointer;font-size:13px;color:#7ab;user-select:none;padding:4px 0">开发者选项（响应格式 / 超时 / 代理 / 请求体扩展 / 输出目录 / 粘贴 / 日志 / 增强）</summary>
    <div style="padding-top:6px">
      <label>响应格式（structuredOutput）</label>
      <select id="structuredOutput">
        <option value="">跟随引擎（默认）</option>
        <option value="true">强制结构化输出（读图时要求网关按视觉 JSON schema 返回）</option>
        <option value="false">关闭</option>
      </select>
      <div class="hint">默认关闭；仅 OpenAI 兼容网关支持时开启，不支持的网关会返回 400</div>
      <label>请求超时（毫秒）</label>
      <input id="timeoutMs" placeholder="留空 = 引擎默认（读图约 60s，生图约 120s）">
      <label>代理模式</label>
      <select id="proxyMode">
        <option value="inherit">继承全局（默认）</option>
        <option value="direct">强制直连</option>
        <option value="custom">自定义代理</option>
      </select>
      <input id="proxy" placeholder="http://127.0.0.1:7890（代理模式选「自定义代理」时填写）">
      <label>请求体扩展（extraBody JSON）</label>
      <textarea id="extraBody" rows="2" placeholder='{"thinking":{"type":"disabled"}}（厂商特殊开关；留空 = 无）'></textarea>
      <label>图片输出目录</label>
      <input id="outputDir" placeholder="留空 = 默认（D:\VisionForge\out）">
      <label>粘贴转路径（智能接管）</label>
      <select id="pasteToPath">
        <option value="true">开启</option>
        <option value="false">关闭</option>
      </select>
      <label>调试日志（排障用）</label>
      <select id="debugLogs">
        <option value="true">开启</option>
        <option value="false">关闭（默认）</option>
      </select>
      <label>图生图提示词自动增强</label>
      <select id="enhanceEditPrompt">
        <option value="true">开启（推荐）</option>
        <option value="false">关闭</option>
      </select>
      <div class="hint">简短指令（如"让两人拥抱"）自动追加保护约束：保持面部特征、肢体自然、不加水印；你明确要求改某项时自动跳过对应约束</div>
      <div style="border-top:1px dashed rgba(128,128,128,.35);margin-top:10px;padding-top:8px">
        <label>自定义请求模板（官方 JSON 兜底）</label>
        <div class="hint">仅当该引擎的请求格式与内置协议族（OpenAI 兼容 / Anthropic / Gemini / 原生）不兼容时使用。从引擎官网复制「请求 / 响应示例 JSON」粘贴到下方，点「自动生成模板」得到占位符模板（{{PROMPT}} / {{IMAGE1}} / {{MODEL}} / {{API_KEY}} 等），可再手改后保存；尺寸占位符：{{SIZE}}（内部原文）、{{SIZE_X}}（1024x1024，多数引擎）、{{SIZE_STAR}}（1024*1024，千问系）；{{COUNT}}/{{SIZE}} 整节点出现时自动保持数字类型。留空 = 关闭</div>
        <label>读图请求示例（官方 JSON）</label>
        <textarea id="rtReadSample" rows="4" placeholder='{"url":"https://api.xxx.com/chat/completions","headers":{"Authorization":"Bearer sk-..."},"body":{"model":"...","messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"data:image/png;base64,..."}},{"type":"text","text":"请描述这张图片"}]}]}}'></textarea>
        <button type="button" id="rtReadInfer" style="margin-top:6px">自动生成读图模板</button>
        <label>生图请求示例（官方 JSON）</label>
        <textarea id="rtGenSample" rows="4" placeholder='{"url":"https://api.xxx.com/images/generations","headers":{"Authorization":"Bearer sk-..."},"body":{"model":"...","prompt":"一只猫","size":"1024x1024","n":1}}'></textarea>
        <button type="button" id="rtGenInfer" style="margin-top:6px">自动生成生图模板</button>
        <label>生图响应示例（官方 JSON）</label>
        <textarea id="rtRespSample" rows="3" placeholder='{"data":[{"url":"https://cdn.xxx.com/a.png"}]}'></textarea>
        <button type="button" id="rtRespInfer" style="margin-top:6px">自动生成响应提取路径</button>
        <label>模板 JSON（可编辑；留空 = 关闭自定义模板）</label>
        <textarea id="rtTemplate" rows="6" placeholder='{"enabled":true,"read":{...},"generate":{...},"extract":{...}}'></textarea>
        <label>启用自定义模板</label>
        <select id="rtEnabled">
          <option value="true">开启</option>
          <option value="false">关闭</option>
        </select>
      </div>
    </div>
  </details>
  <details id="cacheManage" style="margin-top:10px;border-top:1px solid rgba(128,128,128,.25);padding-top:6px">
    <summary style="cursor:pointer;font-size:13px;color:#7ab;user-select:none;padding:4px 0">缓存管理（生成图 / 粘贴 / 特征摘要）</summary>
    <div style="padding-top:6px">
      <div id="cacheInfo" class="hint">正在统计缓存占用…</div>
      <button id="cacheClean" type="button" style="margin-top:6px">立即清理（保留当前会话中的图片）</button>
      <div class="hint">一键清理会删除生成图 / 粘贴缓存与全部特征摘要；当前会话生成的图片会保留，不影响对话内放大 / 下载</div>
    </div>
  </details>
  <button id="save">保存</button>
  <div id="msg"></div>
</div>
<div class="card" id="customCard">
  <h1 style="font-size:16px;margin-bottom:4px">自定义引擎（翻译器）</h1>
  <div class="sub">添加任意厂商引擎（Google Gemini、Imagen、OpenAI 兼容网关等），无需改代码即可读图 / 生图 / 编辑。名称会自动规范化</div>
  <div id="customList" class="sub"></div>
  <button id="toggleAddCustom" type="button" style="margin-top:8px">+ 添加 / 编辑自定义引擎</button>
  <div id="addCustom" class="hidden">
    <label>引擎名称</label>
    <input id="cName" placeholder="例如 google" autocomplete="off">
    <div class="hint" id="cNameHint">自动规范为小写字母、数字、-、_、.（最长 40 字符）；与内置引擎重名会被拒绝</div>
    <label>显示名称（可选）</label>
    <input id="cDisplay" placeholder="例如 Google Gemini">
    <div class="hint">添加后请在上方引擎列表中选择该引擎，在下方填写接口地址、API 密钥与模型，再点「保存」即可生效（协议族由接口地址自动识别）</div>
    <div id="cMsg"></div>
    <button id="saveCustom">添加引擎</button>
  </div>
</div>
<script>
  var msg = document.getElementById('msg')
  var DATA = null
  function hasKeyFor(id) { return DATA.settings[id] ? DATA.settings[id].hasKey : false }
  function eng(id) { return DATA.engines[id] }
  function rebuildModels(id, currentModel) {
    var sel = document.getElementById('model')
    var list = eng(id).models || []
    sel.innerHTML = ''
    var found = false
    for (var i = 0; i < list.length; i++) {
      var op = document.createElement('option')
      op.value = list[i]; op.textContent = list[i]
      if (currentModel && currentModel === list[i]) { op.selected = true; found = true }
      sel.appendChild(op)
    }
    var custom = document.createElement('option')
    custom.value = '__custom__'
    custom.textContent = '自定义…'
    if (currentModel && !found) { custom.selected = true }
    sel.appendChild(custom)
    var box = document.getElementById('modelCustom')
    if (currentModel && !list.includes(currentModel)) { box.classList.remove('hidden'); box.value = currentModel }
    else { box.classList.add('hidden'); box.value = '' }
  }
  function renderEngine(id) {
    var meta = eng(id)
    document.getElementById('engine').value = id
    var capsEl = document.getElementById('engineCaps')
    if (meta && meta.caps) {
      var c = meta.caps
      capsEl.textContent = '能力：' + (c.read ? '✓ 读图' : '✗ 读图') + ' / ' + (c.generate ? '✓ 生图' : '✗ 生图') + ' / ' + (c.edit ? '✓ 编辑' : '✗ 编辑') + (meta.maxRes ? ' · 最高 ' + meta.maxRes : '') + (meta.keyless ? ' · 免密钥' : '')
    } else { capsEl.textContent = '' }
    var isKeyless = meta.keyless
    var keyInput = document.getElementById('apiKey')
    keyInput.classList.toggle('hidden', isKeyless)
    document.getElementById('keyHint').classList.toggle('hidden', isKeyless)
    var maskEl = document.getElementById('hasKey')
    if (isKeyless) { maskEl.textContent = '✓ 此引擎通过登录使用，无需密钥'; keyInput.value = '' }
    else if (hasKeyFor(id)) { keyInput.value = '••••••'; maskEl.textContent = '已配置密钥（掩码显示，点击输入框可替换）' }
    else { keyInput.value = ''; maskEl.textContent = '未配置密钥' }
    var stored = DATA.settings[id] || {}
    document.getElementById('baseUrl').value = (stored.baseUrl !== undefined && stored.baseUrl !== '') ? stored.baseUrl : (meta.baseUrl || '')
    rebuildModels(id, stored.model || '')
    var soEl = document.getElementById('structuredOutput')
    if (soEl) soEl.value = stored.structuredOutput === '' ? '' : String(stored.structuredOutput)
    var tmEl = document.getElementById('timeoutMs')
    if (tmEl) tmEl.value = typeof stored.timeoutMs === 'number' ? String(stored.timeoutMs) : ''
    var ebEl = document.getElementById('extraBody')
    if (ebEl) ebEl.value = typeof stored.extraBody === 'string' ? stored.extraBody : ''
    var pmEl = document.getElementById('proxyMode')
    if (pmEl) pmEl.value = stored.proxyMode || 'inherit'
    var pxEl = document.getElementById('proxy')
    if (pxEl) pxEl.value = typeof stored.proxy === 'string' ? stored.proxy : ''
    var rtEl = document.getElementById('rtTemplate')
    if (rtEl) rtEl.value = typeof stored.requestTemplate === 'string' ? stored.requestTemplate : ''
    var rteEl = document.getElementById('rtEnabled')
    if (rteEl) {
      var rtObj = null
      try { rtObj = stored.requestTemplate ? JSON.parse(stored.requestTemplate) : null } catch (e) {}
      rteEl.value = rtObj && rtObj.enabled === false ? 'false' : 'true'
    }
  }
  ;(async function () {
    try {
      var r = await fetch('/visionforge/settings/api')
      DATA = await r.json()
      var sel = document.getElementById('engine')
      sel.innerHTML = ''
      var keys = Object.keys(DATA.engines)
      for (var i = 0; i < keys.length; i++) {
        var op = document.createElement('option')
        op.value = keys[i]; op.textContent = DATA.engines[keys[i]].label + capSuffix(DATA.engines[keys[i]])
        sel.appendChild(op)
      }
      sel.onchange = function () { renderEngine(this.value) }
      function capSuffix(meta) {
        var c = meta.caps || {}
        var s = []
        if (c.read) s.push('读图')
        if (c.generate) s.push('生图')
        if (c.edit) s.push('编辑')
        var base = s.join('·')
        if (meta.maxRes) base = base ? base + '·最高' + meta.maxRes : '最高' + meta.maxRes
        return base ? '（' + base + '）' : ''
      }
      document.getElementById('visionPriority').value = DATA.visionPriority || 'official'
      document.getElementById('outputDir').value = DATA.outputDir || ''
      document.getElementById('enhanceEditPrompt').value = DATA.enhanceEditPrompt === false ? 'false' : 'true'
      document.getElementById('pasteToPath').value = DATA.pasteToPath ? 'true' : 'false'
      document.getElementById('debugLogs').value = DATA.debugLogs ? 'true' : 'false'
      var lr = DATA.lastRead
      var lrEl = document.getElementById('lastRead')
      if (lr && lr.provider) {
        lrEl.textContent = '最近一次读图引擎：' + lr.provider + (lr.model ? '（' + lr.model + '）' : '') + (lr.at ? ' · ' + new Date(lr.at).toLocaleString() : '')
      } else {
        lrEl.textContent = '最近一次读图引擎：暂无记录（完成一次读图后显示）'
      }
      renderEngine(DATA.current || 'qwen')
      initCustom()
    } catch (e) { msg.textContent = '加载当前配置失败：' + e.message; msg.className = 'err' }
  })()
  var fmtBytes = function (b) {
    if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB'
    if (b >= 1024) return (b / 1024).toFixed(1) + ' KB'
    return b + ' B'
  }
  function refreshCache() {
    fetch('/visionforge/cache/stats').then(function (r) { return r.json() }).then(function (st) {
      var el = document.getElementById('cacheInfo')
      if (!el) return
      el.textContent = '输出目录：' + (st.outDir || '') + ' ｜ 生成图 ' + st.outCount + ' 个（' + fmtBytes(st.outBytes) + '）｜ 粘贴 ' + st.pasteCount + ' 个（' + fmtBytes(st.pasteBytes) + '）｜ 特征摘要 ' + st.featCount + ' 个（' + fmtBytes(st.featBytes) + '）｜ 合计 ' + fmtBytes(st.totalBytes)
    }).catch(function () {})
  }
  refreshCache()
  var cacheCleanBtn = document.getElementById('cacheClean')
  if (cacheCleanBtn) {
    cacheCleanBtn.onclick = function () {
      var b = this
      b.disabled = true
      fetch('/visionforge/cache/clean', { method: 'POST' }).then(function (r) { return r.json() }).then(function (res) {
        var info = document.getElementById('cacheInfo')
        if (info) info.textContent = '已清理生成图/粘贴 ' + res.removed + ' 个（释放 ' + fmtBytes(res.freed) + '）＋特征摘要 ' + res.featRemoved + ' 个（释放 ' + fmtBytes(res.featFreed) + '）' + (res.kept ? '；保留当前会话图片 ' + res.kept + ' 张' : '')
        refreshCache()
      }).catch(function (e) {
        var m = document.getElementById('msg')
        if (m) { m.textContent = '清理失败：' + e.message; m.className = 'err' }
      }).finally(function () { b.disabled = false })
    }
  }
  document.getElementById('apiKey').onfocus = function () {
    if (this.value === '••••••') this.value = ''
  }
  document.getElementById('model').onchange = function () {
    var box = document.getElementById('modelCustom')
    if (this.value === '__custom__') { box.classList.remove('hidden'); box.focus() }
    else { box.classList.add('hidden'); box.value = '' }
  }
  document.getElementById('save').onclick = async function () {
    var b = this; b.disabled = true; msg.textContent = '保存中…'; msg.className = ''
    try {
      var engineId = document.getElementById('engine').value
      var modelSel = document.getElementById('model')
      var model = modelSel.value === '__custom__' ? document.getElementById('modelCustom').value.trim() : modelSel.value
      var keyVal = document.getElementById('apiKey').value.trim()
      var body = {
        provider: engineId,
        engine: engineId,
        baseUrl: document.getElementById('baseUrl').value.trim(),
        model: model,
        visionPriority: document.getElementById('visionPriority').value,
        outputDir: document.getElementById('outputDir').value.trim(),
        enhanceEditPrompt: document.getElementById('enhanceEditPrompt').value === 'true',
        pasteToPath: document.getElementById('pasteToPath').value === 'true',
        debugLogs: document.getElementById('debugLogs').value === 'true',
        structuredOutput: (function () { var v = document.getElementById('structuredOutput').value; return v === '' ? undefined : v === 'true' })(),
        timeoutMs: document.getElementById('timeoutMs').value.trim(),
        extraBody: document.getElementById('extraBody').value,
        proxyMode: document.getElementById('proxyMode').value,
        proxy: document.getElementById('proxy').value.trim(),
        requestTemplate: (function () {
          var raw = document.getElementById('rtTemplate').value.trim()
          if (raw === '') return undefined
          try {
            var o = JSON.parse(raw)
            if (o && typeof o === 'object') { o.enabled = document.getElementById('rtEnabled').value === 'true' }
            return o
          } catch (e) { return raw }
        })()
      }
      if (keyVal !== '' && keyVal !== '••••••') body.apiKey = keyVal
      var r = await fetch('/visionforge/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      var j = await r.json()
      if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status))
      msg.textContent = '✓ 已保存'; msg.className = 'ok'
      document.getElementById('apiKey').value = ''
      DATA = await (await fetch('/visionforge/settings/api')).json()
      renderEngine(engineId)
    } catch (e) { msg.textContent = '保存失败：' + e.message; msg.className = 'err' }
    b.disabled = false
  }
  function inferTemplate(kind, sampleEl, targetEl, msgEl) {
    var sample = sampleEl.value.trim()
    if (!sample) { msgEl.textContent = '请先粘贴官方 JSON 示例'; msgEl.className = 'err'; return }
    var body
    try { body = JSON.parse(sample) } catch (e) { msgEl.textContent = '示例不是合法 JSON：' + e.message; msgEl.className = 'err'; return }
    fetch('/visionforge/settings/infer-template', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: kind, sample: body }) })
      .then(function (r) { return r.json() })
      .then(function (res) {
        if (!res.ok) { msgEl.textContent = '推断失败：' + (res.error || ''); msgEl.className = 'err'; return }
        var out = res.template
        if (out === null || out === undefined || (Array.isArray(out) && out.length === 0)) {
          msgEl.textContent = '未能识别示例中的可变字段，请手动填写模板 JSON'; msgEl.className = 'err'; return
        }
        var prev = null
        try { prev = JSON.parse(document.getElementById('rtTemplate').value || 'null') } catch (e) {}
        var merged = prev && typeof prev === 'object' ? prev : {}
        if (kind === 'read') { merged.read = out }
        else if (kind === 'generate') { merged.generate = out }
        else if (kind === 'extract') { if (!merged.extract || typeof merged.extract !== 'object') merged.extract = {}; merged.extract.generate = { images: out } }
        document.getElementById('rtTemplate').value = JSON.stringify(merged, null, 2)
        msgEl.textContent = '已生成模板（可再编辑后保存）'; msgEl.className = 'ok'
      })
      .catch(function (e) { msgEl.textContent = '推断请求失败：' + e.message; msgEl.className = 'err' })
  }
  var rtReadBtn = document.getElementById('rtReadInfer')
  if (rtReadBtn) rtReadBtn.onclick = function () { inferTemplate('read', document.getElementById('rtReadSample'), document.getElementById('rtTemplate'), msg) }
  var rtGenBtn = document.getElementById('rtGenInfer')
  if (rtGenBtn) rtGenBtn.onclick = function () { inferTemplate('generate', document.getElementById('rtGenSample'), document.getElementById('rtTemplate'), msg) }
  var rtRespBtn = document.getElementById('rtRespInfer')
  if (rtRespBtn) rtRespBtn.onclick = function () { inferTemplate('extract', document.getElementById('rtRespSample'), document.getElementById('rtTemplate'), msg) }
  // ---- 自定义引擎（翻译器）----
  var cMsg = document.getElementById('cMsg')
  var editingCustom = null
  var DOMAIN_HINTS = [
    { re: /generativelanguage|googleapis\.com/, family: 'gemini' },
    { re: /anthropic\.com/, family: 'anthropic' },
    { re: /openai\.com|azure\.com|qianwen|dashscope|bigmodel|deepseek|moonshot|z\.ai|siliconflow|openrouter|groq|mistral|together/, family: 'openai-compatible' }
  ]
  function familyFromUrl(url) {
    for (var i = 0; i < DOMAIN_HINTS.length; i++) {
      if (DOMAIN_HINTS[i].re.test(url || '')) return DOMAIN_HINTS[i].family
    }
    return ''
  }
  function levenshtein(a, b) {
    var m = a.length, n = b.length
    var dp = new Array(n + 1)
    for (var j = 0; j <= n; j++) dp[j] = j
    for (var i = 1; i <= m; i++) {
      var prev = dp[0]; dp[0] = i
      for (var j = 1; j <= n; j++) {
        var tmp = dp[j]
        dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
        prev = tmp
      }
    }
    return dp[n]
  }
  function normalizeName(raw) {
    return (raw || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '').replace(/^[^a-z0-9]+/, '').slice(0, 40)
  }
  function nameHints(raw) {
    var id = normalizeName(raw)
    var hints = []
    if (!id) { hints.push({ text: '请输入引擎名称', err: false }); return hints }
    if (raw !== id) hints.push({ text: '已规范为：' + id, err: false })
    var builtin = Object.keys(DATA.engines).filter(function (k) { return !DATA.customs[k] })
    if (builtin.indexOf(id) >= 0 || DATA.customs[id]) {
      hints.push({ text: '「' + id + '」已存在（内置或自定义），请换一个名称', err: true })
    }
    var best = null
    for (var i = 0; i < builtin.length; i++) {
      var d = levenshtein(id, builtin[i])
      if (d > 0 && d <= 2 && (!best || d < best.d)) best = { name: builtin[i], d: d }
    }
    if (best) hints.push({ text: '与内置引擎「' + best.name + '」拼写相近（距离 ' + best.d + '）。如需使用内置引擎，请直接在上方选择；确认新增同名引擎可继续', err: false })
    return hints
  }
  function renderCustomList() {
    var el = document.getElementById('customList')
    var ids = Object.keys(DATA.customs)
    el.innerHTML = ids.length === 0
      ? '（暂无自定义引擎，点击上方按钮添加）'
      : ids.map(function (id) {
          var c = DATA.customs[id]
          var caps = []
          if (c.models.some(function (m) { return m.capabilities.read })) caps.push('读图')
          if (c.models.some(function (m) { return m.capabilities.generate || m.capabilities.edit })) caps.push('生图')
          return '• ' + c.displayName + '（' + id + '）· 读图:' + c.readFamily + (c.genFamily ? ' · 生图:' + c.genFamily : '') + (caps.length ? ' · ' + caps.join('/') : '') + ' · ' + (c.apiKey ? '密钥已配置' : '密钥未配置') + ' <a href="#" data-remove="' + id + '">删除</a>'
        }).join('<br>')
    el.querySelectorAll('a[data-remove]').forEach(function (a) {
      a.onclick = function (e) {
        e.preventDefault()
        if (!confirm('确定删除自定义引擎「' + a.getAttribute('data-remove') + '」？')) return
        removeCustomEngine(a.getAttribute('data-remove'))
      }
    })
  }
  async function removeCustomEngine(id) {
    var b = this; cMsg.textContent = '删除中…'; cMsg.className = ''
    try {
      var r = await fetch('/visionforge/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ custom: { action: 'remove', name: id } }) })
      var j = await r.json()
      if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status))
      cMsg.textContent = '✓ 已删除引擎「' + id + '」'; cMsg.className = 'ok'
      DATA = await (await fetch('/visionforge/settings/api')).json()
      renderCustomList()
      renderEngine(document.getElementById('engine').value)
    } catch (e) { cMsg.textContent = '删除失败：' + e.message; cMsg.className = 'err' }
  }
  function openCustomEditor(entry, id) {
    editingCustom = id || null
    var box = document.getElementById('addCustom')
    box.classList.remove('hidden')
    document.getElementById('toggleAddCustom').textContent = editingCustom ? '收起编辑器' : '+ 添加自定义引擎'
    document.getElementById('cName').value = entry ? entry.id || '' : ''
    document.getElementById('cDisplay').value = entry ? entry.displayName || '' : ''
    document.getElementById('cNameHint').textContent = '自动规范为小写字母、数字、-、_、.（最长 40 字符）'
    cMsg.textContent = ''
    if (editingCustom) document.getElementById('cName').setAttribute('readonly', 'readonly')
    else document.getElementById('cName').removeAttribute('readonly')
    box.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  document.getElementById('toggleAddCustom').onclick = function () {
    var box = document.getElementById('addCustom')
    if (!box.classList.contains('hidden')) { box.classList.add('hidden'); return }
    openCustomEditor(null)
  }
  document.getElementById('cName').oninput = function () {
    var hints = nameHints(this.value)
    document.getElementById('cNameHint').textContent = hints.map(function (h) { return h.text }).join('；')
    document.getElementById('cNameHint').style.color = hints.some(function (h) { return h.err }) ? '#c33' : '#999'
  }
  document.getElementById('saveCustom').onclick = async function () {
    var b = this; b.disabled = true; cMsg.textContent = '保存中…'; cMsg.className = ''
    try {
      var id = normalizeName(document.getElementById('cName').value)
      if (!id) throw new Error('请填写引擎名称')
      var builtin = Object.keys(DATA.engines).filter(function (k) { return !DATA.customs[k] })
      if (builtin.indexOf(id) >= 0 || DATA.customs[id]) throw new Error('「' + id + '」已存在（内置或自定义），请换一个名称')
      var displayName = document.getElementById('cDisplay').value.trim() || id
      // 前端注册进引擎下拉并选中；接口地址/密钥/模型在下方通用字段填写后由主「保存」落盘
      DATA.engines[id] = { label: displayName, models: [], caps: {}, custom: true }
      DATA.customs[id] = { id: id, displayName: displayName, models: [], readFamily: '', genFamily: '', apiKey: '' }
      var sel = document.getElementById('engine')
      sel.innerHTML = ''
      var keys = Object.keys(DATA.engines)
      for (var i = 0; i < keys.length; i++) {
        var op = document.createElement('option')
        op.value = keys[i]; op.textContent = DATA.engines[keys[i]].label + capSuffix(DATA.engines[keys[i]])
        sel.appendChild(op)
      }
      sel.value = id
      renderEngine(id)
      renderCustomList()
      document.getElementById('addCustom').classList.add('hidden')
      document.getElementById('toggleAddCustom').textContent = '+ 添加自定义引擎'
      cMsg.textContent = '✓ 已添加引擎「' + id + '」，请在下方填写接口地址、API 密钥与模型后点「保存」'; cMsg.className = 'ok'
    } catch (e) { cMsg.textContent = '添加失败：' + e.message; cMsg.className = 'err' }
    b.disabled = false
  }
  // 初始化自定义引擎列表（DATA 加载后调用）
  var initCustom = function () {
    if (!DATA) return
    renderCustomList()
  }
</script>
`;
}

function startSettingsServer() {
  if (settingsServer !== null) return Promise.resolve(settingsPort)
  return new Promise((resolveP) => {
    try {
      const server = createServer((req, res) => {
        const sendJson = (status, body) => {
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(body))
        }
        try {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          if (url.pathname === '/visionforge/settings' && req.method === 'GET') {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
            res.end(settingsPageHtml())
            return
          }
          if (url.pathname === '/visionforge/settings/api' && req.method === 'GET') {
            let config = {}
            try { config = readConfig() } catch { config = {} }
            const current = config.provider !== undefined && (ENGINES.includes(config.provider) || Object.hasOwn(config.customProviders ?? {}, config.provider))
              ? config.provider
              : 'qwen'
            const { engines, settings, customs } = allEngineMeta(config)
            sendJson(200, {
              engines,
              settings,
              customs,
              readFamilies: READ_FAMILIES,
              genFamilies: GEN_FAMILIES,
              current,
              visionPriority: config.visionPriority === 'plugin' ? 'plugin' : 'official',
              outputDir: typeof config.outputDir === 'string' && config.outputDir.trim() !== '' ? config.outputDir : outputDir(),
              pasteToPath: config.pasteToPath !== false,
              debugLogs: config.debugLogs === true,
              lastRead: (() => { try { return JSON.parse(readFileSync(join(homedir(), '.visionforge', 'last-read.json'), 'utf8')) } catch { return null } })(),
            })
            return
          }
          if (url.pathname === '/visionforge/cache/stats' && req.method === 'GET') {
            cacheStats().then((stats) => sendJson(200, stats)).catch((e) => sendJson(500, { error: String(e.message || e) }))
            return
          }
          if (url.pathname === '/visionforge/cache/clean' && req.method === 'POST') {
            ;(async () => {
              const { removed, freed } = await sweepCaches(Date.now(), 0, sessionTracked)
              let featRemoved = 0
              let featFreed = 0
              try {
                const { readdir, stat, rm } = await import('node:fs/promises')
                const featuresDir = join(dirname(resolve(outputDir())), 'features')
                for (const entry of await readdir(featuresDir, { withFileTypes: true })) {
                  if (!entry.isFile()) continue
                  const full = join(featuresDir, entry.name)
                  try { const info = await stat(full); await rm(full, { force: true }); featRemoved++; featFreed += info.size } catch { /* best-effort */ }
                }
              } catch { /* best-effort */ }
              const stats = await cacheStats()
              sendJson(200, { removed, freed, featRemoved, featFreed, kept: sessionTracked.size, stats })
            })().catch((e) => sendJson(500, { error: String(e.message || e) }))
            return
          }
          if (url.pathname === '/visionforge/settings/infer-template' && req.method === 'POST') {
            const chunks = []
            let total = 0
            ;(async () => {
              for await (const chunk of req) {
                total += chunk.length
                if (total > 256 * 1024) { sendJson(413, { error: 'payload too large' }); req.destroy(); return }
                chunks.push(chunk)
              }
              const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
              const kind = payload.kind
              const sample = payload.sample
              if (!sample || typeof sample !== 'object') { sendJson(400, { error: 'missing sample' }); return }
              let template = null
              if (kind === 'read') template = inferReadRequestTemplate(sample)
              else if (kind === 'generate') template = inferGenRequestTemplate(sample)
              else if (kind === 'extract') template = inferGenImagePaths(sample)
              else if (kind === 'extract-read') template = { path: inferReadContentPath(sample) }
              else { sendJson(400, { error: 'unknown kind: ' + kind }); return }
              sendJson(200, { ok: true, template })
            })().catch((e) => sendJson(500, { error: String(e.message || e) }))
            return
          }
          if (url.pathname === '/visionforge/settings' && req.method === 'POST') {
            const chunks = []
            let total = 0
            ;(async () => {
              for await (const chunk of req) {
                total += chunk.length
                if (total > 64 * 1024) { sendJson(413, { error: 'payload too large' }); req.destroy(); return }
                chunks.push(chunk)
              }
              const patch = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
              if (patch.custom) {
                const result = applyCustomSettings(patch.custom)
                sendJson(200, { ok: true, ...result })
                return
              }
              const engineId = typeof patch.provider === 'string' && (ENGINES.includes(patch.provider) || Object.hasOwn(readConfig().customProviders ?? {}, patch.provider))
                ? patch.provider
                : (typeof patch.engine === 'string' && (ENGINES.includes(patch.engine) || Object.hasOwn(readConfig().customProviders ?? {}, patch.engine)) ? patch.engine : undefined)
              const enginePatch = {}
              if (engineId !== undefined) {
                enginePatch.provider = engineId
                enginePatch.engine = engineId
                if (typeof patch.apiKey === 'string' && patch.apiKey.trim() !== '') enginePatch.apiKey = patch.apiKey.trim()
                if (typeof patch.baseUrl === 'string') enginePatch.baseUrl = patch.baseUrl.trim()
                if (typeof patch.model === 'string') enginePatch.model = patch.model.trim()
              }
              if (patch.visionPriority === 'official' || patch.visionPriority === 'plugin') enginePatch.visionPriority = patch.visionPriority
              if (typeof patch.outputDir === 'string') enginePatch.outputDir = patch.outputDir.trim()
              if (typeof patch.pasteToPath === 'boolean') enginePatch.pasteToPath = patch.pasteToPath
              if (typeof patch.debugLogs === 'boolean') enginePatch.debugLogs = patch.debugLogs
              applySettings(enginePatch)
              sendJson(200, { ok: true })
            })().catch((error) => sendJson(400, { error: String(error?.message ?? error) }))
            return
          }
          res.writeHead(404).end('not found')
        } catch (error) {
          try { sendJson(500, { error: String(error?.message ?? error) }) } catch { /* socket gone */ }
        }
      })
      server.listen(0, '127.0.0.1', () => {
        settingsPort = server.address().port
        settingsServer = server
        resolveP(settingsPort)
      })
      server.on('error', () => { settingsServer = null; resolveP(0) })
    } catch {
      resolveP(0)
    }
  })
}

function openInBrowser(target) {
  try {
    const raw = String(target)
    const fileUrl = /^https?:\/\//i.test(raw) ? raw : ('file:///' + encodeURI(raw.replace(/\\/g, '/')))
    const child = spawn('cmd.exe', ['/c', 'start', '', fileUrl], { detached: true, stdio: 'ignore' })
    child.unref()
    return '已在浏览器中打开：' + target
  } catch {
    return null
  }
}

// ---- 粘贴判定与存储 ------------------------------------------------------------
const recentPastePaths = []
const PASTE_SNIFFS = [
  { ext: '.png', test: (b) => b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a },
  { ext: '.jpg', test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: '.gif', test: (b) => b.length >= 6 && ['GIF87a', 'GIF89a'].includes(b.toString('ascii', 0, 6)) },
  { ext: '.webp', test: (b) => b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
  { ext: '.heic', test: (b) => b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp' && ['heic', 'heix', 'hevc', 'hevx'].includes(b.toString('ascii', 8, 12)) },
  { ext: '.heif', test: (b) => b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp' && ['mif1', 'msf1', 'heif'].includes(b.toString('ascii', 8, 12)) },
]

async function ensurePasteDir() {
  const { mkdir, lstat, realpath } = await import('node:fs/promises')
  let root
  try {
    const out = outputDir()
    if (typeof out === 'string' && out.trim() !== '') root = join(resolve(out.trim()), 'paste')
  } catch { /* fall through */ }
  if (!root) root = join(homedir(), '.visionforge', 'out', 'paste')
  const parent = dirname(root)
  await mkdir(parent, { recursive: true }).catch(() => {})
  let realParent
  try {
    realParent = await realpath(parent)
  } catch (error) {
    throw new Error(`${parent} is not usable for the paste store: ${error?.message ?? error}`)
  }
  const target = join(realParent, basename(root))
  try {
    await mkdir(target, { mode: 0o700 })
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }
  const info = await lstat(target)
  if (!info.isDirectory()) throw new Error(`${target} exists and is not a directory`)
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (uid !== undefined) {
    if (info.uid !== uid) throw new Error(`${target} belongs to another user`)
    if ((info.mode & 0o777) !== 0o700) {
      const { chmod } = await import('node:fs/promises')
      await chmod(target, 0o700)
      const after = await lstat(target)
      if ((after.mode & 0o777) !== 0o700) throw new Error(`${target} could not be made private`)
    }
  }
  return target
}

async function savePasteBytes(buffer) {
  const { randomBytes } = await import('node:crypto')
  const { writeFile } = await import('node:fs/promises')
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('empty paste body')
  if (buffer.length > PASTE_MAX_BYTES) throw new Error('paste too large')
  const sniff = PASTE_SNIFFS.find((s) => s.test(buffer))
  if (!sniff) throw new Error('not a supported image')
  const dir = await ensurePasteDir()
  const name = `p-${Date.now()}-${randomBytes(4).toString('hex')}${sniff.ext}`
  const file = join(dir, name)
  await writeFile(file, buffer, { mode: 0o600 })
  recentPastePaths.push(file)
  if (recentPastePaths.length > RECENT_PASTE_CAP) recentPastePaths.shift()
  sessionTracked.add(resolve(file))
  return file
}

function isLoopbackHost(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function trustedRequest(req) {
  const host = req.headers?.host
  if (typeof host !== 'string' || host === '') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLoopbackHost(hostUrl.hostname)) return false
  if (req.headers?.['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers?.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

// ---- 工具定义 ------------------------------------------------------------------
function abortable(promise, signal) {
  if (!signal) return promise
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error('aborted'))
      return
    }
    const onAbort = () => reject(signal.reason ?? new Error('aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}

function makeReadTool(toolName, recentPastePathsRef, toolCache) {
  return {
    name: toolName,
    description:
      'Read an image through the VisionForge vision bridge. Use whenever a message references an image the current model cannot see: a local file path or an http(s) URL to a screenshot, photo, chart, diagram, or document scan. Returns structured evidence with every word transcribed (ocr.full_text), layout regions in reading order, semantics, and an uncertainty list. Quote the evidence instead of guessing. For the same image and focus, call this tool once and reuse its returned evidence instead of calling again. Scheduling: when the user set visionPriority=plugin (their own keys first), and the message carries an image pasted into the composer, call this tool first with source:"auto" (reads that image) and quote its evidence; only if this tool fails, analyze the image attachment directly. When visionPriority=official, analyze the image attachment directly first; only if the model cannot see it, call this tool with source:"auto" or an explicit "path". Requires a configured VisionForge engine (run `npx @lr611/visionforge doctor` in a terminal to check).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute local file path or http(s) URL of the image. Omit when using source="auto".' },
        source: { type: 'string', enum: ['path', 'auto'], description: 'path (default): read the image given in "path". auto: read the most recently pasted image in the composer (no path needed).' },
        prompt: { type: 'string', description: 'Optional extra focus for the reading (e.g. "focus on the axis labels")' },
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderEvidenceText(value) }],
    },
    timeoutMs: CLI_TIMEOUT_MS + 20_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({
      card: 'generic',
      title: toolName,
      kind: 'read',
      rawInput: args,
      ...(typeof args?.path === 'string' && args?.source !== 'auto' && !/^https?:\/\//i.test(args.path) ? { locations: [{ path: args.path }] } : {}),
    }),
    async execute(args, exec) {
      let path = args?.path
      // 容错：agent 可能把数组序列化成字符串传入（如 "[\"D:\\...jpg\"]"），解析成数组后取第一个。
      if (typeof path === 'string') {
        const t = path.trim()
        if (t.startsWith('[') && t.endsWith(']')) {
          try {
            const parsed = JSON.parse(t)
            if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'string') path = parsed[0]
          } catch { /* keep as string */ }
        }
      }
      if (args?.source === 'auto') {
        if (recentPastePathsRef.length === 0) {
          throw new Error(`${toolName} source:"auto" has no recent pasted image — paste an image into the composer first, or pass an explicit "path".`)
        }
        path = recentPastePathsRef[recentPastePathsRef.length - 1]
      }
      if (typeof path !== 'string' || path.trim() === '') {
        throw new Error(`${toolName} needs a non-empty string "path" (or source:"auto" for the most recent pasted image).`)
      }
      const sourceKey = /^https?:\/\//i.test(path) ? `remote:${path}` : `local:${resolve(path)}`
      const cacheKey = JSON.stringify([sourceKey, typeof args.prompt === 'string' ? args.prompt : ''])
      let pending = toolCache.get(cacheKey)
      if (pending === undefined) {
        const cliArgs = ['-i', path, '--timeout', String(CLI_TIMEOUT_MS)]
        if (args.prompt) cliArgs.push('--prompt', args.prompt)
        const run = (async () => {
          const sig = exec && (exec.signal || exec.abortSignal)
          const { stdout, stderr, code } = await runCli(cliArgs, sig)
          if (code !== 0) throw new Error(`visionforge failed (exit ${code}): ${(stderr || stdout).trim().slice(0, 500)}`)
          let parsed
          try {
            parsed = JSON.parse(stdout)
          } catch {
            throw new Error(`visionforge produced no JSON: ${stdout.trim().slice(0, 300)}`)
          }
          // 记录最近一次实际使用的引擎链（设置卡片回显用）
          try {
            const meta = parsed && parsed.meta && typeof parsed.meta === 'object' ? parsed.meta : {}
            const attempts = Array.isArray(meta.attempts) ? meta.attempts : []
            const last = attempts[attempts.length - 1]
            writeFileSync(join(homedir(), '.visionforge', 'last-read.json'), JSON.stringify({ at: new Date().toISOString(), provider: (last && last.provider) || '', model: (last && last.model) || '', attempts }, null, 2) + '\n', { mode: 0o600 })
          } catch { /* best-effort */ }
          // B4 特征摘要：从证据中提取人物/场景/风格摘要，落盘缓存 + 附加到返回结果，
          // 宿主构建图生图 prompt 时可直接引用（身份锚定），提升人物一致性
          const readResult = parsed && parsed.result && typeof parsed.result === 'object' ? parsed.result : {}
          try {
            const sem = readResult.semantics && typeof readResult.semantics === 'object' ? readResult.semantics : {}
            const vis = readResult.visual && typeof readResult.visual === 'object' ? readResult.visual : {}
            const ents = Array.isArray(sem.entities) ? sem.entities : []
            const people = ents.filter((e) => e && (String(e.type || '').toLowerCase().includes('person') || String(e.type || '').includes('人') || String(e.name || '').includes('人')))
            const parts = []
            if (sem.scene) parts.push(`场景：${sem.scene}`)
            if (people.length > 0) parts.push(`人物：${people.map((e) => e.evidence || e.name || '').filter(Boolean).join('；')}`)
            else if (ents.length > 0) parts.push(`主体：${ents.map((e) => e.evidence || e.name || '').filter(Boolean).join('；')}`)
            if (vis.style) parts.push(`风格：${vis.style}`)
            if (Array.isArray(vis.notes) && vis.notes.length > 0) parts.push(`细节：${vis.notes.join('；')}`)
            if (parts.length > 0) {
              const featureSummary = parts.join('。')
              const featuresDir = join(dirname(outputDir()), 'features')
              mkdirSync(featuresDir, { recursive: true })
              const hash = createHash('sha256').update(sourceKey).digest('hex').slice(0, 12)
              writeFileSync(join(featuresDir, `${hash}.json`), JSON.stringify({ at: new Date().toISOString(), path, featureSummary }, null, 2) + "\n", { mode: 0o600 })
              readResult.featureSummary = featureSummary
            }
          } catch { /* best-effort */ }
          return readResult
        })()
        toolCache.set(cacheKey, run)
        run.catch(() => { toolCache.delete(cacheKey) })
        pending = run
      }
      return structuredClone(await abortable(pending, exec && exec.signal))
    },
  }
}

function makeGenTool(toolName, mode, outputDirOfConfig) {
  return {
    name: toolName,
    description:
      mode === 'generate'
        ? 'Generate an image from a text description through the VisionForge image bridge (Qwen-Image via qwen.apiKey, or GLM-Image via glm.apiKey). Requires at least one of these keys (run `npx @lr611/visionforge doctor`, or `visionforge config set qwen.apiKey <key>`). Returns the saved local file path and a temporary URL. After success, copy the ENTIRE markdown block from the tool result (the [![生成的图片](图片URL)](本地预览地址) preview line plus the download line) verbatim into your final reply, and nothing else about the files: do not list the file paths as plain text and do not paste the provider URL anywhere. Clicking the preview must open the local preview address, never the provider URL. The result also carries a previewMarkdown field containing the ready preview+download markdown: reply with exactly that block as your final answer and nothing else about the files. EVERY call outputs exactly ONE image: never call this tool multiple times to offer the user "a choice of candidates" unless the user explicitly asked for N images. When the user asks for N images, call this tool N times and vary the prompt each time (e.g. append "variant 1/N: ...") so the results differ; never repeat the same prompt verbatim across calls.'
        : 'IMPORTANT: BEFORE calling this tool to edit/fuse images, you MUST first call visionforge_read_image on the input image(s) to learn the people\'s actual pose, body shape, clothing, hairstyle, expression and the scene — this is the plugin\'s eye. Then construct the prompt from that real evidence and lock the identity of every person the user did NOT explicitly ask to modify (keep face, hairstyle, body shape unchanged; modify ONLY what the user named). NEVER call this tool without first reading the input image(s), unless the request is pure text-to-image (generate). Full prompt-quality rules (MANDATORY DETAIL FORMAT: IDENTITY / DYNAMICS / CONTACT PHYSICS / SCENE & LIGHT, and the pose-expansion duty) live in the VisionForge skill — read its 图生图指令细节格式 section and follow it when writing the edit prompt; brief poses must be expanded into concrete geometric language with negative examples (e.g. 侧坐 → 侧身坐，双腿并拢垂放在自行车同一侧，不是跨坐、不是双腿分开). Edit images from a text instruction through the VisionForge image bridge (Qwen-Image edit only; GLM-Image does not support editing). Requires the qwen.apiKey. Input accepts 1-3 absolute local file paths or http(s) URLs (multi-image fusion: e.g. merge two faces into one scene), or the string "auto" to use the images most recently pasted into the composer (up to 3). Set count to request multiple outputs (1-6). After success, copy the ENTIRE markdown block from the tool result (one preview line per image: [![生成图 N](图片URL)](本地预览地址), plus the download lines) verbatim into your final reply, and nothing else about the files: do not list the file paths as plain text and do not paste the provider URLs anywhere. The result also carries a previewMarkdown field containing the ready preview+download markdown: reply with exactly that block and nothing else about the files. NOTE: input:"auto" resolves the images VisionForge itself tracked from pasted composer content; images uploaded via DSH attachments/drag may not be tracked, so if auto edits the wrong image, locate the actual file (e.g. in the workspace) and pass its explicit path.',
    parameters: {
      type: 'object',
      properties:
        mode === 'generate'
          ? {
              prompt: { type: 'string', description: 'Text description of the image to generate. PROMPT-WRITING GUIDE (mandatory, following the Doubao/Jimeng image-prompt formula): write AT LEAST 50 characters covering ALL SIX dimensions — 1) subject & its concrete features (age/build/hair/clothing/color), 2) action/pose in concrete geometric terms (e.g. 侧坐 → 双腿并拢垂放在车身一侧; never a bare pose word), 3) scene/environment, 4) lighting/atmosphere (light source + direction + mood), 5) composition/view, 6) quality words (写实/高清/细节/光影层次). The plugin only appends protective boundary constraints; IT WILL NOT write these details for you, and its result warns you with a `注意:` line naming exactly which dimensions are missing (short prompts under 50 characters or fewer than 3 dimensions are flagged). If you see that warning, expand the prompt per this guide before generating — do not call with a bare short prompt. Do not invent objects/people the user did not ask for; keep the user\'s objective requirements intact.' },
              size: { type: 'string', description: 'Output size in WxH format, or a resolution word like 2K/4K/1080P. LEAVE EMPTY unless the user explicitly asked for a specific resolution: empty = engine-best default (2K/2560x1440 where supported, else the engine maximum). IMPORTANT: never pass the legacy default 1536x1024 - the engines support much higher resolution; passing it degrades quality. Do not invent any numeric size on your own; if in doubt, leave it empty.' },
              output: { type: 'string', description: 'Optional save path (default: D:\\VisionForge\\out with a timestamped name)' },
              provider: { type: 'string', description: 'Optional provider: qwen, glm, or a custom engine id (default: user default engine, then qwen if configured, else glm)' },
              model: { type: 'string', description: 'Optional model name (default: qwen-image or glm-image)' },
            }
          : {
              input: { type: 'array', items: { type: 'string' }, description: '1-3 absolute local file paths or http(s) URLs of the images to edit/fuse (single string also accepted), or the single string "auto" to use the most recently pasted images (up to 3)' },
              prompt: { type: 'string', description: 'Editing instruction. PROMPT-WRITING GUIDE (mandatory, following the Doubao/Jimeng image-prompt formula): write AT LEAST 50 characters covering, in order: 1) who must stay identical (face/hairstyle/body — lock identity unless the user explicitly asked to change it), 2) what to change, concretely, 3) action/pose in concrete geometric terms (e.g. 侧坐 → 双腿并拢垂放在车身一侧; never a bare pose word), 4) scene/environment, 5) lighting/atmosphere (light source + direction + mood), 6) quality words (写实/高清/细节/光影层次). The plugin only appends protective boundary constraints; IT WILL NOT write these details for you, and its result warns you with a `注意:` line naming exactly which dimensions are missing (short prompts under 50 characters or fewer than 3 dimensions are flagged). If you see that warning, expand the prompt per this guide before generating — do not call with a bare short prompt.' },
              count: { type: 'integer', minimum: 1, maximum: 6, description: 'Number of images to output (default 1). Set >1 ONLY when the user explicitly asked for multiple outputs; every output then differs from the others.' },
              size: { type: 'string', description: 'Output size in WxH format, or a resolution word like 2K/4K/1080P. LEAVE EMPTY unless the user explicitly asked for a specific resolution: empty = engine-best default (2K/2560x1440 where supported, else the engine maximum). IMPORTANT: never pass the legacy default 1536x1024 - the engines support much higher resolution; passing it degrades quality. Do not invent any numeric size on your own; if in doubt, leave it empty.' },
              output: { type: 'string', description: 'Optional save path for the first output (default: D:\\VisionForge\\out with a timestamped name)' },
              model: { type: 'string', description: 'Optional model name (default: engine default model)' },
            },
      required: mode === 'generate' ? ['prompt'] : ['input', 'prompt'],
    },
    output: {
      schema: IMAGE_GEN_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderGenText(value) }],
    },
    timeoutMs: 300_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({
      card: 'generic',
      title: toolName,
      kind: mode === 'generate' ? 'generate' : 'edit',
      rawInput: args,
      ...(mode === 'edit'
        ? (() => {
            const inputs = Array.isArray(args?.input) ? args.input : [args.input]
            const locs = (inputs || [])
              .filter((x) => typeof x === 'string' && x !== 'auto' && !/^https?:\/\//i.test(x))
              .map((x) => ({ path: x }))
            return locs.length > 0 ? { locations: locs } : {}
          })()
        : {}),
    }),
    async execute(args, exec) {
      let inputs = []
      if (mode === 'generate') {
        if (typeof args?.prompt !== 'string' || args.prompt.trim() === '') {
          throw new Error(`${toolName} needs a non-empty string "prompt".`)
        }
      } else {
        // 容错：agent 可能把路径数组序列化成字符串传进来（如 "[\"D:\\...jpg\"]"），
        // 先识别 JSON 数组字符串并解析成数组，避免把字面量当路径 stat（ENOENT）。
        let rawInput = args?.input
        if (typeof rawInput === 'string') {
          const t = rawInput.trim()
          if (t.startsWith('[') && t.endsWith(']')) {
            try {
              const parsed = JSON.parse(t)
              if (Array.isArray(parsed)) rawInput = parsed
            } catch { /* keep as string */ }
          }
        }
        inputs = (Array.isArray(rawInput) ? rawInput : [rawInput])
          .map((x) => (typeof x === 'string' ? x.trim() : ''))
          .filter((x) => x.length > 0)
        if (inputs.length === 1 && inputs[0] === 'auto') {
          if (recentPastePaths.length === 0) {
            throw new Error(`${toolName} input:"auto" has no recent pasted image — paste images into the composer first, or pass explicit "input" paths/URLs.`)
          }
          inputs = recentPastePaths.slice(-3)
        }
        if (inputs.length === 0) {
          throw new Error(`${toolName} needs at least one non-empty "input" (string, array of 1-3 paths/URLs, or "auto").`)
        }
        if (inputs.length > 3) {
          throw new Error(`${toolName} accepts at most 3 input images; got ${inputs.length}.`)
        }
        if (typeof args?.prompt !== 'string' || args.prompt.trim() === '') {
          throw new Error(`${toolName} needs a non-empty string "prompt".`)
        }
      }
      let outCount = 1
      if (mode === 'edit' && (typeof args.count === 'number' || typeof args.count === 'string')) {
        const c = parseInt(String(args.count).trim(), 10)
        if (Number.isFinite(c)) outCount = Math.max(1, Math.min(6, Math.floor(c)))
      }
      // count>1 时并行调用各变体（串行会让总时长超过工具超时 → 宿主反复重试 / 只出第一张）。
      // 部分失败不整体报错：成功的图照常返回，失败原因经 enhanceNotice 转达给宿主。
      const runOne = async (n) => {
        const prompt = outCount > 1 ? `${args.prompt} — 第 ${n}/${outCount} 个变体：请输出与前一张不同的构图、姿态、角度或光影` : args.prompt
        const cliArgs = [mode, '--prompt', prompt]
        if (mode === 'edit') cliArgs.push('--input', ...inputs)
        if (typeof args.size === 'string' && args.size.trim() !== '') cliArgs.push('--size', args.size)
        if (typeof args.output === 'string' && args.output.trim() !== '') {
          const name = basename(args.output.trim())
          const finalName = outCount > 1 ? name.replace(/(\.[^.]+)$/, `-${n}$1`) : name
          cliArgs.push('--output', join(resolve(outputDirOfConfig), finalName))
        }
        if (typeof args.provider === 'string' && args.provider.trim() !== '') cliArgs.push('--provider', args.provider)
        if (typeof args.model === 'string' && args.model.trim() !== '') cliArgs.push('--model', args.model)
        cliArgs.push('--timeout', String(CLI_TIMEOUT_MS))
        const sig = exec && (exec.signal || exec.abortSignal)
        const { stdout, stderr, code } = await runCli(cliArgs, sig)
        if (code !== 0) {
          return { ok: false, error: `visionforge ${mode} failed (exit ${code}): ${(stderr || stdout).trim().slice(0, 500)}` }
        }
        let parsed
        try {
          parsed = JSON.parse(stdout)
        } catch {
          return { ok: false, error: `visionforge ${mode} produced no JSON: ${stdout.trim().slice(0, 300)}` }
        }
        return { ok: true, parsed }
      }
      const results = await Promise.allSettled(Array.from({ length: outCount }, (_, i) => runOne(i + 1)))
      const outputs = []
      const errors = []
      results.forEach((r, idx) => {
        const res = r.status === 'fulfilled' ? r.value : { ok: false, error: (r.reason && r.reason.message) || String(r.reason) }
        if (res.ok && res.parsed && typeof res.parsed === 'object' && !Array.isArray(res.parsed)) outputs.push(res.parsed)
        else if (res.error) errors.push(`第 ${idx + 1} 张: ${res.error}`)
      })
      if (outputs.length === 0) {
        throw new Error(errors[0] || `visionforge ${mode} failed`)
      }
      const partialNotice = errors.length > 0 ? `部分图片生成失败：${errors.join('；')}` : ''
      const merged =
        outputs.length === 1
          ? outputs[0]
          : (() => {
              const m = { provider: outputs[0]?.provider, model: outputs[0]?.model }
              m.urls = outputs.map((o) => o?.url).filter((x) => typeof x === 'string')
              m.filePaths = outputs.map((o) => o?.filePath).filter((x) => typeof x === 'string')
              return m
            })()
      // 确保本地预览服务已就绪（listen 是异步的；重启后立即生成时 port 可能还是 0，
      // 会导致 previewMarkdown 无本地图 URL / 无保存按钮 → 消息里图片和按钮全不见）。
      await waitRenderServer()
      // 用户已按停止：立即失败，不再构建输出（插件不拖累宿主核心工作）
      const sig = exec && (exec.signal || exec.abortSignal)
      if (sig && sig.aborted) throw new Error('visionforge aborted by user')
      if (merged && typeof merged === 'object' && !Array.isArray(merged)) {
        if (partialNotice) merged.enhanceNotice = merged.enhanceNotice ? `${merged.enhanceNotice}；${partialNotice}` : partialNotice
        merged.previewMarkdown = buildPreviewMarkdown(merged)
        const produced = Array.isArray(merged.filePaths) ? merged.filePaths : [merged.filePath]
        for (const fp of produced) if (typeof fp === 'string') sessionTracked.add(resolve(fp))
      }
      return merged
    },
  }
}

function makeDownloadTool(toolName) {
  return {
    name: toolName,
    description: 'Save a VisionForge-generated image from the cache to a permanent location. Default destination is the D: drive root (e.g. D:\\photo.png); without a D: drive a VisionForge folder is created under the user home. Pass output to choose a different file path or directory. After saving, opens Explorer with the file selected and returns a clickable locate link.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute local path of the generated image (the filePath returned by visionforge_generate_image or visionforge_edit_image)' },
        output: { type: 'string', description: 'Optional destination file path, or a directory to save into (default: D: drive root)' },
      },
      required: ['path'],
    },
    output: {
      schema: IMAGE_DOWNLOAD_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: (value && value.message) || `Saved: ${value?.filePath}` }],
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => false,
    presentCall: (args) => ({
      card: 'generic',
      title: toolName,
      kind: 'download',
      rawInput: args,
      ...(typeof args?.path === 'string' && !/^https?:\/\//i.test(args.path) ? { locations: [{ path: args.path }] } : {}),
    }),
    async execute(args) {
      if (typeof args?.path !== 'string' || args.path.trim() === '') {
        throw new Error(`${toolName} needs a non-empty string "path".`)
      }
      const src = resolve(args.path.trim())
      if (!existsSync(src)) throw new Error(`${toolName}: file not found: ${src}`)
      const ext = extname(src)
      const base = basename(src)
      let dest
      const explicit = typeof args?.output === 'string' && args.output.trim() !== ''
      if (explicit) {
        const out = resolve(args.output.trim())
        if (out.endsWith('\\') || out.endsWith('/') || (existsSync(out) && statSync(out).isDirectory())) {
          dest = join(out, base)
        } else {
          dest = out
        }
      } else {
        const dRoot = existsSync('D:\\') ? 'D:\\' : join(homedir(), 'VisionForge')
        dest = join(dRoot, base)
      }
      if (dest !== src && existsSync(dest)) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-')
        const stem = base.slice(0, base.length - ext.length) || 'visionforge'
        dest = join(dirname(dest), `${stem}-${ts}${ext}`)
      }
      const parent = dirname(dest)
      if (!existsSync(parent)) mkdirSync(parent, { recursive: true })
      copyFileSync(src, dest)
      try {
        const explorer = spawn('explorer.exe', ['/select,' + dest], { detached: true, stdio: 'ignore' })
        explorer.on('error', () => {})
        explorer.unref()
      } catch { /* reveal is a nicety */ }
      return {
        filePath: dest,
        action: 'downloaded',
        message: `已保存到 ${dest} — [点击定位下载位置](file:///${dest.replace(/\\/g, '/')})（资源管理器已自动打开并选中该文件）`,
      }
    },
  }
}

function makePreviewTool(toolName) {
  return {
    name: toolName,
    description: 'Open a VisionForge-generated image in the system default image viewer for preview and zooming, before deciding whether to download it. Takes the absolute local path of the generated image (the filePath returned by visionforge_generate_image or visionforge_edit_image). Does not move or delete the file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute local path of the image to preview (the filePath returned by visionforge_generate_image or visionforge_edit_image)' },
      },
      required: ['path'],
    },
    output: {
      schema: IMAGE_PREVIEW_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: (value && value.message) || `Preview: ${value?.path}` }],
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => false,
    presentCall: (args) => ({
      card: 'generic',
      title: toolName,
      kind: 'read',
      rawInput: args,
      ...(typeof args?.path === 'string' && !/^https?:\/\//i.test(args.path) ? { locations: [{ path: args.path }] } : {}),
    }),
    async execute(args) {
      if (typeof args?.path !== 'string' || args.path.trim() === '') {
        throw new Error(`${toolName} needs a non-empty string "path".`)
      }
      const target = resolve(args.path.trim())
      if (!existsSync(target)) throw new Error(`${toolName}: file not found: ${target}`)
      const previewUrl =
        renderServerPort > 0
          ? `http://127.0.0.1:${renderServerPort}/visionforge/image?path=${encodeURIComponent(target)}`
          : target
      const opened = openInBrowser(previewUrl)
      return {
        path: target,
        opened: opened !== null,
        message: opened ?? `文件位置：${target}（浏览器打开失败，可直接到该路径查看）`,
      }
    },
  }
}

// ---- 图片证据（attachment → 证据文本）--------------------------------------------
async function evidenceOfAttachment(ctx, block, signal) {
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
  let dir
  let stage = 'store'
  try {
    const stored = await ctx.attachments.readImage(block.attachment, signal)
    if (!stored?.data) {
      throw new Error("attachments.readImage returned no 'data' bytes; the dsh attachment shape may have changed")
    }
    const mediaType = stored.ref?.mediaType ?? block.attachment?.mediaType
    const ext = MEDIA_EXT[mediaType]
    if (!ext) {
      stage = 'media'
      throw new Error(`unsupported pasted media type ${mediaType ?? '(none declared)'}`)
    }
    stage = 'engine'
    dir = await mkdtemp(join(tmpdir(), 'visionforge-dsh-'))
    const file = join(dir, `paste${ext}`)
    await writeFile(file, Buffer.from(stored.data), { mode: 0o600 })
    const { stdout, stderr, code } = await runCli(['-i', file, '--timeout', String(CLI_TIMEOUT_MS)], signal)
    if (code !== 0) throw new Error((stderr || stdout).trim().slice(0, 300))
    const parsed = JSON.parse(stdout)
    return {
      ok: true,
      block: Object.freeze({
        type: 'text',
        text: `[Pasted image, read by the VisionForge vision bridge]\n${renderEvidenceText(parsed.result)}`,
      }),
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 300) : String(error)
    console.error(`[visionforge] image read failed (${stage}): ${detail}`)
    return {
      ok: false,
      block: Object.freeze({ type: 'text', text: FAILURE_TEXT[stage] }),
    }
  } finally {
    if (dir) {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

function contentHasImage(blocks) {
  return Array.isArray(blocks) && blocks.some((b) => b?.type === 'image' || (b?.type === 'tool-result' && contentHasImage(b.content)))
}

function stableKey(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableKey(value[key])}`).join(',')}}`
}

function makeEvidenceCache(ctx) {
  const cache = new Map()
  return {
    async readOne(block, signal) {
      const key = stableKey(block.attachment ?? block)
      const hit = cache.get(key)
      if (hit !== undefined) {
        if (typeof hit === 'object' && hit !== null && 'retryAfter' in hit) {
          if (performance.now() < hit.retryAfter) return hit.block
          cache.delete(key)
        } else {
          cache.delete(key)
          cache.set(key, hit)
          return hit
        }
      }
      const pending = evidenceOfAttachment(ctx, block, undefined).then(
        (evidence) => {
          if (!evidence.ok && cache.get(key) === pending) {
            cache.set(key, { retryAfter: performance.now() + EVIDENCE_RETRY_MS, block: evidence.block })
          }
          return evidence.block
        },
        () => {
          const blockText = Object.freeze({ type: 'text', text: FAILURE_TEXT.engine })
          if (cache.get(key) === pending) {
            cache.set(key, { retryAfter: performance.now() + EVIDENCE_RETRY_MS, block: blockText })
          }
          return blockText
        },
      )
      cache.set(key, pending)
      while (cache.size > EVIDENCE_CACHE_LIMIT) {
        const victim = cache.keys().next().value
        if (victim === undefined) break
        cache.delete(victim)
      }
      return abortable(pending, signal)
    },
  }
}

async function convertBlocks(blocks, convertOne) {
  const out = []
  for (const block of blocks) {
    if (block?.type === 'image') {
      out.push(await convertOne(block))
    } else if (block?.type === 'tool-result' && contentHasImage(block.content)) {
      out.push({ ...block, content: await convertBlocks(block.content, convertOne) })
    } else {
      out.push(block)
    }
  }
  return out
}

async function convertMessages(ctx, messages, signal, cache) {
  const out = []
  for (const message of messages) {
    if (!contentHasImage(message.content)) {
      out.push(message)
      continue
    }
    const content = await convertBlocks(message.content, (block) => cache.readOne(block, signal))
    out.push({ ...message, content })
  }
  return out
}

// ---- 桥接：llm 适配器包装（官方模型 ↔ 插件优先调度）-------------------------------
const VISION_NAME = /(deepseek-(vl|ocr)|janus|glm-[\d.]*v(\b|-)|glm-5\.3-flash(?:$|[-:])|\bvision\b)/i
const WRAP_FAMILIES = ['deepseek', 'glm', 'mimo']

function shouldWrapModel(info, families) {
  const id = String(info?.id ?? '').toLowerCase()
  const unaliased = id.replace(/^~/, '')
  const bare = unaliased.slice(unaliased.lastIndexOf('/') + 1)
  const matchesFamily = families.some((family) => family !== '*' && (id.startsWith(family) || bare.startsWith(family)))
  if (!matchesFamily) {
    if (!families.includes('*') || !Array.isArray(info?.inputModalities) || !info.inputModalities.includes('text')) return false
  }
  if (VISION_NAME.test(bare)) return false
  if (Array.isArray(info?.inputModalities) && info.inputModalities.includes('image')) return false
  if (bare.startsWith('mimo') && !/(^|-)pro(?:-|:|$)/i.test(bare)) return false
  return true
}

function registerVisionAdapter(ctx, config, ownProviders, evidenceCache) {
  const llm = ctx.llm
  if (typeof llm?.registerAdapter !== 'function' || typeof llm?.stream !== 'function') return () => {}
  const active = { value: true }
  const claimed = new Set()
  const registrations = new Map()
  const disposed = () => {
    active.value = false
    for (const id of claimed) ownProviders?.delete(id)
    claimed.clear()
  }

  const wrapModelInfo = (info, providerId) => {
    const inputModalities = Array.isArray(info?.inputModalities) ? [...info.inputModalities] : []
    if (!inputModalities.includes('text')) inputModalities.unshift('text')
    if (!inputModalities.includes('image')) inputModalities.push('image')
    return { ...info, provider: providerId, inputModalities }
  }

  const registerOne = (upstream, providerId, displayName) => {
    if (!active.value) return false
    try {
      const adapter = {
        providerInfo(provider) {
          return { id: provider, name: displayName }
        },
        providerRetryPolicy() {
          if (typeof llm.providerRetryPolicy !== 'function') return undefined
          return llm.providerRetryPolicy(upstream)
        },
        async listModels(_provider, signal) {
          const models = await llm.listModels(upstream, signal)
          return models.filter((m) => shouldWrapModel(m, config.families || WRAP_FAMILIES)).map((m) => ({
            ...wrapModelInfo(m, providerId),
            name: `${m.name ?? m.id} (VisionForge vision)`,
          }))
        },
        async resolveModel(_provider, model, signal) {
          const info = await llm.resolveModelInfo(upstream, model, signal)
          if (!shouldWrapModel(info, config.families || WRAP_FAMILIES)) {
            const declaresImage = Array.isArray(info?.inputModalities) && info.inputModalities.includes('image')
            throw new Error(
              declaresImage
                ? `model "${model}" declares native image input, so its "(VisionForge vision)" entry no longer applies. Select the same model from the provider group without "(VisionForge vision)".`
                : `model "${model}" is outside the VisionForge vision wrap scope`,
            )
          }
          return { ...wrapModelInfo(info, providerId), id: model }
        },
        prepareCall(_provider, _model) {
          return { stream: (options) => this.stream(options) }
        },
        imageRequestPricing() {
          return undefined
        },
        stream(options) {
          const self = this
          return (async function* () {
            const converted = await convertMessages(ctx, options.messages, options.signal, evidenceCache)
            yield* llm.stream({ ...options, provider: upstream, messages: converted, via: providerId })
          })()
        },
      }
      const registration = llm.registerAdapter([providerId], adapter)
      registrations.set(upstream, { providerId, registration })
      claimed.add(providerId)
      ownProviders?.add(providerId)
      return true
    } catch (error) {
      const duplicate = error?.code === 'DUPLICATE_ADAPTER' || /\balready registered\b|\bduplicate (adapter|provider)\b/i.test(String(error))
      if (duplicate) {
        console.error(`[visionforge] vision provider ${providerId} already registered, keeping the existing one`)
        return true
      }
      console.error(`[visionforge] vision provider registration skipped (${providerId}): ${error}`)
      return false
    }
  }

  const dropOne = (upstream) => {
    const current = registrations.get(upstream)
    if (!current) return
    registrations.delete(upstream)
    claimed.delete(current.providerId)
    ownProviders?.delete(current.providerId)
    if (typeof current.registration === 'function') current.registration()
  }

  const reconcile = async () => {
    if (!active.value) return
    const list = typeof llm.listProviders === 'function' ? llm.listProviders() : []
    const available = new Set(list.map((info) => (typeof info === 'string' ? info : info?.id)).filter(Boolean))
    if (typeof llm.listProviders !== 'function') {
      if (!registrations.has('__legacy__')) {
        registerOne('deepseek-official', 'deepseek-visionforge', 'DeepSeek (VisionForge vision)')
      }
      return
    }
    if (config.upstream) {
      const upstream = config.upstream
      const providerId = config.providerId || (upstream === 'deepseek-official' ? 'deepseek-visionforge' : `visionforge-${upstream}`)
      if (available.has(upstream) && !registrations.has(upstream)) {
        const name = (() => {
          try {
            const found = list.find((entry) => entry?.id === upstream)
            return found?.name ?? upstream
          } catch {
            return upstream
          }
        })()
        registerOne(upstream, providerId, `${name} (VisionForge vision)`)
      } else if (!available.has(upstream) && registrations.has(upstream)) {
        dropOne(upstream)
      }
      return
    }
    for (const [upstream, current] of registrations) {
      if (!available.has(upstream)) dropOne(upstream)
    }
    for (const info of list) {
      const id = typeof info === 'string' ? info : info?.id
      if (!id || String(id).startsWith('visionforge-')) continue
      const discover = Array.isArray(config.discover) ? new Set(config.discover) : null
      if (discover && !discover.has(id)) continue
      if (registrations.has(id)) continue
      const base = (typeof info === 'string' ? undefined : info.name) ?? id
      let models = []
      try {
        models = await llm.listModels(id)
      } catch {
        continue
      }
      if (!models.some((m) => shouldWrapModel(m, config.families || WRAP_FAMILIES))) continue
      const providerId = id === 'deepseek-official' ? 'deepseek-visionforge' : `visionforge-${id}`
      if (!registerOne(id, providerId, `${base} (VisionForge vision)`)) continue
    }
  }

  void reconcile().catch((e) => console.error('[visionforge] reconcile error:', e))
  if (typeof ctx.on === 'function') ctx.on('llm/adapters-updated', () => void reconcile().catch((e) => console.error('[visionforge] reconcile error:', e)))
  return disposed
}

// ---- 自动读图（pre-step 钩子）------------------------------------------------------
function registerAutoRead(ctx, evidenceCache) {
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    if (!decision.messages.some((message) => contentHasImage(message.content))) return decision
    const messages = await convertMessages(ctx, decision.messages, payload.signal, evidenceCache)
    return { kind: 'enter', messages }
  })
}

// ---- 0.2.0+ 服务端入口拦截（patch sessionController.prompt + resolveModelInfo）-----
// 0.2.0-rc.2 在 prompt 入口对「纯文本模型 + 图片附件」直接抛 MODEL_DOES_NOT_SUPPORT_IMAGES
//（在 admit 之前），agent/pre-step 调度器根本触发不到。方向 B（保留宿主缩略图）：
// ① patch ctx.llm.resolveModelInfo——对"不支持图片的模型"返回不含 inputModalities 的信息，
//    让 session-controller 的 `inputModalities !== void 0` 检查跳过（873 行）；
// ② image part 原样保留 → admitPromptContent 落盘（前端宿主 rail 缩略图渲染）；
// ③ agent/pre-step（registerAutoRead）再把 image part 转成读图证据文本（模型输入仍纯文本）。
function patchResolveModelInfo(ctx) {
  const llm = ctx?.llm
  if (!llm || typeof llm.resolveModelInfo !== 'function') return
  if (llm.__visionforgeResolvePatched) return
  llm.__visionforgeResolvePatched = true
  const orig = llm.resolveModelInfo.bind(llm)
  llm.resolveModelInfo = async (provider, model, signal) => {
    const info = await orig(provider, model, signal)
    if (
      info &&
      typeof info === 'object' &&
      Array.isArray(info.inputModalities) &&
      !info.inputModalities.includes('image')
    ) {
      const { inputModalities, ...rest } = info
      return rest
    }
    return info
  }
}

function registerPromptInterceptor(ctx, config = {}) {
  const patch = (ctl) => {
    if (!ctl || typeof ctl.prompt !== 'function') {
      interceptorLog(`sessionController 可用但 prompt 不是函数（${ctl ? typeof ctl.prompt : 'ctl 为空'}）`)
      return
    }
    if (ctl.__visionforgePromptPatched) return
    ctl.__visionforgePromptPatched = true
    const origPrompt = ctl.prompt.bind(ctl)
    const NEVER_SIGNAL = new AbortController().signal
    ctl.prompt = async (request, signal) => {
      // 注意：整个函数体同步执行（不 await），保持 typert Remote 调用上下文
      // （ctx.invocation / abort signal）在 origPrompt 启动时仍然有效。
      // signal 必须透传：SessionController.prompt(request, signal) 入口
      // （dsh-api-session-controller 3097 行）第一行就是 signal.throwIfAborted()，
      // 不透传会让纯文本模型发图时 signal 为 undefined 而崩（gateway/internal）。
      const safeSignal = signal ?? NEVER_SIGNAL
      try {
        const content = request?.content
        const types = Array.isArray(content) ? content.map((p) => p?.type) : 'not-array'
        const hasImage = Array.isArray(content) && content.some((part) => part?.type === 'image')
        interceptorLog(`prompt 调用：types=[${types}] hasImage=${hasImage} signal=${signal ? 'provided' : 'undefined→fallback'} sessionId=${request?.sessionId ?? ''}`)
        if (hasImage) {
          // 方向 B+（无痕版）：保留 image part 原样（前端宿主缩略图渲染；873 由
          // resolveModelInfo 补丁放行，image part 经 admitPromptContent 落盘）+
          // 同步把图片字节落盘到 paste 目录并加入 recentPastePaths（read/edit 的
          // source:"auto"/input:"auto" 可解析到路径）。不再附加任何 text part——
          // agent 靠 llm 原生的 textOnlyImageText 占位（"[image omitted because this
          // model accepts text only; attachment sha256:…]"）触发 VisionForge skill，
          // 然后以 "auto" 调用读图/编辑。消息里只有缩略图，零额外文本。
          const pasteDir = join(outputDir(), 'paste')
          try { mkdirSync(pasteDir, { recursive: true }) } catch { /* best-effort */ }
          const ts = new Date().toISOString().replace(/[:.]/g, '-')
          let index = 0
          let saved = 0
          for (const part of request.content) {
            if (part?.type === 'image' && typeof part.data === 'string') {
              const ext = mediaExtOf(part.mediaType)
              const path = join(pasteDir, `vf-${ts}-${index++}.${ext}`)
              try {
                writeFileSync(path, Buffer.from(part.data, 'base64'))
                recentPastePaths.push(path)
                if (recentPastePaths.length > RECENT_PASTE_CAP) recentPastePaths.shift()
                try { sessionTracked.add(resolve(path)) } catch { /* best-effort */ }
                saved++
              } catch (error) {
                interceptorLog(`方向 B+ paste 写入失败：${error}`)
              }
            }
          }
          if (saved > 0) interceptorLog(`方向 B+ 落盘 paste ${saved} 个（未附加任何文本；auto 可解析）`)
        }
      } catch (error) {
        interceptorLog(`prompt interceptor error: ${error}`)
      }
      let promise
      try {
        promise = origPrompt(request, safeSignal)
      } catch (error) {
        interceptorLog(`origPrompt 同步抛错：${error?.message ?? error}${error?.stack ? `\n${error.stack}` : ''}`)
        throw error
      }
      if (promise && typeof promise.then === 'function') {
        let settled = false
        promise.then(
          (result) => {
            if (settled) return
            settled = true
            interceptorLog(`origPrompt 返回：accepted=${result?.accepted ?? 'unknown'} result=${JSON.stringify(result)?.slice(0, 150) ?? String(result)}`)
          },
          (error) => {
            if (settled) return
            settled = true
            interceptorLog(`origPrompt 抛错：${error?.message ?? error}${error?.stack ? `\n${error.stack}` : ''}`)
          }
        )
        setTimeout(() => {
          if (!settled) interceptorLog('origPrompt 10 秒未 settle（可能卡住或错误走其他通道）')
        }, 10000)
      } else {
        interceptorLog(`origPrompt 返回非 promise：${String(promise)}`)
      }
      return promise
    }
    interceptorLog(`patch 成功：sessionController.prompt 已包装（服务名 sessionController）`)
  }
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['sessionController'], (scope) => patch(scope.sessionController))
      interceptorLog('已通过 ctx.inject(["sessionController"]) 请求注入')
    } catch (error) {
      interceptorLog(`ctx.inject 注册失败：${error}`)
    }
  } else {
    try { patch(ctx.sessionController) } catch (error) { interceptorLog(`直接访问失败：${error}`) }
  }
}

function interceptorLog(line) {
  try {
    const dir = outputDir()
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'interceptor.log'), `${new Date().toISOString()} ${line}\n`)
  } catch { /* logging is best-effort */ }
}

function rewritePromptImages(request, config) {
  const content = request.content
  const priority = readConfig()?.visionPriority ?? config.visionPriority ?? 'plugin'
  // host 优先：0.2.0-rc.2 下模型能力解析需异步调用（resolveAgent/resolveModelInfo），
  // 会破坏 typert Remote 调用上下文（ctx.invocation/abort signal）。
  // 同步拦截阶段统一按插件接管；host 语义由 agent/pre-step 钩子（registerAutoRead）兜底。
  if (priority === 'host') interceptorLog('host 优先：同步拦截阶段按插件接管（模型放行由后续钩子处理）')
  const pasteDir = join(outputDir(), 'paste')
  try { mkdirSync(pasteDir, { recursive: true }) } catch { /* best-effort */ }
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const out = []
  let index = 0
  for (const part of content) {
    if (part?.type === 'image' && typeof part.data === 'string') {
      const ext = mediaExtOf(part.mediaType)
      const path = join(pasteDir, `vf-${ts}-${index++}.${ext}`)
      try {
        writeFileSync(path, Buffer.from(part.data, 'base64'))
        interceptorLog(`图片字节已保存：${path}（mediaType=${part.mediaType} data.length=${part.data.length}）`)
      } catch (error) {
        interceptorLog(`paste 写入失败：${error}`)
        out.push(part)
        continue
      }
      const preview = renderServerPort > 0
        ? `http://127.0.0.1:${renderServerPort}/visionforge/image?path=${encodeURIComponent(path)}`
        : null
      out.push({ type: 'text', text: `[Image: source: ${path}]${preview ? `\n![图片](${preview})` : ''}` })
    } else {
      out.push(part)
    }
  }
  return out
}

function mediaExtOf(mediaType) {
  if (typeof mediaType !== 'string') return 'png'
  if (mediaType.includes('jpeg') || mediaType.includes('jpg')) return 'jpg'
  if (mediaType.includes('webp')) return 'webp'
  if (mediaType.includes('gif')) return 'gif'
  if (mediaType.includes('heic') || mediaType.includes('heif')) return 'heic'
  return 'png'
}

// ---- 缓存清扫 ----------------------------------------------------------------------
async function sweepCaches(now = Date.now(), ttlMs = CACHE_TTL_MS, skipSet = null) {
  let removed = 0
  let freed = 0
  try {
    const { readdir, stat, rm } = await import('node:fs/promises')
    const outDir = resolve(outputDir())
    if (!existsSync(outDir)) return { removed, freed }
    async function walk(dir) {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        try {
          if (entry.isDirectory()) {
            await walk(full)
            continue
          }
          if (entry.name === 'save-debug.log') continue
          if (skipSet && skipSet.has(resolve(full))) continue
          const info = await stat(full)
          if (now - info.mtimeMs >= ttlMs) {
            freed += info.size
            removed++
            await rm(full, { force: true }).catch(() => {})
          }
        } catch { /* one bad entry never aborts the sweep */ }
      }
    }
    await walk(outDir)
  } catch { /* sweeping is housekeeping */ }
  return { removed, freed }
}

// C2：统计输出目录（生成图 + 粘贴子目录）与特征缓存目录的占用
async function cacheStats() {
  const { readdir, stat } = await import('node:fs/promises')
  const outDir = resolve(outputDir())
  const featuresDir = join(dirname(outDir), 'features')
  const pasteSep = `${sep}paste${sep}`
  const stats = { outDir, featuresDir, outCount: 0, outBytes: 0, pasteCount: 0, pasteBytes: 0, featCount: 0, featBytes: 0 }
  async function walk(dir, onFile) {
    let entries = []
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      try {
        if (entry.isDirectory()) { await walk(full, onFile); continue }
        const info = await stat(full)
        onFile(full, info.size)
      } catch { /* skip unreadable */ }
    }
  }
  await walk(outDir, (full, size) => {
    if (full.includes(pasteSep)) { stats.pasteCount++; stats.pasteBytes += size } else { stats.outCount++; stats.outBytes += size }
  })
  await walk(featuresDir, (_f, size) => { stats.featCount++; stats.featBytes += size })
  stats.totalBytes = stats.outBytes + stats.pasteBytes + stats.featBytes
  stats.totalCount = stats.outCount + stats.pasteCount + stats.featCount
  return stats
}

// ---- 宿主 webServer 路由 ------------------------------------------------------------
function registerHostRoutes(ctx, ownProviders, config = {}) {
  if (typeof ctx.inject !== 'function') return
  ctx.inject(['webServer', 'llm'], (scope) => {
    const llm = scope.llm
    // 粘贴路由：GET 判定（该模型是否接管），POST 落盘。
    const verdicts = new Map()
    scope.webServer.register({
      name: 'visionforge-paste',
      kind: 'exact',
      path: '/visionforge/paste',
      handler: async (req, res) => {
        if (!trustedRequest(req)) {
          res.writeHead(403, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: ROUTE_REFUSAL }))
          return
        }
        if (req.method === 'GET') {
          try {
            const label = new URL(req.url, 'http://localhost').searchParams.get('model') ?? ''
            const pasteOff = config.pasteToPath === false || (() => {
              try { return readConfig()?.pasteToPath === false } catch { return false }
            })()
            if (pasteOff) {
              res.writeHead(200, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ takeover: false }))
              return
            }
            const cached = verdicts.get(label)
            const sharedPriority = (() => {
              try { return readConfig()?.visionPriority } catch { return undefined }
            })()
            const modelKeepsThumbnail = /\(VisionForge vision\)/i.test(label) || /vision|multimodal|vl|image|omni/i.test(label)
            const forcedPlugin = sharedPriority === 'plugin' && !modelKeepsThumbnail
            if (forcedPlugin) verdicts.delete(label)
            let takeover
            if (cached && !forcedPlugin && Date.now() - cached.at < VERDICT_TTL_MS) {
              takeover = cached.takeover
            } else {
              takeover = await pasteTakeoverVerdict(llm, label, ownProviders)
              verdicts.set(label, { at: Date.now(), takeover })
              if (verdicts.size > VERDICT_CAP) {
                const first = verdicts.keys().next().value
                if (first !== undefined) verdicts.delete(first)
              }
            }
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ takeover }))
            return
          } catch {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ takeover: false }))
            return
          }
        }
        if (req.method === 'POST') {
          try {
            const chunks = []
            let total = 0
            for await (const chunk of req) {
              total += chunk.length
              if (total > PASTE_MAX_BYTES + 1024) {
                res.writeHead(413, { 'content-type': 'application/json' })
                res.end(JSON.stringify({ error: 'paste too large' }))
                req.destroy()
                return
              }
              chunks.push(chunk)
            }
            const file = await savePasteBytes(Buffer.concat(chunks))
            res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
            res.end(JSON.stringify({ path: file }))
          } catch (error) {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: String(error?.message ?? error) }))
          }
          return
        }
        res.writeHead(405).end()
      },
    })
    // 设置页打开路由（client 卡片「打开完整设置页」链接的目标）。
    scope.webServer.register({
      name: 'visionforge-open-settings-page',
      kind: 'exact',
      path: '/visionforge/open-settings-page',
      handler: async (req, res) => {
        const send = (status, body) => {
          res.writeHead(status, { 'content-type': 'application/json' })
          res.end(JSON.stringify(body))
        }
        if (!trustedRequest(req)) {
          send(403, { error: ROUTE_REFUSAL })
          return
        }
        if (req.method !== 'GET') {
          res.writeHead(405).end()
          return
        }
        const port = await startSettingsServer()
        if (port) openInBrowser(`http://127.0.0.1:${port}/visionforge/settings`)
        send(200, { ok: !!port })
      },
    })
    // 配置路由：GET 摘要 / POST 应用补丁。
    scope.webServer.register({
      name: 'visionforge-config',
      kind: 'exact',
      path: '/visionforge/config',
      handler: async (req, res) => {
        const send = (status, body) => {
          res.writeHead(status, { 'content-type': 'application/json' })
          res.end(JSON.stringify(body))
        }
        if (!trustedRequest(req)) {
          send(403, { error: ROUTE_REFUSAL })
          return
        }
        if (req.method === 'GET') {
          try {
            send(200, engineSummary())
          } catch (error) {
            send(409, { error: String(error?.message ?? error) })
          }
          return
        }
        if (req.method !== 'POST') {
          res.writeHead(405).end()
          return
        }
        try {
          const chunks = []
          let total = 0
          for await (const chunk of req) {
            total += chunk.length
            if (total > 64 * 1024) {
              send(413, { error: 'config payload too large' })
              req.destroy()
              return
            }
            chunks.push(chunk)
          }
          const patch = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (patch?.open === true) {
            openConfigInEditor()
            send(200, { opened: true })
            return
          }
          applySettings(patch)
          send(200, engineSummary())
        } catch (error) {
          send(400, { error: String(error?.message ?? error) })
        }
      },
    })
  })
}

async function pasteTakeoverVerdict(llm, label, ownProviders) {
  if (typeof label !== 'string' || label.trim() === '') return false
  if (/\(VisionForge vision\)/i.test(label)) return false
  if (!llm || typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') return false
  const lowered = label.toLowerCase()
  let matchedAny = false
  for (const info of llm.listProviders()) {
    const providerId = info?.id
    if (!providerId) continue
    if (ownProviders?.has(providerId)) continue
    let models = []
    try {
      models = await llm.listModels(providerId)
    } catch {
      return false
    }
    for (const model of models) {
      if (typeof model?.name === 'string' && /\(VisionForge vision\)/i.test(model.name)) continue
      for (const candidate of [model?.name, model?.id]) {
        if (typeof candidate !== 'string' || candidate.length === 0) continue
        if (!lowered.includes(candidate.toLowerCase())) continue
        const modalities = model?.inputModalities
        if (!Array.isArray(modalities) || modalities.includes('image')) return false
        if (candidate.length >= 3) matchedAny = true
      }
    }
  }
  return matchedAny
}

// ---- 插件入口 ----------------------------------------------------------------------
export function apply(ctx, config = {}) {
  try {
    const dshPatch = {}
    if (config.engine !== undefined) dshPatch.engine = config.engine
    if (config.apiKey !== undefined) dshPatch.apiKey = config.apiKey
    if (config.baseUrl !== undefined) dshPatch.baseUrl = config.baseUrl
    if (config.model !== undefined) dshPatch.model = config.model
    if (config.visionPriority !== undefined) dshPatch.visionPriority = config.visionPriority
    if (config.outputDir !== undefined) dshPatch.outputDir = config.outputDir
    if (config.pasteToPath !== undefined) dshPatch.pasteToPath = config.pasteToPath
    if (Object.keys(dshPatch).length > 0) applySettings(dshPatch)
  } catch { /* the shared file may be unwritable; the form itself already saved */ }

  const evidenceCache = makeEvidenceCache(ctx)

  ensureDefaults()
  startRenderServer()
  const ownProviders = new Set()

  // 工具注册：6 个。
  try {
    ctx.tools.register(makeReadTool(config.toolName || 'visionforge_read_image', recentPastePaths, new Map()))
  } catch (error) {
    console.error(`[visionforge] read tool registration skipped: ${error}`)
  }
  try {
    ctx.tools.register(makeGenTool(config.generateToolName || 'visionforge_generate_image', 'generate', outputDir()))
  } catch (error) {
    console.error(`[visionforge] generate tool registration skipped: ${error}`)
  }
  try {
    ctx.tools.register(makeGenTool(config.editToolName || 'visionforge_edit_image', 'edit', outputDir()))
  } catch (error) {
    console.error(`[visionforge] edit tool registration skipped: ${error}`)
  }
  try {
    ctx.tools.register(makeDownloadTool(config.downloadToolName || 'visionforge_download_image'))
  } catch (error) {
    console.error(`[visionforge] download tool registration skipped: ${error}`)
  }
  try {
    ctx.tools.register(makePreviewTool(config.previewToolName || 'visionforge_preview_image'))
  } catch (error) {
    console.error(`[visionforge] preview tool registration skipped: ${error}`)
  }
  try {
    ctx.tools.register({
      name: config.settingsToolName || 'visionforge_open_settings',
      description: 'Open the VisionForge settings page in the browser. The page lets the user fill in their own provider API key(s) (comma-separated for automatic rotation), base URL, model, reading priority (official first vs plugin first), output directory, and paste behavior, then save locally. Call this whenever the user asks to configure VisionForge, open the settings, change/add an API key, change the base URL or model, or switch the reading priority.',
      parameters: { type: 'object', properties: {}, required: [] },
      output: {
        schema: { type: 'object', properties: { ok: { type: 'boolean' }, url: { type: 'string' }, error: { type: 'string' } }, required: ['ok'] },
        render: (_args, value) => [{ type: 'text', text: value?.ok ? `已打开 VisionForge 设置页：${value.url}（在浏览器中填写并保存）` : `打开设置页失败：${value?.error ?? 'unknown'}` }],
      },
      timeoutMs: 30_000,
      isConcurrencySafe: () => true,
      async execute() {
        const port = await startSettingsServer()
        if (!port) throw new Error('VisionForge settings server failed to start')
        const url = `http://127.0.0.1:${port}/visionforge/settings`
        openInBrowser(url)
        return { ok: true, url }
      },
    })
  } catch (error) {
    console.error(`[visionforge] settings tool registration skipped: ${error}`)
  }

  // llm 适配器包装（官方/插件优先级调度）。
  if (config.visionProvider !== false) {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['llm'], (scope) => {
        return registerVisionAdapter(scope, config, ownProviders, evidenceCache)
      })
    } else {
      registerVisionAdapter(ctx, config, ownProviders, evidenceCache)
    }
  }

  // 自动读图（pre-step 钩子，默认关闭）：方向 B+ 下 image part 保留（前端缩略图），
  // agent 靠消息里的 <!-- VF_IMAGE: 路径 --> 注释主动读图/编辑；pre-step 转换会把
  // image part 替换成证据文本、破坏前端缩略图显示，故默认不启用，仅显式开启时注册。
  if (config.autoRead === true) {
    registerAutoRead(ctx, evidenceCache)
  }

  // 服务端入口拦截（0.2.0+ 纯文本模型图片消息被入口拒绝，需在 prompt 前接管）。
  try {
    patchResolveModelInfo(ctx)
  } catch (error) {
    console.error(`[visionforge] resolveModelInfo patch skipped: ${error}`)
  }
  try {
    registerPromptInterceptor(ctx, config)
  } catch (error) {
    console.error(`[visionforge] prompt interceptor registration skipped: ${error}`)
  }

  // 宿主路由（粘贴 / 配置）。
  registerHostRoutes(ctx, ownProviders, config)

  // 设置命名空间（让设置卡片可派发）。
  if (config.settingsCard !== false && typeof ctx.inject === 'function') {
    ctx.inject(['settings'], (scope) => {
      try {
        const passThrough = (value) => ({ ...(value ?? {}) })
        passThrough.toJSON = () => ({
          uid: 0,
          refs: { 0: { type: 'object', meta: { default: {} }, dict: {} } },
        })
        scope.settings.register('visionforge', passThrough, { base: {} })
      } catch (error) {
        console.error(`[visionforge] settings namespace skipped: ${error}`)
      }
    })
  }
}

export const __config = { engineSummary, applySettings, configPath, refusal: ROUTE_REFUSAL }
export const __paste = {
  sweep: sweepCaches,
  ttlMs: CACHE_TTL_MS,
  refusal: ROUTE_REFUSAL,
}
