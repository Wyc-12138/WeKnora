package types

import (
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

const (
	MobileSubmissionKindArticle = "article"
	MobileSubmissionKindFile    = "file"
)

const (
	MobileSubmissionStatusProcessing   = "processing"
	MobileSubmissionStatusPendingReview = "pending_review"
	MobileSubmissionStatusPublished    = "published"
	MobileSubmissionStatusRejected     = "rejected"
	MobileSubmissionStatusFailed       = "failed"
	MobileSubmissionStatusWithdrawn    = "withdrawn"
)

// MobileSubmission is a mobile-side draft submitted for desktop review.
// It intentionally does not participate in retrieval until an approval flow
// creates a formal Knowledge row and links knowledge_id.
type MobileSubmission struct {
	ID              string         `json:"id"                gorm:"type:varchar(36);primaryKey"`
	TenantID        uint64         `json:"tenant_id"          gorm:"index;not null"`
	KnowledgeBaseID string         `json:"knowledge_base_id"  gorm:"type:varchar(36);index;not null"`
	Kind            string         `json:"kind"               gorm:"type:varchar(32);index;not null"`
	Title           string         `json:"title"              gorm:"type:varchar(512);not null"`
	SourceURL       string         `json:"source_url"         gorm:"type:varchar(2048)"`
	FileName        string         `json:"file_name"          gorm:"type:varchar(512)"`
	FileType        string         `json:"file_type"          gorm:"type:varchar(64)"`
	FileSize        int64          `json:"file_size"`
	FilePath        string         `json:"file_path"          gorm:"type:varchar(2048)"`
	Note            string         `json:"note"               gorm:"type:text"`
	Metadata        JSON           `json:"metadata"           gorm:"type:jsonb"`
	Status          string         `json:"status"             gorm:"type:varchar(32);index;not null;default:'pending_review'"`
	KnowledgeID     string         `json:"knowledge_id"       gorm:"type:varchar(36);index"`
	ErrorMessage    string         `json:"error_message"      gorm:"type:text"`
	CreatedAt       time.Time      `json:"created_at"`
	UpdatedAt       time.Time      `json:"updated_at"`
	DeletedAt       gorm.DeletedAt `json:"deleted_at"         gorm:"index"`
}

func (s *MobileSubmission) BeforeCreate(tx *gorm.DB) error {
	if s.ID == "" {
		s.ID = uuid.New().String()
	}
	if s.Status == "" {
		s.Status = MobileSubmissionStatusPendingReview
	}
	return nil
}

type MobileSubmissionListFilter struct {
	Status           string
	KnowledgeBaseIDs []string
}

type MobileArticlePreviewRequest struct {
	URL string `json:"url" binding:"required"`
}

type MobileArticlePreview struct {
	URL         string `json:"url"`
	Title       string `json:"title"`
	Source      string `json:"source"`
	PublishedAt string `json:"published_at"`
	Summary     string `json:"summary"`
	CoverURL    string `json:"cover_url"`
}

type MobileArticleSubmissionRequest struct {
	URL          string `json:"url" binding:"required"`
	Title        string `json:"title"`
	MaterialType string `json:"material_type"`
	Note         string `json:"note"`
	Source       string `json:"source"`
	PublishedAt  string `json:"published_at"`
	Summary      string `json:"summary"`
	CoverURL     string `json:"cover_url"`
}
