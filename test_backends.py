import copy
import io
import json
import unittest
import urllib.error
from types import SimpleNamespace
from unittest.mock import Mock
from backends import FACTORY, BackendRequest
from board_tools import BoardTools
from api_backend import run_api
from server import parse_map, parse_board


def snapshot():
    return {"nodes":[{"id":"E01","kind":"card","title":"Root","text":"root","summary":"root","category":"main","pinned":True,"parentIds":[],"box":{"x":0,"y":0,"width":100,"height":100}},
    {"id":"A01","kind":"note","title":"Note","text":"note","parentIds":["E01"],"box":{"x":100,"y":0,"width":100,"height":100}}],"newIds":["E04","E05"],"layout":{"flow":"columns","density":"normal"}}

def response(message): return io.BytesIO(json.dumps({"choices":[{"message":message}]}).encode())
def tool_call(name,args): return {"id":"call1","type":"function","function":{"name":name,"arguments":json.dumps(args)}}
SETTINGS={"url":"https://example.com/v1/chat/completions","key":"TEST-SECRET"}

class FactoryTests(unittest.TestCase):
    def test_plan_output_is_a_bounded_action(self):
        from server import structured_candidate, write_plan_schema

        schema = write_plan_schema()
        self.addCleanup(schema.unlink)
        actions = json.loads(schema.read_text(encoding="utf-8"))["properties"]["action"]["enum"]
        self.assertIn("ask", actions)
        self.assertIn("decompose", actions)
        self.assertIn("explain", actions)
        self.assertIn("splitAnswer", actions)
        self.assertIn("organizeBranch", actions)
        self.assertEqual(structured_candidate('```json\n{"action":"ask"}\n```', {"scope": "plan"}),
                         ("answer", {"text": '{"action":"ask"}'}))
        for value in ('"ask"', '{"action":"unknown"}', '{"action":"ask","extra":true}'):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "操作类型"):
                structured_candidate(value, {"scope": "plan"})
        with self.assertRaisesRegex(ValueError, "找不到可解析的 JSON"):
            structured_candidate("I can explain that.", {"scope": "plan"})

    def test_unknown(self):
        for name in ("other",None,[]):
            with self.assertRaises(ValueError): FACTORY.get(name)
    def test_capability_status(self):
        statuses=FACTORY.status(SimpleNamespace(CODEX_EXECUTABLE="codex",ZCODE_COMMAND=None))
        self.assertTrue(statuses[0]["installed"])
        self.assertFalse(statuses[1]["installed"])
        self.assertFalse(statuses[2]["configured"])
        self.assertTrue(all(s["verified"] is False for s in statuses))
    def test_cli_dispatch(self):
        for name in ("codex","zcode"):
            runtime=Mock();req=BackendRequest(name,"m","ask","question",{},[])
            FACTORY.get(name).execute(req,runtime)
            runtime.run_turn.assert_called_once()
            forwarded = runtime.run_turn.call_args.kwargs["request"]
            self.assertIs(forwarded, req)
            self.assertTrue(callable(runtime.run_turn.call_args.kwargs["cancellation"].cancel))
    def test_api_dispatch(self):
        runtime=Mock();req=BackendRequest("api","m","ask","question",{},[],api={"baseUrl":"https://example.com/v1","apiKey":"TEST-SECRET"})
        adapter=FACTORY.get("api");adapter.validate(req,runtime);adapter.execute(req,runtime)
        runtime.run_api_turn.assert_called_once()
        self.assertNotIn("TEST-SECRET",repr(req))
    def test_unavailable_cli(self):
        for name in ("codex","zcode"):
            with self.assertRaises(ValueError): FACTORY.get(name).validate(BackendRequest(name,"","ask","q",{},[]),SimpleNamespace(CODEX_EXECUTABLE=None,ZCODE_COMMAND=None))
    def test_api_edit_denied(self):
        with self.assertRaises(ValueError): FACTORY.get("api").validate(BackendRequest("api","m","edit","q",{},[]),Mock())

    def test_explanation_rejects_write_scopes_and_invalid_source_answers(self):
        from server import parse_request

        request = {"backend": "api", "mode": "ask", "scope": "explain", "question": "拆成知识卡"}
        for update in (
            {"mode": "edit"},
            {"board": {}},
            {"decomposition": {}},
            {"sourceAnswer": {"question": "", "answer": "原回答"}},
            {"sourceAnswer": {"question": "原问题", "answer": "A" * 16001}},
            {"sourceAnswer": {"question": "原问题", "answer": "😀" * 13000}},
        ):
            with self.subTest(fields=list(update)), self.assertRaises(ValueError):
                parse_request(json.dumps({**request, **update}).encode("utf-8"))

