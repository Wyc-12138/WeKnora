import unittest
from unittest.mock import Mock, patch

from docreader.utils.redfox_provider import fetch_redfox_article


class TestRedFoxProvider(unittest.TestCase):
    @patch("docreader.utils.redfox_provider.requests.post")
    def test_fetch_redfox_article_builds_document(self, post):
        response = Mock()
        response.status_code = 200
        response.json.return_value = {
            "code": 2000,
            "msg": "ok",
            "data": {
                "content": (
                    "<p>这是足够长的公众号正文内容，用于验证 RedFox provider 可以把 HTML 正文转换为 Markdown 文档。</p>"
                    "<p>第二段继续补充文章主体信息，确保短小的错误页不会被误判为有效文章内容。</p>"
                    "<p>第三段包含更多自然语言文本，用于模拟真实微信公众号文章的主体正文。</p>"
                ),
                "title": "测试标题",
                "summary": "测试摘要",
                "workUuid": "uuid-1",
                "workUrl": "https://mp.weixin.qq.com/s/example",
                "publishTime": "2026-01-15 10:00:00",
                "author": "科研云",
                "readCount": 50000,
            },
        }
        post.return_value = response

        doc = fetch_redfox_article(
            "https://mp.weixin.qq.com/s/example",
            api_key="ak_test",
        )

        self.assertIsNotNone(doc)
        self.assertIn("# 测试标题", doc.content)
        self.assertIn("测试摘要", doc.content)
        self.assertIn("公众号正文内容", doc.content)
        self.assertEqual(doc.metadata["source"], "redfox")
        self.assertEqual(doc.metadata["work_uuid"], "uuid-1")
        self.assertEqual(doc.metadata["read_count"], "50000")
        self.assertEqual(post.call_args.kwargs["headers"]["REDFOX_API_KEY"], "ak_test")

    @patch("docreader.utils.redfox_provider.requests.post")
    def test_fetch_redfox_article_returns_none_on_unsuccessful_code(self, post):
        response = Mock()
        response.status_code = 200
        response.json.return_value = {"code": 4000, "msg": "not found", "data": {}}
        post.return_value = response

        doc = fetch_redfox_article("https://mp.weixin.qq.com/s/example", api_key="ak_test")

        self.assertIsNone(doc)

    def test_fetch_redfox_article_without_key_returns_none(self):
        doc = fetch_redfox_article("https://mp.weixin.qq.com/s/example", api_key="")
        self.assertIsNone(doc)


if __name__ == "__main__":
    unittest.main()
