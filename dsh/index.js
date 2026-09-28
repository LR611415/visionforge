// VisionForge — DeepSeek Harness (DSH) plugin bridge.
// 自研桥接层：读图 / 生图 / 编辑 / 预览 / 下载 / 粘贴接管 / 设置页。
// 引擎能力（CLI: dist/main.js，provider 适配/schema/failover/guard/cooldown）
// 保留自 liustack/modlens（MIT），桥接层为本项目独立实现。

import { spawn } from 'node:child_process'
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

const CLI_PATH = fileURLToPath(new URL('../src/index.js', import.meta.url))
const CLI_TIMEOUT_MS = 180_000
const CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000
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
  return ENGINE_ALIASES[key] ?? ''
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
    engines[id] = {
      baseUrl: typeof settings.baseUrl === 'string' ? settings.baseUrl : '',
      model: typeof settings.model === 'string' ? settings.model : '',
      hasKey: hasKey(settings.apiKey),
      proxyMode: !Object.hasOwn(settings, 'proxy') ? 'inherit' : typeof settings.proxy === 'string' && settings.proxy.trim() === '' ? 'direct' : 'custom',
      source: inFile ? 'file' : Object.keys(settings).length > 0 ? 'env' : '',
    }
  }
  const reuse = {}
  for (const harness of REUSE_HARNESSES) {
    const granted = config.reuse?.[harness]
    reuse[harness] = typeof granted === 'boolean' ? granted : harness === 'claude'
  }
  return {
    provider: canonicalEngine(config.provider),
    engines,
    keyless: KEYLESS_ENGINES,
    reuse,
    visionPriority: config.visionPriority === 'plugin' ? 'plugin' : 'official',
    outputDir: typeof config.outputDir === 'string' && config.outputDir.trim() !== '' ? config.outputDir : defaultOutputDir(),
    pasteToPath: config.pasteToPath !== false,
  }
}

