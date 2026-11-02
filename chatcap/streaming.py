from __future__ import annotations

import re
import threading
from datetime import datetime
from typing import Iterator

from dateutil import parser as date_parser

from .downloader import _Downloader


class ChatStreamer:
    """Generator-based live-chat streamer built on YouTubeChatDownloader's helpers.

    NOTE: YouTubeChatDownloader.download_chat() is NOT a generator. It blocks until
    the whole chat is fetched (never, for a live stream) and returns a list, so it
    can't be used to stream messages into a UI. This class re-implements the
    polling loop and yields each message as soon as it arrives.
    """

    def __init__(self, video_url: str, stop: threading.Event) -> None:
        self.dl = _Downloader()
        self.video_url = video_url
        self.stop = stop
        self.status = ""
        self.finished_reason = ""

    def _get(self, api_key: str, version: str, cont: str, live: bool) -> dict:
        return self.dl.get_live_chat_data(api_key, version, cont, is_live=live, retries=3)

    @staticmethod
    def _timeout_s(data: dict, default: float) -> float:
        """Honour YouTube's suggested poll delay (timeoutMs), clamped to 1–5 s."""
        found: list[int] = []

        def walk(o):
            if found:
                return
            if isinstance(o, dict):
                v = o.get("timeoutMs")
                if v is not None:
                    try:
                        found.append(int(v))
                        return
                    except (TypeError, ValueError):
                        pass
                for x in o.values():
                    walk(x)
            elif isinstance(o, list):
                for x in o:
                    walk(x)

        walk(data)
        if not found:
            return default
        return min(5.0, max(1.0, found[0] / 1000.0))

    def _stream_start(self, html: str, video_id: str) -> float | None:
        """Unix time at which the live stream started (None if unknown)."""
        m = re.search(r'"startTimestamp"\s*:\s*"([^"]+)"', html)
        if m:
            try:
                return date_parser.isoparse(m.group(1)).timestamp()
            except (ValueError, OverflowError):
                pass
        try:
            info = self.dl.get_video_info(video_id)
            ts = info.get("release_timestamp") or info.get("timestamp")
            return float(ts) if ts else None
        except Exception:
            return None

    def _stamp(self, m: dict, start: float) -> None:
        """Rewrite a live message's timestamp as elapsed stream time (H:MM:SS)."""
        try:
            ms = int((datetime.fromisoformat(m["datetime"]).timestamp() - start) * 1000)
        except (KeyError, ValueError, TypeError):
            return
        m["timestamp"] = ("-" if ms < 0 else "") + self.dl.ms_to_timestamp(abs(ms))
        m["video_offset_ms"] = str(ms)

    def messages(self) -> Iterator[dict]:
        dl, stop = self.dl, self.stop
        video_id = dl.extract_video_id(self.video_url)
        page_url = f"https://www.youtube.com/watch?v={video_id}"

        self.status = "Fetching video page…"
        html = dl.fetch_html(page_url)
        api_key, version, yid = dl.extract_innertube_params(html)
        if not api_key:
            raise RuntimeError("Could not extract the YouTube innertube API key.")
        if not yid:
            raise RuntimeError("Could not extract ytInitialData from the page.")
        cont = dl.find_continuation(yid)
        if not cont:
            raise RuntimeError("No live-chat continuation found — does this video have chat?")

        looks_live = bool(re.search(r'"isLive"\s*:\s*true', html))
        live = looks_live

        self.status = "Connecting to chat…"
        try:
            data = self._get(api_key, version, cont, live)
        except Exception as e:
            if "400" not in str(e):
                raise
            live = not live
            data = self._get(api_key, version, cont, live)

        start = self._stream_start(html, video_id) if live else None

        seen_ids: set[str] = set()
        seen_conts: set[str] = set()
        idle_polls = 0
        self.status = "live" if live else "replay"

        while not stop.is_set():
            msgs, _ = dl.parse_live_chat_messages(data)
            for m in msgs:
                mid = m.get("message_id")
                if mid:
                    if mid in seen_ids:
                        continue
                    seen_ids.add(mid)
                if start is not None:
                    self._stamp(m, start)
                yield m

            nxt = dl.extract_next_continuation(data)
            if not nxt:
                if not live:
                    self.finished_reason = "End of replay."
                    return
                idle_polls += 1
                if idle_polls >= 5:
                    try:
                        fresh = dl.find_continuation(
                            dl.extract_innertube_params(dl.fetch_html(page_url))[2]
                        )
                        if fresh:
                            nxt, idle_polls = fresh, 0
                    except Exception:
                        pass
                if not nxt:
                    if stop.wait(5):
                        return
                    nxt = cont
            else:
                idle_polls = 0

            if not live and nxt in seen_conts:
                self.finished_reason = "End of replay."
                return
            seen_conts.add(nxt)
            cont = nxt

            delay = self._timeout_s(data, 1.0) if live else 0.08
            if stop.wait(delay):
                return

            try:
                data = self._get(api_key, version, cont, live)
            except Exception as e:
                if not live:
                    raise
                self.status = f"Retrying after error: {e}"
                if stop.wait(10):
                    return
                data = {}
                continue
