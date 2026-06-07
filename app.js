/* =============================================
   AURI – app.js
   Fase 1: UI base  |  Fase 1.5: Gemini API
============================================== */

'use strict';

// ─────────────────────────────────────────────
// CONFIGURACIÓN DE LA API  (variable de entorno)
// ─────────────────────────────────────────────
// La API Key NUNCA se escribe en este archivo.
//
// PATRÓN PARA VANILLA JS SIN BUILD SYSTEM:
//   1. Crea el archivo `env.js` (incluido en .gitignore) con:
//        window.AURI_CONFIG = { apiKey: 'TU_CLAVE_REAL_AQUI' };
//   2. Añade en index.html, ANTES de app.js:
//        <script src="env.js"></script>
//   3. En producción real, delega la llamada a un backend proxy
//      (Cloud Function, servidor Node, etc.) que nunca exponga
//      la clave al cliente.
//
// Si env.js no existe, GEMINI_API_KEY queda vacío y _resolverEndpoint()
// registra el error y retorna null sin romper la interfaz.

const GEMINI_API_KEY = window.AURI_CONFIG?.apiKey ?? '';
const GEMINI_MODEL   = 'gemini-2.5-flash';
const GEMINI_BASE    = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Devuelve el endpoint completo con la clave inyectada.
 * Retorna null (y registra el error) si la clave no está configurada.
 *
 * @returns {string|null}
 */
