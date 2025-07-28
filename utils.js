// Utility to show temporary status messages
function showStatusMessage(message, duration = 3000) {
  const statusElement = document.getElementById('status');
  statusElement.textContent = message;
  statusElement.setAttribute('aria-live', 'assertive');
  setTimeout(() => {
    statusElement.textContent = isConnected ? `Connected (${totalClients}/${maxClients} connections)` : 'Waiting for connection...';
    statusElement.setAttribute('aria-live', 'polite');
  }, duration);
}

// Sanitize message content to prevent XSS
function sanitizeMessage(content) {
  const div = document.createElement('div');
  div.textContent = content;
  return div.innerHTML.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function generateCode() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 16; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
    if (i % 4 === 3 && i < 15) result += '-';
  }
  return result;
}

function generateMessageId() {
  return Math.random().toString(36).substr(2, 9);
}

function validateUsername(username) {
  const regex = /^[a-zA-Z0-9]{1,16}$/;
  return username && regex.test(username);
}

function validateCode(code) {
  const regex = /^[a-zA-Z0-9]{4}-[a-zA-Z0-9]{4}-[a-zA-Z0-9]{4}-[a-zA-Z0-9]{4}$/;
  return code && regex.test(code);
}

// Keepalive function to prevent WebSocket timeout
function startKeepAlive() {
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  keepAliveTimer = setInterval(() => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'ping', clientId }));
      log('info', 'Sent keepalive ping');
    }
  }, 20000);
}

function stopKeepAlive() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
    log('info', 'Stopped keepalive');
  }
}

function cleanupPeerConnection(targetId) {
  const peerConnection = peerConnections.get(targetId);
  const dataChannel = dataChannels.get(targetId);
  if (dataChannel && dataChannel.readyState === 'open') {
    log('info', `Skipping cleanup for ${targetId}: data channel is open`);
    return;
  }
  if (peerConnection) {
    peerConnection.close();
    peerConnections.delete(targetId);
  }
  if (dataChannel) {
    dataChannel.close();
    dataChannels.delete(targetId);
  }
  candidatesQueues.delete(targetId);
  clearTimeout(connectionTimeouts.get(targetId));
  connectionTimeouts.delete(targetId);
  retryCounts.delete(targetId);
  messageRateLimits.delete(targetId);
  imageRateLimits.delete(targetId);
  isConnected = dataChannels.size > 0;
  updateMaxClientsUI();
  if (!isConnected) {
    inputContainer.classList.add('hidden');
    messages.classList.add('waiting');
  }
}

function initializeMaxClientsUI() {
  log('info', 'initializeMaxClientsUI called, isInitiator:', isInitiator);
  const maxClientsRadios = document.getElementById('maxClientsRadios');
  if (!maxClientsRadios) {
    log('error', 'maxClientsRadios element not found');
    showStatusMessage('Error: UI initialization failed.');
    return;
  }
  maxClientsRadios.innerHTML = '';
  if (isInitiator) {
    log('info', 'Creating buttons for maxClients, current maxClients:', maxClients);
    maxClientsContainer.classList.remove('hidden');
    for (let n = 2; n <= 10; n++) {
      const button = document.createElement('button');
      button.textContent = n;
      button.setAttribute('aria-label', `Set maximum users to ${n}`);
      button.className = n === maxClients ? 'active' : '';
      button.disabled = !isInitiator;
      button.addEventListener('click', () => {
        if (isInitiator) {
          log('info', `Button clicked for maxClients: ${n}`);
          setMaxClients(n);
          document.querySelectorAll('#maxClientsRadios button').forEach(btn => btn.classList.remove('active'));
          button.classList.add('active');
        }
      });
      maxClientsRadios.appendChild(button);
    }
    log('info', 'Buttons appended to maxClientsRadios');
  } else {
    log('info', 'Hiding maxClientsContainer for non-initiator');
    maxClientsContainer.classList.add('hidden');
  }
}

