import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { dialogLabel, t, useLanguage } from "../../core/i18n";

import type { ExtensionDialog } from "../../core/types";
import { Modal } from "./modal";

export function ExtensionDialogView({
  dialog,
  onCancel,
  onRespond,
}: {
  dialog: ExtensionDialog;
  onCancel: () => void;
  onRespond: (response: Record<string, unknown>) => void;
}) {
  useLanguage();
  const [value, setValue] = useState(dialog.prefill || "");

  if (dialog.method === "notify") {
    return (
      <Modal
        onClose={onCancel}
        title={dialog.title || (dialog.notifyType ? dialogLabel(dialog.notifyType) : t("Notification"))}
      >
        <p className="text-sm">{dialog.message}</p>
        <div className="mt-4 flex justify-end">
          <Button onClick={onCancel} type="button">
            {t("OK")}
          </Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal onClose={onCancel} title={dialog.title || dialogLabel(dialog.method)}>
      {dialog.message && <p className="mb-3 text-muted-foreground text-sm">{dialog.message}</p>}
      {dialog.method === "select" && (
        <div className="space-y-2">
          {(dialog.options || []).map((option) => (
            <Button
              className="w-full justify-start"
              key={option}
              onClick={() => onRespond({ value: option })}
              type="button"
              variant="outline"
            >
              {option}
            </Button>
          ))}
        </div>
      )}
      {dialog.method === "confirm" && (
        <div className="flex justify-end gap-2">
          <Button onClick={() => onRespond({ confirmed: false })} type="button" variant="outline">
            {t("No")}
          </Button>
          <Button onClick={() => onRespond({ confirmed: true })} type="button">
            {t("Yes")}
          </Button>
        </div>
      )}
      {dialog.method === "input" && (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            onRespond(value.trim() ? { value: value.trim() } : { cancelled: true });
          }}
        >
          <Input
            autoFocus
            onChange={(event) => setValue(event.target.value)}
            placeholder={dialog.placeholder}
            value={value}
          />
          <div className="flex justify-end gap-2">
            <Button onClick={onCancel} type="button" variant="outline">
              {t("Cancel")}
            </Button>
            <Button type="submit">{t("Submit")}</Button>
          </div>
        </form>
      )}
      {dialog.method === "editor" && (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            onRespond(value ? { value } : { cancelled: true });
          }}
        >
          <Textarea autoFocus className="min-h-40" onChange={(event) => setValue(event.target.value)} value={value} />
          <div className="flex justify-end gap-2">
            <Button onClick={onCancel} type="button" variant="outline">
              {t("Cancel")}
            </Button>
            <Button type="submit">{t("Save")}</Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
