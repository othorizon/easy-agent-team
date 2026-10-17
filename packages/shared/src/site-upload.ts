import { prepareSiteUploadSchema, type SiteManifestFile, type SiteUploadStatus, type SitePublishResult } from './site.js';

export interface FolioUploadFile extends SiteManifestFile { bytes: Uint8Array }
export type FolioUploadRequest = (method: string, path: string, body?: unknown) => Promise<unknown>;
export interface FolioUploadOptions {
  requestId: string;
  sessionId?: string;
  message?: string;
  onSession?: (id: string) => void;
  onProgress?: (message: string) => void;
}
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const statusOf = (e: unknown) => (e as { status?: number }).status;
const retryable = (e: unknown) => statusOf(e) === undefined || statusOf(e) === 0 || statusOf(e) === 408 ||
  statusOf(e) === 429 || (statusOf(e) ?? 0) >= 500 || (e as { code?: string }).code === 'UPLOAD_BUSY';
async function retry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let n = 0; ; n++) {
    try { return await fn(); }
    catch (e) {
      if (n + 1 >= attempts || !retryable(e)) throw e;
      await delay(Math.min(5000, 400 * 2 ** n) + Math.random() * 100);
    }
  }
}
export function folioManifestKey(files: SiteManifestFile[]) {
  return JSON.stringify([...files].sort((a, b) => a.path.localeCompare(b.path)).map((f) => [f.path, f.hash, f.size, f.type]));
}
/** Bounded, binary-only transport shared by CLI and browser. OSS signed PUT URLs never reach logs/errors. */
export async function uploadFolioFiles(request: FolioUploadRequest, folio: string, files: FolioUploadFile[], options: FolioUploadOptions): Promise<SitePublishResult> {
  const base = `/api/sites/${encodeURIComponent(folio)}/uploads`;
  const manifest = files.map(({ bytes: _, ...file }) => file);
  const body = prepareSiteUploadSchema.parse({ requestId: options.requestId, files: manifest, message: options.message ?? '' });
  let session: SiteUploadStatus;
  if (options.sessionId) {
    session = await retry(() => request('GET', `${base}/${options.sessionId}`)) as SiteUploadStatus;
    if (folioManifestKey(session.files) !== folioManifestKey(manifest))
      throw new Error('重新选择的内容与上传会话不一致，请选择原文件或开始新的发布');
    if (session.result) return session.result;
    session = await retry(() => request('POST', `${base}/${session.id}/renew`, {})) as SiteUploadStatus;
  } else {
    try { session = await retry(() => request('POST', base, body)) as SiteUploadStatus; }
    catch (e) {
      if (statusOf(e) === 404) await request('GET', `/api/sites/${encodeURIComponent(folio)}`);
      if (statusOf(e) === 404 || statusOf(e) === 405)
        throw new Error('服务端不支持 Folio 二进制上传协议，请升级平台和 eat CLI 后重试');
      throw e;
    }
  }
  options.onSession?.(session.id);
  if (session.result) return session.result;
  if (session.state === 'expired') throw new Error('上传会话已过期，请开始新的发布');
  const unique = new Map(files.map((f) => [f.hash, f]));
  options.onProgress?.(`总文件 ${files.length}，复用内容 ${unique.size - session.uploads.length}，新增上传 ${session.uploads.length}`);
  let renewed: Promise<SiteUploadStatus> | undefined;
  let cursor = 0, done = 0, failed = false;
  const workers = Array.from({ length: Math.min(4, session.uploads.length) }, async () => {
    while (!failed && cursor < session.uploads.length) {
      const original = session.uploads[cursor++];
      const file = unique.get(original.hash);
      if (!file || file.bytes.byteLength !== original.size) throw new Error('本地文件与清单不一致，请重新扫描');
      let target = original;
      try {
        await retry(async () => {
          let response: Response;
          try {
            response = await fetch(target.url, {
              method: 'PUT', headers: target.headers, body: new Blob([file.bytes as Uint8Array<ArrayBuffer>]),
              credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(120_000),
            });
          } catch { throw new Error('OSS 二进制上传失败，请检查网络及 Bucket CORS 后重试'); }
          await response.arrayBuffer(); // Drain the connection; never expose OSS XML or its URL.
          if (!response.ok) {
            if (response.status === 403) {
              renewed ??= retry(() => request('POST', `${base}/${session.id}/renew`, {})) as Promise<SiteUploadStatus>;
              target = (await renewed).uploads.find((u) => u.hash === original.hash) ?? target;
              throw new Error('上传签名已续签，正在重试');
            }
            throw Object.assign(new Error(`OSS 上传失败（HTTP ${response.status}），请重试`), { status: response.status });
          }
        });
        done++;
        options.onProgress?.(`上传 ${done}/${session.uploads.length}，总文件 ${files.length}`);
      } catch (e) { failed = true; throw e; }
    }
  });
  const outcomes = await Promise.allSettled(workers);
  const failure = outcomes.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failure) throw failure.reason;
  options.onProgress?.('正在验证 SHA-256 并发布…');
  return await retry(() => request('POST', `${base}/${session.id}/complete`, {}), 8) as SitePublishResult;
}