export function applySettings(patch) {
  const config = readConfig()
  if (patch?.provider !== undefined) {
    if (patch.provider === '') {
      delete config.provider
    } else if (ENGINES.includes(patch.provider)) {
      config.provider = patch.provider
    } else {
      throw new Error(`unknown engine: ${patch.provider}`)
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
    engine = canonicalEngine(config.provider) || 'qwen'
  }
  if (engine !== undefined) {
    if (!ENGINES.includes(engine)) throw new Error(`unknown engine: ${engine}`)
    config.providers = { ...config.providers }
    const holders = engineKeys(engine).filter((key) => config.providers[key] !== undefined)
    const target = holders.length > 0 ? holders[holders.length - 1] : engine
    const seed = holders.length > 0 ? {} : envSettings(engine)
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
function runCli(args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawnHidden(process.execPath, [CLI_PATH, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => resolve({ stdout, stderr, code }))
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
    const local = port > 0 && typeof fp === 'string' ? `http://127.0.0.1:${port}/visionforge/image?path=${encodeURIComponent(fp)}` : null
    const thumb = local ?? u
    const dl = port > 0 && typeof fp === 'string' ? ` [下载](http://127.0.0.1:${port}/visionforge/download?path=${encodeURIComponent(fp)})` : ''
    lines.push(`![生成图 ${i + 1}](${thumb})${dl}`)
  })
  return lines.join('\n')
}

function renderGenText(value) {
  const v = value && typeof value === 'object' ? value : {}
  const urls = Array.isArray(v.urls) && v.urls.length > 0 ? v.urls : typeof v.url === 'string' ? [v.url] : []
  const files = Array.isArray(v.filePaths) && v.filePaths.length > 0 ? v.filePaths : typeof v.filePath === 'string' ? [v.filePath] : []
  const port = renderServerPort
  const lines = []
  urls.forEach((u, i) => {
    if (typeof u !== 'string') return
    const fp = files[i]
    const local = port > 0 && typeof fp === 'string' ? `http://127.0.0.1:${port}/visionforge/image?path=${encodeURIComponent(fp)}` : null
    const thumb = local ?? u
    lines.push(`![生成图 ${i + 1}](${thumb})`)
  })
  if (port > 0 && files.length > 0) {
    lines.push('')
    files.forEach((fp, i) => {
      if (typeof fp === 'string') lines.push(`[下载图片 ${i + 1}](http://127.0.0.1:${port}/visionforge/download?path=${encodeURIComponent(fp)})`)
    })
  }
  if (urls.length > 0 || files.length > 0) {
    lines.push('', '【展示给用户】请在最终回复正文中【原样、完整】复制上面这一整段：每条图片预览链接（[![生成图 N](缩略图)](本地预览地址)，对话里显示小图、点击打开系统图片查看器预览并放大）和每条下载按钮（点击后复制到 D 盘根目录并在资源管理器中定位，返回的消息里带下载位置跳转链接）。禁止只列文件路径；禁止把临时 URL 单独贴成文本或链接。')
  }
  if (typeof v.provider === 'string') lines.push(`Provider: ${v.provider}`)
  if (typeof v.model === 'string') lines.push(`Model: ${v.model}`)
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
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const isImage = url.pathname === '/visionforge/image'
        const isDownload = url.pathname === '/visionforge/download'
        const isOpen = url.pathname === '/visionforge/open'
        const isSaveLocal = url.pathname === '/visionforge/download-local'
        if (!isImage && !isDownload && !isOpen && !isSaveLocal) {
          res.writeHead(404).end('not found')
          return
        }
        const raw = url.searchParams.get('path')
        if (!raw) {
          res.writeHead(400).end('missing path')
          return
        }
        const file = resolve(raw)
        const inOut = dirname(file) === outDir || dirname(file).startsWith(outDir + sep)
        if ((!inOut && !servedFiles.has(file)) || !existsSync(file)) {
          res.writeHead(403).end('forbidden')
          return
        }
        if (isOpen) {
          // 系统默认图片查看器打开（不经过 DSH 自身打开方式）。
          try {
            const child = spawn('cmd.exe', ['/c', 'start', '', file], { detached: true, stdio: 'ignore' })
            child.on('error', () => {})
            child.unref()
          } catch { /* open is a nicety */ }
          res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
          res.end(JSON.stringify({ ok: true, file }))
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
          res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
          res.end(JSON.stringify({ ok: true, file: dest, source: file }))
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
          if (rawUrl.includes('/visionforge/download-local')) {
            mkdirSync(outDir, { recursive: true })
            appendFileSync(join(outDir, 'save-debug.log'), `${new Date().toISOString()} url=${rawUrl} err=${(err && err.stack) || err}\n`)
          }
        } catch { /* logging is best-effort */ }
      }
    })
    let candidateIndex = 0
    const onListenSuccess = () => {
      const addr = server.address()
      renderServerPort = typeof addr === 'object' && addr ? addr.port : 0
      void sweepCaches()
    }
    const onListenError = (e) => {
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

// ---- 设置页服务 ---------------------------------------------------------------
let settingsPort = 0
let settingsServer = null

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
<div class="card">
  <label>引擎（提供方）</label>
  <select id="engine"></select>
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
  <label>图片输出目录</label>
  <input id="outputDir">
  <label>粘贴转路径（智能接管）</label>
  <select id="pasteToPath">
    <option value="true">开启</option>
    <option value="false">关闭</option>
  </select>
  <button id="save">保存</button>
  <div id="msg"></div>
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
        op.value = keys[i]; op.textContent = DATA.engines[keys[i]].label
        sel.appendChild(op)
      }
      sel.onchange = function () { renderEngine(this.value) }
      document.getElementById('visionPriority').value = DATA.visionPriority || 'official'
      document.getElementById('outputDir').value = DATA.outputDir || ''
      document.getElementById('pasteToPath').value = DATA.pasteToPath ? 'true' : 'false'
      renderEngine(DATA.current || 'qwen')
    } catch (e) { msg.textContent = '加载当前配置失败：' + e.message; msg.className = 'err' }
  })()
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
        pasteToPath: document.getElementById('pasteToPath').value === 'true'
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
            const providers = config.providers ?? {}
            const current = config.provider !== undefined && ENGINES.includes(config.provider) ? config.provider : 'qwen'
            const engines = {}
            const settings = {}
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
              }
            }
            sendJson(200, {
              engines,
              settings,
              current,
              visionPriority: config.visionPriority === 'plugin' ? 'plugin' : 'official',
              outputDir: typeof config.outputDir === 'string' && config.outputDir.trim() !== '' ? config.outputDir : outputDir(),
              pasteToPath: config.pasteToPath !== false,
            })
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
              const engineId = typeof patch.provider === 'string' && ENGINES.includes(patch.provider)
                ? patch.provider
                : (typeof patch.engine === 'string' && ENGINES.includes(patch.engine) ? patch.engine : undefined)
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
          const { stdout, stderr, code } = await runCli(cliArgs, undefined)
          if (code !== 0) throw new Error(`visionforge failed (exit ${code}): ${(stderr || stdout).trim().slice(0, 500)}`)
          let parsed
          try {
            parsed = JSON.parse(stdout)
          } catch {
            throw new Error(`visionforge produced no JSON: ${stdout.trim().slice(0, 300)}`)
          }
          return parsed.result
        })()
        toolCache.set(cacheKey, run)
        run.catch(() => { toolCache.delete(cacheKey) })
        pending = run
      }
      return structuredClone(await abortable(pending, exec.signal))
    },
  }
}

