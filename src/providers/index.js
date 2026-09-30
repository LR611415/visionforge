// providers/index.js — 引擎注册表、别名解析与故障切换链
//
// 链语义（保持）：
//  - 本地图优先顺序 gemini-api → openai → qwen → anthropic →
//    antigravity-cli → claude-cli；远程图去掉 claude-cli（只读本地）。
//  - kimi-cli 只可被 -p 钉死，绝不进自动链。
//  - config.provider 钉死时：本地图或非 agent 型优先移到链首；
//    agent 型（隔离工作目录的 CLI）在远程图上不前置。
//  - reuse.claude === false 时 claude-cli 移出链。
//  - 只有"可用"（API 键/地址齐备或 CLI 在 PATH）的引擎才进链。
//
// P3 动态化：REGISTRY 仍为内置；自定义引擎（customProviders，见
// src/custom-providers.js）在传入 config 时动态并入 listProviders /
// resolveProvider / providerChain —— 因此自定义引擎自动获得 failover、
// cooldown、多 key 轮换等全部既有机制。不传 config 时行为与旧版完全一致。

import * as fs from 'fs';
import * as path from 'path';

import { resolveProviderSettings } from '../config-resolve.js';
import { isCustomProviderName, readCustomProviders } from '../custom-providers.js';
import { splitApiKeys } from '../util.js';
import { foldProviderName, providerAliases } from './aliases.js';
import { anthropicApiProvider } from './anthropic.js';
import { antigravityCliProvider } from './antigravity.js';
import { claudeCliProvider } from './claude-cli.js';
import { createCustomProvider } from './custom.js';
import { geminiApiProvider } from './gemini.js';
import { kimiCliProvider } from './kimi-cli.js';
import { openAiProvider } from './openai.js';
import { qwenProvider } from './qwen.js';

export { foldProviderName, providerAliases } from './aliases.js';

const REGISTRY = [
    anthropicApiProvider,
    antigravityCliProvider,
    claudeCliProvider,
    geminiApiProvider,
    kimiCliProvider,
    openAiProvider,
    qwenProvider,
];

/** 全部标准引擎名（内置按注册顺序，自定义按配置顺序）。 */
export function listProviders(config) {
    const builtin = REGISTRY.map((provider) => provider.name);
    const customs = Object.keys(readCustomProviders(config ?? {}));
    return customs.length > 0 ? [...builtin, ...customs] : builtin;
}

/** 标准名 → 描述符，供 doctor 渲染安装/修复指引。 */
export const PROVIDER_DESCRIPTORS = [
    {
        name: 'antigravity-cli',
        kind: 'subprocess',
        bin: 'agy',
        install: 'curl -fsSL https://antigravity.google/cli/install.sh | bash && agy   # sign in, then exit',
    },
    {
        name: 'gemini-api',
        kind: 'api',
        required: [{ field: 'apiKey' }],
        fix: 'visionforge config set gemini-api.apiKey   # hidden prompt; free key: https://aistudio.google.com',
    },
    {
        name: 'openai',
        kind: 'api',
        required: [{ field: 'baseUrl' }, { field: 'apiKey' }, { field: 'model' }],
        fix: 'visionforge config set openai.baseUrl <url> / openai.apiKey (hidden prompt) / openai.model <name>',
    },
    {
        name: 'qwen',
        kind: 'api',
        required: [{ field: 'apiKey' }],
        fix: 'visionforge config set qwen.apiKey <key>   # hidden prompt; free key: https://bailian.console.aliyun.com/ (阿里云百炼)',
    },
    {
        name: 'anthropic',
        kind: 'api',
        required: [{ field: 'apiKey' }],
        fix: 'visionforge config set anthropic.apiKey   # hidden prompt',
    },
    {
        name: 'claude-cli',
        kind: 'subprocess',
        bin: 'claude',
        install: 'install the Claude Code CLI, then run `claude` once to sign in',
    },
    {
        name: 'kimi-cli',
        kind: 'subprocess',
        bin: 'kimi',
        install: 'https://moonshotai.github.io/kimi-code/ (then run `kimi` and /login)',
    },
];

const PROVIDER_ALIASES_SOURCE = providerAliases();

