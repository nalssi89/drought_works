import assert from "node:assert/strict";
import test from "node:test";

import { parseDailyNormalTotals } from "../app/lib/api-hub.ts";
import { customIntradayHref } from "../app/lib/custom-query.ts";
import {
  adjustStation,
  extendStation,
  latestObservationTime,
  mergeAggregateRanks,
  parseDailyNormals,
  parseHourlyDailyRain,
  parseOfficialDailyRainTotals,
  periodStart,
} from "../app/lib/intraday.ts";
import { millisecondsUntilNextHourlyRefresh } from "../app/lib/refresh.ts";
import { IncompleteHourlyObservationError, completeHourlyObservation } from "../supabase/functions/_shared/hourly-observation.ts";
import { OfficialDataUnavailableError, refreshOfficial } from "../supabase/functions/kma-hourly-cache/official-refresh.ts";
import {
  REPRESENTATIVE_STATIONS,
  aggregateOfficialStations,
  extendOfficialStations,
  finalizeOfficialStations,
  parseOfficialDailyRain,
} from "../supabase/functions/kma-hourly-cache/daily-rollover.ts";

function hourlyLine(time: string, station: number, rain: number): string {
  const fields = Array.from({ length: 49 }, () => "-9");
  fields[0] = time;
  fields[1] = String(station);
  fields[16] = String(rain);
  return fields.join(" ");
}

test("moves the rolling window start to D+1", () => {
  assert.equal(periodStart("2026-08-18", "1m"), "2026-07-19");
  assert.equal(periodStart("2026-08-18", "3m"), "2026-05-19");
  assert.equal(periodStart("2026-08-18", "6m"), "2026-02-19");
  assert.equal(periodStart("2026-08-18", "12m"), "2025-08-19");
});

test("starts the year-to-date period on January 1", () => {
  assert.equal(periodStart("2026-08-18", "ty"), "2026-01-01");
  assert.equal(periodStart("2027-01-01", "ty"), "2027-01-01");
});

