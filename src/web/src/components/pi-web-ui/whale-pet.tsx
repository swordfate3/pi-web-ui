import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLanguage } from "../../core/i18n";
import { usePiWebUiStore } from "../../core/store";
import type { ChatItem, UsageStatsResult, UsageStatsTotals } from "../../core/types";
import {
  clampWhalePosition,
  defaultWhalePosition,
  placeWhaleCard,
  readWhalePosition,
  WHALE_POSITION_STORAGE_KEY,
  type WhalePosition,
  type WhaleViewport,
  writeWhalePosition,
} from "../../core/whale-pet";
import "./whale-pet.css";

export type WhaleMode = "full" | "compact" | "hidden";
export type WhalePetImageState = "idle" | "thinking" | "tool" | "success";
export type WhalePetImages = Partial<Record<WhalePetImageState | "pat", string>>;

type WhaleTranslations = {
  companion: string;
  connectionRequired: string;
  loading: string;
  loadError: string;
  retry: string;
  sessionUsage: string;
  sessionScope: string;
  allBranches: string;
  tokens: string;
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
  total: string;
  requests: string;
  estimatedCost: string;
  knownSubtotal: string;
  unknownCost: string;
  unpriced: string;
  costNote: string;
  truncated: string;
  lastResponse: string;
  noResponse: string;
  models: string;
  responseTokens: string;
  thinking: string;
  working: string;
  success: string;
  disconnected: string;
  idle: string;
  openUsage: string;
  closeCard: string;
  collapse: string;
  hide: string;
  showFull: string;
  showCompact: string;
  drag: string;
  importHint: string;
};

const words: Record<"en" | "zh-CN", WhaleTranslations> = {
  en: {
    companion: "Whale companion",
    connectionRequired: "Connect to Pi to view current session usage.",
    loading: "Loading current session usage…",
    loadError: "Usage could not be loaded.",
    retry: "Retry",
    sessionUsage: "Session usage",
    sessionScope: "Current session · all branches",
    allBranches: "All entries in this session, not all sessions today.",
    tokens: "Tokens",
    input: "Input",
    output: "Output",
    cacheRead: "Cache read",
    cacheWrite: "Cache write",
    total: "Total",
    requests: "Requests",
    estimatedCost: "Estimated cost (USD)",
    knownSubtotal: "Known subtotal",
    unknownCost: "Unknown",
    unpriced: "unpriced requests",
    costNote: "Estimated using rates recorded by Pi; this may differ from your provider's bill.",
    truncated: "Some model labels were grouped or invalid records adjusted; totals include the available usage.",
    lastResponse: "Last response",
    noResponse: "No response yet",
    models: "Models used",
    responseTokens: "tokens",
    thinking: "Thinking",
    working: "Using a tool",
    success: "Done for now",
    disconnected: "Not connected",
    idle: "Ready",
    openUsage: "Open whale and session usage",
    closeCard: "Close usage card",
    collapse: "Collapse whale",
    hide: "Hide whale",
    showFull: "Show full whale",
    showCompact: "Show compact whale",
    drag: "Move whale; use arrow keys to reposition",
    importHint: "Import whale artwork in Settings to replace this emoji.",
  },
  "zh-CN": {
    companion: "鲸鱼娘",
    connectionRequired: "连接 Pi 后可查看当前会话用量。",
    loading: "正在加载当前会话用量…",
    loadError: "无法加载用量。",
    retry: "重试",
    sessionUsage: "会话用量",
    sessionScope: "当前会话 · 全部分支",
    allBranches: "统计当前会话全部条目，不是今天的全部会话。",
    tokens: "Token",
    input: "输入",
    output: "输出",
    cacheRead: "缓存读取",
    cacheWrite: "缓存写入",
    total: "总计",
    requests: "请求数",
    estimatedCost: "估算费用（USD）",
    knownSubtotal: "已知小计",
    unknownCost: "未知",
    unpriced: "次未定价请求",
    costNote: "根据 Pi 记录的费率估算，不一定等同于服务商账单。",
    truncated: "部分模型已合并或异常记录已调整；总量仍包含可用的用量记录。",
    lastResponse: "最近响应",
    noResponse: "暂无响应",
    models: "使用的模型",
    responseTokens: "Token",
    thinking: "思考中",
    working: "正在使用工具",
    success: "暂告一段落",
    disconnected: "未连接",
    idle: "空闲中",
    openUsage: "打开鲸鱼娘和会话用量",
    closeCard: "关闭用量卡片",
    collapse: "收起鲸鱼娘",
    hide: "隐藏鲸鱼娘",
    showFull: "显示完整鲸鱼娘",
    showCompact: "显示紧凑鲸鱼娘",
    drag: "移动鲸鱼娘；可使用方向键调整位置",
    importHint: "可在设置中导入鲸鱼素材来替换这个表情。",
  },
};

