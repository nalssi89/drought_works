import ky from "ky";

import { parseDailyNormals, parseHourlyDailyRain } from "./intraday.ts";

const API_BASE = "https://apihub.kma.go.kr/api/typ01/url";

export async function fetchHourlyDailyRain(observationTime: string): Promise<Map<number, number>> {
  const text = await request("kma_sfctm2.php", {
    tm: observationTime.replaceAll(/[-:T]/g, ""),
    stn: "0",
    help: "0",
  });
  return parseHourlyDailyRain(text, observationTime);
}

export async function fetchDailyNormals(date: string): Promise<Map<number, number>> {
  const [, month, day] = date.split("-");
  const text = await request("sfc_norm1.php", {
    norm: "D",
    tmst: "2021",
    stn: "0",
    MM1: String(Number(month)),
    DD1: String(Number(day)),
    MM2: String(Number(month)),
    DD2: String(Number(day)),
  });
  return parseDailyNormals(text, date);
}

async function request(path: string, searchParams: Record<string, string>): Promise<string> {
  const authKey = process.env.KMA_API_AUTH_KEY;
  if (!authKey) throw new TypeError("KMA APIHub 인증키가 설정되지 않았습니다.");
  return ky.get(`${API_BASE}/${path}`, {
    searchParams: { ...searchParams, authKey },
    retry: { limit: 2, methods: ["get"] },
    timeout: 20_000,
  }).text();
}