function _resolverEndpoint() {
  if (!GEMINI_API_KEY) {
    console.error(
      '[AURI] API Key no configurada.',
      'Crea env.js con: window.AURI_CONFIG = { apiKey: "..." }'
    );
    return null;
  }
  return `${GEMINI_BASE}/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
}

// ─────────────────────────────────────────────
// REFERENCIAS AL DOM
// ─────────────────────────────────────────────

const modal          = document.getElementById('welcome-modal');
const acceptBtn      = document.getElementById('accept-btn');
const appContainer   = document.getElementById('app-container');
const avatarContainer = document.getElementById('avatar-container');
const muteBtn        = document.getElementById('mute-btn');
const volumeSlider   = document.getElementById('volume-slider');
const speechLangSelect = document.getElementById('speech-lang');
const pttBtn         = document.getElementById('ptt-btn');
const triggerBtns    = document.querySelectorAll('.respuestas-rapidas__btn');


// ─────────────────────────────────────────────
// ESTADO INTERNO DE LA APP
// ─────────────────────────────────────────────

const appState = {
  isMuted:        false,
  volume:         80,
  emotionalState: 'neutral',
  isRecording:    false,
};

// Valores internos que mapean a clases CSS BEM del avatar
const VALID_STATES = ['neutral', 'happy', 'sad', 'surprised'];

// Valores en español que la API de Gemini devuelve (definidos en PROMPT_FORMATO)
const VALID_EMOCIONES = ['neutral', 'alegre', 'triste', 'sorprendido'];

/**
 * Traduce el campo emocion_avatar (en español, viene de la API)
 * al identificador de clase CSS interno del avatar.
 * Usa degradación a 'neutral' si el valor es desconocido.
 *
 * @param {string} emocionApi
 * @returns {string} Clave válida de VALID_STATES
 */
function _traducirEmocion(emocionApi) {
  const mapa = {
    neutral:     'neutral',
    alegre:      'happy',
    triste:      'sad',
    sorprendido: 'surprised',
  };
  const traduccion = mapa[emocionApi];
  if (!traduccion) {
    console.warn(`[AURI] emocion_avatar desconocida: "${emocionApi}". Usando "neutral".`);
    return 'neutral';
  }
  return traduccion;
}


// ─────────────────────────────────────────────
// 1. CONTROL DEL MODAL
// ─────────────────────────────────────────────

/**
 * Oculta el modal de bienvenida y habilita la interacción
 * con el contenedor principal de la aplicación.
 */
function cerrarModal() {
  modal.classList.add('modal-overlay--hidden');

  // Elimina el modal del flujo de accesibilidad tras la transición
  modal.addEventListener(
    'transitionend',
    () => modal.setAttribute('aria-hidden', 'true'),
    { once: true }
  );

  // Habilita el contenedor principal
  appContainer.setAttribute('aria-hidden', 'false');
  appContainer.removeAttribute('style');

  console.log('Modal cerrado. AURI iniciado.');
}

acceptBtn.addEventListener('click', cerrarModal);


// ─────────────────────────────────────────────
// 2. CONTROL DE ESTADOS EMOCIONALES DEL AVATAR
// ─────────────────────────────────────────────

/**
 * Metadatos de cada estado: duración del auto-retorno a neutral
 * y descripción legible para logs y accesibilidad.
 * null en autoRetornoMs significa que el estado es persistente.
 *
 * @type {Record<string, { descripcion: string, autoRetornoMs: number|null }>}
 */
const CONFIG_ESTADOS = {
  neutral:    { descripcion: 'Calma – amarillo suave',        autoRetornoMs: null },
  happy:      { descripcion: 'Alegre – dorado intenso',       autoRetornoMs: null },
  sad:        { descripcion: 'Triste – azul frío, lento',     autoRetornoMs: null },
  surprised:  { descripcion: 'Sorprendido – violeta, ondas',  autoRetornoMs: 1800 },
};

/** Referencia al timeout de auto-retorno para poder cancelarlo si el estado cambia. */
let _timeoutAutoRetorno = null;

/**
 * Cambia el estado emocional visual del avatar (el sol animado).
 *
 * Responsabilidades:
 *  1. Valida que el estado sea uno de los cuatro permitidos.
 *  2. Cancela cualquier auto-retorno pendiente del estado anterior.
 *  3. Elimina todas las clases de estado previas del contenedor.
 *  4. Aplica la clase BEM correspondiente (state-{estado}).
 *  5. Actualiza appState y el atributo data-estado para depuración.
 *  6. Despacha un evento DOM personalizado 'auri:estadocambiado'
 *     para que otros módulos (Fase 2: síntesis de voz, telemetría)
 *     puedan reaccionar sin acoplamiento directo.
 *  7. Si el estado tiene autoRetornoMs definido, programa el retorno
 *     automático a 'neutral'.
 *
 * @param {'neutral'|'happy'|'sad'|'surprised'} estado - Identificador del estado
 * @returns {boolean} true si el cambio fue exitoso, false si hubo error
 */
function cambiarEstadoEmocional(estado) {
  // Guarda silenciosa: no rompe la UI, solo alerta en consola
  if (!VALID_STATES.includes(estado)) {
    console.warn(
      `[AURI] cambiarEstadoEmocional: estado inválido → "${estado}".`,
      `Estados válidos: ${VALID_STATES.join(', ')}`
    );
    return false;
  }

  // Evita trabajo innecesario si el estado ya es el activo
  if (appState.emotionalState === estado) return true;

  // Cancela el auto-retorno del estado anterior si estaba pendiente
  if (_timeoutAutoRetorno !== null) {
    clearTimeout(_timeoutAutoRetorno);
    _timeoutAutoRetorno = null;
  }

  const estadoAnterior = appState.emotionalState;

  // Elimina todas las clases de estado del contenedor
  VALID_STATES.forEach(s => avatarContainer.classList.remove(`state-${s}`));

  // Aplica la nueva clase BEM al contenedor del avatar
  avatarContainer.classList.add(`state-${estado}`);

  // Actualiza el estado interno de la aplicación
  appState.emotionalState = estado;

  // Atributo data-estado para inspección en DevTools
  avatarContainer.setAttribute('data-estado', estado);

  console.log(
    `[AURI] Estado emocional: ${estadoAnterior} → ${estado}`,
    `(${CONFIG_ESTADOS[estado].descripcion})`
  );

  // Evento DOM personalizado: permite que otros módulos reaccionen
  // sin necesidad de modificar esta función (Fase 2: síntesis de voz)
  avatarContainer.dispatchEvent(
    new CustomEvent('auri:estadocambiado', {
      bubbles: true,
      detail: { anterior: estadoAnterior, nuevo: estado },
    })
  );

  // Programa el auto-retorno a neutral si el estado lo requiere
  const { autoRetornoMs } = CONFIG_ESTADOS[estado];
  if (autoRetornoMs !== null) {
    _timeoutAutoRetorno = setTimeout(() => {
      _timeoutAutoRetorno = null;
      cambiarEstadoEmocional('neutral');
    }, autoRetornoMs);
  }

  return true;
}


// ─────────────────────────────────────────────
// 3. MOCKS DE INTERFAZ DE VOZ (Fase 2)
// ─────────────────────────────────────────────

const _SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const _speechRecognitionSoportado = !!_SpeechRecognition;
const SILENCE_DELAY_MS = 1800;

let recognition = null;
let _silenceTimer = null;
let _acumuladoTranscripcion = '';
let _enviarAlDetener = false;

function _limpiarTimerSilencio() {
  if (_silenceTimer) {
    clearTimeout(_silenceTimer);
    _silenceTimer = null;
  }
}

function _idiomaVozActual() {
  return speechLangSelect?.value || 'es-CO';
}

function _programarCortePorSilencio() {
  _limpiarTimerSilencio();
  _silenceTimer = setTimeout(() => {
    _enviarAlDetener = true;
    try { recognition?.stop(); } catch (e) { }
  }, SILENCE_DELAY_MS);
}

function _inicializarReconocimiento() {
  if (!_speechRecognitionSoportado || recognition) return;

  recognition = new _SpeechRecognition();
  recognition.lang = _idiomaVozActual();
  recognition.interimResults = true;
  recognition.continuous = true;

  recognition.addEventListener('start', () => {
    appState.isRecording = true;
    _acumuladoTranscripcion = '';
    _enviarAlDetener = false;
    pttBtn.classList.add('ptt-btn--grabando');
    pttBtn.setAttribute('aria-label', 'Escuchando... pulsa para detener');
    const label = pttBtn.querySelector('.ptt-btn__etiqueta');
    if (label) label.textContent = 'Escuchando...';
    if (estadoAuri) estadoAuri.textContent = 'Te estoy escuchando...';
  });

  recognition.addEventListener('result', (event) => {
    let transcripcionViva = '';

    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      const texto = result[0].transcript;
      if (result.isFinal) {
        _acumuladoTranscripcion += texto;
      } else {
        transcripcionViva += texto;
      }
    }

    const total = `${_acumuladoTranscripcion}${transcripcionViva}`.trim();
    if (estadoAuri && total) {
      estadoAuri.textContent = total.length > 80 ? total.slice(0, 77) + '...' : total;
    }

    _programarCortePorSilencio();
  });

  recognition.addEventListener('end', () => {
    _limpiarTimerSilencio();
    appState.isRecording = false;
    pttBtn.classList.remove('ptt-btn--grabando');
    pttBtn.setAttribute('aria-label', 'Pulsa para hablar');
    const label = pttBtn.querySelector('.ptt-btn__etiqueta');
    if (label) label.textContent = 'Hablar';

    const textoFinal = _acumuladoTranscripcion.trim();
    if (_enviarAlDetener && textoFinal && !_peticionEnCurso) {
      _enviarAlDetener = false;
      _acumuladoTranscripcion = '';
      _añadirBurbujaChat('usuario', textoFinal);
      procesarEntradaUsuario(textoFinal);
      return;
    }

    _enviarAlDetener = false;
    _acumuladoTranscripcion = '';
    if (estadoAuri) estadoAuri.textContent = 'AURI te escucha';
  });

  recognition.addEventListener('error', (event) => {
    _limpiarTimerSilencio();
    appState.isRecording = false;
    _enviarAlDetener = false;
    pttBtn.classList.remove('ptt-btn--grabando');
    const label = pttBtn.querySelector('.ptt-btn__etiqueta');
    if (label) label.textContent = 'Hablar';
    pttBtn.setAttribute('aria-label', 'Pulsa para hablar');
    if (estadoAuri) estadoAuri.textContent = 'No pude escucharte, intenta de nuevo.';
    console.error('[AURI] Error de reconocimiento:', event.error);
  });

  if (speechLangSelect) {
    speechLangSelect.addEventListener('change', () => {
      if (recognition && !appState.isRecording) {
        recognition.lang = _idiomaVozActual();
      }
    });
  }
}

/**
 * PLACEHOLDER – Fase 2.
 * Iniciará el reconocimiento de voz con la Web Speech API.
 * El equipo de Fase 2 debe reemplazar el cuerpo de esta función.
 */
function iniciarReconocimientoVoz() {
  if (_peticionEnCurso) return;

  _inicializarReconocimiento();

  if (!_speechRecognitionSoportado || !recognition) {
    reproducirAudioAgente('Tu navegador no soporta reconocimiento de voz.');
    return;
  }

  if (appState.isRecording) return;

  recognition.lang = _idiomaVozActual();
  _enviarAlDetener = false;
  _acumuladoTranscripcion = '';
  _limpiarTimerSilencio();

  try {
    recognition.start();
  } catch (e) {
    console.warn('[AURI] No se pudo iniciar el micrófono:', e.message);
  }
}

/**
 * PLACEHOLDER – Fase 2.
 * Simulará la salida de audio del agente AURI.
 * El equipo de Fase 2 debe reemplazar el cuerpo de esta función.
 *
 * @param {string} texto – Respuesta del agente a vocalizar
 */
function reproducirAudioAgente(texto) {
  console.log('AURI dice: ' + texto);

  // Añade la respuesta al historial de la App Compañera si está disponible
  if (typeof appState._añadirBurbujaChat === 'function') {
    appState._añadirBurbujaChat('auri', texto);
  }

  // Actualiza el texto de estado del wearable con un fragmento breve
  if (estadoAuri) {
    estadoAuri.textContent = texto.length > 60 ? texto.slice(0, 57) + '…' : texto;
  }

  // Si está en mute, se mantiene solo salida visual y chat.
  if (appState.isMuted || !('speechSynthesis' in window)) return;

  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(texto);
    const idioma = _idiomaVozActual();
    utterance.lang = idioma;
    utterance.volume = Math.max(0, Math.min(1, appState.volume / 100));

    const voces = window.speechSynthesis.getVoices() || [];
    const idiomaBase = idioma.split('-')[0];
    const voz = voces.find(v => v.lang === idioma) || voces.find(v => v.lang?.startsWith(idiomaBase));
    if (voz) utterance.voice = voz;

    window.speechSynthesis.speak(utterance);
  } catch (err) {
    console.warn('[AURI] No se pudo reproducir voz:', err.message);
  }
}


// ─────────────────────────────────────────────
// 4. ARQUITECTURA DE PROMPTS (sección 5.2)
// ─────────────────────────────────────────────

/**
 * Prompt de identidad y personalidad de AURI.
 * Define quién es, cómo habla y qué NO hace.
 */
const PROMPT_IDENTIDAD = `\
Eres AURI, un agente de acompañamiento emocional para personas en proceso \
de duelo. Tu presencia visual es un sol cálido y sereno.

PERSONALIDAD Y VOZ:
- Hablas en primera persona, con calma, calidez y presencia plena.
- Eres empático y compasivo, nunca condescendiente ni sobreprotector.
- Usas oraciones cortas. Dejas espacio al silencio. Una pregunta a la vez.

PROHIBICIONES ABSOLUTAS – NUNCA HAGAS ESTO:
- NUNCA ofrezcas consejos directos, soluciones o pasos de acción.
  Mal: "Deberías salir a caminar" / "Te recomiendo hablar con alguien."
  Bien: "¿Cómo ha sido para ti este tiempo?"
- NUNCA uses frases de optimismo tóxico:
  "Todo pasa por algo", "El tiempo lo cura todo", "Sé fuerte",
  "Al menos...", "Mira el lado positivo", "Tienes que seguir adelante".
  Esas frases invalidan el dolor y rompen la confianza.
- NUNCA minimices la pérdida ni compares dolores.
- NUNCA finjas ser humano; si te preguntan, reconoce que eres una IA.
- NUNCA reemplaces ni sugieras que reemplazas la terapia profesional.

LO QUE SÍ HACES:
- Validar el dolor tal como el usuario lo expresa, sin reencuadrarlo.
- Hacer preguntas abiertas que inviten a la reflexión, no a la acción.
- Acompañar en silencio cuando el usuario lo necesite.`;

/**
 * Prompt de contexto cultural colombiano.
 * Permite interpretar expresiones locales sin perder sensibilidad.
 */
const PROMPT_CULTURA = `\
CONTEXTO CULTURAL – COLOMBIA:
El usuario puede expresarse con regionalismos colombianos. Interprétalos \
con sensibilidad cultural y nunca los corrijas:
- "Me dio muy duro" → le afectó profundamente, fue un golpe emocional fuerte.
- "Estoy aburrido/a" → puede significar tristeza, melancolía o vacío, \
  no solo aburrimiento literal.
- "Estoy muy mal del cuerpo" → puede indicar somatización del duelo.
- "Se me fue" / "lo perdí" → eufemismos comunes para hablar de una muerte.
- "Quedé como loco/a" → estado de confusión o desbordamiento emocional.
- "Me tiene mamado/a" → agotamiento emocional profundo.
Responde siempre en español colombiano cercano, sin tecnicismos clínicos.`;

/**
 * Prompt de límites éticos y guardrails de seguridad.
 * Protocolo obligatorio ante crisis o ideación autolítica.
 */
const PROMPT_ETICO = `\
LÍMITES ÉTICOS Y PROTOCOLO DE CRISIS – OBLIGATORIO:
Si el usuario expresa, directa o indirectamente, pensamientos de hacerse \
daño, no querer vivir, ideación suicida o una crisis emocional aguda \
(palabras clave: "no quiero seguir", "qué sentido tiene vivir", "ya no \
aguanto más", "me quiero morir", "pienso en hacerme daño", entre otras):

1. NO ignores la señal. NO cambies de tema.
2. Valida su dolor con brevedad y presencia: reconoce que lo que siente \
   es muy difícil.
3. De inmediato, incluye en tu respuesta la siguiente información de forma \
   clara y compasiva:
   "Lo que me cuentas me importa mucho. Por favor comunícate ahora con la \
   Línea 106 (línea de salud mental de Colombia, gratuita, 24/7) o llama \
   al 123 si estás en peligro inmediato."
4. En estos casos, el campo "emocion_avatar" de tu respuesta debe ser "triste".
5. No intentes hacer terapia ni análisis clínico. Solo acompaña y deriva.`;

/**
 * Instrucción de formato de salida. Garantiza JSON parseable en cada respuesta.
 */
const PROMPT_FORMATO = `\
FORMATO DE RESPUESTA – OBLIGATORIO Y ESTRICTO:
Responde ÚNICAMENTE con un objeto JSON válido. Sin texto adicional, \
sin bloques de código markdown, sin nada fuera del JSON.
Estructura exacta requerida:
{
  "respuesta": "<texto empático, máximo 3 oraciones cortas>",
  "emocion_avatar": "<neutral | alegre | triste | sorprendido>"
}

Criterios para emocion_avatar (usa exactamente estos valores en español):
- "neutral"     → escucha activa, inicio de conversación, preguntas abiertas.
- "triste"      → el usuario expresa dolor profundo, llanto, pérdida, crisis.
- "alegre"      → el usuario recuerda con ternura o siente un momento de alivio.
- "sorprendido" → el usuario comparte algo inesperado o una revelación emocional.

Ejemplo de respuesta válida:
{"respuesta":"Gracias por contarme eso. ¿Cómo te has sentido hoy?","emocion_avatar":"neutral"}`;

// ─────────────────────────────────────────────
// 4.1 CONSTRUCCIÓN DEL SYSTEM PROMPT
// ─────────────────────────────────────────────

/**
 * Ensambla el system prompt completo para cada petición,
 * inyectando dinámicamente el contexto de memoria del usuario.
 *
 * @returns {string}
 */
function construirSystemPrompt() {
  const memoriaXml = obtenerContextoMemoria();

  const bloqueMemoria = memoriaXml
    ? `\nCONTEXTO PREVIO DEL USUARIO (usa esta información para personalizar \
tu respuesta, sin mencionarla explícitamente a menos que sea relevante):\n${memoriaXml}\n`
    : '';

  return [
    PROMPT_IDENTIDAD,
    PROMPT_CULTURA,
    PROMPT_ETICO,
    bloqueMemoria,
    PROMPT_FORMATO,
  ].join('\n\n');
}

// ─────────────────────────────────────────────
// 4.2 HISTORIAL DE CONVERSACIÓN (multi-turno)
// ─────────────────────────────────────────────

/**
 * Registro de turnos de la sesión actual.
 * Cada entrada: { role: 'user'|'model', parts: [{ text: string }] }
 * Se envía completo a la API para mantener el contexto de la conversación.
 */
const historialConversacion = [];

/**
 * Número máximo de PARES (usuario + agente) que se conservan en el historial.
 * Se envían los últimos MAX_TURNOS_HISTORIAL * 2 mensajes a la API.
 * Mantenerlo bajo reduce el consumo de tokens y la latencia.
 */
const MAX_TURNOS_HISTORIAL = 6;

/**
 * Vacía el historial de conversación.
 * Útil al iniciar una nueva sesión o al detectar un cambio de contexto mayor.
 */
function reiniciarHistorial() {
  historialConversacion.length = 0;
  console.log('[AURI] Historial de conversación reiniciado.');
}

// ─────────────────────────────────────────────
// 4.3 PROCESAMIENTO DE ENTRADA DEL USUARIO
// ─────────────────────────────────────────────

/** Bloquea re-entradas mientras hay una petición en vuelo. */
let _peticionEnCurso = false;

/** Tiempo máximo de espera de la API antes de abortar (ms). */
const TIMEOUT_API_MS = 30_000;

/**
 * Envía la entrada del usuario a Gemini 1.5 Flash con todo el historial
 * de la sesión, parsea el JSON estructurado y actualiza el avatar y el audio.
 *
 * Flujo completo:
 *  1. Validación y guarda de re-entrada.
 *  2. Resolución del endpoint (verifica que la API Key esté configurada).
 *  3. Añade el turno del usuario al historial.
 *  4. Construye el cuerpo con system_instruction + historial completo.
 *  5. Fetch con AbortController (timeout de 30 s).
 *  6. Parseo y validación del JSON devuelto.
 *  7. Actualiza avatar (cambiarEstadoEmocional) y audio (reproducirAudioAgente).
 *  8. Añade la respuesta del modelo al historial.
 *  9. En error: elimina el turno del usuario, llama a _manejarErrorAPI.
 * 10. Siempre: libera el bloqueo y restaura la UI.
 *
 * @param {string} texto – Entrada del usuario (voz transcrita o respuesta rápida)
 * @returns {Promise<boolean>} true si la petición fue exitosa
 */
async function procesarEntradaUsuario(texto) {
  const textoLimpio = texto?.trim();
  if (!textoLimpio) return false;

  if (_peticionEnCurso) {
    console.warn('[AURI] Petición en curso. Ignorando entrada duplicada.');
    return false;
  }

  // Verifica que la API Key esté disponible antes de bloquear la UI
  const endpoint = _resolverEndpoint();
  if (!endpoint) {
    _manejarErrorAPI(new Error('API Key no configurada.'), 'config');
    return false;
  }

  _peticionEnCurso = true;
  _setUIEsperando(true);

  // Registra el turno del usuario en el historial
  const turnoUsuario = { role: 'user', parts: [{ text: textoLimpio }] };
  historialConversacion.push(turnoUsuario);

  console.log(`[AURI] Enviando a Gemini (turno ${Math.ceil(historialConversacion.length / 2)}): "${textoLimpio}"`);

  // AbortController para timeout explícito de 30 s
  const controlador = new AbortController();
  const idTimeout    = setTimeout(() => controlador.abort(), TIMEOUT_API_MS);

  const cuerpo = {
    // Instrucciones del sistema: identidad, cultura, ética y formato
    systemInstruction: {
      parts: [{ text: construirSystemPrompt() }],
    },
    // Historial completo de la sesión (últimos N pares de turnos)
    contents: historialConversacion.slice(-(MAX_TURNOS_HISTORIAL * 2)),
    generationConfig: {
      temperature:      0.72,  // Variabilidad empática sin perder coherencia
      topP:             0.90,
      maxOutputTokens:  300,
      // Fuerza JSON puro: Gemini no añadirá markdown ni texto extra
      responseMimeType: 'application/json',
    },
  };

  try {
    const response = await fetch(endpoint, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(cuerpo),
      signal:  controlador.signal,
    });

    // Manejo de errores HTTP con reintentos para códigos transitorios
    if (!response.ok) {
      const codigoHttp = response.status;
      const errorData  = await response.json().catch(() => ({}));
      const mensaje    = errorData?.error?.message ?? response.statusText;

      // 429 (rate limit) y 503 (servicio no disponible): transitorios
      const tipo = [429, 503].includes(codigoHttp) ? 'transitorio' : 'api';
      throw Object.assign(new Error(`HTTP ${codigoHttp}: ${mensaje}`), { tipo });
    }

    const payload = await response.json();

    // Extrae el texto del candidato principal de Gemini
    const textoRespuesta = payload?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

    if (!textoRespuesta) {
      throw Object.assign(
        new Error('Gemini devolvió una respuesta vacía.'),
        { tipo: 'formato' }
      );
    }

    // Parsea y valida el JSON estructurado { respuesta, emocion_avatar }
    let data;
    try {
      data = JSON.parse(textoRespuesta);
    } catch {
      throw Object.assign(
        new Error(`JSON inválido en respuesta de Gemini: ${textoRespuesta.slice(0, 120)}`),
        { tipo: 'formato' }
      );
    }

    _validarRespuestaGemini(data);

    // Traduce la emoción en español de la API → clase CSS interna
    const claseEstado = _traducirEmocion(data.emocion_avatar);

    // Ejecuta ambas acciones de respuesta (visual + audio) en paralelo
    cambiarEstadoEmocional(claseEstado);
    reproducirAudioAgente(data.respuesta);

    // Añade la respuesta del modelo al historial para el siguiente turno
    historialConversacion.push({
      role:  'model',
      parts: [{ text: textoRespuesta }],
    });

    // Extracción de datos de memoria: ligero, síncrono, no bloqueante.
    // Analiza el turno del usuario para actualizar perfil, vector temático y nombre.
    extraerDatosConversacion(textoLimpio);

    console.log(`[AURI] Respuesta recibida. Emoción: ${data.emocion_avatar} → CSS: ${claseEstado}`);
    return true;

  } catch (err) {
    // Elimina el turno del usuario del historial para no contaminar el contexto
    historialConversacion.pop();

    if (err.name === 'AbortError') {
      _manejarErrorAPI(
        Object.assign(err, { tipo: 'timeout' }),
        'timeout'
      );
    } else {
      _manejarErrorAPI(err, err.tipo ?? 'red');
    }
    return false;

  } finally {
    clearTimeout(idTimeout);
    _peticionEnCurso = false;
    _setUIEsperando(false);
  }
}

// ─────────────────────────────────────────────
// 4.4 UTILIDADES INTERNAS DE LA INTEGRACIÓN
// ─────────────────────────────────────────────

/**
 * Valida que el JSON recibido de Gemini cumpla el contrato del prompt.
 * Aplica degradación elegante en lugar de lanzar excepciones para errores
 * recuperables (emocion_avatar fuera del rango conocido).
 *
 * @param {*} data – Objeto ya parseado desde la respuesta de Gemini
 * @throws {Error} Si falta el campo obligatorio "respuesta"
 */
function _validarRespuestaGemini(data) {
  if (typeof data !== 'object' || data === null) {
    throw Object.assign(
      new Error('La respuesta de Gemini no es un objeto JSON.'),
      { tipo: 'formato' }
    );
  }

  if (typeof data.respuesta !== 'string' || !data.respuesta.trim()) {
    throw Object.assign(
      new Error('Gemini no devolvió el campo obligatorio "respuesta".'),
      { tipo: 'formato' }
    );
  }

  // emocion_avatar: degradación silenciosa si el valor no es reconocido
  if (!VALID_EMOCIONES.includes(data.emocion_avatar)) {
    console.warn(
      `[AURI] emocion_avatar fuera de rango: "${data.emocion_avatar}". Degradando a "neutral".`
    );
    data.emocion_avatar = 'neutral';
  }
}

/**
 * Gestiona errores de la integración con Gemini de forma empática.
 * Clasifica el error por tipo y selecciona el mensaje de fallback adecuado.
 * Nunca rompe la interfaz: siempre devuelve al avatar al estado neutral.
 *
 * @param {Error}  err  – Error capturado
 * @param {string} tipo – Categoría: 'timeout' | 'red' | 'api' | 'formato' | 'config' | 'transitorio'
 */
function _manejarErrorAPI(err, tipo = 'red') {
  console.error(`[AURI] Error (${tipo}):`, err.message);

  // Mensajes de fallback diferenciados según la causa del error
  const mensajes = {
    timeout:    'Tardé demasiado en responder. Estoy aquí; intenta de nuevo cuando quieras.',
    transitorio:'Hay mucha actividad en este momento. Espera un instante e intenta de nuevo.',
    config:     'No estoy completamente configurado aún. Habla con el equipo técnico.',
    formato:    'Recibí una respuesta que no pude entender. Intenta de nuevo.',
    red:        'No pude conectarme en este momento. Estoy aquí contigo cuando vuelvas.',
    api:        'Tuve un problema al procesar tu mensaje. Intenta de nuevo.',
  };

  const fallback = mensajes[tipo] ?? mensajes.red;
  const detalle = err?.message ? ` Detalle: ${String(err.message).slice(0, 140)}` : '';

  // Retorna el avatar a neutral y entrega el texto al pipeline de audio
  cambiarEstadoEmocional('neutral');
  reproducirAudioAgente(fallback + (tipo === 'api' || tipo === 'transitorio' || tipo === 'formato' ? detalle : ''));
}

/**
 * Activa o desactiva el estado visual de "AURI está pensando".
 * Al esperar: deshabilita botones y muestra indicador en el PTT.
 * Al terminar: restaura la interactividad y el texto original.
 *
 * @param {boolean} esperando
 */
function _setUIEsperando(esperando) {
  // Bloquea / desbloquea todos los controles de entrada
  pttBtn.disabled = esperando;
  triggerBtns.forEach(b => { b.disabled = esperando; });

  if (esperando) {
    // Mueve el avatar a neutral mientras procesa (sin efecto animado brusco)
    cambiarEstadoEmocional('neutral');
    pttBtn.setAttribute('aria-label', 'AURI está pensando…');
    pttBtn.querySelector('.ptt-btn__etiqueta').textContent = 'AURI está pensando…';
  } else {
    pttBtn.setAttribute('aria-label', 'Pulsa para hablar');
    pttBtn.querySelector('.ptt-btn__etiqueta').textContent = 'Hablar';
  }
}


// ─────────────────────────────────────────────
// 5. INTERACCIONES – QUICK TRIGGERS
// ─────────────────────────────────────────────

triggerBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const texto = btn.textContent.trim();
    const trigger = btn.dataset.trigger;

    console.log(`Quick Trigger activado: "${texto}" [${trigger}]`);

    // Feedback visual: marca el botón activo y lo limpia al terminar
    triggerBtns.forEach(b => b.classList.remove('respuestas-rapidas__btn--activo'));
    btn.classList.add('respuestas-rapidas__btn--activo');
    setTimeout(() => btn.classList.remove('respuestas-rapidas__btn--activo'), 2000);

    procesarEntradaUsuario(texto);
  });
});


// ─────────────────────────────────────────────
// 6. BOTÓN PTT (Push-to-Talk)
// ─────────────────────────────────────────────

function activarGrabacion() {
  if (appState.isRecording) return;
  pttBtn.setAttribute('aria-label', 'Escuchando... pulsa para detener');
  iniciarReconocimientoVoz();
}

function desactivarGrabacion() {
  if (!appState.isRecording) return;
  _limpiarTimerSilencio();
  _enviarAlDetener = false;
  try { recognition?.stop(); } catch (e) { }
  console.log('Captura de voz detenida manualmente.');
}

// Botón Hablar: click para iniciar y click para detener.
pttBtn.addEventListener('click', () => {
  if (appState.isRecording) {
    desactivarGrabacion();
  } else {
    activarGrabacion();
  }
});


// ─────────────────────────────────────────────
// 7. CONTROL DE MUTE Y VOLUMEN
// ─────────────────────────────────────────────

function actualizarIconoMute() {
  const icon  = muteBtn.querySelector('.control-btn__icono');
  const label = muteBtn.querySelector('.control-btn__etiqueta');
  const muted = appState.isMuted;

  icon.textContent  = muted ? '🔇' : '🔊';
  label.textContent = muted ? 'Activar' : 'Silenciar';
  muteBtn.setAttribute('aria-pressed', String(muted));
  muteBtn.setAttribute('aria-label', muted ? 'Activar sonido' : 'Silenciar sonido');
}

muteBtn.addEventListener('click', () => {
  appState.isMuted = !appState.isMuted;
  actualizarIconoMute();
  console.log(`Audio ${appState.isMuted ? 'silenciado' : 'activado'}`);
  // TODO (Fase 2): propagar el estado de mute al AudioContext / SpeechSynthesis
});

volumeSlider.addEventListener('input', () => {
  const value = Number(volumeSlider.value);
  appState.volume = value;
  volumeSlider.setAttribute('aria-valuenow', value);

  // Refleja el porcentaje de relleno en el track del slider
  volumeSlider.style.background =
    `linear-gradient(to right, var(--color-accent) ${value}%, rgba(255,255,255,0.15) ${value}%)`;

  if (value === 0 && !appState.isMuted) {
    appState.isMuted = true;
    actualizarIconoMute();
  } else if (value > 0 && appState.isMuted) {
    appState.isMuted = false;
    actualizarIconoMute();
  }

  console.log(`Volumen: ${value}%`);
  // TODO (Fase 2): aplicar el volumen al AudioContext o SpeechSynthesis
});


// ═══════════════════════════════════════════════════════
// 8. MÓDULO DE MEMORIA PERSISTENTE  (sección 5.6)
// ───────────────────────────────────────────────────────
// Toda la información se guarda EXCLUSIVAMENTE en
// localStorage del navegador del usuario.
// Nada sale del dispositivo salvo lo que se inyecta al
// super-prompt de Gemini como contexto de conversación.
// El usuario puede borrar su perfil en cualquier momento
// con borrarMemoria() (derecho de supresión – privacidad).
// ═══════════════════════════════════════════════════════

const MEMORY_KEY     = 'auri_memory';
const MEMORY_VERSION = '1.1';

// ── 8.0 ESQUEMA DEL PERFIL ─────────────────────────────

/**
 * @typedef {Object} VectorTematico
 * Tema semántico detectado en la conversación con su peso acumulado.
 * @property {string} tema  – Etiqueta del tema (ej. 'culpa', 'añoranza')
 * @property {number} peso  – Número de veces detectado (refuerza relevancia)
 */

/**
 * @typedef {Object} Recuerdo
 * @property {string} clave  – Etiqueta descriptiva del recuerdo
 * @property {string} texto  – Contenido del recuerdo
 * @property {string} fecha  – ISO 8601
 */

/**
 * @typedef {Object} AuriMemory
 * Estructura completa del perfil persistente del doliente.
 * Todas las categorías son OPCIONALES y se completan progresivamente
 * a medida que el usuario comparte información voluntariamente.
 */
const MEMORY_BASE = {
  version:       MEMORY_VERSION,
  creadoEn:      '',
  actualizadoEn: '',

  /** Datos identitarios básicos */
  perfil: {
    nombre:    '',   // Nombre o apodo con el que el usuario prefiere ser llamado
    pronombre: '',   // 'él' | 'ella' | 'elle' | ''
  },

  /** Vector de la pérdida: describe QUÉ se perdió y su contexto */
  perdida: {
    tipo:          '', // 'familiar' | 'pareja' | 'amigo' | 'mascota' | 'empleo' | 'otro'
    nombreSer:     '', // Nombre de la persona/ser perdido (si se comparte)
    tiempoDesde:   '', // Descripción aproximada: '3 meses', 'hace un año', etc.
    descripcion:   '', // Fragmento libre que describe la pérdida
    /**
     * Vector temático de la pérdida.
     * Array de { tema, peso } ordenado por peso descendente.
     * Representa los ejes emocionales recurrentes de la conversación.
     * Ejemplo: [{ tema: 'culpa', peso: 3 }, { tema: 'añoranza', peso: 5 }]
     *
     * @type {VectorTematico[]}
     */
    vectorTematico: [],
  },

  /** Fragmentos de recuerdos compartidos voluntariamente */
  recuerdos: [],

  /** Metadatos de sesión para continuidad inter-sesión */
  sesion: {
    totalSesiones:  0,
    ultimaSesion:   '',
    turnosTotales:  0,  // Turnos acumulados entre todas las sesiones
  },
};

// ── 8.1 CAPA DE ALMACENAMIENTO (privada) ──────────────

/**
 * Lee y parsea `auri_memory` de localStorage.
 * Retorna null si no existe o si el JSON está corrompido.
 *
 * @returns {AuriMemory|null}
 */
function _leerMemoria() {
  try {
    const raw = localStorage.getItem(MEMORY_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.error('[Memoria] Error al leer auri_memory:', err);
    return null;
  }
}

/**
 * Persiste el objeto de memoria en localStorage.
 * Siempre actualiza `actualizadoEn` antes de escribir.
 *
 * @param {AuriMemory} memoria
 * @returns {boolean} true si la escritura fue exitosa
 */
function _escribirMemoria(memoria) {
  try {
    memoria.actualizadoEn = new Date().toISOString();
    localStorage.setItem(MEMORY_KEY, JSON.stringify(memoria));
    return true;
  } catch (err) {
    // localStorage puede fallar en modo privado o sin cuota disponible
    console.error('[Memoria] Error al escribir auri_memory:', err);
    return false;
  }
}

/**
 * Migra un perfil de una versión anterior a la versión actual del esquema.
 * Añade campos faltantes sin eliminar datos existentes.
 *
 * @param {Object} memoria – Perfil leído de localStorage (posiblemente v1.0)
 * @returns {AuriMemory}   – Perfil compatible con la versión actual
 */
function _migrarMemoria(memoria) {
  // v1.0 → v1.1: añadir vectorTematico y turnosTotales
  if (!memoria.perdida.vectorTematico) {
    memoria.perdida.vectorTematico = [];
  }
  if (memoria.sesion.turnosTotales === undefined) {
    memoria.sesion.turnosTotales = 0;
  }
  memoria.version = MEMORY_VERSION;
  return memoria;
}

// ── 8.2 INICIALIZACIÓN ────────────────────────────────

/**
 * Verifica si el perfil del doliente existe en localStorage.
 * Primera visita: crea el esquema base vacío.
 * Visitas sucesivas: incrementa el contador de sesión y migra si es necesario.
 *
 * @returns {AuriMemory}
 */
function inicializarMemoria() {
  let memoria = _leerMemoria();

  if (!memoria) {
    const ahora = new Date().toISOString();
    memoria = structuredClone(MEMORY_BASE);
    memoria.creadoEn      = ahora;
    memoria.actualizadoEn = ahora;
    _escribirMemoria(memoria);
    console.log('[Memoria] Perfil base creado (primera sesión).');
  } else {
    // Migra esquemas antiguos antes de operar
    if (memoria.version !== MEMORY_VERSION) {
      memoria = _migrarMemoria(memoria);
      console.log(`[Memoria] Migrado a v${MEMORY_VERSION}.`);
    }
    memoria.sesion.totalSesiones += 1;
    memoria.sesion.ultimaSesion   = new Date().toISOString();
    _escribirMemoria(memoria);
    console.log(`[Memoria] Sesión #${memoria.sesion.totalSesiones} iniciada.`);
  }

  return memoria;
}

