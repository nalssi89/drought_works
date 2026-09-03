import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { createClient } from "@supabase/supabase-js";
import ky from "ky";
import {
  REPRESENTATIVE_STATIONS,
  completeHourlyObservation,
  completeLatestHourlyObservation,
} from "../_shared/hourly-observation.ts";
import { KMA_STATION_NAMES } from "../_shared/kma-stations.ts";
import {
  aggregateOfficialStations,
  extendOfficialStations,
  finalizeOfficialStations,
  parseCachePayload,
  parseOfficialDailyRain,
  rolloverCacheKey,
  selectLatestCompletedBase,
  selectRolloverBase,
} from "./daily-rollover.ts";
import type {
  AggregateValue as Aggregate,
  CachePayload,
  Mode,
  StationValue as Station,
} from "./daily-rollover.ts";
import {
  OfficialDataUnavailableError,
  refreshOfficial,
  safeRefreshErrorMessage,
} from "./official-refresh.ts";

const PERIODS = ["1m", "3m", "6m", "12m", "ty"] as const;
const MONTHS = { "1m": 1, "3m": 3, "6m": 6, "12m": 12 } as const;
const NORMAL_CODE = new Map([[143, 860], [146, 864]]);
const REPRESENTATIVE_STATION_SET = new Set(REPRESENTATIVE_STATIONS);
const NORMAL_STATION_SET = new Set(REPRESENTATIVE_STATIONS.map((station) => NORMAL_CODE.get(station) ?? station));
const API_BASE = "https://apihub.kma.go.kr/api/typ01/url";
const KST_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
});

type Period = typeof PERIODS[number];
type RollingPeriod = Exclude<Period, "ty">;
type JsonRecord = Record<string, unknown>;

class LatestHourlyObservationUnavailableError extends Error {
  constructor(readonly scheduledDate: string, readonly actualObservationTime: string) {
    super(`latest hourly observation is not available for ${scheduledDate}`);
    this.name = "LatestHourlyObservationUnavailableError";
  }
}

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
  if (period === "ty") return `${endDate.slice(0, 4)}-01-01`;
  return addDays(addMonths(endDate, -MONTHS[period]), 1);
}

function kstHour(now = new Date()): string {
  const values = new Map(KST_FORMATTER.formatToParts(now).map((part) => [part.type, part.value]));
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}T${values.get("hour")}:00`;
}

function compactTime(value: string): string {
  return value.replaceAll(/[-:T]/g, "");
}

function expandTime(value: string): string {
  if (!/^\d{12}$/.test(value)) throw new TypeError("invalid hourly observation time");
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(8, 10)}:00`;
}

function normalParams(date: string): Record<string, string> {
  const [, month, day] = date.split("-");
  return {
    norm: "D",
    tmst: "2021",
    stn: "0",
    MM1: String(Number(month)),
    DD1: String(Number(day)),
    MM2: String(Number(month)),
    DD2: String(Number(day)),
  };
}

async function apiText(
  path: string,
  params: Record<string, string>,
  authKey: string,
  timeout = 20_000,
): Promise<string> {
  return ky.get(`${API_BASE}/${path}`, {
    searchParams: { ...params, authKey },
    retry: { limit: 2, methods: ["get"] },
    timeout,
  }).text();
}

async function hourlyObservation(
  observationTime: string,
  authKey: string,
  stations: readonly number[] = REPRESENTATIVE_STATIONS,
) {
  const currentTime = compactTime(observationTime);
  const currentText = await apiText("kma_sfctm2.php", {
    tm: currentTime,
    stn: stations.length === REPRESENTATIVE_STATIONS.length ? "0" : stations.join(":"),
    help: "0",
  }, authKey);
  return completeHourlyObservation({
    observationTime: currentTime,
    currentText,
    stations,
    fetchFallbackText: (time, stations) => apiText("kma_sfctm2.php", {
      tm: time,
      stn: stations.join(":"),
      help: "0",
    }, authKey),
  });
}

