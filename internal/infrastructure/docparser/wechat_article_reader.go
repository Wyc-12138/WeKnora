package docparser

import (
	"context"
	"fmt"
	stdhtml "html"
	"io"
	"mime"
	"net/http"
	"net/url"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/PuerkitoBio/goquery"
	"github.com/Tencent/WeKnora/internal/types"
	secutils "github.com/Tencent/WeKnora/internal/utils"
	nethtml "golang.org/x/net/html"
)

const (
	wechatFetchTimeout = 30 * time.Second
	wechatImageTimeout = 30 * time.Second
)

var (
	reWeChatMsgDesc = regexp.MustCompile(`var\s+msg_desc\s*=\s*htmlDecode\("(.*?)"\)`)
	reWeChatNick    = regexp.MustCompile(`var\s+nickname\s*=\s*htmlDecode\("(.*?)"\)`)
	reWeChatCT      = regexp.MustCompile(`var\s+ct\s*=\s*"(\d+)"`)
	reCSSURL        = regexp.MustCompile(`url\((.*?)\)`)
)

// WeChatArticle contains the exact artifacts extracted from a WeChat article:
// Markdown with relative image paths, inline image bytes, and the original HTML.
type WeChatArticle struct {
	ReadResult            *types.ReadResult
	SourceHTML            string
	InlineImageCount      int
	BackgroundImageCount  int
	TotalUniqueImageCount int
}

// IsWeChatArticleURL reports whether rawURL should use the WeChat article
// extractor instead of the generic URL docreader.
func IsWeChatArticleURL(rawURL string) bool {
	u, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return false
	}
	host := strings.ToLower(u.Hostname())
	return (u.Scheme == "http" || u.Scheme == "https") && host == "mp.weixin.qq.com" && strings.HasPrefix(u.Path, "/s/")
}

// ReadWeChatArticle returns a ReadResult suitable for the normal WeKnora image
// resolver and chunking pipeline.
func ReadWeChatArticle(ctx context.Context, rawURL string) (*types.ReadResult, error) {
	article, err := ExtractWeChatArticle(ctx, rawURL)
	if err != nil {
		return nil, err
	}
	return article.ReadResult, nil
}

// ExtractWeChatArticle mirrors the proven local extraction flow:
// fetch HTML, parse #js_content, download img[data-src]/background images,
// and generate Markdown that references images/... relative paths.
func ExtractWeChatArticle(ctx context.Context, rawURL string) (*WeChatArticle, error) {
	if !IsWeChatArticleURL(rawURL) {
		return nil, fmt.Errorf("not a WeChat article URL: %s", rawURL)
	}
	if err := secutils.ValidateURLForSSRF(rawURL); err != nil {
		return nil, fmt.Errorf("URL rejected: %w", err)
	}

	htmlText, err := fetchWeChatHTML(ctx, rawURL)
	if err != nil {
		return nil, err
	}

	doc, err := goquery.NewDocumentFromReader(strings.NewReader(htmlText))
	if err != nil {
		return nil, fmt.Errorf("parse WeChat HTML: %w", err)
	}
	content := doc.Find("#js_content")
	if content.Length() == 0 {
		return nil, fmt.Errorf("no #js_content found; page may be blocked or structure changed")
	}

	state := &wechatExtractState{
		ctx:      ctx,
		rawURL:   rawURL,
		client:   secutils.NewSSRFSafeHTTPClient(secutils.SSRFSafeHTTPClientConfig{Timeout: wechatImageTimeout, MaxRedirects: 5}),
		seenURLs: map[string]string{},
		refData:  map[string]types.ImageRef{},
	}

	if err := state.downloadInlineImages(content); err != nil {
		return nil, err
	}
	backgroundPaths, err := state.downloadBackgroundImages(content)
	if err != nil {
		return nil, err
	}

	title := metaContent(doc, `meta[property="og:title"]`)
	desc := firstSubmatch(reWeChatMsgDesc, htmlText)
	author := firstSubmatch(reWeChatNick, htmlText)
	ct := firstSubmatch(reWeChatCT, htmlText)
	published := formatWeChatPublishTime(ct)

	md := buildWeChatMarkdown(content, rawURL, title, author, published, desc, backgroundPaths)
	refs := make([]types.ImageRef, 0, len(state.refOrder))
	for _, ref := range state.refOrder {
		refs = append(refs, ref)
	}

	if isWeChatBlockedContent(rawURL, md) {
		return nil, fmt.Errorf("WeChat article content appears to be blocked or verification-gated")
	}

	return &WeChatArticle{
		ReadResult: &types.ReadResult{
			MarkdownContent: md,
			ImageRefs:       refs,
			Metadata: map[string]string{
				"title":       title,
				"account":     author,
				"published":   published,
				"description": desc,
				"source":      rawURL,
			},
		},
		SourceHTML:            htmlText,
		InlineImageCount:      state.inlineImageCount,
		BackgroundImageCount:  state.backgroundImageCount,
		TotalUniqueImageCount: len(state.seenURLs),
	}, nil
}