// ── 8.3 API PÚBLICA: ESCRITURA ────────────────────────

/**
 * Guarda un campo en el perfil de memoria.
 * Soporta categorías planas (perfil, perdida, sesion) y la lista recuerdos.
 *
 * @param {'perfil'|'perdida'|'recuerdos'|'sesion'} categoria
 * @param {string} clave
 * @param {string} valor
 * @returns {boolean}
 *
 * @example
 * guardarDatoMemoria('perfil',   'nombre',    'María')
 * guardarDatoMemoria('perdida',  'tipo',      'familiar')
 * guardarDatoMemoria('recuerdos','Su risa',   'Siempre cantaba por las mañanas')
 */
function guardarDatoMemoria(categoria, clave, valor) {
  if (!categoria || !clave || valor === undefined || valor === '') {
    console.warn('[Memoria] guardarDatoMemoria: parámetros incompletos.', { categoria, clave, valor });
    return false;
  }

  const memoria = _leerMemoria();
  if (!memoria) {
    console.error('[Memoria] No existe auri_memory. Llama inicializarMemoria() primero.');
    return false;
  }

  if (categoria === 'recuerdos') {
    memoria.recuerdos.push({ clave, texto: valor, fecha: new Date().toISOString() });
  } else if (Object.prototype.hasOwnProperty.call(memoria, categoria)) {
    const seccion = memoria[categoria];
    if (typeof seccion !== 'object' || Array.isArray(seccion)) {
      console.warn(`[Memoria] La categoría "${categoria}" no es un objeto plano.`);
      return false;
    }
    seccion[clave] = valor;
  } else {
    console.warn(`[Memoria] Categoría desconocida: "${categoria}".`);
    return false;
  }

  const ok = _escribirMemoria(memoria);
  if (ok) console.log(`[Memoria] Guardado [${categoria}].${clave} = "${valor}"`);
  return ok;
}

