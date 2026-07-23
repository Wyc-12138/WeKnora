import unittest
from unittest.mock import Mock, patch

from docreader.utils.dajiala_provider import (
    fetch_dajiala_article,
    fetch_dajiala_article_with_diagnostics,
)


class TestDajialaProvider(unittest.TestCase):
    @patch("docreader.utils.dajiala_provider.requests.post")
    def test_fetch_dajiala_article_builds_document(self, post):
        response = Mock()
        response.status_code = 200
        response.json.return_value = {
            "code": 0,
            "msg": "OK",
            "data": {
                "html": (
                    "<html><body>"
                    "<h2>课程介绍</h2>"
                    "<p>这是足够长的公众号正文内容，用于验证大家乐 provider 可以把 HTML 正文转换为 Markdown 文档。</p>"
                    "<p>第二段继续补充文章主体信息，确保短小的错误页不会被误判为有效文章内容。</p>"
                    "<p>第三段包含更多自然语言文本，用于模拟真实微信公众号文章的主体正文。</p>"
                    "</body></html>"
                ),
                "title": "测试标题",
                "article_url": "https://mp.weixin.qq.com/s/example",
                "nickname": "测试公众号",
                "post_time_str": "2026-07-23 10:00",
                "author": "tester",
            },
        }
        post.return_value = response

        doc = fetch_dajiala_article(
            "https://mp.weixin.qq.com/s/example",
            api_key="jzl_test",
        )

        self.assertIsNotNone(doc)
        self.assertIn("# 测试标题", doc.content)
        self.assertIn("测试公众号 | 2026-07-23 10:00", doc.content)
        self.assertIn("公众号正文内容", doc.content)
        self.assertEqual(doc.metadata["source"], "dajiala")
        self.assertEqual(doc.metadata["account"], "测试公众号")
        self.assertEqual(post.call_args.kwargs["json"]["key"], "jzl_test")

    @patch("docreader.utils.dajiala_provider.requests.post")
    def test_fetch_dajiala_article_returns_none_on_unsuccessful_code(self, post):
        response = Mock()
        response.status_code = 200
        response.json.return_value = {"code": 101, "msg": "article deleted", "data": {}}
        post.return_value = response

        doc = fetch_dajiala_article("https://mp.weixin.qq.com/s/example", api_key="jzl_test")

        self.assertIsNone(doc)

    @patch("docreader.utils.dajiala_provider.requests.post")
    def test_diagnostics_report_short_or_empty_content(self, post):
        response = Mock()
        response.status_code = 200
        response.json.return_value = {
            "code": 0,
            "msg": "OK",
            "data": {
                "html": "",
                "title": "Short article shell",
            },
        }
        post.return_value = response

        doc, diag = fetch_dajiala_article_with_diagnostics(
            "https://mp.weixin.qq.com/s/example",
            api_key="jzl_test",
        )

        self.assertIsNone(doc)
        self.assertEqual(diag["http_status"], 200)
        self.assertEqual(diag["code"], 0)
        self.assertEqual(diag["title"], "Short article shell")
        self.assertEqual(diag["html_length"], 0)
        self.assertFalse(diag["usable"])
        self.assertEqual(diag["error"], "no_usable_content")

    def test_fetch_dajiala_article_without_key_returns_none(self):
        doc = fetch_dajiala_article("https://mp.weixin.qq.com/s/example", api_key="")
        self.assertIsNone(doc)


if __name__ == "__main__":
    unittest.main()
