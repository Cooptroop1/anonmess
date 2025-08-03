// Event handlers and listeners
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

let pendingCode = null;
let pendingJoin = null;
let mediaRecorder = null;
let voiceTimerInterval = null;
const maxReconnectAttempts = 5; // New: Limit reconnect attempts

socket.onopen = () => {
  console.log('WebSocket opened');
  socket.send(JSON.stringify({ type: 'connect', clientId }));
  startKeepAlive();
  reconnectAttempts = 0; // Reset on successful connection
  const urlParams = new URLSearchParams(window.location.search);
  const codeParam = urlParams.get('code');
  if (codeParam && validateCode(codeParam)) {
    console.log('Detected code in URL, setting pendingCode for autoConnect after token');
    pendingCode = codeParam;
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
  if (reconnectAttempts >= maxReconnectAttempts) {
    showStatusMessage('Max reconnect attempts reached. Please refresh the page.', 10000);
    return;
  }
  const delay = Math.min(30000, 5000 * Math.pow(2, reconnectAttempts));
  reconnectAttempts++;
  setTimeout(() => {
    socket = new WebSocket('wss://signaling-server-zc6m.onrender.com');
    socket.onopen = () => {
      console.log('Reconnected, sending connect');
      socket.send(JSON.stringify({ type: 'connect', clientId }));
      startKeepAlive();
      if (code && username && validateCode(code) && validateUsername(username)) {
        console.log('Rejoining with code:', code);
        socket.send(JSON.stringify({ type: 'join', code, clientId, username, token }));
      }
    };
    socket.onerror = socket.onerror;
    socket.onclose = socket.onclose;
    socket.onmessage = socket.onmessage;
  }, delay);
};

socket.onmessage = async (event) => {
  console.log('Received WebSocket message:', event.data);
  try {
    const message = JSON.parse(event.data);
    console.log('Parsed message:', message);

    if (!message.type) {
      console.error('Invalid message: missing type');
      showStatusMessage('Invalid server message received.');
      return;
    }

    if (message.type === 'pong') {
      console.log('Received keepalive pong');
      return;
    }

    if (message.type === 'connected') {
      token = message.accessToken;
      refreshToken = message.refreshToken;
      console.log('Received authentication tokens:', { accessToken: token, refreshToken });
      if (pendingCode) {
        autoConnect(pendingCode);
        pendingCode = null;
      }
      if (pendingJoin) {
        socket.send(JSON.stringify({ type: 'join', ...pendingJoin, token }));
        pendingJoin = null;
      }
      return;
    }

    if (message.type === 'token-refreshed') {
      token = message.accessToken;
      console.log('Received new access token:', token);
      showStatusMessage('Authentication token refreshed.');
      if (pendingJoin) {
        socket.send(JSON.stringify({ type: 'join', ...pendingJoin, token }));
        pendingJoin = null;
      }
      return;
    }

    if (message.type === 'error') {
      showStatusMessage(message.message);
      console.error('Server error:', message.message);
      if (message.message.includes('Invalid or expired token')) {
        if (refreshToken) {
          console.log('Attempting to refresh token');
          socket.send(JSON.stringify({ type: 'refresh-token', clientId, refreshToken }));
        } else {
          console.error('No refresh token available, forcing reconnect');
          stopKeepAlive();
          socket.close();
        }
      } else if (message.message.includes('Token revoked') || message.message.includes('Invalid or expired refresh token')) {
        showStatusMessage('Session expired. Reconnecting...');
        stopKeepAlive();
        token = ''; // Clear token to prevent reuse
        refreshToken = ''; // Clear refresh token
        socket.close();
      } else if (message.message.includes('Rate limit exceeded')) {
        showStatusMessage('Rate limit exceeded. Waiting before retrying...');
        stopKeepAlive();
        setTimeout(() => {
          if (reconnectAttempts < maxReconnectAttempts) {
            socket.send(JSON.stringify({ type: 'connect', clientId }));
            startKeepAlive();
          }
        }, 60000);
      } else if (message.message.includes('Chat is full') || message.message.includes('Username already taken') || message.message.includes('Initiator offline')) {
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
        token = ''; // Clear token
        refreshToken = ''; // Clear refresh token
      }
      return;
    }

    if (message.type === 'init') {
      clientId = message.clientId;
      maxClients = Math.min(message.maxClients, 10);
      isInitiator = message.isInitiator;
      features = message.features || features;
      totalClients = 1;
      console.log(`Initialized client ${clientId}, username: ${username}, maxClients: ${maxClients}, isInitiator: ${isInitiator}, features:`, features);
      usernames.set(clientId, username);
      initializeMaxClientsUI();
      updateFeaturesUI();
      if (isInitiator) {
        isConnected = true;
        roomKey = await window.crypto.subtle.generateKey(
          { name: 'AES-GCM', length: 256 },
          true,
          ['encrypt', 'decrypt']
        );
      } else {
        const publicKey = await exportPublicKey(keyPair.publicKey);
        socket.send(JSON.stringify({ type: 'public-key', publicKey, clientId, code, token }));
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

    if (message.type === 'public-key' && isInitiator) {
      try {
        const joinerPublic = await importPublicKey(message.publicKey);
        const sharedKey = await deriveSharedKey(keyPair.privateKey, joinerPublic);
        const roomKeyRaw = await window.crypto.subtle.exportKey('raw', roomKey);
        const { encrypted, iv } = await encryptRaw(sharedKey, roomKeyRaw);
        const myPublic = await exportPublicKey(keyPair.publicKey);
        socket.send(JSON.stringify({
          type: 'encrypted-room-key',
          encryptedKey: encrypted,
          iv,
          publicKey: myPublic,
          targetId: message.clientId,
          code,
          clientId,
          token
        }));
      } catch (error) {
        console.error('Error handling public-key:', error);
        showStatusMessage('Key exchange failed.');
      }
    }

    if (message.type === 'encrypted-room-key') {
      try {
        const initiatorPublic = await importPublicKey(message.publicKey);
        const sharedKey = await deriveSharedKey(keyPair.privateKey, initiatorPublic);
        const roomKeyRaw = await decryptBytes(sharedKey, message.encryptedKey, message.iv);
        roomKey = await window.crypto.subtle.importKey(
          'raw',
          roomKeyRaw,
          { name: 'AES-GCM' },
          true,
          ['encrypt', 'decrypt']
        );
        console.log('Room key successfully imported.');
      } catch (error) {
        console.error('Error handling encrypted-room-key:', error);
        showStatusMessage('Failed to receive encryption key.');
      }
    }

    if ((message.type === 'message' || message.type === 'image' || message.type === 'voice') && useRelay) {
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
      messageDiv.appendChild(document.createTextNode(`${senderUsername}: `));
      if (message.type === 'image') {
        const img = document.createElement('img');
        img.src = message.data;
        img.style.maxWidth = '100%';
        img.style.borderRadius = '0.5rem';
        img.style.cursor = 'pointer';
        img.setAttribute('alt', 'Received image');
        img.addEventListener('click', () => createImageModal(message.data, 'messageInput'));
        messageDiv.appendChild(img);
      } else if (message.type === 'voice') {
        const audio = document.createElement('audio');
        audio.src = message.data;
        audio.controls = true;
        audio.setAttribute('alt', 'Received voice message');
        audio.addEventListener('click', () => createAudioModal(message.data, 'messageInput'));
        messageDiv.appendChild(audio);
      } else {
        messageDiv.appendChild(document.createTextNode(sanitizeMessage(message.content)));
      }
      messages.prepend(messageDiv);
      messages.scrollTop = 0;
    }

    if (message.type === 'features-update') {
      features = message;
      console.log('Received features update:', features);
      updateFeaturesUI();
      if (!features.enableService) {
        showStatusMessage('Service disabled by admin. Disconnecting...');
        stopKeepAlive();
        token = ''; // Clear token
        refreshToken = ''; // Clear refresh token
        socket.close();
      }
    }
  } catch (error) {
    console.error('Error parsing message:', error, 'Raw data:', event.data);
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
  if (socket.readyState === WebSocket.OPEN && token) {
    console.log('Sending join message for new chat');
    socket.send(JSON.stringify({ type: 'join', code, clientId, username, token }));
  } else {
    pendingJoin = { code, clientId, username };
    if (socket.readyState !== WebSocket.OPEN) {
      socket.addEventListener('open', () => {
        console.log('WebSocket opened, sending join for new chat');
        if (token) {
          socket.send(JSON.stringify({ type: 'join', code, clientId, username, token }));
          pendingJoin = null;
        }
      }, { once: true });
    }
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
  if (socket.readyState === WebSocket.OPEN && token) {
    console.log('Sending join message for existing chat');
    socket.send(JSON.stringify({ type: 'join', code, clientId, username, token }));
  } else {
    pendingJoin = { code, clientId, username };
    if (socket.readyState !== WebSocket.OPEN) {
      socket.addEventListener('open', () => {
        console.log('WebSocket opened, sending join for existing chat');
        if (token) {
          socket.send(JSON.stringify({ type: 'join', code, clientId, username, token }));
          pendingJoin = null;
        }
      }, { once: true });
    }
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
    sendMedia(file, 'image');
    event.target.value = '';
  }
};

document.getElementById('voiceButton').onclick = () => {
  if (!mediaRecorder || mediaRecorder.state !== 'recording') {
    startVoiceRecording();
  } else {
    stopVoiceRecording();
  }
};

function startVoiceRecording() {
  if (window.location.protocol !== 'https:') {
    console.error('Insecure context: HTTPS required for microphone access');
    showStatusMessage('Error: Microphone access requires HTTPS. Please load the site over a secure connection.');
    document.getElementById('voiceButton')?.focus();
    return;
  }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    console.error('Microphone not supported');
    showStatusMessage('Error: Microphone not supported by your browser or device.');
    document.getElementById('voiceButton')?.focus();
    return;
  }

  navigator.mediaDevices.getUserMedia({ audio: true })
    .then(stream => {
      mediaRecorder = new MediaRecorder(stream);
      const chunks = [];
      let startTime = Date.now();

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunks.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        const blob = new Blob(chunks, { type: 'audio/webm' });
        stream.getTracks().forEach(track => track.stop());
        clearInterval(voiceTimerInterval);
        document.getElementById('voiceTimer').style.display = 'none';
        document.getElementById('voiceButton').classList.remove('recording');
        document.getElementById('voiceButton').textContent = '🎤';
        if (blob.size > 0) {
          await sendMedia(blob, 'voice');
        } else {
          showStatusMessage('Error: No audio recorded.');
        }
      };

      mediaRecorder.start();
      document.getElementById('voiceButton').classList.add('recording');
      document.getElementById('voiceButton').textContent = '⏹';
      document.getElementById('voiceTimer').style.display = 'flex';
      document.getElementById('voiceTimer').textContent = '0:00';

      voiceTimerInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        if (elapsed >= 30) {
          mediaRecorder.stop();
          return;
        }
        const minutes = Math.floor(elapsed / 60);
        const seconds = elapsed % 60;
        document.getElementById('voiceTimer').textContent = `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
      }, 1000);
    })
    .catch(error => {
      console.error('Error accessing microphone:', error.name, error.message);
      if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
        showStatusMessage('Error: Microphone permission denied. Please enable in browser or device settings.');
      } else if (error.name === 'NotFoundError') {
        showStatusMessage('Error: No microphone found on device.');
      } else if (error.name === 'NotReadableError') {
        showStatusMessage('Error: Microphone hardware error or in use by another app.');
      } else if (error.name === 'SecurityError') {
        showStatusMessage('Error: Insecure context. Ensure site is loaded over HTTPS.');
      } else {
        showStatusMessage('Error: Could not access microphone. Check permissions and device support.');
      }
      document.getElementById('voiceButton')?.focus();
    });
}

function stopVoiceRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
  }
}

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
  voiceRateLimits.clear();
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
  token = ''; // Clear token
  refreshToken = ''; // Clear refresh token
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
  if (isInitiator && socket.readyState === WebSocket.OPEN && code && totalClients < maxClients && token) {
    socket.send(JSON.stringify({ type: 'submit-random', code, clientId, token }));
    showStatusMessage(`Sent code ${code} to random board.`);
    codeSentToRandom = true;
    button2.disabled = true;
  } else {
    showStatusMessage('Cannot send: Not initiator, no code, no token, or room is full.');
  }
  document.getElementById('button1')?.focus();
};

document.getElementById('button2').onclick = () => {
  if (!button2.disabled) {
    window.location.href = 'https://anonomoose.com/random.html';
  }
  document.getElementById('button2')?.focus();
};