test("keeps the arbitrary end date when intraday mode is enabled", () => {
  assert.equal(
    customIntradayHref("2026-08-17", "2026-02-18", "2026-08-17T18:00"),
    "/?date=2026-08-17&period=custom&start=2026-02-18&intraday=1&time=2026-08-17T18%3A00",
  );
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

test("carries the latest same-day RN_DAY when one representative station is absent", async () => {
  const observationTime = "202608211200";
  const currentText = REPRESENTATIVE_STATIONS
    .filter((station) => station !== 277)
    .map((station) => hourlyLine(observationTime, station, 0))
    .join("\n");
  const requestedTimes: string[] = [];

  const result = await completeHourlyObservation({
    observationTime,
    currentText,
    fetchFallbackText: async (time) => {
      requestedTimes.push(time);
      return time === "202608211000" ? hourlyLine(time, 277, 0.4) : "";
    },
  });

  assert.equal(result.rain.get(277), 0.4);
  assert.deepEqual(result.carriedFrom, new Map([[277, "202608211000"]]));
  assert.deepEqual(requestedTimes, ["202608211100", "202608211000"]);
  assert.equal(parseHourlyDailyRain(result.text).get(277), 0.4);
});

test("carries multiple missing stations from their latest same-day observations", async () => {
  const observationTime = "202608211200";
  const missingStations = [271, 272, 273, 277, 278, 279, 281] as const;
  const missingStationSet = new Set<number>(missingStations);
  const currentText = REPRESENTATIVE_STATIONS
    .filter((station) => !missingStationSet.has(station))
    .map((station) => hourlyLine(observationTime, station, 0))
    .join("\n");

  const result = await completeHourlyObservation({
    observationTime,
    currentText,
    fetchFallbackText: async (time, stations) => {
      const available = time === "202608211100" ? stations.slice(0, 3) : stations;
      return available.map((station) => hourlyLine(time, station, station / 10)).join("\n");
    },
  });

  assert.equal(result.rain.size, 66);
  assert.deepEqual(
    [...result.carriedFrom.entries()],
    missingStations.map((station, index) => [station, index < 3 ? "202608211100" : "202608211000"]),
  );
});

test("completes a requested historical boundary station without requiring all 66 stations", async () => {
  const observationTime = "202603040000";

  const result = await completeHourlyObservation({
    observationTime,
    currentText: hourlyLine(observationTime, 100, 6.7),
    stations: [100],
    fetchFallbackText: async () => "",
  });

  assert.deepEqual(result.rain, new Map([[100, 6.7]]));
});

test("does not carry an hourly station value across midnight", async () => {
  const observationTime = "202608210100";
  const currentText = REPRESENTATIVE_STATIONS
    .filter((station) => station !== 277)
    .map((station) => hourlyLine(observationTime, station, 0))
    .join("\n");
  const requestedTimes: string[] = [];

  await assert.rejects(
    completeHourlyObservation({
      observationTime,
      currentText,
      fetchFallbackText: async (time) => {
        requestedTimes.push(time);
        return time === "202608202300" ? hourlyLine(time, 277, 5) : "";
      },
    }),
    (error) => error instanceof IncompleteHourlyObservationError && error.missingStations.includes(277),
  );
  assert.deepEqual(requestedTimes, ["202608210000"]);
});

test("does not relabel a wholly unavailable hour with prior-hour observations", async () => {
  let fallbackCalls = 0;

  await assert.rejects(
    completeHourlyObservation({
      observationTime: "202608211200",
      currentText: hourlyLine("202608211200", 999, 1),
      fetchFallbackText: async () => {
        fallbackCalls += 1;
        return REPRESENTATIVE_STATIONS.map((station) => hourlyLine("202608211100", station, 0)).join("\n");
      },
    }),
    IncompleteHourlyObservationError,
  );
  assert.equal(fallbackCalls, 0);
});

test("keeps the representative station universe fixed", () => {
  assert.deepEqual([...REPRESENTATIVE_STATIONS].sort((left, right) => left - right), [
    90, 95, 100, 101, 105, 108, 112, 114, 119, 127, 129, 130, 131, 133, 135, 136, 138,
    140, 143, 146, 152, 155, 156, 159, 162, 165, 168, 170, 184, 185, 188, 189, 192, 201,
    202, 203, 211, 212, 216, 221, 226, 232, 235, 236, 238, 243, 244, 245, 247, 248, 260,
    261, 262, 271, 272, 273, 277, 278, 279, 281, 284, 285, 288, 289, 294, 295,
  ]);
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

test("extends the year-to-date total without removing January 1", () => {
  const result = extendStation({
    baseNormal: 900,
    basePrecipitation: 700,
    endDayNormal: 8,
    endDayPrecipitation: 12,
  });

  assert.deepEqual(result, { precipitation: 712, normal: 908, ratio: 78.4 });
});

test("extends cached year-to-date stations for the hourly refresh", () => {
  const stations = [{ code: 108, name: "서울", normal: 900, precipitation: 700, ratio: 77.8 }] as const;
  const endRain = new Map([[108, 12]]);
  const endNormal = new Map([[108, 8]]);

  const result = extendOfficialStations(stations, endRain, endNormal);

  assert.deepEqual(result, [{ code: 108, name: "서울", precipitation: 712, normal: 908, ratio: 78.4 }]);
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

test("defers an official refresh when KMA daily aggregates are not ready", async () => {
  const result = await refreshOfficial(async () => {
    throw new OfficialDataUnavailableError();
  });

  assert.equal(result, "deferred");
});

test("does not hide an unexpected official refresh failure", async () => {
  const failure = new TypeError("daily endpoint failed");

  await assert.rejects(
    refreshOfficial(async () => {
      throw failure;
    }),
    failure,
  );
});

test("ignores climatological February 29 in a non-leap target year", () => {
  const rows = [
    "2021,108,2,28,0,0,0,1.0",
    "2021,108,2,29,0,0,0,9.0",
    "2021,108,3,1,0,0,0,2.0",
  ].join("\n");

  assert.equal(parseDailyNormalTotals(rows, 2026).get(108), 3);
  assert.equal(parseDailyNormalTotals(rows, 2028).get(108), 12);
});

test("reads RN_DSUM and treats -99.9 as zero from the KMA daily rainfall response", () => {
  const rows = Array.from({ length: 60 }, (_, index) => {
    const fields = Array.from({ length: 11 }, () => "-999");
    fields[0] = "20260818";
    fields[1] = String(90 + index);
    fields[5] = index === 18 ? "12.4" : "-99.9";
    return fields.join(" ");
  }).join("\n");

  const rain = parseOfficialDailyRain(rows, "2026-08-18");

  assert.equal(rain.get(90), 0);
  assert.equal(rain.get(108), 12.4);
});

test("totals a multi-day RN_DSUM range and requires every representative station day", () => {
  const rows = ["20260801", "20260802"].flatMap((date, dayIndex) => REPRESENTATIVE_STATIONS.map((station) => {
    const fields = Array.from({ length: 11 }, () => "-999");
    fields[0] = date;
    fields[1] = String(station);
    fields[5] = station === 108 ? (dayIndex === 0 ? "12.4" : "-99.9") : "0.0";
    return fields.join(" ");
  }));

  const rain = parseOfficialDailyRainTotals(rows.join("\n"), "2026-08-01", "2026-08-02");

  assert.equal(rain.size, REPRESENTATIVE_STATIONS.length);
  assert.equal(rain.get(108), 12.4);
  assert.throws(
    () => parseOfficialDailyRainTotals(rows.slice(1).join("\n"), "2026-08-01", "2026-08-02"),
    /자료가 완전하지 않습니다/,
  );
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
