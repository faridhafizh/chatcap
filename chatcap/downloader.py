from datetime import datetime

from yt_chat_downloader import YouTubeChatDownloader


class _Downloader(YouTubeChatDownloader):
    """Fix renderer type detection and timestamps from yt_chat_downloader."""

    def _parse_message_renderer(self, renderer, video_offset="0"):
        m = super()._parse_message_renderer(renderer, video_offset)
        if m:
            if m.get("timestamp") in ("", "0:00") and m.get("datetime"):
                try:
                    m["timestamp"] = datetime.fromisoformat(m["datetime"]).strftime("%H:%M:%S")
                except ValueError:
                    pass
            if "purchaseAmountText" in renderer:
                m["message_type"] = "super_chat"
            elif "headerSubtext" in renderer or "headerPrimaryText" in renderer:
                m["message_type"] = "membership"
        return m