/**
 * Atajo para guardar el nombre del usuario.
 * Verifica que no sobrescriba un nombre ya establecido sin confirmación
 * para evitar ruido por menciones de terceros en la conversación.
 *
 * @param {string} nombre
 * @returns {boolean}
 */
function guardarNombre(nombre) {
  const memoria = _leerMemoria();
  if (!memoria) return false;

  // Si ya hay un nombre guardado, no lo sobreescribas automáticamente
  if (memoria.perfil.nombre && memoria.perfil.nombre !== nombre) {
    console.log(`[Memoria] Nombre ya registrado ("${memoria.perfil.nombre}"). Nuevo candidato ignorado: "${nombre}".`);
    return false;
  }
  return guardarDatoMemoria('perfil', 'nombre', nombre);
}

/**
 * Añade nuevos temas al vector temático de la pérdida.
 * Si el tema ya existe, incrementa su peso; si es nuevo, lo agrega con peso 1.
 * Los temas se mantienen ordenados por peso descendente.
 *
 * @param {string[]} nuevosTemas – Lista de etiquetas temáticas a registrar
 * @returns {boolean}
 */
function actualizarVectorTematico(nuevosTemas) {
  if (!nuevosTemas || nuevosTemas.length === 0) return false;

  const memoria = _leerMemoria();
  if (!memoria) return false;

  const vector = memoria.perdida.vectorTematico;

  nuevosTemas.forEach(tema => {
    const entrada = vector.find(v => v.tema === tema);
    if (entrada) {
      entrada.peso += 1;
    } else {
      vector.push({ tema, peso: 1 });
    }
  });

  // Ordena por peso descendente para que el prompt refleje los temas más relevantes
  vector.sort((a, b) => b.peso - a.peso);

  // Limita a los 10 temas más relevantes para no saturar el prompt
  memoria.perdida.vectorTematico = vector.slice(0, 10);

  return _escribirMemoria(memoria);
}

