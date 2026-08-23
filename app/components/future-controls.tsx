"use client";

import { useState } from "react";

import {
  FUTURE_PERIOD,
  rainfallQueryName,
  type FutureBaseMode,
  type RainfallByRegion,
} from "../lib/future-scenario";
import { addDays, addMonths, type Period } from "../lib/precipitation";
import { STATION_REGIONS, type StationRegionKey } from "../lib/station-presentation";

const SCENARIO_PERIODS: readonly Readonly<{ value: Period; label: string }>[] = [
  { value: "1m", label: "최근 1개월" },
  { value: "3m", label: "최근 3개월" },
  { value: "6m", label: "최근 6개월" },
  { value: "12m", label: "최근 1년" },
  { value: "ty", label: "올해 누적" },
];

type FutureControlsProps = Readonly<{
  baseMode: FutureBaseMode;
  baseDate: string;
  observationTime: string;
  maximumObservationTime: string;
  targetDate: string;
  scenarioPeriod: Period;
  rainfallByRegion: RainfallByRegion;
}>;

export function FutureControls({
  baseMode,
  baseDate,
  observationTime,
  maximumObservationTime,
  targetDate,
  scenarioPeriod,
  rainfallByRegion,
}: FutureControlsProps) {
  const [mode, setMode] = useState<FutureBaseMode>(baseMode);
  const [officialDate, setOfficialDate] = useState(baseMode === "intraday" ? addDays(baseDate, -1) : baseDate);
  const [intradayTime, setIntradayTime] = useState(observationTime);
  const [futureDate, setFutureDate] = useState(targetDate);
  const [commonRain, setCommonRain] = useState("100");
  const [rainfall, setRainfall] = useState<Record<StationRegionKey, string>>(() => Object.fromEntries(
    STATION_REGIONS.map((region) => [region.key, String(rainfallByRegion[region.key])]),
  ) as Record<StationRegionKey, string>);

  const selectedBaseCandidate = mode === "intraday" ? intradayTime.slice(0, 10) : officialDate;
  const selectedBaseDate = /^\d{4}-\d{2}-\d{2}$/.test(selectedBaseCandidate) ? selectedBaseCandidate : baseDate;
  const futureMin = addDays(selectedBaseDate, 1);
  const futureMax = addDays(selectedBaseDate, 366);
  const latestDate = addDays(maximumObservationTime.slice(0, 10), -1);
  const quickDates = [
    ["+1주", addDays(selectedBaseDate, 7)],
    ["+1개월", addMonths(selectedBaseDate, 1)],
    ["+3개월", addMonths(selectedBaseDate, 3)],
  ] as const;

  function changeMode(nextMode: FutureBaseMode) {
    setMode(nextMode);
    const nextBaseDate = nextMode === "intraday" ? intradayTime.slice(0, 10) : officialDate;
    if (futureDate <= nextBaseDate) setFutureDate(addDays(nextBaseDate, 30));
  }

  function applyCommonRainfall() {
    const parsed = Math.max(0, Math.min(5_000, Number(commonRain) || 0));
    const value = String(Math.round(parsed * 10) / 10);
    setRainfall(Object.fromEntries(STATION_REGIONS.map((region) => [region.key, value])) as Record<StationRegionKey, string>);
  }

  return (
    <form className="future-control-panel" method="get" aria-label="향후 강수 시나리오 조건">
      <input type="hidden" name="period" value={FUTURE_PERIOD} />
      <nav className="periods future-period-nav" aria-label="누적기간 및 시나리오">
        <span>누적기간</span>
        {SCENARIO_PERIODS.map((option) => <a className="period-button" href={`/?period=${option.value}${mode === "intraday" ? "&intraday=1" : ""}`} key={option.value}>{option.label}</a>)}
        <a className="period-button selected" href={`/?period=${FUTURE_PERIOD}${mode === "intraday" ? "&base=intraday" : ""}`} aria-current="page">향후 강수</a>
      </nav>
      <fieldset className="future-fieldset base-fieldset">
        <legend>1. 기준자료</legend>
        <div className="base-mode-options">
          <label><input type="radio" name="base" value="official" checked={mode === "official"} onChange={() => changeMode("official")} /> 완료 일자료</label>
          <label><input type="radio" name="base" value="intraday" checked={mode === "intraday"} onChange={() => changeMode("intraday")} /> 당일 시간자료</label>
        </div>
        {mode === "official" ? (
          <label className="future-input-label" htmlFor="future-base-date">
            기준일
            <input id="future-base-date" name="date" type="date" max={latestDate} value={officialDate} onChange={(event) => {
              const next = event.currentTarget.value;
              setOfficialDate(next);
              if (futureDate <= next) setFutureDate(addDays(next, 30));
            }} />
          </label>
        ) : (
          <label className="future-input-label" htmlFor="future-base-time">
            기준 관측시각
            <input id="future-base-time" name="time" type="datetime-local" min="1973-01-01T01:00" max={maximumObservationTime} step="3600" value={intradayTime} onChange={(event) => {
              const next = event.currentTarget.value;
              setIntradayTime(next);
              if (futureDate <= next.slice(0, 10)) setFutureDate(addDays(next.slice(0, 10), 30));
            }} />
          </label>
        )}
      </fieldset>

      <fieldset className="future-fieldset target-fieldset">
        <legend>2. 미래 시점과 산출기간</legend>
        <label className="future-input-label" htmlFor="future-target-date">
          미래 시점
          <input id="future-target-date" name="target" type="date" min={futureMin} max={futureMax} value={futureDate} onChange={(event) => setFutureDate(event.currentTarget.value)} required />
        </label>
        <div className="future-date-shortcuts" aria-label="미래 시점 빠른 선택">
          {quickDates.map(([label, date]) => <button type="button" onClick={() => setFutureDate(date)} key={label}>{label}</button>)}
        </div>
        <label className="future-input-label" htmlFor="scenario-period">
          산출기간
          <select id="scenario-period" name="scenarioPeriod" defaultValue={scenarioPeriod}>
            {SCENARIO_PERIODS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
          </select>
        </label>
      </fieldset>

      <fieldset className="future-fieldset rainfall-fieldset">
        <legend>3. 권역별 미래 총강수량</legend>
        <p className="future-help" id="future-rain-help">기준 다음 날부터 미래 시점까지의 총강수량입니다. 당일 기준은 선택 관측시각 이후, 완료 일자료 기준은 다음 날부터 미래 시점 24시까지 시간상 균등 분포하며, 권역 내 모든 대표지점에 같은 값을 적용합니다.</p>
        <div className="common-rain-control">
          <label htmlFor="common-rain">전 권역 일괄값</label>
          <input id="common-rain" type="number" min="0" max="5000" step="0.1" value={commonRain} onChange={(event) => setCommonRain(event.currentTarget.value)} />
          <span>mm</span>
          <button type="button" onClick={applyCommonRainfall}>모두 적용</button>
        </div>
        <div className="region-rain-grid">
          {STATION_REGIONS.map((region) => (
            <label className="region-rain-input" key={region.key}>
              <span>{region.label}<small>{region.codes.length}개 지점</small></span>
              <span className="number-with-unit">
                <input
                  type="number"
                  name={rainfallQueryName(region.key)}
                  min="0"
                  max="5000"
                  step="0.1"
                  value={rainfall[region.key]}
                  aria-describedby="future-rain-help"
                  onChange={(event) => setRainfall((current) => ({ ...current, [region.key]: event.currentTarget.value }))}
                />
                <span>mm</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="future-actions">
        <button className="scenario-submit" type="submit">시나리오 산출</button>
        <a className="scenario-reset" href={`/?period=${FUTURE_PERIOD}`}>초기화</a>
      </div>
    </form>
  );
}
