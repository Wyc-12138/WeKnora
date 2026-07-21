package repository

import (
	"context"
	"errors"

	"github.com/Tencent/WeKnora/internal/types"
	"github.com/Tencent/WeKnora/internal/types/interfaces"
	"gorm.io/gorm"
)

var ErrMobileSubmissionNotFound = errors.New("mobile submission not found")

type mobileSubmissionRepository struct {
	db *gorm.DB
}

func NewMobileSubmissionRepository(db *gorm.DB) interfaces.MobileSubmissionRepository {
	return &mobileSubmissionRepository{db: db}
}

func (r *mobileSubmissionRepository) Create(ctx context.Context, submission *types.MobileSubmission) error {
	return r.db.WithContext(ctx).Create(submission).Error
}

func (r *mobileSubmissionRepository) GetByID(ctx context.Context, tenantID uint64, id string) (*types.MobileSubmission, error) {
	var submission types.MobileSubmission
	err := r.db.WithContext(ctx).
		Where("tenant_id = ? AND id = ?", tenantID, id).
		First(&submission).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrMobileSubmissionNotFound
		}
		return nil, err
	}
	return &submission, nil
}

func (r *mobileSubmissionRepository) List(
	ctx context.Context,
	tenantID uint64,
	page *types.Pagination,
	filter types.MobileSubmissionListFilter,
) ([]*types.MobileSubmission, int64, error) {
	var submissions []*types.MobileSubmission
	var total int64
	if page == nil {
		page = &types.Pagination{}
	}

	scope := r.db.WithContext(ctx).Model(&types.MobileSubmission{}).Where("tenant_id = ?", tenantID)
	if filter.Status != "" {
		scope = scope.Where("status = ?", filter.Status)
	}
	if len(filter.KnowledgeBaseIDs) > 0 {
		scope = scope.Where("knowledge_base_id IN ?", filter.KnowledgeBaseIDs)
	}

	if err := scope.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	if err := scope.
		Order("created_at DESC").
		Offset(page.Offset()).
		Limit(page.Limit()).
		Find(&submissions).Error; err != nil {
		return nil, 0, err
	}
	return submissions, total, nil
}

func (r *mobileSubmissionRepository) Update(ctx context.Context, submission *types.MobileSubmission) error {
	return r.db.WithContext(ctx).Save(submission).Error
}
