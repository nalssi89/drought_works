import assert from "node:assert/strict";
import test from "node:test";

import {
  cachedPayloadToOfficial,
  officialPayloadReady,
} from "../supabase/functions/_shared/official-cache-fallback.ts";

function cachedPayload(period: "1m" | "3m" | "6m" | "12m" | "ty" = "6m") {
  return {
    schemaVersion: 2,
    period,
    effectiveDate: "2026-08-21",
    mode: "official",
    observationTime: null,
    stations: Array.from({ length: 66 }, (_, index) => ({
      code: 100 + index,
      name: `지점${index + 1}`,
      normal: 300 + index,
      precipitation: 200 + index,
      ratio: 70 + index / 10,
    })),
    regions: Array.from({ length: 12 }, (_, index) => ({
      code: String(index + 1).padStart(2, "0"),
      normal: 400 + index,
      precipitation: 300 + index,
      ratio: 75 + index / 10,
      rank: index + 1,
    })),
    admins: Array.from({ length: 4 }, (_, index) => ({
      code: String(index + 1).padStart(2, "0"),
      normal: 500 + index,
      precipitation: 350 + index,
      ratio: 70 + index,
      rank: null,
    })),
    fetchedAt: "2026-08-21T15:40:00.000Z",
    source: "daily",
  };
}

test("recognizes that an empty Hydro response is not a completed official payload", () => {
  assert.equal(officialPayloadReady({ list1: [], list2: [], list_admin: [] }, "6m"), false);
});

test("converts the matching completed daily cache to the official Hydro response shape", () => {
  const converted = cachedPayloadToOfficial(cachedPayload(), "2026-08-21", "6m");
  assert.ok(converted);
  assert.equal(officialPayloadReady(converted, "6m"), true);
  assert.equal(converted.search_date_db, "20260821");
  assert.equal(converted.search_period, "2026년 02월 22일 ~ 2026년 08월 21일");
  assert.equal((converted.list1 as unknown[]).length, 12);
  assert.equal((converted.list2 as unknown[]).length, 66);
  assert.equal((converted.list_admin as unknown[]).length, 4);
});

test("keeps year-to-date regions empty in the compatibility response", () => {
  const converted = cachedPayloadToOfficial(cachedPayload("ty"), "2026-08-21", "ty");
  assert.ok(converted);
  assert.equal(officialPayloadReady(converted, "ty"), true);
  assert.deepEqual(converted.list1, []);
  assert.equal(converted.search_period, "2026년 01월 01일 ~ 2026년 08월 21일");
});

test("does not substitute a cache from a different effective date", () => {
  assert.equal(cachedPayloadToOfficial(cachedPayload(), "2026-08-20", "6m"), null);
});
