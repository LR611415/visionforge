# 自定义请求模板 — 示例代码

> 适用场景：你新增的引擎，请求格式不在内置协议族（OpenAI 兼容 / Anthropic / Gemini / 原生）内，
> 翻译器无法适配。此时到网页设置页 → 开发者选项 → **自定义请求模板**，把引擎官网的
> 「请求 / 响应示例 JSON」粘贴进来，点「自动生成模板」，得到占位符模板后保存即可读图 / 生图。
>
> 占位符（自动替换成你配置的实际值）：
>
> | 占位符 | 含义 |
> | --- | --- |
> | `{{BASE_URL}}` | 引擎接口地址（设置里填的 baseUrl，自动去尾部斜杠） |
> | `{{API_KEY}}` | 当前 API 密钥 |
> | `{{MODEL}}` | 当前模型名 |
> | `{{PROMPT}}` | 提示词（读图 = 视觉指令；生图 = 画面描述） |
> | `{{IMAGE1}}` `{{IMAGE2}}` `{{IMAGE3}}` | 参考图（本地自动转 data URI，远程 URL 原样；第 1/2/3 张） |
> | `{{SIZE}}` | 尺寸内部原文（如 `1024*1024`） |
> | `{{SIZE_X}}` | x 格式尺寸（`1024x1024`，**多数引擎用这个**） |
> | `{{SIZE_STAR}}` | * 格式尺寸（`1024*1024`，千问 DashScope 系用） |
> | `{{COUNT}}` | 张数（数字） |
>
> **类型保真**：`{{COUNT}}` / `{{SIZE}}` / `{{SIZE_X}}` / `{{SIZE_STAR}}` 单独占满一个 JSON 节点时（如 `"n": "{{COUNT}}"`），自动按引擎示例里的类型输出——示例里是数字就输出数字，是字符串就输出字符串。避免"引擎要数字 `n: 2`，模板却发字符串 `"2"`"导致的 400 错误。

---

## 真实引擎填写示例（对着填就行）

下面用真实引擎的官方请求格式举例。步骤固定：**① 从引擎官网复制请求示例 → ② 手动把示例里的真实密钥/地址改成占位 → ③ 粘贴到设置页点「自动生成模板」→ ④ 对照下表核对占位符 → ⑤ 保存**。只需要引擎实际支持的段落（只读图就只填 read，只生图就只填 generate）。

### 例 A：千问 DashScope（qwen-vl 读图 + qwen-image 生图）——最典型

官网：https://help.aliyun.com/zh/model-studio/ （模型服务 → 文生图 / 视觉理解）

**① 读图请求示例（OpenAI 兼容模式，粘贴进「读图请求示例」）**

```json
{
  "model": "qwen-vl-plus",
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "image_url", "image_url": { "url": "https://example.com/a.png" } },
        { "type": "text", "text": "请描述这张图片的内容" }
      ]
    }
  ]
}
```

**② 自动生成后（核对以下关键点）**

```json
{
  "url": "{{BASE_URL}}/compatible-mode/v1/chat/completions",
  "method": "POST",
  "headers": { "Authorization": "Bearer {{API_KEY}}", "Content-Type": "application/json" },
  "body": {
    "model": "{{MODEL}}",
    "messages": [
      {
        "role": "user",
        "content": [
          { "type": "image_url", "image_url": { "url": "{{IMAGE1}}" } },
          { "type": "text", "text": "{{PROMPT}}" }
        ]
      }
    ]
  }
}
```

要点：引擎设置里 baseUrl 填 `https://dashscope.aliyuncs.com`，模板 url 用 `{{BASE_URL}}/compatible-mode/v1/chat/completions`（BASE_URL 不含尾斜杠，路径全写在模板里）。

**③ 生图请求示例（DashScope 原生格式）**

```json
{
  "model": "wanx2.1-t2i-turbo",
  "input": { "prompt": "一只金毛犬在草地上奔跑" },
  "parameters": { "size": "1024*1024", "n": 1 }
}
```

**④ 自动生成后（注意 `{{SIZE_STAR}}`——DashScope 生图要 `*` 分隔）**

```json
{
  "url": "{{BASE_URL}}/api/v1/services/aigc/text2image/image-synthesis",
  "method": "POST",
  "headers": { "Authorization": "Bearer {{API_KEY}}", "X-DashScope-Async": "enable" },
  "body": {
    "model": "{{MODEL}}",
    "input": { "prompt": "{{PROMPT}}" },
    "parameters": { "size": "{{SIZE_STAR}}", "n": "{{COUNT}}" }
  }
}
```

> 若你的引擎生成图要 `x` 分隔（如 OpenAI 系），把 `{{SIZE_STAR}}` 改成 `{{SIZE_X}}` 即可，无需改引擎设置。

**⑤ 生图响应提取**（DashScope 异步任务结构，响应示例填）

```json
{ "output": { "results": [ { "url": "https://dashscope-result.oss-cn-shanghai.aliyuncs.com/xxx.png" } ] } }
```

提取路径自动生成 `output.results.0.url`（多张时插件自动展开整组）。

