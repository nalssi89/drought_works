import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import ky from "ky";
import { selectHourlyObservation } from "../_shared/hourly-selection.ts";

const API_BASE = "https://apihub.kma.go.kr/api/typ01/url";

Deno.serve(async (request: Request) => {
  if (request.method !== "GET") return new Response("method not allowed", { status: 405 });

  const url = new URL(request.url);
  const api = url.searchParams.get("api");
  if (!api) return Response.json({ error: "invalid api query" }, { status: 400 });
  return proxyApiHub(request, url, api);
});

async function proxyApiHub(request: Request, url: URL, api: string): Promise<Response> {
  const authKey = request.headers.get("x-kma-auth");
  if (!authKey || authKey.length < 16) return new Response("unauthorized", { status: 401 });

  try {
    if (api === "hourly-latest") {
      const stn = url.searchParams.get("stn") ?? "0";
      if (!/^\d+(?::\d+)*$/.test(stn)) return Response.json({ error: "invalid station query" }, { status: 400 });
      const text = await apiText("kma_sfctm2.php", { stn, help: "0", authKey });
      return new Response(text, {
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
      });
    }

    if (api === "hourly-range") {
      const tm1 = url.searchParams.get("tm1") ?? "";
      const tm2 = url.searchParams.get("tm2") ?? "";
      const stn = url.searchParams.get("stn") ?? "0";
      if (!/^\d{12}$/.test(tm1) || !/^\d{12}$/.test(tm2) || tm1 > tm2 || !/^\d+(?::\d+)*$/.test(stn)) {
        return Response.json({ error: "invalid hourly range query" }, { status: 400 });
      }
      const text = await apiText("kma_sfctm3.php", { tm1, tm2, stn, help: "0", authKey }, 60_000);
      return new Response(text, {
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
      });
    }

    if (api === "hourly") {
      const tm = url.searchParams.get("tm") ?? "";
      if (!/^\d{12}$/.test(tm)) return Response.json({ error: "invalid hourly query" }, { status: 400 });
      const rangeText = await apiText("kma_sfctm3.php", {
        tm1: `${tm.slice(0, 8)}0000`,
        tm2: tm,
        stn: "0",
        help: "0",
        authKey,
      }, 60_000);
      const observation = selectHourlyObservation(rangeText, tm);
      const headers = new Headers({ "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=60" });
      if (observation.carriedFrom.size > 0) {
        headers.set("X-KMA-Carried-Stations", [...observation.carriedFrom.entries()].map(([station, time]) => `${station}@${time}`).join(","));
      }
      if (observation.zeroFilledStations.length > 0) {
        headers.set("X-KMA-Zero-Filled-Stations", observation.zeroFilledStations.join(","));
      }
      return new Response(observation.text, { headers });
    }

    let path: string;
    let searchParams: Record<string, string>;
    let cacheControl = "public, max-age=60";
    if (api === "daily") {
      const tm1 = url.searchParams.get("tm1") ?? "";
      const tm2 = url.searchParams.get("tm2") ?? "";
      const stnId = url.searchParams.get("stn_id") ?? "0";
      if (!/^\d{8}$/.test(tm1) || !/^\d{8}$/.test(tm2) || tm1 > tm2 || !/^\d+(?::\d+)*$/.test(stnId)) {
        return Response.json({ error: "invalid daily query" }, { status: 400 });
      }
      path = "sts_rn.php";
      searchParams = { tm1, tm2, stn_id: stnId, disp: "1", help: "0", authKey };
    }
    else if (api === "normal" || api === "normal-range") {
      const month1 = url.searchParams.get("MM1") ?? "";
      const day1 = url.searchParams.get("DD1") ?? "";
      const month2 = api === "normal" ? month1 : url.searchParams.get("MM2") ?? "";
      const day2 = api === "normal" ? day1 : url.searchParams.get("DD2") ?? "";
      if (!validMonthDay(month1, day1) || !validMonthDay(month2, day2) || monthDayOrdinal(month1, day1) > monthDayOrdinal(month2, day2)) {
        return Response.json({ error: "invalid normal query" }, { status: 400 });
      }
      path = "sfc_norm1.php";
      searchParams = { norm: "D", tmst: "2021", stn: "0", MM1: month1, DD1: day1, MM2: month2, DD2: day2, authKey };
      cacheControl = "public, max-age=86400";
    }
    else return Response.json({ error: "invalid api query" }, { status: 400 });

    const longRange = api === "normal-range" || (api === "daily" && searchParams.tm1 !== searchParams.tm2);
    const text = await apiText(path, searchParams, longRange ? 60_000 : 20_000);
    return new Response(text, {
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": cacheControl },
    });
  } catch (error) {
    if (error instanceof Error) return Response.json({ error: "api upstream unavailable" }, { status: 502 });
    throw error;
  }
}

async function apiText(path: string, searchParams: Record<string, string>, timeout = 20_000): Promise<string> {
  return ky.get(`${API_BASE}/${path}`, {
    searchParams,
    retry: { limit: 2, methods: ["get"] },
    timeout,
  }).text();
}

function validMonthDay(month: string, day: string): boolean {
  if (!/^(?:[1-9]|1[0-2])$/.test(month) || !/^(?:[1-9]|[12]\d|3[01])$/.test(day)) return false;
  const parsed = new Date(Date.UTC(2000, Number(month) - 1, Number(day)));
  return parsed.getUTCMonth() === Number(month) - 1 && parsed.getUTCDate() === Number(day);
}

function monthDayOrdinal(month: string, day: string): number {
  return Math.round((Date.UTC(2000, Number(month) - 1, Number(day)) - Date.UTC(2000, 0, 1)) / 86_400_000);
}
