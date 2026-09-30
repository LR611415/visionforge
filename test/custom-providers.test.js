// custom-providers.test.js — 名称护栏 + customProviders schema + 域名识别
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalizeName,
  checkNameConflicts,
  levenshtein,
  parseSizeCap,
  suggestBuiltinName,
  suggestFamilyFromBaseUrl,
  readCustomProviders,
} from '../src/custom-providers.js';

test('canonicalizeName: 归一大小写、空格、连字符、下划线', () => {
  assert.equal(canonicalizeName('  Google  Gemini '), 'google-gemini');
  assert.equal(canonicalizeName('Google_Gemini'), 'google-gemini');
  assert.equal(canonicalizeName('OPENAI'), 'openai');
});

test('canonicalizeName: 支持中文/Unicode，拒绝空输入、前导符号与非法字符', () => {
  assert.throws(() => canonicalizeName(''), /不能为空/);
  // 中文引擎名（如"星桥"）是合法名称
  assert.equal(canonicalizeName('你好世界'), '你好世界');
  assert.equal(canonicalizeName('星桥'), '星桥');
  assert.throws(() => canonicalizeName('-leading'), /不规范/);
  assert.throws(() => canonicalizeName('!!bad!!'), /不规范/);
});

test('parseSizeCap: 2K/4K/像素/边长/非法解析', () => {
  assert.deepEqual(parseSizeCap('2K'), { supports2K: true, maxW: 2560, maxH: 1440 });
  assert.deepEqual(parseSizeCap('4k'), { supports2K: true, maxW: 4096, maxH: 4096 });
  const px = parseSizeCap('4096x4096');
  assert.equal(px.maxW, 4096);
  assert.equal(px.supports2K, true);
  assert.equal(parseSizeCap(''), null);
  assert.equal(parseSizeCap(undefined), null);
  assert.throws(() => parseSizeCap('huge'), /无法解析/);
});

test('checkNameConflicts: 内置引擎与别名折叠', () => {
  const conflict = checkNameConflicts('qwen', {});
  assert.equal(conflict.kind, 'builtin');
  assert.match(conflict.message, /内置引擎/);
  // 别名也折叠：gemini → gemini-api
  const gemini = checkNameConflicts('gemini', {});
  assert.equal(gemini.kind, 'builtin');
  assert.equal(gemini.folded, 'gemini-api');
});

test('checkNameConflicts: 已有自定义引擎重名', () => {
  const conflict = checkNameConflicts('my-engine', { customProviders: { 'my-engine': { baseUrl: 'https://x.com' } } });
  assert.equal(conflict.kind, 'duplicate');
});

test('checkNameConflicts: 无冲突返回 null', () => {
  assert.equal(checkNameConflicts('brand-new-engine', {}), null);
});

test('levenshtein: 编辑距离计算', () => {
  assert.equal(levenshtein('qwenx', 'qwen'), 1);
  assert.equal(levenshtein('geminiapi', 'gemini-api'), 1);
  assert.equal(levenshtein('', 'abc'), 3);
});

test('suggestBuiltinName: 对内置引擎 ≤2 距离给出建议，不静默', () => {
  const s = suggestBuiltinName('qwenx');
  assert.ok(s);
  assert.equal(s.suggestion, 'qwen');
  assert.equal(s.distance, 1);
  // 距离太远不提示
  assert.equal(suggestBuiltinName('totally-unrelated-name'), null);
});

test('suggestFamilyFromBaseUrl: 域名 → 协议族', () => {
  assert.equal(suggestFamilyFromBaseUrl('https://generativelanguage.googleapis.com').family, 'gemini');
  assert.equal(suggestFamilyFromBaseUrl('https://api.anthropic.com').family, 'anthropic');
  assert.equal(suggestFamilyFromBaseUrl('https://api.openai.com').family, 'openai-compatible');
  assert.equal(suggestFamilyFromBaseUrl('https://maas.qianwenaiapi.com/compatible-mode/v1').family, 'openai-compatible');
  assert.equal(suggestFamilyFromBaseUrl('https://unknown-vendor.example').family, 'openai-compatible'); // 兜底
});

test('readCustomProviders: 规范化条目，坏条目点名报错', () => {
  const out = readCustomProviders({
    customProviders: {
      google: {
        displayName: 'Google Gemini',
        baseUrl: 'https://generativelanguage.googleapis.com',
        readFamily: 'gemini',
        genFamily: 'chat-native',
        apiKey: 'AIza-x',
        models: [
          { name: 'gemini-3.1', capabilities: { read: true, generate: false } },
          { name: 'imagen-4.0', capabilities: { read: false, generate: true } },
        ],
      },
    },
  });
  assert.equal(out.google.readFamily, 'gemini');
  assert.equal(out.google.genFamily, 'chat-native');
  assert.equal(out.google.model, 'gemini-3.1');
  assert.equal(out.google.models.length, 2);
  // 未知 readFamily 报错并点名
  assert.throws(
    () => readCustomProviders({ customProviders: { bad: { baseUrl: 'https://x.com', readFamily: 'nope' } } }),
    /readFamily "nope" 未知/,
  );
  // 有 key 没地址：明确报错
  assert.throws(
    () => readCustomProviders({ customProviders: { bad2: { apiKey: 'sk-x' } } }),
    /缺少 baseUrl/,
  );
});

test('readCustomProviders: 骨架引擎（models 为空）允许创建', () => {
  const out = readCustomProviders({ customProviders: { skeleton: { baseUrl: 'https://x.com' } } });
  assert.equal(out.skeleton.models.length, 0);
  assert.equal(out.skeleton.genFamily, null);
});
