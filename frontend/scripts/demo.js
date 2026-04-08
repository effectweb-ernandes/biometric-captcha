/**
 * demo.js - Biometric CAPTCHA demo logic
 * Depends on: biometric-collector.js (loaded first)
 */

// ── Session state ─────────────────────────────────────────────────────────────

var keystrokeIntervals = [];   // interval (ms) between consecutive keydowns
var lastKeyTime        = 0;    // timestamp of last keydown event
var lastNonTabKeyTime  = 0;    // timestamp of last non-Tab keydown (used for Tab-transition timing)
var backspaceCount     = 0;    // number of backspace presses
var keystrokeCount     = 0;    // total keystrokes recorded
var fieldTransitions   = [];   // human transition times (lastNonTabKeyTime→mousedown or →Tab), for variance scoring
var lastBlurTime       = 0;    // timestamp of last blur event
var rhythmBars         = [];   // DOM bar elements in the timeline
var botRunning         = false;
var isHuman            = true;

var bigramMap          = {};   // bigram pair → array of inter-key intervals
var lastBigramKey      = null; // previous printable key (for bigram construction)
var fieldFirstKeyDelay = {};   // fieldIndex → delay from focus to first key
var fieldFirstKeySet   = {};   // fieldIndex → boolean (first key already recorded)
var fieldFocusTime     = {};   // fieldIndex → focus timestamp
var fieldIntervals     = {};   // fieldIndex → array of keystroke intervals in that field
var backspaceTimes     = [];   // timestamps of each backspace (for regularity analysis)

var suspiciousFocusEvents  = []; // programmatic focus records (no mousedown/Tab before focus)
var lastMouseDownTime      = 0;  // last mousedown timestamp (0 = never set)
var lastTabTime            = 0;  // last Tab keydown timestamp (0 = never set)
var focusCount             = 0;  // total focus events this session (first is exempt)
var syntheticEventDetected = false; // synthetic (non-isTrusted) mouse/keyboard event detected

// ── Utility functions ─────────────────────────────────────────────────────────

function mean(arr) {
  return arr.length ? arr.reduce(function(a, b) { return a + b; }, 0) / arr.length : 0;
}

function stdDev(arr) {
  if (arr.length < 2) return 0;
  var m = mean(arr);
  return Math.sqrt(arr.map(function(x) { return (x - m) * (x - m); })
    .reduce(function(a, b) { return a + b; }, 0) / arr.length);
}

function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

// ── Timeline bar ──────────────────────────────────────────────────────────────

function addBar(ms, isBot) {
  var timeline = document.getElementById('tl');
  var height   = Math.max(3, Math.min(ms, 700) / 700 * 50);
  var bar      = document.createElement('div');
  bar.className    = 'tb';
  bar.style.height = height + 'px';
  bar.style.background = isBot ? '#f87171' : (ms < 150 ? '#f87171' : ms < 400 ? '#60a5fa' : '#4ade80');
  bar.style.flexShrink = '0';
  timeline.appendChild(bar);
  rhythmBars.push(bar);
  if (rhythmBars.length > 55) {
    var old = rhythmBars.shift();
    if (old.parentNode) old.parentNode.removeChild(old);
  }
}

// ── Log panel ─────────────────────────────────────────────────────────────────

function addLog(msg, cls) {
  var logEl = document.getElementById('log');
  var entry = document.createElement('div');
  entry.className = cls || 'li';
  var t = new Date();
  entry.textContent = t.getHours() + ':' + String(t.getMinutes()).padStart(2, '0') + ':'
    + String(t.getSeconds()).padStart(2, '0') + ' ' + msg;
  logEl.appendChild(entry);
  logEl.scrollTop = logEl.scrollHeight;
}

// ── Scoring ───────────────────────────────────────────────────────────────────