class ToolTests(unittest.TestCase):
    def setUp(self): self.tools=BoardTools(snapshot(),parse_map,True)
    def test_reads_and_isolation(self):
        board=self.tools.call("get_board",{});board["board"]["items"].clear()
        self.assertEqual(len(self.tools.plan["items"]),2)
        self.assertEqual(self.tools.call("get_node",{"id":"E01"})["title"],"Root")
    def test_create_update_reparent(self):
        self.tools.call("create_node",{"id":"E04","title":"New","summary":"new","category":"reference","parentId":"E01"})
        self.tools.call("update_node",{"id":"E04","title":"Updated"})
        self.tools.call("reparent_node",{"id":"E04","parentId":"A01","side":"left"})
        self.assertEqual(self.tools.plan["items"][-1]["parentId"],"A01")
    def test_archive_restore_layout(self):
        self.tools.call("archive_node",{"id":"A01","archived":True})
        self.assertEqual(self.tools.plan["items"][1]["category"],"archive")
        self.tools.call("archive_node",{"id":"A01","archived":False})
        self.tools.call("set_layout",{"flow":"vertical","density":"compact"})
        self.assertEqual(self.tools.plan["layout"]["flow"],"vertical")
    def test_atomic_rejection(self):
        cases=[("archive_node",{"id":"E01","archived":True}),
            ("reparent_node",{"id":"E01","parentId":"A01","side":"auto"}),
            ("update_node",{"id":"A99","title":"x"}),
            ("update_node",{"id":"A01","title":"x"*161}),
            ("set_layout",{"flow":"unknown","density":"normal"}),
            ("update_node",{"id":"A01","command":"rm"}),
            ("execute_command",{"command":"x"})]
        for name,args in cases:
            before=copy.deepcopy(self.tools.plan)
            with self.assertRaises(ValueError): self.tools.call(name,args)
            self.assertEqual(before,self.tools.plan)
    def test_read_only(self):
        t=BoardTools(snapshot(),parse_map,False)
        self.assertEqual(len(t.tools),2)
        with self.assertRaises(ValueError):t.call("archive_node",{"id":"A01","archived":True})
    def test_snapshot_metadata(self):
        self.assertEqual(parse_board(snapshot())["nodes"][0]["summary"],"root")

    def test_explicit_layout_root_does_not_inherit_historical_anchor(self):
        board = snapshot()
        board["nodes"][0].update(parentIds=["A01"], layoutParentId="A01")
        board["nodes"][1]["layoutParentId"] = None
        parsed = parse_board(board)

        tools = BoardTools(parsed, parse_map, True)

        self.assertEqual(tools.call("get_node", {"id": "E01"})["parentId"], "A01")
        self.assertIsNone(tools.call("get_node", {"id": "A01"})["parentId"])
        self.assertEqual(parsed["nodes"][1]["parentIds"], ["E01"])

    def test_newly_pinned_nodes_initialize_without_changing_the_snapshot(self):
        for category in ("reference", "optimize", "done"):
            for writable in (False, True):
                with self.subTest(category=category, writable=writable):
                    board = snapshot()
                    second_parent = {**board["nodes"][0], "id": "E02", "pinned": False}
                    board["nodes"].append(second_parent)
                    board["nodes"][1].update(category=category, pinned=True, parentIds=["E02", "E01"])
                    parsed = parse_board(board)
                    before = copy.deepcopy(parsed)

                    tools = BoardTools(parsed, parse_map, writable)

                    note = tools.call("get_node", {"id": "A01"})
                    self.assertEqual(note["category"], "done" if category == "done" else "main")
                    self.assertEqual(note["parentId"], "E02")
                    self.assertFalse(tools.dirty)
                    self.assertEqual(parsed, before)
                    if writable:
                        for name, args in (
                            ("archive_node", {"id": "A01", "archived": True}),
                            ("update_node", {"id": "A01", "category": "reference"}),
                            ("reparent_node", {"id": "E02", "parentId": "A01", "side": "auto"}),
                        ):
                            with self.assertRaises(ValueError):
                                tools.call(name, args)
                        self.assertEqual(tools.call("get_node", {"id": "A01"}), note)
                        self.assertFalse(tools.dirty)

class LoopTests(unittest.TestCase):
    def test_multi_round(self):
        t=BoardTools(snapshot(),parse_map,True);opener=Mock()
        opener.open.side_effect=[response({"content":None,"tool_calls":[tool_call("update_node",{"id":"A01","title":"Updated"})]}),response({"content":"done"})]
        self.assertEqual(run_api(SETTINGS,"m","q",[],opener=opener,board_tools=t),"done")
        self.assertTrue(t.dirty)
        payload=json.loads(opener.open.call_args.args[0].data)
        self.assertEqual(payload["messages"][-1]["role"],"tool")
        self.assertNotIn("TEST-SECRET",json.dumps(payload))
    def test_tool_error_recovery(self):
        t=BoardTools(snapshot(),parse_map,True);opener=Mock()
        opener.open.side_effect=[response({"tool_calls":[tool_call("execute_command",{})]}),response({"content":"cannot do that"})]
        run_api(SETTINGS,"m","q",[],opener=opener,board_tools=t)
        self.assertFalse(t.dirty)
    def test_budget(self):
        t=BoardTools(snapshot(),parse_map,True);opener=Mock()
        opener.open.side_effect=lambda *a,**kw:response({"tool_calls":[tool_call("get_board",{})]})
        with self.assertRaisesRegex(ValueError,"轮次"):run_api(SETTINGS,"m","q",[],opener=opener,board_tools=t)
    def test_cancel_before_request(self):
        opener=Mock()
        with self.assertRaisesRegex(ValueError,"取消"):run_api(SETTINGS,"m","q",[],opener=opener,cancelled=lambda:True)
        opener.open.assert_not_called()
    def test_cancel_after_response(self):
        opener=Mock();opener.open.return_value=response({"content":"done"})
        states=iter([False,True])
        with self.assertRaisesRegex(ValueError,"取消"):run_api(SETTINGS,"m","q",[],opener=opener,cancelled=lambda:next(states))
    def test_http_errors_redacted(self):
        for code in (401,429):
            opener=Mock();opener.open.side_effect=urllib.error.HTTPError(SETTINGS["url"],code,"TEST-SECRET",{},None)
            with self.assertRaises(ValueError) as caught:run_api(SETTINGS,"m","q",[],opener=opener)
            self.assertNotIn("TEST-SECRET",str(caught.exception))
            self.assertIn(str(code),str(caught.exception))
    def test_timeout(self):
        opener=Mock();opener.open.side_effect=TimeoutError()
        with self.assertRaises(ValueError):run_api(SETTINGS,"m","q",[],opener=opener)

if __name__ == "__main__":unittest.main()
