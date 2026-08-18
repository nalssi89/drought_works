import assert from "node:assert/strict";
import test from "node:test";

import {
  adjustStation,
  latestObservationTime,
  mergeAggregateRanks,
  parseDailyNormals,
  parseHourlyDailyRain,
  periodStart,
} from "../app/lib/intraday.ts";
import { millisecondsUntilNextHourlyRefresh } from "../app/lib/refresh.ts";

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

test("replaces rain with the selected partial end day while keeping the full daily normal", () => {
  const input = {
    baseNormal: 1003.2,
    basePrecipitation: 851.9,
    startDayNormal: 2.4,
    startDayPrecipitation: 3,
    endDayNormal: 8,
    endDayPrecipitation: 12,
  } as const;
  const morning = adjustStation(input);
  const evening = adjustStation(input);

  assert.equal(morning.precipitation, 860.9);
  assert.equal(morning.normal, 1008.8);
  assert.equal(morning.normal, evening.normal);
  assert.equal(morning.ratio, 85.3);
});

test("refreshes at minute 10 of the next applicable hour", () => {
  assert.equal(
    millisecondsUntilNextHourlyRefresh(new Date("2026-08-18T09:04:30Z")),
    6.25 * 60_000,
  );
  assert.equal(
    millisecondsUntilNextHourlyRefresh(new Date("2026-08-18T09:10:45Z")),
    60 * 60_000,
  );
});

test("offers the new hour from minute 10 KST", () => {
  assert.equal(latestObservationTime(new Date("2026-08-17T16:09:00Z")), "2026-08-17T23:00");
  assert.equal(latestObservationTime(new Date("2026-08-17T16:10:00Z")), "2026-08-18T01:00");
});

test("keeps intraday totals while carrying the latest official ranks", () => {
  const current = [{ code: "01", normal: 905.1, precipitation: 650.4, ratio: 71.9, rank: null }] as const;
  const official = [{ code: "01", normal: 899.5, precipitation: 641.6, ratio: 71.4, rank: 9 }] as const;

  const merged = mergeAggregateRanks(current, official);

  assert.deepEqual(merged, [{ code: "01", normal: 905.1, precipitation: 650.4, ratio: 71.9, rank: 9 }]);
});
