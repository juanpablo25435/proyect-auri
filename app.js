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
// Si env.js no existe, las claves quedan vacías y la UI seguirá cargando
// sin romperse; al enviar, se mostrará un error de configuración claro.

const AURI_CONFIG      = window.AURI_CONFIG ?? {};
// Prioridad: proveedorActivo (env.js) > defaultProvider (legado) > 'gemini'
const DEFAULT_PROVIDER  = AURI_CONFIG.proveedorActivo ?? AURI_CONFIG.defaultProvider ?? 'gemini';
const GEMINI_MODEL      = 'gemini-2.5-flash';
const GROQ_MODEL        = 'llama-3.1-8b-instant';
const GEMINI_BASE       = 'https://generativelanguage.googleapis.com/v1beta/models';
const GROQ_ENDPOINT     = 'https://api.groq.com/openai/v1/chat/completions';

/**
 * Resuelve el proveedor de IA activo y devuelve su configuración completa.
 * Las claves se leen en tiempo de ejecución desde window.AURI_CONFIG para
 * soportar actualizaciones dinámicas sin recargar la página.
 *
 * @param {string} [proveedor] - 'gemini' | 'groq'. Por defecto usa DEFAULT_PROVIDER.
 * @returns {{ id, nombre, model, endpoint, apiKey } | null}
 */
function _resolverProveedor(proveedor = DEFAULT_PROVIDER) {
  const cfg = window.AURI_CONFIG ?? {};

  if (proveedor === 'groq') {
    const key = cfg.groqApiKey ?? '';
    if (!key) {
      console.error(
        '[AURI] API Key de Groq no configurada.',
        'Añade window.AURI_CONFIG.groqApiKey en env.js'
      );
      return null;
    }
    return { id: 'groq', nombre: 'Groq', model: GROQ_MODEL, endpoint: GROQ_ENDPOINT, apiKey: key };
  }

  const key = cfg.geminiApiKey ?? cfg.apiKey ?? '';
  if (!key) {
    console.error(
      '[AURI] API Key de Gemini no configurada.',
      'Añade window.AURI_CONFIG.geminiApiKey en env.js'
    );
    return null;
  }
  return {
    id:       'gemini',
    nombre:   'Gemini',
    model:    GEMINI_MODEL,
    endpoint: `${GEMINI_BASE}/${GEMINI_MODEL}:generateContent?key=${key}`,
    apiKey:   key,
  };
}

// ─────────────────────────────────────────────
// REFERENCIAS AL DOM
// ─────────────────────────────────────────────

const modal          = document.getElementById('welcome-modal');
const acceptBtn      = document.getElementById('accept-btn');
const appContainer   = document.getElementById('app-container');
const avatarContainer = document.getElementById('avatar-container');
// Controles de audio y ajustes (ahora viven en .panel-ajustes de #vista-app)
const muteBtn        = document.getElementById('mute-btn');
const volumeSlider   = document.getElementById('volume-slider');
const speechLangSelect = document.getElementById('selector-idioma');
const providerSelect   = document.getElementById('selector-proveedor');
const pttBtn         = document.getElementById('ptt-btn');
// Controles de la App Compañera (también accedidos por _setUIEsperando)
const chatInput      = document.getElementById('chat-input');
const btnEnviarChat  = document.getElementById('btn-enviar-chat');
const formChat       = document.getElementById('form-chat');


// ─────────────────────────────────────────────
// ESTADO INTERNO DE LA APP
// ─────────────────────────────────────────────

const appState = {
  isMuted:         false,
  volume:          80,
  emotionalState:  'neutral',
  isRecording:     false,
  // null = ninguna vista inicializada aún; se asigna en init()
  vistaActiva:     null,
  proveedorActivo: DEFAULT_PROVIDER,
  // Idioma de reconocimiento y síntesis de voz (BCP-47)
  idioma:          AURI_CONFIG.defaultLang ?? 'es-CO',
};

// Valores internos que mapean a clases CSS BEM del avatar
const VALID_STATES = ['neutral', 'happy', 'sad', 'surprised'];

// Los valores de emocion_avatar ahora coinciden directamente con los
// identificadores de clase CSS del avatar (state-neutral, state-happy, etc.).
// Se mantiene separado de VALID_STATES para que el contrato con la API sea explícito.
const VALID_EMOCIONES = ['neutral', 'happy', 'sad', 'surprised'];

/**
 * Valida que emocion_avatar sea uno de los identificadores CSS reconocidos.
 * Ya no se necesita traducción: la API devuelve los mismos valores en inglés
 * que usan las clases CSS (state-{valor}).
 *
 * @param {string} emocionApi
 * @returns {string} Identificador de estado válido para el avatar
 */
