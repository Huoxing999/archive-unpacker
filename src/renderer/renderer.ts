type ArchiveStatus = 'pending' | 'running' | 'done' | 'wrong-password' | 'failed' | 'skipped';

interface ArchiveEntry {
  id: string;
  path: string;
  name: string;
  extension: string;
  directory: string;
  size: number;
  modifiedMs: number;
  partCount: number;
  partPaths: string[];
  disguised: boolean;
}

interface ScanResult {
  folder: string;
  archives: ArchiveEntry[];
  sevenZipPath: string | null;
  verified: number;
  rejected: string[];
  used7zVerify: boolean;
  error?: string;
}

interface ExtractResult {
  id: string;
  archivePath: string;
  outputDir: string;
  success: boolean;
  wrongPassword: boolean;
  exitCode: number | null;
  matchedPasswordIndex: number | null;
  error: string;
  elapsedMs: number;
  usedPath: string;
  renamedFrom: string;
  strippedPrefix: number;
  /** 这次解压出来的文件数量（不含文件夹） */
  extractedFiles: number;
  /** 源文件是 LZ4 压缩流时解出来的字节数（0 = 不是 LZ4） */
  lz4Bytes: number;
  /** LZ4 解出来的内层文件名 */
  lz4InnerName: string;
  /** LZ4 内层是不是压缩包 */
  lz4InnerIsArchive: boolean;
  /** LZ4 内层文件是否留在了磁盘上 */
  lz4InnerKept: boolean;
  deletedFiles: string[];
  deleteError: string;
}

interface NestedSkip {
  name: string;
  reason: string;
}

interface NestedAnalyzeResult {
  follow: ArchiveEntry[];
  skipped: NestedSkip[];
  used7zVerify: boolean;
  stopReason: string;
  notes: string[];
  /** 非空 = 已经解到头的成品文件夹，需要搬回源目录 */
  finishedFolder: string;
}

interface HoistResult {
  ok: boolean;
  movedFrom: string;
  movedTo: string;
  removedDirs: string[];
  keptDirs: string[];
  error: string;
}

interface ArchiveApi {
  selectFolder: () => Promise<string | null>;
  selectSevenZip: () => Promise<string | null>;
  getDefaults: () => Promise<{ sevenZipPath: string | null; homeFolder: string }>;
  readPersonalConfig: () => Promise<{
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
    passwords?: Array<{ value?: string; prefix?: string }>;
    disguisedExtensions?: string[];
  } | null>;
  scanFolder: (request: {
    folder: string;
    recursive: boolean;
    disguisedExtensions: string[];
    verifyWith7z: boolean;
    strictDisguised?: boolean;
  }) => Promise<ScanResult>;
  analyzeNested: (request: {
    folder: string;
    disguisedExtensions: string[];
    parentPath: string;
    depth: number;
    parentFileCount: number;
    fileThreshold: number;
    sevenZipPath: string | null;
  }) => Promise<NestedAnalyzeResult>;
  hoistFinished: (request: { folder: string; targetRoot: string }) => Promise<HoistResult>;
  extractArchive: (request: {
    id: string;
    archivePath: string;
    outputDir: string;
    passwords: string[];
    sevenZipPath: string | null;
    renameDisguised: boolean;
    renameExtension: string;
    deleteSource: boolean;
    sourcePaths: string[];
  }) => Promise<ExtractResult>;
  openPath: (target: string) => Promise<{ ok: boolean; error: string }>;
  showItemInFolder: (target: string) => Promise<{ ok: boolean; error: string }>;
  onScanProgress: (listener: (progress: { phase: string; done: number; total: number; current: string }) => void) => () => void;
  onExtractProgress: (listener: (progress: { id: string; percent: number }) => void) => () => void;
}

declare global {
  interface Window {
    api: ArchiveApi;
  }
}

interface RenderItem extends ArchiveEntry {
  depth: number;
  selected: boolean;
  status: ArchiveStatus;
  outputDir: string;
  error: string;
  /** 当前解压进度百分比（0-100），未开始为 0 */
  percent: number;
}

interface PasswordItem {
  id: string;
  value: string;
  prefix: string;
}

interface ExtensionItem {
  id: string;
  value: string;
}

interface Settings {
  recursive: boolean;
  separateDirs: boolean;
  /**
   * 解压出来的文件数超过这个值，就不再继续解压里面的嵌套压缩包。
   * 默认 3：只解出一两个文件的通常是"打包壳"，值得往下解；
   * 一次解出好几个文件，就认为这已经是正常内容了。
   */
  nestedFileThreshold: number;
  renameDisguised: boolean;
  /** 伪装后缀改名时使用的目标后缀，例如 zip / rar / 7z */
  renameExtension: string;
  /** 解压完成后删除源压缩包（含分卷） */
  deleteAfterExtract: boolean;
  /** 扫描时用 7-Zip 逐个打开文件校验 */
  verifyWith7z: boolean;
  sevenZipPath: string;
  /** 记住上次打开的压缩包文件夹 */
  sourceFolder: string;
  outputFolder: string;
}

const CONCURRENCY = 3;

const PASSWORD_LIST_KEY = 'archive-unpacker.passwords.v2';
const PASSWORD_DRAFT_KEY = 'archive-unpacker.passwordDraft.v1';
const EXTENSION_LIST_KEY = 'archive-unpacker.disguisedExtensions.v1';
const SETTINGS_KEY = 'archive-unpacker.settings.v1';
const PENDING_NESTED_KEY = 'archive-unpacker.pendingNested.v1';

