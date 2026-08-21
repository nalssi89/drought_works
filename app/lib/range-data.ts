import ky, { HTTPError, TimeoutError } from "ky";
import { z } from "zod";

import type { RangeStationTotal } from "./future-scenario";

const stationSchema = z.object({
  stn_cd: z.number().int(),
  stn_nm: z.string().min(1),
  prcp: z.union([z.string(), z.number()]),
  norm: z.union([z.string(), z.number()]),
  norm_ratio: z.union([z.string(), z.number()]),
});
const payloadSchema = z.object({
  t2: z.array(stationSchema).length(66),
});

export async function fetchOfficialRangeTotals(
  startDate: string,
  endDate: string,
): Promise<Map<number, RangeStationTotal>> {
  if (startDate > endDate) return new Map();
  try {
    const payload = payloadSchema.parse(await fetchRangePayload(startDate, endDate));
    return new Map(payload.t2.map((row) => [
      row.stn_cd,
      { precipitation: numeric(row.prcp), normal: numeric(row.norm) },
    ]));
  }
  catch (error) {
    if (error instanceof HTTPError || error instanceof TimeoutError || error instanceof TypeError || error instanceof z.ZodError) {
      throw new TypeError("기준기간에서 제외되는 과거 강수량과 평년값을 불러오지 못했습니다.");
    }
    throw error;
  }
}

async function fetchRangePayload(startDate: string, endDate: string): Promise<unknown> {
  const proxyUrl = process.env.KMA_PROXY_URL;
  const proxyKey = process.env.KMA_PROXY_ANON_KEY;
  if (proxyUrl && proxyKey) {
    return ky.get(proxyUrl, {
      searchParams: { date: endDate, period: "custom", start: startDate },
      headers: { apikey: proxyKey, Authorization: `Bearer ${proxyKey}` },
      retry: { limit: 2, methods: ["get"] },
      timeout: 60_000,
    }).json<unknown>();
  }

  return ky.post("https://hydro.kma.go.kr/ext/prec.do", {
    body: new URLSearchParams({
      PERIOD: "random",
      START: startDate.replaceAll("-", ""),
      END: endDate.replaceAll("-", ""),
      SPOT: "2",
      DATE: endDate.replaceAll("-", ""),
    }),
    headers: {
      Referer: "https://hydro.kma.go.kr/ext/prec_map.do",
      "X-Requested-With": "XMLHttpRequest",
    },
    retry: { limit: 2, methods: ["post"] },
    timeout: 60_000,
  }).json<unknown>();
}

function numeric(value: string | number): number {
  const parsed = Number(String(value).replaceAll(",", ""));
  if (!Number.isFinite(parsed)) throw new TypeError("범위 자료의 숫자 형식이 올바르지 않습니다.");
  return parsed;
}
