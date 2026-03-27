/**
 * BiometricCollector.js v2.1
 * Coleta passiva de sinais comportamentais para deteccao de bots.
 *
 * Novidades v2.1:
 *  - Deteccao avancada de autocomplete/autofill do browser
 *    distinguindo entre: humano com autocomplete vs bot que injeta valores
 *  - Crosscheck entre campos: se todos foram preenchidos sem keystroke
 *    mas houve clique/mouse/tempo adequado, eh considerado autocomplete humano
 *  - Medicao de tempo entre foco e preenchimento por campo
 *  - Deteccao de inputType para diferenciar autocomplete de injecao direta
 */
class BiometricCollector {
  constructor(formSelector, options = {}) {
    this.form = document.querySelector(formSelector);
    if (!this.form) throw new Error('Formulario nao encontrado: ' + formSelector);
    this.options = {
      apiEndpoint:    options.apiEndpoint    || '/api/captcha/analyze',
      minKeystrokes:  options.minKeystrokes  || 6,
      sessionTimeout: options.sessionTimeout || 30 * 60 * 1000,
    };

    // Keystroke
    this._keystrokeIntervals   = [];
    this._keystrokeTimestamps  = [];
    this._backspaceCount       = 0;
    this._deleteCount          = 0;
    this._lastKeyTime          = null;

    // Mouse
    this._mouseVelocities = [];
    this._mouseMovements  = [];
    this._clickEvents     = [];
    this._lastMousePos    = null;
    this._lastMouseTime   = null;

    // Touch (mobile)
    this._touchEvents     = [];
    this._touchVelocities = [];
    this._lastTouchPos    = null;
    this._lastTouchTime   = null;

    // Campos
    this._fieldTransitions    = [];
    this._fieldFocusDurations = {};
    this._fieldFocusStart     = {};
    this._activeField         = null;
    this._focusCount          = 0;
    this._fieldTypedBefore    = {};

    // Autocomplete / Autofill — core desta versao
    this._autocompleteEvents  = []; // {fieldIdx, fillTime, hadMouseBefore, hadKeystrokeBefore, inputType, suspicious}
    this._fieldValueAtFocus   = {}; // valor do campo quando recebeu foco
    this._fieldFillTime       = {}; // quando o campo foi preenchido via input sem keydown
    this._clickBeforeInput    = {}; // se houve click/touch antes do input em cada campo
    this._lastClickTime       = 0;
    this._lastTouchEndTime    = 0;

    // Comportamento suspeito
    this._pasteCount          = 0;
    this._pasteWithoutTyping  = 0;
    this._autofillDetected    = false;
    this._autofillIsHuman     = false; // autocomplete com evidencias de interacao humana
    this._botInjectionSuspect = false; // preenchimento programatico sem nenhuma interacao

    // Scroll
    this._scrollEvents = [];

    // Sessao
    this._sessionStart   = Date.now();
    this._boundHandlers  = {};
  }

  // ── Inicializacao ──────────────────────────────────────────────────────────

  init() {
    this._attachFormListeners();
    this._attachMouseListeners();
    this._attachTouchListeners();
    this._attachScrollListeners();
    this._monitorAutocomplete();
    return this;
  }

  destroy() {
    Object.entries(this._boundHandlers).forEach(([k, { el, event, fn, opts }]) => {
      el.removeEventListener(event, fn, opts);
    });
  }

  // ── Autocomplete Monitor ──────────────────────────────────────────────────
  // Esta e a parte central da v2.1:
  // Observa quando um campo muda de valor SEM evento keydown precedente,
  // e classifica se foi autocomplete humano ou injecao de bot.

