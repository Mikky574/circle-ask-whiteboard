"""The generated subset of the structure diagram wire format."""
from pathlib import Path
import re


GUIDE_PATH = (Path(__file__).resolve().parent / ".agents" / "skills" / "whiteboard-project-analysis"
              / "references" / "module-diagram-pattern.md")
ROLES = ("entry", "capability", "external", "store", "feedback")
SIZES = ("small", "medium", "large")
KINDS = ("main", "side", "back")
LOCAL_ID = re.compile(r"[a-z][a-z0-9-]{0,23}")
CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff]")
MAX_ZONES = 6
MAX_ZONE_NODES = 7
MAX_LINKS = 24
LANES = tuple(range(6))


def diagram_schema(card_ids, *, zcode=False):
    def record(**fields):
        return {"type": "object", "properties": fields, "required": list(fields), "additionalProperties": False}

    def choice(values, kind="string"):
        return {"type": kind, "enum": list(values)}

    def text(limit):
        return {"type": "string", **({"maxLength": limit} if zcode else {})}

    def entries(item, minimum, maximum):
        return {"type": "array", "items": item,
                **({"minItems": minimum, "maxItems": maximum} if zcode else {})}

    card = choice(card_ids)
    name = text(24)
    node = record(id=name, cardId=card, label=text(24), note=text(80))
    zone = record(id=name, title=text(24), role=choice(ROLES), size=choice(SIZES),
                  lane=choice(LANES, "integer"), nodes=entries(node, 1, MAX_ZONE_NODES))
    link = record(**{"from": name, "to": name, "label": text(16), "kind": choice(KINDS), "evidence": card})
    return record(version=choice((1,), "integer"), rootId=card, title=text(40),
                  zones=entries(zone, 1, MAX_ZONES), links=entries(link, 0, MAX_LINKS))


def validate_overview(value, root_id, items):
    def fail(reason):
        raise ValueError(f"项目模块图无效：{reason}。")

    def record(obj, *fields):
        if not isinstance(obj, dict) or set(obj) != set(fields):
            fail("字段不完整或包含未知字段")

    def entries(value, minimum, maximum):
        if not isinstance(value, list) or not minimum <= len(value) <= maximum:
            fail(f"列表应包含 {minimum} 至 {maximum} 项")
        return value

    def text(value, limit, *, optional=False):
        if not isinstance(value, str) or len(value) > limit or CONTROL.search(value) or (not optional and not value.strip()):
            fail(f"文字应符合 {limit} 字以内的长度要求")

    def identity(value):
        if not isinstance(value, str) or not LOCAL_ID.fullmatch(value) or value in used:
            fail("分区或节点编号无效或重复")
        used.add(value)

    record(value, "version", "rootId", "title", "zones", "links")
    if type(value["version"]) is not int or value["version"] != 1 or value["rootId"] != root_id:
        fail("版本或根卡编号与本项目不一致")
    text(value["title"], 40)
    cards = {item["id"] for item in items}
    required_cards = {root_id, *(item["id"] for item in items if item["parentId"] == root_id)}
    used, displayed, node_ids = set(), set(), set()
    for zone in entries(value["zones"], 1, MAX_ZONES):
        record(zone, "id", "title", "role", "size", "lane", "nodes")
        identity(zone["id"])
        text(zone["title"], 24)
        if (zone["role"] not in ROLES or zone["size"] not in SIZES
                or type(zone["lane"]) is not int or zone["lane"] not in LANES):
            fail("分区角色、大小或列无效")
        for node in entries(zone["nodes"], 1, MAX_ZONE_NODES):
            record(node, "id", "cardId", "label", "note")
            identity(node["id"])
            text(node["label"], 24)
            text(node["note"], 80, optional=True)
            card_id = node["cardId"]
            if not isinstance(card_id, str) or card_id not in required_cards or card_id in displayed:
                fail("总览节点应引用未重复的根卡或直属功能卡")
            displayed.add(card_id)
            node_ids.add(node["id"])
    if displayed != required_cards:
        fail("总览缺少根卡或直属功能卡")

    pairs = set()
    for link in entries(value["links"], 0, MAX_LINKS):
        record(link, "from", "to", "label", "kind", "evidence")
        text(link["label"], 16)
        source, target, evidence = (link[field] for field in ("from", "to", "evidence"))
        if (not all(isinstance(item, str) for item in (source, target, evidence)) or source == target
                or source not in node_ids or target not in node_ids or (source, target) in pairs
                or link["kind"] not in KINDS or evidence not in cards):
            fail("连线端点、类型或证据卡无效")
        pairs.add((source, target))
    return value
