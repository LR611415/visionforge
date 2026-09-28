// reuse.js — 复用本机其他 agent CLI 的登录态读图
//
// 复用语义（保持）：
//  - 只有用户明确授权（config.reuse.<harness> === true）才复用；
//    授权缺失 = 从未问过，什么都不跑。
//  - pi 的 API-key 型凭据转成 inline 路由（同引擎自己的配额等级），
//    其余降级为 agent CLI 路由；codex/opencode/grok 走 agent 路由。
//  - 探测结果缓存到 ~/.visionforge/auto-cache.json（6 小时 TTL）。
//  - 所有复用答案都在 meta.warnings 里注明花的是谁的额度。

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { JSON_TEMPLATE_INSTRUCTION, buildVisionPrompt, visionResultSchemaJson } from './schema.js';
import { execFileSyncHidden, resolveSpawnPlan } from './shim.js';
import { extractJson, parseJsonLoose, redactSecrets, truncate, tryParseJson } from './util.js';
import { globMatch } from './guard.js';
import { anthropicApiProvider } from './providers/anthropic.js';
import { geminiApiProvider } from './providers/gemini.js';
import { openAiProvider } from './providers/openai.js';

const VISION_MODEL_PATTERNS = [
    'claude-*',
    'gpt-4o*',
    'gpt-4.1*',
    'gpt-5*',
    'o3*',
    'o4*',
    'gemini-*',
    'glm-*v*',
    // GLM-5.3-Flash（2026-08-26）：GLM-5 线首个原生多模态。
    // 名字不带 v，glm-*v* 抓不到它。匹配完整 slug 或带分隔符的后缀
    // （:free、-air）；glm-5.3-flashlight 这种连写不是同一个模型。
    // GLM-5.3 本体仍是纯文本。
    'glm-5.3-flash',
    'glm-5.3-flash-*',
    'glm-5.3-flash:*',
    'qwen*-vl*',
    'qwen3.5-plus*',
    'qwen3.6-plus*',
    'qwen3.7-plus*',
    'qwen3.7-flash*',
    'qwen3.8-max*',
    'kimi-k2.5*',
    'kimi-k2.6*',
    'kimi-k2.7*',
    'kimi-k3*',
    'moonshot-v1-*vision*',
    'minimax-vl*',
    'minimax-m3*',
    // mimo-v2.5 的 pro 档是纯文本，所以免费/基础档按全名精确匹配。
    '*mimo-v2.5',
    '*mimo-v2.5-free',
    'mimo-v2-omni*',
    'deepseek-vl*',
    'deepseek-ocr*',
    // DeepSeek V4 视觉端点（2026-08-21）：文档按 vision 一词命名，
    // 通配符覆盖 exp 档及其后继。
    'deepseek-*vision*',
    'janus*',
    'pixtral*',
    'llama-4*',
    'llama-3.2-*vision*',
    'grok-4*',
    'grok-2-vision*',
    'internvl*',
];

export function isVisionModel(modelId) {
    const unaliased = modelId.replace(/^~/, '');
    const bare = unaliased.includes('/') ? unaliased.slice(unaliased.lastIndexOf('/') + 1) : unaliased;
    return VISION_MODEL_PATTERNS.some((pattern) => globMatch(pattern, bare));
}

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const CLI_TIMEOUT_MS = 10_000;
const KEY_FETCH_TIMEOUT_MS = 10_000;

function defaultRunCli(bin, args, timeoutMs) {
    const plan = resolveSpawnPlan(bin, args);
    return execFileSyncHidden(plan.command, plan.args, {
        encoding: 'utf-8',
        timeout: timeoutMs,
        stdio: 'pipe',
        // 被识别的 shim 会交回其子进程的整套环境，探测就在 shell
        // 本会给它的环境里跑，而不是在我们这里跑。
        ...(plan.env ? { env: plan.env } : {}),
    });
}

