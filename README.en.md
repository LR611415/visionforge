# VisionForge

**Give DeepSeek Harness "eyes" and a "brush": vision understanding + image generation + image editing, all in one plugin.**

VisionForge is a deep rework of the open-source vision plugin [liustack/modlens](https://github.com/liustack/modlens) (MIT): it adds the Qwen engine, image generation and editing, an in-app settings card, and an official/plugin dual parse-priority dispatcher. It keeps the upstream's lightweight architecture — on DSH it is just a plugin directory; removing it deletes everything, no official DSH component is modified, and native functionality is untouched.

> **Supported environment**: DSH Desktop **v2.0.17** / DSH harness **0.2.0-rc.2** (verified 2026-10). DSH major releases may change plugin interfaces — re-verify after an upgrade.

### Plugin version × DSH harness matrix

| Plugin | Released | DSH harness | DSH Desktop | Notes |
| --- | --- | --- | --- | --- |
| 0.1.8 and earlier | ≤ 2026-09-27 | harness 0.1.x early | — | Fork/bridge of liustack/modlens 3.26.3 (branding + initial integration) |
| 0.1.9 | 2026-09-28 | harness 0.1.7-rc.1 | — | First rewritten connection layer (~90% original, upstream credit kept); feature baseline |
| 0.1.10 | 2026-09-30 | harness 0.1.7 series (-rc.1 / -rc.2) | v2.0.14 (verified 2026-09) | Enhanced 0.1.9: compliance docs, settings card, marketplace prep |
| **0.2.1** (current) | 2026-10-02 | harness 0.2.0-rc.2 (verified 2026-10); 0.1.7 series compatible | v2.0.17 (verified 2026-10) | Enhanced 0.1.10: 100-char prompt floor + 6-dimension guide check + detail-writing guide + parallel multi-image (no timeout) and 5 bug fixes |

> Install-level compatibility (npm `peerDependencies`): `@deepseek-ai/dsh-client-ui-primitives` allows `>=0.0.1-rc.1 <0.1.0 || >=0.1.0-rc.1 <0.2.0-0 || >=0.2.0-0 <0.3.0-0` (harness 0.1.x and 0.2.x series install); the table lists verified versions.

---

## Feature overview

| Capability | Description |
| :-- | :-- |
| 🖼️ Paste-to-read | Under official vision models, pasted images preview natively in the input box; under text-only models the plugin takes over (turns the image into a local path and parses it). No manual path copying in either mode |
| 🔭 Multi-provider vision engines | `Qwen` / `OpenAI` (any OpenAI-compatible endpoint) / `Anthropic` / `Gemini` / `Antigravity` / `Claude` / `Kimi`, composed into an automatic failover chain — a failed key rotates to the next |
| 🎨 Image generation | `visionforge_generate_image`: text-to-image (Qwen-Image / GLM-Image), 1–6 images, multiple sizes |
| ✏️ Image editing | `visionforge_edit_image`: outfit/scene swap, multi-image merge, expression change (Qwen-Image edit), 1–3 inputs, batch variants (each one different, never duplicated) |
| 🔍 Image zoom | Generated images render as a **90px thumbnail**; **clicking the image itself** opens the cached original in the **system image viewer** — no DSH side panel |
| ⬇️ One-click download | Click "Save image N" to **copy the cached image to the D: drive root** (falls back to `VisionForge` under the user profile when there is no D:), then **auto-selects the saved file in Explorer**; also bypasses the side panel |
| ⚖️ Parse priority | `Official first`: official vision models parse when they can, plugin only as fallback; `Plugin first`: always try your configured provider keys first, official only after all fail |
| ⚙️ Settings card | A "VisionForge 配置" card inside DSH Settings — engine / key / endpoint / model / priority are **all filled in by you**; keys are masked as `••••••` after saving, never hard-coded; the Save button highlights on real changes and greys out after saving |
| 🧩 Custom engines (translator) | Any vendor beyond the built-ins (Google Gemini, Imagen, OpenAI-compatible gateways, private endpoints) can be added without code changes, via the settings card "Add / edit custom engine" or `visionforge config add-engine`. Names are normalized with guards; the base URL auto-detects the format family; read / generate / edit follow per-model capabilities |
| 🗂️ Unified directories | Generation cache, paste cache and download directory all converge to fixed locations — nothing scattered in system temp dirs |
| 🧹 Cache cleanup | Generation and paste caches **expire automatically after 3 days** (swept on plugin start); downloaded permanent copies are unaffected |
| 🔗 Local loopback service | Preview / zoom / download run through local fixed candidate ports (45999/46999/47999/48999) — no dependence on the provider's temporary OSS links (24h expiry); images from old messages stay previewable/zoomable/downloadable after a DSH restart |

## Installation

### Option 1: npm install (recommended)

```bash
npx -y @deepseek-ai/dsh plugin --profile desktop add @lr611/visionforge
```

Then open DSH Settings → built-in plugins → **VisionForge 配置**, fill in the engine and key, and **fully restart DSH Desktop** for it to take effect.

> If an old `@liustack/modlens` is installed, remove it first to avoid two plugins registering the same tool names:
> `npx -y @deepseek-ai/dsh plugin --profile desktop remove @liustack/modlens`

### Option 2: let your AI install it (for non-CLI users)

Send this sentence to your AI assistant (the one inside DSH, or any AI that can reach this machine's terminal/files):

> Follow https://github.com/LR611415/visionforge's INSTALL.md to install and configure the visionforge plugin, then run the doctor check and report the result.

The AI follows `INSTALL.md`: one-command npm install (or local-copy fallback) → engine configuration (skippable — you can fill it in later via the settings card) → `doctor` check → report. AI environments with Skill support can load the bundled `skills/visionforge/SKILL.md` directly.

### Option 3: local source copy fallback (offline / pre-publish)

See Path B in the repo's `INSTALL.md`: copy `dsh/`, `src/`, `skills/`, `cordis.patch.yml`, `package.json` into the DSH plugin directory and run `npm install`.

## Quick start

1. **Configure an engine**: DSH Settings → built-in plugins → VisionForge 配置 → choose an engine (e.g. `Qwen`) → fill API key, endpoint, model → Save (key field shows `••••••` when saved).
2. **Read an image**: copy/paste an image into the input box — official vision models show a native preview and parse it directly; in plugin-first mode it is converted to a path and parsed with your provider keys.
3. **Generate**: say "generate an image of a scarecrow in a field"; the model calls `visionforge_generate_image` and a 90px thumbnail appears in the conversation — **click the image** to zoom with the system viewer, click "Save image N" to download to the D: drive root.
4. **Edit**: paste 1–3 images and say "change her dress to a white JK skirt"; the model calls `visionforge_edit_image` — with the same preview and download flow.

## Custom engines (engine translator)

Beyond the built-in engines you can add **any vendor** (Google Gemini, Imagen, custom OpenAI-compatible gateways, private endpoints) with no code changes — for reading, text-to-image and image-to-image. The "format family" decides how images are sent to the engine, so you never need to know the difference between `image_url` and `inline_data`.

### From the settings card

1. DSH Settings → VisionForge 配置 card → bottom "**+ Add / edit custom engine**".
2. Fill in: engine name (auto-normalized to lowercase `a-z0-9._-`; collisions with built-ins are refused, near-miss spellings are hinted), display name (optional), base URL (pasting auto-detects and pre-fills the read family), read family, generate family, API key (can be left empty and filled later), vision model, generation model (fills generation capability).
3. After saving, the engine appears in the top engine dropdown and can be set as the default.

### From the CLI

```bash
# read + generate (Google Gemini example)
visionforge config add-engine google \
  --base-url https://generativelanguage.googleapis.com \
  --display-name "Google Gemini" \
  --read-family gemini --gen-family chat-native \
  --model gemini-3.1 --gen-model imagen-4.0

visionforge config list-custom              # list custom engines
visionforge config remove-engine google     # remove
visionforge config test google              # end-to-end test with a 1×1 placeholder (tiny quota cost)
```

Keys and models can be filled later via the settings card or `visionforge config set custom.<name>.apiKey`.

### Format families (decide the image upload format)

| Family | Image format | Suitable for |
| --- | --- | --- |
| `openai-compatible` (default fallback) | `image_url` + data URI | OpenAI-compatible gateways, Qwen, GLM, Moonshot, DeepSeek, ~90% of vendors |
| `anthropic` | `image` + `source` base64 block | Anthropic / Claude-compatible endpoints |
| `gemini` | `inline_data` (remote images are fetched back to base64) | Google Gemini |
| `raw-base64` | raw base64 fields on private endpoints | private gateways |

Generation families: `dashscope-image` (Qwen-Image native), `openai-image` (`/images/generations`), `chat-native` (Gemini multimodal generation), `google-imagen` (Imagen `:predict` / `:editImage`). Size formats convert per family (`1024*1024` for Qwen, `1024x1024` for OpenAI, ratios like `1:1` for Imagen); unsupported capabilities fail loudly instead of silently.

### Name guards

- Names auto-normalize (case / spaces / hyphens / underscores);
- Collisions with built-in or existing custom engines are refused with an explanation;
- Near-miss spellings of built-ins (Levenshtein ≤ 2, e.g. `qwenx` → `qwen`) get a "did you mean the built-in?" hint — never silently renamed;
- Base URL domains auto-detect the read family and pre-fill it.

## Settings card fields

| Field | Description |
| :-- | :-- |
| Engine | `Qwen` / `OpenAI` / `Anthropic` / `Gemini` / `Antigravity` / `Claude` / `Kimi`, or **Auto** (builds a failover chain from whichever keys are configured) |
| API key | Filled in by you; comma-separated keys rotate on auth/rate-limit/quota failure; masked as `••••••` after save, selectable and deletable |
| Base URL | The engine's endpoint (e.g. Qwen's OpenAI-compatible endpoint; Antigravity / Claude / Kimi are CLI engines and need no URL) |
| Model | Vision reading model (e.g. `qwen3.8-max`); the dropdown switches to that engine's common models when you change engines, and custom models are allowed |
| Parse priority | `Official first` (default) or `Plugin first` |
| Image output dir | Generation cache directory, default `D:\VisionForge\out` |
| Paste-to-path | Smart takeover switch (text-only models convert pasted images to local paths for the plugin) |

> The model dropdown lists only **vision reading models**; generation models (e.g. `qwen-image-3.0`) are called automatically by the generate/edit commands — no selection needed here.
> For CLI engines (Antigravity / Claude / Kimi) the key and endpoint are not required; the Save button lights up / dims according to actual changes.

## Generated-image interaction

- **Quality (default & resolution words)**: when no quality is specified — engines that support 2K (Qwen / Imagen / Gemini) default to **2560×1440 (2K)**; engines that don't (GLM, side limit 2048) default to **their maximum resolution (2048×2048)**. Spoken resolution words are supported: `4K` (3840×2160), `2.5K / 2K` (2560×1440), `1080P / HD` (1920×1080). True 4K exceeds every engine's native ceiling: Qwen downscales to ≈2.7K (2728×1536) by total-pixel limit, GLM downscales 2K to 2048×1152 by side limit, each with a `sizeNote` in the result (never silently downgraded, never faked as 4K).
- **Downgrade note (`sizeNote`)**: when the engine doesn't support the requested resolution, the result states "the engine doesn't support the requested resolution + the final generated resolution + engines that do support it" (e.g. 2K suggests Qwen / Imagen 4 / Gemini; 4K states no common engine supports it natively and external upscaling is needed).
- **Edit-prompt auto enhancement**: `edit` defaults to ON — short instructions get protective constraints appended (strictly preserve facial features/hair/body, natural limbs and fingers, keep composition and lighting, no text/watermark); when you explicitly ask to change something (e.g. "change hairstyle"), the matching constraint is skipped. Can be disabled entirely (settings-card toggle or `--no-enhance`).
- **Thumbnail**: 90px preview in the conversation, pointing at the local loopback cache (no dependency on provider temp links).
- **Click the image**: the plugin captures the click → requests local `loopback /visionforge/open` → the **system image viewer** opens the cached original (zoom, rotate, save-as); no DSH side panel.
- **Save image N**: the plugin intercepts the button → requests local `loopback /visionforge/download-local` → the cached image is **copied to the D: drive root** (or `C:\Users\<you>\VisionForge` without D:) + Explorer **auto-selects** the saved file; no side panel.
- **Host decoration**: DSH adds `↓🌐` icons when rendering links as buttons — that is host behavior, not plugin-controlled.

## Directories and cache governance

### Unified directories (fixed, configurable)

| Content | Location | Description |
| :-- | :-- | :-- |
| Generation cache | `D:\VisionForge\out` (changeable via `outputDir` in the settings card) | Plugin-generated images, served for preview / zoom / download |
| Paste cache | `D:\VisionForge\out\paste` | Local copies written by paste takeover (no longer in system temp) |
| Download copies | `D:\` root (or `C:\Users\<you>\VisionForge` without D:) | Permanent copies after "Save image N" |
| Plugin config | `C:\Users\<you>\.visionforge\config.json` | Engines, keys, models, priority, output dir |

### Cache cleanup

- **TTL 3 days**: generation and paste caches older than 3 days are deleted automatically (swept on plugin start).
- **Downloads are permanent**: copies in the D: root are **not** affected by cleanup.
- Conversation previews point at the cache; after a cache expires, old thumbnails stop working — expected behavior; regenerate or download instead.

## Boundaries and uninstall (no interference with native DSH)

- **Strict scoping**: every front-end behavior (click capture, button interception, styles, paste takeover) only triggers when it hits plugin images (`img[src*="/visionforge/image"]`, plugin-rendered save buttons); **native DSH components, official messages, and other plugins are untouched**.
- **Uninstall is clean**: after removing the plugin and restarting DSH, no scripts are injected, no local service starts, ports are released. All plugin code lives inside the package (`dsh/index.js`, `dsh/client.js`) — **no official DSH file is modified**.
- **Optional deep cleanup** (after uninstall):
  ```powershell
  Remove-Item -Recurse -Force "C:\Users\<you>\.visionforge"   # plugin config and keys
  Remove-Item -Recurse -Force "D:\VisionForge"               # cache dir (includes downloaded copies! back up first)
  ```
- **Note**: images already downloaded to the `D:\` root are independent copies, not inside `D:\VisionForge`; they survive uninstall — decide yourself whether to delete them.

## FAQ

**Q: A pasted image becomes `![图片](http://127.0.0.1:.../visionforge/image?path=...)` text?**
A: The selected model was judged text-only, so the plugin took over and converted it to a path (a floating thumbnail strip at the bottom-right lets you preview/remove). Switch to the official `DeepSeek-V4-Pro` / `DeepSeek-V4-Flash` (or any image-capable vision model) for native preview.

**Q: Clicking the image does not zoom?**
A: Make sure DSH was fully restarted so the plugin is live; click the **image itself** (not the surrounding link text). Still broken? Check `D:\VisionForge\out\click-debug.log`: entries mean the click reached the plugin (issue is in the system viewer call); no entries mean the click never reached the plugin script (host sandbox).

**Q: Clicking "Save image N" does nothing?**
A: Confirm the button text is "Save image N" (not a host-rendered link). On success the file appears in the D: root and is auto-selected in Explorer; if the sandbox blocks `explorer`, the plugin falls back to opening the directory.

**Q: Why is the key field empty after saving?**
A: Saved keys display as `••••••`; an empty field means no key is configured for that engine (or the save failed) — paste the key again and save.

**Q: How do I fully uninstall VisionForge?**
A: Plugin market / `dsh plugin remove @lr611/visionforge` → fully restart DSH → (optional) delete `~/.visionforge` and `D:\VisionForge`. Native DSH functionality is unaffected.

## Acknowledgements

VisionForge is a rework of [liustack/modlens](https://github.com/liustack/modlens) (MIT): on top of its mature vision parsing engine (OCR / layout / semantic evidence, failover chain), this project independently implements Qwen / GLM image generation and editing, paste-to-read, in-conversation thumbnails, system-viewer zoom, one-click download and the configuration card. Thanks to liustack for the open-source contribution.

## License

MIT (same license as upstream ModLens; this rework is based on its MIT-licensed source and may be freely modified and redistributed).
