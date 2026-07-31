/**
 * Snow removal reservations — Google Sheets backend.
 *
 * Receives a reservation from the form, appends it as a row, and notifies
 * you by email (and optionally text). The Sheet is the job board: sort it,
 * filter it, share it with a driver, work it from your phone.
 *
 * Setup is in README_SETUP.md, next to this file. Short version:
 *   new Sheet -> Extensions -> Apps Script -> paste this -> run setup()
 *   -> Deploy -> Web app -> Execute as ME, Access ANYONE -> copy the URL
 *   -> paste it into config.js as delivery.gsheet.url and set mode "gsheet".
 */

/* ============================== SETTINGS ============================== */

var SETTINGS = {
  // Tab the rows land on. setup() creates it.
  SHEET_NAME: 'Reservations',

  // Tab holding the live settings and the customer alert. Key/value, one
  // row each, so you can read or fix it straight in the Sheet.
  SETTINGS_SHEET: 'Settings',

  // Admin accounts and their live sign-ins.
  ADMINS_SHEET: 'Admins',
  SESSIONS_SHEET: 'Sessions',

  // Least stretching this script will accept from a browser. The rounds
  // are done in the browser with WebCrypto, not here — see the note above
  // proofHash_() for why — so this is only a floor to stop a hand-rolled
  // client registering a barely-stretched password.
  MIN_ROUNDS: 50000,

  // Sign-in throttling. Six wrong guesses parks the account for a while.
  MAX_FAILED: 6,
  LOCKOUT_MINUTES: 15,

  // How long "stay signed in" lasts. Without it, the token dies with the
  // tab (the browser drops it, not the server).
  SESSION_DAYS: 30,

  // Where the "new reservation" email goes. Leave '' for no email.
  NOTIFY_EMAIL: 'grantcole7@gmail.com',

  // Optional carrier email-to-SMS address for a text, e.g.
  // '7015550134@vtext.com' (Verizon), '@txt.att.net', '@tmomail.net'.
  NOTIFY_SMS: '',

  // Optional. If set, must match delivery.gsheet.sharedSecret in config.js.
  // Keeps casual bots out. It ships in the page source, so it is a speed
  // bump, not real security.
  SHARED_SECRET: '',

  // TESTING PASSPHRASE — this file is in a public git repo, so treat this
  // as public knowledge. Fine while nothing real is in the Sheet; change it
  // before any actual customer data lands.
  //
  // To use a private one, add a Script Property instead of editing here:
  //   Apps Script editor -> Project Settings (gear)
  //   -> Script Properties -> Add: ADMIN_PASSPHRASE = your-passphrase
  // A Script Property always wins over this value and never touches the repo.
  ADMIN_PASSPHRASE: 'snowadmin1',

  // Status values offered as a dropdown in column C.
  STATUSES: ['New', 'Quoted', 'Scheduled', 'Done', 'Declined'],
};

/**
 * Reads a setting, preferring a Script Property over the constant above.
 *
 * Script Properties live in your Google account, so secrets stay out of the
 * repo. Anything set there wins; SETTINGS is the fallback for the values
 * that are not sensitive.
 */
function setting(name) {
  try {
    var v = PropertiesService.getScriptProperties().getProperty(name);
    if (v !== null && v !== '') return v;
  } catch (err) {
    // Properties unavailable (rare) — fall through to the constant.
  }
  return SETTINGS[name];
}

/* ============================ SHEET LAYOUT ============================ */

var COLUMNS = [
  'Received',
  'Reference',
  'Status',
  'Name',
  'Phone',
  'Email',
  'Text OK',
  'Address',
  'City',
  'ZIP',
  'Services',
  'Plan',
  'Trigger',
  'Start date',
  'Time of day',
  'Driveway',
  'Surface',
  'Flags',
  'Snow goes',
  'Crew notes',
  'Estimate',
  'Estimate basis',
  'Office notes',
];

/**
 * Run this once from the Apps Script editor before deploying.
 * Creates the tab, writes the header, freezes it, and adds the status
 * dropdown. Safe to run again — it will not touch existing rows.
 */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SETTINGS.SHEET_NAME) ||
              ss.insertSheet(SETTINGS.SHEET_NAME);

  sheet.getRange(1, 1, 1, COLUMNS.length)
       .setValues([COLUMNS])
       .setFontWeight('bold')
       .setBackground('#10233f')
       .setFontColor('#ffffff');

  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(2);

  // Status dropdown down the whole column.
  var rule = SpreadsheetApp.newDataValidation()
      .requireValueInList(SETTINGS.STATUSES, true)
      .setAllowInvalid(false)
      .build();
  sheet.getRange(2, 3, sheet.getMaxRows() - 1, 1).setDataValidation(rule);

  sheet.autoResizeColumns(1, COLUMNS.length);


  settingsSheet_();          // create the Settings tab too, if it's missing
  adminsSheet_();
  sessionsSheet_();
  ensureMaster_();           // ADMIN_PASSPHRASE becomes the 'owner' master

  SpreadsheetApp.getUi().alert(
      'Ready. Sign in to the board as "owner" with ADMIN_PASSPHRASE — it ' +
      'will make you change it. Now deploy: Deploy > New deployment > ' +
      'Web app, Execute as ME, Access ANYONE.');
}

