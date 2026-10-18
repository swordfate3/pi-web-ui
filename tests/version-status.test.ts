import assert from "node:assert/strict";
import test from "node:test";
import {
  captureHubMetadata,
  createVersionStatus,
  fetchLatestVersions,
  type VersionFetch,
} from "../hub/version-status.ts";

const piBody = { name: "@earendil-works/pi-coding-agent", version: "1.3.0" };
const commit = "c".repeat(40);
const webBody = { name: "@kkkiio/pi-web-ui", version: "0.1.2" };
const manifestBody = { source: { sha256: "a".repeat(64) } };
function response(value: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" }, ...init });
}
function versionFetch(overrides: Record<string, unknown> = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher: VersionFetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    const value = Object.entries(overrides).find(([match]) => url.includes(match))?.[1];
    if (value instanceof Error) throw value;
    if (value instanceof Response) return value;
    if (value !== undefined) return response(value);
    if (url.includes("registry.npmjs.org")) return response(piBody);
    if (url.includes("/git/ref/heads/main")) return response({ object: { type: "commit", sha: commit } });
    if (url.endsWith("/package.json")) return response(webBody);
    if (url.endsWith("/build-manifest.json")) return response(manifestBody);
    return response({});
  };
  return { fetcher, calls };
}

test("reads only fixed public version endpoints; Web files share one immutable Git revision", async () => {
  const { fetcher, calls } = versionFetch();
  assert.deepEqual(await fetchLatestVersions(fetcher, new AbortController().signal), {
    pi: { version: "1.3.0" },
    webUi: { version: "0.1.2", build: "a".repeat(64) },
  });
  assert.equal(calls.length, 4);
  assert.ok(calls.every(({ init }) => init?.method === "GET" && init.redirect === "error"));
  assert.ok(calls.every(({ url }) => url.startsWith("https://")));
  const webFiles = calls.filter(({ url }) => url.includes("raw.githubusercontent.com"));
  assert.equal(webFiles.length, 2);
  assert.ok(webFiles.every(({ url }) => url.includes(`/${commit}/`)));
  assert.ok(!JSON.stringify(calls).match(/token|session|cookie|authorization/i));
});

test("partial version source failure preserves only independently validated stable release data", async () => {
  const { fetcher } = versionFetch({ "raw.githubusercontent.com": new Error("offline") });
  assert.deepEqual(await fetchLatestVersions(fetcher, new AbortController().signal), { pi: { version: "1.3.0" } });
  const wrongRef = versionFetch({ "api.github.com": { object: { type: "tree", sha: commit } } });
  assert.deepEqual(await fetchLatestVersions(wrongRef.fetcher, new AbortController().signal), {
    pi: { version: "1.3.0" },
  });
  const badPi = versionFetch({
    "registry.npmjs.org": { name: "@earendil-works/pi-coding-agent", version: "1.4.0-beta.1" },
  });
  assert.deepEqual(await fetchLatestVersions(badPi.fetcher, new AbortController().signal), {
    webUi: { version: "0.1.2", build: "a".repeat(64) },
  });
  const invalid = versionFetch({
    "registry.npmjs.org": { name: "wrong", version: "1.4.0" },
    "api.github.com": { sha: "../main" },
  });
  await assert.rejects(fetchLatestVersions(invalid.fetcher, new AbortController().signal));
});

test("a hanging public source times out independently and keeps the healthy source from this check", async () => {
  const keeper = setTimeout(() => {}, 2000);
  try {
    for (const failingHost of ["api.github.com", "raw.githubusercontent.com", "registry.npmjs.org"]) {
      let aborted = false;
      const base = versionFetch();
      const fetcher: VersionFetch = async (url, init) => {
        if (!String(url).includes(failingHost)) return base.fetcher(url, init);
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
      };
      const status = createVersionStatus({ source: (signal) => fetchLatestVersions(fetcher, signal, 10) });
      try {
        const first = status.refresh();
        assert.equal(status.refresh(), first);
        await first;
        assert.equal(aborted, true);
        assert.equal(status.snapshot().status, "partial");
        if (failingHost === "registry.npmjs.org") {
          assert.equal(status.snapshot().pi, undefined);
          assert.deepEqual(status.snapshot().webUi, { version: "0.1.2", build: "a".repeat(64) });
        } else {
          assert.deepEqual(status.snapshot().pi, { version: "1.3.0" });
          assert.equal(status.snapshot().webUi, undefined);
        }
      } finally {
        status.close();
      }
    }
  } finally {
    clearTimeout(keeper);
  }
});

