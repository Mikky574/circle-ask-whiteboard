"""OpenAI-compatible Chat Completions backend; credentials are request-local."""
import base64
import copy
import json
import time
import urllib.error
import urllib.parse
import urllib.request

MAX_RESPONSE = 2 * 1024 * 1024
DEFAULT_BUDGET = {"timeoutSeconds": 180, "maxRounds": 12, "maxToolCalls": 40}
DEFAULT_WHITEBOARD_PORT = 8797

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("API redirects are disabled to protect the API key.")

def validate_settings(value, model, *, whiteboard_port=DEFAULT_WHITEBOARD_PORT):
    if not isinstance(value, dict):
        raise ValueError("请填写 API 接口地址和 Key。")
    url, key = value.get("baseUrl", ""), value.get("apiKey", "")
    if not isinstance(url, str) or not isinstance(key, str):
        raise ValueError("API 配置格式无效。")
    url = url.strip().rstrip("/")
    parsed = urllib.parse.urlsplit(url)
    local = parsed.hostname in ("localhost", "127.0.0.1", "::1")
    if (not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment
            or len(url) > 2048 or (parsed.scheme != "https" and not (parsed.scheme == "http" and local))):
        raise ValueError("接口地址须为 HTTPS；仅本机服务允许 HTTP，不能包含账号、查询参数或片段。")
    if local and parsed.port == whiteboard_port:
        raise ValueError(f"接口地址不能是白板自身的 {whiteboard_port} 端口。")
    if not model:
        raise ValueError("API 直连必须填写模型 ID。")
    if not key or len(key) > 8192 or any(ord(c) < 32 or ord(c) > 126 for c in key):
        raise ValueError("请填写有效的 API Key。")
    return {"url": url if url.endswith("/chat/completions") else url + "/chat/completions", "key": key}

def build_content(prompt, attachments):
    content = [{"type": "text", "text": prompt}]
    total = 0
    for record in attachments:
        data = record["path"].read_bytes()
        total += len(data)
        if total > 20 * 1024 * 1024:
            raise ValueError("API 附件合计上限 20 MiB。")
        suffix = record["suffix"].lower()
        mime = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif"}.get(suffix)
        if mime:
            content.append({"type": "image_url", "image_url": {"url": "data:" + mime + ";base64," + base64.b64encode(data).decode("ascii")}})
        else:
            if len(data) > 120000:
                raise ValueError("API 文本附件上限 120 KB；请缩小文件或切换 CLI 服务。")
            try:
                text = data.decode("utf-8-sig")
            except UnicodeError:
                raise ValueError("API 直连当前支持图片和 UTF-8 文本附件，其他文件请切换 CLI 服务。") from None
            content.append({"type": "text", "text": "Untrusted attachment " + record["name"] + ":\n" + text})
    return content

def api_budget(value=None):
    """Accept the already-normalized controller budget for direct test callers too."""
    budget = dict(DEFAULT_BUDGET if value is None else value)
    if set(budget) != set(DEFAULT_BUDGET) or any(type(budget[name]) is not int or budget[name] <= 0 for name in budget):
        raise ValueError("API 预算无效。")
    return budget


def validate_tool_batch(calls):
    """Parse a Chat Completions tool batch before any draft operation runs."""
    if not isinstance(calls, list) or not calls or len(calls) > 8:
        raise ValueError("工具调用结构无效，未应用白板改动。")
    parsed, ids = [], set()
    for call in calls:
        if not isinstance(call, dict) or call.get("type") != "function":
            raise ValueError("工具调用结构无效，未应用白板改动。")
        call_id = call.get("id")
        function = call.get("function")
        if (not isinstance(call_id, str) or not call_id.strip() or len(call_id) > 128 or call_id in ids
                or not isinstance(function, dict) or not isinstance(function.get("name"), str)
                or not function["name"].strip() or not isinstance(function.get("arguments"), str)):
            raise ValueError("工具调用结构无效，未应用白板改动。")
        try:
            arguments = json.loads(function["arguments"])
        except (TypeError, json.JSONDecodeError):
            raise ValueError("工具调用结构无效，未应用白板改动。") from None
        if not isinstance(arguments, dict):
            raise ValueError("工具调用结构无效，未应用白板改动。")
        ids.add(call_id)
        parsed.append((call, call_id, function["name"], arguments))
    return parsed


