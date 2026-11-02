from __future__ import annotations

import contextlib
import threading
import time

from rich.markup import escape
from rich.text import Text
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Vertical
from textual.message import Message
from textual.widgets import Footer, Header, RichLog, Static

from .comments import CommentScraper
from .storage import save_json_atomic
from .streaming import ChatStreamer
from .utils import PLAIN_TYPES, user_color
from .worker_control import _Stop


class ChatMessage(Message):
    """A new chat message."""

    def __init__(self, msg: dict) -> None:
        self.msg = msg
        super().__init__()


class StreamState(Message):
    """Stream lifecycle update: kind is 'running' | 'ended' | 'error'."""

    def __init__(self, kind: str, text: str = "") -> None:
        self.kind = kind
        self.text = text
        super().__init__()


class ChatcapApp(App):
    CSS = """
    Screen { layout: vertical; }

    #status {
        height: 1;
        background: $accent;
        color: $text;
        padding: 0 1;
        text-style: bold;
    }

    #log {
        border: round $primary;
        height: 1fr;
        padding: 0 1;
    }
    """

    BINDINGS = [
        Binding("q", "quit", "Quit", priority=True, show=True),
        Binding("ctrl+c", "quit", "Quit", priority=True, show=False),
        Binding("c", "clear", "Clear"),
    ]

    def __init__(
        self,
        video_url: str,
        output_file: str | None = None,
        comment_mode: bool = False,
    ):
        super().__init__()
        self.video_url = video_url
        self.comment_mode = comment_mode
        self.output_file = output_file or (
            "my_comments.json" if comment_mode else "my_live_chat.json"
        )
        self.count = 0
        self.saved: list[dict] = []
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._ended = False
        self._save_lock = threading.Lock()
        self._last_save = 0.0

    def compose(self) -> ComposeResult:
        yield Header(show_clock=True)
        yield Vertical(
            Static(
                "Fetching comments…" if self.comment_mode else "Connecting to chat…",
                id="status",
            ),
            RichLog(
                id="log",
                markup=False,
                wrap=True,
                highlight=False,
                max_lines=5000,
                auto_scroll=True,
            ),
        )
        yield Footer()

    def on_mount(self) -> None:
        self.title = "Chatcap · Comments" if self.comment_mode else "Chatcap · Live Chat"
        self.sub_title = self.video_url
        self._thread = threading.Thread(
            target=self._worker, name="yt_worker", daemon=True
        )
        self._thread.start()

    def _save(self, force: bool = False) -> None:
        """Write the JSON file (throttled to once a second unless forced)."""
        now = time.monotonic()
        if not force and now - self._last_save < 1.0:
            return
        with self._save_lock:
            self._last_save = now
            save_json_atomic(list(self.saved), self.output_file)

    def _handle(self, msg: dict) -> None:
        """Store, persist and display one message (called from the worker thread)."""
        if self._stop.is_set():
            raise _Stop
        self.saved.append(msg)
        try:
            self._save()
        except OSError as e:
            self.post_message(StreamState("error", f"Could not save file: {e}"))
            self._stop.set()
            raise _Stop from e
        self.post_message(ChatMessage(msg))

    def _worker(self) -> None:
        try:
            self.post_message(StreamState("running"))
            if self.comment_mode:
                scraper = CommentScraper(self.video_url, self._stop)
                scraper.run(self._handle)
                reason = scraper.finished_reason
            else:
                streamer = ChatStreamer(self.video_url, self._stop)
                for msg in streamer.messages():
                    self._handle(msg)
                reason = streamer.finished_reason
            if not self._stop.is_set():
                self.post_message(StreamState("ended", reason))
        except _Stop:
            pass
        except Exception as e:  # noqa: BLE001 — surface everything to the UI
            if not self._stop.is_set():
                self.post_message(StreamState("error", str(e) or type(e).__name__))
        finally:
            with contextlib.suppress(Exception):
                self._save(force=True)

    def on_chat_message(self, event: ChatMessage) -> None:
        self._add_message(event.msg)

    def on_stream_state(self, event: StreamState) -> None:
        if event.kind == "running":
            self._set_status(self._live_status())
        elif event.kind == "ended":
            self._ended = True
            extra = f" {event.text}" if event.text else ""
            what = "Done." if self.comment_mode else "Stream ended."
            unit = "comments" if self.comment_mode else "messages"
            self._set_status(f"✅ {what}{extra} {self.count} {unit} saved → {self.output_file}")
        elif event.kind == "error":
            self._ended = True
            self._show_error(event.text)

    def _live_status(self) -> str:
        if self.comment_mode:
            return f"▶ Scraping · {self.count} comments · saving → {self.output_file}"
        return f"▶ Live · {self.count} messages · saving → {self.output_file}"

    def _add_message(self, msg: dict) -> None:
        self.count += 1
        user = msg.get("user_display_name") or msg.get("author") or "?"
        comment = msg.get("comment") or msg.get("message") or ""
        mtype = (msg.get("message_type") or "text").lower()

        line = Text()

        ts = msg.get("timestamp")
        if ts:
            line.append(f"[{ts}] ", style="dim")

        if mtype == "comment":
            if msg.get("is_reply"):
                line.append("↳ ", style="dim")
            if msg.get("is_pinned"):
                line.append("📌 ")

        line.append(str(user), style=f"bold {user_color(str(user))}")
        if msg.get("author_is_uploader"):
            line.append(" (creator)", style="dim cyan")
        line.append(": ", style="dim")

        if mtype == "super_chat":
            line.append(comment, style="bold gold1")
            amount = msg.get("purchase_amount", "")
            if amount:
                line.append(f"  {amount}", style="bold on dark_goldenrod")
        elif mtype == "membership":
            line.append(comment, style="bright_green")
        else:
            line.append(comment, style="white")

        if mtype == "comment" and msg.get("like_count"):
            line.append(f"  👍 {msg['like_count']}", style="dim")

        if mtype not in PLAIN_TYPES:
            line.append(f"  [{mtype}]", style="dim italic yellow")

        self.query_one("#log", RichLog).write(line)
        if not self._ended:
            self._set_status(self._live_status())

    def _set_status(self, text: str) -> None:
        # Pass a Text object so '[' / ']' in filenames or errors aren't parsed as markup.
        self.query_one("#status", Static).update(Text(text))

    def _show_error(self, message: str) -> None:
        self._set_status(f"❌ Error: {message}")
        self.notify(escape(message), title="Error", severity="error", timeout=10)
        self.query_one("#log", RichLog).write(Text(f"ERROR: {message}", style="bold red"))

    async def action_quit(self) -> None:
        self._stop.set()
        with contextlib.suppress(Exception):
            self._save(force=True)
        self.exit()

    def action_clear(self) -> None:
        self.query_one("#log", RichLog).clear()
        self.notify("Log cleared (messages are still being saved).", timeout=2)
