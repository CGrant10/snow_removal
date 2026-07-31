/* ============================================================
   Snow removal reservations — form logic + submission adapters
   ============================================================ */

const CFG = window.SNOW_CONFIG;
const $ = (id) => document.getElementById(id);

/* APP_VERSION lives in updater.js, alongside the update checker. */
const VERSION = APP_VERSION;

const STEPS = 5;              // 0..4 are input steps, 5 is the done screen
const STEP_NAMES = ["Services", "Property", "Schedule", "Contact", "Review"];
let step = 0;

const state = {
  services: new Set(),
  size: null,
  surface: null,
  flags: new Set(),
  pileSpot: "",
  plan: "once",
  trigger: null,
  window: "anytime",
};

/* ------------------------------------------------------------ boot */
function boot() {
  const b = CFG.business;
  const tel = "tel:" + b.phone.replace(/[^\d+]/g, "");

  $("bizName").textContent = $("bizNameSm").textContent = b.name;
  $("bizArea").textContent = $("bizAreaSm").textContent = b.serviceArea;
  $("bizTagline").textContent = b.tagline;
  $("bizHours").textContent = b.hours || "";
  $("bizPhone").href = $("bizPhoneSm").href = tel;
  $("bizPhone").textContent = b.phone;
  document.title = "Reserve — " + b.name;

  $("trustList").innerHTML = (b.trust || [])
    .map((t) => `<li>${t}</li>`).join("");

  $("progress").innerHTML = Array.from({ length: STEPS }, () => "<i></i>").join("");
  $("stepper").innerHTML = STEP_NAMES
    .map((n, i) => `<li><span class="n">${i + 1}</span><span>${n}</span></li>`)
    .join("");

  renderServices();
  renderSizes();
  renderSurfaces();
  renderFlags();
  renderPlans();
  renderTriggers();
  renderWindows();

  wireUpdater([$("appVersion"), $("appVersionSm")], $("updatePill"));

  $("startDate").valueAsDate = new Date();
  $("nextBtn").addEventListener("click", next);
  $("backBtn").addEventListener("click", back);
  $("againBtn").addEventListener("click", () => location.reload());
  $("pileSpot").addEventListener("input", (e) => (state.pileSpot = e.target.value));

  installer();
  show(0);
}

/* ------------------------------------------------------------ install
   Chrome and Edge fire beforeinstallprompt and let us show a real
   button. iOS Safari never has, so there the same button explains the
   Share > Add to Home Screen route instead.                           */
function installer() {
  const buttons = [$("installBtn"), $("installBtnSm")];
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const installed =
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true;

  let prompt = null;
  const showButtons = (on) => buttons.forEach((b) => (b.hidden = !on));

  if (installed) return;                       // already on their home screen

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();                        // we choose when to ask
    prompt = e;
    showButtons(true);
  });

  window.addEventListener("appinstalled", () => {
    prompt = null;
    showButtons(false);
    $("iosHint").hidden = true;
  });

  buttons.forEach((b) => b.addEventListener("click", async () => {
    if (prompt) {
      prompt.prompt();
      await prompt.userChoice;                 // resolves whichever way
      prompt = null;
      showButtons(false);
      return;
    }
    $("iosHint").hidden = false;               // iOS, or prompt already used
  }));

  $("iosHintClose").addEventListener("click", () => ($("iosHint").hidden = true));

  if (isIOS) showButtons(true);                // no event ever comes on iOS
}

/* Service worker registration and the update flow live in updater.js,
   shared with the job board. */

/* ------------------------------------------------------------ render */
/* `multi` squares off the tick mark, the way a checkbox reads next to a radio. */
function card({ ico, t, d, p, sel, multi, onClick }) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "card" + (sel ? " sel" : "");
  b.setAttribute("aria-pressed", String(!!sel));
  if (multi) b.dataset.multi = "1";
  b.innerHTML =
    (ico ? `<svg class="ico" aria-hidden="true"><use href="#i-${ico}"></use></svg>` : "") +
    `<span><span class="t">${t}</span>${d ? `<span class="d">${d}</span>` : ""}</span>` +
    (p ? `<span class="p">${p}</span>` : "") +
    `<span class="tick" aria-hidden="true"><svg><use href="#i-check"></use></svg></span>`;
  b.addEventListener("click", onClick);
  return b;
}

