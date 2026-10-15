import { webBasePath, webRoute } from "./connection-path";
import { workspaceUploadText } from "./i18n";
import { IncrementalSha256 } from "./incremental-sha256";
import { UiError } from "./ui-text";

/** Keep protocol 1's limit stable; protocol 2 is capped independently by the client. */
export const MAX_WORKSPACE_UPLOAD_BYTES = 8 * 1024 * 1024 * 1024;
export const MAX_WORKSPACE_UPLOAD_FILES = 5;
export const WORKSPACE_UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024;
const HASH_SLICE_SIZE = 256 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type UploadScope = {
  sessionId: string;
  runtimeId: string;
  /** Exact current page path, used as a client-side generation fence. */
  generation: string;
};
type UploadFile = { id: string; file: File };
export type WorkspaceUploadProgress = {
  id: string;
  filename: string;
  status: "waiting" | "hashing" | "uploading" | "finalizing" | "saved";
  percent?: number;
  relativePath?: string;
};
type PrepareUpload = {
  protocol: 2;
  uploadId: string;
  url: string;
  relativePath: string;
  maxBytes: number;
  chunkSize: number;
  nextChunk: number;
  complete: boolean;
};
export type WorkspaceUploadReceipt = {
  uploadId: string;
  relativePath: string;
  filename: string;
  size: number;
};
type UploadReceipt = WorkspaceUploadReceipt;
type UploadOptions = {
  scope: UploadScope;
  origin: string;
  pathname: string;
  signal: AbortSignal;
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  xhrFactory?: () => XMLHttpRequest;
  onProgress?: (progress: WorkspaceUploadProgress) => void;
  isCurrent?: () => boolean;
  onReceipt?: (id: string, receipt: WorkspaceUploadReceipt) => void;
};

type FileHashes = { sha256: string; chunkHashes: string[] };

function invalidUploadResponse(): UiError {
  return new UiError(workspaceUploadText("invalidResponse"));
}
function safeRelativePath(path: unknown): path is string {
  if (
    typeof path !== "string" ||
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    Array.from(path).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    return false;
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/** Resolve a server route under this Pi page's root, including /s/<generation>/ and reverse-proxy prefixes. */
export function workspaceUploadUrl(url: string, origin: string, pathname: string): string {
  let route: string;
  try {
    route = webRoute(url, pathname);
  } catch {
    throw new UiError(workspaceUploadText("sameOriginRoute"));
  }
  const resolved = new URL(route, origin);
  const basePath = webBasePath(pathname);
  const sessionPrefix = pathname.match(/^(\/s\/[a-f0-9]{32}\/)/i)?.[1];
  const relativePath = resolved.pathname.startsWith(basePath) ? resolved.pathname.slice(basePath.length) : "";
  const validUploadPath =
    /^api\/uploads\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(relativePath);
  if (
    resolved.origin !== new URL(origin).origin ||
    resolved.pathname !== route ||
    resolved.search ||
    resolved.hash ||
    !validUploadPath ||
    (sessionPrefix && !resolved.pathname.startsWith(sessionPrefix))
  ) {
    throw new UiError(workspaceUploadText("sameOriginRoute"));
  }
  return resolved.href;
}

function validatePrepareResponse(value: unknown, file: File, scope: UploadScope): PrepareUpload {
  if (typeof value !== "object" || value === null) throw invalidUploadResponse();
  const result = value as Partial<PrepareUpload>;
  if (
    result.protocol !== 2 ||
    typeof result.uploadId !== "string" ||
    !UUID_PATTERN.test(result.uploadId) ||
    result.url !== `/api/uploads/${result.uploadId}` ||
    !safeRelativePath(result.relativePath) ||
    result.relativePath !== `.pi-uploads/${scope.sessionId}/${result.uploadId}/${file.name}` ||
    !Number.isSafeInteger(result.maxBytes) ||
    (result.maxBytes ?? 0) <= 0 ||
    (result.maxBytes ?? 0) > MAX_WORKSPACE_UPLOAD_BYTES ||
    result.chunkSize !== WORKSPACE_UPLOAD_CHUNK_SIZE ||
    !Number.isSafeInteger(result.nextChunk) ||
    (result.nextChunk ?? -1) < 0 ||
    (result.nextChunk ?? Number.MAX_SAFE_INTEGER) > Math.ceil(file.size / WORKSPACE_UPLOAD_CHUNK_SIZE) ||
    typeof result.complete !== "boolean" ||
    file.size > Math.min(MAX_WORKSPACE_UPLOAD_BYTES, result.maxBytes ?? 0)
  ) {
    if (file.size > MAX_WORKSPACE_UPLOAD_BYTES) throw new UiError(workspaceUploadText("sizeLimit"));
    if (typeof result.maxBytes === "number" && file.size > result.maxBytes)
      throw new UiError("File exceeds the server's upload size limit");
    throw invalidUploadResponse();
  }
  if (result.complete && result.nextChunk !== Math.ceil(file.size / WORKSPACE_UPLOAD_CHUNK_SIZE)) {
    throw invalidUploadResponse();
  }
  return result as PrepareUpload;
}

function isUploadReceipt(value: unknown, prepared: PrepareUpload, file: File): value is UploadReceipt {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Partial<UploadReceipt>;
  return (
    result.uploadId === prepared.uploadId &&
    result.relativePath === prepared.relativePath &&
    result.filename === file.name &&
    result.size === file.size
  );
}
function isChunkAck(
  value: unknown,
  uploadId: string,
  nextChunk: number,
): value is { uploadId: string; nextChunk: number } {
  if (typeof value !== "object" || value === null) return false;
  const result = value as { uploadId?: unknown; nextChunk?: unknown };
  return result.uploadId === uploadId && result.nextChunk === nextChunk;
}
function abortError(): DOMException {
  return new DOMException(workspaceUploadText("cancelledRetry"), "AbortError");
}
function checkScope(options: UploadOptions): void {
  if (options.signal.aborted) throw abortError();
  if (options.isCurrent && !options.isCurrent()) throw new UiError(workspaceUploadText("sessionChangedRetry"));
}

/** Race slow RPCs/file reads with cancellation; caller rechecks scope immediately after every await. */
function awaitAbortable<T>(operation: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, value?: T) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (error !== undefined) reject(error);
      else resolve(value as T);
    };
    const onAbort = () => finish(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(operation).then(
      (value) => finish(undefined, value),
      (error) => finish(error),
    );
  });
}

