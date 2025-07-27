// init.js
// Keepalive timer ID
let keepAliveTimer = null;
// Reconnection attempt counter for exponential backoff
let reconnectAttempts = 0;
// Image rate limiting
const imageRateLimits = new Map();

let code = generateCode();
let clientId = localStorage.getItem('clientId');
if (!clientId) {
  clientId = generateMessageId();
  localStorage.setItem('clientId', clientId);
}
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
let username = localStorage.getItem('username')?.trim() || '';
let usernames = new Map();
const messageRateLimits = new Map();
let codeSentToRandom = false;
let useRelay = false; // Flag for fallback to server relay

const statusElement = document.getElementById('status');
const codeDisplayElement = document.getElementById('codeDisplay');
const copyCodeButton = document.getElementById('copyCodeButton');
const initialContainer = document.getElementById('initialContainer');
const usernameContainer = document.getElementById('usernameContainer');
const connectContainer = document.getElementById('connectContainer');
const chatContainer = document.getElementById('chatContainer');
const newSessionButton = document.getElementById('newSessionButton');
const maxClientsContainer = document.getElementById('maxClientsContainer');
const inputContainer = document.querySelector('.input-container');
const messages = document.getElementById('messages');
const cornerLogo = document.getElementById('cornerLogo');
const button2 = document.getElementById('button2');
const helpText = document.getElementById('helpText');
const helpModal = document.getElementById('helpModal');

const socket = new WebSocket('wss://signaling-server-zc6m.onrender.com');
console.log('WebSocket created');

// Logo cycle animation
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

// Ensure maxClients UI is initialized after DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  console.log('DOM loaded, initializing maxClients UI');
  initializeMaxClientsUI();

  // Add CSP meta tag for XSS prevention
  const cspMeta = document.createElement('meta');
  cspMeta.setAttribute('http-equiv', 'Content-Security-Policy');
  cspMeta.setAttribute('content', "default-src 'self'; script-src 'self'; img-src data: blob: https://raw.githubusercontent.com");
  document.head.appendChild(cspMeta);
});
