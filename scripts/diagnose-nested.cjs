/**
 * 诊断「为什么这个目录没有再往下解压」。
 *
 * 把真实的 analyzeNestedArchives 跑在你指定的目录上，原样打印判定过程：
 * 扫描到什么、算出什么候选、follow 了谁、跳过了谁、为什么停。
 *
 * 用法：
 *   npm run diagnose -- "F:\yscs\202692S3\692S3.7z\3\2026S92S3"
 *   npm run diagnose -- "目录" [刚解出的文件数] [阈值] [深度]
 *
 * 参数默认值：文件数 1、阈值 3、深度 0（即"最外层刚解出一个文件"的常见情况）。
 * 只读取，不改动任何文件（7-Zip 只做 l / t 列清单）。
 */

const Module = require('module');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const handlers = new Map();

const stubWindow = () => ({
  webContents: { send: () => undefined },
  isDestroyed: () => false,
  loadFile: () => undefined,
  once: () => undefined,
  on: () => undefined,
  show: () => undefined,
});

const StubBrowserWindow = function () {
  return stubWindow();
};
StubBrowserWindow.getAllWindows = () => [stubWindow()];

const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') {
    return {
      app: {
        whenReady: () => Promise.resolve(),
        on: () => undefined,
        setAppUserModelId: () => undefined,
        getPath: () => os.homedir(),
        quit: () => undefined,
      },
      BrowserWindow: StubBrowserWindow,
      dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
      ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
      shell: { showItemInFolder: () => undefined, openPath: async () => '' },
    };
  }
  return originalLoad.apply(this, arguments);
};

const mainJs = path.join(ROOT, 'dist', 'main.js');
const mainSrc = path.join(ROOT, 'src', 'main', 'main.ts');

if (!fs.existsSync(mainJs)) {
  console.error('还没编译。先跑一次：npm run build');
  process.exit(2);
}
if (fs.existsSync(mainSrc) && fs.statSync(mainSrc).mtimeMs > fs.statSync(mainJs).mtimeMs) {
  console.error('警告：src/main/main.ts 比 dist/main.js 新，诊断结果可能不是最新代码。先跑 npm run build。\n');
}

require(mainJs);

/** 和界面里保持一致：伪装后缀存在 localStorage 里，这里直接把常见值列出来 */
const DISGUISED = (process.env.AU_DISGUISED ?? 'png,mp4,jpg,pdf,tif,xls,gif')
  .split(',')
  .map((v) => v.trim().toLowerCase())
  .filter(Boolean);

const folder = process.argv[2];
const parentFileCount = Number(process.argv[3] ?? '1');
const threshold = Number(process.argv[4] ?? '3');
const depth = Number(process.argv[5] ?? '0');

if (!folder) {
  console.error('用法：npm run diagnose -- "<解压输出目录>" [文件数] [阈值] [深度]');
  process.exit(2);
}

(async () => {
  await new Promise((resolve) => setTimeout(resolve, 60));

  const analyzeNested = handlers.get('analyze-nested');
  const scanFolder = handlers.get('scan-folder');
  if (typeof analyzeNested !== 'function' || typeof scanFolder !== 'function') {
    console.error('没能从 dist/main.js 抓到 handler，先跑 npm run build。');
    process.exit(1);
  }

  console.log('目录            :', path.resolve(folder));
  console.log('刚解出的文件数  :', parentFileCount);
  console.log('阈值            :', threshold);
  console.log('深度            :', depth);
  console.log('伪装后缀        :', DISGUISED.join(', '));

  const listed = await scanFolder(null, {
    folder,
    recursive: true,
    disguisedExtensions: DISGUISED,
    verifyWith7z: true,
    strictDisguised: true,
  });

  console.log('\n--- 严格扫描（7-Zip 逐个判定） ---');
  console.log('7-Zip 校验      :', listed.used7zVerify ? '已启用' : '不可用');
  if (listed.error) console.log('错误            :', listed.error);
  console.log(
    '认出来的压缩包  :',
    listed.archives.map((a) => `${a.name}${a.disguised ? '（伪装后缀）' : ''}`).join('、') || '(无)',
  );
  console.log('判定为非压缩包  :', listed.rejected.join('、') || '(无)');

  const decision = await analyzeNested(null, {
    folder,
    disguisedExtensions: DISGUISED,
    parentPath: path.join(path.resolve(folder), '..', 'parent.7z'),
    depth,
    parentFileCount,
    fileThreshold: threshold,
    sevenZipPath: process.env.AU_SEVENZIP || null,
  });

  console.log('\n--- 最终判定 ---');
  if (decision.stopReason) console.log('收手原因        :', decision.stopReason);
  for (const note of decision.notes ?? []) console.log('说明            :', note);
  console.log('会继续解的包    :', decision.follow.map((a) => a.name).join('、') || '(无)');
  if (decision.skipped.length > 0) {
    console.log('跳过            :');
    for (const item of decision.skipped) console.log(`   - ${item.name} :: ${item.reason}`);
  }

  if (decision.follow.length === 0 && !decision.stopReason && decision.skipped.length === 0) {
    console.log('\n提示：这个目录里没有任何可继续解压的包 —— 也就是正常内容，不该再往下解。');
  }
})();
