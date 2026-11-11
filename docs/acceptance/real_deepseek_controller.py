"""One-shot, loopback-only controller for the real DeepSeek acceptance run.

It deliberately reuses the product request parser, controller, ApiAdapter and
tool loop.  The sole test-only difference is a server-side credential injection
after the browser request is parsed: the browser submits an empty API-key field.
No credential is written, printed, put in a command line, or returned by this
controller.
"""
from __future__ import annotations

import copy
import errno
import json
import os
from pathlib import Path
import secrets
import socket
import ssl
import sys
import threading
import time
import urllib.error
import urllib.request

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT))

import api_backend  # noqa: E402
import board_tools  # noqa: E402
import server as product_server  # noqa: E402

TARGET_URL = "https://api.deepseek.com/chat/completions"
MODEL = "deepseek-flash"
MAX_HTTP_REQUESTS = 3
MAX_TOOL_CALLS = 4
MAX_TOKENS = 1024
TIMEOUT_SECONDS = 60
RUNS_DIR = HERE / "telemetry-runs"
REAL_AUTH_FLAG = "REAL_DEEPSEEK_ACCEPTANCE_AUTHORIZATION"
REAL_AUTH_VALUE = "ONE_TIME_USER_AUTHORIZED"

TRANSPORT_ERROR_CODES = {
    errno.ETIMEDOUT: "timeout",
    errno.ECONNREFUSED: "connection-refused",
    errno.ECONNRESET: "connection-reset",
    # urllib can receive native Winsock codes before Python maps them to errno.
    10060: "timeout",
    10061: "connection-refused",
    10054: "connection-reset",
}


class TelemetryPersistenceError(RuntimeError):
    """A request must not be sent unless its pre-send state reached disk."""


def utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


class TelemetryStore:
    """Append an intent journal, then atomically replace a sanitized snapshot.

    The journal has no headers, credentials, request body, response body, or
    user content.  A failed pre-send write raises, so the transport is
    fail-closed rather than making an unaccounted request.
    """
    def __init__(self, root: Path, run_id: str):
        self.root, self.run_id = root, run_id
        self.snapshot_path = root / f"{run_id}.json"
        self.journal_path = root / f"{run_id}.intent.ndjson"
        self._lock = threading.Lock()

    def persist(self, event: str, telemetry: dict) -> None:
        record = {"at": utc_now(), "runId": self.run_id, "event": event}
        snapshot = {"schemaVersion": 2, "runId": self.run_id, "updatedAt": record["at"],
                    "lastEvent": event, "telemetry": copy.deepcopy(telemetry)}
        try:
            with self._lock:
                self.root.mkdir(parents=True, exist_ok=True)
                # fsync means the intent is durable before any network send.
                with self.journal_path.open("a", encoding="utf-8") as journal:
                    journal.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
                    journal.flush()
                    os.fsync(journal.fileno())
                temp = self.snapshot_path.with_suffix(".tmp")
                with temp.open("w", encoding="utf-8") as output:
                    json.dump(snapshot, output, ensure_ascii=False, separators=(",", ":"))
                    output.write("\n")
                    output.flush()
                    os.fsync(output.fileno())
                os.replace(temp, self.snapshot_path)
        except OSError as error:
            raise TelemetryPersistenceError("sanitized telemetry persistence failed") from error


def load_key() -> str:
    """Read exactly the approved user-scoped value, without probing a provider."""
    value = os.environ.get("DEEPSEEK_API_KEY", "")
    if value:
        return value
    if os.name == "nt":
        try:
            import winreg

            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Environment") as key:
                value, _ = winreg.QueryValueEx(key, "DEEPSEEK_API_KEY")
            return value if isinstance(value, str) else ""
        except OSError:
            return ""
    return ""


def public_error(error: BaseException) -> str:
    """Do not reflect request bodies, headers, or provider text into reports."""
    if isinstance(error, ValueError):
        return str(error)[:240]
    return type(error).__name__


