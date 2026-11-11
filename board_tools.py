"""Transactional tools over an explicitly supplied whiteboard snapshot only."""
import copy
import json

TEXT = {"type": "string"}
ID = {"type": "string"}

def definition(name, description, properties, required):
    return {"type": "function", "function": {"name": name, "description": description,
        "parameters": {"type": "object", "properties": properties, "required": required, "additionalProperties": False}}}

READ_TOOLS = [
    definition("get_board", "Read the current draft whiteboard and available IDs.", {}, []),
    definition("get_node", "Read one node by its exact ID.", {"id": ID}, ["id"]),
]
WRITE_TOOLS = [
    definition("create_node", "Create a new card using an available reserved ID. Changes are staged until the entire turn succeeds.",
        {"id": ID, "title": TEXT, "summary": TEXT, "category": {"type":"string","enum":["main","reference","optimize","done"]}, "parentId":{"type":["string","null"]}}, ["id","title","summary","category","parentId"]),
    definition("update_node", "Update existing card text or category; omitted fields stay unchanged.",
        {"id":ID,"title":TEXT,"summary":TEXT,"category":{"type":"string","enum":["main","done","optimize","reference","archive"]}}, ["id"]),
    definition("reparent_node", "Change a card's parent and layout side. Cycles are rejected.",
        {"id":ID,"parentId":{"type":["string","null"]},"side":{"type":"string","enum":["auto","left","right"]}}, ["id","parentId","side"]),
    definition("archive_node", "Archive or restore a card without deleting it. Pinned cards cannot be archived.",
        {"id":ID,"archived":{"type":"boolean"}}, ["id","archived"]),
    definition("set_layout", "Set supported board layout direction and spacing.",
        {"flow":{"type":"string","enum":["columns","vertical","horizontal"]},"density":{"type":"string","enum":["compact","normal","spacious"]}}, ["flow","density"]),
]

class BoardTools:
    def __init__(self, board, validate, writable=False):
        self.board = copy.deepcopy(board)
        self.validate = validate
        self.writable = writable
        self.dirty = False
        items = []
        for node in self.board["nodes"]:
            category = node.get("category", "main" if node["kind"] == "card" else "reference")
            if node.get("pinned") and category not in ("main", "done"):
                category = "main"
            items.append({
                "id": node["id"],
                "title": node["title"] or node["id"],
                "summary": node.get("summary") or node["text"][:500] or node["title"] or node["id"],
                "category": category,
                "parentId": node.get("layoutParentId", next(iter(node["parentIds"]), None)),
                "side": node.get("side", "auto"),
                "sources": node.get("sources", []),
            })
        plan = {
            "title": "白板操作", "summary": "保留当前白板。", "items": items,
            "layout": self.board.get("layout", {"flow": "columns", "density": "normal"}),
        }
        self.plan = validate(json.dumps(plan, ensure_ascii=False), self.board, contextual_new=True)

    @property
    def tools(self):
        return READ_TOOLS + (WRITE_TOOLS if self.writable else [])

    def call(self, name, args):
        definitions = {t["function"]["name"]:t["function"]["parameters"] for t in self.tools}
        if name not in definitions or not isinstance(args,dict):
            raise ValueError("Tool unavailable for this request.")
        schema = definitions[name]
        if set(args)-set(schema["properties"]) or not set(schema["required"]).issubset(args):
            raise ValueError("Invalid tool arguments.")
        if name == "get_board":
            return {"board":copy.deepcopy(self.plan),"availableIds":[i for i in self.board.get("newIds",[]) if i not in {n["id"] for n in self.plan["items"]}],"staged":True}
        draft=copy.deepcopy(self.plan)
        nodes={n["id"]:n for n in draft["items"]}
        if name == "get_node":
            if args["id"] not in nodes: raise ValueError("Unknown node ID.")
            return nodes[args["id"]]
        if name == "create_node":
            if args["id"] not in self.board.get("newIds",[]) or args["id"] in nodes:
                raise ValueError("Use an unused reserved node ID.")
            draft["items"].append({**args,"side":"auto","sources":[]})
        elif name == "set_layout":
            draft["layout"] = args
        else:
            node=nodes.get(args["id"])
            if node is None: raise ValueError("Unknown node ID.")
            if name == "archive_node":
                if type(args["archived"]) is not bool: raise ValueError("archived must be boolean.")
                node["category"] = "archive" if args["archived"] else "reference"
            else:
                node.update({k:v for k,v in args.items() if k != "id"})
        # Validation is atomic: a rejected edit never mutates this draft session.
        checked=self.validate(json.dumps(draft,ensure_ascii=False), self.board, contextual_new=True)
        self.plan=checked
        self.dirty=True
        return {"ok":True,"staged":True,"message":"Validated in draft; browser applies only after the complete turn succeeds."}
