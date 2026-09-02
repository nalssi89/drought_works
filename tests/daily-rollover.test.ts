import assert from "node:assert/strict";
import test from "node:test";

import { OfficialDataUnavailableError } from "../supabase/functions/kma-hourly-cache/official-refresh.ts";
import {
  REPRESENTATIVE_STATIONS,
  parseOfficialDailyRain,
  rolloverCacheKey,
  selectRolloverBase,
} from "../supabase/functions/kma-hourly-cache/daily-rollover.ts";
import type {
  CachePayload,
  Mode,
} from "../supabase/functions/kma-hourly-cache/daily-rollover.ts";

function cachePayload(
  mode: Mode,
  effectiveDate: string,
  observationTime: string | null,
): CachePayload {
  const stations = REPRESENTATIVE_STATIONS.map((code) => ({
    code,
    name: String(code),
    normal: 100,
    precipitation: 10,
    ratio: 10,
  }));
  const aggregate = (code: string) => ({
    code,
    normal: 100,
    precipitation: 10,
    ratio: 10,
    rank: null,
  });
  return {
    schemaVersion: 2,
    period: "1m",
    effectiveDate,
    mode,
    observationTime,
    stations,
    regions: Array.from({ length: 12 }, (_, index) => aggregate(String(index + 1))),
    admins: Array.from({ length: 4 }, (_, index) => aggregate(String(index + 1))),
    fetchedAt: "2026-09-02T00:00:00.000Z",
    source: mode === "official" ? "hydro" : "intraday",
  };
}

test("defers final daily data when a representative station still has an RN_DAY sentinel", () => {
  const rows = REPRESENTATIVE_STATIONS.map((station) => {
    const fields = Array.from({ length: 56 }, () => "-9");
    fields[0] = "20260831";
    fields[1] = String(station);
    fields[2] = "50.0";
    fields[38] = station === 108 ? "-9.0" : "0.0";
    return fields.join(" ");
  }).join("\n");
  const requiredStations = new Set(REPRESENTATIVE_STATIONS);

  assert.throws(
    () => parseOfficialDailyRain(rows, "2026-08-31", requiredStations),
    OfficialDataUnavailableError,
  );
});

test("keys completed hourly rollovers by date so delayed daily promotion retains its source", () => {
  assert.equal(rolloverCacheKey("2026-09-01", "1m"), "rollover:2026-09-01:1m");
  assert.equal(rolloverCacheKey("2026-09-02", "1m"), "rollover:2026-09-02:1m");
});

test("uses the date-scoped next-day 00:00 rollover when official daily data is still stale", () => {
  // Given: September 1 official data is unconfirmed, but its full hourly day is retained at September 2 00:00.
  const official = cachePayload("official", "2026-08-31", null);
  const rollover = cachePayload("rollover", "2026-09-01", "2026-09-02T00:00");

  // When: the September 2 hourly rollover selects its September 1 base.
  const selected = selectRolloverBase(
    { official, rollover },
    { period: "1m", effectiveDate: "2026-09-01" },
  );

  // Then: the retained 24-hour basis keeps the current-day series moving without dropping 23:01–24:00.
  assert.equal(selected.mode, "rollover");
  assert.equal(selected.observationTime, "2026-09-02T00:00");
});

test("prefers a finalized official base over the retained hourly rollover", () => {
  // Given: both candidate caches cover the required previous day.
  const official = cachePayload("official", "2026-09-01", null);
  const rollover = cachePayload("rollover", "2026-09-01", "2026-09-02T00:00");

  // When: the rollover base is selected.
  const selected = selectRolloverBase(
    { official, rollover },
    { period: "1m", effectiveDate: "2026-09-01" },
  );

  // Then: finalized data remains authoritative.
  assert.equal(selected.mode, "official");
  assert.equal(selected.observationTime, null);
});

test("rejects a retained rollover that stops at 23:00 instead of the next-day 00:00 boundary", () => {
  // Given: the only provisional candidate omits September 1's final hourly interval.
  const official = cachePayload("official", "2026-08-31", null);
  const rollover = cachePayload("rollover", "2026-09-01", "2026-09-01T23:00");

  // When / Then: rollover fails closed instead of calling a 23-hour basis complete.
  assert.throws(
    () => selectRolloverBase(
      { official, rollover },
      { period: "1m", effectiveDate: "2026-09-01" },
    ),
    OfficialDataUnavailableError,
  );
});
