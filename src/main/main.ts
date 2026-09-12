import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { decompressLz4Frame, isLz4Magic } from './lz4';
import type {
  ArchiveEntry,
  DefaultsResult,
  ExtractRequest,
  ExtractResult,
  HoistRequest,
  HoistResult,
  NestedAnalyzeRequest,
  NestedAnalyzeResult,
  NestedSkip,
  OpenPathResult,
  PersonalConfig,
  ScanRequest,
  ScanResult,
} from './types';

const ARCHIVE_EXTENSIONS = new Set([
  '.zip',
  '.rar',
  '.7z',
  '.7zip',
  '.tar',
  '.gz',
  '.tgz',
  '.bz2',
  '.tbz',
  '.tbz2',
  '.xz',
  '.txz',
  '.zst',
  '.lz4',
  '.iso',
  '.cab',
  '.wim',
  '.arj',
  '.lzh',
  '.lha',
  '.z',
  '.001',
]);

/** 分卷压缩包命名规则 → 分组 key + 卷序号（序号最小的为主卷） */
const VOLUME_PATTERNS: Array<{ regex: RegExp; build: (m: RegExpMatchArray) => { key: string; index: number } }> = [
  // name.part1.rar / name.part01.rar / name.part1.zip
  {
    regex: /^(.*)\.part(\d{1,4})\.(rar|zip|7z|7zip)$/i,
    build: (m) => ({ key: `${m[1]}#part`, index: Number.parseInt(m[2], 10) }),
  },
  // name.zip.001 / name.7z.001 / name.rar.001
  {
    regex: /^(.*\.(?:zip|7z|7zip|rar|tar|exe))\.(\d{2,4})$/i,
    build: (m) => ({ key: `${m[1]}#num`, index: Number.parseInt(m[2], 10) }),
  },
  // name.r00 / name.r01 ... 以及 name.s00（超过 100 卷）
  {
    regex: /^(.*)\.([rs])(\d{2})$/i,
    build: (m) => ({
      key: `${m[1]}#vol`,
      index: 1 + (m[2].toLowerCase().charCodeAt(0) - 'r'.charCodeAt(0)) * 100 + Number.parseInt(m[3], 10),
    }),
  },
  // name.z01 / name.z02 ...
  {
    regex: /^(.*)\.z(\d{2})$/i,
    build: (m) => ({ key: `${m[1]}#vol`, index: 1 + Number.parseInt(m[2], 10) }),
  },
  // name.001 / name.002 ...
  {
    regex: /^(.*)\.(\d{2,4})$/,
    build: (m) => ({ key: `${m[1]}#num`, index: Number.parseInt(m[2], 10) }),
  },
];

interface VolumeInfo {
  key: string;
  index: number;
}

function parseVolumeName(fileName: string): VolumeInfo {
  for (const pattern of VOLUME_PATTERNS) {
    const matched = fileName.match(pattern.regex);
    if (matched) {
      return pattern.build(matched);
    }
  }

  // 普通压缩包：主卷，序号 0
  return { key: `${fileName.replace(/\.[^.]+$/, '')}#vol`, index: 0 };
}

let mainWindow: BrowserWindow | null = null;

function isArchiveFile(fileName: string): boolean {
  const extension = path.extname(fileName).toLowerCase();
  return ARCHIVE_EXTENSIONS.has(extension);
}

function startsWith(buffer: Buffer, bytes: number[]): boolean {
  if (buffer.length < bytes.length) return false;
  return bytes.every((byte, index) => buffer[index] === byte);
}

function hasArchiveSignature(buffer: Buffer): boolean {
  if (
    startsWith(buffer, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWith(buffer, [0x50, 0x4b, 0x05, 0x06]) ||
    startsWith(buffer, [0x50, 0x4b, 0x07, 0x08]) ||
    startsWith(buffer, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]) ||
    startsWith(buffer, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]) ||
    startsWith(buffer, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) ||
    startsWith(buffer, [0x1f, 0x8b]) ||
    startsWith(buffer, [0x42, 0x5a, 0x68]) ||
    startsWith(buffer, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]) ||
    startsWith(buffer, [0x28, 0xb5, 0x2f, 0xfd]) ||
    isLz4Magic(buffer)
  ) {
    return true;
  }

  if (buffer.length >= 262 && buffer.subarray(257, 262).toString('ascii') === 'ustar') {
    return true;
  }

  return false;
}

/** 7-Zip 判定结果：是压缩包 / 是加密压缩包 / 不是压缩包 */
type ProbeResult = 'archive' | 'encrypted' | 'not-archive';

function looksEncrypted(output: string): boolean {
  return /(wrong\s+password|password|encrypted|密码|口令)/i.test(output);
}

function probeSevenZipOutput(exitCode: number | null, output: string): ProbeResult {
  if (exitCode === 0) return 'archive';

  // 加密压缩包（含加密文件头）7z 会报密码错误，但它确实是压缩包
  if (looksEncrypted(output)) return 'encrypted';

  return 'not-archive';
}

/** 用 7-Zip 实际打开文件来判断是不是压缩包，比看后缀和文件头都靠谱 */
function probeArchiveWith7z(sevenZipPath: string, filePath: string, timeoutMs = 20000): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const child = spawn(sevenZipPath, ['l', filePath, '-p', '-y', '-bso0', '-bsp0'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    let settled = false;

    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer: NodeJS.Timeout = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // 进程可能已结束
      }
      finish('not-archive');
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (output.length < 20000) output += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      if (output.length < 20000) output += chunk;
    });

    child.on('error', () => finish('not-archive'));
    child.on('close', (exitCode) => finish(probeSevenZipOutput(exitCode, output)));
  });
}

const ZIP_EOCD = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const ZIP_CENTRAL = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
const ZIP_LOCAL = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/**
 * 检测「前面拼接了无关数据（视频等）的 ZIP」。
 * 实测 7-Zip 25.01 对前置数据的容忍度**跟扩展名有关**：
 *   - `.zip`：3MB 前置就已经打不开（容忍度很低）
 *   - `.png` / `.mp4` / `.bin` / `.7z`：约 8MB 仍能认，12MB 失败
 * 因为改名现在统一放到解压**成功之后**，首次尝试用的还是原始后缀（如 .png），
 * 容忍度反而更高；一旦超出就靠这里算出前置了多少字节，解压前原地剥掉。
 */
