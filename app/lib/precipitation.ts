import ky, { HTTPError, TimeoutError } from "ky";
import { z } from "zod";
import { fetchDailyNormals, fetchHourlyDailyRain } from "./api-hub.ts";
import {
  adjustStations,
  aggregateStations,
  latestObservationTime,
  mergeAggregateRanks,
  parseObservationTime,
  periodBoundaryDates,
  periodStart,
  REPRESENTATIVE_STATION_CODES,
} from "./intraday.ts";

export { latestObservationTime, parseObservationTime };

const PERIODS = ["1m", "3m", "6m", "12m"] as const;
const REGION_CODES = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"] as const;
const ADMIN_CODES = ["01", "02", "03", "04"] as const;
const CACHE_MAX_AGE_MS = { official: 36 * 60 * 60_000, intraday: 2 * 60 * 60_000 } as const;
const MIN_SUPPORTED_DATE = "1973-01-01";
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

const aggregateSchema = z.object({
  brtc_cd: z.enum(REGION_CODES),
  ny_prcp: z.string(),
  rn_total: z.string(),
  rn_ratio: z.string(),
  rank_num: z.string(),
});

const adminSchema = aggregateSchema.extend({ brtc_cd: z.enum(ADMIN_CODES) });
const stationSchema = z.object({
  stn_cd: z.number().int(),
  stn_nm: z.string().min(1),
  ny_prcp: z.string(),
  rn_total: z.string(),
  rn_ratio_sort: z.number().finite(),
});

const payloadSchema = z.object({
  list1: z.array(aggregateSchema).default([]),
  list2: z.array(stationSchema).default([]),
  list_admin: z.array(adminSchema).default([]),
  search_period: z.string().optional(),
  search_date_db: z.string().optional(),
});

const cachedStationSchema = z.object({
  code: z.number().int(),
  name: z.string().min(1),
  normal: z.number().finite().nonnegative(),
  precipitation: z.number().finite().nonnegative(),
  ratio: z.number().finite().nonnegative(),
});

const cachedAggregateSchema = z.object({
  code: z.string(),
  normal: z.number().finite().nonnegative(),
  precipitation: z.number().finite().nonnegative(),
  ratio: z.number().finite().nonnegative(),
  rank: z.number().int().positive().nullable(),
});

const cachedPayloadSchema = z.object({
  schemaVersion: z.literal(2),
  period: periodSchema,
  effectiveDate: dateSchema,
  mode: z.enum(["official", "intraday"]),
  observationTime: z.string().regex(/^\d{4}-\d{2}-\d{2}T(?:0\d|1\d|2[0-3]):00$/).nullable(),
  stations: z.array(cachedStationSchema).length(66),
  regions: z.array(cachedAggregateSchema).length(12),
  admins: z.array(cachedAggregateSchema).length(4),
  fetchedAt: z.string().datetime(),
  source: z.enum(["hydro", "daily", "intraday"]).optional(),
});

export type Aggregate = Readonly<{
  code: string;
  normal: number;
  precipitation: number;
  ratio: number;
  rank: number | null;
}>;

export type Station = Readonly<{
  code: number;
  name: string;
  normal: number;
  precipitation: number;
  ratio: number;
}>;

export type DashboardData = Readonly<{
  requestedDate: string;
  effectiveDate: string;
  searchPeriod: string;
  period: Period;
  regions: readonly Aggregate[];
  admins: readonly Aggregate[];
  stations: readonly Station[];
  fetchedAt: string;
  mode: "official" | "intraday";
  observationTime: string | null;
  source: "hydro" | "daily" | "intraday";
  stale: boolean;
  ageMinutes: number;
}>;

export type DashboardResult =
  | Readonly<{ kind: "ok"; data: DashboardData }>
  | Readonly<{ kind: "missing"; requestedDate: string }>
  | Readonly<{ kind: "unavailable"; message: string }>;

export type CacheFreshness = Readonly<{ stale: boolean; ageMinutes: number }>;

export function cacheFreshness(fetchedAt: string, mode: "official" | "intraday", now = Date.now()): CacheFreshness {
  const fetchedTime = Date.parse(fetchedAt);
  const ageMinutes = Number.isFinite(fetchedTime) ? Math.max(0, Math.round((now - fetchedTime) / 60_000)) : Number.POSITIVE_INFINITY;
  const futureSkew = Number.isFinite(fetchedTime) && fetchedTime - now > 5 * 60_000;
  return { stale: futureSkew || !Number.isFinite(fetchedTime) || now - fetchedTime > CACHE_MAX_AGE_MS[mode], ageMinutes };
}

