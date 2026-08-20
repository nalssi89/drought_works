import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import ky from "ky";

const PERIODS = new Set(["1m", "3m", "6m", "12m", "ty"]);

Deno.serve(async (request: Request) => {
  if (request.method !== "GET") return new Response("method not allowed", { status: 405 });

  const url = new URL(request.url);
  const date = url.searchParams.get("date") ?? "";
  const period = url.searchParams.get("period") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !PERIODS.has(period)) {
    return Response.json({ error: "invalid date or period" }, { status: 400 });
  }

  try {
    const payload = await ky.post("https://hydro.kma.go.kr/drought/analysisAccData.do", {
      headers: {
        Accept: "application/json, text/javascript, */*; q=0.01",
        "Accept-Language": "ko-KR,ko;q=0.9",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        Origin: "https://hydro.kma.go.kr",
        Referer: "https://hydro.kma.go.kr/index.do",
        "User-Agent": "Mozilla/5.0 (compatible; KMA-Precipitation-Dashboard/1.0)",
        "X-Requested-With": "XMLHttpRequest",
      },
      body: new URLSearchParams({ PERIOD: period, search_date: date.replaceAll("-", "") }),
      retry: { limit: 2, methods: ["post"] },
      timeout: 20_000,
    }).json<unknown>();
    if (!isRecord(payload) || !Array.isArray(payload.list1) || !Array.isArray(payload.list2) || !Array.isArray(payload.list_admin)) {
      return Response.json({ error: "invalid upstream response" }, { status: 502 });
    }

    return Response.json(payload, { headers: { "Cache-Control": "public, max-age=300" } });
  } catch (error) {
    if (error instanceof Error) return Response.json({ error: "upstream unavailable" }, { status: 502 });
    throw error;
  }
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
