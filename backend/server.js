/**
 * server.js v2.0 - Backend de analise biometrica
 * Stack: Node.js + Express + JWT
 *
 * Novidades v2.0:
 *  - Rota /health para monitoramento
 *  - Logging estruturado (JSON) para integracao com PostgreSQL
 *  - Verificacao de IP bloqueado antes de analisar
 *  - Thresholds configurados via variaveis de ambiente
 *  - Suporte a metricas mobile (touch)
 *  - Penalidade para paste-without-typing e autofill
 *  - Cabecalhos de seguranca aprimorados
 *
 * Instalar: npm install express jsonwebtoken helmet cors express-rate-limit
 */
const express   = require('express');
const jwt       = require('jsonwebtoken');
const helmet    = require('helmet');
const cors      = require('cors');
const rateLimit = require('express-rate-limit');

// ── Configuracao ──────────────────────────────────────────────────────────────

const config = {
  port: parseInt(process.env.PORT || '3001'),
  jwt: {
    secret:    process.env.JWT_SECRET || 'troque-em-producao',
    expiresIn: process.env.JWT_EXPIRES || '10m',
  },
  thresholds: {
    block:   parseInt(process.env.THRESHOLD_BLOCK   || '20'),
    suspect: parseInt(process.env.THRESHOLD_SUSPECT || '45'),
  },
  cors: {
    origin: process.env.ALLOWED_ORIGIN || '*',
  },
};

// ── App ───────────────────────────────────────────────────────────────────────

const app = express();

app.use(helmet());
app.use(cors({ origin: config.cors.origin }));
app.use(express.json({ limit: '50kb' }));
app.set('trust proxy', 1); // necessario atras de nginx/load balancer

// Rate limiting
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas requisicoes. Tente novamente em breve.' },
});

// ── Logging estruturado ───────────────────────────────────────────────────────

function log(level, event, data = {}) {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...data,
  }));
}

// ── IPs bloqueados em memoria (substituir por DB em producao) ─────────────────

const blockedIPs = new Map(); // ip -> { reason, expiresAt }

function isBlocked(ip) {
  const entry = blockedIPs.get(ip);
  if (!entry) return false;
  if (entry.expiresAt && Date.now() > entry.expiresAt) {
    blockedIPs.delete(ip);
    return false;
  }
  return true;
}

function blockIP(ip, reason, durationMs = 24 * 60 * 60 * 1000) {
  blockedIPs.set(ip, { reason, expiresAt: Date.now() + durationMs });
  log('WARN', 'ip_blocked', { ip, reason });
}

// ── Motor de analise ──────────────────────────────────────────────────────────

function analyzeMetrics(metrics) {
  if (!metrics) return { score: 0, flags: ['NO_METRICS'] };

  const flags = [];
  let score = 0;

  // 1. Variancia de keystrokes (35 pts)
  const ks = metrics.keystroke || {};
  const cv = ks.cv || 0;
  if (cv > 0.5) score += 35;
  else if (cv > 0.3) score += 25;
  else if (cv > 0.1) score += 12;
  else flags.push('KEYSTROKE_TOO_UNIFORM');

  if (ks.max && ks.min && ks.min > 0 && ks.max / ks.min > 50) {
    flags.push('ARTIFICIAL_NOISE_SUSPECTED');
    score = Math.max(0, score - 15);
  }

  // 2. Velocidade media (20 pts)
  const avg = ks.mean || 0;
  if (avg > 150) score += 20;
  else if (avg > 80) score += 14;
  else if (avg > 40) score += 6;
  else flags.push('TYPING_TOO_FAST');

  // 3. Backspaces (20 pts)
  const bp = metrics.session?.backspaceCount || 0;
  if (bp >= 3) score += 20;
  else if (bp >= 1) score += 12;
  else flags.push('NO_TYPING_ERRORS');

  // 4. Mouse ou Touch (15 pts)
  const isMobile = metrics.session?.isMobile || false;
  if (isMobile) {
    const tv = metrics.touch || {};
    if (tv.eventCount > 5) {
      if (tv.cv > 0.3) score += 15;
      else if (tv.cv > 0.1) score += 8;
      else flags.push('TOUCH_TOO_UNIFORM');
    }
  } else {
    const mouse = metrics.mouse || {};
    if (mouse.sampleCount > 20) {
      if (mouse.cv > 0.4) score += 15;
      else if (mouse.cv > 0.2) score += 8;
      else flags.push('MOUSE_TOO_LINEAR');
    } else {
      flags.push('NO_MOUSE_DATA');
    }
  }

  // 5. Transicoes entre campos (10 pts)
  const ft = metrics.fieldTransitions || {};
  if (ft.std > 300) score += 10;
  else if (ft.std > 100) score += 6;
  else if (ft.std < 10 && ft.events?.length > 1) flags.push('FIELD_TRANSITIONS_TOO_UNIFORM');

  // Penalidades
  if ((metrics.session?.pasteWithoutTyping || 0) > 0) {
    flags.push('PASTE_WITHOUT_TYPING');
    score = Math.max(0, score - 25);
  }

  if (metrics.session?.autofillDetected) {
    flags.push('AUTOFILL_DETECTED');
    score = Math.max(0, score - 10);
  }

  if ((metrics.session?.pasteCount || 0) > 0 && (metrics.session?.keystrokeCount || 0) < 5) {
    flags.push('PASTE_DOMINANT');
    score = Math.max(0, score - 20);
  }

  const sessionSec = (metrics.session?.duration || 0) / 1000;
  const keyCount   = metrics.session?.keystrokeCount || 0;
  if (keyCount > 20 && sessionSec < 2) {
    flags.push('IMPOSSIBLE_SPEED');
    score = 0;
  }

  return { score: Math.min(Math.max(score, 0), 100), flags };
}

