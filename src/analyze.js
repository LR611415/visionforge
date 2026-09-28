// analyze.js — 读图主流程与引擎故障切换编排
//
// 流程（保持）：解析输入（本地/远程）→ 组装链（自动链或 -p 钉死）
// → 冷却检查（冷却的引擎排到队尾、冷却的 key 排到末位）
// → 逐引擎尝试（同引擎内按 key 轮换；仅鉴权/配额失败才换下一个 key）
// → 成功即返回 {image, provider, result, meta}，失败聚合全部尝试。

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { resolveProviderSettings } from './config-resolve.js';
import { assertReadableConfig, loadConfigFile } from './config.js';
import { coolingEngineEntry, coolingEntry } from './cooldown.js';
import { providerChain, resolveProvider } from './providers/index.js';
import { discoverAuto, reuseHint, reuseProviders } from './reuse.js';
import { missingSchemaFields, normalizeVisionResult } from './schema.js';
import { resolveSpawnPlan, spawnHidden } from './shim.js';
import { assertNoRetiredEndpointBinding, isApiKeyFailure, redactSecrets, setErrorMessage, splitApiKeys } from './util.js';

export const DEFAULT_TIMEOUT_MS = 180_000;
const KILL_GRACE_MS = 30_000;
const DRAIN_GRACE_MS = 500;
const SIGKILL_GRACE_MS = 2_000;

// ---------------------------------------------------------------------------
// 输入解析
// ---------------------------------------------------------------------------

export function resolveInput(input) {
    const trimmed = input.trim();
    if (!trimmed) {
        throw new Error('Input path is required.');
    }
    if (isRemoteSource(trimmed)) {
        return { source: trimmed, kind: 'remote' };
    }
    if (/^file:\/\//i.test(trimmed)) {
        return { source: path.resolve(fileURLToPath(trimmed)), kind: 'local' };
    }
    return { source: path.resolve(trimmed), kind: 'local' };
}

function isRemoteSource(value) {
    return /^https?:\/\//i.test(value.trim());
}

export function validateInputFile(filePath) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`Input image not found: ${filePath}`);
    }
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
        throw new Error(`Input is not a file: ${filePath}`);
    }
}

// ---------------------------------------------------------------------------
// 隔离工作目录（给带工具集的 agent CLI 一个只放这张图的临时目录）
// ---------------------------------------------------------------------------

async function removeWorkdir(workdir) {
    try {
        await fs.promises.rm(workdir, { recursive: true, force: true, maxRetries: 1, retryDelay: 500 });
    } catch {
    }
}

async function isolateImage(source) {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'visionforge-work-'));
    try {
        const imageSource = path.join(workdir, path.basename(source));
        fs.copyFileSync(source, imageSource);
        fs.chmodSync(imageSource, 0o600);
        return { imageSource, workdir, cleanup: () => removeWorkdir(workdir) };
    } catch (error) {
        await removeWorkdir(workdir);
        throw error;
    }
}

function emptyWorkdir() {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'visionforge-work-'));
    return { workdir, cleanup: () => removeWorkdir(workdir) };
}

// ---------------------------------------------------------------------------
// 子进程执行（带超时、排空与失败解释）
// ---------------------------------------------------------------------------

