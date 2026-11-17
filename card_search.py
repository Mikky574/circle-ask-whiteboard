"""Offline card ranking, with a local BGE model and a lexical fallback."""

from collections import OrderedDict
import math
import os
from pathlib import Path
import re
from threading import Lock
import unicodedata


MAX_CARDS = 64
MAX_MATCHES = 12
CARD_ID = re.compile(r"[AE][0-9]{2,8}")
TOKEN = re.compile(r"[a-z0-9_]+|[\u3400-\u9fff]+")
QUERY_PREFIX = "为这个句子生成表示以用于检索相关文章："
MODEL_LOCK = Lock()
local_model = None


def checked_text(value, limit, *, required=False):
    if not isinstance(value, str) or len(value) > limit or (required and not value.strip()):
        raise ValueError("搜索问题或卡片内容的格式不正确。")
    return value.strip()


def search_tokens(text):
    tokens = set()
    for word in TOKEN.findall(unicodedata.normalize("NFKC", text).lower()):
        if word[0].isascii() or len(word) == 1:
            tokens.add(word)
        else:
            tokens.update(word[index:index + 2] for index in range(len(word) - 1))
    return tokens


def lexical_scores(query, cards):
    terms = search_tokens(query)
    titles = [search_tokens(f"{card['id']} {card['title']}") for card in cards]
    summaries = [search_tokens(card["summary"]) for card in cards]
    paths = [search_tokens(card["path"]) for card in cards]
    weights = {term: math.log1p(len(cards) / (1 + sum(term in title or term in summary
                         for title, summary in zip(titles, summaries)))) for term in terms}
    total = sum(weights.values()) or 1
    return [sum(weights[term] * (1 if term in title else 0.65 if term in summary else 0.25 if term in path else 0)
                for term in terms) / total for title, summary, path in zip(titles, summaries, paths)]


class LocalBge:
    def __init__(self, directory):
        import numpy
        import onnxruntime
        from tokenizers import Tokenizer

        self.np = numpy
        self.tokenizer = Tokenizer.from_file(str(directory / "tokenizer.json"))
        self.tokenizer.enable_truncation(max_length=256)
        self.tokenizer.enable_padding(pad_id=0, pad_token="[PAD]")
        options = onnxruntime.SessionOptions()
        options.intra_op_num_threads = min(4, os.cpu_count() or 1)
        self.session = onnxruntime.InferenceSession(
            str(directory / "model.onnx"), sess_options=options, providers=["CPUExecutionProvider"]
        )
        self.inputs = [item.name for item in self.session.get_inputs()]
        self.cache = OrderedDict()

    def encode(self, texts):
        batch = self.tokenizer.encode_batch(texts)
        values = {
            "input_ids": self.np.asarray([item.ids for item in batch], dtype=self.np.int64),
            "attention_mask": self.np.asarray([item.attention_mask for item in batch], dtype=self.np.int64),
            "token_type_ids": self.np.asarray([item.type_ids for item in batch], dtype=self.np.int64),
        }
        hidden = self.session.run(["last_hidden_state"], {name: values[name] for name in self.inputs})[0][:, 0, :]
        return hidden / self.np.maximum(self.np.linalg.norm(hidden, axis=1, keepdims=True), 1e-12)

    def scores(self, query, cards):
        passages = [f"{card['title']}\n{card['summary']}\n{card['path']}" for card in cards]
        missing = [text for text in dict.fromkeys(passages) if text not in self.cache]
        for index in range(0, len(missing), 12):
            batch = missing[index:index + 12]
            self.cache.update(zip(batch, self.encode(batch)))
        vector = self.encode([QUERY_PREFIX + query])[0]
        scores = []
        for passage in passages:
            self.cache.move_to_end(passage)
            scores.append(float(self.cache[passage] @ vector))
        while len(self.cache) > 512:
            self.cache.popitem(last=False)
        return scores


def semantic_scores(query, cards):
    global local_model
    with MODEL_LOCK:
        if local_model is None:
            configured = os.environ.get("WHITEBOARD_SEARCH_MODEL_DIR")
            directory = Path(configured) if configured else Path.home() / ".circle-ask-whiteboard" / "models" / "bge-small-zh-v1.5"
            if not (directory / "model.onnx").is_file() or not (directory / "tokenizer.json").is_file():
                return None
            try:
                local_model = LocalBge(directory)
            except Exception:
                # Optional runtime, tokenizer or model may be unavailable on this machine.
                return None
        try:
            return local_model.scores(query, cards)
        except Exception:
            return None


def search_cards(payload):
    if not isinstance(payload, dict) or set(payload) != {"query", "cards"}:
        raise ValueError("请提交搜索问题和候选卡片。")
    query = checked_text(payload["query"], 512, required=True)
    cards = payload["cards"]
    if not isinstance(cards, list) or not 1 <= len(cards) <= MAX_CARDS:
        raise ValueError("每次按问题定位需要 1 至 64 张候选卡片。")
    cleaned = []
    ids = set()
    for card in cards:
        if not isinstance(card, dict) or set(card) != {"id", "title", "summary", "path"}:
            raise ValueError("候选卡片格式不正确。")
        card_id = card["id"]
        if not isinstance(card_id, str) or not CARD_ID.fullmatch(card_id) or card_id in ids:
            raise ValueError("候选卡片编号不正确。")
        ids.add(card_id)
        cleaned.append({"id": card_id, "title": checked_text(card["title"], 120, required=True),
                        "summary": checked_text(card["summary"], 450), "path": checked_text(card["path"], 240)})

    lexical = lexical_scores(query, cleaned)
    semantic = semantic_scores(query, cleaned)
    mode = "semantic" if semantic is not None else "lexical"
    exact_id = unicodedata.normalize("NFKC", query).upper()
    ranked = []
    for index, card in enumerate(cleaned):
        term_score = lexical[index]
        if card["id"] == exact_id:
            ranked.append((2, card["id"]))
        elif semantic is not None:
            score = semantic[index] + 0.16 * term_score
            if score >= 0.43:
                ranked.append((score, card["id"]))
        elif semantic is None and term_score > 0:
            ranked.append((term_score, card["id"]))
    ranked.sort(key=lambda match: match[0], reverse=True)
    return {"matches": [card_id for _, card_id in ranked[:MAX_MATCHES]], "mode": mode}
