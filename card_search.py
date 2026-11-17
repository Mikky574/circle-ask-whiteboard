"""Offline card ranking, with a local BGE model and a lexical fallback."""

from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import hashlib
import math
import os
from pathlib import Path
import re
import sqlite3
from threading import Lock
import unicodedata

from jev_decision import relevance


MAX_CARDS = 4096
MAX_MATCHES = 12
DECISION_CANDIDATES = 8
INLINE_CARDS = 64
VECTOR_BYTES = 512 * 4
CARD_ID = re.compile(r"[AE][0-9]{2,8}")
TOKEN = re.compile(r"[a-z0-9_]+|[\u3400-\u9fff]+")
QUERY_PREFIX = "为这个句子生成表示以用于检索相关文章："
MODEL_LOCK = Lock()
INDEX_LOCK = Lock()
INDEX_WORKER = ThreadPoolExecutor(max_workers=1, thread_name_prefix="whiteboard-search")
index_jobs = {}
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
        self.cache_lock = Lock()
        self.inference_lock = Lock()
        self.cache = OrderedDict()
        self.index_path = Path.home() / ".circle-ask-whiteboard" / "search-vectors.sqlite3"
        model_files = [directory / name for name in ("model.onnx", "tokenizer.json")]
        self.revision = "|".join(f"{path.resolve()}:{path.stat().st_size}:{path.stat().st_mtime_ns}"
                                 for path in model_files) + "|cls-l2-256-v1"
        self.tokenizer = Tokenizer.from_file(str(directory / "tokenizer.json"))
        self.tokenizer.enable_truncation(max_length=256)
        self.tokenizer.enable_padding(pad_id=0, pad_token="[PAD]")
        options = onnxruntime.SessionOptions()
        options.intra_op_num_threads = min(4, os.cpu_count() or 1)
        self.session = onnxruntime.InferenceSession(
            str(directory / "model.onnx"), sess_options=options, providers=["CPUExecutionProvider"]
        )
        self.inputs = [item.name for item in self.session.get_inputs()]

    def encode(self, texts):
        with self.inference_lock:
            batch = self.tokenizer.encode_batch(texts)
            values = {
                "input_ids": self.np.asarray([item.ids for item in batch], dtype=self.np.int64),
                "attention_mask": self.np.asarray([item.attention_mask for item in batch], dtype=self.np.int64),
                "token_type_ids": self.np.asarray([item.type_ids for item in batch], dtype=self.np.int64),
            }
            hidden = self.session.run(["last_hidden_state"], {name: values[name] for name in self.inputs})[0][:, 0, :]
            return hidden / self.np.maximum(self.np.linalg.norm(hidden, axis=1, keepdims=True), 1e-12)

    def key(self, text):
        return hashlib.sha256(f"{self.revision}\n{text}".encode("utf-8")).digest()

    def open_index(self):
        self.index_path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.index_path, timeout=0.25)
        try:
            connection.execute("CREATE TABLE IF NOT EXISTS vectors (key BLOB PRIMARY KEY, vector BLOB NOT NULL)")
        except sqlite3.Error:
            connection.close()
            raise
        return connection

    def cache_vectors(self, vectors, *, persist=False):
        self.cache.update(vectors)
        for key in vectors:
            self.cache.move_to_end(key)
        while len(self.cache) > MAX_CARDS * 2:
            self.cache.popitem(last=False)
        if persist:
            try:
                with closing(self.open_index()) as connection, connection:
                    connection.executemany("INSERT OR REPLACE INTO vectors VALUES (?, ?)",
                                           ((key, vector.astype("<f4").tobytes()) for key, vector in vectors.items()))
                    connection.execute("DELETE FROM vectors WHERE rowid <= (SELECT max(rowid) - 24000 FROM vectors)")
            except (OSError, sqlite3.Error):
                pass

    def existing_vectors(self, keys):
        with self.cache_lock:
            existing = {key: self.cache[key] for key in keys if key in self.cache}
            missing = [key for key in dict.fromkeys(keys) if key not in existing]
            if missing:
                loaded = {}
                try:
                    with closing(self.open_index()) as connection:
                        for start in range(0, len(missing), 256):
                            group = missing[start:start + 256]
                            placeholders = ",".join("?" for _ in group)
                            rows = connection.execute(f"SELECT key, vector FROM vectors WHERE key IN ({placeholders})", group)
                            loaded.update((key, self.np.frombuffer(vector, dtype="<f4"))
                                          for key, vector in rows if len(vector) == VECTOR_BYTES)
                except (OSError, sqlite3.Error):
                    pass
                existing.update(loaded)
            self.cache_vectors(existing)
            return existing

    def index(self, missing):
        existing = self.existing_vectors(missing)
        entries = [(key, text) for key, text in missing.items() if key not in existing]
        encoded = {}
        for start in range(0, len(entries), 12):
            batch = entries[start:start + 12]
            vectors = self.encode([text for _, text in batch])
            encoded.update((key, vector) for (key, _), vector in zip(batch, vectors))
        with self.cache_lock:
            self.cache_vectors(encoded, persist=True)
        return {**existing, **encoded}


