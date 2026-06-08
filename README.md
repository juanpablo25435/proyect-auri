# AURI — Ecosistema de Acompañamiento Emocional (Wearable Virtual & Companion App)

<p align="center">
  <strong>Zero-UI emocional · Wearable virtual · Companion App · LLM orchestration · Vanilla JavaScript</strong>
</p>

<p align="center">
  <img alt="Stack" src="https://img.shields.io/badge/Stack-Vanilla%20JS%20%7C%20HTML5%20%7C%20CSS3-1a1f2e">
  <img alt="Arquitectura" src="https://img.shields.io/badge/Architecture-SPA%20Monolito%20Modular-4a90a4">
  <img alt="Voice" src="https://img.shields.io/badge/API-Web%20Speech%20API-f9c84a">
  <img alt="LLM" src="https://img.shields.io/badge/LLM-Gemini%20%7C%20Groq-9b59b6">
</p>

---

## 1. Título e Identidad del Proyecto

**AURI** es una SPA experimental de acompañamiento emocional que simula un ecosistema compuesto por un **colgante inteligente virtual** y una **App Compañera móvil**. El proyecto explora la intersección entre interfaces de cero fricción (**Zero-UI**), hardware minimalista simulado y Modelos de Lenguaje de Gran Escala (**LLMs**) para construir una experiencia conversacional íntima, accesible y sensible al contexto.

En lugar de presentar una interfaz saturada de controles, AURI propone una interacción centrada en la voz, el gesto táctil y la respuesta emocional visual. El usuario se comunica con un agente empático mediante un patrón **Push-To-Talk**, mientras el sistema interpreta la conversación, actualiza una memoria local de largo plazo y modula un **Avatar Solar Interactivo** según el estado emocional devuelto por el modelo.

El proyecto está diseñado como un prototipo técnico de alta fidelidad: no depende de frameworks, no requiere pipeline de build y mantiene toda la lógica en JavaScript nativo, priorizando portabilidad, auditabilidad y control explícito del runtime del navegador.

---

## 2. Arquitectura del Sistema e Ingeniería del Software

AURI está implementado como un **monolito modular funcionalmente limpio** dentro de `app.js`. Aunque el código reside en un único archivo JavaScript, el grafo técnico del proyecto evidencia comunidades funcionales separadas: proveedor LLM, construcción de prompts, voz, memoria persistente, vista del wearable y vista de la App Compañera.

### Núcleo Conversacional y Orquestación

El flujo crítico del sistema está concentrado en `procesarEntradaUsuario`, que actúa como mediador central entre la entrada del usuario, el historial conversacional, la memoria persistida, la capa multi-proveedor de LLMs, la UI y la síntesis de voz.

Su responsabilidad operacional incluye:

- Validar la entrada y prevenir reentradas mediante un bloqueo de petición en curso.
- Resolver dinámicamente el proveedor activo de IA.
- Registrar el turno del usuario en el historial local de conversación.
- Ejecutar extracción ligera de memoria en el mismo flujo de interacción.
- Construir el cuerpo de solicitud compatible con el proveedor seleccionado.
- Invocar la API remota mediante `fetch` y `AbortController` con timeout explícito.
- Parsear y validar la respuesta estructurada del modelo.
- Actualizar el estado emocional del avatar.
- Reproducir la respuesta del agente mediante síntesis de voz.
- Restaurar la UI y manejar errores de red, formato, timeout o configuración.

Este diseño convierte a `procesarEntradaUsuario` en el **orquestador de negocio** de AURI: recibe texto proveniente de voz o chat, coordina servicios internos y entrega una respuesta multimodal.

### Sub-sistema de Audio y Voz

AURI implementa una integración avanzada con la **Web Speech API**, usando tanto `SpeechRecognition` como `SpeechSynthesis`.

El reconocimiento de voz se configura como un sistema estricto **Push-To-Talk (PTT)**:

- El usuario mantiene presionado el botón físico virtual del colgante para hablar.
- El sistema inicia una única sesión de reconocimiento por interacción.
- `interimResults = false` desactiva resultados interinos.
- `continuous = false` evita sesiones abiertas indefinidamente.
- El cierre por silencio se controla con un temporizador interno.

La decisión de desactivar resultados interinos es intencional: en algunos entornos móviles, especialmente Android y navegadores con implementaciones parciales de reconocimiento, los resultados interinos pueden acumular texto duplicado y producir un efecto de cascada o eco conversacional. Al operar únicamente con frases finales, AURI reduce ruido, evita transcripciones repetidas y optimiza el rendimiento en dispositivos móviles.

La síntesis de voz usa `SpeechSynthesisUtterance`, respeta el estado de mute, cancela utterances previos para evitar colas acumuladas y selecciona voces disponibles según el idioma configurado.

### Sub-sistema de Memoria a Largo Plazo

La memoria de AURI es local, síncrona y privada por diseño. Se basa en `localStorage` bajo una clave de persistencia propia, sin servicios externos ni base de datos remota.

