import assert from "node:assert/strict";
import test from "node:test";

import {
  adjustStation,
  parseDailyNormals,
  parseHourlyDailyRain,
  periodStart,
} from "../app/lib/intraday.ts";

test("moves the rolling window start to D+1", () => {
  assert.equal(periodStart("2026-08-18", "1m"), "2026-07-19");
  assert.equal(periodStart("2026-08-18", "3m"), "2026-05-19");
  assert.equal(periodStart("2026-08-18", "6m"), "2026-02-19");
  assert.equal(periodStart("2026-08-18", "12m"), "2025-08-19");
});

test("reads RN_DAY and treats KMA missing-rain sentinels as zero", () => {
  const rows = [
    "# header",
    "202608181800 108 11 0.9 -9 -9.0 -9 1006.6 1008.6 2 0.5 29.7 23.3 69.0 28.6 -9.0 -9.0 -9.0 -9.0",
    "202608181800 159 11 0.9 -9 -9.0 -9 1006.6 1008.6 2 0.5 29.7 23.3 69.0 28.6 3.4 119.3 119.3 -9.0",
  ].join("\n");

  const rain = parseHourlyDailyRain(rows);
  assert.equal(rain.get(108), 0);
  assert.equal(rain.get(159), 119.3);
});

test("uses official replacement normals for Daegu and Jeonju", () => {
  const rows = [
    "2021,860,8,18,23.9,27.1,21.1,7.9,-99.9,1.9,83.4,24.7,4.6,-99.9,1007.5,1009.6,=",
    "2021,864,8,18,23.9,27.1,21.1,8.6,-99.9,1.9,83.4,24.7,4.6,-99.9,1007.5,1009.6,=",
  ].join("\n");

  const normals = parseDailyNormals(rows);
  assert.equal(normals.get(860), 7.9);
  assert.equal(normals.get(864), 8.6);
});

test("replaces the first full day with the selected partial end day", () => {
  const result = adjustStation({
    baseNormal: 1003.2,
    basePrecipitation: 851.9,
    startDayNormal: 2.4,
    startDayPrecipitation: 3,
    endDayNormal: 8,
    endDayPrecipitation: 12,
    elapsedHours: 18,
  });

  assert.equal(result.precipitation, 860.9);
  assert.equal(result.normal, 1006.8);
  assert.equal(result.ratio, 85.5);
});
