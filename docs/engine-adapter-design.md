# 引擎翻译器（Engine Adapter）设计文档

> 状态：**已实现（本地 0.1.9 分支，未推送）**
> 涉及文件：`src/custom-providers.js`（名称护栏 + schema）、`src/providers/translator.js`（格式模板表）、`src/providers/custom.js`（自定义引擎适配器）、`src/providers/index.js`（动态注册表）、`src/config.js` / `src/config-resolve.js`（配置层）、`src/doctor.js` / `src/analyze.js` / `src/index.js`（CLI 与体检）、`src/imagegen.js`（生图翻译器）、`dsh/index.js`（设置卡片）
> 测试：`test/custom-providers.test.js`、`test/translator.test.js`（全量 47/47 通过）

---

## 1. 目标

让用户**无需改代码**即可接入任意厂商引擎（Google Gemini、Imagen、OpenAI 兼容网关、私有端点等），完成读图 / 文生图 / 图生图三件事。设计上分三层：

1. **协议族（format family）**：把"图片怎么传给引擎"收敛为一张格式模板表（读图 4 族 + 生图 4 族），用户只选族，不碰格式。
2. **模型级能力（capabilities）**：读图、生图、编辑按**模型**声明（同一引擎下不同模型能力不同），而不是按引擎声明。
3. **名称护栏**：用户手打引擎名时，四道防线防止踩进内置引擎或打出不规范名。

---

## 2. 核心概念

### 2.1 Canonical Image（内部统一图片对象）

所有引擎入口之前，图片先归一化：

```js
{ kind: 'remote' | 'local', source: '<路径或 URL>', mimeType: 'image/png', data: '<base64，仅 local>' }
```

- 本地文件：`readLocalImageBase64`（魔数嗅探 mime + 25 MiB 上限，见 `src/net.js`）。
- 远程 URL：仅存 URL，各模板自行决定直传还是拉回（gemini 读图会拉回 base64 内联，与内置 gemini.js 行为一致）。

### 2.2 协议族与格式模板表（`src/providers/translator.js`）

**读图（READ_FAMILIES）**：

| family | 图片 content 块（local） | 鉴权 | 端点 | 适用 |
| --- | --- | --- | --- | --- |
| `openai-compatible` | `{type:'image_url', image_url:{url:'data:<mime>;base64,<data>'}}` | Bearer | `{base}/chat/completions` | 默认兜底族，覆盖约 90% 厂商 |
| `anthropic` | `{type:'image', source:{type:'base64', media_type, data}}` | `x-api-key` + `anthropic-version` | `{base}/v1/messages` | Anthropic / Claude 兼容端点 |
| `gemini` | `{inline_data:{mime_type, data}}`（远程自动拉回） | `x-goog-api-key` | `{base}/v1beta/models/{model}:generateContent` | Google Gemini |
| `raw-base64` | 私有字段 `image_base64` + `media_type` | Bearer | `{base}/chat/completions` | 私有网关 |

每个模板含 `reserved` 字段列表，`mergeExtraBody` 会拒绝厂商专有字段里与这些保留字段冲突的键（报错点名），防止覆盖图片/提示词/强制机制。

**生图（GEN_FAMILIES，P5）**：

| family | 端点 | 尺寸格式 | 图片来源 | 适用 |
| --- | --- | --- | --- | --- |
| `dashscope-image` | `{base}/services/aigc/multimodal-generation/generation` | `W*H`（星号，历史坑） | 回复 `output.choices[].message.content[].image`（URL） | Qwen-Image 原生（内置 qwen 已收敛至此） |
| `openai-image` | `{base}/images/generations` | `WxH` | 回复 `data[].url`；编辑走 `input_image` | GLM-Image 等 OpenAI 风格（内置 glm 已收敛至此） |
| `chat-native` | `{base}/v1beta/models/{model}:generateContent` | `W*H` | 回复 `candidates[].content.parts[].inlineData`（base64） | Gemini 多模态生成（读图同端点） |
| `google-imagen` | `{base}/v1beta/models/{model}:predict`（编辑走 `:editImage` 分支） | 比例 `W:H`（如 `1:1`、`16:9`） | 回复 `predictions[].bytesBase64Encoded` / `url` | Google Imagen |

`normalizeSizeFor(size, family)` 按族转换：`1024x1024` → dashscope/chat-native `1024*1024`、openai `1024x1024`、imagen `1:1`（gcd 化简）。统一返回 http(s) URL **或 data URI**，落盘层 `saveImageResult` 两者都支持。

### 2.3 模型级能力（capabilities）

同一引擎下不同模型能力不同（例：Google 引擎下 `gemini-3.1` 可读+生、纯视觉版只读、`imagen-4.0` 只生）。因此能力声明在 `models[]` 上，顶层 `capabilities` 兜底：

```jsonc
"customProviders": {
  "google": {
    "displayName": "Google Gemini",
    "baseUrl": "https://generativelanguage.googleapis.com",
    "readFamily": "gemini",
    "genFamily": "chat-native",
    "models": [
      { "name": "gemini-3.1",       "capabilities": { "read": true,  "generate": true,  "edit": false } },
      { "name": "imagen-4.0",       "capabilities": { "read": false, "generate": true,  "edit": false } },
      { "name": "gemini-2.5-flash", "capabilities": { "read": true,  "generate": false, "edit": false } }
    ]
  }
}
```

- 生图路由：找 `capabilities.generate || edit` 的模型，没有则明确报错"请配置生图模型"（不静默）。
- 编辑路由：有参考图时按 `mode='edit'` 渲染（google-imagen 走 `referenceImages` 分支），`GLM-Image` 这类不支持编辑的引擎在 CLI 层直接报错。

