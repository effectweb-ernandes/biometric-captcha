# Biometric CAPTCHA

> Deteccao de bots por biometria comportamental passiva — sem imagens, sem puzzles, sem friccao para o usuario.

---

## O Problema

Os CAPTCHAs visuais tradicionais estão se tornando obsoletos. Modelos de visão computacional modernos resolvem esses desafios com precisao superior a humana.

A questao central é: como distinguir um humano de uma máquina sem incomodar o usuario?

A resposta está na imperfeição humana.

---

## A Solucão: Biometria Comportamental

Humanos sao cronometricamente imperfeitos — e essa imperfeicao e sua assinatura unica.

Enquanto um bot preenche um formulario com timing milimetricamente uniforme, um humano hesita, erra, corrige, acelera e desacelera de forma organica e imprevisivel.

    Bot:    campo1 -50ms- campo2 -50ms- campo3   <- timing perfeito = SUSPEITO
    Humano: campo1 -432ms- campo2 -891ms- campo3 <- variancia natural = APROVADO

---

## Como Funciona

1. BiometricCollector.js roda no browser e captura eventos de teclado, mouse e scroll de forma passiva
2. Na submissao do form, as metricas sao enviadas ao backend
3. O backend analisa os dados e retorna um JWT assinado com a decisao
4. O JWT e validado antes de processar o formulario

Decisoes: PASS (score > 45) | CHALLENGE (20-45) | BLOCK (< 20)

---

## Metricas Coletadas

| Sinal | O que revela | Peso |
|---|---|---|
| Variancia entre teclas | Bots tem timing perfeito | 35% |
| Velocidade media | Bots digitam acima de 1000 WPM | 20% |
| Backspaces usados | Bots nunca erram | 20% |
| Variancia do mouse | Bots movem em linha reta | 15% |
| Intervalo entre campos | Bots mudam de campo em tempo fixo | 10% |

---

## Flags de Deteccao

- KEYSTROKE_TOO_UNIFORM: intervalo entre teclas sem variacao
- TYPING_TOO_FAST: velocidade impossivel para humanos
- NO_TYPING_ERRORS: nenhum backspace em texto longo
- MOUSE_TOO_LINEAR: mouse em linha reta perfeita
- FIELD_TRANSITIONS_TOO_UNIFORM: tempo fixo ao mudar de campo
- PASTE_WITHOUT_TYPING: colou tudo sem digitar nada
- IMPOSSIBLE_SPEED: volume de dados em tempo impossivel
- ARTIFICIAL_NOISE_SUSPECTED: ruido branco simulado detectado
- CLIENT_SCORE_TAMPERED: score do cliente adulterado

---

## Estrutura do Projeto

    biometric-captcha/
    |- frontend/
    |   |- biometric-collector.js   <- Script drop-in para o seu site
    |   |- index.html               <- Exemplo completo de integracao
    |- backend/
    |   |- server.js                <- API Node.js + Express + JWT
    |- database/
    |   |- schema.sql               <- Schema PostgreSQL com views e funcoes
    |- README.md

---

## Instalacao Rapida

### 1. Backend

    cd backend
    npm install express jsonwebtoken helmet cors express-rate-limit
    export JWT_SECRET="seu-segredo-aqui"
    node server.js

### 2. Banco de dados

    psql -U postgres -d seu_banco -f database/schema.sql

### 3. Frontend

    <script src="/biometric-collector.js"></script>
    <script>
      const captcha = new BiometricCollector('#seu-form', {
        apiEndpoint: '/api/captcha/analyze'
      });
      captcha.init();

      document.querySelector('#seu-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const token = await captcha.getToken();
        // Inclua o token na requisicao — seu backend valida antes de processar
      });
    </script>

### 4. Validar o token no backend

    const jwt = require('jsonwebtoken');

    function validarCaptcha(token) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      if (decoded.decision === 'BLOCK') throw new Error('Bot detectado');
      return decoded; // { decision, score, flags }
    }

---

## Por que funciona?

O principio e o paradoxo da perfeicao: comportamento cronometricamente perfeito e imediatamente suspeito.

Bots que tentam simular variancia humana falham porque:
- Ruido branco e detectavel — humanos seguem distribuicoes ligadas a cognicao e biomecanica
- A velocidade de digitacao humana tem autocorrelacao — padrao impossivel de falsificar em tempo real

---

## Privacidade e LGPD

- Apenas metricas derivadas sao enviadas ao servidor (medias, desvios padrao)
- Dados anonimizaveis antes de persistir no banco
- Schema inclui funcao de limpeza automatica
- Documente a coleta na sua Politica de Privacidade

---

## Roadmap

- [ ] SDK para React e Vue
- [ ] Suporte a mobile (pressao de toque, acelerometro)
- [ ] Modelo de ML treinado nos logs do PostgreSQL
- [ ] Fingerprint de dispositivo (WebGL, canvas, fonts)
- [ ] Dashboard de monitoramento em tempo real
- [ ] Integracao com blocklists de IPs (AbuseIPDB)
- [ ] Publicar no npm
