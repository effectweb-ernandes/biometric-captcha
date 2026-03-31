/**
 * server.js v2.0 - Biometric analysis backend
 * Stack: Node.js + Express + JWT
 *
 * What's new in v2.0:
 *  - /health route for monitoring
 *  - Structured logging (JSON) for PostgreSQL integration
 *  - Blocked IP check before analysis
 *  - Thresholds configured via environment variables
 *  - Mobile metrics support (touch)
 *  - Penalty for paste-without-typing and autofill
 *  - Enhanced security headers
 *
 * Install: npm install express jsonwebtoken helmet cors express-rate-limit
 */
const express   = require('express');
const jwt       = require('jsonwebtoken');
const helmet    = require('helmet');
const cors      = require('cors');
const rateLimit = require('express-rate-limit');

// ── Configuration ─────────────────────────────────────────────────────────────

const config = {
  port: parseInt(process.env.PORT || '3001'),
  jwt: {
    secret:    process.env.JWT_SECRET || 'troque-em-producao',
    expiresIn: process.env.JWT_EXPIRES || '10m',
  },
  thresholds: {
    block:   parseInt(process.env.THRESHOLD_BLOCK   || '25'),
    suspect: parseInt(process.env.THRESHOLD_SUSPECT || '65'),
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
app.set('trust proxy', 1); // required behind nginx/load balancer

// Rate limiting
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas requisicoes. Tente novamente em breve.' },
});

// ── Structured logging ────────────────────────────────────────────────────────

function log(level, event, data = {}) {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...data,
  }));
}

// ── In-memory blocked IPs (replace with DB in production) ─────────────────────

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

// ── Analysis engine ───────────────────────────────────────────────────────────

function analyzeMetrics(metrics) {
  if (!metrics) return { score: 0, flags: ['NO_METRICS'] };

  const flags = [];
  let score = 0;

  // 1. Keystroke variance (25 pts)
  const ks  = metrics.keystroke || {};
  const cv  = ks.cv || 0;
  if (cv > 0.5) score += 25;
  else if (cv > 0.3) score += 18;
  else if (cv > 0.1) score += 9;
  else flags.push('KEYSTROKE_TOO_UNIFORM');

  if (ks.max && ks.min && ks.min > 0 && ks.max / ks.min > 50) {
    flags.push('ARTIFICIAL_NOISE_SUSPECTED');
    score = Math.max(0, score - 15);
  }

  // 2. Average speed (15 pts)
  const avg = ks.mean || 0;
  if (avg > 150) score += 15;
  else if (avg > 80) score += 10;
  else if (avg > 40) score += 5;
  else flags.push('TYPING_TOO_FAST');

  // 3. Backspaces (10 pts)
  const bp       = metrics.session?.backspaceCount || 0;
  const keyCount = metrics.session?.keystrokeCount || 0;
  if (bp >= 3) score += 10;
  else if (bp >= 1) score += 6;
  else flags.push('NO_TYPING_ERRORS');

  if (keyCount >= 50 && bp === 0) {
    flags.push('NO_ERRORS_LONG_TEXT');
    score = Math.max(0, score - 15);
  }

  // 4. Mouse or Touch (10 pts)
  const isMobile = metrics.session?.isMobile || false;
  if (isMobile) {
    const tv = metrics.touch || {};
    if (tv.eventCount > 5) {
      if (tv.cv > 0.3) score += 10;
      else if (tv.cv > 0.1) score += 5;
      else flags.push('TOUCH_TOO_UNIFORM');
    }
  } else {
    const mouse = metrics.mouse || {};
    if (mouse.sampleCount > 20) {
      if (mouse.cv > 0.4) score += 10;
      else if (mouse.cv > 0.2) score += 6;
      else flags.push('MOUSE_TOO_LINEAR');
    } else {
      flags.push('NO_MOUSE_DATA');
    }
  }

  // 5. Field transitions (5 pts)
  const ft = metrics.fieldTransitions || {};
  if (ft.std > 300) score += 5;
  else if (ft.std > 100) score += 3;
  else if (ft.std < 10 && ft.events?.length > 1) flags.push('FIELD_TRANSITIONS_TOO_UNIFORM');

  // 6. Bigram analysis (15 pts)
  const bg = metrics.bigrams || {};
  if (bg.highVarianceCount > 0) score += 15;
  else if (bg.repeatedCount > 0 && bg.lowVarianceCount === 0) score += 8;

  if (bg.repeatedCount > 0 && bg.lowVarianceCount > bg.highVarianceCount) {
    flags.push('BIGRAM_TOO_UNIFORM');
    score = Math.max(0, score - 15);
  }

  // 7. Rhythm curve (10 pts)
  const rhythm = metrics.rhythm || {};
  if (rhythm.variance > 20) score += 10;
  else if (rhythm.variance > 10) score += 5;
  else if ((rhythm.variance || 0) === 0 && keyCount > 20) {
    flags.push('FLAT_RHYTHM_CURVE');
    score = Math.max(0, score - 10);
  }

  // 8. Honeypot timing (10 pts)
  const honeypot = metrics.honeypot || {};
  const delays   = honeypot.firstKeyDelays || [];
  if (delays.length > 0) {
    const humanDelays   = delays.filter(d => d >= 100 && d <= 1500).length;
    const instantDelays = delays.filter(d => d < 50).length;
    if (humanDelays === delays.length) score += 10;
    else if (humanDelays > 0) score += 5;
    if (instantDelays > 0) {
      flags.push('INSTANT_TYPING_DETECTED');
      score = Math.max(0, score - 15);
    }
  }

  // Cross-field correlation penalty
  const crossField = metrics.crossField || {};
  if (crossField.fieldCount >= 2 && (crossField.fieldMeanCV || 0) < 0.05) {
    flags.push('UNIFORM_CROSS_FIELD_SPEED');
    score = Math.max(0, score - 10);
  }

  // Existing penalties
  if ((metrics.session?.pasteWithoutTyping || 0) > 0) {
    flags.push('PASTE_WITHOUT_TYPING');
    score = Math.max(0, score - 25);
  }

  if (metrics.session?.autofillDetected && !metrics.session?.autofillIsHuman) {
    flags.push('AUTOFILL_DETECTED');
    score = Math.max(0, score - 10);
  }

  if ((metrics.session?.pasteCount || 0) > 0 && keyCount < 5) {
    flags.push('PASTE_DOMINANT');
    score = Math.max(0, score - 20);
  }

  const sessionSec = (metrics.session?.duration || 0) / 1000;
  if (keyCount > 20 && sessionSec < 2) {
    flags.push('IMPOSSIBLE_SPEED');
    score = 0;
  }

  return { score: Math.min(Math.max(score, 0), 100), flags };
}

