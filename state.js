// state.js - Shared state variables

export let code = generateCode();
export let clientId = Math.random().toString(36).substr(2, 9);
export let username = '';
export let isInitiator = false;
export let isConnected = false;
export let maxClients = 2;
export let totalClients = 0;
export let peerConnections = new Map();
export let dataChannels = new Map();
export let connectionTimeouts = new Map();
export let retryCounts = new Map();
export const maxRetries = 2;
export let candidatesQueues = new Map();
export let processedMessageIds = new Set();
export let usernames = new Map();
export const messageRateLimits = new Map();
export let codeSentToRandom = false;
export let useRelay = false;
let _token = '';
export function getToken() { return _token; }
export function setToken(newValue) { _token = newValue; }
let _refreshToken = '';
export function getRefreshToken() { return _refreshToken; }
export function setRefreshToken(newValue) { _refreshToken = newValue; }
export let features = { enableService: true, enableImages: true, enableVoice: true, enableVoiceCalls: true };
export let keyPair;
export let roomKey;
export let remoteAudios = new Map();
export let refreshingToken = false;
export let signalingQueue = new Map();
export let pendingCode = null;
export let pendingJoin = null;

// Function to generate code (moved from events.js)
function generateCode() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 16; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
    if (i % 4 === 3 && i < 15) result += '-';
  }
  return result;
}

// Initialize clientId and username from localStorage
if (typeof window !== 'undefined') {
  if (localStorage.getItem('clientId')) {
    clientId = localStorage.getItem('clientId');
  } else {
    localStorage.setItem('clientId', clientId);
  }
  username = localStorage.getItem('username')?.trim() || '';
}

// Async key pair generation
(async () => {
  keyPair = await window.crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey']
  );
})();

// Image and voice rate limits
export const imageRateLimits = new Map();
export const voiceRateLimits = new Map();

// Global message rate
export let globalMessageRate = { count: 0, startTime: Date.now() };

// Reconnection attempts
let _reconnectAttempts = 0;
export function getReconnectAttempts() { return _reconnectAttempts; }
export function setReconnectAttempts(newValue) { _reconnectAttempts = newValue; }
