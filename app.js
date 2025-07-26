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
  constchars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
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

async function sendImage(file) {
  const validImageTypes = ['image/jpeg', 'image/png'];
  if (!file || !validImageTypes.includes(file.type) || !username || dataChannels.size === 0) {
    showStatusMessage('Error: Select a JPEG or PNG image and ensure you are connected.');
    document.getElementById('imageButton').focus();
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    showStatusMessage('Error: Image size exceeds 5MB limit.');
    document.getElementById('imageButton').focus();
    return;
  }

  // Image rate limiting
  const now = performance.now();
  const rateLimit = imageRateLimits.get(clientId) || { count: 0, startTime: now };
  if (now - rateLimit.startTime >= 60000) {
    rateLimit.count = 0;
    rateLimit.startTime = now;
  }
  rateLimit.count += 1;
  imageRateLimits.set(clientId, rateLimit);
  if (rateLimit.count > 5) {
    showStatusMessage('Image rate limit reached (5 images/min). Please wait.');
    document.getElementById('imageButton').focus();
    return;
  }

  const maxWidth = 640;
  const maxHeight = 360;
  const quality = 0.4;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const img = new Image();
  img.src = URL.createObjectURL(file);
  await new Promise(resolve => img.onload = resolve);

  let width = img.width;
  let height = img.height;
  if (width > height) {
    if (width > maxWidth) {
      height = Math.round((height * maxWidth) / width);
      width = maxWidth;
    }
  } else {
    if (height > maxHeight) {
      width = Math.round((width * maxHeight) / height);
      height = maxHeight;
    }
  }
  canvas.width = width;
  canvas.height = height;
  ctx.drawImage(img, 0, 0, width, height);
  const base64 = canvas.toDataURL('image/jpeg', quality);
  URL.revokeObjectURL(img.src);

  const messageId = generateMessageId();
  const timestamp = Date.now();
  const message = { messageId, type: 'image', data: base64, username, timestamp };
  if (useRelay) {
    // Fallback: Send to server for relay
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'relay-image', code, clientId, ...message }));
    }
  } else if (dataChannels.size > 0) {
    // P2P mode
    const jsonString = JSON.stringify(message);
    dataChannels.forEach((dataChannel) => {
      if (dataChannel.readyState === 'open') {
        dataChannel.send(jsonString);
      }
    });
  } else {
    showStatusMessage('Error: No connections.');
    return;
  }
  const messages = document.getElementById('messages');
  const messageDiv = document.createElement('div');
  messageDiv.className = 'message-bubble self';
  const timeSpan = document.createElement('span');
  timeSpan.className = 'timestamp';
  timeSpan.textContent = new Date(timestamp).toLocaleTimeString();
  messageDiv.appendChild(timeSpan);
  messageDiv.appendChild(document.createTextNode(`${username}: `));
  const imgElement = document.createElement('img');
  imgElement.src = base64;
  imgElement.style.maxWidth = '100%';
  imgElement.style.borderRadius = '0.5rem';
  imgElement.style.cursor = 'pointer';
  imgElement.setAttribute('alt', 'Sent image');
  imgElement.addEventListener('click', () => {
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
      document.getElementById('imageButton').focus();
    });
    modal.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        modal.classList.remove('active');
        document.getElementById('imageButton').focus();
      }
    });
  });
  messageDiv.appendChild(imgElement);
  messages.prepend(messageDiv);
  messages.scrollTop = messages.scrollHeight;
  processedMessageIds.add(messageId);
  document.getElementById('imageButton').focus();
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

const socket = new WebSocket('wss://signaling-server-zc6m.onrender.com');
console.log('WebSocket created');

socket.onopen = () => {
  console.log('WebSocket opened');
  socket.send(JSON.stringify({ type: 'connect', clientId }));
  startKeepAlive();
  reconnectAttempts = 0;
  const urlParams = new URLSearchParams(window.location.search);
  const codeParam = urlParams.get('code');
  if (codeParam && validateCode(codeParam)) {
    console.log('Detected code in URL, triggering autoConnect');
    autoConnect(codeParam);
  } else {
    console.log('No valid code in URL, showing initial container');
    initialContainer.classList.remove('hidden');
    usernameContainer.classList.add('hidden');
    connectContainer.classList.add('hidden');
    chatContainer.classList.add('hidden');
    codeDisplayElement.classList.add('hidden');
    copyCodeButton.classList.add('hidden');
    statusElement.textContent = 'Start a new chat or connect to an existing one';
  }
};

socket.onerror = (error) => {
  console.error('WebSocket error:', error);
  showStatusMessage('Connection error, please try again later.');
  stopKeepAlive();
  connectionTimeouts.forEach((timeout) => clearTimeout(timeout));
};

