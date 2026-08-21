"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { CUSTOM_PERIOD, defaultCustomStart, type PeriodSelection } from "../lib/custom-period";
import { customIntradayHref } from "../lib/custom-query";
import { addDays, addMonths } from "../lib/precipitation";

const PERIOD_OPTIONS = [
  ["1m", "최근 1개월"], ["3m", "최근 3개월"], ["6m", "최근 6개월"], ["12m", "최근 1년"], ["ty", "올해 누적"], [CUSTOM_PERIOD, "임의기간"],
] as const;

type ControlsProps = Readonly<{
  date: string;
  startDate: string | null;
  period: PeriodSelection;
  intraday: boolean;
  observationTime: string;
  maximumObservationTime: string;
  liveLatest: boolean;
}>;

export function Controls({ date, startDate, period, intraday, observationTime, maximumObservationTime, liveLatest }: ControlsProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const moves = [
    ["-1년", addMonths(date, -12)], ["-1월", addMonths(date, -1)], ["-1주", addDays(date, -7)], ["-1일", addDays(date, -1)],
    ["+1일", addDays(date, 1)], ["+1주", addDays(date, 7)], ["+1월", addMonths(date, 1)], ["+1년", addMonths(date, 12)],
  ] as const;

  function navigate(nextDate: string, nextPeriod: PeriodSelection, nextTime = observationTime, nextStartDate = startDate) {
    startTransition(() => router.push(query(nextDate, nextPeriod, intraday, intraday ? nextTime : null, nextStartDate)));
  }

  const selectedStartDate = startDate ?? defaultCustomStart(date);
  const nowHref = period === CUSTOM_PERIOD
    ? intraday ? `/?period=${CUSTOM_PERIOD}&start=${selectedStartDate}&intraday=1` : query(date, period, false, null, selectedStartDate)
    : intraday ? `/?period=${period}&intraday=1` : `/?period=${period}`;

  return (
    <section className="control-panel" aria-label="조회 조건">
      <div className={period === CUSTOM_PERIOD ? "date-form custom-date-form" : "date-form"}>
        {period === CUSTOM_PERIOD ? <><span className="date-range-title">임의기간</span><label htmlFor="start-date">시작일</label><input id="start-date" name="start" type="date" min={addDays(date, -366)} max={date} value={selectedStartDate} onInput={(event) => {
          const nextStartDate = event.currentTarget.value;
          if (nextStartDate) navigate(date, period, observationTime, nextStartDate);
        }} /><span className="date-range-separator" aria-hidden="true">~</span><label htmlFor="date">종료일</label></> : <label htmlFor="date">날짜</label>}
        <input id="date" name="date" type="date" value={date} onInput={(event) => {
          const nextDate = event.currentTarget.value;
          navigate(nextDate, period, `${nextDate}T${observationTime.slice(11)}`, startDate);
        }} />
        {pending ? <span className="update-status" aria-live="polite">자료 갱신 중…</span> : null}
      </div>
      <nav className="date-moves" aria-label="날짜 빠른 이동">
        {moves.slice(0, 4).map(([label, value]) => <Link href={query(value, period, intraday, intraday ? `${value}T${observationTime.slice(11)}` : null, startDate)} key={label}>{label}</Link>)}
        <Link className="now-link" href={nowHref}>NOW</Link>
        {moves.slice(4).map(([label, value]) => <Link href={query(value, period, intraday, intraday ? `${value}T${observationTime.slice(11)}` : null, startDate)} key={label}>{label}</Link>)}
      </nav>
      <nav className="periods" aria-label="누적기간">
        <span>누적기간</span>
        {PERIOD_OPTIONS.map(([value, label]) => (
          <Link className={value === period ? "period-button selected" : "period-button"} href={value !== CUSTOM_PERIOD && liveLatest ? `/?period=${value}${intraday ? "&intraday=1" : ""}` : query(date, value, intraday, intraday ? observationTime : null, value === CUSTOM_PERIOD ? selectedStartDate : null)} key={value} aria-current={value === period ? "page" : undefined}>{label}</Link>
        ))}
      </nav>
      <div className="intraday-controls">
          <label className="check-control">
          <input type="checkbox" checked={intraday} onChange={(event) => {
            const href = event.currentTarget.checked
              ? period === CUSTOM_PERIOD
                ? customIntradayHref(date, selectedStartDate, observationTime)
                : `/?period=${period}&intraday=1`
              : query(date, period, false, null, startDate);
            startTransition(() => router.push(href));
          }} />
          당일 시간강수 반영(추정)
        </label>
        {intraday ? (
          <label className="time-control" htmlFor="observation-time">
            관측시각
            <input id="observation-time" type="datetime-local" min="1973-01-01T01:00" max={maximumObservationTime} step="3600" value={observationTime} onInput={(event) => {
              const nextTime = event.currentTarget.value;
              if (nextTime) navigate(nextTime.slice(0, 10), period, nextTime);
            }} />
          </label>
        ) : null}
      </div>
    </section>
  );
}

function query(date: string, period: PeriodSelection, intraday: boolean, observationTime: string | null, startDate: string | null): string {
  const params = new URLSearchParams({ date, period });
  if (period === CUSTOM_PERIOD && startDate) params.set("start", startDate);
  if (intraday) params.set("intraday", "1");
  if (observationTime) params.set("time", observationTime);
  return `/?${params.toString()}`;
}
