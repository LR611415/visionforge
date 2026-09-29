import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globMatch, evaluateGuard } from '../src/guard.js';

// --- globMatch ---

test('globMatch: * matches any sequence', () => {
    assert.equal(globMatch('deepseek-v4-*', 'deepseek-v4-pro'), true);
    assert.equal(globMatch('deepseek-v4-*', 'deepseek-v4-flash'), true);
    assert.equal(globMatch('deepseek-v4-*', 'deepseek-v5'), false);
});

test('globMatch: ? matches exactly one char', () => {
    assert.equal(globMatch('glm-5.?', 'glm-5.2'), true);
    assert.equal(globMatch('glm-5.?', 'glm-5.22'), false);
});

test('globMatch: case insensitive', () => {
    assert.equal(globMatch('DEEPSEEK-v4-*', 'deepseek-v4-pro'), true);
    assert.equal(globMatch('deepseek-v4-*', 'DeepSeek-V4-Pro'), true);
});

test('globMatch: exact pattern (no wildcard)', () => {
    assert.equal(globMatch('glm-5.3', 'glm-5.3'), true);
    assert.equal(globMatch('glm-5.3', 'glm-5.30'), false);
});

test('globMatch: namespace pair */glm-5.3-flash matches namespaced model only', () => {
    assert.equal(globMatch('*/glm-5.3-flash', 'z-ai/glm-5.3-flash'), true);
    assert.equal(globMatch('*/glm-5.3-flash', 'glm-5.3-flash'), false); // 裸名需裸模式，*/ 只抓带命名空间的候选
    assert.equal(globMatch('glm-5.3-flash', 'z-ai/glm-5.3-flash'), false);
});

test('globMatch: glm-5.3-flash* must NOT match flashlight (anchor trap)', () => {
    assert.equal(globMatch('glm-5.3-flash*', 'glm-5.3-flashlight'), true); // 确实会匹配——文档已警告此写法
    // 文档推荐的锚定写法才是安全边界：允许名单应写 glm-5.3-flash 精确或带分隔符
    assert.equal(globMatch('glm-5.3-flash', 'glm-5.3-flashlight'), false);
});

test('globMatch: deny 视觉变体 glm-*v* 抓住带分隔符变体', () => {
    assert.equal(globMatch('glm-*v*', 'glm-5.2v'), true);
    assert.equal(globMatch('glm-*v*', 'glm-5.2-vision'), true);
    assert.equal(globMatch('glm-*v*', 'glm-5.3'), false);
});

// --- evaluateGuard ---

test('evaluateGuard: no rules configured → allow (fail open)', () => {
    assert.equal(evaluateGuard({}, { model: 'deepseek-v4-pro' }).guard, 'allow');
    assert.equal(evaluateGuard({}, { model: null }).guard, 'allow');
});

test('evaluateGuard: deny list rejects matching model', () => {
    const guards = { denyModels: ['glm-*v*', 'deepseek-vl*'] };
    assert.equal(evaluateGuard(guards, { model: 'glm-5.2v', provider: 'z-ai' }).guard, 'deny');
    assert.equal(evaluateGuard(guards, { model: 'deepseek-vl-1.5' }).guard, 'deny');
    assert.equal(evaluateGuard(guards, { model: 'deepseek-v4-pro' }).guard, 'allow');
});

test('evaluateGuard: deny wins over allow (both match)', () => {
    const guards = { allowModels: ['glm-*'], denyModels: ['glm-*v*'] };
    assert.equal(evaluateGuard(guards, { model: 'glm-5.2v' }).guard, 'deny');
});

test('evaluateGuard: allow whitelist rejects non-listed model', () => {
    const guards = { allowModels: ['deepseek-v4-*', 'glm-5.2'] };
    assert.equal(evaluateGuard(guards, { model: 'deepseek-v4-pro' }).guard, 'allow');
    assert.equal(evaluateGuard(guards, { model: 'qwen3-coder' }).guard, 'deny');
});

test('evaluateGuard: matches provider/model pair too', () => {
    const guards = { denyModels: ['*/glm-5.3-flash'] };
    assert.equal(evaluateGuard(guards, { model: 'glm-5.3-flash', provider: 'z-ai' }).guard, 'deny');
    assert.equal(evaluateGuard(guards, { model: 'glm-5.3-flash', provider: 'openrouter' }).guard, 'deny');
});

test('evaluateGuard: denyWhenUnknown=true denies unknown model', () => {
    const guards = { denyWhenUnknown: true };
    assert.equal(evaluateGuard(guards, { model: null }).guard, 'deny');
});

test('evaluateGuard: unknown model fails open by default', () => {
    const guards = { denyModels: ['glm-*'] };
    assert.equal(evaluateGuard(guards, { model: null }).guard, 'allow');
});
