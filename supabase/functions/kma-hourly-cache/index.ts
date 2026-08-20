import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { createClient } from "@supabase/supabase-js";
import ky from "ky";
import { finalizeOfficialStations, parseCachePayload, parseOfficialDailyRain, periodBoundaryDates, REPRESENTATIVE_STATIONS } from "./daily-rollover.ts";
import type { AggregateValue as Aggregate, CachePayload, Mode, StationValue as Station } from "./daily-rollover.ts";
import { OfficialDataUnavailableError, refreshOfficial } from "./official-refresh.ts";

const PERIODS = ["1m", "3m", "6m", "12m"] as const;
const NORMAL_CODE = new Map([[143, 860], [146, 864]]);
const REGION_CODES = Array.from({ length: 12 }, (_, index) => String(index + 1).padStart(2, "0"));
const ADMIN_CODES = Array.from({ length: 4 }, (_, index) => String(index + 1).padStart(2, "0"));
const API_BASE = "https://apihub.kma.go.kr/api/typ01/url";
const HYDRO_URL = "https://hydro.kma.go.kr/drought/analysisAccData.do";
const KST_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
});

type Period = typeof PERIODS[number];
type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
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

function parseNormals(text: string, date: string): Map<number, number> {
  const result = new Map<number, number>();
  const [, month, day] = date.split("-");
  for (const line of text.split(/\r?\n/)) {
    const fields = line.split(",").map((field) => field.trim());
    if (fields[0] !== "2021" || fields[2] !== String(Number(month)) || fields[3] !== String(Number(day))) continue;
    const station = Number(fields[1]);
    const rain = Number(fields[7]);
    if (Number.isInteger(station) && Number.isFinite(rain) && rain >= 0) result.set(station, rain);
  }
  if (result.size !== REPRESENTATIVE_STATIONS.length || REPRESENTATIVE_STATIONS.some((code) => !result.has(code))) throw new TypeError("incomplete daily normals");
  return result;
}

function numeric(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value.replaceAll(",", "")) : Number(value);
  if (!Number.isFinite(parsed)) throw new TypeError("invalid official numeric value");
  return parsed;
}

function nonNegative(value: unknown): number {
  const parsed = numeric(value);
  if (parsed < 0) throw new TypeError("invalid official negative value");
  return parsed;
}

function numericRank(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value.replaceAll(",", "")) : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function hasCodes(rows: readonly Aggregate[], expected: readonly string[]): boolean {
  const codes = new Set(rows.map((row) => row.code));
  return codes.size === expected.length && expected.every((code) => codes.has(code));
}

function officialAggregate(item: unknown): Aggregate {
  if (!isRecord(item) || typeof item.brtc_cd !== "string") throw new TypeError("invalid official aggregate");
  return { code: item.brtc_cd, normal: nonNegative(item.ny_prcp), precipitation: nonNegative(item.rn_total), ratio: nonNegative(item.rn_ratio), rank: numericRank(item.rank_num) };
}

async function officialData(date: string, period: Period): Promise<Readonly<{ stations: readonly Station[]; regions: readonly Aggregate[]; admins: readonly Aggregate[] }>> {
  const value = await ky.post(HYDRO_URL, {
    body: new URLSearchParams({ PERIOD: period, search_date: date.replaceAll("-", "") }),
    headers: { Accept: "application/json, text/javascript, */*; q=0.01", Origin: "https://hydro.kma.go.kr", Referer: "https://hydro.kma.go.kr/index.do", "User-Agent": "Mozilla/5.0 (compatible; KMA-Precipitation-Dashboard/1.0)", "X-Requested-With": "XMLHttpRequest" },
    retry: { limit: 2, methods: ["post"] }, timeout: 20_000,
  }).json<unknown>();
  if (!isRecord(value) || !Array.isArray(value.list2) || value.list2.length !== 66 || !Array.isArray(value.list1) || value.list1.length !== 12 || !Array.isArray(value.list_admin) || value.list_admin.length !== 4) throw new OfficialDataUnavailableError();
  const stations = value.list2.map((item) => {
    if (!isRecord(item) || typeof item.stn_cd !== "number" || typeof item.stn_nm !== "string") throw new TypeError("invalid official station");
    return { code: item.stn_cd, name: item.stn_nm, normal: nonNegative(item.ny_prcp), precipitation: nonNegative(item.rn_total), ratio: nonNegative(item.rn_ratio_sort) };
  });
  const regions = value.list1.map(officialAggregate);
  const admins = value.list_admin.map(officialAggregate);
  if (new Set(stations.map((station) => station.code)).size !== REPRESENTATIVE_STATIONS.length || REPRESENTATIVE_STATIONS.some((code) => !stations.some((station) => station.code === code)) || !hasCodes(regions, REGION_CODES) || !hasCodes(admins, ADMIN_CODES)) throw new OfficialDataUnavailableError();
  return { stations, regions, admins };
}