async function detectPrependedZip(filePath: string): Promise<number | null> {
  let handle;
  try {
    const size = (await fs.stat(filePath)).size;
    if (size < 4096) return null;

    handle = await fs.open(filePath, 'r');
    const tailLength = Math.min(size, 65557);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, size - tailLength);

    const eocdIndex = tail.lastIndexOf(ZIP_EOCD);
    if (eocdIndex < 0 || eocdIndex + 22 > tailLength) return null;

    const entries = tail.readUInt16LE(eocdIndex + 10);
    const cdSize = tail.readUInt32LE(eocdIndex + 12);
    const cdOffset = tail.readUInt32LE(eocdIndex + 16);
    if (entries === 0 || cdSize === 0) return null;

    const eocdPosition = size - tailLength + eocdIndex;
    const actualCdPosition = eocdPosition - cdSize;
    if (actualCdPosition <= 0) return null;

    const prefix = actualCdPosition - cdOffset;
    if (prefix <= 0 || prefix >= size) return null;

    // 确认真正的中央目录位置确实是 PK\x01\x02
    const cdHead = Buffer.alloc(4);
    await handle.read(cdHead, 0, 4, actualCdPosition);
    if (!cdHead.equals(ZIP_CENTRAL)) return null;

    // 确认剥掉前置数据后，开头就是本地文件头
    const localHead = Buffer.alloc(4);
    await handle.read(localHead, 0, 4, prefix);
    if (!localHead.equals(ZIP_LOCAL)) return null;

    return prefix;
  } catch {
    return null;
  } finally {
    if (handle) {
      await handle.close().catch(() => undefined);
    }
  }
}

/**
 * 原地去掉文件开头的前置无关数据（视频等），不产生任何副本。
 * 读取位置始终大于写入位置，逐块搬移是安全的，最后截断文件尾部即可。
 */
async function stripPrefixInPlace(filePath: string, prefix: number): Promise<void> {
  const handle = await fs.open(filePath, 'r+');
  try {
    const total = (await handle.stat()).size;
    const chunkSize = 8 * 1024 * 1024;
    const buffer = Buffer.alloc(chunkSize);

    let readPosition = prefix;
    let writePosition = 0;

    while (readPosition < total) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(chunkSize, total - readPosition), readPosition);
      if (bytesRead <= 0) break;

      await handle.write(buffer, 0, bytesRead, writePosition);
      readPosition += bytesRead;
      writePosition += bytesRead;
    }

    await handle.truncate(writePosition);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function mapWithLimit<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}

async function hasArchiveSignatureFromFile(filePath: string): Promise<boolean> {
  let handle;
  try {
    handle = await fs.open(filePath, 'r');
    const buffer = Buffer.alloc(512);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return hasArchiveSignature(buffer.subarray(0, bytesRead));
  } catch {
    return false;
  } finally {
    if (handle) {
      await handle.close().catch(() => undefined);
    }
  }
}

/**
 * 分卷的后续卷（本身不是可独立识别的压缩包后缀），
 * 例如 .r00/.s00/.z01 以及 xxx.7z.002 / xxx.002
 */
function isVolumeCompanion(fileName: string): boolean {
  return /\.([rsz])\d{2}$/i.test(fileName) || /\.(?:zip|7z|7zip|rar|tar|exe)\.\d{2,4}$/i.test(fileName) || /\.\d{2,4}$/.test(fileName);
}

/* ---------------- LZ4 压缩流：7-Zip 不支持，得自己解开 ---------------- */

/** 7-Zip 只看文件头，所以中间文件的后缀随便起，这里用个一眼能看出是临时的 */
const LZ4_TEMP_SUFFIX = '.__lz4_tmp__';

/**
 * LZ4 解出来的内层东西可能是啥。靠文件头认，认不出来就当普通文件（后缀留空）。
 * 顺序有讲究：先认长得最像的压缩包，别被后面的短魔数抢了。
 */
const INNER_FORMATS: Array<{ ext: string; label: string; isArchive: boolean; test: (buffer: Buffer) => boolean }> = [
  {
    ext: '.zip',
    label: 'ZIP',
    isArchive: true,
    test: (b) => startsWith(b, [0x50, 0x4b, 0x03, 0x04]) || startsWith(b, [0x50, 0x4b, 0x05, 0x06]) || startsWith(b, [0x50, 0x4b, 0x07, 0x08]),
  },
  { ext: '.7z', label: '7-Zip', isArchive: true, test: (b) => startsWith(b, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) },
  { ext: '.rar', label: 'RAR', isArchive: true, test: (b) => startsWith(b, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]) },
  { ext: '.cab', label: 'CAB', isArchive: true, test: (b) => startsWith(b, [0x4d, 0x53, 0x43, 0x46]) },
  { ext: '.gz', label: 'gzip', isArchive: true, test: (b) => startsWith(b, [0x1f, 0x8b]) },
  { ext: '.bz2', label: 'bzip2', isArchive: true, test: (b) => startsWith(b, [0x42, 0x5a, 0x68]) },
  { ext: '.xz', label: 'xz', isArchive: true, test: (b) => startsWith(b, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]) },
  { ext: '.zst', label: 'zstd', isArchive: true, test: (b) => startsWith(b, [0x28, 0xb5, 0x2f, 0xfd]) },
  { ext: '.tar', label: 'tar', isArchive: true, test: (b) => b.length >= 262 && b.subarray(257, 262).toString('ascii') === 'ustar' },
];

interface InnerFormat {
  ext: string;
  label: string;
  isArchive: boolean;
}

function detectInnerFormat(head: Buffer): InnerFormat {
  for (const format of INNER_FORMATS) {
    if (format.test(head)) return { ext: format.ext, label: format.label, isArchive: format.isArchive };
  }
  return { ext: '', label: '普通文件', isArchive: false };
}

/** 只看文件头，判断这是不是一个 LZ4 压缩流 */
async function isLz4File(filePath: string): Promise<boolean> {
  let handle;
  try {
    handle = await fs.open(filePath, 'r');
    const head = Buffer.alloc(8);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    return isLz4Magic(head.subarray(0, bytesRead));
  } catch {
    return false;
  } finally {
    if (handle) {
      await handle.close().catch(() => undefined);
    }
  }
}

interface Lz4StageResult {
  ok: boolean;
  error: string;
  /** 解出来的内层临时文件（位于源文件旁边） */
  innerPath: string;
  innerExt: string;
  innerLabel: string;
  innerIsArchive: boolean;
  bytes: number;
}

/**
 * 把 LZ4 压缩流解到源文件旁边的临时文件，并判断内层是什么。
 * 中间文件怎么收尾由调用方决定（成功即删 / 失败改名保留）。
 */
async function expandLz4Source(
  archivePath: string,
  onProgress?: (percent: number) => void,
): Promise<Lz4StageResult> {
  const target = `${archivePath}${LZ4_TEMP_SUFFIX}`;
  const failed = (error: string): Lz4StageResult => ({
    ok: false,
    error,
    innerPath: '',
    innerExt: '',
    innerLabel: '',
    innerIsArchive: false,
    bytes: 0,
  });

  try {
    // 上一次失败可能留下过半截，先清掉，保证每次都是干净的一遍
    await fs.rm(target, { force: true }).catch(() => undefined);
    const result = await decompressLz4Frame(archivePath, target, onProgress);
    const format = detectInnerFormat(result.head);
    return {
      ok: true,
      error: '',
      innerPath: target,
      innerExt: format.ext,
      innerLabel: format.label,
      innerIsArchive: format.isArchive,
      bytes: result.bytesOut,
    };
  } catch (error) {
    await fs.rm(target, { force: true }).catch(() => undefined);
    return failed(error instanceof Error ? error.message : String(error));
  }
}

