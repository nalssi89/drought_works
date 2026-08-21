import ky, { HTTPError, TimeoutError } from "ky";
import { z } from "zod";

import { fetchDailyNormals, fetchHourlyDailyRain } from "./api-hub";
import type { CustomRange } from "./custom-period";
import { customRangeIssue } from "./custom-period";
import { aggregateStations, extendStations, mergeAggregateRanks } from "./intraday";
import { addDays, type Aggregate, type Station } from "./precipitation";

const REGION_CODES = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"] as const;
const ADMIN_CODES = ["01", "02", "03", "04"] as const;
const metricRowSchema = z.object({ title: z.string() }).catchall(z.union([z.string(), z.number()]));
const stationSchema = z.object({
  stn_cd: z.number().int(),
  stn_nm: z.string().min(1),
  prcp: z.union([z.string(), z.number()]),
  norm: z.union([z.string(), z.number()]),
  norm_ratio: z.union([z.string(), z.number()]),
});
const payloadSchema = z.object({
  displayTime: z.string(),
  t1: z.array(metricRowSchema),
  t2: z.array(stationSchema).length(66),
  t4: z.array(metricRowSchema),
});

type CustomDashboardData = Readonly<{
  requestedDate: string;
  effectiveDate: string;
  searchPeriod: string;
  period: "custom";
  regions: readonly Aggregate[];
  admins: readonly Aggregate[];
  stations: readonly Station[];
  fetchedAt: string;
  mode: "official" | "intraday";
  observationTime: string | null;
}>;

export type CustomDashboardResult =
  | Readonly<{ kind: "ok"; data: CustomDashboardData }>
  | Readonly<{ kind: "missing"; requestedDate: string }>
  | Readonly<{ kind: "unavailable"; message: string }>;

export async function loadCustomDashboard(range: CustomRange, observationTime: string | null): Promise<CustomDashboardResult> {
  const issue = customRangeIssue(range);
  if (issue) return { kind: "unavailable", message: issue };
  if (observationTime) return loadIntradayCustom(range, observationTime);
  return loadOfficialCustom(range);
}

