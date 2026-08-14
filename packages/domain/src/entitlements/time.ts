const earliestCommercialTime = Date.parse("2000-01-01T00:00:00.000Z");
const latestCommercialTime = Date.parse("9999-12-31T23:59:59.999Z");

export function commercialInstant(value: unknown): number {
  const milliseconds = value instanceof Date ? value.getTime() : Number.NaN;
  if (!Number.isFinite(milliseconds)
    || milliseconds < earliestCommercialTime
    || milliseconds > latestCommercialTime) {
    throw new Error("COMMERCIAL_TIME_INVALID");
  }
  return milliseconds;
}

function checkedDate(milliseconds: number): Date {
  const result = new Date(milliseconds);
  commercialInstant(result);
  return result;
}

export function addExactly168Hours(value: Date): Date {
  return checkedDate(commercialInstant(value) + 168 * 60 * 60 * 1_000);
}

export function oneYearAnniversaryUtc(value: Date): Date {
  commercialInstant(value);
  const targetYear = value.getUTCFullYear() + 1;
  const targetMonth = value.getUTCMonth();
  const monthEnd = checkedDate(Date.UTC(targetYear, targetMonth + 1, 0));
  const targetDay = Math.min(value.getUTCDate(), monthEnd.getUTCDate());
  return checkedDate(Date.UTC(
    targetYear,
    targetMonth,
    targetDay,
    value.getUTCHours(),
    value.getUTCMinutes(),
    value.getUTCSeconds(),
    value.getUTCMilliseconds(),
  ));
}