function timed(run) {
    const start = Date.now();
    const probe = run();
    return { ...probe, elapsedMs: Date.now() - start };
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function findOnPath(bin, env) {
    const dirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
    const suffixes = process.platform === 'win32' ? [...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean), ''] : [''];
    for (const dir of dirs) {
        for (const suffix of suffixes) {
            const full = path.join(dir, bin + suffix);
            try {
                if (fs.statSync(full).isFile()) {
                    return full;
                }
            } catch {
            }
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// 逐 harness 探测
// ---------------------------------------------------------------------------

function probeClaude(env) {
    return timed(() => {
        const cliPath = findOnPath('claude', env);
        if (!cliPath) {
            return { harness: 'claude-code', cliFound: false, visionModels: [], source: 'none' };
        }
        return {
            harness: 'claude-code',
            cliFound: true,
            cliPath,
            visionModels: ['anthropic/* (all current models)'],
            source: 'builtin-table',
        };
    });
}

function probeCodex(env, home) {
    return timed(() => {
        const cliPath = findOnPath('codex', env);
        const base = { harness: 'codex', cliFound: cliPath !== null };
        if (!cliPath) {
            return { ...base, visionModels: [], source: 'none' };
        }
        const codexHome = path.join(home, '.codex');
        const loggedIn = fs.existsSync(path.join(codexHome, 'auth.json'));
        if (!fs.existsSync(path.join(codexHome, 'config.toml'))) {
            return { ...base, cliPath, loggedIn, visionModels: ['default'], source: 'builtin-table' };
        }
        try {
            const toml = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf-8');
            const catalogPath = toml.match(/^model_catalog_json\s*=\s*"([^"]+)"/m)?.[1];
            const thirdParty = /^model_provider\s*=/m.test(toml);
            if (!catalogPath) {
                return thirdParty
                    ? { ...base, cliPath, loggedIn, visionModels: [], source: 'none' }
                    : { ...base, cliPath, loggedIn, visionModels: ['default'], source: 'builtin-table' };
            }
            const catalog = readJson(catalogPath);
            const vision = (catalog.models ?? [])
                .filter((m) => m.slug && (m.input_modalities ?? []).includes('image'))
                .map((m) => m.slug);
            return { ...base, cliPath, loggedIn, visionModels: vision, source: 'metadata' };
        } catch (error) {
            return {
                ...base,
                cliPath,
                loggedIn,
                visionModels: [],
                source: 'none',
                error: redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 200),
            };
        }
    });
}

function probeGrok(env, home) {
    return timed(() => {
        const cliPath = findOnPath('grok', env);
        const base = { harness: 'grok', cliFound: cliPath !== null };
        if (!cliPath) {
            return { ...base, visionModels: [], source: 'none' };
        }
        const grokHome = path.join(home, '.grok');
        let loggedIn = false;
        try {
            const auth = readJson(path.join(grokHome, 'auth.json'));
            loggedIn = Object.keys(auth).length > 0;
        } catch {
        }
        try {
            const cache = readJson(path.join(grokHome, 'models_cache.json'));
            const vision = Object.keys(cache.models ?? {}).filter((id) => isVisionModel(id));
            return { ...base, cliPath, loggedIn, visionModels: vision.length > 0 ? vision : ['default'], source: 'builtin-table' };
        } catch {
            return { ...base, cliPath, loggedIn, visionModels: ['default'], source: 'builtin-table' };
        }
    });
}

function probePi(env, home) {
    return timed(() => {
        const cliPath = findOnPath('pi', env);
        const base = { harness: 'pi', cliFound: cliPath !== null };
        if (!cliPath) {
            return { ...base, visionModels: [], source: 'none' };
        }
        const agentDir = path.join(home, '.pi', 'agent');
        try {
            const auth = readJson(path.join(agentDir, 'auth.json'));
            const providersWithCreds = new Set(Object.keys(auth));
            const store = readJson(path.join(agentDir, 'models-store.json'));
            const vision = [];
            for (const entry of Object.values(store)) {
                for (const model of entry?.models ?? []) {
                    if (model.id && (model.input ?? []).includes('image') && model.provider && providersWithCreds.has(model.provider)) {
                        vision.push(model.id);
                    }
                }
            }
            return { ...base, cliPath, loggedIn: providersWithCreds.size > 0, visionModels: vision, source: 'metadata' };
        } catch (error) {
            return {
                ...base,
                cliPath,
                visionModels: [],
                source: 'none',
                error: redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 200),
            };
        }
    });
}

