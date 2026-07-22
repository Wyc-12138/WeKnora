from __future__ import annotations

import asyncio
import ipaddress
import re
import socket
import time
from collections import deque
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urldefrag, urljoin, urlparse, urlunparse
from urllib.robotparser import RobotFileParser

from docreader.utils.ssrf import is_ssrf_safe_url

DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)

BLOCK_MARKERS = (
    "环境异常",
    "当前环境异常",
    "完成验证",
    "去验证",
    "参数错误",
    "验证码",
    "人机验证",
    "访问过于频繁",
    "请在微信客户端打开",
    "请在客户端打开",
    "系统暂时限制",
    "网络环境存在异常",
    "轻点两下取消赞",
    "轻点两下取消在看",
    "security verification",
    "verify you are human",
    "captcha",
    "access denied",
    "too many requests",
)

SKIP_EXTENSIONS = {
    ".7z",
    ".avi",
    ".css",
    ".dmg",
    ".exe",
    ".gif",
    ".gz",
    ".ico",
    ".jpeg",
    ".jpg",
    ".js",
    ".m4a",
    ".mov",
    ".mp3",
    ".mp4",
    ".ogg",
    ".pdf",
    ".png",
    ".rar",
    ".svg",
    ".tar",
    ".wav",
    ".webm",
    ".webp",
    ".zip",
}


@dataclass
class PageResult:
    url: str
    depth: int
    status: str
    title: str = ""
    http_status: int | None = None
    markdown: str = ""
    markdown_length: int = 0
    visible_text_length: int = 0
    discovered_links: list[str] = field(default_factory=list)
    block_reason: str = ""
    method: str = "playwright"
    error: str = ""
    elapsed_ms: int = 0


@dataclass
class BrowserCrawlConfig:
    browser: str = "chromium"
    browser_channel: str = ""
    executable_path: str = ""
    headed: bool = False
    timeout_ms: int = 30_000
    delay_ms: int = 800
    max_depth: int = 0
    max_pages: int = 3
    allowed_domains: set[str] = field(default_factory=set)
    respect_robots: bool = False
    allow_private_net: bool = False
    proxy: str = ""


def normalize_url(raw_url: str) -> str:
    raw_url = raw_url.strip()
    url, _fragment = urldefrag(raw_url)
    parsed = urlparse(url)
    scheme = parsed.scheme.lower()
    netloc = parsed.netloc.lower()
    path = parsed.path or "/"
    if path != "/" and path.endswith("/"):
        path = path.rstrip("/")
    return urlunparse((scheme, netloc, path, "", parsed.query, ""))


def hostname(url: str) -> str:
    return (urlparse(url).hostname or "").lower()


def default_allowed_domains(seed_url: str, domains: set[str] | None = None) -> set[str]:
    allowed = {d.lower().lstrip(".") for d in (domains or set()) if d.strip()}
    if not allowed:
        seed_host = hostname(seed_url)
        if seed_host:
            allowed.add(seed_host)
    return allowed


def allowed_by_domain(url: str, allowed_domains: set[str]) -> bool:
    host = hostname(url)
    if not host:
        return False
    for domain in allowed_domains:
        domain = domain.lower().lstrip(".")
        if host == domain or host.endswith("." + domain):
            return True
    return False


def is_probably_html_url(url: str) -> bool:
    suffix = Path(urlparse(url).path.lower()).suffix
    return suffix not in SKIP_EXTENSIONS


def validate_fetch_target(url: str, allow_private_net: bool) -> tuple[bool, str]:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        return False, "only http/https URLs are supported"
    host = parsed.hostname
    if not host:
        return False, "missing hostname"
    if allow_private_net:
        return True, ""

    try:
        ip = ipaddress.ip_address(host)
        ips = [ip]
    except ValueError:
        try:
            infos = socket.getaddrinfo(host, parsed.port or (443 if parsed.scheme == "https" else 80))
        except socket.gaierror as exc:
            return False, f"DNS resolution failed: {exc}"
        ips = []
        for info in infos:
            try:
                ips.append(ipaddress.ip_address(info[4][0]))
            except ValueError:
                continue

    for ip in ips:
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_multicast
            or ip.is_reserved
            or ip.is_unspecified
        ):
            return False, f"blocked non-public address: {ip}"
    return True, ""


