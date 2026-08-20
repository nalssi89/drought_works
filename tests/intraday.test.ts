import assert from "node:assert/strict";
import test from "node:test";

import {
  adjustStation,
  periodBoundaryDates,
  latestObservationTime,
  mergeAggregateRanks,
  parseDailyNormals,
  parseHourlyDailyRain,
  parseObservationTime,
  periodStart,
} from "../app/lib/intraday.ts";
import {
  cacheFreshness,
  parseDate,
} from "../app/lib/precipitation.ts";
import { millisecondsUntilNextHourlyRefresh } from "../app/lib/refresh.ts";
import { OfficialDataUnavailableError, refreshOfficial } from "../supabase/functions/kma-hourly-cache/official-refresh.ts";
import {
  REPRESENTATIVE_STATIONS,
  aggregateOfficialStations,
  finalizeOfficialStations,
  parseOfficialDailyRain,
} from "../supabase/functions/kma-hourly-cache/daily-rollover.ts";

test("moves the rolling window start to D+1", () => {
  assert.equal(periodStart("2026-08-18", "1m"), "2026-07-19");
  assert.equal(periodStart("2026-08-18", "3m"), "2026-05-19");
  assert.equal(periodStart("2026-08-18", "6m"), "2026-02-19");
  assert.equal(periodStart("2026-08-18", "12m"), "2025-08-19");
});

test("keeps the removed boundary day separate from the intraday start day", () => {
  assert.deepEqual(periodBoundaryDates("2026-08-18", "6m"), {
    startDate: "2026-02-19",
    removedDate: "2026-02-18",
    endDate: "2026-08-18",
  });
});

test("reads RN_DAY and treats KMA missing-rain sentinels as zero", () => {
  const rows = [
    "# header",
    "202608181800 108 11 0.9 -9 -9.0 -9 1006.6 1008.6 2 0.5 29.7 23.3 69.0 28.6 -9.0 -9.0 -9.0 -9.0",
    "202608181800 159 11 0.9 -9 -9.0 -9 1006.6 1008.6 2 0.5 29.7 23.3 69.0 28.6 3.4 119.3 119.3 -9.0",
  ].join("\n");

  const rain = parseHourlyDailyRain(rows, "2026-08-18T18:00");
  assert.equal(rain.get(108), 0);
  assert.equal(rain.get(159), 119.3);
});

test("parses only the requested hourly timestamp", () => {
  const fields = (rain: string) => {
    const row = Array.from({ length: 20 }, () => "-9");
    row[0] = "202608181800";
    row[1] = "108";
    row[16] = rain;
    return row.join(" ");
  };
  const rows = `${fields("3.4")}\n${fields("9.1").replace("202608181800", "202608181900")}`;
  const rain = parseHourlyDailyRain(rows, "2026-08-18T19:00");

  assert.deepEqual([...rain.entries()], [[108, 9.1]]);
});

test("uses official replacement normals for Daegu and Jeonju", () => {
  const rows = [
    "2021,860,8,18,23.9,27.1,21.1,7.9,-99.9,1.9,83.4,24.7,4.6,-99.9,1007.5,1009.6,=",
    "2021,864,8,18,23.9,27.1,21.1,8.6,-99.9,1.9,83.4,24.7,4.6,-99.9,1007.5,1009.6,=",
  ].join("\n");

  const normals = parseDailyNormals(rows, "2026-08-18");
  assert.equal(normals.get(860), 7.9);
  assert.equal(normals.get(864), 8.6);
});

test("parses only the requested daily normal date", () => {
  const rows = [
    "2021,860,8,18,23.9,27.1,21.1,7.9,-99.9,1.9,83.4,24.7,4.6,-99.9,1007.5,1009.6,=",
    "2021,860,8,19,23.9,27.1,21.1,12.4,-99.9,1.9,83.4,24.7,4.6,-99.9,1007.5,1009.6,=",
  ].join("\n");

  assert.equal(parseDailyNormals(rows, "2026-08-19").get(860), 12.4);
});

test("rejects malformed, unsupported, and future dates", () => {
  assert.equal(parseDate("2026-02-30"), null);
  assert.equal(parseDate("1972-12-31"), null);
  assert.equal(parseDate("2099-01-01"), null);
  assert.equal(parseObservationTime("2026-02-30T01:00"), null);
  assert.equal(parseObservationTime("2099-01-01T01:00"), null);
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

test("marks intraday cache stale sooner than official cache", () => {
  const fetchedAt = new Date(Date.now() - 3 * 60 * 60_000).toISOString();

  assert.equal(cacheFreshness(fetchedAt, "intraday").stale, true);
  assert.equal(cacheFreshness(fetchedAt, "official").stale, false);
});

test("keeps intraday totals while carrying the latest official ranks", () => {
  const current = [{ code: "01", normal: 905.1, precipitation: 650.4, ratio: 71.9, rank: null }] as const;
  const official = [{ code: "01", normal: 899.5, precipitation: 641.6, ratio: 71.4, rank: 9 }] as const;

  const merged = mergeAggregateRanks(current, official);

  assert.deepEqual(merged, [{ code: "01", normal: 905.1, precipitation: 650.4, ratio: 71.9, rank: 9 }]);
});

test("defers an official refresh when KMA daily aggregates are not ready", async () => {
  const result = await refreshOfficial(async () => {
    throw new OfficialDataUnavailableError();
  });

  assert.equal(result, "deferred");
});

test("uses the ASOS daily fallback when KMA regional aggregates are not ready", async () => {
  let fallbackRuns = 0;

  const result = await refreshOfficial(
    async () => {
      throw new OfficialDataUnavailableError();
    },
    async () => {
      fallbackRuns += 1;
    },
  );

  assert.equal(result, "updated");
  assert.equal(fallbackRuns, 1);
});

test("reads final RN_DAY from the KMA ASOS daily response", () => {
  const rows = REPRESENTATIVE_STATIONS.map((station) => {
    const fields = Array.from({ length: 56 }, () => "-9");
    fields[0] = "20260818";
    fields[1] = String(station);
    fields[38] = station === 108 ? "12.4" : "-9.0";
    return fields.join(" ");
  }).join("\n");

  const rain = parseOfficialDailyRain(rows, "2026-08-18");

  assert.equal(rain.get(90), 0);
  assert.equal(rain.get(108), 12.4);
});

test("finalizes the official day and carries the last published ranks", () => {
  const stations = REPRESENTATIVE_STATIONS.map((code) => ({ code, name: String(code), normal: 100, precipitation: 50, ratio: 50 }));
  const hourlyRain = new Map(REPRESENTATIVE_STATIONS.map((code) => [code, 0]));
  const dailyRain = new Map(hourlyRain);
  dailyRain.set(108, 6);
  const aggregates = aggregateOfficialStations(stations);

  const result = finalizeOfficialStations({
    stations,
    hourlyRain,
    dailyRain,
    regions: aggregates.regions.map((row) => ({ ...row, rank: 7 })),
    admins: aggregates.admins.map((row) => ({ ...row, rank: 8 })),
  });

  assert.equal(result.stations.find((row) => row.code === 108)?.precipitation, 56);
  assert.deepEqual(result.regions[0], { code: "01", normal: 100, precipitation: 51, ratio: 51, rank: 7 });
  assert.equal(result.admins[0]?.rank, 8);
});