function makeGenTool(toolName, mode, outputDirOfConfig) {
  return {
    name: toolName,
    description:
      mode === 'generate'
        ? 'Generate an image from a text description through the VisionForge image bridge (Qwen-Image via qwen.apiKey, or GLM-Image via glm.apiKey). Requires at least one of these keys (run `npx @lr611/visionforge doctor`, or `visionforge config set qwen.apiKey <key>`). Returns the saved local file path and a temporary URL. After success, copy the ENTIRE markdown block from the tool result (the [![生成的图片](图片URL)](本地预览地址) preview line plus the download line) verbatim into your final reply, and nothing else about the files: do not list the file paths as plain text and do not paste the provider URL anywhere. Clicking the preview must open the local preview address, never the provider URL. The result also carries a previewMarkdown field containing the ready preview+download markdown: reply with exactly that block as your final answer and nothing else about the files. EVERY call outputs exactly ONE image: never call this tool multiple times to offer the user "a choice of candidates" unless the user explicitly asked for N images. When the user asks for N images, call this tool N times and vary the prompt each time (e.g. append "variant 1/N: ...") so the results differ; never repeat the same prompt verbatim across calls.'
        : 'Edit images from a text instruction through the VisionForge image bridge (Qwen-Image edit only; GLM-Image does not support editing). Requires the qwen.apiKey. Input accepts 1-3 absolute local file paths or http(s) URLs (multi-image fusion: e.g. merge two faces into one scene), or the string "auto" to use the images most recently pasted into the composer (up to 3). When the message carries pasted images and the user asks to fuse / edit / modify them (e.g. merge two photos, change an expression), call this tool with input:"auto" — the official reading model understands the request, this tool performs the edit through their provider keys. Set count to request multiple outputs (1-6). Returns the saved local file path(s) and temporary URL(s). After success, copy the ENTIRE markdown block from the tool result (one preview line per image: [![生成图 N](图片URL)](本地预览地址), plus the download lines) verbatim into your final reply, and nothing else about the files: do not list the file paths as plain text and do not paste the provider URLs anywhere. Clicking a preview must open its local preview address, never the provider URL. The result also carries a previewMarkdown field containing the ready preview+download markdown: reply with exactly that block as your final answer and nothing else about the files. NOTE: input:"auto" resolves the images VisionForge itself tracked from pasted composer content; images uploaded via DSH attachments/drag may not be tracked, so if auto edits the wrong image, locate the actual file (e.g. in the workspace) and pass its explicit path.',
    parameters: {
      type: 'object',
      properties:
        mode === 'generate'
          ? {
              prompt: { type: 'string', description: 'Text description of the image to generate' },
              size: { type: 'string', description: 'Output size, e.g. 1024x1024 (default 1024*1024)' },
              output: { type: 'string', description: 'Optional save path (default: D:\\VisionForge\\out with a timestamped name)' },
              provider: { type: 'string', description: 'Optional provider: qwen or glm (default: qwen if configured, else glm)' },
              model: { type: 'string', description: 'Optional model name (default: qwen-image or glm-image)' },
            }
          : {
              input: { type: 'array', items: { type: 'string' }, description: '1-3 absolute local file paths or http(s) URLs of the images to edit/fuse (single string also accepted), or the single string "auto" to use the most recently pasted images (up to 3)' },
              prompt: { type: 'string', description: 'Editing instruction' },
              count: { type: 'integer', minimum: 1, maximum: 6, description: 'Number of images to output (default 1). Set >1 ONLY when the user explicitly asked for multiple outputs; every output then differs from the others.' },
              size: { type: 'string', description: 'Output size, e.g. 1024x1024 (default 1024*1024)' },
              output: { type: 'string', description: 'Optional save path for the first output (default: D:\\VisionForge\\out with a timestamped name)' },
              model: { type: 'string', description: 'Optional model name (default: qwen-image-edit)' },
            },
      required: mode === 'generate' ? ['prompt'] : ['input', 'prompt'],
    },
    output: {
      schema: IMAGE_GEN_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderGenText(value) }],
    },
    timeoutMs: 140_000,
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
    async execute(args) {
      let inputs = []
      if (mode === 'generate') {
        if (typeof args?.prompt !== 'string' || args.prompt.trim() === '') {
          throw new Error(`${toolName} needs a non-empty string "prompt".`)
        }
      } else {
        inputs = (Array.isArray(args?.input) ? args.input : [args.input])
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
      const outputs = []
      for (let n = 1; n <= outCount; n++) {
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
        const { stdout, stderr, code } = await runCli(cliArgs, undefined)
        if (code !== 0) {
          throw new Error(`visionforge ${mode} failed (exit ${code}): ${(stderr || stdout).trim().slice(0, 500)}`)
        }
        let parsed
        try {
          parsed = JSON.parse(stdout)
        } catch {
          throw new Error(`visionforge ${mode} produced no JSON: ${stdout.trim().slice(0, 300)}`)
        }
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) outputs.push(parsed)
      }
      const merged =
        outputs.length === 1
          ? outputs[0]
          : (() => {
              const m = { provider: outputs[0]?.provider, model: outputs[0]?.model }
              m.urls = outputs.map((o) => o?.url).filter((x) => typeof x === 'string')
              m.filePaths = outputs.map((o) => o?.filePath).filter((x) => typeof x === 'string')
              return m
            })()
      if (merged && typeof merged === 'object' && !Array.isArray(merged)) {
        merged.previewMarkdown = buildPreviewMarkdown(merged)
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

// ---- 缓存清扫 ----------------------------------------------------------------------
async function sweepCaches(now = Date.now(), ttlMs = CACHE_TTL_MS) {
  try {
    const { readdir, stat, rm } = await import('node:fs/promises')
    const outDir = resolve(outputDir())
    if (!existsSync(outDir)) return
    async function walk(dir) {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        try {
          if (entry.isDirectory()) {
            await walk(full)
            continue
          }
          if (entry.name === 'save-debug.log') continue
          const info = await stat(full)
          if (now - info.mtimeMs >= ttlMs) await rm(full, { force: true }).catch(() => {})
        } catch { /* one bad entry never aborts the sweep */ }
      }
    }
    await walk(outDir)
  } catch { /* sweeping is housekeeping */ }
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

  // 自动读图（可选）。
  if (config.autoRead === true) {
    registerAutoRead(ctx, evidenceCache)
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
