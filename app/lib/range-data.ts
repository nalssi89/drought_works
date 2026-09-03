import { fetchDailyNormalRange, fetchOfficialDailyRainRange } from "./api-hub";
import type { RangeStationTotal } from "./future-scenario";
import { KMA_NORMAL_CODE, KMA_STATION_CODES } from "./kma-stations.ts";

export async function fetchOfficialRangeTotals(
  startDate: string,
  endDate: string,
): Promise<Map<number, RangeStationTotal>> {
  if (startDate > endDate) return new Map();
  try {
    const [rain, normals] = await Promise.all([
      fetchOfficialDailyRainRange(startDate, endDate),
      fetchDailyNormalRange(startDate, endDate),
    ]);
    return new Map(KMA_STATION_CODES.map((station) => [
      station,
      {
        precipitation: required(rain, station),
        normal: required(normals, KMA_NORMAL_CODE.get(station) ?? station),
      },
    ]));
  }
  catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new TypeError("기준기간에서 제외되는 과거 강수량과 평년값을 불러오지 못했습니다.");
  }
}

function required(values: ReadonlyMap<number, number>, station: number): number {
  const value = values.get(station);
  if (value === undefined) throw new TypeError(`${station} 지점 자료가 없습니다.`);
  return value;
}
