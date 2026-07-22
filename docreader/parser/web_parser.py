import asyncio
import html as html_lib
import logging
import re
from dataclasses import dataclass
from typing import Optional
from urllib.parse import parse_qsl, urlencode, urljoin, urlparse, urlunparse

import requests
from bs4 import BeautifulSoup, Comment
from lxml.etree import XPath
from markdownify import markdownify
from playwright.async_api import Page, async_playwright
from trafilatura import extract, utils, xpaths

from docreader.config import CONFIG
from docreader.models.document import Document
from docreader.parser.base_parser import BaseParser
from docreader.parser.chain_parser import PipelineParser
from docreader.parser.markdown_parser import MarkdownParser
from docreader.utils import endecode
from docreader.utils.ssrf import is_ssrf_safe_url

logger = logging.getLogger(__name__)

_GOTO_TIMEOUT_MS = 30_000
_NETWORK_IDLE_TIMEOUT_MS = 10_000
_SPA_WAIT_TIMEOUT_MS = 15_000
# Minimum visible characters before treating an SPA shell as "rendered".
_SPA_MIN_TEXT_LEN = 80
# Minimum visible characters for Playwright text fallback when trafilatura fails.
_MIN_FALLBACK_TEXT_LEN = 50
_DIRECT_FETCH_TIMEOUT = (5, 20)
_DIRECT_FETCH_REDIRECT_LIMIT = 5
_DIRECT_FETCH_MAX_BYTES = 5 * 1024 * 1024
_WECHAT_MIN_ARTICLE_TEXT_LEN = 120
_WECHAT_HOST = "mp.weixin.qq.com"
_WECHAT_USER_AGENT = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 "
    "MicroMessenger/8.0.42 NetType/WIFI Language/zh_CN"
)
_SENSITIVE_QUERY_KEYS = {
    "access_token",
    "exportkey",
    "pass_ticket",
    "sessionid",
    "ticket",
    "token",
    "uin",
}
_WECHAT_BLOCK_MARKERS = (
    "当前环境异常",
    "环境异常",
    "完成验证",
    "去验证",
    "请在微信客户端打开",
    "访问过于频繁",
    "当前网络环境存在异常",
    "系统暂时限制",
)

# Monkey-patch trafilatura internals to better support WeChat Official Account
# articles, whose images live on `mmbiz.qpic.cn` without a standard file
# extension and whose main content sits inside `#js_content` /
# `.rich_media_content`. Trafilatura's `utils.IMAGE_EXTENSION` and
# `xpaths.BODY_XPATH` are internal APIs, so we guard the patch and skip
# silently if they are renamed/removed in a future release.
try:
    _WECHAT_IMAGE_EXTENSION = re.compile(
        r"[^\s]+\.(avif|bmp|gif|hei[cf]|jpe?g|png|webp)(\b|$)|"  # Standard extensions
        r"mmbiz\.qpic\.cn/[^\s]*wx_fmt=(jpeg|jpg|png|gif|webp)"  # WeChat query format
    )
    utils.IMAGE_EXTENSION = _WECHAT_IMAGE_EXTENSION

    _WECHAT_BODY_XPATH = XPath(
        '(.//*[@id="js_content" or contains(@class, "rich_media_content")])[1]'
    )
    _wechat_xpath_str = str(_WECHAT_BODY_XPATH)
    if not any(str(x) == _wechat_xpath_str for x in xpaths.BODY_XPATH):
        xpaths.BODY_XPATH.insert(0, _WECHAT_BODY_XPATH)
except (AttributeError, ImportError) as e:
    logger.warning(
        "Failed to patch trafilatura internals for WeChat support: %s", e
    )


@dataclass(frozen=True)
class _ScrapeResult:
    html: str
    visible_text: str
    page_title: str


def redact_url_for_log(url: str) -> str:
    """Redact volatile/sensitive query values before logging a crawled URL."""
    try:
        parsed = urlparse(url)
        query = []
        for key, value in parse_qsl(parsed.query, keep_blank_values=True):
            if key.lower() in _SENSITIVE_QUERY_KEYS:
                query.append((key, "***"))
            else:
                query.append((key, value))
        redacted = parsed._replace(query=urlencode(query, doseq=True))
        return urlunparse(redacted)
    except Exception:
        return "<unparseable-url>"


