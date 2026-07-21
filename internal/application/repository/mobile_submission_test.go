package repository

import (
	"context"
	"testing"

	"github.com/Tencent/WeKnora/internal/types"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestMobileSubmissionRepositoryCreateAndList(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&types.MobileSubmission{}))

	repo := NewMobileSubmissionRepository(db)
	ctx := context.Background()

	require.NoError(t, repo.Create(ctx, &types.MobileSubmission{
		TenantID:        7,
		KnowledgeBaseID: "kb-1",
		Kind:            types.MobileSubmissionKindArticle,
		Title:           "Article",
		SourceURL:       "https://mp.weixin.qq.com/s/example",
		Status:          types.MobileSubmissionStatusPendingReview,
	}))
	require.NoError(t, repo.Create(ctx, &types.MobileSubmission{
		TenantID:        7,
		KnowledgeBaseID: "kb-1",
		Kind:            types.MobileSubmissionKindFile,
		Title:           "Done",
		Status:          types.MobileSubmissionStatusPublished,
	}))

	items, total, err := repo.List(ctx, 7, &types.Pagination{Page: 1, PageSize: 10}, types.MobileSubmissionListFilter{
		Status: types.MobileSubmissionStatusPendingReview,
	})
	require.NoError(t, err)
	require.Equal(t, int64(1), total)
	require.Len(t, items, 1)
	require.Equal(t, "Article", items[0].Title)

	kbItems, total, err := repo.List(ctx, 7, &types.Pagination{Page: 1, PageSize: 10}, types.MobileSubmissionListFilter{
		KnowledgeBaseIDs: []string{"kb-missing"},
	})
	require.NoError(t, err)
	require.Equal(t, int64(0), total)
	require.Empty(t, kbItems)

	otherTenant, total, err := repo.List(ctx, 8, &types.Pagination{Page: 1, PageSize: 10}, types.MobileSubmissionListFilter{})
	require.NoError(t, err)
	require.Equal(t, int64(0), total)
	require.Empty(t, otherTenant)
}