const PET_SIZE_DESKTOP = { width: 160, height: 160 };
const PET_SIZE_MOBILE = { width: 112, height: 108 };
const PET_SIZE_COMPACT = { width: 76, height: 76 };
const REFRESH_INTERVAL_MS = 5000;

export function WhalePet({
  mode,
  onModeChange,
  reduceMotion,
  suspended = false,
  images,
  positionResetKey = 0,
}: {
  mode: WhaleMode;
  onModeChange: (mode: WhaleMode) => void;
  reduceMotion: boolean;
  suspended?: boolean;
  images?: WhalePetImages;
  positionResetKey?: number;
}) {
  const language = useLanguage();
  const text = words[language];
  const connection = usePiWebUiStore((state) => state.connection);
  const chatStatus = usePiWebUiStore((state) => state.chatStatus);
  const sessionId = usePiWebUiStore((state) => state.sessionId);
  const runtimeId = usePiWebUiStore((state) => state.runtimeId);
  const sessionActionPending = usePiWebUiStore((state) => state.sessionActionPending);
  const hasActiveTool = usePiWebUiStore((state) => state.items.some(isActiveTool));
  const [cardOpen, setCardOpen] = useState(false);
  const [position, setPosition] = useState<WhalePosition>(() => initialPosition(mode));
  const [cardPosition, setCardPosition] = useState<WhalePosition | null>(null);
  const [cardMaxHeight, setCardMaxHeight] = useState(() =>
    Math.max(64, Math.min(420, getVisibleViewport().height - 24)),
  );
  const [usage, setUsage] = useState<UsageStatsResult | null>(null);
  const [usageError, setUsageError] = useState<{ scope: string; message: string } | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [failedImages, setFailedImages] = useState<Set<string>>(() => new Set());
  const imageSignature = [images?.idle, images?.thinking, images?.tool, images?.success, images?.pat]
    .filter((source): source is string => Boolean(source))
    .join("\u0000");
  const [successFlash, setSuccessFlash] = useState(false);
  const [petPat, setPetPat] = useState(false);
  const petRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    target: HTMLButtonElement;
    startX: number;
    startY: number;
    origin: WhalePosition;
    moved: boolean;
  } | null>(null);
  // Keep the user's intent separate from the temporary, viewport-clamped display point.
  const preferredPositionRef = useRef(readWhalePosition(() => safeLocalStorage()));
  const lastPositionResetKeyRef = useRef(positionResetKey);
  const suppressClickRef = useRef(false);
  const positionRef = useRef(position);
  positionRef.current = position;
  const finishDrag = useCallback((cancelled: boolean) => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    suppressClickRef.current = drag.moved || cancelled;
    if (drag.target.hasPointerCapture(drag.pointerId)) drag.target.releasePointerCapture(drag.pointerId);
    if (drag.moved && preferredPositionRef.current)
      writeWhalePosition(() => safeLocalStorage(), preferredPositionRef.current);
  }, []);
  const petSize = useCallback((currentMode: WhaleMode) => {
    const pet = petRef.current;
    return pet ? { width: pet.offsetWidth, height: pet.offsetHeight } : getPetSize(currentMode);
  }, []);
  const patTimerRef = useRef<number | null>(null);
  const generationRef = useRef(0);
  const requestInFlightRef = useRef(false);
  const requestQueuedRef = useRef(false);
  const refreshRef = useRef<(() => void) | null>(null);
  const wasBusyRef = useRef(false);
  const [documentVisible, setDocumentVisible] = useState(
    typeof document === "undefined" || document.visibilityState === "visible",
  );
  const visibleRef = useRef(documentVisible);
  const activityRef = useRef({ chatStatus, hasActiveTool });
  const viewport = useCallback(() => getVisibleViewport(), []);
  const positionCard = useCallback(() => {
    const pet = petRef.current;
    const card = cardRef.current;
    if (!pet || !card) return;
    const bounds = pet.getBoundingClientRect();
    const visible = getVisibleViewport();
    setCardMaxHeight(Math.max(64, Math.min(420, visible.height - 24)));
    setCardPosition(
      placeWhaleCard(
        { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom },
        { width: card.offsetWidth, height: card.offsetHeight },
        getVisibleViewport(),
      ),
    );
  }, []);
  const scopeKey = sessionId && runtimeId ? `${sessionId}\u0000${runtimeId}` : "";
  const canRequest =
    mode !== "hidden" &&
    !suspended &&
    cardOpen &&
    connection === "connected" &&
    Boolean(sessionId && runtimeId) &&
    !sessionActionPending &&
    documentVisible;
  const visibleUsageError = usageError?.scope === scopeKey ? usageError.message : null;

  const activity = useMemo<WhalePetImageState>(() => {
    if (connection !== "connected") return "idle";
    if (hasActiveTool) return "tool";
    if (chatStatus === "submitted" || chatStatus === "streaming") return "thinking";
    if (successFlash) return "success";
    return "idle";
  }, [chatStatus, connection, hasActiveTool, successFlash]);
  const busy = connection === "connected" && (chatStatus === "submitted" || chatStatus === "streaming");

  useEffect(() => {
    const wasBusy = wasBusyRef.current;
    wasBusyRef.current = busy;
    setSuccessFlash(false);
    if (wasBusy && !busy && connection === "connected") {
      setSuccessFlash(true);
      const timer = window.setTimeout(() => setSuccessFlash(false), 1800);
      return () => window.clearTimeout(timer);
    }
  }, [busy, connection]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: each replacement image set gets a fresh bounded failure cache.
  useEffect(() => {
    setFailedImages(new Set());
  }, [imageSignature]);

  useEffect(() => {
    const updateVisibility = () => {
      visibleRef.current = document.visibilityState === "visible";
      setDocumentVisible(visibleRef.current);
    };
    document.addEventListener("visibilitychange", updateVisibility);
    return () => document.removeEventListener("visibilitychange", updateVisibility);
  }, []);

  useEffect(() => {
    return () => {
      if (patTimerRef.current !== null) window.clearTimeout(patTimerRef.current);
      finishDrag(true);
    };
  }, [finishDrag]);

  useEffect(() => {
    if (mode === "hidden" || suspended) {
      if (patTimerRef.current !== null) window.clearTimeout(patTimerRef.current);
      patTimerRef.current = null;
      setPetPat(false);
      setCardOpen(false);
    }
  }, [mode, suspended]);

  useEffect(() => {
    if (!cardOpen || mode === "hidden" || suspended) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        setCardOpen(false);
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (!cardRef.current?.contains(target) && !petRef.current?.contains(target)) setCardOpen(false);
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [cardOpen, mode, suspended]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: session replacement remounts ChatInput's anchor DOM.
  useLayoutEffect(() => {
    if (lastPositionResetKeyRef.current !== positionResetKey) {
      lastPositionResetKeyRef.current = positionResetKey;
      finishDrag(true);
      preferredPositionRef.current = null;
      try {
        safeLocalStorage()?.removeItem(WHALE_POSITION_STORAGE_KEY);
      } catch {
        // Privacy/sandbox modes can deny storage; the in-page reset still works.
      }
    }
    if (mode === "hidden" || suspended) {
      finishDrag(true);
      return;
    }
    const composer = document.querySelector("[data-whale-anchor]");
    const updatePosition = () => {
      const visible = viewport();
      const size = petSize(mode);
      setPosition((current) => {
        const next = preferredPositionRef.current
          ? clampWhalePosition(preferredPositionRef.current, visible, size)
          : defaultWhalePosition(composer?.getBoundingClientRect() ?? null, visible, size);
        return next.x === current.x && next.y === current.y ? current : next;
      });
    };
    let frame = 0;
    const onResize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        updatePosition();
        positionCard();
      });
    };
    updatePosition();
    const observer = new ResizeObserver(onResize);
    if (composer) observer.observe(composer);
    const footer = composer?.closest("footer");
    if (footer) observer.observe(footer);
    observer.observe(document.body);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onResize, true);
    window.visualViewport?.addEventListener("resize", onResize);
    window.visualViewport?.addEventListener("scroll", onResize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onResize, true);
      window.visualViewport?.removeEventListener("resize", onResize);
      window.visualViewport?.removeEventListener("scroll", onResize);
      cancelAnimationFrame(frame);
    };
  }, [mode, positionCard, viewport, positionResetKey, suspended, scopeKey, finishDrag, petSize]);

  useEffect(() => {
    if (!cardOpen || suspended || mode === "hidden") return;
    positionCard();
    const observer = new ResizeObserver(positionCard);
    if (cardRef.current) observer.observe(cardRef.current);
    if (petRef.current) observer.observe(petRef.current);
    return () => observer.disconnect();
  }, [cardOpen, mode, positionCard, suspended]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: DOM position changes require repositioning the independent fixed card.
  useEffect(() => {
    if (!cardOpen || !visibleRef.current) return;
    const frame = requestAnimationFrame(positionCard);
    return () => cancelAnimationFrame(frame);
  }, [cardOpen, position, positionCard]);

  // Clear mismatched server results synchronously for rendering and in the effect for state hygiene.
  const usageMatchesScope = Boolean(
    usage && connection === "connected" && usage.sessionId === sessionId && usage.runtimeId === runtimeId,
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: every scope change invalidates local results and in-flight generations.
  useEffect(() => {
    setUsage(null);
    setUsageError(null);
    setUsageLoading(false);
    generationRef.current++;
  }, [scopeKey]);
  useEffect(() => {
    if (connection !== "connected" || !sessionId || !runtimeId || sessionActionPending) {
      setUsage(null);
      setUsageError(null);
      setUsageLoading(false);
    }
  }, [connection, runtimeId, sessionActionPending, sessionId]);

  useEffect(() => {
    if (!canRequest || !sessionId || !runtimeId) {
      refreshRef.current = null;
      setUsageLoading(false);
      requestQueuedRef.current = false;
      return;
    }
    const generation = ++generationRef.current;
    let active = true;
    const currentSessionId = sessionId;
    const currentRuntimeId = runtimeId;

    const refresh = () => {
      if (!active || generation !== generationRef.current || !visibleRef.current) return;
      if (requestInFlightRef.current) {
        requestQueuedRef.current = true;
        return;
      }
      const state = usePiWebUiStore.getState();
      if (
        state.connection !== "connected" ||
        state.sessionId !== currentSessionId ||
        state.runtimeId !== currentRuntimeId ||
        state.sessionActionPending
      )
        return;
      requestInFlightRef.current = true;
      requestQueuedRef.current = false;
      setUsageLoading(true);
      setUsageError(null);
      void (async () => {
        try {
          const result = await state.getUsageStats();
          if (!active || generation !== generationRef.current) return;
          if (result.sessionId !== currentSessionId || result.runtimeId !== currentRuntimeId) {
            setUsage(null);
            setUsageError({ scope: scopeKey, message: text.loadError });
            return;
          }
          setUsage(result);
        } catch {
          if (active && generation === generationRef.current) {
            setUsage(null);
            setUsageError({ scope: scopeKey, message: text.loadError });
          }
        } finally {
          requestInFlightRef.current = false;
          if (active && generation === generationRef.current) setUsageLoading(false);
          if (requestQueuedRef.current) {
            requestQueuedRef.current = false;
            window.setTimeout(() => refreshRef.current?.(), 0);
          }
        }
      })();
    };

    refreshRef.current = refresh;
    refresh();
    const timer = window.setInterval(refresh, REFRESH_INTERVAL_MS);
    return () => {
      active = false;
      if (generation === generationRef.current) generationRef.current++;
      if (refreshRef.current === refresh) refreshRef.current = null;
      window.clearInterval(timer);
    };
  }, [canRequest, runtimeId, scopeKey, sessionId, text.loadError]);

  useEffect(() => {
    const previous = activityRef.current;
    const changed = previous.chatStatus !== chatStatus || previous.hasActiveTool !== hasActiveTool;
    activityRef.current = { chatStatus, hasActiveTool };
    if (changed && canRequest) refreshRef.current?.();
  }, [canRequest, chatStatus, hasActiveTool]);

  const onDragPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || mode === "hidden" || dragRef.current) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    suppressClickRef.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      target: event.currentTarget,
      startX: event.clientX,
      startY: event.clientY,
      origin: position,
      moved: false,
    };
  };
  const onDragPointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    drag.moved = true;
    suppressClickRef.current = true;
    const nextViewport = viewport();
    const next = clampWhalePosition({ x: drag.origin.x + dx, y: drag.origin.y + dy }, nextViewport, petSize(mode));
    preferredPositionRef.current = next;
    positionRef.current = next;
    setPosition(next);
  };
  const onDragPointerEnd = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    finishDrag(event.type !== "pointerup");
  };

  const moveWithKeyboard = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const distance = event.shiftKey ? 24 : 8;
    const delta = {
      ArrowUp: { x: 0, y: -distance },
      ArrowDown: { x: 0, y: distance },
      ArrowLeft: { x: -distance, y: 0 },
      ArrowRight: { x: distance, y: 0 },
    }[event.key];
    const current = positionRef.current;
    const next = clampWhalePosition(
      { x: current.x + (delta?.x ?? 0), y: current.y + (delta?.y ?? 0) },
      viewport(),
      petSize(mode),
    );
    preferredPositionRef.current = next;
    positionRef.current = next;
    writeWhalePosition(() => safeLocalStorage(), next);
    setPosition(next);
  };

  if (mode === "hidden" || suspended) return null;
  const compact = mode === "compact";
  const petStyle = { left: position.x, top: position.y };
  const requestedImage = petPat ? images?.pat : images?.[activity];
  const currentImage = [requestedImage, images?.[activity], images?.idle].find(
    (candidate) => candidate && !failedImages.has(candidate),
  );
  const imageSrc = currentImage;

  return (
    <>
      <div
        className={`whale-pet whale-pet--${mode}${reduceMotion ? " whale-pet--reduced" : ""}${petPat ? " whale-pet--pat" : ""}`}
        ref={petRef}
        style={petStyle}
        data-testid="whale-pet"
      >
        <div className="whale-pet__actions">
          <button
            aria-label={text.drag}
            className="whale-pet__drag"
            data-testid="whale-drag"
            onKeyDown={moveWithKeyboard}
            onPointerCancel={onDragPointerEnd}
            onPointerDown={onDragPointerDown}
            onLostPointerCapture={onDragPointerEnd}
            onPointerMove={onDragPointerMove}
            onPointerUp={onDragPointerEnd}
            title={text.drag}
            type="button"
          >
            ⠿
          </button>
          {mode === "full" ? (
            <button
              aria-label={text.collapse}
              className="whale-pet__mode-button"
              onClick={() => onModeChange("compact")}
              type="button"
            >
              −
            </button>
          ) : (
            <button
              aria-label={text.showFull}
              className="whale-pet__mode-button"
              onClick={() => onModeChange("full")}
              type="button"
            >
              ＋
            </button>
          )}
          <button
            aria-label={text.hide}
            className="whale-pet__mode-button"
            onClick={() => {
              setCardOpen(false);
              onModeChange("hidden");
            }}
            type="button"
          >
            ×
          </button>
        </div>
        <button
          aria-expanded={cardOpen}
          aria-label={`${text.openUsage}: ${activityLabel(activity, text)}`}
          className="whale-pet__body"
          data-testid="whale-pet-body"
          onPointerDown={onDragPointerDown}
          onPointerMove={onDragPointerMove}
          onPointerUp={onDragPointerEnd}
          onPointerCancel={onDragPointerEnd}
          onLostPointerCapture={onDragPointerEnd}
          onClick={(event) => {
            if (event.detail !== 0 && suppressClickRef.current) {
              suppressClickRef.current = false;
              return;
            }
            setCardOpen((open) => !open);
            setPetPat(true);
            if (patTimerRef.current !== null) window.clearTimeout(patTimerRef.current);
            patTimerRef.current = window.setTimeout(() => setPetPat(false), 850);
          }}
          type="button"
        >
          {imageSrc ? (
            <img
              alt=""
              aria-hidden="true"
              draggable={false}
              className="whale-pet__image"
              onError={() => setFailedImages((current) => new Set(current).add(imageSrc))}
              src={imageSrc}
            />
          ) : (
            <span aria-hidden="true" className="whale-pet__emoji">
              🐳
            </span>
          )}
          {(!compact || !imageSrc) && <span className="whale-pet__label">{text.companion}</span>}
          {!imageSrc && !compact && <span className="whale-pet__import-hint">{text.importHint}</span>}
          <span aria-live="polite" className="whale-pet__status">
            {connection === "connected" ? activityLabel(activity, text) : text.disconnected}
          </span>
        </button>
      </div>

      {cardOpen && (
        <section
          aria-label={text.sessionUsage}
          className="whale-card"
          data-testid="whale-usage-card"
          ref={cardRef}
          style={{
            maxHeight: cardMaxHeight,
            ...(cardPosition ? { left: cardPosition.x, top: cardPosition.y } : { visibility: "hidden" }),
          }}
        >
          <header className="whale-card__header">
            <div className="whale-card__heading">
              <h2>{text.sessionUsage}</h2>
              <span>{text.sessionScope}</span>
            </div>
            <button
              aria-label={text.closeCard}
              className="whale-card__close"
              onClick={() => setCardOpen(false)}
              type="button"
            >
              ×
            </button>
          </header>
          <div className="whale-card__content">
            {!canRequest ? (
              <p className="whale-card__notice">{text.connectionRequired}</p>
            ) : usageLoading && !usageMatchesScope ? (
              <p aria-live="polite" className="whale-card__notice">
                {text.loading}
              </p>
            ) : visibleUsageError ? (
              <div className="whale-card__error" role="alert">
                <span>{visibleUsageError}</span>
                <button onClick={() => refreshRef.current?.()} type="button">
                  {text.retry}
                </button>
              </div>
            ) : usageMatchesScope && usage ? (
              <UsageSummary usage={usage} text={text} />
            ) : (
              <p aria-live="polite" className="whale-card__notice">
                {text.loading}
              </p>
            )}
            <p className="whale-card__scope-note">{text.allBranches}</p>
          </div>
        </section>
      )}
    </>
  );
}

