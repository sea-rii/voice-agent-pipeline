require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const twilio = require('twilio');
const {
  createBookingEvent,
  updateBookingEvent,
  getAvailableSlots,
  isSlotFree,
  checkCalendarAccess,
} = require('./calendar');
const { saveCallLog, isValidCallSid } = require('./callLog');
const { verifyAddress } = require('./maps');
const {
  TIMEZONE,
  todayInTimeZone,
  addDays,
  weekdayOf,
  isWeekday,
  isValidDateString,
  isValidTimeString,
  formatDateForSpeech,
  formatTimeForSpeech,
  zonedDateTimeToDate,
} = require('./time');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const PUBLIC_HOST = process.env.PUBLIC_HOST;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const DEEPGRAM_KEYTERMS = (process.env.DEEPGRAM_KEYTERMS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

if (!PUBLIC_HOST) console.warn('[WARN] PUBLIC_HOST is not set in .env.');
if (!DEEPGRAM_API_KEY) console.warn('[WARN] DEEPGRAM_API_KEY is not set in .env.');
if (!OPENAI_API_KEY) console.warn('[WARN] OPENAI_API_KEY is not set in .env.');
if (!ELEVENLABS_API_KEY) console.warn('[WARN] ELEVENLABS_API_KEY is not set in .env — voice replies will fail.');
if (!TWILIO_AUTH_TOKEN) console.warn('[WARN] TWILIO_AUTH_TOKEN is not set — ALL Twilio webhooks will be rejected.');
if (!TWILIO_ACCOUNT_SID) console.warn('[WARN] TWILIO_ACCOUNT_SID is not set — calls will end by closing the stream instead of the Twilio API.');

const twilioClient =
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) : null;

const BUSINESS_NAME = 'Comfort Air HVAC';
const GREETING = `Hi, thanks for calling ${BUSINESS_NAME}. Just so you know, this call may be recorded. What's going on?`;
const CLOSING_LINE = `You're all set — thanks for calling ${BUSINESS_NAME}, have a great day!`;
const BARGE_IN_MIN_WORDS = 2;

// How long to wait after the caller's last finalized words before replying.
// Any new words (even partial ones) cancel the wait, so these only apply to
// real silence.
const SETTLE_MS_NORMAL = 1100;
const SETTLE_MS_UNFINISHED = 2500; // sentence sounds cut off mid-thought
const SETTLE_MS_ADDRESS_OR_PHONE = 2800; // callers pause a lot while giving these

// ---------------------------------------------------------------------------
// Security: only accept webhooks that Twilio actually signed.
// ---------------------------------------------------------------------------
function requireTwilioSignature(req, res, next) {
  if (!TWILIO_AUTH_TOKEN || !PUBLIC_HOST) {
    console.error('[SECURITY] Rejecting webhook: TWILIO_AUTH_TOKEN or PUBLIC_HOST missing, cannot verify it.');
    return res.sendStatus(403);
  }
  const signature = req.header('X-Twilio-Signature') || '';
  const url = `https://${PUBLIC_HOST}${req.originalUrl}`;
  if (!twilio.validateRequest(TWILIO_AUTH_TOKEN, signature, url, req.body || {})) {
    console.warn(`[SECURITY] Invalid Twilio signature on ${req.originalUrl} — rejected.`);
    return res.sendStatus(403);
  }
  next();
}

// One-time tokens so only media streams started by OUR /incoming-call are accepted.
const streamTokens = new Map(); // token -> expiresAt

function issueStreamToken() {
  const now = Date.now();
  for (const [t, exp] of streamTokens) if (exp < now) streamTokens.delete(t);
  const token = crypto.randomBytes(16).toString('hex');
  streamTokens.set(token, now + 60_000);
  return token;
}

