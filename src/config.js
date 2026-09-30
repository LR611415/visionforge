// config.js — 配置读取 / 写入 / 展示
//
// 核心不变量（自 3.17.0 起的外部契约，保持）：
//  - 一个 provider 的设置整份来自单一来源：配置文件里提到过它，
//    就以文件为准；只字未提才读绑定的环境变量。
//  - apiKey 接受英文逗号分隔的 key 列表，请求按配置顺序轮换。
//  - 写文件权限 0600，目录 0700；损坏/缺失按"无状态"处理。
//  - saved.<openai>.<label> 是 openai 槽位的命名存档，save/use 整包换入。
//  - config show 对所有值做掩码，且只在值上打码、不动键名。

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { listProviders, providerAliases, resolveProvider } from './providers/index.js';
import { foldProviderName } from './providers/aliases.js';
import { ENV_BINDINGS, fileKeysFor, fileSettingsFor, providerConfiguredInFile, resolveProviderSettings } from './config-resolve.js';
import { isCustomProviderName, normalizeCustomProviderEntry, readCustomProviders } from './custom-providers.js';
import {
    isPlainObject,
    maskUrlCredentials,
    parseExtraBody,
    parseJsonOrExplain,
    redactSecrets,
    splitApiKeys,
} from './util.js';

export { ENV_BINDINGS, fileSettingsFor, providerConfiguredInFile, resolveProviderSettings } from './config-resolve.js';

export const CONFIG_DIR = path.join(os.homedir(), '.visionforge');
export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

export const REUSE_HARNESSES = ['claude', 'codex', 'opencode', 'pi', 'grok'];

const STRING_FIELDS = ['apiKey', 'baseUrl', 'model', 'visionModel', 'proxy'];

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

export const CONFIG_VERSION = 1;

/**
 * 配置损坏/结构异常时：把原文件备份为 <path>.bak-<时间戳>，避免用户配置直接丢失。
 * 返回备份路径（失败返回 null）。
 */
function backupBrokenConfig(configPath, kind) {
    try {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = `${configPath}.bak-${stamp}`;
        fs.copyFileSync(configPath, backupPath);
        return backupPath;
    } catch {
        return null;
    }
}

export function loadConfigFile(configPath = CONFIG_PATH) {
    let raw;
    try {
        raw = fs.readFileSync(configPath, 'utf-8');
    } catch (error) {
        if (error.code === 'ENOENT') {
            return {};
        }
        throw new Error(`Cannot read ${configPath}: ${error.message}. Fix the file or its permissions.`);
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        const backupPath = backupBrokenConfig(configPath, 'parse');
        throw new Error(
            `Failed to parse ${configPath}: ${error.message}. ` +
            `已自动备份损坏文件${backupPath ? `到 ${backupPath}` : '（备份失败）'}，插件将按全新配置运行，请重新填写配置。`,
        );
    }
    if (!parsed || typeof parsed !== 'object') {
        const backupPath = backupBrokenConfig(configPath, 'not-object');
        throw new Error(
            `${configPath} 不是合法的配置对象（值为 ${parsed === null ? 'null' : typeof parsed}）。` +
            `已自动备份到 ${backupPath ?? '（备份失败）'}，插件将按全新配置运行，请重新填写配置。`,
        );
    }
    // 顶层结构校验：类型异常视为损坏，备份后报错（上层按全新配置兜底），不静默忽略。
    const offences = [];
    if (parsed.providers !== undefined && !isPlainObject(parsed.providers)) offences.push('providers 应为对象');
    if (parsed.customProviders !== undefined && !isPlainObject(parsed.customProviders)) offences.push('customProviders 应为对象');
    if (parsed.provider !== undefined && typeof parsed.provider !== 'string') offences.push('provider 应为字符串');
    if (parsed.outputDir !== undefined && typeof parsed.outputDir !== 'string') offences.push('outputDir 应为字符串');
    if (parsed.pasteToPath !== undefined && typeof parsed.pasteToPath !== 'string' && typeof parsed.pasteToPath !== 'boolean') offences.push('pasteToPath 应为字符串或布尔值');
    if (offences.length > 0) {
        const backupPath = backupBrokenConfig(configPath, 'schema');
        throw new Error(
            `${configPath} 结构异常（${offences.join('、')}）。` +
            `已自动备份到 ${backupPath ?? '（备份失败）'}，插件将按全新配置运行，请重新填写配置。`,
        );
    }
    return parsed;
}