function runCommand(providerName, invocation, timeoutMs, describeFailure) {
    const runStartedAt = Date.now();
    return new Promise((resolve, reject) => {
        const childEnv = invocation.env ? { ...process.env, ...invocation.env } : undefined;
        const plan = resolveSpawnPlan(invocation.command, invocation.args, childEnv ?? process.env, invocation.cwd);
        const spawnEnv = plan.env ?? childEnv;
        const child = spawnHidden(plan.command, plan.args, {
            cwd: invocation.cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
            // provider 可以标记自己的子进程：kimi-cli 靠它识别
            // "本进程由 kimi 启动，再调 kimi 会成环"。
            ...(spawnEnv ? { env: spawnEnv } : {}),
        });
        const outDecoder = new TextDecoder('utf-8');
        const errDecoder = new TextDecoder('utf-8');
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let settled = false;
        let drainTimer;
        let killTimer;
        const settle = (code) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            clearTimeout(drainTimer);
            stdout += outDecoder.decode();
            stderr += errDecoder.decode();
            child.stdout?.destroy();
            child.stderr?.destroy();
            child.unref();
            if (timedOut) {
                reject(new Error(`${providerName} provider timed out after ${timeoutMs} ms.`));
                return;
            }
            if (code !== 0) {
                const explained = describeFailure?.({ stdout, stderr, code, startedAt: runStartedAt }) ?? null;
                if (explained instanceof Error) {
                    setErrorMessage(explained, redactSecrets(explained.message));
                    reject(explained);
                    return;
                }
                reject(
                    new Error(
                        redactSecrets(explained ?? `${providerName} provider failed with code ${code}.${stderr ? ` stderr: ${stderr.trim()}` : ''}`),
                    ),
                );
                return;
            }
            resolve({ stdout, stderr });
        };
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            settle(null);
            killTimer = setTimeout(() => {
                if (!exited) {
                    child.kill('SIGKILL');
                }
            }, SIGKILL_GRACE_MS);
        }, timeoutMs);
        let exitCode = null;
        let exited = false;
        const restartDrain = () => {
            if (!exited || settled) {
                return;
            }
            clearTimeout(drainTimer);
            drainTimer = setTimeout(() => settle(exitCode), DRAIN_GRACE_MS);
        };
        child.stdout.on('data', (chunk) => {
            stdout += outDecoder.decode(chunk, { stream: true });
            restartDrain();
        });
        child.stderr.on('data', (chunk) => {
            stderr += errDecoder.decode(chunk, { stream: true });
            restartDrain();
        });
        child.on('error', (error) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            clearTimeout(drainTimer);
            clearTimeout(killTimer);
            const code = error.code;
            if (code === 'ENOENT') {
                const missingCwd = !fs.existsSync(invocation.cwd);
                reject(
                    new Error(
                        missingCwd
                            ? `Working directory does not exist: ${invocation.cwd}`
                            : `Provider CLI not found: ${invocation.command} (spawn ENOENT). Install it and sign in first.`,
                    ),
                );
                return;
            }
            reject(new Error(`${providerName} provider could not start \`${invocation.command}\`: ${error.message}`));
        });
        child.on('exit', (code) => {
            exitCode = code;
            exited = true;
            clearTimeout(killTimer);
            restartDrain();
        });
        child.on('close', (code) => settle(code));
    });
}

// ---------------------------------------------------------------------------
// 单引擎执行（API 直接调；CLI 走 buildInvocation + parseOutput）
// ---------------------------------------------------------------------------

async function runProvider(provider, model, options, resolvedInput, timeoutMs, settings, warnings, apiKeySecrets = []) {
    if (settings.extraBody && !provider.execute) {
        warnings.push(`${provider.name} is a CLI provider and takes no request body, so extraBody was ignored for this run.`);
    }
    const providerOptions = {
        imageSource: resolvedInput.source,
        imageKind: resolvedInput.kind,
        model,
        extraPrompt: options.prompt,
        providerBin: options.providerBin,
        workdir: options.workdir,
        timeoutMs,
        settings,
        apiKeySecrets,
    };
    let parsed;
    if (provider.execute) {
        parsed = await provider.execute(providerOptions);
    } else if (provider.buildInvocation && provider.parseOutput) {
        const { buildInvocation, parseOutput } = provider;
        const isolation = !options.workdir && provider.isolateWorkdir
            ? resolvedInput.kind === 'local'
                ? await isolateImage(resolvedInput.source)
                : emptyWorkdir()
            : null;
        try {
            const invocation = buildInvocation({
                ...providerOptions,
                imageSource: isolation?.imageSource ?? providerOptions.imageSource,
                workdir: isolation?.workdir ?? providerOptions.workdir,
            });
            const backstop = provider.hasInternalTimeout ? timeoutMs + KILL_GRACE_MS : timeoutMs;
            const commandResult = await runCommand(provider.name, invocation, backstop, provider.describeFailure);
            parsed = parseOutput(commandResult.stdout);
        } finally {
            await isolation?.cleanup();
        }
    } else {
        throw new Error(`Provider ${provider.name} implements neither execute nor buildInvocation.`);
    }
    parsed.result = normalizeVisionResult(parsed.result);
    const missing = missingSchemaFields(parsed.result);
    if (missing.length > 0) {
        throw new Error(`${provider.name} returned a result that does not match the vision schema (wrong or missing: ${missing.join(', ')}).`);
    }
    return parsed;
}

// ---------------------------------------------------------------------------
// 链组装（自动链 + 复用引擎 + 冷却重排）
// ---------------------------------------------------------------------------

const INLINE_REGION = new Set(['gemini-api', 'openai', 'anthropic']);

