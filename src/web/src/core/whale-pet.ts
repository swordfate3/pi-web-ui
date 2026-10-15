export type WhalePosition = { x: number; y: number };
export type WhaleViewport = { left: number; top: number; width: number; height: number };
export type WhaleSize = { width: number; height: number };
export type WhaleStorage = Pick<Storage, "getItem" | "setItem">;

export const WHALE_POSITION_STORAGE_KEY = "pi-web-ui-whale-position";
const MAX_STORED_COORDINATE = 100_000;

/** Clamp an absolute fixed-position point to the currently visible viewport. */
export function clampWhalePosition(
  position: WhalePosition,
  viewport: WhaleViewport,
  size: WhaleSize,
  margin = 12,
): WhalePosition {
  const minX = viewport.left + margin;
  const minY = viewport.top + margin;
  const maxX = Math.max(minX, viewport.left + viewport.width - size.width - margin);
  const maxY = Math.max(minY, viewport.top + viewport.height - size.height - margin);
  return {
    x: clampFinite(position.x, minX, maxX, minX),
    y: clampFinite(position.y, minY, maxY, minY),
  };
}

/** Place a card above its pet when possible, otherwise below, and keep it in view. */
export function placeWhaleCard(
  anchor: { left: number; top: number; right: number; bottom: number },
  card: WhaleSize,
  viewport: WhaleViewport,
  gap = 12,
  margin = 12,
): WhalePosition {
  const minX = viewport.left + margin;
  const maxX = Math.max(minX, viewport.left + viewport.width - card.width - margin);
  const minY = viewport.top + margin;
  const maxY = Math.max(minY, viewport.top + viewport.height - card.height - margin);
  const above = anchor.top - gap - card.height;
  const below = anchor.bottom + gap;
  const y = above >= minY || below > maxY ? above : below;
  const x = anchor.left + (anchor.right - anchor.left) / 2 - card.width / 2;
  return { x: clampFinite(x, minX, maxX, minX), y: clampFinite(y, minY, maxY, minY) };
}

/** Browser storage can be unavailable (privacy mode, sandbox, quota); all access is best-effort. */
export function readWhalePosition(getStorage: () => WhaleStorage | null): WhalePosition | null {
  try {
    const serialized = getStorage()?.getItem(WHALE_POSITION_STORAGE_KEY);
    if (!serialized) return null;
    const value: unknown = JSON.parse(serialized);
    if (!isPosition(value)) return null;
    return { x: value.x, y: value.y };
  } catch {
    return null;
  }
}

export function writeWhalePosition(getStorage: () => WhaleStorage | null, position: WhalePosition): boolean {
  if (!isPosition(position)) return false;
  try {
    const storage = getStorage();
    if (!storage) return false;
    storage.setItem(WHALE_POSITION_STORAGE_KEY, JSON.stringify({ x: position.x, y: position.y }));
    return true;
  } catch {
    return false;
  }
}

function isPosition(value: unknown): value is WhalePosition {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.x === "number" &&
    Number.isFinite(candidate.x) &&
    candidate.x >= 0 &&
    candidate.x <= MAX_STORED_COORDINATE &&
    typeof candidate.y === "number" &&
    Number.isFinite(candidate.y) &&
    candidate.y >= 0 &&
    candidate.y <= MAX_STORED_COORDINATE
  );
}

function clampFinite(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}
