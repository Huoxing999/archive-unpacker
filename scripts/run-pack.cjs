// 用 Node 捕获 electron-builder 输出，避开 PowerShell 的编码转换问题
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const r = spawnSync('npx.cmd', ['electron-builder', '--win', 'portable', '--x64'], {
  encoding: 'buffer',
  shell: true,
  cwd: root,
  env: {
    ...process.env,
    ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/',
    ELECTRON_BUILDER_BINARIES_MIRROR: 'https://npmmirror.com/mirrors/electron-builder-binaries/',
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
  },
  maxBuffer: 128 * 1024 * 1024,
});

// 先按 utf8 解，失败再按 gbk 兜底（只影响中文，ASCII 错误信息两种都能读）
const dec = (buf) => {
  if (!buf || buf.length === 0) return '(empty)';
  const s = buf.toString('utf8');
  return s.includes('\ufffd') ? buf.toString('latin1') : s;
};

const out = [
  `EXIT=${r.status} SIGNAL=${r.signal || 'none'}`,
  '',
  '=== STDOUT ===',
  dec(r.stdout).slice(-8000),
  '',
  '=== STDERR ===',
  dec(r.stderr).slice(-8000),
].join('\n');

fs.writeFileSync(path.join(root, 'pack3.log'), out, 'utf8');
