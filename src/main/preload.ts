import { contextBridge, ipcRenderer } from 'electron';
import type {
  ArchiveEntry,
  DefaultsResult,
  ExtractProgress,
  ExtractRequest,
  ExtractResult,
  HoistRequest,
  HoistResult,
  NestedAnalyzeRequest,
  NestedAnalyzeResult,
  OpenPathResult,
  PersonalConfig,
  ScanProgress,
  ScanRequest,
  ScanResult,
} from './types';

export interface ArchiveApi {
  selectFolder: () => Promise<string | null>;
  selectSevenZip: () => Promise<string | null>;
  getDefaults: () => Promise<DefaultsResult>;
  /** 读取随包附带的个人配置（私密版）；公开版返回 null */
  readPersonalConfig: () => Promise<PersonalConfig | null>;
  scanFolder: (request: ScanRequest) => Promise<ScanResult>;
  /** 判断解压出来的东西里还有哪些包需要继续解 */
  analyzeNested: (request: NestedAnalyzeRequest) => Promise<NestedAnalyzeResult>;
  /** 把解到头的成品文件夹搬回源目录，并清掉空目录外壳 */
  hoistFinished: (request: HoistRequest) => Promise<HoistResult>;
  extractArchive: (request: ExtractRequest & { id: string }) => Promise<ExtractResult & { id: string }>;
  openPath: (target: string) => Promise<OpenPathResult>;
  showItemInFolder: (target: string) => Promise<OpenPathResult>;
  onScanProgress: (listener: (progress: ScanProgress) => void) => () => void;
  onExtractProgress: (listener: (progress: ExtractProgress) => void) => () => void;
}

const api: ArchiveApi = {
  selectFolder: () => ipcRenderer.invoke('dialog:select-folder'),
  selectSevenZip: () => ipcRenderer.invoke('dialog:select-7z'),
  getDefaults: () => ipcRenderer.invoke('app:defaults'),
  readPersonalConfig: () => ipcRenderer.invoke('personal-config'),
  scanFolder: (request: ScanRequest) => ipcRenderer.invoke('scan-folder', request),
  analyzeNested: (request: NestedAnalyzeRequest) => ipcRenderer.invoke('analyze-nested', request),
  hoistFinished: (request: HoistRequest) => ipcRenderer.invoke('hoist-finished', request),
  extractArchive: (request) => ipcRenderer.invoke('extract-archive', request),
  openPath: (target) => ipcRenderer.invoke('shell:open-path', target),
  showItemInFolder: (target) => ipcRenderer.invoke('shell:show-item', target),
  onScanProgress: (listener) => {
    const handler = (_event: unknown, progress: ScanProgress) => listener(progress);
    ipcRenderer.on('scan-progress', handler);
    return () => {
      ipcRenderer.removeListener('scan-progress', handler);
    };
  },
  onExtractProgress: (listener) => {
    const handler = (_event: unknown, progress: ExtractProgress) => listener(progress);
    ipcRenderer.on('extract-progress', handler);
    return () => {
      ipcRenderer.removeListener('extract-progress', handler);
    };
  },
};

contextBridge.exposeInMainWorld('api', api);

declare global {
  interface Window {
    api: ArchiveApi;
  }
}

export type { ArchiveEntry };
