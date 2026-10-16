import { useCallback, useEffect, useRef, useState } from "react";

export const WHALE_ASSET_SLOTS = ["idle", "thinking", "tool", "success", "pat"] as const;
export type WhaleAssetSlot = (typeof WHALE_ASSET_SLOTS)[number];
export type WhaleAssetErrorCode =
  | "unsupported-file"
  | "file-too-large"
  | "invalid-signature"
  | "mime-mismatch"
  | "invalid-dimensions"
  | "decoder-unavailable"
  | "decode-failed"
  | "read-unavailable"
  | "persistence-unavailable"
  | "clear-unavailable";
export type WhaleAssetsState = {
  images: Partial<Record<WhaleAssetSlot, string>>;
  previewImages: Partial<Record<WhaleAssetSlot, string>>;
  importAsset: (slot: WhaleAssetSlot, file: File) => Promise<void>;
  clearAssets: () => Promise<void>;
  busy: boolean;
  error: string | null;
  persistent: boolean;
  temporarySlots: WhaleAssetSlot[];
};

const DATABASE_NAME = "pi-web-ui-whale-assets";
const DATABASE_VERSION = 1;
const STORE_NAME = "assets";
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 2048;
const OPERATION_TIMEOUT_MS = 3000;

type AssetState = Partial<Record<WhaleAssetSlot, string>>;
type AssetBlobs = Partial<Record<WhaleAssetSlot, Blob>>;
type AssetUrls = { originals: AssetState; previews: AssetState };
const emptyUrls = (): AssetUrls => ({ originals: {}, previews: {} });

function releaseUrls(urls: AssetUrls): void {
  for (const url of [...Object.values(urls.originals), ...Object.values(urls.previews)]) {
    if (url) URL.revokeObjectURL(url);
  }
}

function createAssetUrls(original: Blob, preview: Blob): { original: string; preview: string } {
  const originalUrl = URL.createObjectURL(original);
  try {
    return { original: originalUrl, preview: URL.createObjectURL(preview) };
  } catch (error) {
    URL.revokeObjectURL(originalUrl);
    throw error;
  }
}

class WhaleAssetFailure extends Error {
  readonly code: WhaleAssetErrorCode;

  constructor(code: WhaleAssetErrorCode) {
    super(code);
    this.name = "WhaleAssetFailure";
    this.code = code;
  }
}

/** Signature checks inspect the file bytes, not a filename or a declared media type. */
export function isPngSignature(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  );
}

export function isWebpSignature(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  );
}

/** GIF87a/GIF89a only; the filename and media type do not establish format. */
export function isGifSignature(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  );
}

