# NORa

NORa is a WhatsApp-native personal second brain. A user can send a text or voice note, and the agent can turn it into organized Notion memory, calendar actions, and a follow-up reminder without leaving the conversation.

## Why WhatsApp matters

The input is designed for moments when opening a productivity app is inconvenient: send a voice note while walking, commuting, or between meetings. WhatsApp provides the familiar capture surface and the later proactive reminder; Notion is the durable workspace where the resulting memory and calendar event can be inspected.

## Core workflow

```text
WhatsApp voice note
  → Meta webhook (verified and deduplicated)
  → Groq Whisper transcription
  → OpenRouter/OpenAI reasoning and tool selection
  → Notion note/calendar + local reminder persistence
  → concise action receipt in WhatsApp
```

The OpenAI-compatible agent can sequence tools, for example searching a note before updating it or checking calendar conflicts before creating an event. Calendar conflict confirmation is stored as explicit application state, not only in the prompt.

## Setup

1. Install Node.js 22 or newer.
2. Install dependencies with `npm ci`.
3. Copy `.env.example` to `.env` and fill every required value.
4. Configure Meta’s webhook URL as `https://<your-ngrok-domain>/webhook` using `VERIFY_TOKEN`.
5. Share the Notion notes parent page and calendar data source with the integration.
6. Start the service with `npm start`.

Startup validates the critical configuration and never prints secret values. This is intentionally a single-owner application: only `WHATSAPP_OWNER_PHONE` is accepted.

## Tests

```bash
npm test
```

The focused tests cover Meta signature verification, owner authorization, batch processing and deduplication, calendar interval semantics, reminder claiming/retries, and user-visible failure handling.

## Recommended demo

Send a WhatsApp voice note such as:

> Save this pitch idea: voice notes should become structured project memory. Schedule a pitch review with Clara Friday at 15:00 for 30 minutes, and remind me 30 minutes before.

Show the transcript/result, the new Notion note, the calendar event, the reminder confirmation, and the reminder arriving in WhatsApp. For a second act, request an overlapping event and demonstrate the event-specific “Move …” / “Cancel” choices. The selected event moves into the next verified free slot while the other event stays at its requested time.

Keep the reminder within the active WhatsApp conversation window for the hackathon demonstration. WhatsApp Business Platform may require approved templates for free-form proactive messages outside its 24-hour customer-service window; template management is deliberately outside this project’s scope.

## What's Next

And this is just the beginning.

We imagine NORa evolving from a personal assistant into a true communication layer that works quietly in the background, helping people stay connected without constantly managing their availability.

If you're unavailable, NORa could automatically let your contacts know — and even estimate when you'll be available again. It could send personalized responses on your behalf, based on the context of the conversation and the way you normally communicate.

NORa could also expand beyond WhatsApp to work across the platforms people already use every day — **Discord, Slack, Telegram, Skype, and more**. Instead of adapting your workflow to each platform, NORa could become the consistent assistant that follows you across them.

Over time, NORa could learn your communication habits: your preferred channels, when you usually respond, who you prioritize, and the best way to reach you.

For professional teams, NORa could go even further by connecting to shared calendars and helping coordinate everyone's schedules. It could match availability, find the right time for meetings, resolve scheduling conflicts, and keep the whole team in sync.

The goal is simple:

> **Less time managing your schedule and communication. More time actually getting things done.**