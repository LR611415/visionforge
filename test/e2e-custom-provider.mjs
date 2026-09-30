// 实测：模拟首次安装后"新增引擎（只填名称）→ 主保存 → 引擎Summary返回 → 再次更新"
// 安全：先备份 config.json，测完恢复。
import { applySettings, engineSummary, readConfig, configPath } from 'file:///C:/Users/李/Desktop/VisionForge/dsh/index.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const cfg = configPath();
const bak = path.join(os.homedir(), '.visionforge', '__vf-e2e-backup.json');
fs.copyFileSync(cfg, bak);
console.log('备份:', cfg, '->', bak);

let failed = false;
const ok = (name, cond, extra = '') => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' | ' + extra : '')); if (!cond) failed = true };

try {
  // 1) 模拟"只填名称后主保存"：新增自定义引擎 google-test（openai-compatible 推断）
  applySettings({ engine: 'google-test', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'gemini-3.1', apiKey: 'sk-test-123', visionPriority: 'official' });
  let c = readConfig();
  ok('新增：customProviders 有 google-test', c.customProviders && !!c.customProviders['google-test']);
  const g = c.customProviders?.['google-test'];
  ok('新增：displayName', g && g.displayName === 'google-test');
  ok('新增：baseUrl', g && g.baseUrl === 'https://dashscope.aliyuncs.com/compatible-mode/v1');
  ok('新增：readFamily=openai-compatible', g && g.readFamily === 'openai-compatible', JSON.stringify(g && g.readFamily));
  ok('新增：model', g && g.model === 'gemini-3.1');
  ok('新增：apiKey', g && g.apiKey === 'sk-test-123');
  ok('新增：provider 切到 google-test', c.provider === 'google-test');
  ok('新增：models[0] read 能力', Array.isArray(g.models) && g.models[0] && g.models[0].capabilities.read === true);

  // 2) engineSummary 返回
  const sum = engineSummary();
  ok('engineSummary：engines 含 google-test', sum.engines && !!sum.engines['google-test']);
  ok('engineSummary：hasKey=true', sum.engines?.['google-test']?.hasKey === true);
  ok('engineSummary：customs 含 google-test', Array.isArray(sum.customs) && sum.customs.some((x) => x.id === 'google-test'));

  // 3) 更新：换模型（模拟下拉选中后改字段再保存）
  applySettings({ engine: 'google-test', model: 'gemini-3.2' });
  c = readConfig();
  ok('更新：model 变为 gemini-3.2', c.customProviders?.['google-test']?.model === 'gemini-3.2');
  ok('更新：baseUrl 未丢失', c.customProviders?.['google-test']?.baseUrl === 'https://dashscope.aliyuncs.com/compatible-mode/v1');
  ok('更新：apiKey 未丢失', c.customProviders?.['google-test']?.apiKey === 'sk-test-123');

  // 4) 内置引擎保存仍正常
  applySettings({ engine: 'qwen', model: 'qwen3.8-max' });
  c = readConfig();
  ok('内置 qwen 仍可保存', c.providers?.qwen?.model === 'qwen3.8-max');
} catch (e) {
  console.log('EXCEPTION:', e && e.message);
  failed = true;
} finally {
  fs.copyFileSync(bak, cfg);
  console.log('已恢复 config.json（测试改动已回滚）');
}

console.log(failed ? 'E2E_FAILED' : 'E2E_ALL_PASS');
