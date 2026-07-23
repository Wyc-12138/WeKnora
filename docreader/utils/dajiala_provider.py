from __future__ import annotations

import logging
import re
from typing import Any
from urllib.parse import urljoin
from urllib.parse import urlparse

import requests
from bs4 import BeautifulSoup
from markdownify import markdownify

from docreader.models.document import Document
from docreader.utils.browser_crawler import clean_markdown, normalized_text
from docreader.utils.ssrf import is_ssrf_safe_url

logger = logging.getLogger(__name__)

_DAJIALA_PATH = "/fbmain/monitor/v3/article_html"
_DAJIALA_TIMEOUT = (5, 30)
_CONTENT_MIN_VISIBLE_LEN = 80


def _diagnostic(endpoint: str) -> dict[str, Any]:
    parsed = urlparse(endpoint)
    return {
        "attempted": True,
        "endpoint_host": parsed.hostname or "",
        "http_status": None,
        "code": None,
        "msg": "",
        "title": "",
        "html_length": 0,
        "markdown_length": 0,
        "visible_text_length": 0,
        "usable": False,
        "error": "",
    }


def _string_value(data: dict[str, Any], key: str) -> str:
    value = data.get(key)
    if value is None:
        return ""
    return str(value).strip()


def _html_to_markdown(html: str) -> str:
    html = html or ""
    if not html.strip():
        return ""
    soup = BeautifulSoup(html, "html.parser")
    for node in soup.select("script, style, iframe, noscript, svg"):
        node.decompose()
    markdown = markdownify(str(soup), heading_style="ATX", bullets="-")
    markdown = re.sub(r"\n{3,}", "\n\n", markdown)
    return clean_markdown(markdown)


def _metadata(data: dict[str, Any], source_url: str) -> dict[str, str]:
    field_map = {
        "title": "title",
        "biz": "biz",
        "article_url": "article_url",
        "mp_head_img": "mp_head_img",
        "cover_url": "cover_url",
        "nickname": "account",
        "post_time": "post_time",
        "post_time_str": "publish_time",
        "gh_id": "gh_id",
        "wxid": "wxid",
        "signature": "signature",
        "author": "author",
        "desc": "description",
        "copyright": "copyright",
        "ip_wording": "ip_wording",
    }
    metadata = {
        "source": "dajiala",
        "source_url": source_url,
    }
    for src, dst in field_map.items():
        value = data.get(src)
        if value is not None and str(value).strip() != "":
            metadata[dst] = str(value).strip()
    return metadata


def _build_document(data: dict[str, Any], source_url: str) -> Document | None:
    html = _string_value(data, "html")
    body = _html_to_markdown(html)
    if len(normalized_text(body)) < _CONTENT_MIN_VISIBLE_LEN:
        return None

    title = _string_value(data, "title")
    account = _string_value(data, "nickname")
    publish_time = _string_value(data, "post_time_str")
    description = _string_value(data, "desc")

    parts = []
    if title:
        parts.append(f"# {title}")
    meta = " | ".join(part for part in (account, publish_time) if part)
    if meta:
        parts.append(meta)
    if description:
        parts.append(f"## Summary\n\n{description}")
    parts.append(body)

    return Document(
        content=clean_markdown("\n\n".join(parts)),
        metadata=_metadata(data, source_url),
    )


def fetch_dajiala_article_with_diagnostics(
    article_url: str,
    api_key: str,
    verifycode: str = "",
    base_url: str = "https://www.dajiala.com",
) -> tuple[Document | None, dict[str, Any]]:
    api_key = (api_key or "").strip()
    verifycode = (verifycode or "").strip()
    endpoint = urljoin(base_url.rstrip("/") + "/", _DAJIALA_PATH.lstrip("/"))
    diag = _diagnostic(endpoint)
    if not api_key:
        diag["attempted"] = False
        diag["error"] = "missing_api_key"
        return None, diag

    safe, reason = is_ssrf_safe_url(endpoint)
    if not safe:
        logger.warning("Dajiala endpoint blocked by SSRF guard: %s", reason)
        diag["error"] = f"ssrf_guard:{reason}"
        return None, diag

    try:
        response = requests.post(
            endpoint,
            headers={"Content-Type": "application/json"},
            json={"url": article_url, "key": api_key, "verifycode": verifycode},
            timeout=_DAJIALA_TIMEOUT,
        )
    except Exception as exc:
        logger.warning("Dajiala article request failed: %s", exc)
        diag["error"] = f"request_failed:{exc}"
        return None, diag

    diag["http_status"] = response.status_code
    if response.status_code != 200:
        logger.warning("Dajiala article request returned HTTP %s", response.status_code)
        diag["error"] = "http_status_not_200"
        return None, diag

    try:
        payload = response.json()
    except Exception as exc:
        logger.warning("Dajiala article response is not JSON: %s", exc)
        diag["error"] = f"invalid_json:{exc}"
        return None, diag

    code = payload.get("code")
    diag["code"] = code
    diag["msg"] = str(payload.get("msg") or payload.get("msk") or payload.get("message") or "")
    if code not in (0, "0"):
        logger.warning("Dajiala article response not successful: code=%s msg=%s", code, diag["msg"])
        diag["error"] = "business_code_not_0"
        return None, diag

    data = payload.get("data")
    if not isinstance(data, dict):
        logger.warning("Dajiala article response missing data object")
        diag["error"] = "missing_data_object"
        return None, diag

    html = _string_value(data, "html")
    markdown = _html_to_markdown(html)
    visible_len = len(normalized_text(markdown))
    diag.update(
        {
            "title": _string_value(data, "title"),
            "html_length": len(html),
            "markdown_length": len(markdown),
            "visible_text_length": visible_len,
        }
    )

    doc = _build_document(data, article_url)
    if doc is None:
        logger.warning("Dajiala article response has no usable content")
        diag["error"] = "no_usable_content"
        return None, diag
    diag["usable"] = True
    return doc, diag


def fetch_dajiala_article(
    article_url: str,
    api_key: str,
    verifycode: str = "",
    base_url: str = "https://www.dajiala.com",
) -> Document | None:
    doc, _diag = fetch_dajiala_article_with_diagnostics(
        article_url,
        api_key=api_key,
        verifycode=verifycode,
        base_url=base_url,
    )
    return doc