function renderServices() {
  const host = $("serviceList");
  host.innerHTML = "";
  CFG.services.forEach((s) => {
    host.appendChild(card({
      ico: s.icon,
      t: s.label,
      d: s.blurb,
      p: s.quoteOnly ? "quoted on site" : "from $" + s.base,
      sel: state.services.has(s.id),
      multi: true,
      onClick: () => {
        state.services.has(s.id) ? state.services.delete(s.id) : state.services.add(s.id);
        renderServices();
        syncConditional();
        updateTotal();
      },
    }));
  });
}

function renderSizes() {
  const host = $("sizeList");
  host.innerHTML = "";
  CFG.drivewaySizes.forEach((s) => {
    host.appendChild(card({
      t: s.label, d: s.detail, sel: state.size === s.id,
      onClick: () => { state.size = s.id; renderSizes(); updateTotal(); },
    }));
  });
}

function renderSurfaces() {
  const host = $("surfaceList");
  host.innerHTML = "";
  CFG.surfaces.forEach((s) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip" + (state.surface === s.id ? " sel" : "");
    b.textContent = s.label;
    b.addEventListener("click", () => { state.surface = s.id; renderSurfaces(); });
    host.appendChild(b);
  });
}

function renderFlags() {
  const host = $("flagList");
  host.innerHTML = "";
  CFG.propertyFlags.forEach((f) => {
    const l = document.createElement("label");
    l.className = "check";
    l.innerHTML = `<input type="checkbox"><span>${f.label}</span>`;
    l.querySelector("input").addEventListener("change", (e) => {
      e.target.checked ? state.flags.add(f.id) : state.flags.delete(f.id);
    });
    host.appendChild(l);
  });
}

function renderPlans() {
  const host = $("planList");
  host.innerHTML = "";
  CFG.plans.forEach((p) => {
    host.appendChild(card({
      t: p.label, d: p.detail, sel: state.plan === p.id,
      onClick: () => { state.plan = p.id; renderPlans(); syncConditional(); updateTotal(); },
    }));
  });
}

function renderTriggers() {
  const host = $("triggerList");
  host.innerHTML = "";
  CFG.triggerDepths.forEach((d) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip" + (state.trigger === d ? " sel" : "");
    b.textContent = d;
    b.addEventListener("click", () => { state.trigger = d; renderTriggers(); });
    host.appendChild(b);
  });
}

function renderWindows() {
  const host = $("windowList");
  host.innerHTML = "";
  CFG.timeWindows.forEach((w) => {
    host.appendChild(card({
      t: w.label, d: w.detail, sel: state.window === w.id,
      onClick: () => { state.window = w.id; renderWindows(); },
    }));
  });
}

/* Show/hide the blocks that only matter for some answers */
function syncConditional() {
  $("sizeBlock").hidden = !state.services.has("driveway");
  $("triggerBlock").hidden = state.plan === "once";
}

/* ------------------------------------------------------------ pricing */
function estimate() {
  const sizeMult = (CFG.drivewaySizes.find((s) => s.id === state.size) || {}).mult || 1;
  const plan = CFG.plans.find((p) => p.id === state.plan) || { mult: 1 };

  let perVisit = 0;
  let quoteOnly = false;

  state.services.forEach((id) => {
    const s = CFG.services.find((x) => x.id === id);
    if (!s) return;
    if (s.quoteOnly) { quoteOnly = true; return; }
    perVisit += s.needsSize ? s.base * sizeMult : s.base;
  });

  if (plan.seasonalMonthly) {
    const monthly = Math.round((perVisit * CFG.seasonMonthlyFactor) / 5) * 5;
    return { kind: "monthly", amount: monthly, quoteOnly };
  }
  return { kind: "visit", amount: Math.round((perVisit * plan.mult) / 5) * 5, quoteOnly };
}

