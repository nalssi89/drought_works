import { OfficialDataUnavailableError } from "./official-refresh.ts";

export { REPRESENTATIVE_STATIONS } from "../_shared/hourly-observation.ts";

export type StationValue = Readonly<{
  code: number;
  name: string;
  normal: number;
  precipitation: number;
  ratio: number;
}>;

export type AggregateValue = Readonly<{
  code: string;
  normal: number;
  precipitation: number;
  ratio: number;
  rank: number | null;
}>;

export type Period = "1m" | "3m" | "6m" | "12m" | "ty";
export type Mode = "official" | "intraday";
export type CachePayload = Readonly<{
  schemaVersion: 2;
  period: Period;
  effectiveDate: string;
  mode: Mode;
  observationTime: string | null;
  stations: readonly StationValue[];
  regions: readonly AggregateValue[];
  admins: readonly AggregateValue[];
  fetchedAt: string;
  source: "hydro" | "daily" | "intraday";
}>;

type FinalizationInput = Readonly<{
  stations: readonly StationValue[];
  hourlyRain: ReadonlyMap<number, number>;
  dailyRain: ReadonlyMap<number, number>;
  regions: readonly AggregateValue[];
  admins: readonly AggregateValue[];
}>;

const GROUPS = {
  metro: [108, 112, 119, 201, 202, 203],
  yeongseo: [101, 114, 211, 212, 95],
  yeongdong: [100, 105, 216, 90],
  chungbuk: [127, 131, 135, 221, 226],
  chungnam: [129, 133, 232, 235, 236, 238],
  jeonbuk: [140, 146, 243, 244, 245, 247, 248],
  jeonnam: [156, 165, 168, 170, 260, 261, 262],
  gyeongbuk: [130, 136, 138, 143, 271, 272, 273, 277, 278, 279, 281],
  gyeongnam: [152, 155, 159, 162, 192, 284, 285, 288, 289, 294, 295],
  jeju: [184, 185, 188, 189],
} as const;
const NORMAL_CODE = new Map([[143, 860], [146, 864]]);

const GANGWON = [...GROUPS.yeongseo, ...GROUPS.yeongdong] as const;
const NATIONAL = [
  ...GROUPS.metro, ...GANGWON, ...GROUPS.chungbuk, ...GROUPS.chungnam,
  ...GROUPS.jeonbuk, ...GROUPS.jeonnam, ...GROUPS.gyeongbuk, ...GROUPS.gyeongnam,
] as const;

export function parseOfficialDailyRain(text: string, date: string): Map<number, number> {
  const result = new Map<number, number>();
  const compactDate = date.replaceAll("-", "");
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith(`${compactDate} `)) continue;
    const fields = line.trim().split(/\s+/);
    const station = Number(fields[1]);
    const dailyRain = Number(fields[2]);
    if (Number.isInteger(station) && Number.isFinite(dailyRain)) result.set(station, Math.max(0, dailyRain));
  }
  if (result.size < 60) throw new OfficialDataUnavailableError();
  return result;
}

export function parseCachePayload(
  value: unknown,
  expected: Readonly<{ period: Period; effectiveDate: string; mode: Mode }>,
): CachePayload {
  if (!isRecord(value) || value.schemaVersion !== 2 || value.period !== expected.period || value.mode !== expected.mode || value.effectiveDate !== expected.effectiveDate || !Array.isArray(value.stations) || value.stations.length !== 66 || !Array.isArray(value.regions) || value.regions.length !== 12 || !Array.isArray(value.admins) || value.admins.length !== 4 || typeof value.fetchedAt !== "string") throw new OfficialDataUnavailableError();
  const stations = value.stations.map((item) => {
    if (!isRecord(item) || typeof item.code !== "number" || typeof item.name !== "string" || typeof item.normal !== "number" || typeof item.precipitation !== "number" || typeof item.ratio !== "number") throw new OfficialDataUnavailableError();
    return { code: item.code, name: item.name, normal: item.normal, precipitation: item.precipitation, ratio: item.ratio };
  });
  const source = value.source === "daily" ? "daily" : expected.mode === "official" ? "hydro" : "intraday";
  const observationTime = typeof value.observationTime === "string" ? value.observationTime : null;
  return { schemaVersion: 2, ...expected, observationTime, stations, regions: value.regions.map(parseAggregate), admins: value.admins.map(parseAggregate), fetchedAt: value.fetchedAt, source };
}

