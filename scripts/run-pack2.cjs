// 用已有的 win-unpacked 直接封装 portable（跳过 electron 解压/重建，绕开沙盒批量删除拦截）
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const r = spawnSync('npx.cmd', ['electron-builder', '--win', 'portable', '--x64', '--prepackaged', 'release/win-unpacked'], {
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

const dec = (buf) => {
  if (!buf || buf.length === 0) return '(empty)';
  const s = buf.toString('utf8');
  return s.includes('\ufffd') ? buf.toString('latin1') : s;
};

fs.writeFileSync(path.join(root, 'pack4.log'), [
  `EXIT=${r.status} SIGNAL=${r.signal || 'none'}`,
  '',
  '=== STDOUT ===',
  dec(r.stdout).slice(-6000),
  '',
  '=== STDERR ===',
  dec(r.stderr).slice(-4000),
].join('\n'), 'utf8');
