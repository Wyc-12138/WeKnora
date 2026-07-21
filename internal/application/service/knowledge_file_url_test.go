package service

import "testing"

func TestIsFileURLCoversUploadSupportedDocumentTypes(t *testing.T) {
	cases := []string{
		"https://example.com/a.pdf",
		"https://example.com/a.doc",
		"https://example.com/a.docx",
		"https://example.com/a.epub",
		"https://example.com/a.mhtml",
		"https://example.com/a.csv",
		"https://example.com/a.xlsx",
		"https://example.com/a.xls",
		"https://example.com/a.pptx",
		"https://example.com/a.ppt",
		"https://example.com/a.json",
		"https://example.com/a.markdown",
	}

	for _, rawURL := range cases {
		if !isFileURL(rawURL, "", "") {
			t.Fatalf("isFileURL(%q) = false, want true", rawURL)
		}
	}
}

func TestIsFileURLKeepsWechatArticleAsHTMLURL(t *testing.T) {
	rawURL := "https://mp.weixin.qq.com/s/example"
	if isFileURL(rawURL, "", "") {
		t.Fatalf("isFileURL(%q) = true, want false", rawURL)
	}
}

func TestIsFileURLUsesFileHints(t *testing.T) {
	if !isFileURL("https://example.com/download?id=1", "report.pdf", "") {
		t.Fatal("isFileURL() with fileName hint = false, want true")
	}
	if !isFileURL("https://example.com/download?id=1", "", "pdf") {
		t.Fatal("isFileURL() with fileType hint = false, want true")
	}
}