function required(values: ReadonlyMap<number, number>, code: number, label: string): number {
  const value = values.get(code);
  if (value === undefined) throw new TypeError(`${label} missing for station ${code}`);
  return value;
}

function adjust(base: readonly Station[], removedRain: ReadonlyMap<number, number>, endRain: ReadonlyMap<number, number>, startNormal: ReadonlyMap<number, number>, endNormal: ReadonlyMap<number, number>): readonly Station[] {
  return base.map((station) => {
    const normalCode = NORMAL_CODE.get(station.code) ?? station.code;
    const precipitation = round1(Math.max(0, station.precipitation - required(removedRain, station.code, "removed rain") + required(endRain, station.code, "end rain")));
    const normal = round1(Math.max(0, station.normal - required(startNormal, normalCode, "start normal") + required(endNormal, normalCode, "end normal")));
    return { ...station, precipitation, normal, ratio: normal > 0 ? round1(precipitation / normal * 100) : 0 };
  });
}

function round1(value: number): number {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

function payload(period: Period, effectiveDate: string, mode: Mode, observationTime: string | null, stations: readonly Station[], regions: readonly Aggregate[] = [], admins: readonly Aggregate[] = []): CachePayload {
  return { schemaVersion: 2, period, effectiveDate, mode, observationTime, stations, regions, admins, fetchedAt: new Date().toISOString(), source: mode === "official" ? "hydro" : "intraday" };
}

function client() {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) throw new TypeError("Supabase environment is incomplete");
  return createClient(url, serviceKey, { auth: { persistSession: false } });
}

function kmaAuthKey(): string {
  const authKey = Deno.env.get("KMA_API_AUTH_KEY");
  if (!authKey) throw new TypeError("KMA API key is not configured");
  return authKey;
}

function isCronRequest(request: Request): boolean {
  const secret = Deno.env.get("CRON_SECRET");
  const supplied = request.headers.get("x-cron-secret");
  return Boolean(secret && secret.length >= 32 && supplied && supplied === secret);
}

type CacheWrite = Readonly<{
  cache_key: string;
  observation_time: string;
  payload: CachePayload;
  refreshed_at: string;
}>;

async function writeCacheRows(supabase: ReturnType<typeof client>, rows: readonly CacheWrite[]): Promise<void> {
  const results = await Promise.all(rows.map((row) => supabase.rpc("upsert_kma_precip_cache", {
    p_cache_key: row.cache_key,
    p_observation_time: row.observation_time,
    p_payload: row.payload,
    p_refreshed_at: row.refreshed_at,
  })));
  if (results.some((result) => result.error)) throw new TypeError("cache write failed");
}

async function acquireLease(supabase: ReturnType<typeof client>): Promise<string | null> {
  const ownerId = crypto.randomUUID();
  const { data, error } = await supabase.rpc("try_acquire_kma_cache_lease", {
    p_lease_key: "kma-hourly-cache",
    p_owner_id: ownerId,
    p_ttl_seconds: 300,
  });
  if (error) throw new TypeError("cache lease failed");
  return data === true ? ownerId : null;
}

async function releaseLease(supabase: ReturnType<typeof client>, ownerId: string): Promise<void> {
  const { error } = await supabase.rpc("release_kma_cache_lease", { p_lease_key: "kma-hourly-cache", p_owner_id: ownerId });
  if (error) throw new TypeError("cache lease release failed");
}

async function boundaryData(period: Period, effectiveDate: string, authKey: string) {
  const boundary = periodBoundaryDates(effectiveDate, period);
  const [removedRain, removedNormal] = await Promise.all([
    hourlyText(`${boundary.removedDate}T00:00`, authKey).then((text) => parseHourly(text, `${boundary.removedDate}T00:00`)),
    apiText("sfc_norm1.php", normalParams(boundary.removedDate), authKey).then((text) => parseNormals(text, boundary.removedDate)),
  ]);
  return { removedRain, removedNormal };
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
  await writeCacheRows(supabase, rows);
}

