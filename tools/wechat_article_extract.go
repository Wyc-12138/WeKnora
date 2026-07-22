package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/Tencent/WeKnora/internal/infrastructure/docparser"
)

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintf(os.Stderr, "usage: go run ./tools/wechat_article_extract.go <url> <out_dir>\n")
		os.Exit(2)
	}

	rawURL := os.Args[1]
	outDir := os.Args[2]
	article, err := docparser.ExtractWeChatArticle(context.Background(), rawURL)
	if err != nil {
		fmt.Fprintf(os.Stderr, "extract failed: %v\n", err)
		os.Exit(1)
	}

	imgDir := filepath.Join(outDir, "images")
	if err := os.MkdirAll(imgDir, 0o755); err != nil {
		fmt.Fprintf(os.Stderr, "mkdir images failed: %v\n", err)
		os.Exit(1)
	}
	mdPath := filepath.Join(outDir, "article.md")
	htmlPath := filepath.Join(outDir, "source.html")

	if err := os.WriteFile(mdPath, []byte(article.ReadResult.MarkdownContent), 0o644); err != nil {
		fmt.Fprintf(os.Stderr, "write markdown failed: %v\n", err)
		os.Exit(1)
	}
	if err := os.WriteFile(htmlPath, []byte(article.SourceHTML), 0o644); err != nil {
		fmt.Fprintf(os.Stderr, "write html failed: %v\n", err)
		os.Exit(1)
	}
	for _, ref := range article.ReadResult.ImageRefs {
		if ref.OriginalRef == "" || len(ref.ImageData) == 0 {
			continue
		}
		parts := strings.Split(filepath.ToSlash(ref.OriginalRef), "/")
		filename := parts[len(parts)-1]
		if err := os.WriteFile(filepath.Join(imgDir, filename), ref.ImageData, 0o644); err != nil {
			fmt.Fprintf(os.Stderr, "write image %s failed: %v\n", filename, err)
			os.Exit(1)
		}
	}

	absOut, _ := filepath.Abs(outDir)
	absMD, _ := filepath.Abs(mdPath)
	absHTML, _ := filepath.Abs(htmlPath)
	fmt.Println("OUT_DIR", absOut)
	fmt.Println("MD_PATH", absMD)
	fmt.Println("HTML_PATH", absHTML)
	fmt.Println("INLINE_IMAGES", article.InlineImageCount)
	fmt.Println("BACKGROUND_IMAGES", article.BackgroundImageCount)
	fmt.Println("TOTAL_UNIQUE_IMAGES", article.TotalUniqueImageCount)
	fmt.Println("MD_CHARS", len([]rune(article.ReadResult.MarkdownContent)))
}