async function latestHourlyObservation(authKey: string) {
  const currentText = await apiText("kma_sfctm2.php", {
    stn: "0",
    help: "0",
  }, authKey);
  const observation = await completeLatestHourlyObservation({
    currentText,
    fetchRangeText: (startTime, endTime, stations) => apiText("kma_sfctm3.php", {
      tm1: startTime,
      tm2: endTime,
      stn: stations.join(":"),
      help: "0",
    }, authKey, 60_000),
  });
  if (observation.defaultedStations.length > 0) {
    console.warn(JSON.stringify({
      event: "kma_hourly_station_defaulted",
      observationTime: observation.observationTime,
      stations: observation.defaultedStations,
      fallback: "zero_current_day_rain",
    }));
  }
  return {
    ...observation,
    observationTime: expandTime(observation.observationTime),
  };
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

type PeriodTotals = Readonly<{
  rain: ReadonlyMap<Period, ReadonlyMap<number, number>>;
  normal: ReadonlyMap<Period, ReadonlyMap<number, number>>;
}>;

async function collectPeriodTotals(effectiveDate: string, authKey: string): Promise<PeriodTotals> {
  const starts = new Map(PERIODS.map((period) => [period, periodStart(effectiveDate, period)]));
  const earliestStart = [...starts.values()].sort()[0];
  if (!earliestStart) throw new TypeError("missing earliest period start");
  const rain = new Map(PERIODS.map((period) => [period, new Map<number, number>()]));
  const normal = new Map(PERIODS.map((period) => [period, new Map<number, number>()]));

  for (const { start, end } of splitByDays(earliestStart, effectiveDate, 31)) {
    const [, startMonth, startDay] = start.split("-");
    const [, endMonth, endDay] = end.split("-");
    const [dailyText, normalText] = await Promise.all([
      apiText("sts_rn.php", {
        tm1: start.replaceAll("-", ""),
        tm2: end.replaceAll("-", ""),
        stn_id: "0",
        disp: "1",
        help: "0",
      }, authKey, 60_000),
      apiText("sfc_norm1.php", {
        norm: "D",
        tmst: "2021",
        stn: "0",
        MM1: String(Number(startMonth)),
        DD1: String(Number(startDay)),
        MM2: String(Number(endMonth)),
        DD2: String(Number(endDay)),
      }, authKey, 60_000),
    ]);
    const dailySeen = new Set<string>();
    for (const line of dailyText.split(/\r?\n/)) {
      if (!/^\d{8}(?:\s|,)/.test(line)) continue;
      const fields = line.includes(",") ? line.split(",").map((field) => field.trim()) : line.trim().split(/\s+/);
      const compactDate = fields[0];
      const date = `${compactDate.slice(0, 4)}-${compactDate.slice(4, 6)}-${compactDate.slice(6, 8)}`;
      const station = Number(fields[1]);
      const dailyRain = Number(fields[5]);
      if (date < start || date > end || !REPRESENTATIVE_STATION_SET.has(station) || !Number.isFinite(dailyRain)) continue;
      dailySeen.add(`${date}:${station}`);
      addToPeriods(rain, starts, date, station, Math.max(0, dailyRain));
    }

    const normalSeen = new Set<string>();
    const year = start.slice(0, 4);
    for (const line of normalText.split(/\r?\n/)) {
      if (!line.startsWith("2021,")) continue;
      const fields = line.split(",").map((field) => field.trim());
      const station = Number(fields[1]);
      const month = Number(fields[2]);
      const day = Number(fields[3]);
      const normalRain = Number(fields[7]);
      const date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      if (!validDate(date) || date < start || date > end || !NORMAL_STATION_SET.has(station) || !Number.isFinite(normalRain) || normalRain < 0) continue;
      normalSeen.add(`${date}:${station}`);
      addToPeriods(normal, starts, date, station, normalRain);
    }

    const expected = inclusiveDays(start, end) * REPRESENTATIVE_STATIONS.length;
    if (dailySeen.size !== expected || normalSeen.size !== expected) throw new OfficialDataUnavailableError();
  }
  return { rain, normal };
}

function splitByDays(startDate: string, endDate: string, maximumDays: number): ReadonlyArray<Readonly<{ start: string; end: string }>> {
  const segments: Array<{ start: string; end: string }> = [];
  let cursor = startDate;
  while (cursor <= endDate) {
    const candidateEnd = addDays(cursor, maximumDays - 1);
    const yearEnd = `${cursor.slice(0, 4)}-12-31`;
    const segmentEnd = [candidateEnd, yearEnd, endDate].sort()[0];
    segments.push({ start: cursor, end: segmentEnd });
    cursor = addDays(segmentEnd, 1);
  }
  return segments;
}

function addToPeriods(
  totals: Map<Period, Map<number, number>>,
  starts: ReadonlyMap<Period, string>,
  date: string,
  station: number,
  value: number,
): void {
  for (const period of PERIODS) {
    const start = starts.get(period);
    const periodTotals = totals.get(period);
    if (!start || !periodTotals || date < start) continue;
    periodTotals.set(station, (periodTotals.get(station) ?? 0) + value);
  }
}

function inclusiveDays(startDate: string, endDate: string): number {
  return Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000) + 1;
}

function validDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function required(values: ReadonlyMap<number, number>, code: number, label: string): number {
  const value = values.get(code);
  if (value === undefined) throw new TypeError(`${label} missing for station ${code}`);
  return value;
}

function adjust(
  base: readonly Station[],
  startRain: ReadonlyMap<number, number>,
  endRain: ReadonlyMap<number, number>,
  startNormal: ReadonlyMap<number, number>,
  endNormal: ReadonlyMap<number, number>,
): readonly Station[] {
  return base.map((station) => {
    const normalCode = NORMAL_CODE.get(station.code) ?? station.code;
    const precipitation = round1(Math.max(
      0,
      station.precipitation
        - required(startRain, station.code, "start rain")
        + required(endRain, station.code, "end rain"),
    ));
    const normal = round1(Math.max(
      0,
      station.normal
        - required(startNormal, normalCode, "start normal")
        + required(endNormal, normalCode, "end normal"),
    ));
    return {
      ...station,
      precipitation,
      normal,
      ratio: normal > 0 ? round1(precipitation / normal * 100) : 0,
    };
  });
}

function round1(value: number): number {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

function payload(
  period: Period,
  effectiveDate: string,
  mode: Mode,
  observationTime: string | null,
  stations: readonly Station[],
  regions: readonly Aggregate[] = [],
  admins: readonly Aggregate[] = [],
): CachePayload {
  return {
    schemaVersion: 2,
    period,
    effectiveDate,
    mode,
    observationTime,
    stations,
    regions,
    admins,
    fetchedAt: new Date().toISOString(),
    source: mode === "official" ? "daily" : mode === "rollover" ? "hourly" : "intraday",
  };
}

function client() {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) throw new TypeError("Supabase environment is incomplete");
  return createClient(url, serviceKey, { auth: { persistSession: false } });
}

