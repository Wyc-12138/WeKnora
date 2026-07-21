CREATE TABLE IF NOT EXISTS mobile_submissions (
    id VARCHAR(36) PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    knowledge_base_id VARCHAR(36) NOT NULL,
    kind VARCHAR(32) NOT NULL,
    title VARCHAR(512) NOT NULL,
    source_url VARCHAR(2048),
    file_name VARCHAR(512),
    file_type VARCHAR(64),
    file_size BIGINT NOT NULL DEFAULT 0,
    file_path VARCHAR(2048),
    note TEXT,
    metadata JSONB,
    status VARCHAR(32) NOT NULL DEFAULT 'pending_review',
    knowledge_id VARCHAR(36),
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_mobile_submissions_tenant_created
    ON mobile_submissions (tenant_id, created_at DESC)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_mobile_submissions_kb_status
    ON mobile_submissions (knowledge_base_id, status)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_mobile_submissions_knowledge_id
    ON mobile_submissions (knowledge_id)
    WHERE deleted_at IS NULL AND knowledge_id <> '';
