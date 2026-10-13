/** 28px button + 4px gutter; current separator occupies the gutter, never changes height. */
export const SIDEBAR_TREE_ROW_HEIGHT = 32;
export const SIDEBAR_TREE_OVERSCAN = 6;

export function sidebarVirtualRange(count: number, scrollTop: number, viewportHeight: number) {
  const top = Math.max(0, Math.min(scrollTop, Math.max(0, count * SIDEBAR_TREE_ROW_HEIGHT - viewportHeight)));
  return {
    start: Math.max(0, Math.floor(top / SIDEBAR_TREE_ROW_HEIGHT) - SIDEBAR_TREE_OVERSCAN),
    end: Math.min(count, Math.ceil((top + viewportHeight) / SIDEBAR_TREE_ROW_HEIGHT) + SIDEBAR_TREE_OVERSCAN),
  };
}

/** Pin at most one actually focused row, never the intervening offscreen rows. */
export function sidebarVirtualIndices(count: number, range: { start: number; end: number }, focusedIndex = -1) {
  const indices = Array.from({ length: range.end - range.start }, (_, index) => range.start + index);
  if (focusedIndex >= 0 && focusedIndex < count && (focusedIndex < range.start || focusedIndex >= range.end)) {
    indices.push(focusedIndex);
    indices.sort((a, b) => a - b);
  }
  return indices;
}

/** Index-based navigation works before the target row exists in DOM. */
export function sidebarScrollOffset(index: number, count: number, viewportHeight: number) {
  return Math.max(
    0,
    Math.min(
      (index + 0.5) * SIDEBAR_TREE_ROW_HEIGHT - viewportHeight / 2,
      Math.max(0, count * SIDEBAR_TREE_ROW_HEIGHT - viewportHeight),
    ),
  );
}
