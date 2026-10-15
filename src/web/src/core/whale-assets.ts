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

export function useWhaleAssets(): WhaleAssetsState {
  const [images, setImages] = useState<AssetState>({});
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [persistent, setPersistent] = useState(false);
  const [temporarySlots, setTemporarySlots] = useState<WhaleAssetSlot[]>([]);
  const temporaryRef = useRef(new Set<WhaleAssetSlot>());
  const activeRef = useRef(true);
  const revisionRef = useRef(0);
  const urlsRef = useRef<AssetState>({});
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
      const validated: AssetBlobs = {};
      for (const slot of WHALE_ASSET_SLOTS) {
        const blob = blobs[slot];
        if (blob && (await isValidStoredImage(blob))) validated[slot] = blob;
      }
      if (!activeRef.current || revision !== revisionRef.current) return;
      const nextUrls: AssetState = {};
      try {
        for (const slot of WHALE_ASSET_SLOTS) {
          const blob = validated[slot];
          if (blob) nextUrls[slot] = URL.createObjectURL(blob);
        }
      } catch {
        for (const url of Object.values(nextUrls)) if (url) URL.revokeObjectURL(url);
        throw new WhaleAssetFailure("read-unavailable");
      }
      for (const url of Object.values(urlsRef.current)) if (url) URL.revokeObjectURL(url);
      urlsRef.current = nextUrls;
      setImages(nextUrls);
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
      for (const url of Object.values(urlsRef.current)) if (url) URL.revokeObjectURL(url);
      urlsRef.current = {};
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
          const mimeType = await validateImport(file);
          const blob = new Blob([file], { type: mimeType });
          let saved = false;
          try {
            await writeAsset(slot, blob);
            saved = true;
          } catch {
            // Keep the validated Blob usable for this page, but surface that it will not survive reload.
          }
          if (!activeRef.current) return;
          const url = URL.createObjectURL(blob);
          replaceUrl(slot, url, urlsRef, setImages);
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
            if (revision === revisionRef.current && Object.keys(urlsRef.current).length === 0) {
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
          for (const url of Object.values(urlsRef.current)) if (url) URL.revokeObjectURL(url);
          urlsRef.current = {};
          setImages({});
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

  return { images, importAsset, clearAssets, busy, error, persistent, temporarySlots };
}

function replaceUrl(
  slot: WhaleAssetSlot,
  url: string,
  urlsRef: { current: AssetState },
  setImages: (images: AssetState) => void,
): void {
  const previous = urlsRef.current[slot];
  if (previous) URL.revokeObjectURL(previous);
  const next = { ...urlsRef.current, [slot]: url };
  urlsRef.current = next;
  setImages(next);
}

function toErrorCode(cause: unknown, fallback: WhaleAssetErrorCode): WhaleAssetErrorCode {
  return cause instanceof WhaleAssetFailure ? cause.code : fallback;
}

async function validateImport(file: File): Promise<"image/png" | "image/webp"> {
  if (typeof file.size !== "number" || file.size <= 0 || file.size > MAX_FILE_BYTES) {
    throw new WhaleAssetFailure(file.size > MAX_FILE_BYTES ? "file-too-large" : "unsupported-file");
  }
  if (file.type !== "" && file.type !== "image/png" && file.type !== "image/webp") {
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
  if (!isPng && !isWebp) throw new WhaleAssetFailure("invalid-signature");
  const mimeType = isPng ? "image/png" : "image/webp";
  if (file.type && file.type !== mimeType) throw new WhaleAssetFailure("mime-mismatch");
  await validateDecodedImage(file);
  return mimeType;
}

async function isValidStoredImage(blob: Blob): Promise<boolean> {
  if (blob.size <= 0 || blob.size > MAX_FILE_BYTES) return false;
  try {
    const signature = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    if (!isPngSignature(signature) && !isWebpSignature(signature)) return false;
    await validateDecodedImage(blob);
    return true;
  } catch {
    return false;
  }
}

async function validateDecodedImage(blob: Blob): Promise<void> {
  if (typeof globalThis.createImageBitmap !== "function") throw new WhaleAssetFailure("decoder-unavailable");
  let bitmap: ImageBitmap;
  try {
    bitmap = await globalThis.createImageBitmap(blob);
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