function money(n) { return "$" + n.toLocaleString("en-US"); }

function updateTotal() {
  const e = estimate();
  const bar = $("runningTotal");
  const rail = $("railEstimate");

  if (!state.services.size) {
    bar.textContent = "";
    rail.hidden = true;
    return;
  }

  const per = e.kind === "monthly" ? " / month" : " / visit";

  if (!e.amount && e.quoteOnly) {
    bar.textContent = "Quoted on site";
    rail.hidden = false;
    $("railAmt").textContent = "On site";
    $("railPer").textContent = "quote";
    return;
  }

  bar.textContent = "Estimate ~" + money(e.amount) + per;
  rail.hidden = false;
  $("railAmt").textContent = money(e.amount);
  $("railPer").textContent = per.trim();
}

/* ------------------------------------------------------------ nav */
function show(n) {
  step = n;
  document.querySelectorAll(".step").forEach((el) => {
    el.hidden = Number(el.dataset.step) !== n;
  });
  [...$("progress").children].forEach((i, idx) => i.classList.toggle("on", idx <= n && n < STEPS));

  [...$("stepper").children].forEach((li, idx) => {
    li.classList.toggle("done", idx < n);
    li.classList.toggle("now", idx === n && n < STEPS);
    li.querySelector(".n").textContent = idx < n ? "✓" : String(idx + 1);
  });

  $("backBtn").hidden = n === 0 || n >= STEPS;
  $("nextBtn").hidden = n >= STEPS;
  $("nextBtn").textContent = n === STEPS - 1 ? "Send request" : "Continue";
  $("progress").hidden = n >= STEPS;
  document.querySelector(".navbar").hidden = n >= STEPS;   // nothing left to do

  // The document itself never scrolls — the scroller is #app (mobile) or
  // .content (desktop), whichever is actually overflowing.
  [$("app"), document.querySelector(".content")].forEach((el) => {
    if (el) el.scrollTop = 0;
  });
  if (n === STEPS - 1) renderSummary();
}

function back() { show(Math.max(0, step - 1)); }

function next() {
  if (step === 0) {
    const ok = state.services.size > 0;
    $("err-services").hidden = ok;
    if (!ok) return;
  }
  if (step === 3) {
    const ok = $("name").value.trim() && $("phone").value.trim() &&
               $("address").value.trim() && $("city").value.trim();
    $("err-contact").hidden = !!ok;
    if (!ok) return;
  }
  if (step === STEPS - 1) return submit();
  show(step + 1);
  if (step === 1 || step === 2) syncConditional();
}

/* ------------------------------------------------------------ summary */
function labelFor(list, id, key = "label") {
  const hit = list.find((x) => x.id === id);
  return hit ? hit[key] : "—";
}