export function cooldownEnabled(config) {
    return config.cooldown?.trim().toLowerCase() !== 'off';
}

/** 把 provider 名折叠到标准名（别名映射，未知名原样返回）。 */
export function canonicalProviderName(name) {
    return foldProviderName(name.trim().toLowerCase());
}

// ---------------------------------------------------------------------------
// 写入
// ---------------------------------------------------------------------------

export function setConfigValue(dottedKey, value, configPath = CONFIG_PATH) {
    const config = loadConfigFile(configPath);
    if (dottedKey === 'provider') {
        config.provider = value;
    } else if (dottedKey === 'cooldown') {
        const normalized = value.trim().toLowerCase();
        if (normalized !== 'on' && normalized !== 'off') {
            throw new Error(`Invalid cooldown value: ${value}. Use on or off.`);
        }
        config.cooldown = normalized;
    } else if (dottedKey === 'proxy') {
        if (value.trim() === '') {
            delete config.proxy;
        } else {
            config.proxy = value.trim();
        }
    } else if (dottedKey.startsWith('reuse.')) {
        setReuseValue(config, dottedKey.slice('reuse.'.length), value);
    } else if (dottedKey.startsWith('guards.')) {
        setGuardsValue(config, dottedKey.slice('guards.'.length), value);
    } else if (dottedKey.startsWith('custom.')) {
        setCustomProviderField(config, dottedKey.slice('custom.'.length), value);
    } else if (dottedKey === 'enhanceEditPrompt') {
        const normalized = value.trim().toLowerCase();
        if (normalized !== '' && normalized !== 'true' && normalized !== 'false') {
            throw new Error('enhanceEditPrompt must be true or false (empty clears to default true).');
        }
        if (normalized === '') {
            delete config.enhanceEditPrompt;
        } else {
            config.enhanceEditPrompt = normalized === 'true';
        }
    } else {
        setProviderField(config, dottedKey, value);
    }
    persistConfig(config, configPath);
}

const CUSTOM_STRING_FIELDS = ['apiKey', 'baseUrl', 'model', 'proxy', 'displayName', 'readFamily', 'genFamily', 'auth'];

/** 自定义引擎字段（custom.<name>.<field> 多级点键）。 */
function setCustomProviderField(config, dottedKey, value) {
    const dot = dottedKey.indexOf('.');
    if (dot <= 0 || dot === dottedKey.length - 1) {
        throw new Error(
            `Invalid custom engine key: custom.${dottedKey}. Use custom.<name>.<apiKey|baseUrl|model|proxy|displayName|readFamily|genFamily|structuredOutput|extraBody>.`,
        );
    }
    const name = dottedKey.slice(0, dot);
    const field = dottedKey.slice(dot + 1);
    if (!isCustomProviderName(name, config)) {
        throw new Error(
            `自定义引擎 "${name}" 不存在。请先用 visionforge config add-engine ${name} --base-url <url> 创建，再配置其字段。`,
        );
    }
    if (config.customProviders !== undefined && !isPlainObject(config.customProviders)) {
        throw new Error(`The "customProviders" section in ${CONFIG_PATH} is not an object. Fix or remove it, then try again.`);
    }
    const entry = config.customProviders[name];
    if (field === 'structuredOutput') {
        const normalized = value.trim().toLowerCase();
        if (normalized !== '' && normalized !== 'true' && normalized !== 'false') {
            throw new Error(`custom.${name}.structuredOutput must be true or false (empty clears).`);
        }
        if (normalized === '') {
            delete entry.structuredOutput;
        } else {
            entry.structuredOutput = normalized === 'true';
        }
    } else if (field === 'extraBody') {
        if (value.trim() === '') {
            delete entry.extraBody;
        } else {
            entry.extraBody = parseExtraBody(value, `custom.${name}.extraBody`);
        }
    } else if (CUSTOM_STRING_FIELDS.includes(field)) {
        entry[field] = value;
    } else {
        throw new Error(
            `Unknown custom engine field: ${field}. Use apiKey, baseUrl, model, proxy, displayName, readFamily, genFamily, structuredOutput, or extraBody.`,
        );
    }
}

