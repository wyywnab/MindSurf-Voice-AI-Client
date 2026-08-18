import type { UsageEntry } from "../types/httpApi";

export type UsageView = "daily" | "weekly" | "cumulative";

export interface UsageCell {
  key: string;
  label: string;
  value: number;
  level: number;
  future?: boolean;
}

export function usageRange(now = new Date()) {
  const today = startOfDay(now);
  const end = new Date(today);
  end.setDate(end.getDate() + 1);
  const start = new Date(today);
  start.setDate(start.getDate() - start.getDay() - 52 * 7);
  return { fromMs: start.getTime(), toMs: end.getTime(), start };
}

export function dailyUsageCells(entries: UsageEntry[], start: Date, now = new Date()) {
  const totals = new Map<string, number>();
  for (const entry of entries) {
    const key = dateKey(new Date(entry.settled_at_ms));
    totals.set(key, (totals.get(key) ?? 0) + entry.credits_charged);
  }
  const today = startOfDay(now).getTime();
  const cells: UsageCell[] = [];
  for (let index = 0; index < 371; index += 1) {
    const date = new Date(start);
    date.setDate(date.getDate() + index);
    const value = totals.get(dateKey(date)) ?? 0;
    cells.push({
      key: dateKey(date),
      label: `${date.toLocaleDateString()} · ${value.toLocaleString()} credits`,
      value,
      level: 0,
      future: date.getTime() > today,
    });
  }
  return applyLevels(cells);
}

export function weeklyUsageCells(daily: UsageCell[], cumulative = false) {
  let running = 0;
  const cells: UsageCell[] = [];
  for (let index = 0; index < daily.length; index += 7) {
    const week = daily.slice(index, index + 7);
    const value = week.reduce((sum, cell) => sum + cell.value, 0);
    running += value;
    cells.push({
      key: week[0]?.key ?? String(index),
      label: `${week[0]?.key ?? ""} 起 · ${(cumulative ? running : value).toLocaleString()} credits`,
      value: cumulative ? running : value,
      level: 0,
      future: week.every((cell) => cell.future),
    });
  }
  return applyLevels(cells);
}

export function monthMarkers(start: Date) {
  const markers: Array<{ label: string; column: number }> = [];
  let previous = -1;
  for (let week = 0; week < 53; week += 1) {
    const date = new Date(start);
    date.setDate(date.getDate() + week * 7);
    if (date.getMonth() !== previous) {
      markers.push({
        label: date.toLocaleDateString(undefined, { month: "short" }),
        column: week + 1,
      });
      previous = date.getMonth();
    }
  }
  return markers;
}

function applyLevels(cells: UsageCell[]) {
  const maximum = Math.max(
    0,
    ...cells.filter((cell) => !cell.future).map((cell) => cell.value),
  );
  return cells.map((cell) => ({
    ...cell,
    level:
      cell.future || cell.value === 0 || maximum === 0
        ? 0
        : Math.max(1, Math.ceil((cell.value / maximum) * 4)),
  }));
}

function startOfDay(value: Date) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function dateKey(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
