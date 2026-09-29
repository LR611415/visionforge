import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cooldownStateKey, parseCooldownStateKey } from '../src/cooldown.js';

test('cooldownStateKey: 生成稳定 key', () => {
    assert.equal(cooldownStateKey('qwen', 0), 'qwen::key:0');
    assert.equal(cooldownStateKey('gemini-api', 2), 'gemini-api::key:2');
    assert.equal(cooldownStateKey('openai', 3), 'openai::key:3');
});

test('parseCooldownStateKey: 正常解析', () => {
    assert.deepEqual(parseCooldownStateKey('qwen::key:0'), { engine: 'qwen', keyIndex: 0 });
    assert.deepEqual(parseCooldownStateKey('gemini-api::key:2'), { engine: 'gemini-api', keyIndex: 2 });
});

test('parseCooldownStateKey: 引擎名含 # 或异常输入不崩溃', () => {
    const r = parseCooldownStateKey('not-a-valid-key');
    assert.ok(r === null || typeof r === 'object');
});

test('cooldownStateKey/parseCooldownStateKey: round-trip', () => {
    for (const engine of ['qwen', 'openai', 'anthropic', 'claude-cli', 'my-custom-engine']) {
        for (const keyIndex of [0, 1, 5]) {
            const key = cooldownStateKey(engine, keyIndex);
            assert.deepEqual(parseCooldownStateKey(key), { engine, keyIndex });
        }
    }
});
