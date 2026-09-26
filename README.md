# VisionForge

**给 DeepSeek Harness 装上"眼睛"和"画笔"：视觉理解 + 图片生成，一个插件搞定。**

VisionForge 基于开源视觉插件 ModLens 深度改造而来：接入千问（Qwen）引擎、新增图片生成与编辑能力、内置图形化设置卡片、支持官方 / 插件双解析优先级调度。改造点全部保留原插件的轻量架构——在 dsh 上只是一个插件目录，卸载即删除，不影响任何 Harness 配置。

> **适配环境**：DSH Desktop **v2.0.14** / DSH harness **0.1.7-rc.1**（2026-09 验证）。DSH 大版本更新可能改变插件接口，需按「本机增强记录」重新核对。

---

## 功能一览

| 能力 | 说明 |
| :-- | :-- |
| 🖼️ 粘贴即读 | 官方 DeepSeek 视觉模型下，图片粘贴进输入框**原生预览**，发送后由视觉模型直接解析（官方已把文本模型请求路由到原生多模态模型） |
| 🔭 多提供商视觉引擎 | `qwen` / `openai`（任意 OpenAI 兼容端点）/ `anthropic` / `gemini-api` / `antigravity-cli` / `claude-cli` / `kimi-cli`，自动组成故障转移链 |
| 🎨 图片生成 | `modlens_generate_image`：文字描述生成图片（Qwen-Image / GLM-Image） |
| ✏️ 图片编辑 | `modlens_edit_image`：换装、换背景、多图融合、改表情（Qwen-Image edit），支持 1-3 张输入、批量输出 |
| ⚖️ 解析优先级 | `官方优先`：官方视觉模型能看图时先解析，不行才走插件；`插件优先`：始终先用你配置的提供商密钥，全部失败才试官方 |
| ⚙️ 设置卡片 | DSH 设置页内置「VisionForge 配置」卡片，引擎 / 密钥 / 接口 / 模型 / 优先级全部**由你自己填写**，密钥保存后显示 `••••••` 掩码，不写死在代码里 |
| 🖱️ 对话内预览 | 生成的图片在对话里以 **90px 缩略图**显示，**点击缩略图**打开电脑系统图片查看器放大；旁边有「下载」按钮（按钮上的 `↓🌐` 图标为 DSH 宿主渲染链接时自动添加，非插件控制） |
| 🗂️ 统一目录 | 生成图缓存、粘贴原图缓存、下载目录全部收敛固定，不再东一张西一张 |
| 🧹 缓存清理 | 生成图与粘贴缓存超过 **3 天**自动过期清理（启动时执行）；下载的永久副本不受影响 |
| 🔗 本地回环服务 | 预览 / 下载走本机固定端口（43999）loopback 路由，不依赖提供商的临时 OSS 链接（24h 失效、带下载头），重启 DSH 后旧消息的图仍可预览 |

## 安装

### 方式一：从 npm 安装改造版（推荐）

```bash
npx -y @deepseek-ai/dsh plugin --profile desktop add @lr611/visionforge
```

安装后进入 DSH 设置 → 内置插件 → **VisionForge 配置** 卡片填写引擎与密钥，**完全重启 DSH Desktop** 生效。

> 若本机已安装官方版 `@liustack/modlens`，请先移除再安装本包，避免两套插件同时注册同名工具：
> `npx -y @deepseek-ai/dsh plugin --profile desktop remove @liustack/modlens`

> 源码 / 本地复制兜底：见仓库 `INSTALL.md` 的 Path B（未发布或离线场景，复制 `dsh/`、`dist/`、`cordis.patch.yml`、`package.json` 到 `@liustack\modlens` 安装目录覆盖）。

### 方式二：把安装交给你的 AI（推荐给不熟悉命令行的用户）

把下面这句话发给你的 AI 助手（DSH 内的助手，或任何能访问本机终端 / 文件的 AI）：

> 按 https://github.com/LR611415/visionforge 的 INSTALL.md 安装并配置 visionforge 插件，完成后运行体检（doctor）并把结果告诉我。

AI 会按 `INSTALL.md` 的步骤执行：npm 一键安装（发布后）或本地复制兜底 → 配置引擎（qwen 等）→ `doctor` 体检 → 报告结果。`INSTALL.md` 是一份专门写给 AI 的可执行文档（含失败处理与 Windows 注意），照着跑不会卡壳。

### 方式三：从插件商店安装官方版

官方版提供读图能力，但不含本仓库的千问引擎与生图能力改造：

```bash
npx -y @deepseek-ai/dsh plugin --profile desktop add @liustack/modlens
```

安装后进入 DSH 设置 → 内置插件 → **VisionForge 配置** 卡片填写引擎与密钥。

## 快速开始

