export interface ArchiveEntry {
  id: string;
  path: string;
  name: string;
  extension: string;
  directory: string;
  /** 主卷 + 所有分卷的总大小 */
  size: number;
  modifiedMs: number;
  /** 分卷总数（1 表示单卷） */
  partCount: number;
  /** 所有分卷路径，按卷序号排序，第一个是主卷 */
  partPaths: string[];
  /** 是否为伪装后缀（如 .png 实为压缩包） */
  disguised: boolean;
}

export interface ScanRequest {
  folder: string;
  recursive: boolean;
  disguisedExtensions: string[];
  /** 扫描时用 7-Zip 实际打开文件校验（更准，稍慢） */
  verifyWith7z: boolean;
  /**
   * 校验时连「伪装后缀」也一起判定。
   * 嵌套扫描时开启：解压出来的 jpg/pdf 等正常文件不会被误当成压缩包。
   */
  strictDisguised?: boolean;
}

export interface ScanResult {
  folder: string;
  archives: ArchiveEntry[];
  sevenZipPath: string | null;
  /** 参与校验的文件数 */
  verified: number;
  /** 校验未通过、被排除的文件名 */
  rejected: string[];
  /** 是否真的做了 7-Zip 校验 */
  used7zVerify: boolean;
  error?: string;
}

export interface ScanProgress {
  phase: 'collect' | 'verify';
  done: number;
  total: number;
  current: string;
}

/** 单个压缩包的解压进度 */
export interface ExtractProgress {
  id: string;
  percent: number;
}

export interface ExtractRequest {
  archivePath: string;
  outputDir: string;
  passwords: string[];
  sevenZipPath: string | null;
  /** 伪装后缀解压前先永久改名 */
  renameDisguised: boolean;
  /** 改名用的目标后缀，例如 zip / rar / 7z */
  renameExtension: string;
  /** 解压成功后删除源压缩包 */
  deleteSource: boolean;
  /** 源文件路径（含所有分卷），成功后一并删除 */
  sourcePaths: string[];
}

export interface ExtractResult {
  archivePath: string;
  outputDir: string;
  success: boolean;
  wrongPassword: boolean;
  exitCode: number | null;
  matchedPasswordIndex: number | null;
  error: string;
  elapsedMs: number;
  /** 实际用于解压的文件路径（改名后为 .rar 路径） */
  usedPath: string;
  /** 若发生改名，这里是被改名前的原路径 */
  renamedFrom: string;
  /** 从原文件原地移除的前置无关数据大小（0 表示未移除） */
  strippedPrefix: number;
  /** 这次解压出来的文件数量（取自 7-Zip 收尾统计的 Files: N，不含文件夹） */
  extractedFiles: number;
  /**
   * 源文件是 LZ4 压缩流时解出来的字节数。
   * 0 表示这个源文件不是 LZ4，走的还是 7-Zip 那条路。
   */
  lz4Bytes: number;
  /** LZ4 解出来的内层文件名（用于日志）；'' 表示没这回事 */
  lz4InnerName: string;
  /** LZ4 内层是不是压缩包（true → 已交给 7-Zip 继续解；false → 文件本身就是结果） */
  lz4InnerIsArchive: boolean;
  /** LZ4 内层文件是否被留在了磁盘上（解压失败时留着备用；成功时用完即删） */
  lz4InnerKept: boolean;
  /** 解压成功后已删除的源文件（含分卷） */
  deletedFiles: string[];
  /** 删除源文件时的错误信息 */
  deleteError: string;
}

/**
 * 判断「解压出来的东西里还有哪些包需要继续解」。
 * 主进程负责判定，渲染层只负责把 follow 里的包加进队列。
 */
export interface NestedAnalyzeRequest {
  /** 上一层的解压输出目录 */
  folder: string;
  /** 用户标记的伪装后缀（嵌套扫描里不会被自动追） */
  disguisedExtensions: string[];
  /** 上一层压缩包的路径，用于排除它自己 */
  parentPath: string;
  /** 上一层在整个嵌套树里的深度（最外层为 0） */
  depth: number;
  /** 上一层刚解压出来的文件数量 */
  parentFileCount: number;
  /** 文件数超过这个值就不再继续解压嵌套包 */
  fileThreshold: number;
  sevenZipPath: string | null;
}

export interface NestedSkip {
  name: string;
  reason: string;
}

export interface NestedAnalyzeResult {
  /** 确认还需要继续解压的包 */
  follow: ArchiveEntry[];
  /** 主动跳过的文件及原因（用于日志） */
  skipped: NestedSkip[];
  used7zVerify: boolean;
  /** 「收手了」的说明，例如文件数超阈值；为空串表示不是被主动叫停的 */
  stopReason: string;
  /** 判定过程中的说明（例如"只解出 1 个 .tif，是你登记过的伪装后缀，直接继续"） */
  notes: string[];
  /**
   * 已经解到头的成品文件夹（绝对路径）。
   * 非空表示「不用再往下解了，把这个文件夹搬回源目录」。
   */
  finishedFolder: string;
}

/** 把解到头的成品文件夹搬回源目录，并清掉留下的空目录外壳 */
export interface HoistRequest {
  /** 要搬走的成品文件夹（绝对路径） */
  folder: string;
  /** 搬到哪里：源目录（设置里的「压缩包文件夹」）。清理空目录时也绝不越过它 */
  targetRoot: string;
}

export interface HoistResult {
  ok: boolean;
  movedFrom: string;
  /** 实际落点（目标重名时会加序号） */
  movedTo: string;
  /** 清理掉的空目录 */
  removedDirs: string[];
  /** 因为不是空的（或删不掉）而保留下来的目录 */
  keptDirs: string[];
  error: string;
}

export interface DefaultsResult {
  sevenZipPath: string | null;
  homeFolder: string;
}

/**
 * 个人配置（`personal-settings.json`）。
 * 私密版随包附带这个文件，程序**首次运行**（本机还没有设置记录）时把它当作默认值导入；
 * 之后用户在界面里的改动以本机记录为准，不会被这个文件覆盖。
 * 公开版不带这个文件，读取结果为 null，一切走代码默认值。
 */
export interface PersonalConfig {
  settings?: {
    recursive?: boolean;
    separateDirs?: boolean;
    nestedFileThreshold?: number;
    renameDisguised?: boolean;
    renameExtension?: string;
    deleteAfterExtract?: boolean;
    verifyWith7z?: boolean;
    sevenZipPath?: string;
    sourceFolder?: string;
    outputFolder?: string;
  };
  /** 候选密码（含可选的文件名前缀绑定） */
  passwords?: Array<{ value?: string; prefix?: string }>;
  /** 伪装后缀列表 */
  disguisedExtensions?: string[];
}

export interface OpenPathResult {
  ok: boolean;
  error: string;
}
