import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import type net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { brotliDecompressSync, gunzipSync, gzipSync } from "node:zlib";
import { WebSocket, WebSocketServer } from "ws";
import { createSessionRegistration } from "../extensions/session-registration.ts";
import { initializeHub, issueSession, readHubConfig } from "../hub/config.ts";
import { startHub } from "../hub/server.ts";

const script = Buffer.from('export const text = "hello world";\n'.repeat(4096));
const asset = "assets/index-AbCd1234.js";

async function fixture(t: test.TestContext, options: { backendCompression?: boolean } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-hub-transfer-"));
  const configFile = path.join(directory, "config.json");
  initializeHub(configFile, { port: 0 });
  const config = readHubConfig(configFile);
  const hub = await startHub(config, { versions: { source: async () => ({}) } });
  const credentialFile = path.join(directory, "session.json");
  issueSession(config, credentialFile, { label: "Transfer fixture" });
  const registration = createSessionRegistration({ socketPath: hub.socketPath, credentialFile });
  let status = 200;
  let responseHeaders: http.OutgoingHttpHeaders = { "Content-Type": "application/javascript" };
  let responseBody = script;
  let interrupted = false;
  const server = http.createServer((request, response) => {
    if (!registration.guard(request, response)) return;
    response.writeHead(status, { "Content-Length": responseBody.length, ...responseHeaders });
    if (interrupted) {
      response.write(responseBody.subarray(0, 16));
      setImmediate(() => response.destroy());
    } else {
      response.end(request.method === "HEAD" ? undefined : responseBody);
    }
  });
  // Pi normally offers no compression. The optional compression-capable backend
  // verifies that browser negotiation cannot leak onto this separate local hop.
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: options.backendCompression ?? false });
  let backendExtensions = "";
  server.on("upgrade", (request, socket, head) => {
    if (!registration.guard(request)) return socket.destroy();
    wss.handleUpgrade(request, socket, head, (client) => {
      backendExtensions = client.extensions;
      client.send(script);
      client.on("message", (data, binary) => client.send(data, { binary }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  let sessionUrl = "";
  await registration.start((server.address() as net.AddressInfo).port, (value) => {
    sessionUrl = value ?? "";
  });
  t.after(async () => {
    await registration.stop();
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await hub.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    registration,
    get backendExtensions() {
      return backendExtensions;
    },
    get url() {
      return sessionUrl;
    },
    respond(code: number, headers: http.OutgoingHttpHeaders, body = script) {
      status = code;
      responseHeaders = headers;
      responseBody = body;
    },
    interrupt(value: boolean) {
      interrupted = value;
    },
  };
}

function request(url: string, headers: http.OutgoingHttpHeaders = {}, method = "GET") {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const outgoing = http.request(url, { method, headers, timeout: 3000 }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () =>
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }),
      );
    });
    outgoing.on("timeout", () => outgoing.destroy(new Error("transfer timed out")));
    outgoing.on("error", reject);
    outgoing.end();
  });
}

function binaryMessage(client: WebSocket) {
  return new Promise<Buffer>((resolve, reject) => {
    const receive = (data: Buffer, binary: boolean) => {
      if (!binary) return;
      client.removeListener("message", receive);
      client.removeListener("error", reject);
      resolve(Buffer.from(data));
    };
    client.on("message", receive);
    client.once("error", reject);
  });
}

for (const [accept, coding] of [
  ["gzip", "gzip"],
  ["br, gzip", "br"],
  ["br;q=0, gzip;q=0.5", "gzip"],
  ["br;q=0.2, gzip;q=0.8", "gzip"],
]) {
  test(`hashed static script is compressed before the tunnel for ${accept}`, async (t) => {
    const f = await fixture(t);
    const response = await request(f.url + asset, { "Accept-Encoding": accept });
    assert.equal(response.status, 200);
    assert.equal(response.headers["content-encoding"], coding);
    assert.deepEqual(coding === "br" ? brotliDecompressSync(response.body) : gunzipSync(response.body), script);
    assert.ok(response.body.length < script.length / 4, "the wire body, not just a header, must shrink");
    assert.equal(response.headers["content-length"], undefined, "identity length must not describe compressed bytes");
    assert.match(response.headers.vary ?? "", /Accept-Encoding/i);
  });
}