function renderSummary() {
  const svc = [...state.services].map((id) => labelFor(CFG.services, id)).join(", ");
  const flags = [...state.flags].map((id) => labelFor(CFG.propertyFlags, id)).join(", ");

  const rows = [
    ["Services", svc],
    state.services.has("driveway") ? ["Driveway", labelFor(CFG.drivewaySizes, state.size)] : null,
    state.surface ? ["Surface", labelFor(CFG.surfaces, state.surface)] : null,
    ["Plan", labelFor(CFG.plans, state.plan)],
    state.plan !== "once" && state.trigger ? ["Trigger", state.trigger] : null,
    state.plan === "once" ? ["Date", $("startDate").value || "—"] : ["Starting", $("startDate").value || "—"],
    ["Time", labelFor(CFG.timeWindows, state.window)],
    flags ? ["Notes", flags] : null,
    state.pileSpot ? ["Snow goes", state.pileSpot] : null,
    ["Name", $("name").value],
    ["Phone", $("phone").value],
    ["Address", `${$("address").value}, ${$("city").value} ${$("zip").value}`.trim()],
    $("notes").value ? ["Crew notes", $("notes").value] : null,
  ].filter(Boolean);

  $("summary").innerHTML = rows
    .map(([k, v]) => `<div class="row"><span class="k">${k}</span><span class="v">${esc(v)}</span></div>`)
    .join("");

  const e = estimate();
  $("estimate").innerHTML = e.amount
    ? `<span class="lbl">Ballpark estimate</span>
       <span class="big">${money(e.amount)}<span class="per">
         ${e.kind === "monthly" ? "/ month" : "/ visit"}</span></span>
       ${e.quoteOnly ? '<span class="note">Plus roof or lot work, quoted on site.</span>' : ""}`
    : `<span class="lbl">Ballpark estimate</span>
       <span class="note">We'll walk this one and quote it on site — no charge for the visit.</span>`;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/* ------------------------------------------------------------ payload */

/* Every id in the payload resolved to the words a human reads. Carried
   along so a receiver — a spreadsheet, an inbox — never needs a copy of
   config.js to make sense of a request. */
function readableOf(p) {
  const join = (ids, list) => ids.map((id) => labelFor(list, id)).join(", ");
  return {
    services: join(p.job.services, CFG.services),
    plan: labelFor(CFG.plans, p.job.plan),
    timeWindow: labelFor(CFG.timeWindows, p.job.timeWindow),
    drivewaySize: p.property.drivewaySize
      ? labelFor(CFG.drivewaySizes, p.property.drivewaySize) : "",
    surface: p.property.surface ? labelFor(CFG.surfaces, p.property.surface) : "",
    flags: join(p.property.flags, CFG.propertyFlags),
  };
}

function buildPayload() {
  const e = estimate();
  const payload = {
    submittedAt: new Date().toISOString(),
    reference: "SNO-" + Math.random().toString(36).slice(2, 7).toUpperCase(),
    customer: {
      name: $("name").value.trim(),
      phone: $("phone").value.trim(),
      email: $("email").value.trim(),
      textOk: $("textOk").checked,
    },
    property: {
      address: $("address").value.trim(),
      city: $("city").value.trim(),
      zip: $("zip").value.trim(),
      drivewaySize: state.size,
      surface: state.surface,
      flags: [...state.flags],
      pileSpot: state.pileSpot,
    },
    job: {
      services: [...state.services],
      plan: state.plan,
      trigger: state.trigger,
      startDate: $("startDate").value,
      timeWindow: state.window,
      notes: $("notes").value.trim(),
    },
    estimate: e,
  };

  payload.readable = readableOf(payload);
  return payload;
}

/* Plain-text version — what actually lands in an inbox or a phone */
function asText(p) {
  const r = p.readable;
  return [
    `NEW RESERVATION  ${p.reference}`,
    ``,
    `${p.customer.name} — ${p.customer.phone}${p.customer.email ? " / " + p.customer.email : ""}`,
    `${p.property.address}, ${p.property.city} ${p.property.zip}`,
    ``,
    `Services: ${r.services}`,
    `Plan: ${r.plan}${p.job.trigger ? ` (after ${p.job.trigger})` : ""}`,
    `Start: ${p.job.startDate} — ${r.timeWindow}`,
    r.drivewaySize ? `Driveway: ${r.drivewaySize}` : "",
    r.surface ? `Surface: ${r.surface}` : "",
    r.flags ? `Flags: ${r.flags}` : "",
    p.property.pileSpot ? `Snow goes: ${p.property.pileSpot}` : "",
    p.job.notes ? `Notes: ${p.job.notes}` : "",
    ``,
    `Estimate: $${p.estimate.amount} ${p.estimate.kind === "monthly" ? "/month" : "/visit"}`,
  ].filter(Boolean).join("\n");
}

/* ------------------------------------------------------------ submit */
async function submit() {
  const btn = $("nextBtn");
  const err = $("err-submit");
  err.hidden = true;
  btn.disabled = true;
  btn.textContent = "Sending…";

  const payload = buildPayload();

  try {
    await DELIVERY[CFG.delivery.mode](payload);
    $("doneMsg").textContent =
      `Thanks ${payload.customer.name.split(" ")[0]} — we'll confirm by ` +
      `${payload.customer.textOk ? "text" : "phone"} at ${payload.customer.phone}.`;
    $("doneRef").textContent = "Reference " + payload.reference;
    show(STEPS);
  } catch (ex) {
    console.error(ex);

    /* Never imply a request went through when it didn't — someone whose
       driveway is buried has to know to pick up the phone instead. */
    err.textContent = navigator.onLine
      ? `Couldn't send that (${ex.message}). Call or text us at ` +
        `${CFG.business.phone} and we'll take it down by hand.`
      : `You're offline, so this hasn't been sent yet. Your answers are ` +
        `still here — we'll try again the moment you're back on, or call ` +
        `us at ${CFG.business.phone}.`;
    err.hidden = false;

    if (!navigator.onLine) retryWhenOnline();
  } finally {
    btn.disabled = false;
    btn.textContent = "Send request";
  }
}

/* One pending retry at a time, and only while they're still on the review
   step. Anything more would be a background queue pretending to be a
   confirmation. */
let retryArmed = false;
function retryWhenOnline() {
  if (retryArmed) return;
  retryArmed = true;
  window.addEventListener("online", () => {
    retryArmed = false;
    if (step === STEPS - 1) submit();
  }, { once: true });
}

/* ---- Delivery adapters. Each takes the payload and throws on failure. ---- */
const DELIVERY = {

  /* Dev only. */
  async console(payload) {
    console.log("[reservation]", payload);
    console.log(asText(payload));
  },

  /* No backend at all: hands off to the customer's mail client. */
  async mailto(payload) {
    const url =
      `mailto:${CFG.business.email}` +
      `?subject=${encodeURIComponent("Snow reservation " + payload.reference)}` +
      `&body=${encodeURIComponent(asText(payload))}`;
    window.location.href = url;
  },

  /* https://web3forms.com — free, no account server-side. */
  async web3forms(payload) {
    const cfg = CFG.delivery.web3forms;
    const body = {
      access_key: cfg.accessKey,
      subject: `Snow reservation ${payload.reference} — ${payload.property.address}`,
      from_name: payload.customer.name,
      replyto: payload.customer.email || undefined,
      cc: cfg.ccSmsGateway || undefined,
      message: asText(payload),
      raw_json: JSON.stringify(payload),
    };
    const r = await fetch("https://api.web3forms.com/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.success === false) throw new Error(j.message || "HTTP " + r.status);
  },

  /* https://formspree.io */
  async formspree(payload) {
    const r = await fetch(CFG.delivery.formspree.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        _subject: `Snow reservation ${payload.reference}`,
        email: payload.customer.email,
        message: asText(payload),
        payload,
      }),
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
  },

  /* Google Sheet via the Apps Script in apps_script/Code.gs. */
  async gsheet(payload) {
    const cfg = CFG.delivery.gsheet;
    if (!/^https:\/\/script\.google\.com\//.test(cfg.url)) {
      throw new Error("no Apps Script URL in config.js");
    }

    /* text/plain on purpose. Apps Script web apps do not answer CORS
       preflights, so an application/json body would be blocked before it
       ever left the browser. A plain-text body is a "simple request" and
       goes straight through — Code.gs parses it as JSON on the far side. */
    const r = await fetch(cfg.url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(cfg.sharedSecret
        ? { ...payload, secret: cfg.sharedSecret }
        : payload),
      redirect: "follow",
    });

    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json().catch(() => ({}));
    if (j.ok === false) throw new Error(j.error || "the sheet rejected it");
  },

  /* Your own endpoint: server.py, Zapier, a Twilio proxy… */
  async webhook(payload) {
    const cfg = CFG.delivery.webhook;
    const headers = { "Content-Type": "application/json" };
    if (cfg.sharedSecret) headers["X-Snow-Secret"] = cfg.sharedSecret;
    const r = await fetch(cfg.url, {
      method: "POST", headers, body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
  },
};

boot();