type wechatExtractState struct {
	ctx                  context.Context
	rawURL               string
	client               *http.Client
	seenURLs             map[string]string
	refData              map[string]types.ImageRef
	refOrder             []types.ImageRef
	inlineImageCount     int
	backgroundImageCount int
}

func fetchWeChatHTML(ctx context.Context, rawURL string) (string, error) {
	client := secutils.NewSSRFSafeHTTPClient(secutils.SSRFSafeHTTPClientConfig{Timeout: wechatFetchTimeout, MaxRedirects: 10})
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return "", err
	}
	setWeChatBrowserHeaders(req)
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("fetch WeChat article failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("fetch WeChat article HTTP %d %s", resp.StatusCode, resp.Status)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("read WeChat article body: %w", err)
	}
	return string(body), nil
}

func setWeChatBrowserHeaders(req *http.Request) {
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36")
	req.Header.Set("Referer", "https://mp.weixin.qq.com/")
	req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8")
	req.Header.Set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
	req.Header.Set("Accept-Encoding", "identity")
}

func (s *wechatExtractState) downloadInlineImages(content *goquery.Selection) error {
	var firstErr error
	content.Find("img").Each(func(_ int, img *goquery.Selection) {
		src, _ := img.Attr("data-src")
		if strings.TrimSpace(src) == "" {
			src, _ = img.Attr("src")
		}
		src = normalizeWeChatURL(src)
		if src == "" {
			return
		}
		rel, err := s.downloadImage(src, "image")
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			return
		}
		img.SetAttr("data-local", rel)
	})
	return firstErr
}

func (s *wechatExtractState) downloadBackgroundImages(content *goquery.Selection) ([]string, error) {
	var bgURLs []string
	content.Find("[style]").Each(func(_ int, sel *goquery.Selection) {
		style, _ := sel.Attr("style")
		for _, match := range reCSSURL.FindAllStringSubmatch(style, -1) {
			if len(match) < 2 {
				continue
			}
			bgURL := normalizeWeChatURL(match[1])
			if strings.HasPrefix(bgURL, "http://") || strings.HasPrefix(bgURL, "https://") {
				bgURLs = append(bgURLs, bgURL)
			}
		}
	})

	var paths []string
	seenPaths := map[string]struct{}{}
	for _, bgURL := range bgURLs {
		rel, err := s.downloadImage(bgURL, "background")
		if err != nil {
			return paths, err
		}
		if _, ok := seenPaths[rel]; !ok {
			seenPaths[rel] = struct{}{}
			paths = append(paths, rel)
		}
	}
	return paths, nil
}