function detectTampering(localScore, serverScore) {
  return Math.abs(localScore - serverScore) > 30 ? { tampered: true } : { tampered: false };
}

// ── Rotas ─────────────────────────────────────────────────────────────────────

// Health check para monitoramento (uptime, k8s, etc.)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    blockedIPs: blockedIPs.size,
  });
});

// Analise biometrica principal
app.post('/api/captcha/analyze', limiter, async (req, res) => {
  const ip = req.ip;

  // Verifica se IP esta bloqueado
  if (isBlocked(ip)) {
    log('WARN', 'blocked_ip_request', { ip });
    return res.status(403).json({ error: 'Acesso negado.' });
  }

  try {
    const { metrics, localScore, userAgent, platform, language } = req.body;

    if (!metrics || typeof localScore !== 'number') {
      return res.status(400).json({ error: 'Payload invalido.' });
    }

    const analysis = analyzeMetrics(metrics);

    // Detecta adulteracao do score cliente
    const tamper = detectTampering(localScore, analysis.score);
    if (tamper.tampered) {
      analysis.flags.push('CLIENT_SCORE_TAMPERED');
      analysis.score = Math.max(0, analysis.score - 40);
    }

    // Decisao
    let decision;
    if (analysis.score <= config.thresholds.block)   decision = 'BLOCK';
    else if (analysis.score <= config.thresholds.suspect) decision = 'CHALLENGE';
    else decision = 'PASS';

    // Auto-bloqueia IPs com score muito baixo
    if (analysis.score <= 5) {
      blockIP(ip, 'Score critico: ' + analysis.score, 60 * 60 * 1000); // 1h
    }

    // Logging estruturado
    log('INFO', 'captcha_analysis', {
      decision,
      score: analysis.score,
      flags: analysis.flags,
      ip,
      isMobile: metrics.session?.isMobile || false,
    });

    // Gera JWT
    const token = jwt.sign(
      { decision, score: analysis.score, flags: analysis.flags, ip },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn }
    );

    return res.json({ token, decision, score: analysis.score });

  } catch (err) {
    log('ERROR', 'analyze_error', { error: err.message, ip });
    return res.status(500).json({ error: 'Erro interno.' });
  }
});

// Verificacao do token (usada pelo backend da aplicacao)
app.post('/api/captcha/verify', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ valid: false, error: 'Token ausente.' });

  try {
    const decoded = jwt.verify(token, config.jwt.secret);
    if (decoded.decision === 'BLOCK') {
      return res.status(403).json({ valid: false, score: decoded.score, flags: decoded.flags });
    }
    return res.json({ valid: true, decision: decoded.decision, score: decoded.score, flags: decoded.flags });
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ valid: false, error: 'Token expirado. Reenvie o formulario.' });
    }
    return res.status(401).json({ valid: false, error: 'Token invalido.' });
  }
});

// Rota de status dos IPs bloqueados (proteger em producao!)
app.get('/api/captcha/blocked', (req, res) => {
  const list = Array.from(blockedIPs.entries()).map(([ip, data]) => ({ ip, ...data }));
  return res.json({ count: list.length, list });
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(config.port, () => {
  log('INFO', 'server_start', { port: config.port, thresholds: config.thresholds });
});

module.exports = app;