const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element: ${id}`);
  }
  return element as T;
};

const sourceInput = $<HTMLInputElement>('sourceFolder');
const outputInput = $<HTMLInputElement>('outputFolder');
const sourceBrowseButton = $<HTMLButtonElement>('sourceBrowse');
const outputBrowseButton = $<HTMLButtonElement>('outputBrowse');
const rescanButton = $<HTMLButtonElement>('rescan');
const startButton = $<HTMLButtonElement>('start');
const stopButton = $<HTMLButtonElement>('stop');
const openOutputButton = $<HTMLButtonElement>('openOutput');
const progressRow = $<HTMLDivElement>('progressRow');
const progressFill = $<HTMLDivElement>('progressFill');
const progressText = $<HTMLSpanElement>('progressText');
const selectAllCheckbox = $<HTMLInputElement>('selectAll');
const summary = $<HTMLDivElement>('summary');
const topbarStatus = $<HTMLDivElement>('topbarStatus');
const archiveList = $<HTMLDivElement>('archiveRows');
const logBody = $<HTMLDivElement>('logBody');
const clearLogButton = $<HTMLButtonElement>('clearLog');

const settingsButton = $<HTMLButtonElement>('settingsButton');
const settingsMask = $<HTMLDivElement>('settingsMask');
const settingsClose = $<HTMLButtonElement>('settingsClose');
const recursiveCheckbox = $<HTMLInputElement>('recursive');
const separateDirsCheckbox = $<HTMLInputElement>('separateDirs');
const nestedFileThresholdInput = $<HTMLInputElement>('nestedFileThreshold');
const renameDisguisedCheckbox = $<HTMLInputElement>('renameDisguised');
const renameExtensionInput = $<HTMLInputElement>('renameExtension');
const deleteAfterExtractCheckbox = $<HTMLInputElement>('deleteAfterExtract');
const verifyWith7zCheckbox = $<HTMLInputElement>('verifyWith7z');
const sevenZipInput = $<HTMLInputElement>('sevenZip');
const sevenZipHint = $<HTMLDivElement>('sevenZipHint');
const sevenZipBrowseButton = $<HTMLButtonElement>('sevenZipBrowse');
const newExtensionInput = $<HTMLInputElement>('newExtension');
const addExtensionButton = $<HTMLButtonElement>('addExtension');
const extensionList = $<HTMLDivElement>('extensionList');

const newPasswordInput = $<HTMLInputElement>('newPassword');
const newPrefixInput = $<HTMLInputElement>('newPrefix');
const addPasswordButton = $<HTMLButtonElement>('addPassword');
const passwordList = $<HTMLDivElement>('passwordList');

let items: RenderItem[] = [];
let running = false;
let stopRequested = false;
let scanning = false;
let scanToken = 0;
let scanProgressLabel = '';

/* 本轮解压的进度状态（支持并发：同时记录多个在跑的任务） */
let batchTotal = 0;
let batchDone = 0;
const runningPercents = new Map<string, number>();

/* ---------------- 工具 ---------------- */

function createId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function baseNameOf(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

function normalizeExtension(value: string): string {
  return value.trim().toLowerCase().replace(/^\./, '');
}

/** 改名后缀：只允许字母数字，非法值回落到 zip（与主进程保持一致） */
function normalizeRenameExtension(value: string): string {
  const cleaned = normalizeExtension(value);
  return /^[a-z0-9]{1,8}$/.test(cleaned) ? cleaned : 'zip';
}

/** 嵌套解压层数：只允许 0~5 的整数，非法值回落到 0（不追嵌套） */
/** 阈值默认值：解压出来的文件数超过它就不继续解压嵌套包 */
const DEFAULT_NESTED_FILE_THRESHOLD = 3;
const MAX_NESTED_FILE_THRESHOLD = 999;

function clampNestedFileThreshold(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_NESTED_FILE_THRESHOLD;
  return Math.min(MAX_NESTED_FILE_THRESHOLD, Math.trunc(parsed));
}

let storageWarned = false;

function warnStorage(message: string): void {
  if (storageWarned) return;
  storageWarned = true;
  appendLog('error', `本地存储不可用，设置/密码将无法保存：${message}`);
}

function readJson<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch (error) {
    warnStorage(error instanceof Error ? error.message : String(error));
    return null;
  }
}

function writeJson(key: string, value: unknown): boolean {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    warnStorage(error instanceof Error ? error.message : String(error));
    return false;
  }
}

/* ---------------- 设置 ---------------- */

const defaultSettings: Settings = {
  recursive: true,
  separateDirs: true,
  nestedFileThreshold: DEFAULT_NESTED_FILE_THRESHOLD,
  renameDisguised: true,
  renameExtension: 'zip',
  deleteAfterExtract: true,
  verifyWith7z: false,
  sevenZipPath: '',
  sourceFolder: '',
  outputFolder: '',
};

let settings: Settings = { ...defaultSettings, ...(readJson<Partial<Settings>>(SETTINGS_KEY) ?? {}) };

// 旧版本会把「解压位置」自动填成源文件夹，这会让「包在哪就在哪解压」失效，这里清理掉
if (settings.outputFolder && settings.outputFolder === settings.sourceFolder) {
  settings.outputFolder = '';
}

// 旧的「最大嵌套层数」已由「文件数阈值」取代，直接按新默认值走（不再读旧字段）
settings.nestedFileThreshold = clampNestedFileThreshold(settings.nestedFileThreshold);

function persistSettings(): void {
  writeJson(SETTINGS_KEY, settings);
}

/* ---------------- 嵌套层级记忆 ---------------- */

/**
 * 记住「哪些包是程序自己挖出来的嵌套包、在第几层」。
 *
 * 批量解压中途停止/关掉程序后，下一次扫描会把这些包当成 depth 0 的顶层包，
 * 「解到头自动搬运」的判定（成品检测、层数护栏）就全都不认识了 ——
 * 大批量里出现过整条链安静解完却一个成品都不搬的情况，就是这个原因。
 *
 * key：包文件完整路径（小写）；value：嵌套深度（>0 才记）。
 */
type PendingNestedMap = Record<string, number>;

let pendingNested: PendingNestedMap = readJson<PendingNestedMap>(PENDING_NESTED_KEY) ?? {};

function persistPendingNested(): void {
  writeJson(PENDING_NESTED_KEY, pendingNested);
}

function rememberPendingNested(filePath: string, depth: number): void {
  if (depth <= 0) return;
  pendingNested[filePath.toLowerCase()] = depth;
  persistPendingNested();
}

function forgetPendingNested(...filePaths: Array<string | undefined>): void {
  let changed = false;
  for (const filePath of filePaths) {
    if (!filePath) continue;
    const key = filePath.toLowerCase();
    if (key in pendingNested) {
      delete pendingNested[key];
      changed = true;
    }
  }
  if (changed) persistPendingNested();
}

function applySettingsToUi(): void {
  recursiveCheckbox.checked = settings.recursive;
  separateDirsCheckbox.checked = settings.separateDirs;
  nestedFileThresholdInput.value = String(settings.nestedFileThreshold);
  renameDisguisedCheckbox.checked = settings.renameDisguised;
  renameExtensionInput.value = settings.renameExtension;
  deleteAfterExtractCheckbox.checked = settings.deleteAfterExtract;
  verifyWith7zCheckbox.checked = settings.verifyWith7z;
  sevenZipInput.value = settings.sevenZipPath;
  sourceInput.value = settings.sourceFolder;
  outputInput.value = settings.outputFolder;
}

/* ---------------- 候选密码（含前缀绑定） ---------------- */

let passwordItems: PasswordItem[] = readJson<Array<Partial<PasswordItem>>>(PASSWORD_LIST_KEY)?.map((entry) => ({
  id: typeof entry?.id === 'string' ? entry.id : createId(),
  value: typeof entry?.value === 'string' ? entry.value : '',
  prefix: typeof entry?.prefix === 'string' ? entry.prefix : '',
})) ?? [];

function persistPasswordItems(): void {
  writeJson(PASSWORD_LIST_KEY, passwordItems);
}

/**
 * 「密码 / 前缀」输入框里尚未点 + 的内容也一起记住，
 * 下次打开程序自动回填，不用重新输。
 */
interface PasswordDraft {
  value: string;
  prefix: string;
}

let passwordDraft: PasswordDraft = {
  value: '',
  prefix: '',
  ...(readJson<Partial<PasswordDraft>>(PASSWORD_DRAFT_KEY) ?? {}),
};

function persistPasswordDraft(): void {
  passwordDraft = {
    value: newPasswordInput.value,
    prefix: newPrefixInput.value,
  };
  writeJson(PASSWORD_DRAFT_KEY, passwordDraft);
}

function applyPasswordDraft(): void {
  if (passwordDraft.value) newPasswordInput.value = passwordDraft.value;
  if (passwordDraft.prefix) newPrefixInput.value = passwordDraft.prefix;
}

function splitPrefixes(raw: string): string[] {
  return raw
    .split(/[,，、\s]+/)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0);
}

/** 文件名命中前缀的密码优先，其余按列表顺序兜底；输入框里没点 + 的也作为最后兜底 */
function candidatesFor(fileName: string): string[] {
  const lowerName = fileName.toLowerCase();
  const preferred: string[] = [];
  const fallback: string[] = [];

  for (const item of passwordItems) {
    if (!item.value) continue;
    if (splitPrefixes(item.prefix).some((token) => lowerName.startsWith(token))) {
      preferred.push(item.value);
    } else {
      fallback.push(item.value);
    }
  }

  const ordered = [...new Set([...preferred, ...fallback])];
  const draft = newPasswordInput.value.trim();
  if (draft && !ordered.includes(draft)) {
    ordered.push(draft);
  }
  return ordered;
}

function renderPasswordList(): void {
  if (passwordItems.length === 0) {
    passwordList.innerHTML = `<div class="password-empty">还没有候选密码</div>`;
    return;
  }

  passwordList.innerHTML = passwordItems
    .map(
      (item, index) => `
      <div class="password-item" data-id="${escapeHtml(item.id)}">
        <input class="password-entry" type="text" value="${escapeHtml(item.value)}" placeholder="密码" spellcheck="false" />
        <input class="pw-prefix" type="text" value="${escapeHtml(item.prefix)}" placeholder="前缀" title="文件名前缀，多个用逗号分隔" spellcheck="false" />
        <button class="mini-button" data-pw-action="up" title="上移" ${index === 0 ? 'disabled' : ''}>↑</button>
        <button class="mini-button" data-pw-action="down" title="下移" ${index === passwordItems.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="mini-button danger" data-pw-action="remove" title="删除">×</button>
      </div>
    `,
    )
    .join('');
}

function addPasswordToList(value: string, prefix: string): void {
  const password = value.trim();
  if (!password) {
    appendLog('warning', '请输入要添加的密码。');
    return;
  }

  if (passwordItems.some((item) => item.value === password && item.prefix.trim() === prefix.trim())) {
    appendLog('warning', '该密码（含同样前缀）已经在候选列表中。');
    return;
  }

  passwordItems.push({ id: createId(), value: password, prefix: prefix.trim() });
  persistPasswordItems();
  renderPasswordList();
  newPasswordInput.value = '';
  newPrefixInput.value = '';
  newPasswordInput.focus();
}

function movePasswordInList(id: string, offset: -1 | 1): void {
  const index = passwordItems.findIndex((item) => item.id === id);
  const targetIndex = index + offset;
  if (index < 0 || targetIndex < 0 || targetIndex >= passwordItems.length) return;

  const [target] = passwordItems.splice(index, 1);
  passwordItems.splice(targetIndex, 0, target);
  persistPasswordItems();
  renderPasswordList();
}

/* ---------------- 伪装后缀 ---------------- */

let extensionItems: ExtensionItem[] =
  readJson<Array<Partial<ExtensionItem>>>(EXTENSION_LIST_KEY)?.map((entry) => ({
    id: typeof entry?.id === 'string' ? entry.id : createId(),
    value: normalizeExtension(typeof entry?.value === 'string' ? entry.value : ''),
  })).filter((entry) => entry.value.length > 0) ?? [];

if (extensionItems.length === 0) {
  extensionItems = [{ id: createId(), value: 'png' }];
}

function persistExtensionItems(): void {
  writeJson(EXTENSION_LIST_KEY, extensionItems);
}

function extensionValues(): string[] {
  return extensionItems.map((item) => normalizeExtension(item.value)).filter((value) => value.length > 0);
}

function renderExtensionList(): void {
  if (extensionItems.length === 0) {
    extensionList.innerHTML = `<span class="tag-empty">还没有伪装后缀。</span>`;
    return;
  }

  extensionList.innerHTML = extensionItems
    .map(
      (item) => `
    <span class="tag-item" data-id="${escapeHtml(item.id)}">
      <span>.${escapeHtml(normalizeExtension(item.value))}</span>
      <button class="tag-remove" data-extension-action="remove" title="删除">×</button>
    </span>
  `,
    )
    .join('');
}

/* ---------------- 状态与渲染 ---------------- */

const statusMeta: Record<ArchiveStatus, { label: string; className: string }> = {
  pending: { label: '等待', className: 'pending' },
  running: { label: '解压中', className: 'running' },
  done: { label: '完成', className: 'done' },
  'wrong-password': { label: '密码错误', className: 'wrong-password' },
  failed: { label: '失败', className: 'failed' },
  skipped: { label: '跳过', className: 'skipped' },
};

function outputRoot(): string {
  return outputInput.value.trim() || sourceInput.value.trim();
}

/**
 * 常见压缩后缀（剥输出目录名时用）：
 * 分卷包名剥完序号后往往还挂着 .7z/.rar 这类尾巴（精灵王.7z.001），
 * 不剥的话输出目录会叫「精灵王.7z」，将来搬走成品也带着这个怪名字。
 */
const ARCHIVE_SUFFIXES = new Set(['7z', 'zip', 'rar', 'lz4', 'tar', 'gz', 'bz2', 'xz']);

/** 分卷序号尾：.001 ~ .999（7z/zip 分卷）、.part1 ~ .part999（rar 分卷） */
const VOLUME_SUFFIX_RE = /^\.(?:part[1-9]\d{0,2}|\d{3})$/i;

/**
 * 包名 → 输出目录名。
 * 第一层扩展名无条件剥掉（game.mp4 → game，和旧版行为一致）；
 * 分卷包剥完序号后往往还挂着压缩后缀，继续往里剥：
 *   精灵王.7z.001 → 精灵王.7z → 精灵王
 *   MygsT.part1.rar → MygsT.part1 → MygsT
 */
function archiveBaseName(fileName: string): string {
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

function joinPath(root: string, name: string): string {
  return root.endsWith('\\') || root.endsWith('/') ? `${root}${name}` : `${root}\\${name}`;
}

/** 取文件所在目录（不依赖 path 模块，渲染层用） */
function dirNameOf(filePath: string): string {
  const index = Math.max(filePath.lastIndexOf('\\'), filePath.lastIndexOf('/'));
  return index > 0 ? filePath.slice(0, index) : '';
}

/**
 * 解压落点：压缩包在哪个文件夹，结果就放在那个文件夹里。
 * - 没填「解压位置」：以压缩包自身所在目录为根（默认行为）
 * - 填了「解压位置」：强制输出到该目录
 * - separateDirs 打开时，再套一层以压缩包名命名的子目录
 */
function itemOutputDir(item: RenderItem): string {
  const override = outputInput.value.trim();
  const base = override || dirNameOf(item.path);
  if (!base) return '';
  if (!settings.separateDirs) return base;
  return joinPath(base, archiveBaseName(item.name));
}

function setTopbar(idle: boolean): void {
  if (running) {
    topbarStatus.textContent = '解压中';
    topbarStatus.className = 'topbar-status running';
  } else if (idle) {
    topbarStatus.textContent = '空闲';
    topbarStatus.className = 'topbar-status';
  } else {
    topbarStatus.textContent = '已完成';
    topbarStatus.className = 'topbar-status done';
  }
}

function updateSelectAll(): void {
  const selected = items.filter((item) => item.selected).length;
  selectAllCheckbox.checked = items.length > 0 && selected === items.length;
  selectAllCheckbox.indeterminate = selected > 0 && selected < items.length;
}

function updateSummary(): void {
  if (scanning) {
    summary.textContent = scanProgressLabel || '正在扫描...';
    return;
  }
  if (items.length === 0) {
    summary.textContent = '尚未扫描';
    return;
  }

  const selected = items.filter((item) => item.selected).length;
  const done = items.filter((item) => item.status === 'done').length;
  const wrong = items.filter((item) => item.status === 'wrong-password').length;
  const failed = items.filter((item) => item.status === 'failed').length;
  const volumes = items.reduce((total, item) => total + Math.max(0, item.partCount - 1), 0);
  const volumeText = volumes > 0 ? ` · 已合并 ${volumes} 个分卷` : '';

  summary.textContent = `共 ${items.length} 个 · 已选 ${selected} · 完成 ${done} · 密码错 ${wrong} · 失败 ${failed}${volumeText}`;
}

function updateButtons(): void {
  const busy = running || scanning;
  sourceBrowseButton.disabled = busy;
  outputBrowseButton.disabled = busy;
  rescanButton.disabled = busy || !sourceInput.value.trim();
  startButton.disabled = busy || items.length === 0;
  stopButton.disabled = !running;
  openOutputButton.disabled = !outputRoot();
  setTopbar(true);
}

function appendLog(level: 'info' | 'success' | 'warning' | 'error', message: string): void {
  const line = document.createElement('div');
  line.className = `log-line ${level === 'info' ? 'muted' : level}`;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  logBody.appendChild(line);

  while (logBody.children.length > 500) {
    logBody.removeChild(logBody.firstElementChild as Element);
  }

  logBody.scrollTop = logBody.scrollHeight;
}

function renderRows(): void {
  if (items.length === 0) {
    archiveList.innerHTML = `<div class="empty-state">选择压缩包文件夹后会自动扫描。</div>`;
    updateSelectAll();
    updateSummary();
    updateButtons();
    return;
  }

  const rows = items
    .map((item) => {
      const ext = item.extension.replace('.', '').toUpperCase().slice(0, 4) || 'FILE';
      const meta = statusMeta[item.status];
      const badgeText = item.status === 'running' ? `解压中 ${Math.round(item.percent || 0)}%` : meta.label;
      return `
      <div class="archive-row ${item.depth > 0 ? 'depth-1' : ''}" data-id="${escapeHtml(item.id)}" title="${escapeHtml(item.path)}">
        <input class="row-select" type="checkbox" ${item.selected ? 'checked' : ''} ${running ? 'disabled' : ''} />
        <span class="ext-badge ${item.disguised ? 'disguised' : ''}">${escapeHtml(item.disguised ? `${ext}!` : ext)}</span>
        <span class="row-name">${escapeHtml(item.name)}</span>
        <span class="parts-tag">${item.partCount > 1 ? `${item.partCount}卷` : ''}</span>
        <span class="row-size">${formatSize(item.size)}</span>
        <span class="badge ${meta.className}">${escapeHtml(badgeText)}</span>
        <span class="row-actions">
          <button class="link-button" data-action="open" data-id="${escapeHtml(item.id)}" title="在资源管理器中显示">定位</button>
          <button class="link-button danger-link" data-action="remove" data-id="${escapeHtml(item.id)}" title="从列表移除">×</button>
        </span>
      </div>
    `;
    })
    .join('');

  archiveList.innerHTML = rows;
  updateSelectAll();
  updateSummary();
  updateButtons();
}

function findItem(id: string): RenderItem | undefined {
  return items.find((item) => item.id === id);
}

function updateRow(item: RenderItem): void {
  const row = archiveList.querySelector<HTMLElement>(`.archive-row[data-id="${item.id}"]`);
  if (!row) return;

  const badge = row.querySelector<HTMLElement>('.badge');
  if (badge) {
    const meta = statusMeta[item.status];
    badge.className = `badge ${meta.className}`;
    // 解压中显示实时百分比
    badge.textContent = item.status === 'running' ? `解压中 ${Math.round(item.percent || 0)}%` : meta.label;
  }

  updateSelectAll();
  updateSummary();
}

function refreshOutputDirs(): void {
  for (const item of items) {
    item.outputDir = itemOutputDir(item);
  }
}

/** 整体进度 = (已完成项 + 各在跑项百分比之和/100) / 总项数 */
function batchOverallPercent(): number {
  if (batchTotal === 0) return 0;
  let runningSum = 0;
  for (const percent of runningPercents.values()) runningSum += percent;
  return Math.min(100, ((batchDone + runningSum / 100) / batchTotal) * 100);
}

function updateBatchProgress(): void {
  if (!running || batchTotal === 0) {
    progressRow.hidden = true;
    progressFill.style.width = '0%';
    progressText.textContent = '';
    progressText.title = '';
    return;
  }

  progressRow.hidden = false;
  progressFill.style.width = `${batchOverallPercent().toFixed(1)}%`;

  let topPercent = -1;
  let topName = '';
  for (const [id, percent] of runningPercents) {
    if (percent > topPercent) {
      topPercent = percent;
      topName = findItem(id)?.name ?? '';
    }
  }

  const tail = topPercent >= 0 ? `${topPercent}%` : '准备中';
  progressText.textContent = `${batchDone}/${batchTotal} · ${tail}`;
  progressText.title = topName ? `正在解压：${topName}` : '';
}

/** 定位：打开该压缩包所在文件夹并选中它；文件已不在时退回打开所在目录 */
async function openItemLocation(item: RenderItem): Promise<void> {
  if (!item.path) {
    appendLog('warning', `${item.name}：没有可定位的路径。`);
    return;
  }

  const result = await window.api.showItemInFolder(item.path);
  if (!result.ok) {
    appendLog('warning', `${item.name}：定位失败。${result.error || ''}`);
  }
}

/* ---------------- 扫描 ---------------- */

/** 返回是否真的执行了扫描（正忙时返回 false，由调用方重试） */
async function scanArchives(options: { log?: boolean } = {}): Promise<boolean> {
  const folder = sourceInput.value.trim();
  if (!folder) return false;
  if (running || scanning) return false;

  scanning = true;
  scanProgressLabel = '正在收集文件...';
  const token = ++scanToken;
  updateSummary();
  updateButtons();
  if (options.log !== false) {
    appendLog('info', `正在扫描：${folder}`);
  }

  try {
    const result = await window.api.scanFolder({
      folder,
      recursive: settings.recursive,
      disguisedExtensions: extensionValues(),
      verifyWith7z: settings.verifyWith7z,
    });

    if (token !== scanToken) return false;

    if (result.error) {
      appendLog('error', result.error);
      items = [];
      renderRows();
      return true;
    }

    if (!settings.sevenZipPath && !sevenZipInput.value && result.sevenZipPath) {
      settings.sevenZipPath = result.sevenZipPath;
      sevenZipInput.value = result.sevenZipPath;
      persistSettings();
    }

    // 注意：不再自动把「解压位置」填成扫描目录。
    // 留空时按「压缩包在哪个文件夹就在哪里解压」，填了才强制覆盖。

    items = result.archives.map((archive) => {
      // 恢复嵌套层级：上一次批量解压中断后剩下的嵌套包，别当成顶层包重新计数
      const restoredDepth = pendingNested[archive.path.toLowerCase()];
      const depth = typeof restoredDepth === 'number' && restoredDepth > 0 ? restoredDepth : 0;
      return {
        ...archive,
        depth,
        selected: true,
        status: 'pending' as ArchiveStatus,
        outputDir: '',
        error: '',
        percent: 0,
      };
    });

    // 只保留本次扫描还看得见的路径，防止记忆无限膨胀
    const stillThere: PendingNestedMap = {};
    for (const item of items) {
      const key = item.path.toLowerCase();
      const depth = pendingNested[key];
      if (typeof depth === 'number' && depth > 0) stillThere[key] = depth;
    }
    pendingNested = stillThere;
    persistPendingNested();

    refreshOutputDirs();

    const volumes = items.reduce((total, item) => total + Math.max(0, item.partCount - 1), 0);
    renderRows();
    if (options.log !== false) {
      appendLog(
        'success',
        `扫描完成：${items.length} 个压缩包${volumes > 0 ? `（已合并 ${volumes} 个分卷）` : ''}。`,
      );
    }
    if (result.used7zVerify) {
      appendLog('info', `7-Zip 校验通过 ${result.verified} 个。`);
    }
    if (result.rejected.length > 0) {
      const preview = result.rejected.slice(0, 5).join('、');
      const more = result.rejected.length > 5 ? ` 等 ${result.rejected.length} 个` : '';
      appendLog('warning', `以下文件 7-Zip 无法识别为压缩包，已跳过：${preview}${more}`);
    }
    return true;
  } catch (error) {
    if (token === scanToken) {
      appendLog('error', `扫描失败：${error instanceof Error ? error.message : String(error)}`);
    }
    return true;
  } finally {
    if (token === scanToken) {
      scanning = false;
      updateSummary();
      updateButtons();
    }
  }
}

let sourceInputTimer = 0;

/** 输入/选择文件夹后延迟自动扫描；若正忙则稍后重试，避免漏掉最后一次扫描 */
function scheduleAutoScan(): void {
  window.clearTimeout(sourceInputTimer);

  const attempt = async (retry: number): Promise<void> => {
    const done = await scanArchives({ log: false });
    if (!done && retry > 0) {
      sourceInputTimer = window.setTimeout(() => void attempt(retry - 1), 400);
    }
  };

  sourceInputTimer = window.setTimeout(() => void attempt(20), 350);
}

/* ---------------- 解压 ---------------- */

function selectedItems(): RenderItem[] {
  return items.filter((item) => item.selected);
}

function createNestedItem(archive: ArchiveEntry, parent: RenderItem): RenderItem {
  const item: RenderItem = {
    ...archive,
    depth: parent.depth + 1,
    selected: true,
    status: 'pending',
    outputDir: '',
    error: '',
    percent: 0,
  };
  // 嵌套包同样解压到它自己所在的文件夹，不再跳到最外层输出目录
  item.outputDir = itemOutputDir(item);
  // 记住「这是程序自己挖出来的嵌套包、在第几层」，
  // 中断后再扫描时按这个深度恢复，搬运判定链才认得它
  rememberPendingNested(item.path, item.depth);
  return item;
}

/**
 * 解压完一层后，问主进程「这里还有哪些包确实需要继续解」。
 *
 * 判定规则全在主进程（`analyzeNestedArchives`），渲染层只负责：
 *  - 把刚解压出来的文件数报上去；
 *  - 被叫停时把原因写进日志（让用户看得见"为什么不再解了"）；
 *  - 把确认要解的包加进队列。
 */
async function discoverNestedArchives(
  parent: RenderItem,
  result: ExtractResult,
  seenPaths: Set<string>,
): Promise<RenderItem[]> {
  if (!result.success) return [];

  try {
    const analysis = await window.api.analyzeNested({
      folder: result.outputDir,
      disguisedExtensions: extensionValues(),
      parentPath: parent.path,
      depth: parent.depth,
      parentFileCount: result.extractedFiles,
      fileThreshold: settings.nestedFileThreshold,
      sevenZipPath: sevenZipInput.value.trim() || settings.sevenZipPath || null,
    });

    // 被主动叫停：把原因说清楚，别让用户以为是漏解了
    if (analysis.stopReason) {
      appendLog('info', `${parent.name}：${analysis.stopReason}。`);
      return [];
    }

    // 判定过程中的说明（例如"只解出 1 个 .tif，是登记过的伪装后缀，直接继续解"）
    for (const note of analysis.notes ?? []) {
      appendLog('info', `${parent.name}：${note}。`);
    }

    // 解到头了：把成品文件夹搬回源目录，并清掉一路留下的空目录外壳
    if (analysis.finishedFolder) {
      const targetRoot = sourceInput.value.trim();

      if (!targetRoot) {
        appendLog('warning', `${parent.name}：已经解到成品「${baseNameOf(analysis.finishedFolder)}」，但没设置「压缩包文件夹」，不敢搬移。`);
        return [];
      }

      const hoist = await window.api.hoistFinished({ folder: analysis.finishedFolder, targetRoot });

      if (!hoist.ok) {
        appendLog('warning', `${parent.name}：成品搬移失败，文件仍在原处。${hoist.error}`);
        return [];
      }

      if (hoist.movedTo.toLowerCase() === hoist.movedFrom.toLowerCase()) {
        appendLog('info', `${parent.name}：解压完成 —— 成品「${baseNameOf(hoist.movedTo)}」已经在目标位置，无需搬移。`);
      } else {
        appendLog('success', `${parent.name}：解压完成 —— 成品「${baseNameOf(hoist.movedTo)}」已移到 ${dirNameOf(hoist.movedTo)}`);
      }

      if (hoist.removedDirs.length > 0) {
        appendLog(
          'info',
          `${parent.name}：已清掉 ${hoist.removedDirs.length} 个空目录（${hoist.removedDirs.map(baseNameOf).join(' ← ')}）。`,
        );
      }

      if (hoist.keptDirs.length > 0) {
        appendLog(
          'info',
          `${parent.name}：${hoist.keptDirs.map(baseNameOf).join('、')} 里还有别的东西，没有删。`,
        );
      }

      return [];
    }

    // 跳过的文件按原因归类，避免一个包里几百张图刷屏
    if (analysis.skipped.length > 0) {
      const byReason = new Map<string, string[]>();
      for (const skipped of analysis.skipped) {
        const list = byReason.get(skipped.reason) ?? [];
        list.push(skipped.name);
        byReason.set(skipped.reason, list);
      }

      for (const [reason, list] of byReason) {
        const sample = list.slice(0, 3).join('、');
        const more = list.length > 3 ? ` 等 ${list.length} 个` : '';
        appendLog('info', `${parent.name}：不动 ${sample}${more} —— ${reason}。`);
      }
    }

    const nested: RenderItem[] = [];
    for (const archive of analysis.follow) {
      const key = archive.path.toLowerCase();
      if (seenPaths.has(key)) continue;
      seenPaths.add(key);
      nested.push(createNestedItem(archive, parent));
    }

    if (nested.length > 0) {
      items.push(...nested);
      renderRows();
      appendLog('info', `${parent.name}：判断出 ${nested.length} 个包还需要继续解压，已加入队列。`);
    } else if (analysis.skipped.length === 0) {
      // 什么都不做的时候也必须说一句，否则用户分不清"到这就够了"还是"程序漏了"
      appendLog(
        'info',
        `${parent.name}：解压出 ${result.extractedFiles} 个文件，里面没有需要继续解压的压缩包，到此为止。`,
      );
    }

    return nested;
  } catch (error) {
    appendLog('warning', `${parent.name}：扫描嵌套压缩包失败。${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

async function processItem(item: RenderItem): Promise<ExtractResult | null> {
  item.status = 'running';
  item.error = '';
  item.percent = 0;
  runningPercents.set(item.id, 0);
  updateRow(item);
  updateBatchProgress();

  const outputDir = itemOutputDir(item);

  try {
    const result = await window.api.extractArchive({
      id: item.id,
      archivePath: item.path,
      outputDir,
      passwords: candidatesFor(item.name),
      sevenZipPath: sevenZipInput.value.trim() || null,
      renameDisguised: settings.renameDisguised,
      renameExtension: normalizeRenameExtension(settings.renameExtension),
      deleteSource: settings.deleteAfterExtract,
      sourcePaths: item.partPaths?.length ? item.partPaths : [item.path],
    });

    item.outputDir = result.outputDir;
    item.error = result.error;

    if (result.strippedPrefix > 0) {
      appendLog('info', `${item.name}：已原地移除开头的 ${formatSize(result.strippedPrefix)} 无关数据后解压。`);
    }

    if (result.lz4Bytes > 0) {
      const size = formatSize(result.lz4Bytes);
      if (!result.lz4InnerIsArchive) {
        appendLog('info', `${item.name}：是 LZ4 压缩流（7-Zip 不支持，程序自己解），已解开 ${size} → 「${result.lz4InnerName}」。`);
      } else if (result.lz4InnerKept) {
        appendLog('warning', `${item.name}：LZ4 已解开 ${size}，但内层压缩包没解成功，已把「${result.lz4InnerName}」留在源目录旁备用。`);
      } else {
        appendLog('info', `${item.name}：是 LZ4 压缩流（7-Zip 不支持，程序自己解），已解开 ${size}，内层还是压缩包，继续解压。`);
      }
    }

    if (result.deletedFiles.length > 0) {
      appendLog('info', `${item.name}：已删除源压缩包${result.deletedFiles.length > 1 ? ` 及分卷，共 ${result.deletedFiles.length} 个文件` : ''}。`);
    }

    if (result.deleteError) {
      appendLog('warning', `${item.name}：源压缩包删除失败。${result.deleteError}`);
    }

    if (result.renamedFrom) {
      appendLog('info', `已改名：${baseNameOf(result.renamedFrom)} → ${baseNameOf(result.usedPath)}`);

      // 层级记忆跟着改：旧路径的记录搬到新路径名下
      const oldDepth = pendingNested[result.renamedFrom.toLowerCase()];
      if (typeof oldDepth === 'number') {
        pendingNested[result.usedPath.toLowerCase()] = oldDepth;
        delete pendingNested[result.renamedFrom.toLowerCase()];
        persistPendingNested();
      }

      item.path = result.usedPath;
      item.name = baseNameOf(result.usedPath);
      item.extension = item.name.slice(item.name.lastIndexOf('.')).toLowerCase();
      item.disguised = false;
      renderRows();
    }

    if (result.success) {
      // 这个包已经解完了，不再需要层级记忆
      forgetPendingNested(item.path, result.usedPath);
      item.status = 'done';
      item.percent = 100;
      appendLog(
        'success',
        `${item.name}：解压完成（${formatDuration(result.elapsedMs)}，${result.extractedFiles} 个文件）→ ${result.outputDir}`,
      );
    } else if (result.wrongPassword) {
      item.status = 'wrong-password';
      appendLog('error', `${item.name}：所有候选密码均未成功。`);
    } else {
      item.status = 'failed';
      appendLog('error', `${item.name}：失败。${result.error || `退出代码 ${result.exitCode ?? '未知'}`}`);
    }

    return result;
  } catch (error) {
    item.status = 'failed';
    item.error = error instanceof Error ? error.message : String(error);
    appendLog('error', `${item.name}：调用解压失败。${item.error}`);
    return null;
  } finally {
    runningPercents.delete(item.id);
    updateRow(item);
    updateBatchProgress();
  }
}

async function startExtraction(): Promise<void> {
  if (running) return;

  const batch = selectedItems();
  if (batch.length === 0) {
    appendLog('warning', '没有选择任何压缩包。');
    return;
  }

  // 落点由压缩包自身所在目录推导，无需再强制要求设置「解压位置」
  const draftPassword = newPasswordInput.value.trim();
  if (draftPassword && !passwordItems.some((item) => item.value === draftPassword)) {
    appendLog('info', `「密码」框里的内容也会作为最后一个兜底候选参与尝试。`);
  }

  if (passwordItems.length === 0 && !draftPassword) {
    appendLog('warning', '没有候选密码，将按无密码解压。');
  }

  stopRequested = false;
  running = true;

  const queue: RenderItem[] = batch.slice();
  const seenPaths = new Set<string>(queue.map((item) => item.path.toLowerCase()));
  let nextIndex = 0;
  let inFlight = 0;
  let successCount = 0;
  let wrongCount = 0;
  let failedCount = 0;
  let nestedCount = 0;

  for (const item of queue) {
    if (item.status !== 'done') item.status = 'pending';
    item.error = '';
    item.percent = 0;
    item.outputDir = itemOutputDir(item);
  }

  // 初始化本轮进度
  batchTotal = queue.length;
  batchDone = 0;
  runningPercents.clear();
  updateBatchProgress();

  renderRows();
  appendLog('info', `开始解压 ${queue.length} 个压缩包，并发 ${CONCURRENCY}。`);
  setTopbar(true);

  const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

  try {
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (!stopRequested) {
        const index = nextIndex;

        if (index < queue.length) {
          nextIndex += 1;
          inFlight += 1;

          const item = queue[index];
          const result = await processItem(item);

          if (item.status === 'done') successCount += 1;
          if (item.status === 'wrong-password') wrongCount += 1;
          if (item.status === 'failed') failedCount += 1;

          batchDone += 1;
          batchTotal = queue.length;
          updateBatchProgress();

          if (result?.success) {
            const discovered = await discoverNestedArchives(item, result, seenPaths);
            queue.push(...discovered);
            nestedCount += discovered.length;
            batchTotal = queue.length;
            updateBatchProgress();
          }

          inFlight -= 1;
          continue;
        }

        if (inFlight > 0) {
          await sleep(150);
          continue;
        }

        break;
      }
    });

    await Promise.all(workers);

    for (const item of queue) {
      if (item.status === 'pending' || item.status === 'running') {
        item.status = 'skipped';
        updateRow(item);
      }
    }

    const stopped = stopRequested;
    const skipped = queue.filter((item) => item.status === 'skipped').length;
    const nestedText = nestedCount > 0 ? `，嵌套新增 ${nestedCount}` : '';
    appendLog(
      stopped ? 'warning' : 'success',
      stopped
        ? `已停止。成功 ${successCount}，密码错误 ${wrongCount}，失败 ${failedCount}，跳过 ${skipped}${nestedText}`
        : `本轮完成。成功 ${successCount}，密码错误 ${wrongCount}，失败 ${failedCount}${nestedText}`,
    );
  } finally {
    running = false;
    stopRequested = false;
    renderRows();
    updateButtons();
    setTopbar(false);
    showBatchCompletion();
  }
}

