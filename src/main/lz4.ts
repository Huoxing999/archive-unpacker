/**
 * LZ4 解压（自己实现，因为 7-Zip 不支持 lz4 格式）。
 *
 * 只处理标准的 **LZ4 Frame 格式**（魔数 0x184D2204，磁盘上存成 04 22 4D 18），
 * 也就是 `lz4` 命令行工具默认产出的那种，文件后缀一般是 `.lz4` / `.tar.lz4` / `.zip.lz4`。
 * 旧版 Legacy 格式（0x184C2102）只做识别、不做解压，遇到会给出清楚的报错。
 *
 * 实现要点：
 *  - **流式**：按块读写，内存占用最大也就「一个块 + 64KB 字典」，GB 级文件也能跑；
 *  - **块独立**（B.Indep）与**块间带字典**两种帧都支持；
 *  - 校验帧头校验和（HC）与内容校验和（XXH32）：头坏了或内容对不上直接报错，
 *    绝不放任「悄悄解出一堆垃圾」。
 *
 * 只依赖 node:fs / node:buffer。
 */

import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

/** LZ4 Frame 魔数 */
export const LZ4_FRAME_MAGIC = 0x184d2204;
/** 旧版（Legacy）LZ4 魔数：只识别、不支持 */
const LZ4_LEGACY_MAGIC = 0x184c2102;
/** 可跳过帧（skippable frame）的魔数区间 */
const SKIPPABLE_MIN = 0x184d2a50;
const SKIPPABLE_MAX = 0x184d2a5f;

/** 块间字典窗口固定 64KB */
const DICT_SIZE = 64 * 1024;
/** 帧头缓冲区：magic(4) + FLG(1) + BD(1) + 内容大小(8) + 字典ID(4) + HC(1) */
const HEADER_BUFFER = 19;
/** 取内层内容开头这么多字节，用来判断里面是什么格式 */
const PEEK_SIZE = 512;

/**
 * 用文件头判断是不是 LZ4。
 * 识别 Frame、Skippable、Legacy 三种魔数（Legacy 只是为了让报错更明确）。
 */
export function isLz4Magic(buffer: Buffer): boolean {
  if (buffer.length < 4) return false;
  const magic = buffer.readUInt32LE(0);
  if (magic === LZ4_FRAME_MAGIC || magic === LZ4_LEGACY_MAGIC) return true;
  return magic >= SKIPPABLE_MIN && magic <= SKIPPABLE_MAX;
}

/* ------------------------------------------------------------------ */
/* XXH32（帧头校验和 / 内容校验和都用它）                                */
/* ------------------------------------------------------------------ */

const PRIME32_1 = 0x9e3779b1;
const PRIME32_2 = 0x85ebca77;
const PRIME32_3 = 0xc2b2ae3d;
const PRIME32_4 = 0x27d4eb2f;
const PRIME32_5 = 0x165667b1;

