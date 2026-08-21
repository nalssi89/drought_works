import { addDays, addMonths, type Period } from "./precipitation";

export const CUSTOM_PERIOD = "custom" as const;
export type PeriodSelection = Period | typeof CUSTOM_PERIOD;

export type CustomRange = Readonly<{
  startDate: string;
  endDate: string;
}>;

export function defaultCustomStart(endDate: string): string {
  return addDays(addMonths(endDate, -6), 1);
}

export function customRangeIssue(range: CustomRange): string | null {
  const start = Date.parse(`${range.startDate}T00:00:00Z`);
  const end = Date.parse(`${range.endDate}T00:00:00Z`);
  const elapsedDays = Math.round((end - start) / 86_400_000);
  if (elapsedDays < 0) return "임의기간 시작일은 종료일보다 늦을 수 없습니다.";
  if (elapsedDays > 366) return "임의기간은 최대 1년까지 조회할 수 있습니다.";
  return null;
}
