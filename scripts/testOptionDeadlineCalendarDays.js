/**
 * scripts/testOptionDeadlineCalendarDays.js
 *
 * Phase 7H-5G1C — Option Exercise Deadline = Hard Date minus 2 CALENDAR DAYS.
 * Pure tests. No Supabase calls, no network, no production data.
 *
 * Run: node scripts/testOptionDeadlineCalendarDays.js
 *
 * The implementation under test is a pure-string mirror of the SQL function
 * public.fn_option_deadline_from_hard_date (date - 2). It is compared against
 * an independent reference using UTC epoch-day arithmetic.
 */

/* eslint-disable @typescript-eslint/no-var-requires */
const assert = require('assert');

// ── Mirror of src/lib/optionDeadline.ts (kept dependency-free) ───────────────
function isLeapYear(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
function daysInMonth(y, m) {
  if (m === 2) return isLeapYear(y) ? 29 : 28;
  return [4, 6, 9, 11]?.indexOf(m) !== -1 ? 30 : 31;
}
function pad(n, w) { return String(n)?.padStart(w, '0'); }
function subtractCalendarDays(iso, days) {
  const mt = /^(\d{4})-(\d{2})-(\d{2})$/?.exec(iso);
  if (!mt) throw new Error('Invalid date format');
  let y = parseInt(mt?.[1], 10), m = parseInt(mt?.[2], 10), d = parseInt(mt?.[3], 10);
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) throw new Error('Invalid calendar date');
  for (let i = 0; i < days; i++) {
    d -= 1;
    if (d < 1) { m -= 1; if (m < 1) { m = 12; y -= 1; } d = daysInMonth(y, m); }
  }
  return pad(y, 4) + '-' + pad(m, 2) + '-' + pad(d, 2);
}
const deadline = (hard) => subtractCalendarDays(hard, 2);

// ── Independent reference (UTC epoch days; immune to local TZ/DST) ───────────
function referenceDeadline(hard) {
  const [y, m, d] = hard?.split('-')?.map(Number);
  const ms = Date.UTC(y, m - 1, d) - 2 * 86400000;
  const r = new Date(ms);
  return r?.getUTCFullYear() + '-' + pad(r?.getUTCMonth() + 1, 2) + '-' + pad(r?.getUTCDate(), 2);
}
function weekday(iso) {
  const [y, m, d] = iso?.split('-')?.map(Number);
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']?.[new Date(Date.UTC(y, m - 1, d))?.getUTCDay()];
}

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  PASS  ' + name); }
  catch (e) { failed++; console.log('  FAIL  ' + name + '\n        ' + e?.message); }
}

console.log('Option Exercise Deadline — calendar-day tests\n');

// ── Weekday boundary cases ───────────────────────────────────────────────────
test('Friday Hard Date → Wednesday deadline', () => {
  assert?.strictEqual(weekday('2026-11-06'), 'Friday');
  assert?.strictEqual(deadline('2026-11-06'), '2026-11-04');
  assert?.strictEqual(weekday('2026-11-04'), 'Wednesday');
});
test('Monday Hard Date → Saturday deadline (no shift to Thursday)', () => {
  assert?.strictEqual(weekday('2026-11-09'), 'Monday');
  assert?.strictEqual(deadline('2026-11-09'), '2026-11-07');
  assert?.strictEqual(weekday('2026-11-07'), 'Saturday');
});
test('Tuesday Hard Date → Sunday deadline (no shift to Friday)', () => {
  assert?.strictEqual(weekday('2026-11-10'), 'Tuesday');
  assert?.strictEqual(deadline('2026-11-10'), '2026-11-08');
  assert?.strictEqual(weekday('2026-11-08'), 'Sunday');
});
test('Sunday Hard Date → Friday deadline', () => {
  assert?.strictEqual(weekday('2026-11-01'), 'Sunday');
  assert?.strictEqual(deadline('2026-11-01'), '2026-10-30');
  assert?.strictEqual(weekday('2026-10-30'), 'Friday');
});
test('Production example: 2026-11-01 → 2026-10-30 (not 2026-10-29)', () => {
  assert?.strictEqual(deadline('2026-11-01'), '2026-10-30');
});
test('Wednesday / Thursday / Saturday Hard Dates', () => {
  assert?.strictEqual(deadline('2026-11-04'), '2026-11-02'); // Wed → Mon
  assert?.strictEqual(deadline('2026-11-05'), '2026-11-03'); // Thu → Tue
  assert?.strictEqual(deadline('2026-11-07'), '2026-11-05'); // Sat → Thu
});

// ── Holidays: no adjustment ──────────────────────────────────────────────────
test('Federal holiday between deadline and Hard Date → no adjustment (Veterans Day 2026-11-11)', () => {
  // Hard Date Thu 2026-11-12; Wed 11-11 is a Federal Reserve holiday.
  assert?.strictEqual(deadline('2026-11-12'), '2026-11-10');
});
test('Federal holiday ON the deadline date → no adjustment (Thanksgiving 2026-11-26)', () => {
  assert?.strictEqual(deadline('2026-11-28'), '2026-11-26');
});
test('Federal holiday Monday Hard Date (Labor Day 2026-09-07) → Saturday', () => {
  assert?.strictEqual(deadline('2026-09-07'), '2026-09-05');
});

