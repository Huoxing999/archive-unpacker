// archiveBaseName 新逻辑的边界自测（与 renderer.ts 里的实现保持一致）
const ARCHIVE_SUFFIXES = new Set(['7z', 'zip', 'rar', 'lz4', 'tar', 'gz', 'bz2', 'xz']);
const VOLUME_SUFFIX_RE = /^\.(?:part[1-9]\d{0,2}|\d{3})$/i;

function archiveBaseName(fileName) {
  let base = fileName;
  const firstDot = base.lastIndexOf('.');
  if (firstDot > 0) base = base.slice(0, firstDot);
  for (let i = 0; i < 2; i += 1) {
    const dot = base.lastIndexOf('.');
    if (dot <= 0) break;
    const ext = base.slice(dot + 1).toLowerCase();
    const isVolume = VOLUME_SUFFIX_RE.test(base.slice(dot));
    const isArchive = ARCHIVE_SUFFIXES.has(ext);
    if (!isVolume && !isArchive) break;
    base = base.slice(0, dot);
  }
  return base;
}

const cases = [
  ['精灵王.7z.001', '精灵王'],
  ['260909-8_2.7z.001', '260909-8_2'],
  ['MygsT.part1.rar', 'MygsT'],
  ['XP3[ADV]啪咔色！～宅男的我和强行推销的辣妹～パコエロ！～キモオタな僕と押し売りギャルズ～ AI汉化版+全CG存档.7z.001', 'XP3[ADV]啪咔色！～宅男的我和强行推销的辣妹～パコエロ！～キモオタな僕と押し売りギャルズ～ AI汉化版+全CG存档'],
  ['game.mp4', 'game'],
  ['game.zip', 'game'],
  ['mlqQj.gif', 'mlqQj'],
  ['2026抖音电商带货实操教程01.lz4', '2026抖音电商带货实操教程01'],
  ['A41', 'A41'],
  ['absolutely.7z', 'absolutely'],
  ['报告.final.zip', '报告.final'],
  ['.hidden', '.hidden'],
  ['abc.tar.gz', 'abc'],
  ['video.2024.mp4', 'video.2024'],
  ['分卷测试.zip.005', '分卷测试'],
  ['数据.part12.rar', '数据'],
  ['正常文件.7z.001', '正常文件'],
];

let bad = 0;
for (const [input, expected] of cases) {
  const got = archiveBaseName(input);
  const ok = got === expected;
  if (!ok) bad += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${input.length > 40 ? input.slice(0, 37) + '...' : input} -> ${got}${ok ? '' : ` (expect ${expected})`}`);
}
console.log(`RESULT PASS=${cases.length - bad} FAIL=${bad}`);