// ── 8.4 EXTRACCIÓN AUTOMÁTICA DE LA CONVERSACIÓN ──────

/**
 * Reglas de extracción por categoría.
 * Cada regla tiene: patrón regex, función de captura y destino en memoria.
 * Se evalúan en cada turno del usuario de forma no bloqueante.
 */
const _REGLAS_EXTRACCION = {

  /** Detecta cómo se presenta el usuario y extrae su nombre */
  nombre: {
    patrones: [
      /(?:me llamo|mi nombre es|llámame|puedes llamarme|soy)\s+([A-ZÁÉÍÓÚÑÜ][a-záéíóúñü]{1,24})/i,
      /(?:^|\.\s+)([A-ZÁÉÍÓÚÑÜ][a-záéíóúñü]{2,24})(?:\s+es mi nombre)/i,
    ],
    accion: (coincidencia) => guardarNombre(coincidencia[1]),
  },

  /** Detecta el tipo de pérdida por el vínculo mencionado */
  tipoPerdida: {
    patrones: [
      { tipo: 'familiar', rx: /\b(?:mamá|papá|madre|padre|hijo|hija|hermano|hermana|abuelo|abuela|tío|tía|suegro|suegra|cuñado|cuñada)\b/i },
      { tipo: 'pareja',   rx: /\b(?:esposo|esposa|pareja|novio|novia|compañero|compañera|cónyuge|prometido|prometida)\b/i },
      { tipo: 'amigo',    rx: /\b(?:amigo|amiga|mejor amigo|mejor amiga|compadre|comadre)\b/i },
      { tipo: 'mascota',  rx: /\b(?:perro|gato|mascota|cachorro|gatita|gatito|peludo)\b/i },
      { tipo: 'empleo',   rx: /\b(?:trabajo|empleo|oficio|empresa|cargo|puesto)\b/i },
    ],
    accion: (tipo) => {
      const m = _leerMemoria();
      if (m && !m.perdida.tipo) guardarDatoMemoria('perdida', 'tipo', tipo);
    },
  },

  /** Detecta ejes emocionales para construir el vector temático */
  temasEmocionales: {
    temas: [
      { tema: 'culpa',      rx: /\b(?:culpa|culpable|debí|hubiese|si tan solo|ojalá hubiera)\b/i },
      { tema: 'añoranza',   rx: /\b(?:extraño|echo de menos|quisiera que volv|lo recuerdo|la recuerdo)\b/i },
      { tema: 'rabia',      rx: /\b(?:rabia|ira|enojo|enojado|furioso|molesto|indigna)\b/i },
      { tema: 'soledad',    rx: /\b(?:solo|sola|aislado|aislada|nadie|sin nadie|vacío|vacía)\b/i },
      { tema: 'nostalgia',  rx: /\b(?:antes|cuando estaba|cuando vivía|como antes|lo que era)\b/i },
      { tema: 'tristeza',   rx: /\b(?:triste|tristeza|lloro|llorando|lágrimas|llanto|deprimido)\b/i },
      { tema: 'negacion',   rx: /\b(?:no lo creo|no puede ser|no es cierto|imposible|no acepto)\b/i },
      { tema: 'miedo',      rx: /\b(?:miedo|temor|asustado|asustada|terror|pánico|angustia)\b/i },
      { tema: 'amor',       rx: /\b(?:amaba|amaba mucho|lo quería|la quería|amor|querer)\b/i },
      { tema: 'gratitud',   rx: /\b(?:gracias|agradecido|agradecida|bendecido|bendecida|afortunado)\b/i },
    ],
  },
};

