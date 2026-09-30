import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    renderTemplateRequest,
    getByPath,
    isImageLike,
    findImagePaths,
    normalizeImageValue,
    extractGeneratedImages,
    extractReadContent,
    inferReadRequestTemplate,
    inferGenRequestTemplate,
    inferReadContentPath,
    inferGenImagePaths,
    buildRequestTemplate,
} from '../src/request-template.js';

test('renderTemplateRequest: 占位符替换（字符串/数字/布尔保留）', () => {
    const template = {
        url: '{{BASE_URL}}/chat/completions',
        method: 'POST',
        headers: { Authorization: 'Bearer {{API_KEY}}', 'Content-Type': 'application/json' },
        body: {
            model: '{{MODEL}}',
            messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: '{{IMAGE1}}' } }, { type: 'text', text: '{{PROMPT}}' }] }],
            max_tokens: 512,
            stream: false,
        },
    };
    const r = renderTemplateRequest(template, {
        baseUrl: 'https://api.example.com/v1/', // 尾部斜杠应去掉
        apiKey: 'sk-test',
        model: 'vision-pro',
        prompt: '描述这张图片',
        images: ['data:image/png;base64,AAAA'],
        size: '1024x1024',
        count: 2,
    });
    assert.equal(r.url, 'https://api.example.com/v1/chat/completions');
    assert.equal(r.headers.Authorization, 'Bearer sk-test');
    const body = JSON.parse(r.body);
    assert.equal(body.model, 'vision-pro');
    assert.equal(body.messages[0].content[0].image_url.url, 'data:image/png;base64,AAAA');
    assert.equal(body.messages[0].content[1].text, '描述这张图片');
    assert.equal(body.max_tokens, 512);
    assert.equal(body.stream, false);
});

test('renderTemplateRequest: 多图占位符 IMAGE1/2/3', () => {
    const template = { url: '{{BASE_URL}}/go', headers: {}, body: { images: ['{{IMAGE1}}', '{{IMAGE2}}', '{{IMAGE3}}'] } };
    const r = renderTemplateRequest(template, { baseUrl: 'https://x.io', apiKey: 'k', model: 'm', prompt: 'p', images: ['a', 'b'], size: '', count: 1 });
    const body = JSON.parse(r.body);
    assert.deepEqual(body.images, ['a', 'b', '']);
});

test('getByPath / isImageLike / findImagePaths', () => {
    const payload = { data: [{ url: 'https://cdn.x/img.png', b64: null }, { b64_json: 'aGVsbG8x'.repeat(15) }] };
    assert.equal(getByPath(payload, 'data.0.url'), 'https://cdn.x/img.png');
    assert.equal(getByPath(payload, 'data.1.b64_json'), 'aGVsbG8x'.repeat(15));
    assert.equal(getByPath(payload, 'data.9.url'), undefined);
    assert.ok(isImageLike('data:image/png;base64,AAAA'));
    assert.ok(isImageLike('https://a.b/c.png?x=1'));
    assert.ok(isImageLike('a'.repeat(100)));
    assert.ok(!isImageLike('hello world'));
    const found = findImagePaths(payload);
    assert.equal(found.length, 2);
});

test('extractGeneratedImages: 数组路径 / 对象路径 / 同级数组展开 / base64 规范化', () => {
    const p1 = { data: [{ url: 'https://cdn.x/a.png' }, { url: 'https://cdn.x/b.png' }] };
    const out1 = extractGeneratedImages(p1, ['data.0.url']);
    assert.deepEqual(out1, ['https://cdn.x/a.png', 'https://cdn.x/b.png']);
    const p2 = { data: [{ b64_json: 'YWJjZGVmZ3g'.repeat(15) }] };
    const out2 = extractGeneratedImages(p2, ['data.0.b64_json']);
    assert.deepEqual(out2, ['data:image/png;base64,' + 'YWJjZGVmZ3g'.repeat(15)]);
    const p3 = { result: { images: ['https://cdn.x/c.png'] } };
    const out3 = extractGeneratedImages(p3, ['result.images']);
    assert.deepEqual(out3, ['https://cdn.x/c.png']);
    const out4 = extractGeneratedImages(p1, ['data.9.url']);
    assert.deepEqual(out4, []);
});

test('extractReadContent: 字符串 / part 数组 / 对象', () => {
    assert.equal(extractReadContent({ choices: [{ message: { content: '你好' } }] }, 'choices.0.message.content'), '你好');
    assert.equal(extractReadContent({ choices: [{ message: { content: [{ text: 'a' }, { text: 'b' }] } }] }, 'choices.0.message.content'), 'ab');
    assert.equal(extractReadContent({ choices: [{ message: { content: '' } }] }, 'choices.0.message.content'), null);
    const obj = extractReadContent({ out: { x: { a: 1 } } }, 'out.x');
    assert.ok(typeof obj === 'string' && obj.includes('a'));
    assert.equal(extractReadContent({ a: 1 }, 'nonexistent'), null);
});

