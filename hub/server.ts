import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { type Grant, type HubConfig, privateDirectory, readGrant, readPrivateJson } from "./config.ts";
import { portalCss, portalHtml, portalJs } from "./portal.ts";

type Session = { grant: Grant; generation: string; port: number; expires: number; since: number };
type Handoff = { grant: Grant; from: string; successor?: string; expires: number };
const mac = (token: string, value: string) => createHmac("sha256", token).update(value).digest("hex");
function equal(value: unknown, expected: string) {
  if (typeof value !== "string") return false;
  const a = Buffer.from(value);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function proveBackend(grant: Grant, generation: string, port: number) {
  const challenge = randomBytes(24).toString("hex");
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (valid: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.destroy();
      resolve(valid);
    };
    const request = http.get(
      {
        host: grant.backendHost,
        port,
        path: "/.pi-web-identity",
        agent: false,
        headers: {
          "x-pi-web-challenge": challenge,
          "x-pi-web-challenge-proof": mac(grant.token, challenge),
        },
      },
      (response) => {
        if (response.statusCode !== 200) {
          finish(false);
          return;
        }
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
          if (body.length > 4096) finish(false);
        });
        response.on("error", () => finish(false));
        response.on("end", () => {
          try {
            const value = JSON.parse(body);
            finish(
              value.generation === generation && equal(value.proof, mac(grant.token, `${challenge}:${generation}`)),
            );
          } catch {
            finish(false);
          }
        });
      },
    );
    const timer = setTimeout(() => finish(false), 1500);
    request.on("error", () => finish(false));
  });
}

function backendHeaders(request: IncomingMessage, session: Session) {
  const headers: http.OutgoingHttpHeaders = {};
  const hop = new Set([
    "connection",
    "upgrade",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "authorization",
    "cookie",
    "host",
  ]);
  for (const field of (request.headers.connection ?? "").split(",")) hop.add(field.trim().toLowerCase());
  for (const [key, value] of Object.entries(request.headers)) {
    if (!hop.has(key) && !key.startsWith("x-pi-web-") && !key.startsWith("x-forwarded-") && key !== "forwarded")
      headers[key] = value;
  }
  headers["x-pi-web-generation"] = session.generation;
  headers["x-pi-web-proof"] = mac(session.grant.token, session.generation);
  return headers;
}

/** Explicitly launched independent process; never imported as a Pi extension entry. */
export async function startHub(config: HubConfig) {
  privateDirectory(config.runtimeDir);
  // Exclusive acquisition precedes any asynchronous stale-socket recovery.
  // Fail closed after a crash: a trusted operator must confirm the old process
  // is gone before removing its lock. Never guess from a reused PID.
  const lock = path.join(config.runtimeDir, "hub.lock");
  mkdirSync(lock, { mode: 0o700 });
  const owner = path.join(lock, "owner.json");
  const release = () => {
    if (!existsSync(lock)) return;
    if (existsSync(owner)) unlinkSync(owner);
    rmdirSync(lock);
  };
  try {
    writeFileSync(owner, JSON.stringify({ pid: process.pid }), { flag: "wx", mode: 0o600 });
    const hub = await startLockedHub(config);
    let closing: Promise<void> | undefined;
    return {
      ...hub,
      close: () => {
        closing ??= hub.close().finally(release);
        return closing;
      },
    };
  } catch (error) {
    release();
    throw error;
  }
}

