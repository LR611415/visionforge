# Changelog

All notable changes to `@lr611/visionforge` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) conventions; versioning is
SemVer (with `-rc` prereleases for the harness this plugin targets).

## [0.1.10] — 2026-09-30

### Added
- **内容合规文档（README + SKILL.md）**：新增「真人照片 → 真人照片」生成边界章节——
  依据民法典第 1019 条、《互联网信息服务深度合成管理规定》、《生成式人工智能服务管理
  暂行办法》第 12 条、最高法《关于依法审理涉人工智能纠纷案件的意见》（法发〔2026〕10 号）、
  《人工智能生成合成内容标识办法》说明三类场景边界（本人照片自用 ✅ / 他人照片需授权 ⚠️ /
  公众人物冒充、丑化、低俗、伪造不实场景、未成年人 ❌），并明确插件（技术护栏）与宿主
  （判断与拒绝，第一道闸）的职责划分。SKILL.md「职责边界」章节新增「真人照片合规（红线，
  宿主必读）」小节。
- **P-G 内置设置卡片「粘贴示例自动生成模板」（对齐网页设置页）**：开发者选项「自定义请求
  模板」区新增示例输入框 + 4 个按钮——「自动识别类型」（前端启发式：含 messages+image →
  读图；含 url/data → 响应；含 prompt+size/n → 生图）与「读图示例 / 生图示例 / 响应示例」
  手动兜底。调用服务端 `/visionforge/settings/infer-template`（与网页设置页同一端点）自动
  推断占位符并**合并进模板 JSON**（read → `merged.read`、generate → `merged.generate`、
  extract → `merged.extract.generate.images`），用户无需手拼 JSON 结构。

### Notes
- **兼容性实测（harness 0.2.0-rc.2 / DSH Desktop v2.0.17）**：0.1.10 的
  `peerDependencies` 上限为 `<0.2.0-0`，harness 0.2.x 安装时需授予版本豁免；
  授予后实测读图 / 生图 / 编辑 / 设置卡片 / 预览 / 下载全部正常。下一版本将把
  上限放宽至 `<0.3.0-0`，0.2.x 用户安装将不再需要豁免。

## [Unreleased] — local development (not published)

