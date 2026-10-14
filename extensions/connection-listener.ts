import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

/** Retry occupied ports without a fixed session-count limit; never outlive stop. */
export function listenWithFallback(
  server: Server,
  options: { host: string; port: number },
  signal: AbortSignal,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 15_000;
    let port = options.port;
    const cleanup = () => {
      server.removeListener("error", failed);
      server.removeListener("listening", listened);
      signal.removeEventListener("abort", aborted);
    };
    const aborted = () => {
      cleanup();
      reject(new Error("Pi Web start aborted"));
    };
    const listened = () => {
      cleanup();
      resolve((server.address() as AddressInfo).port);
    };
    const attempt = () => {
      if (signal.aborted) {
        aborted();
        return;
      }
      server.once("error", failed);
      server.once("listening", listened);
      try {
        server.listen({ port, host: options.host, signal });
      } catch {
        cleanup();
        reject(new Error("Pi Web could not obtain a listening port"));
      }
    };
    const failed = (error: NodeJS.ErrnoException) => {
      server.removeListener("listening", listened);
      if (error.code === "EADDRINUSE" && port < 65535 && Date.now() < deadline && !signal.aborted) {
        port++;
        // Even a failed listen installs Node's signal cleanup on `close`.
        // Complete that lifecycle before retrying instead of accumulating it.
        server.close(() => attempt());
      } else {
        cleanup();
        reject(new Error("Pi Web could not obtain a listening port"));
      }
    };
    signal.addEventListener("abort", aborted, { once: true });
    attempt();
  });
}
