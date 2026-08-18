import Link from "next/link";
import { addDays, addMonths, type Period } from "../lib/precipitation";

const PERIOD_OPTIONS = [
  ["1m", "최근 1개월"],
  ["3m", "최근 3개월"],
  ["6m", "최근 6개월"],
  ["12m", "최근 1년"],
] as const;

export function Controls({ date, period }: Readonly<{ date: string; period: Period }>) {
  const moves = [
    ["-1년", addMonths(date, -12)],
    ["-1월", addMonths(date, -1)],
    ["-1주", addDays(date, -7)],
    ["-1일", addDays(date, -1)],
    ["+1일", addDays(date, 1)],
    ["+1주", addDays(date, 7)],
    ["+1월", addMonths(date, 1)],
    ["+1년", addMonths(date, 12)],
  ] as const;
  return (
    <section className="control-panel" aria-label="조회 조건">
      <form className="date-form" method="get">
        <label htmlFor="date">날짜</label>
        <input id="date" name="date" type="date" defaultValue={date} />
        <input name="period" type="hidden" value={period} />
        <button type="submit">조회</button>
      </form>
      <nav className="date-moves" aria-label="날짜 빠른 이동">
        {moves.slice(0, 4).map(([label, value]) => <Link href={query(value, period)} key={label}>{label}</Link>)}
        <Link className="now-link" href={`/?period=${period}`}>NOW</Link>
        {moves.slice(4).map(([label, value]) => <Link href={query(value, period)} key={label}>{label}</Link>)}
      </nav>
      <nav className="periods" aria-label="누적기간">
        <span>누적기간</span>
        {PERIOD_OPTIONS.map(([value, label]) => (
          <Link className={value === period ? "period-button selected" : "period-button"} href={query(date, value)} key={value} aria-current={value === period ? "page" : undefined}>{label}</Link>
        ))}
      </nav>
    </section>
  );
}

function query(date: string, period: Period): string {
  return `/?date=${date}&period=${period}`;
}
