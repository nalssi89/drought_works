import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { createClient } from "@supabase/supabase-js";
import ky from "ky";

const PERIODS = ["1m", "3m", "6m", "12m"] as const;
const MONTHS = { "1m": 1, "3m": 3, "6m": 6, "12m": 12 } as const;
const NORMAL_CODE = new Map([[143, 860], [146, 864]]);
const API_BASE = "https://apihub.kma.go.kr/api/typ01/url";
const HYDRO_URL = "https://hydro.kma.go.kr/drought/analysisAccData.do";
const KST_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
});

type Period = typeof PERIODS[number];
type Mode = "official" | "intraday";
type JsonRecord = Record<string, unknown>;
type Station = Readonly<{ code: number; name: string; normal: number; precipitation: number; ratio: number }>;
type Aggregate = Readonly<{ code: string; normal: number; precipitation: number; ratio: number; rank: number | null }>;
type CachePayload = Readonly<{
  schemaVersion: 2; period: Period; effectiveDate: string; mode: Mode;
  observationTime: string | null; stations: readonly Station[];
  regions: readonly Aggregate[]; admins: readonly Aggregate[]; fetchedAt: string;
}>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function periodStart(endDate: string, period: Period): string {
  return addDays(addMonths(endDate, -MONTHS[period]), 1);
}

