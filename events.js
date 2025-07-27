// events.js (updated without DOMContentLoaded, extracted onmessage handlers)

// Event handlers and listeners

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

// Extracted handlers for onmessage
function handlePong(message) {
  console.log('Received keepalive pong');
}

function handleError(message) {
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
}

function handleInit(message) {
  clientId = message.clientId;
  maxClients = Math.min(message.maxClients, 10);
  isInitiator = message.isInitiator;
  totalClients = 1;
  console.log(`Initialized client ${clientId}, username: ${username}, maxClients: ${maxClients}, isInitiator: ${isInitiator}`);
  usernames.set(clientId, username);
  initializeMaxClientsUI();
  updateMaxClientsUI();
}

function handleInitiatorChanged(message) {
  console.log(`Initiator changed to ${message.newInitiator} for code: ${code}`);
  isInitiator = message.newInitiator === clientId;
  initializeMaxClientsUI();
  updateMaxClientsUI();
}

function handleJoinNotify(message) {
  if (message.code === code) {
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
}

function handleClientDisconnected(message) {
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

function handleMaxClients(message) {
  maxClients = Math.min(message.maxClients, 10);
  console.log(`Max clients updated to ${maxClients} for code: ${code}`);
  updateMaxClientsUI();
}

function handleOffer(message) {
  if (message.clientId !== clientId) {
    console.log(`Received offer from ${message.clientId} for code: ${code}`);
    handleOffer(message.offer, message.clientId);
  }
}

function handleAnswer(message) {
  if (message.clientId !== clientId) {
    console.log(`Received answer from ${message.clientId} for code: ${code}`);
    handleAnswer(message.answer, message.clientId);
  }
}

function handleCandidate(message) {
  if (message.clientId !== clientId) {
    console.log(`Received ICE candidate from ${message.clientId} for code: ${code}`);
    handleCandidate(message.candidate, message.clientId);
  }
}

function handleRelay(message) {
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
}

socket.onmessage = (event) => {
  console.log('Received WebSocket message:', event.data);
  try {
    const message = JSON.parse(event.data);
    console.log('Parsed message:', message);
    if (message.type === 'pong') {
      handlePong(message);
      return;
    }
    if (message.type === 'error') {
      handleError(message);
      return;
    }
    if (message.type === 'init') {
      handleInit(message);
    }
    if (message.type === 'initiator-changed') {
      handleInitiatorChanged(message);
    }
    if (message.type === 'join-notify') {
      handleJoinNotify(message);
    }
    if (message.type === 'client-disconnected') {
      handleClientDisconnected(message);
    }
    if (message.type === 'max-clients') {
      handleMaxClients(message);
    }
    if (message.type === 'offer') {
      handleOffer(message);
    }
    if (message.type === 'answer') {
      handleAnswer(message);
    }
    if (message.type === 'candidate') {
      handleCandidate(message);
    }
    if ((message.type === 'message' || message.type === 'image') && useRelay) {
      handleRelay(message);
    }
  } catch (error) {
    console.error('Error parsing message:', error);
    showStatusMessage('Error receiving message, please try again.');
  }
};

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
  statusElement.text First, the user wants to implement all the issues and suggestions from the report I gave for the client code (the 4 split files).

The report has:

1. TURN Creds Handling: Add checks in startPeerConnection if creds empty, use STUN-only.

2. Duplicate DOM Loaded Listener: Remove from events.js.

3. ClientId Validation Removed: Add basic check (length 9, alphanumeric).

4. Timestamp in Received Messages: Add timeSpan for text in onmessage.

5. ICE 701/400 Errors: Expand onicecandidateerror to ignore 400/401.

6. Relay Mode UX: Add optional retry button or periodic reattempt. (This is more involved, perhaps add a simple retry function.)

7. Performance: Add window.onbeforeunload to send 'leave'. (In events.js)

8. Code Organization: Extract sub-functions in onmessage (e.g., handleInit, etc.)

9. Edge Cases: Add validation in autoConnect early; add close button to modal.

I need to update the 4 files: utils.js, init.js, events.js, main.js with these changes.

Since the user asks for "full codes for the changes", I'll print the full updated content for each file.

Also, the system prompt has tools and render components, but this is a code update task, so no need for tools unless I need to search something. For this, I can directly respond with the code.

Final response should interweave render components if applicable, but since no search, no citations.

Output the updated files.utils.js
```javascript
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

function validateClientId(clientId) {
  const regex = /^[a-z0-9]{9}$/i;
  return clientId && regex.test(clientId);
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
