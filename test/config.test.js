import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalProviderName } from '../src/config.js';

test('canonicalProviderName: 标准名保持不变', () => {
    assert.equal(canonicalProviderName('qwen'), 'qwen');
    assert.equal(canonicalProviderName('openai'), 'openai');
    assert.equal(canonicalProviderName('anthropic'), 'anthropic');
    assert.equal(canonicalProviderName('gemini-api'), 'gemini-api');
    assert.equal(canonicalProviderName('claude-cli'), 'claude-cli');
    assert.equal(canonicalProviderName('kimi-cli'), 'kimi-cli');
    assert.equal(canonicalProviderName('antigravity-cli'), 'antigravity-cli');
});

test('canonicalProviderName: 别名折叠到标准名', () => {
    assert.equal(canonicalProviderName('qwen-vl'), 'qwen');
    assert.equal(canonicalProviderName('dashscope'), 'qwen');
    assert.equal(canonicalProviderName('gemini'), 'gemini-api');
    assert.equal(canonicalProviderName('openai-compat'), 'openai');
    assert.equal(canonicalProviderName('claude'), 'anthropic');
    assert.equal(canonicalProviderName('claude-code'), 'claude-cli');
    assert.equal(canonicalProviderName('kimi'), 'kimi-cli');
    assert.equal(canonicalProviderName('kimi-code'), 'kimi-cli');
    assert.equal(canonicalProviderName('agy'), 'antigravity-cli');
    assert.equal(canonicalProviderName('antigravity'), 'antigravity-cli');
});

test('canonicalProviderName: 大小写与空白归一化', () => {
    assert.equal(canonicalProviderName('  QWEN '), 'qwen');
    assert.equal(canonicalProviderName('OpenAI'), 'openai');
    assert.equal(canonicalProviderName('Claude-Code'), 'claude-cli');
});

test('canonicalProviderName: 未知名字原样返回', () => {
    assert.equal(canonicalProviderName('my-custom-engine'), 'my-custom-engine');
    assert.equal(canonicalProviderName(''), '');
});

import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfigFile, persistConfig, CONFIG_VERSION } from '../src/config.js';

function tmpConfig(raw) {
    const dir = mkdtempSync(join(tmpdir(), 'vf-cfg-'));
    const p = join(dir, 'config.json');
    if (raw !== null) writeFileSync(p, raw, 'utf-8');
    return { dir, p };
}

test('loadConfigFile: 损坏 JSON → 自动备份 .bak + 抛错', () => {
    const { dir, p } = tmpConfig('{ "providers": { "qwen": { "apiKey": "sk-abc" } } '); // 截断的 JSON
    assert.throws(() => loadConfigFile(p), /已自动备份/);
    const baks = readdirSync(dir).filter((f) => f.startsWith('config.json.bak-'));
    assert.equal(baks.length, 1, '应生成 1 个 .bak 备份');
    const raw = readFileSync(join(dir, baks[0]), 'utf-8');
    assert.ok(raw.includes('providers'), '备份内容保留原文件');
    rmSync(dir, { recursive: true, force: true });
});

test('loadConfigFile: 顶层结构异常（providers 为数组）→ 备份 + 抛错', () => {
    const { dir, p } = tmpConfig(JSON.stringify({ provider: 'qwen', providers: [1, 2, 3] }));
    assert.throws(() => loadConfigFile(p), /结构异常.*providers 应为对象/);
    const baks = readdirSync(dir).filter((f) => f.startsWith('config.json.bak-'));
    assert.equal(baks.length, 1);
    rmSync(dir, { recursive: true, force: true });
});

test('loadConfigFile: 正常配置 → 原样返回，不做备份', () => {
    const { dir, p } = tmpConfig(JSON.stringify({ provider: 'qwen', providers: { qwen: { apiKey: 'sk-x' } } }));
    const cfg = loadConfigFile(p);
    assert.equal(cfg.provider, 'qwen');
    assert.equal(readdirSync(dir).filter((f) => f.includes('.bak-')).length, 0);
    rmSync(dir, { recursive: true, force: true });
});

test('persistConfig: 写入带 version 字段', () => {
    const { dir, p } = tmpConfig(null);
    persistConfig({ provider: 'qwen' }, p);
    const saved = JSON.parse(readFileSync(p, 'utf-8'));
    assert.equal(saved.version, CONFIG_VERSION);
    assert.equal(saved.provider, 'qwen');
    rmSync(dir, { recursive: true, force: true });
});