export function composeChain(kind, config, autoOptions, cooldown) {
    const chain = [...providerChain(kind, config, autoOptions?.env ?? process.env)];
    const borrowed = reuseProviders(kind, config, autoOptions);
    let preferredName = null;
    if (config.provider?.trim()) {
        try {
            preferredName = resolveProvider(config.provider.trim()).name;
        } catch {
            preferredName = null;
        }
    }
    if (borrowed.inline.length > 0) {
        const lastInline = chain.map((p) => INLINE_REGION.has(p.name)).lastIndexOf(true);
        const insertAt = lastInline >= 0 ? lastInline + 1 : kind === 'local' && preferredName === chain[0]?.name ? 1 : 0;
        chain.splice(insertAt, 0, ...borrowed.inline);
    }
    if (borrowed.agents.length > 0) {
        const last = chain[chain.length - 1];
        const beforeClaude = last?.name === 'claude-cli' && preferredName !== 'claude-cli';
        chain.splice(beforeClaude ? chain.length - 1 : chain.length, 0, ...borrowed.agents);
    }
    if (!cooldown) {
        return chain;
    }
    return reorderByCooldown(chain, cooldown, config, autoOptions?.env ?? process.env);
}

export function reorderByCooldown(chain, cooldown, config, env) {
    const tagged = chain.map((provider) => {
        const keyCount = splitApiKeys(resolveProviderSettings(provider.name, config, env).apiKey).length;
        return {
            provider,
            inline: !provider.isolateWorkdir,
            cooling: Boolean(coolingEngineEntry(cooldown.state, provider.name, keyCount, cooldown.now)),
        };
    });
    const healthyThenCooling = (items) => [...items.filter((item) => !item.cooling), ...items.filter((item) => item.cooling)];
    const inline = healthyThenCooling(tagged.filter((item) => item.inline));
    const agents = healthyThenCooling(tagged.filter((item) => !item.inline));
    const lead = tagged[0];
    if (lead && !lead.inline && !lead.cooling) {
        const restAgents = agents.filter((item) => item.provider.name !== lead.provider.name);
        return [lead.provider, ...inline.map((item) => item.provider), ...restAgents.map((item) => item.provider)];
    }
    return [...inline.map((item) => item.provider), ...agents.map((item) => item.provider)];
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

export async function analyzeImage(options) {
    const resolvedInput = resolveInput(options.input);
    if (resolvedInput.kind === 'local') {
        validateInputFile(resolvedInput.source);
    }
    const config = options.config ?? loadConfigFile();
    assertReadableConfig(config);
    const controller = options.cooldown;
    const chain = options.provider
        ? [resolveProvider(options.provider)]
        : options.providerBin
          ? [resolveProvider('antigravity-cli')]
          : composeChain(resolvedInput.kind, config, options.autoOptions, controller);
    const named = options.provider ?? config.provider?.trim();
    if (named) {
        try {
            const canonical = resolveProvider(named).name;
            assertNoRetiredEndpointBinding(canonical, resolveProviderSettings(canonical, config));
        } catch (error) {
            if (error instanceof Error && error.message.includes('takes its settings from one place')) {
                throw error;
            }
        }
    }
    if (chain.length === 0) {
        throw new Error(
            'No vision provider is set up on this machine. Install Antigravity CLI (curl -fsSL https://antigravity.google/cli/install.sh | bash, then run agy once to sign in), or configure a key: visionforge config set gemini-api.apiKey <key>. Run visionforge doctor for the full picture.' +
                reuseHint(config, options.autoOptions),
        );
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const attempts = [];
    const warnings = [];
    if (controller && !options.provider && !options.providerBin) {
        for (const provider of chain) {
            const keyCount = splitApiKeys(resolveProviderSettings(provider.name, config).apiKey).length;
            const entry = coolingEngineEntry(controller.state, provider.name, keyCount, controller.now);
            if (entry) {
                warnings.push(`The ${provider.name} provider is cooling until ${entry.until}, so it moves to the back of the fallback chain.`);
            }
        }
    }
    let lastError;
    for (const provider of chain) {
        const configured = resolveProviderSettings(provider.name, config);
        const settingsBase = options.extraBody ? { ...configured, extraBody: options.extraBody } : configured;
        const firstProvider = attempts.every((attempt) => attempt.provider === provider.name);
        const model = (firstProvider ? options.model : undefined) || settingsBase.visionModel || provider.visionDefaultModel || settingsBase.model || provider.defaultModel;
        const apiKeys = splitApiKeys(settingsBase.apiKey);
        const configuredKeyRuns =
            apiKeys.length > 0 ? apiKeys.map((apiKey, keyIndex) => ({ apiKey, keyIndex })) : [{ apiKey: undefined, keyIndex: undefined }];
        const keyRuns = controller
            ? [
                  ...configuredKeyRuns.filter(
                      (run) => run.keyIndex === undefined || !coolingEntry(controller.state, provider.name, controller.now, run.keyIndex),
                  ),
                  ...configuredKeyRuns.filter(
                      (run) => run.keyIndex !== undefined && coolingEntry(controller.state, provider.name, controller.now, run.keyIndex),
                  ),
              ]
            : configuredKeyRuns;
        let parsed;
        let successfulStartedAt = 0;
        let successfulKeyIndex;
        for (let runIndex = 0; runIndex < keyRuns.length; runIndex += 1) {
            const keyRun = keyRuns[runIndex];
            const startedAt = Date.now();
            try {
                parsed = await runProvider(provider, model, options, resolvedInput, timeoutMs, { ...settingsBase, apiKey: keyRun.apiKey }, warnings, apiKeys);
                successfulStartedAt = startedAt;
                successfulKeyIndex = keyRun.keyIndex;
                break;
            } catch (error) {
                const message = redactSecrets(error instanceof Error ? error.message : String(error), apiKeys);
                if (error instanceof Error) {
                    setErrorMessage(error, message);
                }
                lastError = error;
                attempts.push({
                    provider: provider.name,
                    ...(apiKeys.length > 1 ? { keyIndex: keyRun.keyIndex } : {}),
                    ok: false,
                    durationSeconds: (Date.now() - startedAt) / 1000,
                    error: message.slice(0, 300),
                });
                if (controller) {
                    const entry = controller.record(provider.name, error, keyRun.keyIndex, apiKeys);
                    if (entry) {
                        const keyNote = keyRun.keyIndex === undefined ? '' : ` API key ${keyRun.keyIndex + 1}`;
                        warnings.push(`The ${provider.name} provider${keyNote} hit its quota and is now cooling until ${entry.until}.`);
                    }
                }
                const hasNextKey = runIndex + 1 < keyRuns.length;
                if (hasNextKey && isApiKeyFailure(error)) {
                    continue;
                }
                break;
            }
        }
        if (!parsed) {
            continue;
        }
        attempts.push({
            provider: provider.name,
            ...(apiKeys.length > 1 ? { keyIndex: successfulKeyIndex } : {}),
            ok: true,
            durationSeconds: (Date.now() - successfulStartedAt) / 1000,
        });
        controller?.clear(provider.name, successfulKeyIndex);
        if (provider.reuseNote) {
            warnings.push(provider.reuseNote);
        }
        warnings.push(...(controller?.warnings ?? []));
        const failed = attempts.filter((attempt) => !attempt.ok);
        if (failed.length > 0) {
            const rotatedWithinProvider = failed.every((attempt) => attempt.provider === provider.name) && successfulKeyIndex !== undefined;
            if (rotatedWithinProvider && successfulKeyIndex !== undefined) {
                warnings.push(
                    `Rotated to ${provider.name} API key ${successfulKeyIndex + 1} after: ${failed
                        .map((attempt) => `${attempt.provider}${attempt.keyIndex === undefined ? '' : ` (API key ${attempt.keyIndex + 1})`}: ${attempt.error}`)
                        .join(' | ')}`,
                );
            } else {
                warnings.push(
                    `Failed over to ${provider.name} after: ${failed.map((attempt) => `${attempt.provider} (${attempt.error})`).join('; ')}.`,
                );
                if (options.model) {
                    warnings.push(`The explicit model applied to ${failed[0].provider} only; ${provider.name} ran its own default.`);
                }
            }
        }
        return {
            image: resolvedInput.source,
            provider: provider.name,
            result: parsed.result,
            meta: {
                generatedAt: new Date().toISOString(),
                // 空字符串表示引擎没告诉我们它跑的是哪个模型（kimi-cli），
                // 字段写 null 而不是点名一个不存在的名字。
                model: model === '' ? null : model,
                conversationId: parsed.meta.conversationId,
                durationSeconds: parsed.meta.durationSeconds,
                usage: parsed.meta.usage,
                attempts,
                warnings,
            },
        };
    }
    if (chain.length === 1) {
        if (!options.provider && !options.providerBin && lastError instanceof Error) {
            const hint = reuseHint(config, options.autoOptions);
            if (hint) {
                lastError.message += hint;
            }
        }
        throw lastError;
    }
    throw new Error(
        `Every configured vision provider failed for this image. ${attempts.map((attempt) => `${attempt.provider}: ${attempt.error}`).join(' | ')}${reuseHint(config, options.autoOptions)}`,
    );
}