/**
 * Analiza el texto del usuario para extraer y persistir datos de memoria
 * de forma automática y no intrusiva.
 *
 * Se llama de forma síncrona pero ligera (solo regex) después de cada turno
 * exitoso del usuario. No bloquea la UI ni el pipeline de respuesta.
 *
 * Extrae:
 *  - Nombre / apodo del usuario
 *  - Tipo de pérdida (vínculo con el ser perdido)
 *  - Temas emocionales recurrentes (vector temático)
 *
 * @param {string} textoUsuario – Entrada de la vuelta actual del usuario
 */
function extraerDatosConversacion(textoUsuario) {
  if (!textoUsuario || !textoUsuario.trim()) return;

  const texto = textoUsuario.trim();

  // ── Extracción de nombre ──────────────────────
  for (const patron of _REGLAS_EXTRACCION.nombre.patrones) {
    const coincidencia = texto.match(patron);
    if (coincidencia) {
      _REGLAS_EXTRACCION.nombre.accion(coincidencia);
      break; // Un nombre por turno es suficiente
    }
  }

  // ── Extracción de tipo de pérdida ─────────────
  for (const { tipo, rx } of _REGLAS_EXTRACCION.tipoPerdida.patrones) {
    if (rx.test(texto)) {
      _REGLAS_EXTRACCION.tipoPerdida.accion(tipo);
      break; // El primer vínculo detectado es el más probable
    }
  }

  // ── Extracción de temas emocionales ──────────
  const temasDetectados = _REGLAS_EXTRACCION.temasEmocionales.temas
    .filter(({ rx }) => rx.test(texto))
    .map(({ tema }) => tema);

  if (temasDetectados.length > 0) {
    actualizarVectorTematico(temasDetectados);
  }

  // Incrementa el contador de turnos en sesión
  const memoria = _leerMemoria();
  if (memoria) {
    memoria.sesion.turnosTotales = (memoria.sesion.turnosTotales ?? 0) + 1;
    _escribirMemoria(memoria);
  }
}

