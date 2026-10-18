import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isStableSemver } from "../extensions/software-metadata.ts";

const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const CACHE_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_BODY_BYTES = 256 * 1024;
const PACKAGE_NAME = "@kkkiio/pi-web-ui";
const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

export type VersionStatus = Readonly<{
  status: "checking" | "ok" | "partial" | "unavailable";
  checkedAt?: number;
  pi?: Readonly<{ version: string }>;
  webUi?: Readonly<{ version: string; build: string }>;
  hub?: Readonly<{ version: string; build?: string }>;
}>;

export type LatestVersions = Readonly<{
  pi?: Readonly<{ version: string }>;
  webUi?: Readonly<{ version: string; build: string }>;
}>;

export type VersionFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;
export type VersionSource = (signal: AbortSignal) => Promise<LatestVersions>;

export type VersionStatusOptions = {
  hub?: { version: string; build?: string };
  source?: VersionSource;
  fetch?: VersionFetch;
  now?: () => number;
  cacheMs?: number;
  timeoutMs?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedJson(response: Response): Promise<unknown> {
  return (async () => {
    if (!response.ok || response.redirected) {
      await response.body?.cancel().catch(() => {});
      throw new Error("Version source unavailable");
    }
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) {
      await response.body?.cancel().catch(() => {});
      throw new Error("Version source response too large");
    }
    if (!response.body) throw new Error("Version source response unavailable");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY_BYTES) {
          await reader.cancel();
          throw new Error("Version source response too large");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    try {
      return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"));
    } catch {
      throw new Error("Invalid version source response");
    }
  })();
}