/* ============================== SETTINGS TAB ==========================
   Flat key/value rows. An empty Settings tab means "use whatever is in
   config.js" — the app treats every key as an override, so anything not
   listed here simply falls through to the shipped default.

   Keys the app understands:
     biz.name  biz.phone  biz.email  biz.serviceArea  biz.tagline
     biz.hours     biz.trust          pipe-separated list
     price.<serviceId>                base price, e.g. price.driveway
     size.<sizeId>                    driveway multiplier, e.g. size.2car
     seasonMonthlyFactor
     alert.id  alert.message  alert.tone  alert.until   (ISO 8601)
   ====================================================================== */

function settingsSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SETTINGS.SETTINGS_SHEET);
  if (!sh) {
    sh = ss.insertSheet(SETTINGS.SETTINGS_SHEET);
    sh.getRange(1, 1, 1, 2)
      .setValues([['Key', 'Value']])
      .setFontWeight('bold')
      .setBackground('#10233f')
      .setFontColor('#ffffff');
    sh.setFrozenRows(1);
    sh.setColumnWidth(1, 200);
    sh.setColumnWidth(2, 520);
  }
  return sh;
}

/**
 * What the `settings` action returns, cached across requests.
 *
 * Both apps ask for this on every load and again whenever the window
 * regains focus, and the answer changes maybe twice a season. 30 seconds
 * is short enough that publishing an alert still feels immediate — and a
 * write clears the cache anyway, so the board never sees its own save go
 * missing.
 */
function settingsPayload_() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('settings');
  if (hit) {
    try { return JSON.parse(hit); } catch (err) { /* rewrite it below */ }
  }

  var s = readSettings_();
  var payload = {
    ok: true,
    settings: publicSettings_(s),
    alert: activeAlert_(s),
  };

  // An alert expiring sooner than the cache would outlive its own window,
  // so shorten the cache to match.
  var ttl = 30;
  if (payload.alert && payload.alert.until) {
    var left = Math.floor(
        (new Date(payload.alert.until).getTime() - Date.now()) / 1000);
    if (left > 0 && left < ttl) ttl = left;
  }

  try { cache.put('settings', JSON.stringify(payload), ttl); } catch (err) {}
  return payload;
}

function dropSettingsCache_() {
  try { CacheService.getScriptCache().remove('settings'); } catch (err) {}
  forget_('settings');
}

/** Every stored key as a flat map of strings. */
function readSettings_() {
  return memo_('settings', loadSettings_);
}

function loadSettings_() {
  var values = settingsSheet_().getDataRange().getValues();
  var out = {};
  for (var i = 1; i < values.length; i++) {
    var key = String(values[i][0] || '').trim();
    if (!key) continue;
    var v = values[i][1];
    out[key] = (v instanceof Date) ? v.toISOString() : String(v);
  }
  return out;
}

/** Merge a patch over what's stored and rewrite the tab. Empty string
    deletes a key, which is how "back to the config.js default" works. */
function writeSettings_(patch) {
  var sh = settingsSheet_();
  var merged = readSettings_();

  Object.keys(patch || {}).forEach(function (k) {
    var v = patch[k];
    if (v === null || v === undefined || String(v) === '') delete merged[k];
    else merged[k] = String(v);
  });

  var keys = Object.keys(merged).sort();
  var rows = Math.max(sh.getMaxRows() - 1, 1);
  sh.getRange(2, 1, rows, 2).clearContent();
  if (keys.length) {
    sh.getRange(2, 1, keys.length, 2).setValues(keys.map(function (k) {
      return [k, merged[k]];
    }));
  }

  dropSettingsCache_();
  MEMO_['settings'] = merged;      // this request already knows the answer
  return merged;
}

/** The alert, but only while it's inside its window. Expiry is decided
    here rather than in the browser, so a wrong clock on a customer's
    phone can't keep a stale storm notice on screen. */
function activeAlert_(s) {
  if (!s['alert.message']) return null;

  var until = s['alert.until'];
  if (until) {
    var end = new Date(until).getTime();
    if (!isNaN(end) && end <= Date.now()) return null;
  }

  return {
    id: s['alert.id'] || '',
    message: s['alert.message'],
    tone: s['alert.tone'] || 'info',
    until: until || '',
  };
}

/** Settings minus the alert keys, which travel separately. */
function publicSettings_(s) {
  var out = {};
  Object.keys(s).forEach(function (k) {
    if (k.indexOf('alert.') !== 0) out[k] = s[k];
  });
  return out;
}

/* ============================== ENDPOINT ============================== */

/** Health check — open the /exec URL in a browser to see this. */
function doGet() {
  return json({ ok: true, service: 'snow-reservations' });
}

/**
 * Everything posts here.
 *
 *   Anonymous
 *     (none)        a customer submitting the public form
 *     settings      either app reading live settings + the alert. The
 *                   customer portal has no account and still needs these.
 *     signIn        username + password, in exchange for a session token
 *
 *   Any signed-in admin (token)
 *     session       who am I — restores a sign-in without a password
 *     signOut       drop this one device's token
 *     changePassword
 *     list          load the job board
 *     update        change a status or an office note
 *
 *   Master only (token + role)
 *     saveSettings  business info and prices
 *     publishAlert / clearAlert
 *     listAdmins / createAdmin / deleteAdmin
 *     setAdminActive / resetAdminPassword
 */
/** Actions that only read. These skip the lock — see doPost. */
var READ_ONLY = [
  'settings', 'authSalt', 'session', 'list', 'listAdmins',
];

