import { webBasePath, webRoute } from "./connection-path";
import { workspaceUploadText } from "./i18n";
import { UiError } from "./ui-text";

export const MAX_WORKSPACE_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_WORKSPACE_UPLOAD_FILES = 5;

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
  status: "waiting" | "uploading" | "saved";
  percent?: number;
  relativePath?: string;
};

type PrepareUpload = {
  uploadId: string;
  url: string;
  relativePath: string;
  maxBytes: number;
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
  const validUploadPath = /^api\/uploads\/[0-9a-f-]{36}$/i.test(relativePath);
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

function validatePrepareResponse(value: unknown, file: File): PrepareUpload {
  if (typeof value !== "object" || value === null) throw invalidUploadResponse();
  const result = value as Partial<PrepareUpload>;
  if (
    typeof result.uploadId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result.uploadId) ||
    result.url !== `/api/uploads/${result.uploadId}` ||
    !safeRelativePath(result.relativePath) ||
    !Number.isSafeInteger(result.maxBytes) ||
    (result.maxBytes ?? 0) < 0 ||
    file.size > Math.min(MAX_WORKSPACE_UPLOAD_BYTES, result.maxBytes ?? 0)
  ) {
    if (file.size > MAX_WORKSPACE_UPLOAD_BYTES) {
      throw new UiError(workspaceUploadText("sizeLimit"));
    }
    if (typeof result.maxBytes === "number" && file.size > result.maxBytes) {
      throw new UiError("File exceeds the server's upload size limit");
    }
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

function abortError(): DOMException {
  return new DOMException(workspaceUploadText("cancelledRetry"), "AbortError");
}

function putFile(
  file: File,
  url: string,
  uploadId: string,
  relativePath: string,
  signal: AbortSignal,
  onProgress: (percent: number) => void,
  xhrFactory: () => XMLHttpRequest,
): Promise<UploadReceipt> {
  return new Promise((resolve, reject) => {
    const xhr = xhrFactory();
    let settled = false;
    const finish = (error?: Error, receipt?: UploadReceipt) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else if (receipt) resolve(receipt);
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
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.min(100, Math.floor((event.loaded / event.total) * 100)));
      }
    };
    xhr.onerror = () => finish(new UiError(workspaceUploadText("uploadFailedRetry")));
    xhr.onabort = () => finish(abortError());
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        finish(new UiError(workspaceUploadText("uploadFailedRetry")));
        return;
      }
      let response: unknown;
      try {
        response = JSON.parse(xhr.responseText);
      } catch {
        finish(invalidUploadResponse());
        return;
      }
      if (!isUploadReceipt(response, { uploadId, relativePath } as PrepareUpload, file)) {
        finish(invalidUploadResponse());
        return;
      }
      onProgress(100);
      finish(undefined, response);
    };
    try {
      xhr.send(file);
    } catch {
      finish(new UiError(workspaceUploadText("uploadFailedRetry")));
    }
  });
}

/** Prepare and PUT files one at a time; only opaque server receipts are returned for the prompt request. */
export async function uploadWorkspaceFiles(files: UploadFile[], options: UploadOptions): Promise<UploadReceipt[]> {
  if (files.length > MAX_WORKSPACE_UPLOAD_FILES) {
    throw new UiError(workspaceUploadText("filesLimit"));
  }
  if (options.pathname !== options.scope.generation) {
    throw new UiError(workspaceUploadText("sessionChangedRetry"));
  }
  const receipts: UploadReceipt[] = [];
  const xhrFactory = options.xhrFactory ?? (() => new XMLHttpRequest());

  for (const { id, file } of files) {
    if (options.signal.aborted) throw abortError();
    if (options.isCurrent && !options.isCurrent()) {
      throw new UiError(workspaceUploadText("sessionChangedRetry"));
    }
    if (file.size > MAX_WORKSPACE_UPLOAD_BYTES) {
      throw new UiError(workspaceUploadText("sizeLimit"));
    }
    const prepared = validatePrepareResponse(
      await options.send("prepare_upload", {
        filename: file.name,
        size: file.size,
        sessionId: options.scope.sessionId,
        runtimeId: options.scope.runtimeId,
      }),
      file,
    );
    if (options.signal.aborted) throw abortError();
    if (options.isCurrent && !options.isCurrent()) {
      throw new UiError(workspaceUploadText("sessionChangedRetry"));
    }
    const url = workspaceUploadUrl(prepared.url, options.origin, options.pathname);
    options.onProgress?.({ id, filename: file.name, status: "uploading", percent: 0 });
    const receipt = await putFile(
      file,
      url,
      prepared.uploadId,
      prepared.relativePath,
      options.signal,
      (percent) => options.onProgress?.({ id, filename: file.name, status: "uploading", percent }),
      xhrFactory,
    );
    if (options.isCurrent && !options.isCurrent()) {
      throw new UiError(workspaceUploadText("sessionChangedRetry"));
    }
    receipts.push(receipt);
    options.onReceipt?.(id, receipt);
    options.onProgress?.({
      id,
      filename: file.name,
      status: "saved",
      percent: 100,
      relativePath: receipt.relativePath,
    });
  }
  return receipts;
}
