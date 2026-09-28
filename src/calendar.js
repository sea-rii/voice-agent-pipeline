const { google } = require('googleapis');
const { TIMEZONE, zonedDateTimeToDate, addDays, isWeekday } = require('./time');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const REDIRECT_URI = 'http://localhost:3001/oauth2callback'; // must match get-google-token.js

const SLOT_START_TIMES = (process.env.SLOT_START_TIMES || '08:00,09:00,10:00,11:00,13:00,14:00,15:00,16:00')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const SLOT_DURATION_MINUTES = Number(process.env.SLOT_DURATION_MINUTES || 60);
const MIN_LEAD_MINUTES = Number(process.env.MIN_LEAD_MINUTES || 60);

let calendarClient = null;

function getCalendarClient() {
  if (!calendarClient) {
    const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
    oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
    calendarClient = google.calendar({ version: 'v3', auth: oauth2Client });
  }
  return calendarClient;
}

/**
 * booking = { name, phone, issue, address, addressVerified, date: "YYYY-MM-DD",
 *             time: "HH:MM" (24h, business timezone), durationMinutes? }
 */
function buildEvent(booking) {
  const start = zonedDateTimeToDate(booking.date, booking.time);
  const end = new Date(start.getTime() + (booking.durationMinutes || SLOT_DURATION_MINUTES) * 60000);
  const addressNote = booking.addressVerified ? '' : ' (not verified — confirm with customer on arrival)';

  return {
    summary: `HVAC Service — ${booking.name}`,
    location: booking.address,
    description: [
      `Customer: ${booking.name}`,
      `Phone: ${booking.phone}`,
      `Issue: ${booking.issue}`,
      `Address: ${booking.address}${addressNote}`,
      '',
      'Booked automatically by the Arklane voice agent.',
    ].join('\n'),
    start: { dateTime: start.toISOString(), timeZone: TIMEZONE },
    end: { dateTime: end.toISOString(), timeZone: TIMEZONE },
  };
}

/** Creates the event. Returns { eventLink, eventId }. */
async function createBookingEvent(booking) {
  const response = await getCalendarClient().events.insert({
    calendarId: 'primary',
    requestBody: buildEvent(booking),
  });
  return { eventLink: response.data.htmlLink, eventId: response.data.id };
}

/** Updates an existing event in place (caller corrected something after booking). */
async function updateBookingEvent(eventId, booking) {
  const response = await getCalendarClient().events.patch({
    calendarId: 'primary',
    eventId,
    requestBody: buildEvent(booking),
  });
  return { eventLink: response.data.htmlLink, eventId: response.data.id };
}

/**
 * Timed events that block time between timeMin and timeMax.
 * All-day events (birthdays, holidays) and events marked "Free" are ignored.
 */
async function listBlockingEvents(timeMin, timeMax) {
  const response = await getCalendarClient().events.list({
    calendarId: 'primary',
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 250,
  });

  return (response.data.items || [])
    .filter((e) => e.status !== 'cancelled' && e.transparency !== 'transparent' && e.start?.dateTime && e.end?.dateTime)
    .map((e) => ({ id: e.id, start: new Date(e.start.dateTime), end: new Date(e.end.dateTime) }));
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

/** Open slot start times ("HH:MM") for a date, e.g. ["09:00", "13:00"]. */
async function getAvailableSlots(dateStr, { excludeEventId } = {}) {
  if (!isWeekday(dateStr)) return [];

  const dayStart = zonedDateTimeToDate(dateStr, '00:00');
  const dayEnd = zonedDateTimeToDate(addDays(dateStr, 1), '00:00');
  const events = (await listBlockingEvents(dayStart, dayEnd)).filter((e) => e.id !== excludeEventId);
  const earliest = Date.now() + MIN_LEAD_MINUTES * 60000;

  return SLOT_START_TIMES.filter((time) => {
    const start = zonedDateTimeToDate(dateStr, time);
    const end = new Date(start.getTime() + SLOT_DURATION_MINUTES * 60000);
    if (start.getTime() < earliest) return false;
    return !events.some((e) => overlaps(start, end, e.start, e.end));
  });
}

/** Re-checks one slot right before booking, so two callers can't grab the same time. */
async function isSlotFree(dateStr, timeStr, excludeEventId) {
  const start = zonedDateTimeToDate(dateStr, timeStr);
  const end = new Date(start.getTime() + SLOT_DURATION_MINUTES * 60000);
  const events = await listBlockingEvents(start, end);
  return !events.some((e) => e.id !== excludeEventId && overlaps(start, end, e.start, e.end));
}

/** Startup self-test: throws if the Google credentials can't read the calendar. */
async function checkCalendarAccess() {
  const now = new Date();
  await listBlockingEvents(now, new Date(now.getTime() + 60 * 60000));
}

module.exports = {
  createBookingEvent,
  updateBookingEvent,
  getAvailableSlots,
  isSlotFree,
  checkCalendarAccess,
  SLOT_DURATION_MINUTES,
};