export function useWhaleAssets(reduceMotion = false): WhaleAssetsState {
  const [urls, setUrls] = useState<AssetUrls>(emptyUrls);
  const [systemReduced, setSystemReduced] = useState(
    () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true,
  );
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setSystemReduced(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [persistent, setPersistent] = useState(false);
  const [temporarySlots, setTemporarySlots] = useState<WhaleAssetSlot[]>([]);
  const temporaryRef = useRef(new Set<WhaleAssetSlot>());
  const activeRef = useRef(true);
  const revisionRef = useRef(0);
  const urlsRef = useRef<AssetUrls>(emptyUrls());
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingRef = useRef(1); // The initial IndexedDB read is also busy work.

  const beginWork = useCallback(() => {
    pendingRef.current++;
    if (activeRef.current) setBusy(true);
  }, []);
  const endWork = useCallback(() => {
    pendingRef.current = Math.max(0, pendingRef.current - 1);
    if (activeRef.current) setBusy(pendingRef.current > 0);
  }, []);
  const restoreAssets = useCallback(async (revision: number, preserveError = false) => {
    try {
      const blobs = await readAssets();
      const nextUrls = emptyUrls();
      try {
        for (const slot of WHALE_ASSET_SLOTS) {
          const blob = blobs[slot];
          if (!blob) continue;
          let validated: Awaited<ReturnType<typeof validateWhaleImage>>;
          try {
            validated = await validateWhaleImage(blob);
          } catch {
            continue; // Invalid stored data is never rendered as an image.
          }
          const pair = createAssetUrls(new Blob([blob], { type: validated.mimeType }), validated.preview);
          nextUrls.originals[slot] = pair.original;
          nextUrls.previews[slot] = pair.preview;
        }
      } catch {
        releaseUrls(nextUrls);
        throw new WhaleAssetFailure("read-unavailable");
      }
      if (!activeRef.current || revision !== revisionRef.current) {
        releaseUrls(nextUrls);
        return;
      }
      releaseUrls(urlsRef.current);
      urlsRef.current = nextUrls;
      setUrls(nextUrls);
      setPersistent(true);
      if (!preserveError) setError(null);
    } catch {
      if (activeRef.current && revision === revisionRef.current) {
        setPersistent(false);
        if (!preserveError) setError("read-unavailable");
      }
    }
  }, []);

  useEffect(() => {
    activeRef.current = true;
    let cancelled = false;
    const revision = revisionRef.current;
    const load = async () => {
      try {
        await restoreAssets(revision);
      } finally {
        if (!cancelled) endWork();
      }
    };
    // Hydration is the first serialized operation: imports must retain all other saved slots.
    queueRef.current = load();
    return () => {
      cancelled = true;
      activeRef.current = false;
      releaseUrls(urlsRef.current);
      urlsRef.current = emptyUrls();
    };
  }, [endWork, restoreAssets]);

  const importAsset = useCallback(
    (slot: WhaleAssetSlot, file: File): Promise<void> => {
      beginWork();
      const task = queueRef.current.then(async () => {
        if (!activeRef.current) {
          endWork();
          return;
        }
        const revision = ++revisionRef.current;
        try {
          if (!WHALE_ASSET_SLOTS.includes(slot)) throw new WhaleAssetFailure("unsupported-file");
          const { mimeType, preview } = await validateWhaleImage(file);
          const blob = new Blob([file], { type: mimeType });
          let saved = false;
          try {
            await writeAsset(slot, blob);
            saved = true;
          } catch {
            // Keep the validated Blob usable for this page, but surface that it will not survive reload.
          }
          if (!activeRef.current) return;
          const pair = createAssetUrls(blob, preview);
          const previous = urlsRef.current;
          if (previous.originals[slot]) URL.revokeObjectURL(previous.originals[slot]);
          if (previous.previews[slot]) URL.revokeObjectURL(previous.previews[slot]);
          const next = {
            originals: { ...previous.originals, [slot]: pair.original },
            previews: { ...previous.previews, [slot]: pair.preview },
          };
          urlsRef.current = next;
          setUrls(next);
          if (saved) temporaryRef.current.delete(slot);
          else temporaryRef.current.add(slot);
          setTemporarySlots([...temporaryRef.current]);
          const allSaved = temporaryRef.current.size === 0;
          setPersistent(allSaved);
          setError(allSaved ? null : "persistence-unavailable");
        } catch (cause) {
          if (activeRef.current) {
            const code = toErrorCode(cause, "decode-failed");
            setError(code);
            if (revision === revisionRef.current && Object.keys(urlsRef.current.originals).length === 0) {
              await restoreAssets(revision, true);
            }
          }
          throw new WhaleAssetFailure(toErrorCode(cause, "decode-failed"));
        } finally {
          endWork();
        }
      });
      queueRef.current = task.catch(() => undefined);
      return task;
    },
    [beginWork, endWork, restoreAssets],
  );

  const clearAssets = useCallback((): Promise<void> => {
    beginWork();
    const task = queueRef.current.then(async () => {
      if (!activeRef.current) {
        endWork();
        return;
      }
      revisionRef.current++;
      temporaryRef.current.clear();
      setTemporarySlots([]);
      try {
        if (activeRef.current) {
          releaseUrls(urlsRef.current);
          urlsRef.current = emptyUrls();
          setUrls(emptyUrls());
        }
        try {
          await deleteAssets();
          if (activeRef.current) {
            setPersistent(true);
            setError(null);
          }
        } catch {
          if (activeRef.current) {
            setPersistent(false);
            setError("clear-unavailable");
          }
        }
      } finally {
        endWork();
      }
    });
    queueRef.current = task.catch(() => undefined);
    return task;
  }, [beginWork, endWork]);

  return {
    images: reduceMotion || systemReduced ? urls.previews : urls.originals,
    previewImages: urls.previews,
    importAsset,
    clearAssets,
    busy,
    error,
    persistent,
    temporarySlots,
  };
}

function toErrorCode(cause: unknown, fallback: WhaleAssetErrorCode): WhaleAssetErrorCode {
  return cause instanceof WhaleAssetFailure ? cause.code : fallback;
}

export async function validateWhaleImage(file: Blob): Promise<{
  mimeType: "image/png" | "image/webp" | "image/gif";
  preview: Blob;
}> {
  if (typeof file.size !== "number" || file.size <= 0 || file.size > MAX_FILE_BYTES) {
    throw new WhaleAssetFailure(file.size > MAX_FILE_BYTES ? "file-too-large" : "unsupported-file");
  }
  if (file.type !== "" && !["image/png", "image/webp", "image/gif"].includes(file.type)) {
    throw new WhaleAssetFailure("unsupported-file");
  }

  let signature: Uint8Array;
  try {
    signature = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  } catch {
    throw new WhaleAssetFailure("invalid-signature");
  }
  const isPng = isPngSignature(signature);
  const isWebp = isWebpSignature(signature);
  const isGif = isGifSignature(signature);
  if (!isPng && !isWebp && !isGif) throw new WhaleAssetFailure("invalid-signature");
  const mimeType = isPng ? "image/png" : isWebp ? "image/webp" : "image/gif";
  if (file.type && file.type !== mimeType) throw new WhaleAssetFailure("mime-mismatch");
  // Reject oversized GIF logical screens before asking the browser to decode.
  if (isGif) {
    if (signature.length < 10) throw new WhaleAssetFailure("invalid-signature");
    const width = signature[6] | (signature[7] << 8);
    const height = signature[8] | (signature[9] << 8);
    if (!width || !height || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION)
      throw new WhaleAssetFailure("invalid-dimensions");
  }
  const preview = await decodeStillPreview(file);
  return { mimeType, preview };
}

async function decodeStillPreview(blob: Blob): Promise<Blob> {
  if (typeof globalThis.createImageBitmap !== "function") throw new WhaleAssetFailure("decoder-unavailable");
  let bitmap: ImageBitmap;
  try {
    bitmap = await new Promise<ImageBitmap>((resolve, reject) => {
      let settled = false;
      const timer = globalThis.setTimeout(() => {
        settled = true;
        reject(new WhaleAssetFailure("decode-failed"));
      }, OPERATION_TIMEOUT_MS);
      Promise.resolve()
        .then(() => globalThis.createImageBitmap(blob))
        .then(
          (decoded) => {
            if (settled) {
              decoded.close();
              return;
            }
            settled = true;
            globalThis.clearTimeout(timer);
            resolve(decoded);
          },
          () => {
            if (settled) return;
            settled = true;
            globalThis.clearTimeout(timer);
            reject(new WhaleAssetFailure("decode-failed"));
          },
        );
    });
  } catch {
    throw new WhaleAssetFailure("decode-failed");
  }
  try {
    if (
      bitmap.width <= 0 ||
      bitmap.height <= 0 ||
      bitmap.width > MAX_IMAGE_DIMENSION ||
      bitmap.height > MAX_IMAGE_DIMENSION
    ) {
      throw new WhaleAssetFailure("invalid-dimensions");
    }
    // createImageBitmap decodes the first frame, not a re-encoded animated file.
    // Keep the original separately; this small PNG is for reduced motion and
    // always-still settings thumbnails (CSS cannot pause an animated <img>).
    const scale = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new WhaleAssetFailure("decoder-unavailable");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => {
      const timer = globalThis.setTimeout(() => reject(new WhaleAssetFailure("decode-failed")), OPERATION_TIMEOUT_MS);
      try {
        canvas.toBlob((preview) => {
          globalThis.clearTimeout(timer);
          if (preview && preview.type === "image/png") resolve(preview);
          else reject(new WhaleAssetFailure("decode-failed"));
        }, "image/png");
      } catch {
        globalThis.clearTimeout(timer);
        reject(new WhaleAssetFailure("decode-failed"));
      }
    });
  } finally {
    bitmap.close();
  }
}

