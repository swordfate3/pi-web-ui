import { useLanguage } from "../../core/i18n";
import type { WhaleAssetsState } from "../../core/whale-assets";
import { WhaleAssetSettings } from "./whale-asset-settings";

export type WhaleMode = "full" | "compact" | "hidden";
export function WhaleSettings({
  mode,
  onModeChange,
  reduceMotion,
  onReduceMotionChange,
  assets,
}: {
  mode: WhaleMode;
  onModeChange: (mode: WhaleMode) => void;
  reduceMotion: boolean;
  onReduceMotionChange: (value: boolean) => void;
  assets: WhaleAssetsState;
}) {
  const zh = useLanguage() === "zh-CN";
  return (
    <section className="space-y-3 rounded-lg border p-3" aria-label={zh ? "鲸鱼娘" : "Whale companion"}>
      <h3 className="font-medium text-sm">{zh ? "鲸鱼娘 · 网页桌宠" : "Whale companion"}</h3>
      <div className="flex flex-wrap gap-2">
        {(["full", "compact", "hidden"] as const).map((option, index) => (
          <button
            key={option}
            type="button"
            className="rounded-md border px-3 py-2 text-sm aria-pressed:bg-primary aria-pressed:text-primary-foreground"
            aria-pressed={mode === option}
            data-testid={`whale-mode-${option}`}
            onClick={() => onModeChange(option)}
          >
            {(zh ? ["显示立绘", "收起为小入口", "关闭"] : ["Show character", "Compact", "Off"])[index]}
          </button>
        ))}
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={reduceMotion} onChange={(e) => onReduceMotionChange(e.target.checked)} />
        {zh ? "减少桌宠动画（也遵循系统设置）" : "Reduce companion animation (also respects system preference)"}
      </label>
      <p className="text-muted-foreground text-xs">
        {zh
          ? "仅网页内悬浮；点击互动不调用模型、不消耗 Token。关闭后可在这里重新开启。"
          : "Only floats inside this page. Interactions never call a model or use tokens. Re-enable here after closing."}
      </p>
      <WhaleAssetSettings assets={assets} />
    </section>
  );
}