### Added
- **Batch 2 (2026-09-30, local only — not pushed/published):**
  - **D1** Tool descriptions slimmed down (read/generate/edit point at `skills/visionforge/SKILL.md`).
  - **B4** Reference-image feature-summary cache (`D:\VisionForge\features\<sha>.json`, written on
    each read-image, reused by edit prompt anchoring).
  - **A1** Settings card advanced section (`<details>`: output dir / paste takeover / debug logs /
    prompt enhancement toggle).
  - **A2** Engine capability badges in the settings dropdown (per-engine caps / max resolution,
    e.g. `Qwen (读图+生图+编辑 · 2K)`).
  - **E1** Key zero-leak audit: all error paths redact secrets (classify/failure formatting,
    custom-engine gate errors).
  - **B1** Posture dictionary expanded to 26 entries (kiss / princess-hold / neck-hold / hug /
    piggyback / fireman-carry / cross-leg / lotus-sit / squat / kneel / snuggle / arm-around /
    back-to-back / shoulder-ride + Chinese scene variants).
  - **B2** Scene-dynamics dictionary expanded to 12 groups (+8: water / dance / snow-ice / ball /
    climbing / swing / instrument / lying down), each with need/skip guards.
  - **B3** English instruction support: every trigger word has English equivalents, case-insensitive;
    **word-boundary matching** (regex `\b…\b` for ASCII words) so `visit`≠`sit`, `with`≠`hit`,
    `career`≠`car`, `seahorse`≠`horse`; third-person verb variants (`sits/hits/rides/…`) added.
  - **C1** Config versioning: `version:1` written on persist; broken-config backup
    (`config.json.bak-<ts>` + explicit error) instead of silent reset.
  - **C2** Cache management in the settings card: live usage stats (output / generated / paste /
    features) + one-click TTL cleanup that **preserves current-session images**.
  - **E2** `doctor --uninstall-check`: lists every local footprint (config dir, cache root,
    features dir, fallback dir, DSH profile dependency/bundle/installed path, env vars).
  - **C4** API-key rotation verified on the read side (keyIndex + cooldown-aware ordering) and
    **added to the generate side** (qwen / glm / custom engines now try each comma-separated key
    on auth/quota failure instead of using `apiKeys[0]` only).
  - **Batch 3 (2026-09-30, local only — not pushed/published):**
    - **P-A** Posture **geometric visual details** in the prompt enhancer: every posture entry
      now carries a `visual` (positive, geometry-based scene description — e.g. princess-hold =
      "一手托肩背、一手托大腿与膝弯，双腿自然弯垂"), output as a new `姿态细节：` segment
      alongside the defensive constraint list; multi-posture combos (princess-hold + neck-hold +
      kiss) get a `多姿态协调` coordination sentence. Posture coverage raised to 15 entries with
      scene-aware visuals (side-sit on bicycle / chair / horse).
    - **P-B** Web settings page custom-engine form slimmed to match the built-in DSH card:
      only 引擎名称 + 显示名称; saving registers the engine into the dropdown and selects it
      (base URL / API key / models are filled in the common fields below and persisted by the
      main 保存). Edit button removed (config edits go through the common fields); list keeps
      per-entry 删除.
    - **P-C** 高级设置 upgraded to **开发者选项** on both the web page and the built-in card:
      response format (`structuredOutput` 强制读图 JSON schema), request timeout
      (`timeoutMs`, 1000–600000 ms), proxy mode (`inherit / direct / custom` + proxy URL),
      request-body extra (`extraBody` JSON, deep-merged, keys rejected if reserved). Server-side
      `applySettings` now persists these per engine (built-in `providers.<name>` and custom
      `customProviders.<id>`); `allEngineMeta` / `engineSummary` expose them for UI回填; the
      runtime providers layer already consumed them (openai / gemini / anthropic / custom).
    - **P-D** Custom **request templates** (official-JSON fallback for engines whose request
      format does not fit the built-in protocol families): new `src/request-template.js` with
      placeholder rendering (`{{BASE_URL}}` / `{{API_KEY}}` / `{{MODEL}}` / `{{PROMPT}}` /
      `{{IMAGE1..3}}` / `{{SIZE}}` / `{{COUNT}}`), dot-path response extraction
      (`extractReadContent` / `extractGeneratedImages` with sibling-array expansion for
      multi-image responses), and heuristic template inference from pasted official request /
      response examples (`inferReadRequestTemplate` / `inferGenRequestTemplate` /
      `inferReadContentPath` / `inferGenImagePaths`). Runtime routing: `custom.js execute()`
      and `imagegen.js customGenImageCall()` detect `entry.requestTemplate.enabled` and build
      the request from the template instead of the protocol family (extract paths override
      family parsing when present); empty-image errors now guide the user to the developer
      options. Settings: `applySettings` persists/validates `requestTemplate` per engine,
      `engineSummary` / `allEngineMeta` expose it; web settings page developer options gained
      the 自定义请求模板 section (paste read/generate/response examples → 自动生成模板 →
      editable template JSON → enable) backed by a new `POST /visionforge/settings/infer-template`
      endpoint; the built-in DSH card mirrors the template-JSON field. 9 new unit tests
      (placeholder rendering, dot-path extraction, sibling expansion, inference, merge).
    - **P-E2 提示词职责边界定版（替换 P-E 细节层）**：**细节描写/扩写归宿主，插件只守边界 + 指导**。
      移除 P-E 的细节描写填充层（FILLER_SECTIONS / SCENE_ATMOS / QUALITY_BOOST 全部删除——
      prompt 不再被插件代写画质/光影/构图/氛围），保留保护性边界约束（防换脸/防畸变/防穿模/
      姿态语义澄清、场景动态物理兜底）与 generate 模式约束过滤。新增**短提示词检测**：宿主原文
      （去空白）不足 50 字时，增强器返回 `notice` 提醒宿主按写作指南补细节（提醒不写入 prompt、
      不代写内容），CLI `generate`/`edit` 结果带 `enhanceNotice`，DSH 工具把它渲染成结果里的
      `注意:` 行。**写作指南落点**：DSH 工具 `prompt` 参数 description（生成/编辑各一份，宿主每次
      调用必读——主体特征、动作几何化、场景、光影、构图、画质六维 + ≥50 字 + 不新增元素），
      skills/visionforge/SKILL.md 新增「提示词写作指南」章节。测试改写为 notice 机制断言
      （短提示词→notice 且无代写、宿主写足→无 notice、generate 跳约束组），全量 140/140 通过。
    - **P-E3 notice 升级：字数 + 六维覆盖双检测（点名缺失维度）**——新增提示词写作指南
      六维检测词表（主体特征/动作姿态/场景环境/光影氛围/构图视角/画质要求，中英文代表词），
      触发条件从「<50 字」升级为「<50 字 **或** 六维覆盖 <3 维」：短指令点名缺失维度并列出
      已覆盖维度（「提示词仅 N 字，缺少：…，已覆盖 主体特征、动作姿态…」）；区分图生图
      （提醒先读图锁身份、原图场景光线不变可写明「保持原图场景光线构图」）与文生图
      （无原图可依、须补全六维）两种指导文案；杜绝「堆砌空词凑字数」漏检。SKILL.md 写作指南
      新增**合格范例**（约 80 字完整图生图 prompt）与**偷懒写法负面清单**（5 类模糊指令禁止
      照搬）；DSH 工具描述同步说明 notice 点名机制。新增 7 项测试（缺失维度点名/字数足缺维
      仍提醒/keep-scene 路径/generate 文案/六维全无 notice），全量 145/145 通过。
    - **P-F 自定义请求模板（开发者选项兜底）体验优化**：
      - **尺寸占位符三态**：新增 `{{SIZE_X}}`（`1024x1024`，OpenAI/GLM/Gemini 系）与
        `{{SIZE_STAR}}`（`1024*1024`，千问 DashScope 系），`{{SIZE}}` 保留内部原文向后兼容——
        解决"模板按官网示例填 `1024x1024`，引擎实际收到内部 `1024*1024` 报 400"的经典坑
        （与早前 `--size 1024x1024` 被 qwen 拒同一根因）。
      - **数字类型保真**：`{{COUNT}}`/`{{SIZE}}`/`{{SIZE_X}}`/`{{SIZE_STAR}}` 单独占满一个
        JSON 节点时，按引擎示例里该节点的类型输出（示例是数字就发数字，不再强制字符串化），
        避免"引擎要 `n: 2`（number）却收到 `"2"`"的 400。
      - **错误提示带模板段名**：`renderTemplateRequest` 新增 `label` 参数（读图/生图），
        缺 url 时报「读图模板缺少 url / 生图模板缺少 url」+ 修复指引。
      - **UI 说明同步**：内置卡片（client.js 中英文）与网页设置页（index.js hint）占位符表
        补 `{{SIZE_X}}`/`{{SIZE_STAR}}` 与类型保真说明。
      - **docs/request-template-examples.md 新增「真实引擎填写示例」**：千问 DashScope
        （读图 OpenAI 兼容 + 生图原生格式 + 异步响应提取）、OpenAI 兼容、Anthropic、Gemini
        四组官方请求 JSON 骨架 → 自动生成后核对要点，附「引擎 → 尺寸分隔符 → 常用字段名」
        对照表（DashScope=`*`，其余多=`x`），用户对着填即可。
      新增 3 项模板测试（SIZE 三态/数字类型保真+非整节点字符串/label 错误提示），
      全量 148/148 通过。
    - **P-G 内置设置卡片「粘贴示例自动生成模板」（对齐网页设置页，解决"不知道往哪填"）**：
      内置卡片「自定义请求模板」区新增示例输入框 + 4 个按钮——「自动识别类型」
      （前端启发式判断示例是读图请求 / 生图请求 / 生图响应：含 messages+image → read；
      含 url/data → extract；含 prompt+size/n → generate）与「读图示例 / 生图示例 /
      响应示例」三个手动指定按钮（识别不出时兜底）。点击后调服务端
      `/visionforge/settings/infer-template`（复用网页设置页同一端点），自动推断占位符
      模板并**合并进下方模板 JSON**（read → `merged.read`，generate → `merged.generate`，
      extract → `merged.extract.generate.images`），用户只需粘贴官网示例 → 点按钮 → 核对 →
      保存，无需手拼 JSON 结构。识别结果即时反馈（成功/未识别可变字段/类型无法自动判断）。
      语法检查通过，同步安装目录。