function setReuseValue(config, harness, value) {
    if (!REUSE_HARNESSES.includes(harness)) {
        throw new Error(`Unknown reuse harness: ${harness}. Use ${REUSE_HARNESSES.join(', ')}.`);
    }
    const normalized = value.trim().toLowerCase();
    if (normalized === '') {
        delete config.reuse?.[harness];
        if (config.reuse && Object.keys(config.reuse).length === 0) {
            delete config.reuse;
        }
    } else if (normalized !== 'true' && normalized !== 'false') {
        throw new Error(`reuse.${harness} must be true or false (empty clears).`);
    } else {
        config.reuse ??= {};
        config.reuse[harness] = normalized === 'true';
    }
}

function setGuardsValue(config, field, value) {
    if (config.guards !== undefined && !isPlainObject(config.guards)) {
        throw new Error('The "guards" section in the config file is not an object. Fix or remove it, then try again.');
    }
    if (field === 'denyModels' || field === 'allowModels') {
        if (value.trim() === '') {
            delete config.guards?.[field];
        } else {
            config.guards ??= {};
            config.guards[field] = parseModelList(value, `guards.${field}`);
        }
    } else if (field === 'denyWhenUnknown') {
        const normalized = value.trim().toLowerCase();
        if (normalized !== 'true' && normalized !== 'false') {
            throw new Error('guards.denyWhenUnknown must be true or false.');
        }
        config.guards ??= {};
        config.guards.denyWhenUnknown = normalized === 'true';
    } else {
        throw new Error(`Unknown guards field: ${field}. Use denyModels, allowModels, or denyWhenUnknown.`);
    }
    if (config.guards && Object.keys(config.guards).length === 0) {
        delete config.guards;
    }
}

function setProviderField(config, dottedKey, value) {
    const dot = dottedKey.indexOf('.');
    if (dot <= 0 || dot === dottedKey.length - 1) {
        throw new Error(
            `Invalid config key: ${dottedKey}. Use "provider", "proxy", "cooldown", "reuse.<claude|codex|opencode|pi|grok>", "guards.<denyModels|allowModels|denyWhenUnknown>", or "<provider>.<apiKey|baseUrl|model|proxy|extraBody|structuredOutput>".`,
        );
    }
    const typedName = dottedKey.slice(0, dot);
    const field = dottedKey.slice(dot + 1);
    const providerName = typedName.trim().toLowerCase();
    if (config.providers !== undefined && !isPlainObject(config.providers)) {
        throw new Error(`The "providers" section in ${CONFIG_PATH} is not an object. Fix or remove it, then try again.`);
    }
    for (const spelling of fileKeysFor(foldProviderName(providerName), config)) {
        const entry = config.providers?.[spelling];
        if (entry !== undefined && !isPlainObject(entry)) {
            throw new Error(`"providers.${spelling}" in ${CONFIG_PATH} is not an object. Fix or remove it, then try again.`);
        }
    }
    try {
        resolveProvider(providerName, config);
    } catch {
        const aliases = providerAliases();
        throw new Error(
            `Unknown provider: ${typedName}. Use one of ${listProviders(config).join(', ')} (aliases like ${Object.keys(aliases)
                .filter((alias) => aliases[alias] !== alias)
                .slice(0, 4)
                .join(', ')} work too).`,
        );
    }
    // 自定义引擎的字段写入 customProviders 段（与内置 providers 段隔离）
    if (isCustomProviderName(providerName, config)) {
        const entryRoot = config.customProviders ?? {};
        const entry = isPlainObject(entryRoot[providerName]) ? entryRoot[providerName] : {};
        if (field === 'structuredOutput') {
            const normalized = value.trim().toLowerCase();
            if (normalized !== '' && normalized !== 'true' && normalized !== 'false') {
                throw new Error(`${providerName}.structuredOutput must be true or false (empty clears).`);
            }
            if (normalized === '') {
                delete entry.structuredOutput;
            } else {
                entry.structuredOutput = normalized === 'true';
            }
        } else if (field === 'extraBody') {
            if (value.trim() === '') {
                delete entry.extraBody;
            } else {
                entry.extraBody = parseExtraBody(value, `${providerName}.extraBody`);
            }
        } else if (!STRING_FIELDS.includes(field)) {
            throw new Error(`Unknown config field: ${field}. Use apiKey, baseUrl, model, proxy, extraBody, or structuredOutput.`);
        } else {
            entry[field] = value;
        }
        config.customProviders ??= {};
        config.customProviders[providerName] = entry;
        return;
    }
    if (field === 'structuredOutput') {
        if (!['openai', 'qwen'].includes(foldProviderName(providerName)) && !isCustomProviderName(providerName, config)) {
            throw new Error(`structuredOutput applies to the openai/qwen providers and custom engines only, not ${providerName}.`);
        }
        const normalized = value.trim().toLowerCase();
        if (normalized !== '' && normalized !== 'true' && normalized !== 'false') {
            throw new Error(`${providerName}.structuredOutput must be true or false (empty clears).`);
        }
        config.providers ??= {};
        config.providers[providerName] ??= {};
        if (normalized === '') {
            delete config.providers[providerName].structuredOutput;
        } else {
            config.providers[providerName].structuredOutput = normalized === 'true';
        }
    } else if (field === 'extraBody') {
        config.providers ??= {};
        config.providers[providerName] ??= {};
        if (value.trim() === '') {
            delete config.providers[providerName].extraBody;
        } else {
            config.providers[providerName].extraBody = parseExtraBody(value, `${providerName}.extraBody`);
        }
    } else if (!STRING_FIELDS.includes(field)) {
        throw new Error(`Unknown config field: ${field}. Use apiKey, baseUrl, model, proxy, extraBody, or structuredOutput.`);
    } else {
        config.providers ??= {};
        config.providers[providerName] ??= {};
        config.providers[providerName][field] = value;
    }
}