export function parseDate(value: string | undefined): string | null {
  const result = dateSchema.safeParse(value);
  if (!result.success || result.data < MIN_SUPPORTED_DATE || result.data > currentKstDate()) return null;
  return result.data;
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
  let staleCached: DashboardResult | null = null;
  if (useCachedLatest) {
    const cached = await loadCachedDashboard(period, observationTime ? "intraday" : "official");
    if (cached.kind === "ok" && !cached.data.stale) return cached;
    if (cached.kind === "ok") staleCached = cached;
  }
  if (observationTime) {
    const live = await loadIntradayDashboard(observationTime, period);
    return live.kind === "ok" || staleCached === null ? live : staleCached;
  }
  if (requestedDate) return loadOne(requestedDate, period);
  let candidate = latestCandidateDate();
  let lastUnavailable: DashboardResult | null = null;
  for (let attempt = 0; attempt < 7; attempt += 1) {
    const result = await loadOne(candidate, period);
    if (result.kind === "ok") return result;
    if (result.kind === "unavailable") lastUnavailable = result;
    candidate = addDays(candidate, -1);
  }
  return staleCached ?? lastUnavailable ?? { kind: "unavailable", message: "최근 7일 안에 완료된 공식 일자료를 찾지 못했습니다." };
}

async function loadCachedDashboard(period: Period, mode: "official" | "intraday"): Promise<DashboardResult> {
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
    if (cached.period !== period || cached.mode !== mode) throw new TypeError("예약 갱신 자료의 조회 조건이 다릅니다.");
    if (parseDate(cached.effectiveDate) !== cached.effectiveDate || (cached.observationTime && parseObservationTime(cached.observationTime) === null)) {
      throw new TypeError("예약 갱신 자료의 기준일 또는 관측시각이 유효하지 않습니다.");
    }
    validateCachedIdentity(cached);
    const stations = cached.stations.map((station) => ({ ...station }));
    const calculated = aggregateStations(stations);
    const regions = mode === "official" ? cached.regions : mergeAggregateRanks(calculated.regions, cached.regions);
    const admins = mode === "official" ? cached.admins : mergeAggregateRanks(calculated.admins, cached.admins);
    const startDate = periodStart(cached.effectiveDate, period);
    const elapsedHours = cached.observationTime ? Number(cached.observationTime.slice(11, 13)) : 24;
    const source = cached.source ?? (mode === "official" ? "hydro" : "intraday");
    const freshness = cacheFreshness(cached.fetchedAt, mode);
    return {
      kind: "ok",
      data: {
        requestedDate: cached.effectiveDate,
        effectiveDate: cached.effectiveDate,
        searchPeriod: mode === "official"
          ? `${displayDate(startDate)} ~ ${displayDate(cached.effectiveDate)}`
          : `${displayDate(startDate)} 00시 ~ ${displayDate(cached.effectiveDate)} ${String(elapsedHours).padStart(2, "0")}시 (당일 관측 반영 추정)`,
        period,
        regions,
        admins,
        stations,
        fetchedAt: cached.fetchedAt,
        mode,
        observationTime: cached.observationTime,
        source,
        stale: freshness.stale,
        ageMinutes: freshness.ageMinutes,
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
    const response = await fetchOfficialPayload(requestedDate, period);
    const payload = payloadSchema.parse(response);
    if (payload.list1.length === 0 && payload.list2.length === 0) return { kind: "missing", requestedDate };
    const effectiveDate = parseOfficialDate(payload.search_date_db);
    if (payload.list1.length !== 12 || payload.list2.length !== 66 || payload.list_admin.length !== 4 || !payload.search_period || effectiveDate !== requestedDate) {
      return { kind: "unavailable", message: "공식 서버 응답의 지점 또는 권역 수가 예상과 다릅니다." };
    }
    validateOfficialIdentity(payload);
    return {
      kind: "ok",
      data: {
        requestedDate,
        effectiveDate,
        searchPeriod: payload.search_period,
        period,
        regions: payload.list1.map(toAggregate),
        admins: payload.list_admin.map(toAggregate),
        stations: payload.list2.map((row) => ({
          code: row.stn_cd,
          name: row.stn_nm,
          normal: numeric(row.ny_prcp),
          precipitation: numeric(row.rn_total),
          ratio: row.rn_ratio_sort,
        })),
        fetchedAt: new Date().toISOString(),
        mode: "official",
        observationTime: null,
        source: "hydro",
        stale: false,
        ageMinutes: 0,
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
  const base = await loadOne(baseDate, period);
  if (base.kind !== "ok") return base;

    const boundary = periodBoundaryDates(effectiveDate, period);
    try {
      const [startRain, endRain, startNormals, endNormals] = await Promise.all([
      fetchHourlyDailyRain(`${boundary.removedDate}T00:00`),
      fetchHourlyDailyRain(observationTime),
      fetchDailyNormals(boundary.removedDate),
      fetchDailyNormals(effectiveDate),
    ]);
    const stations = adjustStations(base.data.stations, startRain, endRain, startNormals, endNormals);
    const calculated = aggregateStations(stations);
    const regions = mergeAggregateRanks(calculated.regions, base.data.regions);
    const admins = mergeAggregateRanks(calculated.admins, base.data.admins);
    return {
      kind: "ok",
      data: {
        requestedDate: effectiveDate,
        effectiveDate,
        searchPeriod: `${displayDate(boundary.startDate)} 00시 ~ ${displayDate(effectiveDate)} ${String(elapsedHours).padStart(2, "0")}시 (당일 관측 반영 추정)`,
        period,
        regions,
        admins,
        stations,
        fetchedAt: new Date().toISOString(),
        mode: "intraday",
        observationTime,
        source: "intraday",
        stale: false,
        ageMinutes: 0,
      },
    };
  } catch (error) {
    if (error instanceof HTTPError || error instanceof TimeoutError || error instanceof TypeError || error instanceof z.ZodError) {
      return { kind: "unavailable", message: "기상청 시간자료 또는 평년값을 불러오지 못했습니다. 잠시 후 다시 조회해 주세요." };
    }
    throw error;
  }
}

async function fetchOfficialPayload(requestedDate: string, period: Period): Promise<unknown> {
  const proxyUrl = process.env.KMA_PROXY_URL;
  const proxyKey = process.env.KMA_PROXY_ANON_KEY;
  if (proxyUrl && proxyKey) {
    return ky.get(proxyUrl, {
      searchParams: { date: requestedDate, period },
      headers: {
        apikey: proxyKey,
        Authorization: `Bearer ${proxyKey}`,
      },
      retry: { limit: 2, methods: ["get"] },
      timeout: 20_000,
    }).json<unknown>();
  }

  return ky.post("https://hydro.kma.go.kr/drought/analysisAccData.do", {
    body: new URLSearchParams({ PERIOD: period, search_date: requestedDate.replaceAll("-", "") }),
    headers: {
      Referer: "https://hydro.kma.go.kr/index.do",
      "X-Requested-With": "XMLHttpRequest",
    },
    retry: { limit: 2, methods: ["post"] },
    timeout: 15_000,
  }).json<unknown>();
}

function toAggregate(row: z.infer<typeof aggregateSchema>): Aggregate {
  return {
    code: row.brtc_cd,
    normal: numeric(row.ny_prcp),
    precipitation: numeric(row.rn_total),
    ratio: numeric(row.rn_ratio),
    rank: numericRank(row.rank_num),
  };
}

function numeric(value: string): number {
  const parsed = Number(value.replaceAll(",", ""));
  if (!Number.isFinite(parsed)) throw new TypeError(`Invalid numeric value: ${value}`);
  return parsed;
}

function numericRank(value: string): number | null {
  const parsed = Number(value.replaceAll(",", ""));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function validateCachedIdentity(cached: z.infer<typeof cachedPayloadSchema>): void {
  const stationCodes = new Set(cached.stations.map((station) => station.code));
  const regionCodes = new Set(cached.regions.map((row) => row.code));
  const adminCodes = new Set(cached.admins.map((row) => row.code));
  if (stationCodes.size !== REPRESENTATIVE_STATION_CODES.length || REPRESENTATIVE_STATION_CODES.some((code) => !stationCodes.has(code))) throw new TypeError("예약 갱신 자료의 지점 집합이 다릅니다.");
  if (regionCodes.size !== REGION_CODES.length || REGION_CODES.some((code) => !regionCodes.has(code))) throw new TypeError("예약 갱신 자료의 권역 집합이 다릅니다.");
  if (adminCodes.size !== ADMIN_CODES.length || ADMIN_CODES.some((code) => !adminCodes.has(code))) throw new TypeError("예약 갱신 자료의 집계 집합이 다릅니다.");
}

function validateOfficialIdentity(payload: z.infer<typeof payloadSchema>): void {
  const stationCodes = new Set(payload.list2.map((station) => station.stn_cd));
  const regionCodes = new Set(payload.list1.map((row) => row.brtc_cd));
  const adminCodes = new Set(payload.list_admin.map((row) => row.brtc_cd));
  if (stationCodes.size !== REPRESENTATIVE_STATION_CODES.length || REPRESENTATIVE_STATION_CODES.some((code) => !stationCodes.has(code))) throw new TypeError("공식 응답의 지점 집합이 다릅니다.");
  if (regionCodes.size !== REGION_CODES.length || REGION_CODES.some((code) => !regionCodes.has(code))) throw new TypeError("공식 응답의 권역 집합이 다릅니다.");
  if (adminCodes.size !== ADMIN_CODES.length || ADMIN_CODES.some((code) => !adminCodes.has(code))) throw new TypeError("공식 응답의 집계 집합이 다릅니다.");
}

function parseOfficialDate(value: string | undefined): string | null {
  if (!value || !/^\d{8}$/.test(value)) return null;
  const date = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  return parseDate(date);
}

function currentKstDate(now = new Date()): string {
  const parts = KST_DATE_FORMATTER.formatToParts(now);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
}

function displayDate(value: string): string {
  const [year, month, day] = value.split("-");
  return `${year}년 ${month}월 ${day}일`;
}