function probeOpencode(env, runCli) {
    return timed(() => {
        const cliPath = findOnPath('opencode', env);
        const base = { harness: 'opencode', cliFound: cliPath !== null };
        if (!cliPath) {
            return { ...base, visionModels: [], source: 'none' };
        }
        try {
            const listing = runCli(cliPath, ['models'], CLI_TIMEOUT_MS);
            const vision = listing
                .split('\n')
                .map((line) => line.trim())
                .filter((line) => line.length > 0 && isVisionModel(line));
            return { ...base, cliPath, visionModels: vision, source: 'builtin-table' };
        } catch (error) {
            return {
                ...base,
                cliPath,
                visionModels: [],
                source: 'none',
                error: redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 200),
            };
        }
    });
}

// ---------------------------------------------------------------------------
// discoverAuto（带 6 小时缓存）
// ---------------------------------------------------------------------------

function readCache(cachePath, ttlMs) {
    try {
        const cached = readJson(cachePath);
        if (!cached.cachedAt || !Array.isArray(cached.probes)) {
            return null;
        }
        const cachedAtMs = Date.parse(cached.cachedAt);
        if (!Number.isFinite(cachedAtMs) || Date.now() - cachedAtMs > ttlMs) {
            return null;
        }
        return cached;
    } catch {
        return null;
    }
}

export function discoverAuto(options = {}) {
    const env = options.env ?? process.env;
    const home = options.home ?? os.homedir();
    const cachePath = options.cachePath ?? path.join(home, '.visionforge', 'auto-cache.json');
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    if (!options.fresh) {
        const cached = readCache(cachePath, ttlMs);
        if (cached) {
            return { probes: cached.probes, cachedAt: cached.cachedAt, fromCache: true };
        }
    }
    const runCli = options.runCli ?? defaultRunCli;
    const probes = [probeClaude(env), probeCodex(env, home), probeOpencode(env, runCli), probePi(env, home), probeGrok(env, home)];
    const cachedAt = new Date().toISOString();
    try {
        fs.mkdirSync(path.dirname(cachePath), { recursive: true });
        fs.writeFileSync(cachePath, JSON.stringify({ cachedAt, probes }, null, 2), { mode: 0o600 });
    } catch {
    }
    return { probes, cachedAt, fromCache: false };
}

// ---------------------------------------------------------------------------
// agent 路由（codex / opencode / grok / pi 降级）
// ---------------------------------------------------------------------------

function codexCliRoute(visionModel) {
    return {
        name: 'codex-cli',
        defaultModel: visionModel,
        isolateWorkdir: true,
        reuseNote: 'this read reused the local Codex CLI login and spent that account\'s quota.',
        buildInvocation: (options) => {
            if (options.imageKind === 'remote') {
                throw new Error('codex-cli route reads local files only. Remote URLs stay on the inline providers.');
            }
            const prompt = `${buildVisionPrompt({
                imageSource: options.imageSource,
                imageKind: 'inline',
                extraPrompt: options.extraPrompt,
            })}

${JSON_TEMPLATE_INSTRUCTION}`;
            const model = options.model || visionModel;
            const args = ['exec', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', '--json', '-i', options.imageSource];
            if (model && model !== 'default') {
                args.push('-m', model);
            }
            args.push('--', prompt);
            return {
                command: options.providerBin || 'codex',
                args,
                cwd: path.resolve(options.workdir || path.dirname(options.imageSource)),
            };
        },
        parseOutput: (stdout) => {
            let threadId = null;
            let usage = null;
            let lastMessage = null;
            for (const line of stdout.split('\n')) {
                const event = tryParseJson(line.trim());
                if (!event) {
                    continue;
                }
                if (event.type === 'thread.started' && event.thread_id) {
                    threadId = event.thread_id;
                }
                if (event.type === 'turn.completed' && event.usage !== undefined) {
                    usage = event.usage;
                }
                if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
                    lastMessage = event.item.text;
                }
            }
            if (!lastMessage) {
                throw new Error('codex exec produced no agent message. Check the Codex login (run: codex).');
            }
            const result = extractJson(lastMessage);
            if (result === null) {
                throw new Error(`codex returned a non-JSON answer: ${truncate(lastMessage)}`);
            }
            return { result, meta: { conversationId: threadId, durationSeconds: null, usage } };
        },
    };
}

