import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { localWebUrl, resolveConnectionConfig, validatedPublicUrl } from "../extensions/connection-config.ts";
import { listenWithFallback } from "../extensions/connection-listener.ts";

test("local defaults need no registry or platform paths", () => {
  const config = resolveConnectionConfig({}, {});
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 3001);
  assert.equal(config.autoStart, true);
  assert.equal(config.registration, undefined);
  assert.equal(config.publicUrl, undefined);
});

test("public URL validator never exposes malformed input", () => {
  assert.throws(
    () => validatedPublicUrl("credential-like-invalid-value"),
    (error: Error) => {
      assert.equal(error.message, "Invalid Pi Web public URL");
      assert.equal("input" in error, false);
      return true;
    },
  );
});

test("explicit environment overrides settings, including disabled=false", () => {
  const config = resolveConnectionConfig(
    { host: "::1", port: 4000, disabled: true, publicUrl: "https://old.example/" },
    {
      PI_WEB_UI_HOST: "127.0.0.1",
      PI_WEB_UI_PORT: "5000",
      PI_WEB_UI_DISABLED: "false",
      PI_WEB_UI_PUBLIC_URL: "https://new.example/pi/",
    },
  );
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 5000);
  assert.equal(config.autoStart, true);
  assert.equal(config.publicUrl, "https://new.example/pi/");
});

test("invalid bind options are rejected without echoing untrusted values", () => {
  for (const port of ["3001junk", "", 0, -1, 65536, 1.5, "3e3", "secret-value"]) {
    assert.throws(() => resolveConnectionConfig({ port }, {}), /Invalid Pi Web port$/);
  }
  for (const host of ["http://host", "host/path", "bad host", "", "host;command"]) {
    assert.throws(() => resolveConnectionConfig({ host }, {}), /Invalid Pi Web host$/);
  }
});

test("unsafe optional public URLs do not prevent local use or expose their contents", () => {
  for (const publicUrl of [
    "javascript:alert(1)",
    "https://name:secret@host/",
    "https://host/?secret=1",
    "https://host/#secret",
    "http://remote.example/",
  ]) {
    const config = resolveConnectionConfig({ publicUrl }, {});
    assert.equal(config.publicUrl, undefined);
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.warnings.length, 1);
    assert.ok(!config.warnings[0].includes("secret"));
  }
});

test("registration is explicit, all-or-nothing, and accepts local IPC paths", () => {
  assert.equal(
    resolveConnectionConfig({ registration: { socketPath: "/tmp/registry.sock" } }, {}).registration,
    undefined,
  );
  assert.deepEqual(
    resolveConnectionConfig(
      {},
      {
        PI_WEB_UI_REGISTRY_SOCKET: "\\\\.\\pipe\\pi-web",
        PI_WEB_UI_REGISTRY_CREDENTIAL_FILE: "C:\\Pi\\capability.json",
      },
    ).registration,
    { socketPath: "\\\\.\\pipe\\pi-web", credentialFile: "C:\\Pi\\capability.json" },
  );
});

test("browser local URLs use reachable loopback and bracket IPv6", () => {
  assert.equal(localWebUrl("0.0.0.0", 3001), "http://127.0.0.1:3001/");
  assert.equal(localWebUrl("::", 3002), "http://[::1]:3002/");
  assert.equal(localWebUrl("::1", 3003), "http://[::1]:3003/");
});

test("real occupied TCP port advances to an available actual port", async () => {
  const occupied = http.createServer();
  const server = http.createServer();
  await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  const first = (occupied.address() as { port: number }).port;
  try {
    const port = await listenWithFallback(server, { host: "127.0.0.1", port: first }, new AbortController().signal);
    assert.ok(port > first);
    assert.equal(port, (server.address() as { port: number }).port);
  } finally {
    await Promise.all([occupied, server].map((value) => new Promise<void>((resolve) => value.close(() => resolve()))));
  }
});

test("aborted start cannot leave a listening server", async () => {
  const server = http.createServer();
  const controller = new AbortController();
  const pending = listenWithFallback(server, { host: "127.0.0.1", port: 3001 }, controller.signal);
  controller.abort();
  await assert.rejects(pending, /aborted/i);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(server.listening, false);
});

test("more than ten occupied ports do not impose a session-count limit", async () => {
  const occupied: http.Server[] = [];
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const first = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const server = http.createServer();
  try {
    for (let index = 0; index < 12; index++) {
      const blocker = http.createServer();
      occupied.push(blocker);
      try {
        await new Promise<void>((resolve, reject) => {
          blocker.once("error", reject);
          blocker.listen(first + index, "127.0.0.1", resolve);
        });
      } catch (error) {
        // Existing services also occupy a port; never stop or replace them for this test.
        if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      }
    }
    const port = await listenWithFallback(server, { host: "127.0.0.1", port: first }, new AbortController().signal);
    assert.ok(port >= first + 12);
    assert.ok(server.listenerCount("close") < 5, "failed listens must release their abort cleanup listeners");
  } finally {
    await Promise.all(
      [...occupied, server].map((value) => new Promise<void>((resolve) => value.close(() => resolve()))),
    );
  }
});
