import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import ky from "ky";
import { completeHourlyObservation } from "../_shared/hourly-observation.ts";

const PERIODS = new Set(["1m", "3m", "6m", "12m", "ty"]);
const API_BASE = "https://apihub.kma.go.kr/api/typ01/url";

Deno.serve(async (request: Request) => {
  if (request.method !== "GET") return new Response("method not allowed", { status: 405 });

  const url = new URL(request.url);
  const api = url.searchParams.get("api");
  if (api) return proxyApiHub(request, url, api);
  const date = url.searchParams.get("date") ?? "";
  const period = url.searchParams.get("period") ?? "";
  const start = url.searchParams.get("start") ?? "";
  if (!validDate(date) || (period === "custom" ? !validCustomRange(start, date) : !PERIODS.has(period))) {
    return Response.json({ error: "invalid date or period" }, { status: 400 });
  }

  try {
    const custom = period === "custom";
    const payload = await ky.post(custom ? "https://hydro.kma.go.kr/ext/prec.do" : "https://hydro.kma.go.kr/drought/analysisAccData.do", {
      headers: {
        Accept: "application/json, text/javascript, */*; q=0.01",
        "Accept-Language": "ko-KR,ko;q=0.9",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        Origin: "https://hydro.kma.go.kr",
        Referer: custom ? "https://hydro.kma.go.kr/ext/prec_map.do" : "https://hydro.kma.go.kr/index.do",
        "User-Agent": "Mozilla/5.0 (compatible; KMA-Precipitation-Dashboard/1.0)",
        "X-Requested-With": "XMLHttpRequest",
      },
      body: custom
        ? new URLSearchParams({ PERIOD: "random", START: start.replaceAll("-", ""), END: date.replaceAll("-", ""), SPOT: "2", DATE: date.replaceAll("-", "") })
        : new URLSearchParams({ PERIOD: period, search_date: date.replaceAll("-", "") }),
      retry: { limit: 2, methods: ["post"] },
      timeout: custom ? 60_000 : 20_000,
    }).json<unknown>();
    const validPayload = custom
      ? isRecord(payload) && Array.isArray(payload.t1) && Array.isArray(payload.t2) && Array.isArray(payload.t4)
      : isRecord(payload) && Array.isArray(payload.list1) && Array.isArray(payload.list2) && Array.isArray(payload.list_admin);
    if (!validPayload) {
      return Response.json({ error: "invalid upstream response" }, { status: 502 });
    }

    return Response.json(payload, { headers: { "Cache-Control": "public, max-age=300" } });
  } catch (error) {
    if (error instanceof Error) return Response.json({ error: "upstream unavailable" }, { status: 502 });
    throw error;
  }
});

async function proxyApiHub(request: Request, url: URL, api: string): Promise<Response> {
  const authKey = request.headers.get("x-kma-auth");
  if (!authKey || authKey.length < 16) return new Response("unauthorized", { status: 401 });

  try {
    if (api === "hourly") {
      const tm = url.searchParams.get("tm") ?? "";
      if (!/^\d{12}$/.test(tm)) return Response.json({ error: "invalid hourly query" }, { status: 400 });
      const currentText = await apiText("kma_sfctm2.php", { tm, stn: "0", help: "0", authKey });
      const observation = await completeHourlyObservation({
        observationTime: tm,
        currentText,
        fetchFallbackText: (time, stations) => apiText("kma_sfctm2.php", { tm: time, stn: stations.join(":"), help: "0", authKey }),
      });
      const headers = new Headers({ "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=60" });
      if (observation.carriedFrom.size > 0) {
        headers.set("X-KMA-Carried-Stations", [...observation.carriedFrom.entries()].map(([station, time]) => `${station}@${time}`).join(","));
      }
      return new Response(observation.text, { headers });
    }

    let path: string;
    let searchParams: Record<string, string>;
    if (api === "daily") {
      const tm = url.searchParams.get("tm") ?? "";
      if (!/^\d{8}$/.test(tm)) return Response.json({ error: "invalid daily query" }, { status: 400 });
      path = "kma_sfcdd.php";
      searchParams = { tm, stn: "0", disp: "0", help: "0", authKey };
    }
    else if (api === "normal") {
      const month = url.searchParams.get("MM1") ?? "";
      const day = url.searchParams.get("DD1") ?? "";
      if (!/^(?:[1-9]|1[0-2])$/.test(month) || !/^(?:[1-9]|[12]\d|3[01])$/.test(day)) {
        return Response.json({ error: "invalid normal query" }, { status: 400 });
      }
      path = "sfc_norm1.php";
      searchParams = { norm: "D", tmst: "2021", stn: "0", MM1: month, DD1: day, MM2: month, DD2: day, authKey };
    }
    else return Response.json({ error: "invalid api query" }, { status: 400 });

    const text = await apiText(path, searchParams);
    return new Response(text, {
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=60" },
    });
  } catch (error) {
    if (error instanceof Error) return Response.json({ error: "api upstream unavailable" }, { status: 502 });
    throw error;
  }
}

async function apiText(path: string, searchParams: Record<string, string>): Promise<string> {
  return ky.get(`${API_BASE}/${path}`, {
    searchParams,
    retry: { limit: 2, methods: ["get"] },
    timeout: 20_000,
  }).text();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validCustomRange(start: string, end: string): boolean {
  if (!validDate(start)) return false;
  const elapsedDays = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
  return elapsedDays >= 0 && elapsedDays <= 366;
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}