test("only hashed static assets receive private bounded caching, with identity clients preserved", async (t) => {
  const f = await fixture(t);
  const response = await request(f.url + asset, { "Accept-Encoding": "gzip;q=0, br;q=0" });
  assert.deepEqual(response.body, script);
  assert.equal(response.headers["content-encoding"], undefined);
  assert.equal(response.headers["cache-control"], "private, max-age=86400, immutable");
  for (const resource of [
    "",
    "index.html",
    "assets/unversioned.js",
    "api/downloads/private",
    `${asset}?token=private`,
  ]) {
    const dynamic = await request(f.url + resource, { "Accept-Encoding": "gzip" });
    assert.equal(dynamic.headers["cache-control"], "no-store", resource);
    assert.equal(dynamic.headers["content-encoding"], undefined, resource);
    assert.deepEqual(dynamic.body, script, resource);
  }
  await f.registration.stop();
  const expired = await request(f.url + asset, { "Accept-Encoding": "gzip" });
  assert.equal(expired.status, 410);
  assert.equal(expired.headers["cache-control"], "no-store");
});

test("HEAD negotiates static representation without a response body", async (t) => {
  const f = await fixture(t);
  const response = await request(f.url + asset, { "Accept-Encoding": "gzip" }, "HEAD");
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-encoding"], "gzip");
  assert.equal(response.headers["content-length"], undefined);
  assert.equal(response.body.length, 0);
});

test("errors, ranges, downloads and backend privacy policies never become cacheable assets", async (t) => {
  const f = await fixture(t);
  for (const [status, headers] of [
    [404, { "Content-Type": "application/javascript" }],
    [
      206,
      { "Content-Type": "application/javascript", "Content-Range": `bytes 0-${script.length - 1}/${script.length}` },
    ],
    [200, { "Content-Type": "application/json" }],
    [200, { "Content-Type": "application/javascript", "Cache-Control": "no-store" }],
    [200, { "Content-Type": "application/javascript", "Set-Cookie": "private=value" }],
    [200, { "Content-Type": "application/javascript", "Content-Disposition": "attachment" }],
  ] as [number, http.OutgoingHttpHeaders][]) {
    f.respond(status, headers);
    const response = await request(f.url + asset, { "Accept-Encoding": "gzip" });
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers["content-encoding"], undefined);
    assert.deepEqual(response.body, script);
    assert.equal(response.headers["set-cookie"], undefined, "existing cookie stripping remains in effect");
  }
  f.respond(200, { "Content-Type": "application/javascript" });
  const ranged = await request(f.url + asset, { Range: "bytes=0-99", "Accept-Encoding": "gzip" });
  assert.equal(ranged.headers["cache-control"], "no-store");
  assert.equal(ranged.headers["content-encoding"], undefined);
});

test("CSS compression preserves Vary and drops identity-only validators", async (t) => {
  const f = await fixture(t);
  f.respond(200, {
    "Content-Type": "text/css; charset=utf-8",
    Vary: "Origin",
    ETag: '"original"',
    "Content-MD5": "original-md5",
    Digest: "sha-256=original",
  });
  const compressed = await request(`${f.url}assets/index-AbCd1234.css`, { "Accept-Encoding": "*;q=0.5" });
  assert.equal(compressed.headers["content-encoding"], "br");
  assert.equal(compressed.headers.vary, "Origin, Accept-Encoding");
  for (const name of ["etag", "content-md5", "digest"]) assert.equal(compressed.headers[name], undefined);
  assert.deepEqual(brotliDecompressSync(compressed.body), script);
  f.respond(200, { "Content-Type": "text/css", Vary: "*" });
  const wildcard = await request(`${f.url}assets/index-AbCd1234.css`);
  assert.equal(wildcard.headers.vary, "*");
});

