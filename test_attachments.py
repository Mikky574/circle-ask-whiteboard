import json
import tempfile
import threading
import unittest
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote
from unittest.mock import patch

import server


class AttachmentDeliveryTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        env = patch.dict("os.environ", WHITEBOARD_ATTACHMENTS_DIR=directory.name)
        env.start()
        self.addCleanup(env.stop)
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.WhiteboardHandler)
        self.addCleanup(self.httpd.server_close)
        self.host = f"127.0.0.1:{self.httpd.server_port}"
        hosts = patch.object(server, "ALLOWED_HOSTS", {self.host})
        hosts.start()
        self.addCleanup(hosts.stop)
        thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 5)
        self.addCleanup(self.httpd.shutdown)

    def request(self, method, path, content=None, headers=None):
        connection = HTTPConnection("127.0.0.1", self.httpd.server_port, timeout=5)
        try:
            connection.request(method, path, content, headers or {})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def upload(self, name, content):
        status, _, body = self.request("POST", "/api/attachments", content, {
            "Origin": f"http://{self.host}", "Content-Type": "application/octet-stream",
            "X-Attachment-Name": quote(name, safe=""),
        })
        self.assertEqual(status, 201)
        return json.loads(body)["id"]

    def test_utf8_markdown_opens_inline_as_inert_text(self):
        content = "# 需求与验收\n<script>alert(1)</script>".encode()
        name = "需求与验收说明.md"
        attachment_id = self.upload(name, content)
        status, headers, body = self.request("GET", f"/api/attachments/{attachment_id}")
        self.assertEqual((status, body), (200, content))
        self.assertEqual(headers["Content-Type"], "text/plain; charset=utf-8")
        self.assertEqual(headers["Content-Length"], str(len(content)))
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(headers["Cross-Origin-Resource-Policy"], "same-origin")
        self.assertEqual(headers["Content-Disposition"], f"inline; filename=\"attachment.md\"; filename*=UTF-8''{quote(name, safe='')}")

    def test_active_formats_and_non_utf8_text_download_instead(self):
        for name, content in (("preview.html", b"<script>alert(1)</script>"), ("invalid.md", bytes([255]))):
            with self.subTest(name=name):
                attachment_id = self.upload(name, content)
                status, headers, body = self.request("GET", f"/api/attachments/{attachment_id}")
                self.assertEqual((status, body), (200, content))
                self.assertEqual(headers["Content-Type"], "application/octet-stream")
                self.assertTrue(headers["Content-Disposition"].startswith("attachment; "))

    def test_route_rejects_untrusted_host_paths_and_corrupted_uploads(self):
        attachment_id = self.upload("note.txt", b"plain text")
        valid_path = f"/api/attachments/{attachment_id}"
        self.assertEqual(self.request("GET", valid_path, headers={"Host": "invalid.test"})[0], 403)
        for suffix in ("/../note.txt", "/metadata.json", "?inline=true", "%2fcontent"):
            with self.subTest(suffix=suffix):
                self.assertEqual(self.request("GET", valid_path + suffix)[0], 404)
        self.assertEqual(self.request("GET", f"/api/attachments/{'0' * 32}")[0], 404)
        (self.root / attachment_id / "content").write_bytes(b"truncated")
        self.assertEqual(self.request("GET", valid_path)[0], 404)


if __name__ == "__main__":
    unittest.main()