function detectTampering(localScore, serverScore) {
  return Math.abs(localScore - serverScore) > 30 ? { tampered: true } : { tampered: false };
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Health check for monitoring (uptime, k8s, etc.)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    blockedIPs: blockedIPs.size,
  });
});

// Main biometric analysis
app.post('/api/captcha/analyze', limiter, async (req, res) => {
  const ip = req.ip;

  // Check if IP is blocked
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

    // Detect client score tampering
    const tamper = detectTampering(localScore, analysis.score);
    if (tamper.tampered) {
      analysis.flags.push('CLIENT_SCORE_TAMPERED');
      analysis.score = Math.max(0, analysis.score - 40);
    }

    // Decision
    let decision;
    if (analysis.score <= config.thresholds.block)   decision = 'BLOCK';
    else if (analysis.score <= config.thresholds.suspect) decision = 'CHALLENGE';
    else decision = 'PASS';

    // Auto-block IPs with very low score
    if (analysis.score <= 5) {
      blockIP(ip, 'Score critico: ' + analysis.score, 60 * 60 * 1000); // 1h
    }

    // Structured logging
    log('INFO', 'captcha_analysis', {
      decision,
      score: analysis.score,
      flags: analysis.flags,
      ip,
      isMobile: metrics.session?.isMobile || false,
    });

    // Generate JWT
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

// Token verification (used by the application backend)
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

// Blocked IPs status route (protect in production!)
app.get('/api/captcha/blocked', (req, res) => {
  const list = Array.from(blockedIPs.entries()).map(([ip, data]) => ({ ip, ...data }));
  return res.json({ count: list.length, list });
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(config.port, () => {
  log('INFO', 'server_start', { port: config.port, thresholds: config.thresholds });
});

module.exports = app;