let completionTimer = 0;

/** 收尾时把进度条打满并展示 1.5 秒，随后收起 */
function showBatchCompletion(): void {
  window.clearTimeout(completionTimer);

  if (batchTotal === 0) {
    progressRow.hidden = true;
    progressFill.style.width = '0%';
    progressText.textContent = '';
    return;
  }

  progressRow.hidden = false;
  progressFill.style.width = '100%';
  progressText.textContent = `${batchDone}/${batchTotal} · 完成`;
  progressText.title = '';

  completionTimer = window.setTimeout(() => {
    progressRow.hidden = true;
    progressFill.style.width = '0%';
    progressText.textContent = '';
  }, 1500);
}

function stopExtraction(): void {
  if (!running) return;
  stopRequested = true;
  appendLog('warning', '正在停止：已开始的会继续完成，未开始的将跳过。');
}

/* ---------------- 设置弹窗 ---------------- */

function openSettings(): void {
  settingsMask.hidden = false;
}

function closeSettings(): void {
  settingsMask.hidden = true;
}

function updateSevenZipHint(): void {
  if (sevenZipInput.value.trim()) {
    sevenZipHint.textContent = '将使用上方路径中的 7z.exe。';
    sevenZipHint.className = 'hint ok';
  } else {
    sevenZipHint.textContent = '未指定时会自动检测常见安装位置。';
    sevenZipHint.className = 'hint';
  }
}

