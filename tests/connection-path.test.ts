import assert from "node:assert/strict";
import test from "node:test";
import { hubHomePath, webBasePath, webRoute } from "../src/web/src/core/connection-path.ts";
import { exportDownloadUrl } from "../src/web/src/core/export-download.ts";
import type { ExportHtmlResult } from "../src/web/src/core/types.ts";
import { wsUrl } from "../src/web/src/core/ws.ts";

test("Hub home is offered only on an exact same-origin Hub session entry", () => {
  const generation = "a".repeat(32);
  assert.equal(hubHomePath(`/s/${generation}/`), "/sessions/");
  assert.equal(hubHomePath(`/s/${generation}/index.html`), "/sessions/");
  for (const pathname of ["/", "/index.html", "/pi/", "/s/abc/", `/s/${generation}/api`, `//evil/s/${generation}/`])
    assert.equal(hubHomePath(pathname), null);
});

test("entry paths retain the current proxy directory, never another session", () => {
  assert.equal(webBasePath("/"), "/");
  assert.equal(webBasePath("/index.html"), "/");
  assert.equal(webBasePath("/s/abc/"), "/s/abc/");
  assert.equal(webBasePath("/s/abc/index.html"), "/s/abc/");
  assert.equal(webRoute("ws", "/s/abc/"), "/s/abc/ws");
  assert.equal(webRoute("/api/exports/token", "/pi/"), "/pi/api/exports/token");
  for (const route of ["//evil.example/ws", "../ws", "https://evil.example/ws"]) {
    assert.throws(() => webRoute(route, "/pi/"));
  }
});

test("WebSocket URLs retain HTTPS, IPv6, ports and reverse-proxy subpaths", () => {
  assert.equal(wsUrl(undefined, "http://localhost:4444/"), "ws://localhost:4444/ws");
  assert.equal(wsUrl(undefined, "https://gateway.example/s/abc/"), "wss://gateway.example/s/abc/ws");
  assert.equal(wsUrl(undefined, "http://[::1]:3001/"), "ws://[::1]:3001/ws");
  assert.equal(wsUrl(4000, "http://localhost:4444/index.html"), "ws://localhost:4000/ws");
});

test("export attachments stay same-origin within the active entry directory", () => {
  const result: ExportHtmlResult = {
    token: "12345678-1234-1234-1234-123456789abc",
    filename: "session.html",
    downloadUrl: "/api/exports/12345678-1234-1234-1234-123456789abc",
  };
  assert.equal(
    exportDownloadUrl(result, "https://gateway.example", "/s/abc/"),
    "https://gateway.example/s/abc/api/exports/12345678-1234-1234-1234-123456789abc",
  );
  assert.equal(
    exportDownloadUrl(result, "http://localhost:3001"),
    "http://localhost:3001/api/exports/12345678-1234-1234-1234-123456789abc",
  );
  for (const downloadUrl of [
    "https://evil.example/",
    "/s/other/api/exports/token",
    `${result.downloadUrl}?key=secret`,
  ]) {
    assert.throws(() => exportDownloadUrl({ ...result, downloadUrl }, "https://gateway.example", "/s/abc/"));
  }
});
