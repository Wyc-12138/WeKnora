package service

import (
	"context"
	"encoding/json"
	"mime/multipart"
	"net/url"
	"strings"
	"time"

	werrors "github.com/Tencent/WeKnora/internal/errors"
	"github.com/Tencent/WeKnora/internal/types"
	"github.com/Tencent/WeKnora/internal/types/interfaces"
	secutils "github.com/Tencent/WeKnora/internal/utils"
)

type mobileSubmissionService struct {
	repo    interfaces.MobileSubmissionRepository
	fileSvc interfaces.FileService
}

func NewMobileSubmissionService(
	repo interfaces.MobileSubmissionRepository,
	fileSvc interfaces.FileService,
) interfaces.MobileSubmissionService {
	return &mobileSubmissionService{
		repo:    repo,
		fileSvc: fileSvc,
	}
}

func (s *mobileSubmissionService) PreviewArticle(
	ctx context.Context,
	_ string,
	req *types.MobileArticlePreviewRequest,
) (*types.MobileArticlePreview, error) {
	if req == nil || strings.TrimSpace(req.URL) == "" {
		return nil, werrors.NewBadRequestError("article URL is required")
	}
	rawURL := strings.TrimSpace(req.URL)
	if !isValidURL(rawURL) || !secutils.IsValidURL(rawURL) {
		return nil, werrors.NewBadRequestError("article URL is invalid")
	}
	if err := secutils.ValidateURLForSSRF(rawURL); err != nil {
		return nil, werrors.NewBadRequestError(secutils.FormatSSRFError("URL", rawURL, err))
	}

	parsed, _ := url.Parse(rawURL)
	source := parsed.Hostname()
	title := "Public article"
	if strings.Contains(source, "mp.weixin.qq.com") {
		source = "WeChat Official Account"
		title = "WeChat article"
	}
	return &types.MobileArticlePreview{
		URL:         rawURL,
		Title:       title,
		Source:      source,
		PublishedAt: "",
		Summary:     "Article link recognized. Confirm the title, target knowledge base, and material type before submitting the draft.",
		CoverURL:    "",
	}, nil
}

func (s *mobileSubmissionService) CreateArticleSubmission(
	ctx context.Context,
	kbID string,
	req *types.MobileArticleSubmissionRequest,
) (*types.MobileSubmission, error) {
	if req == nil || strings.TrimSpace(req.URL) == "" {
		return nil, werrors.NewBadRequestError("article URL is required")
	}
	rawURL := strings.TrimSpace(req.URL)
	if !isValidURL(rawURL) || !secutils.IsValidURL(rawURL) {
		return nil, werrors.NewBadRequestError("article URL is invalid")
	}
	if err := secutils.ValidateURLForSSRF(rawURL); err != nil {
		return nil, werrors.NewBadRequestError(secutils.FormatSSRFError("URL", rawURL, err))
	}
	title := strings.TrimSpace(req.Title)
	if title == "" {
		title = "WeChat article"
	}

	metadata, err := mobileMetadata(map[string]string{
		"material_type": req.MaterialType,
		"source":        req.Source,
		"published_at":  req.PublishedAt,
		"summary":       req.Summary,
		"cover_url":     req.CoverURL,
		"channel":       types.ChannelWechat,
	})
	if err != nil {
		return nil, err
	}

	tenantID := types.MustTenantIDFromContext(ctx)
	submission := &types.MobileSubmission{
		TenantID:        tenantID,
		KnowledgeBaseID: kbID,
		Kind:            types.MobileSubmissionKindArticle,
		Title:           title,
		SourceURL:       rawURL,
		Note:            strings.TrimSpace(req.Note),
		Metadata:        metadata,
		Status:          types.MobileSubmissionStatusPendingReview,
		CreatedAt:       time.Now(),
		UpdatedAt:       time.Now(),
	}
	if err := s.repo.Create(ctx, submission); err != nil {
		return nil, err
	}
	return submission, nil
}

func (s *mobileSubmissionService) CreateFileSubmission(
	ctx context.Context,
	kbID string,
	file *multipart.FileHeader,
	title string,
	materialType string,
	note string,
) (*types.MobileSubmission, error) {
	if file == nil {
		return nil, werrors.NewBadRequestError("file is required")
	}
	fileName := file.Filename
	fileType := strings.ToLower(getFileType(fileName))
	if !allowedMobileSubmissionFileTypes[fileType] {
		return nil, werrors.NewBadRequestError("only PDF and Word files are supported")
	}
	if strings.TrimSpace(title) == "" {
		title = strings.TrimSuffix(fileName, "."+fileType)
	}

	metadata, err := mobileMetadata(map[string]string{
		"material_type": materialType,
		"channel":       types.ChannelWechat,
	})
	if err != nil {
		return nil, err
	}

	tenantID := types.MustTenantIDFromContext(ctx)
	submission := &types.MobileSubmission{
		TenantID:        tenantID,
		KnowledgeBaseID: kbID,
		Kind:            types.MobileSubmissionKindFile,
		Title:           strings.TrimSpace(title),
		FileName:        fileName,
		FileType:        fileType,
		FileSize:        file.Size,
		Note:            strings.TrimSpace(note),
		Metadata:        metadata,
		Status:          types.MobileSubmissionStatusPendingReview,
		CreatedAt:       time.Now(),
		UpdatedAt:       time.Now(),
	}
	if err := s.repo.Create(ctx, submission); err != nil {
		return nil, err
	}

	filePath, err := s.fileSvc.SaveFile(ctx, file, tenantID, submission.ID)
	if err != nil {
		submission.Status = types.MobileSubmissionStatusFailed
		submission.ErrorMessage = err.Error()
		_ = s.repo.Update(ctx, submission)
		return nil, err
	}
	submission.FilePath = filePath
	submission.UpdatedAt = time.Now()
	if err := s.repo.Update(ctx, submission); err != nil {
		_ = s.fileSvc.DeleteFile(ctx, filePath)
		return nil, err
	}
	return submission, nil
}

func (s *mobileSubmissionService) ListSubmissions(
	ctx context.Context,
	page *types.Pagination,
	filter types.MobileSubmissionListFilter,
) (*types.PageResult, error) {
	if page == nil {
		page = &types.Pagination{}
	}
	if scope, ok := types.TenantAPIKeyScopeFromContext(ctx); ok && scope.IsKnowledgeBaseRestricted() {
		if len(filter.KnowledgeBaseIDs) > 0 {
			if !scope.AllowsKnowledgeBases(filter.KnowledgeBaseIDs) {
				return nil, werrors.NewForbiddenError("API key scope does not allow one or more knowledge bases")
			}
		} else {
			filter.KnowledgeBaseIDs = append([]string(nil), scope.KnowledgeBaseIDs...)
		}
	}
	tenantID := types.MustTenantIDFromContext(ctx)
	submissions, total, err := s.repo.List(ctx, tenantID, page, filter)
	if err != nil {
		return nil, err
	}
	return types.NewPageResult(total, page, submissions), nil
}

var allowedMobileSubmissionFileTypes = map[string]bool{
	"pdf":  true,
	"doc":  true,
	"docx": true,
}

func mobileMetadata(values map[string]string) (types.JSON, error) {
	clean := make(map[string]string)
	for key, value := range values {
		if strings.TrimSpace(value) != "" {
			clean[key] = strings.TrimSpace(value)
		}
	}
	bytes, err := json.Marshal(clean)
	if err != nil {
		return nil, err
	}
	return types.JSON(bytes), nil
}