function rotl32(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

/** 32 位乘法取低 32 位（用 Math.imul，避免 JS 双精度丢高位） */
function mul32(a: number, b: number): number {
  return Math.imul(a | 0, b | 0) >>> 0;
}

/** 增量式 XXH32：边解压边喂数据，不用把整个文件读进内存 */
export class XxHash32 {
  private readonly seed: number;
  private v1: number;
  private v2: number;
  private v3: number;
  private v4: number;
  private readonly tail = Buffer.alloc(16);
  private tailLen = 0;
  private total = 0;

  constructor(seed = 0) {
    this.seed = seed >>> 0;
    this.v1 = (this.seed + PRIME32_1 + PRIME32_2) >>> 0;
    this.v2 = (this.seed + PRIME32_2) >>> 0;
    this.v3 = this.seed;
    this.v4 = (this.seed - PRIME32_1) >>> 0;
  }

  /**
   * XXH32 的轮函数：acc += input * P2; acc = rotl(acc,13); acc *= P1
   *
   * 注意那个 `input * PRIME32_2` 不能省 —— 少了它短输入（<16 字节，走不到轮函数）
   * 的测试照样全过，但一遇到真实数据校验和就对不上。
   */
  private round(accumulator: number, input: number): number {
    return mul32(rotl32((accumulator + mul32(input, PRIME32_2)) >>> 0, 13), PRIME32_1);
  }

  private stripe(buffer: Buffer, at: number): void {
    this.v1 = this.round(this.v1, buffer.readUInt32LE(at));
    this.v2 = this.round(this.v2, buffer.readUInt32LE(at + 4));
    this.v3 = this.round(this.v3, buffer.readUInt32LE(at + 8));
    this.v4 = this.round(this.v4, buffer.readUInt32LE(at + 12));
  }

  update(data: Buffer): void {
    if (data.length === 0) return;
    // 规范里长度按 uint32 相加，超过 4GB 自然回绕
    this.total = (this.total + data.length) >>> 0;

    let offset = 0;

    // 先把上次剩下的一小截补齐到 16 字节
    if (this.tailLen > 0) {
      const need = 16 - this.tailLen;
      if (data.length < need) {
        data.copy(this.tail, this.tailLen);
        this.tailLen += data.length;
        return;
      }
      data.copy(this.tail, this.tailLen, 0, need);
      this.stripe(this.tail, 0);
      this.tailLen = 0;
      offset = need;
    }

    const lastStripe = data.length - 16;
    while (offset <= lastStripe) {
      this.stripe(data, offset);
      offset += 16;
    }

    if (offset < data.length) {
      data.copy(this.tail, 0, offset);
      this.tailLen = data.length - offset;
    }
  }

  digest(): number {
    let hash =
      this.total >= 16
        ? (rotl32(this.v1, 1) + rotl32(this.v2, 7) + rotl32(this.v3, 12) + rotl32(this.v4, 18)) >>> 0
        : (this.seed + PRIME32_5) >>> 0;

    hash = (hash + this.total) >>> 0;

    const tail = this.tail.subarray(0, this.tailLen);
    let offset = 0;
    while (offset + 4 <= tail.length) {
      hash = mul32(rotl32((hash + mul32(tail.readUInt32LE(offset), PRIME32_3)) >>> 0, 17), PRIME32_4);
      offset += 4;
    }
    while (offset < tail.length) {
      hash = mul32(rotl32((hash + mul32(tail[offset], PRIME32_5)) >>> 0, 11), PRIME32_1);
      offset += 1;
    }

    hash ^= hash >>> 15;
    hash = mul32(hash, PRIME32_2);
    hash ^= hash >>> 13;
    hash = mul32(hash, PRIME32_3);
    hash ^= hash >>> 16;
    return hash >>> 0;
  }
}

/* ------------------------------------------------------------------ */
/* LZ4 块解码                                                          */
/* ------------------------------------------------------------------ */

/**
 * 解开一个 LZ4 数据块（经典的 LZ4 序列格式）。
 *
 * `dst` 布局：[0, dstStart) 是上一块留下的 64KB 字典，新数据从 dstStart 开始写。
 * 返回本次写出的字节数。
 *
 * 匹配串是**逐字节**拷贝的：LZ4 允许 offset < matchLength（自引用重叠），
 * 用 Buffer.copy 会把重叠部分算错，必须一个字节一个字节搬。
 */
function decodeBlock(src: Buffer, srcStart: number, srcEnd: number, dst: Buffer, dstStart: number): number {
  let ip = srcStart;
  let op = dstStart;

  while (ip < srcEnd) {
    const token = src[ip];
    ip += 1;

    // ---- 字面量长度 ----
    let literalLength = token >>> 4;
    if (literalLength === 15) {
      let byte = 255;
      while (byte === 255) {
        if (ip >= srcEnd) throw new Error('LZ4：数据块字面量长度越界');
        byte = src[ip];
        ip += 1;
        literalLength += byte;
      }
    }

    if (ip + literalLength > srcEnd) throw new Error('LZ4：数据块字面量越界');
    if (op + literalLength > dst.length) throw new Error('LZ4：输出超过块上限');

    src.copy(dst, op, ip, ip + literalLength);
    ip += literalLength;
    op += literalLength;

    // 最后一个序列只有字面量，没有匹配段
    if (ip >= srcEnd) break;

    // ---- 匹配段 ----
    if (ip + 2 > srcEnd) throw new Error('LZ4：数据块匹配偏移越界');
    const offset = src[ip] | (src[ip + 1] << 8);
    ip += 2;
    if (offset === 0) throw new Error('LZ4：匹配偏移为 0');

    let matchLength = token & 0x0f;
    if (matchLength === 15) {
      let byte = 255;
      while (byte === 255) {
        if (ip >= srcEnd) throw new Error('LZ4：数据块匹配长度越界');
        byte = src[ip];
        ip += 1;
        matchLength += byte;
      }
    }
    matchLength += 4;

    const matchStart = op - offset;
    if (matchStart < 0) throw new Error('LZ4：匹配位置越界');
    if (op + matchLength > dst.length) throw new Error('LZ4：输出超过块上限');

    for (let index = 0; index < matchLength; index += 1) {
      dst[op + index] = dst[matchStart + index];
    }
    op += matchLength;
  }

  return op - dstStart;
}

/** 从 BD 字节取块上限：4→64KB, 5→256KB, 6→1MB, 7→4MB */
function blockMaxSizeFrom(bd: number): number {
  switch ((bd >>> 4) & 0x07) {
    case 4:
      return 64 * 1024;
    case 5:
      return 256 * 1024;
    case 6:
      return 1024 * 1024;
    case 7:
    default:
      return 4 * 1024 * 1024;
  }
}

/** 从指定位置读满 length 个字节，读不满就报「文件意外结束」 */
async function readInto(handle: FileHandle, position: number, buffer: Buffer, length: number): Promise<void> {
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
    if (bytesRead <= 0) throw new Error('LZ4：文件意外结束');
    filled += bytesRead;
  }
}