/* ---------------- 事件绑定 ---------------- */

sourceBrowseButton.addEventListener('click', async () => {
  if (running) return;
  const folder = await window.api.selectFolder();
  if (!folder) return;

  sourceInput.value = folder;
  // 只设置源文件夹，不再顺手把「解压位置」也填上（留空才能「包在哪就在哪解压」）
  settings.sourceFolder = folder;
  persistSettings();
  updateButtons();

  if (!(await scanArchives())) {
    scheduleAutoScan();
  }
});

outputBrowseButton.addEventListener('click', async () => {
  if (running) return;
  const folder = await window.api.selectFolder();
  if (!folder) return;

  outputInput.value = folder;
  settings.outputFolder = folder;
  persistSettings();
  refreshOutputDirs();
  updateButtons();
});

sourceInput.addEventListener('input', () => {
  settings.sourceFolder = sourceInput.value.trim();
  persistSettings();
  updateButtons();
  scheduleAutoScan();
});

outputInput.addEventListener('input', () => {
  settings.outputFolder = outputInput.value.trim();
  persistSettings();
  refreshOutputDirs();
  updateButtons();
});

rescanButton.addEventListener('click', () => {
  void scanArchives();
});

startButton.addEventListener('click', () => {
  void startExtraction();
});

stopButton.addEventListener('click', stopExtraction);