/** 内层文件的自然名字：去掉 .lz4，再按识别结果补后缀（已经是这个后缀就不重复补） */
function innerFileName(archivePath: string, innerExt: string): string {
  const base = path.basename(archivePath, path.extname(archivePath));
  if (!innerExt) return base;
  return base.toLowerCase().endsWith(innerExt) ? base : `${base}${innerExt}`;
}

interface ScanCandidate {
  path: string;
  name: string;
  directory: string;
  size: number;
  modifiedMs: number;
  disguised: boolean;
  /** 是否为可独立解压的压缩包（真实压缩包后缀或伪装后缀） */
  real: boolean;
  /** 完全没后缀、但文件头证明它是压缩包（如被丢了后缀的 A41） */
  noExtension: boolean;
  index: number;
}

let lastProgressAt = 0;

function reportProgress(phase: 'collect' | 'verify', done: number, total: number, current: string): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  // 文件很多时限流，避免 IPC 刷屏拖慢扫描
  const now = Date.now();
  if (now - lastProgressAt < 80 && done < total) return;
  lastProgressAt = now;

  mainWindow.webContents.send('scan-progress', { phase, done, total, current });
}

/** 解压进度限流表：每个任务 id 单独计时，避免 IPC 刷屏 */
const extractProgressAt = new Map<string, number>();

function reportExtractProgress(id: string, percent: number): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const now = Date.now();
  const last = extractProgressAt.get(id) ?? 0;
  if (now - last < 120 && percent < 100) return;
  extractProgressAt.set(id, now);

  mainWindow.webContents.send('extract-progress', { id, percent });
}

async function scanFolder(request: ScanRequest): Promise<ScanResult> {
  const folder = request.folder.trim();
  const absoluteFolder = path.resolve(folder);
  const groups = new Map<string, ScanCandidate[]>();
  const disguisedExtensions = new Set(
    (request.disguisedExtensions ?? []).map((value) => value.toLowerCase().replace(/^\./, '')),
  );
  const sevenZipPath = await resolveSevenZipPath();
  const verify = request.verifyWith7z && Boolean(sevenZipPath);
  // 严格模式：连伪装后缀也要 7-Zip 点头才收（嵌套扫描用）
  const strictDisguised = Boolean(request.strictDisguised);

  const emptyResult = (error?: string): ScanResult => ({
    folder: absoluteFolder,
    archives: [],
    sevenZipPath,
    verified: 0,
    rejected: [],
    used7zVerify: false,
    error,
  });

  async function walk(currentDir: string, depth: number): Promise<void> {
    if (depth > 20) return;

    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (request.recursive && !entry.name.startsWith('.')) {
          await walk(entryPath, depth + 1);
        }
        continue;
      }

      if (!entry.isFile()) continue;

      const extension = path.extname(entry.name).toLowerCase().replace(/^\./, '');
      const hasKnownExtension = isArchiveFile(entry.name);
      // 伪装后缀：开启校验时全部交给 7-Zip 判定；否则用文件头兜底
      const disguised = !hasKnownExtension && disguisedExtensions.has(extension);
      // 完全没后缀、但文件头证明它是压缩包（比如被丢了后缀的 A41）：
      // 按内容认出来，当成正经压缩包收进候选，解压时再补上正确后缀。
      const noExtension = extension === '' && !hasKnownExtension && !disguised;
      const noExtArchive = noExtension && (await hasArchiveSignatureFromFile(entryPath));
      const real = hasKnownExtension || disguised || noExtArchive;
      // 分卷的后续卷也要收进来，否则统计卷数会漏
      const companion = !real && isVolumeCompanion(entry.name);

      if (!real && !companion) continue;

      let stats;
      try {
        stats = await fs.stat(entryPath);
      } catch {
        continue;
      }

      reportProgress('collect', groups.size, groups.size + 1, entry.name);

      const volume = parseVolumeName(entry.name);
      const groupKey = `${currentDir.toLowerCase()}|${volume.key}`;
      const candidate: ScanCandidate = {
        path: entryPath,
        name: entry.name,
        directory: currentDir,
        size: stats.size,
        modifiedMs: stats.mtimeMs,
        disguised,
        real,
        noExtension: noExtArchive,
        index: volume.index,
      };

      const bucket = groups.get(groupKey);
      if (bucket) {
        bucket.push(candidate);
      } else {
        groups.set(groupKey, [candidate]);
      }
    }
  }

  try {
    const stats = await fs.stat(absoluteFolder);
    if (!stats.isDirectory()) {
      return emptyResult('所选路径不是文件夹。');
    }
    await walk(absoluteFolder, 0);
  } catch {
    return emptyResult('文件夹不存在或无法访问。');
  }

  const buckets = [...groups.values()].filter((bucket) => bucket.some((item) => item.real));
  for (const bucket of buckets) {
    bucket.sort((a, b) => a.index - b.index || a.name.localeCompare(b.name, 'zh-Hans-CN'));
  }

  const rejected: string[] = [];
  let verified = 0;
  const accepted: ScanCandidate[][] = [];

  if (verify && sevenZipPath) {
    const mains = buckets.map((bucket) => bucket.find((item) => item.real) ?? bucket[0]);
    let done = 0;

    const results = await mapWithLimit(mains, 4, async (candidate) => {
      // LZ4 是 7-Zip 不认识的格式，别让它把人家判成「非压缩包」
      const result: ProbeResult = (await isLz4File(candidate.path))
        ? 'archive'
        : await probeArchiveWith7z(sevenZipPath, candidate.path);

      done += 1;
      reportProgress('verify', done, mains.length, candidate.name);
      return result;
    });

    mains.forEach((candidate, index) => {
      // 用户自己标记的伪装后缀默认一律保留，7-Zip 判定只作用于常规压缩包；
      // 但严格模式（嵌套扫描）下伪装后缀也要通过判定，避免把解压出来的图片/PDF 当成压缩包
      if (results[index] === 'not-archive' && (!candidate.disguised || strictDisguised)) {
        rejected.push(candidate.name);
        return;
      }

      verified += 1;
      accepted.push(buckets[index]);
    });
  } else {
    // 不校验（默认）：直接按后缀收录，用户标记的伪装后缀不需要任何判定
    for (const bucket of buckets) accepted.push(bucket);
  }

  const archives: ArchiveEntry[] = [];
  for (const bucket of accepted) {
    const main = bucket.find((item) => item.real) ?? bucket[0];

    archives.push({
      id: randomUUID(),
      path: main.path,
      name: main.name,
      extension: path.extname(main.name).toLowerCase(),
      directory: main.directory,
      size: bucket.reduce((total, item) => total + item.size, 0),
      modifiedMs: main.modifiedMs,
      partCount: bucket.length,
      partPaths: bucket.map((item) => item.path),
      disguised: main.disguised,
    });
  }

  const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });
  archives.sort((a, b) => collator.compare(a.name, b.name) || collator.compare(a.path, b.path));

  return { folder: absoluteFolder, archives, sevenZipPath, verified, rejected, used7zVerify: verify };
}