function opencodeCliRoute(modelId) {
    return {
        name: 'opencode-cli',
        defaultModel: modelId,
        isolateWorkdir: true,
        reuseNote: `this read reused OpenCode's ${modelId} and spent that account's quota.`,
        buildInvocation: (options) => {
            if (options.imageKind === 'remote') {
                throw new Error('opencode-cli route reads local files only. Remote URLs stay on the inline providers.');
            }
            const prompt = `${buildVisionPrompt({
                imageSource: options.imageSource,
                imageKind: 'inline',
                extraPrompt: options.extraPrompt,
            })}

${JSON_TEMPLATE_INSTRUCTION}`;
            return {
                command: options.providerBin || 'opencode',
                args: ['run', prompt, '-m', options.model || modelId, '--format', 'json', '-f', options.imageSource],
                cwd: path.resolve(options.workdir || path.dirname(options.imageSource)),
            };
        },
        parseOutput: (stdout) => {
            let sessionId = null;
            let usage = null;
            const texts = [];
            for (const line of stdout.split('\n')) {
                const event = tryParseJson(line.trim());
                if (!event) {
                    continue;
                }
                sessionId ??= event.sessionID ?? null;
                if (event.type === 'text' && typeof event.part?.text === 'string') {
                    texts.push(event.part.text);
                }
                if (event.type === 'step_finish' && event.part?.tokens !== undefined) {
                    usage = event.part.tokens;
                }
            }
            const answer = texts.join('').trim();
            if (!answer) {
                throw new Error('opencode run produced no text answer.');
            }
            const result = extractJson(answer);
            if (result === null) {
                throw new Error(`opencode returned a non-JSON answer: ${truncate(answer)}`);
            }
            return { result, meta: { conversationId: sessionId, durationSeconds: null, usage } };
        },
    };
}

function grokCliRoute(modelId) {
    return {
        name: 'grok-cli',
        defaultModel: modelId,
        isolateWorkdir: true,
        reuseNote: 'this read reused the local Grok CLI login and spent that account\'s quota.',
        buildInvocation: (options) => {
            if (options.imageKind === 'remote') {
                throw new Error('grok-cli route reads local files only. Remote URLs stay on the inline providers.');
            }
            const prompt = buildVisionPrompt({ imageSource: options.imageSource, imageKind: 'local', extraPrompt: options.extraPrompt });
            const args = ['-p', prompt, '--output-format', 'json', '--json-schema', visionResultSchemaJson(), '--allow', 'Read'];
            const model = options.model || modelId;
            if (model && model !== 'default') {
                args.push('-m', model);
            }
            return {
                command: options.providerBin || 'grok',
                args,
                cwd: path.resolve(options.workdir || path.dirname(options.imageSource)),
            };
        },
        parseOutput: (stdout) => {
            const envelope = parseJsonLoose(stdout);
            if (!envelope || typeof envelope !== 'object') {
                throw new Error('grok produced no JSON envelope. Check the Grok login (run: grok).');
            }
            const result = envelope.structuredOutput ?? (typeof envelope.text === 'string' ? extractJson(envelope.text) : null);
            if (result === null || result === undefined) {
                throw new Error(`grok returned no structured output: ${truncate(envelope.text ?? '')}`);
            }
            return { result, meta: { conversationId: envelope.sessionId ?? null, durationSeconds: null, usage: envelope.usage ?? null } };
        },
    };
}

