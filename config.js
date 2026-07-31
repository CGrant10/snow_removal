/* ============================================================
   Snow removal reservations — configuration
   Edit this file. Everything else can stay as-is.
   ============================================================ */

window.SNOW_CONFIG = {
  business: {
    name: "Northern Edge Snow Removal",
    phone: "(701) 555-0134",
    email: "dispatch@example.com",
    serviceArea: "Fargo / West Fargo and 15 miles out",
    tagline: "Plowed before your coffee is done.",
    hours: "Storm response 24/7 · Office 8–5 weekdays",

    /* Shown in the sidebar. Keep to three or four short items. */
    trust: [
      "Licensed & insured",
      "Locally owned and operated",
      "No long-term contract required",
    ],
  },

  /* ---------- How reservation requests reach you ----------
     Pick ONE by setting `mode`. See README.md for setup steps.

       "console"   – dev only. Dumps the payload to the browser console.
       "mailto"    – zero setup. Opens the customer's email client, pre-filled.
       "web3forms" – free form-to-email service. Put your access key below.
       "formspree" – same idea, different vendor. Put your form URL below.
       "gsheet"    – appends a row to a Google Sheet and emails/texts you.
                     Setup is in apps_script/README_SETUP.md. This is the one
                     to use once there are enough jobs to lose track of.
       "webhook"   – POST JSON to any endpoint you control (server.py, a
                     Zapier/Make hook, a Twilio proxy...).
  --------------------------------------------------------- */
  delivery: {
    mode: "gsheet",

    gsheet: {
      /* The /exec URL Apps Script gives you when you deploy the web app.
         Must start with https://script.google.com/ */
      url: "https://script.google.com/macros/s/AKfycbzuTzgjuEgDPmWh2bz3aAHAOAGGZhzxyJMOHyokKxcNIChMCYA2o8ILsFyhF8FB-vIhyQ/exec",
      /* Optional. If set, must match SHARED_SECRET in Code.gs. Sent in the
         body, not a header — a custom header would trip CORS preflight.
         It is visible to anyone who reads the page source, so treat it as
         a speed bump against bots, not a real secret. */
      sharedSecret: "",
    },

    web3forms: {
      accessKey: "PASTE-YOUR-WEB3FORMS-ACCESS-KEY",
      // Optional: also text you, if you set up an email-to-SMS address
      // e.g. 7015550134@vtext.com (Verizon), @txt.att.net, @tmomail.net
      ccSmsGateway: "",
    },

    formspree: {
      endpoint: "https://formspree.io/f/YOURFORMID",
    },

    webhook: {
      url: "http://localhost:8123/api/reservations",
      // Sent as a header if non-empty; server.py checks it.
      sharedSecret: "",
    },
  },

  /* ---------- Services offered ----------
     `base` drives the ballpark estimate only — the customer is always told
     it is an estimate, not a quote.
     `icon` names a symbol in the sprite at the top of index.html.        */
  services: [
    {
      id: "driveway",
      label: "Driveway clearing",
      blurb: "Plow or blow the drive down to pavement, plus the street apron.",
      base: 45,
      icon: "plow",
      needsSize: true,
    },
    {
      id: "walks",
      label: "Sidewalks & steps",
      blurb: "Public walk, front path, steps, and a path to the mailbox.",
      base: 25,
      icon: "steps",
    },
    {
      id: "salt",
      label: "Ice melt / sanding",
      blurb: "Pet-safe ice melt on walks and steps after clearing.",
      base: 20,
      icon: "salt",
    },
    {
      id: "roof",
      label: "Roof & ice dams",
      blurb: "Roof rake the first 6–8 feet of eave. Quoted on site.",
      base: 150,
      icon: "roof",
      quoteOnly: true,
    },
    {
      id: "lot",
      label: "Commercial lot",
      blurb: "Small business lots and alley approaches. Quoted on site.",
      base: 0,
      icon: "lot",
      quoteOnly: true,
    },
  ],

  /* Driveway size tiers — multiplier applied to driveway base price */
  drivewaySizes: [
    { id: "1car", label: "1–2 cars", detail: "Single stall, short approach", mult: 1.0 },
    { id: "2car", label: "2–3 cars", detail: "Double wide, standard city lot", mult: 1.4 },
    { id: "3car", label: "3+ cars", detail: "Triple wide or extra parking pad", mult: 1.9 },
    { id: "long", label: "Long / rural", detail: "Over 100 ft, acreage approach", mult: 2.8 },
  ],

  surfaces: [
    { id: "concrete", label: "Concrete" },
    { id: "asphalt", label: "Asphalt" },
    { id: "gravel", label: "Gravel", note: "We run the blade high on gravel." },
    { id: "paver", label: "Pavers / stamped", note: "Poly blade, no salt." },
  ],

  /* How often they want you out */
  plans: [
    {
      id: "once",
      label: "One time",
      detail: "This storm only.",
      mult: 1.0,
    },
    {
      id: "trigger",
      label: "Per visit, automatic",
      detail: "We come every time snowfall passes your trigger depth.",
      mult: 0.9,
    },
    {
      id: "season",
      label: "Season contract",
      detail: "Flat monthly rate, unlimited visits Nov–Mar.",
      mult: 1.0,
      seasonalMonthly: true,
    },
  ],

  triggerDepths: ["1 inch", "2 inches", "3 inches", "Call me first"],

  timeWindows: [
    { id: "predawn", label: "Before 7 AM", detail: "Out before the commute." },
    { id: "morning", label: "Morning", detail: "7 AM – noon" },
    { id: "afternoon", label: "Afternoon", detail: "Noon – 5 PM" },
    { id: "anytime", label: "Anytime", detail: "Whenever you get to it — cheapest." },
  ],

  /* Season contract pricing = driveway base * size mult * this */
  seasonMonthlyFactor: 3.2,

  /* Extras shown as checkboxes on the property step */
  propertyFlags: [
    { id: "cars_parked", label: "Cars are usually parked in the drive" },
    { id: "dog", label: "Dog in the yard" },
    { id: "gate", label: "Gate or narrow access" },
    { id: "no_salt", label: "Do not use salt" },
    { id: "steep", label: "Steep or sloped drive" },
    { id: "corner", label: "Corner lot (extra sidewalk)" },
  ],
};