  _monitorAutocomplete() {
    const fields = this.form.querySelectorAll('input, textarea, select');

    fields.forEach((field, idx) => {
      // Guarda o valor no momento do foco
      field.addEventListener('focus', () => {
        this._fieldValueAtFocus[idx] = field.value;
        this._clickBeforeInput[idx]  = (Date.now() - this._lastClickTime) < 2000
                                    || (Date.now() - this._lastTouchEndTime) < 2000;
      });

      // Monitora mudancas de valor via evento 'input'
      field.addEventListener('input', (e) => {
        const now = Date.now();

        // Se o campo mudou mas nao houve keydown recente (< 200ms),
        // provavelmente foi autocomplete ou injecao
        const msSinceLastKey = this._lastKeyTime
          ? (performance.now() - this._lastKeyTime)
          : Infinity;

        const valueChangedWithoutKey = msSinceLastKey > 200 && field.value !== this._fieldValueAtFocus[idx];

        if (valueChangedWithoutKey && field.value.length > 0) {
          this._autofillDetected = true;

          const inputType = e.inputType || 'unknown';
          // inputType === 'insertReplacementText' ou 'insertFromAutofill'
          // indicam autocomplete legitimo do browser
          const isLegitimateAutofill = [
            'insertReplacementText',
            'insertFromAutofill',
            'insertFromPaste',  // usuario colou manualmente
          ].includes(inputType);

          // Evidencias de que eh humano usando autocomplete:
          // 1. Houve clique/toque antes (usuario clicou na sugestao)
          // 2. O campo estava em foco por tempo adequado (> 300ms)
          // 3. inputType indica autocomplete legitimo do browser
          // 4. Ja houve keystroke em ALGUM campo da sessao
          const focusDuration = this._fieldFocusStart[idx]
            ? (performance.now() - this._fieldFocusStart[idx])
            : 0;

          const hasHumanEvidence =
            this._clickBeforeInput[idx]           ||  // clicou antes
            focusDuration > 300                   ||  // ficou no campo por tempo adequado
            isLegitimateAutofill                  ||  // inputType correto
            this._keystrokeTimestamps.length > 0;     // ja digitou em outro campo

          this._autocompleteEvents.push({
            fieldIdx:          idx,
            fillTimeMs:        now,
            focusDurationMs:   Math.round(focusDuration),
            inputType,
            hadClickBefore:    this._clickBeforeInput[idx] || false,
            hadKeystroke:      this._keystrokeTimestamps.length > 0,
            isLegitimateAutofill,
            isHuman:           hasHumanEvidence,
            suspicious:        !hasHumanEvidence,
          });

          if (hasHumanEvidence) {
            this._autofillIsHuman = true;
          } else {
            // Sem nenhuma evidencia de interacao humana = suspeito de bot
            this._botInjectionSuspect = true;
          }
        }
      });
    });

    // Verifica campos pre-preenchidos apos 800ms (autofill no carregamento da pagina)
    setTimeout(() => {
      const fields2 = this.form.querySelectorAll('input, textarea');
      let preFilledCount = 0;
      fields2.forEach(field => {
        if (field.value && field.value.length > 0) preFilledCount++;
      });

      if (preFilledCount > 0 && this._keystrokeTimestamps.length === 0) {
        // Campos pre-preenchidos sem nenhuma interacao ainda
        // Pode ser autofill legitimo do browser no carregamento
        // Marca como autofill mas nao como bot (aguarda mais evidencias)
        this._autofillDetected = true;
      }
    }, 800);
  }

  // ── Formulario ─────────────────────────────────────────────────────────────

  _attachFormListeners() {
    this.form.querySelectorAll('input, textarea, select').forEach((field, idx) => {
      const onFocus = () => {
        this._focusCount++;
        const now = performance.now();
        if (this._activeField !== null) {
          const prev = this._fieldFocusStart[this._activeField];
          if (prev) {
            if (!this._fieldFocusDurations[this._activeField]) this._fieldFocusDurations[this._activeField] = 0;
            this._fieldFocusDurations[this._activeField] += now - prev;
          }
          this._fieldTransitions.push({ from: this._activeField, to: idx, ts: now });
        }
        this._activeField       = idx;
        this._fieldFocusStart[idx] = now;
      };

      const onBlur = () => {
        const now = performance.now();
        if (this._activeField === idx && this._fieldFocusStart[idx]) {
          if (!this._fieldFocusDurations[idx]) this._fieldFocusDurations[idx] = 0;
          this._fieldFocusDurations[idx] += now - this._fieldFocusStart[idx];
          delete this._fieldFocusStart[idx];
        }
        this._activeField = null;
      };

      const onKeydown = (e) => {
        const now = performance.now();
        this._fieldTypedBefore[idx] = true;
        if (e.key === 'Backspace') this._backspaceCount++;
        if (e.key === 'Delete')    this._deleteCount++;
        if (this._lastKeyTime !== null) {
          const d = now - this._lastKeyTime;
          if (d < 5000) this._keystrokeIntervals.push(d);
        }
        this._keystrokeTimestamps.push(now);
        this._lastKeyTime = now;
      };

      const onPaste = () => {
        this._pasteCount++;
        if (!this._fieldTypedBefore[idx]) this._pasteWithoutTyping++;
      };

      field.addEventListener('focus',   onFocus);
      field.addEventListener('blur',    onBlur);
      field.addEventListener('keydown', onKeydown);
      field.addEventListener('paste',   onPaste);

      this._boundHandlers['focus_'   + idx] = { el: field, event: 'focus',   fn: onFocus };
      this._boundHandlers['blur_'    + idx] = { el: field, event: 'blur',    fn: onBlur };
      this._boundHandlers['key_'     + idx] = { el: field, event: 'keydown', fn: onKeydown };
      this._boundHandlers['paste_'   + idx] = { el: field, event: 'paste',   fn: onPaste };
    });
  }

