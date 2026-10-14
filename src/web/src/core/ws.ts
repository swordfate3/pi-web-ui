import { webRoute } from "./connection-path";

export const wsUrl = (port?: number, pageUrl = location.href) => {
  const url = new URL(pageUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (port !== undefined) url.port = String(port);
  url.pathname = webRoute("ws", url.pathname);
  url.search = "";
  url.hash = "";
  return url.href;
};
