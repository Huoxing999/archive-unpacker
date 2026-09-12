// 列出 win-unpacked 里 app.asar 的打包内容，确认运行时需要的文件都在
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const asarPath = path.join(root, 'release', 'win-unpacked', 'resources', 'app.asar');
const out = [];

if (!fs.existsSync(asarPath)) {
  out.push(`app.asar MISSING at ${asarPath}`);
} else {
  out.push(`app.asar: ${(fs.statSync(asarPath).size / 1024).toFixed(1)} KB`);
  try {
    const asar = require('@electron/asar');
    const files = asar.listPackage(asarPath);
    out.push(`entries: ${files.length}`);
    const need = [
      '/dist/main.js',
      '/dist/preload.js',
      '/dist/renderer/renderer.js',
      '/src/renderer/index.html',
      '/src/renderer/styles.css',
      '/build/icon.ico',
      '/package.json',
    ];
    for (const n of need) {
      const hit = files.some((f) => f.replace(/\\/g, '/') === n);
      out.push(`${hit ? 'OK  ' : 'MISS'} ${n}`);
    }
    out.push('--- first 25 entries ---');
    out.push(...files.slice(0, 25));
  } catch (e) {
    out.push(`asar read failed: ${e.message}`);
  }
}

fs.writeFileSync(path.join(root, '_asar_check.txt'), out.join('\n'), 'utf8');
