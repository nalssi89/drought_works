type StationRecord = Readonly<{
  code: number;
}>;

type StationRegionDefinition = Readonly<{
  key: string;
  label: string;
  codes: readonly number[];
}>;

export type StationRegionGroup<T extends StationRecord> = Readonly<{
  key: string;
  label: string;
  stations: readonly T[];
}>;

export const STATION_REGIONS: readonly StationRegionDefinition[] = [
  { key: "metro", label: "서울·인천·경기도", codes: [108, 112, 119, 201, 202, 203] },
  { key: "yeongseo", label: "강원특별자치도 영서", codes: [95, 101, 114, 211, 212] },
  { key: "yeongdong", label: "강원특별자치도 영동", codes: [90, 100, 105, 216] },
  { key: "chungbuk", label: "충청북도", codes: [127, 131, 135, 221, 226] },
  { key: "chungnam", label: "대전·세종·충청남도", codes: [129, 133, 232, 235, 236, 238] },
  { key: "jeonbuk", label: "전북특별자치도", codes: [140, 146, 243, 244, 245, 247, 248] },
  { key: "jeonnam", label: "광주·전라남도", codes: [156, 165, 168, 170, 260, 261, 262] },
  { key: "gyeongbuk", label: "대구·경상북도", codes: [130, 136, 138, 143, 271, 272, 273, 277, 278, 279, 281] },
  { key: "gyeongnam", label: "부산·울산·경상남도", codes: [152, 155, 159, 162, 192, 284, 285, 288, 289, 294, 295] },
  { key: "jeju", label: "제주특별자치도", codes: [184, 185, 188, 189] },
];

export function groupStationsByRegion<T extends StationRecord>(stations: readonly T[]): StationRegionGroup<T>[] {
  const stationsByCode = new Map(stations.map((station) => [station.code, station] as const));
  const assignedCodes = new Set<number>();
  const groups = STATION_REGIONS.map((region) => {
    const groupedStations = region.codes.flatMap((code) => {
      const station = stationsByCode.get(code);
      if (!station) return [];
      assignedCodes.add(code);
      return [station];
    });
    return { key: region.key, label: region.label, stations: groupedStations };
  });
  const unassignedStations = [...stations]
    .filter((station) => !assignedCodes.has(station.code))
    .sort((left, right) => left.code - right.code);
  return unassignedStations.length === 0
    ? groups
    : [...groups, { key: "other", label: "기타", stations: unassignedStations }];
}

export function ratioThresholdClass(ratio: number): string | null {
  if (ratio <= 45) return "ratio-threshold-45";
  if (ratio <= 55) return "ratio-threshold-55";
  if (ratio <= 65) return "ratio-threshold-65";
  return null;
}

export function ratioCellClass(ratio: number): string {
  return ["ratio-value", ratioThresholdClass(ratio)].filter(Boolean).join(" ");
}
