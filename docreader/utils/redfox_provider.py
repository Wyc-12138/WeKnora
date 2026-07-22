from __future__ import annotations

import logging
import re
from typing import Any
from urllib.parse import urljoin
from urllib.parse import urlparse

import requests

from docreader.models.document import Document
from docreader.utils.browser_crawler import clean_markdown, normalized_text
from docreader.utils.ssrf import is_ssrf_safe_url

logger = logging.getLogger(__name__)

_REDFOX_PATH = "/story/api/gzhData/queryArticleDetail"
_REDFOX_TIMEOUT = (5, 25)
_CONTENT_MIN_VISIBLE_LEN = 80


def _diagnostic(endpoint: str) -> dict[str, Any]:
    parsed = urlparse(endpoint)
    return {
        "attempted": True,
        "endpoint_host": parsed.hostname or "",
        "http_status": None,
        "code": None,
        "msg": "",
        "data_type": "",
        "title": "",
        "author": "",
        "work_url": "",
        "content_length": 0,
        "markdown_length": 0,
        "visible_text_length": 0,
        "usable": False,
        "error": "",
    }


def _looks_like_html(text: str) -> bool:
    return bool(re.search(r"<[a-zA-Z][^>]*>", text or ""))


def _content_to_markdown(content: str) -> str:
    content = content or ""
    if not _looks_like_html(content):
        return clean_markdown(content)

    try:
        from bs4 import BeautifulSoup
        from markdownify import markdownify

        soup = BeautifulSoup(content, "html.parser")
        for node in soup.select("script, style, iframe, noscript, svg"):
            node.decompose()
        return clean_markdown(markdownify(str(soup), heading_style="ATX", bullets="-"))
    except Exception:
        return clean_markdown(re.sub(r"<[^>]+>", "", content))


def _string_value(data: dict[str, Any], key: str) -> str:
    value = data.get(key)
    if value is None:
        return ""
    return str(value).strip()


def _metadata(data: dict[str, Any], source_url: str) -> dict[str, str]:
    field_map = {
        "workUuid": "work_uuid",
        "workUrl": "work_url",
        "title": "title",
        "summary": "summary",
        "publishTime": "publish_time",
        "author": "author",
        "readCount": "read_count",
        "watchCount": "watch_count",
        "likeCount": "like_count",
        "commentCount": "comment_count",
        "collectCount": "collect_count",
        "shareCount": "share_count",
        "rewardCount": "reward_count",
        "isOriginal": "is_original",
        "syncTime": "sync_time",
        "accountType": "account_type",
        "coverUrl": "cover_url",
        "publishLocation": "publish_location",
        "memo": "memo",
        "sourceUrl": "source_url",
        "originalAuthor": "original_author",
        "orderNum": "order_num",
    }
    metadata = {
        "source": "redfox",
        "source_url": source_url,
    }
    for src, dst in field_map.items():
        value = data.get(src)
        if value is not None and str(value).strip() != "":
            metadata[dst] = str(value).strip()
    return metadata


def _build_document(data: dict[str, Any], source_url: str) -> Document | None:
    body = _content_to_markdown(_string_value(data, "content"))
    if len(normalized_text(body)) < _CONTENT_MIN_VISIBLE_LEN:
        return None

    title = _string_value(data, "title")
    author = _string_value(data, "author") or _string_value(data, "originalAuthor")
    publish_time = _string_value(data, "publishTime")
    summary = _string_value(data, "summary")

    parts = []
    if title:
        parts.append(f"# {title}")
    meta = " | ".join(part for part in (author, publish_time) if part)
    if meta:
        parts.append(meta)
    if summary:
        parts.append(f"## 摘要\n\n{summary}")
    parts.append(body)

    return Document(
        content=clean_markdown("\n\n".join(parts)),
        metadata=_metadata(data, source_url),
    )


def fetch_redfox_article_with_diagnostics(
    article_url: str,
    api_key: str,
    base_url: str = "https://redfox.hk",
) -> tuple[Document | None, dict[str, Any]]:
    api_key = (api_key or "").strip()
    endpoint = urljoin(base_url.rstrip("/") + "/", _REDFOX_PATH.lstrip("/"))
    diag = _diagnostic(endpoint)
    if not api_key:
        diag["attempted"] = False
        diag["error"] = "missing_api_key"
        return None, diag

    safe, reason = is_ssrf_safe_url(endpoint)
    if not safe:
        logger.warning("RedFox endpoint blocked by SSRF guard: %s", reason)
        diag["error"] = f"ssrf_guard:{reason}"
        return None, diag

    try:
        response = requests.post(
            endpoint,
            headers={
                "Content-Type": "application/json",
                "REDFOX_API_KEY": api_key,
            },
            json={"url": article_url},
            timeout=_REDFOX_TIMEOUT,
        )
    except Exception as exc:
        logger.warning("RedFox article request failed: %s", exc)
        diag["error"] = f"request_failed:{exc}"
        return None, diag

    diag["http_status"] = response.status_code
    if response.status_code != 200:
        logger.warning("RedFox article request returned HTTP %s", response.status_code)
        diag["error"] = "http_status_not_200"
        return None, diag

    try:
        payload = response.json()
    except Exception as exc:
        logger.warning("RedFox article response is not JSON: %s", exc)
        diag["error"] = f"invalid_json:{exc}"
        return None, diag

    code = payload.get("code")
    diag["code"] = code
    diag["msg"] = str(payload.get("msg") or payload.get("message") or "")
    if code not in (2000, "2000"):
        msg = diag["msg"]
        logger.warning("RedFox article response not successful: code=%s msg=%s", code, msg)
        diag["error"] = "business_code_not_2000"
        return None, diag

    data = payload.get("data")
    diag["data_type"] = type(data).__name__
    if not isinstance(data, dict):
        logger.warning("RedFox article response missing data object")
        diag["error"] = "missing_data_object"
        return None, diag

    raw_content = _string_value(data, "content")
    markdown = _content_to_markdown(raw_content)
    visible_len = len(normalized_text(markdown))
    diag.update(
        {
            "title": _string_value(data, "title"),
            "author": _string_value(data, "author") or _string_value(data, "originalAuthor"),
            "work_url": _string_value(data, "workUrl"),
            "content_length": len(raw_content),
            "markdown_length": len(markdown),
            "visible_text_length": visible_len,
        }
    )

    doc = _build_document(data, article_url)
    if doc is None:
        logger.warning("RedFox article response has no usable content")
        diag["error"] = "no_usable_content"
        return None, diag
    diag["usable"] = True
    return doc, diag


def fetch_redfox_article(
    article_url: str,
    api_key: str,
    base_url: str = "https://redfox.hk",
) -> Document | None:
    doc, _diag = fetch_redfox_article_with_diagnostics(article_url, api_key, base_url)
    return doc