### 例 B：OpenAI 兼容引擎（ChatGPT / 中转 / 私有部署通用）

读图请求（示例即官方 chat/completions 格式）：

```json
{
  "model": "gpt-4o",
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "image_url", "image_url": { "url": "https://example.com/a.png" } },
        { "type": "text", "text": "描述这张图片" }
      ]
    }
  ],
  "max_tokens": 1024
}
```

生图请求（OpenAI images API）：

```json
{
  "model": "dall-e-3",
  "prompt": "一只金毛犬在草地上奔跑",
  "size": "1024x1024",
  "n": 1
}
```

自动生成后 size 用 `{{SIZE_X}}`（OpenAI 系是 `1024x1024`），响应提取 `data.0.url` 或 `data.0.b64_json`。

### 例 C：Anthropic Claude（读图）

```json
{
  "model": "claude-3-5-sonnet-latest",
  "max_tokens": 1024,
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "iVBORw0KGgo..." } },
        { "type": "text", "text": "描述这张图片" }
      ]
    }
  ]
}
```

自动生成后：`{{IMAGE1}}` 会命中 `content.0.source.data`（本地图自动转 base64）；响应正文提取 `content`（part 数组自动拼 text）。注意 headers 里 Authorization 是 `Bearer {{API_KEY}}`。

### 例 D：Gemini（读图）

```json
{
  "contents": [
    {
      "parts": [
        { "inline_data": { "mime_type": "image/png", "data": "iVBORw0KGgo..." } },
        { "text": "描述这张图片" }
      ]
    }
  ]
}
```

自动生成后 url 用 `{{BASE_URL}}/v1beta/models/{{MODEL}}:generateContent`，`{{IMAGE1}}` 命中 `contents.0.parts.0.inline_data.data`；响应正文提取 `candidates.0.content.parts`。

### 对照表：引擎 → 尺寸分隔符 → 常用字段名

| 引擎 | 尺寸写法 | 读图常用字段 | 生图常用字段 |
| --- | --- | --- | --- |
| 千问 DashScope 生图 | `1024*1024`（`{{SIZE_STAR}}`） | messages[].content[] | input.prompt / parameters.size |
| OpenAI 兼容 / DALL·E | `1024x1024`（`{{SIZE_X}}`） | messages[].content[] | prompt / size / n |
| Anthropic | 无（固定 1024） | content[]（base64 source） | 不支持生图 |
| Gemini | `1024x1024`（`{{SIZE_X}}`） | contents[].parts[] | prompt / imageSize |
| 智谱 GLM 生图 | `1024x1024`（`{{SIZE_X}}`） | 同 OpenAI 兼容 | prompt / size / n |

**填写顺序建议**：读图 → 生图 → 响应提取，每段独立粘贴示例、独立点「自动生成」，最后在「模板 JSON」里合并确认，再保存。

---

## ⚠️ 谨慎填写（必读）

1. **模板里永远不要填真实密钥 / 真实接口地址 / 真实模型名**——全部用 `{{占位符}}`，
   真实值会从「引擎设置」里自动注入。若模板里写死真实 key，它会以明文保存在
   `~/.visionforge/config.json`，卸载插件也不清除，存在泄露风险。
2. **粘贴官网示例前，先手动替换其中的真实凭据**（密钥、签名、token、请求 ID 等），
   改成明显占位（如 `sk-REPLACE-WITH-PLACEHOLDER`），再粘贴进示例框点「自动生成」。
3. **不要粘贴带隐私数据的完整响应**——响应示例只需保留与图片字段有关的结构，
   其余字段可删。插件只按提取路径取图，其他内容不会被保存或上传。
4. 厂商特殊开关（如 `X-Custom-Trace`）可以保留，但同样不要放任何真实凭据或隐私值。
5. 保存后如需复核，用「引擎设置」里的配置展示（密钥为掩码显示）确认模板里没有明文 key。

---

## 示例 1：读图请求（OpenAI 兼容风格）

**① 官网示例（粘贴进「读图请求示例」）**

```json
{
  "url": "https://api.example.com/v1/chat/completions",
  "method": "POST",
  "headers": {
    "Authorization": "Bearer sk-REPLACE-WITH-PLACEHOLDER",
    "Content-Type": "application/json"
  },
  "body": {
    "model": "vision-pro-v2",
    "messages": [
      {
        "role": "user",
        "content": [
          {
            "type": "image_url",
            "image_url": {
              "url": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
            }
          },
          {
            "type": "text",
            "text": "请详细描述这张图片中的内容，返回结构化结果"
          }
        ]
      }
    ],
    "max_tokens": 1024
  }
}
```

**② 点「自动生成读图模板」后得到（可再手改）**

```json
{
  "url": "{{BASE_URL}}/v1/chat/completions",
  "method": "POST",
  "headers": {
    "Authorization": "Bearer {{API_KEY}}",
    "Content-Type": "application/json"
  },
  "body": {
    "model": "{{MODEL}}",
    "messages": [
      {
        "role": "user",
        "content": [
          {
            "type": "image_url",
            "image_url": { "url": "{{IMAGE1}}" }
          },
          {
            "type": "text",
            "text": "{{PROMPT}}"
          }
        ]
      }
    ],
    "max_tokens": 1024
  }
}
```

