/**
 * 把最新 dist/ + src/renderer 三件套重打进 win-unpacked 的 app.asar。
 *
 * 背景：M5170 / S910S8 修复后只编译了 dist、没有重新打包，桌面快捷方式跑的
 * 目录版 exe 一直是旧逻辑（M5164 由此没触发搬运）。完整 electron-builder
 * 打包又慢又容易踩沙盒删除拦截 —— 其实 exe 根本没变，只有 asar 里的 JS 变了。
 *
 * 用法：npm run sync:asar
 *   0. 先关掉正在运行的程序；最好先 npm run build（本脚本不代跑，fail-fast 防呆）
 *   1. 解包现有 asar（保留 electron-builder 生成的精简 package.json 等结构）
 *   2. 覆盖 dist/ 全部产物 + src/renderer/{index.html,renderer.ts,styles.css}
 *   3. 重打 asar → 备份旧包到 %TEMP%\app.asar.bak-<时间戳> → 替换
 *   4. 回读验证：新包里能搜到 dist/main.js 的特征串才算成功
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const asar = require('@electron/asar');

const ROOT = path.resolve(__dirname, '..');
const asarPath = path.join(ROOT, 'release', 'win-unpacked', 'resources', 'app.asar');
const distMain = path.join(ROOT, 'dist', 'main.js');

if (!fs.existsSync(asarPath)) {
  console.error('找不到 ' + asarPath + '（先跑一次完整打包生成 win-unpacked）');
  process.exit(2);
}
if (!fs.existsSync(distMain)) {
  console.error('dist/main.js 不存在 —— 先 npm run build 再来同步。');
  process.exit(2);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const staging = path.join(os.tmpdir(), `au-asar-src-${stamp}`);
const newAsar = path.join(os.tmpdir(), `au-asar-new-${stamp}.asar`);
const backup = `${asarPath}.bak-${stamp}`;

(async () => {
try {
  console.log('1/4 解包现有 asar ...');
  await asar.extractAll(asarPath, staging);

  console.log('2/4 覆盖最新产物（dist/ + src/renderer 三件套）...');
  fs.rmSync(path.join(staging, 'dist'), { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, 'dist'), path.join(staging, 'dist'), { recursive: true });
  for (const f of ['index.html', 'renderer.ts', 'styles.css']) {
    fs.cpSync(path.join(ROOT, 'src', 'renderer', f), path.join(staging, 'src', 'renderer', f));
  }

  console.log('3/4 重打 asar ...');
  await asar.createPackage(staging, newAsar);

  const fresh = fs.readFileSync(newAsar);
  const probe = fs.readFileSync(distMain).toString('utf-8').slice(0, 2000).trim().slice(0, 60);
  if (!fresh.includes(Buffer.from(probe, 'utf-8'))) {
    throw new Error('新 asar 里搜不到 dist/main.js 开头内容，疑似打包错位，已放弃替换');
  }

  fs.copyFileSync(asarPath, backup);
  fs.copyFileSync(newAsar, asarPath);
  console.log('4/4 已替换: ' + asarPath);
  console.log('   旧包备份: ' + backup);
  console.log('完成。桌面快捷方式下次启动就是新逻辑。');
} catch (error) {
  console.error('同步失败：' + (error && error.message ? error.message : error));
  console.error('提示：程序正在运行会锁住 asar，先关掉程序再试。');
  process.exit(1);
} finally {
  for (const p of [staging, newAsar]) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* 收尾失败可忽略 */ }
  }
}
})();
