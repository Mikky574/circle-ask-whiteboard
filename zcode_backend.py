"""Adapter for the installed ZCode app server's stdio protocol."""

import json
import mimetypes
import os
import re
import shutil
import sys
from pathlib import Path

from agent_trace import zcode_trace


MAX_FRAME = 16 * 1024 * 1024
OUTPUT_LIMIT = 4800
STDERR_CAUSES = {
    "ECONNREFUSED": "连接被拒绝", "ECONNRESET": "连接被重置",
    "ENOTFOUND": "无法解析服务器地址", "EAI_AGAIN": "DNS 暂时不可用",
    "ETIMEDOUT": "连接超时", "UND_ERR_CONNECT_TIMEOUT": "连接超时",
    "CERT_HAS_EXPIRED": "TLS 证书已过期", "UNABLE_TO_VERIFY_LEAF_SIGNATURE": "TLS 证书验证失败",
}
HTTP_DIAGNOSTIC = re.compile(
    r'\b(?:HTTP(?:/\d(?:\.\d)?)?\s+|(?:status(?:Code)?|httpStatus)["\']?\s*[:=]\s*)'
    r'(400|401|403|404|408|429|500|502|503|504)\b', re.I,
)


def read_zcode_stderr(stream, events):
    # stderr may contain URLs, request bodies, headers, or plugin output. Emit
    # only detected codes and fixed descriptions, and always drain the pipe.
    seen = set()
    try:
        while isinstance(raw := stream.readline(4096), bytes) and raw:
            line = raw.decode("utf-8", errors="replace")
            match = HTTP_DIAGNOSTIC.search(line)
            cause = next((code for code in STDERR_CAUSES if code in line), None)
            if match:
                detail = f"HTTP {match[1]}"
            elif cause:
                detail = f"{STDERR_CAUSES[cause]}（{cause}）"
            else:
                detail = {
                    "login required": "登录或鉴权失败",
                    "rate limit": "模型供应商限流或额度不足",
                    "model_unavailable": "模型或供应商配置异常",
                }.get(safe_diagnostic(line), "CLI 写入诊断信息")
            if detail not in seen and len(seen) < 16:
                seen.add(detail)
                events.put(("stderr", detail))
    except (OSError, ValueError):
        pass

NATIVE_ATTACHMENTS = {"image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf"}
READ_TOOLS = ("mcp__whiteboard__list_files", "mcp__whiteboard__read_file")
EDIT_TOOLS = (*READ_TOOLS, "mcp__whiteboard__replace_text")


def zcode_command():
    executable = shutil.which(os.environ.get("WHITEBOARD_ZCODE_EXECUTABLE", "zcode"))
    if not executable:
        return None
    launcher = Path(executable).resolve()
    if os.name == "nt" and launcher.suffix.lower() == ".cmd":
        install = launcher.parent.parent
        node = install / "Toolchain" / "node-v24.14.0-win-x64" / "node.exe"
        cli = install / "source" / "apps" / "zcode-cli" / "packages" / "cli" / "dist" / "zcode.cjs"
        if node.is_file() and cli.is_file():
            return [str(node), str(cli), "app-server", "--stdio"]
    return [str(launcher), "app-server", "--stdio"]


def select_model(model, settings):
    if not model:
        return None
    provider, separator, model_id = model.partition("/")
    if not separator:
        provider, model_id = "", model
    matches = [entry for entry in settings["available"]
               if entry["ref"]["modelId"] == model_id
               and (not provider or entry["ref"]["providerId"] == provider)
               and not entry.get("disabledReason")]
    current = settings.get("current") or {}
    if current.get("modelId") == model_id and (not provider or current.get("providerId") == provider):
        return current
    if len(matches) != 1:
        raise ZCodeError("unknown model; use providerId/modelId")
    entry = matches[0]
    selection = entry["ref"]
    reasoning = entry.get("reasoning") or {}
    if reasoning.get("defaultLevel") and not selection.get("options"):
        selection = {**selection, "options": {"reasoningLevel": reasoning["defaultLevel"]}}
    return selection


