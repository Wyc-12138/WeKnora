package handler

import (
	"context"
	"net/http"
	"strconv"

	"github.com/Tencent/WeKnora/internal/errors"
	"github.com/Tencent/WeKnora/internal/types"
	"github.com/Tencent/WeKnora/internal/types/interfaces"
	"github.com/gin-gonic/gin"
)

type MobileSubmissionHandler struct {
	service interfaces.MobileSubmissionService
}

func NewMobileSubmissionHandler(service interfaces.MobileSubmissionService) *MobileSubmissionHandler {
	return &MobileSubmissionHandler{service: service}
}

func (h *MobileSubmissionHandler) PreviewArticle(c *gin.Context) {
	ctx, ok := requestTenantContext(c)
	if !ok {
		return
	}
	var req types.MobileArticlePreviewRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.Error(errors.NewBadRequestError(err.Error()))
		return
	}
	preview, err := h.service.PreviewArticle(ctx, c.Param("id"), &req)
	if err != nil {
		c.Error(err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": preview})
}

func (h *MobileSubmissionHandler) CreateArticleSubmission(c *gin.Context) {
	ctx, ok := requestTenantContext(c)
	if !ok {
		return
	}
	var req types.MobileArticleSubmissionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.Error(errors.NewBadRequestError(err.Error()))
		return
	}
	submission, err := h.service.CreateArticleSubmission(ctx, c.Param("id"), &req)
	if err != nil {
		c.Error(err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"success": true, "data": submission})
}

func (h *MobileSubmissionHandler) CreateFileSubmission(c *gin.Context) {
	ctx, ok := requestTenantContext(c)
	if !ok {
		return
	}
	file, err := c.FormFile("file")
	if err != nil {
		c.Error(errors.NewBadRequestError("file is required").WithDetails(err.Error()))
		return
	}
	if fileName := c.PostForm("fileName"); fileName != "" {
		file.Filename = fileName
	}
	submission, err := h.service.CreateFileSubmission(
		ctx,
		c.Param("id"),
		file,
		c.PostForm("title"),
		c.PostForm("material_type"),
		c.PostForm("note"),
	)
	if err != nil {
		c.Error(err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"success": true, "data": submission})
}

func (h *MobileSubmissionHandler) ListSubmissions(c *gin.Context) {
	ctx, ok := requestTenantContext(c)
	if !ok {
		return
	}
	page := &types.Pagination{
		Page:     parsePositiveInt(c.Query("page"), 1),
		PageSize: parsePositiveInt(c.Query("page_size"), 20),
	}
	filter := types.MobileSubmissionListFilter{Status: c.Query("status")}
	if kbID := c.Query("knowledge_base_id"); kbID != "" {
		filter.KnowledgeBaseIDs = []string{kbID}
	}
	result, err := h.service.ListSubmissions(ctx, page, filter)
	if err != nil {
		c.Error(err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": result})
}

func requestTenantContext(c *gin.Context) (context.Context, bool) {
	tenantID := c.GetUint64(types.TenantIDContextKey.String())
	if tenantID == 0 {
		c.Error(errors.NewUnauthorizedError("Unauthorized"))
		return nil, false
	}
	return context.WithValue(c.Request.Context(), types.TenantIDContextKey, tenantID), true
}

func parsePositiveInt(value string, fallback int) int {
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed < 1 {
		return fallback
	}
	return parsed
}
