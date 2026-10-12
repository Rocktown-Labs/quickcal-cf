# OCR bench

Evaluates Workers AI models as replacements for the external Z.ai GLM-OCR step
(`apps/server/src/lib/ocr.ts`) — the only part of the pipeline that
needs an API key. Everything here runs on the existing Cloudflare account, so
the $5k startup credits cover it.

## What it tests

Each strategy runs every image/PDF in `samples/` through the Workers AI REST
API and scores the extracted events against `truth.json`:

| Strategy | What it does |
|---|---|
| `glm-direct` | One call: image → events JSON with the production prompt (default reasoning) |
| `glm-direct-low` | Same, but `reasoning_effort: low` (cheaper, much faster) |
| `glm-direct-tuned` | Low reasoning + betting-slip-aware prompt |
| `glm-direct-dated` | Tuned prompt + capture-date reference so "today" resolves (proposed production config) |
| `qwen-direct` | One call with `@cf/qwen/qwen3.8-27b` |
| `moondream-ocr` | Two calls: Moondream transcribes the image → GLM extracts (mirrors the current OCR → extract architecture) |
| `moondream-direct` | One call: Moondream returns events JSON itself |
| `glm-pdf` | PDF sent as an OpenAI-style `file` content part to GLM |

Before the strategies, a **`clef-gate` phase** runs every image through the
production Clef gate ("is this a calendar?") on both `clef` and `clef-flash`,
plus the tuned criteria proposal, and reports each probability and pass/reject
at the 0.5 threshold. Use `--gate=only` to run just the gate, `--gate=off` to
skip it.

Scoring matches each truth event to a prediction by date (then time), and
checks time (exact), title/location (normalised token overlap ≥ 70%).

## Run it

```sh
cd scripts/ocr-bench
bun install          # once — wrangler is only needed for docs, not at runtime
bun run make-samples.ts   # regenerates the synthetic samples via headless Chrome
bun run run.ts
# subsets:
bun run run.ts --only=glm-direct-low,moondream-ocr
bun run run.ts --samples=ticket-concert.png
```

Auth: uses `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` if set, otherwise
the `wrangler login` OAuth token from `~/Library/Preferences/.wrangler/config`. The
account must be on Workers Paid (glm-5.3-flash requires it).

Full transcripts, token usage and per-sample scores land in
`results/<timestamp>/` (gitignored).

## Adding your own samples

Drop real screenshots into `samples/` (png/jpg) and add matching entries to
`truth.json` — the keys are filenames, the events use the same field names as
production (`ExtractedEvent`). Re-run with `--samples=<file>` to iterate.

## Findings (October 2026)

### The Clef gate: great on schedules, weak on single-event documents

The production pipeline runs Clef (`@cf/cloudflare/clef`) before any OCR or
extraction: *"does this document primarily represent a calendar, schedule,
agenda, or a list of events with dates?"* — measured over the schedule-themed
samples (class schedule, concert ticket, travel itinerary, party flyer, plus
receipt/article negative controls):

| Sample | Production criteria | Tuned criteria |
|---|---|---|
| class-schedule.png | 0.98 PASS | 0.98 PASS |
| party-flyer.png | 0.87 PASS | 0.98 PASS |
| itinerary-email.png | 0.51 PASS (borderline) | 0.95 PASS |
| ticket-concert.png | **0.37 REJECT** | **0.97 PASS** |
| grocery-receipt.png | 0.02 REJECT | 0.04 REJECT |
| news-article.png | 0.02 REJECT | 0.06 REJECT |

- The production criteria handle multi-event schedules well but **reject
  single-event documents** — a plain concert ticket scores 0.37 — and leave
  travel itineraries right on the threshold (0.51). Since the product takes
  "concert dates" and similar single-event uploads, that's a real gap.
- **Tuned criteria fix it cleanly**: reframing the question to *"does this
  document contain one or more dated or timed events the user might want to
  add to a calendar?"* (explicitly naming tickets, invitations, game
  schedules, itineraries) scores 0.95–0.98 on every schedule-type sample while
  still rejecting the negative controls. **Adopted in production**
  (`getCalendarProbability` in `apps/server/src/lib/ai.ts`); the copy here is
  for regression-testing future criteria changes.
- `clef-flash` (9B, ~5x faster) agreed with `clef`'s direction on every
  sample — a viable drop-in for the hot path. Note it **must be called at its
  own endpoint** (`@cf/cloudflare/clef-flash`); the `cle` endpoint returns 422
  for `model: "clef-flash"`. (Fixed in `apps/server/src/lib/ai.ts`.)
- Side note: a batch of sports-betting-slip screenshots briefly lived in
  `samples/` (belongs to a sibling project). Under the production criteria
  Clef rejects those too (they read as receipts); the general "contains dated
  events" framing covers them if that product ever needs it. They've been
  moved out of this repo.

### Extraction on schedule documents: what works, what breaks

- **`glm-direct` (one call, image → events)** is excellent on schedule-type
  documents: 100% recall and field accuracy on the class schedule, concert
  ticket (picking the show time over the gates time), travel itinerary, and
  handwritten party flyer. Low reasoning is as accurate as default and ~2-3x
  faster/cheaper.
- **Relative dates need a reference point.** Documents that say "Today" or
  "This Saturday" can't be resolved without knowing when the image was taken,
  and the prompt forbids inventing dates, so the model returns `date: ""`.
  Passing the capture/upload date into the prompt (`The image was captured on
  …; resolve "today" to that date`) fixes this — validated end-to-end with
  `glm-direct-dated`. In production that reference is the upload timestamp.
- **Found a production bug:** the extraction prompt instructs the model to
  return `date: ""` when undeterminable, but the Zod schema requires strict
  `YYYY-MM-DD` — and `generateICSForAI` throws on empty dates. Today this is
  masked because schedule documents usually carry full dates, but any upload
  with only relative or missing dates will fail extraction entirely. Decide:
  skip undated events at the schema boundary, or support date-less events
  through DB/ICS (e.g. for review before export).
- Never fall back to a purchase/print timestamp as an event time.

### Model comparison (synthetic schedule/ticket set)

| Strategy | Recall | Precision | Field acc. | Latency/image | Cost/image |
|---|---|---|---|---|---|
| **`glm-direct-low`** | **100%** | **100%** | **100%** | 3–10 s | ~$0.0004 |
| `glm-direct` | 100% | 100% | 100% | 10–30 s | ~$0.0009 |
| `moondream-ocr` | 80–100%* | 90% | 100%* | 20–55 s | ~$0.001 |
| `qwen-direct` | 50% | 100% | 100% | 30 s–20 min | ~$0.005 |
| `moondream-direct` | poor | — | — | 3 s | ~$0.0002 |
| `glm-pdf` (file part) | fails (HTTP 400) | | | | |

\* `moondream-ocr` has noticeable run-to-run variance (temperature 0.2);
`glm` results were identical across repeated runs.

- **PDFs are not supported** by any vision path: `image_url` parts reject
  `application/pdf` ("expected image/* MIME type") and the `file` part 400s.
  Extract text in the Worker (e.g. `unpdf`) and feed the existing text
  extractor, or rasterise pages to images first.
- **Moondream's non-streaming responses return an empty object** (`result: {}`)
  — only `stream: true` works (as of Oct 2026). It also cannot read PDFs.
- Full runs cost a few cents; iterating is essentially free against the $5k
  credits. The bench auto-refreshes an expired wrangler OAuth token on 401.