function piCliRoute(providerName, modelId) {
    return {
        name: 'pi-cli',
        defaultModel: modelId,
        isolateWorkdir: true,
        reuseNote: `this read reused pi's ${providerName}/${modelId} and spent that account's quota.`,
        buildInvocation: (options) => {
            if (options.imageKind === 'remote') {
                throw new Error('pi-cli route reads local files only. Remote URLs stay on the inline providers.');
            }
            const prompt = `${buildVisionPrompt({
                imageSource: options.imageSource,
                imageKind: 'inline',
                extraPrompt: options.extraPrompt,
            })}

${JSON_TEMPLATE_INSTRUCTION}`;
            return {
                command: options.providerBin || 'pi',
                args: [
                    '-p',
                    '--no-session',
                    '--no-tools',
                    '--mode',
                    'json',
                    '--provider',
                    providerName,
                    '--model',
                    options.model || modelId,
                    `@${options.imageSource}`,
                    prompt,
                ],
                cwd: path.resolve(options.workdir || path.dirname(options.imageSource)),
            };
        },
        parseOutput: (stdout) => {
            let final = null;
            for (const line of stdout.split('\n')) {
                const event = tryParseJson(line.trim());
                if (event?.type === 'message_end' && event.message) {
                    final = event.message;
                }
            }
            const answer = (final?.content ?? [])
                .filter((part) => part.type === 'text' && typeof part.text === 'string')
                .map((part) => part.text)
                .join('')
                .trim();
            if (!answer) {
                throw new Error('pi produced no text answer. Check pi and its credentials.');
            }
            const result = extractJson(answer);
            if (result === null) {
                throw new Error(`pi returned a non-JSON answer: ${truncate(answer)}`);
            }
            return { result, meta: { conversationId: final?.responseId ?? null, durationSeconds: null, usage: final?.usage ?? null } };
        },
    };
}

// ---------------------------------------------------------------------------
// pi 凭据路由（API-key 型 → inline；其余 → agent）
// ---------------------------------------------------------------------------

const PI_API_TARGETS = {
    'openai-completions': 'openai',
    'anthropic-messages': 'anthropic',
};

const DEFAULT_TARGETS = {
    openai: openAiProvider,
    anthropic: anthropicApiProvider,
    'gemini-api': geminiApiProvider,
};

function fetchPiKey(piPath, modelId, provider, timeoutMs) {
    try {
        const plan = resolveSpawnPlan(piPath, ['auth', 'print-api-key', '--model', modelId, '--provider', provider]);
        const key = execFileSyncHidden(plan.command, plan.args, {
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: timeoutMs,
            ...(plan.env ? { env: plan.env } : {}),
        }).trim();
        if (!key) {
            throw new Error('empty');
        }
        return key;
    } catch {
        throw new Error(`pi could not print an API key for ${provider}/${modelId}. Run \`pi auth\` to check that credential.`);
    }
}

