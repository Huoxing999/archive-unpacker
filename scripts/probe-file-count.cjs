// 探针：对比「单文件 zip」与「多文件 zip」在 7z x -bsp1 下的收尾统计输出
// 只读诊断，产物放在 %TEMP% 里，结束自动清理
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SEVENZIP = 'C:\\Program Files\\7-Zip\\7z.exe';

function show(label, text) {
  // 逐行转义显示，重点看 Files: 行是否在、行首有没有多余字符
  console.log(`===== ${label} stdout (escaped) =====`);
  for (const line of text.split(/\r\n|\r|\n/)) {
    const escaped = JSON.stringify(line);
    if (escaped.length > 0 && escaped !== '""') console.log(escaped);
  }
}

function run(label, build) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cnt-probe-'));
  try {
    const zip = path.join(root, 't.zip');
    const out = path.join(root, 'out');
    fs.mkdirSync(out, { recursive: true });
    build(root, zip);
    execFileSync(SEVENZIP, ['x', zip, `-o${out}`, '-aoa', '-p', '-y', '-bsp1'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = execFileSync(SEVENZIP, ['x', zip, `-o${out}`, '-aoa', '-p', '-y', '-bsp1'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    show(label, stdout);
    const matched = /^Files:\s*(\d+)/m.exec(stdout);
    console.log(`>> ${label}: regex matched = ${matched ? matched[1] : 'NONE'}`);
    console.log();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run('single-file zip', (root, zip) => {
  fs.writeFileSync(path.join(root, 'only.txt'), 'hello single file');
  execFileSync(SEVENZIP, ['a', '-tzip', zip, path.join(root, 'only.txt')], { stdio: 'ignore' });
});

run('multi-file zip', (root, zip) => {
  fs.writeFileSync(path.join(root, 'a.txt'), 'aaa');
  fs.writeFileSync(path.join(root, 'b.txt'), 'bbb');
  execFileSync(SEVENZIP, ['a', '-tzip', zip, path.join(root, 'a.txt'), path.join(root, 'b.txt')], { stdio: 'ignore' });
});

console.log('PROBE DONE');
