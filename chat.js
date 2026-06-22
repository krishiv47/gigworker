/* =====================================================================
   GigGuard — AI Chat Component
   Provides a chat interface for dispatch operators to ask AI questions
   about incidents. Uses the AI provider from common.js.
   ===================================================================== */
const IncidentChat = (function () {
  /* ---- internal state ---- */
  let messages = [];        // { role: 'user'|'assistant', content: string }
  let incident = null;      // current incident context
  let containerEl = null;   // root DOM element
  let messagesEl = null;    // scrollable message area
  let inputEl = null;       // text input
  let sendBtn = null;       // send button
  let suggestionsEl = null; // suggestion pills row
  let typingEl = null;      // typing indicator
  let busy = false;         // true while waiting for API
  let mode = 'dispatch';    // 'dispatch' or 'driver'

  const DISPATCH_SUGGESTIONS = [
    'What injuries are likely?',
    'Recommended treatment?',
    'Should we alert trauma team?',
    'Recovery time estimate?',
  ];

  const DRIVER_SUGGESTIONS = [
    'I am in pain, what do I do?',
    'Will the ambulance take long?',
    'How do I stop bleeding?',
    'I feel dizzy.',
  ];

  /* ---- helpers ---- */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function scrollToBottom() {
    if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  /* ---- system prompt builder ---- */
  function buildSystemPrompt() {
    if (!incident) {
      return 'You are a medical triage AI assistant for an emergency crash detection system called GigGuard. No incident is currently loaded.';
    }
    const i = incident;
    const injuries = (i.ai && i.ai.likely_injuries) ? i.ai.likely_injuries.join(', ') : 'Unknown';

    if (mode === 'driver') {
      return `You are a reassuring AI assistant talking directly to the gig rider who just had a crash.
Current incident context:
- Rider: ${i.driver.name}
- Impact: ${i.impact.gForce}G
- Likely injuries: ${injuries}

Provide calm, brief, reassuring guidance. The rider may be injured, confused, or scared. Do NOT give complex medical advice, just simple reassurance and basic safe practices while waiting for help. Keep responses extremely brief (1-2 sentences max).`;
    }

    return `You are a medical triage AI assistant for an emergency crash detection system called GigGuard. You help dispatch operators understand crash incidents and make dispatch decisions.

Current incident context:
- Rider: ${i.driver.name}, Vehicle: ${i.driver.vehicle}
- Impact: ${i.impact.gForce}G, Speed: ${i.impact.speedBefore} → ${i.impact.speedAfter} km/h, Direction: ${i.impact.direction}
- AI Severity: ${i.severity}
- Likely injuries: ${injuries}
- Location: ${i.location.lat}, ${i.location.lng}

Provide concise, actionable medical guidance. You are NOT a doctor — always recommend professional medical evaluation. Keep responses brief (2-3 paragraphs max).`;
  }

  /* ---- render a single chat bubble ---- */
  function renderBubble(msg) {
    const div = document.createElement('div');
    const isUser = msg.role === 'user';
    div.className = `chat-bubble ${isUser ? 'chat-bubble-user' : 'chat-bubble-ai'}`;
    div.textContent = msg.content;
    return div;
  }

  /* ---- render all messages ---- */
  function renderMessages() {
    if (!messagesEl) return;
    messagesEl.innerHTML = '';
    if (!messages.length) {
      const empty = document.createElement('div');
      empty.className = 'chat-empty';
      empty.textContent = incident
        ? 'Ask a question about this incident…'
        : 'Select an incident to start chatting.';
      messagesEl.appendChild(empty);
      return;
    }
    messages.forEach((m) => messagesEl.appendChild(renderBubble(m)));
    scrollToBottom();
  }

  /* ---- show / hide typing indicator ---- */
  function setTyping(on) {
    if (!typingEl) return;
    typingEl.style.display = on ? 'flex' : 'none';
    if (on) scrollToBottom();
  }

  /* ---- toggle input controls ---- */
  function setEnabled(on) {
    busy = !on;
    if (inputEl) inputEl.disabled = !on;
    if (sendBtn) sendBtn.disabled = !on;
  }

  /* ---- send a message to AI ---- */
  async function send(text) {
    const content = (text || '').trim();
    if (!content || busy) return;

    // push user message
    messages.push({ role: 'user', content });
    renderMessages();
    inputEl.value = '';

    // hide suggestions after first message
    if (suggestionsEl) suggestionsEl.style.display = 'none';

    setEnabled(false);
    setTyping(true);

    try {
      // build the messages array for the API (full conversation history)
      const apiMessages = messages.map((m) => ({ role: m.role, content: m.content }));
      const systemPrompt = buildSystemPrompt();

      const reply = await AI.chat(apiMessages, systemPrompt);
      messages.push({ role: 'assistant', content: reply });
    } catch (err) {
      console.error('[IncidentChat] API error:', err);
      messages.push({
        role: 'assistant',
        content: 'Sorry, I couldn\'t process that request. ' +
          (err.message || 'Unknown error') + '. Please try again.',
      });
    } finally {
      setTyping(false);
      setEnabled(true);
      renderMessages();
      if (inputEl) inputEl.focus();
    }
  }

  /* ---- build the DOM tree ---- */
  function buildUI(container) {
    containerEl = container;
    containerEl.innerHTML = '';
    containerEl.classList.add('chat-container');

    // suggestions row
    suggestionsEl = document.createElement('div');
    suggestionsEl.className = 'chat-suggestions';
    const suggestions = mode === 'driver' ? DRIVER_SUGGESTIONS : DISPATCH_SUGGESTIONS;
    suggestions.forEach((text) => {
      const pill = document.createElement('button');
      pill.className = 'chat-suggestion';
      pill.textContent = text;
      pill.addEventListener('click', () => send(text));
      suggestionsEl.appendChild(pill);
    });
    containerEl.appendChild(suggestionsEl);

    // messages area
    messagesEl = document.createElement('div');
    messagesEl.className = 'chat-messages';
    containerEl.appendChild(messagesEl);

    // typing indicator (three bouncing dots)
    typingEl = document.createElement('div');
    typingEl.className = 'chat-bubble chat-bubble-ai typing-dots';
    typingEl.style.display = 'none';
    typingEl.innerHTML = '<span></span><span></span><span></span>';
    messagesEl.after(typingEl);

    // input row
    const inputRow = document.createElement('div');
    inputRow.className = 'chat-input-row';

    inputEl = document.createElement('input');
    inputEl.type = 'text';
    inputEl.placeholder = 'Ask about this incident…';
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(inputEl.value); }
    });

    sendBtn = document.createElement('button');
    sendBtn.className = 'btn btn-primary';
    sendBtn.textContent = 'Send';
    sendBtn.addEventListener('click', () => send(inputEl.value));

    inputRow.appendChild(inputEl);
    inputRow.appendChild(sendBtn);
    containerEl.appendChild(inputRow);

    renderMessages();
  }

  /* ===================================================================
     Public API
     =================================================================== */
  return {
    /**
     * Initialise the chat UI inside a DOM element.
     * @param {string} containerId — id of the container element
     * @param {string} m — mode ('dispatch' or 'driver')
     */
    create(containerId, m = 'dispatch') {
      mode = m;
      const el = document.getElementById(containerId);
      if (!el) { console.error('[IncidentChat] container not found:', containerId); return; }
      buildUI(el);
    },

    /**
     * Load incident context for the conversation.
     * Clears any previous chat history and re-shows suggestions.
     * @param {object} inc — incident object from the Store
     */
    setIncident(inc) {
      incident = inc;
      messages = [];
      if (suggestionsEl) suggestionsEl.style.display = '';
      renderMessages();
    },

    /**
     * Reset the chat — clear messages, incident, and restore suggestions.
     */
    clear() {
      incident = null;
      messages = [];
      busy = false;
      if (suggestionsEl) suggestionsEl.style.display = '';
      setTyping(false);
      setEnabled(true);
      renderMessages();
    },
  };
})();
