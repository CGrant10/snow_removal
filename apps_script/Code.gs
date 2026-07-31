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

  SpreadsheetApp.getUi().alert(
      'Ready. Now deploy: Deploy > New deployment > Web app, ' +
      'Execute as ME, Access ANYONE.');
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

/** Every stored key as a flat map of strings. */
function readSettings_() {
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
 *   (none)         a customer submitting the public form. Anonymous.
 *   settings       either app reading live settings + alert. Anonymous —
 *                  the customer portal has no passphrase and still has to
 *                  be able to read them.
 *   list           board/ loading the job board.        Passphrase.
 *   update         board/ changing a status or note.    Passphrase.
 *   saveSettings   board/ changing business info/prices. Passphrase.
 *   publishAlert   board/ putting a notice on the form.  Passphrase.
 *   clearAlert     board/ taking it down early.          Passphrase.
 */
function doPost(e) {
  // One writer at a time, so two people submitting at once cannot land on
  // the same row.
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (err) {
    return json({ ok: false, error: 'busy, try again' });
  }

  try {
    if (!e || !e.postData || !e.postData.contents) {
      return json({ ok: false, error: 'empty body' });
    }

    var p = JSON.parse(e.postData.contents);

    // ---- anonymous: both apps reading settings + the current alert ----
    if (p.action === 'settings') {
      var s = readSettings_();
      return json({
        ok: true,
        settings: publicSettings_(s),
        alert: activeAlert_(s),
      });
    }

    // ---- admin actions, behind the passphrase ----
    var ADMIN = ['list', 'update', 'saveSettings', 'publishAlert', 'clearAlert'];
    if (ADMIN.indexOf(p.action) !== -1) {
      var adminPass = setting('ADMIN_PASSPHRASE');
      if (!adminPass) {
        return json({ ok: false, error: 'admin is switched off' });
      }
      if (p.passphrase !== adminPass) {
        // Slows a script guessing passphrases without annoying a human who
        // fat-fingered theirs once.
        Utilities.sleep(1200);
        return json({ ok: false, error: 'wrong passphrase' });
      }
      if (p.action === 'list') return handleList(p);
      if (p.action === 'update') return handleUpdate(p);
      if (p.action === 'saveSettings') return handleSaveSettings(p);
      if (p.action === 'publishAlert') return handlePublishAlert(p);
      return handleClearAlert();
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
    lock.releaseLock();
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