openOutputButton.addEventListener('click', async () => {
  // 优先打开刚解压出来的目录，其次才是「解压位置 / 源文件夹」
  const extracted = items.find((item) => item.status === 'done' && item.outputDir);
  const target = outputInput.value.trim() || extracted?.outputDir || outputRoot();
  if (!target) return;
  const result = await window.api.openPath(target);
  if (!result.ok) {
    appendLog('error', `无法打开输出目录：${result.error || '未知错误'}`);
  }
});

clearLogButton.addEventListener('click', () => {
  logBody.innerHTML = '';
});

selectAllCheckbox.addEventListener('change', () => {
  const checked = selectAllCheckbox.checked;
  for (const item of items) item.selected = checked;
  renderRows();
});

archiveList.addEventListener('change', (event) => {
  const target = event.target as HTMLElement;
  if (!target.classList.contains('row-select')) return;

  const row = target.closest('.archive-row') as HTMLElement | null;
  if (!row?.dataset.id) return;

  const item = findItem(row.dataset.id);
  if (!item) return;

  item.selected = (target as HTMLInputElement).checked;
  updateSelectAll();
  updateSummary();
});

archiveList.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const button = target.closest<HTMLButtonElement>('button[data-action]');
  if (!button?.dataset.id) return;

  const item = findItem(button.dataset.id);
  if (!item) return;

  if (button.dataset.action === 'remove') {
    if (running) return;
    items = items.filter((candidate) => candidate.id !== item.id);
    renderRows();
    appendLog('info', `已从列表移除：${item.name}`);
    return;
  }

  if (button.dataset.action === 'open') {
    void openItemLocation(item);
  }
});