function UsageSummary({ usage, text }: { usage: UsageStatsResult; text: WhaleTranslations }) {
  const totals = usage.totals;
  const cost = totals.cost;
  const costLabel = cost === null ? text.unknownCost : formatUsd(cost);
  return (
    <>
      <dl className="whale-card__totals">
        <div>
          <dt>{text.input}</dt>
          <dd>{formatCount(totals.input)}</dd>
        </div>
        <div>
          <dt>{text.output}</dt>
          <dd>{formatCount(totals.output)}</dd>
        </div>
        <div>
          <dt>{text.cacheRead}</dt>
          <dd>{formatCount(totals.cacheRead)}</dd>
        </div>
        <div>
          <dt>{text.cacheWrite}</dt>
          <dd>{formatCount(totals.cacheWrite)}</dd>
        </div>
        <div>
          <dt>{text.total}</dt>
          <dd>{formatCount(totals.totalTokens)}</dd>
        </div>
        <div>
          <dt>{text.requests}</dt>
          <dd>{formatCount(totals.requests)}</dd>
        </div>
      </dl>
      <section className="whale-card__cost">
        <h3>{text.estimatedCost}</h3>
        {cost === null ? (
          <p>
            {text.unknownCost}
            {totals.unpricedRequests > 0 && ` · ${totals.unpricedRequests} ${text.unpriced}`}
          </p>
        ) : totals.unpricedRequests > 0 ? (
          <p>
            {text.knownSubtotal}: {costLabel} · {totals.unpricedRequests} {text.unpriced}
          </p>
        ) : (
          <p>{costLabel}</p>
        )}
        <small>{text.costNote}</small>
      </section>
      <section className="whale-card__models">
        <h3>{text.lastResponse}</h3>
        {usage.lastResponse ? (
          <div className="whale-card__model">
            <strong>{usage.lastResponse.provider}</strong>
            <span>{usage.lastResponse.model}</span>
            <small>
              {formatCount(usage.lastResponse.totalTokens)} {text.tokens} · {costSummary(usage.lastResponse, text)}
            </small>
          </div>
        ) : (
          <p>{text.noResponse}</p>
        )}
        <h3>{text.models}</h3>
        {usage.models.map((model) => (
          <div className="whale-card__model" key={`${model.provider}\u0000${model.model}`}>
            <strong>{model.provider}</strong>
            <span>{model.model}</span>
            <small>
              {formatCount(model.totalTokens)} {text.tokens} · {costSummary(model, text)}
            </small>
            <small>
              {text.input} {formatCount(model.input)} · {text.output} {formatCount(model.output)} · {text.cacheRead}{" "}
              {formatCount(model.cacheRead)} · {text.cacheWrite} {formatCount(model.cacheWrite)}
            </small>
          </div>
        ))}
      </section>
      {usage.truncated && <p className="whale-card__scope-note">{text.truncated}</p>}
    </>
  );
}

