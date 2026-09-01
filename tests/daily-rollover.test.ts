import assert from "node:assert/strict";
import test from "node:test";

import { OfficialDataUnavailableError } from "../supabase/functions/kma-hourly-cache/official-refresh.ts";
import {
  REPRESENTATIVE_STATIONS,
  parseOfficialDailyRain,
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

test("uses the previous-day intraday cache when the official daily base is still stale", () => {
  // Given: September 1 official data is unconfirmed, but its 23:00 intraday cache is complete.
  const official = cachePayload("official", "2026-08-31", null);
  const intraday = cachePayload("intraday", "2026-09-01", "2026-09-01T23:00");

  // When: the September 2 hourly rollover selects its September 1 base.
  const selected = selectRolloverBase(
    { official, intraday },
    { period: "1m", effectiveDate: "2026-09-01" },
  );

  // Then: the valid intraday base keeps the current-day series moving.
  assert.equal(selected.mode, "intraday");
  assert.equal(selected.observationTime, "2026-09-01T23:00");
});

test("prefers a finalized official base over the previous-day intraday cache", () => {
  // Given: both candidate caches cover the required previous day.
  const official = cachePayload("official", "2026-09-01", null);
  const intraday = cachePayload("intraday", "2026-09-01", "2026-09-01T23:00");

  // When: the rollover base is selected.
  const selected = selectRolloverBase(
    { official, intraday },
    { period: "1m", effectiveDate: "2026-09-01" },
  );

  // Then: finalized data remains authoritative.
  assert.equal(selected.mode, "official");
  assert.equal(selected.observationTime, null);
});

test("rejects an intraday fallback that was not observed on the required previous day", () => {
  // Given: neither candidate is a valid September 1 base.
  const official = cachePayload("official", "2026-08-31", null);
  const intraday = cachePayload("intraday", "2026-09-01", "2026-08-31T23:00");

  // When / Then: rollover fails closed instead of reusing a mismatched observation.
  assert.throws(
    () => selectRolloverBase(
      { official, intraday },
      { period: "1m", effectiveDate: "2026-09-01" },
    ),
    OfficialDataUnavailableError,
  );
});