1. **配引擎**：DSH 设置 → 内置插件 → VisionForge 配置 → 选择引擎（如 `qwen`）→ 填入 API 密钥、接口地址、模型 → 保存（密钥框显示 `••••••` 即保存成功）。
2. **看图**：把图片复制 / 粘贴进输入框——官方视觉模型下显示原生预览，直接发送即可解析；插件优先时会转路径交给你的提供商密钥解析。
3. **生图**：对话里说"生成一张田间的稻草人"，模型调用 `modlens_generate_image`，对话内直接出现 90px 缩略图，**点击缩略图**打开系统查看器放大，旁边「⬇ 下载」保存到本地。
4. **改图**：粘贴 1-3 张图，说"把女生的衣服换成白色 JK 裙"，模型调用 `modlens_edit_image` 完成编辑，同样带预览与下载。

## 设置卡片配置项

| 字段 | 说明 |
| :-- | :-- |
| 引擎 | `qwen` / `openai` / `anthropic` / `gemini-api` / `antigravity-cli` / `claude-cli` / `kimi-cli`，或留空自动（故障转移链决定） |
| API 密钥 | 由你自己填写，支持英文逗号分隔多 key，鉴权 / 限流 / 配额失败自动轮换；保存后掩码显示 |
| 接口地址 | 该引擎的 Base URL（如千问 AI 平台 OpenAI 兼容端点） |
| 模型 | 视觉读图模型（如 `qwen3.8-max`）；部分引擎提供候选下拉 |
| 解析优先级 | `官方优先`（默认）或 `插件优先` |
| 图片输出目录 | 生成图片的缓存目录，默认 `D:\VisionForge\out` |
| 粘贴转路径 | 智能接管开关（文本模型下把粘贴图转成本地路径供插件读取） |

> 模型候选下拉只列**视觉读图模型**；生成模型（如 `qwen-image`）由生图 / 编辑命令自动调用，不需要在这里选。

## 目录与缓存治理

### 统一目录（全部固定，可配置）

