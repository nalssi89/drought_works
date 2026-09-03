import { KMA_NORMAL_CODE, KMA_STATION_CODES } from "./kma-stations.ts";

type RollingPeriod = "1m" | "3m" | "6m" | "12m";
type Period = RollingPeriod | "ty";

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

const MONTHS: Record<RollingPeriod, number> = { "1m": 1, "3m": 3, "6m": 6, "12m": 12 };
const KST_DATE_TIME_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
});
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
const REPRESENTATIVE_STATIONS = new Set(KMA_STATION_CODES);

export function periodStart(endDate: string, period: Period): string {
  if (period === "ty") return `${endDate.slice(0, 4)}-01-01`;
  return addDays(addMonths(endDate, -MONTHS[period]), 1);
}

export function parseObservationTime(value: string | undefined): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}T(?:0[1-9]|1\d|2[0-3]):00$/.test(value)) return null;
  const parsed = new Date(`${value}:00+09:00`);
  return Number.isNaN(parsed.valueOf()) ? null : value;
}

export function latestObservationTime(now = new Date()): string {
  const reliable = new Date(now.valueOf() - 10 * 60_000);
  const parts = KST_DATE_TIME_FORMATTER.formatToParts(reliable);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const date = `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
  const hour = Number(values.get("hour"));
  return hour === 0 ? `${addDays(date, -1)}T23:00` : `${date}T${String(hour).padStart(2, "0")}:00`;
}

export function parseHourlyDailyRain(text: string): Map<number, number> {
  const result = new Map<number, number>();
  for (const line of text.split(/\r?\n/)) {
    if (!/^\d{12}\s/.test(line)) continue;
    const fields = line.trim().split(/\s+/);
    const station = Number(fields[1]);
    const dailyRain = Number(fields[16]);
    if (Number.isInteger(station) && Number.isFinite(dailyRain)) result.set(station, Math.max(0, dailyRain));
  }
  return result;
}

export function parseOfficialDailyRain(text: string, date: string): Map<number, number> {
  const result = new Map<number, number>();
  const compactDate = date.replaceAll("-", "");
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith(`${compactDate} `) && !line.startsWith(`${compactDate},`)) continue;
    const fields = dailyFields(line);
    const station = Number(fields[1]);
    const dailyRain = Number(fields[5]);
    if (!Number.isInteger(station) || !REPRESENTATIVE_STATIONS.has(station) || !Number.isFinite(dailyRain)) continue;
    result.set(station, Math.max(0, dailyRain));
  }
  return result;
}

export function parseOfficialDailyRainTotals(
  text: string,
  startDate: string,
  endDate: string,
): Map<number, number> {
  const start = startDate.replaceAll("-", "");
  const end = endDate.replaceAll("-", "");
  const totals = new Map<number, number>();
  const counts = new Map<number, number>();
  const observations = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (!/^\d{8}(?:\s|,)/.test(line)) continue;
    const fields = dailyFields(line);
    const date = fields[0];
    const station = Number(fields[1]);
    const dailyRain = Number(fields[5]);
    if (date < start || date > end || !Number.isInteger(station) || !REPRESENTATIVE_STATIONS.has(station) || !Number.isFinite(dailyRain)) continue;
    const key = `${date}:${station}`;
    if (observations.has(key)) throw new TypeError(`중복된 일강수 자료입니다: ${key}`);
    observations.add(key);
    totals.set(station, round1((totals.get(station) ?? 0) + Math.max(0, dailyRain)));
    counts.set(station, (counts.get(station) ?? 0) + 1);
  }

  if (observations.size === 0) return totals;
  const expectedDays = dateDifference(startDate, endDate) + 1;
  for (const station of KMA_STATION_CODES) {
    if (counts.get(station) !== expectedDays) throw new TypeError(`일강수 ${station} 지점 자료가 완전하지 않습니다.`);
  }
  return totals;
}

export function parseDailyNormals(text: string): Map<number, number> {
  const result = new Map<number, number>();
  for (const line of text.split(/\r?\n/)) {
    if (!/^2021,/.test(line)) continue;
    const fields = line.split(",").map((field) => field.trim());
    const station = Number(fields[1]);
    const rain = Number(fields[7]);
    if (Number.isInteger(station) && Number.isFinite(rain) && rain >= 0) result.set(station, rain);
  }
  return result;
}

export function adjustStation(input: Readonly<{
  baseNormal: number;
  basePrecipitation: number;
  startDayNormal: number;
  startDayPrecipitation: number;
  endDayNormal: number;
  endDayPrecipitation: number;
}>): Readonly<{ normal: number; precipitation: number; ratio: number }> {
  const precipitation = round1(Math.max(0, input.basePrecipitation - input.startDayPrecipitation + input.endDayPrecipitation));
  const normal = round1(Math.max(0, input.baseNormal - input.startDayNormal + input.endDayNormal));
  return { precipitation, normal, ratio: normal > 0 ? round1(precipitation / normal * 100) : 0 };
}

export function extendStation(input: Readonly<{
  baseNormal: number;
  basePrecipitation: number;
  endDayNormal: number;
  endDayPrecipitation: number;
}>): Readonly<{ normal: number; precipitation: number; ratio: number }> {
  const precipitation = round1(input.basePrecipitation + input.endDayPrecipitation);
  const normal = round1(input.baseNormal + input.endDayNormal);
  return { precipitation, normal, ratio: normal > 0 ? round1(precipitation / normal * 100) : 0 };
}

export function adjustStations(
  base: readonly StationValue[],
  startRain: ReadonlyMap<number, number>,
  endRain: ReadonlyMap<number, number>,
  startNormals: ReadonlyMap<number, number>,
  endNormals: ReadonlyMap<number, number>,
): StationValue[] {
  return base.map((station) => {
    const normalCode = KMA_NORMAL_CODE.get(station.code) ?? station.code;
    const values = {
      startDayPrecipitation: required(startRain, station.code, "시작일 시간강수"),
      endDayPrecipitation: required(endRain, station.code, "종료일 시간강수"),
      startDayNormal: required(startNormals, normalCode, "시작일 평년값"),
      endDayNormal: required(endNormals, normalCode, "종료일 평년값"),
      baseNormal: station.normal,
      basePrecipitation: station.precipitation,
    };
    return { ...station, ...adjustStation(values) };
  });
}

export function extendStations(
  base: readonly StationValue[],
  endRain: ReadonlyMap<number, number>,
  endNormals: ReadonlyMap<number, number>,
): StationValue[] {
  return base.map((station) => {
    const normalCode = KMA_NORMAL_CODE.get(station.code) ?? station.code;
    return {
      ...station,
      ...extendStation({
        baseNormal: station.normal,
        basePrecipitation: station.precipitation,
        endDayNormal: required(endNormals, normalCode, "종료일 평년값"),
        endDayPrecipitation: required(endRain, station.code, "종료일 시간강수"),
      }),
    };
  });
}

export function aggregateStations(stations: readonly StationValue[]): Readonly<{
  regions: AggregateValue[];
  admins: AggregateValue[];
}> {
  const gangwon = [...GROUPS.yeongseo, ...GROUPS.yeongdong];
  const national = [...GROUPS.metro, ...gangwon, ...GROUPS.chungbuk, ...GROUPS.chungnam, ...GROUPS.jeonbuk, ...GROUPS.jeonnam, ...GROUPS.gyeongbuk, ...GROUPS.gyeongnam];
  const regions = [
    GROUPS.metro, gangwon, GROUPS.yeongseo, GROUPS.yeongdong, GROUPS.chungbuk, GROUPS.chungnam,
    GROUPS.jeonbuk, GROUPS.jeonnam, GROUPS.gyeongbuk, GROUPS.gyeongnam, GROUPS.jeju, national,
  ].map((codes, index) => aggregate(String(index + 1).padStart(2, "0"), codes, stations));
  const admins = [
    [...GROUPS.metro, ...gangwon, ...GROUPS.chungbuk, ...GROUPS.chungnam],
    [...GROUPS.jeonbuk, ...GROUPS.jeonnam, ...GROUPS.gyeongbuk, ...GROUPS.gyeongnam],
    GROUPS.jeju,
    national,
  ].map((codes, index) => aggregate(String(index + 1).padStart(2, "0"), codes, stations));
  return { regions, admins };
}

export function mergeAggregateRanks(
  current: readonly AggregateValue[],
  official: readonly AggregateValue[],
): AggregateValue[] {
  const ranks = new Map(official.map((row) => [row.code, row.rank]));
  return current.map((row) => ({ ...row, rank: ranks.get(row.code) ?? null }));
}

function aggregate(code: string, codes: readonly number[], stations: readonly StationValue[]): AggregateValue {
  const selected = codes.map((stationCode) => {
    const station = stations.find((row) => row.code === stationCode);
    if (!station) throw new TypeError(`대표지점 ${stationCode} 자료가 없습니다.`);
    return station;
  });
  const precipitation = average(selected.map((row) => row.precipitation));
  const normal = average(selected.map((row) => row.normal));
  return { code, precipitation, normal, ratio: normal > 0 ? round1(precipitation / normal * 100) : 0, rank: null };
}

function required(values: ReadonlyMap<number, number>, code: number, label: string): number {
  const value = values.get(code);
  if (value === undefined) throw new TypeError(`${label} ${code} 지점 자료가 없습니다.`);
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

function dateDifference(startDate: string, endDate: string): number {
  return Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000);
}

function dailyFields(line: string): string[] {
  return line.includes(",") ? line.split(",").map((field) => field.trim()) : line.trim().split(/\s+/);
}
