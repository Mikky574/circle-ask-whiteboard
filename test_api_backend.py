import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock
import api_backend as api
import server

class Tests(unittest.TestCase):
    def test_settings(self):
        self.assertEqual(api.validate_settings({"baseUrl":"https://example.com/v1/", "apiKey":"test"},"m")["url"], "https://example.com/v1/chat/completions")
        for url in ("http://example.com/v1", "https://u:p@example.com", "https://example.com?key=x", "http://127.0.0.1:8797"):
            with self.assertRaises(ValueError): api.validate_settings({"baseUrl":url,"apiKey":"test"},"m")
        with self.assertRaisesRegex(ValueError, "9910"):
            api.validate_settings({"baseUrl": "http://localhost:9910/v1", "apiKey": "test"}, "m", whiteboard_port=9910)
        for model,key in (("","test"),("m","a\nb")):
            with self.assertRaises(ValueError): api.validate_settings({"baseUrl":"https://example.com/v1","apiKey":key},model)
    def test_request(self):
        opener=Mock()
        response=io.BytesIO(json.dumps({"choices":[{"message":{"content":"ok"}}]}).encode())
        opener.open.return_value=response
        answer=api.run_api({"url":"https://example.com/v1/chat/completions","key":"test-secret"},"m","hello",[],opener=opener)
        self.assertEqual(answer,"ok")
        request=opener.open.call_args.args[0]
        self.assertEqual(request.headers["Authorization"],"Bearer test-secret")
        payload=json.loads(request.data)
        self.assertNotIn("tools",payload)
        self.assertNotIn("test-secret",request.data.decode())
    def test_response_failure(self):
        opener=Mock();opener.open.return_value=io.BytesIO(b'{"unexpected":true}')
        with self.assertRaises(ValueError): api.run_api({"url":"https://example.com","key":"secret"},"m","x",[],opener=opener)
    def test_attachments(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/"a.txt";p.write_text("test",encoding="utf-8")
            content=api.build_content("hello",[{"path":p,"suffix":".txt","name":"a.txt"}])
            self.assertIn("test",content[1]["text"])
            p.write_bytes(b"x"*120001)
            with self.assertRaises(ValueError): api.build_content("hello",[{"path":p,"suffix":".txt","name":"a.txt"}])
    def test_backend_parse(self):
        result=server.parse_request(json.dumps({"backend":"api","model":"m","question":"hello","mode":"ask"}).encode())
        self.assertEqual(result[3],"api")
    def test_no_redirect(self):
        with self.assertRaises(ValueError): api.NoRedirect().redirect_request(None,None,302,"",{},"https://other")
    def test_key_not_persisted(self):
        js=Path("app.js").read_text(encoding="utf-8")
        self.assertIn('delete lastPayload.api',js)
        self.assertIn('localStorage.setItem(connectionKey, JSON.stringify(connection))',js)
        self.assertNotIn('connection.apiKey',js)

if __name__ == "__main__": unittest.main()
