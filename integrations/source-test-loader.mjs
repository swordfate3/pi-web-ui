// Development-only resolver: source-copy tests use this checkout's dependencies,
// never a production /home/node installation or user agent directory.
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
const dependencyParent = new URL("../package.json", import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@kkkiio/pi-web-ui/interactions/v1") return nextResolve(new URL("../extensions/interactions/client.ts", import.meta.url).href, context);
    if (specifier.startsWith(".") && context.parentURL) {
      for (const candidate of [specifier.endsWith(".js") ? `${specifier.slice(0, -3)}.ts` : `${specifier}.ts`]) {
        const url = new URL(candidate, context.parentURL);
        if (existsSync(url)) return nextResolve(url.href, context);
      }
    }
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (!specifier.startsWith(".") && !specifier.startsWith("/") && error.code === "ERR_MODULE_NOT_FOUND") return nextResolve(specifier, { ...context, parentURL: dependencyParent });
      throw error;
    }
  },
});
