// setup.js - Variables, DOM elements, utilities, toggles, keepalive

// Keepalive timer ID
let keepAliveTimer = null;
// Reconnection attempt counter for exponential backoff
let reconnectAttempts = 0;
// Image rate limiting
const imageRateLimits = new Map();

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
  return div.innerHTML.replace(/</g, '<').replace(/>/g, '>');
}

function generateCode() {
  const chars= 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
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
      console.log('Sent keepalive ping');
    }
  }, 20000);
}

function stopKeepAlive() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
    console.log('Stopped keepalive');
  }
}

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
let processedAnswers = new Set();
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
const darkModeToggle = document.getElementById('darkModeToggle');

// Dark mode toggle
function toggleDarkMode() {
  document.body.classList.toggle('dark');
  const isDark = document.body.classList.contains('dark');
  localStorage.setItem('darkMode', isDark ? 'enabled' : 'disabled');
  darkModeToggle.textContent = isDark ? 'Light Mode' : 'Dark Mode';
}

// Load dark mode preference
if (localStorage.getItem('darkMode') === 'enabled') {
  toggleDarkMode();
}

darkModeToggle.addEventListener('click', toggleDarkMode);

// Help modal toggle
helpText.addEventListener('click', () => {
  helpModal.classList.add('active');
  helpModal.focus();
});

helpModal.addEventListener('click', () => {
  helpModal.classList.remove('active');
  helpText.focus();
});

helpModal.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    helpModal.classList.remove('active');
    helpText.focus();
  }
});

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
