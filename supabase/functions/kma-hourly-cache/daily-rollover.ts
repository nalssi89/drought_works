import { OfficialDataUnavailableError } from "./official-refresh.ts";

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

export type Period = "1m" | "3m" | "6m" | "12m";
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

export function periodBoundaryDates(endDate: string, period: Period): Readonly<{ startDate: string; removedDate: string; endDate: string }> {
  const months = { "1m": 1, "3m": 3, "6m": 6, "12m": 12 }[period];
  const startDate = addDays(addMonths(endDate, -months), 1);
  return { startDate, removedDate: addDays(startDate, -1), endDate };
}

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

const GANGWON = [...GROUPS.yeongseo, ...GROUPS.yeongdong] as const;
const NATIONAL = [
  ...GROUPS.metro, ...GANGWON, ...GROUPS.chungbuk, ...GROUPS.chungnam,
  ...GROUPS.jeonbuk, ...GROUPS.jeonnam, ...GROUPS.gyeongbuk, ...GROUPS.gyeongnam,
] as const;
const REGION_CODES = Array.from({ length: 12 }, (_, index) => String(index + 1).padStart(2, "0"));
const ADMIN_CODES = Array.from({ length: 4 }, (_, index) => String(index + 1).padStart(2, "0"));

export const REPRESENTATIVE_STATIONS: readonly number[] = [
  ...NATIONAL,
  ...GROUPS.jeju,
];

export function parseOfficialDailyRain(text: string, date: string): Map<number, number> {
  const result = new Map<number, number>();
  const compactDate = date.replaceAll("-", "");
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith(`${compactDate} `)) continue;
    const fields = line.trim().split(/\s+/);
    const station = Number(fields[1]);
    const dailyRain = Number(fields[38]);
    if (Number.isInteger(station) && Number.isFinite(dailyRain)) {
      if (result.has(station)) throw new OfficialDataUnavailableError();
      result.set(station, Math.max(0, dailyRain));
    }
  }
  if (result.size !== REPRESENTATIVE_STATIONS.length || REPRESENTATIVE_STATIONS.some((code) => !result.has(code))) throw new OfficialDataUnavailableError();
  return result;
}

export function parseCachePayload(
  value: unknown,
  expected: Readonly<{ period: Period; effectiveDate: string; mode: Mode }>,
): CachePayload {
  if (!isRecord(value) || value.schemaVersion !== 2 || value.period !== expected.period || value.mode !== expected.mode || value.effectiveDate !== expected.effectiveDate || !Array.isArray(value.stations) || value.stations.length !== 66 || !Array.isArray(value.regions) || value.regions.length !== 12 || !Array.isArray(value.admins) || value.admins.length !== 4 || typeof value.fetchedAt !== "string") throw new OfficialDataUnavailableError();
  const stations = value.stations.map((item) => {
    if (!isRecord(item) || typeof item.code !== "number" || typeof item.name !== "string" || typeof item.normal !== "number" || !Number.isFinite(item.normal) || item.normal < 0 || typeof item.precipitation !== "number" || !Number.isFinite(item.precipitation) || item.precipitation < 0 || typeof item.ratio !== "number" || !Number.isFinite(item.ratio) || item.ratio < 0) throw new OfficialDataUnavailableError();
    return { code: item.code, name: item.name, normal: item.normal, precipitation: item.precipitation, ratio: item.ratio };
  });
  if (new Set(stations.map((station) => station.code)).size !== REPRESENTATIVE_STATIONS.length || REPRESENTATIVE_STATIONS.some((code) => !stations.some((station) => station.code === code))) throw new OfficialDataUnavailableError();
  const source = value.source === "daily" || value.source === "hydro" || value.source === "intraday" ? value.source : expected.mode === "official" ? "hydro" : "intraday";
  const observationTime = typeof value.observationTime === "string" ? value.observationTime : null;
  const regions = value.regions.map(parseAggregate);
  const admins = value.admins.map(parseAggregate);
  if (!hasCodes(regions, REGION_CODES) || !hasCodes(admins, ADMIN_CODES)) throw new OfficialDataUnavailableError();
  return { schemaVersion: 2, ...expected, observationTime, stations, regions, admins, fetchedAt: value.fetchedAt, source };
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

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function addMonths(date: string, months: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  const day = value.getUTCDate();
  value.setUTCDate(1);
  value.setUTCMonth(value.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0)).getUTCDate();
  value.setUTCDate(Math.min(day, lastDay));
  return value.toISOString().slice(0, 10);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAggregate(value: unknown): AggregateValue {
  if (!isRecord(value) || typeof value.code !== "string" || typeof value.normal !== "number" || !Number.isFinite(value.normal) || value.normal < 0 || typeof value.precipitation !== "number" || !Number.isFinite(value.precipitation) || value.precipitation < 0 || typeof value.ratio !== "number" || !Number.isFinite(value.ratio) || value.ratio < 0 || (value.rank !== null && (typeof value.rank !== "number" || !Number.isInteger(value.rank) || value.rank <= 0))) throw new OfficialDataUnavailableError();
  return { code: value.code, normal: value.normal, precipitation: value.precipitation, ratio: value.ratio, rank: value.rank };
}

function hasCodes(rows: readonly AggregateValue[], expected: readonly string[]): boolean {
  const codes = new Set(rows.map((row) => row.code));
  return codes.size === expected.length && expected.every((code) => codes.has(code));
}
