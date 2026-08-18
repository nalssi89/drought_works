import ky, { HTTPError, TimeoutError } from "ky";
import { z } from "zod";
import { fetchDailyNormals, fetchHourlyDailyRain } from "./api-hub";
import {
  adjustStations,
  aggregateStations,
  latestObservationTime,
  parseObservationTime,
  periodStart,
} from "./intraday";

export { latestObservationTime, parseObservationTime };

const PERIODS = ["1m", "3m", "6m", "12m"] as const;
const REGION_CODES = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"] as const;
const ADMIN_CODES = ["01", "02", "03", "04"] as const;
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
  rn_ratio_sort: z.number(),
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
  mode: z.enum(["official", "intraday"]),
  observationTime: z.string().regex(/^\d{4}-\d{2}-\d{2}T(?:0\d|1\d|2[0-3]):00$/).nullable(),
  stations: z.array(cachedStationSchema).length(66),
  regions: z.array(cachedAggregateSchema).default([]),
  admins: z.array(cachedAggregateSchema).default([]),
  fetchedAt: z.string().datetime(),
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
    const cached = await loadCachedDashboard(period, observationTime ? "intraday" : "official");
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
    const stations = cached.stations.map((station) => ({ ...station }));
    const calculated = aggregateStations(stations);
    const regions = mode === "official" && cached.regions.length === 12 ? cached.regions : calculated.regions;
    const admins = mode === "official" && cached.admins.length === 4 ? cached.admins : calculated.admins;
    const startDate = periodStart(cached.effectiveDate, period);
    const elapsedHours = cached.observationTime ? Number(cached.observationTime.slice(11, 13)) : 24;
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
    if (payload.list1.length !== 12 || payload.list2.length !== 66 || payload.list_admin.length !== 4 || !payload.search_period || !payload.search_date_db) {
      return { kind: "unavailable", message: "공식 서버 응답의 지점 또는 권역 수가 예상과 다릅니다." };
    }
    return {
      kind: "ok",
      data: {
        requestedDate,
        effectiveDate: `${payload.search_date_db.slice(0, 4)}-${payload.search_date_db.slice(4, 6)}-${payload.search_date_db.slice(6, 8)}`,
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

  const startDate = periodStart(effectiveDate, period);
  const removedDate = addDays(startDate, -1);
  try {
    const [startRain, endRain, startNormals, endNormals] = await Promise.all([
      fetchHourlyDailyRain(`${startDate}T00:00`),
      fetchHourlyDailyRain(observationTime),
      fetchDailyNormals(removedDate),
      fetchDailyNormals(effectiveDate),
    ]);
    const stations = adjustStations(base.data.stations, startRain, endRain, startNormals, endNormals, elapsedHours);
    const { regions, admins } = aggregateStations(stations);
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
    rank: numeric(row.rank_num),
  };
}

function numeric(value: string): number {
  const parsed = Number(value.replaceAll(",", ""));
  if (!Number.isFinite(parsed)) throw new TypeError(`Invalid numeric value: ${value}`);
  return parsed;
}

function displayDate(value: string): string {
  const [year, month, day] = value.split("-");
  return `${year}년 ${month}월 ${day}일`;
}
