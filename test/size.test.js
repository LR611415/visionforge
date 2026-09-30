// size.test.js — 分辨率词表 + 引擎能力表 + 默认画质决策
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampSize, resolveSize, enginesSupporting, DEFAULT_BEST_SIZE, DEFAULT_2K, MAX_TOTAL_PIXELS, ENGINE_SIZE_CAPS } from '../src/size.js';

const dashscope = ENGINE_SIZE_CAPS['dashscope-image']; // qwen：支持 2K，总像素上限
const openai = ENGINE_SIZE_CAPS['openai-image']; // GLM：不支持 2K，边长上限 2048/32 倍数
const imagen = ENGINE_SIZE_CAPS['google-imagen']; // Imagen 4：支持 2K，官方固定表

test('resolveSize: 未指定 + 支持 2K 引擎 → 默认 2K（2560×1440）', () => {
  assert.equal(resolveSize(undefined, dashscope).size, '2560*1440');
  assert.equal(resolveSize('', imagen).size, '2560*1440');
  assert.equal(resolveSize('auto', dashscope).size, '2560*1440');
  assert.equal(resolveSize('best', imagen).size, '2560*1440');
  assert.deepEqual(DEFAULT_2K, { width: 2560, height: 1440 });
});

test('resolveSize: 未指定 + 不支持 2K 引擎 → 默认该引擎最大分辨率', () => {
  const r = resolveSize(undefined, openai);
  assert.equal(r.size, '2048*2048');
  assert.equal(r.note, undefined);
});

test('resolveSize: 未指定 + 无引擎信息（兜底）→ 保守 2048×2048', () => {
  assert.equal(resolveSize().size, '2048*2048');
  assert.equal(DEFAULT_BEST_SIZE.width, 2048);
});

test('resolveSize: 2.5K/2K 对支持 2K 引擎原样（3.69MP ≤ 上限）', () => {
  const r = resolveSize('2.5K', dashscope);
  assert.equal(r.size, '2560*1440');
  assert.equal(r.note, undefined);
  assert.ok(2560 * 1440 <= MAX_TOTAL_PIXELS);
  assert.equal(resolveSize('2k', dashscope).size, '2560*1440');
  assert.equal(resolveSize('QHD', dashscope).size, '2560*1440');
});

test('resolveSize: 2K 对 GLM（边长上限 2048）→ 按 16:9 降级 2048×1152 + note', () => {
  const r = resolveSize('2k', openai);
  assert.equal(r.size, '2048*1152');
  assert.ok(r.note.includes('边长上限 2048'));
  assert.equal(2048 % 32, 0);
  assert.equal(1152 % 32, 0);
});

test('resolveSize: 4K 超上限 → 按比例降级并给 note（不静默）', () => {
  const r = resolveSize('4K', dashscope);
  assert.equal(r.size, '2728*1536');
  assert.ok(r.note.includes('外部超分'));
  assert.ok(2728 * 1536 <= MAX_TOTAL_PIXELS, '钳制后必须不超上限');
  assert.ok(Math.abs(2728 / 1536 - 3840 / 2160) < 0.01, '保持宽高比');
});

test('resolveSize: 4K + Imagen（表上限 2816×1536）→ 钳制到 ≤4.32MP 保持比例', () => {
  const r = resolveSize('4K', imagen);
  assert.ok(r.size.includes('*'));
  const [w, h] = r.size.split('*').map(Number);
  assert.ok(w * h <= 2816 * 1536, '不超过 Imagen 最大像素');
  assert.ok(Math.abs(w / h - 3840 / 2160) < 0.02, '保持宽高比');
  assert.ok(r.note, '降级必须说明');
});

test('resolveSize: 数值 WxH 超限降级 + 未超限原样', () => {
  assert.equal(resolveSize('1024x1024', dashscope).size, '1024*1024');
  assert.equal(resolveSize('1024×1024', dashscope).size, '1024*1024');
  assert.equal(resolveSize('1024*1024', dashscope).size, '1024*1024');
  const over = resolveSize('3840x2160', dashscope);
  assert.equal(over.size, '2728*1536');
  assert.ok(over.note.includes('已按本引擎最大分辨率生成'), '降级必须说明最终生成分辨率');
});

test('resolveSize: 降级 note 告知"引擎不支持需求分辨率 + 最终分辨率 + 建议引擎"（GLM 2K）', () => {
  const r = resolveSize('2K', openai);
  assert.equal(r.size, '2048*1152');
  assert.ok(r.note.includes('该引擎不支持 2K'), '必须告知引擎不支持需求分辨率');
  assert.ok(r.note.includes('已按本引擎最大分辨率生成 2048×1152'), '必须告知最终生成分辨率');
  assert.ok(r.note.includes('Qwen') && r.note.includes('Imagen 4'), '必须建议支持该分辨率的引擎');
});

test('resolveSize: 4K 降级 note 说明常见引擎暂无原生支持', () => {
  const r = resolveSize('4K', dashscope);
  assert.equal(r.size, '2728*1536');
  assert.ok(r.note.includes('常见引擎暂无原生支持 4K'), '4K 应说明无常见引擎可直出');
  assert.ok(r.note.includes('外部超分'), '提示外部超分方案');
});

test('enginesSupporting: 2K 建议引擎包含 Qwen / Imagen 4；4K 无常见引擎', () => {
  const twoK = enginesSupporting(2560, 1440);
  assert.ok(twoK.some((n) => n.includes('Qwen')));
  assert.ok(twoK.some((n) => n.includes('Imagen 4')));
  const fourK = enginesSupporting(3840, 2160);
  assert.ok(!fourK.some((n) => n.includes('Qwen')), '常见引擎不支持 4K');
});

test('resolveSize: 高清/超清/1080P 词表', () => {
  assert.equal(resolveSize('1080P', dashscope).size, '1920*1080');
  assert.equal(resolveSize('高清', dashscope).size, '1920*1080');
  assert.equal(resolveSize('超清', dashscope).size, '2048*2048');
});

test('resolveSize: 无法识别原样返回（错误交给引擎可见）', () => {
  assert.equal(resolveSize('weird', dashscope).size, 'weird');
});

test('clampSize: 像素约束（qwen）不超限原样、超限保持比例且 8 对齐', () => {
  assert.deepEqual(clampSize(1024, 1024), [1024, 1024]);
  assert.deepEqual(clampSize(1, 1), [1, 1]);
  const [w, h] = clampSize(3840, 2160);
  assert.ok(w * h <= MAX_TOTAL_PIXELS);
  assert.equal(w % 8, 0);
  assert.equal(h % 8, 0);
});

test('clampSize: 边长约束（GLM）每边 ≤2048 且 32 对齐', () => {
  assert.deepEqual(clampSize(1024, 1024, openai), [1024, 1024]);
  const [w, h] = clampSize(2560, 1440, openai);
  assert.equal(w, 2048);
  assert.equal(h, 1152);
  assert.ok(w <= 2048 && h <= 2048);
  assert.equal(w % 32, 0);
  assert.equal(h % 32, 0);
  const ratio = 2560 / 1440;
  assert.ok(Math.abs(w / h - ratio) < 0.01);
});
