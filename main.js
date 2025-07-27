
// Core logic: peer connections, message sending, handling offers, etc.

// Global vars for dynamic TURN creds from server
let turnUsername = '';
let turnCredential = '';

async function sendImage(file) {
  const validImageTypes = ['image/jpeg', 'image/png'];
  if (!file || !validImageTypes.includes(file.type) || !username || (dataChannels.size === 0 && totalClients === 0)) { // Updated: Check totalClients
    showStatusMessage('Error: Select a JPEG or PNG image and ensure you are connected.');
    document.getElementById('imageButton')?.focus();
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    showStatusMessage('Error: Image size exceeds 5MB limit.');
    document.getElementById('imageButton')?.focus();
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
    document.getElementById('imageButton')?.focus();
    return;
  }

  const maxWidth = 640;
  const maxHeight = 360;
  let quality = 0.4;
  if (file.size > 3 * 1024 * 1024) {
    quality = 0.3; // Lower quality for files > 3MB
  } else if (file.size > 1 * 1024 * 1024) {
    quality = 0.35; // Medium for 1-3MB
  }
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
  let sent = false;
  if (useRelay) {
    // Fallback: Send to server for relay
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'relay-image', code, clientId, token, ...message }));
      sent = true;
    }
  } else if (dataChannels.size > 0) {
    // P2P mode
    const jsonString = JSON.stringify(message);
    dataChannels.forEach((dataChannel) => {
      if (dataChannel.readyState === 'open') {
        dataChannel.send(jsonString);
      }
    });
    sent = true;
  } 
  if (!sent) {
    showStatusMessage('No connections to send image.');
    return;
  }
  // Updated: Always add locally, even if solo
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
    createImageModal(base64, 'imageButton');
  });
  messageDiv.appendChild(imgElement);
  messages.prepend(messageDiv);
  messages.scrollTop = 0;
  processedMessageIds.add(messageId);
  document.getElementById('imageButton')?.focus();
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
        username: turnUsername,
        credential: turnCredential
      },
      {
        urls: "turn:global.relay.metered.ca:80?transport=tcp",
        username: turnUsername,
        credential: turnCredential
      },
      {
        urls: "turn:global.relay.metered.ca:443",
        username: turnUsername,
        credential: turnCredential
      },
      {
        urls: "turns:global.relay.metered.ca:443?transport=tcp",
        username: turnUsername,
        credential: turnCredential
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
        socket.send(JSON.stringify({ type: 'candidate', candidate: event.candidate, code, targetId, clientId, token }));
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
        socket.send(JSON.stringify({ type: 'offer', offer: peerConnection.localDescription, code, targetId, clientId, token }));
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
    document.getElementById('messageInput')?.focus();
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
    const timeSpan = document.createElement('span');
    timeSpan.className = 'timestamp';
    timeSpan.textContent = new Date(data.timestamp).toLocaleTimeString();
    messageDiv.appendChild(timeSpan);
    messageDiv.appendChild(document.createTextNode(`${senderUsername}: `));
    if (data.type === 'image') {
      const img = document.createElement('img');
      img.src = data.data;
      img.style.maxWidth = '100%';
      img.style.borderRadius = '0.5rem';
      img.style.cursor = 'pointer';
      img.setAttribute('alt', 'Received image');
      img.addEventListener('click', () => {
        createImageModal(data.data, 'messageInput');
      });
      messageDiv.appendChild(img);
    } else {
      messageDiv.appendChild(document.createTextNode(sanitizeMessage(data.content)));
    }
    messages.prepend(messageDiv);
    messages.scrollTop = 0;
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
      socket.send(JSON.stringify({ type: 'answer', answer: peerConnection.localDescription, code, targetId, clientId, token }));
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
    start The tool call was a test, but now to solve the actual problem.

From logs, the issue is that for the initiator in a new chat, there are no peer connections, so dataChannels.size === 0, isConnected remains false, and inputContainer is hidden.

To allow the initiator to see the input box (even if alone, to wait for others), we need to adjust the logic to show the input if isInitiator || dataChannels.size > 0.

In cleanupPeerConnection and updateMaxClientsUI, isConnected = dataChannels.size > 0;

But for initiator, add a check in the join logic to set isConnected = true if isInitiator.

After 'init' with isInitiator=true, set isConnected=true, show input.

Also, in updateMaxClientsUI, if (totalClients >= 1) { messages.classList.remove('waiting'); inputContainer.classList.remove('hidden'); }

But since totalClients=1 for initiator.

Yes.

No need for tools, as I have the code.The issue is that when starting a new chat as the initiator (solo user), there are no peer connections yet, so `dataChannels.size === 0` and `isConnected` stays `false`. This hides the input box and keeps the UI in "waiting" mode, even though the room is created successfully. The app is designed for multi-user P2P/relay, but it should allow the initiator to see the chat interface immediately (to share the code and wait for joins, or even send messages that appear locally until others connect).

To fix this, we can update the code to set `isConnected = true` for the initiator right after receiving the 'init' message if `isInitiator === true`. We'll also adjust `updateMaxClientsUI()` to show the input and remove 'waiting' if `totalClients >= 1` (covering the solo initiator case).

### Changes Needed
Only 2 files change: `events.js` (add set isConnected on init if initiator) and `utils.js` (tweak updateMaxClientsUI to check totalClients >=1 for UI visibility).

Copy-paste these updated files (others unchanged).

#### events.js (Updated)
```javascript
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
        newSocket.send(JSON.stringify({ type: 'join', code, clientId, username, token }));
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
    if (message.type === 'connected') {
      token = message.token;
      console.log('Received authentication token:', token);
      return;
    }
    if (message.type === 'error') {
      showStatusMessage(message.message);
      console.error('Server error:', message.message);
      if (message.message.includes('Chat is full') || message.message.includes('Username already taken') || message.message.includes('Initiator offline')) {
        socket.send(JSON.stringify({ type: 'leave', code, clientId, token }));
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
      if (isInitiator) {
        isConnected = true; // New: Set connected for initiator even if solo
      }
      updateMaxClientsUI();
      turnUsername = message.turnUsername;
      turnCredential = message.turnCredential;
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
            document.getElementById('messageInput')?.focus();
          });
          modal.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
              modal.classList.remove('active');
              document.getElementById('messageInput')?.focus();
            }
          });
        });
        messageDiv.appendChild(img);
      } else {
        messageDiv.appendChild(document.createTextNode(`${senderUsername}: ${sanitizeMessage(message.content)}`));
      }
      messages.prepend(messageDiv);
      messages.scrollTop = 0;
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
  document.getElementById('usernameInput')?.focus();
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
  document.getElementById('usernameConnectInput')?.focus();
};

document.getElementById('joinWithUsernameButton').onclick = () => {
  const usernameInput = document.getElementById('usernameInput').value.trim();
  if (!validateUsername(usernameInput)) {
    showStatusMessage('Invalid username: 1-16 alphanumeric characters.');
    document.getElementById('usernameInput')?.focus();
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
    socket.send(JSON.stringify({ type: 'join', code, clientId, username, token }));
  } else {
    socket.addEventListener('open', () => {
      console.log('WebSocket opened, sending join for new chat');
      socket.send(JSON.stringify({ type: 'join', code, clientId, username, token }));
    }, { once: true });
  }
  document.getElementById('messageInput')?.focus();
};

document.getElementById('connectButton').onclick = () => {
  const usernameInput = document.getElementById('usernameConnectInput').value.trim();
  const inputCode = document.getElementById('codeInput').value.trim();
  if (!validateUsername(usernameInput)) {
    showStatusMessage('Invalid username: 1-16 alphanumeric characters.');
    document.getElementById('usernameConnectInput')?.focus();
    return;
  }
  if (!validateCode(inputCode)) {
    showStatusMessage('Invalid code format: xxxx-xxxx-xxxx-xxxx.');
    document.getElementById('codeInput')?.focus();
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
    socket.send(JSON.stringify({ type: 'join', code, clientId, username, token }));
  } else {
    socket.addEventListener('open', () => {
      console.log('WebSocket opened, sending join for existing chat');
      socket.send(JSON.stringify({ type: 'join', code, clientId, username, token }));
    }, { once: true });
  }
  document.getElementById('messageInput')?.focus();
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
  document.getElementById('startChatToggleButton')?.focus();
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
  document.getElementById('connectToggleButton')?.focus();
};

document.getElementById('sendButton').onclick = () => {
  const messageInput = document.getElementById('messageInput');
  const message = messageInput.value.trim();
  if (message) {
    sendMessage(message);
  }
};

document.getElementById('imageButton').onclick = () => {
  document.getElementById('imageInput')?.click();
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
  socket.send(JSON.stringify({ type: 'leave', code, clientId, token }));
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
  document.getElementById('startChatToggleButton')?.focus();
};

document.getElementById('usernameInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    document.getElementById('joinWithUsernameButton')?.click();
  }
});

document.getElementById('usernameConnectInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    document.getElementById('codeInput')?.focus();
  }
});

document.getElementById('codeInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    document.getElementById('connectButton')?.click();
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
  copyCodeButton?.focus();
};

document.getElementById('button1').onclick = () => {
  if (isInitiator && socket.readyState === WebSocket.OPEN && code && totalClients < maxClients) {
    socket.send(JSON.stringify({ type: 'submit-random', code, clientId, token }));
    showStatusMessage(`Sent code ${code} to random board.`);
    codeSentToRandom = true;
    button2.disabled = true;
  } else {
    showStatusMessage('Cannot send: Not initiator, no code, or room is full.');
  }
  document.getElementById('button1')?.focus();
};

document.getElementById('button2').onclick = () => {
  if (!button2.disabled) {
    window.location.href = 'https://anonomoose.com/random.html';
  }
  document.getElementById('button2')?.focus();
};