async function getJson(
  fetcher: VersionFetch,
  url: string,
  signal: AbortSignal,
  headers: HeadersInit | undefined,
  timeoutMs: number,
) {
  const controller = new AbortController();
  const requestSignal = AbortSignal.any([signal, controller.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Version source timed out"));
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      Promise.resolve().then(async () => {
        const response = await fetcher(url, {
          method: "GET",
          redirect: "error",
          signal: requestSignal,
          headers: { Accept: "application/json", ...headers },
        });
        return boundedJson(response);
      }),
      expired,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Read only the fixed, public package sources; a single immutable Git revision supplies Web UI version and build. */
export async function fetchLatestVersions(
  fetcher: VersionFetch,
  signal: AbortSignal,
  requestTimeoutMs = 3_000,
): Promise<LatestVersions> {
  const settled = await Promise.allSettled([
    getJson(
      fetcher,
      "https://registry.npmjs.org/@earendil-works%2Fpi-coding-agent/latest",
      signal,
      undefined,
      requestTimeoutMs,
    ),
    getJson(
      fetcher,
      "https://api.github.com/repos/swordfate3/pi-web-ui/git/ref/heads/main",
      signal,
      {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "pi-web-ui-hub-version-check",
      },
      requestTimeoutMs,
    ),
  ]);
  let pi: LatestVersions["pi"];
  const piPayload = settled[0].status === "fulfilled" ? settled[0].value : undefined;
  if (isRecord(piPayload) && piPayload.name === PI_PACKAGE_NAME && isStableSemver(piPayload.version))
    pi = Object.freeze({ version: piPayload.version });

  const refPayload = settled[1].status === "fulfilled" ? settled[1].value : undefined;
  const object = isRecord(refPayload) ? refPayload.object : undefined;
  let webUi: LatestVersions["webUi"];
  if (isRecord(object) && object.type === "commit" && typeof object.sha === "string" && COMMIT.test(object.sha)) {
    const revision = object.sha;
    const webResults = await Promise.allSettled([
      getJson(
        fetcher,
        `https://raw.githubusercontent.com/swordfate3/pi-web-ui/${revision}/package.json`,
        signal,
        undefined,
        requestTimeoutMs,
      ),
      getJson(
        fetcher,
        `https://raw.githubusercontent.com/swordfate3/pi-web-ui/${revision}/dist/build-manifest.json`,
        signal,
        undefined,
        requestTimeoutMs,
      ),
    ]);
    const webPayload = webResults[0].status === "fulfilled" ? webResults[0].value : undefined;
    const manifestPayload = webResults[1].status === "fulfilled" ? webResults[1].value : undefined;
    const source = isRecord(manifestPayload) ? manifestPayload.source : undefined;
    if (
      isRecord(webPayload) &&
      webPayload.name === PACKAGE_NAME &&
      isStableSemver(webPayload.version) &&
      isRecord(source) &&
      typeof source.sha256 === "string" &&
      SHA256.test(source.sha256)
    )
      webUi = Object.freeze({ version: webPayload.version, build: source.sha256 });
  }

  if (!pi && !webUi) throw new Error("Public version metadata unavailable");
  return Object.freeze({ ...(pi ? { pi } : {}), ...(webUi ? { webUi } : {}) });
}

/** Capture the Hub package and its own build fingerprint; never infer it from the Pi child runtime. */
export function captureHubMetadata(moduleUrl = import.meta.url): { version: string; build?: string } | undefined {
  let directory = path.dirname(fileURLToPath(moduleUrl));
  let root: string | undefined;
  for (let depth = 0; depth < 8; depth++) {
    try {
      const packagePath = path.join(directory, "package.json");
      if (statSync(packagePath).size > 32 * 1024) throw new Error();
      const manifest = JSON.parse(readFileSync(packagePath, "utf8")) as unknown;
      if (isRecord(manifest) && manifest.name === PACKAGE_NAME && isStableSemver(manifest.version)) {
        root = directory;
        break;
      }
    } catch {}
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  if (!root) return undefined;
  try {
    const packagePath = path.join(root, "package.json");
    const manifest = JSON.parse(readFileSync(packagePath, "utf8")) as Record<string, unknown>;
    let build: string | undefined;
    try {
      const buildPath = path.join(root, "dist", "build-manifest.json");
      if (statSync(buildPath).size > MAX_BODY_BYTES) throw new Error();
      const buildManifest = JSON.parse(readFileSync(buildPath, "utf8")) as unknown;
      const source = isRecord(buildManifest) ? buildManifest.source : undefined;
      if (isRecord(source) && typeof source.sha256 === "string" && SHA256.test(source.sha256)) build = source.sha256;
    } catch {
      // Build metadata is optional, but the package version is always the running Hub's own.
    }
    return Object.freeze({ version: manifest.version as string, ...(build ? { build } : {}) });
  } catch {
    return undefined;
  }
}

/** Background-only, single-flight version lookup with bounded requests and cooldown even after failures. */
export function createVersionStatus(options: VersionStatusOptions = {}) {
  const now = options.now ?? Date.now;
  const cacheMs = Math.max(CACHE_MS, options.cacheMs ?? 0);
  const timeoutMs = Math.max(1, options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const source =
    options.source ??
    (process.env.PI_OFFLINE === "1"
      ? async (_signal: AbortSignal): Promise<LatestVersions> => {
          throw new Error("Version checks disabled in offline mode");
        }
      : (signal: AbortSignal) => fetchLatestVersions(fetcher, signal));
  const localHub = options.hub ?? captureHubMetadata();
  const hub = localHub ? Object.freeze({ ...localHub }) : undefined;
  let status: VersionStatus = Object.freeze({ status: "checking", ...(hub ? { hub } : {}) });
  let inFlight: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let activeTimeout: ReturnType<typeof setTimeout> | undefined;
  let rejectActive: ((error: Error) => void) | undefined;
  let nextCheckAt = 0;
  let closed = false;

  const check = (): Promise<void> => {
    if (closed || inFlight) return inFlight ?? Promise.resolve();
    if (now() < nextCheckAt) return Promise.resolve();
    if (timer) clearTimeout(timer);
    timer = undefined;
    controller = new AbortController();
    const active = controller;
    let rejectTimeout!: (error: Error) => void;
    const expired = new Promise<never>((_resolve, reject) => {
      rejectTimeout = reject;
    });
    rejectActive = rejectTimeout;
    activeTimeout = setTimeout(() => {
      active.abort();
      rejectTimeout(new Error("Version check timed out"));
    }, timeoutMs);
    activeTimeout.unref?.();
    inFlight = (async () => {
      try {
        const result = await Promise.race([Promise.resolve().then(() => source(active.signal)), expired]);
        if (closed || active.signal.aborted) return;
        if (!isRecord(result) || Object.keys(result).some((key) => key !== "pi" && key !== "webUi"))
          throw new Error("Invalid version source result");
        const pi = result.pi;
        const webUi = result?.webUi;
        const validPi = isRecord(pi) && Object.keys(pi).join(",") === "version" && isStableSemver(pi.version);
        const validWeb =
          isRecord(webUi) &&
          Object.keys(webUi).sort().join(",") === "build,version" &&
          isStableSemver(webUi.version) &&
          typeof webUi.build === "string" &&
          SHA256.test(webUi.build);
        if (!validPi && !validWeb) throw new Error("Invalid version source result");
        status = Object.freeze({
          status: validPi && validWeb ? "ok" : "partial",
          checkedAt: now(),
          ...(validPi ? { pi: Object.freeze({ version: pi.version }) } : {}),
          ...(validWeb ? { webUi: Object.freeze({ version: webUi.version, build: webUi.build }) } : {}),
          ...(hub ? { hub } : {}),
        });
      } catch {
        if (closed) return;
        // A failed check never presents stale source values as a successful observation.
        status = Object.freeze({ status: "unavailable", checkedAt: now(), ...(hub ? { hub } : {}) });
      } finally {
        if (activeTimeout) clearTimeout(activeTimeout);
        activeTimeout = undefined;
        rejectActive = undefined;
        if (controller === active) controller = undefined;
        inFlight = undefined;
        if (!closed) {
          nextCheckAt = now() + cacheMs;
          timer = setTimeout(
            () => {
              timer = undefined;
              void check();
            },
            Math.max(0, nextCheckAt - now()),
          );
          timer.unref?.();
        }
      }
    })();
    return inFlight;
  };

  return {
    snapshot: () => status,
    // Hub startup is strictly offline. A browser's first session-list request
    // schedules the public check without delaying the response.
    ensureStarted: () => {
      void check();
    },
    /** Test/maintenance seam. HTTP handlers use snapshot only and never await this. */
    refresh: check,
    close: () => {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (activeTimeout) clearTimeout(activeTimeout);
      activeTimeout = undefined;
      controller?.abort();
      rejectActive?.(new Error("Version checker closed"));
      rejectActive = undefined;
    },
  };
}
