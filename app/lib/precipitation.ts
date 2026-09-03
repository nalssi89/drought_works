import ky, { HTTPError, TimeoutError } from "ky";
import { z } from "zod";
import {
  fetchDailyNormalRange,
  fetchDailyNormals,
  fetchHourlyDailyRain,
  fetchOfficialDailyRain,
  fetchOfficialDailyRainRange,
} from "./api-hub";
import {
  adjustStations,
  aggregateStations,
  extendStations,
  latestObservationTime,
  mergeAggregateRanks,
  parseObservationTime,
  periodStart,
} from "./intraday";
import { KMA_NORMAL_CODE, KMA_STATIONS } from "./kma-stations.ts";

export { latestObservationTime, parseObservationTime };

const PERIODS = ["1m", "3m", "6m", "12m", "ty"] as const;
const KST_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export const periodSchema = z.enum(PERIODS);
export type Period = z.infer<typeof periodSchema>;

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
});

const cachedStationSchema = z.object({
  code: z.number().int(),
  name: z.string().min(1),
  normal: z.number().nonnegative(),
  precipitation: z.number().nonnegative(),
  ratio: z.number().nonnegative(),
});

const cachedAggregateSchema = z.object({
  code: z.string(),
  normal: z.number().nonnegative(),
  precipitation: z.number().nonnegative(),
  ratio: z.number().nonnegative(),
  rank: z.number().int().positive().nullable(),
});

const cachedPayloadSchema = z.object({
  schemaVersion: z.literal(2),
  period: periodSchema,
  effectiveDate: dateSchema,
  mode: z.enum(["official", "intraday", "rollover"]),
  observationTime: z.string().regex(/^\d{4}-\d{2}-\d{2}T(?:0\d|1\d|2[0-3]):00$/).nullable(),
  stations: z.array(cachedStationSchema).length(66),
  regions: z.array(cachedAggregateSchema).default([]),
  admins: z.array(cachedAggregateSchema).default([]),
  fetchedAt: z.string().datetime(),
  source: z.enum(["daily", "hourly", "intraday"]),
}).refine((value) => (
  (value.mode === "official" && value.source === "daily")
  || (value.mode === "rollover" && value.source === "hourly")
  || (value.mode === "intraday" && value.source === "intraday")
), { message: "예약 갱신 자료의 자료원과 산출 모드가 다릅니다." });

export type ScenarioComparison = Readonly<{
  baselinePrecipitation?: number;
  baselineNormal?: number;
  baselineRatio?: number;
  scenarioPrecipitation?: number;
  precipitationDelta?: number;
  normalDelta?: number;
  ratioDelta?: number;
}>;

export type Aggregate = Readonly<{
  code: string;
  normal: number;
  precipitation: number;
  ratio: number;
  rank: number | null;
}> & ScenarioComparison;

export type Station = Readonly<{
  code: number;
  name: string;
  normal: number;
  precipitation: number;
  ratio: number;
}> & ScenarioComparison;

export type DashboardData = Readonly<{
  requestedDate: string;
  effectiveDate: string;
  searchPeriod: string;
  period: Period;
  regions: readonly Aggregate[];
  admins: readonly Aggregate[];
  stations: readonly Station[];
  fetchedAt: string;
  mode: "official" | "intraday" | "rollover" | "future";
  observationTime: string | null;
  baseMode?: "official" | "intraday";
  baseEffectiveDate?: string;
  scenarioTargetDate?: string;
  scenarioRainfall?: Readonly<Record<string, number>>;
  scenarioHorizonDays?: number;
  scenarioIncludedDays?: number;
  scenarioHorizonHours?: number;
  scenarioIncludedHours?: number;
  scenarioRainfallFraction?: number;
}>;

export type DashboardResult =
  | Readonly<{ kind: "ok"; data: DashboardData }>
  | Readonly<{ kind: "missing"; requestedDate: string }>
  | Readonly<{ kind: "unavailable"; message: string }>;

