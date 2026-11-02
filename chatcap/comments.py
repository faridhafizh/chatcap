from __future__ import annotations

import re
import threading
from datetime import datetime
from itertools import islice
from typing import Any, cast

from .downloader import _Downloader
from .worker_control import _Stop


class _YDLLogger:
    """Keeps yt-dlp from writing to the terminal (which Textual owns)."""

    def __init__(self) -> None:
        self.problems: list[str] = []

    def debug(self, msg: str) -> None: ...
    def info(self, msg: str) -> None: ...

    def warning(self, msg: str) -> None:
        self.problems.append(re.sub(r"^(WARNING:\s*)?(\[\w+\]\s*)?", "", msg).strip())

    def error(self, msg: str) -> None:
        self.problems.append(re.sub(r"^(ERROR:\s*)?(\[\w+\]\s*)?", "", msg).strip())


class CommentScraper:
    """Scrapes all regular comments (top-level + replies) of a video with yt-dlp.

    yt-dlp only hands back comments at the very end, so its internal comment
    generator is wrapped (best effort) to emit them as they arrive.
    """

    def __init__(self, video_url: str, stop: threading.Event) -> None:
        self.dl = _Downloader()
        self.video_url = video_url
        self.stop = stop
        self.finished_reason = ""
        self.n_top = 0
        self.n_reply = 0

    def _convert(self, c: dict) -> dict:
        author = (c.get("author") or "").strip()
        name = author.lstrip("@") or "Unknown User"
        handle = author if author.startswith("@") else "@" + name.replace(" ", "")
        iso, date = "", ""
        ts = c.get("timestamp")
        if isinstance(ts, (int, float)):
            dt = datetime.fromtimestamp(ts)
            iso, date = dt.isoformat(), dt.strftime("%Y-%m-%d")
        parent = c.get("parent")
        return {
            "user_id": c.get("author_id", ""),
            "user_display_name": name,
            "user_handle": handle,
            "datetime": iso,
            "timestamp": date,
            "comment": self.dl._normalize_text(c.get("text") or ""),
            "message_type": "comment",
            "like_count": c.get("like_count") or 0,
            "is_reply": parent not in (None, "root"),
            "parent_id": "" if parent in (None, "root") else parent,
            "is_pinned": bool(c.get("is_pinned")),
            "is_favorited": bool(c.get("is_favorited")),
            "author_is_uploader": bool(c.get("author_is_uploader")),
            "author_thumbnail": c.get("author_thumbnail", ""),
            "message_id": c.get("id", ""),
            "badges": [],
            "purchase_amount": "",
            "video_offset_ms": "0",
        }

    def run(self, emit) -> None:
        """Calls emit(message_dict) for every comment; returns when done/stopped."""
        import yt_dlp

        video_id = self.dl.extract_video_id(self.video_url)
        url = f"https://www.youtube.com/watch?v={video_id}"
        seen: set[str] = set()

        def push(c: dict) -> None:
            cid = c.get("id") or id(c)
            if cid in seen:
                return
            seen.add(str(cid))
            if self.stop.is_set():
                raise _Stop
            m = self._convert(c)
            if m["is_reply"]:
                self.n_reply += 1
            else:
                self.n_top += 1
            emit(m)

        patched: tuple[type, Any, bool] | None = None
        try:
            from yt_dlp.extractor.youtube import YoutubeIE

            orig = YoutubeIE._get_comments
            own = "_get_comments" in YoutubeIE.__dict__

            def _get_comments_wrapped(self, *a, **k):
                def _gen():
                    for c in orig(self, *a, **k):
                        push(c)
                        yield c

                return islice(_gen(), None)

            setattr(YoutubeIE, "_get_comments", _get_comments_wrapped)
            patched = (YoutubeIE, orig, own)
        except Exception:
            patched = None

        logger = _YDLLogger()
        opts = {
            "quiet": True,
            "logger": logger,
            "skip_download": True,
            "getcomments": True,
            "noplaylist": True,
            "ignore_no_formats_error": True,
            "extractor_args": {"youtube": {"max_comments": ["all"], "comment_sort": ["top"]}},
        }
        info: dict[str, Any] = {}
        error: Exception | None = None
        try:
            with yt_dlp.YoutubeDL(cast(Any, opts)) as ydl:
                raw = ydl.extract_info(url, download=False) or {}
                info = cast(dict[str, Any], raw)
        except _Stop:
            return
        except Exception as e:  # noqa: BLE001
            error = e
        finally:
            if patched is not None:
                cls, orig_fn, own = patched
                if own:
                    setattr(cls, "_get_comments", orig_fn)
                else:
                    delattr(cls, "_get_comments")

        if self.stop.is_set():
            return
        for c in info.get("comments") or []:
            push(c)

        total = self.n_top + self.n_reply
        if error is not None:
            msg = str(error).replace("ERROR: ", "")
            if total == 0:
                raise RuntimeError(msg)
            self.finished_reason = (
                f"Stopped early ({msg[:80]}). "
                f"Got {self.n_top} comments + {self.n_reply} replies."
            )
        elif total == 0:
            hint = f" ({logger.problems[-1]})" if logger.problems else ""
            self.finished_reason = f"No comments found — they may be disabled{hint}."
        else:
            self.finished_reason = f"{self.n_top} comments + {self.n_reply} replies."
