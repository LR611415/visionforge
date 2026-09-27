# 配置 VisionForge

用户询问如何安装、配置或切换 VisionForge 引擎时读这份文档。优先替用户把命令跑掉，而不是解释给他听。

## 安装时的引导联动（跳过规则）

安装流程里按顺序一次只问一步：**选择引擎 → 接口地址 → 密钥 → 模型**。**任一步用户跳过，立即停止所有后续配置提问**（接口、密钥、模型全部不再弹），安装直接完成，之后用户随时去 DSH 设置 → VisionForge 配置卡片补全。配置值（密钥、接口、模型）一律由用户本人填写，AI 不得替猜、不得复述写死。

## 配置放在哪

`~/.visionforge/config.json`，由 CLI 管理（VisionForge 独立使用该路径，与 modlens 互不影响）。优先级：CLI 参数 > 本文件 > 内置默认值。不设 `provider` 时按失败切换链依次尝试（已配置的 API 引擎先于 CLI 引擎被尝试）。

```bash
npx @lr611/visionforge config init                     # 写入一份起步配置（已存在则拒绝，--force 重写）
npx @lr611/visionforge config show                     # 生效的配置，API key 打码显示
npx @lr611/visionforge config set provider <name>      # 更改默认引擎
npx @lr611/visionforge config set <provider>.<field> <value>   # 字段：apiKey、baseUrl、model、proxy、extraBody、structuredOutput
npx @lr611/visionforge config set proxy http://127.0.0.1:7890   # 所有 API 引擎的默认代理
npx @lr611/visionforge config set <provider>.proxy ""           # 让一个引擎强制直连
```

`config set` 写文件时权限为 0600。省略 `apiKey` 的值会进入隐藏输入（密钥不进 argv、不进 shell 历史）。

## 配置文件形状（本插件相关部分）

真实文件只需要写你用到的键；provider 的设置放在 `providers.<name>` 下面，不在顶层（手工编辑最常犯的错）。

```json
{
  "provider": "qwen",
  "visionPriority": "plugin",
  "pasteToPath": true,
  "outputDir": "D:\\VisionForge\\out",
  "providers": {
    "qwen": {
      "apiKey": "<用户填写的密钥>",
      "baseUrl": "<用户填写的 OpenAI 兼容地址，或留空用引擎默认>",
      "model": "<读图/生图模型名，用户填写>"
    },
    "glm": {
      "apiKey": "<用户填写的密钥>",
      "model": "<用户填写的模型名>"
    }
  }
}
```

本插件专用字段（DSH 设置卡片里同样可配置）：

- `visionPriority`：读图优先级。`plugin`（默认）= 先用本插件配置的引擎读图，全部失败才交官方模型；`official` = 先官方模型，不支持图片或失败再走插件。这个字段只影响"读图"，生图永远走插件引擎。
- `pasteToPath`：`true`（默认）时，粘贴到 DSH 输入框的图片由客户端接管，转为本地路径文本供纯文本模型经插件读取；关闭则粘贴走 DSH 原生附件管线。
- `outputDir`：生成图片的统一缓存目录（Windows 默认 `D:\VisionForge\out`，无 D 盘回退 `C:\Users\<用户名>\VisionForge`）。插件启动时若该字段缺失会自动补写默认值。下载 = 用户点击后才把缓存图复制为永久副本到下载位置。

通用字段（各 provider）：

- `providers.<name>.apiKey`：密钥，接受英文逗号分隔的列表，按配置顺序使用，只在鉴权、限流或配额失败后轮换。
- `providers.<name>.baseUrl`：OpenAI 兼容端点地址。**由用户提供**——不要替用户猜一个端点，把本该发给别家的密钥连同图片送到用户从没指定过的地方。留空用引擎内置默认。
- `providers.<name>.model`：模型名，**由用户填写**（读图模型与生图模型可能不同，如读图用多模态模型、生图用图像生成模型）。
- `providers.<name>.proxy`：三种状态——字段缺失 = 继承全局默认代理；空字符串 = 强制直连；非空 URL = 仅该引擎使用此代理。
- `providers.<name>.extraBody`：JSON 对象，合并进请求体，用于厂商特有开关（如关思考）。

## 各引擎配置步骤

### qwen（读图 + 生图 + 编辑，推荐）

需要用户提供密钥（在千问 AI 平台 / 阿里云百炼开通）：

```bash
npx @lr611/visionforge config set provider qwen
npx @lr611/visionforge config set qwen.apiKey <用户提供的密钥>   # 或省略值进入隐藏输入
npx @lr611/visionforge config set qwen.baseUrl <用户提供的 OpenAI 兼容地址，或留空>
npx @lr611/visionforge config set qwen.model <用户填写的模型名，如多模态读图模型>
```

生图时若该引擎未单独配置图像模型，插件使用引擎默认的图像生成模型。**不要替用户填密钥或具体地址**；用户在 DSH 设置卡片里填写的值会写入同一个配置文件。

### glm（读图 + 生图，不支持编辑）

需要智谱密钥：

```bash
npx @lr611/visionforge config set provider glm
npx @lr611/visionforge config set glm.apiKey <用户提供的密钥>
npx @lr611/visionforge config set glm.model <用户填写的模型名>
```

### openai / anthropic / gemini-api（读图，OpenAI 兼容端点或官方 API）

```bash
npx @lr611/visionforge config set provider openai
npx @lr611/visionforge config set openai.baseUrl <用户提供的端点>
npx @lr611/visionforge config set openai.apiKey <用户提供的密钥>
npx @lr611/visionforge config set openai.model <多模态模型名>
```

`baseUrl` 必填（用官方 OpenAI 也要写）。模型必须是多模态的，纯文本模型会失败或产生幻觉。`anthropic` 用官方 Anthropic API key；`gemini-api` 用 Google AI Studio key。

### antigravity-cli / claude-cli（CLI 引擎，复用本机登录态）

无需密钥，需要先安装对应 CLI 并完成登录（登录无法自动化，让用户自己跑一次）。复用本机其他登录态由 `reuse` 授权控制，见 `doctor` 的 Reuse 一节。

## 用 `doctor` 复核

手工编辑配置或设置卡片保存后，跑一次体检确认什么真正生效：

```bash
npx @lr611/visionforge doctor
```

`doctor` 显示每个引擎的文件值与环境变量、guard 规则与实时判定、failover 链、reuse 决定。未知顶层键和未知引擎名会被忽略而不是报错——敲错字会无声失败，所以体检是核对配置的最终手段。
