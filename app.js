/* ============================================================
   Snow removal reservations — form logic + submission adapters
   ============================================================ */

const CFG = window.SNOW_CONFIG;
const $ = (id) => document.getElementById(id);

const STEPS = 5;              // 0..4 are input steps, 5 is the done screen
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
  $("bizName").textContent = CFG.business.name;
  $("bizTagline").textContent = CFG.business.tagline;
  $("bizPhone").href = "tel:" + CFG.business.phone.replace(/[^\d+]/g, "");
  $("bizPhone").textContent = CFG.business.phone;
  document.title = "Reserve — " + CFG.business.name;

  $("progress").innerHTML = Array.from({ length: STEPS }, () => "<i></i>").join("");

  renderServices();
  renderSizes();
  renderSurfaces();
  renderFlags();
  renderPlans();
  renderTriggers();
  renderWindows();

  $("startDate").valueAsDate = new Date();
  $("nextBtn").addEventListener("click", next);
  $("backBtn").addEventListener("click", back);
  $("againBtn").addEventListener("click", () => location.reload());
  $("pileSpot").addEventListener("input", (e) => (state.pileSpot = e.target.value));

  show(0);
}

/* ------------------------------------------------------------ render */
function card({ ico, t, d, p, sel, onClick }) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "card" + (sel ? " sel" : "");
  b.innerHTML =
    (ico ? `<span class="ico">${ico}</span>` : "") +
    `<span><span class="t">${t}</span>${d ? `<span class="d">${d}</span>` : ""}</span>` +
    (p ? `<span class="p">${p}</span>` : "");
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
      p: s.quoteOnly ? "quoted" : "from $" + s.base,
      sel: state.services.has(s.id),
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
  const host = $("runningTotal");
  if (!state.services.size) { host.textContent = ""; return; }
  if (!e.amount && e.quoteOnly) { host.textContent = "Quoted on site"; return; }
  host.textContent = "~" + money(e.amount) + (e.kind === "monthly" ? " / month" : " / visit");
}

/* ------------------------------------------------------------ nav */
function show(n) {
  step = n;
  document.querySelectorAll(".step").forEach((el) => {
    el.hidden = Number(el.dataset.step) !== n;
  });
  [...$("progress").children].forEach((i, idx) => i.classList.toggle("on", idx <= n && n < STEPS));
  $("backBtn").hidden = n === 0 || n >= STEPS;
  $("nextBtn").hidden = n >= STEPS;
  $("nextBtn").textContent = n === STEPS - 1 ? "Send request" : "Continue";
  $("progress").hidden = n >= STEPS;
  window.scrollTo(0, 0);
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
    ? `<div class="muted">Ballpark estimate</div>
       <div class="big">${money(e.amount)}<span class="muted" style="font-size:15px">
       ${e.kind === "monthly" ? " / month" : " / visit"}</span></div>
       ${e.quoteOnly ? '<div class="muted">Plus roof or lot work, quoted on site.</div>' : ""}`
    : `<div class="muted">We'll quote this one on site.</div>`;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/* ------------------------------------------------------------ payload */
function buildPayload() {
  const e = estimate();
  return {
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
}

/* Plain-text version — what actually lands in an inbox or a phone */
function asText(p) {
  const L = (id) => labelFor(CFG.services, id);
  return [
    `NEW RESERVATION  ${p.reference}`,
    ``,
    `${p.customer.name} — ${p.customer.phone}${p.customer.email ? " / " + p.customer.email : ""}`,
    `${p.property.address}, ${p.property.city} ${p.property.zip}`,
    ``,
    `Services: ${p.job.services.map(L).join(", ")}`,
    `Plan: ${labelFor(CFG.plans, p.job.plan)}${p.job.trigger ? ` (after ${p.job.trigger})` : ""}`,
    `Start: ${p.job.startDate} — ${labelFor(CFG.timeWindows, p.job.timeWindow)}`,
    p.property.drivewaySize ? `Driveway: ${labelFor(CFG.drivewaySizes, p.property.drivewaySize)}` : "",
    p.property.surface ? `Surface: ${labelFor(CFG.surfaces, p.property.surface)}` : "",
    p.property.flags.length ? `Flags: ${p.property.flags.map((f) => labelFor(CFG.propertyFlags, f)).join(", ")}` : "",
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
    err.textContent =
      `Couldn't send that (${ex.message}). Call or text us at ${CFG.business.phone} ` +
      `and we'll take it down by hand.`;
    err.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = "Send request";
  }
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

  /* Your own endpoint: server.py, Apps Script, Zapier, Twilio proxy… */
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
