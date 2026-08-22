import assert from "node:assert/strict";
import test from "node:test";

import {
  HourlySelectionUnavailableError,
  selectHourlyObservation,
} from "../supabase/functions/_shared/hourly-selection.ts";
import { REPRESENTATIVE_STATIONS } from "../supabase/functions/_shared/hourly-observation.ts";

function hourlyLine(time: string, station: number, rain: number): string {
  const fields = Array.from({ length: 49 }, () => "-9");
  fields[0] = time;
  fields[1] = String(station);
  fields[16] = String(rain);
  return fields.join(" ");
}

test("selects the requested explicit hour for all representative stations", () => {
  const requestedTime = "202608220800";
  const text = REPRESENTATIVE_STATIONS
    .map((station) => hourlyLine(requestedTime, station, station / 100))
    .join("\n");

  const selected = selectHourlyObservation(text, requestedTime);

  assert.equal(selected.text.trim().split(/\r?\n/).length, 66);
  assert.equal(selected.carriedFrom.size, 0);
  assert.deepEqual(selected.zeroFilledStations, []);
});

test("carries the latest same-day RN_DAY when a station is absent at the requested hour", () => {
  const requestedTime = "202608220800";
  const missingStation = 284;
  const current = REPRESENTATIVE_STATIONS
    .filter((station) => station !== missingStation)
    .map((station) => hourlyLine(requestedTime, station, 0));
  const earlier = hourlyLine("202608220700", missingStation, 3.2);

  const selected = selectHourlyObservation([...current, earlier].join("\n"), requestedTime);

  assert.equal(selected.carriedFrom.get(missingStation), "202608220700");
  assert.equal(selected.zeroFilledStations.length, 0);
  const carriedLine = selected.text.split(/\r?\n/).find((line) => line.includes(` ${missingStation} `));
  assert.equal(carriedLine?.split(/\s+/)[16], "3.2");
});

test("zero-fills a representative station that has no observation on the requested date", () => {
  const requestedTime = "202608220800";
  const missingStation = 284;
  const current = REPRESENTATIVE_STATIONS
    .filter((station) => station !== missingStation)
    .map((station) => hourlyLine(requestedTime, station, 0));
  current.push(hourlyLine("202608212300", missingStation, 9.9));

  const selected = selectHourlyObservation(current.join("\n"), requestedTime);

  assert.deepEqual(selected.zeroFilledStations, [missingStation]);
  assert.equal(selected.carriedFrom.has(missingStation), false);
  const zeroLine = selected.text.split(/\r?\n/).find((line) => line.includes(` ${missingStation} `));
  assert.equal(zeroLine?.split(/\s+/)[0], requestedTime);
  assert.equal(zeroLine?.split(/\s+/)[16], "0.0");
});

test("never carries a future observation into an earlier requested time", () => {
  const requestedTime = "202608220700";
  const missingStation = 284;
  const current = REPRESENTATIVE_STATIONS
    .filter((station) => station !== missingStation)
    .map((station) => hourlyLine(requestedTime, station, 0));
  current.push(hourlyLine("202608220800", missingStation, 8.8));

  const selected = selectHourlyObservation(current.join("\n"), requestedTime);

  assert.deepEqual(selected.zeroFilledStations, [missingStation]);
});

test("rejects a range with no representative observation", () => {
  assert.throws(
    () => selectHourlyObservation(hourlyLine("202608220800", 999, 1), "202608220800"),
    HourlySelectionUnavailableError,
  );
});