/* ---------------- 嵌套解压：还需不需要继续解 ---------------- */

/** 阈值默认值：刚解压出来的文件数超过它就不再往下解 */
const NESTED_FILE_THRESHOLD_DEFAULT = 3;
const NESTED_FILE_THRESHOLD_MAX = 999;

function clampNestedFileThreshold(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return NESTED_FILE_THRESHOLD_DEFAULT;
  return Math.min(NESTED_FILE_THRESHOLD_MAX, Math.floor(parsed));
}

interface ShellFile {
  path: string;
  name: string;
  directory: string;
  size: number;
  modifiedMs: number;
}

/** 输出目录里「有且只有一个」文件时把它找出来（用于识别单文件套壳） */
async function findSingleFile(folder: string, maxDepth = 8): Promise<ShellFile | null> {
  const found: ShellFile[] = [];

  const walk = async (currentDir: string, depth: number): Promise<void> => {
    if (depth > maxDepth || found.length > 1) return;

    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (found.length > 1) return;

      const entryPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.')) await walk(entryPath, depth + 1);
        continue;
      }

      if (!entry.isFile()) continue;

      try {
        const stats = await fs.stat(entryPath);
        found.push({
          path: entryPath,
          name: entry.name,
          directory: currentDir,
          size: stats.size,
          modifiedMs: stats.mtimeMs,
        });
      } catch {
        continue;
      }
    }
  };

  await walk(path.resolve(folder), 0);
  return found.length === 1 ? found[0] : null;
}

/** 后缀是否属于你登记的「伪装后缀」（常规压缩包后缀不算） */
function isRegisteredDisguised(fileName: string, disguisedExtensions: string[]): boolean {
  if (isArchiveFile(fileName)) return false;

  const extension = path.extname(fileName).toLowerCase().replace(/^\./, '');
  if (!extension) return false;

  return disguisedExtensions.some((value) => value.toLowerCase().replace(/^\./, '') === extension);
}

function entryFromSingleFile(file: ShellFile): ArchiveEntry {
  return {
    id: randomUUID(),
    path: file.path,
    name: file.name,
    extension: path.extname(file.name).toLowerCase(),
    directory: file.directory,
    size: file.size,
    modifiedMs: file.modifiedMs,
    partCount: 1,
    partPaths: [file.path],
    disguised: true,
  };
}

interface TopEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

/** 只看输出目录里直接躺着什么（不往下走） */
async function readTopEntries(folder: string): Promise<TopEntry[]> {
  const resolved = path.resolve(folder);
  try {
    const entries = await fs.readdir(resolved, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      path: path.join(resolved, entry.name),
      isDirectory: entry.isDirectory(),
    }));
  } catch {
    return [];
  }
}

async function countChildren(folder: string): Promise<number> {
  try {
    return (await fs.readdir(path.resolve(folder))).length;
  } catch {
    return 0;
  }
}

/** child 是否严格位于 root 里面（不包含 root 自身） */
function isPathInside(child: string, root: string): boolean {
  const relative = path.relative(root, child);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** 找一个不冲突的落点，绝对不覆盖已有东西 */
async function uniqueTargetPath(candidate: string): Promise<string> {
  if (!existsSync(candidate)) return candidate;

  const directory = path.dirname(candidate);
  const extension = path.extname(candidate);
  const base = path.basename(candidate, extension);

  for (let index = 1; index < 10000; index += 1) {
    const next = path.join(directory, `${base}(${index})${extension}`);
    if (!existsSync(next)) return next;
  }

  throw new Error('同名文件太多，找不到可用的落点。');
}

/**
 * 搬移文件夹。
 * 成品文件夹按定义就位于源目录之中，和目标同属一个卷，所以 rename 就够了、也是原子的；
 * 这里**不做「跨卷复制 + 递归删除」的兜底** —— 那种兜底一旦中途出错就会留下半份数据，
 * 宁可报错让用户自己处理。
 */
async function moveDirectory(from: string, to: string): Promise<void> {
  try {
    await fs.rename(from, to);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EXDEV') {
      throw new Error('跨磁盘搬移暂不支持，请手动移动。');
    }
    throw error;
  }
}

/**
 * 把解到头的成品文件夹搬回源目录，并清掉这一路留下的空目录外壳。
 *
 * 安全约束（全部是硬性的）：
 *  - 目标重名绝不覆盖，自动加 (1)(2)；
 *  - 成品必须在源目录里面才动手，否则拒绝；
 *  - 清理空目录只用 rmdir（非空必然失败），**绝不做递归删除**；
 *  - 一路上行清理，但**永不碰源目录本身**。
 */
