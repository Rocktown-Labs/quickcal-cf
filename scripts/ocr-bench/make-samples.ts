/**
 * Generates synthetic test samples into ./samples using headless Chrome:
 *   - ticket-concert.png / ticket-concert.webp  (simple event ticket)
 *   - class-schedule.png                        (weekly grid, 5 events)
 *   - itinerary-email.png / itinerary-email.pdf (email-style, 3 events)
 *   - party-flyer.png                           (handwriting-style, 1 event)
 *
 * The HTML sources live in ./samples/html so you can tweak them or add new
 * ones, then re-run:  bun run make-samples.ts
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const dir = new URL("./samples", import.meta.url).pathname;
const htmlDir = join(dir, "html");
mkdirSync(htmlDir, { recursive: true });

function chrome(args: string[]) {
  execFileSync(CHROME, args, { stdio: "pipe" });
}

function shoot(htmlFile: string, out: string, width: number, height: number, scale = 1) {
  chrome([
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    `--screenshot=${join(dir, out)}`,
    `--window-size=${width},${height}`,
    `--force-device-scale-factor=${scale}`,
    `file://${join(htmlDir, htmlFile)}`,
  ]);
}

const htmls: Record<string, string> = {
  "ticket-concert.html": `<!doctype html><html><head><meta charset="utf-8"><style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { width:720px; height:960px; font-family:'Helvetica Neue',Arial,sans-serif; background:#f4f1ea; display:flex; align-items:center; justify-content:center; }
    .ticket { width:620px; background:#fff; border:2px solid #1a1a2e; border-radius:14px; overflow:hidden; box-shadow:0 8px 30px rgba(0,0,0,.15); }
    .top { background:#1a1a2e; color:#f5c542; text-align:center; padding:22px; letter-spacing:6px; font-size:20px; font-weight:700; }
    .mid { text-align:center; padding:34px 30px 26px; }
    .venue { font-size:17px; letter-spacing:3px; color:#555; text-transform:uppercase; }
    .presents { font-size:13px; color:#999; margin:10px 0 6px; font-style:italic; }
    .artist { font-size:38px; font-weight:800; color:#1a1a2e; letter-spacing:1px; }
    .rule { border-top:2px dashed #bbb; margin:0 30px; }
    .details { display:flex; justify-content:space-between; padding:24px 40px; font-size:18px; color:#222; }
    .details b { display:block; font-size:12px; letter-spacing:2px; color:#999; margin-bottom:4px; text-transform:uppercase; }
    .bottom { padding:20px 30px 26px; text-align:center; }
    .barcode { height:56px; margin:0 40px; background:repeating-linear-gradient(90deg,#111 0 3px,#fff 3px 6px,#111 6px 8px,#fff 8px 12px); }
    .fine { font-size:12px; color:#888; margin-top:14px; }
  </style></head><body><div class="ticket">
    <div class="top">ADMIT ONE</div>
    <div class="mid">
      <div class="venue">Rocktown Amphitheatre</div>
      <div class="presents">presents</div>
      <div class="artist">THE MIDNIGHT RAMBLERS</div>
    </div>
    <div class="rule"></div>
    <div class="details">
      <div><b>Date</b>Saturday, March 14, 2026</div>
      <div><b>Gates</b>6:00 PM</div>
      <div><b>Show</b>7:30 PM</div>
    </div>
    <div class="details">
      <div><b>Section</b>B</div>
      <div><b>Row / Seat</b>12 / 8</div>
      <div><b>Ticket</b>#84921-A</div>
    </div>
    <div class="bottom">
      <div class="barcode"></div>
      <div class="fine">1200 Venue Way, Austin, TX 78704 &nbsp;·&nbsp; No refunds after showtime.</div>
    </div>
  </div></body></html>`,

  "class-schedule.html": `<!doctype html><html><head><meta charset="utf-8"><style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { width:900px; font-family:'Helvetica Neue',Arial,sans-serif; background:#fff; padding:36px 40px; }
    h1 { font-size:24px; letter-spacing:2px; color:#0d3b66; text-transform:uppercase; }
    .sub { color:#777; font-size:15px; margin:6px 0 24px; }
    table { width:100%; border-collapse:collapse; font-size:16px; }
    th { background:#0d3b66; color:#fff; padding:10px; font-size:14px; letter-spacing:1px; }
    td { border:1px solid #ccd; padding:12px 10px; }
    .course { font-weight:700; color:#111; }
    .room { color:#667; font-size:14px; }
  </style></head><body>
    <h1>Spring 2026 — Weekly Class Schedule</h1>
    <div class="sub">Week of Monday, March 9 – Friday, March 13 · All times local</div>
    <table>
      <tr><th style="width:16%">Day</th><th style="width:14%">Date</th><th>Course</th><th style="width:22%">Time</th><th style="width:26%">Location</th></tr>
      <tr><td>Monday</td><td>Mar 9</td><td class="course">Biology 101</td><td>9:00 AM – 10:15 AM</td><td class="room">Science Hall 204</td></tr>
      <tr><td>Tuesday</td><td>Mar 10</td><td class="course">Calculus II</td><td>11:00 AM – 12:15 PM</td><td class="room">Math Building 110</td></tr>
      <tr><td>Wednesday</td><td>Mar 11</td><td class="course">Chemistry Lab</td><td>2:00 PM – 4:30 PM</td><td class="room">Science Hall 118</td></tr>
      <tr><td>Thursday</td><td>Mar 12</td><td class="course">English Literature</td><td>10:30 AM – 11:45 AM</td><td class="room">Humanities 302</td></tr>
      <tr><td>Friday</td><td>Mar 13</td><td class="course">Statistics</td><td>1:00 PM – 2:15 PM</td><td class="room">Math Building 205</td></tr>
    </table>
  </body></html>`,

  "itinerary-email.html": `<!doctype html><html><head><meta charset="utf-8"><style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { width:760px; font-family:Arial,Helvetica,sans-serif; background:#ececec; padding:30px 0; }
    .card { width:680px; margin:0 auto; background:#fff; border:1px solid #ddd; }
    .hdr { background:#b4222d; color:#fff; padding:20px 28px; font-size:21px; font-weight:bold; }
    .body { padding:24px 28px; font-size:15px; color:#222; line-height:1.55; }
    .ref { color:#666; font-size:13px; margin-bottom:18px; }
    .seg { border-left:4px solid #b4222d; background:#faf7f7; padding:14px 18px; margin-bottom:14px; }
    .seg h3 { font-size:16px; margin-bottom:6px; color:#b4222d; }
    .seg .when { font-weight:bold; }
    .hotel { border-left:4px solid #2a6f4e; background:#f4faf7; padding:14px 18px; }
    .hotel h3 { font-size:16px; margin-bottom:6px; color:#2a6f4e; }
    p { margin:4px 0; }
  </style></head><body><div class="card">
    <div class="hdr">Trip Confirmation — Saved to your account</div>
    <div class="body">
      <div class="ref">Booking reference: QK7X2P &nbsp;·&nbsp; Traveler: Jordan Smith</div>
      <div class="seg">
        <h3>✈ Departure</h3>
        <p class="when">Sunday, March 22, 2026 — departs 8:15 AM</p>
        <p>Flight AA 1204 · Austin (AUS) → Denver (DEN) · arrives 9:45 AM</p>
        <p>Gate 14, seat 23C, boarding zone 2</p>
      </div>
      <div class="seg">
        <h3>✈ Return</h3>
        <p class="when">Friday, March 27, 2026 — departs 5:20 PM</p>
        <p>Flight AA 1205 · Denver (DEN) → Austin (AUS) · arrives 7:05 PM</p>
        <p>Gate 7, seat 12A, boarding zone 3</p>
      </div>
      <div class="hotel">
        <h3>🏨 Hotel</h3>
        <p class="when">Check-in Sunday, March 22, 2026 at 3:00 PM (checkout March 27, 11:00 AM)</p>
        <p>Summit Lodge · 45 Aspen Road, Breckenridge, CO 80424 · confirmation 88214</p>
      </div>
    </div>
  </div></body></html>`,

  "party-flyer.html": `<!doctype html><html><head><meta charset="utf-8"><style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { width:700px; height:900px; font-family:'Marker Felt','Chalkboard SE','Bradley Hand',cursive; background:#fffbe8; display:flex; align-items:center; justify-content:center; }
    .flyer { width:560px; border:4px solid #d4569b; border-radius:20px; padding:40px 36px; text-align:center; color:#4a2c6b; transform:rotate(-1.5deg); }
    h1 { font-size:40px; color:#d4569b; margin-bottom:16px; }
    .line { font-size:26px; margin:14px 0; }
    .small { font-size:20px; color:#776; margin-top:22px; }
  </style></head><body><div class="flyer">
    <h1>Jamie's Birthday Bash!</h1>
    <div class="line">Saturday, March 21</div>
    <div class="line">6 PM 'til late</div>
    <div class="line">47 Cypress Lane</div>
    <div class="line">(backyard — look for the balloons)</div>
    <div class="small">Bring a dish to share! RSVP Dana 555-0142</div>
  </div></body></html>`,

  // Negative controls — documents with dates/times but NO events to attend.
  "grocery-receipt.html": `<!doctype html><html><head><meta charset="utf-8"><style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { width:560px; font-family:'Courier New',monospace; background:#fff; padding:40px 0; }
    .receipt { width:420px; margin:0 auto; font-size:16px; line-height:1.7; }
    .center { text-align:center; }
    .bold { font-weight:bold; }
    .row { display:flex; justify-content:space-between; }
    .rule { border-top:1px dashed #999; margin:10px 0; }
  </style></head><body><div class="receipt">
    <div class="center bold">WHOLE FOODS MARKET</div>
    <div class="center">221 Market Street, Austin, TX</div>
    <div class="center">Tel (512) 555-0199</div>
    <div class="rule"></div>
    <div class="row"><span>2 ORG BANANAS</span><span>1.78</span></div>
    <div class="row"><span>1 GAL WHOLE MILK</span><span>4.99</span></div>
    <div class="row"><span>SOURDOUGH LOAF</span><span>5.49</span></div>
    <div class="row"><span>CHICKEN BREAST 1.2LB</span><span>8.94</span></div>
    <div class="row"><span>SPINACH BABY 10OZ</span><span>3.49</span></div>
    <div class="rule"></div>
    <div class="row bold"><span>SUBTOTAL</span><span>24.69</span></div>
    <div class="row"><span>TAX 8.25%</span><span>2.04</span></div>
    <div class="row bold"><span>TOTAL</span><span>26.73</span></div>
    <div class="rule"></div>
    <div class="center">VISA ****4021&nbsp;&nbsp;APPROVED</div>
    <div class="center">03/12/2026&nbsp;&nbsp;14:22&nbsp;&nbsp;REG 04</div>
    <div class="center">THANK YOU FOR SHOPPING</div>
  </div></body></html>`,

  "news-article.html": `<!doctype html><html><head><meta charset="utf-8"><style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { width:840px; font-family:Georgia,serif; background:#fdfcf8; padding:48px 56px; }
    h1 { font-size:34px; line-height:1.2; color:#111; }
    .byline { color:#777; font-size:14px; margin:14px 0 24px; font-family:Helvetica,Arial,sans-serif; }
    p { font-size:17px; line-height:1.65; color:#222; margin-bottom:16px; }
  </style></head><body>
    <h1>City Council Approves Downtown Transit Expansion After Yearlong Debate</h1>
    <div class="byline">By Maria Castellanos | March 9, 2026 | The Austin Ledger</div>
    <p>The city council voted 8-3 late Monday to approve the $480 million downtown transit expansion, ending a yearlong dispute over funding and routing.</p>
    <p>Under the approved plan, construction on the new bus rapid transit corridor will begin next spring, with the first segment expected to open in 2029. Officials project the corridor will carry 42,000 riders a day once complete.</p>
    <p>Opponents argued the project would displace dozens of small businesses along Congress Avenue. Supporters pointed to rising congestion and the city's rapidly growing population.</p>
    <p>The transit authority will host a series of community meetings in the coming months to gather resident input on station design and landscaping.</p>
  </body></html>`,
};

for (const [name, html] of Object.entries(htmls)) {
  const htmlPath = join(htmlDir, name);
  if (!existsSync(htmlPath)) {
    // writeFileSync lazily imported
    (await import("node:fs")).writeFileSync(htmlPath, html);
  }
}

// PNG renders
shoot("ticket-concert.html", "ticket-concert.png", 720, 960);
shoot("class-schedule.html", "class-schedule.png", 900, 460, 2);
shoot("itinerary-email.html", "itinerary-email.png", 760, 900);
shoot("party-flyer.html", "party-flyer.png", 700, 900);
shoot("grocery-receipt.html", "grocery-receipt.png", 560, 560);
shoot("news-article.html", "news-article.png", 840, 720);

// PDF render of the itinerary
chrome([
  "--headless=new",
  "--disable-gpu",
  "--no-pdf-header-footer",
  `--print-to-pdf=${join(dir, "itinerary-email.pdf")}`,
  `file://${join(htmlDir, "itinerary-email.html")}`,
]);

// WebP variant of the ticket (tests the format Z.ai rejects)
try {
  execFileSync("/usr/bin/sips", [
    "-s",
    "format",
    "webp",
    join(dir, "ticket-concert.png"),
    "--out",
    join(dir, "ticket-concert.webp"),
  ]);
} catch {
  console.warn("sips could not write webp — skipping .webp sample");
}

const files = readdirSync(dir).filter((f) => !f.endsWith(".html"));
for (const f of files) {
  const size = statSync(join(dir, f)).size;
  console.log(`  ${f.padEnd(28)} ${(size / 1024).toFixed(1)} KB`);
}