function updateMaxClientsUI() {
  log('info', 'updateMaxClientsUI called, maxClients:', maxClients, 'isInitiator:', isInitiator);
  statusElement.textContent = isConnected ? `Connected (${totalClients}/${maxClients} connections)` : 'Waiting for connection...';
  const buttons = document.querySelectorAll('#maxClientsRadios button');
  log('info', 'Found buttons:', buttons.length);
  buttons.forEach(button => {
    const value = parseInt(button.textContent);
    button.classList.toggle('active', value === maxClients);
    button.disabled = !isInitiator;
  });
  maxClientsContainer.classList.toggle('hidden', !isInitiator);
  if (!isConnected) {
    messages.classList.add('waiting');
  } else {
    messages.classList.remove('waiting');
  }
}

/**
 * Sets the maximum number of clients allowed in the chat.
 * @param {number} n - The new maximum number of clients (2-10).
 */
function setMaxClients(n) {
  if (isInitiator && clientId && socket.readyState === WebSocket.OPEN) {
    maxClients = Math.min(n, 10);
    log('info', `setMaxClients called with n: ${n}, new maxClients: ${maxClients}`);
    socket.send(JSON.stringify({ type: 'set-max-clients', maxClients: maxClients, code, clientId, token })); // New: include token
    updateMaxClientsUI();
  } else {
    log('warn', 'setMaxClients failed: not initiator or socket not open');
  }
}

/**
 * Centralized logger for consistent logging.
 * @param {string} level - The log level ('info', 'warn', 'error').
 * @param {...any} msg - The message parts to log.
 */
function log(level, ...msg) {
  const timestamp = new Date().toISOString();
  const fullMsg = `[${timestamp}] ${msg.join(' ')}`;
  if (level === 'error') {
    console.error(fullMsg);
  } else if (level === 'warn') {
    console.warn(fullMsg);
  } else {
    console.log(fullMsg);
  }
}

/**
 * Creates and shows an image modal.
 * @param {string} base64 - The base64 image data.
 * @param {string} focusId - The ID of the element to focus after closing the modal.
 */
function createImageModal(base64, focusId) {
  let modal = document.getElementById('imageModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'imageModal';
    modal.className = 'modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-label', 'Image viewer');
    modal.setAttribute('tabindex', '-1');
    document.body.appendChild(modal);
  }
  modal.innerHTML = '';
  const modalImg = document.createElement('img');
  modalImg.src = base64;
  modalImg.setAttribute('alt', 'Enlarged image');
  modal.appendChild(modalImg);
  modal.classList.add('active');
  modal.focus();
  modal.addEventListener('click', () => {
    modal.classList.remove('active');
    document.getElementById(focusId)?.focus();
  });
  modal.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      modal.classList.remove('active');
      document.getElementById(focusId)?.focus();
    }
  });
}

// New: Encryption functions using Web Crypto
async function encrypt(text) {
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(text);
  const encrypted = await window.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    roomKey,
    encoded
  );
  return { encrypted: arrayBufferToBase64(encrypted), iv: arrayBufferToBase64(iv) };
}

async function decrypt(encrypted, iv) {
  const decoded = await window.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToArrayBuffer(iv) },
    roomKey,
    base64ToArrayBuffer(encrypted)
  );
  return new TextDecoder().decode(decoded);
}

function arrayBufferToBase64(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

// New: Export public key as base64 (SPKI format)
async function exportPublicKey(key) {
  const exported = await window.crypto.subtle.exportKey('spki', key);
  return arrayBufferToBase64(exported);
}

// New: Import public key from base64 (SPKI)
async function importPublicKey(base64) {
  const binary = base64ToArrayBuffer(base64);
  return await window.crypto.subtle.importKey(
    'spki',
    binary,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    []
  );
}

// New: Derive shared AES key from ECDH
async function deriveSharedKey(privateKey, publicKey) {
  return await window.crypto.subtle.deriveKey(
    { name: 'ECDH', public: publicKey },
    privateKey,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

// New: Encrypt raw ArrayBuffer (for room key sharing)
async function encryptRaw(key, data) {
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await window.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    data
  );
  return { encrypted: arrayBufferToBase64(encrypted), iv: arrayBufferToBase64(iv) };
}

// New: Decrypt raw to ArrayBuffer
async function decryptRaw(key, encrypted, iv) {
  return await window.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToArrayBuffer(iv) },
    key,
    base64ToArrayBuffer(encrypted)
  );
}