  // ── Mouse ──────────────────────────────────────────────────────────────────

  _attachMouseListeners() {
    const RATE = 50;
    const onMove = (e) => {
      const now = performance.now();
      if (this._lastMousePos && this._lastMouseTime) {
        const dt = now - this._lastMouseTime;
        if (dt >= RATE) {
          const dx = e.clientX - this._lastMousePos.x;
          const dy = e.clientY - this._lastMousePos.y;
          this._mouseVelocities.push(Math.sqrt(dx*dx + dy*dy) / dt);
          this._mouseMovements.push({ x: e.clientX, y: e.clientY, t: now });
          this._lastMousePos  = { x: e.clientX, y: e.clientY };
          this._lastMouseTime = now;
        }
      } else {
        this._lastMousePos  = { x: e.clientX, y: e.clientY };
        this._lastMouseTime = now;
      }
    };
    const onClick = (e) => {
      this._lastClickTime = Date.now();
      this._clickEvents.push({ x: e.clientX, y: e.clientY, t: performance.now(), tag: e.target.tagName });
    };
    document.addEventListener('mousemove', onMove,   { passive: true });
    document.addEventListener('click',     onClick,  { passive: true });
    this._boundHandlers['mousemove'] = { el: document, event: 'mousemove', fn: onMove,  opts: { passive: true } };
    this._boundHandlers['click']     = { el: document, event: 'click',     fn: onClick, opts: { passive: true } };
  }

  // ── Touch ──────────────────────────────────────────────────────────────────

  _attachTouchListeners() {
    const onTouchStart = (e) => {
      const t = e.touches[0];
      this._lastTouchPos  = { x: t.clientX, y: t.clientY };
      this._lastTouchTime = performance.now();
      this._touchEvents.push({ type: 'start', x: t.clientX, y: t.clientY, t: this._lastTouchTime });
    };
    const onTouchEnd = (e) => {
      const now = performance.now();
      this._lastTouchEndTime = Date.now();
      if (this._lastTouchPos && this._lastTouchTime) {
        const t = e.changedTouches[0];
        const dx = t.clientX - this._lastTouchPos.x;
        const dy = t.clientY - this._lastTouchPos.y;
        const dt = now - this._lastTouchTime;
        const vel = dt > 0 ? Math.sqrt(dx*dx + dy*dy) / dt : 0;
        this._touchVelocities.push(vel);
        this._touchEvents.push({ type: 'end', x: t.clientX, y: t.clientY, t: now, vel });
      }
    };
    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchend',   onTouchEnd,   { passive: true });
    this._boundHandlers['touchstart'] = { el: document, event: 'touchstart', fn: onTouchStart, opts: { passive: true } };
    this._boundHandlers['touchend']   = { el: document, event: 'touchend',   fn: onTouchEnd,   opts: { passive: true } };
  }

  // ── Scroll ─────────────────────────────────────────────────────────────────

  _attachScrollListeners() {
    const fn = (e) => this._scrollEvents.push({ dy: e.deltaY, t: performance.now() });
    document.addEventListener('wheel', fn, { passive: true });
    this._boundHandlers['scroll'] = { el: document, event: 'wheel', fn, opts: { passive: true } };
  }

  // ── Estatisticas ───────────────────────────────────────────────────────────

  _stats(arr) {
    if (arr.length < 2) return { mean: 0, std: 0, min: 0, max: 0, cv: 0 };
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const std  = Math.sqrt(arr.map(x => (x - mean) ** 2).reduce((a, b) => a + b, 0) / arr.length);
    return {
      mean: Math.round(mean * 100) / 100,
      std:  Math.round(std  * 100) / 100,
      min:  Math.min(...arr),
      max:  Math.max(...arr),
      cv:   mean > 0 ? std / mean : 0,
    };
  }

  // ── Metricas publicas ──────────────────────────────────────────────────────

