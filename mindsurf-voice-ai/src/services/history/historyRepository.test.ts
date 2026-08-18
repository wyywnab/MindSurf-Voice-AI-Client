import { describe, expect, it } from "vitest";

import type { RecognitionHistoryEntry } from "../../types/history";
import {
  MAX_HISTORY_ENTRIES_PER_USER,
  normalizeHistoryData,
  recognitionHistoryRepository,
  upsertHistoryEntry,
} from "./historyRepository";

function entry(
  id: string,
  userId = "user-a",
  completedAtMs = 1,
): RecognitionHistoryEntry {
  return {
    id,
    userId,
    completedAtMs,
    mode: "asr_only",
    language: "auto",
    pipeline: "pipeline",
    durationMs: 1_000,
    sourceText: null,
    resultText: `result-${id}`,
  };
}

describe("recognition history repository", () => {
  it("filters damaged entries and deduplicates by account and request ID", () => {
    const data = normalizeHistoryData({
      schemaVersion: 1,
      entries: [entry("same", "user-a", 1), entry("same", "user-a", 2), null],
    });
    expect(data.entries).toHaveLength(1);
    expect(data.entries[0]?.completedAtMs).toBe(2);
  });

  it("keeps the same request ID isolated between accounts", () => {
    let data = upsertHistoryEntry(null, entry("same", "user-a"));
    data = upsertHistoryEntry(data, entry("same", "user-b"));
    expect(data.entries.map((item) => item.userId).sort()).toEqual([
      "user-a",
      "user-b",
    ]);
  });

  it("retains only the newest 500 entries for each account", () => {
    let data: unknown = null;
    for (let index = 0; index <= MAX_HISTORY_ENTRIES_PER_USER; index += 1) {
      data = upsertHistoryEntry(data, entry(`request-${index}`, "user-a", index));
    }
    const normalized = normalizeHistoryData(data);
    expect(normalized.entries).toHaveLength(MAX_HISTORY_ENTRIES_PER_USER);
    expect(normalized.entries[0]?.id).toBe("request-500");
    expect(normalized.entries[normalized.entries.length - 1]?.id).toBe("request-1");
  });

  it("drops source text from recognition-only entries", () => {
    const value = entry("request");
    value.sourceText = "should not persist";
    expect(upsertHistoryEntry(null, value).entries[0]?.sourceText).toBeNull();
  });

  it("removes one entry and clears only the selected account", async () => {
    await recognitionHistoryRepository.clearAll();
    await recognitionHistoryRepository.add(entry("one", "user-a", 1));
    await recognitionHistoryRepository.add(entry("two", "user-a", 2));
    await recognitionHistoryRepository.add(entry("one", "user-b", 3));

    expect(
      (await recognitionHistoryRepository.remove("user-a", "one")).map(
        (item) => item.id,
      ),
    ).toEqual(["two"]);
    await recognitionHistoryRepository.clearUser("user-a");

    expect(await recognitionHistoryRepository.list("user-a")).toEqual([]);
    expect(await recognitionHistoryRepository.list("user-b")).toHaveLength(1);
    await recognitionHistoryRepository.clearAll();
  });
});