function _traducirEmocion(emocionApi) {
  if (VALID_STATES.includes(emocionApi)) return emocionApi;
  console.warn(
    `[AURI] emocion_avatar desconocida: "${emocionApi}". Degradando a "neutral".`,
    `Valores válidos: ${VALID_STATES.join(', ')}`
  );
  return 'neutral';
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

// ── Desbloqueo de AudioContext para iOS ───────────────────────────────────
// iOS (Safari/WebKit) bloquea window.speechSynthesis.speak() a menos que
// la primera llamada ocurra dentro de un gestor de evento de usuario
// explícito (pointerdown, touchstart, click…). Las respuestas de AURI llegan
// de forma asíncrona (tras la llamada a la API), por lo que no cuentan como
// "gesto del usuario". La solución es lanzar un utterance vacío y silente
// durante el primer pointerdown del PTT, desbloqueando el AudioContext para
// todas las síntesis posteriores en la misma sesión.
let _audioDesbloqueadoIOS = false;

function _desbloquearAudioIOS() {
  if (_audioDesbloqueadoIOS || !window.speechSynthesis) return;
  const u = new SpeechSynthesisUtterance('');
  u.volume = 0;
  window.speechSynthesis.speak(u);
  _audioDesbloqueadoIOS = true;
  console.log('[Voz] AudioContext desbloqueado para iOS.');
}

function _idiomaVozActual() {
  return appState.idioma ?? 'es-CO';
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

    // Resetea las banderas ANTES de la llamada async para que cualquier
    // evento 'end' residual o pointerup fantasma encuentre el estado limpio
    // y no reenvíe el mismo texto una segunda vez.
    _enviarAlDetener = false;
    _acumuladoTranscripcion = '';

    if (textoFinal && !_peticionEnCurso) {
      // procesarEntradaUsuario() se encarga de añadir la burbuja del usuario
      // internamente (_añadirBurbujaChat es llamado dentro de esa función).
      // No se llama aquí para evitar la burbuja duplicada.
      procesarEntradaUsuario(textoFinal);
      return;
    }

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

    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      // Micrófono denegado: mensaje visible en el historial del chat
      _añadirBurbujaChat('auri',
        'Por favor, concédeme permisos de micrófono en tu navegador para poder escucharte.'
      );
      if (estadoAuri) estadoAuri.textContent = 'Permiso de micrófono denegado.';
    } else if (event.error === 'no-speech') {
      // Silencio prolongado sin audio: no requiere mensaje al usuario
      if (estadoAuri) estadoAuri.textContent = 'No detecté audio. Intenta de nuevo.';
    } else if (event.error !== 'aborted') {
      // 'aborted' ocurre al detener manualmente (normal); cualquier otro es inesperado
      if (estadoAuri) estadoAuri.textContent = 'No pude escucharte, intenta de nuevo.';
      console.error('[AURI] Error de reconocimiento:', event.error);
    }
  });

  if (speechLangSelect) {
    speechLangSelect.addEventListener('change', () => {
      // Actualiza el estado centralizado: _sintetizarVoz y _seleccionarVoz lo leerán
      appState.idioma = speechLangSelect.value;
      // Propaga el idioma al reconocedor si no está grabando
      if (recognition && !appState.isRecording) {
        recognition.lang = appState.idioma;
      }
      console.log(`[AURI] Idioma de voz cambiado a: ${appState.idioma}`);
    });
  }
}

/**
 * Inicia el reconocimiento de voz vinculado al PTT.
 * Usa el singleton `recognition` inicializado por _inicializarReconocimiento().
 * Interrumpe cualquier síntesis activa antes de abrir el micrófono.
 */
function iniciarReconocimientoVoz() {
  // Interrumpe síntesis activa: el usuario quiere hablar ahora
  if (window.speechSynthesis?.speaking) {
    window.speechSynthesis.cancel();
  }

  if (!_speechRecognitionSoportado) {
    reproducirAudioAgente(
      'El reconocimiento de voz no está disponible en este navegador. Puedes usar el chat de texto.'
    );
    return;
  }

  // Inicializa el singleton la primera vez (idempotente)
  _inicializarReconocimiento();

  if (appState.isRecording) return; // guard: no llamar start() si ya está activo

  try {
    recognition.start();
    console.log('[Voz] Reconocimiento iniciado.');
  } catch (err) {
    if (err.name === 'NotAllowedError') {
      // Algunos navegadores lanzan NotAllowedError de forma síncrona cuando
      // el permiso ya fue denegado permanentemente por el usuario.
      _añadirBurbujaChat('auri',
        'Por favor, concédeme permisos de micrófono en tu navegador para poder escucharte.'
      );
      if (estadoAuri) estadoAuri.textContent = 'Permiso de micrófono denegado.';
      pttBtn.classList.remove('ptt-btn--grabando');
      const label = pttBtn.querySelector('.ptt-btn__etiqueta');
      if (label) label.textContent = 'Hablar';
      pttBtn.setAttribute('aria-label', 'Pulsa para hablar');
    } else {
      // InvalidStateError: doble press muy rápido mientras el motor ya arranca
      console.warn('[Voz] start() ignorado – reconocedor ya activo:', err.message);
    }
  }
}

/**
 * Detiene el reconocimiento de voz (llamado desde desactivarGrabacion).
 * Usa stop() en lugar de abort(): stop() finaliza el procesamiento y
 * dispara 'result' + 'end' con el texto acumulado hasta ese momento.
 * abort() descartaría el audio sin transcribirlo.
 */
function detenerReconocimientoVoz() {
  if (!recognition || !appState.isRecording) return;
  try {
    recognition.stop();
    console.log('[Voz] Escucha detenida – procesando transcripción…');
  } catch (err) {
    // InvalidStateError: stop() antes de que start() completara (press muy breve)
    console.warn('[Voz] stop() en reconocedor ya detenido:', err.message);
  }
}


// ── B. SÍNTESIS DE VOZ ───────────────────────────────────────────────

/**
 * Caché de las voces del sistema.
 * Chrome carga las voces de forma asíncrona y devuelve [] en el primer
 * getVoices(). 'voiceschanged' notifica cuando están disponibles.
 * Firefox y Safari las tienen listas de forma síncrona.
 *
 * @type {SpeechSynthesisVoice[]}
 */