socket.onclose = () => {
  console.error('WebSocket closed, attempting reconnect');
  stopKeepAlive();
  showStatusMessage('Lost connection, reconnecting...');
  const delay = Math.min(30000, 5000 * Math.pow(2, reconnectAttempts));
  reconnectAttempts++;
  setTimeout(() => {
    const newSocket = new WebSocket('wss://signaling-server-zc6m.onrender.com');
    newSocket.onopen = () => {
      console.log('Reconnected, sending connect');
      newSocket.send(JSON.stringify({ type: 'connect', clientId }));
      startKeepAlive();
      if (code && username && validateCode(code) && validateUsername(username)) {
        console.log('Rejoining with code:', code);
        newSocket.send(JSON.stringify({ type: 'join', code, clientId, username }));
      }
    };
    newSocket.onerror = socket.onerror;
    newSocket.onclose = socket.onclose;
    newSocket.onmessage = socket.onmessage;
    Object.defineProperty(window, 'socket', { value: newSocket, writable: true });
  }, delay);
};

socket.onmessage = (event) => {
  console.log('Received WebSocket message:', event.data);
  try {
    const message = JSON.parse(event.data);
    console.log('Parsed message:', message);
    if (message.type === 'pong') {
      console.log('Received keepalive pong');
      return;
    }
    if (message.type === 'error') {
      showStatusMessage(message.message);
      console.error('Server error:', message.message);
      if (message.message.includes('Chat is full') || message.message.includes('Username already taken') || message.message.includes('Initiator offline')) {
        socket.send(JSON.stringify({ type: 'leave', code, clientId }));
        initialContainer.classList.remove('hidden');
        usernameContainer.classList.add('hidden');
        connectContainer.classList.add('hidden');
        codeDisplayElement.classList.add('hidden');
        copyCodeButton.classList.add('hidden');
        chatContainer.classList.add('hidden');
        newSessionButton.classList.add('hidden');
        maxClientsContainer.classList.add('hidden');
        inputContainer.classList.add('hidden');
        messages.classList.remove('waiting');
        codeSentToRandom = false;
        button2.disabled = false;
        stopKeepAlive();
      }
      return;
    }
    if (message.type === 'init') {
      clientId = message.clientId;
      maxClients = Math.min(message.maxClients, 10);
      isInitiator = message.isInitiator;
      totalClients = 1;
      console.log(`Initialized client ${clientId}, username: ${username}, maxClients: ${maxClients}, isInitiator: ${isInitiator}`);
      usernames.set(clientId, username);
      initializeMaxClientsUI();
      updateMaxClientsUI();
    }
    if (message.type === 'initiator-changed') {
      console.log(`Initiator changed to ${message.newInitiator} for code: ${code}`);
      isInitiator = message.newInitiator === clientId;
      initializeMaxClientsUI();
      updateMaxClientsUI();
    }
    if (message.type === 'join-notify' && message.code === code) {
      totalClients = message.totalClients;
      console.log(`Join-notify received for code: ${code}, client: ${message.clientId}, total: ${totalClients}, username: ${message.username}`);
      if (message.username) {
        usernames.set(message.clientId, message.username);
      }
      updateMaxClientsUI();
      if (isInitiator && message.clientId !== clientId && !peerConnections.has(message.clientId)) {
        console.log(`Initiating peer connection with client ${message.clientId}`);
        startPeerConnection(message.clientId, true);
      }
    }
    if (message.type === 'client-disconnected') {
      totalClients = message.totalClients;
      console.log(`Client ${message.clientId} disconnected from code: ${code}, total: ${totalClients}`);
      usernames.delete(message.clientId);
      cleanupPeerConnection(message.clientId);
      updateMaxClientsUI();
      if (totalClients <= 1) {
        inputContainer.classList.add('hidden');
        messages.classList.add('waiting');
      }
    }
    if (message.type === 'max-clients') {
      maxClients = Math.min(message.maxClients, 10);
      console.log(`Max clients updated to ${maxClients} for code: ${code}`);
      updateMaxClientsUI();
    }
    if (message.type === 'offer' && message.clientId !== clientId) {
      console.log(`Received offer from ${message.clientId} for code: ${code}`);
      handleOffer(message.offer, message.clientId);
    }
    if (message.type === 'answer' && message.clientId !== clientId) {
      console.log(`Received answer from ${message.clientId} for code: ${code}`);
      handleAnswer(message.answer, message.clientId);
    }
    if (message.type === 'candidate' && message.clientId !== clientId) {
      console.log(`Received ICE candidate from ${message.clientId} for code: ${code}`);
      handleCandidate(message.candidate, message.clientId);
    }
    // Add for relay fallback
    if ((message.type === 'message' || message.type === 'image') && useRelay) {
      // Process relayed message from server
      if (processedMessageIds.has(message.messageId)) return;
      processedMessageIds.add(message.messageId);
      const senderUsername = message.username;
      const messages = document.getElementById('messages');
      const isSelf = senderUsername === username;
      const messageDiv = document.createElement('div');
      messageDiv.className = `message-bubble ${isSelf ? 'self' : 'other'}`;
      const timeSpan = document.createElement('span');
      timeSpan.className = 'timestamp';
      timeSpan.textContent = new Date(message.timestamp).toLocaleTimeString();
      messageDiv.appendChild(timeSpan);
      if (message.type === 'image') {
        messageDiv.appendChild(document.createTextNode(`${senderUsername}: `));
        const img = document.createElement('img');
        img.src = message.data;
        img.style.maxWidth = '100%';
        img.style.borderRadius = '0.5rem';
        img.style.cursor = 'pointer';
        img.setAttribute('alt', 'Received image');
        img.addEventListener('click', () => {
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
          modalImg.src = message.data;
          modalImg.setAttribute('alt', 'Enlarged image');
          modal.appendChild(modalImg);
          modal.classList.add('active');
          modal.focus();
          modal.addEventListener('click', () => {
            modal.classList.remove('active');
            document.getElementById('messageInput').focus();
          });
          modal.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
              modal.classList.remove('active');
              document.getElementById('messageInput').focus();
            }
          });
        });
        messageDiv.appendChild(img);
      } else {
        messageDiv.appendChild(document.createTextNode(`${senderUsername}: ${sanitizeMessage(message.content)}`));
      }
      messages.prepend(messageDiv);
      messages.scrollTop = messages.scrollHeight;
    }
  } catch (error) {
    console.error('Error parsing message:', error);
    showStatusMessage('Error receiving message, please try again.');
  }
};

