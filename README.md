# VisionForge

**给 DeepSeek Harness 装上"眼睛"和"画笔"：视觉理解 + 图片生成 + 图片编辑，一个插件搞定。**

> 🌐 [English](README.en.md) | 中文

VisionForge 基于开源视觉插件 [liustack/modlens](https://github.com/liustack/modlens)（MIT）深度改造而来：接入千问（Qwen）引擎、新增图片生成与编辑能力、内置图形化设置卡片、支持官方 / 插件双解析优先级调度。改造点全部保留原插件的轻量架构——在 DSH 上只是一个插件目录，卸载即删除，不修改任何 DSH 官方组件，不影响原生功能。

> **适配环境**：DSH Desktop **v2.0.14** / DSH harness **0.1.7-rc.2**（2026-09 实测）。DSH 大版本更新可能改变插件接口，升级后请重新验证。

---

## 功能一览

| 能力 | 说明 |
| :-- | :-- |
| 🖼️ 粘贴即读 | 官方视觉模型下图片粘贴进输入框**原生预览**；纯文本模型下由插件接管转成本地路径并解析，两种模式都无需手动复制路径 |
| 🔭 多提供商视觉引擎 | `Qwen` / `OpenAI`（任意 OpenAI 兼容端点）/ `Anthropic` / `Gemini` / `Antigravity` / `Claude` / `Kimi`，自动组成故障转移链，一个密钥失败自动轮换下一个 |
| 🎨 图片生成 | `visionforge_generate_image`：文字描述生成图片（Qwen-Image / GLM-Image），支持 1–6 张、多种尺寸 |
| ✏️ 图片编辑 | `visionforge_edit_image`：换装、换背景、多图融合、改表情（Qwen-Image edit），支持 1–3 张输入、批量输出变体（每张不同，绝不重复） |
| 🔍 图片放大 | 对话内生成的图片以**90px 缩略图**呈现，**点击图片本体**直接用**电脑系统图片查看器**打开缓存位置的原图放大——不弹 DSH 侧边栏 |
| ⬇️ 一键下载 | 点击「保存图片 N」把缓存图**复制到 D 盘根目录**（无 D 盘则用户目录 `VisionForge` 文件夹），并在**资源管理器中自动选中**刚保存的文件；同样不经过侧边栏 |
| ⚖️ 解析优先级 | `官方优先`：官方视觉模型能看图时先解析，不行才走插件；`插件优先`：始终先用你配置的提供商密钥，全部失败才试官方 |
| ⚙️ 设置卡片 | DSH 设置页内置「VisionForge 配置」卡片，引擎 / 密钥 / 接口 / 模型 / 优先级全部**由你自己填写**；密钥保存后显示 `••••••` 掩码，不写死在代码里；改动内容时保存按钮高亮，保存成功后恢复灰色 |
| 🗂️ 统一目录 | 生成图缓存、粘贴原图缓存、下载目录全部收敛固定，不散落在系统临时目录 |
| 🧹 缓存清理 | 生成图与粘贴缓存超过 **3 天**自动过期清理（启动时执行）；已下载的永久副本不受影响 |
| 🔗 本地回环服务 | 预览 / 放大 / 下载走本机固定候选端口（45999/46999/47999/48999）loopback 路由，不依赖提供商的临时 OSS 链接（24h 失效），重启 DSH 后旧消息的图仍可预览、放大、下载 |

## 安装

### 方式一：npm 安装（推荐）

```bash
npx -y @deepseek-ai/dsh plugin --profile desktop add @lr611/visionforge
```

安装后进入 DSH 设置 → 内置插件 → **VisionForge 配置** 卡片填写引擎与密钥，**完全重启 DSH Desktop** 生效。

> 若本机已安装旧版 `@liustack/modlens`，请先移除再安装本包，避免两套插件同时注册同名工具：
> `npx -y @deepseek-ai/dsh plugin --profile desktop remove @liustack/modlens`

### 方式二：把安装交给你的 AI（不熟悉命令行的用户）

把下面这句话发给你的 AI 助手（DSH 内的助手，或任何能访问本机终端 / 文件的 AI）：

> 按 https://github.com/LR611415/visionforge 的 INSTALL.md 安装并配置 visionforge 插件，完成后运行体检（doctor）并把结果告诉我。

AI 会按 `INSTALL.md` 的步骤执行：npm 一键安装（或本地复制兜底）→ 配置引擎（可跳过，跳过则随时可去设置卡片补填）→ `doctor` 体检 → 报告结果。支持 Skill 的 AI 环境可直接加载项目内 `skills/visionforge/SKILL.md`。

### 方式三：本地源码复制兜底（离线 / 未发布场景）

见仓库 `INSTALL.md` 的 Path B：把 `dsh/`、`src/`、`skills/`、`cordis.patch.yml`、`package.json` 复制到 DSH 插件安装目录并 `npm install`。

## 快速开始

1. **配引擎**：DSH 设置 → 内置插件 → VisionForge 配置 → 选择引擎（如 `Qwen`）→ 填入 API 密钥、接口地址、模型 → 保存（密钥框显示 `••••••` 即保存成功）。
2. **看图**：把图片复制 / 粘贴进输入框——官方视觉模型下显示原生预览，直接发送即可解析；插件优先时会转路径交给你的提供商密钥解析。
3. **生图**：对话里说"生成一张田间的稻草人"，模型调用 `visionforge_generate_image`，对话内直接出现 90px 缩略图，**点击图片**用系统图片查看器放大，点「保存图片 N」下载到 D 盘根目录。
4. **改图**：粘贴 1–3 张图，说"把女生的衣服换成白色 JK 裙"，模型调用 `visionforge_edit_image` 完成编辑，同样带预览与下载。

## 设置卡片配置项

| 字段 | 说明 |
| :-- | :-- |
| 引擎 | `Qwen` / `OpenAI` / `Anthropic` / `Gemini` / `Antigravity` / `Claude` / `Kimi`，或**自动**（按已配置的密钥自动组成故障转移链，谁可用谁解析） |
| API 密钥 | 由你自己填写，支持英文逗号分隔多 key，鉴权 / 限流 / 配额失败自动轮换；保存后显示 `••••••` 掩码，可点选删除 |
| 接口地址 | 该引擎的 Base URL（如千问 AI 平台 OpenAI 兼容端点；Antigravity / Claude / Kimi 为 CLI 引擎无需地址） |
| 模型 | 视觉读图模型（如 `qwen3.8-max`）；切换引擎后下拉列表自动切换为对应引擎的常用模型，也可自定义 |
| 解析优先级 | `官方优先`（默认）或 `插件优先` |
| 图片输出目录 | 生成图片的缓存目录，默认 `D:\VisionForge\out` |
| 粘贴转路径 | 智能接管开关（纯文本模型下把粘贴图转成本地路径供插件读取） |

> 模型候选下拉只列**视觉读图模型**；生成模型（如 `qwen-image-3.0`）由生图 / 编辑命令自动调用，不需要在这里选。
> 引擎为 CLI 类（Antigravity / Claude / Kimi）时，密钥与接口地址无需填写，保存按钮会根据实际改动亮起 / 熄灭。

## 生成图交互说明

- **缩略图**：对话内显示 90px 小图，指向本地 loopback 缓存（不依赖提供商的临时链接）。
- **点击图片**：由插件捕获点击 → 请求本机 `loopback /visionforge/open` → **电脑系统图片查看器**打开缓存原图（可放大、缩放、另存）；不弹 DSH 侧边栏。
- **保存图片 N**：点击后插件拦截该按钮 → 请求本机 `loopback /visionforge/download-local` → 缓存图**复制到 D 盘根目录**（无 D 盘则 `C:\Users\<你>\VisionForge`）+ 资源管理器**自动选中**刚保存的文件；全程不弹 DSH 侧边栏。
- **宿主自动装饰**：链接渲染成按钮时 DSH 会自动加 `↓🌐` 图标，属宿主行为，非插件控制。

## 目录与缓存治理

### 统一目录（全部固定，可配置）

| 内容 | 位置 | 说明 |
| :-- | :-- | :-- |
| 生成图缓存 | `D:\VisionForge\out`（可在设置卡片改 `outputDir`） | 插件生成的图片，供对话预览 / 放大 / 下载 |
| 粘贴原图缓存 | `D:\VisionForge\out\paste` | 粘贴接管后写入的本地副本（不再落系统临时目录） |
| 下载永久副本 | `D:\` 根目录（无 D 盘则 `C:\Users\<你>\VisionForge`） | 点击「保存图片 N」后缓存复制到此，永久保留 |
| 插件配置 | `C:\Users\<你>\.visionforge\config.json` | 引擎、密钥、模型、优先级、输出目录 |

### 缓存清除机制

- **TTL 3 天**：生成图缓存与粘贴缓存超过 3 天自动删除（插件启动时清扫）。
- **下载即永久**：已下载的副本在 D 盘根目录，**不受清理影响**。
- 对话里的预览链接指向缓存；缓存过期后旧消息的缩略图失效属预期行为——重新生成或下载即可。

## 边界与卸载（不干扰原生 DSH）

- **作用域严格限定**：前端注入的所有行为（点击捕获、按钮拦截、样式、粘贴接管）都以命中插件图片为前提（`img[src*="/visionforge/image"]`、插件渲染的保存按钮）；**DSH 原生组件、官方消息、其他插件零影响**。
- **卸载即干净**：移除插件后 DSH 重启即不再注入脚本、不再启动本地服务、端口释放。插件代码全部在插件包内（`dsh/index.js`、`dsh/client.js`），**不修改任何 DSH 官方文件**。
- **可选彻底清理**（卸载后）：
  ```powershell
  powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1   # 一键引导式卸载（自动清理 profile 声明/插件目录/配置/缓存，含确认提示）
  ```
  或手动：
  ```powershell
  Remove-Item -Recurse -Force "C:\Users\<你>\.visionforge"   # 插件配置与密钥
  Remove-Item -Recurse -Force "D:\VisionForge"               # 缓存目录（含已下载副本！先备份要留的）
  ```
- **注意**：`D:\` 根目录下已下载的图片是独立副本，不在 `D:\VisionForge` 内，卸载后仍保留，需自行确认是否删除。

## 常见问题

**Q：粘贴图片变成 `![图片](http://127.0.0.1:.../visionforge/image?path=...)` 文本？**
A：你当前选中的模型被判定为纯文本模型，插件接管转成了路径文本（右下角有悬浮缩略图条可预览 / 删除）。切到官方 `DeepSeek-V4-Pro` / `DeepSeek-V4-Flash`（或任何声明 image 的视觉模型）即可原生预览。

**Q：点击图片没有放大？**
A：确认已完全重启 DSH 使插件生效；点击的是**图片本体**（不是旁边的链接文字）。若仍无效，检查 `D:\VisionForge\out\click-debug.log` 是否有记录：有记录说明点击已到达插件（问题在系统查看器调用），无记录说明点击未到达插件脚本（宿主沙箱限制）。

**Q：点击「保存图片 N」没有反应？**
A：确认按钮文字为「保存图片 N」（不是宿主自动渲染的其他链接）。成功后 D 盘根目录出现文件并自动在资源管理器中选中；若沙箱拒绝 explorer 会自动回退打开目录。

**Q：密钥框保存后为什么是空的？**
A：保存后密钥以 `••••••` 掩码显示；若显示为空说明该引擎未配置密钥（或保存失败），重新粘贴密钥再保存。

**Q：怎么彻底卸载 VisionForge？**
A：插件市场 / `dsh plugin remove @lr611/visionforge` → 完全重启 DSH →（可选）删除 `~/.visionforge` 与 `D:\VisionForge`。卸载后 DSH 原生功能不受任何影响。

## Acknowledgements

VisionForge 基于 [liustack/modlens](https://github.com/liustack/modlens)（MIT）的图像桥接设计改造而来：在其成熟的视觉解析引擎（OCR / 布局 / 语义证据、失败切换链）之上，独立实现了 Qwen / GLM 生图与编辑、粘贴直读、对话内缩略图预览、系统查看器放大、一键下载与配置卡片等能力。感谢 liustack 的开源贡献。

## License

MIT（上游 ModLens 同许可；本改造基于其 MIT 许可源码，可自由修改与分发）。
