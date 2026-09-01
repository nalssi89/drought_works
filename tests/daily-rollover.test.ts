import assert from "node:assert/strict";
import test from "node:test";

import { OfficialDataUnavailableError } from "../supabase/functions/kma-hourly-cache/official-refresh.ts";
import {
  REPRESENTATIVE_STATIONS,
  parseOfficialDailyRain,
} from "../supabase/functions/kma-hourly-cache/daily-rollover.ts";

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
