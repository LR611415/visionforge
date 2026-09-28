const fs = require('fs');
const f = 'D:/DSH-desktop/DSH Desktop/resources/app/lib/client.js';
const src = fs.readFileSync(f, 'utf8');
const keys = ['file://', 'openWith', 'open-with', 'shell.open', 'markdown', 'react-markdown', '/visionforge', 'modlens', '放大', 'zoom', 'enlarge', 'onImageClick', 'imageClick', 'download', '侧边栏', 'external'];
for (const k of keys) {
  let i = 0, n = 0;
  const samples = [];
  while ((i = src.indexOf(k, i)) !== -1 && n < 3) {
    const a = Math.max(0, i - 150), b = Math.min(src.length, i + k.length + 250);
    samples.push(src.slice(a, b).replace(/\s+/g, ' '));
    i += k.length;
    n++;
  }
  console.log('=== ' + k + ' (count>=3 sampled) ===');
  if (n === 0) console.log('(none)');
  else samples.forEach((s, idx) => console.log('[' + idx + '] …' + s + '…'));
}