def search_model():
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
        return local_model


def semantic_scores(query, cards):
    model = search_model()
    if model is None:
        return None
    try:
        passages = [f"{card['title']}\n{card['summary']}\n{card['path']}" for card in cards]
        keys = [model.key(text) for text in passages]
        vectors = model.existing_vectors(keys)
        missing = {key: text for key, text in zip(keys, passages) if key not in vectors}
        if missing:
            job_key = hashlib.sha256(b"".join(sorted(keys))).digest()
            with INDEX_LOCK:
                job = index_jobs.get(job_key)
                for key in list(index_jobs):
                    if index_jobs[key].done():
                        del index_jobs[key]
                if job is not None:
                    if not job.done():
                        return "indexing"
                elif not query or len(missing) > INLINE_CARDS:
                    if len(index_jobs) < 3:
                        index_jobs[job_key] = INDEX_WORKER.submit(model.index, missing)
                    return "indexing"
            vectors.update(job.result() if job is not None else model.index(missing))
        if not query:
            return []
        vector = model.encode([QUERY_PREFIX + query])[0]
        return (model.np.stack([vectors[key] for key in keys]) @ vector).tolist()
    except Exception:
        # Invalid local assets or an unavailable optional runtime use lexical matching.
        return None


def search_cards(payload):
    if not isinstance(payload, dict) or set(payload) not in ({"query", "cards"}, {"query", "cards", "engine"}):
        raise ValueError("请提交搜索问题和候选卡片。")
    engine = payload.get("engine")
    if "engine" in payload and engine not in ("bge", "jev"):
        raise ValueError("搜索引擎无效。")
    query = checked_text(payload["query"], 512)
    cards = payload["cards"]
    if not isinstance(cards, list) or not 1 <= len(cards) <= MAX_CARDS:
        raise ValueError(f"每次按问题定位需要 1 至 {MAX_CARDS} 张候选卡片。")
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

    semantic = semantic_scores(query, cleaned)
    if semantic == "indexing":
        return {"matches": [], "mode": "indexing"}
    mode = "semantic" if semantic is not None else "lexical"
    if not query:
        return {"matches": [], "mode": mode}
    lexical = lexical_scores(query, cleaned)
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
    matches = [card_id for _, card_id in ranked[:MAX_MATCHES]]
    result = {"matches": matches, "mode": mode}
    if engine != "jev":
        return result

    result["engine"] = "bge" if semantic is not None else "lexical"
    if not matches or matches[0] == exact_id:
        return result

    by_id = {card["id"]: card for card in cleaned}
    shortlist = matches[:DECISION_CANDIDATES]
    scores = relevance(query, [by_id[card_id] for card_id in shortlist])
    if scores is None:
        result["engineUnavailable"] = True
        return result

    shortlisted = [card_id for card_id in shortlist if scores[card_id] >= 0.35]
    result["matches"] = sorted(shortlisted, key=scores.get, reverse=True)
    result["engine"] = "jev"
    return result