export function aggregateOfficialStations(stations: readonly StationValue[]): Readonly<{
  regions: AggregateValue[];
  admins: AggregateValue[];
}> {
  const regions = [
    GROUPS.metro, GANGWON, GROUPS.yeongseo, GROUPS.yeongdong, GROUPS.chungbuk, GROUPS.chungnam,
    GROUPS.jeonbuk, GROUPS.jeonnam, GROUPS.gyeongbuk, GROUPS.gyeongnam, GROUPS.jeju, NATIONAL,
  ].map((codes, index) => aggregate(String(index + 1).padStart(2, "0"), codes, stations));
  const admins = [
    [...GROUPS.metro, ...GANGWON, ...GROUPS.chungbuk, ...GROUPS.chungnam],
    [...GROUPS.jeonbuk, ...GROUPS.jeonnam, ...GROUPS.gyeongbuk, ...GROUPS.gyeongnam],
    GROUPS.jeju,
    NATIONAL,
  ].map((codes, index) => aggregate(String(index + 1).padStart(2, "0"), codes, stations));
  return { regions, admins };
}

export function finalizeOfficialStations(input: FinalizationInput): Readonly<{
  stations: StationValue[];
  regions: AggregateValue[];
  admins: AggregateValue[];
}> {
  const stations = input.stations.map((station) => {
    const precipitation = round1(Math.max(
      0,
      station.precipitation - required(input.hourlyRain, station.code) + required(input.dailyRain, station.code),
    ));
    return { ...station, precipitation, ratio: station.normal > 0 ? round1(precipitation / station.normal * 100) : 0 };
  });
  const aggregates = aggregateOfficialStations(stations);
  return {
    stations,
    regions: mergeRanks(aggregates.regions, input.regions),
    admins: mergeRanks(aggregates.admins, input.admins),
  };
}

export function extendOfficialStations(
  stations: readonly StationValue[],
  endRain: ReadonlyMap<number, number>,
  endNormal: ReadonlyMap<number, number>,
): StationValue[] {
  return stations.map((station) => {
    const normalCode = NORMAL_CODE.get(station.code) ?? station.code;
    const precipitation = round1(station.precipitation + required(endRain, station.code));
    const normal = round1(station.normal + required(endNormal, normalCode));
    return { ...station, precipitation, normal, ratio: normal > 0 ? round1(precipitation / normal * 100) : 0 };
  });
}

function aggregate(code: string, codes: readonly number[], stations: readonly StationValue[]): AggregateValue {
  const selected = codes.map((stationCode) => {
    const station = stations.find((row) => row.code === stationCode);
    if (!station) throw new OfficialDataUnavailableError();
    return station;
  });
  const precipitation = average(selected.map((row) => row.precipitation));
  const normal = average(selected.map((row) => row.normal));
  return { code, precipitation, normal, ratio: normal > 0 ? round1(precipitation / normal * 100) : 0, rank: null };
}

function mergeRanks(current: readonly AggregateValue[], published: readonly AggregateValue[]): AggregateValue[] {
  const ranks = new Map(published.map((row) => [row.code, row.rank]));
  return current.map((row) => ({ ...row, rank: ranks.get(row.code) ?? null }));
}

function required(values: ReadonlyMap<number, number>, code: number): number {
  const value = values.get(code);
  if (value === undefined) throw new OfficialDataUnavailableError();
  return value;
}

function average(values: readonly number[]): number {
  return round1(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function round1(value: number): number {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAggregate(value: unknown): AggregateValue {
  if (!isRecord(value) || typeof value.code !== "string" || typeof value.normal !== "number" || typeof value.precipitation !== "number" || typeof value.ratio !== "number" || (value.rank !== null && (typeof value.rank !== "number" || !Number.isInteger(value.rank) || value.rank <= 0))) throw new OfficialDataUnavailableError();
  return { code: value.code, normal: value.normal, precipitation: value.precipitation, ratio: value.ratio, rank: value.rank };
}
