-- Biometric CAPTCHA - Schema PostgreSQL 14+
-- Executar: psql -U postgres -d seu_banco -f database/schema.sql

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- -------------------------------------------------------
-- Tabela principal de sessoes analisadas
-- -------------------------------------------------------
CREATE TABLE IF NOT EXISTS captcha_sessions (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    ip_address      INET        NOT NULL,
    user_agent      TEXT,
    local_score     SMALLINT    NOT NULL CHECK (local_score BETWEEN 0 AND 100),
    server_score    SMALLINT    NOT NULL CHECK (server_score BETWEEN 0 AND 100),
    decision        TEXT        NOT NULL CHECK (decision IN ('PASS', 'CHALLENGE', 'BLOCK')),
    keystroke_cv    NUMERIC(6,4),
    keystroke_mean  NUMERIC(8,2),
    keystroke_std   NUMERIC(8,2),
    backspace_count SMALLINT,
    paste_count     SMALLINT,
    mouse_cv        NUMERIC(6,4),
    flags           TEXT[]      DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_captcha_ip       ON captcha_sessions (ip_address);
CREATE INDEX IF NOT EXISTS idx_captcha_decision ON captcha_sessions (decision);
CREATE INDEX IF NOT EXISTS idx_captcha_created  ON captcha_sessions (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_captcha_score    ON captcha_sessions (server_score);

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
-- View: dashboard de monitoramento por hora
-- -------------------------------------------------------
CREATE OR REPLACE VIEW captcha_dashboard AS
SELECT
    DATE_TRUNC('hour', created_at)                                          AS hour,
    COUNT(*)                                                                AS total,
    COUNT(*) FILTER (WHERE decision = 'PASS')                              AS passed,
    COUNT(*) FILTER (WHERE decision = 'CHALLENGE')                         AS challenged,
    COUNT(*) FILTER (WHERE decision = 'BLOCK')                             AS blocked,
    ROUND(AVG(server_score), 1)                                            AS avg_score,
    ROUND(100.0 * COUNT(*) FILTER (WHERE decision = 'BLOCK') / COUNT(*), 1) AS block_rate_pct
FROM captcha_sessions
GROUP BY DATE_TRUNC('hour', created_at)
ORDER BY hour DESC;

-- -------------------------------------------------------
-- View: IPs mais suspeitos nas ultimas 24h
-- -------------------------------------------------------
CREATE OR REPLACE VIEW suspicious_ips AS
SELECT
    ip_address,
    COUNT(*)                                       AS attempts,
    AVG(server_score)::NUMERIC(5,1)                AS avg_score,
    COUNT(*) FILTER (WHERE decision = 'BLOCK')     AS blocks
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
-- Funcao: limpeza de sessoes com mais de 30 dias
-- -------------------------------------------------------
CREATE OR REPLACE FUNCTION cleanup_old_sessions()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    DELETE FROM captcha_sessions WHERE created_at < NOW() - INTERVAL '30 days';
END;
$$;

-- Agendar limpeza automatica (requer pg_cron instalado):
-- SELECT cron.schedule('cleanup-captcha', '0 3 * * *', 'SELECT cleanup_old_sessions()');
-- SELECT cron.schedule('auto-block-bots', '0 * * * *', 'SELECT auto_block_suspicious_ips()');
