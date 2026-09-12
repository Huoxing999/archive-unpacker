/**
 * 端到端验证脚本（不需要启动 Electron）。
 *
 * 做法：把 electron 模块替换成桩，加载已编译的 dist/main.js，
 * 抓出 ipcMain 注册的 handler 直接调用，用真实文件 + 真实 7-Zip 跑一遍。
 *
 * 覆盖：
 *   1. 解压文件数统计 —— 从 7z x 收尾统计里取 Files: N
 *   2. 嵌套解压判定 —— 文件数未超阈值才继续解
 *   3. 阈值可配置 —— 同一个目录，改阈值结果就变
 *   4. 正常文件永不被碰 —— jpg/pdf/mp4 被 7-Zip 挡掉；伪装后缀即使是真包也不自动追
 *   5. 层数护栏 —— 到内部上限就收手
 *   6. 解压成功后才改名 —— 误判的正常文件失败后保持原文件名
 *   7. 解压后删除源压缩包 —— 成功才删 / 关闭保留 / 失败不删 / 分卷一起删
 *   8. 进度上报 —— extract-progress 事件单调递增
 *   9. 前置数据剥离 —— 拼了视频的伪装包先剥前缀再解压
 *  10. 定位接口 —— 文件在就选中，不在就打开所在目录
 *
 * 用法：node scripts/verify-depth.cjs   （或 npm run verify）
 */

const Module = require('module');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SEVENZIP = 'C:\\Program Files\\7-Zip\\7z.exe';

/* ---------------- electron 桩 ---------------- */

const sentEvents = [];
const handlers = new Map();

const fakeWebContents = {
  send: (channel, payload) => sentEvents.push({ channel, payload }),
};

function createStubWindow() {
  return {
    webContents: fakeWebContents,
    isDestroyed: () => false,
    loadFile: () => undefined,
    once: () => undefined,
    on: () => undefined,
    show: () => undefined,
  };
}

function StubBrowserWindow() {
  return createStubWindow();
}
StubBrowserWindow.getAllWindows = () => [createStubWindow()];

const electronStub = {
  app: {
    whenReady: () => Promise.resolve(),
    on: () => undefined,
    setAppUserModelId: () => undefined,
    getPath: () => os.homedir(),
    quit: () => undefined,
  },
  BrowserWindow: StubBrowserWindow,
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  },
  ipcMain: {
    handle: (channel, fn) => handlers.set(channel, fn),
  },
  shell: {
    showItemInFolder: () => undefined,
    openPath: async () => '',
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request) {
  if (request === 'electron') return electronStub;
  return originalLoad.apply(this, arguments);
};

require(path.join(ROOT, 'dist', 'main.js'));

/* ---------------- 断言工具 ---------------- */

let passed = 0;
const failures = [];

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  \u2713 ${label}`);
  } else {
    failures.push(`${label}${detail ? ` \u2014 ${detail}` : ''}`);
    console.log(`  \u2717 ${label}${detail ? ` \u2014 ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

function names(archives) {
  return archives.map((archive) => archive.name).sort();
}

/* ---------------- 夹具工具 ---------------- */

const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]),
  Buffer.alloc(600, 0x7a),
  Buffer.from([0xff, 0xd9]),
]);

const PDF = Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n%%EOF\n`);

function sevenZip(args, cwd) {
  return execFileSync(SEVENZIP, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

function makeZip(zipPath, entries, cwd) {
  sevenZip(['a', '-tzip', zipPath, ...entries], cwd);
  return requireArchive(zipPath, cwd, 'zip');
}

function make7z(archivePath, entries, cwd) {
  sevenZip(['a', '-t7z', archivePath, ...entries], cwd);
  return requireArchive(archivePath, cwd, '7z');
}

/** 7-Zip 的工作目录是 cwd，相对路径要拼回 cwd 才检查得到 */
function requireArchive(archivePath, cwd, kind) {
  const resolved = path.isAbsolute(archivePath) ? archivePath : path.join(cwd, archivePath);
  if (!fs.existsSync(resolved)) throw new Error(`创建 ${kind} 失败：${resolved}`);
  return resolved;
}

function randomBytes(size) {
  return crypto.randomBytes(size);
}

/** 造一个「里面有一个真压缩包 + 一堆正常文件」的目录，模拟解压完的输出 */
function buildExtractedOutput(root) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'photo.jpg'), JPEG);
  fs.writeFileSync(path.join(root, 'doc.pdf'), PDF);
  fs.writeFileSync(path.join(root, 'clip.mp4'), randomBytes(4096));
  fs.writeFileSync(path.join(root, 'readme.txt'), 'normal file');

  const seed = path.join(root, '_seed');
  fs.mkdirSync(seed, { recursive: true });
  fs.writeFileSync(path.join(seed, 'inner.txt'), 'nested payload');
  makeZip(path.join(root, 'inner.zip'), ['inner.txt'], seed);
  fs.rmSync(seed, { recursive: true, force: true });

  return root;
}

function analyzeRequest(folder, overrides) {
  return {
    folder,
    disguisedExtensions: ['jpg', 'pdf', 'mp4', 'png'],
    parentPath: path.join(folder, '..', 'parent.zip'),
    depth: 0,
    parentFileCount: 1,
    fileThreshold: 3,
    sevenZipPath: SEVENZIP,
    ...overrides,
  };
}

/* ---------------- LZ4 夹具 ----------------
 * 手拼一个合法的 LZ4 帧（用「未压缩块」），校验和按规范算。
 * 7-Zip 解不开 lz4，所以这里必须自己造，也正好证明我们解的是真格式。
 */

const lz4 = require(path.join(ROOT, 'dist', 'lz4.js'));

function xxh32(buffer) {
  const hash = new lz4.XxHash32();
  hash.update(buffer);
  return hash.digest();
}

function lz4Frame(payload) {
  // FLG=0x6C：版本1 + 块独立 + 带内容大小 + 带内容校验和；BD=0x70：块上限 4MB
  const sizeField = Buffer.alloc(8);
  sizeField.writeBigUInt64LE(BigInt(payload.length));
  const headerBody = Buffer.concat([Buffer.from([0x6c, 0x70]), sizeField]);

  const parts = [
    Buffer.from([0x04, 0x22, 0x4d, 0x18]),
    headerBody,
    Buffer.from([(xxh32(headerBody) >>> 8) & 0xff]),
  ];

  const CHUNK = 4 * 1024 * 1024;
  for (let offset = 0; offset < payload.length; offset += CHUNK) {
    const slice = payload.subarray(offset, Math.min(offset + CHUNK, payload.length));
    const size = Buffer.alloc(4);
    size.writeUInt32LE((0x80000000 | slice.length) >>> 0);
    parts.push(size, slice);
  }

  parts.push(Buffer.from([0, 0, 0, 0])); // EndMark
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32LE(xxh32(payload));
  parts.push(checksum);

  return Buffer.concat(parts);
}

function makeLz4(lz4Path, payload) {
  fs.writeFileSync(lz4Path, lz4Frame(payload));
  return lz4Path;
}

/**
 * 造一个加密 zip（用错误的密码去解就会失败，用来测「中间文件保留」）。
 * 显式用 AES256：ZipCrypto 在密码错时报的是 CRC 错，消息里不一定有
 * 「wrong password」，会把「候选密码逐个试」这条链路的测试搞得不稳定。
 */
function makeEncryptedZip(zipPath, entries, cwd, password) {
  sevenZip(['a', '-tzip', '-mem=AES256', `-p${password}`, zipPath, ...entries], cwd);
  return requireArchive(zipPath, cwd, 'zip');
}

/** LZ4 中间文件的命名规则（和主进程保持一致） */
function lz4TempOf(archivePath) {
  return `${archivePath}.__lz4_tmp__`;
}

/**
 * XXH32 长输入向量：数据按 data[i] = (i*7+13) & 0xFF 生成，期望值来自
 * Python `xxhash 4.0.1`（C 实现）参考。短输入向量（""/"a"/"abc"）碰不到轮函数，
 * 必须靠这些长向量把 `input * PRIME32_2` 那一步钉死。
 */
const XXH32_LONG_VECTORS = [
  { n: 16, want: 0x8587cb0c },
  { n: 1000, want: 0x62bda8c6 },
  { n: 65536, want: 0x08bd96de },
  { n: 1000003, want: 0x918ab4ed },
];

function patternBytes(n) {
  const buffer = Buffer.allocUnsafe(n);
  for (let index = 0; index < n; index += 1) buffer[index] = (index * 7 + 13) & 0xff;
  return buffer;
}

/* ---------------- 测试主体 ---------------- */