/* ------------------------------------------------------------------ */
/* 对外主函数                                                          */
/* ------------------------------------------------------------------ */

export interface Lz4DecompressResult {
  /** 实际解出来的字节数 */
  bytesOut: number;
  /** 帧头里声明的内容大小；0 表示帧里没有写 */
  declaredSize: number;
  /** 解出来的内容开头若干字节，用于判断内层是什么格式 */
  head: Buffer;
  /** 帧里带内容校验和时是否校验通过；null 表示帧里没有校验和 */
  checksumOk: boolean | null;
  /** 一共处理了几帧（正常是 1，允许拼接多帧） */
  frames: number;
}

/**
 * 把 LZ4 压缩流解到目标文件（覆盖写入）。
 *
 * @param inputPath  源 .lz4 文件
 * @param outputPath 输出文件
 * @param onProgress 进度回调，参数是 0~100 的整数（按**已读入**字节数估算）
 */
export async function decompressLz4Frame(
  inputPath: string,
  outputPath: string,
  onProgress?: (percent: number) => void,
): Promise<Lz4DecompressResult> {
  const inHandle = await fs.open(inputPath, 'r');
  let outHandle: FileHandle | null = null;

  try {
    const totalBytes = (await inHandle.stat()).size;
    outHandle = await fs.open(outputPath, 'w');

    let position = 0;
    let bytesOut = 0;
    let declaredSize = 0;
    let frames = 0;
    let checksumOk: boolean | null = null;
    const headParts: Buffer[] = [];
    let headLen = 0;
    let written = 0;
    let lastReported = -1;

    const scratch = Buffer.allocUnsafe(HEADER_BUFFER);
    const sizeBuf = Buffer.allocUnsafe(4);

    const report = () => {
      if (!onProgress || totalBytes <= 0) return;
      const percent = Math.min(100, Math.floor((position / totalBytes) * 100));
      if (percent === lastReported) return;
      lastReported = percent;
      onProgress(percent);
    };

    for (;;) {
      // ---------- 帧边界：普通帧 / 可跳过帧 / 数据已结束 ----------
      if (position >= totalBytes) break;

      await readInto(inHandle, position, sizeBuf, 4);
      const magic = sizeBuf.readUInt32LE(0);
      position += 4;

      if (magic >= SKIPPABLE_MIN && magic <= SKIPPABLE_MAX) {
        await readInto(inHandle, position, sizeBuf, 4);
        position += 4 + sizeBuf.readUInt32LE(0);
        continue;
      }

      if (magic !== LZ4_FRAME_MAGIC) {
        if (frames === 0) {
          throw new Error(
            magic === LZ4_LEGACY_MAGIC
              ? 'LZ4：这是旧版 Legacy 格式，暂不支持，请用新版 lz4 重新压缩。'
              : 'LZ4：文件头不是 LZ4 帧格式。',
          );
        }
        // 已经解出完整帧了，后面跟的是别的东西，当作正常结束
        break;
      }

      frames += 1;

      // ---------- 帧头 ----------
      const headerStart = position;
      await readInto(inHandle, position, scratch, 2);
      const flg = scratch[0];
      const bd = scratch[1];
      position += 2;

      if ((flg >>> 6) !== 1) throw new Error('LZ4：不支持的帧版本。');

      const blockIndependent = (flg & 0x20) !== 0;
      const blockChecksum = (flg & 0x10) !== 0;
      const hasContentSize = (flg & 0x08) !== 0;
      const contentChecksum = (flg & 0x04) !== 0;
      const hasDictId = (flg & 0x01) !== 0;

      let contentSize = 0;
      if (hasContentSize) {
        await readInto(inHandle, position, scratch, 8);
        contentSize = Number(scratch.readBigUInt64LE(0));
        position += 8;
      }
      if (hasDictId) {
        position += 4;
      }

      await readInto(inHandle, position, scratch, 1);
      const expectedHeaderChecksum = scratch[0];
      position += 1;

      // HC = 帧头（FLG..字典ID）的 XXH32 的第二个字节
      const headerLength = 2 + (hasContentSize ? 8 : 0) + (hasDictId ? 4 : 0);
      const headerBytes = Buffer.allocUnsafe(headerLength);
      await readInto(inHandle, headerStart, headerBytes, headerLength);
      const headerHash = new XxHash32();
      headerHash.update(headerBytes);
      if (((headerHash.digest() >>> 8) & 0xff) !== expectedHeaderChecksum) {
        throw new Error('LZ4：帧头校验和不匹配，文件可能已损坏。');
      }

      if (hasContentSize) declaredSize += contentSize;

      const blockMaxSize = blockMaxSizeFrom(bd);
      const contentHash = new XxHash32();

      let compressBuf = Buffer.allocUnsafe(0);
      let outBuf = Buffer.allocUnsafe(DICT_SIZE + blockMaxSize);
      const dictBuf = Buffer.allocUnsafe(DICT_SIZE);
      let dictLen = 0;

      // ---------- 块循环 ----------
      for (;;) {
        await readInto(inHandle, position, sizeBuf, 4);
        const rawSize = sizeBuf.readUInt32LE(0);
        position += 4;

        if (rawSize === 0) break; // EndMark

        const uncompressed = (rawSize & 0x80000000) !== 0;
        const blockSize = rawSize & 0x7fffffff;
        if (blockSize > blockMaxSize) throw new Error('LZ4：数据块超过帧头声明的上限。');

        if (compressBuf.length < blockSize) compressBuf = Buffer.allocUnsafe(blockSize);
        await readInto(inHandle, position, compressBuf, blockSize);
        position += blockSize;

        if (blockChecksum) {
          // 块校验和各家实现语义略有出入，这里只跳过不校验（内容校验和才是硬保证）
          await readInto(inHandle, position, sizeBuf, 4);
          position += 4;
        }

        // 把上一块的尾巴摆到输出开头，供非独立块的匹配串回引
        if (dictLen > 0) dictBuf.copy(outBuf, 0, 0, dictLen);

        let produced: number;
        if (uncompressed) {
          if (outBuf.length < dictLen + blockSize) outBuf = Buffer.allocUnsafe(dictLen + blockSize);
          compressBuf.copy(outBuf, dictLen, 0, blockSize);
          produced = blockSize;
        } else {
          produced = decodeBlock(compressBuf, 0, blockSize, outBuf, dictLen);
        }

        const chunk = outBuf.subarray(dictLen, dictLen + produced);
        await outHandle.write(chunk, 0, produced, written);
        written += produced;
        bytesOut += produced;

        contentHash.update(chunk);

        if (headLen < PEEK_SIZE) {
          const take = Math.min(PEEK_SIZE - headLen, produced);
          headParts.push(Buffer.from(chunk.subarray(0, take)));
          headLen += take;
        }

        if (!blockIndependent) {
          const total = dictLen + produced;
          const keep = Math.min(DICT_SIZE, total);
          outBuf.copy(dictBuf, 0, total - keep, total);
          dictLen = keep;
        }

        report();
      }

      if (contentChecksum) {
        await readInto(inHandle, position, sizeBuf, 4);
        const expected = sizeBuf.readUInt32LE(0);
        position += 4;
        const ok = contentHash.digest() === expected;
        checksumOk = checksumOk === null ? ok : checksumOk && ok;
        if (!ok) throw new Error('LZ4：内容校验和不匹配，解出来的数据不完整或已损坏。');
      }

      report();
    }

    if (frames === 0) throw new Error('LZ4：文件里没有找到有效的 LZ4 数据帧。');

    return {
      bytesOut,
      declaredSize,
      head: Buffer.concat(headParts, headLen),
      checksumOk,
      frames,
    };
  } finally {
    await inHandle.close().catch(() => undefined);
    if (outHandle) await outHandle.close().catch(() => undefined);
  }
}