function readAssets(): Promise<AssetBlobs> {
  const deadline = Date.now() + OPERATION_TIMEOUT_MS;
  return withDatabase(
    deadline,
    (database) =>
      runTransaction(
        database,
        "readonly",
        deadline,
        (store, setResult) => {
          const result: AssetBlobs = {};
          let pending = WHALE_ASSET_SLOTS.length;
          for (const slot of WHALE_ASSET_SLOTS) {
            const request = store.get(slot);
            request.onsuccess = () => {
              const value: unknown = request.result;
              if (value instanceof Blob) result[slot] = value;
              pending--;
              if (pending === 0) setResult(result);
            };
          }
        },
        "read-unavailable",
      ),
    "read-unavailable",
  );
}

function writeAsset(slot: WhaleAssetSlot, file: Blob): Promise<void> {
  const deadline = Date.now() + OPERATION_TIMEOUT_MS;
  return withDatabase(
    deadline,
    (database) =>
      runTransaction(database, "readwrite", deadline, (store) => {
        store.put(file, slot);
      }),
    "persistence-unavailable",
  );
}

function deleteAssets(): Promise<void> {
  const deadline = Date.now() + OPERATION_TIMEOUT_MS;
  return withDatabase(
    deadline,
    (database) =>
      runTransaction(database, "readwrite", deadline, (store) => {
        store.clear();
      }),
    "clear-unavailable",
  );
}