export function parseDate(value: string | undefined): string | null {
  const result = dateSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function latestCandidateDate(): string {
  const parts = KST_DATE_FORMATTER.formatToParts(new Date());
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const year = values.get("year");
  const month = values.get("month");
  const day = values.get("day");
  if (!year || !month || !day) return new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  return addDays(`${year}-${month}-${day}`, -1);
}

export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function addMonths(date: string, months: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  const day = value.getUTCDate();
  value.setUTCDate(1);
  value.setUTCMonth(value.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0)).getUTCDate();
  value.setUTCDate(Math.min(day, lastDay));
  return value.toISOString().slice(0, 10);
}

export async function loadDashboard(requestedDate: string | null, period: Period, observationTime: string | null = null, useCachedLatest = false): Promise<DashboardResult> {
  if (useCachedLatest) {
    const cached = await loadCachedDashboard(period, observationTime ? "intraday" : "completed");
    if (cached.kind === "ok") return cached;
  }
  if (observationTime) return loadIntradayDashboard(observationTime, period);
  if (requestedDate) return loadOne(requestedDate, period);
  let candidate = latestCandidateDate();
  for (let attempt = 0; attempt < 7; attempt += 1) {
    const result = await loadOne(candidate, period);
    if (result.kind !== "missing") return result;
    candidate = addDays(candidate, -1);
  }
  return { kind: "unavailable", message: "최근 7일 안에 완료된 공식 일자료를 찾지 못했습니다." };
}

async function loadCachedDashboard(period: Period, mode: "official" | "intraday" | "completed"): Promise<DashboardResult> {
  const cacheUrl = process.env.KMA_CACHE_URL;
  const proxyKey = process.env.KMA_PROXY_ANON_KEY;
  if (!cacheUrl || !proxyKey) return { kind: "unavailable", message: "예약 갱신 자료가 설정되지 않았습니다." };
  try {
    const value = await ky.get(cacheUrl, {
      searchParams: { period, mode },
      headers: { apikey: proxyKey, Authorization: `Bearer ${proxyKey}` },
      retry: { limit: 2, methods: ["get"] },
      timeout: 20_000,
    }).json<unknown>();
    const cached = cachedPayloadSchema.parse(value);
    const modeMatches = mode === "completed"
      ? cached.mode === "official" || cached.mode === "rollover"
      : cached.mode === mode;
    if (cached.period !== period || !modeMatches) throw new TypeError("예약 갱신 자료의 조회 조건이 다릅니다.");
    const stations = cached.stations.map((station) => ({ ...station }));
    const calculated = aggregateStations(stations);
    const regions = cached.mode === "official" && cached.regions.length === 12 ? cached.regions : mergeAggregateRanks(calculated.regions, cached.regions);
    const admins = cached.mode === "official" && cached.admins.length === 4 ? cached.admins : mergeAggregateRanks(calculated.admins, cached.admins);
    const startDate = periodStart(cached.effectiveDate, period);
    const elapsedHours = cached.observationTime ? Number(cached.observationTime.slice(11, 13)) : 24;
    return {
      kind: "ok",
      data: {
        requestedDate: cached.effectiveDate,
        effectiveDate: cached.effectiveDate,
        searchPeriod: cached.mode === "intraday"
          ? `${displayDate(startDate)} 00시 ~ ${displayDate(cached.effectiveDate)} ${String(elapsedHours).padStart(2, "0")}시 (당일 관측 반영 추정)`
          : `${displayDate(startDate)} ~ ${displayDate(cached.effectiveDate)}`,
        period,
        regions,
        admins,
        stations,
        fetchedAt: cached.fetchedAt,
        mode: cached.mode,
        observationTime: cached.observationTime,
      },
    };
  } catch (error) {
    if (error instanceof HTTPError || error instanceof TimeoutError || error instanceof TypeError || error instanceof z.ZodError) {
      return { kind: "unavailable", message: "예약 갱신 자료를 불러오지 못했습니다." };
    }
    throw error;
  }
}