### 2.4 名称护栏（`src/custom-providers.js`）

用户手打引擎名（尤其"大小写与官方不一致、多/少一个字母"）时四道防线：

| # | 防线 | 行为 |
| --- | --- | --- |
| ① | `canonicalizeName` | trim → 小写 → 空格/下划线统一 `-` → 只允许 `[a-z0-9._-]`（≤40，不能以 `.`/`-` 开头）；非法抛错 |
| ② | `checkNameConflicts` | 内置引擎标准名 + 全部别名折叠（`gemini`→`gemini-api`、`claude`→`anthropic`…）+ 已有自定义重名 → 拒绝并点名 |
| ③ | `suggestBuiltinName` | 与内置引擎 Levenshtein ≤ 2（如 `qwenx`→`qwen`）→ 提示"你是不是指内置引擎"，**不静默改名**（用户可能真想要近似名） |
| ④ | `suggestFamilyFromBaseUrl` | 粘贴接口地址后按域名识别协议族 + 显示名建议（generativelanguage→gemini、anthropic.com→anthropic、openai/dashscope/bigmodel/moonshot/deepseek…→openai-compatible，未命中兜底 openai-compatible） |

CLI 与设置卡片共用同一套护栏（`dsh/index.js` 直接 import `src/custom-providers.js`），行为完全一致。

---

## 3. 配置层（`config.customProviders`）

与 `providers` 段并存。**自定义引擎设置单源**：只从 `customProviders` 读，不读环境变量（`src/config-resolve.js` 的 `resolveProviderSettings` 对自定义名走单源分支）。`config.js` 支持：

- `config set custom.<name>.<field>`（apiKey / baseUrl / model / genModel / readFamily / genFamily / displayName / extraBody）
- `assertReadableConfig` 校验 customProviders 段（坏条目点名报错，不让坏配置静默生效）
- `renderEffectiveConfig` 展示自定义引擎段（key 打码）
- `knownApiKeys` 纳入自定义 key（错误信息脱敏）

CLI 命令面：

```bash
visionforge config add-engine <name> --base-url <url> [--api-key <key>] [--display-name <name>] [--read-family <f>] [--gen-family <f>] [--model <m>] [--gen-model <m>]
visionforge config remove-engine <name>
visionforge config list-custom
visionforge config test <engine>        # 1×1 占位图端到端实测（花极少配额）
```

---

## 4. 运行时集成

- **注册表**（`src/providers/index.js`）：`listProviders(config)` / `resolveProvider(name, config)` / `providerAvailable` / `providerChain` 动态并入自定义引擎——`config.provider` 钉死自定义名 → 链首；未钉死 → 有可用性（key + baseUrl + family）的自然进链尾。所有调用点已补传 `config`（`analyze.js` 3 处、`doctor.js`、`config-resolve.js`）。
- **读图**（`src/providers/custom.js`）：`createCustomProvider(entry)` 把自定义引擎包装成与内置同构的 provider（`{name, displayName, defaultModel, visionDefaultModel, isCustom, readFamily, execute}`）；`execute` 按 readFamily 走 `renderReadRequest` / `parseReadResponse`，缺 schema 字段时复用 qwen 的 `normalizeLooseVision` 容错归一。
- **doctor**：`inspectCustomProvider` 逐引擎显示 family / 就绪状态 / key / 模型；`config test <engine>` 是运行期探测（400 格式错 → 提示查 family；401/403 → 提示密钥；404 → 提示 baseUrl）。
- **生图/编辑**（`src/imagegen.js`）：内置 qwen/glm 收敛到翻译器模板（行为不变：端点、错误前缀、默认模型保持）；自定义引擎按 genFamily 渲染，落盘统一走 `saveImageResult`（http URL / data URI 双支持），缓存目录统一 `D:\VisionForge\out`（无 D 盘回退用户目录），TTL 3 天。

---

## 5. 设置卡片（`dsh/index.js`）

- 引擎下拉 = 内置 + 自定义（自定义标"（自定义）"）。
- 底部「+ 添加 / 编辑自定义引擎」表单：名称（实时规范化 + 冲突/拼写即时提示）、显示名、接口地址（粘贴自动识别协议族并预填）、读图协议族、生图协议族（含"不启用"）、密钥（掩码可操作）、视觉模型、生图模型。
- 服务端 `applyCustomSettings` 与 CLI 共用护栏（名称规范化 / 冲突拒绝 / family 枚举校验 / baseUrl https 校验）；保存/删除即时生效并刷新列表。
- 保存按钮脏检查、key 掩码、中文化等既有行为不变。

---

## 6. 风险与边界

1. **厂商专有字段**：family 只覆盖"图片格式"，其余走 `extraBody` 透传；`reserved` 拒绝覆盖保留字段并点名。
2. **鉴权差异**：family 默认 Bearer / `x-goog-api-key` / `x-api-key` 已内建；特殊鉴权可在 `auth` 字段扩展。
3. **图片大小**：本地图 25 MiB 上限（`readLocalImageBase64`），超限明确报错。
4. **安全**：自定义 baseUrl 只允许 http(s)；key 打码规则沿用；请求经 `apiFetch` 支持代理。
5. **能力不支持**：生图/编辑不支持时明确报错（"GLM-Image does not support image editing" / "请配置生图模型"），不静默降级。
6. **与内置引擎同权**：自定义引擎与内置在链里平等；内置格式更可靠，文档建议优先内置。

---

## 7. 一句话总结

新增引擎不再改代码：用户在设置卡片或 CLI 填「名称 / 接口地址 / 协议族 / 密钥 / 模型（按能力）」，翻译器按协议族自动处理图片上传格式，护栏保证名称规范、错误可诊断。
