import ky from "ky";

import { parseDailyNormals, parseHourlyDailyRain, parseOfficialDailyRain } from "./intraday";

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
  return parseDailyNormals(text);
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
  const api = path === "kma_sfctm2.php" ? "hourly" : path === "kma_sfcdd.php" ? "daily" : "normal";
  if (proxyUrl && proxyKey) {
    return ky.get(proxyUrl, {
      searchParams: { api, ...searchParams },
      headers: {
        apikey: proxyKey,
        Authorization: `Bearer ${proxyKey}`,
        "x-kma-auth": authKey,
      },
      retry: { limit: 2, methods: ["get"] },
      timeout: 20_000,
    }).text();
  }
  return ky.get(`${API_BASE}/${path}`, {
    searchParams: { ...searchParams, authKey },
    retry: { limit: 2, methods: ["get"] },
    timeout: 20_000,
  }).text();
}