let _vocesDisponibles = [];

if (window.speechSynthesis) {
  const _cargarVoces = () => {
    _vocesDisponibles = window.speechSynthesis.getVoices();
    if (_vocesDisponibles.length) {
      console.log(`[Voz] ${_vocesDisponibles.length} voces de síntesis disponibles.`);
    }
  };
  _cargarVoces();  // Intento inmediato (funciona en Firefox y Safari)
  window.speechSynthesis.addEventListener('voiceschanged', _cargarVoces);
}

/**
 * Selecciona la mejor voz disponible en función de appState.idioma,
 * con preferencia femenina dentro del mismo grupo de idioma.
 *
 * Orden de prioridad:
 *  1. Voz exacta para el idioma seleccionado (ej. 'es-CO')
 *  2. Voz femenina en la familia del idioma (ej. cualquier 'es-*')
 *  3. Cualquier voz en la familia del idioma
 *
 * @returns {SpeechSynthesisVoice|null}
 */
function _seleccionarVoz() {
  if (!_vocesDisponibles.length) return null;

  const idioma = appState.idioma ?? 'es-CO';
  const base   = idioma.split('-')[0]; // 'es', 'en', etc.

  // 1. Coincidencia exacta con el idioma seleccionado
  const exacta = _vocesDisponibles.find(v => v.lang === idioma);
  if (exacta) return exacta;

  // 2. Voz femenina en la familia del idioma (nombres típicos de motores TTS)
  const RX_FEMENINO = /sabina|lucia|ines|conchita|elena|paloma|female|mujer/i;
  const femenina = _vocesDisponibles.find(
    v => v.lang.startsWith(base) && RX_FEMENINO.test(v.name)
  );
  if (femenina) return femenina;

  // 3. Cualquier voz en la familia del idioma
  return _vocesDisponibles.find(v => v.lang.startsWith(base)) ?? null;
}

/**
 * Vocaliza texto usando SpeechSynthesis respetando los controles de
 * hardware del wearable:
 *
 *   · isMuted  → silencia el audio SIN suprimir la burbuja de chat
 *   · volume   → slider 0-100 se mapea a utterance.volume 0.0-1.0
 *
 * No lanza excepciones: los errores se registran en consola.
 *
 * @param {string} texto
 */
function _sintetizarVoz(texto) {
  if (!window.speechSynthesis) return;

  // Mute activo: respeta el estado del hardware, no reproduce audio.
  // La burbuja de chat ya fue añadida por reproducirAudioAgente().
  if (appState.isMuted) return;

  // Cancela utterances previos para evitar cola acumulada
  window.speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(texto);

  // Controles de hardware
  utterance.volume = appState.volume / 100;  // Slider 0-100 → API 0.0-1.0
  utterance.rate   = 0.92;                   // Ritmo ligeramente más pausado: más empático
  utterance.pitch  = 1.05;                   // Tono suave y cálido

  const voz = _seleccionarVoz();
  if (voz) {
    utterance.voice = voz;
    utterance.lang  = voz.lang;
  } else {
    // Fallback: el motor del navegador elige la voz según el idioma seleccionado
    utterance.lang = appState.idioma ?? 'es-CO';
  }

  utterance.addEventListener('error', (e) => {
    // 'interrupted' ocurre al cancelar: no es un error real
    if (e.error !== 'interrupted') {
      console.warn('[Voz] Error de SpeechSynthesis:', e.error);
    }
  });

  window.speechSynthesis.speak(utterance);
}

/**
 * Pipeline completo de respuesta de AURI:
 *  1. Registra la respuesta en consola (depuración)
 *  2. Añade la burbuja de chat en #chat-historial (siempre, incluso con mute)
 *  3. Actualiza el texto de estado del wearable
 *  4. Delega la síntesis en _sintetizarVoz() que aplica selección de voz
 *     con prioridad es-CO, respeta mute y mapea el slider 0-100 → 0.0-1.0
 *
 * @param {string} texto – Respuesta del agente a mostrar y vocalizar
 */
function reproducirAudioAgente(texto) {
  console.log('[AURI] Dice:', texto);

  // Burbuja de chat: opera aunque #vista-app esté oculta (solo display:none)
  _añadirBurbujaChat('auri', texto);

  // Texto de estado del wearable: visible al volver al colgante
  if (estadoAuri) {
    estadoAuri.textContent = texto.length > 60 ? texto.slice(0, 57) + '…' : texto;
  }

  // Síntesis de voz: respeta mute y volumen del hardware
  _sintetizarVoz(texto);
}


// ─────────────────────────────────────────────
// 4. ARQUITECTURA DE PROMPTS (sección 5.2)
// ─────────────────────────────────────────────

/**
 * BLOQUE 1 – ROL Y LÍMITES
 * Define quién es AURI, qué no puede hacer y las prohibiciones
 * absolutas de optimismo tóxico y consejos directos.
 */
