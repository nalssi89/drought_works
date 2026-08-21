import ky from "ky";

import { parseHourlyDailyRain, parseOfficialDailyRain } from "./intraday";

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
    return parseDailyNormalTotals(text);
  }));

  const totals = new Map<number, number>();
  for (const values of maps) {
    for (const [station, value] of values) totals.set(station, round1((totals.get(station) ?? 0) + value));
  }
  return totals;
}

export async function fetchOfficialDailyRain(date: string): Promise<Map<number, number>> {
  const text = await request("kma_sfcdd.php", {
    tm: date.replaceAll("-", ""),
    stn: "0",
    disp: "0",
    help: "0",
  });
  return parseOfficialDailyRain(text, date);
}

async function request(path: string, searchParams: Record<string, string>): Promise<string> {
  const authKey = process.env.KMA_API_AUTH_KEY;
  if (!authKey) throw new TypeError("KMA APIHub 인증키가 설정되지 않았습니다.");
  const proxyUrl = process.env.KMA_PROXY_URL;
  const proxyKey = process.env.KMA_PROXY_ANON_KEY;
  const normalRange = path === "sfc_norm1.php"
    && (searchParams.MM1 !== searchParams.MM2 || searchParams.DD1 !== searchParams.DD2);
  const api = path === "kma_sfctm2.php"
    ? "hourly"
    : path === "kma_sfcdd.php"
      ? "daily"
      : normalRange ? "normal-range" : "normal";
  const timeout = normalRange ? 60_000 : 20_000;
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

function parseDailyNormalTotals(text: string): Map<number, number> {
  const totals = new Map<number, number>();
  for (const line of text.split(/\r?\n/)) {
    if (!/^2021,/.test(line)) continue;
    const fields = line.split(",").map((field) => field.trim());
    const station = Number(fields[1]);
    const rain = Number(fields[7]);
    if (Number.isInteger(station) && Number.isFinite(rain) && rain >= 0) {
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

function round1(value: number): number {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}