function parseModelList(value, key) {
    if (value.trim().startsWith('[')) {
        const parsed = parseJsonOrExplain(value, key);
        if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
            throw new Error(`${key} must be a JSON array of glob strings.`);
        }
        return parsed;
    }
    return value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
}

export function persistConfig(config, configPath = CONFIG_PATH) {
    const out = { version: CONFIG_VERSION, ...config };
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
    try {
        fs.chmodSync(configPath, 0o600);
    } catch {
        // Windows 上 chmod 语义有限，忽略即可。
    }
}

// ---------------------------------------------------------------------------
// 可读性校验（发现 malformed 段就点名报错，不让坏配置静默生效）
// ---------------------------------------------------------------------------

export function assertReadableConfig(config, configPath = CONFIG_PATH) {
    const sentence = (key, what) => new Error(`${key} in ${configPath} ${what}. Fix or remove it, then try again.`);
    if (config.provider !== undefined && typeof config.provider !== 'string') {
        throw sentence('"provider"', 'is not a string');
    }
    if (config.proxy !== undefined && typeof config.proxy !== 'string') {
        throw sentence('"proxy"', 'is not a string');
    }
    if (config.cooldown !== undefined && typeof config.cooldown !== 'string') {
        throw sentence('"cooldown"', 'is not a string');
    }
    if (config.reuse !== undefined && !isPlainObject(config.reuse)) {
        throw sentence('"reuse"', 'is not an object');
    }
    if (config.providers !== undefined && !isPlainObject(config.providers)) {
        throw sentence('"providers"', 'is not an object');
    }
    for (const [name, entry] of Object.entries(isPlainObject(config.providers) ? config.providers : {})) {
        if (!isPlainObject(entry)) {
            throw sentence(`"providers.${name}"`, 'is not an object');
        }
        const offence = entryFieldOffence(entry);
        if (offence !== null) {
            throw sentence(`"providers.${name}"`, offence);
        }
    }
    // 自定义引擎段：结构 + 字段类型校验（normalizeCustomProviderEntry 会点名坏条目）
    if (config.customProviders !== undefined) {
        if (!isPlainObject(config.customProviders)) {
            throw sentence('"customProviders"', 'is not an object');
        }
        for (const [name, entry] of Object.entries(config.customProviders)) {
            try {
                normalizeCustomProviderEntry(name, entry);
            } catch (error) {
                throw new Error(`customProviders.${name} 配置无效：${error.message}`);
            }
        }
    }
    if (config.saved !== undefined && !isPlainObject(config.saved)) {
        throw sentence('"saved"', 'is not an object');
    }
    if (config.guards !== undefined) {
        if (!isPlainObject(config.guards)) {
            throw sentence('"guards"', 'is not an object');
        }
        for (const field of ['denyModels', 'allowModels']) {
            const value = config.guards[field];
            if (value !== undefined && !Array.isArray(value)) {
                throw sentence(`"guards.${field}"`, 'is not an array');
            }
        }
        const flag = config.guards.denyWhenUnknown;
        if (flag !== undefined && typeof flag !== 'boolean') {
            throw sentence('"guards.denyWhenUnknown"', 'is not true or false');
        }
    }
}