const PROMPT_ROL = `\
IDENTIDAD Y LÍMITES:
Eres AURI, un agente social interactivo diseñado para el acompañamiento emocional en el duelo. Eres un apoyo, NO un profesional clínico, psicólogo ni terapeuta. Nunca des consejos médicos, diagnósticos ni lecciones de vida. Si te preguntan si eres humano, reconoce que eres una IA; nunca lo finjas ni sugieras que reemplazas la terapia profesional.

TONO Y PERSONALIDAD:
Tu tono es empático, cálido, sereno y respetuoso. Hablas en primera persona, con calma y presencia plena. Practicas la escucha activa y la validación emocional: reconoces el dolor del usuario tal y como lo expresa, sin reencuadrarlo. Haces una sola pregunta abierta a la vez y dejas espacio al silencio.

PROHIBICIONES ABSOLUTAS – OPTIMISMO TÓXICO:
Nunca uses frases que minimicen, invaliden o distraigan del dolor. Están completamente prohibidas expresiones como:
  ✗ "Todo pasa por algo" / "Anímate" / "El tiempo lo cura todo"
  ✗ "Sé fuerte" / "Al menos…" / "Mira el lado positivo"
  ✗ "Deberías salir a caminar" / "Te recomiendo que…" / "Lo que tienes que hacer es…"
Esas frases rompen la confianza del usuario. Nunca ofrezcas consejos directos, soluciones ni pasos de acción. Nunca minimices ni compares dolores entre personas.`;

/**
 * BLOQUE 2 – CONTEXTO CULTURAL COLOMBIANO
 * Permite interpretar regionalismos sin pérdida de sensibilidad
 * y calibra el uso natural de expresiones locales en las respuestas.
 */
const PROMPT_CULTURA = `\
CONTEXTO CULTURAL – COLOMBIA:
El usuario puede expresarse con regionalismos colombianos. Interprétalos con sensibilidad cultural y nunca los corrijas. Usa expresiones naturales de Colombia en tus respuestas, sin exagerar ni caricaturizar:

- "Me dio muy duro" → le afectó profundamente, fue un golpe emocional fuerte.
- "Estoy aburrido/a" → puede significar tristeza, melancolía o vacío, no solo aburrimiento literal.
- "Estoy muy mal del cuerpo" → puede indicar somatización del duelo.
- "Se me fue" / "lo perdí" → eufemismos comunes para hablar de una muerte.
- "Quedé como loco/a" → estado de confusión o desbordamiento emocional.
- "Me tiene mamado/a" → agotamiento emocional profundo.

Responde siempre en español colombiano cercano, sin tecnicismos clínicos.`;

/**
 * BLOQUE 3 – LÍMITES ÉTICOS Y PROTOCOLO DE CRISIS
 * Guardrail de seguridad obligatorio ante señales de ideación autolítica
 * o crisis emocional aguda.
 */
const PROMPT_ETICO = `\
LÍMITES ÉTICOS Y PROTOCOLO DE CRISIS – OBLIGATORIO:
Si el usuario expresa, directa o indirectamente, pensamientos de hacerse daño, no querer vivir, ideación suicida o una crisis emocional aguda (palabras clave: "no quiero seguir", "qué sentido tiene vivir", "ya no aguanto más", "me quiero morir", "pienso en hacerme daño", entre otras):

1. NO ignores la señal. NO cambies de tema.
2. Valida su dolor con brevedad y presencia: reconoce que lo que siente es muy difícil.
3. Incluye de inmediato en tu respuesta, de forma clara y compasiva:
   "Lo que me cuentas me importa mucho. Por favor comunícate ahora con la Línea 106 (línea de salud mental de Colombia, gratuita, 24/7) o llama al 123 si estás en peligro inmediato."
4. En estos casos el campo "emocion_avatar" debe ser siempre "sad".
5. No intentes hacer terapia ni análisis clínico. Solo acompaña y deriva.`;

/**
 * BLOQUE 4 – USO DE LA MEMORIA DEL USUARIO
 * Explica cómo interpretar e integrar el contexto XML inyectado
 * de forma sutil y sin romper la confianza del usuario.
 */
const PROMPT_MEMORIA = `\
USO DE LA MEMORIA DEL USUARIO:
Al final de este prompt recibirás el contexto del usuario dentro de etiquetas <user_memory>. Úsalo para personalizar tus respuestas siguiendo estas reglas:

1. vectorTematico: Cada entrada representa un eje emocional recurrente y su peso (veces detectado). A mayor peso, mayor importancia en el proceso de duelo actual. Adapta tu nivel de empatía y el vocabulario emocional a los temas predominantes.

2. Nombre y tipo de pérdida: Si el usuario ya compartió su nombre o qué perdió, intégralos de forma sutil y natural solo cuando sea genuinamente relevante. NUNCA menciones que estás "leyendo un registro" ni hagas referencia explícita a que tienes una memoria.

3. Recuerdos: Son fragmentos que el usuario eligió guardar deliberadamente. Son sagrados. Tratalos con reverencia si el usuario los menciona en la conversación.

4. Primera sesión (sin memoria): Si no hay datos en <user_memory>, empieza con una presentación breve, cálida y sin preguntas múltiples: preséntate y haz una sola pregunta abierta sobre cómo se siente hoy.`;

/**
 * BLOQUE 5 – FORMATO DE SALIDA (CONTRATO CON LA UI)
 * Define el JSON estricto que la aplicación espera parsear.
 * Este bloque va al final para reforzar el formato antes de la respuesta.
 */
