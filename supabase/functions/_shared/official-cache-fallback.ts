export const OFFICIAL_PERIODS = ["1m", "3m", "6m", "12m", "ty"] as const;
export type OfficialPeriod = typeof OFFICIAL_PERIODS[number];

type CachedStation = Readonly<{
  code: number;
  name: string;
  normal: number;
  precipitation: number;
  ratio: number;
}>;

type CachedAggregate = Readonly<{
  code: string;
  normal: number;
  precipitation: number;
  ratio: number;
  rank: number | null;
}>;

export function officialPayloadReady(value: unknown, period: OfficialPeriod): boolean {
  if (!isRecord(value)) return false;
  if (!Array.isArray(value.list1) || !Array.isArray(value.list2) || !Array.isArray(value.list_admin)) return false;
  const expectedRegionCount = period === "ty" ? 0 : 12;
  return value.list1.length === expectedRegionCount
    && value.list2.length === 66
    && value.list_admin.length === 4
    && typeof value.search_period === "string"
    && value.search_period.length > 0
    && typeof value.search_date_db === "string"
    && /^\d{8}$/.test(value.search_date_db);
}

export function cachedPayloadToOfficial(
  value: unknown,
  requestedDate: string,
  period: OfficialPeriod,
): Record<string, unknown> | null {
  if (!isRecord(value)
    || value.schemaVersion !== 2
    || value.period !== period
    || value.effectiveDate !== requestedDate
    || value.mode !== "official"
    || !Array.isArray(value.stations)
    || !Array.isArray(value.regions)
    || !Array.isArray(value.admins)) return null;

  const stations = value.stations.map(parseStation);
  const regions = value.regions.map(parseAggregate);
  const admins = value.admins.map(parseAggregate);
  if (stations.some((row) => row === null)
    || regions.some((row) => row === null)
    || admins.some((row) => row === null)
    || stations.length !== 66
    || regions.length !== 12
    || admins.length !== 4) return null;

  const stationValues = stations as CachedStation[];
  const regionValues = regions as CachedAggregate[];
  const adminValues = admins as CachedAggregate[];
  return {
    list1: period === "ty" ? [] : regionValues.map(toOfficialAggregate),
    list2: stationValues.map((station) => ({
      stn_cd: station.code,
      stn_nm: station.name,
      ny_prcp: String(station.normal),
      rn_total: String(station.precipitation),
      rn_ratio_sort: station.ratio,
    })),
    list_admin: adminValues.map(toOfficialAggregate),
    search_period: `${displayDate(periodStart(requestedDate, period))} ~ ${displayDate(requestedDate)}`,
    search_date_db: requestedDate.replaceAll("-", ""),
  };
}

function parseStation(value: unknown): CachedStation | null {
  if (!isRecord(value)
    || typeof value.code !== "number"
    || !Number.isInteger(value.code)
    || typeof value.name !== "string"
    || typeof value.normal !== "number"
    || typeof value.precipitation !== "number"
    || typeof value.ratio !== "number") return null;
  return {
    code: value.code,
    name: value.name,
    normal: value.normal,
    precipitation: value.precipitation,
    ratio: value.ratio,
  };
}

function parseAggregate(value: unknown): CachedAggregate | null {
  if (!isRecord(value)
    || typeof value.code !== "string"
    || typeof value.normal !== "number"
    || typeof value.precipitation !== "number"
    || typeof value.ratio !== "number"
    || (value.rank !== null && typeof value.rank !== "number")) return null;
  return {
    code: value.code,
    normal: value.normal,
    precipitation: value.precipitation,
    ratio: value.ratio,
    rank: value.rank,
  };
}

function toOfficialAggregate(value: CachedAggregate): Record<string, string> {
  return {
    brtc_cd: value.code,
    ny_prcp: String(value.normal),
    rn_total: String(value.precipitation),
    rn_ratio: String(value.ratio),
    rank_num: value.rank === null ? "0" : String(value.rank),
  };
}

function periodStart(endDate: string, period: OfficialPeriod): string {
  if (period === "ty") return `${endDate.slice(0, 4)}-01-01`;
  const months = period === "1m" ? 1 : period === "3m" ? 3 : period === "6m" ? 6 : 12;
  return addDays(addMonths(endDate, -months), 1);
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

function displayDate(value: string): string {
  const [year, month, day] = value.split("-");
  return `${year}년 ${month}월 ${day}일`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
