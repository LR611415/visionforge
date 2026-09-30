// VisionForge — 浏览器端（client half）。
// 职责：① 粘贴图片接管（转路径/预览浮条）；② 生成图预览样式（90px 缩略图、
// 点击走系统图片查看器、下载走本地保存）；③ 设置卡片（settings.plugins.tab 槽位）。
// 与宿主通信全部走插件自有回环路由（/visionforge/*），不触碰宿主内部 API 之外的任何东西。
window.__ModuleLoader__.load({
  id: '@lr611/visionforge',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    // ---- 粘贴：从剪贴板事件里取图片文件 ------------------------------------
    function grabImageFiles(event) {
      var items = event.clipboardData && event.clipboardData.items
      if (!items) return []
      var files = []
      for (var i = 0; i < items.length; i++) {
        var it = items[i]
        if (!it || it.kind !== 'file') continue
        var f = it.getAsFile()
        if (f && /^image\//.test(f.type)) files.push(f)
      }
      return files
    }

    function isPlainInput(el) {
      return !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')
    }

    function isComposer(el) {
      if (!el || typeof el.getAttribute !== 'function') return false
      if (el.getAttribute('data-composer-input') == null) return false
      return el.isContentEditable === true || el.contentEditable === 'true'
    }

    function writableOf(el) {
      return isPlainInput(el) || isComposer(el)
    }

    function resolveTarget(el) {
      if (!el) return null
      if (isPlainInput(el)) return el
      if (isComposer(el)) return el
      var node = el
      while (node && node !== document.body) {
        if (isPlainInput(node) || isComposer(node)) return node
        node = node.parentNode
      }
      return null
    }

    function insertText(el, text) {
      if (!el) return false
      if (isPlainInput(el)) {
        var start = el.selectionStart
        var end = el.selectionEnd
        var cur = el.value
        el.value = cur.slice(0, start) + text + cur.slice(end)
        var caret = start + text.length
        el.setSelectionRange(caret, caret)
        return true
      }
      if (isComposer(el)) {
        var sel = window.getSelection()
        if (sel && sel.rangeCount > 0 && el.contains(sel.getRangeAt(0).commonAncestorContainer)) {
          var range = sel.getRangeAt(0)
          range.deleteContents()
          var textNode = document.createTextNode(text)
          range.insertNode(textNode)
          range.setStartAfter(textNode)
          range.collapse(true)
          sel.removeAllRanges()
          sel.addRange(range)
          return true
        }
        el.appendChild(document.createTextNode(text))
        return true
      }
      return false
    }

    function stripInsertedMark(el, mark) {
      if (isPlainInput(el)) {
        el.value = el.value.replace(mark, '')
        return
      }
      var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null)
      var nodes = []
      while (walker.nextNode()) nodes.push(walker.currentNode)
      for (var i = 0; i < nodes.length; i++) {
        var idx = nodes[i].nodeValue.indexOf(mark)
        if (idx === -1) continue
        var parent = nodes[i].parentNode
        if (idx > 0) parent.insertBefore(document.createTextNode(nodes[i].nodeValue.slice(0, idx)), nodes[i])
        var rest = nodes[i].nodeValue.slice(idx + mark.length)
        if (rest.length > 0) parent.insertBefore(document.createTextNode(rest), nodes[i].nextSibling)
        parent.removeChild(nodes[i])
        return
      }
    }

    function uploadOne(file) {
      return new Promise(function (resolve, reject) {
        var reader = new FileReader()
        reader.onerror = function () { reject(new Error('read failed')) }
        reader.onload = function () {
          var buf = reader.result
          fetch('/visionforge/paste', {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
            body: buf,
          })
            .then(function (r) {
              if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || 'HTTP ' + r.status) })
              return r.json()
            })
            .then(function (j) { resolve(j.path) })
            .catch(reject)
        }
        reader.readAsArrayBuffer(file)
      })
    }

    // ---- 粘贴浮条（缩略图 + 每项删除）---------------------------------------
    var previewBar = null
    var barItems = []

    function buildPreviewBar(entries) {
      var bar = document.createElement('div')
      bar.style.cssText =
        'position:fixed;left:16px;bottom:16px;z-index:2147483646;display:flex;gap:8px;align-items:center;' +
        'padding:8px 10px;border-radius:10px;background:rgba(24,24,27,.92);box-shadow:0 6px 24px rgba(0,0,0,.35)'
      entries.forEach(function (entry, index) {
        var wrap = document.createElement('span')
        wrap.style.cssText = 'position:relative;display:inline-block'
        var img = document.createElement('img')
        img.src = entry.url
        img.style.cssText = 'width:56px;height:56px;object-fit:cover;border-radius:6px;display:block'
        var x = document.createElement('button')
        x.textContent = '×'
        x.title = '移除这张图片'
        x.style.cssText =
          'position:absolute;top:-6px;right:-6px;width:18px;height:18px;line-height:16px;text-align:center;' +
          'border-radius:50%;border:0;background:#e5484d;color:#fff;font-size:12px;cursor:pointer;padding:0'
        x.addEventListener('click', function () {
          stripInsertedMark(lastTarget, entry.mark)
          barItems.splice(index, 1)
          var still = barItems.length
          if (still === 0) dismissPreviewBar()
          else rebuildPreviewBar()
        })
        wrap.appendChild(img)
        wrap.appendChild(x)
        bar.appendChild(wrap)
      })
      return bar
    }

    function rebuildPreviewBar() {
      if (!previewBar || !previewBar.parentNode) return
      var fresh = buildPreviewBar(barItems)
      previewBar.parentNode.replaceChild(fresh, previewBar)
      previewBar = fresh
    }

    function showPreviewBar() {
      if (previewBar && previewBar.parentNode) return
      previewBar = buildPreviewBar(barItems)
      document.body.appendChild(previewBar)
    }

    function dismissPreviewBar() {
      if (previewBar && previewBar.parentNode) previewBar.parentNode.removeChild(previewBar)
      previewBar = null
      barItems = []
    }

    // ---- 接管判定：当前模型能否自己看图 --------------------------------------
    var lastTarget = null
    var verdictCache = {}
    var routeStandDown = false
    var lastVerdictAt = 0

    function modelLabel() {
      var el = document.querySelector('[data-current-model]') || document.querySelector('[class*="model-selector"] [class*="selected"]')
      return el ? (el.getAttribute('data-current-model') || el.textContent || '').trim() : ''
    }

    function refreshVerdict() {
      if (routeStandDown) return Promise.resolve(false)
      var label = modelLabel()
      var now = Date.now()
      if (verdictCache[label] && now - lastVerdictAt < 60 * 1000) {
        return Promise.resolve(verdictCache[label])
      }
      return fetch('/visionforge/paste?model=' + encodeURIComponent(label), { method: 'GET' })
        .then(function (r) {
          if (r.status === 404 || r.status === 403) {
            routeStandDown = true
            return false
          }
          if (!r.ok) return false
          return r.json()
        })
        .then(function (j) {
          var take = !!(j && j.takeover)
          verdictCache[label] = take
          lastVerdictAt = now
          return take
        })
        .catch(function () { return false })
    }

    function onFocusIn(event) {
      var target = resolveTarget(event.target)
      if (target) lastTarget = target
    }

    function onPaste(event) {
      var files = grabImageFiles(event)
      if (files.length === 0) return
      var target = resolveTarget(event.target)
      if (!target) return
      var needed = true
      refreshVerdict().then(function (take) {
        if (!take) return
        if (!needed) return
        needed = false
        event.preventDefault()
        event.stopImmediatePropagation()
        handlePastedFiles(files, target)
      })
    }

    function handlePastedFiles(files, target) {
      var pending = files.map(function (file) {
        return uploadOne(file).then(function (path) {
          var ext = path.split('.').pop() || 'png'
          var previewUrl = '/visionforge/image?path=' + encodeURIComponent(path)
          var mark = '![图片](' + previewUrl + ') '
          insertText(target, mark)
          barItems.push({ url: previewUrl, mark: mark, ext: ext })
          showPreviewBar()
        })
      })
      Promise.all(pending).catch(function (error) {
        console.error('[visionforge] paste failed: ' + error)
      })
    }

    // ---- 生成图：预览样式 + 点击系统查看器 + 下载本地保存 ----------------------
    // 基于缩略图 src 的 loopback origin 构造完整 URL（页面 origin 不是 loopback，
    // 相对路径会 404 —— 老版本 ef6c3a9 用 src.origin + /open，这是可用机制）。
    function openSystemViewer(src) {
      try {
        var u = new URL(src)
        var p = u.searchParams.get('path')
        if (!p) return
        fetch(u.origin + '/visionforge/open?path=' + encodeURIComponent(p), { method: 'GET' }).catch(function () {})
      } catch (err) { /* ignore malformed src */ }
    }

    // 基于链接/缩略图 src 的 loopback origin 构造完整 URL；服务端 /visionforge/download-local
    // 返回 JSON（复制到 D 盘根 + 定位），不经过宿主侧边栏。
    function downloadLocal(src) {
      try {
        var u = new URL(src)
        var p = u.searchParams.get('path')
        if (!p) return
        fetch(u.origin + '/visionforge/download-local?path=' + encodeURIComponent(p), { method: 'GET' })
          .then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status)
            return r.json()
          })
          .then(function (j) {
            if (j && j.file) showToast('已保存到 ' + j.file)
          })
          .catch(function (error) {
            console.error('[visionforge] download failed: ' + error)
            showToast('下载失败：' + (error && error.message ? error.message : error))
          })
      } catch (err) {
        console.error('[visionforge] downloadLocal error', err)
      }
    }

    var toastTimer = null
    function showToast(text) {
      var old = document.querySelector('[data-vf-toast]')
      if (old && old.parentNode) old.parentNode.removeChild(old)
      var box = document.createElement('div')
      box.setAttribute('data-vf-toast', '1')
      box.textContent = text
      box.style.cssText =
        'position:fixed;left:50%;bottom:64px;transform:translateX(-50%);z-index:2147483647;' +
        'padding:10px 18px;border-radius:8px;background:rgba(24,24,27,.95);color:#fff;font-size:13px;' +
        'box-shadow:0 6px 20px rgba(0,0,0,.35);max-width:70vw;word-break:break-all'
      document.body.appendChild(box)
      if (toastTimer) clearTimeout(toastTimer)
      toastTimer = setTimeout(function () {
        if (box.parentNode) box.parentNode.removeChild(box)
      }, 5000)
    }

    // 从缩略图 <img> 解析出真实缓存路径：预览 URL 形如 /visionforge/image?path=...
    function cachePathOf(img) {
      var src = img.getAttribute('src') || ''
      var m = src.match(/[?&]path=([^&]+)/)
      return m ? decodeURIComponent(m[1]) : ''
    }

    function injectPreviewStyles() {
      try {
        var style = document.createElement('style')
        style.setAttribute('data-vf-styles', '1')
        style.textContent =
          'img[src*="/visionforge/image"]{max-width:90px!important;max-height:90px!important;' +
          'cursor:zoom-in;border-radius:6px;object-fit:cover;vertical-align:middle}'
        ;(document.head || document.documentElement).appendChild(style)

        document.addEventListener('click', function (event) {
          // 向上查找：点击可能落在 img 本身或宿主包它的容器（div/figure）上。
          var el = event.target
          while (el && el !== document.body) {
            if (el.tagName === 'IMG' && /visionforge\/image/.test(el.getAttribute('src') || '')) {
              var path = cachePathOf(el)
              if (!path) return
              event.preventDefault()
              event.stopPropagation()
              // 诊断：命中后上报，定位"点图无反应"卡在哪一环（无记录 = 监听器未触发）。
              try {
                fetch('/visionforge/click-debug?path=' + encodeURIComponent(path), { method: 'GET' }).catch(function () {})
              } catch (err) { /* diagnostic is best-effort */ }
              openSystemViewer(el.getAttribute('src') || '')
              return
            }
            el = el.parentNode
          }
        }, true)

        // 宿主可能给生成图卡片渲染「放大」按钮；它与「点击图片即查看」重复，
        // 且会打开宿主侧边栏而非系统查看器 —— 拦截并隐藏。
        var hidden = new WeakSet()
        var hideZoom = function () {
          document.querySelectorAll('button').forEach(function (btn) {
            if (hidden.has(btn)) return
            var txt = (btn.textContent || '').trim()
            if (/放大|zoom|enlarge/i.test(txt)) {
              hidden.add(btn)
              btn.style.display = 'none'
            }
          })
        }
        hideZoom()
        setInterval(hideZoom, 4000)

        // 下载/保存链接（/visionforge/download、download-local、save-local）被宿主渲染成按钮时，
        // 统一改走本地保存（复制到 D 盘根并定位，不经过宿主侧边栏）。
        document.addEventListener('click', function (event) {
          var anchor = event.target
          while (anchor && anchor.tagName !== 'A') anchor = anchor.parentNode
          if (!anchor) return
          var href = anchor.getAttribute('href') || ''
          if (!/visionforge\/(download|download-local|save-local)/.test(href)) return
          event.preventDefault()
          event.stopPropagation()
          downloadLocal(href)
        }, true)
      } catch (error) {
        console.error('[visionforge] preview styles skipped: ' + error)
      }
    }

    // ---- 设置卡片（settings.plugins.tab 槽位）----------------------------------
    var ENGINES = [
      { id: 'antigravity-cli', label: 'Antigravity', keyless: true, baseUrl: '', models: [] },
      { id: 'gemini-api', label: 'Gemini', keyless: false, baseUrl: 'https://generativelanguage.googleapis.com', models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-pro'] },
      { id: 'openai', label: 'OpenAI', keyless: false, baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4-turbo'] },
      { id: 'qwen', label: 'Qwen', keyless: false, baseUrl: 'https://maas.qianwenaiapi.com/compatible-mode/v1', models: ['qwen3.8-max', 'qwen3.7-max', 'qwen3-vl-plus', 'qwen3-vl-flash', 'qwen-image-3.0', 'qwen-image-2.0', 'qwen-max', 'qwen-plus', 'qwen-flash', 'qwen-turbo'] },
      { id: 'anthropic', label: 'Anthropic', keyless: false, baseUrl: 'https://api.anthropic.com', models: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-5', 'claude-3-7-sonnet', 'claude-3-5-sonnet'] },
      { id: 'claude-cli', label: 'Claude', keyless: true, baseUrl: '', models: [] },
      { id: 'kimi-cli', label: 'Kimi', keyless: true, baseUrl: '', models: [] },
    ]
    var MODEL_DISPLAY = {}
    var TEXT = {
      en: {
        title: 'VisionForge 视觉引擎',
        engine: 'Engine',
        apiKey: 'API Key',
        baseUrl: 'Base URL',
        model: 'Model',
        priority: 'Reading priority',
        priorityOfficial: 'Official first',
        priorityPlugin: 'Plugin first',
        outputDir: 'Output directory',
        paste: 'Paste takeover',
        pasteOn: 'On',
        pasteOff: 'Off',
        save: 'Save',
        openFull: 'Open full settings page',
        saved: 'Saved',
        devOptions: 'Developer options (response format / timeout / proxy / extraBody)',
        respFormat: 'Response format (structuredOutput)',
        respFollow: 'Follow engine (default)',
        respStrict: 'Force structured output (read JSON schema)',
        respOff: 'Off',
        timeoutMs: 'Request timeout (ms)',
        proxyMode: 'Proxy mode',
        proxyInherit: 'Inherit global (default)',
        proxyDirect: 'Force direct',
        proxyCustom: 'Custom proxy',
        extraBody: 'Request body extra (extraBody JSON)',
        reqTemplate: 'Custom request template (official JSON fallback)',
        reqTemplateHint: 'Only for engines whose request format is incompatible with built-in protocol families. Paste official request/response JSON examples (see web settings page) into this template JSON; placeholders: {{PROMPT}} / {{IMAGE1..3}} / {{MODEL}} / {{API_KEY}} / {{BASE_URL}} / {{SIZE}} / {{SIZE_X}}(1024x1024) / {{SIZE_STAR}}(1024*1024) / {{COUNT}}. Whole-node {{COUNT}}/{{SIZE}} placeholders keep numeric types automatically. Leave empty = off',
        customModel: 'Custom…',
        masked: 'Configured (masked)',
        notConfigured: 'Not configured',
        keyHint: 'Leave empty to keep current; fill to replace (multiple keys comma-separated)',
      },
      zh: {
        title: 'VisionForge 视觉引擎',
        engine: '引擎（提供方）',
        apiKey: 'API 密钥',
        baseUrl: '接口地址',
        model: '模型',
        priority: '解析优先级',
        priorityOfficial: '官方优先',
        priorityPlugin: '插件优先',
        outputDir: '图片输出目录',
        paste: '粘贴接管',
        pasteOn: '开启',
        pasteOff: '关闭',
        save: '保存',
        openFull: '打开完整设置页',
        saved: '已保存',
        devOptions: '开发者选项（响应格式 / 超时 / 代理 / 请求体扩展）',
        respFormat: '响应格式（structuredOutput）',
        respFollow: '跟随引擎（默认）',
        respStrict: '强制结构化输出（读图 JSON schema）',
        respOff: '关闭',
        timeoutMs: '请求超时（毫秒）',
        proxyMode: '代理模式',
        proxyInherit: '继承全局（默认）',
        proxyDirect: '强制直连',
        proxyCustom: '自定义代理',
        extraBody: '请求体扩展（extraBody JSON）',
        reqTemplate: '自定义请求模板（官方 JSON 兜底）',
        reqTemplateHint: '仅当该引擎请求格式与内置协议族不兼容时使用。填写模板 JSON（可在网页设置页粘贴官方示例自动生成）；占位符：{{PROMPT}} / {{IMAGE1..3}} / {{MODEL}} / {{API_KEY}} / {{BASE_URL}} / {{SIZE}} / {{SIZE_X}}(1024x1024) / {{SIZE_STAR}}(1024*1024) / {{COUNT}}。{{COUNT}}/{{SIZE}} 类占位符整节点出现时自动保持数字类型。请勿在模板中填写真实密钥/地址，统一用占位符（真实值由引擎设置自动注入）。留空 = 关闭',
        customModel: '自定义…',
        masked: '已配置（掩码显示）',
        notConfigured: '未配置',
        keyHint: '留空 = 保持当前密钥不变；填入 = 覆盖（支持多 key 逗号分隔）',
      },
    }

    var localeRefHandle = { current: null }

    // 语言判定：DSH locale 服务（active）优先，其次页面 lang，其次浏览器语言。
    function localeRef() {
      try {
        var loc = localeRefHandle.current
        if (loc && typeof loc.getSnapshot === 'function') {
          var active = loc.getSnapshot().active
          if (active && /zh/i.test(active)) return 'zh'
        }
      } catch (e) { /* locale service unavailable */ }
      var el = document.documentElement
      if (el && /zh/i.test(el.lang || '')) return 'zh'
      var nav = (typeof navigator !== 'undefined' && navigator.language) || ''
      if (/zh/i.test(nav)) return 'zh'
      return 'en'
    }

    function nextDraft(values, current) {
      var draft = {}
      var engine = values.engine || current.engine
      var fieldChanged = false
      if (typeof values.apiKey === 'string' && values.apiKey !== '' && !/^[•●*·.]+$/.test(values.apiKey)) { draft.apiKey = values.apiKey; fieldChanged = true }
      if (typeof values.baseUrl === 'string' && values.baseUrl !== (current.baseUrl || '')) { draft.baseUrl = values.baseUrl; fieldChanged = true }
      if (typeof values.model === 'string' && values.model !== (current.model || '')) { draft.model = values.model; fieldChanged = true }
      // host 端 baseUrl/model/apiKey 必须在 engine 上下文里应用；
      // 只要任一字段变化就带上 engine，避免配置被静默忽略。
      if (engine && (engine !== current.engine || fieldChanged)) {
        draft.engine = engine
        if (engine !== current.engine) draft.provider = engine
      }
      if (typeof values.visionPriority === 'string' && values.visionPriority !== (current.visionPriority || 'official')) draft.visionPriority = values.visionPriority
      if (typeof values.outputDir === 'string' && values.outputDir !== (current.outputDir || '')) draft.outputDir = values.outputDir
      if (typeof values.pasteToPath === 'boolean' && values.pasteToPath !== (current.pasteToPath !== false)) draft.pasteToPath = values.pasteToPath
      if (typeof values.structuredOutput === 'string' && values.structuredOutput !== (typeof current.structuredOutput === 'string' ? current.structuredOutput : '')) draft.structuredOutput = values.structuredOutput === '' ? '' : values.structuredOutput === 'true'
      if (typeof values.timeoutMs === 'string' && values.timeoutMs !== (typeof current.timeoutMs === 'string' ? current.timeoutMs : '')) draft.timeoutMs = values.timeoutMs
      if (typeof values.extraBody === 'string' && values.extraBody !== (typeof current.extraBody === 'string' ? current.extraBody : '')) draft.extraBody = values.extraBody
      if (typeof values.proxyMode === 'string' && values.proxyMode !== (current.proxyMode || 'inherit')) draft.proxyMode = values.proxyMode
      if (typeof values.proxy === 'string' && values.proxy !== (current.proxy || '')) draft.proxy = values.proxy
      if (typeof values.requestTemplate === 'string' && values.requestTemplate.trim() !== (typeof current.requestTemplate === 'string' ? current.requestTemplate : '').trim()) {
        var rtRaw = values.requestTemplate.trim()
        if (rtRaw === '') draft.requestTemplate = ''
        else {
          try {
            var rtObj = JSON.parse(rtRaw)
            draft.requestTemplate = rtObj && typeof rtObj === 'object' ? rtObj : rtRaw
          } catch (e) { draft.requestTemplate = rtRaw }
        }
      }
      return draft
    }

    function savePayload(ctx, values, current) {
      var payload = nextDraft(values, current)
      if (Object.keys(payload).length === 0) return Promise.resolve()
      var p = Promise.resolve()
      if (typeof ctx.scope === 'object' && ctx.scope && typeof ctx.scope.config === 'object' && ctx.scope.config && typeof ctx.scope.config.set === 'function') {
        p = Promise.resolve(ctx.scope.config.set(payload))
      }
      return p
    }

    function supportsTextSecurity() {
      var input = document.createElement('input')
      return 'webkitTextSecurity' in input
    }

    function secretFieldProps() {
      if (supportsTextSecurity()) return { style: { WebkitTextSecurity: 'disc' } }
      return { type: 'password' }
    }

    function ConfigCard(react, ui) {
      var useState = react.useState
      var useEffect = react.useEffect
      var div = react.createElement('div', null)
      var CustomSectionComp = CustomSection(react, ui)

      function Field(props) {
        return react.createElement(
          'label',
          { style: { display: 'block', fontSize: 13, fontWeight: 600, margin: '12px 0 4px', color: '#888' } },
          props.label,
          props.children,
        )
      }

      function Card(props) {
        var lang = localeRef()
        var values = props.values
        var current = props.current || {}
        var enginesMeta = props.enginesMeta || {}
        var engineMeta = enginesMeta[values.engine] || enginesMeta['qwen'] || { label: 'Qwen', keyless: false, models: [] }
        var isKeyless = !!engineMeta.keyless
        var models = engineMeta.models || []
        var modelKnown = models.indexOf(values.model) !== -1
        var addOpenState = react.useState(false)
        var addOpen = addOpenState[0]
        var devOpenState = react.useState(false)
        var devOpen = devOpenState[0]
        var extraState = react.useState({})
        var extra = extraState[0]
        var sampleState = react.useState('')
        var sample = sampleState[0]
        var inferBusyState = react.useState(false)
        var inferBusy = inferBusyState[0]
        var inferMsgState = react.useState('')
        var inferMsg = inferMsgState[0]
        function guessKind(obj) {
          if (!obj || typeof obj !== 'object') return ''
          var s = JSON.stringify(obj)
          var hasMessages = /"messages"|"contents"/.test(s)
          var hasImage = /"image"|"inline_data"|"image_url"|"input_image"|"init_image"|"reference_images"/.test(s)
          var hasPrompt = /"prompt"|"query"|"text"|"question"/.test(s)
          var hasSizeNum = /"size"|"n"|"num"|"count"|"sample_count"/.test(s)
          if (hasMessages && (hasImage || hasPrompt)) return 'read'
          if (/"(url|b64_json|img_url|image_url)"/.test(s) && /"data"|"output"|"result"/.test(s)) return 'extract'
          if (/"(url|b64_json|img_url)"/.test(s)) return 'extract'
          if (hasPrompt && hasSizeNum && !hasMessages) return 'generate'
          if (hasImage && hasPrompt) return 'generate'
          return ''
        }
        function inferTemplate(kind) {
          if (inferBusy) return
          var sampleText = sample.trim()
          if (!sampleText) { inferMsgState[1]('请先粘贴官网示例 JSON'); return }
          var obj
          try { obj = JSON.parse(sampleText) } catch (e) { inferMsgState[1]('示例不是合法 JSON：' + e.message); return }
          inferBusyState[1](true); inferMsgState[1]('识别中…')
          fetch('/visionforge/settings/infer-template', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ kind: kind, sample: obj }),
          })
            .then(function (r) { return r.json() })
            .then(function (res) {
              inferBusyState[1](false)
              if (!res.ok) { inferMsgState[1]('生成失败：' + (res.error || '')); return }
              var out = res.template
              if (out === null || out === undefined || (Array.isArray(out) && out.length === 0)) {
                inferMsgState[1]('未能识别示例中的可变字段，请粘贴更完整的官网示例，或手动填写下方模板 JSON')
                return
              }
              var prev = null
              try { prev = values.requestTemplate ? JSON.parse(values.requestTemplate) : null } catch (e) {}
              var merged = prev && typeof prev === 'object' ? prev : {}
              if (kind === 'read') merged.read = out
              else if (kind === 'generate') merged.generate = out
              else if (kind === 'extract') { if (!merged.extract || typeof merged.extract !== 'object') merged.extract = {}; merged.extract.generate = { images: out } }
              set('requestTemplate', JSON.stringify(merged, null, 2))
              inferMsgState[1]('✓ 已合并到下方模板 JSON（可再编辑，核对后点保存）')
            })
            .catch(function (e) { inferBusyState[1](false); inferMsgState[1]('请求失败：' + e.message) })
        }
        function autoGuess() {
          var sampleText = sample.trim()
          if (!sampleText) { inferMsgState[1]('请先粘贴官网示例 JSON'); return }
          var obj
          try { obj = JSON.parse(sampleText) } catch (e) { inferMsgState[1]('示例不是合法 JSON：' + e.message); return }
          var kind = guessKind(obj)
          if (!kind) { inferMsgState[1]('无法自动判断类型，请点上方按钮手动指定（读图示例 / 生图示例 / 响应示例）'); return }
          inferTemplate(kind)
        }
        var extraMerged = {}
        for (var ek in extra) if (!Object.hasOwn(props.enginesMeta, ek)) extraMerged[ek] = extra[ek]
        var allMeta = Object.assign({}, props.enginesMeta, extraMerged)
        var knownIds = Object.keys(allMeta)

        function set(field, value) {
          var next = {}
          for (var k in values) next[k] = values[k]
          next[field] = value
          props.onValues(next)
        }

        return react.createElement('div', { style: { padding: 4 } },
          react.createElement(Field, { label: TEXT[lang].engine },
            react.createElement('select', {
              style: inputStyle,
              value: values.engine || 'qwen',
              onChange: function (e) {
                var v = e.target.value
                if (v === '__add_custom__') {
                  e.target.value = values.engine || 'qwen'
                  addOpenState[1](true)
                  return
                }
                set('engine', v)
              },
            },
              knownIds.map(function (id) {
                var meta = allMeta[id]
                var label = meta.label || id
                if (meta.keyless && meta.cliReady === false) label += '（未检测到 CLI）'
                return react.createElement('option', { key: id, value: id }, label)
              }),
              react.createElement('option', { key: '__add_custom__', value: '__add_custom__', style: { color: '#1668dc', fontWeight: 600 } }, '＋ 添加自定义引擎…'),
            ),
          ),
          addOpen
            ? react.createElement(CustomSectionComp, {
                knownIds: knownIds,
                customs: props.customs || [],
                onChanged: props.onCustomChanged,
                onAdd: function (id) {
                  var extra2 = {}
                  for (var ek2 in extra) extra2[ek2] = extra[ek2]
                  extra2[id] = { label: id + '（自定义）', keyless: false, baseUrl: '', model: '', hasKey: false, models: [], custom: true }
                  extraState[1](extra2)
                  set('engine', id)
                  addOpenState[1](false)
                },
                onClose: function () { addOpenState[1](false) },
              })
            : null,
          isKeyless
            ? react.createElement('div', { style: { fontSize: 12, color: '#0a7', marginTop: 10 } },
                '✓ 免密钥：需本机已安装并登录 ' + (engineMeta.cliCmd || '对应') + ' CLI' + (engineMeta.cliReady === false ? '（未检测到，请先安装并登录）' : '') + '；未登录时读图/生图会失败')
            : react.createElement(Field, { label: TEXT[lang].apiKey },
                react.createElement('input', Object.assign({}, secretFieldProps(), {
                  style: inputStyle,
                  value: values.apiKey || '',
                  placeholder: current.hasKey ? '已配置；点击掩码可全选替换，或输入/粘贴新密钥' : '粘贴新密钥将替换（留空 = 保持不变）',
                  onFocus: function (e) { if (e && e.target && typeof e.target.select === 'function') e.target.select() },
                  onChange: function (e) { set('apiKey', e.target.value) },
                  autoComplete: 'off',
                })),
                react.createElement('div', { style: { fontSize: 11, color: '#999', marginTop: 3 } },
                  current.hasKey ? TEXT[lang].masked + '；' + TEXT[lang].keyHint : TEXT[lang].notConfigured + '；' + TEXT[lang].keyHint,
                ),
              ),
          react.createElement(Field, { label: TEXT[lang].baseUrl },
            react.createElement('input', {
              style: inputStyle,
              value: values.baseUrl || '',
              onChange: function (e) { set('baseUrl', e.target.value) },
            }),
          ),
          react.createElement(Field, { label: TEXT[lang].model },
            react.createElement('select', {
              style: inputStyle,
              value: modelKnown ? values.model : '__custom__',
              onChange: function (e) {
                if (e.target.value === '__custom__') set('model', '__custom__')
                else set('model', e.target.value)
              },
            },
              models.map(function (m) {
                return react.createElement('option', { key: m, value: m }, m)
              }),
              react.createElement('option', { value: '__custom__' }, TEXT[lang].customModel),
            ),
            values.model === '__custom__'
              ? react.createElement('input', {
                  style: Object.assign({}, inputStyle, { marginTop: 6 }),
                  placeholder: '例如 qwen3.8-max',
                  defaultValue: '',
                  onChange: function (e) { set('modelCustom', e.target.value) },
                })
              : null,
          ),
          react.createElement(Field, { label: '分辨率能力（可选）' },
            react.createElement('input', {
              style: inputStyle,
              value: values.sizeCap || '',
              onChange: function (e) { set('sizeCap', e.target.value) },
              placeholder: '如 2K / 4K / 4096x4096（留空 = 跟随引擎通用上限）',
              autoComplete: 'off',
            }),
            react.createElement('div', { style: { fontSize: 11, color: '#999', marginTop: 3 } },
              '声明该引擎/模型的分辨率能力上限；不填时按协议族通用上限（OpenAI 兼容默认 2048，qwen 系默认 2K）',
            ),
          ),
          react.createElement(Field, { label: TEXT[lang].priority },
            react.createElement('select', {
              style: inputStyle,
              value: values.visionPriority || 'official',
              onChange: function (e) { set('visionPriority', e.target.value) },
            },
              react.createElement('option', { value: 'official' }, TEXT[lang].priorityOfficial),
              react.createElement('option', { value: 'plugin' }, TEXT[lang].priorityPlugin),
            ),
          ),
          react.createElement('details', { style: { marginTop: 12, borderTop: '1px solid rgba(128,128,128,.25)', paddingTop: 6 } },
            react.createElement('summary', { style: { cursor: 'pointer', fontSize: 13, color: '#7ab', userSelect: 'none', padding: '4px 0' }, onClick: function () { devOpenState[1](!devOpen) } }, TEXT[lang].devOptions),
            devOpen
              ? react.createElement('div', null,
                  react.createElement(Field, { label: TEXT[lang].respFormat },
                    react.createElement('select', {
                      style: inputStyle,
                      value: values.structuredOutput === undefined || values.structuredOutput === '' ? '' : String(values.structuredOutput),
                      onChange: function (e) { set('structuredOutput', e.target.value) },
                    },
                      react.createElement('option', { value: '' }, TEXT[lang].respFollow),
                      react.createElement('option', { value: 'true' }, TEXT[lang].respStrict),
                      react.createElement('option', { value: 'false' }, TEXT[lang].respOff),
                    ),
                  ),
                  react.createElement(Field, { label: TEXT[lang].timeoutMs },
                    react.createElement('input', {
                      style: inputStyle,
                      value: values.timeoutMs || '',
                      placeholder: '留空 = 引擎默认（读图约 60s，生图约 120s）',
                      onChange: function (e) { set('timeoutMs', e.target.value) },
                    }),
                  ),
                  react.createElement(Field, { label: TEXT[lang].proxyMode },
                    react.createElement('select', {
                      style: inputStyle,
                      value: values.proxyMode || 'inherit',
                      onChange: function (e) { set('proxyMode', e.target.value) },
                    },
                      react.createElement('option', { value: 'inherit' }, TEXT[lang].proxyInherit),
                      react.createElement('option', { value: 'direct' }, TEXT[lang].proxyDirect),
                      react.createElement('option', { value: 'custom' }, TEXT[lang].proxyCustom),
                    ),
                    react.createElement('input', {
                      style: Object.assign({}, inputStyle, { marginTop: 6 }),
                      value: values.proxy || '',
                      placeholder: 'http://127.0.0.1:7890（选「自定义代理」时填写）',
                      onChange: function (e) { set('proxy', e.target.value) },
                    }),
                  ),
                  react.createElement(Field, { label: TEXT[lang].extraBody },
                    react.createElement('textarea', {
                      style: Object.assign({}, inputStyle, { minHeight: 44, fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12 }),
                      value: values.extraBody || '',
                      placeholder: '{"thinking":{"type":"disabled"}}（厂商特殊开关；留空 = 无）',
                      onChange: function (e) { set('extraBody', e.target.value) },
                    }),
                  ),
                  react.createElement(Field, { label: TEXT[lang].reqTemplate },
                    react.createElement('div', { style: { marginBottom: 6, padding: 8, background: 'rgba(128,128,128,.08)', borderRadius: 8 } },
                      react.createElement('div', { style: { fontSize: 11, color: '#888', marginBottom: 4 } },
                        '不会填模板？把官网的「请求 / 响应示例 JSON」整段粘贴到下面，点按钮自动生成并合并到模板框（无需手拼结构）：',
                      ),
                      react.createElement('textarea', {
                        style: Object.assign({}, inputStyle, { minHeight: 52, fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12 }),
                        value: sample,
                        placeholder: '{"model":"...","prompt":"一只猫","size":"1024x1024","n":1}（请求或响应均可，可含 url/headers/body 顶层结构）',
                        onChange: function (e) { sampleState[1](e.target.value) },
                      }),
                      react.createElement('div', { style: { display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' } },
                        react.createElement('button', {
                          onClick: autoGuess,
                          disabled: inferBusy,
                          style: { padding: '5px 12px', border: 0, borderRadius: 6, background: '#1668dc', color: '#fff', fontSize: 12, cursor: inferBusy ? 'default' : 'pointer' },
                        }, '自动识别类型'),
                        react.createElement('button', {
                          onClick: function () { inferTemplate('read') },
                          disabled: inferBusy,
                          style: { padding: '5px 10px', border: '1px solid rgba(128,128,128,.4)', borderRadius: 6, background: 'transparent', fontSize: 12, cursor: inferBusy ? 'default' : 'pointer' },
                        }, '读图示例'),
                        react.createElement('button', {
                          onClick: function () { inferTemplate('generate') },
                          disabled: inferBusy,
                          style: { padding: '5px 10px', border: '1px solid rgba(128,128,128,.4)', borderRadius: 6, background: 'transparent', fontSize: 12, cursor: inferBusy ? 'default' : 'pointer' },
                        }, '生图示例'),
                        react.createElement('button', {
                          onClick: function () { inferTemplate('extract') },
                          disabled: inferBusy,
                          style: { padding: '5px 10px', border: '1px solid rgba(128,128,128,.4)', borderRadius: 6, background: 'transparent', fontSize: 12, cursor: inferBusy ? 'default' : 'pointer' },
                        }, '响应示例'),
                      ),
                      inferMsg
                        ? react.createElement('div', { style: { fontSize: 11, color: /失败|错误|无法/.test(inferMsg) ? '#e5484d' : '#0a7', marginTop: 4 } }, inferMsg)
                        : null,
                    ),
                    react.createElement('textarea', {
                      style: Object.assign({}, inputStyle, { minHeight: 64, fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12 }),
                      value: values.requestTemplate || '',
                      placeholder: '{"enabled":true,"read":{...},"generate":{...},"extract":{...}}',
                      onChange: function (e) { set('requestTemplate', e.target.value) },
                    }),
                    react.createElement('div', { style: { fontSize: 11, color: '#999', marginTop: 3 } }, TEXT[lang].reqTemplateHint),
                  ),
                )
              : null,
          ),
          react.createElement(Field, { label: TEXT[lang].outputDir },
            react.createElement('input', {
              style: inputStyle,
              value: values.outputDir || '',
              onChange: function (e) { set('outputDir', e.target.value) },
            }),
          ),
          react.createElement(Field, { label: TEXT[lang].paste },
            react.createElement('select', {
              style: inputStyle,
              value: values.pasteToPath ? '1' : '0',
              onChange: function (e) { set('pasteToPath', e.target.value === '1') },
            },
              react.createElement('option', { value: '1' }, TEXT[lang].pasteOn),
              react.createElement('option', { value: '0' }, TEXT[lang].pasteOff),
            ),
          ),
          react.createElement('div', { style: { marginTop: 16, display: 'flex', gap: 10, alignItems: 'center' } },
            react.createElement('button', {
              disabled: !props.dirty,
              style: {
                padding: '8px 22px', border: 0, borderRadius: 8,
                background: props.dirty ? '#1668dc' : '#9db8e8',
                color: '#fff',
                cursor: props.dirty ? 'pointer' : 'default',
              },
              onClick: function () {
                var finalValues = Object.assign({}, values)
                if (finalValues.model === '__custom__') finalValues.model = finalValues.modelCustom || ''
                props.onSave(finalValues)
              },
            }, TEXT[lang].save),
            react.createElement('a', {
              href: '#',
              style: { fontSize: 13, color: '#1668dc' },
              onClick: function (e) {
                e.preventDefault()
                fetch('/visionforge/open-settings-page', { method: 'GET' }).catch(function () {
                  window.open('/visionforge/settings', '_blank')
                })
              },
            }, TEXT[lang].openFull),
            props.note
              ? react.createElement('span', { style: { fontSize: 12, color: /失败|错误/.test(props.note) ? '#e5484d' : '#0a7', marginLeft: 6 } }, props.note)
              : null,
          ),
        )
      }

      function Wrapper(props) {
        var values = props.values
        return react.createElement(Card, {
          values: values,
          current: props.current,
          dirty: props.dirty,
          note: props.note,
          enginesMeta: props.enginesMeta,
          customs: props.customs,
          onCustomChanged: props.onCustomChanged,
          onValues: props.onValues,
          onSave: props.onSave,
        })
      }

      return Wrapper
    }

    var inputStyle = {
      width: '100%',
      padding: '8px 10px',
      border: '1px solid rgba(128,128,128,.35)',
      borderRadius: 8,
      fontSize: 13,
      boxSizing: 'border-box',
      background: 'transparent',
      color: 'inherit',
    }

    // 自定义引擎（翻译器）：由引擎下拉"＋ 添加自定义引擎…"展开（受控组件）。
    // 只填引擎名称；接口地址/API 密钥/模型用卡片下方通用字段填写，点主「保存」后生效。
    function CustomSection(react, ui) {
      var useState = react.useState
      var famLabel = { 'openai-compatible': 'OpenAI 兼容', anthropic: 'Anthropic', gemini: 'Gemini', 'raw-base64': '私有端点', 'dashscope-image': 'DashScope 生图', 'openai-image': 'OpenAI 生图', 'chat-native': '原生对话生图', 'google-imagen': 'Imagen' }
      function label2(v) { return famLabel[v] || v || '—' }
      function normalizeName(input) {
        var s = String(input || '').trim()
        if (!s) return { id: '', error: '引擎名称不能为空' }
        var id = s.toLowerCase().replace(/[\s_]+/g, '-').replace(/-+/g, '-')
        if (!/^[\p{L}\p{N}][\p{L}\p{N}._-]{0,38}$/u.test(id) || /^[.\-]/.test(id)) return { id: '', error: '引擎名称不规范：仅允许字母（含中文）、数字、点、下划线、连字符（≤40 字符，不能以点或连字符开头）' }
        return { id: id, error: '' }
      }
      function Section(props) {
        var customs = props.customs || []
        var knownIds = props.knownIds || []
        var nameState = useState('')
        var busyState = useState(false)
        var msgState = useState('')
        var name = nameState[0], busy = busyState[0], msg = msgState[0]
        function confirm() {
          var norm = normalizeName(name)
          if (norm.error) { msgState[1](norm.error); return }
          if (knownIds.indexOf(norm.id) !== -1) { msgState[1]('与现有引擎重名：' + norm.id); return }
          props.onAdd(norm.id)
        }
        function remove(id) {
          if (!window.confirm('删除自定义引擎「' + id + '」？')) return
          busyState[1](true); msgState[1]('删除中…')
          fetch('/visionforge/settings', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ custom: { action: 'remove', name: id } }),
          })
            .then(function (r) { return r.json().then(function (b) { if (!r.ok) throw new Error(b.error || '删除失败'); return b }) })
            .then(function () { msgState[1]('已删除'); props.onChanged() })
            .catch(function (e) { msgState[1]('删除失败: ' + ((e && e.message) || e)) })
            .finally(function () { busyState[1](false) })
        }
        return react.createElement('div', { style: { marginTop: 10, border: '1px solid rgba(76,111,255,.35)', borderRadius: 10, padding: 12 } },
          react.createElement('div', { style: { fontSize: 13, fontWeight: 600, color: '#555' } }, '添加自定义引擎'),
          react.createElement('div', { style: { fontSize: 11, color: '#999', marginTop: 3 } }, '只需填写引擎名称；接口地址、API 密钥、模型用下方通用字段填写，完成后点「保存」即生效'),
          react.createElement('label', { style: lblStyle }, '引擎名称'),
          react.createElement('input', { style: inputStyle, value: name, onChange: function (e) { nameState[1](e.target.value); msgState[1]('') }, placeholder: '例如 google', autoComplete: 'off' }),
          react.createElement('div', { style: { marginTop: 10, display: 'flex', gap: 10, alignItems: 'center' } },
            react.createElement('button', { type: 'button', disabled: busy, style: btnStyle, onClick: function () { confirm() } }, '确认添加'),
            react.createElement('a', { href: '#', style: { fontSize: 13, color: '#888' }, onClick: function (e) { e.preventDefault(); props.onClose() } }, '取消'),
          ),
          msg ? react.createElement('div', { style: { fontSize: 12, color: /失败|重名|不规范|不能为空/.test(msg) ? '#e5484d' : '#0a7', marginTop: 6 } }, msg) : null,
          customs.length > 0
            ? react.createElement('div', { style: { marginTop: 10, borderTop: '1px solid rgba(128,128,128,.2)', paddingTop: 8 } },
                react.createElement('div', { style: { fontSize: 12, fontWeight: 600, color: '#888', marginBottom: 4 } }, '已添加的自定义引擎（下拉选中后用下方字段编辑，点保存生效）'),
                customs.map(function (c) {
                  return react.createElement('div', { key: c.id, style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginTop: 4 } },
                    react.createElement('span', { style: { fontWeight: 600 } }, c.displayName || c.id),
                    react.createElement('span', { style: { color: '#888', fontSize: 12 } }, '(' + c.id + ')'),
                    react.createElement('span', { style: { color: '#0a7', fontSize: 12 } }, label2(c.readFamily) + (c.genFamily ? ' / ' + label2(c.genFamily) : '')),
                    c.failedReason
                      ? react.createElement('span', { style: { color: '#c33', fontSize: 12, marginLeft: 6, cursor: 'help', title: c.failedReason } }, '⚠ 上次失败')
                      : null,
                    react.createElement('a', { href: '#', style: { color: '#c33', fontSize: 12 }, onClick: function (e) { e.preventDefault(); remove(c.id) } }, '删除'),
                  )
                }),
              )
            : null,
        )
      }
      return Section
    }
    var lblStyle = { display: 'block', fontSize: 13, fontWeight: 600, margin: '12px 0 4px', color: '#888' }
    var btnStyle = { padding: '8px 22px', border: 0, borderRadius: 8, background: '#1668dc', color: '#fff', font: 'inherit', fontSize: 13, cursor: 'pointer' }

    function seedDraft(summary) {
      var engine = (summary && summary.provider) || 'qwen'
      var eng = (summary && summary.engines && summary.engines[engine]) || {}
      return {
        engine: engine,
        apiKey: eng.hasKey ? '••••••' : '',
        hasKey: !!eng.hasKey,
        baseUrl: typeof eng.baseUrl === 'string' ? eng.baseUrl : '',
        model: typeof eng.model === 'string' ? eng.model : '',
        sizeCap: typeof eng.sizeCap === 'string' ? eng.sizeCap : '',
        visionPriority: (summary && summary.visionPriority) || 'official',
        outputDir: summary && typeof summary.outputDir === 'string' ? summary.outputDir : '',
        pasteToPath: !summary || summary.pasteToPath !== false,
        structuredOutput: typeof eng.structuredOutput === 'boolean' ? (eng.structuredOutput ? 'true' : 'false') : '',
        timeoutMs: typeof eng.timeoutMs === 'number' ? String(eng.timeoutMs) : '',
        extraBody: typeof eng.extraBody === 'string' ? eng.extraBody : '',
        proxyMode: eng.proxyMode || 'inherit',
        proxy: typeof eng.proxy === 'string' ? eng.proxy : '',
        requestTemplate: typeof eng.requestTemplate === 'string' ? eng.requestTemplate : '',
        modelCustom: '',
      }
    }

    // 草稿与已保存基线逐字段比较：有任何真实变更 → true（保存按钮点亮）。
    function draftChanged(draft, baseline) {
      if (!draft || !baseline) return false
      if (draft.engine !== baseline.engine) return true
      if (draft.visionPriority !== baseline.visionPriority) return true
      if ((draft.outputDir || '') !== (baseline.outputDir || '')) return true
      if (draft.pasteToPath !== baseline.pasteToPath) return true
      var key = typeof draft.apiKey === 'string' ? draft.apiKey : ''
      if (key !== '' && !/^[•●*·.]+$/.test(key) && key !== (typeof baseline.apiKey === 'string' ? baseline.apiKey : '')) return true
      if ((draft.baseUrl || '') !== (baseline.baseUrl || '')) return true
      var dm = typeof draft.model === 'string' ? draft.model : ''
      var bm = typeof baseline.model === 'string' ? baseline.model : ''
      if (dm === '__custom__') {
        if (bm !== '__custom__') return true
        if ((draft.modelCustom || '') !== (baseline.modelCustom || '')) return true
      } else if (dm !== bm) {
        return true
      }
      if ((draft.sizeCap || '') !== (baseline.sizeCap || '')) return true
      var so = typeof draft.structuredOutput === 'string' ? draft.structuredOutput : ''
      var bso = typeof baseline.structuredOutput === 'string' ? baseline.structuredOutput : ''
      if (so !== bso) return true
      if ((draft.timeoutMs || '') !== (baseline.timeoutMs || '')) return true
      if ((draft.extraBody || '') !== (baseline.extraBody || '')) return true
      if ((draft.proxyMode || 'inherit') !== (baseline.proxyMode || 'inherit')) return true
      if ((draft.proxy || '') !== (baseline.proxy || '')) return true
      if ((draft.requestTemplate || '').trim() !== (baseline.requestTemplate || '').trim()) return true
      return false
    }

    function SettingsPage(react, ui) {
      var useState = react.useState
      var useEffect = react.useEffect
      // 组件引用必须稳定：在 Page 外创建一次，否则每次渲染都是新类型，
      // React 会把表单整体卸载重挂，输入框丢焦点（输入一个字符就得重新点击）。
      var Card = ConfigCard(react, ui)
      function Page() {
        var configState = useState(null)
        var draftState = useState(null)
        var noteState = useState('')
        var config = configState[0]
        var draft = draftState[0]
        var note = noteState[0]

        useEffect(function () {
          var cancelled = false
          fetch('/visionforge/config')
            .then(function (r) {
              return r.json().then(function (body) {
                if (!r.ok) throw new Error(body.error || '加载失败')
                return body
              })
            })
            .then(function (summary) {
              if (cancelled) return
              configState[1](summary)
              draftState[1](seedDraft(summary))
            })
            .catch(function (error) {
              if (!cancelled) noteState[1]('加载失败: ' + ((error && error.message) || error))
            })
          return function () { cancelled = true }
        }, [])

        if (!config || !draft) {
          return react.createElement('div', { style: { padding: 12, fontSize: 13, color: '#888' } }, 'VisionForge 配置加载中…' + (note ? '（' + note + '）' : ''))
        }
        var current = seedDraft(config)
        var dirty = draftChanged(draft, current)
        return react.createElement(Card, {
          values: draft,
          current: current,
          dirty: dirty,
          note: note,
          enginesMeta: (config && config.engines) || {},
          customs: (config && config.customs) || [],
          onCustomChanged: function () {
            fetch('/visionforge/config')
              .then(function (r) { return r.json() })
              .then(function (next) {
                if (next && typeof next === 'object') { configState[1](next); draftState[1](seedDraft(next)) }
              })
              .catch(function () {})
          },
          onValues: function (next) { draftState[1](next) },
          onSave: function (finalValues) {
            var payload = nextDraft(finalValues, current)
            if (Object.keys(payload).length === 0) return Promise.resolve()
            noteState[1]('保存中…')
            return fetch('/visionforge/config', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(payload),
            })
              .then(function (r) {
                return r.json().then(function (body) {
                  if (!r.ok) throw new Error(body.error || '保存失败')
                  return body
                })
              })
              .then(function (next) {
                configState[1](next)
                draftState[1](seedDraft(next))
                noteState[1]('已保存')
              })
              .catch(function (error) {
                noteState[1]('保存失败: ' + ((error && error.message) || error))
              })
          },
        })
      }
      return Page
    }

    function registerCard(ctx) {
      try {
        if (typeof ctx.inject !== 'function') return
        // locale 服务单独注入：缺服务只留空 handle，不阻塞卡片注册。
        ctx.inject(['locale'], function (scope) {
          localeRefHandle.current = scope.locale
        })
        ctx.inject(['slots'], function (scope) {
          var slots = scope && scope.slots
          if (!slots || typeof slots.inject !== 'function') return
          try {
            var react = require('react')
            var ui = require('@deepseek-ai/dsh-client-ui-primitives')
            var Page = SettingsPage(react, ui)
            slots.inject('settings.plugins.tab', function () {
              return slots.register({
                name: 'settings.plugins.tab',
                id: 'visionforge',
                order: 30,
                label: function () { return 'VisionForge' },
              }, Page)
            })
          } catch (error) {
            console.error('[visionforge] settings card skipped: ' + error)
          }
        })
      } catch (error) {
        console.error('[visionforge] settings card skipped: ' + error)
      }
    }

    // ---- 生命周期 ---------------------------------------------------------------
    function apply(ctx) {
      registerCard(ctx)
      injectPreviewStyles()
      document.addEventListener('paste', onPaste, true)
      document.addEventListener('focusin', onFocusIn, true)
      if (typeof ctx.effect === 'function') {
        ctx.effect(
          function () {
            return function () {
              document.removeEventListener('paste', onPaste, true)
              document.removeEventListener('focusin', onFocusIn, true)
              var styleEl = document.querySelector('[data-vf-styles]')
              if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl)
              if (previewBar && previewBar.parentNode) previewBar.parentNode.removeChild(previewBar)
            }
          },
          'visionforge: client listeners',
        )
      }
    }

    exports.apply = apply
    exports.__card = {
      nextDraft: nextDraft,
      savePayload: savePayload,
      secretFieldProps: secretFieldProps,
      ConfigCard: ConfigCard,
    }
    exports.inject = []
    return module.exports
  },
})