function costSummary(usage: UsageStatsTotals, text: WhaleTranslations): string {
  const price = usage.cost === null ? text.unknownCost : formatUsd(usage.cost);
  if (!usage.unpricedRequests) return price;
  return `${usage.cost === null ? price : `${text.knownSubtotal}: ${price}`} · ${usage.unpricedRequests} ${text.unpriced}`;
}

function isActiveTool(item: ChatItem): boolean {
  return item.kind === "tool" && (item.state === "input-available" || item.state === "input-streaming");
}

function initialPosition(mode: WhaleMode): WhalePosition {
  const stored = readWhalePosition(() => safeLocalStorage());
  const visible = getVisibleViewport();
  const size = getPetSize(mode);
  if (stored) return clampWhalePosition(stored, visible, size);
  return defaultWhalePosition(null, visible, size);
}

function getPetSize(mode: WhaleMode) {
  if (mode === "compact") return PET_SIZE_COMPACT;
  // CSS breakpoints use the layout viewport, never visualViewport's zoomed width.
  return typeof window !== "undefined" && window.matchMedia("(max-width: 639px)").matches
    ? PET_SIZE_MOBILE
    : PET_SIZE_DESKTOP;
}

function getVisibleViewport(): WhaleViewport {
  const visual = typeof window !== "undefined" ? window.visualViewport : null;
  if (visual) return { left: visual.offsetLeft, top: visual.offsetTop, width: visual.width, height: visual.height };
  return {
    left: 0,
    top: 0,
    width: typeof window === "undefined" ? 1280 : window.innerWidth,
    height: typeof window === "undefined" ? 800 : window.innerHeight,
  };
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function activityLabel(activity: WhalePetImageState, text: WhaleTranslations): string {
  switch (activity) {
    case "thinking":
      return text.thinking;
    case "tool":
      return text.working;
    case "success":
      return text.success;
    default:
      return text.idle;
  }
}

function formatCount(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(value);
}
