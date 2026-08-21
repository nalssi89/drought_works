import { HTTPError, TimeoutError } from "ky";
import { z } from "zod";

import { fetchDailyNormalRange } from "./api-hub";
import {
  calculateFutureScenario,
  defaultFutureDate,
  futureRangeIssue,
  scenarioPeriodLabel,
  scenarioWindow,
  type FutureBaseMode,
  type RainfallByRegion,
  type RangeStationTotal,
} from "./future-scenario";
import { fetchOfficialRangeTotals } from "./range-data";
import {
  latestObservationTime,
  loadDashboard,
  type DashboardData,
  type DashboardResult,
  type Period,
} from "./precipitation";

export type FutureDashboardRequest = Readonly<{
  baseMode: FutureBaseMode;
  requestedBaseDate: string | null;
  explicitObservationTime: string | null;
  requestedTargetDate: string | null;
  scenarioPeriod: Period;
  rainfallByRegion: RainfallByRegion;
}>;

export async function loadFutureDashboard(request: FutureDashboardRequest): Promise<DashboardResult> {
  const observationTime = request.baseMode === "intraday"
    ? request.explicitObservationTime ?? latestObservationTime()
    : null;
  const useCachedLatest = request.baseMode === "intraday"
    ? request.explicitObservationTime === null
    : request.requestedBaseDate === null;
  const base = await loadDashboard(
    request.baseMode === "official" ? request.requestedBaseDate : observationTime?.slice(0, 10) ?? null,
    request.scenarioPeriod,
    observationTime,
    useCachedLatest,
  );
  if (base.kind !== "ok") return base;

  const baseDate = base.data.effectiveDate;
  const targetDate = request.requestedTargetDate ?? defaultFutureDate(baseDate);
  const issue = futureRangeIssue(baseDate, targetDate);
  if (issue) return { kind: "unavailable", message: issue };

  const window = scenarioWindow(baseDate, targetDate, request.scenarioPeriod, base.data.mode === "intraday" ? base.data.observationTime : null);
  try {
    const [removedTotals, futureNormals] = await Promise.all([
      removedStationTotals(base.data, window.removesEntireBaseWindow, window.removedStartDate, window.removedEndDate),
      fetchDailyNormalRange(window.futureNormalStartDate, window.futureNormalEndDate),
    ]);
    const calculated = calculateFutureScenario({
      baseStations: base.data.stations,
      baseRegions: base.data.regions,
      baseAdmins: base.data.admins,
      removedTotals,
      futureNormals,
      rainfallByRegion: request.rainfallByRegion,
      assumedRainfallFraction: window.assumedRainfallFraction,
    });
    const data: DashboardData = {
      requestedDate: targetDate,
      effectiveDate: targetDate,
      searchPeriod: `${displayDate(window.targetStartDate)} ~ ${displayDate(targetDate)} · ${scenarioPeriodLabel(request.scenarioPeriod)} 향후 강수 시나리오`,
      period: request.scenarioPeriod,
      regions: calculated.regions,
      admins: calculated.admins,
      stations: calculated.stations,
      fetchedAt: new Date().toISOString(),
      mode: "future",
      observationTime: base.data.observationTime,
      baseMode: base.data.mode === "intraday" ? "intraday" : "official",
      baseEffectiveDate: baseDate,
      scenarioTargetDate: targetDate,
      scenarioRainfall: request.rainfallByRegion,
      scenarioHorizonDays: window.horizonDays,
      scenarioIncludedDays: window.includedFutureDays,
      scenarioHorizonHours: window.horizonHours,
      scenarioIncludedHours: window.includedFutureHours,
      scenarioRainfallFraction: window.assumedRainfallFraction,
    };
    return { kind: "ok", data };
  }
  catch (error) {
    if (error instanceof HTTPError || error instanceof TimeoutError || error instanceof TypeError || error instanceof RangeError || error instanceof z.ZodError) {
      const message = error instanceof Error ? error.message : "향후 강수 시나리오를 산출하지 못했습니다.";
      return { kind: "unavailable", message };
    }
    throw error;
  }
}

async function removedStationTotals(
  base: DashboardData,
  removesEntireBaseWindow: boolean,
  startDate: string | null,
  endDate: string | null,
): Promise<Map<number, RangeStationTotal>> {
  if (removesEntireBaseWindow) {
    return new Map(base.stations.map((station) => [station.code, {
      precipitation: station.precipitation,
      normal: station.normal,
    }]));
  }
  if (!startDate || !endDate || startDate > endDate) return new Map();
  return fetchOfficialRangeTotals(startDate, endDate);
}

function displayDate(value: string): string {
  const [year, month, day] = value.split("-");
  return `${year}년 ${month}월 ${day}일`;
}
