import type { ChangeEvent } from "react";
import { useLanguage } from "../../core/i18n";
import {
  WHALE_ASSET_SLOTS,
  type WhaleAssetErrorCode,
  type WhaleAssetSlot,
  type WhaleAssetsState,
} from "../../core/whale-assets";

const slots: Record<WhaleAssetSlot, { en: string; "zh-CN": string }> = {
  idle: { en: "Idle", "zh-CN": "待机" },
  thinking: { en: "Thinking", "zh-CN": "思考" },
  tool: { en: "Using a tool", "zh-CN": "工具工作" },
  success: { en: "Done", "zh-CN": "完成" },
  pat: { en: "Head pat", "zh-CN": "摸摸头" },
};

const errorMessages: Record<WhaleAssetErrorCode, { en: string; "zh-CN": string }> = {
  "unsupported-file": {
    en: "Choose a PNG, WebP or GIF image.",
    "zh-CN": "请选择 PNG、WebP 或 GIF 图片。",
  },
  "file-too-large": { en: "Each image must be no larger than 2 MiB.", "zh-CN": "每张图片不能超过 2 MiB。" },
  "invalid-signature": {
    en: "The file is not a valid PNG, WebP or GIF image.",
    "zh-CN": "文件内容不是有效的 PNG、WebP 或 GIF 图片。",
  },
  "mime-mismatch": { en: "The file type does not match its image data.", "zh-CN": "文件类型与图片内容不匹配。" },
  "invalid-dimensions": {
    en: "Image dimensions must be between 1 and 2048 pixels on each side.",
    "zh-CN": "图片宽高必须在 1 至 2048 像素之间。",
  },
  "decoder-unavailable": {
    en: "This browser cannot verify images; no image was imported.",
    "zh-CN": "当前浏览器无法校验图片，未导入素材。",
  },
  "decode-failed": {
    en: "The image could not be decoded; no image was imported.",
    "zh-CN": "图片无法解码，未导入素材。",
  },
  "read-unavailable": {
    en: "Local storage could not be read. You can still use the text/emoji fallback or import an image for this page only.",
    "zh-CN": "无法读取本地存储。仍可使用文字/表情回退，或导入仅本页临时可用的图片。",
  },
  "persistence-unavailable": {
    en: "This image is available for this page only; the browser could not save it locally.",
    "zh-CN": "这张图片仅在当前页面临时可用；浏览器无法将其保存到本地。",
  },
  "clear-unavailable": {
    en: "Images were cleared from this page, but the browser could not confirm clearing saved data.",
    "zh-CN": "图片已从当前页面清除，但浏览器无法确认已清除保存的数据。",
  },
};

export function WhaleAssetSettings({ assets }: { assets: WhaleAssetsState }) {
  const language = useLanguage();
  const zh = language === "zh-CN";
  const statusText = assets.error
    ? errorMessages[assets.error as WhaleAssetErrorCode][language]
    : assets.persistent
      ? zh
        ? "素材仅保存在此浏览器的本地存储中。"
        : "Assets are saved locally in this browser."
      : zh
        ? "本地素材存储状态未知。"
        : "Local asset storage status is unknown.";
  const onSelect = (slot: WhaleAssetSlot, event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file) void assets.importAsset(slot, file).catch(() => undefined);
  };

  return (
    <section aria-label={zh ? "本地鲸鱼娘素材" : "Local whale artwork"} className="space-y-3 rounded-md border p-3">
      <h4 className="font-medium text-sm">{zh ? "本地鲸鱼娘素材" : "Local whale artwork"}</h4>
      <p className="text-muted-foreground text-xs">
        {zh
          ? "支持 PNG/WebP/GIF，每张不超过 2 MiB、宽高不超过 2048 像素。GIF 保留原动画；减少动画时显示静态首帧，下方缩略图始终静态。仅保存在此浏览器和当前站点设备；同源的不同 Hub 路径共享，不随 Pi 会话或模型同步，也不会上传。静态素材可选「02桌宠」，动画可选「04动态GIF」中的 idle.gif 等。只导入待机图即可，其他状态会回退到待机图。"
          : "PNG/WebP/GIF, up to 2 MiB and 2048 × 2048 pixels each. GIFs keep their animation; reduced motion uses a still first frame. Thumbnails below are always still. Stored only in this browser on this device: paths on the same origin share assets. Nothing is synced with Pi or a model, or uploaded. Choose still artwork from “02桌宠” or animations such as idle.gif from “04动态GIF”. Idle is enough; other states fall back to idle."}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {WHALE_ASSET_SLOTS.map((slot) => (
          <div className="flex min-w-0 items-center gap-3" key={slot}>
            {assets.previewImages[slot] ? (
              <img
                alt=""
                aria-hidden="true"
                className="h-12 w-12 shrink-0 rounded object-contain"
                src={assets.previewImages[slot]}
              />
            ) : (
              <span aria-hidden="true" className="flex h-12 w-12 shrink-0 items-center justify-center rounded bg-muted">
                🐳
              </span>
            )}
            <label className="min-w-0 text-sm">
              <span className="mb-1 block font-medium">{slots[slot][language]}</span>
              <input
                accept="image/png,image/webp,image/gif"
                aria-label={zh ? `导入${slots[slot][language]}图片` : `Import ${slots[slot].en} image`}
                className="block w-full text-xs file:mr-2 file:rounded file:border file:px-2 file:py-1"
                data-testid={`whale-asset-${slot}`}
                onChange={(event) => onSelect(slot, event)}
                type="file"
              />
            </label>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button
          className="rounded-md border px-3 py-2 text-sm disabled:opacity-50"
          data-testid="whale-assets-clear"
          disabled={assets.busy}
          onClick={() => void assets.clearAssets()}
          type="button"
        >
          {zh ? "清除全部本地素材" : "Clear all local artwork"}
        </button>
        {assets.busy && (
          <span className="text-muted-foreground text-xs">{zh ? "正在校验或保存…" : "Validating or saving…"}</span>
        )}
      </div>
      <p
        aria-live={assets.error ? "assertive" : "polite"}
        className="text-muted-foreground text-xs"
        data-testid="whale-assets-status"
        role={assets.error ? "alert" : "status"}
      >
        {statusText}
        {assets.temporarySlots.length > 0 && (
          <span className="block">
            {zh ? "仅本页可用：" : "This page only: "}
            {assets.temporarySlots.map((slot) => slots[slot][language]).join("、")}
          </span>
        )}
      </p>
    </section>
  );
}