async function hoistFinishedFolder(request: HoistRequest): Promise<HoistResult> {
  const failure = (error: string): HoistResult => ({
    ok: false,
    movedFrom: '',
    movedTo: '',
    removedDirs: [],
    keptDirs: [],
    error,
  });

  if (!request.folder?.trim()) return failure('没有指定要搬的文件夹。');
  if (!request.targetRoot?.trim()) return failure('没有设置「压缩包文件夹」，不敢搬移。');

  const source = path.resolve(request.folder);
  const targetRoot = path.resolve(request.targetRoot);

  if (!existsSync(source)) return failure('要搬的文件夹不存在。');
  if (!existsSync(targetRoot)) return failure('目标目录不存在。');

  let stats;
  try {
    stats = await fs.stat(source);
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
  if (!stats.isDirectory()) return failure('要搬的不是文件夹。');

  if (source.toLowerCase() === targetRoot.toLowerCase()) {
    return failure('不能搬移目标目录本身。');
  }

  // 成品本来就在源目录里、且已经直接躺在源目录下 → 什么都不用做
  if (path.dirname(source).toLowerCase() === targetRoot.toLowerCase()) {
    return { ok: true, movedFrom: source, movedTo: source, removedDirs: [], keptDirs: [], error: '' };
  }

  // 只在「源目录里面」动手，避免把别处的目录搬过来
  if (!isPathInside(source, targetRoot)) {
    return failure('成品文件夹不在「压缩包文件夹」里面，出于安全考虑不做处理。');
  }

  const desired = path.join(targetRoot, path.basename(source));
  let target: string;
  try {
    target = await uniqueTargetPath(desired);
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }

  try {
    await moveDirectory(source, target);
  } catch (error) {
    return failure(`搬移失败：${error instanceof Error ? error.message : String(error)}`);
  }

  // 从原位置一路上行，删掉已经空了的目录；一遇到还有东西的就停
  const removedDirs: string[] = [];
  const keptDirs: string[] = [];
  let cursor = path.dirname(source);

  while (isPathInside(cursor, targetRoot)) {
    let entries;
    try {
      entries = await fs.readdir(cursor);
    } catch {
      break;
    }

    if (entries.length > 0) {
      // 里面还有别的东西（另一个包、用户自己的文件），到此为止，绝不动它
      keptDirs.push(cursor);
      break;
    }

    try {
      await fs.rmdir(cursor);
      removedDirs.push(cursor);
    } catch {
      keptDirs.push(cursor);
      break;
    }

    cursor = path.dirname(cursor);
  }

  // 撞名要回原名：目标名被占时加了序号（如 A41(1)）。如果占名的正是这条待删的空壳链
  //（A41 资料包整条链每层都叫同一个名字），清完链之后名字就空出来了 —— 把名字要回来，
  // 别给用户留下「A41(1)」这种别扭落点名。要不回来就保留带序号的名字，内容不受影响。
  if (target !== desired && !existsSync(desired)) {
    try {
      await fs.rename(target, desired);
      target = desired;
    } catch {
      /* 保留带序号的名字即可 */
    }
  }

  return { ok: true, movedFrom: source, movedTo: target, removedDirs, keptDirs, error: '' };
}

/**
 * 解压完一层后，判断输出目录里还有哪些包「确实需要继续解」。
 *
 * 判定顺序：
 *  1. **成品判定**（只在套壳链里，即深度 ≥ 1）：输出目录里只有 1 个文件夹、
 *     且那个文件夹里不止一个东西 → 这就是解到头的成品，不再往下解，
 *     交给渲染层把它搬回源目录（见 `hoistFinishedFolder`）。
 *  2. 层数护栏：内部最多 3 层（安全网，不给用户调）。
 *  2.5 **成品判定·散装形态**（同样深度 ≥ 1，护栏之后）：输出目录里直接就有不止一项
 *     （A41 型：最后一层包的根下散着 存档/游戏文件夹，没有壳文件夹包着）
 *     → 输出目录本身就是成品，整个搬回源目录。放在护栏之后：到护栏深度彻底收手。
 *  3. **单文件套壳**：解压出来只有一个文件，且它的后缀在你登记的伪装后缀里
 *     → 直接判定为"还要继续解"，**不再用 7-Zip 去试探**。
 *     资料包就是这么一层层套下来的（xxx.7z.001 → xxx.pdf → xxx.tif → …），
 *     一个文件一个壳，问 7-Zip 既慢又可能被加密头挡住。后缀是你自己登记的，
 *     等于你已经告诉过程序"这类后缀可能是套壳"，那就直接照做。
 *     （真不是压缩包也没关系：改名和删源包都只在解压成功后做，最多多一条失败记录。）
 *  4. 文件数 > 阈值（默认 3，可设置）→ 说明已经是正常内容，收手。
 *  5. 其余情况：7-Zip 严格校验，只有真能列出清单的压缩包才继续解
 *     —— 这一条挡住解压出来的真 jpg / pdf / 视频。
 */
async function analyzeNestedArchives(request: NestedAnalyzeRequest): Promise<NestedAnalyzeResult> {
  const empty = (): NestedAnalyzeResult => ({
    follow: [],
    skipped: [],
    used7zVerify: false,
    stopReason: '',
    notes: [],
    finishedFolder: '',
  });

  // 1) 成品判定（任何深度都做，包括最外层）：
  //    输出目录里只有 1 个文件夹、且那个文件夹里不止一个东西
  //    → 这就是解到头的成品，不再往下解，改为把它搬回源目录。
  //    v2LwY 实测：顶层伪装包（v2LwY.json）解出「1 个目录含 2 项」，
  //    旧规则要求 depth≥1 导致成品埋在两层壳里不搬，用户明确要搬。
  //    最外层搬的是「里面的那个目录」，壳（输出目录）在搬移后清掉，不会动源目录本身。
  const top = await readTopEntries(request.folder);
  if (top.length === 1 && top[0].isDirectory) {
    const childCount = await countChildren(top[0].path);
    if (childCount > 1) {
      return {
        ...empty(),
        finishedFolder: top[0].path,
        notes: [`「${top[0].name}」里有 ${childCount} 项，是解到头的成品，不再往下解`],
      };
    }
  }

  // 层数护栏已按用户要求移除：多深的链都继续解。
  // 停下来的兜底仍是后面几条：散装/套壳成品判定、文件数阈值、严格扫描。

  // 2.5) 成品判定·散装形态：输出目录里**直接**就有不止一项。
  //      上面的第 1 步认的是「1 个壳文件夹包着成品」（BARE＆BUNNY 型）；
      //      但像 A41 资料包这种，最后一层包的根下直接散着 存档/游戏文件夹 等多个条目，
  //      没有壳文件夹包着 —— 按用户规则「下不止一个文件或文件夹 = 解到头」，
  //      输出目录本身就是成品，整个搬回源目录。
  //      放在层数护栏之后：到护栏深度就彻底收手，安全网优先于搬移。
  if (request.depth >= 1) {
    const top = await readTopEntries(request.folder);
    if (top.length > 1) {
      return {
        ...empty(),
        finishedFolder: path.resolve(request.folder),
        notes: [
          `「${path.basename(request.folder)}」里直接有 ${top.length} 项成品，不再往下解，整个文件夹搬回源目录`,
        ],
      };
    }
  }

  const threshold = clampNestedFileThreshold(request.fileThreshold);

  // 3) 单文件套壳：只解出一个文件，且后缀是登记过的伪装后缀 → 直接继续解
  if (request.parentFileCount === 1) {
    const single = await findSingleFile(request.folder);
    if (single && isRegisteredDisguised(single.name, request.disguisedExtensions)) {
      return {
        ...empty(),
        follow: [entryFromSingleFile(single)],
        notes: [
          `只解出 1 个文件 ${single.name}，后缀 ${path.extname(single.name).toLowerCase()} 是你登记过的伪装后缀，直接改名继续解压`,
        ],
      };
    }
  }

  // 4) 解压出来的文件超过阈值就收手
  if (request.parentFileCount > threshold) {
    return {
      ...empty(),
      stopReason: `刚解压出 ${request.parentFileCount} 个文件，超过设定的 ${threshold} 个，不再继续解压嵌套包`,
    };
  }

  const requested = request.sevenZipPath?.trim();
  const sevenZipPath =
    requested && (await isExecutableFile(requested)) ? path.resolve(requested) : await resolveSevenZipPath();
  if (!sevenZipPath) return empty();

  // 5) 严格扫描：strictDisguised + 7-Zip 逐个判定，
  //    所以「解压出来的正常图片/文档」都不会进候选
  const scan = await scanFolder({
    folder: request.folder,
    recursive: true,
    disguisedExtensions: request.disguisedExtensions,
    verifyWith7z: true,
    strictDisguised: true,
  });

  // 拿不到 7-Zip 判定就不敢下结论：宁可不追，也不乱解用户的正常文件
  if (scan.error || !scan.used7zVerify) return empty();

  const seenPaths = new Set<string>([path.resolve(request.parentPath).toLowerCase()]);
  const follow: ArchiveEntry[] = [];
  const skipped: NestedSkip[] = [];

  for (const name of scan.rejected) {
    skipped.push({ name, reason: '7-Zip 确认它不是压缩包（正常文件）' });
  }

  for (const archive of scan.archives) {
    const key = path.resolve(archive.path).toLowerCase();
    if (seenPaths.has(key)) continue;
    seenPaths.add(key);

    // 这里**不看后缀**：伪装后缀只要过了 7-Zip 这一关，就是真压缩包，照样往下解。
    follow.push(archive);
  }

  return { follow, skipped, used7zVerify: true, stopReason: '', notes: [], finishedFolder: '' };
}

async function resolveSevenZipPath(): Promise<string | null> {
  const candidatePaths = [
    process.env.SEVENZIP_PATH,
    process.env['7ZIP_PATH'],
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', '7-Zip', '7z.exe'),
    path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', '7-Zip', '7z.exe'),
  ].filter((value): value is string => Boolean(value && typeof value === 'string'));

  for (const candidate of candidatePaths) {
    try {
      if (await isExecutableFile(candidate)) {
        return path.resolve(candidate);
      }
    } catch {
      // Keep checking the next candidate.
    }
  }

  return null;
}

interface AttemptResult {
  success: boolean;
  wrongPassword: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** 7-Zip 收尾统计里的文件数（Files: N，不含文件夹） */
  files: number;
}

/** 从 7z x 的收尾统计里取「解压出来几个文件」 */
function parseExtractedFileCount(output: string): number {
  const matched = /^Files:\s*(\d+)/m.exec(output);
  if (matched) {
    const parsed = Number.parseInt(matched[1], 10);
    if (Number.isFinite(parsed)) return parsed;
  }

  // 7-Zip（25.01 实测）对「只解出一个文件」的包不打 Files: 行，只打 Size:/Compressed:，
  // 多文件和 0 文件才有 Files: 行。这个函数只在解压成功后被调用，
  // 此时收尾统计里有非零 Size: 就是单文件场景，按 1 个文件计。
  // 注意 7z 还会打「Physical Size = N」但行首不是 Size:，不会误中。
  if (/^Size:\s*[1-9]/m.test(output)) return 1;

  return 0;
}

function looksLikeWrongPassword(output: string): boolean {
  return /(?:wrong\s+password|password\s+(?:is\s+)?not\s+correct|incorrect\s+password|cannot?\s+open\s+encrypted\s+archive|can\s+not\s+open\s+encrypted\s+archive|password\s+mismatch|密码错误|密码不正确)/i.test(
    output,
  );
}

function runSevenZipAttempt(
  sevenZipPath: string,
  archivePath: string,
  outputDir: string,
  password: string,
  onProgress?: (percent: number) => void,
): Promise<AttemptResult> {
  // -bsp1：把进度百分比写到 stdout，用来喂进度条
  const args = ['x', archivePath, `-o${outputDir}`, '-aoa', password.length > 0 ? `-p${password}` : '-p', '-y', '-bsp1'];

  return new Promise((resolve) => {
    const child = spawn(sevenZipPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;

      if (!onProgress) return;

      // 7-Zip 的进度行形如 " 45% 12 - name"，用 \r 就地刷新；只认行首的百分比，
      // 避免文件名里带 % 造成误判
      const lines = chunk.split(/\r\n|\r|\n/);
      let latest: number | null = null;
      for (const line of lines) {
        const matched = /^\s*(\d{1,3})%/.exec(line);
        if (matched) {
          const percent = Number.parseInt(matched[1], 10);
          if (Number.isFinite(percent)) latest = Math.min(100, Math.max(0, percent));
        }
      }

      if (latest !== null) onProgress(latest);
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (error) => {
      resolve({
        success: false,
        wrongPassword: false,
        exitCode: null,
        stdout,
        stderr: `${stderr}\n${error.message}`,
        files: 0,
      });
    });

    child.on('close', (exitCode) => {
      const output = `${stdout}\n${stderr}`;
      const wrongPassword = looksLikeWrongPassword(output);
      const success = exitCode === 0 || (exitCode === 1 && !wrongPassword);

      resolve({
        success,
        wrongPassword,
        exitCode,
        stdout,
        stderr,
        // 只有成功时这个统计才有意义（失败时 7-Zip 会打出部分统计）
        files: success ? parseExtractedFileCount(stdout) : 0,
      });
    });
  });
}

/** 规范化改名后缀，非法值一律回落到 zip */
function normalizeRenameExtension(value: string | undefined): string {
  const cleaned = (value ?? '').trim().toLowerCase().replace(/^\./, '');
  return /^[a-z0-9]{1,8}$/.test(cleaned) ? cleaned : 'zip';
}

/** 把伪装后缀文件永久改名（默认 .zip，可在设置里改），原文件不复原 */
async function renameDisguisedFile(filePath: string, extension: string): Promise<string> {
  const directory = path.dirname(filePath);
  const base = path.basename(filePath, path.extname(filePath));
  let target = path.join(directory, `${base}.${extension}`);
  let counter = 1;

  while (existsSync(target)) {
    target = path.join(directory, `${base}(${counter}).${extension}`);
    counter += 1;
  }

  await fs.rename(filePath, target);
  return target;
}

async function extractArchive(
  request: ExtractRequest,
  onProgress?: (percent: number) => void,
): Promise<ExtractResult> {
  const archivePath = path.resolve(request.archivePath);
  const outputDir = path.resolve(request.outputDir);
  const requestedSevenZip = request.sevenZipPath?.trim();
  const sevenZipPath = requestedSevenZip
    ? (await isExecutableFile(requestedSevenZip))
      ? path.resolve(requestedSevenZip)
      : null
    : await resolveSevenZipPath();
  const startedAt = Date.now();

  const failure = (error: string): ExtractResult => ({
    archivePath,
    outputDir,
    success: false,
    wrongPassword: false,
    exitCode: null,
    matchedPasswordIndex: null,
    error,
    elapsedMs: Date.now() - startedAt,
    usedPath: archivePath,
    renamedFrom: '',
    strippedPrefix: 0,
    extractedFiles: 0,
    lz4Bytes: 0,
    lz4InnerName: '',
    lz4InnerIsArchive: false,
    lz4InnerKept: false,
    deletedFiles: [],
    deleteError: '',
  });

  if (!sevenZipPath) {
    return failure('未找到 7-Zip。请在设置里手动选择 7z.exe。');
  }

  if (!existsSync(archivePath)) {
    return failure('压缩包不存在。');
  }

  // 注意：这里不预先改名。7-Zip 按文件头识别格式，伪装后缀照样能解；
  // 改名统一放到「解压成功之后」做，避免把识别错的正常文件改名弄坏。
  let usedPath = archivePath;
  let renamedFrom = '';
  let strippedPrefix = 0;

  await fs.mkdir(outputDir, { recursive: true }).catch(() => undefined);

  let lz4Bytes = 0;
  let lz4InnerName = '';
  let lz4InnerIsArchive = false;
  let lz4InnerKept = false;
  let lz4Stage: Lz4StageResult | null = null;
  /** 内层是压缩包时，补完正确后缀后的中间文件真实路径（位于源目录旁） */
  let lz4InnerPath: string | null = null;

  // 0) LZ4 压缩流：7-Zip 认不出来，先自己解开，拿到内层文件再走下面那条正常流程
  if (await isLz4File(archivePath)) {
    lz4Stage = await expandLz4Source(archivePath, onProgress);
    if (!lz4Stage.ok) {
      return failure(lz4Stage.error);
    }

    lz4Bytes = lz4Stage.bytes;
    lz4InnerIsArchive = lz4Stage.innerIsArchive;

    // 内层不是压缩包：解出来的那个文件本身就是结果，直接放进输出目录收工
    if (!lz4Stage.innerIsArchive) {
      const landed = await uniqueTargetPath(path.join(outputDir, innerFileName(archivePath, lz4Stage.innerExt)));

      try {
        await fs.rename(lz4Stage.innerPath, landed);
      } catch (error) {
        await fs.rm(lz4Stage.innerPath, { force: true }).catch(() => undefined);
        return failure(`LZ4 已解开，但把内层文件放进输出目录失败：${error instanceof Error ? error.message : String(error)}`);
      }

      return {
        archivePath,
        outputDir,
        success: true,
        wrongPassword: false,
        exitCode: 0,
        matchedPasswordIndex: null,
        error: '',
        elapsedMs: Date.now() - startedAt,
        usedPath: archivePath,
        renamedFrom: '',
        strippedPrefix: 0,
        extractedFiles: 1,
        lz4Bytes,
        lz4InnerName: path.basename(landed),
        lz4InnerIsArchive: false,
        lz4InnerKept: true,
        ...(await removeSourceFiles(request, archivePath, true)),
      };
    }

    // 内层是压缩包：先按识别结果补上正确后缀（比如 A41.zip），
    // 再把它当成普通压缩包继续走下面的正常流程——
    // 7-Zip 解压、嵌套判定、伪装改名都按既有逻辑来，
    // 不再用那个一眼是临时的 .__lz4_tmp__ 名字，免得后续环节认不出它是压缩包。
    const properName = innerFileName(archivePath, lz4Stage.innerExt);
    const properPath = await uniqueTargetPath(path.join(path.dirname(archivePath), properName));
    try {
      await fs.rename(lz4Stage.innerPath, properPath);
    } catch (error) {
      await fs.rm(lz4Stage.innerPath, { force: true }).catch(() => undefined);
      return failure(`LZ4 已解开，但给内层压缩包补后缀失败：${error instanceof Error ? error.message : String(error)}`);
    }
    lz4InnerPath = properPath;
    lz4InnerName = path.basename(properPath);
    usedPath = properPath;
  }

  // 顶层「完全没后缀、但文件头已证明是压缩包」的文件（如被丢了后缀的 A41）：
  // 必须在 7-Zip 解压【之前】就补上正确后缀。否则解压输出目录会跟源文件同名
  // （F:\yscs\A41 既是文件、又是要创建的目录），7-Zip 直接报
  // "Cannot create output directory"。用户要的也是「先补 .zip 再正常走流程」。
  // 只在「无后缀」时做；伪装后缀（有后缀）仍走第 3 步「成功后才改名」，不动这里——
  // 那条是为了保护被误判的正常文件（jpg/pdf）不被改名。
  // 这里能安全提前改名，是因为扫描阶段已经用文件头确认过它是压缩包。
  if (!lz4Stage && path.extname(usedPath).toLowerCase() === '' && !isArchiveFile(usedPath)) {
    try {
      const renamed = await renameDisguisedFile(usedPath, normalizeRenameExtension(request.renameExtension));
      renamedFrom = usedPath;
      usedPath = renamed;
    } catch (error) {
      appendRenameWarning(`给无后缀压缩包补后缀失败，将按原文件名继续尝试：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const candidates = request.passwords.length > 0 ? request.passwords : [''];

  interface Outcome {
    success: boolean;
    matched: number | null;
    detail: string;
    wrongPassword: boolean;
    files: number;
  }

  const runAttempts = async (target: string): Promise<Outcome> => {
    for (let index = 0; index < candidates.length; index += 1) {
      const attempt = await runSevenZipAttempt(sevenZipPath, target, outputDir, candidates[index], onProgress);

      if (attempt.success) {
        return { success: true, matched: index, detail: '', wrongPassword: false, files: attempt.files };
      }

      if (!attempt.wrongPassword) {
        return {
          success: false,
          matched: null,
          detail: attempt.stderr.trim() || attempt.stdout.trim() || '7-Zip 未能解压该文件。',
          wrongPassword: false,
          files: 0,
        };
      }
    }

    return { success: false, matched: null, detail: '所有候选密码均未成功。', wrongPassword: true, files: 0 };
  };

  try {
    // 1) 先按原文件名解压：7-Zip 是按文件头识别格式的，伪装后缀不影响解压
    let outcome = await runAttempts(usedPath);

    // 2) 仍打不开时兜底：有些伪装包前面拼了视频等无关数据，
    //    原地把前置部分去掉（不产生副本）后重试
    if (!outcome.success) {
      const prefix = await detectPrependedZip(usedPath);
      if (prefix && prefix > 0) {
        try {
          await stripPrefixInPlace(usedPath, prefix);
          strippedPrefix = prefix;
          outcome = await runAttempts(usedPath);
        } catch (error) {
          appendRenameWarning(`移除前置数据失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    // 3) 只有解压成功后才改名（把伪装后缀统一成设定的后缀）。
    //    失败就原样保留原文件名 —— 这样即使把 jpg/pdf 误当成压缩包，也不会把文件弄坏。
    //    LZ4 那条路走的是我们自己造的临时文件，不参与改名。
    //    注意：完全没后缀的压缩包（如丢了后缀的 A41）已在上面「解压之前」补过后缀了，
    //    那里必须提前补，否则输出目录会和源文件同名、7-Zip 直接创建目录失败。
    //    这里只针对「有伪装后缀」的文件做成功后改名；noExtArchiveFile 仅是兜底，正常不会走到。
    const noExtArchiveFile = path.extname(usedPath).toLowerCase() === '';
    if (outcome.success && !lz4Stage && !isArchiveFile(usedPath) && (request.renameDisguised || noExtArchiveFile)) {
      try {
        const renamed = await renameDisguisedFile(usedPath, normalizeRenameExtension(request.renameExtension));
        renamedFrom = usedPath;
        usedPath = renamed;
      } catch (error) {
        appendRenameWarning(error instanceof Error ? error.message : String(error));
      }
    }

    // 4) LZ4 中间文件收尾：成功了就是废料，删掉；失败了改名留在源目录旁，省得白解一遍
    if (lz4Stage) {
      if (outcome.success) {
        // 中间包已经补过正确后缀（如 A41.zip），用完即删
        if (lz4InnerPath) await fs.rm(lz4InnerPath, { force: true }).catch(() => undefined);
      } else {
        // 失败时中间包已经用正确后缀留在源目录旁（如 A41.zip），把它标成「已保留」即可
        lz4InnerKept = true;
      }
    }

    return {
      archivePath,
      outputDir,
      success: outcome.success,
      wrongPassword: outcome.wrongPassword,
      exitCode: outcome.success ? 0 : 2,
      matchedPasswordIndex: outcome.matched,
      error: outcome.success ? '' : outcome.detail.slice(0, 1200),
      elapsedMs: Date.now() - startedAt,
      usedPath,
      renamedFrom,
      strippedPrefix,
      extractedFiles: outcome.files,
      lz4Bytes,
      lz4InnerName,
      lz4InnerIsArchive,
      lz4InnerKept,
      ...(await removeSourceFiles(request, usedPath, outcome.success)),
    };
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
}

/**
 * 解压成功后按需删除源压缩包（含全部分卷）。
 * 只在成功时删除；任何一个删不掉都只记录错误，不影响解压结果。
 */
async function removeSourceFiles(
  request: ExtractRequest,
  usedPath: string,
  success: boolean,
): Promise<{ deletedFiles: string[]; deleteError: string }> {
  const deletedFiles: string[] = [];
  let deleteError = '';

  if (!request.deleteSource || !success) {
    return { deletedFiles, deleteError };
  }

  const targets = new Set<string>([usedPath]);
  for (const candidate of request.sourcePaths ?? []) {
    if (typeof candidate === 'string' && candidate.trim()) targets.add(path.resolve(candidate));
  }

  for (const target of targets) {
    try {
      if (!existsSync(target)) continue;

      // 源压缩包一定是文件。无后缀包提前补后缀后（A41 → A41.zip），
      // 旧的 sourcePaths 条目可能恰好指向按原名建出来的输出目录（F:\yscs\A41\A41），
      // 这时候 fs.unlink 会报 EPERM 还留下一条莫名其妙的删除失败日志 —— 目录一律跳过。
      const stat = await fs.stat(target).catch(() => null);
      if (!stat || !stat.isFile()) continue;

      await fs.unlink(target);
      deletedFiles.push(target);
    } catch (error) {
      const message = `${path.basename(target)}：${error instanceof Error ? error.message : String(error)}`;
      deleteError = deleteError ? `${deleteError}；${message}` : message;
    }
  }

  return { deletedFiles, deleteError };
}

function appendRenameWarning(message: string): void {
  console.warn(`[ArchiveUnpacker] 伪装后缀改名失败：${message}`);
}

async function isExecutableFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function selectFolder(): Promise<string | null> {
  const options = { properties: ['openDirectory'] as Array<'openDirectory'> };
  const parent = mainWindow ?? BrowserWindow.getAllWindows()[0];
  const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

async function selectSevenZip(): Promise<string | null> {
  const options = {
    properties: ['openFile'] as Array<'openFile'>,
    filters: [{ name: '7-Zip executable', extensions: ['exe'] }],
  };
  const parent = mainWindow ?? BrowserWindow.getAllWindows()[0];
  const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

/**
 * 读取随包附带的 `personal-settings.json`（私密版专用）。
 *
 * 查找顺序：
 *   1. 应用根目录（开发时 = 项目根；打包后在 asar 内）
 *   2. resources 目录（打包时把配置放进 extraResources 的情况）
 *
 * 文件不存在（公开版）或内容损坏都返回 null —— 个人配置是锦上添花，绝不能拦住启动。
 */
async function readPersonalConfig(): Promise<PersonalConfig | null> {
  const candidates = [
    path.join(__dirname, '..', 'personal-settings.json'),
    process.resourcesPath ? path.join(process.resourcesPath, 'personal-settings.json') : '',
  ];

  for (const file of candidates) {
    if (!file) continue;
    try {
      if (!(await isExecutableFile(file))) continue;
      const text = await fs.readFile(file, 'utf8');
      const parsed = JSON.parse(text) as PersonalConfig;
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // 坏文件当没有，继续找下一个
    }
  }

  return null;
}

function registerIpcHandlers(): void {
  ipcMain.handle('dialog:select-folder', () => selectFolder());
  ipcMain.handle('dialog:select-7z', () => selectSevenZip());

  ipcMain.handle('app:defaults', async (): Promise<DefaultsResult> => ({
    sevenZipPath: await resolveSevenZipPath(),
    homeFolder: app.getPath('downloads'),
  }));

  // 个人配置：私密版随包带 personal-settings.json，公开版没有（返回 null）
  ipcMain.handle('personal-config', () => readPersonalConfig());

  ipcMain.handle('scan-folder', (_event, request: ScanRequest) => scanFolder(request));

  ipcMain.handle('analyze-nested', (_event, request: NestedAnalyzeRequest) => analyzeNestedArchives(request));

  ipcMain.handle('hoist-finished', (_event, request: HoistRequest) => hoistFinishedFolder(request));

  ipcMain.handle('extract-archive', async (_event, request: ExtractRequest & { id: string }) => {
    const result = await extractArchive(request, (percent) => reportExtractProgress(request.id, percent));
    extractProgressAt.delete(request.id);
    return { ...result, id: request.id };
  });

  ipcMain.handle('shell:open-path', async (_event, target: string): Promise<OpenPathResult> => {
    if (!target) {
      return { ok: false, error: '路径为空。' };
    }

    const resolved = path.resolve(target);
    if (!existsSync(resolved)) {
      return { ok: false, error: '路径不存在。' };
    }

    const error = await shell.openPath(resolved);
    return { ok: !error, error: error ?? '' };
  });

  ipcMain.handle('shell:show-item', async (_event, target: string): Promise<OpenPathResult> => {
    if (!target) {
      return { ok: false, error: '路径为空。' };
    }

    const resolved = path.resolve(target);

    // 文件还在：打开所在文件夹并选中它
    if (existsSync(resolved)) {
      shell.showItemInFolder(resolved);
      return { ok: true, error: '' };
    }

    // 文件已被改名或删除：退一步，打开它所在的目录
    const parent = path.dirname(resolved);
    if (parent !== resolved && existsSync(parent)) {
      const failure = await shell.openPath(parent);
      return failure ? { ok: false, error: `无法打开文件夹：${failure}` } : { ok: true, error: '' };
    }

    return { ok: false, error: `路径已不存在：${resolved}` };
  });
}

function createWindow(): void {
  // 窗口 / 任务栏图标。开发时读项目里的 build/icon.ico；
  // 打包后 exe 自带图标，这里找不到文件就不设（不影响启动）。
  const iconPath = path.join(__dirname, '..', 'build', 'icon.ico');

  mainWindow = new BrowserWindow({
    width: 900,
    height: 640,
    minWidth: 720,
    minHeight: 480,
    useContentSize: true,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f6f7fb',
    title: '批量解压工具',
    ...(existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.local.archive-unpacker');
  registerIpcHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
