import os
import unittest
from unittest.mock import patch

from docreader.models.document import Document
from docreader.parser.web_parser import (
    _build_browser_launch_kwargs,
    _normalize_browser_name,
    build_visible_text_fallback,
    extract_markdown_from_html,
    install_ssrf_route_guard,
    StdWebParser,
)
from docreader.utils.ssrf import is_ssrf_safe_url, reset_ssrf_whitelist_cache_for_test


class TestWebParserHelpers(unittest.TestCase):
    def setUp(self) -> None:
        self._env_patch = patch.dict(
            os.environ,
            {"SSRF_WHITELIST": "", "SSRF_WHITELIST_EXTRA": ""},
            clear=False,
        )
        self._env_patch.start()
        reset_ssrf_whitelist_cache_for_test()

    def tearDown(self) -> None:
        self._env_patch.stop()
        reset_ssrf_whitelist_cache_for_test()

    def test_extract_markdown_empty_html(self):
        self.assertIsNone(extract_markdown_from_html(""))
        self.assertIsNone(extract_markdown_from_html("   "))

    def test_extract_markdown_article_html(self):
        html = """
        <html><head><title>Demo</title></head><body>
        <article><h1>Hello</h1><p>World paragraph with enough text for extraction.</p></article>
        </body></html>
        """
        md = extract_markdown_from_html(html)
        self.assertIsNotNone(md)
        self.assertIn("Hello", md)

    def test_build_fallback_too_short(self):
        self.assertIsNone(build_visible_text_fallback("short"))
        self.assertIsNone(build_visible_text_fallback(""))

    def test_build_fallback_with_title(self):
        text = "A" * 60
        md = build_visible_text_fallback(text, page_title="WeKnora")
        self.assertIsNotNone(md)
        self.assertTrue(md.startswith("# WeKnora"))
        self.assertIn(text, md)

    def test_build_fallback_without_title(self):
        text = "B" * 60
        md = build_visible_text_fallback(text, page_title="")
        self.assertEqual(md, text)

    def test_install_ssrf_route_guard_is_importable(self):
        self.assertTrue(callable(install_ssrf_route_guard))

    def test_browser_name_defaults_to_chromium_for_invalid_value(self):
        self.assertEqual(_normalize_browser_name(""), "chromium")
        self.assertEqual(_normalize_browser_name("bad-browser"), "chromium")
        self.assertEqual(_normalize_browser_name("webkit"), "webkit")

    def test_browser_launch_kwargs_include_proxy_and_executable(self):
        with patch("docreader.parser.web_parser.CONFIG") as cfg:
            cfg.web_browser = "chromium"
            cfg.web_browser_channel = "chrome"
            cfg.web_browser_executable_path = "/path/to/chrome"
            kwargs = _build_browser_launch_kwargs("http://proxy.example:8080")

        self.assertEqual(kwargs["proxy"], {"server": "http://proxy.example:8080"})
        self.assertEqual(kwargs["channel"], "chrome")
        self.assertEqual(kwargs["executable_path"], "/path/to/chrome")

    @patch("docreader.parser.web_parser.fetch_one")
    @patch("docreader.parser.web_parser.fetch_dajiala_article_with_diagnostics")
    def test_parse_wechat_uses_dajiala_before_browser(self, dajiala_mock, fetch_one_mock):
        parser = StdWebParser(title="wechat")
        dajiala_mock.return_value = (
            Document(content="# Dajiala Article\n\nbody text", metadata={"source": "dajiala"}),
            {"attempted": True, "http_status": 200, "code": 0, "usable": True},
        )

        doc = parser.parse_into_text(b"https://mp.weixin.qq.com/s/demo")

        self.assertIn("Dajiala Article", doc.content)
        self.assertEqual(doc.metadata["source"], "dajiala")
        dajiala_mock.assert_called_once()
        fetch_one_mock.assert_not_called()

    @patch("docreader.parser.web_parser.fetch_one")
    @patch("docreader.parser.web_parser.fetch_dajiala_article_with_diagnostics")
    def test_parse_wechat_returns_empty_when_dajiala_fails(self, dajiala_mock, fetch_one_mock):
        parser = StdWebParser(title="wechat")
        dajiala_mock.return_value = (
            None,
            {
                "attempted": True,
                "http_status": 200,
                "code": 101,
                "usable": False,
                "error": "business_code_not_0",
            },
        )

        doc = parser.parse_into_text(b"https://mp.weixin.qq.com/s/demo")

        self.assertEqual(doc.content, "")
        self.assertEqual(doc.metadata, {})
        dajiala_mock.assert_called_once()
        fetch_one_mock.assert_not_called()

    def test_redirect_target_blocked_before_navigation(self):
        safe, reason = is_ssrf_safe_url("http://127.0.0.1:39127/audit.txt")
        self.assertFalse(safe)
        self.assertTrue(reason)


if __name__ == "__main__":
    unittest.main()