def transport_category(reason: object) -> str:
    if isinstance(reason, (socket.gaierror, socket.herror)):
        return "dns"
    if isinstance(reason, ssl.SSLError):
        return "tls"
    if isinstance(reason, TimeoutError):
        return "timeout"
    if isinstance(reason, ConnectionRefusedError):
        return "connection-refused"
    if isinstance(reason, ConnectionResetError):
        return "connection-reset"
    if isinstance(reason, OSError):
        for code in (reason.errno, getattr(reason, "winerror", None)):
            if type(code) is int and code in TRANSPORT_ERROR_CODES:
                return TRANSPORT_ERROR_CODES[code]
        reason = reason.args[0] if reason.args else None
    # http.client reports CONNECT failures using this fixed prefix and a status code.
    prefix = "Tunnel connection failed: "
    if isinstance(reason, str) and reason.startswith(prefix):
        status = reason[len(prefix):len(prefix) + 4]
        if (len(status) == 4 and status[0] in "12345" and status[3] == " "
                and status[1:3].isascii() and status[1:3].isdigit()):
            return "proxy"
    return "unknown"


class ResponseProxy:
    def __init__(self, response, state):
        self._response = response
        self._state = state

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self._response.close()
        return False

    def read(self, amount=-1):
        raw = self._response.read(amount)
        try:
            value = json.loads(raw)
            usage = value.get("usage")
            if isinstance(usage, dict):
                self._state.telemetry["vendorUsage"] = {
                    name: usage[name]
                    for name in ("prompt_tokens", "completion_tokens", "total_tokens")
                    if isinstance(usage.get(name), int)
                }
                self._state.persist("provider_usage_received")
        except (UnicodeError, json.JSONDecodeError, TypeError, AttributeError):
            pass
        return raw

    def __getattr__(self, name):
        return getattr(self._response, name)


class CountingOpener:
    """Transport guard: exact destination, no redirects, bounded requests/tokens/time."""
    def __init__(self, state, delegate=None):
        self.state = state
        self.telemetry = state.telemetry
        self.started = time.monotonic()
        self.delegate = delegate or urllib.request.build_opener(api_backend.NoRedirect())

    def open(self, request, timeout=None):
        if time.monotonic() - self.started >= TIMEOUT_SECONDS:
            raise TimeoutError("real acceptance time budget exhausted")
        if request.full_url != TARGET_URL:
            raise ValueError("real acceptance blocked a non-DeepSeek destination")
        authorization = request.get_header("Authorization") or ""
        if not authorization.startswith("Bearer ") or len(authorization) <= len("Bearer "):
            raise ValueError("real acceptance missing server-side authorization")
        try:
            payload = json.loads(request.data.decode("utf-8"))
        except (AttributeError, UnicodeError, json.JSONDecodeError) as error:
            raise ValueError("real acceptance malformed provider payload") from error
        if payload.get("model") != MODEL:
            raise ValueError("real acceptance blocked an unexpected model")
        # This is test-transport enforcement, not a change to product defaults.
        payload["max_tokens"] = MAX_TOKENS
        request.data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if self.telemetry["http"]["attempted"] >= MAX_HTTP_REQUESTS:
            raise ValueError("real acceptance HTTP request limit reached")
        # This durable intent is deliberately before delegate.open().  If the
        # process dies after send, the snapshot still says attempted, never 0.
        self.telemetry["http"]["attempted"] += 1
        self.telemetry["http"]["outcome"] = "unknown"
        self.telemetry["maxTokensForced"] = all(
            [self.telemetry["maxTokensForced"], payload.get("max_tokens") == MAX_TOKENS]
        )
        self.state.persist("http_send_intent")
        try:
            response = self.delegate.open(request, timeout=min(float(timeout or TIMEOUT_SECONDS), TIMEOUT_SECONDS))
        except urllib.error.HTTPError as error:
            self.telemetry["providerHttpStatus"] = error.code
            # Deliberately retain no vendor body; its text could be untrusted.
            self.telemetry["providerError"] = {"kind": "HTTPError", "status": error.code}
            self.telemetry["http"]["outcome"] = "failed"
            self.state.persist("http_exception")
            raise
        except OSError as error:
            if isinstance(error, urllib.error.URLError):
                kind, reason = "URLError", error.reason
            else:
                kind = "TimeoutError" if isinstance(error, TimeoutError) else "OSError"
                reason = error
            self.telemetry["providerError"] = {"kind": kind, "category": transport_category(reason)}
            self.telemetry["http"]["outcome"] = "failed"
            self.state.persist("http_exception")
            raise
        if response.geturl() != TARGET_URL:
            response.close()
            self.telemetry["http"]["outcome"] = "failed"
            self.telemetry["providerError"] = {"kind": "RedirectBlocked"}
            self.state.persist("http_exception")
            raise ValueError("real acceptance blocked a redirected provider response")
        self.telemetry["providerHttpStatus"] = getattr(response, "status", 200)
        self.telemetry["http"]["succeeded"] += 1
        self.telemetry["http"]["outcome"] = "succeeded"
        self.state.persist("http_response_received")
        return ResponseProxy(response, self.state)


