"""Shared, credential-free fixtures for the offline acceptance suite.

The fixture represents one isolated browser snapshot.  It is never sent to a
provider and all callers must request a fresh copy with ``board_snapshot``.
"""

from __future__ import annotations

import copy
import io
import json


FIXTURE_ID = "whiteboard-contract-v1"
TEST_ONLY_KEY = "TEST-ONLY-NOT-A-REAL-KEY"

_BOARD = {
    "nodes": [
        {
            "id": "E01",
            "kind": "card",
            "title": "Pinned root",
            "text": "Root evidence",
            "summary": "Root evidence",
            "category": "main",
            "pinned": True,
            "parentIds": [],
            "box": {"x": 0, "y": 0, "width": 100, "height": 80},
        },
        {
            "id": "A01",
            "kind": "note",
            "title": "Child note",
            "text": "Child evidence",
            "summary": "Child evidence",
            "category": "reference",
            "parentIds": ["E01"],
            "box": {"x": 120, "y": 0, "width": 100, "height": 80},
        },
    ],
    "newIds": ["E04", "E05"],
    "layout": {"flow": "columns", "density": "normal"},
}


def board_snapshot():
    """Return an independent E01/A01/E04/E05 snapshot."""
    return copy.deepcopy(_BOARD)


def api_settings():
    """Return an inert setting consumed only by fake urllib openers."""
    return {"url": "https://example.invalid/v1/chat/completions", "key": TEST_ONLY_KEY}


def response(message):
    """Create a fake Chat Completions byte stream."""
    return io.BytesIO(json.dumps({"choices": [{"message": message}]}).encode("utf-8"))


def tool_call(name, arguments, call_id="fixture-call"):
    return {
        "id": call_id,
        "type": "function",
        "function": {"name": name, "arguments": json.dumps(arguments)},
    }