async function main() {
  if (!fs.existsSync(SEVENZIP)) {
    console.error('未找到 7-Zip，无法运行验证。');
    process.exit(2);
  }

  // dist/main.js 是在 app.whenReady() 的回调里注册 IPC 的，
  // 桩里的 whenReady 是 Promise，需要先让微任务队列跑完
  await new Promise((resolve) => setTimeout(resolve, 50));

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'au-verify-'));
  console.log(`工作目录：${work}`);

  try {
    const scanFolder = handlers.get('scan-folder');
    const analyzeNested = handlers.get('analyze-nested');
    const extractArchive = handlers.get('extract-archive');
    const hoistFinished = handlers.get('hoist-finished');

    for (const [name, handler] of [
      ['scan-folder', scanFolder],
      ['analyze-nested', analyzeNested],
      ['extract-archive', extractArchive],
      ['hoist-finished', hoistFinished],
    ]) {
      if (typeof handler !== 'function') throw new Error(`未能从 dist/main.js 抓到 ${name} handler，检查编译产物。`);
    }

    /* ===== 1. 解压文件数统计 ===== */
    section('1. 解压文件数统计（Files: N）');
    const out1 = path.join(work, 'out1');
    const seed1 = path.join(out1, '_seed');
    fs.mkdirSync(path.join(seed1, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(seed1, 'sub', 'a.txt'), 'aaa');
    fs.writeFileSync(path.join(seed1, 'sub', 'b.txt'), 'bbb');
    fs.writeFileSync(path.join(seed1, 'c.bin'), randomBytes(64));
    const pack1 = makeZip(path.join(out1, 'count.zip'), ['sub', 'c.bin'], seed1);
    fs.rmSync(seed1, { recursive: true, force: true });

    const countResult = await extractArchive(null, {
      id: 'count',
      archivePath: pack1,
      outputDir: out1,
      passwords: [],
      sevenZipPath: SEVENZIP,
      renameDisguised: false,
      renameExtension: 'zip',
      deleteSource: false,
      sourcePaths: [pack1],
    });
    check('解压成功', countResult.success === true, `error=${countResult.error}`);
    check(
      '统计出 3 个文件（不含文件夹）',
      countResult.extractedFiles === 3,
      `extractedFiles=${countResult.extractedFiles}`,
    );

    /* ===== 2. 嵌套判定：文件数没超阈值 → 继续解 ===== */
    section('2. 嵌套判定：解出文件数未超阈值 → 继续解');
    const out2 = buildExtractedOutput(path.join(work, 'out2'));
    const followScan = await analyzeNested(null, analyzeRequest(out2));

    check('7-Zip 校验生效', followScan.used7zVerify === true);
    check('没有触发「收手」', followScan.stopReason === '', followScan.stopReason);
    check(
      '只把 inner.zip 算作要继续解的包',
      JSON.stringify(names(followScan.follow)) === JSON.stringify(['inner.zip']),
      names(followScan.follow).join(', ') || '（空）',
    );
    check(
      'photo.jpg / doc.pdf / clip.mp4 都被判定为正常文件',
      ['photo.jpg', 'doc.pdf', 'clip.mp4'].every((name) =>
        followScan.skipped.some((item) => item.name === name && /正常文件/.test(item.reason)),
      ),
      followScan.skipped.map((item) => `${item.name}(${item.reason})`).join(' | '),
    );

    /* ===== 3. 嵌套判定：文件数超阈值 → 收手 ===== */
    section('3. 嵌套判定：解出文件数超阈值 → 不再解');
    const stopScan = await analyzeNested(null, analyzeRequest(out2, { parentFileCount: 4 }));
    check('超过阈值(3)后不再返回任何包', stopScan.follow.length === 0, names(stopScan.follow).join(', '));
    check('给出了「为什么停」的说明', stopScan.stopReason.length > 0, stopScan.stopReason);
    check('说明里带上了实际文件数和阈值', /4\s*个文件/.test(stopScan.stopReason) && /3\s*个/.test(stopScan.stopReason), stopScan.stopReason);

    /* ===== 4. 阈值确实可配 ===== */
    section('4. 阈值可配置');
    const looseThreshold = await analyzeNested(null, analyzeRequest(out2, { parentFileCount: 4, fileThreshold: 10 }));
    check(
      '同一目录、阈值放宽到 10 → 又继续解了',
      JSON.stringify(names(looseThreshold.follow)) === JSON.stringify(['inner.zip']),
      names(looseThreshold.follow).join(', ') || '（空）',
    );

    const exactEdge = await analyzeNested(null, analyzeRequest(out2, { parentFileCount: 3, fileThreshold: 3 }));
    check('刚好等于阈值（3 vs 3）→ 仍然继续解', exactEdge.follow.length === 1 && exactEdge.stopReason === '');

    const edgeStop = await analyzeNested(null, analyzeRequest(out2, { parentFileCount: 4, fileThreshold: 3 }));
    check('刚超一个（4 vs 3）→ 停止', edgeStop.follow.length === 0 && edgeStop.stopReason.length > 0);

    const clampLow = await analyzeNested(null, analyzeRequest(out2, { parentFileCount: 4, fileThreshold: 0 }));
    check('阈值 0 / 负数会被夹回默认 3（不会变成"永不停"）', clampLow.follow.length === 0 && /3\s*个/.test(clampLow.stopReason), clampLow.stopReason);

    /* ===== 5. 单文件套壳：直接继续解（不再问 7-Zip） ===== */
    section('5. 单文件套壳：只解出 1 个文件 + 登记过的伪装后缀 → 直接继续解');

    const userDisguised = ['png', 'mp4', 'jpg', 'pdf', 'tif', 'xls', 'gif'];

    // 完全复刻真实资料包的路径形状：692S3.7z.001 → 3/2026S92S3.pdf → 2026S92S3/2026S92S3.tif
    const out5 = path.join(work, '202692S3', '692S3.7z', '3', '2026S92S3');
    fs.mkdirSync(out5, { recursive: true });
    const seed5 = path.join(work, '_seed5');
    fs.mkdirSync(seed5, { recursive: true });
    fs.writeFileSync(path.join(seed5, 'payload.txt'), 'real payload');
    make7z('packed.7z', ['payload.txt'], seed5);
    fs.copyFileSync(path.join(seed5, 'packed.7z'), path.join(out5, '2026S92S3.tif'));
    fs.rmSync(seed5, { recursive: true, force: true });

    const tifPath = path.join(out5, '2026S92S3.tif');
    const shell = await analyzeNested(
      null,
      analyzeRequest(out5, { parentFileCount: 1, disguisedExtensions: userDisguised }),
    );
    check('没有触发「收手」', shell.stopReason === '', shell.stopReason);
    check(
      '单文件套壳被判定为需要继续解',
      JSON.stringify(names(shell.follow)) === JSON.stringify(['2026S92S3.tif']),
      names(shell.follow).join(', ') || '（空）',
    );
    check('follow 的路径就是那个文件', shell.follow[0]?.path === tifPath, shell.follow[0]?.path);
    check('走的是「直接继续」这条路，没有再去问 7-Zip', shell.used7zVerify === false, `used7zVerify=${shell.used7zVerify}`);
    check('日志里有说得清的说明', shell.notes.some((note) => /伪装后缀/.test(note)), JSON.stringify(shell.notes));

    // 后缀没登记 → 不追（伪装后缀列表是"我允许你动这类文件"的声明）
    const unregistered = await analyzeNested(
      null,
      analyzeRequest(out5, { parentFileCount: 1, disguisedExtensions: ['png', 'jpg'] }),
    );
    check(
      '后缀没登记就不追（.tif 不在列表里）',
      unregistered.follow.length === 0 && unregistered.stopReason === '',
      `${names(unregistered.follow).join(', ') || '（空）'} / ${unregistered.stopReason}`,
    );

    // 解出 2 个文件 → 单文件规则不适用，回到 7-Zip 校验那条路
    fs.writeFileSync(path.join(out5, 'readme.txt'), 'not an archive');
    const twoFiles = await analyzeNested(
      null,
      analyzeRequest(out5, { parentFileCount: 2, disguisedExtensions: userDisguised }),
    );
    check('解出 2 个文件时不套用单文件规则', twoFiles.used7zVerify === true, `used7zVerify=${twoFiles.used7zVerify}`);
    check('此时真 .tif 仍被 7-Zip 认出来并继续解', names(twoFiles.follow).includes('2026S92S3.tif'));
    check('普通 txt 被挡住', !names(twoFiles.follow).includes('readme.txt'));
    fs.rmSync(path.join(out5, 'readme.txt'));

    // 单文件，但后缀是常规压缩包 → 不算"伪装后缀"，走 7-Zip 校验
    const knownExtDir = path.join(work, 'out5-known');
    fs.mkdirSync(knownExtDir, { recursive: true });
    fs.copyFileSync(tifPath, path.join(knownExtDir, 'inner.7z'));
    const knownExt = await analyzeNested(
      null,
      analyzeRequest(knownExtDir, { parentFileCount: 1, disguisedExtensions: userDisguised }),
    );
    check('单文件但后缀是常规压缩包(.7z) → 不算伪装后缀，改走 7-Zip 校验', knownExt.used7zVerify === true, `used7zVerify=${knownExt.used7zVerify}`);
    check('该 .7z 依然被继续解', names(knownExt.follow).includes('inner.7z'), names(knownExt.follow).join(', '));

    // 反面对照：同目录放一个**真** PDF（单个文件、后缀已登记）——按用户要求会直接尝试解压，
    // 这是明确的取舍：宁可多一条失败记录，也不要漏掉一层套壳。
    // （真文件不会被改名、不会被删，都是解压成功后才做的事。）
    const realPdfDir = path.join(work, 'out5-realpdf');
    fs.mkdirSync(realPdfDir, { recursive: true });
    fs.writeFileSync(path.join(realPdfDir, '2026S97S8.pdf'), PDF);
    const realPdf = await analyzeNested(
      null,
      analyzeRequest(realPdfDir, { parentFileCount: 1, disguisedExtensions: userDisguised }),
    );
    check(
      '单个真 PDF：会照你说的直接尝试（宁可失败一条，也不漏解一层）',
      names(realPdf.follow).includes('2026S97S8.pdf'),
      names(realPdf.follow).join(', ') || '（空）',
    );

    // 层数护栏优先于单文件规则
    const deepShell = await analyzeNested(
      null,
      analyzeRequest(out5, { parentFileCount: 1, disguisedExtensions: userDisguised, depth: 3 }),
    );
    check('到层数上限时，单文件规则也不放行', deepShell.follow.length === 0 && deepShell.stopReason.length > 0, deepShell.stopReason);

    /* ===== 6. 解到头：成品搬回源目录 + 清掉空目录外壳 ===== */
    section('6. 解到头：成品搬回源目录，并清掉空目录外壳');

    // 复刻真实形状：yscs\mAVX7\mAVX7.part1\CxmXg\Zhpuw\BARE＆BUNNY
    // （注意文件夹名带全角 ＆，顺便验证非 ASCII 路径）
    const srcRoot = path.join(work, 'yscs');
    const scaffold = path.join(srcRoot, 'mAVX7', 'mAVX7.part1', 'CxmXg', 'Zhpuw');
    const finished = path.join(scaffold, 'BARE＆BUNNY');
    fs.mkdirSync(finished, { recursive: true });
    fs.writeFileSync(path.join(finished, 'ep01.mkv'), 'video-bytes');
    fs.mkdirSync(path.join(finished, 'sub'), { recursive: true });

    // 6a 成品判定
    const finishedDecision = await analyzeNested(null, analyzeRequest(scaffold, { parentFileCount: 2, depth: 2 }));
    check('只有 1 个文件夹、里面有 >1 项 → 判定为解到头', finishedDecision.finishedFolder === finished, finishedDecision.finishedFolder || '(空)');
    check('判成成品后不再往下解', finishedDecision.follow.length === 0);
    check('给出了说明', finishedDecision.notes.some((note) => /成品/.test(note)), JSON.stringify(finishedDecision.notes));

    // 6b v2LwY 实测修复：最外层（深度 0）解出「1 个目录含 >1 项」也要搬——
    //    顶层伪装包（v2LwY.json）解出唯一游戏目录，旧规则 depth≥1 把它拦住，成品埋两层壳
    const topLevelShape = await analyzeNested(null, analyzeRequest(scaffold, { parentFileCount: 2, depth: 0 }));
    check('最外层（深度 0）解出唯一成品目录也搬移（v2LwY 型）', topLevelShape.finishedFolder === finished, topLevelShape.finishedFolder || '(空)');

    // 6c 文件夹里只有 1 项 → 不算成品
    const thinScaffold = path.join(work, 'thin', 'out');
    fs.mkdirSync(path.join(thinScaffold, 'ONLY'), { recursive: true });
    fs.writeFileSync(path.join(thinScaffold, 'ONLY', 'a.txt'), 'x');
    const thinDecision = await analyzeNested(null, analyzeRequest(thinScaffold, { parentFileCount: 1, depth: 2 }));
    check('文件夹里只有 1 项 → 不算成品（继续往下解）', thinDecision.finishedFolder === '', thinDecision.finishedFolder || '(空)');

    // 6d 搬移 + 清理
    const hoist = await hoistFinished(null, { folder: finished, targetRoot: srcRoot });
    check('搬移成功', hoist.ok === true, hoist.error);
    check('成品落到源目录', hoist.movedTo === path.join(srcRoot, 'BARE＆BUNNY'), hoist.movedTo);
    check(
      '内容完整搬过去（文件与子文件夹都在）',
      fs.existsSync(path.join(hoist.movedTo, 'ep01.mkv')) && fs.existsSync(path.join(hoist.movedTo, 'sub')),
    );
    check('外壳整条链被清掉（mAVX7 没了）', !fs.existsSync(path.join(srcRoot, 'mAVX7')));
    check('正好清掉 4 层空目录', hoist.removedDirs.length === 4, hoist.removedDirs.join(' | '));
    check('源目录本身还在（绝不动它）', fs.existsSync(srcRoot));

    // 6e 重名绝不覆盖
    const srcRoot2 = path.join(work, 'yscs2');
    const scaffold2 = path.join(srcRoot2, 'PKG', 'inner');
    const finished2 = path.join(scaffold2, 'CONTENT');
    fs.mkdirSync(finished2, { recursive: true });
    fs.writeFileSync(path.join(finished2, 'a.txt'), 'a');
    fs.writeFileSync(path.join(finished2, 'b.txt'), 'b');
    fs.writeFileSync(path.join(srcRoot2, 'PKG', 'keep-me.txt'), 'other stuff');

    const hoist2 = await hoistFinished(null, { folder: finished2, targetRoot: srcRoot2 });
    check('第二单：搬移成功', hoist2.ok === true, hoist2.error);
    check('落点为 CONTENT', hoist2.movedTo === path.join(srcRoot2, 'CONTENT'), hoist2.movedTo);
    check('inner 被清掉', !fs.existsSync(scaffold2));
    check('PKG 保留下来（里面还有 keep-me.txt）', fs.existsSync(path.join(srcRoot2, 'PKG', 'keep-me.txt')));
    check('keptDirs 报告了 PKG', hoist2.keptDirs.some((dir) => dir.endsWith('PKG')), hoist2.keptDirs.join(' | '));

    // 再来一个同名成品 → 必须加序号，绝不覆盖
    const scaffold3 = path.join(srcRoot2, 'PKG2', 'inner');
    const finished3 = path.join(scaffold3, 'CONTENT');
    fs.mkdirSync(finished3, { recursive: true });
    fs.writeFileSync(path.join(finished3, 'c.txt'), 'c');
    const hoist3 = await hoistFinished(null, { folder: finished3, targetRoot: srcRoot2 });
    check('重名时自动加序号，不覆盖已有内容', hoist3.movedTo === path.join(srcRoot2, 'CONTENT(1)'), hoist3.movedTo);
    check('原来那份内容没被动过', fs.existsSync(path.join(srcRoot2, 'CONTENT', 'a.txt')));
    check('新那份也在', fs.existsSync(path.join(srcRoot2, 'CONTENT(1)', 'c.txt')));

    // 6f 安全边界
    const outside = path.join(work, 'elsewhere', 'X');
    fs.mkdirSync(outside, { recursive: true });
    check(
      '成品不在「压缩包文件夹」里面 → 拒绝搬移',
      (await hoistFinished(null, { folder: outside, targetRoot: srcRoot2 })).ok === false,
    );
    check(
      '不能搬移源目录本身',
      (await hoistFinished(null, { folder: srcRoot2, targetRoot: srcRoot2 })).ok === false,
    );
    check(
      '没设置目标目录 → 拒绝',
      (await hoistFinished(null, { folder: finished3, targetRoot: '' })).ok === false,
    );
    check(
      '路径不存在 → 拒绝',
      (await hoistFinished(null, { folder: path.join(work, 'ghost'), targetRoot: srcRoot2 })).ok === false,
    );

    /* ===== 7. 层数护栏 ===== */
    section('7. 层数护栏');
    const deepScan = await analyzeNested(null, analyzeRequest(out2, { depth: 3 }));
    check('深度到 3 就收手', deepScan.follow.length === 0 && deepScan.stopReason.length > 0, deepScan.stopReason);
    check('说明里提到层数上限', /层/.test(deepScan.stopReason), deepScan.stopReason);

    /* ===== 8. 改名时机（失败不改名，保护正常文件） ===== */
    section('8. 改名时机');
    const out7 = path.join(work, 'out7');
    fs.mkdirSync(out7, { recursive: true });
    const fakeImage = path.join(out7, 'holiday.jpg');
    fs.writeFileSync(fakeImage, JPEG);

    const misjudged = await extractArchive(null, {
      id: 'misjudged',
      archivePath: fakeImage,
      outputDir: out7,
      passwords: [],
      sevenZipPath: SEVENZIP,
      renameDisguised: true,
      renameExtension: 'zip',
      deleteSource: true,
      sourcePaths: [fakeImage],
    });
    check('把 jpg 当压缩包解压会失败', misjudged.success === false, `success=${misjudged.success}`);
    check('失败后文件仍在且名字没变', fs.existsSync(fakeImage));
    check('没有产生 holiday.zip', !fs.existsSync(path.join(out7, 'holiday.zip')));
    check('失败时不会删除源文件', misjudged.deletedFiles.length === 0);

    const realZipAsPng = path.join(out7, 'album.png');
    const seed7 = path.join(out7, '_seed');
    fs.mkdirSync(seed7, { recursive: true });
    fs.writeFileSync(path.join(seed7, 'a.txt'), 'real archive inside png');
    makeZip(path.join(out7, 'tmp.zip'), ['a.txt'], seed7);
    fs.copyFileSync(path.join(out7, 'tmp.zip'), realZipAsPng);
    fs.rmSync(path.join(out7, 'tmp.zip'));
    fs.rmSync(seed7, { recursive: true, force: true });

    const renamed = await extractArchive(null, {
      id: 'renamed',
      archivePath: realZipAsPng,
      outputDir: out7,
      passwords: [],
      sevenZipPath: SEVENZIP,
      renameDisguised: true,
      renameExtension: 'zip',
      deleteSource: false,
      sourcePaths: [realZipAsPng],
    });
    check('真压缩包（伪装成 png）解压成功', renamed.success === true, `error=${renamed.error}`);
    check('renamedFrom 指向原 png', path.basename(renamed.renamedFrom) === 'album.png');
    check('usedPath 变成 .zip', renamed.usedPath.toLowerCase().endsWith('.zip'), renamed.usedPath);
    check(
      '磁盘上出现 album.zip 且 a.txt 已解出',
      fs.existsSync(path.join(out7, 'album.zip')) && fs.existsSync(path.join(out7, 'a.txt')),
    );

    /* ===== 9. 解压后删除源压缩包 ===== */
    section('9. 解压后删除源压缩包（deleteSource）');

    const out8a = path.join(work, 'out8a');
    fs.mkdirSync(out8a, { recursive: true });
    const seed8a = path.join(out8a, '_seed');
    fs.mkdirSync(seed8a, { recursive: true });
    fs.writeFileSync(path.join(seed8a, 'x.txt'), 'payload-a');
    const pack8a = makeZip(path.join(out8a, 'packA.zip'), ['x.txt'], seed8a);
    fs.rmSync(seed8a, { recursive: true, force: true });

    const del8a = await extractArchive(null, {
      id: 'del-a',
      archivePath: pack8a,
      outputDir: out8a,
      passwords: [],
      sevenZipPath: SEVENZIP,
      renameDisguised: false,
      renameExtension: 'zip',
      deleteSource: true,
      sourcePaths: [pack8a],
    });
    check('成功 + 开启删除 -> 源包已删', del8a.success && !fs.existsSync(pack8a));
    check('deletedFiles 记录了删除项', del8a.deletedFiles.some((f) => path.basename(f) === 'packA.zip'));
    check('解压出的 x.txt 还在', fs.existsSync(path.join(out8a, 'x.txt')));

    const out8b = path.join(work, 'out8b');
    fs.mkdirSync(out8b, { recursive: true });
    const seed8b = path.join(out8b, '_seed');
    fs.mkdirSync(seed8b, { recursive: true });
    fs.writeFileSync(path.join(seed8b, 'y.txt'), 'payload-b');
    const pack8b = makeZip(path.join(out8b, 'packB.zip'), ['y.txt'], seed8b);
    fs.rmSync(seed8b, { recursive: true, force: true });
    const keep8b = await extractArchive(null, {
      id: 'keep-b',
      archivePath: pack8b,
      outputDir: out8b,
      passwords: [],
      sevenZipPath: SEVENZIP,
      renameDisguised: false,
      renameExtension: 'zip',
      deleteSource: false,
      sourcePaths: [pack8b],
    });
    check('成功 + 关闭删除 -> 源包保留', keep8b.success && fs.existsSync(pack8b));

    const out8c = path.join(work, 'out8c');
    fs.mkdirSync(out8c, { recursive: true });
    const broken = path.join(out8c, 'broken.zip');
    fs.writeFileSync(broken, randomBytes(1024));
    const fail8c = await extractArchive(null, {
      id: 'fail-c',
      archivePath: broken,
      outputDir: out8c,
      passwords: [],
      sevenZipPath: SEVENZIP,
      renameDisguised: true,
      renameExtension: 'zip',
      deleteSource: true,
      sourcePaths: [broken],
    });
    check('失败 + 开启删除 -> 源包保留（不会误删）', fail8c.success === false && fs.existsSync(broken));

    const out8d = path.join(work, 'out8d');
    fs.mkdirSync(out8d, { recursive: true });
    const seed8d = path.join(out8d, '_seed');
    fs.mkdirSync(seed8d, { recursive: true });
    fs.writeFileSync(path.join(seed8d, 'big.dat'), randomBytes(60 * 1024));
    sevenZip(['a', '-tzip', '-v16k', 'split.zip', 'big.dat'], seed8d);
    const volumeNames = fs.readdirSync(seed8d).filter((n) => n.startsWith('split.'));
    const volumePaths = volumeNames.map((n) => path.join(seed8d, n));
    const mainVolume = volumePaths.find((p) => /\.zip$/i.test(p)) ?? volumePaths.sort()[0];
    fs.rmSync(path.join(seed8d, 'big.dat'));

    const del8d = await extractArchive(null, {
      id: 'del-d',
      archivePath: mainVolume,
      outputDir: out8d,
      passwords: [],
      sevenZipPath: SEVENZIP,
      renameDisguised: false,
      renameExtension: 'zip',
      deleteSource: true,
      sourcePaths: volumePaths,
    });
    const volumesLeft = volumeNames.filter((n) => fs.existsSync(path.join(seed8d, n)));
    check(`分卷包 (${volumeNames.length} 卷) 解压成功`, del8d.success === true, `error=${del8d.error}`);
    check('所有分卷都被删除', volumesLeft.length === 0, `残留：${volumesLeft.join(', ')}`);
    check('解压出的 big.dat 存在', fs.existsSync(path.join(out8d, 'big.dat')));

    /* ===== 10. 进度上报 ===== */
    section('10. 解压进度上报');
    const out9 = path.join(work, 'out9');
    fs.mkdirSync(out9, { recursive: true });
    const seed9 = path.join(out9, '_seed');
    fs.mkdirSync(seed9, { recursive: true });
    for (let i = 0; i < 1500; i += 1) {
      fs.writeFileSync(path.join(seed9, `f${String(i).padStart(4, '0')}.bin`), randomBytes(512));
    }
    const pack9 = makeZip(path.join(out9, 'many.zip'), ['.'], seed9);
    fs.rmSync(seed9, { recursive: true, force: true });

    sentEvents.length = 0;
    const prog = await extractArchive(null, {
      id: 'progress-case',
      archivePath: pack9,
      outputDir: out9,
      passwords: [],
      sevenZipPath: SEVENZIP,
      renameDisguised: false,
      renameExtension: 'zip',
      deleteSource: false,
      sourcePaths: [pack9],
    });

    const events = sentEvents
      .filter((event) => event.channel === 'extract-progress' && event.payload.id === 'progress-case')
      .map((event) => event.payload.percent);
    check('解压成功', prog.success === true, `error=${prog.error}`);
    check(`收到进度事件（${events.length} 个）`, events.length > 0);
    check('进度单调不减', events.every((value, i) => i === 0 || value >= events[i - 1]), events.join(','));
    check('大文件数的统计是对的', prog.extractedFiles === 1500, `extractedFiles=${prog.extractedFiles}`);
    check(
      '1500 个文件 > 阈值 3 → 判定会收手（验证两者串得起来）',
      (await analyzeNested(null, analyzeRequest(out9, { parentFileCount: prog.extractedFiles }))).follow.length === 0,
    );

    /* ===== 11. 前置数据剥离 ===== */
    section('11. 前置无关数据剥离');
    const out10 = path.join(work, 'out10');
    fs.mkdirSync(out10, { recursive: true });
    const seed10 = path.join(out10, '_seed');
    fs.mkdirSync(seed10, { recursive: true });
    fs.writeFileSync(path.join(seed10, 'inside.txt'), 'after video prefix');
    makeZip(path.join(out10, 'plain.zip'), ['inside.txt'], seed10);
    fs.rmSync(seed10, { recursive: true, force: true });

    // 前置数据必须够大：实测 7-Zip 能容忍约 8MB 前置数据（.png 后缀），
    // 12MB 起就打不开了；这里用 24MB 确保一定走到「剥前缀后重试」的分支。
    const disguisedVideo = path.join(out10, 'movie.png');
    fs.writeFileSync(
      disguisedVideo,
      Buffer.concat([Buffer.alloc(24 * 1024 * 1024, 0), fs.readFileSync(path.join(out10, 'plain.zip'))]),
    );
    fs.rmSync(path.join(out10, 'plain.zip'));

    const stripped = await extractArchive(null, {
      id: 'prefix-case',
      archivePath: disguisedVideo,
      outputDir: out10,
      passwords: [],
      sevenZipPath: SEVENZIP,
      renameDisguised: true,
      renameExtension: 'zip',
      deleteSource: false,
      sourcePaths: [disguisedVideo],
    });
    check('剥离前置数据后解压成功', stripped.success === true, `error=${stripped.error}`);
    check('记录了剥离的字节数', stripped.strippedPrefix > 0, `strippedPrefix=${stripped.strippedPrefix}`);
    check('解出 inside.txt', fs.existsSync(path.join(out10, 'inside.txt')));
    check(
      '剥前缀后仍按成功路径改名成 .zip',
      stripped.usedPath.toLowerCase().endsWith('.zip') && fs.existsSync(stripped.usedPath),
    );

    // 扩展名会影响 7-Zip 的容忍度：同一个 3MB 前置数据，
    // .zip 必须先剥前缀，.png 则能直接被 7-Zip 打开
    const seed10b = path.join(out10, '_seed10b');
    fs.mkdirSync(seed10b, { recursive: true });
    fs.writeFileSync(path.join(seed10b, 'z.txt'), 'prefix probe');
    makeZip(path.join(out10, 'zipseed.zip'), ['z.txt'], seed10b);
    fs.rmSync(seed10b, { recursive: true, force: true });

    const probeDir = path.join(out10, 'probe');
    fs.mkdirSync(probeDir, { recursive: true });
    const withPrefix = (fileName, bytes) => {
      const target = path.join(probeDir, fileName);
      fs.writeFileSync(target, Buffer.concat([Buffer.alloc(bytes, 0), fs.readFileSync(path.join(out10, 'zipseed.zip'))]));
      return target;
    };

    const zipCase = await extractArchive(null, {
      id: 'prefix-zip',
      archivePath: withPrefix('withZip.zip', 3 * 1024 * 1024),
      outputDir: probeDir,
      passwords: [],
      sevenZipPath: SEVENZIP,
      renameDisguised: false,
      renameExtension: 'zip',
      deleteSource: false,
      sourcePaths: [],
    });
    const pngCase = await extractArchive(null, {
      id: 'prefix-png',
      archivePath: withPrefix('withPng.png', 3 * 1024 * 1024),
      outputDir: probeDir,
      passwords: [],
      sevenZipPath: SEVENZIP,
      renameDisguised: false,
      renameExtension: 'zip',
      deleteSource: false,
      sourcePaths: [],
    });
    check('3MB 前置 + .zip -> 必须剥前缀才能解', zipCase.success && zipCase.strippedPrefix > 0, `strippedPrefix=${zipCase.strippedPrefix}`);
    check('3MB 前置 + .png -> 7-Zip 直接认（原始后缀容忍度更高）', pngCase.success && pngCase.strippedPrefix === 0, `strippedPrefix=${pngCase.strippedPrefix}`);

    /* ===== 12. 定位接口 ===== */
    section('12. 定位接口');
    const showItem = handlers.get('shell:show-item');
    const openPath = handlers.get('shell:open-path');
    check('shell:show-item 已注册', typeof showItem === 'function');
    check('shell:open-path 已注册', typeof openPath === 'function');
    check('空路径被拒绝', (await showItem(null, '')).ok === false);
    check('不存在的路径返回失败', (await showItem(null, path.join(work, 'no-such-dir', 'ghost.bin'))).ok === false);
    check('存在的文件定位成功', (await showItem(null, path.join(out7, 'a.txt'))).ok === true);
    check('文件不在但目录在 -> 退化打开目录', (await showItem(null, path.join(out7, 'was-deleted.bin'))).ok === true);

    /* ===== 13. LZ4 压缩流（7-Zip 解不了，程序自己解） ===== */
    section('13. LZ4 压缩流：先自己解开，再接着往下解');

    // 13.1 帧解码本身：XXH32 长向量 + 内容校验和
    const unitLz4 = path.join(work, 'unit.lz4');
    const unitOut = path.join(work, 'unit.out');
    for (const vector of XXH32_LONG_VECTORS) {
      check(
        `XXH32 长向量 n=${vector.n}`,
        xxh32(patternBytes(vector.n)) === vector.want,
        `want=0x${vector.want.toString(16)}`,
      );
    }
    fs.writeFileSync(unitLz4, lz4Frame(Buffer.from('hello lz4 frame')));
    const unitResult = await lz4.decompressLz4Frame(unitLz4, unitOut);
    check('帧解码字节数正确', unitResult.bytesOut === 15, String(unitResult.bytesOut));
    check('帧解码内容正确', fs.readFileSync(unitOut, 'utf8') === 'hello lz4 frame');
    check('帧内容校验和通过', unitResult.checksumOk === true);
    check('帧头声明的原始大小被读出', unitResult.declaredSize === 15, String(unitResult.declaredSize));

    // 13.2 端到端：A41.lz4 里套一个 zip
    const out13 = path.join(work, 'lz4-a');
    const seed13 = path.join(out13, '_seed');
    fs.mkdirSync(seed13, { recursive: true });
    fs.writeFileSync(path.join(seed13, 'inside.txt'), 'lz4 nested payload');
    fs.writeFileSync(path.join(seed13, 'second.txt'), 'another one');
    const zip13 = makeZip(path.join(out13, 'inner.zip'), ['inside.txt', 'second.txt'], seed13);
    fs.rmSync(seed13, { recursive: true, force: true });

    const lz4Zip = path.join(out13, 'A41.lz4');
    makeLz4(lz4Zip, fs.readFileSync(zip13));
    fs.rmSync(zip13, { force: true });

    const scan13 = await scanFolder(null, {
      folder: out13,
      recursive: false,
      disguisedExtensions: [],
      verifyWith7z: true,
    });
    check('扫描认得出 .lz4', names(scan13.archives).includes('A41.lz4'), JSON.stringify(names(scan13.archives)));
    check('没被 7-Zip 校验误杀', !scan13.rejected.includes('A41.lz4'), JSON.stringify(scan13.rejected));

    const dir13 = path.join(work, 'lz4-a-out');
    const res13 = await extractArchive(null, {
      id: 'lz4zip',
      archivePath: lz4Zip,
      outputDir: dir13,
      passwords: [],
      sevenZipPath: SEVENZIP,
      renameDisguised: true,
      renameExtension: 'zip',
      deleteSource: false,
      sourcePaths: [lz4Zip],
    });
    check('LZ4 全流程成功', res13.success === true, `error=${res13.error}`);
    check('报出了 LZ4 解出的字节数', res13.lz4Bytes > 0, String(res13.lz4Bytes));
    check('识别出内层是压缩包', res13.lz4InnerIsArchive === true);
    check('中间包按内容补成了 A41.zip 再继续走流程', res13.lz4InnerName === 'A41.zip', res13.lz4InnerName);
    check('内层第一个文件解出来了', fs.existsSync(path.join(dir13, 'inside.txt')));
    check('内层第二个文件解出来了', fs.existsSync(path.join(dir13, 'second.txt')));
    check('文件数统计只算内层内容（不含中间包）', res13.extractedFiles === 2, String(res13.extractedFiles));
    check('LZ4 中间文件用完即删', !fs.existsSync(lz4TempOf(lz4Zip)), '临时文件残留');
    check('源 .lz4 没被改名（不该走伪装改名那条路）', fs.existsSync(lz4Zip) && !fs.existsSync(path.join(out13, 'A41.zip')));
    check('中间包没有跑到输出目录里', !fs.existsSync(path.join(dir13, 'inner.zip')));
    check('解出来的内容对得上', fs.readFileSync(path.join(dir13, 'inside.txt'), 'utf8') === 'lz4 nested payload');

    // 13.3 内层不是压缩包：解出来的文件本身就是结果
    const out13b = path.join(work, 'lz4-b');
    fs.mkdirSync(out13b, { recursive: true });
    const plainPayload = Buffer.concat([Buffer.from('plain payload, not an archive\n'), randomBytes(2048)]);
    const lz4Plain = path.join(out13b, 'movie.lz4');
    makeLz4(lz4Plain, plainPayload);
    const dir13b = path.join(work, 'lz4-b-out');
    const res13b = await extractArchive(null, {
      id: 'lz4plain',
      archivePath: lz4Plain,
      outputDir: dir13b,
      passwords: [],
      sevenZipPath: SEVENZIP,
      renameDisguised: false,
      renameExtension: 'zip',
      deleteSource: false,
      sourcePaths: [lz4Plain],
    });
    check('内层不是压缩包也能成功', res13b.success === true, `error=${res13b.error}`);
    check('标明内层不是压缩包', res13b.lz4InnerIsArchive === false);
    check('按「去掉 .lz4」的名字落地', fs.existsSync(path.join(dir13b, 'movie')), JSON.stringify(fs.readdirSync(dir13b)));
    check('解出的内容原样一致', fs.readFileSync(path.join(dir13b, 'movie')).equals(plainPayload));
    check('文件数算 1 个', res13b.extractedFiles === 1, String(res13b.extractedFiles));

    // 13.4 开启「解压后删除源压缩包」：源 .lz4 要删，内层结果要留
    const out13c = path.join(work, 'lz4-c');
    const seed13c = path.join(out13c, '_seed');
    fs.mkdirSync(seed13c, { recursive: true });
    fs.writeFileSync(path.join(seed13c, 'kept.txt'), 'must survive');
    const zip13c = makeZip(path.join(out13c, 'inner.zip'), ['kept.txt'], seed13c);
    fs.rmSync(seed13c, { recursive: true, force: true });
    const lz4Del = path.join(out13c, 'C9.lz4');
    makeLz4(lz4Del, fs.readFileSync(zip13c));
    fs.rmSync(zip13c, { force: true });

    const dir13c = path.join(work, 'lz4-c-out');
    const res13c = await extractArchive(null, {
      id: 'lz4del',
      archivePath: lz4Del,
      outputDir: dir13c,
      passwords: [],
      sevenZipPath: SEVENZIP,
      renameDisguised: false,
      renameExtension: 'zip',
      deleteSource: true,
      sourcePaths: [lz4Del],
    });
    check('删除源包模式下依然成功', res13c.success === true, `error=${res13c.error}`);
    check('源 .lz4 已被删除', !fs.existsSync(lz4Del));
    check('中间文件没有残留', !fs.existsSync(lz4TempOf(lz4Del)));
    check('解出来的内容还在', fs.existsSync(path.join(dir13c, 'kept.txt')));

    // 13.5 内层是加密包且密码不对：解不开，但中间包要留着，别让用户白解一遍
    const out13d = path.join(work, 'lz4-d');
    const seed13d = path.join(out13d, '_seed');
    fs.mkdirSync(seed13d, { recursive: true });
    fs.writeFileSync(path.join(seed13d, 'secret.txt'), 'classified');
    const zip13d = makeEncryptedZip(path.join(out13d, 'inner.zip'), ['secret.txt'], seed13d, 'rightpass');
    fs.rmSync(seed13d, { recursive: true, force: true });
    const lz4Enc = path.join(out13d, 'locked.lz4');
    makeLz4(lz4Enc, fs.readFileSync(zip13d));
    fs.rmSync(zip13d, { force: true });

    const res13d = await extractArchive(null, {
      id: 'lz4enc',
      archivePath: lz4Enc,
      outputDir: path.join(work, 'lz4-d-out'),
      passwords: ['wrongpass'],
      sevenZipPath: SEVENZIP,
      renameDisguised: false,
      renameExtension: 'zip',
      deleteSource: false,
      sourcePaths: [lz4Enc],
    });
    check('密码不对 -> 解压失败', res13d.success === false);
    check('失败时中间包被保留下来', fs.existsSync(path.join(out13d, 'locked.zip')), JSON.stringify(fs.readdirSync(out13d)));
    check('结果里报出了保留的文件名', res13d.lz4InnerName === 'locked.zip', res13d.lz4InnerName);
    check('标记了内层文件已保留', res13d.lz4InnerKept === true);
    check('临时名字没有残留', !fs.existsSync(lz4TempOf(lz4Enc)));
    check('保留下来的是个真 zip', (() => {
      const kept = path.join(out13d, 'locked.zip');
      if (!fs.existsSync(kept)) return false;
      return fs.readFileSync(kept).subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    })());
    check('源 .lz4 在失败时当然保留', fs.existsSync(lz4Enc));

    // 13.6 密码正确时能一路解到底（加密包那条链必须真的通）
    const res13e = await extractArchive(null, {
      id: 'lz4enc-ok',
      archivePath: lz4Enc,
      outputDir: path.join(work, 'lz4-e-out'),
      passwords: ['wrongpass', 'rightpass'],
      sevenZipPath: SEVENZIP,
      renameDisguised: false,
      renameExtension: 'zip',
      deleteSource: false,
      sourcePaths: [lz4Enc],
    });
    check('候选密码里有对的 -> 成功', res13e.success === true, `error=${res13e.error}`);
    check('命中的是第 2 个候选', res13e.matchedPasswordIndex === 1, String(res13e.matchedPasswordIndex));
    check('加密包里的文件解出来了', fs.existsSync(path.join(work, 'lz4-e-out', 'secret.txt')));
    check('这次中间文件被清掉了', !fs.existsSync(lz4TempOf(lz4Enc)));

    // 13.7 嵌套目录里出现 .lz4，也要能继续追
    const out13f = path.join(work, 'lz4-f');
    fs.mkdirSync(out13f, { recursive: true });
    const seed13f = path.join(work, '_seed-lz4-f');
    fs.mkdirSync(seed13f, { recursive: true });
    fs.writeFileSync(path.join(seed13f, 'deep.txt'), 'deep');
    const zip13f = makeZip(path.join(work, 'deep.zip'), ['deep.txt'], seed13f);
    makeLz4(path.join(out13f, 'next.lz4'), fs.readFileSync(zip13f));
    fs.rmSync(seed13f, { recursive: true, force: true });
    fs.rmSync(zip13f, { force: true });

    const analysis13 = await analyzeNested(null, analyzeRequest(out13f, { parentFileCount: 1, depth: 0 }));
    check(
      '嵌套扫描把 .lz4 列进「要继续解」',
      analysis13.follow.some((archive) => archive.name === 'next.lz4'),
      JSON.stringify(names(analysis13.follow)),
    );
    check('没有把它当普通文件跳过', !analysis13.skipped.some((item) => item.name === 'next.lz4'));

    // 13.8 坏文件要给出人看得懂的错，而不是静默解出垃圾
    const brokenLz4 = path.join(work, 'broken.lz4');
    const goodFrame = lz4Frame(Buffer.from('payload'));
    goodFrame[6] = goodFrame[6] ^ 0xff; // 打坏帧头校验和
    fs.writeFileSync(brokenLz4, goodFrame);
    const res13g = await extractArchive(null, {
      id: 'lz4broken',
      archivePath: brokenLz4,
      outputDir: path.join(work, 'lz4-g-out'),
      passwords: [],
      sevenZipPath: SEVENZIP,
      renameDisguised: false,
      renameExtension: 'zip',
      deleteSource: false,
      sourcePaths: [brokenLz4],
    });
    check('帧头损坏 -> 失败', res13g.success === false);
    check('错误信息点明是 LZ4 帧头问题', res13g.error.includes('LZ4'), res13g.error);
    check('损坏时不留下临时文件', !fs.existsSync(lz4TempOf(brokenLz4)));

    // 13.9 内层无后缀压缩包：按「内容」补上正确后缀名，再继续走正常解压流程
    // （用 source 名为 bundle.lz4 来证明后缀是从内容认出来的，不是写死 A41）
    const out13h = path.join(work, 'lz4-h');
    const seed13h = path.join(out13h, '_seed');
    fs.mkdirSync(seed13h, { recursive: true });
    fs.writeFileSync(path.join(seed13h, 'a.txt'), 'alpha');
    fs.writeFileSync(path.join(seed13h, 'b.txt'), 'beta');
    const zip13h = makeZip(path.join(out13h, 'inner.zip'), ['a.txt', 'b.txt'], seed13h);
    fs.rmSync(seed13h, { recursive: true, force: true });
    const lz4H = path.join(out13h, 'bundle.lz4');
    makeLz4(lz4H, fs.readFileSync(zip13h));
    fs.rmSync(zip13h, { force: true });

    const res13h = await extractArchive(null, {
      id: 'lz4name',
      archivePath: lz4H,
      outputDir: path.join(work, 'lz4-h-out'),
      passwords: [],
      sevenZipPath: SEVENZIP,
      renameDisguised: false,
      renameExtension: 'zip',
      deleteSource: false,
      sourcePaths: [lz4H],
    });
    check('13.9 内层是压缩包 -> 全流程成功', res13h.success === true, `error=${res13h.error}`);
    check('13.9 中间包按内容补成了正确后缀名 bundle.zip', res13h.lz4InnerName === 'bundle.zip', res13h.lz4InnerName);
    check('13.9 正常流程继续把内层内容解出来了', fs.existsSync(path.join(work, 'lz4-h-out', 'a.txt')) && fs.existsSync(path.join(work, 'lz4-h-out', 'b.txt')));
    check('13.9 用完即删，不留临时文件也不留中间包', !fs.existsSync(lz4TempOf(lz4H)) && !fs.existsSync(path.join(out13h, 'bundle.zip')));

    // 14. 完全没有后缀、但文件头证明它是压缩包的文件（如被丢了后缀的 A41）
    section('14. 没后缀的压缩包：扫描认得出，解压时自动补 .zip 再继续');

    const out14 = path.join(work, 'noext');
    fs.mkdirSync(out14, { recursive: true });
    const seed14 = path.join(out14, '_seed');
    fs.mkdirSync(seed14, { recursive: true });
    fs.writeFileSync(path.join(seed14, 'one.txt'), 'first');
    fs.writeFileSync(path.join(seed14, 'two.txt'), 'second');
    const zip14 = makeZip(path.join(out14, 'inner.zip'), ['one.txt', 'two.txt'], seed14);
    fs.rmSync(seed14, { recursive: true, force: true });
    // 把 zip 内容写成一个「完全没后缀」的文件 A41（模拟丢了后缀的场景）
    const noExtFile = path.join(out14, 'A41');
    fs.copyFileSync(zip14, noExtFile);
    fs.rmSync(zip14, { force: true });

    // 14.1 不校验（纯按文件头）也要认得出
    const scan14a = await scanFolder(null, {
      folder: out14,
      recursive: false,
      disguisedExtensions: [],
      verifyWith7z: false,
    });
    check('14.1 没后缀的压缩包被扫描认出', names(scan14a.archives).includes('A41'), JSON.stringify(names(scan14a.archives)));
    check('14.1 没被误判成非压缩包', !scan14a.rejected.includes('A41'), JSON.stringify(scan14a.rejected));

    // 14.2 开启 7-Zip 校验也要认得出
    const scan14b = await scanFolder(null, {
      folder: out14,
      recursive: false,
      disguisedExtensions: [],
      verifyWith7z: true,
    });
    check('14.2 7-Zip 校验下也认得出', names(scan14b.archives).includes('A41'), JSON.stringify(names(scan14b.archives)));

    // 14.3 解压：自动补 .zip 后缀并正常解出内容（伪装改名开关关着也要补）
    const dir14 = path.join(work, 'noext-out');
    const res14 = await extractArchive(null, {
      id: 'noext',
      archivePath: noExtFile,
      outputDir: dir14,
      passwords: [],
      sevenZipPath: SEVENZIP,
      renameDisguised: false,
      renameExtension: 'zip',
      deleteSource: false,
      sourcePaths: [noExtFile],
    });
    check('14.3 没后缀文件解压成功', res14.success === true, `error=${res14.error}`);
    check('14.3 解压后补成了 A41.zip', fs.existsSync(path.join(out14, 'A41.zip')), JSON.stringify(fs.readdirSync(out14)));
    check('14.3 源文件 A41 已被改名（不再是无后缀）', !fs.existsSync(noExtFile));
    check('14.3 内容正常解出来了', fs.existsSync(path.join(dir14, 'one.txt')) && fs.existsSync(path.join(dir14, 'two.txt')));
    check('14.3 结果记录了改名来源', res14.renamedFrom === noExtFile, res14.renamedFrom);

    // 14.4 嵌套场景：解压出来的没后缀包，下一级扫描也要能继续追
    const out14d = path.join(work, 'noext-nested');
    fs.mkdirSync(out14d, { recursive: true });
    fs.writeFileSync(path.join(out14d, 'deep.txt'), 'deep'); // 必须先有这个文件，7z 才能把它打进包
    const deepZip = makeZip(path.join(out14d, 'inner.zip'), ['deep.txt'], out14d);
    fs.copyFileSync(deepZip, path.join(out14d, 'shell')); // 没后缀的包
    fs.rmSync(deepZip, { force: true });
    const analysis14 = await analyzeNested(null, analyzeRequest(out14d, { parentFileCount: 1, depth: 0 }));
    check('14.4 嵌套扫描追没后缀的包', analysis14.follow.some((archive) => archive.name === 'shell'), JSON.stringify(names(analysis14.follow)));

    // 14.5 复现真实故障：输出目录与源文件同名（如 F:\yscs\A41 既是文件、又是要创建的目录）。
    // separateDirs 开启时，输出目录 = 源文件所在目录 + 源文件名（去掉后缀）= F:\yscs\A41，
    // 和源文件 F:\yscs\A41 撞名，7-Zip 会直接报 "Cannot create output directory"。
    // 修复后：无后缀压缩包在 7-Zip 解压前就先补成 A41.zip，输出目录不再撞名。
    const out14c = path.join(work, 'collide');
    fs.mkdirSync(out14c, { recursive: true });
    const seed14c = path.join(out14c, '_seed');
    fs.mkdirSync(seed14c, { recursive: true });
    fs.writeFileSync(path.join(seed14c, 'a.txt'), 'payload-a');
    fs.writeFileSync(path.join(seed14c, 'b.txt'), 'payload-b');
    const zip14c = makeZip(path.join(out14c, 'inner.zip'), ['a.txt', 'b.txt'], seed14c);
    fs.rmSync(seed14c, { recursive: true, force: true });
    const collideSrc = path.join(out14c, 'A41'); // 完全没后缀
    fs.copyFileSync(zip14c, collideSrc);
    fs.rmSync(zip14c, { force: true });
    // 输出目录就设在「源文件所在目录下、与源文件同名」—— 这正是真实故障的布局
    const collideOut = path.join(out14c, 'A41');
    const res14c = await extractArchive(null, {
      id: 'collide',
      archivePath: collideSrc,
      outputDir: collideOut,
      passwords: [],
      sevenZipPath: SEVENZIP,
      renameDisguised: false,
      renameExtension: 'zip',
      deleteSource: false,
      sourcePaths: [collideSrc],
    });
    check('14.5 输出目录与源文件同名时也能解压成功（不再撞名）', res14c.success === true, `error=${res14c.error}`);
    // 源文件 A41 已被改名为 A41.zip；同名 A41 现在是「输出目录」，所以不能用「名字不存在」判断，
    // 而要用「A41 不再是一个文件（无后缀源文件已消失）」来判断。
    const srcIsFile = fs.existsSync(collideSrc) && fs.statSync(collideSrc).isFile();
    check('14.5 源文件 A41 已被提前改名为 A41.zip（无后缀文件不再存在）', fs.existsSync(path.join(out14c, 'A41.zip')) && !srcIsFile, `A41.zip=${fs.existsSync(path.join(out14c, 'A41.zip'))} srcIsFile=${srcIsFile}`);
    check('14.5 内容解到了同名输出目录里', fs.existsSync(path.join(collideOut, 'a.txt')) && fs.existsSync(path.join(collideOut, 'b.txt')));
    check('14.5 结果记录了改名来源', res14c.renamedFrom === collideSrc, res14c.renamedFrom);

    /* ===== 15. 成品判定·散装形态：内容直接散在输出目录（A41 型）+ 撞名要回原名 ===== */
    section('15. 成品判定扩展：内容直接散在输出目录，整个输出目录搬回源目录');

    // 复刻 F:\yscs\A41\A41\A41\{存档,游戏} 的形状（整条链每层都叫同一个名字，复刻撞名）
    const flatRoot = path.join(work, 'flat-hoist');
    const flatChain = path.join(flatRoot, 'A41');
    const flatOut1 = path.join(flatChain, 'A41');
    const flatOut2 = path.join(flatOut1, 'A41'); // 最后一层输出 = 成品所在
    fs.mkdirSync(path.join(flatOut2, 'game'), { recursive: true });
    fs.mkdirSync(path.join(flatOut2, 'save'));
    fs.writeFileSync(path.join(flatOut2, 'game', 'a.txt'), 'a');
    fs.writeFileSync(path.join(flatOut2, 'game', 'b.txt'), 'b');

    // 15.1 判定：输出目录直接有 >1 项 → 输出目录本身就是成品（阈值超了也一样，成品判定优先）
    const flatDecision = await analyzeNested(
      null,
      analyzeRequest(flatOut2, { parentFileCount: 30, depth: 2 }),
    );
    check(
      '15.1 内容直接散在输出目录 → 判定输出目录为成品',
      flatDecision.finishedFolder === flatOut2,
      flatDecision.finishedFolder || '(空)',
    );
    check(
      '15.1 成品判定优先于阈值收手（30 个文件也没被阈值拦住）',
      flatDecision.stopReason === '',
      flatDecision.stopReason,
    );
    check('15.1 给出了说明', flatDecision.notes.some((note) => /成品/.test(note)), JSON.stringify(flatDecision.notes));

    // 15.2 深度 0 不触发（最外层不搬移，和壳文件夹形态同一约束）
    const flatTop = await analyzeNested(null, analyzeRequest(flatOut2, { parentFileCount: 30, depth: 0 }));
    check('15.2 最外层（深度 0）不做散装成品搬移', flatTop.finishedFolder === '', flatTop.finishedFolder || '(空)');

    // 15.3 撞名要回原名：成品名 A41 和链根 A41 撞名，先落 A41(1)，清完空壳链把名字要回来
    const flatHoist = await hoistFinished(null, { folder: flatDecision.finishedFolder, targetRoot: flatRoot });
    check('15.3 搬移成功', flatHoist.ok === true, flatHoist.error);
    check('15.3 最终落点就是 A41（不是 A41(1)）', flatHoist.movedTo === path.join(flatRoot, 'A41'), flatHoist.movedTo);
    check(
      '15.3 内容完整（game/save 都在）',
      fs.existsSync(path.join(flatHoist.movedTo, 'game', 'a.txt')) && fs.existsSync(path.join(flatHoist.movedTo, 'save')),
    );
    check('15.3 空壳链被清掉（正好 2 层）', flatHoist.removedDirs.length === 2, flatHoist.removedDirs.join(' | '));
    check('15.3 没留下 A41(1) 这种别扭落点', !fs.existsSync(path.join(flatRoot, 'A41(1)')), flatRoot);

    // 15.4 单文件输出不触发散装判定（回归确认：只有 >1 项才算散装成品）
    const keepRoot = path.join(work, 'flat-keep');
    const keepOut = path.join(keepRoot, 'PKG', 'inner');
    fs.mkdirSync(keepOut, { recursive: true });
    fs.writeFileSync(path.join(keepOut, 'x.txt'), 'x');
    const keepDecision = await analyzeNested(null, analyzeRequest(keepOut, { parentFileCount: 1, depth: 2 }));
    check('15.4 单文件输出不触发散装判定（回归确认）', keepDecision.finishedFolder === '', keepDecision.finishedFolder || '(空)');

    /* ===== 16. 计数兜底（单文件包不打 Files: 行）+ 删源只删文件 ===== */
    section('16. 单文件计数兜底 + 删源保护（跳过目录）');

    // 16.1 单文件 zip：7-Zip 25.01 对「只解出一个文件」的包不打 Files: 行，
    //      只打 Size:/Compressed:，旧解析逻辑返回 0，日志显示「解压完成，0 个文件」，
    //      嵌套判定里的「单文件套壳」分支也永远命中不了
    const out16a = path.join(work, 'cnt-single');
    const seed16a = path.join(out16a, '_seed');
    fs.mkdirSync(seed16a, { recursive: true });
    fs.writeFileSync(path.join(seed16a, 'only.txt'), 'single payload');
    const pack16a = makeZip(path.join(out16a, 'single.zip'), ['only.txt'], seed16a);
    fs.rmSync(seed16a, { recursive: true, force: true });

    const cnt16a = await extractArchive(null, {
      id: 'cnt-single',
      archivePath: pack16a,
      outputDir: path.join(out16a, 'out'),
      passwords: [],
      sevenZipPath: SEVENZIP,
      renameDisguised: false,
      renameExtension: 'zip',
      deleteSource: false,
      sourcePaths: [pack16a],
    });
    check('16.1 单文件包解压成功', cnt16a.success === true, cnt16a.error);
    check(
      '16.1 单文件包计出 1 个文件（不再误报 0）',
      cnt16a.extractedFiles === 1,
      `extractedFiles=${cnt16a.extractedFiles}`,
    );

    // 16.2 删源保护：sourcePaths 里混进一个目录，删除环节必须跳过目录、只删文件
    const out16b = path.join(work, 'del-protect');
    fs.mkdirSync(path.join(out16b, 'sacred-dir'), { recursive: true });
    fs.writeFileSync(path.join(out16b, 'sacred-dir', 'keep.txt'), 'must survive');
    const seed16b = path.join(out16b, '_seed');
    fs.mkdirSync(seed16b, { recursive: true });
    fs.writeFileSync(path.join(seed16b, 'p.txt'), 'p');
    const pack16b = makeZip(path.join(out16b, 'pkg.zip'), ['p.txt'], seed16b);
    fs.rmSync(seed16b, { recursive: true, force: true });

    const del16b = await extractArchive(null, {
      id: 'del-protect',
      archivePath: pack16b,
      outputDir: path.join(out16b, 'out'),
      passwords: [],
      sevenZipPath: SEVENZIP,
      renameDisguised: false,
      renameExtension: 'zip',
      deleteSource: true,
      sourcePaths: [pack16b, path.join(out16b, 'sacred-dir')],
    });
    check('16.2 删源开启时解压成功', del16b.success === true, del16b.error);
    check('16.2 目录没被误删（删除环节跳过目录）', fs.existsSync(path.join(out16b, 'sacred-dir', 'keep.txt')));
    check('16.2 没有删除报错（不再有 EPERM 噪音）', del16b.deleteError === '', del16b.deleteError);
    check(
      '16.2 源文件 pkg.zip 正常删除',
      !fs.existsSync(pack16b) && del16b.deletedFiles.includes(pack16b),
      JSON.stringify(del16b.deletedFiles),
    );

    // 16.3 复刻真实故障：无后缀包 A41 + 输出目录同名 + 删源开启。
    //      提前改名后 usedPath=A41.zip，旧 sourcePaths 条目 A41 正好落在输出目录头上，
    //      修复前这里会对输出目录 fs.unlink 报 EPERM，还留下「删除失败」的矛盾日志。
    const out16c = path.join(work, 'del-collide');
    fs.mkdirSync(out16c, { recursive: true });
    const seed16c = path.join(out16c, '_seed');
    fs.mkdirSync(seed16c, { recursive: true });
    fs.writeFileSync(path.join(seed16c, 'a.txt'), 'a');
    fs.writeFileSync(path.join(seed16c, 'b.txt'), 'b');
    const zip16c = makeZip(path.join(out16c, 'inner.zip'), ['a.txt', 'b.txt'], seed16c);
    fs.rmSync(seed16c, { recursive: true, force: true });
    const collide16c = path.join(out16c, 'A41');
    fs.copyFileSync(zip16c, collide16c);
    fs.rmSync(zip16c, { force: true });

    const del16c = await extractArchive(null, {
      id: 'del-collide',
      archivePath: collide16c,
      outputDir: collide16c, // 输出目录与源文件同名（真实布局）
      passwords: [],
      sevenZipPath: SEVENZIP,
      renameDisguised: false,
      renameExtension: 'zip',
      deleteSource: true,
      sourcePaths: [collide16c],
    });
    check('16.3 撞名布局 + 删源：解压成功', del16c.success === true, del16c.error);
    check(
      '16.3 输出目录完好（同名目录没被当源文件删掉）',
      fs.existsSync(path.join(collide16c, 'a.txt')) && fs.existsSync(path.join(collide16c, 'b.txt')),
    );
    check('16.3 没有删除报错', del16c.deleteError === '', del16c.deleteError);
    check(
      '16.3 删掉的是 A41.zip（改了名的源文件）',
      !fs.existsSync(path.join(out16c, 'A41.zip')) && del16c.deletedFiles.includes(path.join(out16c, 'A41.zip')),
      JSON.stringify(del16c.deletedFiles),
    );
    check('16.3 记录了改名来源', del16c.renamedFrom === collide16c, del16c.renamedFrom);
  } finally {
    try {
      fs.rmSync(work, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响结论 */
    }
  }

  console.log(`\n${'='.repeat(46)}`);
  console.log(`通过 ${passed} 项，失败 ${failures.length} 项`);
  // ASCII 总结行：避开终端编码问题，方便脚本/CI 直接读取结果
  console.log(`RESULT PASS=${passed} FAIL=${failures.length}`);
  if (failures.length > 0) {
    console.log('\n失败明细：');
    failures.forEach((item) => console.log(`  - ${item}`));
    process.exit(1);
  }
  console.log('=== 全部通过 ===');
}

main().catch((error) => {
  console.error('\n验证脚本异常：', error);
  console.error(`RESULT PASS=${passed} FAIL=${failures.length} EXCEPTION=1`);
  process.exit(1);
});
