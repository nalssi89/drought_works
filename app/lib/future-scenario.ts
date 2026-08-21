import { aggregateStations, periodStart } from "./intraday.ts";
import type { Aggregate, Period, Station } from "./precipitation.ts";
import { STATION_REGIONS, stationRegionKey, type StationRegionKey } from "./station-presentation.ts";

export const FUTURE_PERIOD = "future" as const;
export type PeriodSelection = Period | typeof FUTURE_PERIOD;
export type FutureBaseMode = "official" | "intraday";
export type RainfallByRegion = Readonly<Record<StationRegionKey, number>>;

export type RangeStationTotal = Readonly<{
  precipitation: number;
  normal: number;
}>;

export type ScenarioWindow = Readonly<{
  baseStartDate: string;
  targetStartDate: string;
  removedStartDate: string | null;
  removedEndDate: string | null;
  removesEntireBaseWindow: boolean;
  futureNormalStartDate: string;
  futureNormalEndDate: string;
  horizonDays: number;
  includedFutureDays: number;
  horizonHours: number;
  includedFutureHours: number;
  assumedRainfallFraction: number;
}>;

export type FutureScenarioCalculation = Readonly<{
  stations: readonly Station[];
  regions: readonly Aggregate[];
  admins: readonly Aggregate[];
}>;

const NORMAL_CODE = new Map([[143, 860], [146, 864]]);
const MAX_FUTURE_DAYS = 366;

export function emptyRainfallByRegion(value = 0): RainfallByRegion {
  return Object.fromEntries(STATION_REGIONS.map((region) => [region.key, value])) as Record<StationRegionKey, number>;
}

export function rainfallQueryName(region: StationRegionKey): string {
  return `rain_${region}`;
}

export function parseRainfallByRegion(
  valueFor: (name: string) => string | undefined,
): RainfallByRegion {
  const commonRaw = valueFor("rain_all");
  const regionalRaw = new Map(STATION_REGIONS.map((region) => [region.key, valueFor(rainfallQueryName(region.key))] as const));
  const hasAnyValue = commonRaw !== undefined || [...regionalRaw.values()].some((value) => value !== undefined);
  const common = hasAnyValue ? parseRainfall(commonRaw) : 100;
  return Object.fromEntries(STATION_REGIONS.map((region) => {
    const raw = regionalRaw.get(region.key);
    return [region.key, raw === undefined ? common : parseRainfall(raw)];
  })) as Record<StationRegionKey, number>;
}

export function futureRangeIssue(baseDate: string, targetDate: string): string | null {
  const elapsedDays = dateDifference(baseDate, targetDate);
  if (elapsedDays <= 0) return "미래 시점은 기준일보다 늦어야 합니다.";
  if (elapsedDays > MAX_FUTURE_DAYS) return "향후 강수 시나리오는 기준일 이후 최대 366일까지 산출할 수 있습니다.";
  return null;
}

export function defaultFutureDate(baseDate: string): string {
  return addDays(baseDate, 30);
}

export function scenarioWindow(
  baseDate: string,
  targetDate: string,
  period: Period,
  baseObservationTime: string | null = null,
): ScenarioWindow {
  const issue = futureRangeIssue(baseDate, targetDate);
  if (issue) throw new RangeError(issue);

  const baseStartDate = periodStart(baseDate, period);
  const targetStartDate = periodStart(targetDate, period);
  const horizonStartDate = addDays(baseDate, 1);
  const removesEntireBaseWindow = targetStartDate > baseDate;

  let removedStartDate: string | null = null;
  let removedEndDate: string | null = null;
  if (removesEntireBaseWindow) {
    removedStartDate = baseStartDate;
    removedEndDate = baseDate;
  }
  else if (targetStartDate > baseStartDate) {
    removedStartDate = baseStartDate;
    removedEndDate = addDays(targetStartDate, -1);
  }

  const futureNormalStartDate = maxDate(horizonStartDate, targetStartDate);
  const scenarioStart = baseObservationTime
    ? Date.parse(`${baseObservationTime}:00+09:00`)
    : Date.parse(`${horizonStartDate}T00:00:00+09:00`);
  if (!Number.isFinite(scenarioStart) || (baseObservationTime && baseObservationTime.slice(0, 10) !== baseDate)) {
    throw new RangeError("당일 기준 관측시각이 기준일과 일치하지 않습니다.");
  }
  const scenarioEnd = Date.parse(`${addDays(targetDate, 1)}T00:00:00+09:00`);
  const targetWindowStart = Date.parse(`${targetStartDate}T00:00:00+09:00`);
  const includedStart = Math.max(scenarioStart, targetWindowStart);
  const horizonHours = (scenarioEnd - scenarioStart) / 3_600_000;
  const includedFutureHours = (scenarioEnd - includedStart) / 3_600_000;
  const horizonDays = horizonHours / 24;
  const includedFutureDays = includedFutureHours / 24;

  return {
    baseStartDate,
    targetStartDate,
    removedStartDate,
    removedEndDate,
    removesEntireBaseWindow,
    futureNormalStartDate,
    futureNormalEndDate: targetDate,
    horizonDays,
    includedFutureDays,
    horizonHours,
    includedFutureHours,
    assumedRainfallFraction: includedFutureHours / horizonHours,
  };
}