async function rebuildOfficialFromDaily(
  supabase: ReturnType<typeof client>,
  midnight: string,
  authKey: string,
): Promise<void> {
  const effectiveDate = addDays(midnight.slice(0, 10), -1);
  const totals = await collectPeriodTotals(effectiveDate, authKey);
  const rows = PERIODS.map((period) => {
    const periodRain = totals.rain.get(period);
    const periodNormal = totals.normal.get(period);
    if (!periodRain || !periodNormal) throw new TypeError(`missing totals for ${period}`);
    const stations = REPRESENTATIVE_STATIONS.map((code) => {
      const name = KMA_STATION_NAMES.get(code);
      if (!name) throw new TypeError(`missing station name for ${code}`);
      const precipitation = round1(required(periodRain, code, "daily rain"));
      const normal = round1(required(periodNormal, NORMAL_CODE.get(code) ?? code, "daily normal"));
      return { code, name, precipitation, normal, ratio: normal > 0 ? round1(precipitation / normal * 100) : 0 };
    });
    const aggregates = aggregateOfficialStations(stations);
    return {
      cache_key: `official:${period}`,
      observation_time: midnight,
      payload: payload(period, effectiveDate, "official", null, stations, aggregates.regions, aggregates.admins),
      refreshed_at: new Date().toISOString(),
    };
  });
  const { error } = await supabase.from("kma_precip_cache").upsert(rows);
  if (error) throw new TypeError("daily official cache rebuild failed");
  console.info(JSON.stringify({
    event: "kma_daily_official_rebuilt",
    effectiveDate,
    source: "daily",
  }));
}

async function boundaryData(period: RollingPeriod, effectiveDate: string, authKey: string) {
  const startDate = periodStart(effectiveDate, period);
  const removedDate = addDays(startDate, -1);
  const compactRemovedDate = removedDate.replaceAll("-", "");
  const [removedRain, removedNormal] = await Promise.all([
    apiText("sts_rn.php", {
      tm1: compactRemovedDate,
      tm2: compactRemovedDate,
      stn_id: "0",
      disp: "1",
      help: "0",
    }, authKey).then((text) => parseOfficialDailyRain(text, removedDate)),
    apiText("sfc_norm1.php", normalParams(removedDate), authKey).then(parseNormals),
  ]);
  const missingStations = REPRESENTATIVE_STATIONS.filter((station) => !removedRain.has(station));
  if (missingStations.length > 0) {
    const completedAt = `${addDays(removedDate, 1)}T00:00`;
    const fallback = await hourlyObservation(completedAt, authKey, missingStations);
    for (const [station, rain] of fallback.rain) removedRain.set(station, rain);
  }
  return { removedRain, removedNormal };
}

async function ensureRolloverBases(
  supabase: ReturnType<typeof client>,
  effectiveDate: string,
  authKey: string,
): Promise<ReadonlyMap<Period, CachePayload>> {
  const completedAt = `${addDays(effectiveDate, 1)}T00:00`;
  const rolloverKeys = PERIODS.map((period) => rolloverCacheKey(effectiveDate, period));
  const existing = await supabase
    .from("kma_precip_cache")
    .select("cache_key,payload")
    .in("cache_key", rolloverKeys);
  if (existing.error || !existing.data) throw new TypeError("rollover cache lookup failed");
  if (existing.data.length === PERIODS.length) {
    const values = new Map(existing.data.map((row) => [row.cache_key, row.payload]));
    try {
      return new Map(PERIODS.map((period) => [
        period,
        selectRolloverBase(
          { official: undefined, rollover: values.get(rolloverCacheKey(effectiveDate, period)) },
          { period, effectiveDate },
        ),
      ]));
    } catch (error) {
      if (!(error instanceof OfficialDataUnavailableError)) throw error;
    }
  }

  const baseDate = addDays(effectiveDate, -1);
  const sourceKeys = PERIODS.flatMap((period) => [
    `official:${period}`,
    rolloverCacheKey(baseDate, period),
  ]);
  const source = await supabase
    .from("kma_precip_cache")
    .select("cache_key,payload")
    .in("cache_key", sourceKeys);
  if (source.error || !source.data) throw new TypeError("rollover source lookup failed");
  const sourceValues = new Map(source.data.map((row) => [row.cache_key, row.payload]));
  const rollingPeriods = PERIODS.filter((period): period is RollingPeriod => period !== "ty");
  const [completedRain, endNormal, boundaryEntries] = await Promise.all([
    hourlyObservation(completedAt, authKey).then((observation) => observation.rain),
    apiText("sfc_norm1.php", normalParams(effectiveDate), authKey).then(parseNormals),
    Promise.all(rollingPeriods.map(async (period) => [
      period,
      await boundaryData(period, effectiveDate, authKey),
    ] as const)),
  ]);
  const boundaries = new Map(boundaryEntries);
  const snapshots = PERIODS.map((period) => {
    const base = selectRolloverBase(
      {
        official: sourceValues.get(`official:${period}`),
        rollover: sourceValues.get(rolloverCacheKey(baseDate, period)),
      },
      { period, effectiveDate: baseDate },
    );
    let stations: readonly Station[];
    if (period === "ty") {
      stations = extendOfficialStations(base.stations, completedRain, endNormal);
    } else {
      const boundary = boundaries.get(period);
      if (!boundary) throw new OfficialDataUnavailableError();
      stations = adjust(
        base.stations,
        boundary.removedRain,
        completedRain,
        boundary.removedNormal,
        endNormal,
      );
    }
    const value = payload(
      period,
      effectiveDate,
      "rollover",
      completedAt,
      stations,
      base.regions,
      base.admins,
    );
    return {
      period,
      value,
      row: {
        cache_key: rolloverCacheKey(effectiveDate, period),
        observation_time: completedAt,
        payload: value,
        refreshed_at: new Date().toISOString(),
      },
    };
  });
  const { error } = await supabase.from("kma_precip_cache").upsert(snapshots.map(({ row }) => row));
  if (error) throw new TypeError("rollover cache update failed");
  console.info(JSON.stringify({
    event: "kma_rollover_snapshot_completed",
    effectiveDate,
    observationTime: completedAt,
  }));
  return new Map(snapshots.map(({ period, value }) => [period, value]));
}