test("version response validation excludes redirect, malformed JSON and oversized bodies without losing independent Web data", async () => {
  const invalidResponses = [
    new Response("{}", { status: 302, headers: { location: "https://evil.example" } }),
    new Response("{", { status: 200 }),
    new Response(new Uint8Array(256 * 1024 + 1), { status: 200 }),
    new Response("{}", { status: 200, headers: { "content-length": "999999999" } }),
  ];
  for (const invalid of invalidResponses) {
    const f = versionFetch({ "registry.npmjs.org": invalid });
    assert.deepEqual(await fetchLatestVersions(f.fetcher, new AbortController().signal), {
      webUi: { version: "0.1.2", build: "a".repeat(64) },
    });
  }
  const allFailed = versionFetch({
    "registry.npmjs.org": new Response("{", { status: 200 }),
    "api.github.com": new Error("offline"),
  });
  await assert.rejects(fetchLatestVersions(allFailed.fetcher, new AbortController().signal), /unavailable/);
});

test("version status starts checking without I/O and caches successful checks for at least five minutes", async () => {
  let now = 1_000;
  let count = 0;
  const status = createVersionStatus({
    now: () => now,
    cacheMs: 1,
    hub: { version: "0.1.1", build: "b".repeat(64) },
    source: async () => {
      count++;
      return { pi: { version: "1.3.0" }, webUi: { version: "0.1.2", build: "a".repeat(64) } };
    },
  });
  assert.equal(status.snapshot().status, "checking");
  assert.equal(count, 0, "Hub startup must not start a network check");
  const first = status.refresh();
  assert.equal(status.refresh(), first, "concurrent consumers share one source request");
  await first;
  assert.deepEqual(status.snapshot(), {
    status: "ok",
    checkedAt: now,
    pi: { version: "1.3.0" },
    webUi: { version: "0.1.2", build: "a".repeat(64) },
    hub: { version: "0.1.1", build: "b".repeat(64) },
  });
  now += 299_999;
  await status.refresh();
  assert.equal(count, 1, "successful data is single-flight cached for at least five minutes");
  status.close();
});

test("synchronous source throws settle cleanly and failures enter the same retry cooldown", async () => {
  let now = 0;
  let count = 0;
  const status = createVersionStatus({
    now: () => now,
    source: () => {
      count++;
      throw new Error("synthetic failure");
    },
  });
  await status.refresh();
  assert.equal(status.snapshot().status, "unavailable");
  assert.equal(status.snapshot().checkedAt, now);
  assert.equal(count, 1);
  await status.refresh();
  assert.equal(count, 1, "failure cannot trigger a 5-second poll retry storm");
  now += 300_000;
  await status.refresh();
  assert.equal(count, 2);
  status.close();
});

test("failed checks do not retain a previous release as current, and malformed injected source is partial-safe", async () => {
  let now = 1;
  let fail = false;
  const status = createVersionStatus({
    now: () => now,
    source: () => {
      if (fail) throw new Error("offline");
      return Promise.resolve({ pi: { version: "1.3.0" } });
    },
  });
  await status.refresh();
  assert.equal(status.snapshot().status, "partial");
  now += 300_000;
  fail = true;
  await status.refresh();
  assert.deepEqual(status.snapshot(), { status: "unavailable", checkedAt: now, hub: status.snapshot().hub });
  status.close();
});

test("timeout aborts its request, close aborts in-flight work and malformed data is unavailable", async () => {
  let timedOut = false;
  const timeout = createVersionStatus({
    timeoutMs: 5,
    source: (signal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => {
            timedOut = true;
            reject(new Error("aborted"));
          },
          { once: true },
        ),
      ),
  });
  await timeout.refresh();
  assert.equal(timedOut, true);
  assert.equal(timeout.snapshot().status, "unavailable");
  timeout.close();

  let closed = false;
  const pending = createVersionStatus({
    timeoutMs: 10_000,
    source: (signal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => {
            closed = true;
            reject(new Error("aborted"));
          },
          { once: true },
        ),
      ),
  });
  const inFlight = pending.refresh();
  await new Promise((resolve) => setImmediate(resolve));
  pending.close();
  await inFlight;
  assert.equal(closed, true);
  assert.equal(pending.snapshot().status, "checking", "close cannot publish an aborted result");
});

test("captures the Hub package metadata from package root and independently tolerates absent manifest", () => {
  const hub = captureHubMetadata();
  assert.ok(hub?.version);
  if (hub.build) assert.match(hub.build, /^[a-f0-9]{64}$/);
  assert.equal(captureHubMetadata("file:///missing/not-a-package/hub/version-status.ts"), undefined);
});
