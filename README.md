# Snow removal reservations — skeleton

A five-step reservation form. Customer picks services, describes the property,
picks a schedule, leaves contact info, reviews a ballpark estimate, and sends.
No accounts, no payments, no database — just a well-structured request that
lands somewhere you'll actually see it.

```
index.html    the form
styles.css    dark/light styling
config.js     ← everything you'd want to change lives here
app.js        form logic + the delivery adapters
server.py     optional backend: logs to JSONL, emails/texts you
```

## Run it

Static, no build step:

```bash
python -m http.server 8123 --directory snow_removal
```

Or with the backend (also serves the form):

```bash
python snow_removal/server.py
```

Open http://localhost:8123.

## Layout

One codebase, two layouts, switching at 900px:

- **Mobile** — full-width steps, a sticky header with a tap-to-call button, a
  progress hairline, and a fixed bottom bar carrying Back / running estimate /
  Continue.
- **Desktop** — a navy sidebar with the brand, a numbered stepper that checks
  off as you go, the running estimate, trust points, and the phone number;
  the form sits beside it as a floating card with inline nav buttons.

Light theme by default because it reads as more trustworthy on a booking
form; dark follows the visitor's system setting. Both are styled deliberately,
and `prefers-reduced-motion` is honored.

**Icons are a custom inline SVG sprite** at the top of `index.html` — no emoji,
no icon library, nothing that shows up in every other app. They are monoline,
24×24, stroke-only, and inherit `currentColor`, so one CSS `color` restyles
any of them. To add one: drop a new `<symbol id="i-yourname">` in the sprite
and reference it from `config.js` as `icon: "yourname"`. The favicon is the
same crystal mark inlined as a data URI.

## Configuring the business

Everything your buddy will want to tweak is in [config.js](config.js):
business name and phone, the service list and prices, driveway size tiers and
their multipliers, surfaces, plans (one-time / auto per-visit / season
contract), trigger depths, time windows, and the "anything we should know"
checkboxes. Add a service by appending one object to `services`; the UI and the
estimate pick it up automatically.

The estimate is deliberately labeled a ballpark, not a quote — the form never
commits to a price and never takes payment.

---

## Where do the requests go?

`config.js → delivery.mode` picks one adapter. All of them are already written
in [app.js](app.js).

### 1. `mailto` — zero setup, zero cost

Opens the customer's own email app with everything pre-filled. Works instantly,
costs nothing, needs no account. Downside: the customer has to hit send in
their mail app, and some people bail there. Fine for day one; you'll outgrow it.

### 2. `web3forms` — the one I'd start with

Free form-to-email service. Sign up at web3forms.com, paste the access key into
`config.js`, done. No server, no backend, works on GitHub Pages or Netlify.
Reservations land in your inbox as readable text.

**Getting a text too:** most carriers have an email-to-SMS gateway. Set
`ccSmsGateway` to your number at your carrier's domain and the same email
arrives as a text, free:

| Carrier  | Address format          |
|----------|-------------------------|
| Verizon  | `7015550134@vtext.com`  |
| AT&T     | `7015550134@txt.att.net`|
| T-Mobile | `7015550134@tmomail.net`|

Gateways truncate long messages and occasionally get filtered — good enough for
"you got a job," not for the full details.

### 3. `formspree` — same idea, different vendor

Free tier is smaller (50/month) but the dashboard is nicer and it keeps a
searchable archive of submissions. Paste your form URL into `config.js`.

### 4. `gsheet` — reservations land in a Google Sheet

**The one to move to once there are enough jobs to lose track of.** Every
request appends a row to a spreadsheet and emails (and optionally texts) you.
The Sheet becomes the job board: sort it, filter it by service or trigger
depth, share it with a driver, work it from the Sheets app on his phone.

Setup — about fifteen minutes, no server, no cost — is in
[apps_script/README_SETUP.md](apps_script/README_SETUP.md). The script itself
is [apps_script/Code.gs](apps_script/Code.gs); `setup()` builds the header
row, freezes the panes, and adds a Status dropdown
(New / Quoted / Scheduled / Done / Declined).

**Adding an admin is just sharing the Sheet.** Google handles who they are —
no accounts to build, no passwords to store.

Two things that trip everyone up once, both covered in the setup doc:
deploying with **Access: Anyone** (required — it lets the script be *called*,
it does not make the Sheet public), and remembering that editing `Code.gs`
does nothing until you deploy a **new version**.

### 5. `webhook` — anything you control

POSTs the JSON payload to a URL. Two good targets:

**`server.py` (included).** Appends every reservation to `reservations.jsonl`
and, if you set the SMTP environment variables, emails and/or texts you. Runs
on the free tier of Render/Railway/Fly, or on a spare machine. Env vars are
documented at the top of [server.py](server.py). Gmail needs an *app password*,
not your account password.

**Zapier / Make.** Catch Hook trigger, then fan out to email, SMS, Slack,
Google Calendar, whatever. Costs money past the free tier but requires no code.

### Real SMS (Twilio) — a note

Twilio can text you properly (no truncation, no carrier filtering), but the API
key can never live in `config.js` — anything in the browser is public. It has
to go through a server: form → `server.py` (or an Apps Script/Cloud Function) →
Twilio. Also, US A2P 10DLC registration takes a few days and costs a few dollars
a month. Start with the email-to-SMS gateway; move to Twilio when the volume
justifies it.

---

## What this skeleton deliberately does *not* do

Worth naming so nobody's surprised:

- **No payments.** Adding Stripe means a real backend and PCI scope.
- **No accounts or login.** Every submission is a fresh request. With the
  `gsheet` path, "admin" means someone you shared the Sheet with — Google is
  the login. Real customer accounts and a purpose-built dashboard need a
  backend with auth (Supabase is the cheap way in).
- **No calendar/capacity.** The form will happily accept twelve jobs for the
  same pre-dawn window. Add capacity checks when the backend is real.
- **No confirmation to the customer.** They get a reference number on screen.
  Sending them an actual confirmation email needs the backend path (#4) or a
  Formspree autoresponse.
- **No photo upload.** Needs file storage.
- **No spam protection.** A public form gets bots. Web3Forms and Formspree
  include honeypot/captcha options — turn them on before it goes live.

## Suggested next steps, in order

1. Fill in real services and prices in `config.js`.
2. Switch `delivery.mode` to `web3forms`, add the SMS gateway, test on a phone.
3. Put it on Netlify or GitHub Pages with a real domain.
4. When there are enough jobs to lose track of, switch to `gsheet` so there's
   a spreadsheet of record and somewhere to track status.
5. Run a real season on the Sheet. Whatever annoys him about it is the spec
   for a real dashboard — build the right thing instead of guessing.
6. Only then consider a backend with auth, a calendar, customer accounts, and
   route planning.
