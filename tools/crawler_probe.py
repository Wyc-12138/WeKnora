#!/usr/bin/env python3
"""PROTOTYPE: browser-rendered crawler probe.

This command is intentionally a thin wrapper around
`docreader.utils.browser_crawler`, which is also used by DocReader URL import.
If this probe and DocReader use the same options, they use the same crawler
implementation.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from docreader.config import CONFIG
from docreader.utils.browser_crawler import BrowserCrawlConfig, crawl
from docreader.utils.redfox_provider import fetch_redfox_article_with_diagnostics


def _is_wechat_article_url(url: str) -> bool:
    try:
        parsed = urlparse(url)
    except Exception:
        return False
    return parsed.scheme in {"http", "https"} and parsed.hostname == "mp.weixin.qq.com"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Probe whether Playwright-based generic crawling can fetch real page content."
    )
    parser.add_argument("--url", required=True, help="Seed URL to crawl.")
    parser.add_argument("--max-depth", type=int, default=0, help="Maximum BFS depth. Default: 0.")
    parser.add_argument("--max-pages", type=int, default=3, help="Maximum pages to fetch. Default: 3.")
    parser.add_argument(
        "--allowed-domain",
        action="append",
        default=[],
        help="Allowed hostname or suffix. Can be repeated. Defaults to the seed hostname.",
    )
    parser.add_argument("--delay-ms", type=int, default=800, help="Delay between pages. Default: 800.")
    parser.add_argument(
        "--output",
        default="crawler_probe_output.json",
        help="Output JSON file. Default: crawler_probe_output.json.",
    )
    parser.add_argument(
        "--browser",
        choices=("chromium", "webkit", "firefox"),
        default="chromium",
        help="Playwright browser engine. Default: chromium.",
    )
    parser.add_argument(
        "--browser-channel",
        choices=("chrome", "msedge"),
        help="Use an installed Chrome/Edge channel instead of Playwright's bundled browser.",
    )
    parser.add_argument(
        "--executable-path",
        help="Path to a browser executable. Useful when Playwright browser download is unavailable.",
    )
    parser.add_argument("--headed", action="store_true", help="Run browser with a visible window.")
    parser.add_argument("--timeout-ms", type=int, default=30_000, help="Navigation timeout.")
    parser.add_argument(
        "--respect-robots",
        action="store_true",
        help="Check robots.txt before fetching. Off by default for quick diagnostics.",
    )
    parser.add_argument(
        "--allow-private-net",
        action="store_true",
        help="Allow private, loopback, link-local, and reserved IP targets. Off by default.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.max_depth < 0:
        raise SystemExit("--max-depth must be >= 0")
    if args.max_pages < 1:
        raise SystemExit("--max-pages must be >= 1")

    config = BrowserCrawlConfig(
        browser=args.browser,
        browser_channel=args.browser_channel or "",
        executable_path=args.executable_path or "",
        headed=args.headed,
        timeout_ms=args.timeout_ms,
        delay_ms=args.delay_ms,
        max_depth=args.max_depth,
        max_pages=args.max_pages,
        allowed_domains={d for d in args.allowed_domain if d.strip()},
        respect_robots=args.respect_robots,
        allow_private_net=args.allow_private_net,
    )
    redfox_doc = None
    redfox_diag = None
    if _is_wechat_article_url(args.url) and CONFIG.wechat_redfox_enabled and CONFIG.redfox_api_key:
        redfox_doc, redfox_diag = fetch_redfox_article_with_diagnostics(
            args.url,
            api_key=CONFIG.redfox_api_key,
            base_url=CONFIG.redfox_base_url,
        )

    if redfox_doc is not None:
        output = {
            "prototype": "crawler_probe",
            "seed_url": args.url,
            "config": {
                "max_depth": args.max_depth,
                "max_pages": args.max_pages,
                "allowed_domains": sorted(config.allowed_domains),
                "delay_ms": args.delay_ms,
                "browser": args.browser,
                "browser_channel": args.browser_channel,
                "executable_path": args.executable_path,
                "respect_robots": args.respect_robots,
                "allow_private_net": args.allow_private_net,
                "redfox_enabled": True,
            },
            "redfox": redfox_diag,
            "summary": {"ok": 1, "blocked": 0, "failed": 0, "visited": 1, "queued": 1},
            "pages": [
                {
                    "url": args.url,
                    "depth": 0,
                    "status": "ok",
                    "title": redfox_doc.metadata.get("title", ""),
                    "http_status": 200,
                    "markdown": redfox_doc.content,
                    "markdown_length": len(redfox_doc.content),
                    "visible_text_length": len(redfox_doc.content),
                    "discovered_links": [],
                    "block_reason": "",
                    "method": "redfox",
                    "error": "",
                    "elapsed_ms": 0,
                    "metadata": redfox_doc.metadata,
                }
            ],
        }
    else:
        output = asyncio.run(crawl(args.url, config))
        if redfox_diag is not None:
            output["redfox"] = redfox_diag
            output.setdefault("config", {})["redfox_enabled"] = True
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(output["summary"], ensure_ascii=False))
    print(str(output_path))


if __name__ == "__main__":
    main()