> 提示：`max_tokens` 这类固定值原样保留；想让它跟随设置，可自己改成 `{{COUNT}}` 之外的自定义占位符
> （占位符只认 `{{...}}` 形式，任意大写单词都行，运行时按名称在模板 JSON 里找不到的值替换为空）。

---

## 示例 2：生图请求（特殊字段引擎 —— 协议族不适配的典型）

这种引擎把提示词叫 `query`、尺寸叫 `output_size`、参考图叫 `init_image`，内置协议族不认识，
正好用自定义模板兜底。

**① 官网示例（粘贴进「生图请求示例」）**

```json
{
  "url": "https://api.example.com/generate",
  "method": "POST",
  "headers": {
    "Authorization": "Bearer sk-REPLACE-WITH-PLACEHOLDER",
    "X-Custom-Trace": "abc123"
  },
  "body": {
    "model_name": "gen-pro-4k",
    "query": "一只在草地上奔跑的金毛犬，阳光明媚",
    "output_size": "1024x1024",
    "num": 2,
    "init_image": "https://cdn.example.com/ref.png"
  }
}
```

**② 点「自动生成生图模板」后得到**

```json
{
  "url": "{{BASE_URL}}/generate",
  "method": "POST",
  "headers": {
    "Authorization": "Bearer {{API_KEY}}",
    "X-Custom-Trace": "abc123"
  },
  "body": {
    "model_name": "{{MODEL}}",
    "query": "{{PROMPT}}",
    "output_size": "{{SIZE}}",
    "num": "{{COUNT}}",
    "init_image": "{{IMAGE1}}"
  }
}
```

> 字段名只要是 prompt / model / size / n / count / image 的**子串**（忽略大小写）就会自动替换；
> 没识别到的（如上面的 `X-Custom-Trace`）原样保留。识别错的可以自己在模板 JSON 里改。

---

## 示例 3：生图响应（提取图片字段）

**① 官网响应示例（粘贴进「生图响应示例」）**

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "items": [
      { "img_url": "https://cdn.example.com/a.png" },
      { "img_url": "https://cdn.example.com/b.png" }
    ]
  }
}
```

**② 点「自动生成响应提取路径」后得到**

```
data.items.0.img_url
```

（保存进模板时自动变成 `"extract": { "generate": { "images": ["data.items.0.img_url"] } }`；
运行时会把 `data.items` 数组里所有成员的 `img_url` 全部取回——第一张、第二张都能下载。）

**读图响应正文路径**（手填，常见形态）：

```
choices.0.message.content
```

若响应正文是 part 数组：

```
candidates.0.content.parts
```

---

## 示例 4：完整模板 JSON（合并三段后，直接粘进「模板 JSON」并保存）

```json
{
  "enabled": true,
  "read": {
    "url": "{{BASE_URL}}/v1/chat/completions",
    "method": "POST",
    "headers": {
      "Authorization": "Bearer {{API_KEY}}",
      "Content-Type": "application/json"
    },
    "body": {
      "model": "{{MODEL}}",
      "messages": [
        {
          "role": "user",
          "content": [
            { "type": "image_url", "image_url": { "url": "{{IMAGE1}}" } },
            { "type": "text", "text": "{{PROMPT}}" }
          ]
        }
      ],
      "max_tokens": 1024
    }
  },
  "generate": {
    "url": "{{BASE_URL}}/generate",
    "method": "POST",
    "headers": {
      "Authorization": "Bearer {{API_KEY}}",
      "X-Custom-Trace": "abc123"
    },
    "body": {
      "model_name": "{{MODEL}}",
      "query": "{{PROMPT}}",
      "output_size": "{{SIZE}}",
      "num": "{{COUNT}}",
      "init_image": "{{IMAGE1}}"
    }
  },
  "extract": {
    "read": { "content": "choices.0.message.content" },
    "generate": { "images": ["data.items.0.img_url"] }
  }
}
```

---

## 常见问题

- **只生图不读图 / 只读图不生图**：`read` / `generate` 分别可选。哪个引擎没有对应能力就不填哪段，只填有的。
- **不想用某一段了**：删掉对应 `read` / `generate` / `extract` 段即可；`"enabled": false` 整体关闭。
- **保存报「url 不能为空」**：模板里 `read` 或 `generate` 缺 `url` 字段。url 写 `{{BASE_URL}}/路径` 或完整地址都行。
- **误把真实密钥填进模板了怎么办**：立即到「引擎设置」重新保存一次（模板 JSON 改为 `{{API_KEY}}`），并手动检查 `~/.visionforge/config.json` 是否残留明文；如有，删除对应字段后重新保存。
- **生成出来图片不对 / 数量不对**：检查 `extract.generate.images` 路径是否指向真正的图片字段；多图请用带 `.0.` 的数组路径（`data.0.url` 这种，插件会自动展开整组）。
- **推断结果与官网实际不符**：直接在「模板 JSON」里手改，改完保存即可，无需重新推断。
