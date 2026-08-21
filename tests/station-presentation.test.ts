import assert from "node:assert/strict";
import test from "node:test";

import {
  STATION_REGIONS,
  groupStationsByRegion,
  ratioCellClass,
  ratioThresholdClass,
} from "../app/lib/station-presentation.ts";

test("groups all 66 representative stations into the dashboard regions", () => {
  const stations = STATION_REGIONS
    .flatMap((region) => region.codes.map((code) => ({ code, name: String(code) })))
    .reverse();
  const groups = groupStationsByRegion(stations);

  assert.equal(groups.length, 10);
  assert.equal(groups.reduce((count, group) => count + group.stations.length, 0), 66);
  assert.deepEqual(groups.map((group) => group.label), [
    "서울·인천·경기도",
    "강원특별자치도 영서",
    "강원특별자치도 영동",
    "충청북도",
    "대전·세종·충청남도",
    "전북특별자치도",
    "광주·전라남도",
    "대구·경상북도",
    "부산·울산·경상남도",
    "제주특별자치도",
  ]);
  assert.deepEqual(groups[0]?.stations.map((station) => station.code), [108, 112, 119, 201, 202, 203]);
  assert.deepEqual(groups[1]?.stations.map((station) => station.code), [95, 101, 114, 211, 212]);
  assert.deepEqual(groups[2]?.stations.map((station) => station.code), [90, 100, 105, 216]);
});

test("keeps an unexpected station visible in a final other group", () => {
  const groups = groupStationsByRegion([{ code: 108 }, { code: 999 }]);

  assert.equal(groups.at(-1)?.label, "기타");
  assert.deepEqual(groups.at(-1)?.stations.map((station) => station.code), [999]);
});

test("assigns the defined precipitation-ratio colors at inclusive cutoffs", () => {
  assert.equal(ratioThresholdClass(45), "ratio-threshold-45");
  assert.equal(ratioThresholdClass(45.1), "ratio-threshold-55");
  assert.equal(ratioThresholdClass(55), "ratio-threshold-55");
  assert.equal(ratioThresholdClass(55.1), "ratio-threshold-65");
  assert.equal(ratioThresholdClass(65), "ratio-threshold-65");
  assert.equal(ratioThresholdClass(65.1), null);
  assert.equal(ratioCellClass(44.9), "ratio-value ratio-threshold-45");
  assert.equal(ratioCellClass(80), "ratio-value");
});