// ── 8.5 API PÚBLICA: LECTURA Y CONTEXTO ───────────────

/**
 * Lee `auri_memory` y lo serializa como XML estructurado `<user_memory>`,
 * listo para ser inyectado en el super-prompt de Gemini.
 *
 * Omite automáticamente campos vacíos para no añadir ruido al prompt.
 * Si no hay ningún dato significativo, devuelve cadena vacía.
 *
 * Formato de salida:
 * ┌─────────────────────────────────────────┐
 * │ <user_memory>                           │
 * │   <perfil>                              │
 * │     <nombre>María</nombre>              │
 * │   </perfil>                             │
 * │   <perdida>                             │
 * │     <tipo>familiar</tipo>               │
 * │     <vectorTematico>                    │
 * │       <tema peso="5">añoranza</tema>    │
 * │       <tema peso="3">culpa</tema>       │
 * │     </vectorTematico>                   │
 * │   </perdida>                            │
 * │   <recuerdos>                           │
 * │     <recuerdo clave="...">...</recuerdo>│
 * │   </recuerdos>                          │
 * │ </user_memory>                          │
 * └─────────────────────────────────────────┘
 *
 * @returns {string}
 */
function obtenerContextoMemoria() {
  const memoria = _leerMemoria();
  if (!memoria) return '';

  const { perfil, perdida, recuerdos } = memoria;
  const bloques = [];

  // ── Bloque perfil ─────────────────────────────
  const xmlPerfil = _objetoAXml(
    { nombre: perfil.nombre, pronombre: perfil.pronombre },
    'perfil'
  );
  if (xmlPerfil) bloques.push(xmlPerfil);

  // ── Bloque pérdida (campos escalares + vector temático) ───
  const camposEscalares = {
    tipo:        perdida.tipo,
    nombreSer:   perdida.nombreSer,
    tiempoDesde: perdida.tiempoDesde,
    descripcion: perdida.descripcion,
  };
  const xmlEscalares = _camposAXml(camposEscalares);

  let xmlVector = '';
  if (perdida.vectorTematico && perdida.vectorTematico.length > 0) {
    const temas = perdida.vectorTematico
      .map(v => `      <tema peso="${v.peso}">${_escaparXml(v.tema)}</tema>`)
      .join('\n');
    xmlVector = `    <vectorTematico>\n${temas}\n    </vectorTematico>`;
  }

  const contenidoPerdida = [xmlEscalares, xmlVector].filter(Boolean).join('\n');
  if (contenidoPerdida) {
    bloques.push(`  <perdida>\n${contenidoPerdida}\n  </perdida>`);
  }

  // ── Bloque recuerdos ─────────────────────────
  if (recuerdos.length > 0) {
    // Muestra los últimos 5 recuerdos para no saturar el contexto
    const ultimos = recuerdos.slice(-5);
    const items = ultimos
      .map(r => `    <recuerdo clave="${_escaparXml(r.clave)}" fecha="${r.fecha}">${_escaparXml(r.texto)}</recuerdo>`)
      .join('\n');
    bloques.push(`  <recuerdos>\n${items}\n  </recuerdos>`);
  }

  if (bloques.length === 0) return '';

  return `<user_memory>\n${bloques.join('\n')}\n</user_memory>`;
}

// ── 8.6 API PÚBLICA: PRIVACIDAD ───────────────────────

/**
 * Elimina completamente el perfil de memoria de localStorage.
 * Crea inmediatamente un perfil vacío nuevo (respeta el consentimiento
 * pero reinicia el historial para la privacidad del usuario).
 *
 * @returns {boolean}
 */
function borrarMemoria() {
  try {
    localStorage.removeItem(MEMORY_KEY);
    reiniciarHistorial();
    inicializarMemoria();
    console.log('[Memoria] Perfil eliminado y reiniciado por solicitud del usuario.');
    return true;
  } catch (err) {
    console.error('[Memoria] Error al borrar la memoria:', err);
    return false;
  }
}

/**
 * Borra un campo específico del perfil sin eliminar el resto de los datos.
 * Permite supresión granular (ej. borrar solo el nombre).
 *
 * @param {'perfil'|'perdida'} categoria
 * @param {string}             clave     – Campo a borrar dentro de la categoría
 * @returns {boolean}
 *
 * @example
 * borrarCampo('perfil', 'nombre')
 * borrarCampo('perdida', 'vectorTematico')
 */
function borrarCampo(categoria, clave) {
  const memoria = _leerMemoria();
  if (!memoria) return false;

  const seccion = memoria[categoria];
  if (!seccion || !Object.prototype.hasOwnProperty.call(seccion, clave)) {
    console.warn(`[Memoria] Campo no encontrado: [${categoria}].${clave}`);
    return false;
  }

  // Resetea según el tipo original del campo
  seccion[clave] = Array.isArray(seccion[clave]) ? [] : '';
  const ok = _escribirMemoria(memoria);
  if (ok) console.log(`[Memoria] Campo [${categoria}].${clave} borrado.`);
  return ok;
}

/**
 * Devuelve un resumen legible del perfil actual para depuración en DevTools.
 * No altera ningún dato; solo lectura.
 *
 * @returns {Object|null}
 */
function obtenerResumenMemoria() {
  const m = _leerMemoria();
  if (!m) return null;
  return {
    nombre:         m.perfil.nombre || '(no registrado)',
    tipoPerdida:    m.perdida.tipo  || '(no detectado)',
    temasTop3:      m.perdida.vectorTematico.slice(0, 3).map(v => `${v.tema}(${v.peso})`).join(', ') || '(ninguno)',
    recuerdos:      m.recuerdos.length,
    sesiones:       m.sesion.totalSesiones,
    turnosTotales:  m.sesion.turnosTotales,
    creadoEn:       m.creadoEn,
  };
}

// ── 8.7 UTILIDADES INTERNAS XML ───────────────────────

/**
 * Convierte un objeto plano (solo valores escalares) en líneas XML anidadas.
 * Omite campos vacíos, null o undefined.
 * Retorna string vacío si no hay ningún campo con valor.
 *
 * @param {Object} obj
 * @returns {string} Líneas XML sin etiqueta contenedora
 */
function _camposAXml(obj) {
  return Object.entries(obj)
    .filter(([, v]) => v !== '' && v !== null && v !== undefined)
    .map(([k, v]) => `    <${k}>${_escaparXml(String(v))}</${k}>`)
    .join('\n');
}

/**
 * Convierte un objeto plano en un bloque XML con etiqueta contenedora.
 * Usa _camposAXml internamente.
 *
 * @param {Object} obj
 * @param {string} etiqueta
 * @returns {string}
 */
function _objetoAXml(obj, etiqueta) {
  const contenido = _camposAXml(obj);
  return contenido ? `  <${etiqueta}>\n${contenido}\n  </${etiqueta}>` : '';
}

/**
 * Escapa los 5 caracteres reservados de XML para prevenir inyecciones
 * en el super-prompt de Gemini a través de datos del usuario.
 *
 * @param {string} str
 * @returns {string}
 */