export function calculateFutureScenario(input: Readonly<{
  baseStations: readonly Station[];
  baseRegions: readonly Aggregate[];
  baseAdmins: readonly Aggregate[];
  removedTotals: ReadonlyMap<number, RangeStationTotal>;
  futureNormals: ReadonlyMap<number, number>;
  rainfallByRegion: RainfallByRegion;
  assumedRainfallFraction: number;
}>): FutureScenarioCalculation {
  if (input.assumedRainfallFraction < 0 || input.assumedRainfallFraction > 1) {
    throw new RangeError("가정강수 반영 비율은 0~1 범위여야 합니다.");
  }

  const stations = input.baseStations.map((station) => {
    const region = stationRegionKey(station.code);
    if (!region) throw new TypeError(`대표지점 ${station.code}의 권역을 찾을 수 없습니다.`);
    const removed = input.removedTotals.get(station.code) ?? { precipitation: 0, normal: 0 };
    const normalCode = NORMAL_CODE.get(station.code) ?? station.code;
    const futureNormal = required(input.futureNormals, normalCode, "미래 일평년값");
    const scenarioPrecipitation = round1(input.rainfallByRegion[region] * input.assumedRainfallFraction);
    const precipitation = round1(Math.max(0, station.precipitation - removed.precipitation) + scenarioPrecipitation);
    const normal = round1(Math.max(0, station.normal - removed.normal) + futureNormal);
    const ratio = normal > 0 ? round1(precipitation / normal * 100) : 0;
    return {
      ...station,
      baselinePrecipitation: station.precipitation,
      baselineNormal: station.normal,
      baselineRatio: station.ratio,
      precipitation,
      normal,
      ratio,
      scenarioPrecipitation,
      precipitationDelta: round1(precipitation - station.precipitation),
      normalDelta: round1(normal - station.normal),
      ratioDelta: round1(ratio - station.ratio),
    };
  });

  const projected = aggregateStations(stations);
  const assumedOnly = aggregateStations(stations.map((station) => ({
    ...station,
    precipitation: station.scenarioPrecipitation ?? 0,
    normal: 1,
    ratio: 0,
  })));

  return {
    stations,
    regions: attachAggregateComparison(projected.regions, assumedOnly.regions, input.baseRegions),
    admins: attachAggregateComparison(projected.admins, assumedOnly.admins, input.baseAdmins),
  };
}

export function scenarioPeriodLabel(period: Period): string {
  if (period === "1m") return "최근 1개월";
  if (period === "3m") return "최근 3개월";
  if (period === "6m") return "최근 6개월";
  if (period === "12m") return "최근 1년";
  return "올해 누적";
}

function attachAggregateComparison(
  projected: readonly Aggregate[],
  assumedOnly: readonly Aggregate[],
  baseline: readonly Aggregate[],
): Aggregate[] {
  const baselineByCode = new Map(baseline.map((row) => [row.code, row]));
  const assumedByCode = new Map(assumedOnly.map((row) => [row.code, row.precipitation]));
  return projected.map((row) => {
    const base = baselineByCode.get(row.code);
    if (!base) throw new TypeError(`기준 집계 ${row.code} 자료가 없습니다.`);
    return {
      ...row,
      rank: null,
      baselinePrecipitation: base.precipitation,
      baselineNormal: base.normal,
      baselineRatio: base.ratio,
      scenarioPrecipitation: assumedByCode.get(row.code) ?? 0,
      precipitationDelta: round1(row.precipitation - base.precipitation),
      normalDelta: round1(row.normal - base.normal),
      ratioDelta: round1(row.ratio - base.ratio),
    };
  });
}

function parseRainfall(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.min(5_000, round1(parsed));
}

function required(values: ReadonlyMap<number, number>, code: number, label: string): number {
  const value = values.get(code);
  if (value === undefined) throw new TypeError(`${label} ${code} 지점 자료가 없습니다.`);
  return value;
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function dateDifference(startDate: string, endDate: string): number {
  return Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000);
}

function maxDate(left: string, right: string): string {
  return left >= right ? left : right;
}

function round1(value: number): number {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}
