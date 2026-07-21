package service

import (
	"bytes"
	"context"
	"io"
	"mime/multipart"
	"net/textproto"
	"testing"

	"github.com/Tencent/WeKnora/internal/types"
	"github.com/stretchr/testify/require"
)

type fakeMobileSubmissionRepo struct {
	created    []*types.MobileSubmission
	lastFilter types.MobileSubmissionListFilter
}

func (r *fakeMobileSubmissionRepo) Create(_ context.Context, submission *types.MobileSubmission) error {
	r.created = append(r.created, submission)
	return nil
}

func (r *fakeMobileSubmissionRepo) GetByID(context.Context, uint64, string) (*types.MobileSubmission, error) {
	return nil, nil
}

func (r *fakeMobileSubmissionRepo) List(_ context.Context, _ uint64, page *types.Pagination, filter types.MobileSubmissionListFilter) ([]*types.MobileSubmission, int64, error) {
	r.lastFilter = filter
	return r.created, int64(len(r.created)), nil
}

func (r *fakeMobileSubmissionRepo) Update(_ context.Context, submission *types.MobileSubmission) error {
	if len(r.created) == 0 {
		r.created = append(r.created, submission)
	}
	return nil
}

type fakeMobileFileService struct {
	saved bool
	path  string
}

func (s *fakeMobileFileService) CheckConnectivity(context.Context) error { return nil }
func (s *fakeMobileFileService) SaveFile(context.Context, *multipart.FileHeader, uint64, string) (string, error) {
	s.saved = true
	if s.path == "" {
		return "local://7/mobile-submission/file.pdf", nil
	}
	return s.path, nil
}
func (s *fakeMobileFileService) SaveBytes(context.Context, []byte, uint64, string, bool) (string, error) {
	return "", nil
}
func (s *fakeMobileFileService) GetFile(context.Context, string) (io.ReadCloser, error) {
	return io.NopCloser(bytes.NewReader(nil)), nil
}
func (s *fakeMobileFileService) GetFileURL(context.Context, string) (string, error) { return "", nil }
func (s *fakeMobileFileService) DeleteFile(context.Context, string) error           { return nil }
func (s *fakeMobileFileService) CopyFile(context.Context, string, uint64, string) (string, error) {
	return "", nil
}

func TestMobileSubmissionServiceCreatesDraftWithoutKnowledge(t *testing.T) {
	repo := &fakeMobileSubmissionRepo{}
	svc := NewMobileSubmissionService(repo, &fakeMobileFileService{})
	ctx := context.WithValue(context.Background(), types.TenantIDContextKey, uint64(7))

	submission, err := svc.CreateArticleSubmission(ctx, "kb-1", &types.MobileArticleSubmissionRequest{
		URL:   "https://mp.weixin.qq.com/s/example",
		Title: "Article",
		Note:  "review note",
	})
	require.NoError(t, err)
	require.Equal(t, types.MobileSubmissionStatusPendingReview, submission.Status)
	require.Equal(t, "", submission.KnowledgeID)
	require.Equal(t, types.MobileSubmissionKindArticle, submission.Kind)
	require.Len(t, repo.created, 1)
}

func TestMobileSubmissionServiceRejectsUnsafePreviewURL(t *testing.T) {
	svc := NewMobileSubmissionService(&fakeMobileSubmissionRepo{}, &fakeMobileFileService{})
	_, err := svc.PreviewArticle(context.Background(), "kb-1", &types.MobileArticlePreviewRequest{
		URL: "http://127.0.0.1/private",
	})
	require.Error(t, err)
}

func TestMobileSubmissionServiceStoresFileDraft(t *testing.T) {
	repo := &fakeMobileSubmissionRepo{}
	fileSvc := &fakeMobileFileService{}
	svc := NewMobileSubmissionService(repo, fileSvc)
	ctx := context.WithValue(context.Background(), types.TenantIDContextKey, uint64(7))

	file := testFileHeader(t, "guide.pdf", []byte("pdf"))
	submission, err := svc.CreateFileSubmission(ctx, "kb-1", file, "Guide", "guide", "note")
	require.NoError(t, err)
	require.True(t, fileSvc.saved)
	require.Equal(t, types.MobileSubmissionStatusPendingReview, submission.Status)
	require.Equal(t, "", submission.KnowledgeID)
	require.Equal(t, "local://7/mobile-submission/file.pdf", submission.FilePath)
	require.Equal(t, "pdf", submission.FileType)
}

func TestMobileSubmissionServiceNarrowsListForScopedAPIKey(t *testing.T) {
	repo := &fakeMobileSubmissionRepo{}
	svc := NewMobileSubmissionService(repo, &fakeMobileFileService{})
	ctx := context.WithValue(context.Background(), types.TenantIDContextKey, uint64(7))
	ctx = types.WithTenantAPIKeyScope(ctx, types.TenantAPIKeyScope{
		KnowledgeBaseIDs: types.StringArray{"kb-allowed"},
	})

	_, err := svc.ListSubmissions(ctx, &types.Pagination{Page: 1, PageSize: 10}, types.MobileSubmissionListFilter{})
	require.NoError(t, err)
	require.Equal(t, []string{"kb-allowed"}, repo.lastFilter.KnowledgeBaseIDs)

	_, err = svc.ListSubmissions(ctx, &types.Pagination{Page: 1, PageSize: 10}, types.MobileSubmissionListFilter{
		KnowledgeBaseIDs: []string{"kb-denied"},
	})
	require.Error(t, err)
}

func testFileHeader(t *testing.T, fileName string, content []byte) *multipart.FileHeader {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", `form-data; name="file"; filename="`+fileName+`"`)
	header.Set("Content-Type", "application/octet-stream")
	part, err := writer.CreatePart(header)
	require.NoError(t, err)
	_, err = part.Write(content)
	require.NoError(t, err)
	require.NoError(t, writer.Close())
	reader := multipart.NewReader(&body, writer.Boundary())
	form, err := reader.ReadForm(1024)
	require.NoError(t, err)
	return form.File["file"][0]
}
