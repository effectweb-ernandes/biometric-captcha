/**
 * server.js - Backend de analise biometrica
 * Stack: Node.js + Express + JWT
 * Instalar: npm install express jsonwebtoken helmet cors express-rate-limit
 */
const express   = require('express');
const jwt       = require('jsonwebtoken');
const helmet    = require('helmet');
const cors      = require('cors');
const rateLimit = require('express-rate-limit');

const config = {
  port: process.env.PORT || 3001,
  jwt: { secret: process.env.JWT_SECRET || 'troque-em-producao', expiresIn: '10m' },
  thresholds: { block: 20, suspect: 45, pass: 45 }
};

const app = express();
app.use(helmet());
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json({ limit: '50kb' }));

const limiter = rateLimit({ windowMs: 60000, max: 20 });

function analyzeMetrics(metrics) {
  if (!metrics) return { score: 0, flags: ['NO_METRICS'] };
  const flags = [];
  let score = 0;

  // 1. Variancia de keystrokes (35 pontos)
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

  // 2. Velocidade media de digitacao (20 pontos)
  const avg = ks.mean || 0;
  if (avg > 150) score += 20;
  else if (avg > 80) score += 14;
  else if (avg > 40) score += 6;
  else flags.push('TYPING_TOO_FAST');

  // 3. Erros de digitacao (20 pontos)
  const bp = metrics.session?.backspaceCount || 0;
  if (bp >= 3) score += 20;
  else if (bp >= 1) score += 12;
  else flags.push('NO_TYPING_ERRORS');

  // 4. Comportamento do mouse (15 pontos)
  const mouse = metrics.mouse || {};
  if (mouse.sampleCount > 20) {
    if (mouse.cv > 0.4) score += 15;
    else if (mouse.cv > 0.2) score += 8;
    else flags.push('MOUSE_TOO_LINEAR');
  } else {
    flags.push('NO_MOUSE_DATA');
  }

  // 5. Transicoes entre campos (10 pontos)
  const ft = metrics.fieldTransitions || {};
  if (ft.std > 300) score += 10;
  else if (ft.std > 100) score += 6;
  else if (ft.std < 10 && ft.events?.length > 1) flags.push('FIELD_TRANSITIONS_TOO_UNIFORM');

  // Penalidades
  if (metrics.session?.pasteCount > 0 && metrics.session?.keystrokeCount < 5) {
    flags.push('PASTE_WITHOUT_TYPING');
    score = Math.max(0, score - 20);
  }
  const sessionSec = (metrics.session?.duration || 0) / 1000;
  const keyCount = metrics.session?.keystrokeCount || 0;
  if (keyCount > 20 && sessionSec < 2) { flags.push('IMPOSSIBLE_SPEED'); score = 0; }

  return { score: Math.min(Math.max(score, 0), 100), flags };
}

function detectTampering(localScore, serverScore) {
  return Math.abs(localScore - serverScore) > 30 ? { tampered: true } : { tampered: false };
}

// Rota de analise biometrica
app.post('/api/captcha/analyze', limiter, async (req, res) => {
  try {
    const { metrics, localScore, userAgent } = req.body;
    if (!metrics || typeof localScore !== 'number') return res.status(400).json({ error: 'Payload invalido.' });

    const analysis = analyzeMetrics(metrics);
    const tamper = detectTampering(localScore, analysis.score);
    if (tamper.tampered) { analysis.flags.push('CLIENT_SCORE_TAMPERED'); analysis.score = Math.max(0, analysis.score - 40); }

    let decision;
    if (analysis.score <= config.thresholds.block) decision = 'BLOCK';
    else if (analysis.score <= config.thresholds.suspect) decision = 'CHALLENGE';
    else decision = 'PASS';

    const token = jwt.sign(
      { decision, score: analysis.score, flags: analysis.flags, ip: req.ip },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn }
    );

    return res.json({ token, decision, score: analysis.score });
  } catch (err) {
    console.error('[CAPTCHA]', err);
    return res.status(500).json({ error: 'Erro interno.' });
  }
});

// Rota de verificacao do token (usada pelo backend principal)
app.post('/api/captcha/verify', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ valid: false });
  try {
    const decoded = jwt.verify(token, config.jwt.secret);
    if (decoded.decision === 'BLOCK') return res.status(403).json({ valid: false, score: decoded.score });
    return res.json({ valid: true, decision: decoded.decision, score: decoded.score, flags: decoded.flags });
  } catch (err) {
    return res.status(401).json({ valid: false, error: 'Token invalido ou expirado.' });
  }
});

app.listen(config.port, () => console.log('[CAPTCHA Server] Porta ' + config.port));
module.exports = app;