function yieldToBrowser(options: UploadOptions): Promise<void> {
  checkScope(options);
  return awaitAbortable(new Promise<void>((resolve) => setTimeout(resolve, 0)), options.signal).then(() => {
    checkScope(options);
  });
}

/** Hash 256 KiB file slices so even multi-gigabyte selections never require a whole-file buffer. */
async function hashFile(file: File, options: UploadOptions, id: string): Promise<FileHashes> {
  const fullHash = new IncrementalSha256();
  const chunkHashes: string[] = [];
  const chunks = Math.ceil(file.size / WORKSPACE_UPLOAD_CHUNK_SIZE);
  for (let chunkIndex = 0; chunkIndex < chunks; chunkIndex++) {
    checkScope(options);
    const chunkStart = chunkIndex * WORKSPACE_UPLOAD_CHUNK_SIZE;
    const chunkEnd = Math.min(file.size, chunkStart + WORKSPACE_UPLOAD_CHUNK_SIZE);
    const chunkHash = new IncrementalSha256();
    for (let offset = chunkStart; offset < chunkEnd; offset += HASH_SLICE_SIZE) {
      checkScope(options);
      const slice = file.slice(offset, Math.min(chunkEnd, offset + HASH_SLICE_SIZE));
      const buffer = await awaitAbortable(slice.arrayBuffer(), options.signal);
      checkScope(options);
      const bytes = new Uint8Array(buffer);
      fullHash.update(bytes);
      chunkHash.update(bytes);
      const percent = file.size === 0 ? 100 : Math.floor(((offset + bytes.length) / file.size) * 100);
      options.onProgress?.({ id, filename: file.name, status: "hashing", percent: Math.min(100, percent) });
      if (offset + bytes.length < file.size) await yieldToBrowser(options);
    }
    chunkHashes.push(chunkHash.digest());
  }
  return { sha256: fullHash.digest(), chunkHashes };
}