function doPost(e) {
  MEMO_ = {};                  // nothing carries over between requests

  if (!e || !e.postData || !e.postData.contents) {
    return json({ ok: false, error: 'empty body' });
  }

  var p;
  try {
    p = JSON.parse(e.postData.contents);
  } catch (err) {
    return json({ ok: false, error: 'bad body' });
  }

  // The lock exists so two customers submitting at once can't land on the
  // same row. It used to wrap every request, which meant the board's
  // polling queued behind a form submission and vice versa — with a
  // 20-second wait, that alone could account for a page that "just
  // loads". Reads don't need it.
  var lock = null;
  if (READ_ONLY.indexOf(p.action) === -1) {
    lock = LockService.getScriptLock();
    try {
      lock.waitLock(20000);
    } catch (err) {
      return json({ ok: false, error: 'busy, try again' });
    }
  }

  try {
    // ---- anonymous: both apps reading settings + the current alert ----
    // Hit on every page load of both apps and again on window focus, so
    // it's served from a short cache rather than reading the Sheet each
    // time. Writes drop the cache, so the board still sees its own save
    // immediately.
    if (p.action === 'settings') return json(settingsPayload_());

    // ---- signing in: the only admin actions without a token ----
    if (p.action === 'authSalt') return handleAuthSalt(p);
    if (p.action === 'signIn') return handleSignIn(p);

    // ---- everything else admin-side runs on a session token ----
    var ANY_ADMIN = ['list', 'update', 'session', 'signOut', 'changePassword'];
    var MASTER_ONLY = [
      'saveSettings', 'publishAlert', 'clearAlert',
      'listAdmins', 'createAdmin', 'deleteAdmin',
      'setAdminActive', 'resetAdminPassword',
    ];

    if (ANY_ADMIN.indexOf(p.action) !== -1 ||
        MASTER_ONLY.indexOf(p.action) !== -1) {

      ensureMaster_();
      var me = authFromToken_(p.token);
      if (!me) {
        // 'signedOut' specifically, so the board can drop to the sign-in
        // form instead of showing a red error over a stale page.
        return json({ ok: false, error: 'signedOut' });
      }

      // A forced password change blocks everything except changing it.
      if (me.mustChange && p.action !== 'changePassword' &&
          p.action !== 'session' && p.action !== 'signOut') {
        return json({ ok: false, error: 'mustChange' });
      }

      if (MASTER_ONLY.indexOf(p.action) !== -1 && me.role !== 'master') {
        return json({ ok: false, error: 'that needs a master account' });
      }

      if (p.action === 'session') return handleSession(me);
      if (p.action === 'signOut') return handleSignOut(p);
      if (p.action === 'changePassword') return handleChangePassword(p, me);
      if (p.action === 'list') return handleList(p);
      if (p.action === 'update') return handleUpdate(p);
      if (p.action === 'saveSettings') return handleSaveSettings(p);
      if (p.action === 'publishAlert') return handlePublishAlert(p);
      if (p.action === 'clearAlert') return handleClearAlert();
      if (p.action === 'listAdmins') return handleListAdmins();
      if (p.action === 'createAdmin') return handleCreateAdmin(p);
      if (p.action === 'deleteAdmin') return handleDeleteAdmin(p, me);
      if (p.action === 'setAdminActive') return handleSetAdminActive(p, me);
      return handleResetAdminPassword(p);
    }

    // ---- anonymous: a customer submitting the form ----
    var secret = setting('SHARED_SECRET');
    if (secret && p.secret !== secret) {
      return json({ ok: false, error: 'bad secret' });
    }

    var customer = p.customer || {};
    if (!customer.name || !customer.phone) {
      return json({ ok: false, error: 'name and phone required' });
    }

    var sheet = SpreadsheetApp.getActiveSpreadsheet()
                              .getSheetByName(SETTINGS.SHEET_NAME);
    if (!sheet) return json({ ok: false, error: 'run setup() first' });

    sheet.appendRow(rowFrom(p));
    notify(p);

    return json({ ok: true, reference: p.reference });
  } catch (err) {
    // Surfaces in Apps Script > Executions if something goes wrong.
    console.error(err);
    return json({ ok: false, error: String(err) });
  } finally {
    if (lock) lock.releaseLock();
  }
}

/* ============================ ADMIN ACTIONS =========================== */

function adminSheet() {
  return SpreadsheetApp.getActiveSpreadsheet()
                       .getSheetByName(SETTINGS.SHEET_NAME);
}

/** Every reservation, newest first, as objects keyed by column name. */
function handleList(p) {
  var sheet = adminSheet();
  if (!sheet) return json({ ok: false, error: 'run setup() first' });

  var values = sheet.getDataRange().getValues();
  if (values.length < 2) {
    return json({ ok: true, columns: COLUMNS, reservations: [] });
  }

  var head = values.shift();
  var rows = values.map(function (r, i) {
    var o = { _row: i + 2 };            // sheet row, for updates
    head.forEach(function (h, j) {
      var v = r[j];
      o[h] = (v instanceof Date) ? v.toISOString() : v;
    });
    return o;
  });

  rows.reverse();                        // newest first
  var limit = Math.min(Number(p.limit) || 300, 1000);

  return json({
    ok: true,
    columns: head,
    statuses: SETTINGS.STATUSES,
    total: rows.length,
    reservations: rows.slice(0, limit),
  });
}

