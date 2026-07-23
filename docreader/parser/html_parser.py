import logging

from docreader.models.document import Document
from docreader.parser.base_parser import BaseParser
from docreader.parser.web_parser import (
    build_visible_text_fallback,
    extract_markdown_from_html,
    page_title_from_html,
    redact_url_for_log,
    visible_text_from_html,
)

logger = logging.getLogger(__name__)


class HTMLParser(BaseParser):
    """Parse browser-captured HTML without fetching the source URL."""

    def __init__(self, base_url: str = "", title: str = "", **kwargs):
        super().__init__(**kwargs)
        self.base_url = base_url
        self.title = title

    def parse_into_text(self, content: bytes) -> Document:
        html = content.decode("utf-8", errors="replace")
        logger.info(
            "Parsing HTML snapshot file: base_url=%s, title=%s, size=%d chars",
            redact_url_for_log(self.base_url),
            self.title,
            len(html),
        )

        markdown = extract_markdown_from_html(html)
        page_title = page_title_from_html(html) or self.title
        if not markdown:
            markdown = build_visible_text_fallback(
                visible_text_from_html(html),
                page_title,
            )
        if not markdown:
            return Document(metadata={"html_snapshot": "true"})

        metadata = {"html_snapshot": "true"}
        if self.base_url:
            metadata["source_url"] = self.base_url
        if page_title:
            metadata["title"] = page_title
        return Document(content=markdown, metadata=metadata)
