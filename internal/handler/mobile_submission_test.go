package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Tencent/WeKnora/internal/types"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

type fakeMobileSubmissionService struct {
	previewReq *types.MobileArticlePreviewRequest
	articleReq *types.MobileArticleSubmissionRequest
	fileTitle  string
	listFilter types.MobileSubmissionListFilter
}

func (s *fakeMobileSubmissionService) PreviewArticle(_ context.Context, _ string, req *types.MobileArticlePreviewRequest) (*types.MobileArticlePreview, error) {
	s.previewReq = req
	return &types.MobileArticlePreview{URL: req.URL, Title: "WeChat article"}, nil
}

func (s *fakeMobileSubmissionService) CreateArticleSubmission(_ context.Context, _ string, req *types.MobileArticleSubmissionRequest) (*types.MobileSubmission, error) {
	s.articleReq = req
	return &types.MobileSubmission{
		ID:              "sub-1",
		TenantID:        7,
		KnowledgeBaseID: "kb-1",
		Kind:            types.MobileSubmissionKindArticle,
		Title:           req.Title,
		Status:          types.MobileSubmissionStatusPendingReview,
	}, nil
}

func (s *fakeMobileSubmissionService) CreateFileSubmission(_ context.Context, _ string, _ *multipart.FileHeader, title string, _ string, _ string) (*types.MobileSubmission, error) {
	s.fileTitle = title
	return &types.MobileSubmission{
		ID:     "sub-file",
		Kind:   types.MobileSubmissionKindFile,
		Title:  title,
		Status: types.MobileSubmissionStatusPendingReview,
	}, nil
}

func (s *fakeMobileSubmissionService) ListSubmissions(_ context.Context, page *types.Pagination, filter types.MobileSubmissionListFilter) (*types.PageResult, error) {
	s.listFilter = filter
	return types.NewPageResult(0, page, []*types.MobileSubmission{}), nil
}

func TestMobileSubmissionHandlerCreatesArticleDraft(t *testing.T) {
	gin.SetMode(gin.TestMode)
	service := &fakeMobileSubmissionService{}
	handler := NewMobileSubmissionHandler(service)
	router := gin.New()
	router.POST("/knowledge-bases/:id/mobile-submissions/article", func(c *gin.Context) {
		c.Set(types.TenantIDContextKey.String(), uint64(7))
		handler.CreateArticleSubmission(c)
	})

	body, err := json.Marshal(map[string]string{
		"url":   "https://mp.weixin.qq.com/s/example",
		"title": "Article",
	})
	require.NoError(t, err)
	req := httptest.NewRequest(http.MethodPost, "/knowledge-bases/kb-1/mobile-submissions/article", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	require.Equal(t, http.StatusCreated, rec.Code)
	require.NotNil(t, service.articleReq)
	require.Equal(t, "Article", service.articleReq.Title)
	require.Contains(t, rec.Body.String(), types.MobileSubmissionStatusPendingReview)
}

func TestMobileSubmissionHandlerAcceptsUploadedFileName(t *testing.T) {
	gin.SetMode(gin.TestMode)
	service := &fakeMobileSubmissionService{}
	handler := NewMobileSubmissionHandler(service)
	router := gin.New()
	router.POST("/knowledge-bases/:id/mobile-submissions/file", func(c *gin.Context) {
		c.Set(types.TenantIDContextKey.String(), uint64(7))
		handler.CreateFileSubmission(c)
	})

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	require.NoError(t, writer.WriteField("fileName", "guide.pdf"))
	require.NoError(t, writer.WriteField("title", "Guide"))
	part, err := writer.CreateFormFile("file", "wxfile")
	require.NoError(t, err)
	_, err = part.Write([]byte("pdf"))
	require.NoError(t, err)
	require.NoError(t, writer.Close())

	req := httptest.NewRequest(http.MethodPost, "/knowledge-bases/kb-1/mobile-submissions/file", &body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	require.Equal(t, http.StatusCreated, rec.Code)
	require.Equal(t, "Guide", service.fileTitle)
	require.Contains(t, rec.Body.String(), types.MobileSubmissionStatusPendingReview)
}

func TestMobileSubmissionHandlerParsesListFilters(t *testing.T) {
	gin.SetMode(gin.TestMode)
	service := &fakeMobileSubmissionService{}
	handler := NewMobileSubmissionHandler(service)
	router := gin.New()
	router.GET("/mobile-submissions", func(c *gin.Context) {
		c.Set(types.TenantIDContextKey.String(), uint64(7))
		handler.ListSubmissions(c)
	})

	req := httptest.NewRequest(http.MethodGet, "/mobile-submissions?status=pending_review&knowledge_base_id=kb-1", nil)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	require.Equal(t, types.MobileSubmissionStatusPendingReview, service.listFilter.Status)
	require.Equal(t, []string{"kb-1"}, service.listFilter.KnowledgeBaseIDs)
}