/** Change the status and/or office notes on one reservation. */
function handleUpdate(p) {
  var sheet = adminSheet();
  if (!sheet) return json({ ok: false, error: 'run setup() first' });
  if (!p.reference) return json({ ok: false, error: 'no reference' });

  if (p.status && SETTINGS.STATUSES.indexOf(p.status) === -1) {
    // STATUSES stays a constant — it has to match the Sheet's dropdown.
    return json({ ok: false, error: 'unknown status' });
  }

  var refCol = COLUMNS.indexOf('Reference') + 1;
  var refs = sheet.getRange(2, refCol, Math.max(sheet.getLastRow() - 1, 1), 1)
                  .getValues();

  for (var i = 0; i < refs.length; i++) {
    if (refs[i][0] !== p.reference) continue;

    var row = i + 2;
    if (p.status) {
      sheet.getRange(row, COLUMNS.indexOf('Status') + 1).setValue(p.status);
    }
    if (typeof p.officeNotes === 'string') {
      sheet.getRange(row, COLUMNS.indexOf('Office notes') + 1)
           .setValue(p.officeNotes);
    }
    return json({ ok: true, reference: p.reference, row: row });
  }

  return json({ ok: false, error: 'reference not found' });
}

/* ============================== ACCOUNTS ==============================
   Two tabs. Admins holds one row per person; Sessions holds one row per
   signed-in device, so signing out one phone doesn't touch the others.

   Passwords are never stored. Each account gets a random salt and a
   stretched hash, and only the hash is written down. Session tokens get
   the same treatment: the browser holds the token, the Sheet holds its
   SHA-256, so a leaked Sheet doesn't hand over live sessions.

   Worth being plain about the ceiling: the /exec endpoint is public, and
   anyone with edit access to this Spreadsheet can add themselves an
   account regardless of any of this. It's real auth for a small crew,
   not a fortress.
   ====================================================================== */

var ADMIN_COLUMNS = [
  'Username', 'Role', 'Salt', 'Hash', 'Rounds', 'Must change',
  'Active', 'Created', 'Last seen', 'Failed', 'Locked until',
];
var SESSION_COLUMNS = ['Token hash', 'Username', 'Created', 'Expires'];

/* ---------------------------------------------------------- per-request
   Everything below is re-read constantly within a single request —
   ensureMaster_ and findAdmin_ alone used to pull the Admins tab twice
   before doing any work. Each getSheetByName/getDataRange is a call out
   to the Sheets service, and they add up to whole seconds. This holds
   them for the life of one request and nothing longer.               */
var MEMO_ = {};

function memo_(key, make) {
  if (!(key in MEMO_)) MEMO_[key] = make();
  return MEMO_[key];
}

function forget_(key) { delete MEMO_[key]; }

function tab_(name, columns, widths) {
  return memo_('tab:' + name, function () { return makeTab_(name, columns, widths); });
}

function makeTab_(name, columns, widths) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, columns.length)
      .setValues([columns])
      .setFontWeight('bold')
      .setBackground('#10233f')
      .setFontColor('#ffffff');
    sh.setFrozenRows(1);
    if (widths) widths.forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  }
  return sh;
}

function adminsSheet_() {
  return tab_(SETTINGS.ADMINS_SHEET, ADMIN_COLUMNS, [160, 90, 240, 320, 80]);
}
function sessionsSheet_() {
  return tab_(SETTINGS.SESSIONS_SHEET, SESSION_COLUMNS, [340, 160, 180, 180]);
}

/* ---------------------------------------------------------- crypto */

function randomToken_() {
  // Two UUIDs of entropy, hex only so it survives being pasted anywhere.
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
}

function sha256_(text) {
  return Utilities.base64Encode(
      Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text));
}

/**
 * The stretching happens in the BROWSER, not here.
 *
 * This script used to iterate HMAC-SHA256 a few thousand times to slow
 * down offline guessing. That was a mistake: each Utilities call is a
 * round trip to a Java service, not local arithmetic, so a few thousand
 * of them ran for long enough to hit "Exceeded maximum execution time"
 * and no one could sign in at all.
 *
 * So the browser does PBKDF2 with WebCrypto — 200,000 rounds costs a
 * phone about a tenth of a second — and sends the derived key as a
 * "proof". This function is all the server does with it: one digest,
 * a couple of milliseconds.
 *
 * The proof is password-equivalent in flight, which is fine over HTTPS,
 * and it is never what gets stored — the digest is. So a leaked Sheet
 * still yields nothing you can sign in with, and the stretching is now
 * far heavier than anything Apps Script could have afforded.
 */
function proofHash_(proof) {
  return sha256_(String(proof || ''));
}

/**
 * A stable, unguessable salt for a username that has no account, so the
 * salt lookup can't be used to find out who does. Same username always
 * gets the same answer; nobody can predict it without the script secret.
 */
function decoySalt_(username) {
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty('SALT_SECRET');
  if (!secret) {
    secret = randomToken_();
    props.setProperty('SALT_SECRET', secret);
  }
  return Utilities.base64Encode(
      Utilities.computeHmacSha256Signature(
          String(username).toLowerCase(), secret));
}