function calculateScore() {
  if (keystrokeIntervals.length < 4) return 0;

  var cv  = mean(keystrokeIntervals) > 0 ? stdDev(keystrokeIntervals) / mean(keystrokeIntervals) : 0;
  var avg = mean(keystrokeIntervals);
  var s   = 0;

  // 1. Keystroke variance (25 pts)
  if (cv > 0.5) s += 25; else if (cv > 0.3) s += 18; else if (cv > 0.1) s += 9;

  // 2. Average speed (15 pts)
  if (avg > 150) s += 15; else if (avg > 80) s += 10; else if (avg > 40) s += 5;

  // 3. Backspaces (10 pts)
  if (backspaceCount >= 3) s += 10; else if (backspaceCount >= 1) s += 6;

  // 4. Field transitions variance (5 pts)
  if (fieldTransitions.length >= 1) {
    var transitionStd = stdDev(fieldTransitions);
    if (transitionStd > 300) s += 5; else if (transitionStd > 100) s += 3;
  }

  // 5. Bigrams (15 pts)
  var repeatedBigrams = Object.values(bigramMap).filter(function(a) { return a.length >= 3; });
  var highVarianceBigrams = repeatedBigrams.filter(function(a) {
    var m = mean(a); return m > 0 && stdDev(a) / m > 0.2;
  }).length;
  var lowVarianceBigrams = repeatedBigrams.filter(function(a) {
    var m = mean(a); return m > 0 && stdDev(a) / m < 0.1;
  }).length;
  if (highVarianceBigrams > 0) s += 15;
  else if (repeatedBigrams.length > 0 && lowVarianceBigrams === 0) s += 8;

  // 6. Rhythm curve (10 pts)
  var third = Math.floor(keystrokeIntervals.length / 3);
  if (third >= 2) {
    var rhythmSegments = [
      mean(keystrokeIntervals.slice(0, third)),
      mean(keystrokeIntervals.slice(third, 2 * third)),
      mean(keystrokeIntervals.slice(2 * third)),
    ];
    var rhythmVariance = stdDev(rhythmSegments);
    if (rhythmVariance > 20) s += 10; else if (rhythmVariance > 10) s += 5;
  }

  // 7. Honeypot timing (10 pts)
  var delays    = Object.values(fieldFirstKeyDelay);
  var humanDelays = delays.filter(function(d) { return d >= 100 && d <= 1500; }).length;
  if (delays.length > 0) {
    if (humanDelays === delays.length) s += 10; else if (humanDelays > 0) s += 5;
  }

  // ── Penalties ────────────────────────────────────────────────────────────────

  // Long text with zero backspaces
  if (keystrokeCount >= 50 && backspaceCount === 0) s = Math.max(0, s - 15);

  // Uniform bigrams
  if (repeatedBigrams.length > 0 && lowVarianceBigrams > highVarianceBigrams) s = Math.max(0, s - 15);

  // Cross-field speed uniformity
  var fieldMeans = Object.values(fieldIntervals)
    .filter(function(a) { return a.length >= 3; })
    .map(function(a) { return mean(a); });
  if (fieldMeans.length >= 2) {
    var fieldMeanCV = mean(fieldMeans) > 0 ? stdDev(fieldMeans) / mean(fieldMeans) : 0;
    if (fieldMeanCV < 0.05) s = Math.max(0, s - 10);
  }

  // Instant typing
  if (delays.filter(function(d) { return d < 50; }).length > 0) s = Math.max(0, s - 15);

  // Synthetic events or programmatic focus → hard block
  if (suspiciousFocusEvents.length > 0 || syntheticEventDetected) return 0;

  // Fast human transition (< 300ms)
  var fastTransitions = fieldTransitions.filter(function(j) { return j > 0 && j < 300; }).length;
  s = Math.max(0, s - 15 * fastTransitions);

  // Artificially random CV with suspiciously regular backspaces
  if (cv > 0.95 && backspaceTimes.length >= 3) {
    var backspaceIntervals = [];
    for (var i = 1; i < backspaceTimes.length; i++) {
      backspaceIntervals.push(backspaceTimes[i] - backspaceTimes[i - 1]);
    }
    var backspaceCv = mean(backspaceIntervals) > 0 ? stdDev(backspaceIntervals) / mean(backspaceIntervals) : 1;
    if (backspaceCv < 0.15) s = Math.max(0, s - 10);
  }

  return Math.min(s, 100);
}

// ── UI update ─────────────────────────────────────────────────────────────────