function kstHour(now = new Date()): string {
  const values = new Map(KST_FORMATTER.formatToParts(now).map((part) => [part.type, part.value]));
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}T${values.get("hour")}:00`;
}

function compactTime(value: string): string {
  return value.replaceAll(/[-:T]/g, "");
}

function normalParams(date: string): Record<string, string> {
  const [, month, day] = date.split("-");
  return { norm: "D", tmst: "2021", stn: "0", MM1: String(Number(month)), DD1: String(Number(day)), MM2: String(Number(month)), DD2: String(Number(day)) };
}

async function apiText(path: string, params: Record<string, string>, authKey: string): Promise<string> {
  return ky.get(`${API_BASE}/${path}`, {
    searchParams: { ...params, authKey }, retry: { limit: 2, methods: ["get"] }, timeout: 20_000,
  }).text();
}

async function hourlyText(observationTime: string, authKey: string): Promise<string> {
  return apiText("kma_sfctm2.php", { tm: compactTime(observationTime), stn: "0", help: "0" }, authKey);
}

function parseHourly(text: string, observationTime: string): Map<number, number> {
  const result = new Map<number, number>();
  const prefix = compactTime(observationTime);
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith(`${prefix} `)) continue;
    const fields = line.trim().split(/\s+/);
    const station = Number(fields[1]);
    const rain = Number(fields[16]);
    if (Number.isInteger(station) && Number.isFinite(rain)) result.set(station, Math.max(0, rain));
  }
  if (result.size < 60) throw new TypeError(`incomplete hourly observation: ${observationTime}`);
  return result;
}

function parseNormals(text: string): Map<number, number> {
  const result = new Map<number, number>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("2021,")) continue;
    const fields = line.split(",").map((field) => field.trim());
    const station = Number(fields[1]);
    const rain = Number(fields[7]);
    if (Number.isInteger(station) && Number.isFinite(rain) && rain >= 0) result.set(station, rain);
  }
  if (result.size < 60) throw new TypeError("incomplete daily normals");
  return result;
}

function numeric(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value.replaceAll(",", "")) : Number(value);
  if (!Number.isFinite(parsed)) throw new TypeError("invalid official numeric value");
  return parsed;
}

function officialAggregate(item: unknown): Aggregate {
  if (!isRecord(item) || typeof item.brtc_cd !== "string") throw new TypeError("invalid official aggregate");
  const rank = numeric(item.rank_num);
  return { code: item.brtc_cd, normal: numeric(item.ny_prcp), precipitation: numeric(item.rn_total), ratio: numeric(item.rn_ratio), rank: rank > 0 ? rank : null };
}

async function officialData(date: string, period: Period): Promise<Readonly<{ stations: readonly Station[]; regions: readonly Aggregate[]; admins: readonly Aggregate[] }>> {
  const value = await ky.post(HYDRO_URL, {
    body: new URLSearchParams({ PERIOD: period, search_date: date.replaceAll("-", "") }),
    headers: { Accept: "application/json, text/javascript, */*; q=0.01", Origin: "https://hydro.kma.go.kr", Referer: "https://hydro.kma.go.kr/index.do", "User-Agent": "Mozilla/5.0 (compatible; KMA-Precipitation-Dashboard/1.0)", "X-Requested-With": "XMLHttpRequest" },
    retry: { limit: 2, methods: ["post"] }, timeout: 20_000,
  }).json<unknown>();
  if (!isRecord(value) || !Array.isArray(value.list2) || value.list2.length !== 66 || !Array.isArray(value.list1) || value.list1.length !== 12 || !Array.isArray(value.list_admin) || value.list_admin.length !== 4) throw new TypeError("official daily base is unavailable");
  const stations = value.list2.map((item) => {
    if (!isRecord(item) || typeof item.stn_cd !== "number" || typeof item.stn_nm !== "string") throw new TypeError("invalid official station");
    return { code: item.stn_cd, name: item.stn_nm, normal: numeric(item.ny_prcp), precipitation: numeric(item.rn_total), ratio: numeric(item.rn_ratio_sort) };
  });
  return { stations, regions: value.list1.map(officialAggregate), admins: value.list_admin.map(officialAggregate) };
}

function required(values: ReadonlyMap<number, number>, code: number, label: string): number {
  const value = values.get(code);
  if (value === undefined) throw new TypeError(`${label} missing for station ${code}`);
  return value;
}

function adjust(base: readonly Station[], startRain: ReadonlyMap<number, number>, endRain: ReadonlyMap<number, number>, startNormal: ReadonlyMap<number, number>, endNormal: ReadonlyMap<number, number>, elapsedHours: number): readonly Station[] {
  return base.map((station) => {
    const normalCode = NORMAL_CODE.get(station.code) ?? station.code;
    const precipitation = round1(Math.max(0, station.precipitation - required(startRain, station.code, "start rain") + required(endRain, station.code, "end rain")));
    const normal = round1(Math.max(0, station.normal - required(startNormal, normalCode, "start normal") + required(endNormal, normalCode, "end normal") * elapsedHours / 24));
    return { ...station, precipitation, normal, ratio: normal > 0 ? round1(precipitation / normal * 100) : 0 };
  });
}

function round1(value: number): number {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

function parseCache(value: unknown, period: Period, effectiveDate: string): CachePayload {
  if (!isRecord(value) || value.schemaVersion !== 2 || value.period !== period || value.mode !== "official" || value.effectiveDate !== effectiveDate || !Array.isArray(value.stations) || value.stations.length !== 66 || typeof value.fetchedAt !== "string") throw new TypeError(`official cache missing for ${period}`);
  const stations = value.stations.map((item) => {
    if (!isRecord(item) || typeof item.code !== "number" || typeof item.name !== "string" || typeof item.normal !== "number" || typeof item.precipitation !== "number" || typeof item.ratio !== "number") throw new TypeError("invalid cached station");
    return { code: item.code, name: item.name, normal: item.normal, precipitation: item.precipitation, ratio: item.ratio };
  });
  return { schemaVersion: 2, period, effectiveDate, mode: "official", observationTime: null, stations, regions: [], admins: [], fetchedAt: value.fetchedAt };
}

function payload(period: Period, effectiveDate: string, mode: Mode, observationTime: string | null, stations: readonly Station[], regions: readonly Aggregate[] = [], admins: readonly Aggregate[] = []): CachePayload {
  return { schemaVersion: 2, period, effectiveDate, mode, observationTime, stations, regions, admins, fetchedAt: new Date().toISOString() };
}

function client() {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) throw new TypeError("Supabase environment is incomplete");
  return createClient(url, serviceKey, { auth: { persistSession: false } });
}

async function boundaryData(period: Period, effectiveDate: string, authKey: string) {
  const startDate = periodStart(effectiveDate, period);
  const removedDate = addDays(startDate, -1);
  const [startRain, startNormal] = await Promise.all([
    hourlyText(`${startDate}T00:00`, authKey).then((text) => parseHourly(text, `${startDate}T00:00`)),
    apiText("sfc_norm1.php", normalParams(removedDate), authKey).then(parseNormals),
  ]);
  return { startRain, startNormal };
}

async function updateOfficial(supabase: ReturnType<typeof client>, midnight: string): Promise<void> {
  const effectiveDate = addDays(midnight.slice(0, 10), -1);
  const inputs = await Promise.all(PERIODS.map(async (period) => ({
    period,
    data: await officialData(effectiveDate, period),
  })));
  const rows = inputs.map(({ period, data }) => ({
    cache_key: `official:${period}`, observation_time: midnight,
    payload: payload(period, effectiveDate, "official", null, data.stations, data.regions, data.admins),
    refreshed_at: new Date().toISOString(),
  }));
  const { error } = await supabase.from("kma_precip_cache").upsert(rows);
  if (error) throw new TypeError("official cache update failed");
}

async function updateIntraday(supabase: ReturnType<typeof client>, observationTime: string, authKey: string): Promise<void> {
  const effectiveDate = observationTime.slice(0, 10);
  const baseDate = addDays(effectiveDate, -1);
  const elapsedHours = Number(observationTime.slice(11, 13));
  const { data, error } = await supabase.from("kma_precip_cache").select("cache_key,payload").like("cache_key", "official:%");
  if (error || !data) throw new TypeError("official cache lookup failed");
  const bases = new Map(data.map((row) => [row.cache_key, row.payload]));
  const [endRain, endNormal, boundaries] = await Promise.all([
    hourlyText(observationTime, authKey).then((text) => parseHourly(text, observationTime)),
    apiText("sfc_norm1.php", normalParams(effectiveDate), authKey).then(parseNormals),
    Promise.all(PERIODS.map(async (period) => {
      const base = parseCache(bases.get(`official:${period}`), period, baseDate);
      const boundary = await boundaryData(period, effectiveDate, authKey);
      return { period, base, boundary };
    })),
  ]);
  const rows = boundaries.map(({ period, base, boundary }) => ({
    cache_key: `intraday:${period}`, observation_time: observationTime,
    payload: payload(period, effectiveDate, "intraday", observationTime, adjust(base.stations, boundary.startRain, endRain, boundary.startNormal, endNormal, elapsedHours)),
    refreshed_at: new Date().toISOString(),
  }));
  const { error: upsertError } = await supabase.from("kma_precip_cache").upsert(rows);
  if (upsertError) throw new TypeError("intraday cache update failed");
}

Deno.serve(async (request: Request) => {
  try {
    const supabase = client();
    if (request.method === "GET") {
      const url = new URL(request.url);
      const period = PERIODS.find((value) => value === url.searchParams.get("period"));
      const mode = url.searchParams.get("mode");
      if (!period || (mode !== "official" && mode !== "intraday")) return Response.json({ error: "invalid query" }, { status: 400 });
      const { data, error } = await supabase.from("kma_precip_cache").select("payload").eq("cache_key", `${mode}:${period}`).maybeSingle();
      if (error) throw new TypeError("cache lookup failed");
      if (!data) return Response.json({ error: "cache is not ready" }, { status: 503 });
      return Response.json(data.payload, { headers: { "Cache-Control": "public, max-age=60" } });
    }
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
    const authKey = request.headers.get("x-kma-auth");
    if (!authKey || authKey.length < 16) return new Response("unauthorized", { status: 401 });
    const observationTime = kstHour();
    const hour = Number(observationTime.slice(11, 13));
    const forceOfficial = new URL(request.url).searchParams.get("refresh") === "official";
    if (hour === 0 || forceOfficial) await updateOfficial(supabase, `${observationTime.slice(0, 10)}T00:00`);
    else {
      const expectedBaseDate = addDays(observationTime.slice(0, 10), -1);
      const { data } = await supabase.from("kma_precip_cache").select("payload").eq("cache_key", "official:6m").maybeSingle();
      if (!data || !isRecord(data.payload) || data.payload.effectiveDate !== expectedBaseDate) await updateOfficial(supabase, `${observationTime.slice(0, 10)}T00:00`);
      await updateIntraday(supabase, observationTime, authKey);
    }
    return Response.json({ status: "updated", mode: hour === 0 || forceOfficial ? "official" : "intraday", observationTime });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown failure";
    console.error(JSON.stringify({ event: "kma_hourly_cache_failure", message }));
    return Response.json({ error: "refresh unavailable" }, { status: 502 });
  }
});
