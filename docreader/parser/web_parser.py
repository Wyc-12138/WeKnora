import asyncio
import logging
import re
from dataclasses import dataclass
from typing import Optional
from urllib.parse import parse_qsl, urlencode, urljoin, urlparse, urlunparse

import requests
from bs4 import BeautifulSoup
from playwright.async_api import Page, async_playwright
from trafilatura import extract

from docreader.config import CONFIG
from docreader.models.document import Document
from docreader.parser.base_parser import BaseParser
from docreader.parser.chain_parser import PipelineParser
from docreader.parser.markdown_parser import MarkdownParser
from docreader.utils import endecode
from docreader.utils.browser_crawler import BrowserCrawlConfig, fetch_one
from docreader.utils.dajiala_provider import fetch_dajiala_article_with_diagnostics
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
_WECHAT_HOST = "mp.weixin.qq.com"
_BROWSER_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
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


def page_title_from_html(html: str) -> str:
    soup = BeautifulSoup(html or "", "html.parser")
    if soup.title and soup.title.string:
        return normalize_text(soup.title.string)
    return ""


def visible_text_from_html(html: str) -> str:
    soup = BeautifulSoup(html or "", "html.parser")
    return soup.get_text("\n", strip=True)


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


def _normalize_browser_name(name: str) -> str:
    name = (name or "chromium").strip().lower()
    if name not in {"chromium", "webkit", "firefox"}:
        logger.warning("Unsupported DOCREADER_WEB_BROWSER=%r, using chromium", name)
        return "chromium"
    return name


def _build_browser_launch_kwargs(proxy: str) -> dict:
    kwargs = {}
    if proxy:
        kwargs["proxy"] = {"server": proxy}
    if CONFIG.web_browser_channel:
        if _normalize_browser_name(CONFIG.web_browser) == "chromium":
            kwargs["channel"] = CONFIG.web_browser_channel
        else:
            logger.warning("Ignoring DOCREADER_WEB_BROWSER_CHANNEL for non-chromium browser")
    if CONFIG.web_browser_executable_path:
        kwargs["executable_path"] = CONFIG.web_browser_executable_path
    return kwargs


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
                browser_name = _normalize_browser_name(CONFIG.web_browser)
                kwargs = _build_browser_launch_kwargs(self.proxy)
                logger.info("Launching %s browser", browser_name)
                browser = await getattr(p, browser_name).launch(**kwargs)
                context = await browser.new_context(
                    user_agent=_BROWSER_USER_AGENT,
                    locale="zh-CN",
                    timezone_id="Asia/Shanghai",
                    viewport={"width": 1365, "height": 900},
                    extra_http_headers={
                        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
                        "Cache-Control": "no-cache",
                        "Pragma": "no-cache",
                    },
                )
                page = await context.new_page()
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
                    await context.close()
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

                await context.close()
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
            "User-Agent": (
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
                encoding = response.encoding or ""
                if not encoding or encoding.lower() in {"iso-8859-1", "latin-1"}:
                    encoding = response.apparent_encoding or "utf-8"
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

        logger.info("Scraping web page: %s", redacted_url)
        if is_wechat_article_url(url):
            doc, diag = fetch_dajiala_article_with_diagnostics(
                url,
                api_key=CONFIG.dajiala_api_key,
                verifycode=CONFIG.dajiala_verifycode,
                base_url=CONFIG.dajiala_base_url,
            )
            logger.info(
                "Dajiala WeChat article diagnostics: attempted=%s http_status=%s code=%s usable=%s title=%r html_len=%d markdown_len=%d error=%s",
                diag.get("attempted"),
                diag.get("http_status"),
                diag.get("code"),
                diag.get("usable"),
                str(diag.get("title") or "")[:80],
                diag.get("html_length"),
                diag.get("markdown_length"),
                diag.get("error"),
            )
            if doc is not None:
                return doc
            logger.error("Dajiala did not return usable WeChat article content; url=%s", redacted_url)
            return Document()

        result = asyncio.run(
            fetch_one(
                url,
                BrowserCrawlConfig(
                    browser=_normalize_browser_name(CONFIG.web_browser),
                    browser_channel=CONFIG.web_browser_channel,
                    executable_path=CONFIG.web_browser_executable_path,
                    timeout_ms=_GOTO_TIMEOUT_MS,
                    max_depth=0,
                    max_pages=1,
                    proxy=self.proxy,
                ),
            )
        )

        if result.status != "ok":
            logger.error(
                "Failed to parse web page with shared browser crawler: status=%s reason=%s error=%s url=%s",
                result.status,
                result.block_reason,
                result.error,
                redacted_url,
            )
            return Document()

        metadata = {}
        if result.title:
            metadata["title"] = result.title
        return Document(content=result.markdown, metadata=metadata)


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
