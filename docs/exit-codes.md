# CLI exit codes

`visionforge` (bin → `src/index.js`) uses the following exit codes. They are stable
enough for scripts and AI agents to branch on; treat any undocumented code as an error.

| Code | Meaning | When it happens |
| :-- | :-- | :-- |
| `0` | Success | `analyze` produced evidence; `generate` / `edit` saved output; `guard` verdict `allow`; `doctor` / `config show` / `config set` completed |
| `1` | Guard deny or a normal operational error | `guard` returned `deny`; or any command hit a user-correctable error (missing key, bad argument, API 4xx/5xx, provider unreachable, timeout, quota, local file not found) — the error message names the cause and usually the fix |
| `2` | Guard machinery error | `guard` could not run at all (config read failure, internal error) — fails **open** per policy is *not* what this means; code `2` means the guard itself errored, so the caller should treat the read as unavailable rather than as allowed/denied |
| `78` | (reserved) | Reserved to match the upstream "no runtime" convention; currently unused — VisionForge needs Node 22.19+, see `engines` in package.json |

## Notes for AI agents

- **Always relay the stderr line** (`Error: ...`). Every error message is written to
  name its cause (missing key → names the `config set` command; missing CLI → names the
  install path; API 400 → quotes the provider's message).
- `doctor` spends no quota and never hits the network; run it first when diagnosing.
- `generate` / `edit` may take up to the `--timeout` (default 120s) — do not assume a
  long-running process is hung.
- Guard semantics: `exit 1` from `guard` with a `model` in the verdict means the active
  model has native vision and must read the image itself — stop and hand it over.
