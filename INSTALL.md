# Installing VisionForge (for an AI agent)

> **Source**: https://github.com/LR611415/visionforge（公开仓库，可直接打开本文件或 `git clone https://github.com/LR611415/visionforge.git`）

## 方式二：把安装交给你的 AI（不想读文档的人直接这么用）

用户把下面这句话原样发给自己的 AI 即可，AI 会读本文件按步骤完成安装、引导填写引擎与密钥、体检并汇报：

> 按 https://github.com/LR611415/visionforge 的 INSTALL.md 安装并配置 VisionForge 插件，完成后运行体检（doctor）并把结果告诉我。

**AI 安装时的红线**：密钥、接口地址、模型名一律由**用户本人**在设置卡片或 `config set` 里填写/确认，AI 不得替用户猜、不得在对话里复述或写死具体密钥与地址；用户可跳过配置步骤，跳过后随时去 DSH 设置 → VisionForge 配置卡片补填。

如果你的运行环境支持 Skill（如支持 SKILL.md 的 agent），可直接加载项目内 `skills/visionforge/SKILL.md`（含 `references/`），效果与本文件相同。

---

You are an AI agent and your user told you to install `visionforge`. This document
is the procedure. Follow it in order. Every step is safe to run again, and every
step names what to do when it fails. Commands are shown for PowerShell (Windows)
with POSIX equivalents where they differ.

VisionForge is a **DeepSeek Harness (dsh) plugin**: vision understanding +
image generation. It is NOT a generic agent skill — it only works on a machine
that has DeepSeek Harness (desktop or web) installed. If the target machine has
no `~/.dsh/` directory and no DeepSeek Harness app, installation is not possible;
tell the user that.

> **Supported environment**: DSH Desktop v2.0.14 / dsh harness 0.1.7-rc.2
> (verified 2026-09). Newer major releases may change plugin interfaces; if a
> step fails in a way this document does not cover, report the exact error text.

---

## Step 0: are you inside DeepSeek Harness (dsh)?

If `~/.dsh/` exists, or the conversation runs in the DeepSeek Harness web or
desktop app, VisionForge installs as a **native plugin** — there is no skill
folder to copy. Go to Step 1. (The upstream ModLens INSTALL.md has skill-based
steps for other harnesses; VisionForge deliberately ships only the dsh plugin
form, so skip any skill-folder steps you may have seen elsewhere.)

---

## Step 1: install the plugin package

### Path A: from npm (after `visionforge` is published — preferred)

Detect the profile first: list what exists under the profiles directory.

```powershell
Get-ChildItem "$env:USERPROFILE\.dsh\profiles" -Directory | Select-Object -ExpandProperty Name
```

Then add the plugin for that profile (replace `<profile>` with `desktop`, `web`,
or the name you found):

```bash
npx -y @deepseek-ai/dsh plugin --profile <profile> add @lr611/visionforge
```

**If it fails:**
- `404` / `not found` for `@lr611/visionforge` → the package is not
  published yet. Use Path B (local copy), or ask the user to publish first.
- `declares no dsh.bundle` warning → a release-age gate installed an old
  version. Name an explicit version instead: `add @lr611/visionforge@0.1.0`.
- Network/registry error → check connectivity, then retry.
- If the official `@liustack/modlens` is also installed, remove it first to
  avoid duplicate tool registration:
  `npx -y @deepseek-ai/dsh plugin --profile <profile> remove @liustack/modlens`.

### Path B: local copy (before publishing, or offline)

VisionForge is a directory with `dsh/`, `src/`, `skills/`, `package.json` and
`cordis.patch.yml`. Copy the whole directory into the profile's plugin
dependencies. If `@lr611/visionforge` is NOT installed yet, declare it first so
dsh loads the plugin:

```bash
npx -y @deepseek-ai/dsh plugin --profile <profile> add @lr611/visionforge
```

then overwrite its files with the local VisionForge ones (same paths, same layout):

```powershell
$src = "<path to the VisionForge folder>"
$dst = "$env:USERPROFILE\.dsh\profiles\<profile>\node_modules\@lr611\visionforge"
Copy-Item -Recurse -Force "$src\dsh" "$dst\dsh"
Copy-Item -Force "$src\src\index.js" "$dst\src\index.js"
Copy-Item -Force "$src\cordis.patch.yml" "$dst\cordis.patch.yml"
Copy-Item -Force "$src\package.json" "$dst\package.json"
```

> 不要覆盖 `@liustack/modlens` 官方包——VisionForge 是独立包 `@lr611/visionforge`，
> 与官方互不干扰。若两者同时存在，工具名不同不会冲突。

**After either path**, tell the user to **fully restart dsh**, then check the
model selector: entries suffixed `(modlens vision)` mean the plugin is live.
Pasting images also works on plain text-only entries (the image becomes a local
path). Go to Step 2 for the engine, then Step 3 to verify.

---

## Step 2: give it one vision engine

VisionForge needs at least one working engine. The CLI is invoked as
`npx @lr611/visionforge` when published, or `node <dst>\src\index.js` for a local copy
(below, `visionforge` means whichever resolves). First, check what is already
configured — it spends no quota:

```powershell
npx @lr611/visionforge doctor --json
```