  getMetrics() {
    const ks = this._stats(this._keystrokeIntervals);
    const mv = this._stats(this._mouseVelocities);
    const tv = this._stats(this._touchVelocities);
    const fd = this._stats(Object.values(this._fieldFocusDurations));

    // Classifica o cenario de autocomplete
    const totalAutofillEvents    = this._autocompleteEvents.length;
    const humanAutofillCount     = this._autocompleteEvents.filter(e => e.isHuman).length;
    const suspiciousAutofillCount = this._autocompleteEvents.filter(e => e.suspicious).length;

    return {
      session: {
        duration:              Date.now() - this._sessionStart,
        keystrokeCount:        this._keystrokeTimestamps.length,
        backspaceCount:        this._backspaceCount,
        deleteCount:           this._deleteCount,
        pasteCount:            this._pasteCount,
        pasteWithoutTyping:    this._pasteWithoutTyping,
        focusCount:            this._focusCount,
        fieldTransitions:      this._fieldTransitions.length,
        isMobile:              this._touchEvents.length > 0,

        // Autocomplete
        autofillDetected:      this._autofillDetected,
        autofillIsHuman:       this._autofillIsHuman,
        botInjectionSuspect:   this._botInjectionSuspect,
        totalAutofillEvents,
        humanAutofillCount,
        suspiciousAutofillCount,
        autocompleteEvents:    this._autocompleteEvents,
      },
      keystroke:          { ...ks, humanProbability: Math.min(ks.cv * 2, 1) },
      mouse:              { ...mv, sampleCount: this._mouseVelocities.length, clickCount: this._clickEvents.length },
      touch:              { ...tv, eventCount: this._touchEvents.length },
      fieldTransitions:   { events: this._fieldTransitions },
      fieldFocusDuration: { ...fd, perField: this._fieldFocusDurations },
      scroll:             { eventCount: this._scrollEvents.length },
    };
  }

  // ── Score local ────────────────────────────────────────────────────────────

  computeLocalScore() {
    const m = this.getMetrics();
    let score = 0;

    // 1. Variancia de keystroke (35 pts)
    const cv = m.keystroke.cv;
    if (cv > 0.5) score += 35; else if (cv > 0.3) score += 25; else if (cv > 0.1) score += 12;

    // 2. Velocidade media (20 pts)
    const avg = m.keystroke.mean;
    if (avg > 150) score += 20; else if (avg > 80) score += 14; else if (avg > 40) score += 6;

    // 3. Backspaces (20 pts)
    if (m.session.backspaceCount >= 3) score += 20;
    else if (m.session.backspaceCount >= 1) score += 12;

    // 4. Mouse ou Touch (15 pts)
    if (m.session.isMobile) {
      if (m.touch.cv > 0.3) score += 15; else if (m.touch.cv > 0.1) score += 8;
    } else {
      if (m.mouse.sampleCount > 20) {
        if (m.mouse.cv > 0.4) score += 15; else if (m.mouse.cv > 0.2) score += 8;
      }
    }

    // 5. Transicoes entre campos (10 pts)
    const transitions = this._fieldTransitions;
    if (transitions.length > 1) {
      const gaps = transitions.slice(1).map((t, i) => t.ts - transitions[i].ts);
      const gapStd = this._stats(gaps).std;
      if (gapStd > 300) score += 10; else if (gapStd > 100) score += 6;
    }

    // Penalidades
    if (m.session.pasteWithoutTyping > 0)  score = Math.max(0, score - 25);

    // Autocomplete: so penaliza se for SUSPEITO de bot
    // Autocomplete humano legitimo NAO penaliza
    if (m.session.botInjectionSuspect && !m.session.autofillIsHuman) {
      score = Math.max(0, score - 35); // penalidade forte
    } else if (m.session.autofillDetected && m.session.autofillIsHuman) {
      score += 5; // bonus: autocomplete humano com evidencia de interacao
    }

    return Math.min(score, 100);
  }

  // ── Envio ao backend ───────────────────────────────────────────────────────

  async getToken() {
    const payload = {
      metrics:    this.getMetrics(),
      localScore: this.computeLocalScore(),
      timestamp:  Date.now(),
      userAgent:  navigator.userAgent,
      timezone:   Intl.DateTimeFormat().resolvedOptions().timeZone,
      screen:     { w: screen.width, h: screen.height, dpr: window.devicePixelRatio },
      language:   navigator.language,
      platform:   navigator.platform,
    };
    try {
      const res = await fetch(this.options.apiEndpoint, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
      });
      const data = await res.json();
      return data.token;
    } catch (err) {
      console.error('[BiometricCollector]', err);
      return null;
    }
  }
}

if (typeof module !== 'undefined') module.exports = BiometricCollector;