/** 解析引擎名（别名兼容、自定义引擎兼容）；找不到抛出带可用列表的错误。 */
export function resolveProvider(name, config) {
    const canonical = foldProviderName(String(name).trim().toLowerCase());
    const found = REGISTRY.find((provider) => provider.name === canonical);
    if (found) {
        return found;
    }
    if (config && isCustomProviderName(canonical, config)) {
        return createCustomProvider(readCustomProviders(config)[canonical]);
    }
    throw new Error(
        `Unknown provider: ${name}. Use one of ${listProviders(config).join(', ')} (aliases like ${Object.keys(PROVIDER_ALIASES_SOURCE)
            .filter((alias) => PROVIDER_ALIASES_SOURCE[alias] !== alias)
            .slice(0, 4)
            .join(', ')} work too).`,
    );
}

// ---------------------------------------------------------------------------
// 可用性与链
// ---------------------------------------------------------------------------

function envValue(env, key) {
    const value = env[key];
    return typeof value === 'string' ? value : '';
}

export function findOnPath(bin, env) {
    const dirs = envValue(env, 'PATH')
        .split(path.delimiter)
        .filter(Boolean);
    const suffixes =
        process.platform === 'win32'
            ? [...envValue(env, 'PATHEXT').split(';').filter(Boolean), '']
            : [''];
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

/** 自定义引擎的可用性：apiKey + baseUrl 齐备。 */
function customProviderAvailable(entry) {
    return splitApiKeys(entry.apiKey).length > 0 && Boolean(entry.baseUrl?.trim());
}

export function providerAvailable(name, config, env = process.env) {
    const descriptor = PROVIDER_DESCRIPTORS.find((d) => d.name === name);
    if (!descriptor) {
        const entry = readCustomProviders(config ?? {})[name];
        return entry ? customProviderAvailable(entry) : false;
    }
    if (descriptor.kind === 'subprocess') {
        return findOnPath(descriptor.bin, env) !== null;
    }
    const settings = resolveProviderSettings(name, config, env);
    return (descriptor.required ?? []).every((req) =>
        req.field === 'apiKey' ? splitApiKeys(settings.apiKey).length > 0 : Boolean(settings[req.field]?.trim()),
    );
}

export const LOCAL_FAILOVER_ORDER = ['gemini-api', 'openai', 'qwen', 'anthropic', 'antigravity-cli', 'claude-cli'];
export const PIN_ONLY_PROVIDERS = ['kimi-cli'];
export const REMOTE_FAILOVER_ORDER = ['gemini-api', 'openai', 'qwen', 'anthropic', 'antigravity-cli'];

/** 按图源类型构造自动链：可用性过滤 + 钉死优先 + 自定义引擎兜底。 */
export function providerChain(kind, config, env = process.env) {
    let names = [...(kind === 'remote' ? REMOTE_FAILOVER_ORDER : LOCAL_FAILOVER_ORDER)];
    if (config.reuse?.claude === false) {
        names = names.filter((name) => name !== 'claude-cli');
    }
    const preferred = config.provider?.trim();
    if (preferred) {
        let canonical = null;
        try {
            canonical = resolveProvider(preferred, config).name;
        } catch {
            canonical = null;
        }
        const index = canonical ? names.indexOf(canonical) : -1;
        if (index > 0 && canonical) {
            const isAgent = Boolean(resolveProvider(canonical, config).isolateWorkdir);
            if (kind === 'local' || !isAgent) {
                names.splice(index, 1);
                names.unshift(canonical);
            }
        } else if (index === -1 && canonical) {
            if (PIN_ONLY_PROVIDERS.includes(canonical)) {
                if (kind === 'local') {
                    names.unshift(canonical);
                }
            } else {
                // 自定义引擎：钉死时前置到链首（可用性检查后仍可能被过滤）
                names.unshift(canonical);
            }
        }
    }
    // 自定义引擎兜底：可用性过滤后追加到链尾
    const customs = Object.keys(readCustomProviders(config ?? {}));
    for (const customName of customs) {
        if (!names.includes(customName) && providerAvailable(customName, config, env)) {
            names.push(customName);
        }
    }
    return names.filter((name) => providerAvailable(name, config, env)).map((name) => resolveProvider(name, config));
}