El motor de memoria permite:

- Inicializar un perfil persistente en primera visita.
- Migrar esquemas antiguos sin eliminar datos existentes.
- Guardar nombre, pronombres, tipo de pérdida, recuerdos y metadatos de sesión.
- Mantener un vector temático emocional ponderado.
- Borrar memoria completa o campos específicos por privacidad.
- Serializar contexto relevante como XML estructurado para inyectarlo en el prompt.

La extracción automática de entidades se ejecuta en segundo plano lógico mediante reglas ligeras basadas en expresiones regulares. AURI puede detectar nombre, vínculos familiares o afectivos, tipo de pérdida y temas emocionales como culpa, añoranza, rabia, soledad, tristeza, miedo, amor o gratitud sin interrumpir el hilo conversacional.

Este enfoque evita latencia adicional, no bloquea la UI y mantiene el control de datos en el navegador del usuario.

### Capa de Abstracción de LLMs (Multi-Proveedor)

AURI incorpora una capa dinámica de proveedor LLM que permite conmutar en caliente entre:

- **Google Gemini**, vía Google AI Studio y endpoint `generateContent`.
- **Groq**, vía Groq Cloud y su API compatible con chat completions, optimizada para inferencia de ultra-baja latencia sobre LPUs.

La función de resolución de proveedor lee `window.AURI_CONFIG` en tiempo de ejecución, lo que permite modificar el proveedor activo sin recompilar ni cambiar el código fuente principal. El sistema normaliza la construcción del cuerpo de solicitud y la extracción de texto de respuesta para cada proveedor, preservando un contrato interno común: el modelo debe devolver un JSON con la respuesta textual y el estado emocional del avatar.

---

## 3. Decisiones de Diseño de Interfaz (UX/UI Minimalista)

AURI separa conceptualmente la experiencia en dos superficies: una vista de wearable minimalista y una App Compañera con controles avanzados.

### Vista del Wearable

La vista del wearable simula un colgante físico inteligente. Su diseño sigue una filosofía **Zero-UI**: mínima carga cognitiva, ausencia de texto innecesario y una interacción principal basada en un único control táctil.

El usuario no navega por menús complejos. La experiencia se centra en:

- Un botón **PTT** integrado visualmente al hardware simulado.
- Un estado accesible anunciado mediante texto para lectores de pantalla.
- Un **Avatar Solar Interactivo** que funciona como salida emocional primaria.

El avatar cambia dinámicamente sus clases visuales según el estado emocional parseado desde la respuesta del LLM. Las animaciones, velocidades, brillos y paletas cromáticas se controlan con variables CSS y estados como `neutral`, `happy`, `sad` y `surprised`, generando una respuesta afectiva visible sin saturar la interfaz.

### Vista de la App Compañera

La App Compañera representa el panel avanzado del ecosistema. Permite revisar el historial conversacional, gestionar recuerdos, ajustar voz, controlar proveedor LLM y operar funciones de privacidad.

En resoluciones de escritorio, la vista se comporta como un **Grid simétrico**, separando el historial de chat del panel lateral de recuerdos y ajustes. En dispositivos móviles, especialmente por debajo de `640px`, el diseño se transforma en un **Overlay Absoluto Defensivo**: el panel de ajustes se superpone al contenido con control explícito de capas mediante `z-index`, prevención de desplazamientos no deseados y bloqueos táctiles como `touch-action: none`.

Este comportamiento está optimizado para navegadores móviles, Safari/WebKit e iOS, donde la combinación de viewport dinámico, scroll elástico y eventos táctiles puede producir inconsistencias si la UI no defiende explícitamente sus límites interactivos.

---

## 4. Características Principales e Innovación Técnica

- **Interacción por Voz Híbrida:** combina reconocimiento de voz, síntesis hablada y fallback textual. En Safari/WebKit, AURI desbloquea proactivamente el contexto de audio mediante un gesto táctil inicial `pointerdown`, ejecutando una síntesis silenciosa que habilita respuestas habladas posteriores iniciadas de forma asíncrona.

- **Push-To-Talk estricto:** evita escucha continua y reduce falsos positivos. El usuario conserva control explícito del micrófono, mientras el sistema usa sesiones breves de reconocimiento con resultados finales solamente.

- **Extracción e inyección dinámica de contexto:** cada turno del usuario puede enriquecer una memoria local que luego se serializa como XML y se inyecta en el prompt para personalizar futuras respuestas sin depender de almacenamiento remoto.

