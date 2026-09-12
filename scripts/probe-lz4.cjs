/**
 * LZ4 探针：把 .lz4 解开一遍，报告字节数、内容校验和、内层格式。
 * 只读——除了源文件同目录下那个临时输出（结束就删），不动任何东西。
 *
 * 用法：npm run probe:lz4 -- "<文件.lz4>"
 *      加 --keep 可保留解出来的文件，方便自己拿 7-Zip 再看一眼。
 *
 * 用来诊断「这个 .lz4 里面到底是什么」：程序解不开时先跑它，
 * 就能分清是「LZ4 本身有问题」还是「内层的包有问题」。
 */

const path = require('node:path');
const fs = require('node:fs');

const { decompressLz4Frame, isLz4Magic } = require(path.join(__dirname, '..', 'dist', 'lz4.js'));

const input = process.argv[2];
if (!input) {
  console.error('用法：npm run probe:lz4 -- "<文件.lz4>"');
  process.exit(2);
}

const FORMATS = [
  { magic: [0x50, 0x4b, 0x03, 0x04], label: 'ZIP' },
  { magic: [0x50, 0x4b, 0x05, 0x06], label: 'ZIP(空归档)' },
  { magic: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], label: '7-Zip' },
  { magic: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07], label: 'RAR' },
  { magic: [0x1f, 0x8b], label: 'gzip' },
  { magic: [0x42, 0x5a, 0x68], label: 'bzip2' },
  { magic: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00], label: 'xz' },
  { magic: [0x28, 0xb5, 0x2f, 0xfd], label: 'zstd' },
  { magic: [0x4d, 0x53, 0x43, 0x46], label: 'CAB' },
];

function sniff(head) {
  for (const f of FORMATS) {
    if (head.length >= f.magic.length && f.magic.every((b, i) => head[i] === b)) return f.label;
  }
  if (head.length >= 262 && head.subarray(257, 262).toString('ascii') === 'ustar') return 'tar';
  return '未知（按普通文件处理）';
}

(async () => {
  const st = fs.statSync(input);
  const head4 = Buffer.alloc(4);
  const fd = fs.openSync(input, 'r');
  fs.readSync(fd, head4, 0, 4, 0);
  fs.closeSync(fd);

  console.log('源文件 :', input);
  console.log('大小   :', st.size, '字节 (' + (st.size / 1e9).toFixed(2) + ' GB)');
  console.log('魔数   :', head4.toString('hex', 0, 4).replace(/(..)/g, '$1 ').trim());

  if (!isLz4Magic(head4)) {
    console.log('=> 不是 LZ4 文件，结束。');
    return;
  }
  console.log('=> 识别为 LZ4 帧格式\n');

  // 输出放到源文件同目录（同盘、空间足），避免写到 C 盘
  const output = path.join(path.dirname(input), '__lz4_probe_out.bin');
  const started = Date.now();
  let lastTick = 0;

  const result = await decompressLz4Frame(input, output, (p) => {
    if (p - lastTick >= 10) {
      lastTick = p;
      process.stdout.write(`  进度 ${p}%\r`);
    }
  });

  const elapsed = (Date.now() - started) / 1000;
  const outSize = fs.statSync(output).size;

  console.log('  进度 100%                ');
  console.log('解出字节数 :', result.bytesOut);
  console.log('帧头声明量 :', result.declaredSize, result.declaredSize === 0 ? '(帧里没写)' : '');
  console.log('内容校验和 :', result.checksumOk === null ? '帧里没有校验和' : result.checksumOk ? '通过 ✔' : '不通过 ✘');
  console.log('帧数       :', result.frames);
  console.log('输出文件   :', output, '实际大小', outSize);
  console.log('内层格式   :', sniff(result.head));
  console.log('内层开头   :', result.head.subarray(0, 16).toString('hex', 0, 16).replace(/(..)/g, '$1 ').trim());
  console.log('耗时       :', elapsed.toFixed(1) + ' 秒（' + (result.bytesOut / 1e6 / elapsed).toFixed(0) + ' MB/s 输出）');

  if (process.argv.includes('--keep')) {
    console.log('\n(--keep：输出保留在', output, ')');
  } else {
    fs.rmSync(output, { force: true });
  }
})();
