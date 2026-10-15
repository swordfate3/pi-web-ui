import type { HistoryRange } from "./types";
export function recentHistoryRange(now = new Date(), days = 3): HistoryRange {
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days + 1);
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return { from: from.getTime(), to: to.getTime() };
}
export function dateInputValue(timestamp: number): string {
  const date = new Date(timestamp);
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function calendarRange(start: string, end: string): HistoryRange {
  function parse(value: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Invalid date range");
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(0);
    date.setFullYear(year, month - 1, day);
    date.setHours(0, 0, 0, 0);
    if (dateInputValue(date.getTime()) !== value) throw new Error("Invalid date range");
    return date;
  }
  const from = parse(start);
  const to = parse(end);
  if (from > to) throw new Error("Invalid date range");
  to.setDate(to.getDate() + 1);
  return { from: from.getTime(), to: to.getTime() };
}
