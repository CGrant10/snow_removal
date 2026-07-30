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

  // Where the "new reservation" email goes. Leave '' for no email.
  NOTIFY_EMAIL: 'you@example.com',

  // Optional carrier email-to-SMS address for a text, e.g.
  // '7015550134@vtext.com' (Verizon), '@txt.att.net', '@tmomail.net'.
  NOTIFY_SMS: '',

  // Optional. If set, must match delivery.gsheet.sharedSecret in config.js.
  // Keeps casual bots out. It ships in the page source, so it is a speed
  // bump, not real security.
  SHARED_SECRET: '',

  // Status values offered as a dropdown in column C.
  STATUSES: ['New', 'Quoted', 'Scheduled', 'Done', 'Declined'],
};

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
  SpreadsheetApp.getUi().alert(
      'Ready. Now deploy: Deploy > New deployment > Web app, ' +
      'Execute as ME, Access ANYONE.');
}

/* ============================== ENDPOINT ============================== */

/** Health check — open the /exec URL in a browser to see this. */
function doGet() {
  return json({ ok: true, service: 'snow-reservations' });
}

/** The form posts here. */
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

    if (SETTINGS.SHARED_SECRET && p.secret !== SETTINGS.SHARED_SECRET) {
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

    if (SETTINGS.NOTIFY_EMAIL) {
      MailApp.sendEmail(SETTINGS.NOTIFY_EMAIL, subject, asText(p));
    }

    if (SETTINGS.NOTIFY_SMS) {
      // Carrier gateways truncate hard, so send only what you need to
      // decide whether to call back right now.
      var c = p.customer || {};
      MailApp.sendEmail(SETTINGS.NOTIFY_SMS, '',
          [p.reference, c.name, c.phone, prop.address, prop.city]
              .filter(String).join(' '));
    }
  } catch (err) {
    console.error('notify failed: ' + err);
  }
}