/** Compare without leaking where two strings first differ. */
function safeEqual_(a, b) {
  a = String(a || '');
  b = String(b || '');
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/* ---------------------------------------------------------- storage */

function readAdmins_() {
  return memo_('admins', loadAdmins_);
}

function loadAdmins_() {
  var values = adminsSheet_().getDataRange().getValues();
  var out = [];
  for (var i = 1; i < values.length; i++) {
    if (!String(values[i][0] || '').trim()) continue;
    out.push({
      row: i + 1,
      username: String(values[i][0]).trim(),
      role: String(values[i][1] || 'admin'),
      salt: String(values[i][2] || ''),
      hash: String(values[i][3] || ''),
      rounds: Number(values[i][4]) || SETTINGS.MIN_ROUNDS,
      mustChange: String(values[i][5]) === 'yes',
      active: String(values[i][6]) !== 'no',
      created: values[i][7],
      lastSeen: values[i][8],
      failed: Number(values[i][9]) || 0,
      lockedUntil: values[i][10] ? new Date(values[i][10]).getTime() : 0,
    });
  }
  return out;
}

function findAdmin_(username) {
  var wanted = String(username || '').trim().toLowerCase();
  var all = readAdmins_();
  for (var i = 0; i < all.length; i++) {
    if (all[i].username.toLowerCase() === wanted) return all[i];
  }
  return null;
}

function writeAdmin_(a) {
  adminsSheet_().getRange(a.row, 1, 1, ADMIN_COLUMNS.length).setValues([[
    a.username,
    a.role,
    a.salt,
    a.hash,
    a.rounds,
    a.mustChange ? 'yes' : 'no',
    a.active ? 'yes' : 'no',
    a.created || new Date(),
    a.lastSeen || '',
    a.failed || 0,
    a.lockedUntil ? new Date(a.lockedUntil) : '',
  ]]);
  forget_('admins');
}

/** A row with no salt/hash yet: it can only be signed into with
    ADMIN_PASSPHRASE, and only to set a real password. */
var isBootstrap_ = function (a) { return !a.salt || !a.hash; };

function appendAdmin_(username, role, secret) {
  adminsSheet_().appendRow([
    username, role,
    secret ? secret.salt : '',
    secret ? proofHash_(secret.proof) : '',
    secret ? secret.rounds : '',
    'yes',                       // every new account changes its password
    'yes', new Date(), '', 0, '',
  ]);
  forget_('admins');
}

/** Validate and store a browser-derived credential. */
function setSecret_(admin, p) {
  var salt = String(p.salt || '');
  var proof = String(p.proof || '');
  var rounds = Number(p.rounds) || 0;

  if (salt.length < 16) return 'bad salt';
  if (proof.length < 16) return 'bad proof';
  if (rounds < SETTINGS.MIN_ROUNDS) {
    return 'needs at least ' + SETTINGS.MIN_ROUNDS + ' rounds';
  }

  admin.salt = salt;
  admin.hash = proofHash_(proof);
  admin.rounds = rounds;
  return null;
}

/**
 * First run: create the master account so there is never a moment where
 * the board exists with nobody able to sign in.
 *
 * It starts with no password of its own — signing in uses
 * ADMIN_PASSPHRASE, and the only thing that gets you is the
 * set-a-password screen. That value is sitting in a public repo, so it
 * is a key to the front door and nothing else.
 */
function ensureMaster_() {
  if (readAdmins_().length) return;
  if (!setting('ADMIN_PASSPHRASE')) return;
  appendAdmin_('owner', 'master', null);
}

/**
 * Escape hatch. Run from the Apps Script editor if you're locked out:
 * clears every account and session, and the next request recreates
 * `owner` against ADMIN_PASSPHRASE. Reservations are untouched.
 */
function resetAccounts() {
  [adminsSheet_(), sessionsSheet_()].forEach(function (sh) {
    var rows = sh.getLastRow() - 1;
    if (rows > 0) sh.deleteRows(2, rows);
  });
  SpreadsheetApp.getUi().alert(
      'Accounts cleared. Sign in as "owner" with ADMIN_PASSPHRASE.');
}

/* ---------------------------------------------------------- sessions */

function createSession_(username, remember) {
  var token = randomToken_();
  var expires = new Date(
      Date.now() + SETTINGS.SESSION_DAYS * 24 * 3600 * 1000);

  // Sweeping expired rows is housekeeping, not something a person should
  // wait for. Only bother once the tab has actually grown.
  var sh = sessionsSheet_();
  if (sh.getLastRow() > 40) purgeSessions_();

  sh.appendRow([sha256_(token), username, new Date(), expires]);

  // `remember` only decides whether the BROWSER keeps the token past the
  // tab closing. The server-side lifetime is the same either way.
  return { token: token, expires: expires.toISOString(), remember: !!remember };
}

/**
 * Rewrite the Sessions tab keeping only the rows `keep` approves of.
 *
 * One clear plus one setValues, rather than a deleteRow per victim.
 * Deleting rows one at a time is a separate spreadsheet operation each
 * time and gets slow enough to matter on a tab that sees a write on
 * every sign-in.
 */
function filterSessions_(keep) {
  var sh = sessionsSheet_();
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return;

  var kept = [];
  for (var i = 1; i < values.length; i++) {
    if (values[i][0] && keep(values[i])) kept.push(values[i]);
  }
  if (kept.length === values.length - 1) return;      // nothing to do

  sh.getRange(2, 1, values.length - 1, SESSION_COLUMNS.length).clearContent();
  if (kept.length) {
    sh.getRange(2, 1, kept.length, SESSION_COLUMNS.length).setValues(kept);
  }
}

/** Drop expired rows, so the tab can't grow forever. */
function purgeSessions_() {
  var now = Date.now();
  filterSessions_(function (row) {
    var exp = row[3] ? new Date(row[3]).getTime() : 0;
    return !exp || exp > now;
  });
}

function deleteSessionsFor_(username, tokenHash) {
  var user = username ? String(username).toLowerCase() : null;
  filterSessions_(function (row) {
    if (user && String(row[1]).toLowerCase() === user) return false;
    if (tokenHash && String(row[0]) === tokenHash) return false;
    return true;
  });
}

/** The account behind a token, or null. Also refreshes "last seen". */
function authFromToken_(token) {
  if (!token) return null;

  var wanted = sha256_(token);
  var values = sessionsSheet_().getDataRange().getValues();

  for (var i = 1; i < values.length; i++) {
    if (!safeEqual_(String(values[i][0]), wanted)) continue;

    var exp = values[i][3] ? new Date(values[i][3]).getTime() : 0;
    if (exp && exp <= Date.now()) return null;

    var admin = findAdmin_(values[i][1]);
    if (!admin || !admin.active) return null;

    // "Last seen" used to be written on every single request. A
    // spreadsheet write is the most expensive thing in here and it was
    // buying a timestamp nobody reads to the minute, so it's throttled
    // to once every ten minutes.
    var seen = admin.lastSeen ? new Date(admin.lastSeen).getTime() : 0;
    if (Date.now() - seen > 10 * 60000) {
      admin.lastSeen = new Date();
      writeAdmin_(admin);
    }
    return admin;
  }
  return null;
}

/* ---------------------------------------------------------- actions */

/**
 * Step one of signing in: hand back the salt and round count so the
 * browser can derive the same proof it derived when the password was set.
 *
 * Deliberately answers for usernames that don't exist too, with a stable
 * made-up salt, so this can't be used to enumerate accounts.
 */
function handleAuthSalt(p) {
  ensureMaster_();

  var username = String(p.username || '').trim();
  if (!username) return json({ ok: false, error: 'no username' });

  var admin = findAdmin_(username);
  if (admin && admin.active && isBootstrap_(admin)) {
    // No password set yet — the passphrase goes straight up instead.
    return json({ ok: true, bootstrap: true });
  }
  if (!admin || !admin.active) {
    return json({
      ok: true,
      salt: decoySalt_(username),
      rounds: SETTINGS.MIN_ROUNDS,
    });
  }
  return json({ ok: true, salt: admin.salt, rounds: admin.rounds });
}

function handleSignIn(p) {
  ensureMaster_();

  var username = String(p.username || '').trim();
  var proof = String(p.proof || '');
  var password = String(p.password || '');   // bootstrap only
  if (!username || (!proof && !password)) {
    return json({ ok: false, error: 'username and password required' });
  }

  var admin = findAdmin_(username);

  // Same delay and wording whether or not the account exists, so the form
  // can't be used to find out who has one.
  if (!admin || !admin.active) {
    Utilities.sleep(1200);
    return json({ ok: false, error: 'wrong username or password' });
  }

  if (admin.lockedUntil && admin.lockedUntil > Date.now()) {
    var mins = Math.ceil((admin.lockedUntil - Date.now()) / 60000);
    return json({ ok: false, error: 'too many tries — locked for ' + mins + ' min' });
  }

  var good = isBootstrap_(admin)
      ? safeEqual_(password, setting('ADMIN_PASSPHRASE'))
      : safeEqual_(proofHash_(proof), admin.hash);

  if (!good) {
    admin.failed += 1;
    if (admin.failed >= SETTINGS.MAX_FAILED) {
      admin.lockedUntil = Date.now() + SETTINGS.LOCKOUT_MINUTES * 60000;
      admin.failed = 0;
    }
    writeAdmin_(admin);
    Utilities.sleep(1200);
    return json({ ok: false, error: 'wrong username or password' });
  }

  admin.failed = 0;
  admin.lockedUntil = 0;
  admin.lastSeen = new Date();
  writeAdmin_(admin);

  var session = createSession_(admin.username, p.remember);
  return json({
    ok: true,
    token: session.token,
    expires: session.expires,
    username: admin.username,
    role: admin.role,
    // A bootstrap account has no password of its own yet, so it always
    // lands on the set-a-password screen.
    mustChange: admin.mustChange || isBootstrap_(admin),
  });
}

/** Who am I? Lets the board restore a session without a password. */
function handleSession(admin) {
  return json({
    ok: true,
    username: admin.username,
    role: admin.role,
    mustChange: admin.mustChange,
  });
}

function handleSignOut(p) {
  deleteSessionsFor_(null, sha256_(p.token));
  return json({ ok: true });
}

/**
 * The browser derives the proof for the current password (using the salt
 * it was given at sign-in) and a fresh proof for the new one against a
 * salt it generated. The server only ever sees derived keys.
 */
function handleChangePassword(p, admin) {
  var ok = isBootstrap_(admin)
      ? safeEqual_(String(p.currentPassword || ''), setting('ADMIN_PASSPHRASE'))
      : safeEqual_(proofHash_(p.currentProof), admin.hash);

  if (!ok) {
    Utilities.sleep(1200);
    return json({ ok: false, error: 'current password is wrong' });
  }

  var bad = setSecret_(admin, p);
  if (bad) return json({ ok: false, error: bad });

  admin.mustChange = false;
  writeAdmin_(admin);

  // Every other device that was signed in as this account is now stale.
  deleteSessionsFor_(admin.username, null);
  var session = createSession_(admin.username, true);

  return json({ ok: true, token: session.token, expires: session.expires });
}

/* ------------------------- master-only account admin ----------------- */

function handleListAdmins() {
  return json({
    ok: true,
    admins: readAdmins_().map(function (a) {
      return {
        username: a.username,
        role: a.role,
        active: a.active,
        mustChange: a.mustChange,
        created: a.created ? new Date(a.created).toISOString() : '',
        lastSeen: a.lastSeen ? new Date(a.lastSeen).toISOString() : '',
        locked: !!(a.lockedUntil && a.lockedUntil > Date.now()),
      };
    }),
  });
}

function handleCreateAdmin(p) {
  var username = String(p.username || '').trim();
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
    return json({ ok: false, error: '3–32 characters, letters/numbers/._- only' });
  }
  if (findAdmin_(username)) {
    return json({ ok: false, error: 'that username is taken' });
  }

  // The master's browser derived this from the temp password it showed.
  var pending = { salt: '', hash: '', rounds: 0 };
  var bad = setSecret_(pending, p);
  if (bad) return json({ ok: false, error: bad });

  var role = p.role === 'master' ? 'master' : 'admin';
  appendAdmin_(username, role, { salt: p.salt, proof: p.proof, rounds: p.rounds });
  return handleListAdmins();
}