function initializeMaxClientsUI() {
  console.log('initializeMaxClientsUI called, isInitiator:', isInitiator);
  const maxClientsRadios = document.getElementById('maxClientsRadios');
  if (!maxClientsRadios) {
    console.error('maxClientsRadios element not found');
    showStatusMessage('Error: UI initialization failed.');
    return;
  }
  maxClientsRadios.innerHTML = '';
  if (isInitiator) {
    console.log('Creating buttons for maxClients, current maxClients:', maxClients);
    maxClientsContainer.classList.remove('hidden');
    for (let n = 2; n <= 10; n++) {
      const button = document.createElement('button');
      button.textContent = n;
      button.setAttribute('aria-label', `Set maximum users to ${n}`);
      button.className = n === maxClients ? 'active' : '';
      button.disabled = !isInitiator;
      button.addEventListener('click', () => {
        if (isInitiator) {
          console.log(`Button clicked for maxClients: ${n}`);
          setMaxClients(n);
          document.querySelectorAll('#maxClientsRadios button').forEach(btn => btn.classList.remove('active'));
          button.classList.add('active');
        }
      });
      maxClientsRadios.appendChild(button);
    }
    console.log('Buttons appended to maxClientsRadios');
  } else {
    console.log('Hiding maxClientsContainer for non-initiator');
    maxClientsContainer.classList.add('hidden');
  }
}

