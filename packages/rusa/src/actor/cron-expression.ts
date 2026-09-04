/** Inclusive min/max for each of the 5 standard cron fields, in order. */
const CRON_FIELD_BOUNDS: readonly [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
];

/**
 * A standard 5-field cron expression with numeric/`* / , -` fields only.
 * Each field's range and step semantics are checked before it reaches the
 * host crontab.
 */
export function isValidCronExpr(expr: string): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  if (!fields.every((field) => /^[0-9*/,-]+$/.test(field))) return false;
  try {
    fields.forEach((field, index) => {
      parseCronField(field, CRON_FIELD_BOUNDS[index][0], CRON_FIELD_BOUNDS[index][1]);
    });
    return true;
  } catch {
    return false;
  }
}

/** A syntactically valid cron expression whose calendar constraints never match. */
export class NonFiringCronExprError extends Error {
  constructor(expr: string) {
    super(`cron expression can never fire: ${expr}`);
    this.name = "NonFiringCronExprError";
  }
}

/**
 * Whether a structurally valid cron expression has at least one UTC firing.
 * Gregorian dates, including weekday alignment, repeat every 400 years.
 */
export function cronExprEverFires(expr: string): boolean {
  if (!isValidCronExpr(expr)) return false;
  const [, , domField, monthField, dowField] = expr.trim().split(/\s+/);
  const doms = parseCronField(domField, 1, 31);
  const months = parseCronField(monthField, 1, 12);
  const dows = parseCronField(dowField, 0, 6);
  const domRestricted = domField !== "*";
  const dowRestricted = dowField !== "*";

  for (let year = 2000; year < 2400; year++) {
    for (let month = 0; month < 12; month++) {
      if (!months.has(month + 1)) continue;
      const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
      for (let day = 1; day <= days; day++) {
        const date = new Date(Date.UTC(year, month, day));
        const dayMatches =
          domRestricted && dowRestricted
            ? doms.has(day) || dows.has(date.getUTCDay())
            : domRestricted
              ? doms.has(day)
              : dowRestricted
                ? dows.has(date.getUTCDay())
                : true;
        if (dayMatches) return true;
      }
    }
  }
  return false;
}

/** Reject syntactic, range, and calendar-impossible expressions before persistence. */
export function assertCronExprCanFire(expr: string): void {
  if (!isValidCronExpr(expr)) throw new Error(`invalid cron expression: ${expr}`);
  if (!cronExprEverFires(expr)) throw new NonFiringCronExprError(expr);
}

/** One cron field's matching values, expanded from a supported cron field. */
function parseCronField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const stepMatch = part.match(/^([^/]+)\/(\d+)$/);
    const range = stepMatch ? stepMatch[1] : part;
    const step = stepMatch ? Number(stepMatch[2]) : 1;
    let lo = min;
    let hi = max;
    if (range !== "*") {
      const rangeMatch = range.match(/^(\d+)-(\d+)$/);
      if (rangeMatch) {
        lo = Number(rangeMatch[1]);
        hi = Number(rangeMatch[2]);
      } else if (/^\d+$/.test(range)) {
        lo = hi = Number(range);
      } else {
        throw new Error(`unsupported cron field segment: "${part}"`);
      }
    }
    if (step <= 0 || lo > hi || lo < min || hi > max) {
      throw new Error(`unsupported cron field segment: "${part}"`);
    }
    for (let value = lo; value <= hi; value += step) values.add(value);
  }
  return values;
}

const GREGORIAN_CYCLE_YEARS = 400;

/**
 * The next UTC moment a validated 5-field cron expression fires strictly
 * after `after`. A complete Gregorian cycle bounds the search.
 */
export function nextCronOccurrence(cronExpr: string, after: Date): Date {
  assertCronExprCanFire(cronExpr);
  const [minuteField, hourField, domField, monthField, dowField] = cronExpr.trim().split(/\s+/);
  const minutes = parseCronField(minuteField, 0, 59);
  const hours = parseCronField(hourField, 0, 23);
  const doms = parseCronField(domField, 1, 31);
  const months = parseCronField(monthField, 1, 12);
  const dows = parseCronField(dowField, 0, 6);
  const domRestricted = domField !== "*";
  const dowRestricted = dowField !== "*";

  const candidate = new Date(
    Date.UTC(after.getUTCFullYear(), after.getUTCMonth(), after.getUTCDate())
  );
  const endYear = candidate.getUTCFullYear() + GREGORIAN_CYCLE_YEARS;
  while (candidate.getUTCFullYear() < endYear) {
    const dayMatches =
      domRestricted && dowRestricted
        ? doms.has(candidate.getUTCDate()) || dows.has(candidate.getUTCDay())
        : domRestricted
          ? doms.has(candidate.getUTCDate())
          : dowRestricted
            ? dows.has(candidate.getUTCDay())
            : true;
    if (months.has(candidate.getUTCMonth() + 1) && dayMatches) {
      for (const hour of [...hours].sort((a, b) => a - b)) {
        for (const minute of [...minutes].sort((a, b) => a - b)) {
          const occurrence = new Date(
            Date.UTC(
              candidate.getUTCFullYear(),
              candidate.getUTCMonth(),
              candidate.getUTCDate(),
              hour,
              minute
            )
          );
          if (occurrence.getTime() > after.getTime()) return occurrence;
        }
      }
    }
    candidate.setUTCDate(candidate.getUTCDate() + 1);
  }
  throw new NonFiringCronExprError(cronExpr);
}
