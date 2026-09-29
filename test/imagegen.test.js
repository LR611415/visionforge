import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSize } from '../src/imagegen.js';

// Qwen 图片 API 要求 size 为 "W*H"（星号）。历史坑：传 1024x1024（x 分隔）会收到
// 400 InvalidParameter "Expected format: '<width>*<height>'"。normalizeSize 负责兜底。

test('normalizeSize: 各种分隔符统一为星号', () => {
    assert.equal(normalizeSize('1024x1024'), '1024*1024');
    assert.equal(normalizeSize('1024×1024'), '1024*1024'); // 全角乘号
    assert.equal(normalizeSize('1024*1024'), '1024*1024');
    assert.equal(normalizeSize('512x768'), '512*768');
});

test('normalizeSize: 空格与大小写容忍', () => {
    assert.equal(normalizeSize('1024 x 1024'), '1024*1024');
    assert.equal(normalizeSize('1024  X  1024'), '1024*1024');
    assert.equal(normalizeSize(' 1024x1024 '), '1024*1024');
});

test('normalizeSize: 空/缺省回退到 1024*1024', () => {
    assert.equal(normalizeSize(''), '1024*1024');
    assert.equal(normalizeSize('   '), '1024*1024');
    assert.equal(normalizeSize(undefined), '1024*1024');
    assert.equal(normalizeSize(null), '1024*1024');
});

test('normalizeSize: 无法识别的输入原样返回（由上游报错）', () => {
    assert.equal(normalizeSize('square'), 'square');
    assert.equal(normalizeSize('10*10*10'), '10*10*10');
});