class RunState:
    def __init__(self, key: str = "", *, store: TelemetryStore | None = None, delegate=None):
        self.key = key
        self.run_id = store.run_id if store else secrets.token_urlsafe(18)
        self.store = store or TelemetryStore(RUNS_DIR, self.run_id)
        self.telemetry = {
            "runId": self.run_id,
            "fixedHostChecked": TARGET_URL == "https://api.deepseek.com/chat/completions",
            "sensitiveLoggingDisabled": True,
            "http": {"attempted": 0, "succeeded": 0, "outcome": "unknown"},
            "maxTokensForced": True,
            "providerHttpStatus": None,
            "providerError": None,
            "vendorUsage": None,
            "toolCalls": [],
            "candidateEventSent": False,
            "terminalEvent": None,
            "serverKeyInjection": "browser submitted no key; controller injected only into request-local ApiAdapter settings",
            "providerPromptPolicy": "initial prompt contains only synthetic A01 title/target and whiteboard tool descriptions",
        }
        self.transport = CountingOpener(self, delegate)

    def persist(self, event: str) -> None:
        self.store.persist(event, self.telemetry)

    def sanitized(self):
        return copy.deepcopy(self.telemetry)


STATE: RunState | None = None
ORIGINAL_BACKEND_REQUEST = product_server.backend_request_from_body
ORIGINAL_RUN_API = product_server.run_api
ORIGINAL_BUILD_PROMPT = product_server.build_prompt
ORIGINAL_VALIDATE_BATCH = api_backend.validate_tool_batch
ORIGINAL_TOOL_CALL = board_tools.BoardTools.call


def inject_backend_request(body, parsed):
    """Keep browser key blank; inject only after normal product parsing."""
    assert STATE is not None
    raw = json.loads(body.decode("utf-8"))
    if raw.get("backend") != "api" or raw.get("model") != MODEL:
        raise ValueError("real acceptance only permits the approved API/model")
    api = raw.get("api")
    if not isinstance(api, dict) or api.get("apiKey") not in (None, ""):
        raise ValueError("real acceptance requires an empty browser API-key field")
    raw["api"] = {"baseUrl": TARGET_URL, "apiKey": STATE.key}
    raw["budget"] = {
        "timeoutSeconds": TIMEOUT_SECONDS,
        "maxRounds": MAX_HTTP_REQUESTS,
        "maxToolCalls": MAX_TOOL_CALLS,
    }
    return ORIGINAL_BACKEND_REQUEST(json.dumps(raw, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), parsed)


def bounded_run_api(*args, **kwargs):
    assert STATE is not None
    kwargs["opener"] = STATE.transport
    return ORIGINAL_RUN_API(*args, **kwargs)


def minimal_prompt(_mode, _question, _context, *, source_access=False):
    # Do not forward normal UI/project/source context to the provider.
    return (
        'Synthetic acceptance whiteboard only. Node A01 currently has title "合成初始标题". '
        'Change exactly A01 title to "已验证工具调用". '
        "You must use the supplied whiteboard function update_node; do not merely describe an edit. "
        "Do not request or infer files, people, credentials, or other data."
    )


def capture_tool_batch(calls):
    parsed = ORIGINAL_VALIDATE_BATCH(calls)
    assert STATE is not None
    for _call, call_id, name, args in parsed:
        if len(STATE.telemetry["toolCalls"]) >= MAX_TOOL_CALLS:
            raise ValueError("real acceptance tool call limit reached")
        summary = {"id": args.get("id")} if isinstance(args, dict) else {}
        if isinstance(args, dict) and "title" in args:
            summary["title"] = "[synthetic target]"
        STATE.telemetry["toolCalls"].append({"id": call_id[:128], "name": name, "parameters": summary, "executed": False, "ok": False})
        STATE.persist("tool_intent")
    return parsed