function updateUI() {
  var cv  = mean(keystrokeIntervals) > 0 ? stdDev(keystrokeIntervals) / mean(keystrokeIntervals) : 0;
  var avg = mean(keystrokeIntervals);

  document.getElementById('mcv').textContent   = keystrokeIntervals.length > 1 ? cv.toFixed(2) : '--';
  document.getElementById('mavg').textContent  = keystrokeIntervals.length > 1 ? Math.round(avg) + 'ms' : '--';
  document.getElementById('mbp').textContent   = backspaceCount;
  document.getElementById('mkeys').textContent = keystrokeCount;

  var transEl = document.getElementById('mtrans');
  if (transEl) {
    if (syntheticEventDetected) {
      transEl.textContent  = 'BOT (evento sintetico)';
      transEl.style.color  = '#dc2626';
    } else if (suspiciousFocusEvents.length > 0) {
      transEl.textContent  = 'BOT (sem interacao)';
      transEl.style.color  = '#dc2626';
    } else if (fieldTransitions.length > 0) {
      var avgTrans = Math.round(mean(fieldTransitions));
      transEl.textContent = avgTrans + 'ms media';
      transEl.style.color = fieldTransitions.filter(function(j) { return j < 300; }).length > 0 ? '#d97706' : '';
    } else {
      transEl.textContent = '--';
      transEl.style.color = '';
    }
  }

  var sc  = calculateScore();
  var bar = document.getElementById('sbar');
  document.getElementById('spct').textContent = sc + '%';
  bar.style.width      = sc + '%';
  bar.style.background = sc >= 80 ? '#16a34a' : sc >= 60 ? '#d97706' : '#dc2626';

  var verdict = document.getElementById('verd');
  if (keystrokeIntervals.length < 4) {
    verdict.style.cssText = 'background:#f5f5f5;color:#999';
    verdict.textContent   = 'Aguardando mais dados...';
  } else if (sc >= 80) {
    verdict.style.cssText = 'background:#f0fdf4;color:#166534';
    verdict.textContent   = 'Humano -- padrao organico detectado';
  } else if (sc >= 60) {
    verdict.style.cssText = 'background:#fffbeb;color:#92400e';
    verdict.textContent   = 'Suspeito -- padrao ambiguo';
  } else {
    verdict.style.cssText = 'background:#fef2f2;color:#991b1b';
    verdict.textContent   = 'BOT DETECTADO -- timing uniforme demais';
  }
}

// ── Field event listeners ─────────────────────────────────────────────────────

['fn', 'fe', 'ft', 'fm'].forEach(function(id, idx) {
  var el = document.getElementById(id);

  el.addEventListener('mousedown', function(e) {
    if (e.isTrusted) {
      lastMouseDownTime = performance.now();
    } else {
      syntheticEventDetected = true;
      addLog('Campo ' + (idx + 1) + ': evento sintetico detectado ⚠ BOT', 'lb');
      updateUI();
    }
  });

  el.addEventListener('touchstart', function(e) {
    if (e.isTrusted) {
      lastMouseDownTime = performance.now();
    } else {
      syntheticEventDetected = true;
      addLog('Campo ' + (idx + 1) + ': evento sintetico detectado ⚠ BOT', 'lb');
      updateUI();
    }
  }, { passive: true });

  el.addEventListener('focus', function() {
    var now     = performance.now();
    fieldFocusTime[idx] = now;
    focusCount++;
    var isFirst = (focusCount === 1); // first focus in session is exempt (page load / autofocus)

    var type = lastMouseDownTime > 0 && (now - lastMouseDownTime) < 500 ? 'mouse'
             : lastTabTime > 0      && (now - lastTabTime)       < 500 ? 'tab'
             : 'none';

    if (!isFirst) {
      if (type === 'none') {
        suspiciousFocusEvents.push(0);
        addLog('Campo ' + (idx + 1) + ': foco programatico ⚠ BOT', 'lb');
        updateUI();
      } else {
        // Real transition time: from last keystroke to the human event that caused focus
        // Tab: use lastNonTabKeyTime because lastTabTime === lastKeyTime when Tab is pressed
        var trans = type === 'mouse'
          ? (lastKeyTime > 0 ? lastMouseDownTime - lastKeyTime : null)
          : (lastNonTabKeyTime > 0 ? lastTabTime - lastNonTabKeyTime : null);
        var transStr = trans !== null ? ' (' + Math.round(trans) + 'ms)' : '';
        if (trans !== null && trans > 0) fieldTransitions.push(trans);
        if (type === 'mouse') {
          addLog('Campo ' + (idx + 1) + ': foco via mouse' + transStr + ' ✓', 'lh');
        } else {
          var sym = trans !== null && trans < 300 ? ' ⚠' : ' ✓';
          addLog('Campo ' + (idx + 1) + ': foco via Tab' + transStr + sym, 'lh');
        }
      }
    }
    lastBlurTime = now;
  });

  el.addEventListener('blur', function() { lastBlurTime = performance.now(); });

  el.addEventListener('keydown', function(e) {
    if (!isHuman) return;
    keystrokeCount++;
    var now = performance.now();

    if (e.key === 'Tab') {
      if (e.isTrusted) {
        lastTabTime = now;
      } else {
        syntheticEventDetected = true;
        addLog('Campo ' + (idx + 1) + ': Tab sintetico ⚠ BOT', 'lb');
      }
    } else {
      lastNonTabKeyTime = now;
    }

    if (e.key === 'Backspace') {
      backspaceCount++;
      backspaceTimes.push(now);
      addLog('Backspace #' + backspaceCount, 'lh');
    }

    var isPrintable = e.key.length === 1;
    if (lastKeyTime > 0) {
      var interval = now - lastKeyTime;
      if (interval < 3000) {
        keystrokeIntervals.push(interval);
        addBar(interval, false);
        if (!fieldIntervals[idx]) fieldIntervals[idx] = [];
        fieldIntervals[idx].push(interval);
        if (isPrintable && lastBigramKey !== null) {
          var pair = lastBigramKey + e.key;
          if (!bigramMap[pair]) bigramMap[pair] = [];
          bigramMap[pair].push(interval);
        }
      }
    }

    if (!fieldFirstKeySet[idx] && fieldFocusTime[idx] !== undefined) {
      fieldFirstKeyDelay[idx] = now - fieldFocusTime[idx];
      fieldFirstKeySet[idx]   = true;
    }

    lastBigramKey = isPrintable ? e.key : null;
    lastKeyTime   = now;
    updateUI();

    var badge = document.getElementById('badge');
    badge.className   = 'badge bh';
    badge.textContent = 'modo humano';
    if (keystrokeCount === 1) addLog('Iniciou digitacao', 'lh');
  });
});

