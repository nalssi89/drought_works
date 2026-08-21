import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateFutureScenario,
  emptyRainfallByRegion,
  futureRangeIssue,
  parseRainfallByRegion,
  scenarioWindow,
} from "../app/lib/future-scenario.ts";
import { aggregateStations } from "../app/lib/intraday.ts";
import { STATION_REGIONS } from "../app/lib/station-presentation.ts";

const STATION_CODES = STATION_REGIONS.flatMap((region) => [...region.codes]);

function baseStations() {
  return STATION_CODES.map((code) => ({ code, name: String(code), precipitation: 100, normal: 200, ratio: 50 }));
}

test("moves a one-month window and keeps all assumed rainfall when the horizon fits", () => {
  const window = scenarioWindow("2026-08-21", "2026-09-20", "1m");
  assert.deepEqual(window, {
    baseStartDate: "2026-07-22",
    targetStartDate: "2026-08-21",
    removedStartDate: "2026-07-22",
    removedEndDate: "2026-08-20",
    removesEntireBaseWindow: false,
    futureNormalStartDate: "2026-08-22",
    futureNormalEndDate: "2026-09-20",
    horizonDays: 30,
    includedFutureDays: 30,
    horizonHours: 720,
    includedFutureHours: 720,
    assumedRainfallFraction: 1,
  });
});

test("uses only the rainfall fraction overlapping a short rolling window", () => {
  const window = scenarioWindow("2026-08-21", "2026-10-20", "1m");
  assert.equal(window.removesEntireBaseWindow, true);
  assert.equal(window.futureNormalStartDate, "2026-09-21");
  assert.equal(window.horizonDays, 60);
  assert.equal(window.includedFutureDays, 30);
  assert.equal(window.horizonHours, 1_440);
  assert.equal(window.includedFutureHours, 720);
  assert.equal(window.assumedRainfallFraction, 0.5);
});

test("resets year-to-date at New Year and prorates the scenario rainfall", () => {
  const window = scenarioWindow("2026-12-20", "2027-01-20", "ty");
  assert.equal(window.targetStartDate, "2027-01-01");
  assert.equal(window.removesEntireBaseWindow, true);
  assert.equal(window.horizonDays, 31);
  assert.equal(window.includedFutureDays, 20);
  assert.equal(window.horizonHours, 744);
  assert.equal(window.includedFutureHours, 480);
  assert.equal(window.assumedRainfallFraction, 20 / 31);
});

test("starts an intraday scenario after the selected observation hour", () => {
  const window = scenarioWindow("2026-08-21", "2026-10-20", "1m", "2026-08-21T18:00");
  assert.equal(window.horizonHours, 1_446);
  assert.equal(window.includedFutureHours, 720);
  assert.equal(window.assumedRainfallFraction, 720 / 1_446);
});

test("applies regional rainfall and shows ratio decline for zero-rain regions", () => {
  const stations = baseStations();
  const baseline = aggregateStations(stations);
  const removed = new Map(STATION_CODES.map((code) => [code, { precipitation: 10, normal: 20 }]));
  const futureNormals = new Map(STATION_CODES.map((code) => [code, 30]));
  futureNormals.set(860, 30);
  futureNormals.set(864, 30);
  const rainfall = emptyRainfallByRegion(0);
  const result = calculateFutureScenario({
    baseStations: stations,
    baseRegions: baseline.regions,
    baseAdmins: baseline.admins,
    removedTotals: removed,
    futureNormals,
    rainfallByRegion: { ...rainfall, metro: 100 },
    assumedRainfallFraction: 1,
  });

  const seoul = result.stations.find((row) => row.code === 108);
  assert.deepEqual(seoul, {
    code: 108,
    name: "108",
    baselinePrecipitation: 100,
    baselineNormal: 200,
    baselineRatio: 50,
    precipitation: 190,
    normal: 210,
    ratio: 90.5,
    scenarioPrecipitation: 100,
    precipitationDelta: 90,
    normalDelta: 10,
    ratioDelta: 40.5,
  });

  const sokcho = result.stations.find((row) => row.code === 90);
  assert.equal(sokcho?.scenarioPrecipitation, 0);
  assert.equal(sokcho?.precipitation, 90);
  assert.equal(sokcho?.normal, 210);
  assert.equal(sokcho?.ratio, 42.9);
  assert.equal(sokcho?.ratioDelta, -7.1);

  const metro = result.regions.find((row) => row.code === "01");
  assert.equal(metro?.baselinePrecipitation, 100);
  assert.equal(metro?.baselineNormal, 200);
  assert.equal(metro?.baselineRatio, 50);
  assert.equal(metro?.scenarioPrecipitation, 100);
  assert.equal(metro?.precipitationDelta, 90);
  assert.equal(metro?.ratioDelta, 40.5);
});

test("defaults every region to 100 mm when no rainfall query is supplied", () => {
  const rainfall = parseRainfallByRegion(() => undefined);
  assert.deepEqual(rainfall, emptyRainfallByRegion(100));
});

test("parses a common rainfall value with a regional override", () => {
  const values = new Map([
    ["rain_all", "100"],
    ["rain_jeju", "0"],
    ["rain_gyeongnam", "75.5"],
  ]);
  const rainfall = parseRainfallByRegion((name) => values.get(name));
  assert.equal(rainfall.metro, 100);
  assert.equal(rainfall.jeju, 0);
  assert.equal(rainfall.gyeongnam, 75.5);
});

test("requires a future target within 366 days", () => {
  assert.equal(futureRangeIssue("2026-08-21", "2026-08-21"), "미래 시점은 기준일보다 늦어야 합니다.");
  assert.equal(futureRangeIssue("2026-08-21", "2027-08-23"), "향후 강수 시나리오는 기준일 이후 최대 366일까지 산출할 수 있습니다.");
  assert.equal(futureRangeIssue("2026-08-21", "2027-08-22"), null);
});