/* 密码列表 */

addPasswordButton.addEventListener('click', () => {
  addPasswordToList(newPasswordInput.value, newPrefixInput.value);
});

// 输入框内容随时落盘，重开程序自动回填
for (const input of [newPasswordInput, newPrefixInput]) {
  input.addEventListener('input', () => {
    persistPasswordDraft();
  });
  input.addEventListener('blur', () => {
    persistPasswordDraft();
  });
}

for (const input of [newPasswordInput, newPrefixInput]) {
  input.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key === 'Enter') {
      event.preventDefault();
      addPasswordToList(newPasswordInput.value, newPrefixInput.value);
    }
  });
}

passwordList.addEventListener('input', (event) => {
  const target = event.target as HTMLElement;
  const row = target.closest<HTMLElement>('[data-id]');
  if (!row?.dataset.id) return;

  const item = passwordItems.find((candidate) => candidate.id === row.dataset.id);
  if (!item) return;

  if (target.classList.contains('password-entry')) {
    item.value = (target as HTMLInputElement).value;
    persistPasswordItems();
  } else if (target.classList.contains('pw-prefix')) {
    item.prefix = (target as HTMLInputElement).value;
    persistPasswordItems();
  }
});

passwordList.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const button = target.closest<HTMLButtonElement>('button[data-pw-action]');
  if (!button) return;

  const row = button.closest<HTMLElement>('[data-id]');
  if (!row?.dataset.id) return;

  const action = button.dataset.pwAction;
  const id = row.dataset.id;
  const item = passwordItems.find((candidate) => candidate.id === id);
  if (!item) return;

  if (action === 'remove') {
    passwordItems = passwordItems.filter((candidate) => candidate.id !== id);
    persistPasswordItems();
    renderPasswordList();
    return;
  }

  if (action === 'up') {
    movePasswordInList(id, -1);
    return;
  }

  if (action === 'down') {
    movePasswordInList(id, 1);
    return;
  }
});