def native_attachments(workspace, attachments):
    for attachment in attachments:
        path = Path(attachment).resolve(strict=True)
        if not path.is_relative_to(workspace) or not path.is_file():
            raise ZCodeError("invalid attachment path")
        mime_type, _ = mimetypes.guess_type(path.name)
        if mime_type in NATIVE_ATTACHMENTS:
            yield {"kind": "pdf" if mime_type == "application/pdf" else "image",
                   "filename": path.name, "localPath": str(path), "mimeType": mime_type}


class ZCodeError(Exception):
    pass


def safe_diagnostic(error):
    value = json.dumps(error, ensure_ascii=False).lower()
    if any(word in value for word in ("unauthorized", "not logged in", "login required", "401",
                                       "credential", "api key", "api_key", "authentication", "鉴权", "登录")):
        return "login required"
    if any(word in value for word in ("rate limit", "quota", "429", "用量", "限流")):
        return "rate limit"
    if any(word in value for word in ("model", "provider", "模型", "供应商")):
        return "model_unavailable"
    return "ZCode protocol turn failed"


class ZCodeConnection:
    def __init__(self, process, tools=()):
        self.process = process
        self.tools = frozenset(tools)
        self.session_id = None
        self.request_id = 0
        self.account_headers_requested = False

    def send(self, message):
        self.process.stdin.write((json.dumps(message, ensure_ascii=False) + "\n").encode("utf-8"))
        self.process.stdin.flush()

    def begin_request(self, method, params):
        self.request_id += 1
        self.send({"id": self.request_id, "method": method, "params": params})
        return self.request_id

    def receive(self):
        while line := self.process.stdout.readline(MAX_FRAME + 1):
            if len(line) > MAX_FRAME:
                raise ZCodeError("ZCode protocol frame too large")
            message = json.loads(line)
            if "id" not in message or "method" not in message:
                return message
            self.respond(message["id"], message["method"], message.get("params", {}))
        raise ZCodeError("ZCode process ended before completing the turn")

    def respond(self, request_id, method, params):
        if method == "session/requestRuntimePreferences":
            self.send({"id": request_id, "result": {"nativeSearchEnhancementsEnabled": False,
                                                     "memoryEnabled": False,
                                                     "askUserQuestionAutoResolutionEnabled": False}})
        elif method == "interaction/requestPermission":
            allowed = (self.session_id is not None and params.get("sessionId") == self.session_id
                       and params.get("toolName") in self.tools)
            self.send({"id": request_id, "result": {"decision": "allow" if allowed else "deny"}})
        else:
            if method == "interaction/requestProviderRuntimeHeaders":
                self.account_headers_requested = True
            self.send({"id": request_id, "error": {"code": -32601, "message": "Host method unavailable"}})

    def response(self, message):
        if "error" in message:
            diagnostic = "login required" if self.account_headers_requested else safe_diagnostic(message["error"])
            raise ZCodeError(diagnostic)
        return message["result"]

    def request(self, method, params):
        request_id = self.begin_request(method, params)
        while True:
            message = self.receive()
            if message.get("id") == request_id:
                return self.response(message)


