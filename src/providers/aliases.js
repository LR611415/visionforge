// providers/aliases.js — 引擎名别名表（零依赖，避免 config ↔ providers 循环）
//
// 别名语义（保持）：任何非标准名折叠到标准名；未知名字原样返回，
// 由调用方决定报错还是忽略。doctor 与 config set 的错误提示会用到。

const PROVIDER_ALIASES = {
    antigravity: 'antigravity-cli',
    agy: 'antigravity-cli',
    'antigravity-cli': 'antigravity-cli',
    gemini: 'gemini-api',
    'gemini-api': 'gemini-api',
    'openai-compat': 'openai',
    openai: 'openai',
    claude: 'anthropic',
    anthropic: 'anthropic',
    'claude-code': 'claude-cli',
    'claude-cli': 'claude-cli',
    kimi: 'kimi-cli',
    'kimi-code': 'kimi-cli',
    'kimi-cli': 'kimi-cli',
    'qwen-vl': 'qwen',
    dashscope: 'qwen',
    qwen: 'qwen',
};

export function providerAliases() {
    return { ...PROVIDER_ALIASES };
}

/** 别名（或标准名）→ 标准名；未知名字原样返回。 */
export function foldProviderName(name) {
    return Object.hasOwn(PROVIDER_ALIASES, name) ? PROVIDER_ALIASES[name] : name;
}