function handleDeleteAdmin(p, me) {
  var admin = findAdmin_(p.username);
  if (!admin) return json({ ok: false, error: 'no such account' });

  if (admin.username.toLowerCase() === me.username.toLowerCase()) {
    return json({ ok: false, error: "you can't delete the account you're using" });
  }
  if (admin.role === 'master' && countMasters_() <= 1) {
    return json({ ok: false, error: 'that is the last master account' });
  }

  adminsSheet_().deleteRow(admin.row);
  forget_('admins');
  deleteSessionsFor_(admin.username, null);   // kick their devices too
  return handleListAdmins();
}

/** Turn an account off without losing its history, or back on. */
function handleSetAdminActive(p, me) {
  var admin = findAdmin_(p.username);
  if (!admin) return json({ ok: false, error: 'no such account' });

  var active = !!p.active;
  if (!active) {
    if (admin.username.toLowerCase() === me.username.toLowerCase()) {
      return json({ ok: false, error: "you can't switch off your own account" });
    }
    if (admin.role === 'master' && countMasters_() <= 1) {
      return json({ ok: false, error: 'that is the last master account' });
    }
  }

  admin.active = active;
  admin.failed = 0;
  admin.lockedUntil = 0;
  writeAdmin_(admin);
  if (!active) deleteSessionsFor_(admin.username, null);
  return handleListAdmins();
}

