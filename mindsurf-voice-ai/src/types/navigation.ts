export type MainTabId = "record" | "connection" | "permissions" | "settings";

export interface MainTab {
  id: MainTabId;
  label: string;
}
