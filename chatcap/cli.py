"""Command-line entry point for Chatcap.

Run with ``python -m chatcap URL`` or ``python index.py URL``.
Install dependencies with ``pip install -e .``.
"""

import argparse

from .app import ChatcapApp


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Chatcap — capture YouTube live chat and comments."
    )
    parser.add_argument(
        "video_url",
        help="YouTube video URL (e.g. https://www.youtube.com/watch?v=VIDEO_ID)",
    )
    parser.add_argument(
        "--comment", "--comments",
        dest="comment",
        action="store_true",
        help="Scrape ALL regular comments (including replies) of the video or of an "
             "ended live stream, instead of streaming the live chat.",
    )
    parser.add_argument(
        "-o", "--output",
        default=None,
        help="Output JSON file path (default: my_live_chat.json, "
        "or my_comments.json with --comment)",
    )
    args = parser.parse_args()

    ChatcapApp(
        video_url=args.video_url,
        output_file=args.output,
        comment_mode=args.comment,
    ).run()
