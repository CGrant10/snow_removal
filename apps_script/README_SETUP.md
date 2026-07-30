# Reservations into a Google Sheet

Fifteen minutes, no server, no cost. When you're done, every request from
the form lands as a row in a spreadsheet and you get an email (and a text,
if you want one).

The Sheet **is** the admin page for now: sort it, filter it, share it with a
driver, work it from the Sheets app on your phone.

---

## 1. Make the Sheet

1. Go to [sheets.new](https://sheets.new). Name it something like
   *Snow Reservations 2026*.
2. **Extensions → Apps Script**. A code editor opens in a new tab.
3. Delete the `function myFunction() {}` stub that's already there.
4. Paste in the entire contents of [Code.gs](Code.gs).

## 2. Set your notification addresses

At the top of the pasted code, edit `SETTINGS`:

```js
NOTIFY_EMAIL: 'his.real.address@gmail.com',
NOTIFY_SMS:   '7015550134@vtext.com',   // or '' for no text
```

Carrier email-to-SMS addresses:

| Carrier  | Format                   |
|----------|--------------------------|
| Verizon  | `7015550134@vtext.com`   |
| AT&T     | `7015550134@txt.att.net` |
| T-Mobile | `7015550134@tmomail.net` |

Save (the disk icon, or Ctrl+S).

## 3. Run `setup()` once

1. In the toolbar, pick **setup** from the function dropdown, then **Run**.
2. Google asks for authorization the first time. Choose your account →
   **Advanced** → **Go to (project name)** → **Allow**. The "unverified app"
   warning is expected: the app is *yours*, and Google has no reason to have
   reviewed it.
3. Switch back to the Sheet. You'll have a **Reservations** tab with a bold
   header row, frozen panes, and a **Status** dropdown in column C.

## 4. Deploy it as a web app

1. **Deploy → New deployment**.
2. Gear icon → **Web app**.
3. Set:
   - **Execute as: Me** — so the script can write to *your* Sheet.
   - **Who has access: Anyone** — so a customer who isn't logged into Google
     can submit. This is required; the form is public.
4. **Deploy**, then **copy the Web app URL**. It ends in `/exec`.

> **"Anyone" does not make your Sheet public.** It only means anyone can
> *call this script*. The script only ever appends a row — it never returns
> your data. Nobody can read the Sheet without you sharing it with them.

## 5. Point the form at it

In [../config.js](../config.js):

```js
delivery: {
  mode: "gsheet",
  gsheet: {
    url: "https://script.google.com/macros/s/AKfy.../exec",
    sharedSecret: "",
  },
},
```

Push, submit a test reservation, and watch the row appear.

---

## Checking it works

Open the `/exec` URL in a browser. You should see:

```json
{"ok":true,"service":"snow-reservations"}
```

If you get an error page instead, the deployment settings are wrong — go
back to step 4 and check **Execute as: Me** and **Access: Anyone**.

## When you change Code.gs

Apps Script keeps serving the *deployed* version, not what's in the editor.
After editing you must **Deploy → Manage deployments → pencil icon → Version:
New version → Deploy**. Same URL, new code. This trips up everyone once.

## Turning on the job board (admin.html)

The repo ships a staff page — filterable job board, tap-to-call, status
changes — at `admin.html`. To switch it on, set a passphrase in `Code.gs`:

```js
ADMIN_PASSPHRASE: 'something-long-you-do-not-reuse',
```

Deploy a new version (see the section above — editing alone does nothing),
then open `admin.html` and sign in with it. Leave the setting empty and the
admin endpoints refuse every request, which is the right default.

**Know what this is.** Anyone with the `/exec` URL and that passphrase can
read every customer's name, address, and phone number. Wrong guesses get a
short delay, but there's no real rate limiting and no audit trail. For one
truck that's a fair trade — just make the passphrase long and don't reuse it.

**The stronger version, still free:** create a *second* Apps Script project
bound to the same Sheet with only the admin actions, and deploy that one with
**Access: Only myself** (or your organization). Google's login becomes the
gate, the public form keeps its own anonymous deployment, and no passphrase
exists to leak. Point `admin.js` at that second URL.

## Adding an admin

Two ways, depending on whether they need the job board:

- **Just the data:** share the Sheet like any other Google file (**Share**,
  top right). Editor access lets them change Status and add notes. Google
  handles who they are — no accounts to build, no passwords to store.
- **The job board:** give them the passphrase. Everyone shares one, so
  changing it signs everybody out.

## Blocking bots

A public form will eventually get junk. Options, cheapest first:

1. Set a `SHARED_SECRET` in `Code.gs` and the matching `sharedSecret` in
   `config.js`. Stops dumb scrapers. It's readable in the page source, so
   it will not stop anyone who looks.
2. Add a honeypot field to the form (a hidden input real people never fill).
3. Move to Cloudflare Turnstile or reCAPTCHA if it becomes a real problem.

## Limits

Consumer Gmail accounts can send about 100 emails a day from Apps Script
(Workspace accounts get more). Each reservation uses one, plus one more if
you enabled the text. That's a lot of driveways — but if he ever hits it,
the row still lands in the Sheet; only the notification is dropped.