function entryFieldOffence(entry) {
    for (const field of STRING_FIELDS) {
        if (entry[field] !== undefined && typeof entry[field] !== 'string') {
            return `has a non-string ${field}`;
        }
    }
    if (entry.extraBody !== undefined && !isPlainObject(entry.extraBody)) {
        return 'has an extraBody that is not an object';
    }
    if (entry.structuredOutput !== undefined && typeof entry.structuredOutput !== 'boolean') {
        return 'has a structuredOutput that is not true or false';
    }
    return null;
}

function bundleFieldOffence(bundle) {
    const offence = entryFieldOffence(bundle);
    if (offence !== null) {
        return offence;
    }
    const KNOWN = ['apiKey', 'baseUrl', 'model', 'proxy', 'extraBody', 'structuredOutput'];
    if (!KNOWN.some((field) => bundle[field] !== undefined)) {
        return 'holds none of the openai fields, so using it would empty the slot';
    }
    return null;
}

// ---------------------------------------------------------------------------
// saved / use（openai 槽位的命名存档）
// ---------------------------------------------------------------------------

const SAVED_LABEL = /^[a-z][a-z0-9-]*$/;

function savedSlotFor(slot) {
    const folded = slot.trim().toLowerCase();
    const canonical = foldProviderName(folded);
    if (canonical !== 'openai') {
        throw new Error(
            `Saved copies exist only for the openai slot, the one slot users point at many different gateways. "${slot}" has none.`,
        );
    }
    return canonical;
}

function deepEqualJson(a, b) {
    if (a === b) {
        return true;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
        return a.length === b.length && a.every((item, i) => deepEqualJson(item, b[i]));
    }
    if (a && b && typeof a === 'object' && typeof b === 'object') {
        const ka = Object.keys(a).sort();
        const kb = Object.keys(b).sort();
        return ka.length === kb.length && ka.every((key, i) => key === kb[i] && deepEqualJson(a[key], b[key]));
    }
    return false;
}

export function saveProviderBundle(slot, label, configPath = CONFIG_PATH) {
    const canonical = savedSlotFor(slot);
    if (!SAVED_LABEL.test(label)) {
        throw new Error(`Labels are lowercase letters, digits and hyphens, starting with a letter: "${label}" is not.`);
    }
    const config = loadConfigFile(configPath);
    const snapshot = fileSettingsFor(canonical, config);
    if (Object.keys(snapshot).length === 0) {
        throw new Error(
            `Nothing to save: the ${canonical} slot is empty in ${configPath}. Configure it first (visionforge config set openai.baseUrl <url>).`,
        );
    }
    if (config.saved !== undefined && !isPlainObject(config.saved)) {
        throw new Error(`The "saved" section in ${configPath} is not an object. Fix or remove it, then save again.`);
    }
    config.saved ??= {};
    if (config.saved[canonical] !== undefined && !isPlainObject(config.saved[canonical])) {
        throw new Error(`"saved.${canonical}" in ${configPath} is not an object. Fix or remove it, then save again.`);
    }
    config.saved[canonical] ??= {};
    const replaced = Object.hasOwn(config.saved[canonical], label);
    config.saved[canonical][label] = snapshot;
    persistConfig(config, configPath);
    return replaced;
}

