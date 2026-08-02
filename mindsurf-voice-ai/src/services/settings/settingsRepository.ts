export interface SettingsRepository {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

class LocalStorageSettingsRepository implements SettingsRepository {
  get(key: string) {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(key);
  }

  set(key: string, value: string) {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(key, value);
    }
  }
}

// M2: 将此适配器替换为 Tauri Store 实现。
export const settingsRepository: SettingsRepository =
  new LocalStorageSettingsRepository();