| 内容 | 位置 | 说明 |
| :-- | :-- | :-- |
| 生成图缓存 | `D:\VisionForge\out`（可改 `outputDir`） | 插件生成的图片，供对话预览 |
| 粘贴原图缓存 | `D:\VisionForge\out\paste` | 粘贴接管后写入的本地副本（不再落系统临时目录） |
| 下载永久副本 | `D:\` 根目录（无 D 盘则 `C:\Users\<你>\VisionForge`） | 点击「下载」后缓存复制到此，永久保留 |
| 插件配置 | `C:\Users\<你>\.modlens\config.json` | 引擎、密钥、模型、优先级、输出目录 |

### 缓存清除机制

- **TTL 3 天**：生成图缓存与粘贴缓存超过 3 天自动删除（插件启动时清扫，排除 `save-debug.log` 诊断日志）。
- **下载即永久**：已下载的副本在 D 盘根目录，**不受清理影响**。
- 对话里的预览链接指向缓存；缓存过期后旧消息的缩略图失效属预期行为——重新生成或下载即可。

## 本机增强记录（改造说明）

> 以下为 VisionForge 对上游 ModLens 的本地改造记录，仅适用于本机安装；上游或 DSH 官方更新后可能失效，需按下文重新应用。

### 1. DSH 设置卡片（settings.plugins.tab）

- 注册点：`dsh/client.js` 的 ConfigCard，挂在 `settings.plugins.tab`（id=`modlens`，label=`VisionForge 配置`），打开 DSH 设置 → 内置插件即可见。
- 配置项：引擎、API 密钥（保存后显示 `••••••` 掩码）、Base URL、模型、解析优先级（`official` / `plugin`）、粘贴接管开关、输出目录。
- 引擎（7 个）：`antigravity-cli` / `gemini-api` / `openai` / `qwen` / `anthropic` / `claude-cli` / `kimi-cli`；`auto` 会按已配置项组成 failover 链。
- 模型候选（前端下拉）：qwen = `qwen3.8-max / qwen3-vl-plus / qwen3-vl-flash / qwen-vl-max / qwen-vl-plus`。

### 2. 粘贴预览（适配 DSH 0.1.7 新准入闸门）

- **背景**：DSH 0.1.7 新增 `session/attachment-invalid` 准入——模型未声明 `image` 输入能力时，粘贴 / 发送图片被拒。`deepseek-v4-pro` 原本无 image 声明 → 适配器兜底 `["text"]` → 粘贴被拒，需插件接管成路径文本。
- **补丁 A（DSH 适配器 `dsh-llm-deepseek`）**：给 `deepseek-v4-pro` 声明 `inputModalities: ["text","image"]`——官方已将请求路由到 V4.1 Flash（原生多模态），声明与事实一致 → 准入放行 → **粘贴恢复原生预览**（备份 `index.js.bak`）。
- **补丁 B（modlens `dsh/index.js` verdict）**：`visionPriority=plugin` 时不再盲目强制接管——先删缓存、走 host 真实能力判定；模型真正声明 image 则保留原生缩略图，纯文本模型才接管。
- **结果**：`DeepSeek-V4-Pro` / `DeepSeek-V4-Flash` 下粘贴 = 输入框原生预览；发送 = 官方 Flash 读图，或按 `visionPriority=plugin` 调度走插件（qwen key）读图。
- **预览条**：右下角悬浮缩略图条，每张图独立 `×`，点击同步删除输入框内对应的 markdown 片段。

### 3. 生成图对话预览与下载

- 本地代理路由：`/modlens/image?path=`（渲染、无下载头）与 `/modlens/download?path=`（attachment 下载头）；服务固定 `127.0.0.1:43999`（被占用才回退随机端口）。
- 白名单 = 输出目录内文件 + **modlens 自己登记过的生成文件**（只有插件生成的路径可服务）。
- 对话内缩略图 **90px**，**点击缩略图**打开电脑系统图片查看器（`/modlens/open` → `cmd start`）；「⬇ 下载」→ 复制缓存到 D 盘根 + 资源管理器**自动选中**刚保存的文件（`explorer /select`，沙箱拒绝则回退打开目录）。
- 卡片上宿主自带的「放大」按钮已被隐藏（与点击缩略图功能重复）；万一漏网，点击它也只隐藏不打开侧边栏。

### 4. 本机改码与同步守则

1. 用 python 补丁脚本修改源码（禁用 PowerShell `Set-Content`，避免 BOM；DSH 内置包是 tab 缩进，需用显式 `\t` 转义）。
2. `node --check` 语法检查。
3. `Copy-Item` 同步到安装目录：`C:\Users\李\.dsh\profiles\desktop\node_modules\@liustack\modlens\dsh\`。
4. 重启 DSH Desktop 生效。
5. 维护一份**基线副本**（如 `VisionForge-copy`）用于回退；副本一旦建立不再改动。

## 边界与卸载（不干扰原生 DSH）

- **作用域严格限定**：前端注入的所有行为（点击拦截、按钮隐藏、样式、粘贴接管）都以命中插件图片（`img[src*="/modlens/image"]`）为前提；**DSH 原生组件、官方消息、其他插件零影响**。
- **卸载即干净**：从插件市场 / 命令移除插件后，DSH 重启即不再注入任何脚本、不再启动本地服务、端口释放。插件的所有代码都在 `@liustack/modlens` 包内（dsh/index.js、dsh/client.js），不修改任何 DSH 官方组件——唯一的例外是历史遗留的适配器补丁 `dsh-llm-deepseek`（官方文件，DSH 更新会覆盖，见「注意事项」）。
- **可选彻底清理**（卸载后）：
  ```powershell
  Remove-Item -Recurse -Force "C:\Users\李\.modlens"      # 插件配置与密钥
  Remove-Item -Recurse -Force "D:\VisionForge"            # 缓存目录（含已下载副本！先备份要留的）
  ```
- **注意**：`D:\` 根目录下已下载的图片是独立副本，不在 `D:\VisionForge` 内，需自行确认是否保留。

## 注意事项

- **统一目录**：一切文件收敛在 `D:\VisionForge\` 下——生成图缓存 `D:\VisionForge\out`、粘贴原图缓存 `D:\VisionForge\out\paste`、下载默认 `D:\` 根目录（无 D 盘则在用户主目录下创建 `VisionForge` 文件夹）。不设置在项目目录内，也不散落在 C 盘临时目录。
- DSH 官方更新会覆盖 `dsh-llm-deepseek` 适配器补丁（重做即可，备份在 `index.js.bak`）。
- 配置文件：`C:\Users\李\.modlens\config.json`（引擎、密钥、接口、模型、优先级、输出目录均由设置卡片维护；密钥保存后显示为 `••••••`，不暴露明文）。
- 生成 / 缓存目录：`D:\VisionForge\out`。

## 常见问题

**Q：粘贴图片变成 `![图片](http://127.0.0.1:.../modlens/image?path=...)` 文本？**
A：你当前选中的模型被判定为纯文本模型，插件接管转成了路径文本（右下角有悬浮缩略图条可预览 / 删除）。切到官方 `DeepSeek-V4-Pro` / `DeepSeek-V4-Flash`（或任何声明 image 的视觉模型）即可原生预览。

**Q：生成的图片对话里不显示 / 重启后不能放大了？**
A：确认已重启 DSH 使补丁生效；服务已固定端口 43999，重启后旧消息的图仍可预览放大。缓存超过 3 天会过期，重新生成即可。

**Q：点击下载没有反应？**
A：确认卡片上出现的是「⬇ 下载」按钮（点击后资源管理器自动打开并选中文件）。若沙箱拒绝 explorer 会自动回退打开目录；下载本身已成功（文件在 D 盘根目录）。

**Q：密钥框保存后为什么是空的？**
A：保存后密钥以 `••••••` 掩码显示；若显示为空说明该引擎未配置密钥（或保存失败），重新粘贴密钥再保存。

**Q：怎么彻底卸载 VisionForge？**
A：插件市场 / `dsh plugin remove @liustack/modlens` → 完全重启 DSH →（可选）删除 `~/.modlens` 与 `D:\VisionForge`。卸载后 DSH 原生功能不受任何影响。

## License

MIT（上游 ModLens 同许可；本改造基于其 MIT 许可源码，可自由修改与分发）。