test('inferReadRequestTemplate: 官方示例 → 模板（OpenAI 风格）', () => {
    const sample = {
        url: 'https://api.example.com/chat/completions',
        method: 'POST',
        headers: { Authorization: 'Bearer sk-real', 'Content-Type': 'application/json' },
        body: {
            model: 'vision-pro',
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' } },
                        { type: 'text', text: '请详细描述这张图片中的内容' },
                    ],
                },
            ],
            max_tokens: 512,
        },
    };
    const t = inferReadRequestTemplate(sample);
    assert.ok(t, '应推断出模板');
    assert.equal(t.url, '{{BASE_URL}}/chat/completions');
    assert.equal(t.headers.Authorization, 'Bearer {{API_KEY}}');
    const body = t.body;
    assert.equal(body.model, '{{MODEL}}');
    const content = body.messages[0].content;
    assert.equal(content[0].image_url.url, '{{IMAGE1}}');
    assert.equal(content[1].text, '{{PROMPT}}');
    assert.equal(body.max_tokens, 512);
});

test('inferGenRequestTemplate: 官方示例 → 模板（size/count/image）', () => {
    const sample = {
        url: 'https://api.example.com/images/generations',
        headers: { Authorization: 'Bearer sk-real' },
        body: {
            model: 'image-pro',
            prompt: '一只在草地上奔跑的金毛犬，阳光明媚',
            size: '1024x1024',
            n: 2,
            image: 'https://cdn.example.com/ref.png',
        },
    };
    const t = inferGenRequestTemplate(sample);
    assert.ok(t);
    assert.equal(t.url, '{{BASE_URL}}/images/generations');
    assert.equal(t.headers.Authorization, 'Bearer {{API_KEY}}');
    assert.equal(t.body.model, '{{MODEL}}');
    assert.equal(t.body.prompt, '{{PROMPT}}');
    assert.equal(t.body.size, '{{SIZE}}');
    assert.equal(t.body.n, '{{COUNT}}');
    assert.equal(t.body.image, '{{IMAGE1}}');
});

test('inferReadContentPath / inferGenImagePaths', () => {
    const readResp = { choices: [{ message: { content: '结构化结果 JSON...' } }], id: 'x' };
    assert.equal(inferReadContentPath(readResp), 'choices.0.message.content');
    const genResp = { data: [{ url: 'https://cdn.x/a.png' }, { url: 'https://cdn.x/b.png' }] };
    const paths = inferGenImagePaths(genResp);
    assert.ok(paths.length >= 1);
    assert.equal(paths[0], 'data.0.url');
    const out = extractGeneratedImages(genResp, paths);
    assert.deepEqual(out, ['https://cdn.x/a.png', 'https://cdn.x/b.png']);
});

test('buildRequestTemplate: 合并 read/generate/extract', () => {
    const t = buildRequestTemplate({
        read: { url: '{{BASE_URL}}/a', method: 'POST', headers: {}, body: {} },
        generate: { url: '{{BASE_URL}}/b', method: 'POST', headers: {}, body: {} },
        extract: { read: 'choices.0.message.content', generate: ['data.0.url'] },
    });
    assert.equal(t.enabled, true);
    assert.ok(t.read && t.generate);
    assert.deepEqual(t.extract, { read: { content: 'choices.0.message.content' }, generate: { images: ['data.0.url'] } });
});

test('renderTemplateRequest: {{SIZE_X}} / {{SIZE_STAR}} / {{SIZE}} 三种尺寸格式', () => {
    const template = {
        url: '{{BASE_URL}}/gen',
        method: 'POST',
        headers: {},
        body: { size_x: '{{SIZE_X}}', size_star: '{{SIZE_STAR}}', size_raw: '{{SIZE}}' },
    };
    const r = renderTemplateRequest(template, { baseUrl: 'https://x.io', apiKey: 'k', model: 'm', prompt: 'p', size: '1024*768', count: 1 });
    const body = JSON.parse(r.body);
    assert.equal(body.size_x, '1024x768', 'SIZE_X 输出 x 格式');
    assert.equal(body.size_star, '1024*768', 'SIZE_STAR 输出 * 格式');
    assert.equal(body.size_raw, '1024*768', 'SIZE 保留内部原文');
});

test('renderTemplateRequest: 数字类型保真——整节点数字占位符渲染为数字', () => {
    const template = { url: '{{BASE_URL}}/gen', method: 'POST', headers: {}, body: { n: '{{COUNT}}', size: '{{SIZE_X}}' } };
    const r = renderTemplateRequest(template, { baseUrl: 'https://x.io', apiKey: 'k', model: 'm', prompt: 'p', size: '1024x768', count: 3 });
    const body = JSON.parse(r.body);
    assert.equal(typeof body.n, 'number', '{{COUNT}} 整节点应为数字');
    assert.equal(body.n, 3);
    assert.equal(typeof body.size, 'string', '{{SIZE_X}} 非纯数字 → 保持字符串');
    assert.equal(body.size, '1024x768');
    // 非整节点占位符（嵌在文本里）仍为字符串替换
    const t2 = { url: '{{BASE_URL}}/gen', method: 'POST', headers: {}, body: { label: 'x{{COUNT}}y' } };
    const r2 = renderTemplateRequest(t2, { baseUrl: 'https://x.io', apiKey: 'k', model: 'm', prompt: 'p', size: '', count: 2 });
    assert.equal(JSON.parse(r2.body).label, 'x2y');
});

test('renderTemplateRequest: 缺 url 时报错带模板段名', () => {
    assert.throws(
        () => renderTemplateRequest({ url: '', method: 'POST', headers: {}, body: {} }, { baseUrl: 'https://x.io', apiKey: 'k', label: '生图' }),
        /生图模板缺少 url/,
    );
});