func (s *wechatExtractState) downloadImage(rawImageURL, prefix string) (string, error) {
	imageURL := normalizeWeChatURL(rawImageURL)
	if imageURL == "" || (!strings.HasPrefix(imageURL, "http://") && !strings.HasPrefix(imageURL, "https://")) {
		return "", nil
	}
	if rel, ok := s.seenURLs[imageURL]; ok {
		return rel, nil
	}
	if err := secutils.ValidateURLForSSRF(imageURL); err != nil {
		return "", fmt.Errorf("image URL rejected: %w", err)
	}

	var number int
	switch prefix {
	case "background":
		s.backgroundImageCount++
		number = s.backgroundImageCount
	default:
		s.inlineImageCount++
		number = s.inlineImageCount
	}

	req, err := http.NewRequestWithContext(s.ctx, http.MethodGet, imageURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36")
	req.Header.Set("Referer", "https://mp.weixin.qq.com/")
	resp, err := s.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("download WeChat image failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("download WeChat image HTTP %d", resp.StatusCode)
	}
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("read WeChat image: %w", err)
	}
	mimeType := normalizeMime(resp.Header.Get("Content-Type"), data)
	ext := inferWeChatImageExt(imageURL, mimeType)
	filename := fmt.Sprintf("%s_%03d.%s", prefix, number, ext)
	rel := filepath.ToSlash(filepath.Join("images", filename))

	ref := types.ImageRef{
		Filename:    filename,
		OriginalRef: rel,
		MimeType:    mimeType,
		ImageData:   data,
		IsOriginal:  true,
	}
	s.seenURLs[imageURL] = rel
	s.refData[rel] = ref
	s.refOrder = append(s.refOrder, ref)
	return rel, nil
}

func normalizeMime(contentType string, data []byte) string {
	mimeType, _, _ := mime.ParseMediaType(contentType)
	if strings.HasPrefix(mimeType, "image/") {
		return mimeType
	}
	detected := http.DetectContentType(data)
	if strings.HasPrefix(detected, "image/") {
		return detected
	}
	return "image/jpeg"
}

func inferWeChatImageExt(rawURL, mimeType string) string {
	if u, err := url.Parse(rawURL); err == nil {
		values := u.Query()
		for _, key := range []string{"wx_fmt", "tp"} {
			if value := strings.ToLower(values.Get(key)); value != "" {
				value = strings.ReplaceAll(value, "jpeg", "jpg")
				switch value {
				case "jpg", "png", "gif", "webp", "bmp":
					return value
				}
			}
		}
	}
	switch strings.ToLower(mimeType) {
	case "image/jpeg":
		return "jpg"
	case "image/png":
		return "png"
	case "image/gif":
		return "gif"
	case "image/webp":
		return "webp"
	case "image/bmp":
		return "bmp"
	default:
		return "jpg"
	}
}

func buildWeChatMarkdown(content *goquery.Selection, rawURL, title, author, published, desc string, backgroundPaths []string) string {
	if title == "" {
		title = "WeChat Article"
	}
	lines := []string{
		"# " + title,
		"",
	}
	if author != "" {
		lines = append(lines, "- Account: "+author)
	}
	if published != "" {
		lines = append(lines, "- Published: "+published)
	}
	if desc != "" {
		lines = append(lines, "- Summary: "+desc)
	}
	lines = append(lines, "- Source: "+rawURL, "")

	lastText := ""
	for _, root := range content.Nodes {
		walkHTML(root, func(n *nethtml.Node) {
			if n.Type != nethtml.ElementNode {
				return
			}
			switch strings.ToLower(n.Data) {
			case "img":
				rel := attrValue(n, "data-local")
				if rel == "" {
					return
				}
				alt := attrValue(n, "alt")
				if alt == "" {
					alt = attrValue(n, "data-type")
				}
				if alt == "" {
					alt = "image"
				}
				lines = append(lines, fmt.Sprintf("![%s](%s)", alt, rel), "")
			case "p":
				text := collapseWhitespace(textContent(n))
				if text == "" || text == lastText {
					return
				}
				lastText = text
				strongText := strongTextContent(n)
				if strongText != "" && strongText == text && len([]rune(text)) <= 40 {
					lines = append(lines, "## "+text)
				} else {
					lines = append(lines, text)
				}
				lines = append(lines, "")
			}
		})
	}

	if len(backgroundPaths) > 0 {
		lines = append(lines, "## Saved Background Images", "")
		for _, rel := range backgroundPaths {
			lines = append(lines, fmt.Sprintf("![background](%s)", rel), "")
		}
	}

	md := strings.Join(lines, "\n")
	md = regexp.MustCompile(`\n{3,}`).ReplaceAllString(md, "\n\n")
	return strings.TrimSpace(md) + "\n"
}

