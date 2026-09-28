// Timezone helpers. Everything business-facing (today's date, appointment
// times, weekday checks) is computed in the business's timezone — not UTC
// and not the server's clock. This fixes the "after 7 PM it's already
// tomorrow" bug and the hardcoded -05:00 daylight-saving bug.

const TIMEZONE = process.env.BUSINESS_TIMEZONE || 'America/Chicago';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function pad(n) {
  return String(n).padStart(2, '0');
}

function getZonedParts(date, timeZone = TIMEZONE) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

// Minutes the timezone is ahead of UTC at a given instant (Chicago: -300 or -360).
function offsetMinutes(date, timeZone) {
  const p = getZonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - date.getTime()) / 60000);
}

/** "2026-11-09" + "09:00" in the business timezone -> real Date (handles DST). */
function zonedDateTimeToDate(dateStr, timeStr, timeZone = TIMEZONE) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  const naiveUtc = Date.UTC(y, m - 1, d, hh, mm);
  const firstGuess = naiveUtc - offsetMinutes(new Date(naiveUtc), timeZone) * 60000;
  const corrected = naiveUtc - offsetMinutes(new Date(firstGuess), timeZone) * 60000;
  return new Date(corrected);
}

/** Today's date in the business timezone, "YYYY-MM-DD". */
function todayInTimeZone(timeZone = TIMEZONE) {
  const p = getZonedParts(new Date(), timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

function isWeekday(dateStr) {
  const day = weekdayOf(dateStr);
  return day !== 'Saturday' && day !== 'Sunday';
}

function isValidDateString(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function isValidTimeString(s) {
  return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

/** "2026-09-28" -> "Monday, September 28" */
function formatDateForSpeech(dateStr) {
  const [, m, d] = dateStr.split('-').map(Number);
  return `${weekdayOf(dateStr)}, ${MONTHS[m - 1]} ${d}`;
}

/** "13:00" -> "1 PM", "09:30" -> "9:30 AM" */
function formatTimeForSpeech(timeStr) {
  const [h, mi] = timeStr.split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return mi === 0 ? `${h12} ${suffix}` : `${h12}:${pad(mi)} ${suffix}`;
}

module.exports = {
  TIMEZONE,
  zonedDateTimeToDate,
  todayInTimeZone,
  addDays,
  weekdayOf,
  isWeekday,
  isValidDateString,
  isValidTimeString,
  formatDateForSpeech,
  formatTimeForSpeech,
};