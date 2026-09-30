// diagnose.test.js — 失败归因分类 + 验证状态
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure, customGateError, formatCustomEngineFailure } from '../src/diagnose.js';

test('classifyFailure: 401 / Invalid key → auth', () => {
  const d = classifyFailure({ status: 401, error: new Error('Invalid API key provided') });
  assert.equal(d.category, 'auth');
  assert.match(d.message, /HTTP 401/);
  assert.match(d.advice, /密钥/);
});

test('classifyFailure: 404 → family（协议族不符）', () => {
  const d = classifyFailure({ status: 404, error: new Error('Not Found') });
  assert.equal(d.category, 'family');
});

test('classifyFailure: 超时 → timeout', () => {
  const e = new Error('fetch timed out');
  e.name = 'TimeoutError';
  assert.equal(classifyFailure({ error: e }).category, 'timeout');
});

test('classifyFailure: 未知模型 → model', () => {
  const d = classifyFailure({ status: 400, error: new Error('Model not found: xxx') });
  assert.equal(d.category, 'model');
});

test('classifyFailure: 429 → quota', () => {
  assert.equal(classifyFailure({ status: 429, error: new Error('rate limit') }).category, 'quota');
});

test('classifyFailure: 连接失败 → network', () => {
  assert.equal(classifyFailure({ error: new Error('fetch failed') }).category, 'network');
});

test('customGateError / formatCustomEngineFailure 输出完整指引', () => {
  const entry = { id: '星桥', displayName: '星桥', failed: { reason: '生图：引擎「星桥」调用失败 [family]（HTTP 404）：Not Found' } };
  const gate = customGateError(entry, '星桥');
  assert.ok(gate);
  assert.match(gate, /上次调用失败/);
  assert.equal(customGateError({ id: 'x' }, 'x'), null);
  const fmt = formatCustomEngineFailure({ displayName: '测试', model: 'm1', baseUrl: 'https://x/v1' }, { category: 'auth', message: '鉴权失败', advice: '请检查密钥' });
  assert.match(fmt, /自定义引擎「测试」/);
  assert.match(fmt, /请检查密钥/);
  assert.match(fmt, /baseUrl=https:\/\/x\/v1/);
});