async function loadOne(requestedDate: string, period: Period): Promise<DashboardResult> {
  try {
    const startDate = periodStart(requestedDate, period);
    const [rain, normals] = await Promise.all([
      fetchOfficialDailyRainRange(startDate, requestedDate),
      fetchDailyNormalRange(startDate, requestedDate),
    ]);
    if (rain.size === 0) return { kind: "missing", requestedDate };
    const stations = KMA_STATIONS.map(([code, name]) => {
      const precipitation = required(rain, code, "일강수");
      const normal = required(normals, KMA_NORMAL_CODE.get(code) ?? code, "일평년값");
      return { code, name, precipitation, normal, ratio: normal > 0 ? round1(precipitation / normal * 100) : 0 };
    });
    const aggregates = aggregateStations(stations);
    return {
      kind: "ok",
      data: {
        requestedDate,
        effectiveDate: requestedDate,
        searchPeriod: `${displayDate(startDate)} ~ ${displayDate(requestedDate)}`,
        period,
        regions: aggregates.regions,
        admins: aggregates.admins,
        stations,
        fetchedAt: new Date().toISOString(),
        mode: "official",
        observationTime: null,
      },
    };
  } catch (error) {
    if (error instanceof HTTPError || error instanceof TimeoutError || error instanceof TypeError || error instanceof z.ZodError) {
      return { kind: "unavailable", message: "기상청 공식 자료를 불러오지 못했습니다. 잠시 후 다시 조회해 주세요." };
    }
    throw error;
  }
}

async function loadIntradayDashboard(observationTime: string, period: Period): Promise<DashboardResult> {
  const effectiveDate = observationTime.slice(0, 10);
  const elapsedHours = Number(observationTime.slice(11, 13));
  const baseDate = addDays(effectiveDate, -1);
  const cachedBase = await loadCachedDashboard(period, "official");
  const base = cachedBase.kind === "ok" && cachedBase.data.effectiveDate === baseDate
    ? cachedBase
    : await loadOne(baseDate, period);
  if (base.kind !== "ok") return base;

  const startDate = periodStart(effectiveDate, period);
  try {
    const [endRain, endNormals] = await Promise.all([
      fetchHourlyDailyRain(observationTime),
      fetchDailyNormals(effectiveDate),
    ]);
    const stations = period === "ty"
      ? extendStations(base.data.stations, endRain, endNormals)
      : await Promise.all([
        fetchOfficialDailyRain(addDays(startDate, -1)),
        fetchDailyNormals(addDays(startDate, -1)),
      ]).then(([startRain, startNormals]) => adjustStations(base.data.stations, startRain, endRain, startNormals, endNormals));
    const calculated = aggregateStations(stations);
    const regions = mergeAggregateRanks(calculated.regions, base.data.regions);
    const admins = mergeAggregateRanks(calculated.admins, base.data.admins);
    return {
      kind: "ok",
      data: {
        requestedDate: effectiveDate,
        effectiveDate,
        searchPeriod: `${displayDate(startDate)} 00시 ~ ${displayDate(effectiveDate)} ${String(elapsedHours).padStart(2, "0")}시 (당일 관측 반영 추정)`,
        period,
        regions,
        admins,
        stations,
        fetchedAt: new Date().toISOString(),
        mode: "intraday",
        observationTime,
      },
    };
  } catch (error) {
    if (error instanceof HTTPError || error instanceof TimeoutError || error instanceof TypeError || error instanceof z.ZodError) {
      return { kind: "unavailable", message: "기상청 시간자료 또는 평년값을 불러오지 못했습니다. 잠시 후 다시 조회해 주세요." };
    }
    throw error;
  }
}

function required(values: ReadonlyMap<number, number>, code: number, label: string): number {
  const value = values.get(code);
  if (value === undefined) throw new TypeError(`${label} ${code} 지점 자료가 없습니다.`);
  return value;
}

function round1(value: number): number {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

function displayDate(value: string): string {
  const [year, month, day] = value.split("-");
  return `${year}년 ${month}월 ${day}일`;
}