function updateMaxClientsUI() {
  console.log('updateMaxClientsUI called, maxClients:', maxClients, 'isInitiator:', isInitiator);
  statusElement.textContent = isConnected ? `Connected (${totalClients}/${maxClients} connections)` : 'Waiting for connection...';
  const buttons = document.querySelectorAll('#maxClientsRadios button');
  console.log('Found buttons:', buttons.length);
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

function setMaxClients(n) {
  if (isInitiator && clientId && socket.readyState === WebSocket.OPEN) {
    maxClients = Math.min(n, 10);
    console.log(`setMaxClients called with n: ${n}, new maxClients: ${maxClients}`);
    socket.send(JSON.stringify({ type: 'set-max-clients', maxClients: maxClients, code, clientId }));
    updateMaxClientsUI();
  } else {
    console.warn('setMaxClients failed: not initiator or socket not open');
  }
}

function startPeerConnection(targetId, isOfferer) {
  console.log(`Starting peer connection with ${targetId} for code: ${code}, offerer: ${isOfferer}`);
  if (peerConnections.has(targetId)) {
    console.log(`Cleaning up existing connection with ${targetId}`);
    cleanupPeerConnection(targetId);
  }
  const peerConnection = new RTCPeerConnection({
    iceServers: [
      { urls: "stun:stun.relay.metered.ca:80" },
      {
        urls: "turn:global.relay.metered.ca:80",
        username: "8008f3d422fbe49ca4157b23",
        credential: "E7rLb3LegFMDdjem"
      },
      {
        urls: "turn:global.relay.metered.ca:80?transport=tcp",
        username: "8008f3d422fbe49ca4157b23",
        credential: "E7rLb3LegFMDdjem"
      },
      {
        urls: "turn:global.relay.metered.ca:443",
        username: "8008f3d422fbe49ca4157b23",
        credential: "E7rLb3LegFMDdjem"
      },
      {
        urls: "turns:global.relay.metered.ca:443?transport=tcp",
        username: "8008f3d422fbe49ca4157b23",
        credential: "E7rLb3LegFMDdjem"
      }
    ],
    iceTransportPolicy: 'all'
  });
  peerConnections.set(targetId, peerConnection);
  candidatesQueues.set(targetId, []);

  let dataChannel;
  if (isOfferer) {
    dataChannel = peerConnection.createDataChannel('chat');
    console.log(`Created data channel for ${targetId}`);
    setupDataChannel(dataChannel, targetId);
    dataChannels.set(targetId, dataChannel);
  }

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      console.log(`Sending ICE candidate to ${targetId} for code: ${code}`);
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'candidate', candidate: event.candidate, code, targetId, clientId }));
      }
    }
  };

  peerConnection.onicecandidateerror = (event) => {
    console.error(`ICE candidate error for ${targetId}: ${event.errorText}, code=${event.errorCode}`);
    if (event.errorCode !== 701) {
      const retryCount = retryCounts.get(targetId) || 0;
      if (retryCount < maxRetries) {
        retryCounts.set(targetId, retryCount + 1);
        console.log(`Retrying connection with ${targetId}, attempt ${retryCount + 1}`);
        startPeerConnection(targetId, isOfferer);
      }
    } else {
      console.log(`Ignoring ICE 701 error for ${targetId}, continuing connection`);
    }
  };

  peerConnection.onicegatheringstatechange = () => {
    console.log(`ICE gathering state for ${targetId}: ${peerConnection.iceGatheringState}`);
  };

  peerConnection.onconnectionstatechange = () => {
    console.log(`Connection state for ${targetId}: ${peerConnection.connectionState}`);
    if (peerConnection.connectionState === 'disconnected' || peerConnection.connectionState === 'failed') {
      console.log(`Connection failed with ${targetId}`);
      showStatusMessage('Peer connection failed, attempting to reconnect...');
      cleanupPeerConnection(targetId);
      const retryCount = retryCounts.get(targetId) || 0;
      if (retryCount < maxRetries) {
        retryCounts.set(targetId, retryCount + 1);
        console.log(`Retrying connection attempt ${retryCount + 1} with ${targetId}`);
        startPeerConnection(targetId, isOfferer);
      }
    } else if (peerConnection.connectionState === 'connected') {
      console.log(`WebRTC connection established with ${targetId} for code: ${code}`);
      isConnected = true;
      retryCounts.delete(targetId);
      clearTimeout(connectionTimeouts.get(targetId));
      updateMaxClientsUI();
    }
  };

  peerConnection.ondatachannel = (event) => {
    console.log(`Received data channel from ${targetId}`);
    if (dataChannels.has(targetId)) {
      console.log(`Closing existing data channel for ${targetId}`);
      const existingChannel = dataChannels.get(targetId);
      existingChannel.close();
    }
    dataChannel = event.channel;
    setupDataChannel(dataChannel, targetId);
    dataChannels.set(targetId, dataChannel);
  };

  if (isOfferer) {
    peerConnection.createOffer().then(offer => {
      return peerConnection.setLocalDescription(offer);
    }).then(() => {
      console.log(`Sending offer to ${targetId} for code: ${code}`);
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'offer', offer: peerConnection.localDescription, code, targetId, clientId }));
      }
    }).catch(error => {
      console.error(`Error creating offer for ${targetId}:`, error);
      showStatusMessage('Failed to establish peer connection.');
    });
  }

  const timeout = setTimeout(() => {
    if (!dataChannels.get(targetId) || dataChannels.get(targetId).readyState !== 'open') {
      console.log(`P2P failed with ${targetId}, falling back to relay`);
      useRelay = true;
      showStatusMessage('P2P connection failed, switching to server relay mode.');
      cleanupPeerConnection(targetId);
    }
  }, 10000); // 10s timeout for fallback
  connectionTimeouts.set(targetId, timeout);
}