function consumeStreamToken(token) {
  if (!token) return false;
  const exp = streamTokens.get(token);
  streamTokens.delete(token);
  return !!exp && exp > Date.now();
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------
function buildSystemPrompt(state) {
  const today = todayInTimeZone();
  const upcoming = [];
  for (let i = 0; i < 14; i++) {
    const d = addDays(today, i);
    const label = i === 0 ? ' (today)' : i === 1 ? ' (tomorrow)' : '';
    upcoming.push(`- ${formatDateForSpeech(d)} = ${d}${label}`);
  }

  const bookingStatus = state.booking
    ? `BOOKED for ${formatDateForSpeech(state.booking.date)} at ${formatTimeForSpeech(state.booking.time)}, ${state.booking.address}. If the caller changes anything, give a new full recap, wait for a clear yes, then call book_appointment again — it updates this same appointment.`
    : 'NOT BOOKED YET. book_appointment has not succeeded on this call.';

  const schedulingNote = state.schedulingUnavailable
    ? '\nSCHEDULING SYSTEM IS DOWN: do not call check_availability or book_appointment again. Ask what day and time they would prefer, tell them a team member will call them back today to confirm, then say a short goodbye and call end_call.\n'
    : '';

  return `You are the phone intake assistant for ${BUSINESS_NAME}, a home heating and cooling company. A technician is dispatched to the customer's home for all repairs and installs — customers do not come to us.

Today is ${formatDateForSpeech(today)}, ${today.slice(0, 4)}. All times are local ${TIMEZONE} time. Technicians work Monday through Friday only, no weekend appointments.

Dates for the next two weeks. Use this list to turn "Monday", "tomorrow", "next Thursday" into an exact date — never calculate dates yourself:
${upcoming.join('\n')}

Appointment status: ${bookingStatus}
${schedulingNote}
Collect these, ONE at a time, naturally. Callers often give things out of order — accept information whenever they give it and never re-ask something they already told you.
1. What's going on with their system (heating, cooling, strange noise, routine maintenance, etc). The greeting already asks this, so they usually answer it first. Judge urgency yourself (no heat/AC in extreme weather, gas smell, water leak = urgent) — do NOT ask a separate "is this an emergency" question unless it's genuinely unclear.
2. Their first and last name. Then read it back as its own question: "I have that as Siri Chitney — is that right?" If they correct it, use the correction and read it back once more. If it's still wrong after that, go with your best understanding and move on. Don't ask them to spell it, but if they spell it on their own, use their spelling.
3. A phone number to confirm the appointment ("What's the best number to reach you at?").
4. Their address. Just ask "What's the address?" As soon as you have a full street address, call verify_address with it (include apartment/unit, city and state if they said them).
   - If it returns status "found": read back its spokenAddress and ask if that's right, e.g. "I found 2770 Pontiac Lane in Aurora, Illinois — is that right?" Use the spokenAddress wording, not what you originally heard.
   - If it returns "not_found": ask them to say the full address once more as a sentence, including the city.
   - If it returns "unavailable" or an error: read back what you heard and ask "is that right?"
5. Ask what day works for them. Call check_availability for that exact date, then offer TWO specific open times from the result, like "We have 9 AM or 1 PM open on Monday, which works better?" Never offer or accept a time that check_availability didn't return. If they ask for a Saturday or Sunday, tell them technicians aren't available on weekends and offer the nearest weekday instead (Friday for Saturday, Monday for Sunday).
6. Read back a full recap — name, address, day, AND the specific time — and ask "Does that all sound right?"
7. Only after they clearly say yes to that recap, call book_appointment. When it returns ok: true, say exactly: "${CLOSING_LINE}" and call end_call.

Rules:
- Keep every response to 1-2 short sentences. This is a phone call, not a chat window.
- Only ask ONE question per turn.
- When you ask a yes/no confirmation question, only a clear yes counts as confirmation. If their reply is unclear or sounds like more information (for example the rest of an address), use that information and ask the confirmation question again.
- Don't open every reply with "Thank you" — a short "Got it" or "Okay" is fine, or just ask the next question. Never thank the caller for something they haven't said.
- If the caller just says hello, greet them back briefly and ask what's going on with their system.
- Never quote a specific dollar price. Say "our technician will give you an exact quote on site."
- If it sounds like a gas leak or a real emergency, tell them to hang up and call 911 or their gas company immediately, do not continue the booking, say a short goodbye and call end_call.
- Be warm and efficient, like a good human receptionist, not overly chatty.
- Never ask the caller to spell anything letter by letter — phone audio makes individual letters very hard to hear.
- Never ask for the same piece of information more than twice in a row. After a second attempt, go with your best understanding, mention the technician will confirm it on arrival, and move on.
- NEVER say the appointment is booked, confirmed, or scheduled ("I've booked you," "you're all set," "we'll see you then") unless the appointment status above says BOOKED. Before that, use tentative language only: "We could do Monday at 9 AM" or "I have you down for Monday at 9 AM, pending your confirmation."
- If book_appointment returns an error, do not say it's booked. Briefly explain and fix it (offer another time, or re-confirm the details).
- If the caller corrects anything after your recap, give a new full recap and wait for another clear yes before calling book_appointment.
- If the caller wants to end the call, say a short goodbye and call end_call.
- The caller was already told the call may be recorded; don't repeat that unless they ask.`;
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'verify_address',
      description:
        'Look up the address the caller gave and return the best-matching real street address. Call this every time the caller gives or corrects a full street address.',
      parameters: {
        type: 'object',
        properties: {
          address: {
            type: 'string',
            description: 'The address as you understood it, including apartment/unit, city and state if mentioned.',
          },
        },
        required: ['address'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_availability',
      description: 'Get the open appointment start times for one date. Always call this before offering any times.',
      parameters: {
        type: 'object',
        properties: {
          date: {
            type: 'string',
            description: 'YYYY-MM-DD, taken from the dates list in your instructions.',
          },
        },
        required: ['date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'book_appointment',
      description:
        'Create the appointment on the calendar (or update it if it was already booked on this call). ONLY call this immediately after the caller clearly said yes to your full recap.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          phone: { type: 'string' },
          issue: { type: 'string', description: 'Short description of the problem, note if urgent.' },
          address: {
            type: 'string',
            description: 'Use the spokenAddress from verify_address if it found one.',
          },
          date: { type: 'string', description: 'YYYY-MM-DD' },
          time: {
            type: 'string',
            description: '24-hour HH:MM exactly as returned by check_availability, e.g. "09:00" or "13:00".',
          },
        },
        required: ['name', 'phone', 'issue', 'address', 'date', 'time'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'end_call',
      description: 'Hang up after your next spoken line. Call this when it is time to say your final goodbye.',
      parameters: {
        type: 'object',
        properties: { reason: { type: 'string' } },
        required: [],
      },
    },
  },
];

// Server-side safety nets, independent of what the model decides.
const AFFIRMATIVE = /\b(yes|yeah|yep|yup|correct|right|sounds good|that works|perfect|sure|absolutely|exactly)\b/i;
const NEGATIVE = /\b(no|nope|not|wrong|wait|actually|but|change|hold on)\b/i;
const PREMATURE_BOOKING_CLAIM =
  /\b(i['’]?ve booked|i booked|you['’]?re booked|you['’]?re all set|all set|(is|are) (now )?(booked|confirmed|scheduled)|we['’]?ll see you)\b/i;

function countWords(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function normalizeAddress(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Does this sound like the caller stopped mid-sentence?
function looksUnfinished(text) {
  const t = text.trim();
  if (!t) return true;
  if (/[,\-–—]$/.test(t)) return true;
  if (!/[.?!]$/.test(t)) return true; // Deepgram smart_format punctuates finished sentences
  if (/\b(the|a|an|and|or|but|with|my|our|is|it's|its|um|uh|so|because|to|of|in|on|at|for|like|from)[.?!]?$/i.test(t)) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// HTTP routes
// ---------------------------------------------------------------------------
app.post('/incoming-call', requireTwilioSignature, (req, res) => {
  console.log(`[CALL] Incoming call from ${req.body.From} -> ${req.body.To}`);

  const twiml = new twilio.twiml.VoiceResponse();

  twiml.start().recording({
    recordingStatusCallback: `https://${PUBLIC_HOST}/recording-status`,
    recordingStatusCallbackEvent: ['completed'],
  });

  const connect = twiml.connect();
  const stream = connect.stream({ url: `wss://${PUBLIC_HOST}/media-stream` });
  stream.parameter({ name: 'callerNumber', value: req.body.From || '' });
  stream.parameter({ name: 'calledNumber', value: req.body.To || '' });
  stream.parameter({ name: 'streamToken', value: issueStreamToken() });

  twiml.hangup();

  res.type('text/xml');
  res.send(twiml.toString());
});

app.get('/', (req, res) => res.send('Arklane voice agent server is running.'));

app.post('/recording-status', requireTwilioSignature, (req, res) => {
  const { CallSid, RecordingUrl, RecordingSid, RecordingDuration } = req.body;

  if (!isValidCallSid(CallSid)) {
    console.warn('[RECORDING] Ignoring callback with invalid CallSid:', CallSid);
    return res.sendStatus(400);
  }

  console.log(`[RECORDING] ready for call ${CallSid}: ${RecordingUrl}.mp3 (${RecordingDuration}s)`);

  saveCallLog(CallSid, {
    recordingUrl: `${RecordingUrl}.mp3`,
    recordingSid: RecordingSid,
    recordingDurationSeconds: RecordingDuration,
  });

  res.sendStatus(200);
});

const server = http.createServer(app);

// ---------------------------------------------------------------------------
// External services
// ---------------------------------------------------------------------------
function openDeepgramConnection(onTranscript) {
  let dgUrl =
    'wss://api.deepgram.com/v1/listen' +
    '?model=nova-3' +
    '&encoding=mulaw' +
    '&sample_rate=8000' +
    '&channels=1' +
    '&punctuate=true' +
    '&smart_format=true' +
    '&interim_results=true' +
    '&endpointing=500';

  for (const term of DEEPGRAM_KEYTERMS) {
    dgUrl += `&keyterm=${encodeURIComponent(term)}`;
  }

  const dgSocket = new WebSocket(dgUrl, {
    headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` },
  });

  dgSocket.on('open', () => console.log('[DEEPGRAM] connection opened'));

  dgSocket.on('message', (data) => {
    let parsed;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      return;
    }
    const transcript = parsed?.channel?.alternatives?.[0]?.transcript;
    if (!transcript || !transcript.trim()) return;
    onTranscript(transcript, !!parsed.is_final);
  });

  dgSocket.on('error', (err) => console.error('[DEEPGRAM] error:', err.message));
  dgSocket.on('close', () => console.log('[DEEPGRAM] connection closed'));

  return dgSocket;
}

async function callOpenAI(messages) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
      parallel_tool_calls: false,
      temperature: 0.4,
      max_tokens: 250,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  return data.choices[0].message;
}

/**
 * Sends TTS audio to the call, then a Twilio "mark" that Twilio echoes back
 * once the audio has actually finished PLAYING. `isStillWanted` is checked
 * after the TTS request returns, so a reply the caller interrupted before it
 * started playing is never sent. Returns the audio duration in ms.
 */
async function speakToCall(text, twilioWs, streamSid, markName, isStillWanted = () => true) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream?output_format=ulaw_8000`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'xi-api-key': ELEVENLABS_API_KEY,
    },
    body: JSON.stringify({
      text,
      model_id: 'eleven_turbo_v2_5',
      voice_settings: { stability: 0.9, similarity_boost: 0.85, style: 0.0, use_speaker_boost: true },
      seed: 42,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`ElevenLabs error ${response.status}: ${errText}`);
  }

  const audioBuffer = Buffer.from(await response.arrayBuffer());
  if (!isStillWanted()) return 0;

  const FRAME_SIZE = 160; // 20ms of 8kHz mu-law
  for (let i = 0; i < audioBuffer.length; i += FRAME_SIZE) {
    if (twilioWs.readyState !== WebSocket.OPEN) break;
    const chunk = audioBuffer.subarray(i, i + FRAME_SIZE);
    twilioWs.send(
      JSON.stringify({
        event: 'media',
        streamSid,
        media: { payload: chunk.toString('base64') },
      })
    );
  }

  if (twilioWs.readyState === WebSocket.OPEN && markName) {
    twilioWs.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: markName } }));
  }

  return Math.round(audioBuffer.length / 8); // 8000 bytes per second
}

// ---------------------------------------------------------------------------
// Media stream (one connection per call)
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ server, path: '/media-stream' });

wss.on('connection', (twilioWs) => {
  console.log('[STREAM] Twilio media stream connected');

  let dgSocket = null;
  let callSid = null;
  let streamSid = null;
  let callStartedAt = null;
  let callerNumber = null;
  let calledNumber = null;
  const conversationHistory = [];
  let lastAiReplyText = '';

  // Booking state
  let bookingEventId = null;
  let bookingEventLink = null;
  let confirmedBooking = null;
  let schedulingUnavailable = false;
  const verifiedAddresses = new Set();

  // Speaking / hang-up state
  let markCounter = 0;
  let lastSpeechMark = null;
  let agentSpeaking = false;
  let sayToken = 0; // bumped on barge-in to cancel replies still being generated
  let hangupRequested = false;
  let hangupPending = false;
  let hungUp = false;
  let hangupFallbackTimer = null;

  // Turn-taking state
  let isProcessing = false;
  const pendingTranscripts = [];
  let settleTimer = null;
  let speechActivity = 0; // increases every time the caller says anything

  function sendToTwilio(obj) {
    if (twilioWs.readyState === WebSocket.OPEN) twilioWs.send(JSON.stringify(obj));
  }

  async function say(text, markName = `speech-${++markCounter}`) {
    const myToken = ++sayToken;
    lastSpeechMark = markName;
    agentSpeaking = true;
    return speakToCall(text, twilioWs, streamSid, markName, () => myToken === sayToken);
  }

  async function hangUp(reason) {
    if (hungUp) return;
    hungUp = true;
    if (hangupFallbackTimer) clearTimeout(hangupFallbackTimer);
    console.log(`[HANGUP:${callSid}] ${reason}`);

    try {
      if (twilioClient && callSid) {
        await twilioClient.calls(callSid).update({ status: 'completed' });
        return;
      }
    } catch (err) {
      console.error('[HANGUP] Twilio API hangup failed:', err.message);
    }
    if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
  }

  function lastCallerMessage() {
    for (let i = conversationHistory.length - 1; i >= 0; i--) {
      if (conversationHistory[i].role === 'user') return conversationHistory[i].content || '';
    }
    return '';
  }

  function scheduleTurn(waitMs) {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = null;
      processQueue();
    }, waitMs);
  }

  function chooseSettleDelay() {
    const soFar = pendingTranscripts.join(' ');
    const last = pendingTranscripts[pendingTranscripts.length - 1] || '';
    let wait = SETTLE_MS_NORMAL;

    if (looksUnfinished(last)) wait = Math.max(wait, SETTLE_MS_UNFINISHED);

    const askedPhone = /phone|number/i.test(lastAiReplyText);
    const askedAddress = /address/i.test(lastAiReplyText);
    const digitCount = (soFar.match(/\d/g) || []).length;

    if (askedPhone && digitCount < 10) wait = Math.max(wait, SETTLE_MS_ADDRESS_OR_PHONE);
    if (askedAddress) wait = Math.max(wait, SETTLE_MS_ADDRESS_OR_PHONE);

    return wait;
  }

  // ------------------------- Tools -------------------------
  async function checkAvailability(date) {
    if (!isValidDateString(date)) return { ok: false, error: 'Date must be in YYYY-MM-DD format.' };
    if (date < todayInTimeZone()) return { ok: false, error: 'That date is in the past.' };
    if (!isWeekday(date)) {
      return {
        ok: false,
        error: `${weekdayOf(date)} is a weekend — technicians only work Monday to Friday. Offer the nearest weekday instead.`,
      };
    }

    const slots = await getAvailableSlots(date, { excludeEventId: bookingEventId });
    return {
      ok: true,
      date,
      day: formatDateForSpeech(date),
      openTimes: slots.map((t) => ({ time: t, spoken: formatTimeForSpeech(t) })),
      note: slots.length
        ? 'Offer two of these times.'
        : 'No openings that day. Tell the caller and suggest the next weekday.',
    };
  }

  async function bookAppointment(args) {
    const { name, phone, issue, address, date, time } = args;

    const lastMsg = lastCallerMessage();
    if (!AFFIRMATIVE.test(lastMsg) || NEGATIVE.test(lastMsg)) {
      return {
        ok: false,
        error:
          'The caller has not clearly said yes to a full recap in their latest message. Read the full recap (name, address, day, time) and ask "Does that all sound right?" first.',
      };
    }

    const missing = ['name', 'phone', 'issue', 'address', 'date', 'time'].filter((k) => !args[k]);
    if (missing.length) return { ok: false, error: `Missing: ${missing.join(', ')}.` };
    if (!isValidDateString(date)) return { ok: false, error: 'date must be YYYY-MM-DD.' };
    if (!isValidTimeString(time)) return { ok: false, error: 'time must be 24-hour HH:MM, e.g. "09:00".' };
    if (!isWeekday(date)) return { ok: false, error: 'That day is a weekend. Offer a weekday instead.' };
    if (zonedDateTimeToDate(date, time) <= new Date()) return { ok: false, error: 'That time has already passed.' };

    const free = await isSlotFree(date, time, bookingEventId);
    if (!free) {
      return {
        ok: false,
        error: 'That time is no longer available. Call check_availability again and offer other times.',
      };
    }

    const booking = {
      name,
      phone,
      issue,
      address,
      addressVerified: verifiedAddresses.has(normalizeAddress(address)),
      date,
      time,
    };

    const isUpdate = !!bookingEventId;
    const result = isUpdate
      ? await updateBookingEvent(bookingEventId, booking)
      : await createBookingEvent(booking);

    bookingEventId = result.eventId;
    bookingEventLink = result.eventLink;
    confirmedBooking = booking;
    console.log(`[CALENDAR] ${isUpdate ? 'Updated' : 'Booked'}! ${result.eventLink}`);

    return {
      ok: true,
      updated: isUpdate,
      bookedFor: `${formatDateForSpeech(date)} at ${formatTimeForSpeech(time)}`,
    };
  }

  async function executeTool(name, args) {
    switch (name) {
      case 'verify_address': {
        const result = await verifyAddress(args.address);
        if (result.status === 'found') {
          verifiedAddresses.add(normalizeAddress(result.spokenAddress));
          verifiedAddresses.add(normalizeAddress(result.fullAddress));
        }
        return result;
      }
      case 'check_availability':
        if (schedulingUnavailable) return { ok: false, error: 'Scheduling system is down. Do not retry.' };
        return checkAvailability(args.date);
      case 'book_appointment':
        if (schedulingUnavailable) return { ok: false, error: 'Scheduling system is down. Do not retry.' };
        return bookAppointment(args);
      case 'end_call':
        hangupRequested = true;
        return { ok: true, note: 'Say your final goodbye line now. The call ends after it plays.' };
      default:
        return { ok: false, error: `Unknown tool: ${name}` };
    }
  }

  // ------------------------- Model loop -------------------------
  async function runModelWithTools(extraSystemNote) {
    for (let step = 0; step < 6; step++) {
      const messages = [
        {
          role: 'system',
          content: buildSystemPrompt({ booking: confirmedBooking, schedulingUnavailable }),
        },
        ...conversationHistory,
      ];
      if (extraSystemNote) messages.push({ role: 'system', content: extraSystemNote });

      const msg = await callOpenAI(messages);

      if (msg.tool_calls && msg.tool_calls.length) {
        conversationHistory.push({ role: 'assistant', content: msg.content ?? null, tool_calls: msg.tool_calls });

        for (const toolCall of msg.tool_calls) {
          const toolName = toolCall.function.name;
          let args = {};
          try {
            args = JSON.parse(toolCall.function.arguments || '{}');
          } catch {
            args = {};
          }

          let result;
          try {
            result = await executeTool(toolName, args);
          } catch (err) {
            const detail = err.response?.data ? JSON.stringify(err.response.data) : '';
            console.error(`[TOOL] ${toolName} failed: ${err.message} ${detail}`);

            if (toolName === 'check_availability' || toolName === 'book_appointment') {
              schedulingUnavailable = true;
              result = {
                ok: false,
                error:
                  'The scheduling system is down right now. Do NOT try other dates. Ask what day and time they would prefer, tell them a team member will call them back today to confirm, then say a short goodbye and call end_call.',
              };
            } else {
              result = { ok: false, error: 'That lookup failed on our end. Continue without it.' };
            }
          }

          console.log(`[TOOL:${callSid}] ${toolName}(${JSON.stringify(args)}) -> ${JSON.stringify(result)}`);
          conversationHistory.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(result) });
        }
        continue;
      }

      return (msg.content || '').trim();
    }
    return '';
  }

  async function generateReply() {
    let reply = await runModelWithTools();

    if (!bookingEventId && PREMATURE_BOOKING_CLAIM.test(reply)) {
      console.warn(`[GUARD:${callSid}] blocked premature booking claim: "${reply}"`);
      reply = await runModelWithTools(
        `Your draft reply was: "${reply}". Nothing has been booked yet (book_appointment has not succeeded), so you must not say it is booked, confirmed, scheduled, or that they're all set. Rewrite it using tentative language only, still one or two short sentences.`
      );
      if (!bookingEventId && PREMATURE_BOOKING_CLAIM.test(reply)) {
        reply = 'Before I lock anything in, let me make sure I have it right — does everything so far sound correct?';
      }
    }

    if (!reply) {
      if (hangupRequested) {
        reply = bookingEventId ? CLOSING_LINE : `Thanks for calling ${BUSINESS_NAME}, goodbye!`;
      } else {
        reply = 'Sorry, could you say that one more time?';
      }
    }
    return reply;
  }

  async function processQueue() {
    if (isProcessing || hangupPending) return;
    isProcessing = true;

    try {
      while (pendingTranscripts.length > 0 && !hangupPending) {
        const turnText = pendingTranscripts.splice(0).join(' ');
        const historyLengthBefore = conversationHistory.length;
        const activityAtStart = speechActivity;
        const bookingIdBefore = bookingEventId;
        const hangupBefore = hangupRequested;

        conversationHistory.push({ role: 'user', content: turnText });

        let reply;
        try {
          reply = await generateReply();
        } catch (err) {
          console.error('[PIPELINE] error:', err.message);
          reply = 'Sorry, I missed that — could you say it one more time?';
        }

        // Did the caller keep talking while we were thinking? Then this reply
        // answers only half of what they said. Throw it away and answer the
        // whole thing once they're done (unless we already booked something).
        if (speechActivity !== activityAtStart && bookingEventId === bookingIdBefore) {
          conversationHistory.length = historyLengthBefore;
          hangupRequested = hangupBefore;
          pendingTranscripts.unshift(turnText);
          console.log(`[TURN:${callSid}] caller kept talking — dropped stale reply: "${reply}"`);
          if (!settleTimer) scheduleTurn(chooseSettleDelay());
          break;
        }

        conversationHistory.push({ role: 'assistant', content: reply });
        lastAiReplyText = reply;
        console.log(`[AI:${callSid}] "${reply}"`);

        try {
          if (hangupRequested) {
            hangupPending = true;
            const durationMs = await say(reply, 'final-goodbye');
            hangupFallbackTimer = setTimeout(() => hangUp('fallback timer after goodbye'), durationMs + 3000);
          } else {
            await say(reply);
          }
        } catch (err) {
          console.error('[PIPELINE] speech error:', err.message);
          if (hangupPending) hangUp('error while saying goodbye');
        }
      }
    } finally {
      isProcessing = false;
    }
  }

  // ------------------------- Twilio events -------------------------
  function handleStart(msg) {
    const params = msg.start.customParameters || {};

    if (!isValidCallSid(msg.start.callSid) || !consumeStreamToken(params.streamToken)) {
      console.warn('[SECURITY] Rejected media stream without a valid token/CallSid.');
      twilioWs.close();
      return;
    }

    callSid = msg.start.callSid;
    streamSid = msg.start.streamSid;
    callStartedAt = new Date().toISOString();
    callerNumber = params.callerNumber || null;
    calledNumber = params.calledNumber || null;
    console.log('[STREAM] start', { callSid, streamSid, callerNumber });

    conversationHistory.push({ role: 'assistant', content: GREETING });
    lastAiReplyText = GREETING;
    say(GREETING).catch((err) => console.error('[PIPELINE] greeting error:', err.message));

    dgSocket = openDeepgramConnection((transcript, isFinal) => {
      if (hangupPending) return;
      const text = transcript.trim();

      // ANY words from the caller — even a partial, unfinished transcript —
      // mean they're still talking: stop the countdown to our reply.
      speechActivity++;
      if (settleTimer) {
        clearTimeout(settleTimer);
        settleTimer = null;
      }

      // Barge-in: caller talks over the agent -> stop the agent's audio,
      // including a reply that's still being generated.
      if (agentSpeaking && countWords(text) >= BARGE_IN_MIN_WORDS) {
        sendToTwilio({ event: 'clear', streamSid });
        agentSpeaking = false;
        sayToken++;
        console.log(`\n[BARGE-IN:${callSid}] caller spoke over the agent — audio cleared`);
      }

      if (!isFinal) {
        process.stdout.write(`\r[interim] ${text}          `);
        return;
      }

      console.log(`\n[CALLER:${callSid}] "${text}"`);
      pendingTranscripts.push(text);
      scheduleTurn(chooseSettleDelay());
    });
  }

  function handleStop() {
    console.log(`[STREAM] stop — call ${callSid} ended`);
    if (settleTimer) clearTimeout(settleTimer);
    if (hangupFallbackTimer) clearTimeout(hangupFallbackTimer);

    if (callSid) {
      saveCallLog(callSid, {
        callerNumber,
        calledNumber,
        startedAt: callStartedAt,
        endedAt: new Date().toISOString(),
        transcript: conversationHistory,
        booking: confirmedBooking,
        bookingEventId,
        bookingEventLink,
        needsCallback: schedulingUnavailable && !bookingEventId,
      });
      console.log(`[CALLLOG] saved transcript for ${callSid}`);
    }

    if (dgSocket) dgSocket.close();
  }

  twilioWs.on('message', (message) => {
    let msg;
    try {
      msg = JSON.parse(message.toString());
    } catch {
      return;
    }

    switch (msg.event) {
      case 'start':
        handleStart(msg);
        break;

      case 'media':
        if (dgSocket && dgSocket.readyState === WebSocket.OPEN) {
          dgSocket.send(Buffer.from(msg.media.payload, 'base64'));
        }
        break;

      case 'mark': {
        const name = msg.mark?.name;
        if (name === lastSpeechMark) agentSpeaking = false;
        if (name === 'final-goodbye') hangUp('goodbye finished playing');
        break;
      }

      case 'stop':
        handleStop();
        break;

      default:
        break;
    }
  });

  twilioWs.on('close', () => {
    console.log('[STREAM] Twilio media stream disconnected');
    if (settleTimer) clearTimeout(settleTimer);
    if (hangupFallbackTimer) clearTimeout(hangupFallbackTimer);
    if (dgSocket && dgSocket.readyState === WebSocket.OPEN) dgSocket.close();
  });

  twilioWs.on('error', (err) => {
    console.error('[STREAM] WebSocket error:', err);
  });
});

server.listen(PORT, () => {
  console.log(`Arklane voice agent server listening on port ${PORT}`);
  console.log(`Webhook URL to give Twilio: https://${PUBLIC_HOST || '<your-ngrok-host>'}/incoming-call`);

  checkCalendarAccess()
    .then(() => console.log('[CALENDAR] Google Calendar connected ✓'))
    .catch((err) => {
      const detail = err.response?.data ? JSON.stringify(err.response.data) : '';
      console.error(`[CALENDAR] Google Calendar check FAILED: ${err.message} ${detail}`);
      if (/invalid_grant/i.test(`${err.message} ${detail}`)) {
        console.error('  -> Your refresh token expired or was revoked. Run: node scripts/get-google-token.js');
        console.error('     then paste the new GOOGLE_REFRESH_TOKEN into .env and restart the server.');
      } else if (/insufficient|scope|403/i.test(`${err.message} ${detail}`)) {
        console.error('  -> Permission problem. Make sure the Google Calendar API is enabled in Google Cloud,');
        console.error('     then re-run: node scripts/get-google-token.js');
      }
    });
});