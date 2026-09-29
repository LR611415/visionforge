# Changelog

All notable changes to `@lr611/visionforge` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) conventions; versioning is
SemVer (with `-rc` prereleases for the harness this plugin targets).

## [Unreleased] — local development (not published)

### Added
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