async function loadIntradayCustom(range: CustomRange, observationTime: string): Promise<CustomDashboardResult> {
  if (observationTime.slice(0, 10) !== range.endDate) {
    return { kind: "unavailable", message: "임의기간 종료일과 관측시각의 날짜가 일치하지 않습니다." };
  }
  const baseEndDate = addDays(range.endDate, -1);
  const hasCompletedDays = range.startDate <= baseEndDate;
  const base = await loadOfficialCustom(hasCompletedDays
    ? { startDate: range.startDate, endDate: baseEndDate }
    : { startDate: baseEndDate, endDate: baseEndDate });
  if (base.kind !== "ok") return base;

  try {
    const [endRain, endNormals] = await Promise.all([
      fetchHourlyDailyRain(observationTime),
      fetchDailyNormals(range.endDate),
    ]);
    const completedStations = hasCompletedDays
      ? base.data.stations
      : base.data.stations.map((station) => ({ ...station, normal: 0, precipitation: 0, ratio: 0 }));
    const stations = extendStations(completedStations, endRain, endNormals);
    const calculated = aggregateStations(stations);
    const elapsedHours = observationTime.slice(11, 13);
    return {
      kind: "ok",
      data: {
        requestedDate: range.endDate,
        effectiveDate: range.endDate,
        searchPeriod: `${displayDate(range.startDate)} 00시 ~ ${displayDate(range.endDate)} ${elapsedHours}시 (당일 관측 반영 추정)`,
        period: "custom",
        regions: hasCompletedDays ? mergeAggregateRanks(calculated.regions, base.data.regions) : calculated.regions,
        admins: hasCompletedDays ? mergeAggregateRanks(calculated.admins, base.data.admins) : calculated.admins,
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

async function loadOfficialCustom(range: CustomRange): Promise<CustomDashboardResult> {
  try {
    const payload = payloadSchema.parse(await fetchCustomPayload(range));
    if (payload.t1.length === 0 && payload.t2.length === 0) return { kind: "missing", requestedDate: range.endDate };
    const stations = payload.t2.map((row) => ({
      code: row.stn_cd,
      name: row.stn_nm,
      normal: numeric(row.norm),
      precipitation: numeric(row.prcp),
      ratio: numeric(row.norm_ratio),
    }));
    return {
      kind: "ok",
      data: {
        requestedDate: range.endDate,
        effectiveDate: range.endDate,
        searchPeriod: `${displayDate(range.startDate)} ~ ${displayDate(range.endDate)}`,
        period: "custom",
        regions: aggregates(payload.t1, REGION_CODES),
        admins: aggregates(payload.t4, ADMIN_CODES),
        stations,
        fetchedAt: new Date().toISOString(),
        mode: "official",
        observationTime: null,
      },
    };
  } catch (error) {
    if (error instanceof HTTPError || error instanceof TimeoutError || error instanceof TypeError || error instanceof z.ZodError) {
      return { kind: "unavailable", message: "기상청 공식 임의기간 자료를 불러오지 못했습니다. 잠시 후 다시 조회해 주세요." };
    }
    throw error;
  }
}

async function fetchCustomPayload(range: CustomRange): Promise<unknown> {
  const proxyUrl = process.env.KMA_PROXY_URL;
  const proxyKey = process.env.KMA_PROXY_ANON_KEY;
  if (proxyUrl && proxyKey) {
    return ky.get(proxyUrl, {
      searchParams: { date: range.endDate, period: "custom", start: range.startDate },
      headers: { apikey: proxyKey, Authorization: `Bearer ${proxyKey}` },
      retry: { limit: 2, methods: ["get"] },
      timeout: 60_000,
    }).json<unknown>();
  }
  return ky.post("https://hydro.kma.go.kr/ext/prec.do", {
    body: new URLSearchParams({
      PERIOD: "random",
      START: range.startDate.replaceAll("-", ""),
      END: range.endDate.replaceAll("-", ""),
      SPOT: "2",
      DATE: range.endDate.replaceAll("-", ""),
    }),
    headers: { Referer: "https://hydro.kma.go.kr/ext/prec_map.do", "X-Requested-With": "XMLHttpRequest" },
    retry: { limit: 2, methods: ["post"] },
    timeout: 60_000,
  }).json<unknown>();
}

function aggregates(rows: readonly z.infer<typeof metricRowSchema>[], codes: readonly string[]): Aggregate[] {
  const precipitation = metric(rows, "강수량");
  const normal = metric(rows, "평년값");
  const ratio = metric(rows, "평년비");
  const rank = metric(rows, "최저순위");
  return codes.map((code, index) => ({
    code,
    precipitation: numeric(precipitation[`a${index + 1}`]),
    normal: numeric(normal[`a${index + 1}`]),
    ratio: numeric(ratio[`a${index + 1}`]),
    rank: rankValue(rank[`a${index + 1}`]),
  }));
}

function metric(rows: readonly z.infer<typeof metricRowSchema>[], label: string): z.infer<typeof metricRowSchema> {
  const row = rows.find((candidate) => candidate.title.startsWith(label));
  if (!row) throw new TypeError(`${label} 자료가 없습니다.`);
  return row;
}

function numeric(value: unknown): number {
  const parsed = Number(String(value).replaceAll(",", ""));
  if (!Number.isFinite(parsed)) throw new TypeError("숫자 자료 형식이 올바르지 않습니다.");
  return parsed;
}

function rankValue(value: unknown): number | null {
  const rank = Number(String(value).split("/")[0]);
  return Number.isInteger(rank) && rank > 0 ? rank : null;
}

function displayDate(value: string): string {
  const [year, month, day] = value.split("-");
  return `${year}년 ${month}월 ${day}일`;
}