export function useProviderBundle(slot, label, discard = false, configPath = CONFIG_PATH) {
    const canonical = savedSlotFor(slot);
    const config = loadConfigFile(configPath);
    if (config.providers !== undefined && !isPlainObject(config.providers)) {
        throw new Error(`The "providers" section in ${configPath} is not an object. Fix or remove it, then try again.`);
    }
    if (config.saved !== undefined && !isPlainObject(config.saved)) {
        throw new Error(`The "saved" section in ${configPath} is not an object. Fix or remove it, then try again.`);
    }
    if (config.saved?.[canonical] !== undefined && !isPlainObject(config.saved[canonical])) {
        throw new Error(`"saved.${canonical}" in ${configPath} is not an object. Fix or remove it, then try again.`);
    }
    const bundles = config.saved?.[canonical] ?? {};
    const known = Object.keys(bundles).sort();
    if (!Object.hasOwn(bundles, label)) {
        throw new Error(
            known.length === 0
                ? `No saved copies exist for ${canonical} yet. Save the current one first: visionforge config save openai <label>.`
                : `No saved copy named "${label}". Saved: ${known.join(', ')}.`,
        );
    }
    const bundle = bundles[label];
    if (!isPlainObject(bundle)) {
        throw new Error(
            `The saved copy "${label}" in ${configPath} is not an object (found ${bundle === null ? 'null' : Array.isArray(bundle) ? 'an array' : typeof bundle}). Fix or remove it under "saved.${canonical}.${label}", then try again.`,
        );
    }
    const offence = bundleFieldOffence(bundle);
    if (offence !== null) {
        throw new Error(
            `The saved copy "${label}" in ${configPath} ${offence}. Fix it under "saved.${canonical}.${label}", then try again.`,
        );
    }
    const current = fileSettingsFor(canonical, config);
    const currentSaved = Object.keys(current).length === 0 || Object.values(bundles).some((entry) => deepEqualJson(entry, current));
    if (!currentSaved && !discard) {
        throw new Error(
            `The current ${canonical} settings are not saved under any label and would be lost. Save them first (visionforge config save openai <label>) or pass --discard.`,
        );
    }
    for (const key of fileKeysFor(canonical, config)) {
        delete config.providers?.[key];
    }
    config.providers ??= {};
    config.providers[canonical] = { ...bundle };
    persistConfig(config, configPath);
}

// ---------------------------------------------------------------------------
// init / show
// ---------------------------------------------------------------------------

const CONFIG_TEMPLATE = {
    version: CONFIG_VERSION,
    // 空字符串 = 走内置默认 provider。
    provider: '',
    providers: {},
};