func walkHTML(n *nethtml.Node, fn func(*nethtml.Node)) {
	for child := n.FirstChild; child != nil; child = child.NextSibling {
		fn(child)
		walkHTML(child, fn)
	}
}

func textContent(n *nethtml.Node) string {
	var sb strings.Builder
	var walk func(*nethtml.Node)
	walk = func(cur *nethtml.Node) {
		if cur.Type == nethtml.TextNode {
			sb.WriteString(strings.TrimSpace(cur.Data))
			return
		}
		for child := cur.FirstChild; child != nil; child = child.NextSibling {
			walk(child)
		}
	}
	walk(n)
	return sb.String()
}

func strongTextContent(n *nethtml.Node) string {
	var parts []string
	var walk func(*nethtml.Node)
	walk = func(cur *nethtml.Node) {
		if cur.Type == nethtml.ElementNode {
			name := strings.ToLower(cur.Data)
			if name == "strong" || name == "b" {
				if text := collapseWhitespace(textContent(cur)); text != "" {
					parts = append(parts, text)
				}
				return
			}
		}
		for child := cur.FirstChild; child != nil; child = child.NextSibling {
			walk(child)
		}
	}
	walk(n)
	return strings.Join(parts, "")
}

func collapseWhitespace(s string) string {
	return strings.Join(strings.Fields(strings.TrimSpace(s)), " ")
}

func attrValue(n *nethtml.Node, key string) string {
	for _, attr := range n.Attr {
		if attr.Key == key {
			return attr.Val
		}
	}
	return ""
}

func metaContent(doc *goquery.Document, selector string) string {
	value, _ := doc.Find(selector).First().Attr("content")
	return strings.TrimSpace(value)
}

func firstSubmatch(re *regexp.Regexp, s string) string {
	m := re.FindStringSubmatch(s)
	if len(m) < 2 {
		return ""
	}
	return strings.TrimSpace(stdhtml.UnescapeString(m[1]))
}

func formatWeChatPublishTime(ct string) string {
	if ct == "" {
		return ""
	}
	seconds, err := strconv.ParseInt(ct, 10, 64)
	if err != nil {
		return ""
	}
	return time.Unix(seconds, 0).UTC().In(time.FixedZone("CST", 8*3600)).Format("2006-01-02 15:04:05 -07:00")
}

func normalizeWeChatURL(raw string) string {
	raw = strings.TrimSpace(stdhtml.UnescapeString(raw))
	raw = strings.Trim(raw, `"'`)
	if strings.HasPrefix(raw, "//") {
		return "https:" + raw
	}
	return raw
}

func isWeChatBlockedContent(rawURL, content string) bool {
	if rawURL == "" || content == "" || !strings.Contains(strings.ToLower(rawURL), "mp.weixin.qq.com/") {
		return false
	}
	normalized := strings.ToLower(strings.Join(strings.Fields(content), ""))
	for _, marker := range []string{
		"当前环境异常",
		"环境异常",
		"完成验证",
		"去验证",
		"参数错误",
		"验证码",
		"人机验证",
		"请在微信客户端打开",
		"请在客户端打开",
		"访问过于频繁",
		"当前网络环境存在异常",
		"系统暂时限制",
		"securityverification",
		"verifyyouarehuman",
		"captcha",
		"accessdenied",
		"toomanyrequests",
	} {
		if strings.Contains(normalized, marker) {
			return true
		}
	}
	return false
}
