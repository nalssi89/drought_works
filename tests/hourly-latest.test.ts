import assert from "node:assert/strict";
import test from "node:test";

import {
  REPRESENTATIVE_STATIONS,
  completeLatestHourlyObservation,
} from "../supabase/functions/_shared/hourly-observation.ts";

function hourlyLine(time: string, station: number, rain: number): string {
  const fields = Array.from({ length: 49 }, () => "-9");
  fields[0] = time;
  fields[1] = String(station);
  fields[16] = String(rain);
  return fields.join(" ");
}

test("uses the latest published KST hour instead of assuming the scheduled timestamp", async () => {
  const currentText = [
    hourlyLine("202608220700", 108, 1),
    ...REPRESENTATIVE_STATIONS.map((station) => hourlyLine("202608220800", station, 2)),
  ].join("\n");

  const result = await completeLatestHourlyObservation({
    currentText,
    fetchRangeText: async () => "",
  });

  assert.equal(result.observationTime, "202608220800");
  assert.equal(result.rain.size, 66);
  assert.equal(result.rain.get(108), 2);
  assert.deepEqual(result.defaultedStations, []);
});

test("fills a missing representative station from its latest same-day range observation", async () => {
  const currentText = REPRESENTATIVE_STATIONS
    .filter((station) => station !== 284)
    .map((station) => hourlyLine("202608220800", station, 0))
    .join("\n");
  const rangeRequests: Array<readonly [string, string, readonly number[]]> = [];

  const result = await completeLatestHourlyObservation({
    currentText,
    fetchRangeText: async (startTime, endTime, stations) => {
      rangeRequests.push([startTime, endTime, stations]);
      return hourlyLine("202608220700", 284, 0.4);
    },
  });

  assert.deepEqual(rangeRequests, [["202608220000", "202608220800", [284]]]);
  assert.equal(result.rain.get(284), 0.4);
  assert.deepEqual(result.carriedFrom, new Map([[284, "202608220700"]]));
  assert.deepEqual(result.defaultedStations, []);
});

test("never carries the previous day's RN_DAY into a new date", async () => {
  const currentText = REPRESENTATIVE_STATIONS
    .filter((station) => station !== 284)
    .map((station) => hourlyLine("202608220800", station, 0))
    .join("\n");

  const result = await completeLatestHourlyObservation({
    currentText,
    fetchRangeText: async () => hourlyLine("202608211700", 284, 12.3),
  });

  assert.equal(result.rain.get(284), 0);
  assert.deepEqual(result.defaultedStations, [284]);
  assert.equal(result.carriedFrom.has(284), false);
});
