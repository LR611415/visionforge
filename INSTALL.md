# Installing VisionForge (for an AI agent)

> **Source**: https://github.com/LR611415/visionforge（公开仓库，可直接打开本文件或 `git clone https://github.com/LR611415/visionforge.git`）

You are an AI agent and your user told you to install `visionforge`. This document
is the procedure. Follow it in order. Every step is safe to run again, and every
step names what to do when it fails. Commands are shown for PowerShell (Windows)
with POSIX equivalents where they differ.

VisionForge is a **DeepSeek Harness (dsh) plugin**: vision understanding +
image generation. It is NOT a generic agent skill — it only works on a machine
that has DeepSeek Harness (desktop or web) installed. If the target machine has
no `~/.dsh/` directory and no DeepSeek Harness app, installation is not possible;
tell the user that.

> **Supported environment**: DSH Desktop v2.0.14 / dsh harness 0.1.7-rc.1
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
npx -y @deepseek-ai/dsh plugin --profile <profile> add @lr611415/visionforge
```

**If it fails:**
- `404` / `not found` for `@lr611415/visionforge` → the package is not
  published yet. Use Path B (local copy), or ask the user to publish first.
- `declares no dsh.bundle` warning → a release-age gate installed an old
  version. Name an explicit version instead: `add @lr611415/visionforge@0.1.0`.
- Network/registry error → check connectivity, then retry.
- If the official `@liustack/modlens` is also installed, remove it first to
  avoid duplicate tool registration:
  `npx -y @deepseek-ai/dsh plugin --profile <profile> remove @liustack/modlens`.

### Path B: local copy (before publishing, or offline)

VisionForge is a directory with `dsh/`, `dist/`, `package.json` and
`cordis.patch.yml`. Copy the whole directory into the profile's plugin
dependencies. If the upstream `@liustack/modlens` package is already installed,
**overwrite its files** with the VisionForge ones (same paths, same layout):

```powershell
$src = "<path to the VisionForge folder>"
$dst = "$env:USERPROFILE\.dsh\profiles\<profile>\node_modules\@liustack\modlens"
Copy-Item -Recurse -Force "$src\dsh" "$dst\dsh"
Copy-Item -Force "$src\dist\main.js" "$dst\dist\main.js"
Copy-Item -Force "$src\cordis.patch.yml" "$dst\cordis.patch.yml"
Copy-Item -Force "$src\package.json" "$dst\package.json"
```

If `@liustack/modlens` is NOT installed yet, declare it so dsh loads the plugin:

```bash
npx -y @deepseek-ai/dsh plugin --profile <profile> add @liustack/modlens
```

(then overwrite the files as above and re-run the declare command, or edit the
profile's `cordis.yml` / `cordis.patch.yml` to include `@liustack/modlens`).

**After either path**, tell the user to **fully restart dsh**, then check the
model selector: entries suffixed `(modlens vision)` mean the plugin is live.
Pasting images also works on plain text-only entries (the image becomes a local
path). Go to Step 2 for the engine, then Step 3 to verify.

---

## Step 2: give it one vision engine

VisionForge needs at least one working engine. The CLI is invoked as
`npx @lr611415/visionforge` when published, or `node <dst>\dist\main.js` for a local copy
(below, `visionforge` means whichever resolves). First, check what is already
configured — it spends no quota:

```powershell
npx @lr611415/visionforge doctor --json
```

Read the `providers` section: an API provider showing `[ok]` is ready — skip to
Step 3. Otherwise configure one path below. The key may be a comma-separated
list (rotation after auth/rate-limit/quota failures).

### Path 1: Qwen (千问, recommended — the engine VisionForge is built around)

```powershell
npx @lr611415/visionforge config set qwen.apiKey <KEY>
npx @lr611415/visionforge config set qwen.baseUrl https://maas.qianwenaiapi.com/compatible-mode/v1
npx @lr611415/visionforge config set qwen.model qwen3.8-max
npx @lr611415/visionforge config set provider qwen
```

If the user has a different Qwen endpoint or model, use their values. `qwen` is
used for vision reading AND image generation (Qwen-Image).

### Path 2: any OpenAI-compatible endpoint

```powershell
npx @lr611415/visionforge config set openai.baseUrl <url>
npx @lr611415/visionforge config set openai.apiKey <key>
npx @lr611415/visionforge config set openai.model <model>
npx @lr611415/visionforge config set provider openai
```

All three fields are required, and the model must accept image input (a
text-only model will fail or hallucinate).

### Path 3: Anthropic (Claude)

```powershell
npx @lr611415/visionforge config set anthropic.apiKey <sk-ant-key>
npx @lr611415/visionforge config set provider anthropic
```

### Path 4: let the user fill the settings card

The GUI route: ask the user to open **DSH Settings → Built-in plugins →
VisionForge 配置** and fill engine / API key / base URL / model / priority, then
save (the key field shows `••••••` when saved). Configuration is shared — the
same `~/.modlens/config.json` — so this is equivalent to the CLI commands above.

> **Windows note**: `~/.modlens/config.json` holds all values, written with
> restricted permissions. Re-running `config set` overwrites in place. If a
> write fails, the home directory is not writable — confirm the user profile
> path before retrying.

---

## Step 3: verify with doctor

Run the diagnosis (spends no quota):

```powershell
npx @lr611415/visionforge doctor
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
npx @lr611415/visionforge -i <path-to-image>
```

---

## Done

The plugin is installed and a vision engine is ready. From now on you do not type
these commands by hand: the plugin triggers on its own when an image needs
reading. To change engines or add keys later, re-run the `config set` commands
above, or use the settings card. For download/cache/uninstall details, see the
project `README.md`.