- `docs/engine-adapter-design.md` — design for a dynamic **engine translator**: users add
  custom providers (name / format family / endpoint / key / model); image upload formats are
  resolved from a format-family template table (openai-compatible / anthropic / gemini /
  raw-base64) instead of being hard-coded per provider. **Design only, not implemented.**
- Unit tests for the pure logic layers (zero dependencies, `node --test`):
  - `test/guard.test.js` — glob matching and guard evaluation (deny-first, allow whitelist,
    deny-when-unknown, namespace `*/model` pairs)
  - `test/config.test.js` — provider alias folding (`canonicalProviderName`)
  - `test/cooldown.test.js` — cooldown state key round-trips (`engine::key:N`)
  - `test/imagegen.test.js` — `normalizeSize` (the `1024x1024` → `1024*1024` pitfall)
- GitHub Actions CI (`.github/workflows/ci.yml`) — syntax checks, unit tests, and a
  manifest sanity check (dsh.bundle.patch, peerDependencies, repository URL) on push/PR.
- Marketplace listing preparation (not yet submitted):
  - `data/plugins/LR611415__visionforge.yml` — entry for the `awesome-dsh-plugin` PR
  - `screenshots.json` — placeholder (real screenshots to be added before push)
- `peerDependencies`: `@deepseek-ai/dsh-client-ui-primitives` with an rc-aware range
  (`>=0.0.1-rc.1 <0.1.0 || >=0.1.0-rc.1 <0.2.0-0`).
