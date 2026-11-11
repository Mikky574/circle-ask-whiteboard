"""Backend factory and common execution contract.

Transport-specific implementations remain behind adapters. Availability means the
adapter can be selected, not that credentials or upstream service were verified.
"""
from dataclasses import dataclass, field
import threading
import uuid
from typing import Any, Callable, Protocol, TypedDict
from api_backend import validate_settings

class BackendEvent(TypedDict, total=False):
    type: str
    text: str
    map: dict
    children: list[dict]
    changedFiles: list[str]

@dataclass
class BackendRequest:
    backend: str
    model: str
    mode: str
    question: str
    context: dict
    attachments: list
    # The original positional fields above are kept for callers from the
    # pre-factory UI.  Everything below is the normalized, backend-neutral
    # contract used by adapters and the controller.
    requestId: str = field(default_factory=lambda: uuid.uuid4().hex)
    intent: str = "ask"
    boardId: str = "whiteboard"
    baseRevision: str = ""
    permissions: tuple[str, ...] = ()
    budget: dict = field(default_factory=lambda: {"timeoutSeconds": 180, "maxRounds": 12, "maxToolCalls": 40})
    backendOptions: dict = field(default_factory=dict, repr=False)
    api: dict | None = field(default=None, repr=False)
    schema_path: Any = None


class CancellationToken:
    """One request's cancellation state and optional local transport hooks."""

    def __init__(self):
        self._lock = threading.Lock()
        self._hooks: list[Callable[[], None]] = []
        self._state = "active"

    def cancelled(self):
        with self._lock:
            return self._state == "cancelled"

    def register(self, hook):
        with self._lock:
            cancelled = self._state == "cancelled"
            if not cancelled:
                self._hooks.append(hook)
        if cancelled:
            hook()

    def cancel(self):
        with self._lock:
            if self._state != "active":
                return False
            self._state = "cancelled"
            hooks, self._hooks = self._hooks, []
        for hook in hooks:
            try:
                hook()
            except OSError:
                pass
        return True

    def claim_commit(self):
        """Linearize staged source submission against cancellation.

        Cancellation hooks run outside this lock.  Once claimed, a later
        cancel returns False rather than falsely reporting that it stopped a
        source write which has already won the boundary.
        """
        with self._lock:
            if self._state != "active":
                return False
            self._state = "committed"
            return True

class Runtime(Protocol):
    def run_turn(self, *args, request: BackendRequest, cancellation: CancellationToken): ...
    def run_api_turn(self, *args, request: BackendRequest, cancellation: CancellationToken): ...

class BackendAdapter:
    id = ""
    label = ""
    def __init__(self):
        self._cancellations = {}
        self._cancellation_lock = threading.Lock()

    def _begin(self, request):
        with self._cancellation_lock:
            token = self._cancellations.get(request.requestId)
            if token is None:
                token = CancellationToken()
                self._cancellations[request.requestId] = token
        return token

    def begin(self, request):
        """Reserve the token before the controller exposes request cancellation."""
        return self._begin(request)

    def _finish(self, request):
        with self._cancellation_lock:
            self._cancellations.pop(request.requestId, None)

    def cancel(self, requestId):
        """Cancel this in-flight request if the adapter still owns it.

        API cancellation only marks the request and discards a later HTTP
        response (urllib has no safe in-flight abort here); CLI cancellation
        also invokes its registered child-process termination hook.
        """
        with self._cancellation_lock:
            token = self._cancellations.get(requestId)
        return token.cancel() if token else False
    def capabilities(self):
        return {"ask":True, "organize":True, "sourceEdit":False,
                "boardToolCalls":False, "attachments":[], "cancellation":"transport-dependent"}
    def installed(self, runtime): return True
    def status(self, runtime):
        installed=self.installed(runtime)
        return {"id":self.id,"label":self.label,"available":installed,"installed":installed,
                "configured":None,"verified":False,"capabilities":self.capabilities()}
    def validate(self, request, runtime):
        if (request.intent == "source_edit" or request.mode == "edit") and not self.capabilities()["sourceEdit"]:
            raise ValueError("此服务不支持修改项目代码，请切换 Codex 或 ZCode。")
        if not self.installed(runtime): raise ValueError(f"本机未找到 {self.label} CLI。")
    def execute(self, request, runtime): raise NotImplementedError

class CliAdapter(BackendAdapter):
    def capabilities(self):
        return {"ask":True,"organize":True,"decompose":True,"sourceEdit":True,"boardToolCalls":False,
                "boardOperations":"validated structured plan", "attachments":["images","text"],
                "cancellation":"local subprocess termination; upstream billing not guaranteed"}
    def execute(self, request, runtime):
        token = self._begin(request)
        try:
            return runtime.run_turn(request=request, cancellation=token)
        finally:
            self._finish(request)

class CodexAdapter(CliAdapter):
    id="codex"
    label="Codex"
    def installed(self,runtime): return bool(runtime.CODEX_EXECUTABLE)

class ZCodeAdapter(CliAdapter):
    id="zcode"
    label="ZCode"
    def installed(self,runtime): return bool(runtime.ZCODE_COMMAND)
    def capabilities(self):
        return {**super().capabilities(),"attachments":["images","text","pdf-native"]}

class ApiAdapter(BackendAdapter):
    id="api"
    label="API 直连"
    def capabilities(self):
        return {"ask":True,"organize":True,"decompose":True,"sourceEdit":False,"boardToolCalls":True,
                "boardOperations":"bounded native function calls", "attachments":["images","utf8-text"],
                "cancellation":"discard result on disconnect; active HTTP call bounded by timeout"}
    def status(self,runtime):
        return {**super().status(runtime),"configured":False}
    def validate(self,request,runtime):
        super().validate(request,runtime)
        raw_options = request.backendOptions.get("api", request.api)
        request.api=validate_settings(raw_options,request.model)
        # Keep the normalised address as backend metadata but leave the
        # request-local key only in the non-repr transport settings.
        request.backendOptions = {**request.backendOptions, "api": {"baseUrl": request.api["url"]}}
    def execute(self,request,runtime):
        token = self._begin(request)
        try:
            return runtime.run_api_turn(request=request, cancellation=token)
        finally:
            self._finish(request)

class BackendFactory:
    def __init__(self):
        self.adapters={adapter.id:adapter for adapter in (CodexAdapter(),ZCodeAdapter(),ApiAdapter())}
    def get(self,backend):
        try: return self.adapters[backend]
        except (KeyError,TypeError): raise ValueError("请选择 Codex、ZCode 或 API 直连。") from None
    def status(self,runtime): return [adapter.status(runtime) for adapter in self.adapters.values()]

FACTORY=BackendFactory()