function putChunk(
  body: Blob,
  url: string,
  uploadId: string,
  index: number,
  signal: AbortSignal,
  confirmedBytes: number,
  totalBytes: number,
  onProgress: (percent: number) => void,
  xhrFactory: () => XMLHttpRequest,
): Promise<{ uploadId: string; nextChunk: number }> {
  return new Promise((resolve, reject) => {
    const xhr = xhrFactory();
    let settled = false;
    const finish = (error?: Error, ack?: { uploadId: string; nextChunk: number }) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else if (ack) resolve(ack);
      else reject(invalidUploadResponse());
    };
    const onAbort = () => {
      xhr.abort();
      finish(abortError());
    };
    if (signal.aborted) {
      finish(abortError());
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    onProgress(totalBytes === 0 ? 100 : Math.floor((confirmedBytes / totalBytes) * 100));
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        const completedBytes = confirmedBytes + Math.min(body.size, event.loaded);
        onProgress(totalBytes === 0 ? 100 : Math.min(100, Math.floor((completedBytes / totalBytes) * 100)));
      }
    };
    xhr.onerror = () => finish(new UiError(workspaceUploadText("uploadFailedRetry")));
    xhr.onabort = () => finish(abortError());
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        finish(new UiError(workspaceUploadText("uploadFailedRetry")));
        return;
      }
      try {
        const response: unknown = JSON.parse(xhr.responseText);
        if (isChunkAck(response, uploadId, index + 1)) finish(undefined, response);
        else finish(invalidUploadResponse());
      } catch (error) {
        finish(error instanceof Error ? error : invalidUploadResponse());
      }
    };
    try {
      xhr.send(body);
    } catch {
      finish(new UiError(workspaceUploadText("uploadFailedRetry")));
    }
  });
}

async function sendInScope(options: UploadOptions, method: string, params: Record<string, unknown>): Promise<unknown> {
  checkScope(options);
  const result = await awaitAbortable(options.send(method, params), options.signal);
  checkScope(options);
  return result;
}

/** Hash, resume, then PUT fixed-size raw chunks; only a completed opaque receipt is returned. */
export async function uploadWorkspaceFiles(files: UploadFile[], options: UploadOptions): Promise<UploadReceipt[]> {
  if (files.length > MAX_WORKSPACE_UPLOAD_FILES) throw new UiError(workspaceUploadText("filesLimit"));
  if (options.pathname !== options.scope.generation) throw new UiError(workspaceUploadText("sessionChangedRetry"));
  const receipts: UploadReceipt[] = [];
  const xhrFactory = options.xhrFactory ?? (() => new XMLHttpRequest());

  for (const { id, file } of files) {
    checkScope(options);
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_WORKSPACE_UPLOAD_BYTES)
      throw new UiError(workspaceUploadText("sizeLimit"));
    options.onProgress?.({ id, filename: file.name, status: "hashing", percent: 0 });
    const hashes = await hashFile(file, options, id);
    checkScope(options);
    const prepared = validatePrepareResponse(
      await sendInScope(options, "prepare_upload", {
        protocol: 2,
        filename: file.name,
        size: file.size,
        sha256: hashes.sha256,
        chunkHashes: hashes.chunkHashes,
        sessionId: options.scope.sessionId,
        runtimeId: options.scope.runtimeId,
      }),
      file,
      options.scope,
    );
    checkScope(options);
    const url = workspaceUploadUrl(prepared.url, options.origin, options.pathname);
    let nextChunk = prepared.nextChunk;
    const chunkCount = Math.ceil(file.size / prepared.chunkSize);
    for (; nextChunk < chunkCount; nextChunk++) {
      checkScope(options);
      const start = nextChunk * prepared.chunkSize;
      const end = Math.min(file.size, start + prepared.chunkSize);
      const ack = await putChunk(
        file.slice(start, end),
        `${url}/chunks/${nextChunk}`,
        prepared.uploadId,
        nextChunk,
        options.signal,
        start,
        file.size,
        (percent) => options.onProgress?.({ id, filename: file.name, status: "uploading", percent }),
        xhrFactory,
      );
      checkScope(options);
      if (!isChunkAck(ack, prepared.uploadId, nextChunk + 1)) throw invalidUploadResponse();
      options.onProgress?.({
        id,
        filename: file.name,
        status: "uploading",
        percent:
          file.size === 0
            ? 100
            : Math.floor((Math.min(file.size, (nextChunk + 1) * prepared.chunkSize) / file.size) * 100),
      });
    }
    checkScope(options);
    options.onProgress?.({ id, filename: file.name, status: "finalizing", percent: 100 });
    const receiptValue = await sendInScope(options, "complete_upload", {
      uploadId: prepared.uploadId,
      sessionId: options.scope.sessionId,
      runtimeId: options.scope.runtimeId,
    });
    if (!isUploadReceipt(receiptValue, prepared, file)) throw invalidUploadResponse();
    checkScope(options);
    receipts.push(receiptValue);
    options.onReceipt?.(id, receiptValue);
    options.onProgress?.({
      id,
      filename: file.name,
      status: "saved",
      percent: 100,
      relativePath: receiptValue.relativePath,
    });
  }
  return receipts;
}
