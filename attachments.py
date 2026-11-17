"""Local storage and per-run staging for files attached to whiteboard questions."""

import json
import os
import re
import stat
import tempfile
import unicodedata
import uuid
from pathlib import Path
from urllib.parse import unquote_to_bytes


MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
MAX_ATTACHMENTS = 16
_CHUNK_BYTES = 64 * 1024
_ATTACHMENT_ID = re.compile(r"[0-9a-f]{32}")
_INVALID_PERCENT_ESCAPE = re.compile(r"%(?![0-9a-fA-F]{2})")
_WINDOWS_DEVICE = re.compile(r"CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³]|CONIN\$|CONOUT\$", re.I)


def _storage_root():
    configured = os.environ.get("WHITEBOARD_ATTACHMENTS_DIR")
    default = Path.home() / ".circle-ask-whiteboard" / "attachments"
    return (Path(configured).expanduser() if configured else default).resolve()


def _safe_name(value):
    if not isinstance(value, str):
        raise ValueError("附件文件名无效。")
    name = unicodedata.normalize("NFC", value)
    if (not name or name != name.strip() or name.endswith(".")
            or any(char in '/\\<>:"|?*' or unicodedata.category(char) in {"Cc", "Cf", "Cs"}
                   for char in name)
            or len(name.encode("utf-8")) > 240
            or _WINDOWS_DEVICE.fullmatch(name.split(".", 1)[0].rstrip())):
        raise ValueError("附件文件名无效。")
    return name


def _decode_name(encoded_name):
    if (not isinstance(encoded_name, str) or len(encoded_name) > 2048
            or not encoded_name.isascii() or _INVALID_PERCENT_ESCAPE.search(encoded_name)):
        raise ValueError("附件文件名编码无效。")
    try:
        return _safe_name(unquote_to_bytes(encoded_name).decode("utf-8"))
    except UnicodeError:
        raise ValueError("附件文件名编码无效。") from None


def _valid_size(size):
    return type(size) is int and 0 <= size <= MAX_ATTACHMENT_BYTES


def _copy_exact(source, destination, size):
    remaining = size
    while remaining:
        chunk = source.read(min(_CHUNK_BYTES, remaining))
        if not chunk or len(chunk) > remaining:
            raise ValueError("附件长度与声明不一致。")
        destination.write(chunk)
        remaining -= len(chunk)


def save_attachment(stream, size, encoded_name):
    """Read exactly one bounded request body and publish its record atomically."""
    if not _valid_size(size):
        raise ValueError("单个附件不能超过 10 MB。")
    name = _decode_name(encoded_name)
    root = _storage_root()
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    attachment_id = uuid.uuid4().hex
    staging = Path(tempfile.mkdtemp(prefix=".upload-", dir=root))
    metadata = {"id": attachment_id, "name": name, "size": size}
    try:
        with (staging / "content").open("xb") as output:
            _copy_exact(stream, output, size)
        with (staging / "metadata.json").open("x", encoding="utf-8") as output:
            json.dump(metadata, output, ensure_ascii=False)
        staging.rename(root / attachment_id)
    except BaseException:
        for filename in ("content", "metadata.json"):
            (staging / filename).unlink(missing_ok=True)
        staging.rmdir()
        raise
    return metadata


def _load_attachment(root, attachment_id):
    directory = root / attachment_id
    content = directory / "content"
    metadata_path = directory / "metadata.json"
    try:
        if directory.resolve(strict=True).parent != root:
            raise ValueError
        for path in (content, metadata_path):
            if path.resolve(strict=True).parent != directory or not stat.S_ISREG(path.lstat().st_mode):
                raise ValueError
        with metadata_path.open("rb") as metadata_file:
            encoded = metadata_file.read(4097)
        if len(encoded) > 4096:
            raise ValueError
        metadata = json.loads(encoded)
        if not isinstance(metadata, dict) or metadata.get("id") != attachment_id:
            raise ValueError
        name = _safe_name(metadata.get("name"))
        size = metadata.get("size")
        if not _valid_size(size) or content.stat().st_size != size:
            raise ValueError
    except (OSError, ValueError, RuntimeError):
        raise ValueError("附件不存在或已损坏，请重新上传。") from None
    suffix = Path(name).suffix.lower()
    if not re.fullmatch(r"\.[a-z0-9]{1,12}", suffix):
        suffix = ".bin"
    return {"id": attachment_id, "name": name, "size": size, "path": content, "suffix": suffix}


def load_attachments(value):
    """Resolve distinct upload IDs; only server-stored metadata is trusted."""
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > MAX_ATTACHMENTS:
        raise ValueError("每次最多使用 16 个附件。")
    ids = [item.get("id") if isinstance(item, dict) else item for item in value]
    if (not all(isinstance(item, str) and _ATTACHMENT_ID.fullmatch(item) for item in ids)
            or len(set(ids)) != len(ids)):
        raise ValueError("附件编号无效或重复。")
    root = _storage_root()
    return [_load_attachment(root, attachment_id) for attachment_id in ids]


def read_attachment(attachment_id):
    """Read a stored upload without accepting a caller-supplied filesystem path."""
    record, = load_attachments([attachment_id])
    with record["path"].open("rb") as stream:
        content = stream.read(record["size"] + 1)
    if len(content) != record["size"]:
        raise ValueError("附件长度与声明不一致。")
    return record, content


def stage_attachments(records, workspace):
    """Copy attachments into a fresh workspace and return only relative paths."""
    if not records:
        return []
    directory = Path(workspace) / "attachments"
    directory.mkdir(mode=0o700)
    staged = []
    for index, record in enumerate(records, start=1):
        filename = f"attachment-{index}{record['suffix']}"
        source = record["path"]
        if source.resolve(strict=True) != source or not stat.S_ISREG(source.lstat().st_mode):
            raise ValueError("附件不存在或已损坏，请重新上传。")
        with source.open("rb") as input_file, (directory / filename).open("xb") as output:
            _copy_exact(input_file, output, record["size"])
            if input_file.read(1):
                raise ValueError("附件长度与声明不一致。")
        staged.append({
            "id": record["id"], "name": record["name"], "size": record["size"],
            "path": f"attachments/{filename}",
        })
    return staged