def run_zcode(process, prompt, model, mode, workspace, events, attachments=(), repository=None, *, repair_structured=None):
    tools = EDIT_TOOLS if mode == "edit" else READ_TOOLS
    connection = ZCodeConnection(process, tools)
    workspace = Path(workspace).resolve()
    try:
        workspace_tool = Path(__file__).resolve().with_name("zcode_workspace.py")
        if not workspace_tool.is_file():
            raise ZCodeError("ZCode workspace tools unavailable")
        workspace_args = ["-I", str(workspace_tool), str(workspace), mode]
        if repository is not None:
            workspace_args.append(str(repository))
        events.put(("status", "ZCode 正在创建会话并加载模型配置…"))
        snapshot = connection.request("session/create", {
            "workspace": {"workspacePath": str(workspace), "workspaceKey": str(workspace)},
            "mode": "edit" if mode == "edit" else "plan",
            "persistence": "deferred",
            "titleGenerationEnabled": False,
            "mcpServers": [{"name": "whiteboard", "command": sys.executable,
                            "args": workspace_args, "env": [],
                            "isolation": "session", "protocolVersion": "legacy", "timeoutMs": 10000}],
            # The bridge MCP scopes reads to the workspace and bound repository.
            "toolAllowlist": list(tools),
        })
        session_id = snapshot["session"]["sessionId"]
        connection.session_id = session_id
        session = {"sessionId": session_id}
        settings = snapshot["settings"]["model"]
        selection = select_model(model, settings)
        if not selection and not settings.get("current"):
            raise ZCodeError("no model; configure a provider in ZCode")
        if selection:
            connection.request("session/setModel", {**session, "model": selection,
                                                    "persistAsWorkspaceLastUsed": False})
        connection.request("session/subscribe", {**session, "deliveryKind": "desktop-continuous"})
        events.put(("status", "ZCode 会话已连接，正在发送模型请求…"))
        send_id = connection.begin_request("session/send", {**session, "content": prompt,
                                             "attachments": list(native_attachments(workspace, attachments))})
        answer = read_turn(connection, send_id, session_id, mode, events)
        events.put(("answer", answer))
        if answer.strip() and repair_structured and (repair := repair_structured(answer)):
            events.put(("structured_repair", ""))
            send_id = connection.begin_request("session/send", {**session, "content": repair, "attachments": []})
            answer = read_turn(connection, send_id, session_id, mode, events)
            events.put(("answer", answer))
    except ZCodeError as error:
        events.put(("diagnostic", str(error)))
    except (OSError, ValueError, KeyError, TypeError):
        events.put(("diagnostic", "ZCode protocol response unavailable"))
    finally:
        try:
            process.stdin.close()
        except OSError:
            pass
        events.put(("eof", ""))


def read_turn(connection, send_id, session_id, mode, events):
    reported_tool = False
    output_length = 0
    recovery_attempt = 0
    pending = {}
    while True:
        message = connection.receive()
        if message.get("id") == send_id:
            connection.response(message)
            continue
        params = message.get("params", {})
        if params.get("sessionId") != session_id:
            continue
        if message.get("method") == "state.updated" and params.get("reason") == "prompt_failed":
            raise ZCodeError("login required" if connection.account_headers_requested else "ZCode turn failed")
        if message.get("method") != "session/event":
            continue
        kind = params.get("type")
        payload = params.get("payload", {})
        if kind == "turn.started":
            events.put(("status", "ZCode 正在处理当前白板上下文…"))
        elif kind == "model.streaming" and isinstance(payload, dict) and payload.get("kind") == "text_delta":
            delta = payload.get("delta")
            remaining = OUTPUT_LIMIT + 1 - output_length
            if isinstance(delta, str) and delta and remaining > 0:
                chunk = delta[:remaining]
                output_length += len(chunk)
                events.put(("output", chunk))
        elif kind == "streamRecovery.updated" and isinstance(payload, dict):
            retry = payload.get("retryNumber")
            if type(retry) is int and recovery_attempt < retry <= 100:
                recovery_attempt = retry
                events.put(("status", f"ZCode 正在恢复模型输出流（第 {retry} 次）…"))
        elif kind == "tool.updated":
            if not reported_tool:
                reported_tool = True
                status = "ZCode 正在检查或编辑源码…" if mode == "edit" else "ZCode 正在读取相关文件…"
                events.put(("status", status))
            if trace := zcode_trace(payload, pending):
                events.put(("trace", trace))
        elif kind == "permission.resolved" and isinstance(payload, dict) and payload.get("decision") == "deny":
            if trace := zcode_trace({"kind": "error", "toolCallId": payload.get("toolCallId")}, pending):
                events.put(("trace", trace))
        elif kind == "turn.failed":
            diagnostic = "login required" if connection.account_headers_requested else safe_diagnostic(payload)
            raise ZCodeError(diagnostic)
        elif kind == "turn.completed":
            if payload.get("resultType") == "success" and isinstance(payload.get("response"), str):
                return payload["response"]
            raise ZCodeError("ZCode turn did not complete successfully")