/** Hand someone a new temp password they must then change. */
function handleResetAdminPassword(p) {
  var admin = findAdmin_(p.username);
  if (!admin) return json({ ok: false, error: 'no such account' });

  var bad = setSecret_(admin, p);
  if (bad) return json({ ok: false, error: bad });

  admin.mustChange = true;
  admin.failed = 0;
  admin.lockedUntil = 0;
  writeAdmin_(admin);

  deleteSessionsFor_(admin.username, null);
  return handleListAdmins();
}

function countMasters_() {
  return readAdmins_().filter(function (a) {
    return a.role === 'master' && a.active;
  }).length;
}

/* ========================= ADMIN CENTER ACTIONS ======================= */

/** Business info and prices. Sends back the merged result so the board
    can show exactly what's stored rather than what it hoped it wrote. */
function handleSaveSettings(p) {
  if (!p.settings || typeof p.settings !== 'object') {
    return json({ ok: false, error: 'no settings' });
  }

  // Prices and multipliers have to be numbers. A typo here changes what a
  // customer is quoted, so reject the whole save rather than store junk.
  var bad = [];
  Object.keys(p.settings).forEach(function (k) {
    if (k.indexOf('price.') !== 0 && k.indexOf('size.') !== 0 &&
        k !== 'seasonMonthlyFactor') return;
    var v = String(p.settings[k]);
    if (v === '') return;                     // empty = back to the default
    if (isNaN(Number(v)) || Number(v) < 0) bad.push(k);
  });
  if (bad.length) {
    return json({ ok: false, error: 'not a number: ' + bad.join(', ') });
  }

  var merged = writeSettings_(p.settings);
  return json({ ok: true, settings: publicSettings_(merged) });
}

/** Put a notice on the customer form until `until` passes. */
function handlePublishAlert(p) {
  var message = String(p.message || '').trim();
  if (!message) return json({ ok: false, error: 'no message' });
  if (message.length > 400) {
    return json({ ok: false, error: 'message is too long (400 max)' });
  }

  var until = String(p.until || '');
  if (until) {
    var end = new Date(until).getTime();
    if (isNaN(end)) return json({ ok: false, error: 'bad end time' });
    if (end <= Date.now()) {
      return json({ ok: false, error: 'that end time is already past' });
    }
  }

  var tone = ['info', 'warning', 'urgent'].indexOf(p.tone) === -1
      ? 'info' : p.tone;

  // A fresh id each time, so a phone that dismissed the last alert still
  // shows this one.
  var merged = writeSettings_({
    'alert.id': String(Date.now()),
    'alert.message': message,
    'alert.tone': tone,
    'alert.until': until,
  });

  return json({ ok: true, alert: activeAlert_(merged) });
}

/** Take the alert down now, without waiting for it to expire. */
function handleClearAlert() {
  writeSettings_({
    'alert.id': '',
    'alert.message': '',
    'alert.tone': '',
    'alert.until': '',
  });
  return json({ ok: true, alert: null });
}

/* ============================== DIAGNOSE ==============================
   Run this from the Apps Script editor (pick `diagnose` in the function
   dropdown, then Run) and read the timings in the execution log.

   It times the operations a real request is built out of, so a slow
   board can be traced to a specific call instead of guessed at. Nothing
   here writes anything.
   ====================================================================== */

