# Product Marketing Context

**Document version:** v1
**Last updated:** 2026-10-24

## Product Overview

**One-liner:** QuickCalAI turns any schedule into calendar events you can import, share, or hand to an AI agent.

**What it does:** QuickCalAI reads a schedule from an image, PDF, pasted text, public URL, or structured JSON, extracts the dates, times, titles, and locations, and produces a standard .ics file. Users can download it, email it, text it, share a public link, or subscribe to a private calendar feed containing every event they own.

**Product category:** AI schedule extraction and calendar import.

**Product type:** SaaS with a web app, native app, REST API, and MCP server.

**Business model:** Free account with one AI extraction and unlimited manual events. Premium is $12.99 per month or $71.88 per year for unlimited AI extraction, email and SMS delivery, and public share links.

## Target Audience

**Target companies:** Not company-first. The core buyer is an individual or a small team with a recurring schedule problem.

**Decision-makers:** The person who owns the schedule: a student, executive assistant, coach, event organizer, shift lead, or operations generalist. For agent workflows, the buyer is a developer or technical operator.

**Primary use case:** Turn a schedule that only exists as a PDF, screenshot, post, or block of text into calendar events without retyping it.

**Jobs to be done:**
- Capture a schedule once and get every event into a calendar.
- Share a clean calendar with a team, class, or family without asking them to sign up.
- Let an AI agent create, review, and fix calendar events through an API or MCP.

**Use cases:**
- A student imports a semester timetable from a PDF.
- An executive assistant processes a conference agenda from a link.
- A coach shares a season schedule with parents.
- A shift worker turns a photo of the rota into a calendar.
- A developer connects Claude or Cursor to QuickCalAI and asks it to ingest a schedule.

## Problems & Pain Points

**Core problem:** Schedules arrive in formats that calendars cannot read: screenshots, PDFs, flyers, group chats, web pages, and plain text. Retyping them is slow and easy to get wrong.

**Why alternatives fall short:**
- Manual entry takes time and creates typos.
- Generic OCR gives text, not calendar events.
- Calendar apps import .ics files but do not create them from arbitrary documents.
- AI chat tools can read a schedule but do not produce a clean, reviewable calendar artifact.
- Agent workflows usually stop at "here is the text" instead of creating durable events.

**What it costs them:** Time, missed events, duplicate work, and the risk of trusting an extraction that silently misread a date.

**Emotional tension:** "I do not want to retype this again" and "I need to know the AI got the date right before I trust it."

## Competitive Landscape

**Direct:** Manual calendar entry, generic OCR plus copy and paste, and one-off AI prompts that output text instead of .ics files.

**Secondary:** Scheduling tools such as Calendly, which help people book time but do not extract an existing schedule. Automation tools such as Zapier, which connect apps but do not read an arbitrary document.

**Indirect:** "Just type it in" and "ask an assistant to do it," which still leave the user with unstructured text and no calendar file.

**How each falls short:** They either stop at text, require manual cleanup, or cannot be driven by an agent.

## Differentiation

**Key differentiators:**
- Agent-native: MCP server, REST API, API keys, idempotent retries, and signed webhooks.
- Reviewable extraction: every AI-extracted event carries a confidence score and the source quote it came from.
- Five ways in: image, PDF, pasted text, public URL, and structured JSON.
- One private calendar feed for every event a user owns.
- Free manual events and one free AI extraction before any payment.
- Share links that can be revoked.

**How we do it differently:** QuickCalAI treats extraction as a reviewable pipeline, not a one-shot answer. The output is a real calendar file plus structured event rows that can be edited, deleted, shared, or fed to an agent.

**Why that is better:** Users can verify what the AI read, fix one event without starting over, and trust the calendar they import.

**Why customers choose us:** It removes the retyping step and gives them a clean artifact they can share or automate.

## Objections