function setupDataChannel(dataChannel, targetId) {
  console.log('setupDataChannel initialized for targetId:', targetId);
  dataChannel.onopen = () => {
    console.log(`Data channel opened with ${targetId} for code: ${code}, state: ${dataChannel.readyState}`);
    isConnected = true;
    initialContainer.classList.add('hidden');
    usernameContainer.classList.add('hidden');
    connectContainer.classList.add('hidden');
    chatContainer.classList.remove('hidden');
    newSessionButton.classList.remove('hidden');
    inputContainer.classList.remove('hidden');
    messages.classList.remove('waiting');
    clearTimeout(connectionTimeouts.get(targetId));
    retryCounts.delete(targetId);
    updateMaxClientsUI();
    document.getElementById('messageInput').focus();
  };

  dataChannel.onmessage = (event) => {
    const now = performance.now();
    const rateLimit = messageRateLimits.get(targetId) || { count: 0, startTime: now };
    if (now - rateLimit.startTime >= 1000) {
      rateLimit.count = 0;
      rateLimit.startTime = now;
    }
    rateLimit.count += 1;
    messageRateLimits.set(targetId, rateLimit);
    if (rateLimit.count > 10) {
      console.warn(`Rate limit exceeded for ${targetId}: ${rateLimit.count} messages in 1s`);
      showStatusMessage('Message rate limit reached, please slow down.');
      return;
    }

    let data;
    try {
      data = JSON.parse(event.data);
    } catch (e) {
      console.error(`Invalid message from ${targetId}:`, e);
      showStatusMessage('Invalid message received.');
      return;
    }
    if (!data.messageId || !data.username || (!data.content && data.type !== 'image') || (data.type === 'image' && !data.data)) {
      console.log(`Invalid message format from ${targetId}:`, data);
      return;
    }
    if (processedMessageIds.has(data.messageId)) {
      console.log(`Duplicate message ${data.messageId} from ${targetId}`);
      return;
    }
    processedMessageIds.add(data.messageId);
    const senderUsername = usernames.get(targetId) || data.username;
    const messages = document.getElementById('messages');
    const isSelf = senderUsername === username;
    const messageDiv = document.createElement('div');
    messageDiv.className = `message-bubble ${isSelf ? 'self' : 'other'}`;
    messageDiv.textContent = `${senderUsername}: `;
    if (data.type === 'image') {
      const img = document.createElement('img');
      img.src = data.data;
      img.style.maxWidth = '100%';
      img.style.borderRadius = '0.5rem';
      img.style.cursor = 'pointer';
      img.setAttribute('alt', 'Received image');
      img.addEventListener('click', () => {
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
        modalImg.src = data.data;
        modalImg.setAttribute('alt', 'Enlarged image');
        modal.appendChild(modalImg);
        modal.classList.add('active');
        modal.focus();
        modal.addEventListener('click', () => {
          modal.classList.remove('active');
          document.getElementById('messageInput').focus();
        });
        modal.addEventListener('keydown', (event) => {
          if (event.key === 'Escape') {
            modal.classList.remove('active');
            document.getElementById('messageInput').focus();
          }
        });
      });
      messageDiv.appendChild(img);
    } else {
      messageDiv.textContent += sanitizeMessage(data.content);
    }
    messages.prepend(messageDiv);
    messages.scrollTop = messages.scrollHeight;
    if (isInitiator) {
      dataChannels.forEach((dc, id) => {
        if (id !== targetId && dc.readyState === 'open') {
          dc.send(JSON.stringify(data));
        }
      });
    }
  };

  dataChannel.onerror = (error) => {
    console.error(`Data channel error with ${targetId}:`, error);
    showStatusMessage('Error in peer connection.');
  };

  dataChannel.onclose = () => {
    console.log(`Data channel closed with ${targetId}`);
    showStatusMessage('Peer disconnected.');
    cleanupPeerConnection(targetId);
    messageRateLimits.delete(targetId);
    imageRateLimits.delete(targetId);
    if (dataChannels.size === 0) {
      inputContainer.classList.add('hidden');
      messages.classList.add('waiting');
    }
  };
}

async function handleOffer(offer, targetId) {
  console.log(`Handling offer from ${targetId} for code: ${code}`);
  if (offer.type !== 'offer') {
    console.error(`Invalid offer type from ${targetId}:`, offer.type);
    return;
  }
  if (!peerConnections.has(targetId)) {
    console.log(`No existing peer connection for ${targetId}, starting new one`);
    startPeerConnection(targetId, false);
  }
  const peerConnection = peerConnections.get(targetId);
  try {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'answer', answer: peerConnection.localDescription, code, targetId, clientId }));
    }
    const queue = candidatesQueues.get(targetId) || [];
    queue.forEach(candidate => {
      handleCandidate(candidate, targetId);
    });
    candidatesQueues.set(targetId, []);
  } catch (error) {
    console.error(`Error handling offer from ${targetId}:`, error);
    showStatusMessage('Failed to connect to peer.');
  }
}

async function handleAnswer(answer, targetId) {
  console.log(`Handling answer from ${targetId} for code: ${code}`);
  if (!peerConnections.has(targetId)) {
    console.log(`No peer connection for ${targetId}, starting new one and queuing answer`);
    startPeerConnection(targetId, false);
    candidatesQueues.get(targetId).push({ type: 'answer', answer });
    return;
  }
  const peerConnection = peerConnections.get(targetId);
  if (answer.type !== 'answer') {
    console.error(`Invalid answer type from ${targetId}:`, answer.type);
    return;
  }
  if (peerConnection.signalingState !== 'have-local-offer') {
    console.log(`Queuing answer from ${targetId}`);
    candidatesQueues.get(targetId).push({ type: 'answer', answer });
    return;
  }
  try {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
    const queue = candidatesQueues.get(targetId) || [];
    queue.forEach(item => {
      if (item.type === 'answer') {
        peerConnection.setRemoteDescription(new RTCSessionDescription(item.answer)).catch(error => {
          console.error(`Error applying queued answer from ${targetId}:`, error);
          showStatusMessage('Error processing peer response.');
        });
      } else if (item.type === 'candidate') {
        handleCandidate(item.candidate, targetId);
      }
    });
    candidatesQueues.set(targetId, []);
  } catch (error) {
    console.error(`Error handling answer from ${targetId}:`, error);
    showStatusMessage('Error connecting to peer.');
  }
}

