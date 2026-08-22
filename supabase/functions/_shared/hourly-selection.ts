import { REPRESENTATIVE_STATIONS } from "./hourly-observation.ts";

type SelectedRow = Readonly<{
  line: string;
  time: string;
}>;

export type HourlySelection = Readonly<{
  text: string;
  carriedFrom: ReadonlyMap<number, string>;
  zeroFilledStations: readonly number[];
}>;

export class HourlySelectionUnavailableError extends Error {
  readonly name = "HourlySelectionUnavailableError";
  readonly requestedTime: string;

  constructor(requestedTime: string) {
    super(`hourly observation is unavailable: ${requestedTime}`);
    this.requestedTime = requestedTime;
  }
}

export function selectHourlyObservation(rangeText: string, requestedTime: string): HourlySelection {
  if (!/^\d{12}$/.test(requestedTime)) throw new TypeError("invalid requested hourly time");

  const requestedDate = requestedTime.slice(0, 8);
  const representativeSet = new Set(REPRESENTATIVE_STATIONS);
  const selected = new Map<number, SelectedRow>();

  for (const line of rangeText.split(/\r?\n/)) {
    if (!/^\d{12}\s/.test(line)) continue;
    const fields = line.trim().split(/\s+/);
    const time = fields[0] ?? "";
    const station = Number(fields[1]);
    const dailyRain = Number(fields[16]);
    if (
      time.slice(0, 8) !== requestedDate
      || time > requestedTime
      || !representativeSet.has(station)
      || !Number.isFinite(dailyRain)
    ) continue;

    const existing = selected.get(station);
    if (!existing || time > existing.time) selected.set(station, { line, time });
  }

  if (selected.size === 0) throw new HourlySelectionUnavailableError(requestedTime);

  const carriedFrom = new Map<number, string>();
  const zeroFilledStations: number[] = [];
  const lines = REPRESENTATIVE_STATIONS.map((station) => {
    const row = selected.get(station);
    if (!row) {
      zeroFilledStations.push(station);
      return zeroRainLine(requestedTime, station);
    }
    if (row.time !== requestedTime) carriedFrom.set(station, row.time);
    return row.line;
  });

  return {
    text: `${lines.join("\n")}\n`,
    carriedFrom,
    zeroFilledStations,
  };
}

function zeroRainLine(time: string, station: number): string {
  const fields = Array.from({ length: 17 }, () => "-9");
  fields[0] = time;
  fields[1] = String(station);
  fields[16] = "0.0";
  return fields.join(" ");
}