/* 设置 */

settingsButton.addEventListener('click', openSettings);
settingsClose.addEventListener('click', closeSettings);
settingsMask.addEventListener('click', (event) => {
  if (event.target === settingsMask) closeSettings();
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !settingsMask.hidden) closeSettings();
});

recursiveCheckbox.addEventListener('change', () => {
  settings.recursive = recursiveCheckbox.checked;
  persistSettings();
  if (sourceInput.value.trim()) void scanArchives({ log: false });
});

separateDirsCheckbox.addEventListener('change', () => {
  settings.separateDirs = separateDirsCheckbox.checked;
  persistSettings();
  refreshOutputDirs();
});

nestedFileThresholdInput.addEventListener('change', () => {
  settings.nestedFileThreshold = clampNestedFileThreshold(nestedFileThresholdInput.value);
  nestedFileThresholdInput.value = String(settings.nestedFileThreshold);
  persistSettings();
});

renameDisguisedCheckbox.addEventListener('change', () => {
  settings.renameDisguised = renameDisguisedCheckbox.checked;
  persistSettings();
});

renameExtensionInput.addEventListener('input', () => {
  settings.renameExtension = normalizeRenameExtension(renameExtensionInput.value);
  persistSettings();
});

renameExtensionInput.addEventListener('blur', () => {
  renameExtensionInput.value = normalizeRenameExtension(renameExtensionInput.value);
});