function handleCandidate(candidate, targetId) {
  console.log(`Handling ICE candidate from ${targetId} for code: ${code}`);
  const peerConnection = peerConnections.get(targetId);
  if (peerConnection && peerConnection.remoteDescription) {
    peerConnection.addIceCandidate(new RTCIceCandidate(candidate)).catch(error => {
      console.error(`Error adding ICE candidate from ${targetId}:`, error);
      showStatusMessage('Error establishing peer connection.');
    });
  } else {
    const queue = candidatesQueues.get(targetId) || [];
    queue.push({ type: 'candidate', candidate });
    candidatesQueues.set(targetId, queue);
  }
}

function cleanupPeerConnection(targetId) {
  const peerConnection = peerConnections.get(targetId);
  const dataChannel = dataChannels.get(targetId);
  if (dataChannel && dataChannel.readyState === 'open') {
    console.log(`Skipping cleanup for ${targetId}: data channel is open`);
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

function sendMessage(content) {
  if (content && dataChannels.size > 0 && username) {
    const messageId = generateMessageId();
    const sanitizedContent = sanitizeMessage(content);
    const timestamp = Date.now();
    const message = { messageId, content: sanitizedContent, username, timestamp };
    if (useRelay) {
      // Fallback: Send to server for relay
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'relay-message', code, clientId, ...message }));
      }
    } else {
      // P2P mode
      const jsonString = JSON.stringify(message);
      dataChannels.forEach((dataChannel, targetId) => {
        if (dataChannel.readyState === 'open') {
          dataChannel.send(jsonString);
        }
      });
    }
    const messages = document.getElementById('messages');
    const messageDiv = document.createElement('div');
    messageDiv.className = 'message-bubble self';
    const timeSpan = document.createElement('span');
    timeSpan.className = 'timestamp';
    timeSpan.textContent = new Date(timestamp).toLocaleTimeString();
    messageDiv.appendChild(timeSpan);
    messageDiv.appendChild(document.createTextNode(`${username}: ${sanitizedContent}`));
    messages.prepend(messageDiv);
    messages.scrollTop = messages.scrollHeight;
    const messageInput = document.getElementById('messageInput');
    messageInput.value = '';
    messageInput.style.height = '2.5rem';
    processedMessageIds.add(messageId);
    messageInput.focus();
  } else {
    showStatusMessage('Error: No connections or username not set.');
    document.getElementById('messageInput').focus();
  }
}

document.getElementById('startChatToggleButton').onclick = () => {
  console.log('Start chat toggle clicked');
  initialContainer.classList.add('hidden');
  usernameContainer.classList.remove('hidden');
  connectContainer.classList.add('hidden');
  chatContainer.classList.add('hidden');
  codeDisplayElement.classList.add('hidden');
  copyCodeButton.classList.add('hidden');
  statusElement.textContent = 'Enter a username to start a chat';
  document.getElementById('usernameInput').value = username || '';
  document.getElementById('usernameInput').focus();
};

document.getElementById('connectToggleButton').onclick = () => {
  console.log('Connect toggle clicked');
  initialContainer.classList.add('hidden');
  usernameContainer.classList.add('hidden');
  connectContainer.classList.remove('hidden');
  chatContainer.classList.add('hidden');
  codeDisplayElement.classList.add('hidden');
  copyCodeButton.classList.add('hidden');
  statusElement.textContent = 'Enter a username and code to join a chat';
  document.getElementById('usernameConnectInput').value = username || '';
  document.getElementById('usernameConnectInput').focus();
};

document.getElementById('joinWithUsernameButton').onclick = () => {
  const usernameInput = document.getElementById('usernameInput').value.trim();
  if (!validateUsername(usernameInput)) {
    showStatusMessage('Invalid username: 1-16 alphanumeric characters.');
    document.getElementById('usernameInput').focus();
    return;
  }
  username = usernameInput;
  localStorage.setItem('username', username);
  console.log('Username set in localStorage:', username);
  code = generateCode();
  codeDisplayElement.textContent = `Your code: ${code}`;
  codeDisplayElement.classList.remove('hidden');
  copyCodeButton.classList.remove('hidden');
  usernameContainer.classList.add('hidden');
  connectContainer.classList.add('hidden');
  initialContainer.classList.add('hidden');
  chatContainer.classList.remove('hidden');
  messages.classList.add('waiting');
  statusElement.textContent = 'Waiting for connection...';
  if (socket.readyState === WebSocket.OPEN) {
    console.log('Sending join message for new chat');
    socket.send(JSON.stringify({ type: 'join', code, clientId, username }));
  } else {
    socket.addEventListener('open', () => {
      console.log('WebSocket opened, sending join for new chat');
      socket.send(JSON.stringify({ type: 'join', code, clientId, username }));
    }, { once: true });
  }
  document.getElementById('messageInput').focus();
};

