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
    parser.add_argument(
        "--append", "-a",
        dest="append",
        action="store_true",
        help="Append to an existing output file instead of overwriting.",
    )
    parser.add_argument(
        "--keyword",
        dest="keywords",
        action="append",
        default=None,
        help="Keyword filter (repeatable). Case-insensitive substring match on comment.",
    )
    parser.add_argument(
        "--user",
        dest="users",
        action="append",
        default=None,
        help="User filter (repeatable). Case-insensitive substring match on user name or id.",
    )
    args = parser.parse_args()

    ChatcapApp(
        video_url=args.video_url,
        output_file=args.output,
        comment_mode=args.comment,
        keywords=args.keywords,
        users=args.users,
        append=args.append,
    ).run()
