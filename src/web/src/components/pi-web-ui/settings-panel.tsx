import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { setLanguage, t, themeLabel, thinkingLabel, useLanguage } from "../../core/i18n";

import type { ThemeMode } from "../../core/types";
import { Modal } from "./modal";

export function SettingsPanel(props: {
  authConfigured: boolean;
  authEnabled: boolean;
  autoCompaction: boolean;
  onClose: () => void;
  onRemoteAccess: (tab: "access" | "login") => void;
  onRenameSession: (name: string) => void;
  onSetAutoCompaction: (enabled: boolean) => Promise<void>;
  onSetTheme: (theme: ThemeMode) => void;
  onSetThinking: (level: string) => Promise<void>;
  onToggleAuth: () => void;
  sessionName: string;
  showThinking: boolean;
  setShowThinking: (show: boolean) => void;
  themeMode: ThemeMode;
  thinkingLevel: string;
  availableThinkingLevels: string[];
}) {
  const language = useLanguage();
  const [draftName, setDraftName] = useState(props.sessionName);

  return (
    <Modal onClose={props.onClose} title={t("Settings")}>
      <div className="space-y-5">
        <section className="space-y-2">
          <h3 className="font-medium text-sm">{t("Phone connection")}</h3>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" onClick={() => props.onRemoteAccess("access")}>
              {t("Remote access")}
            </Button>
            <Button variant="outline" onClick={() => props.onRemoteAccess("login")}>
              {t("Login management")}
            </Button>
          </div>
        </section>
        <section className="space-y-2" aria-label={t("Language")}>
          <h3 className="font-medium text-sm">{t("Language")}</h3>
          <div className="grid grid-cols-2 gap-2">
            {(["en", "zh-CN"] as const).map((option) => (
              <Button
                key={option}
                type="button"
                data-testid={`language-${option}`}
                aria-pressed={language === option}
                onClick={() => setLanguage(option)}
                variant={language === option ? "default" : "outline"}
              >
                {option === "en" ? "English" : "简体中文"}
              </Button>
            ))}
          </div>
        </section>
        <section className="space-y-2">
          <h3 className="font-medium text-sm">{t("Appearance")}</h3>
          <div className="grid grid-cols-3 gap-2">
            {(["system", "light", "dark"] as ThemeMode[]).map((theme) => (
              <Button
                key={theme}
                onClick={() => props.onSetTheme(theme)}
                type="button"
                variant={props.themeMode === theme ? "default" : "outline"}
              >
                {themeLabel(theme)}
              </Button>
            ))}
          </div>
        </section>

        <section className="space-y-2">
          <h3 className="font-medium text-sm">{t("Session")}</h3>
          <div className="flex gap-2">
            <Input
              aria-label={t("Session name")}
              onChange={(event) => setDraftName(event.target.value)}
              value={draftName}
            />
            <Button onClick={() => props.onRenameSession(draftName)} type="button">
              {t("Rename")}
            </Button>
          </div>
        </section>

        <section className="space-y-2">
          <h3 className="font-medium text-sm">{t("Agent")}</h3>
          <SettingRow
            label={t("Auto-compaction")}
            onClick={() => props.onSetAutoCompaction(!props.autoCompaction)}
            value={props.autoCompaction}
          />
          <div className="flex flex-wrap gap-2">
            {props.availableThinkingLevels.map((level) => (
              <Button
                key={level}
                onClick={() => props.onSetThinking(level)}
                size="sm"
                type="button"
                variant={props.thinkingLevel === level ? "default" : "outline"}
              >
                {thinkingLabel(level)}
              </Button>
            ))}
          </div>
        </section>

        <section className="space-y-2">
          <h3 className="font-medium text-sm">{t("Display")}</h3>
          <SettingRow
            label={t("Show thinking")}
            onClick={() => props.setShowThinking(!props.showThinking)}
            value={props.showThinking}
          />
        </section>

        {props.authConfigured && (
          <section className="space-y-2">
            <h3 className="font-medium text-sm">{t("Authentication")}</h3>
            <SettingRow label={t("Require login")} onClick={props.onToggleAuth} value={props.authEnabled} />
          </section>
        )}
      </div>
    </Modal>
  );
}

function SettingRow({ label, onClick, value }: { label: string; onClick: () => void; value: boolean }) {
  useLanguage();
  return (
    <button
      className="flex w-full items-center justify-between rounded-md border px-3 py-2"
      onClick={onClick}
      type="button"
    >
      <span className="text-sm">{label}</span>
      <span
        className={cn(
          "rounded-full px-2 py-0.5 text-xs",
          value ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
        )}
      >
        {value ? t("On") : t("Off")}
      </span>
    </button>
  );
}