async function updateOfficialFromDaily(
  supabase: ReturnType<typeof client>,
  midnight: string,
  authKey: string,
): Promise<void> {
  const effectiveDate = addDays(midnight.slice(0, 10), -1);
  const rolloverKeys = PERIODS.map((period) => rolloverCacheKey(effectiveDate, period));
  const [cache, confirmedRain] = await Promise.all([
    supabase.from("kma_precip_cache").select("cache_key,payload").in("cache_key", rolloverKeys),
    confirmedDailyRain(effectiveDate, authKey),
  ]);
  if (cache.error || !cache.data) throw new TypeError("rollover cache lookup failed");
  if (cache.data.length !== PERIODS.length) throw new OfficialDataUnavailableError();
  const bases = new Map(cache.data.map((row) => [row.cache_key, row.payload]));
  const { hourlyRain, dailyRain } = confirmedRain;
  const rows = PERIODS.map((period) => {
    const base = parseCachePayload(bases.get(rolloverCacheKey(effectiveDate, period)), {
      period,
      effectiveDate,
      mode: "rollover",
    });
    if (base.observationTime !== `${midnight.slice(0, 10)}T00:00`) throw new OfficialDataUnavailableError();
    const finalized = finalizeOfficialStations({ ...base, hourlyRain, dailyRain });
    return {
      cache_key: `official:${period}`,
      observation_time: midnight,
      payload: {
        ...payload(period, effectiveDate, "official", null, finalized.stations, finalized.regions, finalized.admins),
        source: "daily" as const,
      },
      refreshed_at: new Date().toISOString(),
    };
  });
  const { error } = await supabase.from("kma_precip_cache").upsert(rows);
  if (error) throw new TypeError("daily official cache update failed");
  console.info(JSON.stringify({
    event: "kma_daily_official_promoted",
    effectiveDate,
    source: "daily",
  }));
}

