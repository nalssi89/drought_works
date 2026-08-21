export const REPRESENTATIVE_STATIONS: readonly number[] = [
  108, 112, 119, 201, 202, 203,
  101, 114, 211, 212, 95,
  100, 105, 216, 90,
  127, 131, 135, 221, 226,
  129, 133, 232, 235, 236, 238,
  140, 146, 243, 244, 245, 247, 248,
  156, 165, 168, 170, 260, 261, 262,
  130, 136, 138, 143, 271, 272, 273, 277, 278, 279, 281,
  152, 155, 159, 162, 192, 284, 285, 288, 289, 294, 295,
  184, 185, 188, 189,
];

const REPRESENTATIVE_STATION_SET = new Set(REPRESENTATIVE_STATIONS);

type HourlyRow = Readonly<{
  line: string;
  observationTime: string;
  station: number;
  rain: number;
}>;

type CompleteHourlyObservationInput = Readonly<{
  observationTime: string;
  currentText: string;
  fetchFallbackText: (observationTime: string, stations: readonly number[]) => Promise<string>;
}>;

type CompleteLatestHourlyObservationInput = Readonly<{
  currentText: string;
  fetchRangeText: (
    startTime: string,
    endTime: string,
    stations: readonly number[],
  ) => Promise<string>;
}>;

export type CompleteHourlyObservation = Readonly<{
  text: string;
  rain: ReadonlyMap<number, number>;
  carriedFrom: ReadonlyMap<number, string>;
}>;

export type CompleteLatestHourlyObservation = Readonly<{
  observationTime: string;
  rain: ReadonlyMap<number, number>;
  carriedFrom: ReadonlyMap<number, string>;
  defaultedStations: readonly number[];
}>;

export class IncompleteHourlyObservationError extends Error {
  readonly name = "IncompleteHourlyObservationError";
  readonly observationTime: string;
  readonly missingStations: readonly number[];

  constructor(
    observationTime: string,
    missingStations: readonly number[],
  ) {
    super(`incomplete hourly observation: ${observationTime}`);
    this.observationTime = observationTime;
    this.missingStations = missingStations;
  }
}

export async function completeHourlyObservation(
  input: CompleteHourlyObservationInput,
): Promise<CompleteHourlyObservation> {
  const rows = parseHourlyRows(input.currentText, input.observationTime);
  const carriedFrom = new Map<number, string>();
  const carriedLines: string[] = [];
  let missingStations = REPRESENTATIVE_STATIONS.filter((station) => !rows.has(station));
  const currentHour = Number(input.observationTime.slice(8, 10));
  if (missingStations.length === REPRESENTATIVE_STATIONS.length) {
    throw new IncompleteHourlyObservationError(input.observationTime, missingStations);
  }

  for (let hour = currentHour - 1; hour >= 0 && missingStations.length > 0; hour -= 1) {
    const fallbackTime = `${input.observationTime.slice(0, 8)}${String(hour).padStart(2, "0")}00`;
    const fallbackText = await input.fetchFallbackText(fallbackTime, missingStations);
    const fallbackRows = parseHourlyRows(fallbackText, fallbackTime);
    for (const station of missingStations) {
      const row = fallbackRows.get(station);
      if (!row) continue;
      rows.set(station, row);
      carriedFrom.set(station, fallbackTime);
      carriedLines.push(row.line);
    }
    missingStations = REPRESENTATIVE_STATIONS.filter((station) => !rows.has(station));
  }

  if (missingStations.length > 0) {
    throw new IncompleteHourlyObservationError(input.observationTime, missingStations);
  }

  const rain = new Map<number, number>();
  for (const [station, row] of rows) rain.set(station, row.rain);
  const text = carriedLines.length === 0
    ? input.currentText
    : `${input.currentText.trimEnd()}\n${carriedLines.join("\n")}\n`;
  return { text, rain, carriedFrom };
}

export async function completeLatestHourlyObservation(
  input: CompleteLatestHourlyObservationInput,
): Promise<CompleteLatestHourlyObservation> {
  const currentRecords = parseHourlyRecords(input.currentText);
  const observationTime = currentRecords.reduce(
    (latest, row) => row.observationTime > latest ? row.observationTime : latest,
    "",
  );
  if (!observationTime) {
    throw new IncompleteHourlyObservationError("latest", REPRESENTATIVE_STATIONS);
  }

  const selected = new Map<number, HourlyRow>();
  for (const row of currentRecords) {
    if (row.observationTime === observationTime && REPRESENTATIVE_STATION_SET.has(row.station)) {
      selected.set(row.station, row);
    }
  }

  let missingStations = REPRESENTATIVE_STATIONS.filter((station) => !selected.has(station));
  const carriedFrom = new Map<number, string>();
  if (missingStations.length > 0) {
    const startTime = `${observationTime.slice(0, 8)}0000`;
    const fallbackText = await input.fetchRangeText(startTime, observationTime, missingStations);
    const fallbackRecords = parseHourlyRecords(fallbackText)
      .filter((row) => row.observationTime.slice(0, 8) === observationTime.slice(0, 8));
    const latestByStation = new Map<number, HourlyRow>();
    for (const row of fallbackRecords) {
      if (!missingStations.includes(row.station)) continue;
      const previous = latestByStation.get(row.station);
      if (!previous || row.observationTime > previous.observationTime) latestByStation.set(row.station, row);
    }
    for (const station of missingStations) {
      const row = latestByStation.get(station);
      if (!row) continue;
      selected.set(station, row);
      carriedFrom.set(station, row.observationTime);
    }
    missingStations = REPRESENTATIVE_STATIONS.filter((station) => !selected.has(station));
  }

  const rain = new Map<number, number>();
  for (const station of REPRESENTATIVE_STATIONS) {
    rain.set(station, selected.get(station)?.rain ?? 0);
  }

  return {
    observationTime,
    rain,
    carriedFrom,
    defaultedStations: missingStations,
  };
}

function parseHourlyRows(text: string, observationTime: string): Map<number, HourlyRow> {
  const rows = new Map<number, HourlyRow>();
  for (const row of parseHourlyRecords(text)) {
    if (row.observationTime === observationTime) rows.set(row.station, row);
  }
  return rows;
}

function parseHourlyRecords(text: string): HourlyRow[] {
  const rows: HourlyRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!/^\d{12}\s/.test(line)) continue;
    const fields = line.trim().split(/\s+/);
    const observationTime = fields[0];
    const station = Number(fields[1]);
    const rain = Number(fields[16]);
    if (observationTime && Number.isInteger(station) && Number.isFinite(rain)) {
      rows.push({ line, observationTime, station, rain: Math.max(0, rain) });
    }
  }
  return rows;
}
