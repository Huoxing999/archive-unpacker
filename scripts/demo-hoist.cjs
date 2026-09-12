/**
 * 场景演示：在临时沙盒里造一条套壳链，跑一遍「解到头 → 搬成品 → 清空壳」。
 *
 * 不需要启动 Electron：把 electron 换成桩，加载已编译的 dist/main.js，
 * 直接调真实的 analyze-nested / hoist-finished 两个 IPC handler。
 *
 * 造的场景（对应真实路径 F:\yscs\mAVX7\mAVX7.part1\CxmXg\Zhpuw\BARE＆BUNNY）：
 *   yscs/mAVX7/mAVX7.part1/CxmXg/Zhpuw/BARE＆BUNNY/{01.mp4, 02.mp4, sub/readme.txt}
 * 预期：BARE＆BUNNY 有 3 项 → 判为成品 → 搬到 yscs 下 → 4 层空壳全清掉 → mAVX7 消失。
 *
 * 用法：npm run demo:hoist   （需先 npm run build）
 */

const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');

const handlers = new Map();
const stub = {
  app: {
    whenReady: () => Promise.resolve(),
    on: () => undefined,
    setAppUserModelId: () => undefined,
    getPath: () => os.homedir(),
    quit: () => undefined,
  },
  BrowserWindow: function StubBrowserWindow() {
    return {
      webContents: { send: () => undefined },
      isDestroyed: () => false,
      loadFile: () => undefined,
      once: () => undefined,
      on: () => undefined,
      show: () => undefined,
    };
  },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on: () => undefined },
  shell: { showItemInFolder: () => undefined, openPath: async () => '' },
};
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'electron') return stub;
  return origLoad.apply(this, arguments);
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hoist-demo-'));
const yscs = path.join(root, 'yscs');
const chain = path.join(yscs, 'mAVX7', 'mAVX7.part1', 'CxmXg', 'Zhpuw');
const finished = path.join(chain, 'BARE＆BUNNY');
fs.mkdirSync(finished, { recursive: true });
fs.writeFileSync(path.join(finished, '01.mp4'), 'a');
fs.writeFileSync(path.join(finished, '02.mp4'), 'b');
fs.mkdirSync(path.join(finished, 'sub'), { recursive: true });
fs.writeFileSync(path.join(finished, 'sub', 'readme.txt'), 'c');

function tree(dir) {
  const out = [path.basename(dir) + '/'];
  const walk = (d, p) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      out.push(p + e.name + (e.isDirectory() ? '/' : ''));
      if (e.isDirectory()) walk(path.join(d, e.name), p + '  ');
    }
  };
  walk(dir, '  ');
  return out.join('\n');
}

(async () => {
  require(path.resolve(__dirname, '..', 'dist', 'main.js'));
  await new Promise((r) => setTimeout(r, 80));
  const hoist = handlers.get('hoist-finished');
  const analyze = handlers.get('analyze-nested');

  console.log('【解压前】\n' + tree(yscs) + '\n');

  const an = await analyze({}, {
    folder: chain,
    disguisedExtensions: ['png', 'mp4', 'jpg', 'pdf', 'tif'],
    parentPath: path.join(yscs, 'mAVX7.7z'),
    depth: 4,
    parentFileCount: 1,
    fileThreshold: 3,
    sevenZipPath: null,
  });
  console.log('【判定】finishedFolder =', an.finishedFolder ? path.relative(root, an.finishedFolder) : '(空)');
  console.log('        notes =', JSON.stringify(an.notes));
  console.log('        follow 数 =', an.follow.length, '/ skipped 数 =', an.skipped.length);

  const res = await hoist({}, { folder: an.finishedFolder, targetRoot: yscs });
  console.log('\n【搬移】ok =', res.ok);
  console.log('       movedFrom   =', res.movedFrom && path.relative(root, res.movedFrom));
  console.log('       movedTo     =', res.movedTo && path.relative(root, res.movedTo));
  console.log('       removedDirs =', res.removedDirs.map((d) => path.basename(d)).join(' ← '));
  console.log('       keptDirs    =', res.keptDirs.map((d) => path.basename(d)).join('、') || '(无)');

  console.log('\n【搬移后】\n' + tree(yscs));
  console.log('\n【外壳 mAVX7 是否还在】', fs.existsSync(path.join(yscs, 'mAVX7')));

  fs.rmSync(root, { recursive: true, force: true });
  process.exit(0);
})();
