import os
import unittest
from unittest.mock import patch

from docreader.parser.web_parser import (
    _ScrapeResult,
    _build_browser_launch_kwargs,
    _normalize_browser_name,
    build_visible_text_fallback,
    extract_wechat_article_document,
    extract_markdown_from_html,
    install_ssrf_route_guard,
    is_wechat_blocked_content,
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

    def test_wechat_block_markers_match_real_chinese_verification_page(self):
        self.assertTrue(
            is_wechat_blocked_content(
                "环境异常 当前环境异常，完成验证后即可继续访问。去验证"
            )
        )

    def test_extract_wechat_article_document_from_js_content(self):
        html = """
        <html><body>
          <h1 id="activity-name">金饰克价，突然大涨！</h1>
          <span id="js_name">最江阴</span>
          <em id="publish_time">2026-07-22</em>
          <div id="js_content">
            <p>7月22日，国际金价直线拉升，截至北京时间12:32，伦敦金现价格日内涨幅明显。</p>
            <p>受国际金价大涨影响，国内品牌金饰零售价今日大幅跳涨，多个品牌报价同步上调。</p>
            <p>这段模拟正文用于确认微信文章根节点能被 requests 加微信 UA 的直连链路提取。</p>
          </div>
        </body></html>
        """

        doc = extract_wechat_article_document(html, "https://mp.weixin.qq.com/s/demo")

        self.assertIsNotNone(doc)
        self.assertIn("金饰克价，突然大涨！", doc.content)
        self.assertIn("国际金价直线拉升", doc.content)
        self.assertEqual(doc.metadata["source"], "wechat_official_account")
        self.assertEqual(doc.metadata["account"], "最江阴")

    @patch("docreader.parser.web_parser.fetch_one")
    def test_parse_wechat_uses_direct_ua_fetch_before_browser(self, fetch_one_mock):
        html = """
        <html><body>
          <h1 id="activity-name">微信直连成功</h1>
          <span id="js_name">测试公众号</span>
          <div id="js_content">
            <p>这是一段足够长的微信公众号正文，用来验证 parse_into_text 会优先使用直连微信 UA 抓取结果。</p>
            <p>当直连 HTML 中存在 js_content 时，不应该再启动后面的浏览器爬虫链路。</p>
            <p>继续补充正文长度，避免被短页面阈值误判为不可用内容。</p>
          </div>
        </body></html>
        """
        parser = StdWebParser(title="wechat")
        with patch.object(
            parser,
            "fetch_direct",
            return_value=_ScrapeResult(html=html, visible_text="", page_title=""),
        ):
            doc = parser.parse_into_text(b"https://mp.weixin.qq.com/s/demo")

        self.assertIn("微信直连成功", doc.content)
        self.assertEqual(doc.metadata["source"], "wechat_official_account")
        fetch_one_mock.assert_not_called()

    def test_redirect_target_blocked_before_navigation(self):
        safe, reason = is_ssrf_safe_url("http://127.0.0.1:39127/audit.txt")
        self.assertFalse(safe)
        self.assertTrue(reason)


if __name__ == "__main__":
    unittest.main()