export function initConfigFile(configPath = CONFIG_PATH, force = false) {
    if (!force && fs.existsSync(configPath)) {
        throw new Error(`${configPath} already exists. Use --force to overwrite (that also deletes every saved gateway copy under "saved").`);
    }
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(CONFIG_TEMPLATE, null, 2)}\n`, { mode: 0o600 });
    try {
        fs.chmodSync(configPath, 0o600);
    } catch {
    }
}

function maskKey(key) {
    if (key.length <= 8) {
        return '****';
    }
    return `${key.slice(0, 6)}...${key.slice(-2)}`;
}

function maskKeys(value) {
    const keys = splitApiKeys(value);
    return keys.length > 0 ? keys.map(maskKey).join(', ') : '****';
}

/** 收集全部已知 key（文件 + env + saved 槽），供展示层统一脱敏。 */
export function knownApiKeys(config, env = process.env) {
    const keys = new Set();
    const providersRoot = isPlainObject(config.providers) ? config.providers : {};
    for (const entry of Object.values(providersRoot)) {
        if (isPlainObject(entry) && typeof entry.apiKey === 'string') {
            for (const apiKey of splitApiKeys(entry.apiKey)) {
                keys.add(apiKey);
            }
        }
    }
    for (const bindings of Object.values(ENV_BINDINGS)) {
        const variable = bindings.apiKey;
        for (const apiKey of splitApiKeys(variable ? env[variable] : undefined)) {
            keys.add(apiKey);
        }
    }
    const savedRoot = isPlainObject(config.saved) ? config.saved : {};
    for (const bundles of Object.values(savedRoot)) {
        if (!isPlainObject(bundles)) {
            continue;
        }
        for (const bundle of Object.values(bundles)) {
            if (isPlainObject(bundle) && typeof bundle.apiKey === 'string') {
                for (const apiKey of splitApiKeys(bundle.apiKey)) {
                    keys.add(apiKey);
                }
            }
        }
    }
    // 自定义引擎的 key 同样纳入脱敏范围
    for (const entry of Object.values(readCustomProviders(config))) {
        if (typeof entry.apiKey === 'string') {
            for (const apiKey of splitApiKeys(entry.apiKey)) {
                keys.add(apiKey);
            }
        }
    }
    return [...keys];
}

function redactValues(value, keys) {
    const ordered = [...keys].sort((a, b) => b.length - a.length);
    const scrub = (text) => {
        let out = text;
        for (const key of ordered) {
            if (key.length > 0) {
                out = out.split(key).join('[redacted]');
            }
        }
        return out;
    };
    const walk = (node) => {
        if (typeof node === 'string') {
            return scrub(node);
        }
        if (Array.isArray(node)) {
            return node.map(walk);
        }
        if (node && typeof node === 'object') {
            const out = Object.create(null);
            for (const [key, entry] of Object.entries(node)) {
                out[key] = walk(entry);
            }
            return out;
        }
        return node;
    };
    return walk(value);
}

export function renderEffectiveConfig(config, env = process.env) {
    const providersRoot = isPlainObject(config.providers) ? config.providers : undefined;
    const canonicalNames = new Set(listProviders());
    const providerNames = new Set(
        Object.keys(providersRoot ?? {})
            .map((key) => foldProviderName(key))
            .filter((name) => canonicalNames.has(name)),
    );
    for (const [providerName, bindings] of Object.entries(ENV_BINDINGS)) {
        if (
            Object.entries(bindings).some(([field, variable]) => {
                const value = env[variable]?.trim();
                return field === 'apiKey' ? splitApiKeys(value).length > 0 : Boolean(value);
            })
        ) {
            providerNames.add(providerName);
        }
    }
    const providers = Object.create(null);
    const notes = [];
    for (const [rawName, entry] of Object.entries(providersRoot ?? {})) {
        if (entry !== undefined && !isPlainObject(entry)) {
            notes.push(`providers.${rawName} is not an object; fix or remove it`);
            continue;
        }
        if (!canonicalNames.has(foldProviderName(rawName))) {
            notes.push(`providers.${rawName} is not a known provider; runs ignore it`);
        }
    }
    if (config.providers !== undefined && providersRoot === undefined) {
        providers['(malformed)'] = { providers: 'the "providers" section is not an object; fix or remove it' };
    }
    for (const name of [...providerNames].sort()) {
        const fileSettings = fileSettingsFor(name, config);
        const mentioned = providerConfiguredInFile(name, config);
        const effective = mentioned ? fileSettings : envSettingsFor(name, env);
        const source = mentioned ? 'file' : 'env';
        const fields = {};
        const entryKeys = splitApiKeys(typeof effective.apiKey === 'string' ? effective.apiKey : undefined);
        const guard = (shown) => redactSecrets(shown, entryKeys);
        for (const field of STRING_FIELDS) {
            const value = effective[field];
            if (value === undefined) {
                continue;
            }
            if (typeof value !== 'string') {
                fields[field] = `(malformed: not a string) (${source})`;
                continue;
            }
            const shown =
                field === 'apiKey'
                    ? maskKeys(value)
                    : field === 'proxy'
                      ? value.trim() === ''
                        ? 'direct'
                        : maskUrlCredentials(guard(value))
                      : guard(value);
            fields[field] = `${shown} (${source})`;
        }
        if (fileSettings.structuredOutput !== undefined) {
            fields.structuredOutput = `${fileSettings.structuredOutput} (file)`;
        }
        if (fileSettings.extraBody !== undefined) {
            fields.extraBody = `${guard(JSON.stringify(fileSettings.extraBody))} (file)`;
        }
        if (Object.keys(fields).length > 0 || mentioned) {
            providers[name] = fields;
        }
    }
    const effective = {
        providers,
        cooldown: config.cooldown ? `${config.cooldown} (file)` : 'on (default)',
    };
    // 自定义引擎段展示（key 打码）
    const customs = readCustomProviders(config);
    if (Object.keys(customs).length > 0) {
        effective.customProviders = Object.create(null);
        for (const entry of Object.values(customs)) {
            const caps = ['read', 'generate', 'edit'].filter((c) => entry.capabilities[c] || entry.models.some((m) => m.capabilities[c]));
            effective.customProviders[entry.id] = {
                displayName: entry.displayName,
                readFamily: entry.readFamily,
                genFamily: entry.genFamily ?? '(未启用生图)',
                model: entry.model,
                baseUrl: entry.baseUrl,
                apiKey: maskKeys(entry.apiKey),
                capabilities: caps.join(', ') || 'read',
            };
        }
    }
    const savedRows = [];
    const savedRoot = config.saved;
    if (savedRoot !== undefined && !isPlainObject(savedRoot)) {
        savedRows.push('the "saved" section is not an object; fix or remove it');
    }
    for (const [slot, bundles] of Object.entries(isPlainObject(savedRoot) ? savedRoot : {})) {
        if (!isPlainObject(bundles)) {
            savedRows.push(`saved.${slot} is not an object; fix or remove it`);
            continue;
        }
        for (const label of Object.keys(bundles).sort()) {
            const bundle = bundles[label];
            if (!isPlainObject(bundle)) {
                savedRows.push(`${slot}/${label}: (malformed: not an object; fix or remove it)`);
                continue;
            }
            const parts = [
                typeof bundle.model === 'string' ? bundle.model : undefined,
                typeof bundle.baseUrl === 'string' ? bundle.baseUrl : undefined,
                bundle.apiKey === undefined
                    ? 'no key'
                    : typeof bundle.apiKey === 'string'
                      ? `key ${maskKeys(bundle.apiKey)}`
                      : 'key (malformed: not a string)',
            ].filter(Boolean);
            savedRows.push(`${slot}/${label}: ${parts.join(' @ ')}`);
        }
    }
    if (savedRows.length > 0) {
        effective.saved = savedRows;
    }
    if (typeof config.provider === 'string' && config.provider.trim()) {
        effective.provider = config.provider.trim();
    } else if (config.provider !== undefined && typeof config.provider !== 'string') {
        effective.provider = '(malformed: not a string)';
    }
    if (config.proxy !== undefined && typeof config.proxy !== 'string') {
        effective.proxy = '(malformed: not a string)';
    } else if (config.proxy?.trim()) {
        effective.proxy = `${maskUrlCredentials(config.proxy.trim())} (file)`;
    } else if (env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy) {
        const raw = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
        effective.proxy = `${maskUrlCredentials(raw)} (env)`;
    }
    if (config.guards !== undefined && !isPlainObject(config.guards)) {
        effective.guards = { '(malformed)': 'the "guards" section is not an object; fix or remove it' };
    } else if (config.guards) {
        const guards = {};
        if (config.guards.denyModels !== undefined) {
            guards.denyModels = `${JSON.stringify(config.guards.denyModels)} (file)`;
        }
        if (config.guards.allowModels !== undefined) {
            guards.allowModels = `${JSON.stringify(config.guards.allowModels)} (file)`;
        }
        if (config.guards.denyWhenUnknown !== undefined) {
            guards.denyWhenUnknown = `${config.guards.denyWhenUnknown} (file)`;
        }
        if (Object.keys(guards).length > 0) {
            effective.guards = guards;
        }
    }
    if (config.reuse !== undefined && !isPlainObject(config.reuse)) {
        effective.reuse = { '(malformed)': 'the "reuse" section is not an object; fix or remove it' };
    } else if (config.reuse && Object.keys(config.reuse).length > 0) {
        const reuse = {};
        for (const harness of REUSE_HARNESSES) {
            const granted = config.reuse[harness];
            if (granted !== undefined) {
                reuse[harness] = `${granted} (file)`;
            }
        }
        for (const stranger of Object.keys(config.reuse).filter((key) => !REUSE_HARNESSES.includes(key))) {
            notes.push(`reuse.${stranger} is not a known harness; runs ignore it`);
        }
        if (Object.keys(reuse).length > 0) {
            effective.reuse = reuse;
        }
    }
    if (notes.length > 0) {
        effective.notes = notes;
    }
    return JSON.stringify(redactValues(effective, knownApiKeys(config, env)), null, 2);
}