| Objection | Response |
| --- | --- |
| "AI extraction is not accurate enough." | Every AI event includes a confidence score and the source quote. Users can edit or delete one event and the .ics regenerates immediately. |
| "I do not want my schedule shared." | Files stay private to the account. A share link is created only when the user asks for one, and it can be revoked. |
| "Why pay for Premium?" | Premium removes the AI cap and unlocks email delivery, SMS delivery, and public share links. Manual events stay free. |
| "Will it work with my calendar?" | The output is a standard .ics file, which imports into Google Calendar, Apple Calendar, Outlook, and any other calendar app that supports the format. |
| "I already use an AI assistant." | QuickCalAI gives the assistant a real calendar tool through MCP or the REST API, instead of leaving the result as chat text. |

**Anti-persona:** Someone who needs a full scheduling product with availability rules, booking pages, and team round-robin. QuickCalAI extracts and organizes existing schedules; it is not a booking platform.

## Switching Dynamics

**Push:** Retyping schedules, missed events, and the old app's failed uploads.

**Pull:** One upload or paste, a reviewable extraction, and an agent that can do the work.

**Habit:** The calendar app is already open, and typing a few events feels familiar.

**Anxiety:** "Will the AI misread a date?" and "Will I lose the schedule I already uploaded?"

## Customer Language

Working language from the landing page and old app. Replace these with verbatim customer quotes as they come in.

**How they describe the problem:**
- "I have a PDF schedule and I do not want to type every date."
- "Can you turn this screenshot into calendar events?"
- "I need to share the schedule with the whole team."

**How they describe us:**
- "It turns a schedule into a calendar file."
- "I can paste the schedule instead of uploading a file."
- "My agent can create the events for me."

**Words to use:** schedule, calendar, events, extract, import, share, agent, review, confidence, source quote.

**Words to avoid:** revolutionary, seamless, magical, game-changing, "agentic shit" in customer copy.

**Glossary:**
| Term | Meaning |
| --- | --- |
| Extraction | The AI pass that turns a document or text into structured events. |
| .ics | The standard calendar file format used by Google Calendar, Apple Calendar, Outlook, and others. |
| Share link | A public page and download link for one upload, revocable by the owner. |
| Calendar feed | A private URL that contains every event a user owns and can be subscribed to in a calendar app. |
| MCP | Model Context Protocol, the interface used by Claude, Cursor, and other agent clients. |
| Free credit | The one AI extraction available to a free account. |

## Brand Voice

**Tone:** Direct, honest, practical, and a little dry. Confident without hype.

**Style:** Short sentences. Plain words. Show the outcome instead of adjectives. No em dashes.

**Personality:** Plainspoken, competent, resourceful, quietly irreverent.

## Proof Points

**Metrics:**
- 5 ingestion paths: image, PDF, pasted text, public URL, structured JSON.
- 9 MCP tools for agents.
- 1 free AI extraction per account.
- Premium at $12.99 per month or $71.88 per year.
- Per-event confidence and source quote on AI extractions.

**Customers:** Do not invent customer counts, logos, or testimonials. The current installed base is small and should not be presented as social proof.

**Testimonials:** None approved for public use yet.

**Value themes:**
| Theme | Proof |
| --- | --- |
| Less retyping | Upload, paste, or link a schedule and get a calendar file. |
| Trust through review | Confidence score and source quote for every AI event. |
| Works with agents | MCP server plus REST API with signed webhooks. |
| Private by default | Private storage, revocable share links, private calendar feed. |
| Free to start | One free AI extraction and unlimited manual events. |

## Goals

**Business goal:** Make QuickCalAI the default way to turn an arbitrary schedule into a calendar, for both people and their agents.

**Conversion action:** Complete a first extraction, then upgrade to Premium for unlimited AI and delivery features.

**Current metrics:** 19 migrated users from the Clerk app. No paid subscriptions at the time of this document. Use these numbers internally only, not in marketing copy.

## Changelog
- v1 (2026-10-24) - Initial context from the codebase, landing page, README, and Clerk migration audit.
