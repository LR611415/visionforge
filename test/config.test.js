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