function withDatabase<T>(
  deadline: number,
  operation: (database: IDBDatabase) => Promise<T>,
  failureCode: WhaleAssetErrorCode,
): Promise<T> {
  return openDatabase(deadline, failureCode).then(async (database) => {
    try {
      return await operation(database);
    } finally {
      database.close();
    }
  });
}

function openDatabase(deadline: number, failureCode: WhaleAssetErrorCode): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new WhaleAssetFailure(failureCode));
      return;
    }
    let settled = false;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      reject(new WhaleAssetFailure(failureCode));
      return;
    }
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    const timer = window.setTimeout(() => fail(failureCode), remaining);
    const fail = (code: WhaleAssetErrorCode) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      reject(new WhaleAssetFailure(code));
    };
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => {
      const database = request.result;
      if (settled) {
        database.close();
        return;
      }
      settled = true;
      window.clearTimeout(timer);
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => fail(failureCode);
    request.onblocked = () => fail(failureCode);
  });
}

function runTransaction<T>(
  database: IDBDatabase,
  mode: IDBTransactionMode,
  deadline: number,
  setup: (store: IDBObjectStore, setResult: (value: T) => void) => void,
  failureCode: WhaleAssetErrorCode = "persistence-unavailable",
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let result = undefined as T;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      database.close();
      reject(new WhaleAssetFailure(failureCode));
      return;
    }
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(STORE_NAME, mode);
    } catch {
      database.close();
      reject(new WhaleAssetFailure(failureCode));
      return;
    }
    const timer = window.setTimeout(() => {
      fail(failureCode);
      try {
        transaction.abort();
      } catch {
        // It may already be inactive; the connection is closed below regardless.
      }
      database.close();
    }, remaining);
    const fail = (code: WhaleAssetErrorCode) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      database.close();
      reject(new WhaleAssetFailure(code));
    };
    transaction.oncomplete = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(result);
    };
    transaction.onerror = () => fail(failureCode);
    transaction.onabort = () => fail(failureCode);
    try {
      setup(transaction.objectStore(STORE_NAME), (value) => {
        result = value;
      });
    } catch {
      fail(failureCode);
      try {
        transaction.abort();
      } catch {
        // Ignore an already completed transaction.
      }
    }
  });
}
