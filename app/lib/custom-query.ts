export function customIntradayHref(date: string, startDate: string, observationTime: string): string {
  const params = new URLSearchParams({
    date,
    period: "custom",
    start: startDate,
    intraday: "1",
    time: `${date}T${observationTime.slice(11)}`,
  });
  return `/?${params.toString()}`;
}