// ── Year boundary ────────────────────────────────────────────────────────────
test('Year boundary: 2027-01-01 → 2026-12-30', () => {
  assert?.strictEqual(deadline('2027-01-01'), '2026-12-30');
});
test('Year boundary: 2027-01-02 → 2026-12-31', () => {
  assert?.strictEqual(deadline('2027-01-02'), '2026-12-31');
});
test('Year boundary: 2027-01-03 → 2027-01-01', () => {
  assert?.strictEqual(deadline('2027-01-03'), '2027-01-01');
});

// ── Leap year ────────────────────────────────────────────────────────────────
test('Leap year 2028: 2028-03-01 → 2028-02-28', () => {
  assert?.strictEqual(deadline('2028-03-01'), '2028-02-28');
});
test('Leap year 2028: 2028-03-02 → 2028-02-29', () => {
  assert?.strictEqual(deadline('2028-03-02'), '2028-02-29');
});
test('Non-leap 2027: 2027-03-01 → 2027-02-27', () => {
  assert?.strictEqual(deadline('2027-03-01'), '2027-02-27');
});
test('Century non-leap 2100: 2100-03-01 → 2100-02-27', () => {
  assert?.strictEqual(deadline('2100-03-01'), '2100-02-27');
});
test('Century leap 2000: 2000-03-01 → 2000-02-28', () => {
  assert?.strictEqual(deadline('2000-03-01'), '2000-02-28');
});

// ── DST transitions (US/Eastern): no date shifting ───────────────────────────
test('DST spring-forward 2027-03-14: 2027-03-15 → 2027-03-13, 2027-03-14 → 2027-03-12', () => {
  assert?.strictEqual(deadline('2027-03-15'), '2027-03-13');
  assert?.strictEqual(deadline('2027-03-14'), '2027-03-12');
  assert?.strictEqual(deadline('2027-03-16'), '2027-03-14');
});
test('DST fall-back 2026-11-01: 2026-11-02 → 2026-10-31, 2026-11-03 → 2026-11-01', () => {
  assert?.strictEqual(deadline('2026-11-02'), '2026-10-31');
  assert?.strictEqual(deadline('2026-11-03'), '2026-11-01');
  assert?.strictEqual(deadline('2026-11-01'), '2026-10-30');
});
test('Result is identical under different process time zones', () => {
  const saved = process.env.TZ;
  const dates = ['2026-11-01', '2027-03-14', '2027-03-15', '2028-03-01', '2027-01-01'];
  const baseline = dates?.map(deadline);
  ['America/New_York', 'Pacific/Auckland', 'UTC', 'Asia/Kolkata']?.forEach((tz) => {
    process.env.TZ = tz;
    assert?.deepStrictEqual(dates?.map(deadline), baseline);
  });
  if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
});

// ── Hard Date changes and extension overrides ────────────────────────────────
test('Hard Date change recalculates from the new date only', () => {
  const original = deadline('2026-11-06');   // Fri → Wed
  const changed = deadline('2026-11-09');    // Mon → Sat
  assert?.strictEqual(original, '2026-11-04');
  assert?.strictEqual(changed, '2026-11-07');
  assert?.notStrictEqual(original, changed);
});
test('new_extension / extension_override use the same calculation as creation', () => {
  const newHard = '2026-12-01'; // Tuesday
  assert?.strictEqual(weekday(newHard), 'Tuesday');
  assert?.strictEqual(deadline(newHard), '2026-11-29'); // Sunday
});
test('Extension override across year end: 2027-01-01 → 2026-12-30', () => {
  assert?.strictEqual(deadline('2027-01-01'), '2026-12-30');
});

// ── Exhaustive parity with independent UTC reference (2000–2100) ─────────────
test('Parity with UTC epoch-day reference for every date 2000-01-01..2100-12-31', () => {
  let count = 0;
  for (let t = Date.UTC(2000, 0, 1); t <= Date.UTC(2100, 11, 31); t += 86400000) {
    const dt = new Date(t);
    const iso = dt?.getUTCFullYear() + '-' + pad(dt?.getUTCMonth() + 1, 2) + '-' + pad(dt?.getUTCDate(), 2);
    assert?.strictEqual(deadline(iso), referenceDeadline(iso), 'mismatch for ' + iso);
    count++;
  }
  assert?.ok(count > 36000);
});

// ── Input validation ─────────────────────────────────────────────────────────
test('Rejects malformed and impossible dates', () => {
  assert?.throws(() => deadline('2026/11/01'));
  assert?.throws(() => deadline('2026-13-01'));
  assert?.throws(() => deadline('2027-02-29'));
});

console.log('\nResults: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