async function confirmedDailyRain(effectiveDate: string, authKey: string) {
  const completedAt = `${addDays(effectiveDate, 1)}T00:00`;
  const compactEffectiveDate = effectiveDate.replaceAll("-", "");
  const [hourly, dailyTextValue] = await Promise.all([
    hourlyObservation(completedAt, authKey),
    apiText("sts_rn.php", {
      tm1: compactEffectiveDate,
      tm2: compactEffectiveDate,
      stn_id: "0",
      disp: "1",
      help: "0",
    }, authKey),
  ]);
  const hourlyRain = hourly.rain;
  return {
    hourlyRain,
    dailyRain: parseOfficialDailyRain(dailyTextValue, effectiveDate, hourlyRain.keys()),
  };
}

async function updateIntraday(
  supabase: ReturnType<typeof client>,
  scheduledDate: string,
  authKey: string,
): Promise<string> {
  const hourly = await latestHourlyObservation(authKey);
  const observationTime = hourly.observationTime;
  if (observationTime.slice(0, 10) !== scheduledDate) {
    throw new LatestHourlyObservationUnavailableError(scheduledDate, observationTime);
  }

  const effectiveDate = observationTime.slice(0, 10);
  const baseDate = addDays(effectiveDate, -1);
  const { data, error } = await supabase
    .from("kma_precip_cache")
    .select("cache_key,payload")
    .in("cache_key", PERIODS.map((period) => `official:${period}`));
  if (error || !data) throw new TypeError("official cache lookup failed");
  const officialBases = new Map(data.map((row) => [row.cache_key, row.payload]));
  const needsRollover = PERIODS.some((period) => {
    try {
      parseCachePayload(officialBases.get(`official:${period}`), {
        period,
        effectiveDate: baseDate,
        mode: "official",
      });
      return false;
    } catch (parseError) {
      if (parseError instanceof OfficialDataUnavailableError) return true;
      throw parseError;
    }
  });
  const [endNormal, rolloverBases] = await Promise.all([
    apiText("sfc_norm1.php", normalParams(effectiveDate), authKey).then(parseNormals),
    needsRollover
      ? ensureRolloverBases(supabase, baseDate, authKey)
      : Promise.resolve(new Map<Period, CachePayload>()),
  ]);
  const periodBases = PERIODS.map((period) => ({
    period,
    base: selectRolloverBase(
      {
        official: officialBases.get(`official:${period}`),
        rollover: rolloverBases.get(period),
      },
      { period, effectiveDate: baseDate },
    ),
  }));
  const rows = await Promise.all(periodBases.map(async ({ period, base }) => {
    const stations = period === "ty"
      ? extendOfficialStations(base.stations, hourly.rain, endNormal)
      : await boundaryData(period, effectiveDate, authKey).then((boundary) => adjust(
        base.stations,
        boundary.removedRain,
        hourly.rain,
        boundary.removedNormal,
        endNormal,
      ));
    return {
      cache_key: `intraday:${period}`,
      observation_time: observationTime,
      payload: payload(
        period,
        effectiveDate,
        "intraday",
        observationTime,
        stations,
        base.regions,
        base.admins,
      ),
      refreshed_at: new Date().toISOString(),
    };
  }));
  const { error: upsertError } = await supabase.from("kma_precip_cache").upsert(rows);
  if (upsertError) throw new TypeError("intraday cache update failed");
  return observationTime;
}