- **Robustez en el parseo de datos:** la respuesta del LLM se limpia antes de `JSON.parse()`, eliminando fences markdown redundantes como ` ```json ` y extrayendo el objeto entre la primera y la última llave para tolerar texto adicional generado por el modelo.

- **Arquitectura multi-proveedor:** Gemini y Groq se seleccionan dinámicamente desde configuración local o controles de UI, permitiendo comparar calidad, latencia y comportamiento sin modificar la base de código.

- **Privacidad local-first:** la memoria vive exclusivamente en el navegador del usuario mediante `localStorage`. El sistema expone operaciones de borrado total y borrado granular para reducir fricción en escenarios sensibles.

- **Diseño accesible:** usa HTML semántico, roles ARIA, `aria-live`, gestión de foco y estados de control para mantener la experiencia usable con tecnologías asistivas.

- **Cero dependencias externas:** el proyecto se ejecuta como una SPA estática en navegador, sin bundlers, frameworks, paquetes npm ni transpilación.

---

## 5. Tecnologías y APIs utilizadas

| Tecnología / API | Uso en AURI | Rol técnico |
| --- | --- | --- |
| JavaScript ES6+ Vanilla | `app.js` | Orquestación de estado, eventos, voz, memoria, llamadas API y navegación SPA sin dependencias externas. |
| HTML5 Semántico | `index.html` | Estructura accesible de modal, wearable, App Compañera, formularios, historial y controles. |
| CSS3 | `style.css` | Variables nativas, CSS Grid, Flexbox, animaciones, responsive design, estados emocionales y metodología BEM. |
| Web Speech API | `SpeechRecognition` / `SpeechSynthesis` | Entrada por voz, transcripción PTT, selección de idioma, síntesis hablada y control de reproducción. |
| Web Storage API | `localStorage` | Persistencia local de memoria, recuerdos, perfil emocional y metadatos de sesión. |
| Fetch API | `fetch` + `AbortController` | Comunicación HTTP con proveedores LLM y control de timeout. |
| Google Gemini API | Google AI Studio | Generación de respuestas estructuradas y estado emocional del avatar. |
| Groq Cloud API | LPUs / Chat Completions | Alternativa de inferencia LLM de ultra-baja latencia. |

---

## 6. Guía de Instalación y Configuración Local

### 1. Clonar el repositorio

```bash
git clone <URL_DEL_REPOSITORIO>
cd proyect-auri
```

### 2. Crear el archivo local de configuración

En la raíz del proyecto, crea un archivo llamado `env.js`.

Este archivo está incluido en `.gitignore` para proteger credenciales locales y no debe subirse al repositorio.

### 3. Definir el objeto global de configuración

El formato exacto recomendado es:

```javascript
window.AURI_CONFIG = {
  proveedorActivo: 'gemini',
  geminiApiKey: 'TU_API_KEY_AQUI',
  groqApiKey: 'TU_API_KEY_AQUI'
};
```

Valores soportados para `proveedorActivo`:

- `gemini`
- `groq`

También puedes configurar el idioma de voz por defecto:

```javascript
window.AURI_CONFIG = {
  proveedorActivo: 'gemini',
  geminiApiKey: 'TU_API_KEY_AQUI',
  groqApiKey: 'TU_API_KEY_AQUI',
  defaultLang: 'es-CO'
};
```

### 4. Verificar la carga de scripts

`index.html` debe cargar `env.js` antes de `app.js`:

```html
<script src="env.js"></script>
<script src="app.js"></script>
```

### 5. Ejecutar la SPA localmente

Como el proyecto no requiere dependencias externas ni build step, puede servirse como sitio estático. Una opción simple es usar un servidor local:

```bash
python -m http.server 5500
```

Luego abre:

```text
http://localhost:5500
```

También puedes usar una extensión tipo Live Server o cualquier servidor estático equivalente.

### 6. Permisos del navegador

Para probar la experiencia completa:

- Permite acceso al micrófono cuando el navegador lo solicite.
- Usa Chrome, Edge o Safari para mejor compatibilidad con Web Speech API.
- En iOS/Safari, inicia la interacción desde el botón PTT para habilitar correctamente la síntesis de voz.

---

## Estado Técnico Actual

Según el análisis del grafo de código:

- El proyecto contiene `1` archivo JavaScript principal analizado.
- El grafo detecta `54` funciones y `380` aristas de llamadas.
- Existen `7` comunidades funcionales principales.
- El flujo de mayor criticidad es `activarGrabacion`, seguido por operaciones de memoria y navegación.
- Las principales oportunidades de refactor están en `procesarEntradaUsuario`, `_inicializarReconocimiento`, `alternarVista`, `cambiarEstadoEmocional` y `obtenerContextoMemoria`.

AURI se encuentra en una etapa sólida de prototipo avanzado: funcionalmente cohesivo, técnicamente auditable y preparado para evolucionar desde un monolito modular hacia una separación futura por módulos (`voz`, `memoria`, `proveedores`, `ui` y `prompt-builder`) sin cambiar el contrato de experiencia del usuario.

---

## Nota de Seguridad

AURI es un agente interactivo de acompañamiento emocional **no clínico**. No reemplaza atención psicológica, psiquiátrica ni médica. Las claves de API nunca deben escribirse directamente en `app.js` ni en archivos versionados. Para producción, se recomienda mover las llamadas a proveedores LLM detrás de un backend proxy que proteja credenciales, aplique rate limiting y registre errores de forma segura.