function diagnose() {
  MEMO_ = {};
  var lines = [];

  function time(label, fn) {
    var t0 = new Date().getTime();
    var extra = '';
    try {
      extra = fn() || '';
    } catch (err) {
      extra = 'FAILED: ' + err;
    }
    var ms = new Date().getTime() - t0;
    lines.push(pad_(label, 34) + pad_(ms + ' ms', 10) + extra);
    return ms;
  }

  time('open spreadsheet', function () {
    return SpreadsheetApp.getActiveSpreadsheet().getName();
  });
  time('Reservations tab', function () {
    var sh = SpreadsheetApp.getActiveSpreadsheet()
                           .getSheetByName(SETTINGS.SHEET_NAME);
    return sh ? sh.getLastRow() - 1 + ' rows' : 'MISSING — run setup()';
  });
  time('read all reservations', function () {
    var sh = SpreadsheetApp.getActiveSpreadsheet()
                           .getSheetByName(SETTINGS.SHEET_NAME);
    return sh ? sh.getDataRange().getValues().length + ' rows' : 'skipped';
  });
  time('read Settings tab', function () {
    return Object.keys(loadSettings_()).length + ' keys';
  });
  time('read Admins tab', function () {
    return loadAdmins_().length + ' accounts';
  });
  time('read Sessions tab', function () {
    return sessionsSheet_().getLastRow() - 1 + ' live sessions';
  });
  time('one SHA-256 (proofHash_)', function () {
    return proofHash_('benchmark').slice(0, 12) + '…';
  });
  time('100 x HMAC-SHA256', function () {
    for (var i = 0; i < 100; i++) {
      Utilities.computeHmacSha256Signature('x', 'y');
    }
    return 'this is why stretching is done in the browser';
  });
  time('settings payload (cached)', function () {
    return settingsPayload_().ok ? 'ok' : 'failed';
  });
  time('take + release the lock', function () {
    var l = LockService.getScriptLock();
    if (!l.tryLock(5000)) return 'BUSY — something else is holding it';
    l.releaseLock();
    return 'free';
  });

  var report = lines.join('\n');
  console.log('\n' + report);
  try {
    SpreadsheetApp.getUi().alert('Timings\n\n' + report);
  } catch (err) {
    /* no UI when run headless — the log has it */
  }
  return report;
}

function pad_(s, n) {
  s = String(s);
  while (s.length < n) s += ' ';
  return s;
}

/* ============================== HELPERS =============================== */

function json(obj) {
  return ContentService
      .createTextOutput(JSON.stringify(obj))
      .setMimeType(ContentService.MimeType.JSON);
}

/** Flattens a reservation into one row, in COLUMNS order. */
function rowFrom(p) {
  var c = p.customer || {};
  var prop = p.property || {};
  var job = p.job || {};
  var est = p.estimate || {};
  // The form resolves every id to its label before sending, so this script
  // never needs a copy of the service list.
  var r = p.readable || {};

  return [
    new Date(),
    p.reference || '',
    'New',
    c.name || '',
    // Leading apostrophe keeps Sheets from mangling a phone number into a
    // number or a date.
    c.phone ? "'" + c.phone : '',
    c.email || '',
    c.textOk ? 'Yes' : 'No',
    prop.address || '',
    prop.city || '',
    prop.zip ? "'" + prop.zip : '',
    r.services || (job.services || []).join(', '),
    r.plan || job.plan || '',
    job.trigger || '',
    job.startDate || '',
    r.timeWindow || job.timeWindow || '',
    r.drivewaySize || prop.drivewaySize || '',
    r.surface || prop.surface || '',
    r.flags || (prop.flags || []).join(', '),
    prop.pileSpot || '',
    job.notes || '',
    est.amount || '',
    est.kind === 'monthly' ? 'per month' : 'per visit',
    '',  // Office notes — filled in from the admin page, never by the form
  ];
}

/** Readable text for the email and the phone. */
function asText(p) {
  var c = p.customer || {};
  var prop = p.property || {};
  var job = p.job || {};
  var est = p.estimate || {};
  var r = p.readable || {};

  var lines = [
    'NEW RESERVATION  ' + (p.reference || ''),
    '',
    c.name + ' - ' + c.phone + (c.email ? ' / ' + c.email : ''),
    prop.address + ', ' + prop.city + ' ' + (prop.zip || ''),
    '',
    'Services: ' + (r.services || ''),
    'Plan: ' + (r.plan || '') + (job.trigger ? ' (after ' + job.trigger + ')' : ''),
    'Start: ' + (job.startDate || '') + ' / ' + (r.timeWindow || ''),
  ];

  if (r.drivewaySize) lines.push('Driveway: ' + r.drivewaySize);
  if (r.surface) lines.push('Surface: ' + r.surface);
  if (r.flags) lines.push('Flags: ' + r.flags);
  if (prop.pileSpot) lines.push('Snow goes: ' + prop.pileSpot);
  if (job.notes) lines.push('Notes: ' + job.notes);

  lines.push('');
  lines.push('Estimate: $' + (est.amount || '?') +
             (est.kind === 'monthly' ? ' /month' : ' /visit'));
  lines.push('');
  lines.push(SpreadsheetApp.getActiveSpreadsheet().getUrl());

  return lines.join('\n');
}

/** Email and optional text. Never allowed to fail the request. */
function notify(p) {
  try {
    var prop = p.property || {};
    var subject = 'Snow reservation ' + (p.reference || '') +
                  ' - ' + (prop.address || '');

    // Both go through setting(), so they can be moved into Script
    // Properties too if you'd rather not have an address in the repo.
    var email = setting('NOTIFY_EMAIL');
    var sms = setting('NOTIFY_SMS');

    if (email) {
      MailApp.sendEmail(email, subject, asText(p));
    }

    if (sms) {
      // Carrier gateways truncate hard, so send only what you need to
      // decide whether to call back right now.
      var c = p.customer || {};
      MailApp.sendEmail(sms, '',
          [p.reference, c.name, c.phone, prop.address, prop.city]
              .filter(String).join(' '));
    }
  } catch (err) {
    console.error('notify failed: ' + err);
  }
}