test("already compressed backend bytes are forwarded unchanged without private caching", async (t) => {
  const f = await fixture(t);
  const encoded = gzipSync(script);
  f.respond(200, { "Content-Type": "application/javascript", "Content-Encoding": "gzip" }, encoded);
  const response = await request(f.url + asset, { "Accept-Encoding": "br, gzip" });
  assert.equal(response.headers["content-encoding"], "gzip");
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(response.body, encoded);
});

test("interrupted static streams fail promptly without affecting subsequent sessions", async (t) => {
  const f = await fixture(t);
  f.interrupt(true);
  await assert.rejects(request(f.url + asset, { "Accept-Encoding": "gzip" }), /aborted|socket hang up|ECONNRESET/);
  f.interrupt(false);
  const response = await request(f.url + asset, { "Accept-Encoding": "gzip" });
  assert.deepEqual(gunzipSync(response.body), script);
});

for (const compress of [true, false]) {
  test(`browser WebSocket compression=${compress} preserves complete frames and session routing`, async (t) => {
    const f = await fixture(t);
    const client = new WebSocket(`${f.url.replace("http:", "ws:")}ws`, {
      origin: new URL(f.url).origin,
      perMessageDeflate: compress,
    });
    t.after(() => client.terminate());
    const initial = binaryMessage(client);
    let negotiated = "";
    client.once("upgrade", (response) => {
      negotiated = response.headers["sec-websocket-extensions"] ?? "";
    });
    await once(client, "open");
    assert.deepEqual(await initial, script);
    assert.equal(client.extensions.includes("permessage-deflate"), compress);
    if (compress) {
      assert.match(negotiated, /server_no_context_takeover/);
      assert.match(negotiated, /client_no_context_takeover/);
      assert.match(negotiated, /server_max_window_bits=12/);
      assert.match(negotiated, /client_max_window_bits=12/);
    }
    const reply = binaryMessage(client);
    client.send(script);
    assert.deepEqual(await reply, script);
    const closed = once(client, "close");
    await f.registration.stop();
    await closed;
  });
}

test("compressed WebSocket input still enforces the decompressed payload limit", async (t) => {
  const f = await fixture(t);
  const client = new WebSocket(`${f.url.replace("http:", "ws:")}ws`, {
    origin: new URL(f.url).origin,
    perMessageDeflate: true,
  });
  t.after(() => client.terminate());
  const initial = binaryMessage(client);
  await once(client, "open");
  await initial;
  const closed = once(client, "close");
  client.send(Buffer.alloc(16 * 1024 * 1024 + 1, "a"));
  const [code] = await closed;
  assert.equal(code, 1009);
  const response = await request(f.url + asset);
  assert.equal(response.status, 200, "one rejected client must not stop the Hub");
});

test("a compression-capable Pi backend connects without inheriting the browser offer", async (t) => {
  const f = await fixture(t, { backendCompression: true });
  const client = new WebSocket(`${f.url.replace("http:", "ws:")}ws`, {
    origin: new URL(f.url).origin,
    perMessageDeflate: true,
  });
  t.after(() => client.terminate());
  const [, message] = await Promise.all([once(client, "open"), binaryMessage(client)]);
  assert.deepEqual(message, script);
  assert.equal(client.extensions, "permessage-deflate");
  assert.equal(f.backendExtensions, "", "the local hop must not receive the browser compression offer");
});

for (const offer of [
  "permessage-deflate",
  "permessage-deflate; client_max_window_bits=10",
  "permessage-deflate; client_max_window_bits; server_max_window_bits=10",
]) {
  test(`incompatible bounded compression offer ${offer} falls back to ordinary WebSocket`, async (t) => {
    const f = await fixture(t);
    const client = new WebSocket(`${f.url.replace("http:", "ws:")}ws`, {
      origin: new URL(f.url).origin,
      perMessageDeflate: false,
      headers: { "Sec-WebSocket-Extensions": offer },
    });
    t.after(() => client.terminate());
    const [, message] = await Promise.all([once(client, "open"), binaryMessage(client)]);
    assert.deepEqual(message, script);
    assert.equal(client.extensions, "");
    const reply = binaryMessage(client);
    client.send(script);
    assert.deepEqual(await reply, script);
  });
}