export function piRoutes(home, env, targets = DEFAULT_TARGETS) {
    const empty = { inline: [], agents: [] };
    const piPath = findOnPath('pi', env);
    if (!piPath) {
        return empty;
    }
    const agentDir = path.join(home, '.pi', 'agent');
    let auth;
    let store;
    try {
        auth = JSON.parse(fs.readFileSync(path.join(agentDir, 'auth.json'), 'utf-8'));
        store = JSON.parse(fs.readFileSync(path.join(agentDir, 'models-store.json'), 'utf-8'));
    } catch {
        return empty;
    }
    const routes = [];
    const agents = [];
    const usedTargets = new Set();
    for (const entry of Object.values(store)) {
        for (const model of entry?.models ?? []) {
            if (!model.id || !model.provider || !model.baseUrl || !(model.input ?? []).includes('image') || !(model.provider in auth)) {
                continue;
            }
            const credential = auth[model.provider];
            const targetName = PI_API_TARGETS[model.api ?? ''];
            const target = targetName ? targets[targetName] : undefined;
            const targetExecute = target?.execute;
            if (!target || !targetExecute || credential?.type !== 'api_key') {
                if (agents.length < 2) {
                    agents.push(piCliRoute(model.provider, model.id));
                }
                continue;
            }
            if (usedTargets.has(target.name)) {
                continue;
            }
            usedTargets.add(target.name);
            const { id, provider, baseUrl } = model;
            routes.push({
                name: `pi:${target.name}`,
                defaultModel: id,
                reuseNote: `this read reused pi's ${provider} credentials for ${id} and spent that account's quota.`,
                execute: async (options) => {
                    const apiKey = fetchPiKey(piPath, id, provider, Math.min(KEY_FETCH_TIMEOUT_MS, options.timeoutMs || KEY_FETCH_TIMEOUT_MS));
                    return targetExecute({
                        ...options,
                        settings: {
                            ...(options.settings ?? {}),
                            apiKey,
                            baseUrl,
                            model: options.model || id,
                        },
                    });
                },
            });
        }
    }
    return { inline: routes.slice(0, 2), agents };
}

export function reuseProviders(kind, config, options = {}) {
    const env = options.env ?? process.env;
    const home = options.home ?? os.homedir();
    const grants = config.reuse ?? {};
    const inline = [];
    const agents = [];
    let piAgents = [];
    if (grants.pi === true) {
        try {
            const pi = piRoutes(home, env, options.targets);
            inline.push(...pi.inline);
            piAgents = pi.agents;
        } catch {
        }
    }
    if (kind === 'local' && (grants.codex === true || grants.opencode === true || grants.grok === true)) {
        try {
            const discovery = options.discovery ?? discoverAuto({ env, home });
            const codex = discovery.probes.find((probe) => probe.harness === 'codex');
            if (grants.codex === true && codex?.cliFound && codex.loggedIn !== false && codex.visionModels[0]) {
                agents.push(codexCliRoute(codex.visionModels[0]));
            }
            const opencode = discovery.probes.find((probe) => probe.harness === 'opencode');
            if (grants.opencode === true && opencode?.cliFound && opencode.visionModels[0]) {
                agents.push(opencodeCliRoute(opencode.visionModels[0]));
            }
            const grok = discovery.probes.find((probe) => probe.harness === 'grok');
            if (grants.grok === true && grok?.cliFound && grok.loggedIn !== false && grok.visionModels[0]) {
                agents.push(grokCliRoute(grok.visionModels[0]));
            }
        } catch {
        }
    }
    if (kind === 'local') {
        agents.push(...piAgents);
    }
    return { inline, agents };
}

const REUSE_KEY_BY_HARNESS = {
    codex: 'codex',
    opencode: 'opencode',
    pi: 'pi',
    grok: 'grok',
};

export function reuseHint(config, autoOptions) {
    try {
        const grants = config.reuse ?? {};
        const discovery = autoOptions?.discovery ?? discoverAuto({ env: autoOptions?.env, home: autoOptions?.home });
        const unasked = [];
        const dead = [];
        for (const probe of discovery.probes) {
            const key = REUSE_KEY_BY_HARNESS[probe.harness];
            if (key === undefined) {
                continue;
            }
            const usable = probe.cliFound && probe.visionModels.length > 0 && probe.loggedIn !== false;
            if (grants[key] === undefined && usable) {
                unasked.push(probe.harness);
            } else if (grants[key] === true && !usable) {
                dead.push(probe.harness);
            }
        }
        const parts = [];
        if (unasked.length > 0) {
            parts.push(
                ` Hint: this machine has vision reachable through ${unasked.join(', ')}, which visionforge is not yet allowed to reuse. Ask the user, then: visionforge config set reuse.<harness> true.`,
            );
        }
        if (dead.length > 0) {
            parts.push(
                ` Note: reuse is granted for ${dead.join(', ')} but it is currently unusable (signed out, uninstalled, or no vision model); check that CLI's login.`,
            );
        }
        return parts.join('');
    } catch {
        return '';
    }
}