Read the `providers` section: an API provider showing `[ok]` is ready — skip to
Step 3. Otherwise configure one path below. The key may be a comma-separated
list (rotation after auth/rate-limit/quota failures).

### 配置引擎（引导式提问，**可整体跳过**）

**联动跳过规则（硬性）**：按顺序一次只问一步。**任一步用户选择『跳过』，立即停止所有后续配置提问**——接口、密钥、模型全部不再弹出，直接进入 Step 3 验证。之后用户可随时去 DSH 设置 → VisionForge 配置卡片补全，配置不丢失、不影响安装完成。

**提问顺序与跳过联动**：

1. **选择引擎**（必问）：`qwen`（推荐：读图+生图+编辑）/ `glm`（读图+生图）/ `openai` / `anthropic` / `gemini-api` / **跳过**
   - 用户选『跳过』 → **不再问 2/3/4 步**，直接 Step 3
2. **接口地址 baseUrl**：用户提供；说『默认/留空』 → 不写，继续第 3 步（大部分平台有内置默认地址，留空可用）
   - 用户跳过 → 不再问 3/4 步（只保留引擎选择，之后去卡片补）
3. **密钥 apiKey**：用户提供（支持逗号分隔多个，自动轮换）；说『没有/跳过』 → **不再问第 4 步**
4. **模型 model**：用户提供读图/生图模型名

**首选（推荐）**：直接引导用户用**设置卡片**——DSH 设置 → 内置插件 → **VisionForge 配置**：引擎、API Key、Base URL、模型、优先级全部前端操作；密钥保存后显示为 `••••••`。卡片打开后让用户自己填，AI 不代填、不索要、不复述密钥。

CLI 等价命令（自动化 / 无界面场景；`<...>` 为占位符，取用户自己的值）：

```powershell
npx @lr611/visionforge config set provider <engine>              # 如 qwen / openai / anthropic
npx @lr611/visionforge config set <engine>.apiKey <YOUR_KEY>     # 可逗号分隔多个 key 自动轮换
npx @lr611/visionforge config set <engine>.baseUrl <URL>         # 用户自己的兼容端点
npx @lr611/visionforge config set <engine>.model <MODEL>         # 用户选择的视觉模型
```

- `qwen` 引擎同时用于视觉读图与图片生成（Qwen-Image）；其余引擎仅读图。
- 模型必须接受图像输入（纯文本模型会失败或产生幻觉）。
- 配置写入 `~/.visionforge/config.json`，与设置卡片完全等价，任意一处保存即生效。

> **Windows note**: `~/.visionforge/config.json` holds all values, written with
> restricted permissions. Re-running `config set` overwrites in place. If a
> write fails, the home directory is not writable — confirm the user profile
> path before retrying.

### 自定义引擎（可选，任何厂商）

内置引擎之外的厂商（Google Gemini、Imagen、OpenAI 兼容网关等）无需改代码即可接入。同样遵循"用户自己填、可跳过"：

1. 推荐引导用户用**设置卡片**：VisionForge 配置卡片底部「+ 添加 / 编辑自定义引擎」——名称自动规范化（重名 / 拼写有护栏提示）、接口地址粘贴后自动识别协议族、密钥可留空稍后补。
2. CLI 等价命令（用户提供自己的值）：

```powershell
npx @lr611/visionforge config add-engine google --base-url https://generativelanguage.googleapis.com --display-name "Google Gemini" --read-family gemini --gen-family chat-native --model gemini-3.1 --gen-model imagen-4.0
npx @lr611/visionforge config list-custom
npx @lr611/visionforge config test google     # 1×1 占位图实测，花极少配额
```

3. 用户跳过 → 完全不影响安装，之后随时补。详见 `docs/engine-adapter-design.md`。

---

## Step 3: verify with doctor

Run the diagnosis (spends no quota):

```powershell
npx @lr611/visionforge doctor
```

**Success is the two lines under `Selected provider`:** the provider named there
must also appear as `[ok]` in the `Providers` list above. Other providers
showing `[!!]` is normal.

Common lines and what they mean:

| Line | Meaning | Fix |
| :-- | :-- | :-- |
| `[!!] ... (minimum 22.19)` under `Node` | Node is too old | Upgrade Node to 22.19+ |
| `Selected provider: ...` differs from what you configured | The provider was never switched | Re-run `config set provider <name>` (Step 2) |
| `[!!] <provider>: missing: apiKey` | The key was not saved | Re-run the Step 2 commands |
| `none detected` under `Harness` | Not inside a recognized agent right now | Fine for a plain CLI check; dsh recovers at run time |

Add `--json` for a machine-readable report you can parse.

**If it fails:** relay the exact error. Most failures are catalogued in the
project README's 常见问题 (Common Questions) section. Do not report VisionForge
as broken before reading that section.

To confirm the read path end to end, run one real read (this call spends one
read against the engine):

```powershell
npx @lr611/visionforge -i <path-to-image>
```

---

## Done

The plugin is installed and a vision engine is ready. From now on you do not type
these commands by hand: the plugin triggers on its own when an image needs
reading. To change engines or add keys later, re-run the `config set` commands
above, or use the settings card. For download/cache/uninstall details, see the
project `README.md`.
