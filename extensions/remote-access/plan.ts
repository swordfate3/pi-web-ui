/** Shared browser-safe schema. Never accept secrets or arbitrary command/path fields. */
export type RemotePlan = {
  version: 1;
  mode: "local" | "lan" | "remote";
  deployment: "new" | "existing";
  environment: "linux" | "other";
  server: string;
  sshUser: string;
  sshPort: number;
  domain: string;
  localPort: number;
  remotePort: number;
  publicUrl: string;
};

const fields = [
  "version",
  "mode",
  "deployment",
  "environment",
  "server",
  "sshUser",
  "sshPort",
  "domain",
  "localPort",
  "remotePort",
  "publicUrl",
];
const hostname = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

export function validateRemotePlan(input: unknown): RemotePlan {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid deployment plan");
  const plan = input as Record<string, unknown>;
  if (Object.keys(plan).some((key) => !fields.includes(key)) || fields.some((key) => !(key in plan))) {
    throw new Error("Unknown or missing deployment fields; credentials are not accepted");
  }
  if (
    plan.version !== 1 ||
    !["local", "lan", "remote"].includes(String(plan.mode)) ||
    !["new", "existing"].includes(String(plan.deployment)) ||
    !["linux", "other"].includes(String(plan.environment))
  ) {
    throw new Error("Invalid deployment mode");
  }
  for (const key of ["sshPort", "localPort", "remotePort"]) {
    if (!Number.isInteger(plan[key]) || Number(plan[key]) < 1 || Number(plan[key]) > 65535)
      throw new Error("Ports must be integers from 1 to 65535");
  }
  for (const key of ["server", "domain"]) {
    if (typeof plan[key] !== "string" || (plan[key] !== "" && !hostname.test(plan[key])))
      throw new Error("Use a plain hostname or IPv4 address");
  }
  if (typeof plan.sshUser !== "string" || (plan.sshUser !== "" && !/^[a-z_][a-z0-9_-]{0,31}$/.test(plan.sshUser)))
    throw new Error("Invalid SSH username");
  if (typeof plan.publicUrl !== "string") throw new Error("Invalid public URL");
  if (plan.publicUrl) {
    let url: URL;
    try {
      url = new URL(plan.publicUrl);
    } catch {
      throw new Error("Invalid public URL");
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !hostname.test(url.hostname) ||
      !/^https:\/\/[a-z0-9.-]+(?::\d+)?\/(?:[a-zA-Z0-9_-]+\/)*$/.test(plan.publicUrl)
    )
      throw new Error("Use an HTTPS URL ending in /, without credentials or traversal");
    if (plan.domain && url.hostname !== plan.domain) throw new Error("Public URL must use the selected domain");
  }
  if (plan.mode === "remote" && (!plan.server || !plan.domain || !plan.sshUser || !plan.publicUrl))
    throw new Error("Complete the remote server, SSH user, domain and public URL");
  if (plan.mode === "remote" && plan.deployment === "new") {
    const url = new URL(String(plan.publicUrl));
    if (url.pathname !== "/" || url.port)
      throw new Error("New single-session deployments use the domain root on HTTPS port 443");
  }
  return Object.fromEntries(fields.map((key) => [key, plan[key]])) as RemotePlan;
}

export function defaultRemotePlan(): RemotePlan {
  return {
    version: 1,
    mode: "local",
    deployment: "new",
    environment: "linux",
    server: "",
    sshUser: "",
    sshPort: 22,
    domain: "",
    localPort: 3001,
    remotePort: 13001,
    publicUrl: "",
  };
}
