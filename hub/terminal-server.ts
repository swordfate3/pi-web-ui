import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { HubConfig } from "./config.ts";
import { HubTerminalAuth } from "./terminal-auth.ts";

/** Real, opt-in Hub listener; no proxy, terminal stream, PTY or write API yet. */
export async function startTerminalServer(config: HubConfig, otherOrigins: string[]) {
  if (!config.terminal) throw new Error("Terminal listener is disabled");
  const terminal = config.terminal;
  const auth = new HubTerminalAuth(config);
  const connections = new Set<Socket>();
  let url = "";
  let closed = false;
  const allowed = (request: IncomingMessage, write: boolean) => {
    const origins = new Set([new URL(url).origin, ...(terminal.publicUrl ? [new URL(terminal.publicUrl).origin] : [])]);
    const origin = request.headers.origin;
    const host = request.headers.host;
    const matched = [...origins].find((candidate) => new URL(candidate).host === host);
    return (
      !!matched &&
      request.headers["sec-fetch-site"] !== "cross-site" &&
      (origin === undefined ? !write : origin === matched)
    );
  };
  const respond = (res: ServerResponse, status: number, value?: unknown) => {
    if (!res.destroyed)
      res
        .writeHead(status, { "Content-Type": "application/json" })
        .end(value === undefined ? undefined : JSON.stringify(value));
  };
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    if (closed || !allowed(req, req.method !== "GET") || req.headers["service-worker"] !== undefined) {
      respond(res, 403);
      return;
    }
    // Exact routes: no query aliases, arbitrary targets or fallthrough assets.
    const route = req.url;
    if (req.method === "GET" && route === "/api/terminal/status") {
      respond(res, 200, { ...auth.status(req), available: false, reason: "terminal_backend_unavailable" });
      return;
    }
    if (req.method !== "POST" || !["/api/terminal/unlock", "/api/terminal/logout"].includes(route ?? "")) {
      respond(res, 404);
      return;
    }
    if (
      req.headers["content-type"] !== "application/json" ||
      req.headers["transfer-encoding"] !== undefined ||
      !/^[0-9]{1,4}$/.test(req.headers["content-length"] ?? "") ||
      Number(req.headers["content-length"]) > 1024
    ) {
      res.setHeader("Connection", "close");
      respond(res, 413);
      return;
    }
    // Slow bodies cannot retain an authority checked only at request start.
    const timer = setTimeout(() => req.destroy(), 2000);
    try {
      let body = "";
      for await (const chunk of req) {
        body += chunk.toString("utf8");
        if (Buffer.byteLength(body) > 1024) throw new Error();
      }
      if (closed || !allowed(req, true)) throw new Error();
      const data = JSON.parse(body);
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
      if (route === "/api/terminal/unlock") {
        if (Object.keys(data).join(",") !== "code") throw new Error();
        const result = auth.unlock(data.code);
        res.setHeader("Set-Cookie", result.cookie);
        respond(res, 200, { csrf: result.csrf, expiresAt: result.expiresAt });
      } else {
        if (Object.keys(data).length !== 0) throw new Error();
        res.setHeader("Set-Cookie", auth.logout(req));
        respond(res, 200, { authorized: false });
      }
    } catch {
      respond(res, 403);
    } finally {
      clearTimeout(timer);
    }
  };
  const server = http.createServer({ maxHeaderSize: 8192, headersTimeout: 5000, requestTimeout: 5000 }, (req, res) => {
    void handle(req, res).catch(() => respond(res, 403));
  });
  server.maxConnections = 32;
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => connections.delete(socket));
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  server.on("upgrade", (_request, socket) => socket.destroy());
  server.on("connect", (_request, socket) => socket.destroy());
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(terminal.port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const forbidden = new Set(otherOrigins.map((origin) => new URL(origin).origin));
    if ([url, terminal.publicUrl].some((origin) => origin && forbidden.has(new URL(origin).origin)))
      throw new Error("Terminal origin must differ from chat and management");
  } catch (error) {
    closed = true;
    auth.close();
    for (const socket of connections) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }
  let closing: Promise<void> | undefined;
  return {
    url,
    close() {
      if (closing) return closing;
      closed = true;
      auth.close();
      for (const socket of connections) socket.destroy();
      closing = new Promise<void>((resolve) => server.close(() => resolve()));
      return closing;
    },
  };
}
