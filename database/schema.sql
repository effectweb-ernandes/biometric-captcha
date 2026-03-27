-- Biometric CAPTCHA v2.0 - Schema PostgreSQL 14+
-- Executar: psql -U postgres -d seu_banco -f database/schema.sql
--
-- Novidades v2.0:
--   - Colunas para metricas mobile (touch)
--   - Colunas para paste_without_typing e autofill_detected
--   - Indice GIN para busca em arrays de flags
--   - View de resumo diario (alem do hourly)
--   - View de top flags para analise de padroes
--   - Funcao de estatisticas de deteccao

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- -------------------------------------------------------
-- Tabela principal de sessoes analisadas
-- -------------------------------------------------------
CREATE TABLE IF NOT EXISTS captcha_sessions (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    ip_address          INET        NOT NULL,
    user_agent          TEXT,
    platform            TEXT,
    language            VARCHAR(10),
    is_mobile           BOOLEAN     DEFAULT FALSE,

    -- Scores
    local_score         SMALLINT    NOT NULL CHECK (local_score  BETWEEN 0 AND 100),
    server_score        SMALLINT    NOT NULL CHECK (server_score BETWEEN 0 AND 100),
    decision            TEXT        NOT NULL CHECK (decision IN ('PASS','CHALLENGE','BLOCK')),

    -- Metricas de keystroke
    keystroke_cv        NUMERIC(6,4),
    keystroke_mean      NUMERIC(8,2),
    keystroke_std       NUMERIC(8,2),
    backspace_count     SMALLINT    DEFAULT 0,
    delete_count        SMALLINT    DEFAULT 0,

    -- Metricas de comportamento suspeito
    paste_count         SMALLINT    DEFAULT 0,
    paste_without_typing SMALLINT   DEFAULT 0,
    autofill_detected   BOOLEAN     DEFAULT FALSE,

    -- Metricas de mouse/touch
    mouse_cv            NUMERIC(6,4),
    mouse_sample_count  SMALLINT,
    touch_event_count   SMALLINT,
    touch_cv            NUMERIC(6,4),

    -- Flags de deteccao (array para busca eficiente)
    flags               TEXT[]      DEFAULT '{}',

    -- Duracao da sessao em ms
    session_duration_ms INTEGER,

    created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Indices para consultas frequentes
CREATE INDEX IF NOT EXISTS idx_captcha_ip         ON captcha_sessions (ip_address);
CREATE INDEX IF NOT EXISTS idx_captcha_decision   ON captcha_sessions (decision);
CREATE INDEX IF NOT EXISTS idx_captcha_created    ON captcha_sessions (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_captcha_score      ON captcha_sessions (server_score);
CREATE INDEX IF NOT EXISTS idx_captcha_mobile     ON captcha_sessions (is_mobile);

-- Indice GIN para busca em arrays de flags (ex: WHERE 'KEYSTROKE_TOO_UNIFORM' = ANY(flags))
CREATE INDEX IF NOT EXISTS idx_captcha_flags_gin  ON captcha_sessions USING GIN (flags);

-- -------------------------------------------------------
-- Tabela de IPs bloqueados
-- -------------------------------------------------------
CREATE TABLE IF NOT EXISTS blocked_ips (
    ip_address    INET        PRIMARY KEY,
    block_reason  TEXT        NOT NULL,
    block_count   INT         DEFAULT 1,
    first_blocked TIMESTAMPTZ DEFAULT NOW(),
    last_blocked  TIMESTAMPTZ DEFAULT NOW(),
    expires_at    TIMESTAMPTZ,
    is_active     BOOLEAN     DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_blocked_active ON blocked_ips (is_active, expires_at);

-- -------------------------------------------------------
-- View: dashboard por hora
-- -------------------------------------------------------
CREATE OR REPLACE VIEW captcha_dashboard_hourly AS
SELECT
    DATE_TRUNC('hour', created_at)                                          AS hour,
    COUNT(*)                                                                AS total,
    COUNT(*) FILTER (WHERE decision = 'PASS')                              AS passed,
    COUNT(*) FILTER (WHERE decision = 'CHALLENGE')                         AS challenged,
    COUNT(*) FILTER (WHERE decision = 'BLOCK')                             AS blocked,
    COUNT(*) FILTER (WHERE is_mobile = TRUE)                               AS mobile,
    ROUND(AVG(server_score), 1)                                            AS avg_score,
    ROUND(100.0 * COUNT(*) FILTER (WHERE decision = 'BLOCK') / COUNT(*), 1) AS block_rate_pct,
    COUNT(*) FILTER (WHERE autofill_detected = TRUE)                       AS autofill_count,
    COUNT(*) FILTER (WHERE paste_without_typing > 0)                       AS paste_suspect_count
FROM captcha_sessions
GROUP BY DATE_TRUNC('hour', created_at)
ORDER BY hour DESC;

-- -------------------------------------------------------
-- View: dashboard por dia
-- -------------------------------------------------------
CREATE OR REPLACE VIEW captcha_dashboard_daily AS
SELECT
    DATE_TRUNC('day', created_at)                                           AS day,
    COUNT(*)                                                                AS total,
    COUNT(*) FILTER (WHERE decision = 'PASS')                              AS passed,
    COUNT(*) FILTER (WHERE decision = 'CHALLENGE')                         AS challenged,
    COUNT(*) FILTER (WHERE decision = 'BLOCK')                             AS blocked,
    ROUND(AVG(server_score), 1)                                            AS avg_score,
    ROUND(100.0 * COUNT(*) FILTER (WHERE decision = 'BLOCK') / COUNT(*), 1) AS block_rate_pct,
    COUNT(DISTINCT ip_address)                                             AS unique_ips
FROM captcha_sessions
GROUP BY DATE_TRUNC('day', created_at)
ORDER BY day DESC;

-- -------------------------------------------------------
-- View: top flags (quais flags aparecem mais)
-- -------------------------------------------------------
CREATE OR REPLACE VIEW captcha_top_flags AS
SELECT
    flag,
    COUNT(*) AS occurrences,
    ROUND(100.0 * COUNT(*) / (SELECT COUNT(*) FROM captcha_sessions), 2) AS pct_of_total
FROM captcha_sessions, UNNEST(flags) AS flag
GROUP BY flag
ORDER BY occurrences DESC;

-- -------------------------------------------------------
-- View: IPs suspeitos nas ultimas 24h
-- -------------------------------------------------------
CREATE OR REPLACE VIEW suspicious_ips AS
SELECT
    ip_address,
    COUNT(*)                                       AS attempts,
    AVG(server_score)::NUMERIC(5,1)                AS avg_score,
    COUNT(*) FILTER (WHERE decision = 'BLOCK')     AS blocks,
    COUNT(*) FILTER (WHERE is_mobile = TRUE)       AS mobile_attempts,
    MAX(created_at)                                AS last_seen
FROM captcha_sessions
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY ip_address
HAVING COUNT(*) FILTER (WHERE decision = 'BLOCK') > 2
ORDER BY blocks DESC, avg_score ASC;

-- -------------------------------------------------------
-- Funcao: auto-bloquear IPs com muitas deteccoes em 1h
-- -------------------------------------------------------
CREATE OR REPLACE FUNCTION auto_block_suspicious_ips()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO blocked_ips (ip_address, block_reason, block_count, expires_at)
    SELECT
        ip_address,
        'Auto: ' || COUNT(*) || ' deteccoes em 1h',
        COUNT(*),
        NOW() + INTERVAL '24 hours'
    FROM captcha_sessions
    WHERE decision = 'BLOCK' AND created_at > NOW() - INTERVAL '1 hour'
    GROUP BY ip_address
    HAVING COUNT(*) >= 5
    ON CONFLICT (ip_address) DO UPDATE SET
        block_count  = blocked_ips.block_count + EXCLUDED.block_count,
        last_blocked = NOW(),
        expires_at   = NOW() + INTERVAL '24 hours',
        is_active    = TRUE;
END;
$$;

-- -------------------------------------------------------
-- Funcao: estatisticas gerais de deteccao
-- -------------------------------------------------------
CREATE OR REPLACE FUNCTION captcha_stats(periodo INTERVAL DEFAULT INTERVAL '7 days')
RETURNS TABLE (
    metrica TEXT,
    valor   NUMERIC
) LANGUAGE plpgsql AS $$
BEGIN
    RETURN QUERY
    SELECT 'total_sessoes'::TEXT,     COUNT(*)::NUMERIC FROM captcha_sessions WHERE created_at > NOW() - periodo
    UNION ALL
    SELECT 'taxa_block_pct',          ROUND(100.0 * COUNT(*) FILTER (WHERE decision='BLOCK') / NULLIF(COUNT(*),0), 2) FROM captcha_sessions WHERE created_at > NOW() - periodo
    UNION ALL
    SELECT 'score_medio',             ROUND(AVG(server_score), 1) FROM captcha_sessions WHERE created_at > NOW() - periodo
    UNION ALL
    SELECT 'total_mobile',            COUNT(*) FILTER (WHERE is_mobile=TRUE)::NUMERIC FROM captcha_sessions WHERE created_at > NOW() - periodo
    UNION ALL
    SELECT 'ips_unicos',              COUNT(DISTINCT ip_address)::NUMERIC FROM captcha_sessions WHERE created_at > NOW() - periodo
    UNION ALL
    SELECT 'autofill_detectado',      COUNT(*) FILTER (WHERE autofill_detected=TRUE)::NUMERIC FROM captcha_sessions WHERE created_at > NOW() - periodo
    UNION ALL
    SELECT 'paste_suspeito',          COUNT(*) FILTER (WHERE paste_without_typing>0)::NUMERIC FROM captcha_sessions WHERE created_at > NOW() - periodo;
END;
$$;

-- -------------------------------------------------------
-- Funcao: limpeza de sessoes antigas
-- -------------------------------------------------------
CREATE OR REPLACE FUNCTION cleanup_old_sessions(manter_dias INT DEFAULT 30)
RETURNS INT LANGUAGE plpgsql AS $$
DECLARE
    deleted INT;
BEGIN
    DELETE FROM captcha_sessions WHERE created_at < NOW() - (manter_dias || ' days')::INTERVAL;
    GET DIAGNOSTICS deleted = ROW_COUNT;
    RETURN deleted;
END;
$$;

-- Agendar automacao (requer pg_cron):
-- SELECT cron.schedule('cleanup-captcha',    '0 3 * * *', 'SELECT cleanup_old_sessions()');
-- SELECT cron.schedule('auto-block-bots',    '0 * * * *', 'SELECT auto_block_suspicious_ips()');

-- Exemplos de consulta:
-- SELECT * FROM captcha_dashboard_daily LIMIT 7;
-- SELECT * FROM captcha_top_flags LIMIT 10;
-- SELECT * FROM captcha_stats(INTERVAL '30 days');
-- SELECT * FROM suspicious_ips;
-- SELECT * FROM captcha_sessions WHERE 'KEYSTROKE_TOO_UNIFORM' = ANY(flags) LIMIT 20;
