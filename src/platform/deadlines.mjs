/**
 * UFR-039 versioned deadline engine (demonstration). Calendar semantics:
 * dates are America/New_York calendar dates; federal holidays follow the
 * 5 U.S.C. 6103 list with Saturday->Friday / Sunday->Monday observance
 * (Inauguration Day excluded); "business days" skip weekends and observed
 * holidays; calendar-day and month periods that end on a non-business day
 * roll forward to the next business day; a deadline is due at 23:59:59.999
 * Eastern on its due date. Rules are DEMONSTRATION ESTIMATES modeled on
 * common federal patterns. They are not authoritative legal deadlines;
 * federal-policy.mjs keeps authoritative deadline computation disabled.
 */
export const RULESET_VERSION = "ufr-demo-deadlines-2026.11";

export const RULES = Object.freeze({
  "records.response": { label: "Agency response to records request (demo: 20 business days)", unit: "business_days", amount: 20 },
  "records.appeal_window": { label: "Window to appeal a records determination (demo: 90 calendar days)", unit: "calendar_days", amount: 90 },
  "records.appeal_response": { label: "Decision on records appeal (demo: 20 business days)", unit: "business_days", amount: 20 },
  "tort.agency_decision": { label: "Agency final disposition of tort claim before deemed denial (demo: 6 months)", unit: "months", amount: 6 },
  "tort.suit_window": { label: "Window after a tort denial (demo: 6 months)", unit: "months", amount: 6 },
  "claim.decision": { label: "Decision on administrative claim (demo: 60 calendar days)", unit: "calendar_days", amount: 60 },
  "appeal.decision": { label: "Decision on administrative appeal (demo: 90 calendar days)", unit: "calendar_days", amount: 90 },
  "complaint.acknowledge": { label: "Acknowledge complaint or petition (demo: 10 business days)", unit: "business_days", amount: 10 },
  "defect.cure": { label: "Claimant cure period after a defect notice (demo: 30 calendar days)", unit: "calendar_days", amount: 30 },
});

const pad = (n) => String(n).padStart(2, "0");
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const parts = (s) => s.split("-").map(Number);
const utc = (s) => { const [y, m, d] = parts(s); return Date.UTC(y, m - 1, d); };
const fromUtc = (t) => { const d = new Date(t); return ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()); };
const dow = (s) => new Date(utc(s)).getUTCDay();
export const addDays = (s, n) => fromUtc(utc(s) + n * 86_400_000);

function nthWeekday(year, month, weekday, n) {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return ymd(year, month, 1 + ((weekday - first + 7) % 7) + (n - 1) * 7);
}
function lastWeekday(year, month, weekday) {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = new Date(Date.UTC(year, month - 1, lastDay)).getUTCDay();
  return ymd(year, month, lastDay - ((last - weekday + 7) % 7));
}
function observed(s) { const w = dow(s); return w === 6 ? addDays(s, -1) : w === 0 ? addDays(s, 1) : s; }

const holidayCache = new Map();
export function federalHolidays(year) {
  if (!holidayCache.has(year)) {
    const list = [
      observed(ymd(year, 1, 1)), nthWeekday(year, 1, 1, 3), nthWeekday(year, 2, 1, 3), lastWeekday(year, 5, 1),
      ...(year >= 2021 ? [observed(ymd(year, 6, 19))] : []), observed(ymd(year, 7, 4)), nthWeekday(year, 9, 1, 1),
      nthWeekday(year, 10, 1, 2), observed(ymd(year, 11, 11)), nthWeekday(year, 11, 4, 4), observed(ymd(year, 12, 25)),
    ];
    // New Year's Day of the following year can be observed on Dec 31.
    if (dow(ymd(year + 1, 1, 1)) === 6) list.push(ymd(year, 12, 31));
    holidayCache.set(year, new Set(list));
  }
  return holidayCache.get(year);
}
export const isBusinessDay = (s) => ![0, 6].includes(dow(s)) && !federalHolidays(parts(s)[0]).has(s);
export const rollForward = (s) => { let d = s; while (!isBusinessDay(d)) d = addDays(d, 1); return d; };
export function addBusinessDays(s, n) { let d = s; let left = n; while (left > 0) { d = addDays(d, 1); if (isBusinessDay(d)) left--; } return d; }
export function addMonths(s, n) {
  const [y, m, d] = parts(s);
  const total = y * 12 + (m - 1) + n; const ny = Math.floor(total / 12); const nm = (total % 12) + 1;
  const lastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return ymd(ny, nm, Math.min(d, lastDay));
}
export function businessDaysBetween(a, b) { let n = 0; let d = a; while (d < b) { d = addDays(d, 1); if (isBusinessDay(d)) n++; } return n; }

const easternFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
export const easternDate = (instant) => easternFmt.format(new Date(instant));
/** The UTC instant of 23:59:59.999 America/New_York on a calendar date (DST-aware). */
export function endOfEasternDay(s) {
  const [y, m, d] = parts(s);
  for (const offset of [4, 5]) {
    const t = Date.UTC(y, m - 1, d + 1, offset) - 1;
    if (easternDate(t) === s && easternDate(t + 1) !== s) return new Date(t);
  }
  throw new Error("timezone_resolution_failed");
}

/** Computes a deadline. The start date is the Eastern calendar date of the triggering instant; counting starts the next day. */
export function computeDeadline(ruleId, startInstant) {
  const rule = RULES[ruleId];
  if (!rule) throw new Error(`unknown deadline rule ${ruleId}`);
  const start = easternDate(startInstant);
  let due = rule.unit === "business_days" ? addBusinessDays(start, rule.amount)
    : rule.unit === "calendar_days" ? rollForward(addDays(start, rule.amount))
      : rollForward(addMonths(start, rule.amount));
  return { ruleId, ruleVersion: RULESET_VERSION, label: rule.label, startDate: start, dueDate: due, dueAt: endOfEasternDay(due).toISOString() };
}

/** Extends a tolled deadline by the business days spent tolled (e.g. while information was requested). */
export function extendForTolling(dueDate, tolledFromInstant, resumedInstant) {
  const days = businessDaysBetween(easternDate(tolledFromInstant), easternDate(resumedInstant));
  const due = addBusinessDays(dueDate, days);
  return { dueDate: due, dueAt: endOfEasternDay(due).toISOString(), tolledBusinessDays: days };
}
