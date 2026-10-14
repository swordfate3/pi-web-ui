import { type RemotePlan, validateRemotePlan } from "../../../../extensions/remote-access/plan";

export type DeploymentMaterial = { name: string; content: string };

export function buildRemoteMaterials(input: RemotePlan, managerSource: string): DeploymentMaterial[] {
  const plan = validateRemotePlan(input);
  const files = [{ name: "connection-plan.json", content: `${JSON.stringify(plan, null, 2)}\n` }];
  const launch = `#!/usr/bin/env bash\nset -euo pipefail\n# Explicitly launch a NEW Pi process. Does not modify settings.json or pirun.\n# LAN mode has no built-in authentication: trusted networks only.\nexport PI_WEB_UI_HOST=${plan.mode === "lan" ? "0.0.0.0" : "127.0.0.1"}\nexport PI_WEB_UI_PORT=${plan.localPort}\nexec pi "$@"\n`;
  if (plan.mode !== "remote") {
    return [
      ...files,
      { name: "launch-pi.sh", content: launch },
      {
        name: "README.txt",
        content:
          plan.mode === "lan"
            ? "Trusted LAN only. No password/TLS is provided by Pi. Do not expose this listener to the internet. Review your host firewall. Launch with bash launch-pi.sh, then use the listener IP/port shown in Pi. No firewall changes are performed.\n"
            : "Local access only. Run bash launch-pi.sh in your project. Existing Pi settings are not changed. Use the actual listener port printed by Pi (occupied ports may advance).\n",
      },
    ];
  }
  const source = managerSource.replace("PLAN = None", `PLAN = json.loads(${JSON.stringify(JSON.stringify(plan))})`);
  files.push({ name: "gateway.py", content: source });
  if (plan.deployment === "new" && plan.environment === "linux") {
    files.push({
      name: "connect.sh",
      content: `#!/usr/bin/env bash\nset -euo pipefail\n# Run on the machine that hosts this exact Pi listener (not on the gateway).\n# Pi must listen on 127.0.0.1:${plan.localPort}. If Pi advances ports, regenerate this file.\n# Requires an OpenSSH client and your OWN server login/key; no key is bundled.\n# Remote forwarding must be allowed. Keep GatewayPorts=no on the server.\nexec ssh -N -T -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \\\n  -p ${plan.sshPort} -R 127.0.0.1:${plan.remotePort}:127.0.0.1:${plan.localPort} \\\n  ${plan.sshUser}@${plan.server}\n`,
    });
  }
  files.push({ name: "README.txt", content: remoteInstructions(plan) });
  return files;
}

