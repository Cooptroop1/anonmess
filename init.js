// Keepalive timer ID
let keepAliveTimer = null;
// Reconnection attempt counter for exponential backoff
let reconnectAttempts = 0;
// Image rate limiting
const imageRateLimits = new Map();
// Voice rate limiting
const voiceRateLimits = new Map();
// Global message rate limit (shared for DoS mitigation)
let globalMessageRate = { count: 0, startTime: Date.now() };

// Define generateCode locally
function generateCode() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 16; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
    if (i % 4 === 3 && i < 15) result += '-';
  }
  return result;
}

let code = generateCode();
let clientId = Math.random().toString(36).substr(2, 9);
let username = '';
let isInitiator = false;
let isConnected = false;
let maxClients = 2;
let totalClients = 0;
let peerConnections = new Map();
let dataChannels = new Map();
let connectionTimeouts = new Map();
let retryCounts = new Map();
const maxRetries = 2;
let candidatesQueues = new Map();
let processedMessageIds = new Set();
let usernames = new Map();
const messageRateLimits = new Map();
let codeSentToRandom = false;
let useRelay = false;
let token = '';
let refreshToken = '';

let keyPair;
let roomKey;

// Declare UI variables globally
let socket, statusElement, codeDisplayElement, copyCodeButton, initialContainer, usernameContainer, connectContainer, chatContainer, newSessionButton, maxClientsContainer, inputContainer, messages, cornerLogo, button2, helpText, helpModal;

if (typeof window !== 'undefined') {
  socket = new WebSocket('wss://signaling-server-zc6m.onrender.com');
  console.log('WebSocket created');

  if (localStorage.getItem('clientId')) {
    clientId = localStorage.getItem('clientId');
  } else {
    localStorage.setItem('clientId', clientId);
  }
  username = localStorage.getItem('username')?.trim() || '';

  globalMessageRate.startTime = performance.now();

  statusElement = document.getElementById('status');
  codeDisplayElement = document.getElementById('codeDisplay');
  copyCodeButton = document.getElementById('copyCodeButton');
  initialContainer = document.getElementById('initialContainer');
  usernameContainer = document.getElementById('usernameContainer');
  connectContainer = document.getElementById('connectContainer');
  chatContainer = document.getElementById('chatContainer');
  newSessionButton = document.getElementById('newSessionButton');
  maxClientsContainer = document.getElementById('maxClientsContainer');
  inputContainer = document.querySelector('.input-container');
  messages = document.getElementById('messages');
  cornerLogo = document.getElementById('cornerLogo');
  button2 = document.getElementById('button2');
  helpText = document.getElementById('helpText');
  helpModal = document.getElementById('helpModal');

  (async () => {
    keyPair = await window.crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveKey']
    );
  })();

  let cycleTimeout;
  function triggerCycle() {
    if (cycleTimeout) clearTimeout(cycleTimeout);
    cornerLogo.classList.add('wink');
    cycleTimeout = setTimeout(() => {
      cornerLogo.classList.remove('wink');
    }, 500);
    setTimeout(() => triggerCycle(), 60000);
  }
  setTimeout(() => triggerCycle(), 60000);

  document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM loaded, initializing maxClients UI');
    initializeMaxClientsUI();
  });
}