document.getElementById('connectButton').onclick = () => {
  const usernameInput = document.getElementById('usernameConnectInput').value.trim();
  const inputCode = document.getElementById('codeInput').value.trim();
  if (!validateUsername(usernameInput)) {
    showStatusMessage('Invalid username: 1-16 alphanumeric characters.');
    document.getElementById('usernameConnectInput').focus();
    return;
  }
  if (!validateCode(inputCode)) {
    showStatusMessage('Invalid code format: xxxx-xxxx-xxxx-xxxx.');
    document.getElementById('codeInput').focus();
    return;
  }
  username = usernameInput;
  localStorage.setItem('username', username);
  console.log('Username set in localStorage:', username);
  code = inputCode;
  codeDisplayElement.textContent = `Using code: ${code}`;
  codeDisplayElement.classList.remove('hidden');
  copyCodeButton.classList.remove('hidden');
  initialContainer.classList.add('hidden');
  usernameContainer.classList.add('hidden');
  connectContainer.classList.add('hidden');
  chatContainer.classList.remove('hidden');
  messages.classList.add('waiting');
  statusElement.textContent = 'Waiting for connection...';
  if (socket.readyState === WebSocket.OPEN) {
    console.log('Sending join message for existing chat');
    socket.send(JSON.stringify({ type: 'join', code, clientId, username }));
  } else {
    socket.addEventListener('open', () => {
      console.log('WebSocket opened, sending join for existing chat');
      socket.send(JSON.stringify({ type: 'join', code, clientId, username }));
    }, { once: true });
  }
  document.getElementById('messageInput').focus();
};

document.getElementById('backButton').onclick = () => {
  console.log('Back button clicked from usernameContainer');
  usernameContainer.classList.add('hidden');
  initialContainer.classList.remove('hidden');
  connectContainer.classList.add('hidden');
  chatContainer.classList.add('hidden');
  codeDisplayElement.classList.add('hidden');
  copyCodeButton.classList.add('hidden');
  statusElement.textContent = 'Start a new chat or connect to an existing one';
  messages.classList.remove('waiting');
  stopKeepAlive();
  document.getElementById('startChatToggleButton').focus();
};

document.getElementById('backButtonConnect').onclick = () => {
  console.log('Back button clicked from connectContainer');
  connectContainer.classList.add('hidden');
  initialContainer.classList.remove('hidden');
  usernameContainer.classList.add('hidden');
  chatContainer.classList.add('hidden');
  codeDisplayElement.classList.add('hidden');
  copyCodeButton.classList.add('hidden');
  statusElement.textContent = 'Start a new chat or connect to an existing one';
  messages.classList.remove('waiting');
  stopKeepAlive();
  document.getElementById('connectToggleButton').focus();
};

document.getElementById('sendButton').onclick = () => {
  const messageInput = document.getElementById('messageInput');
  const message = messageInput.value.trim();
  if (message) {
    sendMessage(message);
  }
};

document.getElementById('imageButton').onclick = () => {
  document.getElementById('imageInput').click();
};

document.getElementById('imageInput').onchange = (event) => {
  const file = event.target.files[0];
  if (file) {
    sendImage(file);
    event.target.value = '';
  }
};

const messageInput = document.getElementById('messageInput');
messageInput.addEventListener('input', () => {
  messageInput.style.height = '2.5rem';
  messageInput.style.height = `${Math.min(messageInput.scrollHeight, 12.5 * 16)}px`;
});

messageInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    const message = event.target.value.trim();
    if (message) {
      sendMessage(message);
    }
  }
});

document.getElementById('newSessionButton').onclick = () => {
  console.log('New session button clicked');
  socket.send(JSON.stringify({ type: 'leave', code, clientId }));
  peerConnections.forEach((pc) => pc.close());
  dataChannels.forEach((dc) => dc.close());
  peerConnections.clear();
  dataChannels.clear();
  candidatesQueues.clear();
  connectionTimeouts.forEach((timeout) => clearTimeout(timeout));
  connectionTimeouts.clear();
  retryCounts.clear();
  processedMessageIds.clear();
  processedAnswers.clear();
  usernames.clear();
  messageRateLimits.clear();
  imageRateLimits.clear();
  isConnected = false;
  isInitiator = false;
  maxClients = 2;
  totalClients = 0;
  code = generateCode();
  codeDisplayElement.textContent = '';
  codeDisplayElement.classList.add('hidden');
  copyCodeButton.classList.add('hidden');
  statusElement.textContent = 'Start a new chat or connect to an existing one';
  document.getElementById('messages').innerHTML = '';
  document.getElementById('messageInput').value = '';
  document.getElementById('messageInput').style.height = '2.5rem';
  document.getElementById('usernameInput').value = username || '';
  document.getElementById('usernameConnectInput').value = username || '';
  document.getElementById('codeInput').value = '';
  initialContainer.classList.remove('hidden');
  usernameContainer.classList.add('hidden');
  connectContainer.classList.add('hidden');
  chatContainer.classList.add('hidden');
  newSessionButton.classList.add('hidden');
  maxClientsContainer.classList.add('hidden');
  inputContainer.classList.add('hidden');
  messages.classList.remove('waiting');
  codeSentToRandom = false;
  button2.disabled = false;
  stopKeepAlive();
  document.getElementById('startChatToggleButton').focus();
};

