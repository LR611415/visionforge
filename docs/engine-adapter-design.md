# 引擎翻译器（Engine Adapter）设计思路

> 状态：**设计草案，未实现**（用户要求先思考思路）
> 目标版本：VisionForge 下一迭代（本地开发分支）
> 关联：`src/providers/index.js`（REGISTRY 写死 7 个引擎）、`src/providers/*.js`（各引擎请求格式）、`src/config.js`（配置层）

---

## 1. 现状与问题

| 现状 | 问题 |
| --- | --- |
| `REGISTRY` 数组写死 7 个引擎（qwen / openai / anthropic / gemini-api / antigravity-cli / claude-cli / kimi-cli） | 用户**不能添加自定义引擎**，只能用内置这几个 |
| 每个 provider 文件里**硬编码**了请求格式（qwen/openai 用 `image_url` + data URI；anthropic 用 `image` + `source` base64；gemini 用 `inline_data`） | 用户接入新厂商（如 moonshot、mistral、智谱 GLM 之外的私有网关）时，**上传图片的格式完全写死**，无法适配 |
| 读图、生图、编辑三能力绑在特定引擎上（qwen 全支持、glm 读+生、其余只读） | 新引擎能力无法声明 |

**核心痛点**：每个引擎官方的图片上传格式不同（URL 直传 / base64 data URI / anthropic 式 source 块 / gemini 式 inline_data），现有代码把这些格式散落硬编码在各 provider 里，加一个新引擎 = 复制一份 provider 文件手写格式。

---

## 2. 目标

1. 用户可在配置中**添加自定义引擎**（名称、端点、密钥、模型、能力），无需改代码
2. 翻译器根据引擎的**协议族（format family）**自动把图片转换成该引擎官方的上传格式
3. 自定义引擎与内置引擎**同等地**进入故障切换链、doctor 体检、设置卡片
4. 格式转换失败时给出**具体字段级错误**（哪个字段不符合哪个协议族）

---

## 3. 核心概念

### 3.1 内部统一图片对象（Canonical Image）

所有引擎入口之前，先把图片归一化成同一结构：

```js
{
  kind: 'remote' | 'inline',      // 远程 URL 还是本地文件
  source: '<本地路径或 URL>',
  mimeType: 'image/jpeg',         // 本地文件探测得到
  data: '<base64>',               // 仅 inline 时存在（读本地文件转 base64）
  width: 1024, height: 1024       // 可选，供厂商限制检查
}
```

### 3.2 引擎适配器描述符（Provider Descriptor）

每个引擎（内置或自定义）都解析成同一描述符：

```js
{
  name: 'my-llm',                 // 引擎 id（配置键）
  displayName: 'MyLLM',           // 设置卡片显示名（命名规范化，如 qwen→Qwen）
  family: 'openai-compatible',    // 协议族：决定图片格式模板
  capabilities: { read: true, generate: false, edit: false },
  endpoint: {
    baseUrl: 'https://.../v1',
    chatPath: '/chat/completions', // 默认按 family 推断，可覆盖
  },
  auth: { type: 'bearer' },       // bearer / api-key / x-api-key / none
  imageProtocol: {                 // 图片传输协议（family 提供默认，可覆盖）
    local: 'data-uri',             // 本地图怎么传
    remote: 'url',                 // 远程图怎么传
  },
  extraBody: { ... },              // 厂商专有字段透传（合并进请求体）
}
```

### 3.3 协议族（Format Family）与格式模板

翻译器的核心是一张**格式模板表**——每种协议族一种图片渲染模板：

| family | 图片 content 块（本地 inline） | 图片 content 块（远程 url） | 适用 |
| --- | --- | --- | --- |
| `openai-compatible` | `{type:'image_url', image_url:{url:'data:<mime>;base64,<data>'}}` | `{type:'image_url', image_url:{url:'<url>'}}` | qwen、openai、绝大多数兼容网关（默认兜底族） |
| `anthropic` | `{type:'image', source:{type:'base64', media_type:'<mime>', data:'<data>'}}` | `{type:'image', source:{type:'url', url:'<url>'}}` | anthropic、claude 兼容端点 |
| `gemini` | `{inline_data:{mime_type:'<mime>', data:'<data>'}}` | `{file_data:{file_uri:'<url>'}}` 或直传 URL | google genai |
| `raw-base64` | 请求体里 `image`/`image_base64` 字段直接放 base64 | 同上放 URL | 私有网关、图片生模型 |

> 每种 family 还携带：**鉴权头模板**（`Authorization: Bearer <key>` / `x-api-key: <key>`）、**端点路径默认值**、**模型字段名**（`model` / `model_id` / `modelName`）。

### 3.4 翻译器（Adapter Resolver）

运行时管线：

```
用户图片 → 归一化为 Canonical Image
         → 按 engine.family 查格式模板表
         → 按 engine.imageProtocol 渲染图片 content 块
         → 合并 extraBody、鉴权头、模型名、prompt
         → 发送 → 按统一结果结构解析
```

翻译器只做一件事：**把 Canonical Image 渲染成目标 family 的 content 块**。现有 qwen.js / openai.js / anthropic.js 里的硬编码格式，会收敛为"从模板表取模板"，而不是每文件手写。