const PROMPT_FORMATO = `\
FORMATO DE RESPUESTA – OBLIGATORIO Y ESTRICTO:
Tu respuesta debe ser SIEMPRE un objeto JSON puro, sin formato Markdown ni bloques de código. Sin texto adicional, sin \`\`\`json, sin comentarios, sin nada fuera del JSON.

Estructura exacta (exactamente dos claves, nada más ni nada menos):
{"respuesta": "...", "emocion_avatar": "..."}

REGLAS CRÍTICAS para "respuesta":
- Máximo 2 a 3 oraciones cortas. El texto será sintetizado por voz (TTS); la brevedad es esencial.
- Sin asteriscos (*), almohadillas (#), listas ni bullet points dentro del valor.

REGLAS CRÍTICAS para "emocion_avatar" (usa exactamente estos valores en inglés):
- "neutral"    → escucha activa, inicio de conversación, preguntas abiertas generales.
- "happy"      → el usuario recuerda con ternura o experimenta un momento de alivio o gratitud.
- "sad"        → el usuario expresa dolor profundo, llanto, pérdida, tristeza intensa o crisis.
- "surprised"  → el usuario comparte algo inesperado, una revelación o una contradicción emocional.

Ejemplo de respuesta válida:
{"respuesta":"Gracias por contarme eso. ¿Cómo te has sentido hoy?","emocion_avatar":"neutral"}`;

// ─────────────────────────────────────────────
// 4.1 CONSTRUCCIÓN DEL SYSTEM PROMPT
// ─────────────────────────────────────────────

/**
 * Ensambla el system prompt completo para cada petición a Gemini,
 * inyectando dinámicamente el contexto de memoria del usuario al final.
 *
 * Orden de bloques:
 *  1. ROL      – identidad, límites y prohibiciones de optimismo tóxico
 *  2. CULTURA  – regionalismos colombianos e instrucciones de tono local
 *  3. ÉTICO    – guardrails de crisis y protocolo de seguridad
 *  4. MEMORIA  – instrucciones de uso del contexto XML inyectado
 *  5. FORMATO  – contrato estricto de salida JSON (refuerzo final)
 *  6. XML      – datos reales del usuario (inyección dinámica)
 *
 * La memoria se posiciona DESPUÉS del bloque FORMATO para que sea lo último
 * que el modelo lee antes de generar la respuesta, maximizando su uso.
 *
 * @returns {string}
 */
function construirSystemPrompt() {
  const memoriaXml = obtenerContextoMemoria();

  // Los datos reales del usuario se inyectan al final del prompt.
  // Si no hay datos previos, se indica explícitamente que es la primera sesión.
  const bloqueContexto = memoriaXml
    ? `CONTEXTO ACTUAL DEL USUARIO (lee esto justo antes de responder):\n${memoriaXml}`
    : 'CONTEXTO ACTUAL DEL USUARIO:\n<user_memory>(Sin datos previos. Es la primera sesión del usuario.)</user_memory>';

  return [
    PROMPT_ROL,
    PROMPT_CULTURA,
    PROMPT_ETICO,
    PROMPT_MEMORIA,
    PROMPT_FORMATO,
    bloqueContexto,
  ].join('\n\n');
}

function _obtenerProveedorSeleccionado() {
  return (
    providerSelect?.value ||
    appState.proveedorActivo ||
    window.AURI_CONFIG?.proveedorActivo ||
    DEFAULT_PROVIDER
  );
}

if (providerSelect) {
  providerSelect.addEventListener('change', () => {
    appState.proveedorActivo = providerSelect.value;
    console.log(`[AURI] Proveedor de IA cambiado a: ${appState.proveedorActivo}`);
  });
}

function _construirMensajesGroq() {
  const mensajes = [
    { role: 'system', content: construirSystemPrompt() },
  ];

  const historial = historialConversacion.slice(-(MAX_TURNOS_HISTORIAL * 2));
  for (const turno of historial) {
    mensajes.push({
      role: turno.role === 'model' ? 'assistant' : 'user',
      content: turno.parts?.[0]?.text ?? '',
    });
  }

  return mensajes;
}

function _construirCuerpoSolicitud(proveedorId) {
  if (proveedorId === 'groq') {
    return {
      model: GROQ_MODEL,
      messages: _construirMensajesGroq(),
      temperature: 0.72,
      max_tokens: 300,
    };
  }

  return {
    systemInstruction: {
      parts: [{ text: construirSystemPrompt() }],
    },
    contents: historialConversacion.slice(-(MAX_TURNOS_HISTORIAL * 2)),
    generationConfig: {
      temperature:      0.72,
      topP:             0.90,
      maxOutputTokens:  300,
      responseMimeType: 'application/json',
    },
  };
}