// ── Email validation ───────────────────────────────────────────────────────────

var DISPOSABLE_DOMAINS = [
  'mailinator.com', 'tempmail.com', 'guerrillamail.com', 'yopmail.com',
  'trashmail.com', 'throwam.com', 'fakeinbox.com',
];

function validateEmail(value) {
  var s = value ? value.trim() : '';
  if (!s) return { ok: false, msg: 'E-mail obrigatório' };

  var parts = s.split('@');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, msg: 'Formato inválido' };

  var domain = parts[1].toLowerCase();
  var dot    = domain.indexOf('.');
  if (dot < 1 || dot === domain.length - 1) return { ok: false, msg: 'Formato inválido' };

  for (var i = 0; i < DISPOSABLE_DOMAINS.length; i++) {
    if (domain === DISPOSABLE_DOMAINS[i] || domain.slice(-(DISPOSABLE_DOMAINS[i].length + 1)) === '.' + DISPOSABLE_DOMAINS[i]) {
      return { ok: false, msg: 'E-mail temporário não permitido' };
    }
  }
  return { ok: true, msg: '' };
}

function showEmailFeedback(ok, msg) {
  var el = document.getElementById('fe');
  var fb = document.getElementById('fe-msg');
  if (!fb) return;
  if (!el.value) {
    el.className   = '';
    fb.textContent = '';
    fb.className   = 'fe-msg';
    return;
  }
  el.className   = ok ? 'valid' : 'invalid';
  fb.textContent = ok ? '✓ E-mail valido' : msg;
  fb.className   = 'fe-msg ' + (ok ? 'ok' : 'err');
}

document.getElementById('fe').addEventListener('blur', function() {
  var result = validateEmail(this.value.trim());
  showEmailFeedback(result.ok, result.msg);
});

document.getElementById('fe').addEventListener('input', function() {
  if (!this.value) {
    this.className = '';
    var fb = document.getElementById('fe-msg');
    if (fb) { fb.textContent = ''; fb.className = 'fe-msg'; }
  }
});

// ── Bot simulation ────────────────────────────────────────────────────────────

async function runBot() {
  if (botRunning) return;
  botRunning = true;
  isHuman    = false;
  reset(false);

  var badge = document.getElementById('badge');
  badge.className   = 'badge bb';
  badge.textContent = 'bot';
  addLog('BOT iniciado -- foco programatico + digitacao 50ms', 'lb');

  var data  = [
    ['fn', 'Joao da Silva Santos'],
    ['fe', 'joao@bot.com'],
    ['ft', '11999999999'],
    ['fm', 'Mensagem automatica.'],
  ];
  var delay = 50;

  for (var i = 0; i < data.length; i++) {
    var el = document.getElementById(data[i][0]);
    el.focus(); // programmatic — no mousedown/Tab before this; focus event detects it
    await sleep(5);
    for (var j = 0; j < data[i][1].length; j++) {
      keystrokeCount++;
      var t = performance.now();
      if (lastKeyTime > 0) {
        var d = t - lastKeyTime;
        keystrokeIntervals.push(d);
        addBar(d, true);
      }
      lastKeyTime  = t;
      el.value    += data[i][1][j];
      updateUI();
      await sleep(delay);
    }
  }

  addLog(
    'BOT concluido -- CV: ' +
    (mean(keystrokeIntervals) > 0 ? (stdDev(keystrokeIntervals) / mean(keystrokeIntervals)).toFixed(3) : 0) +
    ' | Focos bot: ' + suspiciousFocusEvents.length,
    'lb'
  );
  badge.textContent = 'bot finalizado';
  botRunning        = false;
  updateUI();
}