async function startLockedHub(config: HubConfig) {
  privateDirectory(config.stateDir);
  privateDirectory(config.runtimeDir);
  privateDirectory(path.join(config.stateDir, "grants"));
  privateDirectory(path.join(config.stateDir, "generations"));
  // Do not steal a live socket from another manager. A crashed hub can leave a stale inode.
  if (existsSync(config.socketPath)) {
    const stat = lstatSync(config.socketPath);
    if (!stat.isSocket() || stat.uid !== process.getuid?.()) throw new Error("Unsafe hub socket path");
    const stale = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection(config.socketPath);
      const timer = setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, 500);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.destroy();
        resolve(false);
      });
      socket.once("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        socket.destroy();
        resolve(error.code === "ECONNREFUSED");
      });
    });
    if (!stale) throw new Error("Another hub is already running");
    unlinkSync(config.socketPath);
  }
  const boot = randomBytes(16).toString("hex");
  const sessions = new Map<string, Session>();
  const peers = new Set<net.Socket>();
  const connections = new Set<net.Socket>();
  const webSockets = new Map<WebSocket, string>();
  // Browser-only, memory-only capabilities. A disconnected browser gets one
  // short opportunity to follow its exact successor, never an arbitrary Pi.
  const handoffs = new Map<string, Handoff>();
  const pruneHandoffs = () => {
    for (const [token, item] of handoffs) if (item.expires <= Date.now()) handoffs.delete(token);
  };
  let stopped = false;
  let pending = Promise.resolve();
  let url = "";
  const retire = (generation: string) => {
    sessions.delete(generation);
    for (const [ws, id] of webSockets) if (id === generation) ws.terminate();
  };
  const current = (generation: string) => {
    const session = sessions.get(generation);
    if (!session) return undefined;
    try {
      const grant = readGrant(config, session.grant.run_id);
      if (
        session.expires <= Date.now() ||
        grant.revoked ||
        !equal(grant.token, session.grant.token) ||
        grant.backendHost !== session.grant.backendHost
      ) {
        retire(generation);
        return undefined;
      }
    } catch {
      retire(generation);
      return undefined;
    }
    return session;
  };
  const register = async (value: Record<string, unknown>) => {
    if (
      stopped ||
      typeof value.run_id !== "string" ||
      typeof value.generation !== "string" ||
      !/^[0-9a-f]{32}$/.test(value.generation)
    )
      throw new Error("Registration rejected");
    const grant = readGrant(config, value.run_id);
    if (grant.revoked || !equal(value.token, grant.token)) throw new Error("Registration rejected");
    const generation = value.generation;
    const session = current(generation);
    const ledger = path.join(config.stateDir, "generations", `${generation}.json`);
    const owner = existsSync(ledger) ? readPrivateJson(ledger) : undefined;
    if (value.action === "unregister") {
      if ((session && session.grant.run_id !== grant.run_id) || (owner && owner.run_id !== grant.run_id))
        throw new Error("Registration rejected");
      writeFileSync(ledger, JSON.stringify({ boot, run_id: grant.run_id, retired: true }), {
        flag: owner ? "w" : "wx",
        mode: 0o600,
      });
      retire(generation);
      return {};
    }
    if (
      value.action !== "register" ||
      !Number.isInteger(value.port) ||
      Number(value.port) < 1 ||
      Number(value.port) > 65535
    )
      throw new Error("Registration rejected");
    const port = Number(value.port);
    if (owner) {
      if (owner.retired || owner.boot !== boot || owner.run_id !== grant.run_id || !session || session.port !== port)
        throw new Error("ended generation");
    }
    if (!(await proveBackend(grant, generation, port)) || stopped) throw new Error("Registration rejected");
    const latestGrant = readGrant(config, grant.run_id);
    if (latestGrant.revoked || latestGrant.token !== grant.token || latestGrant.backendHost !== grant.backendHost)
      throw new Error("Registration rejected");
    if (session && current(generation) !== session) throw new Error("ended generation");
    if (!existsSync(ledger))
      writeFileSync(ledger, JSON.stringify({ boot, run_id: grant.run_id }), { flag: "wx", mode: 0o600 });
    for (const other of sessions.values())
      if (other.grant.run_id === grant.run_id && other.generation !== generation) retire(other.generation);
    if (session) session.expires = Date.now() + config.leaseMs;
    else sessions.set(generation, { grant, generation, port, expires: Date.now() + config.leaseMs, since: Date.now() });
    pruneHandoffs();
    for (const item of handoffs.values()) {
      if (item.grant.run_id === grant.run_id && item.from !== generation && !item.successor)
        item.successor = generation;
    }
    return { url: `${config.publicUrl ?? url}s/${generation}/` };
  };
  const registry = net.createServer((socket) => {
    if (peers.size >= 128) {
      socket.destroy();
      return;
    }
    peers.add(socket);
    let data = Buffer.alloc(0);
    let received = false;
    const timer = setTimeout(() => socket.destroy(), 5000);
    socket.on("error", () => {});
    socket.once("close", () => {
      clearTimeout(timer);
      peers.delete(socket);
    });
    const reply = (ok: boolean, result?: unknown, error = "Registration rejected") => {
      if (!socket.destroyed) socket.end(`${JSON.stringify(ok ? { ok, result } : { ok, error })}\n`);
    };
    socket.on("data", (chunk: Buffer) => {
      if (received) return;
      data = Buffer.concat([data, chunk]);
      if (data.length > 8192) {
        received = true;
        reply(false);
        return;
      }
      const end = data.indexOf(10);
      if (end < 0) return;
      received = true;
      let value: Record<string, unknown>;
      try {
        value = JSON.parse(data.subarray(0, end).toString());
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      } catch {
        reply(false);
        return;
      }
      pending = pending.then(async () => {
        if (socket.destroyed) return;
        try {
          reply(true, await register(value));
        } catch (error) {
          reply(
            false,
            undefined,
            error instanceof Error && error.message === "ended generation"
              ? "ended generation"
              : "Registration rejected",
          );
        }
      });
    });
  });
  const allowedBrowser = (request: IncomingMessage, requireOrigin = false) => {
    const allowed = new Set([new URL(url).origin, ...(config.publicUrl ? [new URL(config.publicUrl).origin] : [])]);
    const hosts = new Set([...allowed].map((origin) => new URL(origin).host));
    const origin = request.headers.origin;
    return (
      hosts.has(request.headers.host ?? "") &&
      request.headers["sec-fetch-site"] !== "cross-site" &&
      (origin === undefined ? !requireOrigin : allowed.has(origin))
    );
  };
  const matchRoute = (request: IncomingMessage) => /^\/s\/([a-f0-9]{32})(\/.*)?$/.exec(request.url ?? "");
  const fail = (response: ServerResponse, code: number) =>
    response.writeHead(code, { "Cache-Control": "no-store" }).end();
  const server = http.createServer(async (request, response) => {
    try {
      if (!allowedBrowser(request)) {
        fail(response, 403);
        return;
      }
      const pathname = request.url?.split("?")[0];
      if (pathname === "/api/session-handoff") {
        if (request.method !== "POST") {
          fail(response, 405);
          return;
        }
        if (!allowedBrowser(request, true)) {
          fail(response, 403);
          return;
        }
        pruneHandoffs();
        const token = request.headers["x-pi-web-handoff"];
        const item = typeof token === "string" && /^[a-f0-9]{48}$/.test(token) ? handoffs.get(token) : undefined;
        if (!item) {
          fail(response, 410);
          return;
        }
        const grant = readGrant(config, item.grant.run_id);
        if (grant.revoked || !equal(grant.token, item.grant.token) || grant.backendHost !== item.grant.backendHost) {
          handoffs.delete(token as string);
          fail(response, 410);
          return;
        }
        const targetGeneration = item.successor ?? item.from;
        const successor = current(targetGeneration);
        if (!successor && !item.successor) {
          response
            .writeHead(202, { "Content-Type": "application/json", "Cache-Control": "no-store" })
            .end(JSON.stringify({ pending: true }));
          return;
        }
        const proved = successor && (await proveBackend(grant, successor.generation, successor.port));
        // A replacement can register while the original backend proof is in
        // flight. Let the browser resolve the newly bound first successor on
        // its next poll, rather than turning a healthy handoff into a 410.
        if (!stopped && item.expires > Date.now() && targetGeneration !== (item.successor ?? item.from)) {
          response
            .writeHead(202, { "Content-Type": "application/json", "Cache-Control": "no-store" })
            .end(JSON.stringify({ pending: true }));
          return;
        }
        if (
          !successor ||
          successor.grant.run_id !== grant.run_id ||
          !proved ||
          stopped ||
          current(targetGeneration) !== successor ||
          item.expires <= Date.now()
        ) {
          fail(response, 410);
          return;
        }
        response
          .writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" })
          .end(JSON.stringify({ path: `/s/${successor.generation}/` }));
        return;
      }
      const route = matchRoute(request);
      if (route) {
        const session = current(route[1]);
        if (!session) {
          fail(response, 410);
          return;
        }
        if (!route[2]) {
          response.writeHead(308, { Location: `/s/${route[1]}/`, "Cache-Control": "no-store" }).end();
          return;
        }
        if (!(await proveBackend(session.grant, session.generation, session.port))) {
          retire(session.generation);
          fail(response, 410);
          return;
        }
        if (stopped || current(session.generation) !== session || response.destroyed) {
          fail(response, 410);
          return;
        }
        const upstream = http.request(
          {
            host: session.grant.backendHost,
            port: session.port,
            path: route[2],
            method: request.method,
            headers: backendHeaders(request, session),
            agent: false,
          },
          (result) => {
            const headers = { ...result.headers };
            delete headers["set-cookie"];
            delete headers.connection;
            response.writeHead(result.statusCode ?? 502, { ...headers, "Cache-Control": "no-store" });
            result.on("error", () => response.destroy());
            result.pipe(response);
          },
        );
        upstream.setTimeout(30000, () => upstream.destroy());
        upstream.on("error", () => {
          if (!response.headersSent) fail(response, 502);
          else response.destroy();
        });
        response.once("close", () => upstream.destroy());
        request.pipe(upstream);
        return;
      }
      if (!["GET", "HEAD"].includes(request.method ?? "")) {
        fail(response, 405);
        return;
      }
      if (pathname === "/") {
        response.writeHead(302, { Location: "/sessions/", "Cache-Control": "no-store" }).end();
        return;
      }
      if (pathname === "/api/sessions") {
        const items = [...sessions.keys()]
          .map(current)
          .filter((s): s is Session => Boolean(s))
          .map((s) => ({
            label: s.grant.label,
            generation: s.generation,
            path: `/s/${s.generation}/`,
            since: s.since,
          }));
        response
          .writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" })
          .end(JSON.stringify({ sessions: items }));
        return;
      }
      const asset =
        pathname === "/sessions/"
          ? ["text/html", portalHtml]
          : pathname === "/hub.js"
            ? ["text/javascript", portalJs]
            : pathname === "/hub.css"
              ? ["text/css", portalCss]
              : undefined;
      if (!asset) {
        fail(response, pathname?.startsWith("/s/") ? 410 : 404);
        return;
      }
      response
        .writeHead(200, {
          "Content-Type": `${asset[0]}; charset=utf-8`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
          "Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
        })
        .end(request.method === "HEAD" ? undefined : asset[1]);
    } catch {
      if (!response.headersSent) fail(response, 500);
      else response.destroy();
    }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => connections.delete(socket));
  });
  const rejectUpgrade = (socket: Duplex, code: number) => {
    const timer = setTimeout(() => socket.destroy(), 500);
    timer.unref();
    socket.once("close", () => clearTimeout(timer));
    socket.end(`HTTP/1.1 ${code} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
  };
  server.on("upgrade", async (request, socket, head) => {
    try {
      if (!allowedBrowser(request, true)) {
        rejectUpgrade(socket, 403);
        return;
      }
      const route = matchRoute(request);
      const session = route && route[2] === "/ws" ? current(route[1]) : undefined;
      if (
        !session ||
        !(await proveBackend(session.grant, session.generation, session.port)) ||
        stopped ||
        current(session.generation) !== session
      ) {
        rejectUpgrade(socket, 410);
        return;
      }
      const host =
        net.isIP(session.grant.backendHost) === 6 ? `[${session.grant.backendHost}]` : session.grant.backendHost;
      const upstream = new WebSocket(`ws://${host}:${session.port}/ws`, {
        headers: backendHeaders(request, session),
        handshakeTimeout: 3000,
        maxPayload: 16 * 1024 * 1024,
      });
      webSockets.set(upstream, session.generation);
      socket.once("close", () => upstream.terminate());
      const handshakeError = () => {
        if (!socket.destroyed) rejectUpgrade(socket, 502);
      };
      upstream.once("error", handshakeError);
      upstream.once("close", () => webSockets.delete(upstream));
      upstream.once("open", () => {
        upstream.removeListener("error", handshakeError);
        upstream.on("error", () => socket.destroy());
        if (stopped || current(session.generation) !== session || socket.destroyed) {
          upstream.terminate();
          socket.destroy();
          return;
        }
        wss.handleUpgrade(request, socket, head, (client) => {
          webSockets.set(client, session.generation);
          const forward = (from: WebSocket, to: WebSocket) => {
            from.on("message", (data, binary) => {
              if (from === upstream && !binary) {
                try {
                  const value = JSON.parse(data.toString());
                  // Reserve this one Hub transport event. Ordinary Pi events
                  // still pass through byte-for-byte, including unknown ones.
                  if (value?.type === "event" && value.event === "hub_route") return;
                } catch {
                  // Non-JSON payloads retain their existing transport behavior.
                }
              }
              if (to.readyState !== WebSocket.OPEN) return;
              if (to.bufferedAmount > 8 * 1024 * 1024) {
                from.terminate();
                to.terminate();
                return;
              }
              to.send(data, { binary });
            });
            from.once("close", () => {
              webSockets.delete(from);
              to.terminate();
            });
            from.on("error", () => to.terminate());
          };
          forward(client, upstream);
          forward(upstream, client);
          pruneHandoffs();
          if (handoffs.size < 512) {
            const token = randomBytes(24).toString("hex");
            const item: Handoff = { grant: session.grant, from: session.generation, expires: Infinity };
            handoffs.set(token, item);
            client.once("close", () => {
              item.expires = Date.now() + 45_000;
            });
            client.send(
              JSON.stringify({
                type: "event",
                event: "hub_route",
                payload: { generation: session.generation, token },
              }),
            );
          }
        });
      });
    } catch {
      rejectUpgrade(socket, 502);
    }
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  const listen = (target: http.Server | net.Server, address: number | string, host?: string) =>
    new Promise<void>((resolve, reject) => {
      target.once("error", reject);
      const ready = () => {
        target.removeListener("error", reject);
        resolve();
      };
      if (typeof address === "string") target.listen(address, ready);
      else target.listen(address, host, ready);
    });
  try {
    await listen(registry, config.socketPath);
    chmodSync(config.socketPath, 0o600);
    await listen(server, config.port, config.host);
    const port = (server.address() as net.AddressInfo).port;
    url = `http://${config.host === "::1" ? "[::1]" : config.host}:${port}/`;
  } catch (error) {
    stopped = true;
    for (const peer of peers) peer.destroy();
    registry.close();
    server.close();
    throw error;
  }
  const sweep = setInterval(
    () => {
      for (const id of sessions.keys()) current(id);
      pruneHandoffs();
    },
    Math.min(1000, config.leaseMs),
  );
  sweep.unref();
  let closing: Promise<void> | undefined;
  return {
    url,
    socketPath: config.socketPath,
    close() {
      if (closing) return closing;
      stopped = true;
      handoffs.clear();
      clearInterval(sweep);
      for (const id of sessions.keys()) retire(id);
      for (const peer of peers) peer.destroy();
      for (const connection of connections) connection.destroy();
      server.closeAllConnections();
      closing = Promise.all([
        new Promise<void>((resolve) => server.close(() => resolve())),
        new Promise<void>((resolve) => registry.close(() => resolve())),
        new Promise<void>((resolve) => wss.close(() => resolve())),
        pending,
      ]).then(() => {});
      return closing;
    },
  };
}
