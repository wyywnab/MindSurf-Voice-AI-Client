export const MAIN_TAB_IDS = [
  "record",
  "connection",
  "history",
  "permissions",
  "settings",
] as const;

export type MainTabId = (typeof MAIN_TAB_IDS)[number];

export function isMainTabId(value: string): value is MainTabId {
  return (MAIN_TAB_IDS as readonly string[]).includes(value);
}

export interface MainTab {
  id: MainTabId;
  label: string;
}