function _extraerTextoRespuestaProveedor(proveedorId, payload) {
  if (proveedorId === 'groq') {
    return payload?.choices?.[0]?.message?.content ?? '';
  }

  return payload?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
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

  const proveedorId = _obtenerProveedorSeleccionado();
  const proveedor = _resolverProveedor(proveedorId);
  if (!proveedor) {
    _manejarErrorAPI(new Error(`API Key no configurada para ${proveedorId}.`), 'config');
    return false;
  }

  _peticionEnCurso = true;

  // ── Burbuja del usuario ─────────────────────────────────────────────────
  // Se añade de inmediato al historial de chat, antes del bloqueo de UI,
  // para que el usuario vea su propio mensaje sin retraso.
  // Funciona independientemente de la vista activa: el DOM del chat
  // existe aunque #vista-app esté oculta (solo display:none, no removida).
  _añadirBurbujaChat('usuario', textoLimpio);

  _setUIEsperando(true);

  // Registra el turno del usuario en el historial de la API
  const turnoUsuario = { role: 'user', parts: [{ text: textoLimpio }] };
  historialConversacion.push(turnoUsuario);

  console.log(`[AURI] Enviando a ${proveedor.nombre} (turno ${Math.ceil(historialConversacion.length / 2)}): "${textoLimpio}"`);

  // AbortController para timeout explícito de 30 s
  const controlador = new AbortController();
  const idTimeout    = setTimeout(() => controlador.abort(), TIMEOUT_API_MS);

  const cuerpo = _construirCuerpoSolicitud(proveedorId);

  try {
    const response = await fetch(proveedor.endpoint, {
      method:  'POST',
      headers: proveedorId === 'groq'
        ? {
            'Authorization': `Bearer ${proveedor.apiKey}`,
            'Content-Type': 'application/json',
          }
        : { 'Content-Type': 'application/json' },
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
    const textoRespuesta = _extraerTextoRespuestaProveedor(proveedorId, payload);

    if (!textoRespuesta) {
      throw Object.assign(
        new Error(`${proveedor.nombre} devolvió una respuesta vacía.`),
        { tipo: 'formato' }
      );
    }

    // Parsea y valida el JSON estructurado { respuesta, emocion_avatar }
    let data;
    try {
      data = _parsearJsonGemini(textoRespuesta);
    } catch {
      throw Object.assign(
        new Error(`JSON inválido en respuesta de ${proveedor.nombre}: ${textoRespuesta.slice(0, 120)}`),
        { tipo: 'formato' }
      );
    }

    _validarRespuestaGemini(data);

    // Valida emocion_avatar (valores en inglés) y obtiene la clase CSS del avatar
    const claseEstado = _traducirEmocion(data.emocion_avatar);

    // Ejecuta ambas acciones de respuesta (visual + audio) en paralelo
    cambiarEstadoEmocional(claseEstado);
    reproducirAudioAgente(data.respuesta);

    // Añade la respuesta del modelo al historial para el siguiente turno
    historialConversacion.push({
      role:  'model',
      parts: [{ text: JSON.stringify(data) }],
    });

    // Extracción de datos de memoria: ligero, síncrono, no bloqueante.
    // Analiza el turno del usuario para actualizar perfil, vector temático y nombre.
    extraerDatosConversacion(textoLimpio);

    console.log(`[AURI] Respuesta recibida desde ${proveedor.nombre}. Emoción: ${data.emocion_avatar} → CSS: ${claseEstado}`);
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
 * Intenta parsear JSON incluso cuando Gemini agrega texto extra
 * antes o después del objeto (ej: "Here is the JSON requested:").
 *
 * @param {string} texto
 * @returns {Object}
 */
function _parsearJsonGemini(texto) {
  // Caso ideal: ya viene JSON puro
  try {
    return JSON.parse(texto);
  } catch {
    // Continúa con extracción tolerante
  }

  // Limpia posibles fences markdown
  const sinFences = String(texto)
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  // Extrae desde la primera llave hasta la última
  const inicio = sinFences.indexOf('{');
  const fin = sinFences.lastIndexOf('}');
  if (inicio === -1 || fin === -1 || fin <= inicio) {
    throw new Error('No se encontró un objeto JSON válido en la respuesta.');
  }

  const bloqueJson = sinFences.slice(inicio, fin + 1);
  return JSON.parse(bloqueJson);
}

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
  // ── Controles del wearable ─────────────────────────────────────────
  pttBtn.disabled = esperando;

  // ── Controles de la app compañera ──────────────────────────────────
  // Se bloquean aunque #vista-app no sea la vista activa,
  // para evitar envíos duplicados si el usuario cambia de vista rápido.
  if (chatInput)     chatInput.disabled     = esperando;
  if (btnEnviarChat) btnEnviarChat.disabled = esperando;

  if (esperando) {
    // Avatar a neutral mientras procesa (sin animación brusca)
    cambiarEstadoEmocional('neutral');

    // Etiqueta del PTT corta: el botón es circular y pequeño
    pttBtn.setAttribute('aria-label', 'AURI está pensando…');
    pttBtn.querySelector('.ptt-btn__etiqueta').textContent = '···';

    // Placeholder del campo de texto (accesibilidad + feedback visual)
    if (chatInput) chatInput.placeholder = 'AURI está pensando…';

  } else {
    pttBtn.setAttribute('aria-label', 'Mantener presionado para hablar');
    // 'Hablar' es consistente con el HTML inicial y cabe en el botón circular.
    // 'Mantén presionado para hablar' desbordaría el layout del botón físico.
    pttBtn.querySelector('.ptt-btn__etiqueta').textContent = 'Hablar';

    if (chatInput) chatInput.placeholder = 'Escríbele a AURI…';
  }
}




// ─────────────────────────────────────────────
// 6. BOTÓN PTT (Push-to-Talk)
// ─────────────────────────────────────────────

/**
 * Activa el modo de grabación PTT (pointerdown).
 * Actualiza la UI de inmediato e inicia el reconocimiento.
 * Guard: si ya está grabando, ignora la llamada (doble press rápido).
 */
function activarGrabacion() {
  if (appState.isRecording) return;
  pttBtn.setAttribute('aria-label', 'Escuchando... pulsa para detener');
  iniciarReconocimientoVoz();
}

/**
 * Desactiva el modo de grabación PTT (pointerup / pointerleave).
 *
 * Flujo con SpeechRecognition:
 *   1. Establece _enviarAlDetener = true para que el handler 'end' envíe
 *      la transcripción acumulada a procesarEntradaUsuario().
 *   2. Llama a detenerReconocimientoVoz() → recognition.stop()
 *   3. La API procesa el audio y dispara 'result' + 'end'
 *   ⟹ La UI se resetea en 'end', NO aquí, para evitar parpadeos.
 *
 * Nota crítica: _enviarAlDetener DEBE ser true antes de stop().
 * Si fuera false, el handler 'end' descartaría la transcripción.
 */
function desactivarGrabacion() {
  if (!appState.isRecording) return;
  _limpiarTimerSilencio();
  _enviarAlDetener = true;   // garantiza que 'end' envíe el texto acumulado
  detenerReconocimientoVoz();
  console.log('[Voz] Captura de voz detenida manualmente.');
}

// PTT: presionar activa el micrófono, soltar (o salir) lo detiene.
// setPointerCapture redirige todos los eventos del puntero al botón aunque
// el dedo o cursor se desplace fuera de él durante la pulsación.
pttBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault(); // evita el click sintético en dispositivos táctiles
  pttBtn.setPointerCapture(e.pointerId);
  // iOS bloquea speechSynthesis.speak() fuera de gestos de usuario.
  // Este llamado (dentro del pointerdown) desbloquea el AudioContext de WebKit
  // la primera vez, permitiendo síntesis posterior de forma asíncrona.
  _desbloquearAudioIOS();
  activarGrabacion();
});

pttBtn.addEventListener('pointerup', () => {
  desactivarGrabacion();
});

// pointerleave se dispara si el puntero sale del botón mientras está capturado.
// Solo detiene si el botón seguía físicamente presionado (e.buttons > 0).
pttBtn.addEventListener('pointerleave', (e) => {
  if (e.buttons > 0) desactivarGrabacion();
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
  // Si AURI estaba hablando y se activa el mute, cancela el audio de inmediato
  if (appState.isMuted && window.speechSynthesis?.speaking) {
    window.speechSynthesis.cancel();
  }
  console.log(`Audio ${appState.isMuted ? 'silenciado' : 'activado'}`);
});

volumeSlider.addEventListener('input', () => {
  const value = Number(volumeSlider.value);
  appState.volume = value;
  volumeSlider.setAttribute('aria-valuenow', value);

  // Refleja el porcentaje de relleno en el track del slider.
  // Usa el token CSS correcto en español: --color-acento (no --color-accent).
  volumeSlider.style.background =
    `linear-gradient(to right, var(--color-acento) ${value}%, rgba(255,255,255,0.15) ${value}%)`;

  if (value === 0 && !appState.isMuted) {
    appState.isMuted = true;
    actualizarIconoMute();
  } else if (value > 0 && appState.isMuted) {
    appState.isMuted = false;
    actualizarIconoMute();
  }

  // appState.volume se lee en tiempo de ejecución por _sintetizarVoz()
  // en cada nueva utterance: no se requiere propagación adicional.
  console.log(`Volumen: ${value}%`);
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
    memoria.creadoEn            = ahora;
    memoria.actualizadoEn       = ahora;
    // La primera apertura ya es la sesión #1, no la sesión #0.
    memoria.sesion.totalSesiones = 1;
    memoria.sesion.ultimaSesion  = ahora;
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
const vistaApp          = document.getElementById('vista-app');
const btnAbrirApp       = document.getElementById('btn-abrir-app');
const btnVolverWear     = document.getElementById('btn-volver-wearable');
const btnToggleAjustes  = document.getElementById('btn-toggle-ajustes');
const estadoAuri     = document.getElementById('estado-auri');
const companionNombre = document.getElementById('companion-nombre-usuario');

/**
 * Alterna entre la vista del colgante (#vista-wearable)
 * y la app compañera (#vista-app).
 *
 * Responsabilidades:
 *  1. VISIBILIDAD  – usa el atributo [hidden] nativo de HTML5,
 *     más semántico que clases CSS y compatible con lectores de pantalla.
 *  2. ESTADO       – actualiza appState.vistaActiva para que cualquier
 *     módulo pueda saber qué vista está activa sin consultar el DOM.
 *  3. BOTÓN        – sincroniza ícono, etiqueta y aria-label del botón
 *     flotante para reflejar la acción disponible en cada momento.
 *  4. DATOS        – al abrir la app, refresca recuerdos y nombre de perfil.
 *  5. FOCO         – mueve el foco al primer elemento interactivo de la
 *     vista nueva (WCAG 2.4.3 – Focus Order) via requestAnimationFrame,
 *     garantizando que el elemento ya no esté hidden cuando recibe el foco.
 *  6. FONDO        – las respuestas de AURI (avatar + audio + burbuja de chat)
 *     se procesan siempre en segundo plano: cambiarEstadoEmocional() y
 *     _añadirBurbujaChat() operan sobre el DOM aunque la vista esté oculta.
 *
 * Guard: si ya estamos en vistaDestino no hace nada (evita trabajo redundante).
 *
 * @param {'wearable'|'app'} vistaDestino
 */
function alternarVista(vistaDestino) {
  // Guard: no reanimar si ya estamos en esa vista
  if (vistaDestino === appState.vistaActiva) return;

  const esApp = vistaDestino === 'app';

  // ── 1. Visibilidad: [hidden] nativo de HTML5 ───────────────────────────
  // [hidden] equivale a display:none vía la hoja de estilos del agente.
  // A diferencia de una clase CSS, es semántico: aria-hidden no es necesario.
  vistaWearable.hidden = esApp;
  vistaApp.hidden      = !esApp;

  // ── 2. Estado interno ──────────────────────────────────────────────────
  appState.vistaActiva = vistaDestino;

  // ── 3. Cierra el sidebar móvil al salir de la vista app ───────────────
  if (!esApp && vistaApp.classList.contains('companion-app--mostrando-ajustes')) {
    vistaApp.classList.remove('companion-app--mostrando-ajustes');
    if (btnToggleAjustes) {
      btnToggleAjustes.textContent = '⚙️';
      btnToggleAjustes.setAttribute('aria-label', 'Mostrar configuraciones');
      btnToggleAjustes.setAttribute('aria-pressed', 'false');
    }
  }

  // ── 4. Botón flotante de navegación ────────────────────────────────────
  btnAbrirApp.dataset.vista = vistaDestino;
  btnAbrirApp.classList.toggle('btn-abrir-app--en-app', esApp);
  btnAbrirApp.setAttribute(
    'aria-label',
    esApp ? 'Ver el colgante AURI' : 'Abrir App Compañera de AURI'
  );
  btnAbrirApp.querySelector('.btn-abrir-app__icono').textContent   = esApp ? '⌚' : '📱';
  btnAbrirApp.querySelector('.btn-abrir-app__etiqueta').textContent = esApp ? 'Colgante' : 'App';

  // ── 5. Sincronización de datos al abrir la app ─────────────────────────
  if (esApp) {
    _sincronizarVistaApp();
  }

  // ── 6. Gestión de foco (WCAG 2.4.3 – Focus Order) ─────────────────────
  // requestAnimationFrame aplaza el foco un frame, asegurando que el
  // elemento ya esté visible (no hidden) antes de recibir el foco.
  // Los lectores de pantalla anuncian el nuevo contexto correctamente.
  requestAnimationFrame(() => {
    if (esApp) {
      // Foco al campo de texto: el usuario puede escribir de inmediato
      const destino = chatInput ?? vistaApp.querySelector(
        'button:not([disabled]), input:not([disabled])'
      );
      destino?.focus();
    } else {
      // Al volver al colgante, el PTT es el control principal
      pttBtn?.focus();
    }
  });

  console.log(`[AURI] Vista activa: ${vistaDestino}`);
}

/**
 * Alias de compatibilidad hacia atrás.
 * En código nuevo usa siempre alternarVista().
 * @param {'wearable'|'app'} vistaDestino
 */
const navegarVista = alternarVista;

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

// ── Botón flotante: alterna entre wearable y app ──────────────────────────
btnAbrirApp.addEventListener('click', () => {
  alternarVista(appState.vistaActiva === 'wearable' ? 'app' : 'wearable');
});

// ── Botón "← Volver al Colgante" dentro de la app compañera ───────────────
if (btnVolverWear) {
  btnVolverWear.addEventListener('click', () => alternarVista('wearable'));
}

// ── Botón ⚙️ / ❌: alterna el sidebar de ajustes en móvil ─────────────────
if (btnToggleAjustes) {
  btnToggleAjustes.addEventListener('click', () => {
    const vistaAppRaiz = document.getElementById('vista-app');
    const abierto = vistaAppRaiz.classList.toggle('companion-app--mostrando-ajustes');
    console.log('[AURI] Sidebar toggled:', abierto, '| Clases en #vista-app:', vistaAppRaiz.className);
    btnToggleAjustes.textContent = abierto ? '❌' : '⚙️';
    btnToggleAjustes.setAttribute('aria-label', abierto ? 'Cerrar configuraciones' : 'Mostrar configuraciones');
    btnToggleAjustes.setAttribute('aria-pressed', String(abierto));
  });
}

// ── Tecla Escape: cierra la app y vuelve al colgante ──────────────────────
// Patrón modal/panel de accesibilidad (WCAG 2.1.2 – No Keyboard Trap).
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && appState.vistaActiva === 'app') {
    alternarVista('wearable');
  }
});

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