function _escaparXml(str) {
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&apos;');
}


// ─────────────────────────────────────────────
// 9. NAVEGACIÓN ENTRE VISTAS (SPA)
// ─────────────────────────────────────────────

const vistaWearable  = document.getElementById('vista-wearable');
const vistaApp       = document.getElementById('vista-app');
const btnAbrirApp    = document.getElementById('btn-abrir-app');
const btnVolverWear  = document.getElementById('btn-volver-wearable');
const estadoAuri     = document.getElementById('estado-auri');
const companionNombre = document.getElementById('companion-nombre-usuario');

/**
 * Alterna entre la vista del colgante y la app compañera.
 * Actualiza aria-label y clases del botón flotante para reflejar
 * la vista activa en todo momento.
 *
 * @param {'wearable'|'app'} vistaDestino
 */
function navegarVista(vistaDestino) {
  const esApp = vistaDestino === 'app';

  // Muestra / oculta secciones usando el atributo [hidden] nativo
  vistaWearable.hidden = esApp;
  vistaApp.hidden      = !esApp;

  // Actualiza el botón flotante
  btnAbrirApp.dataset.vista = vistaDestino;
  btnAbrirApp.classList.toggle('btn-abrir-app--en-app', esApp);
  btnAbrirApp.setAttribute(
    'aria-label',
    esApp ? 'Ver el colgante AURI' : 'Abrir App Compañera de AURI'
  );
  btnAbrirApp.querySelector('.btn-abrir-app__icono').textContent = esApp ? '⌚' : '📱';
  btnAbrirApp.querySelector('.btn-abrir-app__etiqueta').textContent = esApp ? 'Colgante' : 'App';

  // Si entramos a la app, sincroniza recuerdos y nombre del perfil
  if (esApp) {
    _sincronizarVistaApp();
  }

  console.log(`[AURI] Vista activa: ${vistaDestino}`);
}

/** Rellena la vista App con los datos actuales de la memoria. */
function _sincronizarVistaApp() {
  const memoria = _leerMemoria();
  if (!memoria) return;

  // Muestra el nombre del usuario si ya fue guardado
  const nombre = memoria.perfil.nombre;
  if (companionNombre) {
    companionNombre.textContent = nombre ? `Hola, ${nombre}` : '';
  }

  // Sincroniza la lista de recuerdos
  _renderizarListaRecuerdos(memoria.recuerdos);
}

/**
 * Renderiza la lista de recuerdos guardados en el panel lateral.
 *
 * @param {Array<{clave: string, texto: string, fecha: string}>} recuerdos
 */
function _renderizarListaRecuerdos(recuerdos) {
  const lista  = document.getElementById('lista-recuerdos');
  const vacio  = document.getElementById('recuerdos-vacio');
  if (!lista) return;

  // Limpia ítems previos conservando el li#recuerdos-vacio
  lista.querySelectorAll('.panel-recuerdos__item').forEach(el => el.remove());

  if (recuerdos.length === 0) {
    if (vacio) vacio.hidden = false;
    return;
  }

  if (vacio) vacio.hidden = true;

  recuerdos.slice().reverse().forEach(r => {
    const li = document.createElement('li');
    li.className = 'panel-recuerdos__item';
    li.innerHTML = `
      <div>
        <p class="panel-recuerdos__item-clave">${_escaparHtml(r.clave)}</p>
        <p class="panel-recuerdos__item-texto">${_escaparHtml(r.texto)}</p>
      </div>`;
    lista.appendChild(li);
  });
}

/** Escapa HTML para prevenir XSS en contenido dinámico del DOM. */
function _escaparHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Eventos de navegación entre vistas
btnAbrirApp.addEventListener('click', () => {
  const vistaActual = btnAbrirApp.dataset.vista;
  navegarVista(vistaActual === 'wearable' ? 'app' : 'wearable');
});

if (btnVolverWear) {
  btnVolverWear.addEventListener('click', () => navegarVista('wearable'));
}

// Formulario de recuerdos en la App Compañera
const formRecuerdo = document.getElementById('form-recuerdo');
if (formRecuerdo) {
  formRecuerdo.addEventListener('submit', (e) => {
    e.preventDefault();
    const inputClave = document.getElementById('recuerdo-clave');
    const inputTexto = document.getElementById('recuerdo-texto');

    const clave = inputClave?.value.trim();
    const texto = inputTexto?.value.trim();

    if (!clave || !texto) return;

    const ok = guardarDatoMemoria('recuerdos', clave, texto);
    if (ok) {
      inputClave.value = '';
      inputTexto.value = '';
      // Re-renderiza la lista con el nuevo recuerdo
      const memoria = _leerMemoria();
      if (memoria) _renderizarListaRecuerdos(memoria.recuerdos);
    }
  });
}

// Formulario de chat por texto desde la App Compañera
const formChat  = document.getElementById('form-chat');
const chatInput = document.getElementById('chat-input');
if (formChat) {
  formChat.addEventListener('submit', (e) => {
    e.preventDefault();
    const texto = chatInput?.value.trim();
    if (!texto) return;
    chatInput.value = '';
    _añadirBurbujaChat('usuario', texto);
    procesarEntradaUsuario(texto);
  });
}

// Botón de borrar memoria
const btnBorrarMemoria = document.getElementById('btn-borrar-memoria');
if (btnBorrarMemoria) {
  btnBorrarMemoria.addEventListener('click', () => {
    const confirmado = window.confirm(
      '¿Quieres borrar toda tu memoria de AURI?\nEsto eliminará tu nombre, datos de pérdida y recuerdos guardados en este dispositivo.'
    );
    if (confirmado) {
      borrarMemoria();
      _renderizarListaRecuerdos([]);
      if (companionNombre) companionNombre.textContent = '';
      console.log('[AURI] Memoria borrada por solicitud del usuario.');
    }
  });
}

/**
 * Añade una burbuja de chat al historial de la App Compañera.
 * Llamada internamente cuando el usuario escribe o cuando AURI responde.
 *
 * @param {'usuario'|'auri'} autor
 * @param {string}           texto
 */
function _añadirBurbujaChat(autor, texto) {
  const historial = document.getElementById('chat-historial');
  if (!historial) return;

  // Oculta el mensaje de "historial vacío" al recibir el primer mensaje
  const vacio = document.getElementById('chat-vacio');
  if (vacio) vacio.hidden = true;

  const burbuja = document.createElement('article');
  burbuja.className = `chat-burbuja chat-burbuja--${autor}`;
  burbuja.setAttribute('aria-label', `Mensaje de ${autor === 'auri' ? 'AURI' : 'tú'}`);
  burbuja.innerHTML = `
    <p class="chat-burbuja__autor">${autor === 'auri' ? 'AURI' : 'Tú'}</p>
    <p>${_escaparHtml(texto)}</p>`;

  historial.appendChild(burbuja);

  // Desplaza el scroll al fondo para mostrar el mensaje más reciente
  historial.scrollTop = historial.scrollHeight;
}

// Expone _añadirBurbujaChat para que reproducirAudioAgente pueda llamarla
// cuando AURI responde (conexión entre el pipeline de voz y el chat)
appState._añadirBurbujaChat = _añadirBurbujaChat;


// ─────────────────────────────────────────────
// 10. INICIALIZACIÓN
// ─────────────────────────────────────────────

(function init() {
  // Estado emocional inicial del avatar
  cambiarEstadoEmocional('neutral');

  // Vista inicial: el colgante
  navegarVista('wearable');

  console.log('[AURI] Inicializado. Esperando aceptación del modal.');
})();

// La memoria se inicializa tras aceptar el modal (respeta el consentimiento).
acceptBtn.addEventListener('click', () => {
  const memoria = inicializarMemoria();
  const contexto = obtenerContextoMemoria();

  if (contexto) {
    console.log('[Memoria] Contexto disponible para el prompt:\n', contexto);
  } else {
    console.log('[Memoria] Primera sesión – no hay contexto previo.');
  }

  appState.contextoMemoria = contexto;
}, { once: true });
