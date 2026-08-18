import { isTauri } from "@tauri-apps/api/core";
import { load, type Store } from "@tauri-apps/plugin-store";

import type { RecognitionHistoryEntry } from "../../types/history";

const STORE_PATH = "recognition-history.json";
const STORE_KEY = "history";
const SCHEMA_VERSION = 1;
export const MAX_HISTORY_ENTRIES_PER_USER = 500;
const MAX_ID_LENGTH = 128;
const MAX_METADATA_LENGTH = 512;
const MAX_TEXT_LENGTH = 131_072;

interface RecognitionHistoryData {
  schemaVersion: 1;
  entries: RecognitionHistoryEntry[];
}

export interface RecognitionHistoryRepository {
  list(userId: string): Promise<RecognitionHistoryEntry[]>;
  add(entry: RecognitionHistoryEntry): Promise<RecognitionHistoryEntry[]>;
  remove(userId: string, id: string): Promise<RecognitionHistoryEntry[]>;
  clearUser(userId: string): Promise<void>;
  clearAll(): Promise<void>;
}

class TauriRecognitionHistoryRepository implements RecognitionHistoryRepository {
  private storePromise: Promise<Store> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private browserData: RecognitionHistoryData = emptyData();

  list(userId: string) {
    return this.exclusive(async () => entriesForUser(await this.read(), userId));
  }

  add(entry: RecognitionHistoryEntry) {
    return this.exclusive(async () => {
      const data = upsertHistoryEntry(await this.read(), entry);
      await this.write(data);
      return entriesForUser(data, entry.userId);
    });
  }

  remove(userId: string, id: string) {
    return this.exclusive(async () => {
      const data = await this.read();
      data.entries = data.entries.filter(
        (entry) => entry.userId !== userId || entry.id !== id,
      );
      await this.write(data);
      return entriesForUser(data, userId);
    });
  }

  clearUser(userId: string) {
    return this.exclusive(async () => {
      const data = await this.read();
      data.entries = data.entries.filter((entry) => entry.userId !== userId);
      await this.write(data);
    });
  }

  clearAll() {
    return this.exclusive(() => this.write(emptyData()));
  }

  private async read() {
    if (!isTauri()) return normalizeHistoryData(this.browserData);
    return normalizeHistoryData(await (await this.store()).get<unknown>(STORE_KEY));
  }

  private async write(data: RecognitionHistoryData) {
    if (!isTauri()) {
      this.browserData = normalizeHistoryData(data);
      return;
    }
    const store = await this.store();
    await store.set(STORE_KEY, data);
    await store.save();
  }

  private store() {
    this.storePromise ??= load(STORE_PATH, { autoSave: 100 });
    return this.storePromise;
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export function normalizeHistoryData(value: unknown): RecognitionHistoryData {
  if (!isRecord(value) || value.schemaVersion !== SCHEMA_VERSION) return emptyData();
  const entries = Array.isArray(value.entries)
    ? value.entries.flatMap((entry) => {
        const normalized = normalizeEntry(entry);
        return normalized ? [normalized] : [];
      })
    : [];
  const deduplicated = new Map<string, RecognitionHistoryEntry>();
  for (const entry of entries.sort((a, b) => b.completedAtMs - a.completedAtMs)) {
    const key = `${entry.userId}\u0000${entry.id}`;
    if (!deduplicated.has(key)) deduplicated.set(key, entry);
  }
  return capUsers({
    schemaVersion: SCHEMA_VERSION,
    entries: [...deduplicated.values()],
  });
}

export function upsertHistoryEntry(
  value: unknown,
  entry: RecognitionHistoryEntry,
): RecognitionHistoryData {
  const normalized = normalizeEntry(entry);
  if (!normalized) throw new Error("识别历史记录无效");
  const data = normalizeHistoryData(value);
  data.entries = data.entries.filter(
    (item) => item.userId !== normalized.userId || item.id !== normalized.id,
  );
  data.entries.push(normalized);
  data.entries.sort((a, b) => b.completedAtMs - a.completedAtMs);
  return capUsers(data);
}

function entriesForUser(data: RecognitionHistoryData, userId: string) {
  return data.entries
    .filter((entry) => entry.userId === userId)
    .sort((a, b) => b.completedAtMs - a.completedAtMs);
}

function capUsers(data: RecognitionHistoryData) {
  const counts = new Map<string, number>();
  data.entries = data.entries.filter((entry) => {
    const count = counts.get(entry.userId) ?? 0;
    counts.set(entry.userId, count + 1);
    return count < MAX_HISTORY_ENTRIES_PER_USER;
  });
  return data;
}

function normalizeEntry(value: unknown): RecognitionHistoryEntry | null {
  if (!isRecord(value)) return null;
  if (
    !shortString(value.id, MAX_ID_LENGTH) ||
    !shortString(value.userId, MAX_ID_LENGTH) ||
    !shortString(value.language, MAX_METADATA_LENGTH) ||
    !shortString(value.pipeline, MAX_METADATA_LENGTH) ||
    !finiteNonNegative(value.completedAtMs) ||
    !finiteNonNegative(value.durationMs) ||
    (value.mode !== "asr_only" && value.mode !== "asr_llm") ||
    typeof value.resultText !== "string" ||
    value.resultText.length > MAX_TEXT_LENGTH ||
    (value.sourceText !== null &&
      (typeof value.sourceText !== "string" ||
        value.sourceText.length > MAX_TEXT_LENGTH))
  ) {
    return null;
  }
  return {
    id: value.id,
    userId: value.userId,
    completedAtMs: Math.trunc(value.completedAtMs),
    mode: value.mode,
    language: value.language,
    pipeline: value.pipeline,
    durationMs: Math.trunc(value.durationMs),
    sourceText: value.mode === "asr_llm" ? value.sourceText : null,
    resultText: value.resultText,
  };
}

function emptyData(): RecognitionHistoryData {
  return { schemaVersion: SCHEMA_VERSION, entries: [] };
}

function shortString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const recognitionHistoryRepository: RecognitionHistoryRepository =
  new TauriRecognitionHistoryRepository();