document.getElementById('usernameInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    document.getElementById('joinWithUsernameButton').click();
  }
});

document.getElementById('usernameConnectInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    document.getElementById('codeInput').focus();
  }
});

document.getElementById('codeInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    document.getElementById('connectButton').click();
  }
});

document.getElementById('copyCodeButton').onclick = () => {
  const codeText = codeDisplayElement.textContent.replace('Your code: ', '').replace('Using code: ', '');
  navigator.clipboard.writeText(codeText).then(() => {
    copyCodeButton.textContent = 'Copied!';
    setTimeout(() => {
      copyCodeButton.textContent = 'Copy Code';
    }, 2000);
  }).catch(err => {
    console.error('Failed to copy text: ', err);
    showStatusMessage('Failed to copy code.');
  });
  copyCodeButton.focus();
};

document.getElementById('button1').onclick = () => {
  if (isInitiator && socket.readyState === WebSocket.OPEN && code && totalClients < maxClients) {
    socket.send(JSON.stringify({ type: 'submit-random', code, clientId }));
    showStatusMessage(`Sent code ${code} to random board.`);
    codeSentToRandom = true;
    button2.disabled = true;
  } else {
    showStatusMessage('Cannot send: Not initiator, no code, or room is full.');
  }
  document.getElementById('button1').focus();
};

document.getElementById('button2').onclick = () => {
  if (!button2.disabled) {
    window.location.href = 'https://anonomoose.com/random.html';
  }
  document.getElementById('button2').focus();
};

function autoConnect(codeParam) {
  console.log('autoConnect running with code:', codeParam);
  code = codeParam;
  initialContainer.classList.add('hidden');
  connectContainer.classList.add('hidden');
  usernameContainer.classList.add('hidden');
  chatContainer.classList.remove('hidden');
  codeDisplayElement.classList.add('hidden');
  copyCodeButton.classList.add('hidden');
  console.log('Loaded username from localStorage:', username);
  if (validateCode(codeParam)) {
    if (validateUsername(username)) {
      console.log('Valid username and code, joining chat');
      codeDisplayElement.textContent = `Using code: ${code}`;
      codeDisplayElement.classList.remove('hidden');
      copyCodeButton.classList.remove('hidden');
      messages.classList.add('waiting');
      statusElement.textContent = 'Waiting for connection...';
      if (socket.readyState === WebSocket.OPEN) {
        console.log('WebSocket open, sending join');
        socket.send(JSON.stringify({ type: 'join', code, clientId, username }));
      } else {
        console.log('WebSocket not open, waiting for open event');
        socket.addEventListener('open', () => {
          console.log('WebSocket opened in autoConnect, sending join');
          socket.send(JSON.stringify({ type: 'join', code, clientId, username }));
        }, { once: true });
      }
      document.getElementById('messageInput').focus();
    } else {
      console.log('No valid username, prompting for username');
      usernameContainer.classList.remove('hidden');
      chatContainer.classList.add('hidden');
      statusElement.textContent = 'Please enter a username to join the chat';
      document.getElementById('usernameInput').value = username || '';
      document.getElementById('usernameInput').focus();
      document.getElementById('joinWithUsernameButton').onclick = () => {
        const usernameInput = document.getElementById('usernameInput').value.trim();
        if (!validateUsername(usernameInput)) {
          showStatusMessage('Invalid username: 1-16 alphanumeric characters.');
          document.getElementById('usernameInput').focus();
          return;
        }
        username = usernameInput;
        localStorage.setItem('username', username);
        console.log('Username set in localStorage during autoConnect:', username);
        usernameContainer.classList.add('hidden');
        chatContainer.classList.remove('hidden');
        codeDisplayElement.textContent = `Using code: ${code}`;
        codeDisplayElement.classList.remove('hidden');
        copyCodeButton.classList.remove('hidden');
        messages.classList.add('waiting');
        statusElement.textContent = 'Waiting for connection...';
        if (socket.readyState === WebSocket.OPEN) {
          console.log('WebSocket open, sending join after username input');
          socket.send(JSON.stringify({ type: 'join', code, clientId, username }));
        } else {
          console.log('WebSocket not open, waiting for open event after username');
          socket.addEventListener('open', () => {
            console.log('WebSocket opened in autoConnect join, sending join');
            socket.send(JSON.stringify({ type: 'join', code, clientId, username }));
          }, { once: true });
        }
        document.getElementById('messageInput').focus();
      };
    }
  } else {
    console.log('Invalid code, showing initial container');
    initialContainer.classList.remove('hidden');
    usernameContainer.classList.add('hidden');
    chatContainer.classList.add('hidden');
    showStatusMessage('Invalid code format. Please enter a valid code.');
    document.getElementById('connectToggleButton').focus();
  }
}

// Ensure maxClients UI is initialized after DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  console.log('DOM loaded, initializing maxClients UI');
  initializeMaxClientsUI();
});
