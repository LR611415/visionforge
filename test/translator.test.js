// translator.test.js — 翻译器：Canonical Image + 读图/生图模板渲染与解析
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { canonicalizeImage, normalizeSizeFor, parseGenResponse, renderGenRequest, renderReadRequest, parseReadResponse } from '../src/providers/translator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpPng = path.join(__dirname, '.translator-test.png');
fs.writeFileSync(tmpPng, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
after(() => {
  try { fs.unlinkSync(tmpPng); } catch { /* already gone */ }
});

test('canonicalizeImage: 本地文件读取 base64 + mime', () => {
  const img = canonicalizeImage('local', tmpPng);
  assert.equal(img.kind, 'local');
  assert.equal(img.mimeType, 'image/png');
  assert.ok(img.data.length > 0);
});

test('normalizeSizeFor: family 感知', () => {
  assert.equal(normalizeSizeFor('1024x1024', 'dashscope-image'), '1024*1024');
  assert.equal(normalizeSizeFor('1024×1024', 'dashscope-image'), '1024*1024');
  assert.equal(normalizeSizeFor('1024x1024', 'openai-image'), '1024x1024');
  assert.equal(normalizeSizeFor('1024*1024', 'chat-native'), '1024*1024');
  assert.equal(normalizeSizeFor('1280x720', 'google-imagen'), '16:9');
  assert.equal(normalizeSizeFor('1024x1024', 'google-imagen'), '1:1');
});

test('renderGenRequest: dashscope-image 端点、尺寸、数量', async () => {
  const r = await renderGenRequest({
    family: 'dashscope-image',
    model: 'qwen-image-3.0',
    baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    apiKey: 'sk-test',
    prompt: 'hello',
    size: '1024x1024',
    count: 2,
    refImages: [],
    mode: 'text-to-image',
  });
  assert.match(r.url, /multimodal-generation\/generation$/);
  const body = JSON.parse(r.body);
  assert.equal(body.parameters.size, '1024*1024');
  assert.equal(body.parameters.n, 2);
  assert.equal(body.parameters.watermark, false);
  assert.equal(r.headers.Authorization, 'Bearer sk-test');
});

test('renderGenRequest: openai-image 编辑扩展（image 字段，Seedream 兼容）', async () => {
  const r = await renderGenRequest({
    family: 'openai-image',
    model: 'glm-image',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKey: 'sk-test',
    prompt: 'edit',
    size: '1280x1280',
    count: 1,
    refImages: [canonicalizeImage('local', tmpPng)],
    mode: 'image-to-image',
  });
  assert.match(r.url, /images\/generations$/);
  const body = JSON.parse(r.body);
  assert.ok(Array.isArray(body.image), 'Seedream/OpenAI 兼容用 image 字段（input_image 会被忽略退化为文生图）');
  assert.ok(!('input_image' in body), '不得再发送 gpt-image-1 的 input_image');
  assert.match(body.image[0], /^data:image\/png;base64,/);
});

test('renderGenRequest: chat-native 编辑带 inline_data', async () => {
  const r = await renderGenRequest({
    family: 'chat-native',
    model: 'gemini-3.1',
    baseUrl: 'https://generativelanguage.googleapis.com',
    apiKey: 'AIza-test',
    prompt: 'edit this',
    size: '1024*1024',
    count: 1,
    refImages: [canonicalizeImage('local', tmpPng)],
    mode: 'edit',
  });
  assert.match(r.url, /:generateContent$/);
  assert.equal(r.headers['x-goog-api-key'], 'AIza-test');
  const body = JSON.parse(r.body);
  assert.ok(body.contents[0].parts[0].inline_data.data.length > 0);
  assert.equal(body.generationConfig.responseModalities[0], 'IMAGE');
});

test('renderGenRequest: google-imagen 比例与 sampleCount', async () => {
  const r = await renderGenRequest({
    family: 'google-imagen',
    model: 'imagen-4.0',
    baseUrl: 'https://us-central1-aiplatform.googleapis.com',
    apiKey: 'AIza-test',
    prompt: 'a cat',
    size: '1:1',
    count: 3,
    refImages: [],
    mode: 'text-to-image',
  });
  assert.match(r.url, /:predict$/);
  const body = JSON.parse(r.body);
  assert.equal(body.parameters.sampleCount, 3);
  assert.equal(body.parameters.aspectRatio, '1:1');
});

test('renderGenRequest: 未知 family 明确报错', async () => {
  await assert.rejects(
    renderGenRequest({ family: 'nope', model: 'x', baseUrl: 'https://x.com', apiKey: 'k', prompt: 'p', refImages: [] }),
    /未知生图协议族/,
  );
});

test('parseGenResponse: 四个 family 解析', () => {
  assert.deepEqual(
    parseGenResponse('dashscope-image', { output: { choices: [{ message: { content: [{ image: 'https://x/a.png' }] } }] } }),
    ['https://x/a.png'],
  );
  assert.deepEqual(
    parseGenResponse('openai-image', { data: [{ url: 'https://x/b.png' }, { url: '' }] }),
    ['https://x/b.png'],
  );
  assert.deepEqual(
    parseGenResponse('chat-native', { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } }] } }] }),
    ['data:image/png;base64,aGVsbG8='],
  );
  assert.deepEqual(
    parseGenResponse('google-imagen', { predictions: [{ bytesBase64Encoded: 'aGVsbG8=' }] }),
    ['data:image/png;base64,aGVsbG8='],
  );
});

test('renderReadRequest + parseReadResponse: openai-compatible 读图往返', async () => {
  const r = await renderReadRequest({
    family: 'openai-compatible',
    model: 'qwen3-vl-plus',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey: 'sk-test',
    prompt: 'What is this?',
    image: canonicalizeImage('local', tmpPng),
    timeoutMs: 30000,
  });
  const body = JSON.parse(r.body);
  assert.ok(Array.isArray(body.messages[0].content));
  assert.match(body.messages[0].content[0].image_url.url, /^data:image\/png;base64,/);
  const parsed = parseReadResponse('openai-compatible', {
    choices: [{ message: { content: 'summary: A tiny square' } }],
  });
  assert.equal(parsed.content, 'summary: A tiny square');
});

test('renderReadRequest: gemini 读图 inline_data + responseJsonSchema', async () => {
  const r = await renderReadRequest({
    family: 'gemini',
    model: 'gemini-3.1',
    baseUrl: 'https://generativelanguage.googleapis.com',
    apiKey: 'AIza-test',
    prompt: 'describe',
    image: canonicalizeImage('local', tmpPng),
    timeoutMs: 30000,
  });
  assert.match(r.url, /:generateContent$/);
  assert.equal(r.headers['x-goog-api-key'], 'AIza-test');
  const body = JSON.parse(r.body);
  assert.ok(body.contents[0].parts[0].inline_data.data.length > 0);
  assert.equal(body.contents[0].parts[1].text, 'describe');
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.ok(body.generationConfig.responseJsonSchema);
});

test('renderReadRequest: anthropic 读图 source 块 + x-api-key', async () => {
  const r = await renderReadRequest({
    family: 'anthropic',
    model: 'claude-haiku-4-5',
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'sk-ant-test',
    prompt: 'describe',
    image: canonicalizeImage('local', tmpPng),
    timeoutMs: 30000,
  });
  assert.equal(r.headers['x-api-key'], 'sk-ant-test');
  const body = JSON.parse(r.body);
  assert.equal(body.messages[0].content[0].type, 'image');
  assert.equal(body.messages[0].content[0].source.type, 'base64');
});
