# Biometric CAPTCHA

> Passive behavioral biometrics for bot detection — no images, no puzzles, no friction for the user.

---

## The Problem

Traditional visual CAPTCHAs are becoming obsolete. Modern computer vision models solve these challenges with accuracy surpassing humans.

The core question is: how do you tell a human apart from a machine without annoying the user?

The answer lies in human imperfection.

---

## The Solution: Behavioral Biometrics

Humans are chronometrically imperfect — and that imperfection is their unique signature.

While a bot fills out a form with millisecond-perfect timing, a human hesitates, makes mistakes, corrects them, speeds up and slows down in an organic and unpredictable way.

```
Bot:    field1 -50ms- field2 -50ms- field3    <- perfect timing = SUSPICIOUS
Human:  field1 -432ms- field2 -891ms- field3  <- natural variance = APPROVED
```

---

## How It Works

1. `BiometricCollector.js` passively captures keyboard, mouse, and scroll events
2. On form submission, the metrics are sent to the backend
3. The backend analyzes the data and returns a signed JWT with the decision
4. The JWT is validated before the form is processed

**Possible decisions:** PASS (score > 45) | CHALLENGE (20–45) | BLOCK (< 20)

---

## Collected Metrics

| Signal | What it reveals | Weight |
|---|---|---|
| Keystroke variance | Bots have perfect timing (CV ≈ 0) | 35% |
| Average typing speed | Bots type above 1,000 WPM | 20% |
| Backspaces used | Bots never make typos | 20% |
| Mouse variance | Bots move in a perfectly straight line | 15% |
| Field transition interval | Bots switch fields in fixed time | 10% |

---

## Detection Flags

| Flag | Description |
|---|---|
| `KEYSTROKE_TOO_UNIFORM` | No variation in keystroke interval |
| `TYPING_TOO_FAST` | Speed physically impossible for humans |
| `NO_TYPING_ERRORS` | No backspaces in long text |
| `MOUSE_TOO_LINEAR` | Mouse movement in a perfectly straight line |
| `FIELD_TRANSITIONS_TOO_UNIFORM` | Fixed time when switching fields |
| `PASTE_WITHOUT_TYPING` | Pasted everything without typing |
| `IMPOSSIBLE_SPEED` | Data volume in impossible time |
| `ARTIFICIAL_NOISE_SUSPECTED` | Simulated white noise detected |
| `CLIENT_SCORE_TAMPERED` | Client-side score has been tampered |

---

## Project Structure

```
biometric-captcha/
├── frontend/
│   ├── css/
│   │   └── style.css            ← Demo page styles
│   ├── scripts/
│   │   ├── biometric-collector.js   ← Drop-in script for your site
│   │   └── demo.js              ← Demo script
│   └── index.html               ← Full integration example
├── backend/
│   └── server.js                ← Node.js + Express + JWT API
├── database/
│   └── schema.sql               ← PostgreSQL schema with views and functions
└── README.md
```

---

## Quick Setup

### 1. Backend

```bash
cd backend
npm install express jsonwebtoken helmet cors express-rate-limit
export JWT_SECRET="your-secret-here"
node server.js
```

### 2. Database

```bash
psql -U postgres -d your_database -f database/schema.sql
```

### 3. Frontend

```html
<script src="/scripts/biometric-collector.js"></script>
<script>
  const captcha = new BiometricCollector('#your-form', {
    apiEndpoint: '/api/captcha/analyze'
  });
  captcha.init();

  document.querySelector('#your-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const token = await captcha.getToken();
    // Include the token in your request — your backend validates it before processing
  });
</script>
```

### 4. Validate the token on the backend

```js
const jwt = require('jsonwebtoken');

function validateCaptcha(token) {
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  if (decoded.decision === 'BLOCK') throw new Error('Bot detected');
  return decoded; // { decision, score, flags }
}
```

---

## Why Does It Work?

The fundamental principle is the **perfection paradox**: chronometrically perfect behavior is immediately suspicious.

Sophisticated bots that attempt to simulate human variance generally fail on two fronts:

- **Distribution**: white noise is detectable — humans follow specific distributions tied to cognition and biomechanics
- **Autocorrelation**: human typing speed has memory — a pattern impossible to fake in real time

---

## Privacy & GDPR/LGPD

- Only derived metrics are sent to the server (averages, standard deviations)
- Data can be anonymized before persisting to the database
- The schema includes a configurable automatic cleanup function
- Document the data collection in your Privacy Policy

---

## Roadmap

- [ ] SDK for React and Vue
- [ ] Mobile support (touch pressure, accelerometer)
- [ ] ML model trained on PostgreSQL logs
- [ ] Device fingerprinting (WebGL, canvas, fonts)
- [ ] Real-time monitoring dashboard
- [ ] Integration with IP blocklists (AbuseIPDB)
- [ ] Publish to npm

---

*Developed as a behavioral alternative to classic reCAPTCHA.*
*Human imperfection is the best password.*

---

## Credits

Developed with the assistance of [Claude Code](https://claude.ai/code) — Anthropic's AI assistant.
