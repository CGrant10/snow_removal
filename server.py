"""
Optional backend for the snow removal reservation form.

Does three things and nothing else:
  1. Serves the static form (so you can test on your phone over the LAN).
  2. Accepts POST /api/reservations and appends it to reservations.jsonl.
  3. Optionally emails and/or texts you the request.

Standard library only. Run it:

    python server.py

Then set delivery.mode = "webhook" in config.js.

Email/SMS are configured with environment variables so no secrets live in
the repo. Gmail requires an *app password*, not your login password.

    SNOW_SMTP_HOST=smtp.gmail.com
    SNOW_SMTP_PORT=587
    SNOW_SMTP_USER=you@gmail.com
    SNOW_SMTP_PASS=abcd efgh ijkl mnop
    SNOW_NOTIFY_EMAIL=you@gmail.com          # where reservations land
    SNOW_NOTIFY_SMS=7015550134@vtext.com     # optional carrier email-to-SMS
    SNOW_SHARED_SECRET=whatever              # optional, must match config.js
"""

from __future__ import annotations

import json
import os
import smtplib
import ssl
import threading
from datetime import datetime
from email.message import EmailMessage
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).parent
LOG = HERE / "reservations.jsonl"
PORT = int(os.environ.get("SNOW_PORT", "8123"))
SECRET = os.environ.get("SNOW_SHARED_SECRET", "")


# --------------------------------------------------------------- formatting
def as_text(p: dict) -> str:
    cust = p.get("customer", {})
    prop = p.get("property", {})
    job = p.get("job", {})
    est = p.get("estimate", {})
    # The form resolves every id to its label before sending, so this file
    # never needs a copy of the service list. Falls back to raw ids.
    r = p.get("readable", {})

    lines = [
        f"NEW RESERVATION  {p.get('reference', '?')}",
        "",
        # ASCII only: Windows consoles and SMS gateways mangle typographic dashes.
        f"{cust.get('name')} - {cust.get('phone')}"
        + (f" / {cust['email']}" if cust.get("email") else ""),
        f"{prop.get('address')}, {prop.get('city')} {prop.get('zip', '')}".strip(),
        "",
        f"Services: {r.get('services') or ', '.join(job.get('services', []))}",
        f"Plan: {r.get('plan') or job.get('plan')}"
        + (f" (after {job['trigger']})" if job.get("trigger") else ""),
        f"Start: {job.get('startDate')} / {r.get('timeWindow') or job.get('timeWindow')}",
    ]
    if r.get("drivewaySize") or prop.get("drivewaySize"):
        lines.append(f"Driveway: {r.get('drivewaySize') or prop['drivewaySize']}")
    if r.get("surface") or prop.get("surface"):
        lines.append(f"Surface: {r.get('surface') or prop['surface']}")
    if r.get("flags") or prop.get("flags"):
        lines.append(f"Flags: {r.get('flags') or ', '.join(prop['flags'])}")
    if prop.get("pileSpot"):
        lines.append(f"Snow goes: {prop['pileSpot']}")
    if job.get("notes"):
        lines.append(f"Notes: {job['notes']}")
    lines += ["", f"Estimate: ${est.get('amount')} ({est.get('kind')})"]
    return "\n".join(lines)


# --------------------------------------------------------------- notifying
def send_mail(to_addr: str, subject: str, body: str) -> None:
    host = os.environ.get("SNOW_SMTP_HOST")
    user = os.environ.get("SNOW_SMTP_USER")
    password = os.environ.get("SNOW_SMTP_PASS")
    if not (host and user and password and to_addr):
        return

    msg = EmailMessage()
    msg["From"] = user
    msg["To"] = to_addr
    msg["Subject"] = subject
    msg.set_content(body)

    port = int(os.environ.get("SNOW_SMTP_PORT", "587"))
    with smtplib.SMTP(host, port, timeout=20) as s:
        s.starttls(context=ssl.create_default_context())
        s.login(user, password)
        s.send_message(msg)


def notify(payload: dict) -> None:
    """Fire-and-forget so a slow mail server never stalls the form."""
    text = as_text(payload)
    ref = payload.get("reference", "")
    addr = payload.get("property", {}).get("address", "")

    def run() -> None:
        try:
            send_mail(os.environ.get("SNOW_NOTIFY_EMAIL", ""),
                      f"Snow reservation {ref} — {addr}", text)
            sms = os.environ.get("SNOW_NOTIFY_SMS", "")
            if sms:
                # Carrier gateways truncate hard — send the short version.
                cust = payload.get("customer", {})
                send_mail(sms, "", f"{ref} {cust.get('name')} {cust.get('phone')} {addr}")
        except Exception as exc:  # noqa: BLE001 — never take the server down
            print(f"  ! notify failed: {exc}", flush=True)

    threading.Thread(target=run, daemon=True).start()


# --------------------------------------------------------------- http
class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(HERE), **kw)

    def handle_one_request(self):
        # Browsers abort static requests all the time; don't dump a traceback.
        try:
            super().handle_one_request()
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            self.close_connection = True

    def _json(self, code: int, obj: dict) -> None:
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        # Never let the browser cache the form while you're editing it.
        if self.path.endswith((".js", ".css", ".html", "/")):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_OPTIONS(self):  # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Snow-Secret")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.end_headers()

    def do_POST(self):  # noqa: N802
        if self.path.rstrip("/") != "/api/reservations":
            return self._json(404, {"error": "not found"})

        if SECRET and self.headers.get("X-Snow-Secret") != SECRET:
            return self._json(403, {"error": "bad secret"})

        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > 64_000:
            return self._json(400, {"error": "bad length"})

        try:
            payload = json.loads(self.rfile.read(length))
        except json.JSONDecodeError:
            return self._json(400, {"error": "bad json"})

        cust = payload.get("customer") or {}
        if not cust.get("name") or not cust.get("phone"):
            return self._json(400, {"error": "name and phone required"})

        payload["receivedAt"] = datetime.now().astimezone().isoformat()
        with LOG.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(payload) + "\n")

        print(f"\n{'=' * 60}\n{as_text(payload)}\n{'=' * 60}", flush=True)
        notify(payload)

        return self._json(200, {"ok": True, "reference": payload.get("reference")})

    def log_message(self, fmt, *args):
        """Quieter console: log POSTs and errors, skip routine static hits."""
        line = fmt % args
        if "POST" in line or "code 4" in line or "code 5" in line:
            super().log_message("%s", line)


if __name__ == "__main__":
    print(f"Form:  http://localhost:{PORT}/")
    print(f"Inbox: {LOG}")
    if not os.environ.get("SNOW_SMTP_HOST"):
        print("SMTP not configured — reservations will log to the file only.")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
