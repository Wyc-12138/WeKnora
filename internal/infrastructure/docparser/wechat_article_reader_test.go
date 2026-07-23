package docparser

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/PuerkitoBio/goquery"
)

func TestIsWeChatArticleURL(t *testing.T) {
	tests := []struct {
		name string
		url  string
		want bool
	}{
		{name: "article", url: "https://mp.weixin.qq.com/s/WhBrGpVT_cdejGS3PCyKUg", want: true},
		{name: "non article path", url: "https://mp.weixin.qq.com/mp/profile_ext?action=home", want: false},
		{name: "other host", url: "https://example.com/s/WhBrGpVT_cdejGS3PCyKUg", want: false},
		{name: "unsupported scheme", url: "ftp://mp.weixin.qq.com/s/WhBrGpVT_cdejGS3PCyKUg", want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := IsWeChatArticleURL(tt.url); got != tt.want {
				t.Fatalf("IsWeChatArticleURL(%q) = %v, want %v", tt.url, got, tt.want)
			}
		})
	}
}

func TestFormatWeChatPublishTime(t *testing.T) {
	got := formatWeChatPublishTime("1784708086")
	want := "2026-07-22 16:14:46 +08:00"
	if got != want {
		t.Fatalf("formatWeChatPublishTime() = %q, want %q", got, want)
	}
}

func TestBuildWeChatMarkdown(t *testing.T) {
	doc, err := goquery.NewDocumentFromReader(strings.NewReader(`
<div id="js_content">
  <p><strong>短标题</strong></p>
  <p>正文 <span>内容</span></p>
  <img data-local="images/image_001.png" data-type="png"/>
  <p>正文 <span>内容</span></p>
</div>`))
	if err != nil {
		t.Fatal(err)
	}

	md := buildWeChatMarkdown(
		doc.Find("#js_content"),
		"https://mp.weixin.qq.com/s/example",
		"标题",
		"公众号",
		"2026-07-22 16:14:46 +08:00",
		"摘要",
		[]string{"images/background_001.png"},
	)

	for _, needle := range []string{
		"# 标题",
		"- Account: 公众号",
		"- Published: 2026-07-22 16:14:46 +08:00",
		"- Summary: 摘要",
		"- Source: https://mp.weixin.qq.com/s/example",
		"## 短标题",
		"正文内容",
		"![png](images/image_001.png)",
		"## Saved Background Images",
		"![background](images/background_001.png)",
	} {
		if !strings.Contains(md, needle) {
			t.Fatalf("markdown missing %q:\n%s", needle, md)
		}
	}
	if got := strings.Count(md, "正文内容"); got != 1 {
		t.Fatalf("duplicate adjacent paragraph was not collapsed, count=%d markdown=%s", got, md)
	}
}

func TestExtractWeChatArticleViaPythonProvider(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != PathRead {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		var req map[string]any
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if req["url"] != "https://mp.weixin.qq.com/s/example" {
			t.Fatalf("unexpected url: %#v", req["url"])
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"markdown_content": "# Python Article\n\nbody text",
			"image_refs": []map[string]any{
				{
					"filename":     "image_001.png",
					"original_ref": "images/image_001.png",
					"mime_type":    "image/png",
					"image_data":   "aW1hZ2U=",
				},
			},
			"metadata": map[string]string{
				"title":               "Python Article",
				"inline_images":       "1",
				"background_images":   "0",
				"total_unique_images": "1",
			},
		})
	}))
	defer server.Close()

	t.Setenv(envWeChatPythonAddr, server.URL)
	t.Setenv(envWeChatPythonFallback, "false")

	article, err := ExtractWeChatArticle(t.Context(), "https://mp.weixin.qq.com/s/example")
	if err != nil {
		t.Fatalf("ExtractWeChatArticle returned error: %v", err)
	}
	if !strings.Contains(article.ReadResult.MarkdownContent, "Python Article") {
		t.Fatalf("unexpected markdown: %s", article.ReadResult.MarkdownContent)
	}
	if got := len(article.ReadResult.ImageRefs); got != 1 {
		t.Fatalf("image refs = %d, want 1", got)
	}
	if got := string(article.ReadResult.ImageRefs[0].ImageData); got != "image" {
		t.Fatalf("decoded image data = %q, want image", got)
	}
	if article.InlineImageCount != 1 || article.TotalUniqueImageCount != 1 {
		t.Fatalf("unexpected image counts: %+v", article)
	}
}
