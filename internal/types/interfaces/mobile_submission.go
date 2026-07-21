package interfaces

import (
	"context"
	"mime/multipart"

	"github.com/Tencent/WeKnora/internal/types"
)

type MobileSubmissionRepository interface {
	Create(ctx context.Context, submission *types.MobileSubmission) error
	GetByID(ctx context.Context, tenantID uint64, id string) (*types.MobileSubmission, error)
	List(ctx context.Context, tenantID uint64, page *types.Pagination, filter types.MobileSubmissionListFilter) ([]*types.MobileSubmission, int64, error)
	Update(ctx context.Context, submission *types.MobileSubmission) error
}

type MobileSubmissionService interface {
	PreviewArticle(ctx context.Context, kbID string, req *types.MobileArticlePreviewRequest) (*types.MobileArticlePreview, error)
	CreateArticleSubmission(ctx context.Context, kbID string, req *types.MobileArticleSubmissionRequest) (*types.MobileSubmission, error)
	CreateFileSubmission(ctx context.Context, kbID string, file *multipart.FileHeader, title string, materialType string, note string) (*types.MobileSubmission, error)
	ListSubmissions(ctx context.Context, page *types.Pagination, filter types.MobileSubmissionListFilter) (*types.PageResult, error)
}