def normalized_text(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def detect_blocked_page(text: str, title: str) -> str:
    combined = normalized_text(f"{title}\n{text}").lower()
    for marker in BLOCK_MARKERS:
        if marker.lower() in combined:
            return marker
    return ""


def clean_markdown(text: str) -> str:
    text = text or ""
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def extract_markdown(html: str, visible_text: str, title: str) -> str:
    try:
        from trafilatura import extract

        extracted = extract(
            html,
            output_format="markdown",
            include_images=True,
            include_links=True,
            include_tables=True,
            with_metadata=True,
        )
        if extracted and len(normalized_text(extracted)) >= 80:
            return clean_markdown(extracted)
    except Exception:
        pass

    try:
        from bs4 import BeautifulSoup
        from markdownify import markdownify

        soup = BeautifulSoup(html or "", "html.parser")
        for node in soup.select("script, style, nav, footer, header, iframe, noscript, svg"):
            node.decompose()
        main = soup.select_one("article") or soup.select_one("main") or soup.select_one("[role=main]") or soup.body
        if main:
            converted = markdownify(str(main), heading_style="ATX", bullets="-")
            converted = clean_markdown(converted)
            if len(normalized_text(converted)) >= 80:
                return converted
    except Exception:
        pass

    text = clean_markdown(visible_text)
    if title and text and not text.startswith(title):
        return clean_markdown(f"# {title}\n\n{text}")
    return text


def extract_links(html: str, base_url: str, allowed_domains: set[str]) -> list[str]:
    try:
        from bs4 import BeautifulSoup
    except Exception:
        return []

    soup = BeautifulSoup(html or "", "html.parser")
    links: set[str] = set()
    for node in soup.find_all("a", href=True):
        href = str(node.get("href") or "").strip()
        if not href or href.startswith(("#", "mailto:", "tel:", "javascript:")):
            continue
        absolute = normalize_url(urljoin(base_url, href))
        if allowed_by_domain(absolute, allowed_domains) and is_probably_html_url(absolute):
            links.add(absolute)
    return sorted(links)


class RobotsCache:
    def __init__(self, user_agent: str):
        self.user_agent = user_agent
        self._cache: dict[str, RobotFileParser] = {}

    def can_fetch(self, url: str) -> tuple[bool, str]:
        parsed = urlparse(url)
        root = f"{parsed.scheme}://{parsed.netloc}"
        rp = self._cache.get(root)
        if rp is None:
            rp = RobotFileParser()
            rp.set_url(urljoin(root, "/robots.txt"))
            try:
                rp.read()
            except Exception as exc:
                return True, f"robots.txt unavailable: {exc}"
            self._cache[root] = rp
        allowed = rp.can_fetch(self.user_agent, url)
        return allowed, "" if allowed else "blocked by robots.txt"


async def install_ssrf_route_guard(page: Any) -> None:
    async def handle_route(route) -> None:
        safe, _reason = is_ssrf_safe_url(route.request.url)
        if not safe:
            await route.abort("blockedbyclient")
            return
        await route.continue_()

    await page.route("**/*", handle_route)


async def read_visible_text(page: Any) -> str:
    return await page.evaluate(
        """() => {
            const root = document.querySelector('article')
                || document.querySelector('main')
                || document.querySelector('[role="main"]')
                || document.querySelector('#app')
                || document.body;
            return (root?.innerText || '').trim();
        }"""
    )


async def fetch_page(context: Any, url: str, depth: int, timeout_ms: int, allowed_domains: set[str]) -> PageResult:
    started = time.perf_counter()
    page = await context.new_page()
    try:
        await install_ssrf_route_guard(page)
        response = await page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
        try:
            await page.wait_for_load_state("networkidle", timeout=10_000)
        except Exception:
            pass

        title = normalized_text(await page.title())
        html = await page.content()
        visible_text = await read_visible_text(page)
        links = extract_links(html, url, allowed_domains)
        block_reason = detect_blocked_page(visible_text, title)

        elapsed_ms = int((time.perf_counter() - started) * 1000)
        http_status = response.status if response else None
        if block_reason:
            return PageResult(
                url=url,
                depth=depth,
                status="blocked",
                title=title,
                http_status=http_status,
                visible_text_length=len(visible_text),
                discovered_links=links,
                block_reason=block_reason,
                elapsed_ms=elapsed_ms,
            )

        markdown = extract_markdown(html, visible_text, title)
        if not markdown:
            return PageResult(
                url=url,
                depth=depth,
                status="failed",
                title=title,
                http_status=http_status,
                visible_text_length=len(visible_text),
                discovered_links=links,
                error="no extractable content",
                elapsed_ms=elapsed_ms,
            )

        return PageResult(
            url=url,
            depth=depth,
            status="ok",
            title=title,
            http_status=http_status,
            markdown=markdown,
            markdown_length=len(markdown),
            visible_text_length=len(visible_text),
            discovered_links=links,
            elapsed_ms=elapsed_ms,
        )
    except Exception as exc:
        return PageResult(
            url=url,
            depth=depth,
            status="failed",
            error=str(exc),
            elapsed_ms=int((time.perf_counter() - started) * 1000),
        )
    finally:
        await page.close()


def browser_launch_kwargs(config: BrowserCrawlConfig) -> dict[str, Any]:
    kwargs: dict[str, Any] = {"headless": not config.headed}
    if config.proxy:
        kwargs["proxy"] = {"server": config.proxy}
    if config.browser_channel:
        if config.browser != "chromium":
            raise ValueError("browser_channel is only supported with chromium")
        kwargs["channel"] = config.browser_channel
    if config.executable_path:
        kwargs["executable_path"] = config.executable_path
    return kwargs


async def crawl(seed_url: str, config: BrowserCrawlConfig) -> dict[str, Any]:
    from playwright.async_api import async_playwright

    seed_url = normalize_url(seed_url)
    allowed_domains = default_allowed_domains(seed_url, config.allowed_domains)
    robots = RobotsCache(DEFAULT_USER_AGENT)

    queue: deque[tuple[str, int]] = deque([(seed_url, 0)])
    queued = {seed_url}
    visited: set[str] = set()
    pages: list[PageResult] = []

    async with async_playwright() as p:
        browser_type = getattr(p, config.browser)
        browser = await browser_type.launch(**browser_launch_kwargs(config))
        context = await browser.new_context(
            user_agent=DEFAULT_USER_AGENT,
            locale="zh-CN",
            timezone_id="Asia/Shanghai",
            viewport={"width": 1365, "height": 900},
            extra_http_headers={
                "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
                "Cache-Control": "no-cache",
                "Pragma": "no-cache",
            },
        )

        while queue and len(pages) < config.max_pages:
            current_url, depth = queue.popleft()
            if current_url in visited:
                continue
            visited.add(current_url)

            ok, reason = validate_fetch_target(current_url, config.allow_private_net)
            if not ok:
                pages.append(PageResult(url=current_url, depth=depth, status="failed", error=reason))
                continue

            if not allowed_by_domain(current_url, allowed_domains):
                pages.append(PageResult(url=current_url, depth=depth, status="failed", error="outside allowed domains"))
                continue

            if config.respect_robots:
                allowed, reason = robots.can_fetch(current_url)
                if not allowed:
                    pages.append(PageResult(url=current_url, depth=depth, status="blocked", block_reason=reason))
                    continue

            result = await fetch_page(context, current_url, depth, config.timeout_ms, allowed_domains)
            pages.append(result)

            if result.status == "ok" and depth < config.max_depth:
                for link in result.discovered_links:
                    if link not in queued and link not in visited:
                        queue.append((link, depth + 1))
                        queued.add(link)

            if queue and config.delay_ms > 0:
                await asyncio.sleep(config.delay_ms / 1000)

        await context.close()
        await browser.close()

    summary = {
        "ok": sum(1 for p in pages if p.status == "ok"),
        "blocked": sum(1 for p in pages if p.status == "blocked"),
        "failed": sum(1 for p in pages if p.status == "failed"),
        "visited": len(visited),
        "queued": len(queued),
    }
    return {
        "prototype": "crawler_probe",
        "started_at": datetime.now(timezone.utc).isoformat(),
        "seed_url": seed_url,
        "config": {
            "max_depth": config.max_depth,
            "max_pages": config.max_pages,
            "allowed_domains": sorted(allowed_domains),
            "delay_ms": config.delay_ms,
            "browser": config.browser,
            "browser_channel": config.browser_channel or None,
            "executable_path": config.executable_path or None,
            "respect_robots": config.respect_robots,
            "allow_private_net": config.allow_private_net,
        },
        "summary": summary,
        "pages": [asdict(page) for page in pages],
    }


async def fetch_one(url: str, config: BrowserCrawlConfig) -> PageResult:
    config.max_depth = 0
    config.max_pages = 1
    result = await crawl(url, config)
    pages = result.get("pages") or []
    if not pages:
        return PageResult(url=url, depth=0, status="failed", error="no result")
    return PageResult(**pages[0])
