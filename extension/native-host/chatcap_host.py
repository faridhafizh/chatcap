"""Native messaging host for the Chatcap Chrome/Edge extension.

Chrome/Edge starts this script with one extra argument (the origin of the
calling extension) and exchanges messages over stdin/stdout using the native
messaging framing: a 4-byte little-endian length followed by UTF-8 JSON.

All scraping/analysis work is delegated to the existing ``chatcap`` package,
so the browser extension and the CLI share the same parsers, filters and
message schema (the files in ``Example/`` stay valid for both).
"""
from __future__ import annotations

import argparse
import json
import struct
import sys
import threading
import time
from pathlib import Path
from urllib.parse import urlparse

_HOST_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _HOST_DIR.parent.parent
for _entry in (str(_HOST_DIR), str(_REPO_ROOT)):
    if _entry not in sys.path:
        sys.path.insert(0, _entry)

from chatcap.analytics import analyze_messages, write_markdown  # noqa: E402
from chatcap.comments import CommentScraper  # noqa: E402
from chatcap.storage import save_json_atomic  # noqa: E402
from chatcap.streaming import ChatStreamer  # noqa: E402
from chatcap.utils import make_filter  # noqa: E402
from chatcap.worker_control import _Stop  # noqa: E402

from exporters import write_csv, write_html  # noqa: E402

HOST_NAME = "com.chatcap.host"
MAX_MESSAGE_SIZE = 4 * 1024 * 1024  # 4 MB guard against malformed frames
_WRITE_LOCK = threading.Lock()


# ---------------------------------------------------------------------------
# Native messaging wire protocol
# ---------------------------------------------------------------------------

def read_message(stream=None):
    """Read one framed JSON object. Return None on clean EOF (host should exit)."""
    if stream is None:
        stream = sys.stdin.buffer
    header = stream.read(4)
    if not header:
        return None
    if len(header) != 4:
        raise ValueError("truncated native message header")
    (length,) = struct.unpack("<I", header)
    if length == 0:
        raise ValueError("empty native message")
    if length > MAX_MESSAGE_SIZE:
        raise ValueError(f"native message too large: {length} bytes")
    payload = stream.read(length)
    if len(payload) != length:
        raise ValueError("truncated native message payload")
    obj = json.loads(payload.decode("utf-8"))
    if not isinstance(obj, dict):
        raise ValueError("native message must be a JSON object")
    return obj


def write_message(obj: dict, stream=None) -> None:
    """Write one framed JSON object. Safe to call from the capture thread."""
    if stream is None:
        stream = sys.stdout.buffer
    data = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    with _WRITE_LOCK:
        stream.write(struct.pack("<I", len(data)) + data)
        stream.flush()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def validate_url(url: str) -> str:
    """Only accept YouTube URLs — the host never fetches arbitrary sites."""
    parsed = urlparse(url or "")
    host = parsed.netloc.lower().split(":")[0]
    valid = (
        host == "youtu.be"
        or host == "youtube.com"
        or host.endswith(".youtube.com")
    )
    if parsed.scheme not in ("http", "https") or not valid:
        raise ValueError("Only YouTube URLs are supported")
    return url


def safe_filename(name: str | None) -> str:
    """Make a Windows/macOS/Linux-safe JSON filename out of user input."""
    name = (name or "").strip().replace("/", "_").replace("\\", "_")
    name = "".join(ch if ch not in '<>:"|?*' else "_" for ch in name)
    name = name.strip(". ") or "chatcap"
    if not name.lower().endswith(".json"):
        name += ".json"
    return name


def resolve_output_dir(value: str | None) -> Path:
    """Use the configured folder, else ~/Downloads/chatcap."""
    if value:
        candidate = Path(value).expanduser()
        if candidate.is_dir():
            return candidate
    fallback = Path.home() / "Downloads" / "chatcap"
    fallback.mkdir(parents=True, exist_ok=True)
    return fallback


# ---------------------------------------------------------------------------
# Capture session — mirrors ChatcapApp._handle / _worker from app.py
# ---------------------------------------------------------------------------