function remoteInstructions(plan: RemotePlan): string {
  const intro = `Pi Web remote access — generated, PENDING EXECUTION (not deployed/verified)\nPhone entry: ${plan.publicUrl}\nAuthentication authority: Caddy on ${plan.server}; SSH user ${plan.sshUser} is NOT the web account.\nNo password/key is in these files. Do not paste passwords into Pi or chat.\n\n`;
  const management = `LOGIN / FORGOTTEN PASSWORD (independent of web login)\nOn your server, use Python 3 + Caddy 2.8+ (basic_auth). Specify real paths; none are guessed.\npython3 gateway.py change --site-file /path/to/dedicated-site.caddy --main-config /path/to/main/Caddyfile\npython3 gateway.py recover --site-file /path/to/dedicated-site.caddy --main-config /path/to/main/Caddyfile\nFor Docker Caddy add --docker-container YOUR_CADDY_CONTAINER; --site-file is the server-host path, --main-config is the container-visible path. Python runs on the server host, not in Pi Docker. Mount the whole config DIRECTORY, not an individual site file: atomic replacement must be visible to Caddy.\nSpecify the exact existing account to replace. A rename removes it unless you explicitly add --keep-old. Other accounts are preserved. Only a dedicated, unquoted single-site file with one direct basic_auth block and a simple final proxy is supported; shared files/complex matchers/imported auth/extra handler chains are refused. Authentication and the generated Origin guard must execute before proxying; global order overrides or earlier shared routes must not bypass them. Backups and lock files must NOT match your main config import glob (use import *.caddy, not import *).\nTargets: ONLY the selected site file, its private backup/maintenance lock and a temporary sibling file. Full config and effective handler ordering are validated, then Caddy is reloaded (all sites in that Caddy process). Failed validation/reload restores the original file; a rollback reload failure requires administrator inspection. Run with sufficient file/Caddy permissions; review before using sudo. Do not use with other config editors concurrently.\n\nVERIFY from a trusted HTTPS-capable client after the tunnel/Pi are live:\npython3 gateway.py verify\nEnter the web account/password interactively. It checks anonymous HTTP 401 and authenticated HTTP 200 using valid TLS, no redirects. This is NOT a WebSocket/session-lease test. Also open the phone entry, verify chat/WS, and verify the old account/password no longer works (unless explicitly retained). Browser-cached login may require a private window. Credential changes affect every session sharing this gateway.\n\n`;
  if (plan.deployment === "existing")
    return (
      intro +
      `EXISTING GATEWAY — no deployment/password change is performed\nUse the existing gateway's ACTUAL session URL; do not guess a /s/ generation. Keep existing authentication. Set PI_WEB_UI_PUBLIC_URL only for a verified single-session address, or configure native registration through the compatible registry.\nMulti-session registration needs PI_WEB_UI_REGISTRY_SOCKET + PI_WEB_UI_REGISTRY_CREDENTIAL_FILE, a protected per-run credential issued by your existing router, and a fresh generation URL. Native registration and source-injected adapters must not both be enabled.\nDocker requires the registry socket/credential and path mounts at CONTAINER-visible paths before starting Pi. Reload cannot add mounts; review and recreate only the affected container yourself. No WSL dependency is added by this extension. Registry/router installation is not included.\n\n` +
      management
    );
  if (plan.environment !== "linux")
    return (
      intro +
      "NEW GATEWAY INSTALLATION IS NOT SUPPORTED for this selected environment. The local wizard works without WSL, but server setup/auto-start templates target Linux/OpenSSH/Caddy. No executable deployment is generated.\n\n" +
      management
    );
  return (
    intro +
    `NEW SINGLE-SESSION DEPLOYMENT (not a multi-session router)\n1. On a Linux server, install OpenSSH server, Python 3 and Caddy 2.8+ using their official instructions. This bundle does not install packages or modify firewall/sshd. Domain ${plan.domain} must resolve to the server. Only HTTPS ports 80/443 should be reachable publicly; ${plan.remotePort} stays LOOPBACK only. Never expose raw Pi.\n2. Prepare a running Caddy main config that imports a dedicated site file (e.g. import sites/*.caddy). The site file must not exist yet. Add that import yourself after reviewing the shared config. Ensure Caddy can read the new file (mode 0640); choose an appropriate config directory/group. For a new dedicated Caddy service use --main-config equal to --site-file; the Caddy admin endpoint must already be running for reload. Caddy's admin endpoint must remain loopback-only.\n3. On that server, review and run:\npython3 gateway.py setup --site-file /path/to/sites/pi.caddy --main-config /path/to/main/Caddyfile\nYou choose BOTH the web username and a password in the terminal, with confirmation. There are no defaults. Caddy stores only a bcrypt hash. Config is backed up/validated/reloaded; failure rolls back. Do not use broad import * globs that might load backup/lock files.\n4. On the machine hosting Pi, launch Pi loopback-only at the desired port (current port ${plan.localPort}). Review then run bash connect.sh. Keep it running; closing it ends access. OpenSSH verifies the host key interactively. No private key is bundled/mounted into Pi. If port ${plan.remotePort} is occupied on the server, choose another and regenerate/reconfigure; never replace another tunnel.\n5. Open ${plan.publicUrl} in the phone browser, enter your web login, then verify HTTP/assets/WebSocket. Runtime-generated session identities and model/tool content never go into deployment files.\nNo automatic service install is supplied. Pi and the tunnel must remain running. Multiple Pi sessions require separate domains/ports or an existing compatible router; no shared router is silently installed.\n\n` +
    management
  );
}
