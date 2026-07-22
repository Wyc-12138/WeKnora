#!/usr/bin/env python3
"""Minimal probe for the ClawHub-style WeChat article parser.

This intentionally uses only requests + BeautifulSoup, matching the public
skill description. It does not call RedFox, Jina, or Playwright.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from docreader.utils.ssrf import is_ssrf_safe_url

_TIMEOUT = (5, 25)
_MAX_BYTES = 5 * 1024 * 1024
_WECHAT_HOST = "mp.weixin.qq.com"
_UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 "
    "MicroMessenger/8.0.42 NetType/WIFI Language/zh_CN"
)
_BLOCK_MARKERS = (
    "\u73af\u5883\u5f02\u5e38",
    "\u5f53\u524d\u73af\u5883\u5f02\u5e38",
    "\u5b8c\u6210\u9a8c\u8bc1",
    "\u53bb\u9a8c\u8bc1",
    "\u53c2\u6570\u9519\u8bef",
    "captcha",
    "access denied",
    "security verification",
)


def _text(node) -> str:
    if not node:
        return ""
    return re.sub(r"\s+", " ", node.get_text(" ", strip=True)).strip()


def _meta(soup: BeautifulSoup, *names: str) -> str:
    for name in names:
        node = soup.find("meta", attrs={"property": name}) or soup.find("meta", attrs={"name": name})
        if node and node.get("content"):
            return str(node["content"]).strip()
    return ""


def _is_wechat_url(url: str) -> bool:
    try:
        parsed = urlparse(url)
    except Exception:
        return False
    return parsed.scheme in {"http", "https"} and parsed.hostname == _WECHAT_HOST


def _read_limited(response: requests.Response) -> str:
    chunks: list[bytes] = []
    total = 0
    for chunk in response.iter_content(chunk_size=65536):
        if not chunk:
            continue
        total += len(chunk)
        if total > _MAX_BYTES:
            raise RuntimeError("response_too_large")
        chunks.append(chunk)
    encoding = response.encoding or response.apparent_encoding or "utf-8"
    return b"".join(chunks).decode(encoding, errors="replace")


def parse_html(html: str, url: str) -> dict:
    soup = BeautifulSoup(html or "", "html.parser")
    root = soup.select_one("#js_content") or soup.select_one(".rich_media_content")
    page_text = _text(soup)
    blocked = any(marker.lower() in page_text.lower() for marker in _BLOCK_MARKERS)

    title = (
        _text(soup.select_one("#activity-name"))
        or _meta(soup, "og:title", "twitter:title")
        or _text(soup.title)
    )
    author = _text(soup.select_one("#js_name"))
    publish_time = _text(soup.select_one("#publish_time"))

    content = _text(root) if root else ""
    images = []
    if root:
        for img in root.find_all("img"):
            src = img.get("data-src") or img.get("data-original") or img.get("src") or ""
            if src:
                images.append(urljoin(url, src))

    return {
        "title": title,
        "author": author,
        "publish_time": publish_time,
        "content": content,
        "content_length": len(re.sub(r"\s+", "", content)),
        "images_count": len(images),
        "images": images,
        "has_article_root": root is not None,
        "blocked_marker": blocked,
        "page_text_head": page_text[:500],
    }


def probe(url: str, cookie: str = "") -> dict:
    if not _is_wechat_url(url):
        return {"ok": False, "status": "failed", "error": "not_mp_weixin_url", "url": url}
    safe, reason = is_ssrf_safe_url(url)
    if not safe:
        return {"ok": False, "status": "failed", "error": f"ssrf_guard:{reason}", "url": url}

    headers = {
        "User-Agent": _UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Referer": "https://mp.weixin.qq.com/",
    }
    if cookie:
        headers["Cookie"] = cookie

    try:
        response = requests.get(url, headers=headers, timeout=_TIMEOUT, stream=True)
        html = _read_limited(response)
    except Exception as exc:
        return {"ok": False, "status": "failed", "error": str(exc), "url": url}
    finally:
        try:
            response.close()
        except Exception:
            pass

    parsed = parse_html(html, url)
    ok = (
        response.status_code == 200
        and parsed["has_article_root"]
        and parsed["content_length"] >= 120
        and not parsed["blocked_marker"]
    )
    status = "ok" if ok else "blocked" if parsed["blocked_marker"] else "failed"
    return {
        "prototype": "clawhub_wechat_probe",
        "started_at": datetime.now(timezone.utc).isoformat(),
        "url": url,
        "method": "requests_bs4",
        "http_status": response.status_code,
        "ok": ok,
        "status": status,
        **parsed,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Probe ClawHub-style WeChat article parsing.")
    parser.add_argument("--url", required=True)
    parser.add_argument("--cookie", default="", help="Optional raw Cookie header value.")
    parser.add_argument("--output", default="tmp/clawhub_wechat_probe.json")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    output = probe(args.url, cookie=args.cookie)
    path = Path(args.output)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({k: output.get(k) for k in ("ok", "status", "http_status", "content_length", "has_article_root", "blocked_marker")}, ensure_ascii=False))
    print(str(path))


if __name__ == "__main__":
    main()
