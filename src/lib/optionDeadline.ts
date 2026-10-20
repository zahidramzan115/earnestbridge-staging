// Option Exercise Deadline policy (Phase 7H-5G1C):
//   Deadline = Deposit Goes Hard Date minus exactly 2 CALENDAR DAYS.
//   Cutoff   = 5:00 PM America/New_York on the deadline date.
// Weekends and holidays count as calendar days — no business-day shifting.
//
// The authoritative calculation used by the API routes is the database
// function public.fn_option_deadline_from_hard_date(date). This module is a
// pure-string (no JS Date / timezone) mirror used for tests and parity checks.

export const OPTION_DEADLINE_CALENDAR_DAYS = 2;
export const OPTION_DEADLINE_RPC = 'fn_option_deadline_from_hard_date';

function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y: number, m: number): number {
  if (m === 2) return isLeapYear(y) ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

function pad(n: number, w: number): string {
  return String(n).padStart(w, '0');
}

/**
 * Subtract calendar days from a YYYY-MM-DD string using pure integer
 * arithmetic. No Date object, so no timezone or DST date-shifting.
 */
export function subtractCalendarDays(isoDate: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) throw new Error('Invalid date format. Expected YYYY-MM-DD.');
  let y = parseInt(match[1], 10);
  let m = parseInt(match[2], 10);
  let d = parseInt(match[3], 10);
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) {
    throw new Error('Invalid calendar date.');
  }
  for (let i = 0; i < days; i++) {
    d -= 1;
    if (d < 1) {
      m -= 1;
      if (m < 1) {
        m = 12;
        y -= 1;
      }
      d = daysInMonth(y, m);
    }
  }
  return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;
}

export function optionDeadlineFromHardDate(hardDate: string): string {
  return subtractCalendarDays(hardDate, OPTION_DEADLINE_CALENDAR_DAYS);
}