deleteAfterExtractCheckbox.addEventListener('change', () => {
  settings.deleteAfterExtract = deleteAfterExtractCheckbox.checked;
  persistSettings();
});

verifyWith7zCheckbox.addEventListener('change', () => {
  settings.verifyWith7z = verifyWith7zCheckbox.checked;
  persistSettings();
  if (sourceInput.value.trim()) void scanArchives({ log: false });
});

sevenZipInput.addEventListener('input', () => {
  settings.sevenZipPath = sevenZipInput.value.trim();
  persistSettings();
  updateSevenZipHint();
});

sevenZipBrowseButton.addEventListener('click', async () => {
  const executable = await window.api.selectSevenZip();
  if (!executable) return;

  sevenZipInput.value = executable;
  settings.sevenZipPath = executable;
  persistSettings();
  updateSevenZipHint();
});

addExtensionButton.addEventListener('click', () => {
  addExtensionToList(newExtensionInput.value);
});

newExtensionInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    addExtensionToList(newExtensionInput.value);
  }
});

function addExtensionToList(value: string): void {
  const extension = normalizeExtension(value);
  if (!extension) {
    appendLog('warning', '请输入要添加的文件后缀。');
    return;
  }

  if (!/^[a-z0-9]+$/i.test(extension)) {
    appendLog('warning', '后缀只能包含字母或数字。');
    return;
  }

  if (extensionItems.some((item) => normalizeExtension(item.value) === extension)) {
    appendLog('warning', `.${extension} 已经在列表中。`);
    return;
  }

  extensionItems.push({ id: createId(), value: extension });
  persistExtensionItems();
  renderExtensionList();
  newExtensionInput.value = '';
  newExtensionInput.focus();
  appendLog('success', `已添加伪装后缀：.${extension}`);
}

extensionList.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const button = target.closest<HTMLButtonElement>('button[data-extension-action]');
  if (!button) return;

  const tag = button.closest<HTMLElement>('[data-id]');
  if (!tag?.dataset.id) return;

  if (button.dataset.extensionAction === 'remove') {
    const id = tag.dataset.id;
    extensionItems = extensionItems.filter((item) => item.id !== id);
    persistExtensionItems();
    renderExtensionList();
  }
});

/* ---------------- 初始化 ---------------- */

async function init(): Promise<void> {
  let detected: string | null = null;
  try {
    const defaults = await window.api.getDefaults();
    detected = defaults.sevenZipPath;
  } catch (error) {
    appendLog('error', `初始化失败：${error instanceof Error ? error.message : String(error)}`);
  }

  if (settings.sevenZipPath) {
    sevenZipInput.value = settings.sevenZipPath;
    sevenZipHint.textContent = '将使用上方路径中的 7z.exe。';
    sevenZipHint.className = 'hint ok';
  } else if (detected) {
    settings.sevenZipPath = detected;
    sevenZipInput.value = detected;
    persistSettings();
    sevenZipHint.textContent = `已找到：${detected}`;
    sevenZipHint.className = 'hint ok';
  } else {
    sevenZipHint.textContent = '未自动检测到 7-Zip，请在设置里手动选择 7z.exe。';
    sevenZipHint.className = 'hint bad';
  }

  applySettingsToUi();
  updateSevenZipHint();

  // 记住上次的文件夹，启动时自动带入并扫描
  if (settings.sourceFolder) {
    appendLog('info', `已恢复上次的文件夹：${settings.sourceFolder}`);
    await scanArchives({ log: false });
  }
}

function setupScanProgress(): void {
  window.api.onScanProgress((progress) => {
    if (!scanning) return;
    if (progress.phase === 'verify' && progress.total > 0) {
      scanProgressLabel = `7-Zip 校验中 ${progress.done}/${progress.total}：${progress.current}`;
    } else {
      scanProgressLabel = `正在扫描：${progress.current}`;
    }
    updateSummary();
  });
}

function setupExtractProgress(): void {
  window.api.onExtractProgress((progress) => {
    if (!runningPercents.has(progress.id)) return; // 已结束的任务忽略迟到的进度

    const item = findItem(progress.id);
    if (!item) return;

    item.percent = progress.percent;
    runningPercents.set(progress.id, progress.percent);
    updateRow(item);
    updateBatchProgress();
  });
}

/**
 * 导入随包附带的个人配置（`personal-settings.json`，私密版专用）。
 *
 * 只在「本机还没有这条记录」时导入 —— 也就是首次运行。用户之后在界面里改过的东西
 * 一律以本机为准，不会被这个文件覆盖（换机器/重装时又能一键恢复成你熟悉的样子）。
 */
async function importPersonalConfig(): Promise<void> {
  let personal: Awaited<ReturnType<typeof window.api.readPersonalConfig>> = null;
  try {
    personal = await window.api.readPersonalConfig();
  } catch (error) {
    console.warn('读取个人配置失败', error);
    return;
  }
  if (!personal) return;

  const applied: string[] = [];

  if (personal.settings && !window.localStorage.getItem(SETTINGS_KEY)) {
    settings = { ...settings, ...personal.settings };
    settings.nestedFileThreshold = clampNestedFileThreshold(settings.nestedFileThreshold);
    settings.renameExtension = normalizeRenameExtension(settings.renameExtension);
    persistSettings();
    applied.push('设置');
  }

  if (personal.passwords && personal.passwords.length > 0 && !window.localStorage.getItem(PASSWORD_LIST_KEY)) {
    const imported = personal.passwords
      .filter((entry) => typeof entry?.value === 'string' && entry.value.trim().length > 0)
      .map((entry) => ({
        id: createId(),
        value: (entry.value ?? '').trim(),
        prefix: typeof entry.prefix === 'string' ? entry.prefix.trim() : '',
      }));
    if (imported.length > 0) {
      passwordItems = imported;
      persistPasswordItems();
      applied.push(`${imported.length} 条候选密码`);
    }
  }

  if (
    personal.disguisedExtensions &&
    personal.disguisedExtensions.length > 0 &&
    !window.localStorage.getItem(EXTENSION_LIST_KEY)
  ) {
    const imported = personal.disguisedExtensions
      .filter((value) => typeof value === 'string' && normalizeExtension(value).length > 0)
      .map((value) => ({ id: createId(), value: normalizeExtension(value) }));
    if (imported.length > 0) {
      extensionItems = imported;
      persistExtensionItems();
      applied.push(`${imported.length} 个伪装后缀`);
    }
  }

  if (applied.length > 0) {
    appendLog('info', `已导入个人配置：${applied.join('、')}。`);
  }
}

applySettingsToUi();
applyPasswordDraft();
// 启动即落盘一次，保证候选密码这条记录真实存在（也便于及早暴露本地存储异常）
persistPasswordItems();
renderRows();
renderPasswordList();
renderExtensionList();
setupScanProgress();
setupExtractProgress();

// 个人配置要在 init（自动恢复上次文件夹并扫描）之前导入，否则会用不到导入的结果
void (async () => {
  try {
    await importPersonalConfig();
  } catch (error) {
    console.warn('导入个人配置时出错', error);
  }
  applySettingsToUi();
  renderPasswordList();
  renderExtensionList();
  await init();
})();

export {};