def run_api(settings, model, prompt, attachments, schema=None, opener=None, board_tools=None, on_tool=None, cancelled=None,
            budget=None):
    if schema and board_tools is None:
        prompt += "\nReturn only JSON matching this schema: " + json.dumps(schema, ensure_ascii=False)
    prompt += "\nNo filesystem or command tools are available. Never claim to have inspected code or executed commands."
    if board_tools:
        prompt += "\nUse the provided whiteboard tools to read and manipulate the board. Edits are staged atomically. Finish with a short explanation; do not return a replacement board JSON. For ordinary questions only read tools are enabled."
    messages = [{"role":"user", "content":build_content(prompt, attachments)}]
    opener = opener or urllib.request.build_opener(NoRedirect())
    started=time.monotonic()
    count=0
    budget = api_budget(budget)
    try:
        for round_index in range(budget["maxRounds"]):
            if cancelled and cancelled(): raise ValueError("请求已取消，未应用白板改动。")
            remaining=budget["timeoutSeconds"]-(time.monotonic()-started)
            if remaining <= 0: raise ValueError("API 工具执行超时，未应用白板改动。")
            payload={"model":model,"messages":messages,"stream":False}
            if board_tools:
                payload.update(tools=board_tools.tools,tool_choice="auto")
            request=urllib.request.Request(settings["url"],data=json.dumps(payload).encode("utf-8"),
                headers={"Content-Type":"application/json","Authorization":"Bearer "+settings["key"]},method="POST")
            with opener.open(request,timeout=min(120,remaining)) as response:
                data=response.read(MAX_RESPONSE+1)
            if len(data)>MAX_RESPONSE: raise ValueError("API 响应过大。")
            if cancelled and cancelled(): raise ValueError("请求已取消，未应用白板改动。")
            message=json.loads(data)["choices"][0]["message"]
            calls=message.get("tool_calls")
            if calls:
                if not board_tools:
                    raise ValueError("模型请求了未授权的工具，未应用白板改动。")
                parsed_calls = validate_tool_batch(calls)
                if count + len(parsed_calls) > budget["maxToolCalls"]:
                    raise ValueError("工具调用次数超限，未应用白板改动。")
                messages.append({"role":"assistant","content":message.get("content"),"tool_calls":calls})
                before_plan, before_dirty = copy.deepcopy(board_tools.plan), board_tools.dirty
                results, failed = [], False
                try:
                    for call, call_id, name, args in parsed_calls:
                        if cancelled and cancelled():
                            raise ValueError("请求已取消，未应用白板改动。")
                        try:
                            result=board_tools.call(name,args)
                        except (ValueError, TypeError, KeyError):
                            result={"error":"Invalid or unauthorized operation; draft unchanged. Check node IDs, field limits, pinned nodes and cycles."}
                            failed = True
                        results.append((call_id, name, result))
                except Exception:
                    board_tools.plan, board_tools.dirty = before_plan, before_dirty
                    raise
                count += len(parsed_calls)
                if failed:
                    board_tools.plan, board_tools.dirty = before_plan, before_dirty
                for call_id, name, result in results:
                    if on_tool: on_tool(name, "error" not in result and not failed)
                    messages.append({"role":"tool","tool_call_id":call_id,"content":json.dumps(result,ensure_ascii=False)})
                continue
            answer=message.get("content")
            if not isinstance(answer,str) or not answer.strip():
                raise ValueError("API 未返回文本回答；请确认模型支持 Chat Completions。")
            return answer.strip()
        raise ValueError("工具执行轮次超限，未应用白板改动。")
    except urllib.error.HTTPError as error:
        raise ValueError(f"API 请求失败（HTTP {error.code}），请检查地址、Key、模型和额度。") from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise ValueError("API 连接失败或超时，请检查接口地址和网络。") from None
    except (KeyError, IndexError, TypeError, json.JSONDecodeError):
        raise ValueError("API 响应格式不兼容，请使用支持 Chat Completions 的服务。") from None