---

## 4. 配置扩展（用户视角）

在 `~/.visionforge/config.json` 增加 `customProviders` 段（设置卡片同步支持）：

```jsonc
{
  "providers": { ... },            // 现有内置引擎配置不变
  "customProviders": {
    "moonshot": {
      "displayName": "Moonshot",
      "family": "openai-compatible",   // ← 关键：选协议族，图片格式自动对
      "baseUrl": "https://api.moonshot.cn/v1",
      "apiKey": "sk-***",
      "model": "moonshot-v1-8k-vision-preview",
      "capabilities": { "read": true, "generate": false, "edit": false },
      "imageProtocol": { "local": "data-uri", "remote": "url" },  // 可选，默认按 family
      "extraBody": {}                 // 可选，厂商专有开关
    }
  }
}
```

- **用户只需回答三个问题**：叫什么名、走哪个协议族（下拉：OpenAI 兼容 / Anthropic / Gemini / 原生 Base64）、端点+密钥+模型
- **上传图片的格式由 family 自动决定**——用户不用知道 `image_url` vs `source` 的区别
- 与内置引擎的配置字段（baseUrl/apiKey/model）**完全一致**，学习成本为零

---

## 5. 与现有系统的集成

| 现有组件 | 改动 |
| --- | --- |
| `src/providers/index.js` 的 `REGISTRY` | 改为 `builtinProviders + 运行时从 config 合并 customProviders` 的动态注册表 |
| `listProviders()` | 返回内置 + 自定义全部引擎名 |
| 故障切换链 | 自定义引擎按"可用性"（有 key/地址）自然进链；`config.provider` 钉死时也可指向自定义引擎 |
| `doctor` | 显示自定义引擎及其 family、就绪状态；`config test <engine>` 发最小请求探测格式是否正确 |
| 设置卡片（dsh/index.js） | 引擎列表 = 内置 + 用户自定义；新增"添加引擎"入口（名称 + 协议族下拉 + 端点/密钥/模型） |
| 生图/编辑 | 按 capabilities 过滤：自定义引擎声明了 generate 才出现在生图列表；`imagegen.js` 目前只支持 qwen-image 格式，**生图协议族单独扩展**（`image-gen` family） |

---

## 6. 校验与探测（让用户"能试错"）

1. **配置期校验**：family 必须是已知枚举；baseUrl 必须 http(s)；apiKey 可选（可跳过）；capabilities 默认只读
2. **运行期探测**：`visionforge config test <engine>` 发一个最小图片请求（1×1 像素占位图），返回：
   - ✅ 格式正确 + 模型可读图
   - ❌ `400 InvalidParameter` → 提示"检查 family 是否选对（报错格式类似 OpenAI 还是 Anthropic）"
   - ❌ 401/403 → 提示密钥/鉴权类型
   - ❌ 404 → 提示 baseUrl/路径
3. **doctor 分级**：自定义引擎显示 `[ok]` / `[!!] missing apiKey` / `[!!] family 未知`

---

## 7. 实施路线（分阶段，每阶段可独立发布）

| 阶段 | 内容 | 交付 |
| --- | --- | --- |
| **P1 配置层** | config schema 支持 `customProviders`（解析 + 校验 + 存储） | `visionforge config show` 可见 |
| **P2 翻译器核心** | Canonical Image + 格式模板表 + Adapter Resolver；把 qwen/openai/anthropic 现有硬编码格式**收敛到模板表**（行为不变，回归安全） | 内置引擎无感切换 |
| **P3 注册表动态化** | REGISTRY 合并 customProviders + failover 链接入 + doctor 显示 + `config test` 探测 | 自定义引擎可读图 |
| **P4 设置卡片 UI** | 引擎列表动态化 + "添加引擎"表单（名称/协议族/端点/密钥/模型） | 前端闭环 |
| **P5 生图扩展** | `image-gen` family（qwen-image 现有格式收敛）+ 自定义生图引擎 | 生图可自定义 |

---

## 8. 风险与边界（设计时就要想清楚的）

1. **厂商专有字段**：family 模板只覆盖"图片格式"，其余厂商特殊字段走 `extraBody` 透传（现有机制，保留）
2. **鉴权差异**：family 默认 bearer，但 anthropic 用 `x-api-key`、部分网关用 `api-key`——`auth.type` 字段可覆盖
3. **流式 vs 非流式**：读图目前非流式，自定义引擎若强制流式需 `stream:false` 显式声明
4. **图片大小限制**：base64 后体积 ≈ 原图 ×1.37；超过厂商上限（如 5MB）时翻译器可先压缩或拒绝并提示
5. **安全**：自定义 baseUrl 允许指向任意端点——**不泄露 key**（仍遵守现有打码规则）；请求只发 HTTPS
6. **与内置引擎同权**：自定义引擎和内置引擎在链里平等，但内置引擎的已知格式更可靠——文档建议优先内置

---

## 9. 一句话总结

把"图片怎么传给引擎"这件事从**每个 provider 手写**变成**一张格式模板表 + 用户选协议族**——新增引擎不再改代码，用户填三行配置（名称/协议族/端点）就能接上任意 OpenAI 兼容或 Anthropic 风格的新厂商。