// ── Form submit ───────────────────────────────────────────────────────────────

function submitForm() {
  var statusEl = document.getElementById('st');
  statusEl.style.display = 'block';

  if (keystrokeIntervals.length < 4) {
    statusEl.className   = 'status warn';
    statusEl.textContent = 'Digite mais antes de enviar!';
    return;
  }

  var emailResult = validateEmail(document.getElementById('fe').value.trim());
  if (!emailResult.ok) {
    statusEl.className   = 'status warn';
    statusEl.textContent = 'Por favor, informe um e-mail valido antes de enviar';
    showEmailFeedback(false, emailResult.msg);
    return;
  }

  if (syntheticEventDetected) {
    statusEl.className   = 'status err';
    statusEl.textContent = 'BOT DETECTADO -- eventos de mouse/teclado sinteticos';
    addLog('BLOQUEIO: evento sintetico (isTrusted=false) detectado', 'lb');
    return;
  }

  if (suspiciousFocusEvents.length > 0) {
    statusEl.className   = 'status err';
    statusEl.textContent = 'BOT DETECTADO -- foco em campo sem interacao do usuario';
    addLog('BLOQUEIO: foco programatico detectado em ' + suspiciousFocusEvents.length + ' campo(s)', 'lb');
    return;
  }

  var sc = calculateScore();
  if (sc >= 80) {
    statusEl.className   = 'status ok';
    statusEl.textContent = 'PASS (' + sc + '%) -- Comportamento humano confirmado!';
  } else if (sc >= 60) {
    statusEl.className   = 'status warn';
    statusEl.textContent = 'SUSPEITO (' + sc + '%) -- Verificacao adicional necessaria. Envio bloqueado.';
    addLog('BLOQUEIO: score suspeito ' + sc + '%', 'lb');
    return;
  } else {
    statusEl.className   = 'status err';
    statusEl.textContent = 'BLOCK (' + sc + '%) -- BOT detectado!';
  }

  addLog('ENVIO: ' + (sc >= 80 ? 'PASS' : 'BLOCK') + ' score:' + sc + '%', 'li');
}

// ── Reset ─────────────────────────────────────────────────────────────────────

function reset(clearFields) {
  if (clearFields === undefined) clearFields = true;

  keystrokeIntervals     = [];
  lastKeyTime            = 0;
  lastNonTabKeyTime      = 0;
  backspaceCount         = 0;
  keystrokeCount         = 0;
  fieldTransitions       = [];
  lastBlurTime           = 0;
  rhythmBars             = [];
  botRunning             = false;
  isHuman                = true;
  bigramMap              = {};
  lastBigramKey          = null;
  fieldFirstKeyDelay     = {};
  fieldFirstKeySet       = {};
  fieldFocusTime         = {};
  fieldIntervals         = {};
  backspaceTimes         = [];
  suspiciousFocusEvents  = [];
  lastMouseDownTime      = 0;
  lastTabTime            = 0;
  focusCount             = 0;
  syntheticEventDetected = false;

  document.getElementById('tl').innerHTML   = '';
  document.getElementById('mcv').textContent   = '--';
  document.getElementById('mavg').textContent  = '--';
  document.getElementById('mbp').textContent   = '0';
  document.getElementById('mkeys').textContent = '0';
  document.getElementById('spct').textContent  = '0%';
  document.getElementById('sbar').style.width  = '0%';

  var verdict = document.getElementById('verd');
  verdict.style.cssText = 'background:#f5f5f5;color:#999';
  verdict.textContent   = 'Aguardando digitacao...';

  document.getElementById('st').style.display = 'none';
  document.getElementById('log').innerHTML    = '';

  var badge = document.getElementById('badge');
  badge.className   = 'badge bi';
  badge.textContent = 'aguardando';

  if (clearFields) {
    ['fn', 'fe', 'ft', 'fm'].forEach(function(id) { document.getElementById(id).value = ''; });
    document.getElementById('fe').className = '';
    var fb = document.getElementById('fe-msg');
    if (fb) { fb.textContent = ''; fb.className = 'fe-msg'; }
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

addLog('Sistema pronto. Digite ou clique em Simular Bot.', 'li');
