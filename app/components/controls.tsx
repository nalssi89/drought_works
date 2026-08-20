"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { addDays, addMonths, type Period } from "../lib/precipitation";

const PERIOD_OPTIONS = [
  ["1m", "최근 1개월"], ["3m", "최근 3개월"], ["6m", "최근 6개월"], ["12m", "최근 1년"], ["ty", "올해 누적"],
] as const;

type ControlsProps = Readonly<{
  date: string;
  period: Period;
  intraday: boolean;
  observationTime: string;
  maximumObservationTime: string;
  liveLatest: boolean;
}>;

export function Controls({ date, period, intraday, observationTime, maximumObservationTime, liveLatest }: ControlsProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const moves = [
    ["-1년", addMonths(date, -12)], ["-1월", addMonths(date, -1)], ["-1주", addDays(date, -7)], ["-1일", addDays(date, -1)],
    ["+1일", addDays(date, 1)], ["+1주", addDays(date, 7)], ["+1월", addMonths(date, 1)], ["+1년", addMonths(date, 12)],
  ] as const;

  function navigate(nextDate: string, nextPeriod: Period, nextTime = observationTime) {
    startTransition(() => router.push(query(nextDate, nextPeriod, intraday, intraday ? nextTime : null)));
  }

  return (
    <section className="control-panel" aria-label="조회 조건">
      <div className="date-form">
        <label htmlFor="date">날짜</label>
        <input id="date" name="date" type="date" value={date} onInput={(event) => {
          const nextDate = event.currentTarget.value;
          navigate(nextDate, period, `${nextDate}T${observationTime.slice(11)}`);
        }} />
        {pending ? <span className="update-status" aria-live="polite">자료 갱신 중…</span> : null}
      </div>
      <nav className="date-moves" aria-label="날짜 빠른 이동">
        {moves.slice(0, 4).map(([label, value]) => <Link href={query(value, period, intraday, intraday ? `${value}T${observationTime.slice(11)}` : null)} key={label}>{label}</Link>)}
        <Link className="now-link" href={intraday ? `/?period=${period}&intraday=1` : `/?period=${period}`}>NOW</Link>
        {moves.slice(4).map(([label, value]) => <Link href={query(value, period, intraday, intraday ? `${value}T${observationTime.slice(11)}` : null)} key={label}>{label}</Link>)}
      </nav>
      <nav className="periods" aria-label="누적기간">
        <span>누적기간</span>
        {PERIOD_OPTIONS.map(([value, label]) => (
          <Link className={value === period ? "period-button selected" : "period-button"} href={liveLatest ? `/?period=${value}${intraday ? "&intraday=1" : ""}` : query(date, value, intraday, intraday ? observationTime : null)} key={value} aria-current={value === period ? "page" : undefined}>{label}</Link>
        ))}
      </nav>
      <div className="intraday-controls">
          <label className="check-control">
          <input type="checkbox" checked={intraday} onChange={(event) => {
            const href = event.currentTarget.checked ? `/?period=${period}&intraday=1` : `/?date=${date}&period=${period}`;
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

function query(date: string, period: Period, intraday: boolean, observationTime: string | null): string {
  const params = new URLSearchParams({ date, period });
  if (intraday) params.set("intraday", "1");
  if (observationTime) params.set("time", observationTime);
  return `/?${params.toString()}`;
}
