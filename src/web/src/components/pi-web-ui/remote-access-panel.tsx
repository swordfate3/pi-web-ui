import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import gatewaySource from "../../../../../extensions/remote-access/gateway.py?raw";
import { defaultRemotePlan, type RemotePlan, validateRemotePlan } from "../../../../../extensions/remote-access/plan";
import { connectionLabel, t, useLanguage } from "../../core/i18n";
import { buildRemoteMaterials, type DeploymentMaterial } from "../../core/remote-access-materials";
import { readPreference, writePreference } from "../../core/storage";
import { usePiWebUiStore } from "../../core/store";
import type { WebConnectionInfo } from "../../core/types";
import { Modal } from "./modal";

const PLAN_KEY = "pi-web-ui-remote-plan-v1";
function initialPlan(): RemotePlan {
  try {
    const stored = readPreference(PLAN_KEY);
    if (stored) return validateRemotePlan(JSON.parse(stored));
  } catch {
    /* Invalid/stale drafts are not executed. */
  }
  return defaultRemotePlan();
}

export function RemoteAccessPanel({
  initialTab = "access",
  onClose,
}: {
  initialTab?: "access" | "login";
  onClose: () => void;
}) {
  useLanguage();
  const connection = usePiWebUiStore((state) => state.connection);
  const getWebConnection = usePiWebUiStore((state) => state.getWebConnection);
  const [tab, setTab] = useState(initialTab);
  const [plan, setPlan] = useState(initialPlan);
  const [materials, setMaterials] = useState<DeploymentMaterial[]>([]);
  const [selected, setSelected] = useState("README.txt");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [runtime, setRuntime] = useState<WebConnectionInfo | null>(null);
  useEffect(() => {
    if (connection !== "connected") return;
    let active = true;
    getWebConnection()
      .then((status) => {
        if (!active) return;
        setRuntime(status);
        if (!readPreference(PLAN_KEY)) setPlan((previous) => ({ ...previous, localPort: status.port }));
      })
      .catch(() => {
        /* Older extension: show unavailable rather than inventing a port. */
      });
    return () => {
      active = false;
    };
  }, [connection, getWebConnection]);

  function edit<K extends keyof RemotePlan>(field: K, value: RemotePlan[K]) {
    setPlan((previous) => ({ ...previous, [field]: value }));
    setMaterials([]);
    setError("");
    setSaved(false);
  }
  function generate() {
    try {
      const result = buildRemoteMaterials(plan, gatewaySource);
      setMaterials(result);
      setSelected("README.txt");
      setError("");
    } catch {
      setError(
        t(
          "Check the server, SSH user, domain, HTTPS URL and integer ports. No credentials or command text are accepted.",
        ),
      );
    }
  }
  function saveDraft() {
    try {
      const draft = JSON.stringify(validateRemotePlan(plan));
      writePreference(PLAN_KEY, draft);
      if (readPreference(PLAN_KEY) !== draft) {
        setSaved(false);
        setError(t("Browser storage is unavailable. The draft was not saved; download the materials instead."));
        return;
      }
      setSaved(true);
      setError("");
    } catch {
      setError(t("Complete and validate the nonsecret fields before saving."));
    }
  }
  function download() {
    const material = materials.find((item) => item.name === selected);
    if (!material) return;
    const url = URL.createObjectURL(new Blob([material.content], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = material.name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const textField = (key: "server" | "sshUser" | "domain" | "publicUrl", label: string, id: string) => (
    <label className="block space-y-1 text-sm" key={key} htmlFor={id}>
      <span>{label}</span>
      <Input
        id={id}
        data-testid={id}
        autoComplete="off"
        value={plan[key]}
        onChange={(event) => edit(key, event.target.value)}
      />
    </label>
  );
  const portFields: ("localPort" | "sshPort" | "remotePort")[] =
    plan.mode === "remote" ? ["localPort", "sshPort", "remotePort"] : ["localPort"];
  return (
    <Modal onClose={onClose} title={t("Connect your phone to Pi")}>
      <div className="space-y-4" data-testid="remote-access-panel">
        <div className="grid grid-cols-2 gap-2">
          <Button variant={tab === "access" ? "default" : "outline"} onClick={() => setTab("access")}>
            {t("Remote access")}
          </Button>
          <Button variant={tab === "login" ? "default" : "outline"} onClick={() => setTab("login")}>
            {t("Login management")}
          </Button>
        </div>
        <p className="text-muted-foreground text-sm">
          {t("Passwords and SSH keys never belong in this form. Nothing runs on your server automatically.")}
        </p>
        {tab === "access" ? (
          <>
            <label className="block space-y-1 text-sm">
              <span>{t("Access mode")}</span>
              <select
                className="w-full rounded-md border bg-background p-2"
                data-testid="access-mode"
                value={plan.mode}
                onChange={(event) => edit("mode", event.target.value as RemotePlan["mode"])}
              >
                <option value="local">{t("This computer only")}</option>
                <option value="lan">{t("Trusted LAN (no authentication)")}</option>
                <option value="remote">{t("Remote server with HTTPS and login")}</option>
              </select>
            </label>
            {plan.mode === "lan" && (
              <p className="rounded-md border border-amber-500/40 p-3 text-sm">
                {t("LAN access is unauthenticated. Use only a trusted network; never expose raw Pi to the internet.")}
              </p>
            )}
            {plan.mode === "remote" && (
              <>
                <label className="block space-y-1 text-sm">
                  <span>{t("Deployment")}</span>
                  <select
                    className="w-full rounded-md border bg-background p-2"
                    value={plan.deployment}
                    onChange={(event) => edit("deployment", event.target.value as RemotePlan["deployment"])}
                  >
                    <option value="new">{t("New single-session gateway")}</option>
                    <option value="existing">{t("Connect an existing gateway")}</option>
                  </select>
                </label>
                <p className="rounded-md border bg-muted/40 p-3 text-sm">
                  {plan.deployment === "new"
                    ? t(
                        "New deployment supports one Pi process, Linux, OpenSSH and Caddy. No WSL or Docker is required. It does not install a multi-session router.",
                      )
                    : t(
                        "Keep your existing login. Multi-session access requires your compatible registry and container mounts; this wizard does not install that router.",
                      )}
                </p>
                {textField("server", t("Server hostname or IPv4"), "remote-server")}
                {textField("sshUser", t("SSH user (not web login)"), "remote-ssh-user")}
                {textField("domain", t("HTTPS domain"), "remote-domain")}
                {textField("publicUrl", t("Phone entry (HTTPS, ending in /)"), "remote-public-url")}
                <label className="block space-y-1 text-sm">
                  <span>{t("Gateway environment")}</span>
                  <select
                    className="w-full rounded-md border bg-background p-2"
                    value={plan.environment}
                    onChange={(event) => edit("environment", event.target.value as RemotePlan["environment"])}
                  >
                    <option value="linux">Linux / Caddy</option>
                    <option value="other">{t("Other (installation not supported)")}</option>
                  </select>
                </label>
              </>
            )}
            <div className="grid grid-cols-2 gap-3">
              {portFields.map((key) => (
                <label className="block space-y-1 text-sm" key={key} htmlFor={`remote-${key}`}>
                  <span>
                    {key === "localPort"
                      ? t("Pi listener port")
                      : key === "sshPort"
                        ? t("SSH port")
                        : t("Server loopback port")}
                  </span>
                  <Input
                    id={`remote-${key}`}
                    type="number"
                    min={1}
                    max={65535}
                    value={plan[key]}
                    onChange={(event) => edit(key, Number(event.target.value))}
                  />
                </label>
              ))}
            </div>
          </>
        ) : (
          <section className="space-y-3 rounded-md border p-3 text-sm" data-testid="login-management">
            <h3 className="font-medium">{t("Authentication is managed by Caddy, not Pi")}</h3>
            <p>
              {t(
                "First setup asks you to choose a username and confirm a password in your own terminal. There are no default login credentials.",
              )}
            </p>
            <p>
              {t(
                "Change or recover: run gateway.py on the server with the exact site file and full Caddy config. Only one account is replaced; other accounts stay. Rename removes the old account unless --keep-old is explicitly selected.",
              )}
            </p>
            <p>
              {t(
                "Forgot your password? Use server administrator access and the standalone recover command. Web login is not required; authentication is never disabled for recovery.",
              )}
            </p>
            <p className="text-muted-foreground">
              {t(
                "The script backs up, validates and reloads Caddy, and restores the file on failure. Shared gateway login changes can affect every Pi session.",
              )}
            </p>
            <p>
              {t(
                "Generate materials in Remote access first, then download gateway.py and README.txt. Complex/shared Caddy site files are refused for safety.",
              )}
            </p>
            <p>
              {t(
                "An applied script is not a verified login. Run gateway.py verify, test the old login separately, and check chat/WebSocket in the phone browser.",
              )}
            </p>
            <p className="break-all">
              {t("Configured target (not verified)")}: {plan.publicUrl || t("Not configured")}
            </p>
          </section>
        )}
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button data-testid="generate-materials" onClick={generate}>
            {t("Generate materials")}
          </Button>
          <Button variant="outline" onClick={saveDraft}>
            {t("Save nonsecret draft")}
          </Button>
        </div>
        {saved && (
          <p className="text-muted-foreground text-sm">
            {t("Draft saved in this browser. Pi settings and server credentials are unchanged.")}
          </p>
        )}
        {materials.length > 0 && (
          <section className="space-y-3">
            <p data-testid="deployment-status" className="rounded-md border bg-muted/40 p-3 text-sm">
              {t("Pending execution — generated only, not deployed or verified")}
            </p>
            <label className="block space-y-1 text-sm">
              <span>{t("Preview file")}</span>
              <select
                className="w-full rounded-md border bg-background p-2"
                data-testid="material-select"
                value={selected}
                onChange={(event) => setSelected(event.target.value)}
              >
                {materials.map((item) => (
                  <option key={item.name}>{item.name}</option>
                ))}
              </select>
            </label>
            <pre
              data-testid="material-preview"
              className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted p-3 text-xs"
            >
              {materials.find((item) => item.name === selected)?.content}
            </pre>
            <Button variant="outline" data-testid="download-material" onClick={download}>
              {t("Download selected file")}
            </Button>
          </section>
        )}
        <section className="space-y-1 border-t pt-3 text-muted-foreground text-xs">
          <h3 className="font-medium">{t("Current page checks (not a remote deployment test)")}</h3>
          <p>
            HTTP / {t("Static assets")}: {t("This page loaded")}
          </p>
          <p>WebSocket: {connectionLabel(connection)}</p>
          <p>TLS: {location.protocol === "https:" ? "HTTPS" : t("Local HTTP; remote TLS not verified")}</p>
          <p>
            {t("Login")}: {t("External gateway; not verified here")}
          </p>
          <p>
            {t("Session registration")}:{" "}
            {runtime
              ? runtime.registrationConfigured
                ? t("Configured; check actual generation URL and lease with your router")
                : t("No registry configured")
              : t("Unavailable")}
          </p>
          {runtime && (
            <p className="break-all">
              {t("Actual Pi listener")}: {runtime.localUrl}
            </p>
          )}
          <p className="break-all">
            {t("Current browser entry")}: {location.origin}
            {location.pathname}
          </p>
        </section>
        <Button className="w-full" variant="ghost" onClick={onClose}>
          {t("Skip for now")}
        </Button>
      </div>
    </Modal>
  );
}