async function updateOfficialFromDaily(supabase: ReturnType<typeof client>, midnight: string, authKey: string): Promise<void> {
  const effectiveDate = addDays(midnight.slice(0, 10), -1);
  const observationTime = `${effectiveDate}T23:00`;
  const [cache, hourlyTextValue, dailyTextValue] = await Promise.all([
    supabase.from("kma_precip_cache").select("cache_key,payload").like("cache_key", "intraday:%"),
    hourlyText(observationTime, authKey),
    apiText("kma_sfcdd.php", { tm: effectiveDate.replaceAll("-", ""), stn: "0", disp: "0", help: "0" }, authKey),
  ]);
  if (cache.error || !cache.data) throw new TypeError("intraday cache lookup failed");
  if (cache.data.length !== PERIODS.length) throw new OfficialDataUnavailableError();
  const bases = new Map(cache.data.map((row) => [row.cache_key, row.payload]));
  const hourlyRain = parseHourly(hourlyTextValue, observationTime);
  const dailyRain = parseOfficialDailyRain(dailyTextValue, effectiveDate);
  const rows = PERIODS.map((period) => {
    const base = parseCachePayload(bases.get(`intraday:${period}`), { period, effectiveDate, mode: "intraday" });
    const finalized = finalizeOfficialStations({ ...base, hourlyRain, dailyRain });
    return {
      cache_key: `official:${period}`,
      observation_time: midnight,
      payload: { ...payload(period, effectiveDate, "official", null, finalized.stations, finalized.regions, finalized.admins), source: "daily" },
      refreshed_at: new Date().toISOString(),
    };
  });
  await writeCacheRows(supabase, rows);
}

async function updateIntraday(supabase: ReturnType<typeof client>, observationTime: string, authKey: string): Promise<void> {
  const effectiveDate = observationTime.slice(0, 10);
  const baseDate = addDays(effectiveDate, -1);
  const { data, error } = await supabase.from("kma_precip_cache").select("cache_key,payload").like("cache_key", "official:%");
  if (error || !data) throw new TypeError("official cache lookup failed");
  const bases = new Map(data.map((row) => [row.cache_key, row.payload]));
  const [endRain, endNormal, boundaries] = await Promise.all([
    hourlyText(observationTime, authKey).then((text) => parseHourly(text, observationTime)),
    apiText("sfc_norm1.php", normalParams(effectiveDate), authKey).then((text) => parseNormals(text, effectiveDate)),
    Promise.all(PERIODS.map(async (period) => {
      const base = parseCachePayload(bases.get(`official:${period}`), { period, effectiveDate: baseDate, mode: "official" });
      const boundary = await boundaryData(period, effectiveDate, authKey);
      return { period, base, boundary };
    })),
  ]);
  const rows = boundaries.map(({ period, base, boundary }) => ({
    cache_key: `intraday:${period}`, observation_time: observationTime,
    payload: payload(period, effectiveDate, "intraday", observationTime, adjust(base.stations, boundary.removedRain, endRain, boundary.removedNormal, endNormal), base.regions, base.admins),
    refreshed_at: new Date().toISOString(),
  }));
  await writeCacheRows(supabase, rows);
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
    if (!isCronRequest(request)) return new Response("unauthorized", { status: 401 });
    const authKey = kmaAuthKey();
    const ownerId = await acquireLease(supabase);
    if (!ownerId) return Response.json({ status: "busy", reason: "another refresh is already running" }, { status: 202 });
    const observationTime = kstHour();
    const hour = Number(observationTime.slice(11, 13));
    const forceOfficial = new URL(request.url).searchParams.get("refresh") === "official";
    const midnight = `${observationTime.slice(0, 10)}T00:00`;
    try {
      if (hour === 0 || forceOfficial) {
        const result = await refreshOfficial(
          () => updateOfficial(supabase, midnight),
          () => updateOfficialFromDaily(supabase, midnight, authKey),
        );
        if (result === "deferred") return Response.json({ status: "deferred", reason: "official data not ready", observationTime }, { status: 202 });
      }
      else {
        const expectedBaseDate = addDays(observationTime.slice(0, 10), -1);
        const { data } = await supabase.from("kma_precip_cache").select("payload").eq("cache_key", "official:6m").maybeSingle();
        if (!data || !isRecord(data.payload) || data.payload.effectiveDate !== expectedBaseDate) {
          const result = await refreshOfficial(
            () => updateOfficial(supabase, midnight),
            () => updateOfficialFromDaily(supabase, midnight, authKey),
          );
          if (result === "deferred") return Response.json({ status: "deferred", reason: "official data not ready", observationTime }, { status: 202 });
        }
        else if (data.payload.source === "daily") await refreshOfficial(() => updateOfficial(supabase, midnight));
        await updateIntraday(supabase, observationTime, authKey);
      }
      return Response.json({ status: "updated", mode: hour === 0 || forceOfficial ? "official" : "intraday", observationTime });
    } finally {
      await releaseLease(supabase, ownerId);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown failure";
    console.error(JSON.stringify({ event: "kma_hourly_cache_failure", message }));
    return Response.json({ error: "refresh unavailable" }, { status: 502 });
  }
});