def is_wechat_article_url(url: str) -> bool:
    try:
        parsed = urlparse(url)
    except Exception:
        return False
    return parsed.scheme in {"http", "https"} and parsed.netloc.lower() == _WECHAT_HOST


def normalize_text(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def markdown_visible_len(markdown_text: str) -> int:
    text = re.sub(r"!\[[^\]]*\]\([^)]+\)", "", markdown_text or "")
    text = re.sub(r"\[[^\]]*\]\([^)]+\)", "", text)
    text = re.sub(r"[#>*_`|\\\-\[\]()]", "", text)
    return len(re.sub(r"\s+", "", text))


def is_wechat_blocked_content(text: str) -> bool:
    normalized = normalize_text(text)
    if not normalized:
        return False
    return any(marker in normalized for marker in _WECHAT_BLOCK_MARKERS)


def page_title_from_html(html: str) -> str:
    soup = BeautifulSoup(html or "", "html.parser")
    if soup.title and soup.title.string:
        return normalize_text(soup.title.string)
    return ""


def visible_text_from_html(html: str) -> str:
    soup = BeautifulSoup(html or "", "html.parser")
    return soup.get_text("\n", strip=True)


def has_wechat_article_root(html: str) -> bool:
    soup = BeautifulSoup(html or "", "html.parser")
    return bool(soup.select_one("#js_content") or soup.select_one(".rich_media_content"))


def extract_markdown_from_html(html: str) -> Optional[str]:
    """Run trafilatura on HTML; return markdown or None if nothing extracted."""
    if not html or not html.strip():
        return None
    md_text = extract(
        html,
        output_format="markdown",
        with_metadata=True,
        include_images=True,
        include_tables=True,
        include_links=True,
    )
    if not md_text or not md_text.strip():
        return None
    return md_text


def build_visible_text_fallback(visible_text: str, page_title: str = "") -> Optional[str]:
    """Build markdown from Playwright-visible text when trafilatura finds no article body."""
    text = (visible_text or "").strip()
    if len(text) < _MIN_FALLBACK_TEXT_LEN:
        return None
    title = (page_title or "").strip()
    if title and not text.startswith(title):
        return f"# {title}\n\n{text}"
    return text


def _selector_text(soup: BeautifulSoup, selector: str) -> str:
    node = soup.select_one(selector)
    return normalize_text(node.get_text(" ", strip=True)) if node else ""


def _meta_content(soup: BeautifulSoup, *names: str) -> str:
    for name in names:
        node = soup.find("meta", attrs={"property": name}) or soup.find(
            "meta", attrs={"name": name}
        )
        if node and node.get("content"):
            return normalize_text(str(node["content"]))
    return ""


def _clean_markdown(markdown_text: str) -> str:
    text = html_lib.unescape(markdown_text or "")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _normalize_image_url(src: str, base_url: str) -> str:
    if not src:
        return ""
    if src.startswith("//"):
        return "https:" + src
    return urljoin(base_url, src)


def extract_wechat_article_document(
    html: str,
    url: str,
    fallback_title: str = "",
) -> Optional[Document]:
    """Extract a WeChat Official Account article into markdown."""
    soup = BeautifulSoup(html or "", "html.parser")
    article = soup.select_one("#js_content") or soup.select_one(".rich_media_content")
    if not article:
        return None

    title = (
        _selector_text(soup, "#activity-name")
        or _meta_content(soup, "og:title", "twitter:title")
        or normalize_text(fallback_title)
    )
    account = _selector_text(soup, "#js_name")
    author = _selector_text(soup, "#js_author_name") or _selector_text(soup, "#js_author")
    publish_time = _selector_text(soup, "#publish_time")

    for node in article.find_all(string=lambda text: isinstance(text, Comment)):
        node.extract()
    for node in article.find_all(["script", "style", "iframe", "svg"]):
        node.decompose()
    for selector in (
        ".rich_media_tool",
        ".qr_code_pc",
        ".reward_area",
        ".js_profile_qrcode",
        ".share_notice",
    ):
        for node in article.select(selector):
            node.decompose()

    for img in article.find_all("img"):
        src = (
            img.get("data-src")
            or img.get("data-original")
            or img.get("data-backsrc")
            or img.get("src")
            or ""
        )
        src = _normalize_image_url(src, url)
        if src:
            img["src"] = src
        img["alt"] = normalize_text(img.get("alt") or img.get("data-w") or "")

    body_md = markdownify(
        str(article),
        heading_style="ATX",
        bullets="-",
        strip=["span"],
    )
    body_md = _clean_markdown(body_md)
    if not body_md:
        return None

    parts = []
    if title:
        parts.append(f"# {title}")
    meta_line = " · ".join(
        part for part in (account, author, publish_time) if part
    )
    if meta_line:
        parts.append(meta_line)
    parts.append(body_md)
    content = _clean_markdown("\n\n".join(parts))

    if markdown_visible_len(content) < _WECHAT_MIN_ARTICLE_TEXT_LEN:
        logger.warning(
            "WeChat article extraction produced too little text: %d chars",
            markdown_visible_len(content),
        )
        return None
    if is_wechat_blocked_content(content):
        logger.warning("WeChat article extraction matched block-page markers")
        return None

    metadata = {
        "source": "wechat_official_account",
        "source_url": url,
    }
    if title:
        metadata["title"] = title
    if account:
        metadata["account"] = account
    if author:
        metadata["author"] = author
    if publish_time:
        metadata["publish_time"] = publish_time

    return Document(content=content, metadata=metadata)


async def wait_for_rendered_content(page: Page) -> None:
    """Wait for SPA/JS pages beyond the initial HTML shell."""
    try:
        await page.wait_for_load_state("networkidle", timeout=_NETWORK_IDLE_TIMEOUT_MS)
        logger.info("Network idle after navigation")
    except Exception:
        logger.info("Network idle wait timed out, continuing")

    try:
        await page.wait_for_function(
            """(minLen) => {
                const root = document.querySelector('#app')
                    || document.querySelector('main')
                    || document.body;
                return ((root?.innerText || '').trim().length >= minLen);
            }""",
            arg=_SPA_MIN_TEXT_LEN,
            timeout=_SPA_WAIT_TIMEOUT_MS,
        )
        logger.info("SPA/root visible text reached minimum length")
    except Exception:
        logger.info("SPA text wait timed out, using current DOM")


async def read_visible_text(page: Page) -> str:
    """Prefer #app/main innerText, then fall back to body."""
    return await page.evaluate(
        """() => {
            const root = document.querySelector('#app')
                || document.querySelector('main')
                || document.querySelector('[role="main"]')
                || document.body;
            return (root?.innerText || '').trim();
        }"""
    )


async def install_ssrf_route_guard(page: Page) -> None:
    """Block navigation/subresource requests to SSRF-restricted targets (incl. redirects)."""

    async def handle_route(route) -> None:
        safe, reason = is_ssrf_safe_url(route.request.url)
        if not safe:
            logger.warning(
                "SSRF guard blocked request to %s: %s", route.request.url, reason
            )
            await route.abort("blockedbyclient")
            return
        await route.continue_()

    await page.route("**/*", handle_route)


class StdWebParser(BaseParser):
    """Standard web page parser using Playwright and Trafilatura.

    This parser scrapes web pages using Playwright's WebKit browser and extracts
    clean content using Trafilatura library. It supports proxy configuration and
    converts HTML content to markdown format.
    """

    def __init__(self, title: str, **kwargs):
        """Initialize the web parser.

        Args:
            title: Title of the web page to be used as file name
            **kwargs: Additional arguments passed to BaseParser
        """
        self.title = title
        # Get proxy configuration from config if available
        self.proxy = CONFIG.external_https_proxy
        super().__init__(file_name=title, **kwargs)
        logger.info(f"Initialized WebParser with title: {title}")

    async def scrape(self, url: str) -> _ScrapeResult:
        """Scrape web page content using Playwright.

        Args:
            url: The URL of the web page to scrape

        Returns:
            HTML, visible text, and document title; empty fields on hard failure
        """
        logger.info("Starting web page scraping for URL: %s", redact_url_for_log(url))
        empty = _ScrapeResult(html="", visible_text="", page_title="")
        safe, reason = is_ssrf_safe_url(url)
        if not safe:
            logger.error("URL blocked by SSRF guard before navigation: %s", reason)
            return empty
        try:
            async with async_playwright() as p:
                kwargs = {}
                # Configure proxy if available
                if self.proxy:
                    kwargs["proxy"] = {"server": self.proxy}
                logger.info("Launching WebKit browser")
                browser = await p.webkit.launch(**kwargs)
                page = await browser.new_page()
                await install_ssrf_route_guard(page)

                logger.info("Navigating to URL: %s", redact_url_for_log(url))
                try:
                    await page.goto(
                        url,
                        timeout=_GOTO_TIMEOUT_MS,
                        wait_until="domcontentloaded",
                    )
                    logger.info("Initial page load complete")
                except Exception as e:
                    logger.error(f"Error navigating to URL: {str(e)}")
                    await browser.close()
                    return empty

                await wait_for_rendered_content(page)

                page_title = await page.title()
                visible_text = await read_visible_text(page)
                content = await page.content()
                logger.info(
                    "Retrieved %d bytes HTML, %d chars visible text, title=%r",
                    len(content),
                    len(visible_text),
                    page_title[:80] if page_title else "",
                )

                await browser.close()
                logger.info("Browser closed")

            logger.info("Successfully retrieved HTML content")
            return _ScrapeResult(
                html=content,
                visible_text=visible_text,
                page_title=page_title or "",
            )

        except Exception as e:
            logger.error(f"Failed to scrape web page: {str(e)}")
            return empty

    def fetch_direct(self, url: str) -> _ScrapeResult:
        """Fetch HTML with a normal HTTP client, guarding redirects for SSRF."""
        logger.info("Direct-fetching web page: %s", redact_url_for_log(url))
        empty = _ScrapeResult(html="", visible_text="", page_title="")
        current_url = url
        safe, reason = is_ssrf_safe_url(current_url)
        if not safe:
            logger.error("URL blocked by SSRF guard before direct fetch: %s", reason)
            return empty

        proxies = {}
        if CONFIG.external_http_proxy:
            proxies["http"] = CONFIG.external_http_proxy
        if CONFIG.external_https_proxy:
            proxies["https"] = CONFIG.external_https_proxy

        headers = {
            "User-Agent": _WECHAT_USER_AGENT if is_wechat_article_url(url) else (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36"
            ),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.6",
        }

        try:
            for _ in range(_DIRECT_FETCH_REDIRECT_LIMIT + 1):
                response = requests.get(
                    current_url,
                    headers=headers,
                    timeout=_DIRECT_FETCH_TIMEOUT,
                    allow_redirects=False,
                    stream=True,
                    proxies=proxies or None,
                )
                if response.is_redirect or response.is_permanent_redirect:
                    location = response.headers.get("Location", "")
                    response.close()
                    if not location:
                        return empty
                    next_url = urljoin(current_url, location)
                    safe, reason = is_ssrf_safe_url(next_url)
                    if not safe:
                        logger.error("Redirect blocked by SSRF guard: %s", reason)
                        return empty
                    current_url = next_url
                    continue

                if response.status_code >= 400:
                    logger.warning(
                        "Direct fetch returned HTTP %s for %s",
                        response.status_code,
                        redact_url_for_log(current_url),
                    )
                    response.close()
                    return empty

                chunks = []
                total = 0
                for chunk in response.iter_content(chunk_size=65536):
                    if not chunk:
                        continue
                    total += len(chunk)
                    if total > _DIRECT_FETCH_MAX_BYTES:
                        logger.warning("Direct fetch exceeded max HTML size")
                        response.close()
                        return empty
                    chunks.append(chunk)
                encoding = response.encoding or response.apparent_encoding or "utf-8"
                response.close()
                html = b"".join(chunks).decode(encoding, errors="replace")
                visible_text = visible_text_from_html(html)
                return _ScrapeResult(
                    html=html,
                    visible_text=visible_text,
                    page_title=page_title_from_html(html),
                )

            logger.warning("Direct fetch exceeded redirect limit")
            return empty
        except Exception as e:
            logger.warning("Direct fetch failed: %s", e)
            return empty

    def parse_into_text(self, content: bytes) -> Document:
        """Parse web page content into a Document object.

        Args:
            content: URL encoded as bytes

        Returns:
            Document object containing the parsed markdown content
        """
        url = endecode.decode_bytes(content)
        redacted_url = redact_url_for_log(url)
        is_wechat_url = is_wechat_article_url(url)

        logger.info("Scraping web page: %s", redacted_url)
        scrape_result = self.fetch_direct(url) if is_wechat_url else _ScrapeResult("", "", "")
        if (
            is_wechat_url
            and scrape_result.html
            and not is_wechat_blocked_content(
                "\n".join((scrape_result.visible_text, scrape_result.page_title))
            )
            and not has_wechat_article_root(scrape_result.html)
        ):
            logger.info(
                "WeChat direct fetch did not include an article root; trying browser render"
            )
            scrape_result = asyncio.run(self.scrape(url))
        if not scrape_result.html and not scrape_result.visible_text:
            scrape_result = asyncio.run(self.scrape(url))
        if not scrape_result.html and not scrape_result.visible_text:
            logger.error("Failed to scrape web page (no HTML or visible text)")
            return Document()

        if is_wechat_url:
            combined_text = "\n".join(
                part for part in (scrape_result.visible_text, scrape_result.page_title) if part
            )
            if is_wechat_blocked_content(combined_text):
                logger.error(
                    "WeChat article page was blocked or requires verification: %s",
                    redacted_url,
                )
                return Document()

            wechat_doc = extract_wechat_article_document(
                scrape_result.html,
                url,
                self.title or scrape_result.page_title,
            )
            if wechat_doc:
                logger.info(
                    "Extracted WeChat article: content_len=%d, title=%r",
                    len(wechat_doc.content),
                    wechat_doc.metadata.get("title", ""),
                )
                return wechat_doc
            logger.warning(
                "WeChat-specific extraction failed, trying generic extraction"
            )

        md_text = extract_markdown_from_html(scrape_result.html)
        if not md_text:
            md_text = build_visible_text_fallback(
                scrape_result.visible_text,
                scrape_result.page_title,
            )
            if md_text:
                logger.info(
                    "Trafilatura empty; using Playwright visible-text fallback (%d chars)",
                    len(md_text),
                )

        if not md_text:
            logger.error("Failed to parse web page")
            return Document()

        if is_wechat_url:
            if is_wechat_blocked_content(md_text):
                logger.error("Generic extraction matched WeChat block-page markers")
                return Document()
            if markdown_visible_len(md_text) < _WECHAT_MIN_ARTICLE_TEXT_LEN:
                logger.error(
                    "Generic extraction produced too little WeChat article text: %d chars",
                    markdown_visible_len(md_text),
                )
                return Document()

        metadata = {}
        title_match = re.search(r"^title:\s*(.+)", md_text, re.MULTILINE)
        if title_match:
            extracted_title = title_match.group(1).strip()
            if extracted_title:
                metadata["title"] = extracted_title
                logger.info(
                    f"Extracted article title from trafilatura: {extracted_title}"
                )
        elif scrape_result.page_title:
            metadata["title"] = scrape_result.page_title.strip()
            logger.info(
                "Using page title from Playwright: %s", metadata["title"]
            )
        else:
            logger.info(
                "No title found in trafilatura output, first 200 chars: %r",
                md_text[:200],
            )
        return Document(content=md_text, metadata=metadata)


class WebParser(PipelineParser):
    """Web parser using pipeline pattern.

    This parser chains StdWebParser (for web scraping and HTML to markdown conversion)
    with MarkdownParser (for markdown processing). The pipeline processes content
    sequentially through both parsers.
    """

    # Parser classes to be executed in sequence
    _parser_cls = (StdWebParser, MarkdownParser)


if __name__ == "__main__":
    import sys

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

    url = sys.argv[1] if len(sys.argv) > 1 else "https://cloud.tencent.com/document/product/457/6759"
    print(f"\n{'='*60}")
    print(f"URL: {url}")
    print(f"{'='*60}\n")

    parser = WebParser(title="")
    doc = parser.parse_into_text(url.encode())

    print(f"--- metadata ---")
    for k, v in doc.metadata.items():
        print(f"  {k}: {v}")

    print(f"\n--- images ({len(doc.images)}) ---")
    for path in list(doc.images.keys())[:10]:
        print(f"  {path}  ({len(doc.images[path])} chars base64)")

    print(f"\n--- content ({len(doc.content)} chars) ---")
    print(doc.content[:300000])
    if len(doc.content) > 300000:
        print(f"\n... (truncated, total {len(doc.content)} chars)")

    print(f"\n--- chunks ({len(doc.chunks)}) ---")
    for i, chunk in enumerate(doc.chunks[:5]):
        print(f"  [{i}] seq={chunk.seq} range=[{chunk.start}:{chunk.end}] len={len(chunk.content)}")
        print(f"      {chunk.content[:120]}{'...' if len(chunk.content) > 120 else ''}")
    if len(doc.chunks) > 5:
        print(f"  ... ({len(doc.chunks) - 5} more chunks)")
