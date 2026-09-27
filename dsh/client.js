// Browser half of the visionforge dsh plugin: paste-to-path.
//
// A capture-phase paste listener runs before the composer's own handler.
// When the clipboard carries image files, the default intake (attachment ->
// host image admission -> "model does not support images" for text-only
// models) is suppressed; the bytes go to the plugin's host route
// (POST /visionforge/paste), land as a private temp file, and the returned path
// is inserted into the composer as plain text. A text-only model then sees
// exactly what Pi, OpenCode, and Claude Code hand their models: a file path,
// which is also the visionforge skill's and the read tool's primary trigger.
//
// Hand-written in the lazy-CJS bundle protocol (window.__ModuleLoader__.load
// with a factory returning cordis-plugin exports), so no build step and no
// imports from dsh client packages — the same zero-dependency stance as the
// host half.
window.__ModuleLoader__.load({
  id: '@lr611/visionforge',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    function imageFilesOf(event) {
      var items = event.clipboardData?.items
      if (!items) return []
      var files = []
      for (var i = 0; i < items.length; i++) {
        var item = items[i]
        if (item.kind !== 'file') continue
        var file = item.getAsFile()
        if (file && /^image\//.test(file.type)) files.push(file)
      }
      return files
    }

    function isTextField(el) {
      return el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')
    }

    function isComposerEditable(el) {
      if (!el || typeof el.getAttribute !== 'function') return false
      if (el.getAttribute('data-composer-input') == null) return false
      return el.isContentEditable === true || el.contentEditable === 'true'
    }

    function isWritable(el) {
      return isTextField(el) || isComposerEditable(el)
    }

    // Resolve before taking the event. No writable composer means native
    // paste; missing closest (stubs, odd hosts) falls through to
    // activeElement so a focused textarea still works.
    function resolveWriteTarget(event) {
      var fromEvent = event.target
      if (fromEvent && typeof fromEvent.closest === 'function') {
        var found = fromEvent.closest('textarea, input, [data-composer-input][contenteditable=true]')
        if (found) return found
      }
      var active = document.activeElement
      return isWritable(active) ? active : null
    }

    function insertText(target, text) {
      if (!isWritable(target)) return false
      target.focus()
      // execCommand fires the input event React's controlled textarea needs;
      // the prototype-setter dance is the fallback for engines dropping it.
      var inserted = false
      try {
        inserted = document.execCommand('insertText', false, text)
      } catch {
        inserted = false
      }
      if (inserted) return true
      // Lexical's composer is a contenteditable div: it has no value
      // setter, and assigning innerHTML/textContent bypasses the editor.
      if (!isTextField(target)) return false
      try {
        var proto =
          target.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
        var setter = Object.getOwnPropertyDescriptor(proto, 'value').set
        setter.call(target, target.value + text)
        target.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      } catch {
        return false
      }
    }

    function uploadOne(file) {
      return file.arrayBuffer().then((buffer) =>
        fetch('/visionforge/paste', { method: 'POST', body: buffer }).then((res) => {
          if (!res.ok) {
            return res
              .json()
              .catch(() => ({}))
              .then((body) => {
                var error = new Error(body.error || `paste upload failed (${res.status})`)
                error.status = res.status
                throw error
              })
          }
          return res.json()
        }),
      )
    }

    // A floating toast at the bottom-right that shows the pasted images as
    // thumbnails. The composer itself does not render markdown images and a
    // text-only model cannot hold native image attachments, so this toast is
    // how the user "sees the picture" while the message carries the markdown
    // (the model still receives the path inside it). Closing it only hides
    // the preview, never the message content. Appended to document.body as a
    // fixed element so React re-renders of the composer subtree cannot clear
    // it, and it survives until the user dismisses it.
    // Remove a single pasted-image markdown fragment from the composer's
    // contenteditable text. The paste inserts each image as one contiguous
    // text node, so a tree-walk search plus a Range delete is enough; the
    // editor is told through a selection + execCommand('delete') so its own
    // input pipeline sees the change instead of a raw DOM mutation that a
    // controlled component would fight. Returns true when the fragment was
    // found and removed.
    function removeMdFromComposer(target, mdText) {
      try {
        var root = target && target.nodeType === 1 ? target : null
        if (!root || !mdText) return false
        var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
        var nodes = []
        var n
        while ((n = walker.nextNode())) nodes.push(n)
        var hit = null
        var idx = -1
        for (var i = 0; i < nodes.length; i++) {
          var j = nodes[i].data.indexOf(mdText)
          if (j >= 0) {
            hit = nodes[i]
            idx = j
            break
          }
        }
        if (!hit) return false
        var start = idx
        var end = idx + mdText.length
        // The insert appends `${text} `, and images are joined by a space:
        // swallow one space on each side so removing the middle of three
        // does not leave doubled separators.
        if (start > 0 && hit.data[start - 1] === ' ') start -= 1
        if (hit.data[end] === ' ') end += 1
        var range = document.createRange()
        range.setStart(hit, start)
        range.setEnd(hit, end)
        var sel = window.getSelection()
        if (sel) {
          sel.removeAllRanges()
          sel.addRange(range)
        }
        target.focus()
        return document.execCommand('delete')
      } catch (error) {
        console.error('[visionforge] removeMdFromComposer failed: ' + (error?.message || error))
        return false
      }
    }

    function showPastePreview(target, items) {
      try {
        var olds = document.querySelectorAll('[data-visionforge-paste-preview]')
        if (olds.length > 0) olds[0].remove()
        var bar = document.createElement('div')
        bar.setAttribute('data-visionforge-paste-preview', '1')
        bar.style.cssText =
          'position:fixed;bottom:140px;right:24px;z-index:2147483000;display:flex;align-items:center;gap:8px;' +
          'padding:8px 12px;border:1px solid rgba(127,127,127,0.3);border-radius:10px;' +
          'background:rgba(30,30,30,0.92);box-shadow:0 4px 16px rgba(0,0,0,0.25);' +
          'font-size:12px;color:rgba(255,255,255,0.9);max-width:min(420px,80vw);box-sizing:border-box;'
        var remaining = items.length
        items.forEach(function (item) {
          var cell = document.createElement('div')
          cell.style.cssText = 'position:relative;display:inline-block;'
          var img = document.createElement('img')
          img.src = item.url
          img.alt = '已粘贴图片'
          img.style.cssText = 'height:64px;max-width:96px;object-fit:cover;border-radius:6px;display:block;background:#000;'
          var x = document.createElement('button')
          x.textContent = '×'
          x.title = '删除这张图片（输入框中的对应链接也一并删除）'
          x.style.cssText =
            'position:absolute;top:-7px;right:-7px;width:18px;height:18px;border-radius:50%;border:none;' +
            'cursor:pointer;background:#e5484d;color:#fff;font-size:12px;line-height:18px;text-align:center;padding:0;'
          x.onclick = function () {
            cell.remove()
            remaining -= 1
            if (remaining <= 0) bar.remove()
            var ok = removeMdFromComposer(target, item.md)
            if (!ok) console.warn('[visionforge] 未能从输入框删除对应的链接，请手动删除。')
          }
          cell.appendChild(img)
          cell.appendChild(x)
          bar.appendChild(cell)
        })
        var label = document.createElement('span')
        label.textContent = '已粘贴 ' + items.length + ' 张图片（每张可单独×删除）'
        bar.appendChild(label)
        var close = document.createElement('button')
        close.textContent = '×'
        close.title = '仅隐藏预览条（消息中的图片链接保留）'
        close.style.cssText =
          'margin-left:auto;border:none;background:transparent;cursor:pointer;font-size:18px;' +
          'color:rgba(255,255,255,0.85);padding:0 6px;border-radius:6px;'
        close.onclick = function () {
          bar.remove()
        }
        bar.appendChild(close)
        document.body.appendChild(bar)
      } catch (error) {
        console.error('[visionforge] paste preview toast failed: ' + (error?.message || error))
      }
    }

    function currentModelLabel() {
      var buttons = document.querySelectorAll('button[aria-label]')
      for (var i = 0; i < buttons.length; i++) {
        var label = buttons[i].getAttribute('aria-label') || ''
        if (/选择模型|select model|current model/i.test(label)) return label
      }
      return ''
    }

    // Whether to take a paste over is the HOST's call (GET /visionforge/paste
    // with the selector label; the host resolves it against real model
    // metadata). A name regex here once declared every vision model it did
    // not recognize text-only and hijacked its native paste. The verdict is
    // cached per label and refreshed in the background; until a label has a
    // cached `true`, pastes stay native — the safe direction for both a
    // vision model (keeps its thumbnail) and a text-only one (keeps only its
    // old error message, once). A 404 means the route is off (pasteToPath:
    // false, or no host half), so the client stands down entirely instead of
    // swallowing pastes into a dead endpoint. A 403 means the route refuses
    // this page's origin (non-loopback Host, or cross-site), which is just as
    // permanent for this page, so it stands down the same way.
    var routeAvailable = true
    var verdicts = {}
    // A verdict older than this is UNKNOWN again, even while a refresh is in
    // flight: the route's model metadata can change mid-session (discovery
    // sweeps, provider mounts), and acting on a long-stale `true` is exactly
    // the vision-model hijack this design exists to prevent. The bound is a
    // backstop, since every focus and paste re-asks anyway.
    var VERDICT_MAX_AGE_MS = 60000

    function refreshVerdict(label) {
      if (!routeAvailable) return
      var cached = verdicts[label]
      // Dedupe only on an in-flight request, never on freshness: the host's
      // model inventory can change under an unchanged label (a same-named
      // route mounting mid-session), so every focus and paste re-asks and a
      // stale answer survives at most one local round-trip.
      if (cached?.pending) return
      var entry = { pending: true, takeover: cached ? cached.takeover : false, at: cached ? cached.at : 0 }
      verdicts[label] = entry
      fetch(`/visionforge/paste?model=${encodeURIComponent(label)}`)
        .then((res) => {
          if (res.status === 404 || res.status === 403) {
            routeAvailable = false
            entry.pending = false
            return null
          }
          if (!res.ok) throw new Error(`policy ${res.status}`)
          return res.json()
        })
        .then((body) => {
          entry.pending = false
          if (body) {
            entry.takeover = body.takeover === true
            entry.at = Date.now()
          }
        })
        .catch(() => {
          entry.pending = false
        })
    }

    // A paste needs the composer focused first, so a focus-time prefetch has
    // the verdict ready before the first paste can land.
    function onFocusIn() {
      refreshVerdict(currentModelLabel())
    }

    function onPaste(event) {
      var files = imageFilesOf(event)
      if (files.length === 0) return
      var label = currentModelLabel()
      var cached = verdicts[label]
      refreshVerdict(label)
      // Native preview (takeover=false, or the route is off): the composer
      // keeps its thumbnail, but the image still lands silently server-side,
      // so a later read_image source:"auto" can read the same picture through
      // the user's provider chain. Errors are swallowed: this is a best-effort
      // bridge, never a reason to break the paste.
      if (!routeAvailable || !cached || cached.at === 0 || cached.takeover !== true || Date.now() - cached.at > VERDICT_MAX_AGE_MS) {
        files.forEach(function (f) { uploadOne(f).catch(function () {}) })
        return
      }
      var target = resolveWriteTarget(event)
      if (!target) return
      // Take the paste before the composer's intake starts an attachment (and
      // with it the host-side image admission a text-only model fails).
      event.preventDefault()
      event.stopImmediatePropagation()
      // Settle each upload on its own: the paste is already taken, so one
      // failed image must not take the ones that landed down with it (#111).
      Promise.allSettled(files.map(uploadOne)).then((outcomes) => {
        var items = []
        outcomes.forEach((outcome) => {
          if (outcome.status === 'fulfilled' && outcome.value) {
            if (outcome.value.previewUrl) {
              items.push({ md: `![图片](${outcome.value.previewUrl})`, url: outcome.value.previewUrl })
            } else if (outcome.value.path) {
              items.push({ md: outcome.value.path, url: null })
            }
            return
          }
          var error = outcome.reason
          // A 404 here means the route vanished AFTER a verdict confirmed it
          // (plugin disposed mid-session), and a 403 that it refuses this
          // page's origin: either way that race can cost this one paste —
          // preventDefault already ran — but never another. Stand down and
          // forget every verdict, so the next paste goes native immediately.
          if (error && (error.status === 404 || error.status === 403)) {
            routeAvailable = false
            verdicts = {}
          }
          console.error(`[visionforge] paste-to-path failed: ${error?.message ? error.message : error}`)
        })
        var text = items
          .map(function (it) {
            return it.md
          })
          .join(' ')
        if (!text) return
        if (!insertText(target, `${text} `)) {
          console.error(`[visionforge] paste-to-path: could not insert into the composer (${text})`)
        }
        if (items.length > 0) showPastePreview(target, items)
      })
    }

    // The settings card (issue #39). dsh renders a fixed set of plugin cards
    // and does not enumerate settings namespaces, so a card is contributed
    // through the `settings.plugin.item` slot rather than by declaring a
    // schema. It reads and writes the host route above, which owns
    // ~/.visionforge/config.json: the browser never sees an API key, and never
    // sends a blank one back over a stored key.
    var ENGINES = ['antigravity-cli', 'gemini-api', 'openai', 'qwen', 'anthropic', 'claude-cli', 'kimi-cli']
    // Display names follow each vendor's own convention (Qwen, OpenAI,
    // Anthropic, Gemini) and drop the -api / -cli suffix from the internal
    // provider id. The option value stays the internal id: config and
    // failover chains are keyed by that, only the label is prettied.
    var ENGINE_DISPLAY = {
      'antigravity-cli': 'Antigravity',
      'gemini-api': 'Gemini',
      openai: 'OpenAI',
      qwen: 'Qwen',
      anthropic: 'Anthropic',
      'claude-cli': 'Claude',
      'kimi-cli': 'Kimi',
    }
    function engineDisplay(name) {
      return ENGINE_DISPLAY[name] || name
    }
    var REUSE = ['claude', 'codex', 'opencode', 'pi', 'grok']
    // Vision-reading models offered as candidates per engine. Only the
    // qwen engine carries a list (DashScope VL models); other engines keep
    // free text, since their endpoints accept arbitrary model names. Note:
    // the card's Model field is the READING model, so only VL models belong
    // here - text models (qwen-max) or generation models (qwen-image) would
    // fail every read and are intentionally absent.
    var MODEL_CANDIDATES = {
      // Reading (vision) models on DashScope. qwen3.8-max is listed here
      // because the user's model catalogue claims native vision support;
      // verify the 'vision understanding' tag in the Bailian model plaza
      // before relying on it for reads. Generation models (qwen-image-*,
      // wan2.6-*) intentionally stay out of this list: they belong to the
      // generate/edit commands, not to the reading engine.
      qwen: ['qwen3.8-max', 'qwen3-vl-plus', 'qwen3-vl-flash', 'qwen-vl-max', 'qwen-vl-plus'],
      openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4-turbo'],
      anthropic: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-5', 'claude-3-7-sonnet', 'claude-3-5-sonnet'],
      'gemini-api': ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-pro'],
    }
    // Pretty display names for known model ids (value stays the canonical
    // lowercase id the API expects); unknown ids get a generic prettifier.
    var MODEL_DISPLAY = {
      'qwen3.8-max': 'Qwen3.8-Max',
      'qwen3-vl-plus': 'Qwen3-VL-Plus',
      'qwen3-vl-flash': 'Qwen3-VL-Flash',
      'qwen-vl-max': 'Qwen-VL-Max',
      'qwen-vl-plus': 'Qwen-VL-Plus',
      'gpt-4o': 'GPT-4o',
      'gpt-4o-mini': 'GPT-4o-mini',
      'gpt-4.1': 'GPT-4.1',
      'gpt-4.1-mini': 'GPT-4.1-mini',
      'gpt-4-turbo': 'GPT-4-Turbo',
      'claude-haiku-4-5-20251001': 'Claude Haiku 4.5',
      'claude-sonnet-4-5': 'Claude Sonnet 4.5',
      'claude-3-7-sonnet': 'Claude 3.7 Sonnet',
      'claude-3-5-sonnet': 'Claude 3.5 Sonnet',
      'gemini-2.5-pro': 'Gemini 2.5 Pro',
      'gemini-2.5-flash': 'Gemini 2.5 Flash',
      'gemini-2.0-flash': 'Gemini 2.0 Flash',
      'gemini-1.5-pro': 'Gemini 1.5 Pro',
    }
    function modelDisplay(id) {
      if (MODEL_DISPLAY[id]) return MODEL_DISPLAY[id]
      var special = /^(vl|ocr|api|tts|asr|omni)$/i
      return id
        .split('-')
        .map(function (part) {
          if (special.test(part)) return part.toUpperCase()
          return part.charAt(0).toUpperCase() + part.slice(1)
        })
        .join('-')
    }

    // Two short label sets rather than a locale bundle: the card has a dozen
    // strings, and a bundle would be more machinery than the thing it labels.
    var TEXT = {
      en: {
        tab: 'VisionForge config',
        title: 'Vision & Image Engine (VisionForge)',
        subtitle: 'Vision understanding and image generation, all in one card.',
        customModel: 'Custom model…',
        customModelPlaceholder: 'Type a custom model id',
        openConfig: 'Open config file',
        automatic: 'Automatic (failover chain decides)',
        pickToConfigure: 'Pick an engine above to configure its key and endpoint.',
        engine: 'Engine',
        apiKey: 'API key',
        apiKeyHint:
          'Separate multiple keys with commas. VisionForge rotates to the next key after authentication, rate-limit, or quota failures.',
        baseUrl: 'Base URL',
        model: 'Model',
        proxyRoute: 'Proxy route',
        proxyInherit: 'Inherit global or environment proxy',
        proxyDirect: 'Direct connection',
        proxyCustom: 'Custom proxy',
        proxyUrl: 'Proxy URL',
        proxyStored: 'stored, leave empty to keep it',
        proxyExample: 'http://127.0.0.1:7890',
        proxyHint: 'Direct ignores the global proxy and HTTP_PROXY / HTTPS_PROXY.',
        stored: 'stored, leave empty to keep it',
        unset: 'not set',
        fallback: 'provider default',
        save: 'Save',
        saving: 'saving...',
        saved: 'saved',
        savedWithKey: 'saved (API key updated)',
        savedKeep: 'saved (API key kept; fill the key field to change it)',
        loading: 'loading...',
        discard: 'Discard',
        cliNote: 'This engine signs in through its own CLI: no key, no endpoint.',
        autoTitle: 'Auto mode',
        autoHint: 'Reuse the vision engines already on this machine.',
        priorityRoute: 'Reading priority',
        priorityOfficial: 'Official first (default)',
        priorityPlugin: 'Plugin keys first',
        priorityHint: 'Official first: the built-in vision model reads pasted images directly when it can, the plugin falls back otherwise. Plugin first: always read through your configured provider keys first (fallback chain in order), the official model only as a last resort.' ,
        notLoggedIn: 'found, not signed in',
        loadFailed: 'load failed',
        saveFailed: 'save failed',
        envSourced:
          'These come from environment variables. Saving copies them into the config file, which then becomes this engine’s only source.',
      },
      zh: {
        tab: 'VisionForge 配置',
        title: '视觉与图片引擎（VisionForge）',
        subtitle: '视觉理解 + 图片生成，一个卡片配齐。',
        customModel: '自定义模型…',
        customModelPlaceholder: '输入自定义模型 ID（需配置正确密钥）',
        openConfig: '打开配置文件',
        automatic: '自动（不固定，由故障转移链决定）',
        pickToConfigure: '在上面选一个引擎，才能配置它的密钥和地址。',
        engine: '引擎',
        apiKey: 'API 密钥',
        apiKeyHint: '多个密钥用英文逗号分隔。鉴权、限流或配额失败时会自动轮换到下一个密钥。',
        baseUrl: '接口地址',
        model: '模型',
        proxyRoute: '代理方式',
        proxyInherit: '继承全局代理或环境变量',
        proxyDirect: '直连',
        proxyCustom: '使用专属代理',
        proxyUrl: '代理地址',
        proxyStored: '已保存，留空即不改动',
        proxyExample: 'http://127.0.0.1:7890',
        proxyHint: '直连会忽略全局代理与 HTTP_PROXY / HTTPS_PROXY。',
        stored: '已保存，留空即不改动',
        unset: '未设置',
        fallback: '使用该引擎默认值',
        save: '保存',
        saving: '保存中…',
        saved: '已保存',
        savedWithKey: '已保存（API 密钥已更新）',
        savedKeep: '已保存（API 密钥未改动；如需更换请在密钥框输入新 Key 再保存）',
        loading: '加载中…',
        discard: '放弃修改',
        cliNote: '该引擎通过自己的 CLI 登录，无需密钥和接口地址。',
        autoTitle: 'auto 模式',
        autoHint: '自动复用本机已有视觉引擎。',
        priorityRoute: '解析优先级',
        priorityOfficial: '官方优先（默认）',
        priorityPlugin: '插件优先',
        priorityHint: '官方优先：官方视觉模型能看图时直接解析，不能时自动走插件。插件优先：始终先用你配置的提供商密钥解析（按配置顺序轮换），全部失败才尝试官方模型。',
        notLoggedIn: '已找到，未登录',
        loadFailed: '加载失败',
        saveFailed: '保存失败',
        envSourced: '这些值来自环境变量。保存会把它们写进配置文件，此后该引擎只认配置文件。',
      },
    }

    // The copy this card speaks. `active` is dsh's own interface language,
    // when its locale service was there to say. Asked first because the page
    // language is not an answer on dsh 0.1.0-rc.7: the built index.html
    // freezes `<html lang="zh-CN">` and never rewrites it, so a user set to
    // English still read a Chinese card. Absent the service (older
    // hosts, profiles that ship no locale) the page then the browser decide,
    // unchanged.
    function labels(active) {
      var lang = (active || document.documentElement.lang || navigator.language || 'en').toLowerCase()
      return lang.indexOf('zh') === 0 ? TEXT.zh : TEXT.en
    }

    // What the footer says when a request fails. Whatever the server said
    // travels untranslated ('unknown engine: x', a path error): that is the
    // diagnosis, and mapping it to error codes would buy a translation table
    // with a much larger contact surface than this card is worth. Only the
    // silent case, where there is no detail to show, gets a localized line.
    function noteFrom(error, fallback) {
      // An Error whose message is empty is the no-detail case, not a thing to
      // stringify: String(error) on it reads 'Error'.
      var detail = error && typeof error.message === 'string' ? error.message : error ? String(error) : ''
      return detail || fallback
    }

    // The next draft when the engine changes or a summary arrives. The engine
    // fields belong to the newly selected engine; the reuse grants are
    // the user's pending answers and survive an engine switch, since granting
    // codex has nothing to do with which engine reads the images.
    function nextDraft(summary, provider, keepReuse) {
      // provider '' is its own answer: not pinned, the failover chain
      // decides. There is then no single engine whose key belongs in these
      // fields, so they stay empty and the card says how to get them back.
      var engine = summary.engines[provider] || { baseUrl: '', model: '' }
      return {
        provider: provider,
        apiKey: '',
        baseUrl: engine.baseUrl,
        model: engine.model,
        proxyMode: engine.proxyMode || 'inherit',
        // A proxy URL can carry credentials, so the host reports only its
        // mode. Blank means keep the stored custom URL unless one is typed.
        proxy: '',
        visionPriority: summary.visionPriority || 'official',
        reuse: Object.assign({}, keepReuse || summary.reuse),
      }
    }

    // What one save is actually about. The pin travels only when the select
    // moved; the engine fields only when they were edited. A save that always
    // carried both pinned an engine nobody chose and wrote the values the
    // card loaded back over whatever the file holds now.
    function savePayload(summary, draft) {
      var payload = { reuse: {} }
      REUSE.forEach((name) => {
        if (draft.reuse[name] !== summary.reuse[name]) {
          payload.reuse[name] = draft.reuse[name]
        }
      })
      if (draft.provider !== summary.provider) {
        payload.provider = draft.provider
      }
      if (draft.visionPriority !== summary.visionPriority) {
        payload.visionPriority = draft.visionPriority
      }
      var pristine = nextDraft(summary, draft.provider, draft.reuse)
      var apiKey = draft.apiKey || ''
      var baseUrl = draft.baseUrl || ''
      var model = draft.model || ''
      var proxyMode = draft.proxyMode || 'inherit'
      var proxy = draft.proxy || ''
      var apiKeyEdited = apiKey !== ''
      var baseUrlEdited = baseUrl !== pristine.baseUrl
      var modelEdited = model !== pristine.model
      var proxyEdited = proxyMode !== pristine.proxyMode || proxy !== ''
      var engineEdited = apiKeyEdited || baseUrlEdited || modelEdited || proxyEdited
      if (draft.provider !== '' && engineEdited) {
        payload.engine = draft.provider
        if (apiKeyEdited) payload.apiKey = apiKey
        if (baseUrlEdited) payload.baseUrl = baseUrl
        if (modelEdited) payload.model = model
        if (proxyEdited) {
          payload.proxyMode = proxyMode
          // Once the route is inherit or direct, a custom URL is irrelevant
          // and may contain credentials. Do not put stale input on the wire.
          payload.proxy = proxyMode === 'custom' ? proxy : ''
        }
      }
      return payload
    }

    /**
     * How to render key and proxy credential fields with hidden characters.
     *
     * A real password input makes Safari's iCloud Keychain offer to enable
     * autofill for the site and then pop its bubble on every focus, for a
     * field that is always empty: the secret lives in the config file and the
     * host never sends it here, only whether one is stored. `autocomplete`
     * cannot turn that off, because WebKit ignores it on password fields on
     * purpose (issue #56). Masking with text-security gets the same hidden
     * characters without ever being a password field, and it also keeps a
     * machine-local secret out of a synced keychain.
     *
     * Feature-detected rather than assumed. Where the property is missing the
     * field stays a password input: the nuisance is worth more than the
     * alternative, which is somebody's credential rendered in clear text
     * while they type it.
     *
     * This is a trade, not a free win, and the cost falls on people who are
     * not in the room. A password input carries a protected state into the
     * accessibility tree, and screen readers stop reading characters back
     * because of it. Masking is only paint: VoiceOver and NVDA will read this
     * secret aloud, and ARIA has no equivalent to restore. Selection and copy
     * also become possible, and an IME candidate window shows what is being
     * typed above the field. Accepted here because the field is empty in
     * normal use (the stored value is never sent to the browser), so what a
     * screen reader can read back is what the user is
     * typing at that moment, not a stored secret.
     */
    /**
     * Whether this browser masks a text field's characters. Only the prefixed
     * property exists: there is no unprefixed `text-security`, so probing for
     * one would be dead code that reads like a real path.
     *
     * A throwing `supports` counts as no support. The spec says the two
     * argument form returns false for an unknown property rather than
     * throwing, but this runs inside render, where an exception takes the
     * whole settings surface down instead of costing one field.
     */
    function supportsTextSecurity() {
      try {
        return (
          typeof CSS === 'object' &&
          CSS !== null &&
          typeof CSS.supports === 'function' &&
          CSS.supports('-webkit-text-security', 'disc') === true
        )
      } catch {
        return false
      }
    }

    function secretFieldProps() {
      if (!supportsTextSecurity()) {
        return { type: 'password' }
      }
      return {
        type: 'text',
        autoComplete: 'off',
        autoCorrect: 'off',
        autoCapitalize: 'off',
        spellCheck: false,
        style: { WebkitTextSecurity: 'disc' },
      }
    }

    // `localeRef` is a { current } handle on dsh's locale service, not the
    // service itself: it is optional and may land after the card is built,
    // so it is read at render time rather than captured here. Absent, both
    // helpers below hand back nothing and labels() takes its old path.
    function ConfigCard(react, ui, localeRef) {
      var h = react.createElement
      var Input = ui.Input
      // Each load claims a generation. Collapsing before the config arrives
      // invalidates that load because reopening starts a fresh one. Once the
      // form exists, its in-flight discovery stays relevant across collapse.
      // The counter survives renders because ConfigCard is built once.
      var gen = 0

      // Built once per card so useSyncExternalStore is not handed a new
      // subscribe on every render, which would resubscribe every render.
      var subscribeLocale = (onChange) => {
        var locale = localeRef?.current
        return locale ? locale.subscribe(onChange) : () => {}
      }
      var readLocale = () => {
        var locale = localeRef?.current
        return locale ? locale.getSnapshot().active : ''
      }

      // The chrome is the native plugin card's, value for value (border,
      // layer backgrounds, 12px radius, header row with a rotating chevron,
      // footer with discard ghost + save primary), so this card reads as a
      // sibling of the built-in three rather than a lodger.
      var chevron = (open) =>
        h(
          'svg',
          {
            width: 16,
            height: 16,
            viewBox: '0 0 16 16',
            style: {
              color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
              flex: 'none',
              transition: 'transform .16s',
              transform: open ? 'rotate(180deg)' : 'none',
            },
          },
          h('path', {
            d: 'M4 6l4 4 4-4',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.5,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          }),
        )

      return function visionforgeCard() {
        // Subscribed, not sampled: the language is a live setting, and a card
        // sitting open while the user switches has to follow. getSnapshot and
        // subscribe are the pair dsh documents as useSyncExternalStore-safe.
        // That hook is React 18 and up; where it is missing the language is
        // read once per render instead, which still follows a switch as soon
        // as anything re-renders the card. The branch is on a closure
        // constant, so hook order never varies within one card.
        var t = labels(
          typeof react.useSyncExternalStore === 'function'
            ? react.useSyncExternalStore(subscribeLocale, readLocale)
            : readLocale(),
        )
        // The settings page tab opens with the form expanded: it is a page,
        // not a collapsed list row (the old plugin.item card collapsed).
        var openState = react.useState(true)
        var summaryState = react.useState(null)
        var draftState = react.useState(null)
        var noteState = react.useState('')
        var open = openState[0]
        var summary = summaryState[0]
        var draft = draftState[0]
        var note = noteState[0]

        var seed = (next, provider, keepReuse) => nextDraft(next, provider, keepReuse)

        var load = react.useCallback(() => {
          // Config first, so the engine form can render. Discovery is the
          // self-check probing which local harnesses exist to be borrowed,
          // paid after the form is up, cached host-side.
          var id = ++gen
          fetch('/visionforge/config')
            .then((r) =>
              r.json().then((body) => {
                if (!r.ok) throw new Error(body.error || '')
                return body
              }),
            )
            .then((next) => {
              if (id !== gen) return
              summaryState[1](next)
              draftState[1](seed(next, next.provider))
              noteState[1]('')
              return fetch('/visionforge/config?discover=1')
                .then((r) =>
                  r.json().then((body) => {
                    if (!r.ok) throw new Error(body.error || '')
                    return body
                  }),
                )
                .then((discovered) => {
                  if (id !== gen) return
                  summaryState[1]((prev) => {
                    if (!prev) return prev
                    var merged = Object.assign({}, prev)
                    merged.discovery = discovered && 'discovery' in discovered ? discovered.discovery : null
                    return merged
                  })
                })
                .catch(() => {
                  if (id !== gen) return
                  summaryState[1]((prev) => {
                    if (!prev) return prev
                    var merged = Object.assign({}, prev)
                    merged.discovery = null
                    return merged
                  })
                })
            })
            .catch((error) => {
              if (id !== gen) return
              noteState[1](noteFrom(error, t.loadFailed))
            })
        }, [])

        react.useEffect(() => {
          if (open && summary === null) load()
        }, [open, summary, load])

        // A row wrapping ONE control is a label, which names that control. A
        // row wrapping a set of them must not be: the label becomes the first
        // checkbox's accessible name and swallows the whole section's prose.
        // Those rows are a named group instead.
        var fieldRow = (label, control, key, groupName) =>
          h(
            groupName ? 'div' : 'label',
            {
              key: key,
              role: groupName ? 'group' : undefined,
              'aria-label': groupName || undefined,
              style: {
                display: 'flex',
                flexDirection: 'column',
                gap: '6px',
                padding: '12px 0',
                borderTop: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
              },
            },
            h('div', { style: { fontSize: '13px', color: 'var(--dsw-alias-label-secondary, inherit)' } }, label),
            control,
          )

        var body = null
        if (open) {
          if (summary === null || draft === null) {
            body = h(
              'div',
              {
                style: {
                  padding: '12px 0',
                  color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
                  fontSize: '13px',
                },
              },
              note || t.loading,
            )
          } else {
            var keyless = (summary.keyless || []).indexOf(draft.provider) >= 0
            var current = summary.engines[draft.provider] || { hasKey: false }
            var pristine = seed(summary, draft.provider)
            var dirty =
              draft.provider !== summary.provider ||
              draft.apiKey !== '' ||
              draft.baseUrl !== pristine.baseUrl ||
              draft.model !== pristine.model ||
              draft.proxyMode !== pristine.proxyMode ||
              draft.proxy !== '' ||
              draft.visionPriority !== summary.visionPriority ||
              REUSE.some((name) => draft.reuse[name] !== summary.reuse[name])
            var customProxyMissing =
              draft.proxyMode === 'custom' && current.proxyMode !== 'custom' && draft.proxy.trim() === ''
            var canDiscard = dirty && note !== t.saving
            var canSave = canDiscard && !customProxyMissing

            var set = (key, value) => {
              var next = Object.assign({}, draft)
              next[key] = value
              draftState[1](next)
              noteState[1]('')
            }

            var inputProps = (key, placeholder) => ({
              value: draft[key],
              placeholder: placeholder,
              onChange: (event) => {
                set(key, event.target.value)
              },
            })
            var textField = (label, key, type, placeholder) =>
              fieldRow(label, h(Input, Object.assign(inputProps(key, placeholder), { type: type })), key)
            // Its own function rather than a `type` string the caller has to
            // spell right. A sentinel compared with `===` fails open: one
            // typo, or a later edit passing 'text', and the key renders in
            // clear text with every test still green.
            var secretField = (label, key, placeholder) =>
              fieldRow(label, h(Input, Object.assign(inputProps(key, placeholder), secretFieldProps())), key)
            // When a key is already stored the host never sends it to the
            // browser (only hasKey). Show a fixed mask instead of an empty
            // box, and clear it on focus so typing starts fresh; an empty
            // draft keeps meaning 'leave the stored key alone' for save.
            var maskedSecretField = (label, key, placeholder, masked) =>
              fieldRow(
                label,
                h(
                  Input,
                  Object.assign(inputProps(key, placeholder), secretFieldProps(), {
                    value: masked ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' : draft[key],
                    onFocus: () => {
                      if (masked) set(key, '')
                    },
                  }),
                ),
                key,
              )

            // Auto mode: the probes say which harnesses exist on this
            // machine. Found ones get a checkbox with their status; missing
            // ones are named as absent so the list explains itself.
            var probes = Array.isArray(summary.discovery) ? summary.discovery : null
            // Being listed means being found: an absent harness is simply
            // not shown, and only "not signed in" earns a note.
            var autoRows = REUSE.filter((name) => {
              if (!probes) return true
              var probe = probes.find((candidate) => candidate.harness === name)
              return probe ? probe.cliFound : false
            }).map((name) => {
              var probe = probes?.find((candidate) => candidate.harness === name)
              return h(
                'label',
                {
                  key: name,
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    fontSize: '13px',
                  },
                },
                h('input', {
                  type: 'checkbox',
                  checked: Boolean(draft.reuse[name]),
                  onChange: (event) => {
                    var next = Object.assign({}, draft.reuse)
                    next[name] = event.target.checked
                    set('reuse', next)
                  },
                }),
                h('span', null, name),
                probe && probe.loggedIn === false
                  ? h(
                      'span',
                      {
                        style: {
                          color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
                          fontSize: '12px',
                        },
                      },
                      t.notLoggedIn,
                    )
                  : null,
              )
            })

            body = h(
              'div',
              null,
              h(
                'div',
                {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    marginBottom: '14px',
                    padding: '12px 14px',
                    borderRadius: '12px',
                    background: 'linear-gradient(135deg, rgba(76,111,255,0.18), rgba(138,92,255,0.06))',
                    border: '1px solid rgba(76,111,255,0.30)',
                  },
                },
                h(
                  'div',
                  {
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: '36px',
                      height: '36px',
                      borderRadius: '10px',
                      background: 'linear-gradient(135deg, #4c6fff, #8a5cff)',
                      color: '#fff',
                      fontWeight: 700,
                      fontSize: '15px',
                      letterSpacing: '0.5px',
                      flexShrink: 0,
                    },
                  },
                  'VF',
                ),
                h(
                  'div',
                  null,
                  h(
                    'div',
                    { style: { fontWeight: 600, fontSize: '14px' } },
                    t.title,
                  ),
                  h(
                    'div',
                    {
                      style: {
                        fontSize: '12px',
                        color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
                        marginTop: '2px',
                      },
                    },
                    t.subtitle,
                  ),
                ),
              ),
              fieldRow(
                t.engine,
                h(
                  'select',
                  {
                    value: draft.provider,
                    onChange: (event) => {
                      draftState[1](seed(summary, event.target.value, draft.reuse))
                      noteState[1]('')
                    },
                    style: {
                      appearance: 'none',
                      width: '100%',
                      padding: '8px 12px',
                      borderRadius: '8px',
                      border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
                      background: 'transparent',
                      color: 'inherit',
                      font: 'inherit',
                      fontSize: '13px',
                    },
                  },
                  [h('option', { key: '', value: '' }, t.automatic)].concat(
                    ENGINES.map((name) => h('option', { key: name, value: name }, engineDisplay(name))),
                  ),
                ),
                'engine',
              ),
              draft.provider === ''
                ? fieldRow(
                    t.apiKey,
                    h(
                      'div',
                      {
                        style: {
                          fontSize: '13px',
                          color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
                        },
                      },
                      t.pickToConfigure,
                    ),
                    'unpinned',
                  )
                : keyless
                  ? fieldRow(
                      t.apiKey,
                      h(
                        'div',
                        {
                          style: { fontSize: '13px', color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))' },
                        },
                        t.cliNote,
                      ),
                      'clinote',
                    )
                  : maskedSecretField(t.apiKey, 'apiKey', current.hasKey ? t.stored : t.unset, current.hasKey && draft.apiKey === ''),
              draft.provider === '' || keyless
                ? null
                : fieldRow(
                    '',
                    h(
                      'div',
                      {
                        style: {
                          fontSize: '13px',
                          color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
                        },
                      },
                      t.apiKeyHint,
                    ),
                    'api-key-rotation',
                  ),
              draft.provider === '' || keyless ? null : textField(t.baseUrl, 'baseUrl', 'text', t.fallback),
              draft.provider === ''
                ? null
                : fieldRow(
                    t.model,
                    (MODEL_CANDIDATES[draft.provider] || []).length > 0
                      ? h(
                          'div',
                          { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
                          [
                            h(
                              'select',
                              {
                                name: 'model',
                                value:
                                  draft.model === '__custom__' ||
                                  (draft.model !== '' && !MODEL_CANDIDATES[draft.provider].includes(draft.model))
                                    ? '__custom__'
                                    : draft.model || '',
                                onChange: (event) => {
                                  var v = event.target.value
                                  // '__custom__' is a sentinel that reveals the
                                  // free-entry input; the real id comes from it.
                                  if (v === '__custom__') set('model', '__custom__')
                                  else set('model', v)
                                },
                                style: {
                                  appearance: 'none',
                                  width: '100%',
                                  padding: '8px 12px',
                                  borderRadius: '8px',
                                  border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
                                  background: 'transparent',
                                  color: 'inherit',
                                  font: 'inherit',
                                  fontSize: '13px',
                                },
                              },
                              [
                                // A custom model the user typed that is not in
                                // the candidate list stays selectable, plus an
                                // explicit "custom…" entry.
                                ...(draft.model !== '' &&
                                !MODEL_CANDIDATES[draft.provider].includes(draft.model) &&
                                draft.model !== '__custom__'
                                  ? [h('option', { key: '__current', value: '__custom__' }, modelDisplay(draft.model))]
                                  : []),
                                ...MODEL_CANDIDATES[draft.provider].map((m) => h('option', { key: m, value: m }, modelDisplay(m))),
                                h('option', { key: '__custom__', value: '__custom__' }, t.customModel),
                              ],
                            ),
                            draft.model === '__custom__'
                              ? h(Input, {
                                  type: 'text',
                                  value: '',
                                  placeholder: t.customModelPlaceholder,
                                  onChange: (event) => set('model', event.target.value),
                                })
                              : null,
                          ],
                        )
                      : h(Input, Object.assign(inputProps('model', t.fallback), { type: 'text' })),
                    'model',
                  ),
              draft.provider === '' || keyless
                ? null
                : fieldRow(
                    t.proxyRoute,
                    h(
                      'select',
                      {
                        name: 'proxyMode',
                        value: draft.proxyMode,
                        onChange: (event) => set('proxyMode', event.target.value),
                        style: {
                          appearance: 'none',
                          width: '100%',
                          padding: '8px 12px',
                          borderRadius: '8px',
                          border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
                          background: 'transparent',
                          color: 'inherit',
                          font: 'inherit',
                          fontSize: '13px',
                        },
                      },
                      [
                        h('option', { key: 'inherit', value: 'inherit' }, t.proxyInherit),
                        h('option', { key: 'direct', value: 'direct' }, t.proxyDirect),
                        h('option', { key: 'custom', value: 'custom' }, t.proxyCustom),
                      ],
                    ),
                    'proxy-mode',
                  ),
              draft.provider === '' || keyless
                ? null
                : fieldRow(
                    '',
                    h(
                      'div',
                      {
                        style: {
                          fontSize: '13px',
                          color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
                        },
                      },
                      t.proxyHint,
                    ),
                    'proxy-hint',
                  ),
              draft.provider === '' || keyless || draft.proxyMode !== 'custom'
                ? null
                : secretField(t.proxyUrl, 'proxy', current.proxyMode === 'custom' ? t.proxyStored : t.proxyExample),
              // Where these values are coming from, said once, because the
              // first save moves them: an engine the file names takes its
              // settings from the file alone.
              draft.provider === '' || current.source !== 'env'
                ? null
                : fieldRow(
                    '',
                    h(
                      'div',
                      {
                        style: {
                          fontSize: '13px',
                          color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
                        },
                      },
                      t.envSourced,
                    ),
                    'envsourced',
                  ),
              fieldRow(
                t.priorityRoute,
                h(
                  'select',
                  {
                    name: 'visionPriority',
                    value: draft.visionPriority,
                    onChange: (event) => set('visionPriority', event.target.value),
                    style: {
                      appearance: 'none',
                      width: '100%',
                      padding: '8px 12px',
                      borderRadius: '8px',
                      border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
                      background: 'transparent',
                      color: 'inherit',
                      font: 'inherit',
                      fontSize: '13px',
                    },
                  },
                  [
                    h('option', { key: 'official', value: 'official' }, t.priorityOfficial),
                    h('option', { key: 'plugin', value: 'plugin' }, t.priorityPlugin),
                  ],
                ),
                'vision-priority',
              ),
              fieldRow(
                '',
                h(
                  'div',
                  {
                    style: {
                      fontSize: '13px',
                      color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
                    },
                  },
                  t.priorityHint,
                ),
                'vision-priority-hint',
              ),
              fieldRow(
                h(
                  'span',
                  null,
                  t.autoTitle,
                  h(
                    'span',
                    {
                      style: {
                        color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
                        fontWeight: 400,
                        marginLeft: '8px',
                      },
                    },
                    t.autoHint,
                  ),
                ),
                h(
                  'div',
                  { style: { display: 'flex', flexWrap: 'wrap', gap: '10px 18px', paddingTop: '2px' } },
                  'discovery' in summary ? autoRows : t.loading,
                ),
                'auto',
                t.autoTitle,
              ),
              h(
                'div',
                {
                  key: 'footer',
                  style: {
                    borderTop: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
                    display: 'flex',
                    justifyContent: 'flex-end',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '12px 0 4px',
                  },
                },
                h(
                  'a',
                  {
                    href: '#',
                    onClick: (event) => {
                      event.preventDefault()
                      fetch('/visionforge/config', {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ open: true }),
                      }).catch(() => {})
                    },
                    style: {
                      fontSize: '12px',
                      color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
                      textDecoration: 'underline',
                      textUnderlineOffset: '2px',
                    },
                  },
                  t.openConfig,
                ),
                h(
                  'span',
                  {
                    role: 'status',
                    style: {
                      marginRight: 'auto',
                      marginLeft: '10px',
                      fontSize: '12px',
                      color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
                    },
                  },
                  note,
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    disabled: !canDiscard,
                    onClick: () => {
                      draftState[1](seed(summary, summary.provider))
                      noteState[1]('')
                    },
                    style: {
                      appearance: 'none',
                      font: 'inherit',
                      fontSize: '13px',
                      lineHeight: 1.5,
                      cursor: canDiscard ? 'pointer' : 'default',
                      border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
                      borderRadius: '8px',
                      padding: '5px 14px',
                      background: 'none',
                      color: 'var(--dsw-alias-label-secondary, inherit)',
                      opacity: canDiscard ? 1 : 0.4,
                    },
                  },
                  t.discard,
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    disabled: !canSave,
                    onClick: () => {
                      noteState[1](t.saving)
                      var payload = savePayload(summary, draft)
                      fetch('/visionforge/config', {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify(payload),
                      })
                        .then((r) =>
                          r.json().then((payload) => {
                            if (!r.ok) throw new Error(payload.error || '')
                            return payload
                          }),
                        )
                        .then((next) => {
                          // The save response carries no discovery. Read the
                          // current state here because the lazy probe may have
                          // landed after this save began.
                          summaryState[1]((prev) => {
                            if (!prev || !('discovery' in prev)) return next
                            var merged = Object.assign({}, next)
                            merged.discovery = prev.discovery
                            return merged
                          })
                          draftState[1](seed(next, next.provider))
                          noteState[1](payload.apiKey !== undefined ? t.savedWithKey : t.savedKeep)
                        })
                        .catch((error) => {
                          noteState[1](noteFrom(error, t.saveFailed))
                        })
                    },
                    style: {
                      appearance: 'none',
                      font: 'inherit',
                      fontSize: '13px',
                      lineHeight: 1.5,
                      cursor: canSave ? 'pointer' : 'default',
                      border: '1px solid transparent',
                      borderRadius: '8px',
                      padding: '5px 14px',
                      background: 'var(--dsw-alias-label-primary, currentColor)',
                      color: 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.05))',
                      opacity: canSave ? 1 : 0.4,
                    },
                  },
                  t.save,
                ),
              ),
            )
          }
        }

        return h(
          'div',
          {
            style: {
              border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
              background: open
                ? 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.10))'
                : 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.05))',
              borderRadius: '12px',
              transition: 'border-color .16s, background .16s',
            },
          },
          h(
            'button',
            {
              type: 'button',
              'aria-expanded': open,
              onClick: () => {
                if (open && summary === null) gen += 1
                openState[1](!open)
              },
              style: {
                appearance: 'none',
                width: '100%',
                font: 'inherit',
                color: 'inherit',
                textAlign: 'left',
                cursor: 'pointer',
                background: 'none',
                border: 0,
                borderRadius: '12px',
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                padding: '14px 16px',
              },
            },
            h(
              'div',
              { style: { flex: 1, minWidth: 0 } },
              h('div', { style: { fontSize: '14px', fontWeight: 600 } }, t.title),
              h(
                'div',
                {
                  style: {
                    color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
                    fontSize: '13px',
                    lineHeight: 1.5,
                  },
                },
                t.subtitle,
              ),
            ),
            chevron(open),
          ),
          open ? h('div', { style: { margin: '0 16px', paddingBottom: '8px' } }, body) : null,
        )
      }
    }

    function registerCard(ctx) {
      // Reaching for an undeclared service throws in cordis, so each optional
      // dependency rides a scoped ctx.inject of its own: the closure runs
      // where the service exists and never runs where it does not, exactly as
      // the host half takes webServer.
      if (typeof ctx.inject !== 'function') return

      // dsh's language service gets an inject of its own, and fills a handle
      // the card reads later. Listing it beside slots would be worse than
      // useless: ctx.inject waits for every service named, so on a host that
      // never provides locale the card would never register at all. Here a
      // missing service just leaves the handle empty, and the card falls back
      // to the page language.
      var localeRef = { current: null }
      ctx.inject(['locale'], (scope) => {
        localeRef.current = scope.locale
        if (typeof scope.effect === 'function') {
          scope.effect(
            () => () => {
              localeRef.current = null
            },
            'visionforge: locale handle',
          )
        }
      })

      ctx.inject(['slots'], (scope) => {
        // The card and its route live and die together: with the host route
        // off (settingsCard: false, or no web profile) a card would only
        // render an error, which is not what turning a feature off means.
        // Any response at all proves the route exists; only a 404 or a
        // network failure reads as absent. A 403 is the route's same-origin
        // loopback fence turning this page away, which is just as permanent,
        // so the card stays away there too.
        fetch('/visionforge/config')
          .then((response) => {
            if (response.status === 404 || response.status === 403) return
            try {
              mountCard(scope, localeRef)
            } catch (error) {
              console.error(`[visionforge] settings card skipped: ${error}`)
            }
          })
          .catch(() => {})
      })
    }

    function mountCard(ctx, localeRef) {
      var react
      try {
        react = require('react')
      } catch (error) {
        console.error(`[visionforge] settings card skipped: ${error}`)
        return
      }
      var ui = require('@deepseek-ai/dsh-client-ui-primitives')
      var Card = ConfigCard(react, ui, localeRef)
      // dsh 0.1.7 settings page: the Plugins section renders feature-owned
      // tabs from the `settings.plugins.tab` list slot; the old per-plugin
      // card slot `settings.plugin.item` was removed, so a card registered
      // there never renders on this host. Register a tab instead — the
      // Plugins section lists it and renders this page when selected.
      ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
        name: 'settings.plugins.tab',
        id: 'visionforge',
        order: 30,
        label: () => labels(localeRef?.current?.getSnapshot?.().active || '').tab,
      }, Card))
    }

    // Generated-image preview styling: keep the in-chat thumbnail small and
    // zoom it in on hover (the local /visionforge/image route renders without a
    // download header, so the browser never starts a download).
    // Generated-image preview styling: keep the in-chat thumbnail small.
    // Zooming is left to the host: the card's own "放大" button and a click
    // on the image open in DSH's built-in viewer, the local image viewer the
    // desktop app ships with. No in-chat lightbox is injected, so zooming
    // always follows the host viewer.
    function injectPreviewStyles() {
      try {
        var style = document.createElement('style')
        style.textContent =
          'img[src*="/visionforge/image"], img[data-vf-src]{' +
          'max-width:90px !important;max-height:90px !important;height:auto;' +
          'border-radius:8px;cursor:zoom-in;' +
          'transition:transform .18s ease,box-shadow .18s ease;' +
          'box-shadow:0 2px 8px rgba(0,0,0,.14);' +
          '}'
        ;(document.head || document.documentElement).appendChild(style)
        scanThumbs(document)
        try {
          new MutationObserver(function () { scanThumbs(document) }).observe(document.body || document.documentElement, { childList: true, subtree: true })
        } catch (err) { /* observer is a nicety */ }
        // Zooming opens the original file in the machine's default image
        // viewer (Windows photo app / default viewer) via the local
        // /visionforge/open route — not DSH's built-in viewer, not an in-chat
        // lightbox. Both a click on the thumbnail and the host card's own
        // "放大/zoom" button are routed there.
        // Renderer-level fallback: some DSH builds block <img> loads from the
        // loopback http origin, leaving the generated picture as a broken
        // thumbnail. Fetch the bytes ourselves (the same localhost fetch the
        // zoom/download routes already use), downscale through a canvas and
        // swap in a data: URL so the thumbnail always renders. The original
        // loopback src is remembered in data-vf-src so zoom/download still
        // resolve the real file path from it.
        var THUMB_SIZE = 180
        function hydrateThumb(img) {
          try {
            if (img.__vfThumb) return
            img.__vfThumb = true
            var src = img.getAttribute('src')
            if (!src) return
            img.setAttribute('data-vf-src', src)
            if (img.complete && img.naturalWidth > 0) return
            fetch(src)
              .then(function (r) { if (!r.ok) throw new Error('thumb fetch ' + r.status); return r.blob() })
              .then(function (blob) {
                return new Promise(function (resolveP, rejectP) {
                  var url = URL.createObjectURL(blob)
                  var im = new Image()
                  im.onload = function () {
                    try {
                      var w = im.naturalWidth || 1
                      var h = im.naturalHeight || 1
                      var scale = Math.min(1, THUMB_SIZE / Math.max(w, h))
                      var cw = Math.max(1, Math.round(w * scale))
                      var ch = Math.max(1, Math.round(h * scale))
                      var cv = document.createElement('canvas')
                      cv.width = cw
                      cv.height = ch
                      cv.getContext('2d').drawImage(im, 0, 0, cw, ch)
                      img.src = cv.toDataURL('image/jpeg', 0.82)
                      resolveP()
                    } catch (e) { rejectP(e) } finally { URL.revokeObjectURL(url) }
                  }
                  im.onerror = function (e) { URL.revokeObjectURL(url); rejectP(e) }
                  im.src = url
                })
              })
              .catch(function () { /* keep the original src; the host may still render it */ })
          } catch (err) { /* fallback is a nicety */ }
        }
        function scanThumbs(root) {
          try {
            var imgs = root.querySelectorAll ? root.querySelectorAll('img[src*="/visionforge/image"]') : []
            for (var i = 0; i < imgs.length; i++) hydrateThumb(imgs[i])
          } catch (err) { /* scan is a nicety */ }
        }
        var lastOpenAt = 0
        function openInSystemViewer(src) {
          try {
            var now = Date.now()
            if (now - lastOpenAt < 2000) return
            lastOpenAt = now
            var u = new URL(src)
            var p = u.searchParams.get('path')
            if (p) fetch(u.origin + '/visionforge/open?path=' + encodeURIComponent(p)).catch(function () {})
          } catch (err) {
            // ignore malformed src
          }
        }
        function findCardImage(elm) {
          var host = elm
          while (host && host !== document.body) {
            var img = host.querySelector && host.querySelector('img[src*="/visionforge/image"], img[data-vf-src]')
            if (img) return img
            host = host.parentNode
          }
          return null
        }
        function toast(msg) {
          try {
            var t = document.createElement('div')
            t.textContent = msg
            t.style.cssText =
              'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:100000;' +
              'background:rgba(20,20,20,.92);color:#fff;padding:10px 18px;border-radius:10px;' +
              'font-size:13px;box-shadow:0 6px 24px rgba(0,0,0,.4);max-width:80vw;'
            ;(document.body || document.documentElement).appendChild(t)
            setTimeout(function () {
              if (t.parentNode) t.parentNode.removeChild(t)
            }, 4500)
          } catch (err) {
            // toast is a nicety
          }
        }
        var lastSaveAt = 0
        function downloadLocal(src) {
          try {
            var now = Date.now()
            if (now - lastSaveAt < 2000) return
            lastSaveAt = now
            var u = new URL(src)
            var p = u.searchParams.get('path')
            if (!p) return
            fetch(u.origin + '/visionforge/download-local?path=' + encodeURIComponent(p))
              .then(function (r) {
                return r.json().catch(function () {
                  return {}
                })
              })
              .then(function (j) {
                if (j && j.ok) toast('已从缓存复制到 ' + (j.file || 'D 盘根目录') + '\n缓存位置：' + (j.source || '') + '\n已打开所在目录')
                else toast('保存失败：服务端未确认，请查看控制台')
              })
              .catch(function (err) {
                console.error('[visionforge] download-local failed', err)
                toast('本地保存失败：' + (err && err.message ? err.message : err))
              })
          } catch (err) {
            console.error('[visionforge] downloadLocal error', err)
          }
        }
        // The zoom button duplicates clicking the image itself, so hide it.
        // Use the same wide selector as the click interceptor and walk into
        // shadow roots, where the host card may render its buttons.
        function hideHostZoomButtons() {
          try {
            var queue = [document]
            var guard = 0
            while (queue.length > 0 && guard < 300) {
              var root = queue.shift()
              guard++
              var els = root.querySelectorAll
                ? root.querySelectorAll('button, [role="button"], a, [class*="zoom" i], [class*="enlarge" i], [class*="btn" i], [class*="button" i]')
                : []
              for (var i = 0; i < els.length; i++) {
                var el = els[i]
                var t = (el.textContent || '').trim()
                if (t.length > 0 && t.length <= 12 && (t.indexOf('放大') >= 0 || /zoom|enlarge/i.test(t))) {
                  if (findCardImage(el)) el.style.display = 'none'
                }
              }
              var all = root.querySelectorAll ? root.querySelectorAll('*') : []
              for (var j = 0; j < all.length; j++) {
                if (all[j].shadowRoot) queue.push(all[j].shadowRoot)
              }
            }
          } catch (err) { /* hiding is a nicety */ }
        }
        function attachZoomShadowObservers(root) {
          try {
            var all = root.querySelectorAll ? root.querySelectorAll('*') : []
            for (var i = 0; i < all.length; i++) {
              if (all[i].shadowRoot && !all[i].__vfObs) {
                all[i].__vfObs = true
                new MutationObserver(hideHostZoomButtons).observe(all[i].shadowRoot, { childList: true, subtree: true })
                attachZoomShadowObservers(all[i].shadowRoot)
              }
            }
          } catch (err) { /* observer is a nicety */ }
        }
        hideHostZoomButtons()
        attachZoomShadowObservers(document)
        try {
          new MutationObserver(function () { hideHostZoomButtons() }).observe(document.body || document.documentElement, { childList: true, subtree: true })
        } catch (err) { /* observer is a nicety */ }
        document.addEventListener(
          'click',
          function (event) {
            var target = event.target
            if (!target || !target.closest) return
            var img = target.closest('img[src*="/visionforge/image"], img[data-vf-src]')
            if (img) {
              event.preventDefault()
              event.stopPropagation()
              openInSystemViewer(img.getAttribute('data-vf-src') || img.getAttribute('src'))
              return
            }
            // The host card's own zoom / download buttons: route zoom to the
            // system viewer and download to the local save (D: root + reveal),
            // so neither depends on DSH's open-with setting. The host may
            // render these as plain elements without button-ish classes, so a
            // short-label text scan up the tree is the fallback.
            var btn = target.closest(
              'button, [role="button"], a, [class*="zoom" i], [class*="enlarge" i], [class*="download" i], [class*="save" i], [class*="action" i], [class*="btn" i], [class*="button" i]',
            )
            if (!btn) {
              var walk = target
              while (walk && walk !== document.body) {
                if (walk.nodeType === 1) {
                  var wtxt = (walk.textContent || '').trim()
                  if (wtxt.length > 0 && wtxt.length <= 12 && /下载|download|save|放大|zoom|enlarge/i.test(wtxt)) {
                    if (findCardImage(walk)) {
                      btn = walk
                      break
                    }
                  }
                }
                walk = walk.parentNode
              }
            }
            if (btn) {
              var cardImg = findCardImage(btn)
              if (!cardImg) return
              var txt = btn.textContent || ''
              // Only swallow the click when the label really is download;
              // otherwise let the host's own handler run (never break the host UI).
              // Zoom buttons are hidden below (redundant with clicking the image).
              if (/放大|zoom|enlarge/i.test(txt)) {
                // Zoom duplicates clicking the image; suppress the host
                // side-panel behaviour and remove the button entirely.
                event.preventDefault()
                event.stopPropagation()
                btn.style.display = 'none'
              } else if (/下载|download|save/i.test(txt)) {
                event.preventDefault()
                event.stopPropagation()
                downloadLocal(cardImg.getAttribute('data-vf-src') || cardImg.getAttribute('src'))
              }
            }
          },
          true,
        )
      } catch (error) {
        console.error('[visionforge] preview styles skipped: ' + error)
      }
    }

    function apply(ctx) {
      registerCard(ctx)
      injectPreviewStyles()
      document.addEventListener('paste', onPaste, true)
      document.addEventListener('focusin', onFocusIn, true)
      // cordis effect: unregister on plugin disposal (HMR, profile reload).
      if (typeof ctx.effect === 'function') {
        ctx.effect(
          () => () => {
            document.removeEventListener('paste', onPaste, true)
            document.removeEventListener('focusin', onFocusIn, true)
          },
          'visionforge: paste-to-path listener',
        )
      }
    }

    exports.apply = apply
    // Exposed for the repo's tests only; not part of the plugin contract.
    exports.__card = {
      nextDraft: nextDraft,
      savePayload: savePayload,
      secretFieldProps: secretFieldProps,
      ConfigCard: ConfigCard,
    }
    // `slots` and `locale` are both optional, so neither is required here:
    // registerCard takes each on its own scoped inject.
    exports.inject = []
    return module.exports
  },
})
