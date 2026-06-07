document.addEventListener('DOMContentLoaded', () => {
    const providerSelect = document.getElementById('provider');
    const apiKeyInput = document.getElementById('apiKey');
    const systemMsgInput = document.getElementById('systemMsg');
    const userMsgInput = document.getElementById('userMsg');
    const sendBtn = document.getElementById('sendBtn');
    const responseArea = document.getElementById('responseArea');
    const tempInput = document.getElementById('temperature');
    const tokensInput = document.getElementById('tokens');
    const speechLangSelect = document.getElementById('speechLang');
    const startBtn = document.getElementById('startBtn');
    const stopBtn = document.getElementById('stopBtn');
    const listeningIndicator = document.getElementById('listeningIndicator');
    const voiceToggle = document.getElementById('voiceToggle');

    sendBtn.addEventListener('click', async () => {
        const provider = providerSelect.value;
        const apiKey = apiKeyInput.value.trim();
        const systemMsg = systemMsgInput.value.trim();
        const userMsg = userMsgInput.value.trim();
        const temp = parseFloat(tempInput.value) || 0.7;
        const maxTokens = parseInt(tokensInput.value, 10) || 500;

        if (!apiKey) {
            alert('Por favor, ingresa una API Key.');
            return;
        }

        if (!userMsg) {
            alert('Por favor, ingresa un mensaje de usuario.');
            return;
        }

        responseArea.value = 'Enviando petición...';
        sendBtn.disabled = true;

        try {
            if (provider === 'groq') {
                await sendToGroq(apiKey, systemMsg, userMsg, temp, maxTokens);
            } else if (provider === 'gemini') {
                await sendToGemini(apiKey, systemMsg, userMsg, temp, maxTokens);
            }
        } catch (error) {
            console.error(error);
            responseArea.value = 'Error en la petición:\n' + error.message;
        } finally {
            sendBtn.disabled = false;
        }
    });

    // --- Web Speech API: recognizer & synthesizer setup ---
    let recognition = null;
    let listeningBecauseUserRequested = false;
    let silenceTimer = null;
    let accumulatedTranscript = '';
    let shouldAutoSend = false;
    const SILENCE_DELAY_MS = 1800;

    function clearSilenceTimer() {
        if (silenceTimer) {
            clearTimeout(silenceTimer);
            silenceTimer = null;
        }
    }

    function scheduleSilenceStop() {
        clearSilenceTimer();
        silenceTimer = setTimeout(() => {
            shouldAutoSend = true;
            try {
                recognition.stop();
            } catch (e) {
                // ignore stop errors
            }
        }, SILENCE_DELAY_MS);
    }

    function getSpeechLanguage() {
        return speechLangSelect ? speechLangSelect.value : 'es-CO';
    }

    function applySpeechLanguage() {
        const language = getSpeechLanguage();

        if (recognition) {
            recognition.lang = language;
        }

        return language;
    }

    async function sendConversationMessage(messageText) {
        const provider = providerSelect.value;
        const apiKey = apiKeyInput.value.trim();
        const systemMsg = systemMsgInput.value.trim();
        const temp = parseFloat(tempInput.value) || 0.7;
        const maxTokens = parseInt(tokensInput.value, 10) || 500;

        if (!apiKey) {
            alert('Por favor, ingresa una API Key.');
            return;
        }

        if (!messageText.trim()) {
            return;
        }

        responseArea.value = 'Enviando petición...';
        sendBtn.disabled = true;

        try {
            if (provider === 'groq') {
                await sendToGroq(apiKey, systemMsg, messageText, temp, maxTokens);
            } else if (provider === 'gemini') {
                await sendToGemini(apiKey, systemMsg, messageText, temp, maxTokens);
            }
        } catch (error) {
            console.error(error);
            responseArea.value = 'Error en la petición:\n' + error.message;
        } finally {
            sendBtn.disabled = false;
        }
    }

    if ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window) {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        recognition = new SpeechRecognition();
        recognition.lang = getSpeechLanguage();
        recognition.interimResults = true;
        recognition.continuous = true;

        if (speechLangSelect) {
            speechLangSelect.addEventListener('change', () => {
                applySpeechLanguage();
            });
        }

        recognition.addEventListener('start', () => {
            accumulatedTranscript = '';
            shouldAutoSend = false;
            listeningIndicator.style.display = 'inline';
            if (startBtn) startBtn.disabled = true;
            if (stopBtn) stopBtn.disabled = false;
        });

        recognition.addEventListener('end', () => {
            listeningIndicator.style.display = 'none';
            if (startBtn) startBtn.disabled = false;
            if (stopBtn) stopBtn.disabled = true;

            const transcript = accumulatedTranscript.trim();
            if (shouldAutoSend && transcript) {
                shouldAutoSend = false;
                accumulatedTranscript = '';
                userMsgInput.value = transcript;
                sendConversationMessage(transcript);
                return;
            }

            shouldAutoSend = false;
        });

        recognition.addEventListener('result', (event) => {
            let liveTranscript = '';

            for (let index = event.resultIndex; index < event.results.length; index += 1) {
                const result = event.results[index];
                const text = result[0].transcript;

                if (result.isFinal) {
                    accumulatedTranscript += text;
                } else {
                    liveTranscript += text;
                }
            }

            const combinedTranscript = `${accumulatedTranscript}${liveTranscript}`.trim();
            userMsgInput.value = combinedTranscript;
            scheduleSilenceStop();
        });

        recognition.addEventListener('error', (event) => {
            clearSilenceTimer();
            shouldAutoSend = false;
            listeningIndicator.style.display = 'none';
            micBtn.textContent = 'Iniciar escucha';
            console.error('Speech recognition error:', event.error);
        });
    } else {
        micBtn.disabled = true;
        micBtn.title = 'SpeechRecognition no está soportado en este navegador.';
    }

    if (startBtn) {
        startBtn.addEventListener('click', () => {
            if (!recognition) return;
            listeningBecauseUserRequested = true;
            clearSilenceTimer();
            accumulatedTranscript = '';
            try { recognition.start(); } catch (e) { /* ignore */ }
        });
    }

    if (stopBtn) {
        stopBtn.addEventListener('click', () => {
            if (!recognition) return;
            listeningBecauseUserRequested = false;
            clearSilenceTimer();
            shouldAutoSend = false;
            try { recognition.stop(); } catch (e) { /* ignore */ }
        });
    }

    // Speak text using SpeechSynthesis
    function speakText(text) {
        if (!voiceToggle.checked) return;
        if (!('speechSynthesis' in window)) return;

        // stop recognition while speaking
        const wasListening = listeningIndicator.style.display === 'inline' || listeningBecauseUserRequested;
        try { if (recognition) recognition.stop(); } catch (e) { }

        const utterance = new SpeechSynthesisUtterance(text);
        const language = getSpeechLanguage();
        utterance.lang = language;
        // pick a voice that matches the selected locale or at least the selected language family
        const voices = window.speechSynthesis.getVoices() || [];
        const primaryLanguage = language.split('-')[0];
        for (const v of voices) {
            if (v.lang === language || (v.lang && v.lang.startsWith(primaryLanguage))) { utterance.voice = v; break; }
        }

        utterance.onend = () => {
            // if user had requested listening, restart recognition after speaking
            if (wasListening && recognition) {
                try { recognition.start(); } catch (e) { }
            }
        };

        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(utterance);
    }

    async function sendToGroq(key, systemMsg, userMsg, temperature, maxTokens) {
        const messages = [];

        if (systemMsg) {
            messages.push({ role: 'system', content: systemMsg });
        }
        messages.push({ role: 'user', content: userMsg });

        const requestBody = {
            model: 'llama-3.3-70b-versatile', // Modelo utilizado en script.js
            messages: messages,
            temperature: temperature,
            max_tokens: maxTokens
        };

        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${key}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errText}`);
        }

        const data = await response.json();

        if (data.choices && data.choices.length > 0 && data.choices[0].message) {
            responseArea.value = data.choices[0].message.content;
            // reproducir por voz si está activado
            speakText(responseArea.value);
        } else {
            responseArea.value = 'Respuesta inesperada:\n' + JSON.stringify(data, null, 2);
            speakText(responseArea.value);
        }
    }

    async function sendToGemini(key, systemMsg, userMsg, temperature, maxTokens) {
        // Estructura del body para Gemini (contents, generationConfig, etc.)
        const requestBody = {
            contents: [
                {
                    role: 'user',
                    parts: [{ text: userMsg }]
                }
            ],
            generationConfig: {
                temperature: temperature,
                maxOutputTokens: maxTokens
            }
        };

        // Si hay mensaje del sistema, lo añadimos en systemInstruction (Gemini v1beta lo soporta así)
        if (systemMsg) {
            requestBody.systemInstruction = {
                parts: [{ text: systemMsg }]
            };
        }

        // Endpoint de Gemini (usando gemini-2.5-flash como default para pruebas rápidas)
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`;

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errText}`);
        }

        const data = await response.json();

        if (data.candidates && data.candidates.length > 0 && data.candidates[0].content) {
            responseArea.value = data.candidates[0].content.parts[0].text;
            speakText(responseArea.value);
        } else {
            responseArea.value = 'Respuesta inesperada:\n' + JSON.stringify(data, null, 2);
            speakText(responseArea.value);
        }
    }
});