- `README.en.md` — English translation of the README (with language switch links).
- `docs/exit-codes.md` — CLI exit-code reference.

### Changed
- Diagnostics logs (`click-debug.log` / `open-debug.log` / `save-debug.log`) are now behind a
  **`debugLogs` setting** (default **off**, toggle in the settings card) instead of being
  written unconditionally.
- Settings card shows the **last engine actually used for reading** (`~/.visionforge/last-read.json`,
  recorded on each successful analyze, with provider/model/timestamp and the attempt chain).

### Added
- `scripts/uninstall.ps1` — guided one-command uninstall (clears profile declarations,
  plugin directory, `~/.visionforge` config and caches, with confirmation prompts).

## [0.1.9] — 2026-09-28

### Added
- Branded release under `@lr611/visionforge` (independent npm package; no longer mounted
  under the upstream `@liustack/modlens` namespace).
- Full rework of the bridge layer (`dsh/index.js`, `dsh/client.js`) with strict scoping —
  front-end behavior only touches plugin images/buttons, zero impact on native DSH.
- Settings card ("VisionForge 配置"): Chinese UI, masked key display with editable mask,
  Save button highlights on real changes, engine/model naming normalized (Qwen / OpenAI /
  Anthropic / Gemini / Claude / Kimi), custom model support, skip-friendly flow.

### Changed
- Cache/Download path unification: generation cache, paste cache and download copies all
  converge to `D:\VisionForge\out` / `D:\` root (fallback under user profile without D:).
- Cache TTL cleanup (3 days) on plugin start; downloads are permanent copies.
- Thumbnails at 90px; clicking the image opens the system image viewer (no side panel);
  Save button copies to D: root and auto-selects in Explorer.

### Fixed
- Generated images render in-conversation (previously relied on provider temp URLs).
- Paste-to-read restored for text-only models.
- English substring false-positives in the prompt enhancer (word-boundary matching, see B3).

## [0.1.8] — 2026-09

### Changed
- Rewrote `src/` modules (config, guard, cooldown, schema, providers, analyze, doctor)
  with a self-written implementation; kept the upstream shim and paste-recover path with
  attribution.
- CLI `bin` moved to `src/index.js` (was `dist/main.js`).

## [0.1.7] — 2026-09

### Added
- Branding pass: VisionForge settings card copy/styles, compact generated-image preview.
- Image generation & editing providers (Qwen-Image / GLM-Image) and orchestration.

## [0.1.0] — 2026-09

### Added
- Initial plugin based on the modlens vision bridge: multi-provider read (Qwen / OpenAI /
  Anthropic / Gemini / Antigravity / Claude / Kimi), failover chain, guard, cooldown.

---

## Legend / versions

- `0.1.x` — pre-1.0 feature development; `-rc.N` prereleases match the DSH harness
  release train (`0.1.7-rc.2`).
- Published on npm as `@lr611/visionforge`; repository: https://github.com/LR611415/visionforge
