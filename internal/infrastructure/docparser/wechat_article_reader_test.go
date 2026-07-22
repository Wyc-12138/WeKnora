package docparser

import (
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
