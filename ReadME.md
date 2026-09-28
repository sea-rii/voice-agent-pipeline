# Voice Agent - AI Phone Receptionist

An AI voice agent that answers customer phone calls, has a natural conversation, and books appointments directly into Google Calendar. It uses an HVAC company ("Comfort Air HVAC") as a placeholder business.

The agent collects the caller's issue, name, phone number, and address, verifies the address with Google Maps, checks real calendar availability, reads back a recap, and books the appointment only after the caller confirms. Every call is logged with a full transcript and recording.

## Tech Stack

- **Twilio**: phone number, call handling, real-time audio streaming, recording
- **Deepgram** (nova-3): live speech-to-text
- **OpenAI GPT-4o**: conversation and tool calling
- **ElevenLabs**: text-to-speech
- **Google Calendar API**: availability checks and booking
- **Google Maps Geocoding API**: address verification
- **Node.js / Express / WebSockets**

## How It Works

```
Caller → Twilio → WebSocket → Deepgram (speech-to-text)
                                   ↓
                           GPT-4o + tools
              (verify_address, check_availability,
               book_appointment, end_call)
                                   ↓
Caller ← Twilio ← ElevenLabs (text-to-speech)
```

## Project Structure

```
voice-agent/
├── src/
│   ├── server.js        # Express server, Twilio webhooks, call pipeline, turn-taking
│   ├── calendar.js      # Google Calendar: availability, create/update bookings
│   ├── maps.js          # Google Maps address verification
│   ├── time.js          # Timezone-safe date/time helpers
│   └── callLog.js       # Saves per-call transcripts and recording links
├── scripts/
│   └── get-google-token.js   # One-time Google OAuth setup
├── call-logs/           # Call records (gitignored)
├── .env.example         # Required environment variables
└── package.json
```

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in your API keys
3. Run `node scripts/get-google-token.js` once and add the refresh token to `.env`
4. Start ngrok: `ngrok http 3000`, then set `PUBLIC_HOST` in `.env`
5. Start the server: `node src/server.js`
6. In the Twilio Console, set your number's voice webhook to `https://<PUBLIC_HOST>/incoming-call` (POST)