class Session:
    def __init__(self, config: dict, emit=None) -> None:
        self.url = validate_url(config.get("url"))
        self.mode = "comment" if config.get("mode") in ("comment", "comments") else "live"
        self.path = resolve_output_dir(config.get("output_dir")) / safe_filename(config.get("output"))
        self._filter = make_filter(config.get("keywords"), config.get("users"))
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._emit = emit or write_message
        self._last_save = 0.0
        self._seen_ids: set[str] = set()
        self.saved: list[dict] = []
        self.count = 0
        self.reason = ""

    @property
    def stopped(self):
        return self._stop

    def _save(self, force: bool = False) -> None:
        """Throttled to ~1 save/sec; caller must hold ``self._lock``."""
        now = time.monotonic()
        if not force and now - self._last_save < 1.0:
            return
        save_json_atomic(list(self.saved), str(self.path))
        self._last_save = now

    def handle(self, msg: dict) -> None:
        """Store, deduplicate, filter, persist and forward one message."""
        if self._stop.is_set():
            raise _Stop
        if not self._filter(msg):
            return
        mid = msg.get("message_id")
        with self._lock:
            if mid and mid in self._seen_ids:
                return
            if mid:
                self._seen_ids.add(mid)
            self.saved.append(msg)
            self.count += 1
            try:
                self._save()
            except OSError as e:
                self._stop.set()
                self._emit({"type": "error", "message": f"Could not save file: {e}"})
                raise _Stop from e
        self._emit({"type": "message", "msg": msg, "count": self.count})

    def run(self) -> None:
        """Run the capture until stop/completion; always do a final save."""
        self._emit({
            "type": "status",
            "text": "Scraping comments…" if self.mode == "comment" else "Connecting to live chat…",
        })
        try:
            if self.mode == "comment":
                scraper = CommentScraper(self.url, self._stop)
                scraper.run(self.handle)
                self.reason = scraper.finished_reason or "Done."
            else:
                streamer = ChatStreamer(self.url, self._stop)
                for msg in streamer.messages():
                    self.handle(msg)
                self.reason = streamer.finished_reason or "Stopped."
            self._emit({"type": "ended", "reason": self.reason, "count": self.count})
        except _Stop:
            self.reason = self.reason or "Stopped by user."
        except Exception as e:  # noqa: BLE001 — surface everything to the panel
            if not self._stop.is_set():
                self._emit({"type": "error", "message": str(e) or type(e).__name__})
                self.reason = f"Error: {e}"
        finally:
            with self._lock:
                try:
                    self._save(force=True)
                except OSError as e:
                    self._emit({"type": "error", "message": f"Final save failed: {e}"})
            self._emit({"type": "saved", "path": str(self.path), "count": self.count})

    def export(self, fmt: str) -> None:
        """Write CSV / Markdown / HTML / JSON next to the capture file."""
        fmt = (fmt or "json").lower()
        with self._lock:
            self._save(force=True)
            messages = list(self.saved)
        has_likes = any("like_count" in m for m in messages)
        analysis = analyze_messages(
            messages,
            has_likes=has_likes,
            file_path=str(self.path),
        )
        if fmt == "json":
            out = self.path
        elif fmt == "csv":
            out = write_csv(messages, self.path.with_suffix(".csv"))
        elif fmt in ("md", "markdown"):
            out = self.path.with_suffix(".md")
            write_markdown(analysis, out)
        elif fmt == "html":
            out = write_html(messages, analysis, self.path.with_suffix(".html"))
        else:
            raise ValueError(f"Unknown export format: {fmt!r}")
        self._emit({"type": "exported", "format": fmt, "path": str(out)})


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Chatcap native messaging host")
    parser.add_argument("origin", nargs="?", default="", help="Chrome extension origin (ignored)")
    args = parser.parse_args(argv)

    session: Session | None = None
    thread: threading.Thread | None = None

    while True:
        try:
            message = read_message()
        except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as e:
            write_message({"type": "error", "message": f"Invalid native message: {e}"})
            break
        if message is None:
            break  # panel closed / browser killed the host — save in finally

        kind = str(message.get("type") or "")
        try:
            if kind == "ping":
                write_message({"type": "pong"})
            elif kind == "start":
                if thread is not None and thread.is_alive():
                    write_message({"type": "error", "message": "A capture is already running."})
                    continue
                session = Session(message)
                thread = threading.Thread(target=session.run, name="chatcap-capture", daemon=True)
                thread.start()
            elif kind == "stop":
                if session is None:
                    write_message({"type": "error", "message": "No active capture."})
                else:
                    session.stopped.set()
            elif kind == "export":
                if session is None:
                    write_message({"type": "error", "message": "Start a capture before exporting."})
                else:
                    try:
                        session.export(str(message.get("format") or "json"))
                    except Exception as e:  # noqa: BLE001
                        write_message({"type": "error", "message": f"Export failed: {e}"})
            else:
                write_message({"type": "error", "message": f"Unknown command: {kind!r}"})
        except Exception as e:  # noqa: BLE001
            write_message({"type": "error", "message": f"{type(e).__name__}: {e}"})

    if session is not None:
        session.stopped.set()
        if thread is not None:
            thread.join(timeout=5)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