def capture_tool_execution(self, name, args):
    assert STATE is not None
    STATE.persist("tool_execution_started")
    try:
        result = ORIGINAL_TOOL_CALL(self, name, args)
    except BaseException as error:
        for item in reversed(STATE.telemetry["toolCalls"]):
            if item["name"] == name and not item["executed"]:
                item["executed"] = True
                item["ok"] = False
                item["error"] = public_error(error)
                break
        STATE.persist("tool_execution_exception")
        raise
    for item in reversed(STATE.telemetry["toolCalls"]):
        if item["name"] == name and not item["executed"]:
            item["executed"] = True
            item["ok"] = "error" not in result
            break
    STATE.persist("tool_execution_finished")
    return result


product_server.backend_request_from_body = inject_backend_request
product_server.run_api = bounded_run_api
product_server.build_prompt = minimal_prompt
api_backend.validate_tool_batch = capture_tool_batch
board_tools.BoardTools.call = capture_tool_execution


class AcceptanceHandler(product_server.WhiteboardHandler):
    def log_message(self, *_args):
        # Do not log headers or request paths.  In particular, never log auth.
        return

    def do_GET(self):
        if self.path == "/acceptance/telemetry":
            if not self.host_allowed():
                self.send_json(403, {"type": "error", "text": "invalid loopback host"})
                return
            self.send_json(200, STATE.sanitized() if STATE else {"error": "missing state"})
            return
        super().do_GET()

    def do_POST(self):
        if self.path == "/acceptance/shutdown":
            if not self.host_allowed():
                self.send_json(403, {"type": "error", "text": "invalid loopback host"})
                return
            self.send_json(202, {"accepted": True})
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return
        super().do_POST()

    def send_event(self, event_type, **payload):
        if STATE is not None:
            if event_type == "map":
                STATE.telemetry["candidateEventSent"] = True
            if event_type in ("done", "error"):
                STATE.telemetry["terminalEvent"] = event_type
                STATE.persist("terminal_event")
        return super().send_event(event_type, **payload)


def main():
    global STATE
    # Offline/mock is the only default.  A real run needs a newly supplied,
    # one-time authorization flag; tests never set it.
    if os.environ.get("REAL_DEEPSEEK_ACCEPTANCE_MODE", "mock") != "real":
        print(json.dumps({"status": "dry-run", "reason": "default mock mode; no key read and no provider transport"}), flush=True)
        return 0
    if os.environ.get(REAL_AUTH_FLAG) != REAL_AUTH_VALUE:
        print(json.dumps({"status": "blocked", "reason": "fresh real-run authorization flag required"}), flush=True)
        return 2
    if TARGET_URL != "https://api.deepseek.com/chat/completions" or MODEL != "deepseek-flash":
        print(json.dumps({"status": "blocked", "reason": "fixed provider configuration mismatch"}), flush=True)
        return 2
    # Allocate and durably identify the run before even consulting a key.
    # This also leaves evidence for a blocked real-mode invocation.
    STATE = RunState()
    try:
        STATE.persist("run_intent")
    except TelemetryPersistenceError:
        # No server is started, so a real run cannot make an unjournaled send.
        print(json.dumps({"status": "blocked", "reason": "telemetry persistence unavailable"}), flush=True)
        return 2
    key = load_key()
    if not key:
        STATE.telemetry["terminalEvent"] = "blocked"
        try:
            STATE.persist("terminal_event")
        except TelemetryPersistenceError:
            pass
        print(json.dumps({"status": "blocked", "reason": "DEEPSEEK_API_KEY unavailable in the approved user environment location"}), flush=True)
        return 2
    STATE.key = key
    httpd = product_server.ThreadingHTTPServer(("127.0.0.1", 0), AcceptanceHandler)
    port = httpd.server_address[1]
    product_server.ALLOWED_HOSTS = {f"127.0.0.1:{port}"}
    print(json.dumps({"status": "ready", "host": "127.0.0.1", "port": port, "runId": STATE.run_id}), flush=True)
    try:
        httpd.serve_forever(poll_interval=0.1)
    finally:
        try:
            STATE.persist("process_terminating")
        except TelemetryPersistenceError:
            # Never print internal filesystem details or sensitive state.
            pass
        httpd.server_close()
        # Drop the sole live reference after the request/server lifecycle ends.
        STATE.key = ""


if __name__ == "__main__":
    raise SystemExit(main())
