// config-resolve.js — provider 设置解析（单源原则）
//
// 与 config.js 分离是为了打破 providers/index.js ↔ config.js 的依赖环：
// 这里只做"某 provider 的生效设置是什么"的纯函数，不读写文件、
// 不注册命令，因此可被 providers 层与 config 层共同引用。
//
// 单源原则（保持）：配置文件里提到过某 provider 就以文件为准，
// 只字未提才读绑定的环境变量；文件内别名键也会被读取，
// 冲突时标准键胜出。

import { foldProviderName } from './providers/aliases.js';
import { isCustomProviderName, readCustomProviders } from './custom-providers.js';
import { isPlainObject, splitApiKeys } from './util.js';

/** provider → 环境变量绑定。qwen 用本插件的品牌变量名。 */
export const ENV_BINDINGS = {
    'gemini-api': { apiKey: 'GEMINI_API_KEY', baseUrl: 'GEMINI_BASE_URL' },
    openai: { apiKey: 'OPENAI_API_KEY', baseUrl: 'OPENAI_BASE_URL' },
    anthropic: { apiKey: 'ANTHROPIC_API_KEY', baseUrl: 'ANTHROPIC_BASE_URL' },
    qwen: { apiKey: 'VISIONFORGE_QWEN_API_KEY', baseUrl: 'VISIONFORGE_QWEN_BASE_URL' },
};

/** 文件里出现过该 provider 的任一拼写（标准名或别名）。 */
export function providerConfiguredInFile(providerName, config) {
    return fileKeysFor(providerName, config).length > 0;
}

/** 文件里该 provider 的所有键名（别名在前、标准名在后，后写覆盖先写）。 */
export function fileKeysFor(providerName, config) {
    return Object.keys(isPlainObject(config.providers) ? config.providers : {}).filter(
        (key) => foldProviderName(key) === providerName,
    );
}

export function fileSettingsFor(providerName, config) {
    const keys = fileKeysFor(providerName, config);
    const ordered = [...keys.filter((key) => key !== providerName), ...keys.filter((key) => key === providerName)];
    return Object.assign(
        {},
        ...ordered.map((key) => {
            const entry = config.providers?.[key];
            return isPlainObject(entry) ? entry : {};
        }),
    );
}

function envSettingsFor(providerName, env) {
    const settings = {};
    for (const [field, variable] of Object.entries(ENV_BINDINGS[providerName] ?? {})) {
        const value = env[variable]?.trim();
        const present = field === 'apiKey' ? splitApiKeys(value).length > 0 : Boolean(value);
        if (value && present) {
            settings[field] = value;
        }
    }
    return settings;
}

/** provider 的实际生效设置：文件（单源）或环境变量；顶层 proxy 兜底继承。 */
export function resolveProviderSettings(providerName, config, env = process.env) {
    // 自定义引擎：单源 = customProviders 段（不读环境变量，保证 key 只来自用户显式配置）
    if (isCustomProviderName(providerName, config)) {
        const entry = readCustomProviders(config)[providerName];
        const settings = { ...entry };
        if (!Object.hasOwn(settings, 'proxy') && typeof config.proxy === 'string' && config.proxy.trim()) {
            settings.proxy = config.proxy.trim();
        }
        return settings;
    }
    const mentioned = providerConfiguredInFile(providerName, config);
    const settings = mentioned ? { ...fileSettingsFor(providerName, config) } : envSettingsFor(providerName, env);
    if (!Object.hasOwn(settings, 'proxy') && typeof config.proxy === 'string' && config.proxy.trim()) {
        settings.proxy = config.proxy.trim();
    }
    return settings;
}
