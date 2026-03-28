# Biometric CAPTCHA

> Detecção de bots por biometria comportamental passiva — sem imagens, sem puzzles, sem fricção para o usuário.

---

## O Problema

Os CAPTCHAs visuais tradicionais estão se tornando obsoletos. Modelos de visão computacional modernos resolvem esses desafios com precisão superior à humana.

A questão central é: como distinguir um humano de uma máquina sem incomodar o usuário?

A resposta está na imperfeição humana.

---

## A Solução: Biometria Comportamental

Humanos são cronometricamente imperfeitos — e essa imperfeição é sua assinatura única.

Enquanto um bot preenche um formulário com timing milimetricamente uniforme, um humano hesita, erra, corrige, acelera e desacelera de forma orgânica e imprevisível.

```
Bot:    campo1 -50ms- campo2 -50ms- campo3    <- timing perfeito = SUSPEITO
Humano: campo1 -432ms- campo2 -891ms- campo3  <- variância natural = APROVADO
```

---

## Como Funciona

1. `BiometricCollector.js` captura eventos de teclado, mouse e scroll de forma passiva
2. Na submissão do formulário, as métricas são enviadas ao backend
3. O backend analisa os dados e retorna um JWT assinado com a decisão
4. O JWT é validado antes de processar o formulário

**Decisões possíveis:** PASS (score > 45) | CHALLENGE (20–45) | BLOCK (< 20)

---

## Métricas Coletadas

| Sinal | O que revela | Peso |
|---|---|---|
| Variância entre teclas | Bots têm timing perfeito (CV ≈ 0) | 35% |
| Velocidade média de digitação | Bots digitam acima de 1.000 WPM | 20% |
| Backspaces usados | Bots nunca erram ao digitar | 20% |
| Variância do mouse | Bots movem em linha reta perfeita | 15% |
| Intervalo entre campos | Bots mudam de campo em tempo fixo | 10% |

---

## Flags de Detecção

| Flag | Descrição |
|---|---|
| `KEYSTROKE_TOO_UNIFORM` | Intervalo entre teclas sem variação |
| `TYPING_TOO_FAST` | Velocidade fisicamente impossível para humanos |
| `NO_TYPING_ERRORS` | Nenhum backspace em texto longo |
| `MOUSE_TOO_LINEAR` | Movimento de mouse em linha reta perfeita |
| `FIELD_TRANSITIONS_TOO_UNIFORM` | Tempo fixo ao mudar de campo |
| `PASTE_WITHOUT_TYPING` | Colou tudo sem digitar nada |
| `IMPOSSIBLE_SPEED` | Volume de dados em tempo impossível |
| `ARTIFICIAL_NOISE_SUSPECTED` | Ruído branco simulado detectado |
| `CLIENT_SCORE_TAMPERED` | Score do cliente adulterado |

---

## Estrutura do Projeto

```
biometric-captcha/
├── frontend/
│   ├── css/
│   │   └── style.css            ← Estilos da página de demonstração
│   ├── scripts/
│   │   ├── biometric-collector.js   ← Script drop-in para o seu site
│   │   └── demo.js              ← Script de demonstração
│   └── index.html               ← Exemplo completo de integração
├── backend/
│   └── server.js                ← API Node.js + Express + JWT
├── database/
│   └── schema.sql               ← Schema PostgreSQL com views e funções
└── README.md
```

---

## Instalação Rápida

### 1. Backend

```bash
cd backend
npm install express jsonwebtoken helmet cors express-rate-limit
export JWT_SECRET="seu-segredo-aqui"
node server.js
```

### 2. Banco de dados

```bash
psql -U postgres -d seu_banco -f database/schema.sql
```

### 3. Frontend

```html
<script src="/scripts/biometric-collector.js"></script>
<script>
  const captcha = new BiometricCollector('#seu-formulario', {
    apiEndpoint: '/api/captcha/analyze'
  });
  captcha.init();

  document.querySelector('#seu-formulario').addEventListener('submit', async (e) => {
    e.preventDefault();
    const token = await captcha.getToken();
    // Inclua o token na requisição — seu backend valida antes de processar
  });
</script>
```

### 4. Validar o token no backend

```js
const jwt = require('jsonwebtoken');

function validarCaptcha(token) {
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  if (decoded.decision === 'BLOCK') throw new Error('Bot detectado');
  return decoded; // { decision, score, flags }
}
```

---

## Por que funciona?

O princípio fundamental é o **paradoxo da perfeição**: comportamento cronometricamente perfeito é imediatamente suspeito.

Bots sofisticados que tentam simular variância humana geralmente falham em dois aspectos:

- **Distribuição**: ruído branco é detectável — humanos seguem distribuições específicas ligadas à cognição e à biomecânica
- **Autocorrelação**: a velocidade de digitação humana tem memória — padrão impossível de falsificar em tempo real

---

## Privacidade e LGPD

- Apenas métricas derivadas são enviadas ao servidor (médias, desvios padrão)
- Os dados são anonimizáveis antes de persistir no banco
- O schema inclui função de limpeza automática configurável
- Documente a coleta na sua Política de Privacidade

---

## Roadmap

- [ ] SDK para React e Vue
- [ ] Suporte a mobile (pressão de toque, acelerômetro)
- [ ] Modelo de ML treinado nos logs do PostgreSQL
- [ ] Fingerprint de dispositivo (WebGL, canvas, fonts)
- [ ] Dashboard de monitoramento em tempo real
- [ ] Integração com blocklists de IPs (AbuseIPDB)
- [ ] Publicar no npm

---

*Desenvolvido como alternativa comportamental ao reCAPTCHA clássico.*
*A imperfeição humana é a melhor senha.*