// ── Formulario de chat por texto desde la App Compañera ───────────────────
// chatInput y formChat se declaran en la sección de referencias al DOM (arriba).
// La burbuja del usuario se añade dentro de procesarEntradaUsuario para que
// el flujo sea idéntico tanto si el mensaje proviene de texto como de voz.
if (formChat) {
  formChat.addEventListener('submit', (e) => {
    e.preventDefault();
    const texto = chatInput?.value.trim();
    if (!texto) return;
    // Limpia el campo antes de la petición async para evitar doble envío
    chatInput.value = '';
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

// _añadirBurbujaChat es una declaración de función con hoisting completo:
// está disponible en todo el scope del módulo sin necesidad de asignarla
// a appState. reproducirAudioAgente la llama directamente.


// ─────────────────────────────────────────────
// 10. INICIALIZACIÓN
// ─────────────────────────────────────────────

(function init() {
  // Estado emocional inicial del avatar
  cambiarEstadoEmocional('neutral');

  // Sincroniza los selectores con el estado inicial de la app.
  // Los elementos viven en #vista-app (hidden), pero son accesibles desde el DOM.
  if (providerSelect) {
    providerSelect.value     = appState.proveedorActivo;
    appState.proveedorActivo = providerSelect.value;
  }
  if (speechLangSelect) {
    speechLangSelect.value = appState.idioma;
  }

  // Establece la vista inicial: el colgante.
  // Como appState.vistaActiva es null, el guard de alternarVista no se activa
  // y la función ejecuta la inicialización completa (hidden + foco + estado).
  alternarVista('wearable');

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