Deno.serve(async (request: Request) => {
  try {
    const supabase = client();
    if (request.method === "GET") {
      const url = new URL(request.url);
      const period = PERIODS.find((value) => value === url.searchParams.get("period"));
      const mode = url.searchParams.get("mode");
      if (!period || (mode !== "official" && mode !== "intraday" && mode !== "completed")) {
        return Response.json({ error: "invalid query" }, { status: 400 });
      }
      if (mode === "completed") {
        const [official, rollover] = await Promise.all([
          supabase.from("kma_precip_cache").select("payload").eq("cache_key", `official:${period}`).maybeSingle(),
          supabase.from("kma_precip_cache").select("payload").like("cache_key", `rollover:%:${period}`).order("cache_key", { ascending: false }).limit(1).maybeSingle(),
        ]);
        if (official.error || rollover.error) throw new TypeError("completed cache lookup failed");
        try {
          return Response.json(selectLatestCompletedBase({ official: official.data?.payload, rollover: rollover.data?.payload }, period), {
            headers: { "Cache-Control": "public, max-age=60" },
          });
        } catch (error) {
          if (error instanceof OfficialDataUnavailableError) return Response.json({ error: "cache is not ready" }, { status: 503 });
          throw error;
        }
      }
      const { data, error } = await supabase
        .from("kma_precip_cache")
        .select("payload")
        .eq("cache_key", `${mode}:${period}`)
        .maybeSingle();
      if (error) throw new TypeError("cache lookup failed");
      if (!data) return Response.json({ error: "cache is not ready" }, { status: 503 });
      return Response.json(data.payload, {
        headers: { "Cache-Control": "public, max-age=60" },
      });
    }

    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
    const authKey = request.headers.get("x-kma-auth");
    if (!authKey || authKey.length < 16) return new Response("unauthorized", { status: 401 });

    const scheduledObservationTime = kstHour();
    const scheduledDate = scheduledObservationTime.slice(0, 10);
    const hour = Number(scheduledObservationTime.slice(11, 13));
    const forceOfficial = new URL(request.url).searchParams.get("refresh") === "official";
    const midnight = `${scheduledDate}T00:00`;

    if (forceOfficial) {
      const effectiveDate = addDays(scheduledDate, -1);
      const current = await supabase
        .from("kma_precip_cache")
        .select("payload")
        .in("cache_key", PERIODS.map((period) => `official:${period}`));
      if (current.error || !current.data) throw new TypeError("official cache lookup failed");
      const alreadyCurrent = current.data.length === PERIODS.length
        && current.data.every((row) => isRecord(row.payload)
          && row.payload.effectiveDate === effectiveDate
          && row.payload.source === "daily");
      if (alreadyCurrent) {
        return Response.json({
          status: "current",
          mode: "official",
          observationTime: scheduledObservationTime,
        });
      }
      const previousDate = addDays(effectiveDate, -1);
      const incrementalReady = current.data.length === PERIODS.length
        && current.data.every((row) => isRecord(row.payload)
          && row.payload.effectiveDate === previousDate
          && row.payload.source === "daily");
      const result = await refreshOfficial(
        () => incrementalReady
          ? updateOfficialFromDaily(supabase, midnight, authKey)
          : rebuildOfficialFromDaily(supabase, midnight, authKey),
      );
      if (result === "deferred") {
        return Response.json({
          status: "deferred",
          reason: "official data not ready",
          observationTime: scheduledObservationTime,
        }, { status: 202 });
      }
      return Response.json({
        status: "updated",
        mode: "official",
        observationTime: scheduledObservationTime,
      });
    }

    if (hour === 0) {
      await ensureRolloverBases(supabase, addDays(scheduledDate, -1), authKey);
      return Response.json({
        status: "updated",
        mode: "rollover",
        observationTime: scheduledObservationTime,
      });
    }

    const observationTime = await updateIntraday(supabase, scheduledDate, authKey);
    return Response.json({ status: "updated", mode: "intraday", observationTime });
  } catch (error) {
    if (error instanceof LatestHourlyObservationUnavailableError) {
      console.warn(JSON.stringify({
        event: "kma_hourly_cache_deferred",
        scheduledDate: error.scheduledDate,
        actualObservationTime: error.actualObservationTime,
      }));
      return Response.json({
        status: "deferred",
        reason: "current-day hourly data not ready",
        observationTime: error.actualObservationTime,
      }, { status: 202 });
    }
    const message = safeRefreshErrorMessage(error);
    console.error(JSON.stringify({ event: "kma_hourly_cache_failure", message }));
    return Response.json({ error: "refresh unavailable" }, { status: 502 });
  }
});
