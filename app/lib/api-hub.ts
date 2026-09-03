import ky from "ky";

import { parseHourlyDailyRain, parseOfficialDailyRain, parseOfficialDailyRainTotals } from "./intraday.ts";

const API_BASE = "https://apihub.kma.go.kr/api/typ01/url";

export async function fetchHourlyDailyRain(observationTime: string): Promise<Map<number, number>> {
  const text = await request("kma_sfctm2.php", {
    tm: observationTime.replaceAll(/[-:T]/g, ""),
    stn: "0",
    help: "0",
  });
  return parseHourlyDailyRain(text);
}

export async function fetchDailyNormals(date: string): Promise<Map<number, number>> {
  return fetchDailyNormalRange(date, date);
}

export async function fetchDailyNormalRange(startDate: string, endDate: string): Promise<Map<number, number>> {
  if (startDate > endDate) return new Map();
  const segments = splitByCalendarYear(startDate, endDate);
  const maps = await Promise.all(segments.map(async ({ start, end }) => {
    const [, startMonth, startDay] = start.split("-");
    const [, endMonth, endDay] = end.split("-");
    const text = await request("sfc_norm1.php", {
      norm: "D",
      tmst: "2021",
      stn: "0",
      MM1: String(Number(startMonth)),
      DD1: String(Number(startDay)),
      MM2: String(Number(endMonth)),
      DD2: String(Number(endDay)),
    });
    return parseDailyNormalTotals(text, Number(start.slice(0, 4)));
  }));

  const totals = new Map<number, number>();
  for (const values of maps) {
    for (const [station, value] of values) totals.set(station, round1((totals.get(station) ?? 0) + value));
  }
  return totals;
}

export async function fetchOfficialDailyRain(date: string): Promise<Map<number, number>> {
  const compactDate = date.replaceAll("-", "");
  const text = await request("sts_rn.php", {
    tm1: compactDate,
    tm2: compactDate,
    stn_id: "0",
    disp: "1",
    help: "0",
  });
  return parseOfficialDailyRain(text, date);
}

export async function fetchOfficialDailyRainRange(startDate: string, endDate: string): Promise<Map<number, number>> {
  if (startDate > endDate) return new Map();
  const segments = splitByDays(startDate, endDate, 31);
  const maps = await Promise.all(segments.map(async ({ start, end }) => {
    const text = await request("sts_rn.php", {
      tm1: start.replaceAll("-", ""),
      tm2: end.replaceAll("-", ""),
      stn_id: "0",
      disp: "1",
      help: "0",
    });
    return parseOfficialDailyRainTotals(text, start, end);
  }));

  const totals = new Map<number, number>();
  for (const values of maps) {
    for (const [station, value] of values) totals.set(station, round1((totals.get(station) ?? 0) + value));
  }
  return totals;
}

async function request(path: string, searchParams: Record<string, string>): Promise<string> {
  const authKey = process.env.KMA_API_AUTH_KEY;
  if (!authKey) throw new TypeError("KMA APIHub 인증키가 설정되지 않았습니다.");
  const proxyUrl = process.env.KMA_PROXY_URL;
  const proxyKey = process.env.KMA_PROXY_ANON_KEY;
  const normalRange = path === "sfc_norm1.php"
    && (searchParams.MM1 !== searchParams.MM2 || searchParams.DD1 !== searchParams.DD2);
  const dailyRange = path === "sts_rn.php" && searchParams.tm1 !== searchParams.tm2;
  const api = path === "kma_sfctm2.php"
    ? "hourly"
    : path === "sts_rn.php"
      ? "daily"
      : normalRange ? "normal-range" : "normal";
  const timeout = normalRange || dailyRange ? 60_000 : 20_000;
  if (proxyUrl && proxyKey) {
    return ky.get(proxyUrl, {
      searchParams: { api, ...searchParams },
      headers: {
        apikey: proxyKey,
        Authorization: `Bearer ${proxyKey}`,
        "x-kma-auth": authKey,
      },
      retry: { limit: 2, methods: ["get"] },
      timeout,
    }).text();
  }
  return ky.get(`${API_BASE}/${path}`, {
    searchParams: { ...searchParams, authKey },
    retry: { limit: 2, methods: ["get"] },
    timeout,
  }).text();
}

export function parseDailyNormalTotals(text: string, actualYear: number): Map<number, number> {
  const totals = new Map<number, number>();
  for (const line of text.split(/\r?\n/)) {
    if (!/^2021,/.test(line)) continue;
    const fields = line.split(",").map((field) => field.trim());
    const station = Number(fields[1]);
    const month = Number(fields[2]);
    const day = Number(fields[3]);
    const rain = Number(fields[7]);
    const date = `${actualYear}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (validDate(date) && Number.isInteger(station) && Number.isFinite(rain) && rain >= 0) {
      totals.set(station, round1((totals.get(station) ?? 0) + rain));
    }
  }
  return totals;
}

function splitByCalendarYear(startDate: string, endDate: string): ReadonlyArray<Readonly<{ start: string; end: string }>> {
  const segments: Array<{ start: string; end: string }> = [];
  let cursor = startDate;
  while (cursor <= endDate) {
    const year = Number(cursor.slice(0, 4));
    const yearEnd = `${year}-12-31`;
    const segmentEnd = yearEnd < endDate ? yearEnd : endDate;
    segments.push({ start: cursor, end: segmentEnd });
    cursor = `${year + 1}-01-01`;
  }
  return segments;
}

function splitByDays(startDate: string, endDate: string, maximumDays: number): ReadonlyArray<Readonly<{ start: string; end: string }>> {
  const segments: Array<{ start: string; end: string }> = [];
  let cursor = startDate;
  while (cursor <= endDate) {
    const candidateEnd = addDays(cursor, maximumDays - 1);
    const segmentEnd = candidateEnd < endDate ? candidateEnd : endDate;
    segments.push({ start: cursor, end: segmentEnd });
    cursor = addDays(segmentEnd, 1);
  }
  return segments;
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function round1(value: number): number {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

function validDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}
