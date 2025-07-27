// main.js
// Core logic: peer connections, message sending, handling offers, etc.

// Global vars for dynamic TURN creds from server
let turnUsername = '';
let turnCredential = '';

async function sendImage(file) {
  const validImageTypes = ['image/jpeg', 'image/png'];
  if (!file || !validImageTypes.includes(file.type) || !username || dataChannels.size === 0) {
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
  messageDiv.setAttribute('role', 'listitem');
  messageDiv.setAttribute('aria-label', `Message from ${username}`);
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
  imgElement.addEventListener('click', () => createImageModal(base64, 'imageButton'));
  messageDiv.appendChild(imgElement);
  messages.appendChild(messageDiv);
  messages.scrollTop = messages.scrollHeight;
  processedMessageIds.add(messageId);
  document.getElementById('imageButton')?.focus();
}

function startPeerConnection(targetId, isOfferer) {
  log('info', `Starting peer connection with ${targetId} for code: ${code}, offerer: ${isOfferer}`);
  if (peerConnections.has(targetId)) {
    log('info', `Cleaning up existing connection with ${targetId}`);
    cleanupPeerConnection(targetId);
  }
  const peerConnection = new RTCPeerConnection({
    iceServers: [
      { urls: "stun:stun.relay.metered.ca:80" },
      {
        urls: "turn:global.relay.metered.ca:80",
        username: turnUsername, // Dynamic from server
        credential: turnCredential // Dynamic from server
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
    log('info', `Created data channel for ${targetId}`);
    setupDataChannel(dataChannel, targetId);
    dataChannels.set(targetId, dataChannel);
  }

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      log('info', `Sending ICE candidate to ${targetId} for code: ${code}`);
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'candidate', candidate: event.candidate, code, targetId, clientId }));
      }
    }
  };

  peerConnection.onicecandidateerror = (event) => {
    log('error', `ICE candidate error for ${targetId}: ${event.errorText}, code=${event.errorCode}`);
    if (event.errorCode !== 701) {
      const retryCount = retryCounts.get(targetId) || 0;
      if (retryCount < maxRetries) {
        retryCounts.set(targetId, retryCount + 1);
        log('info', `Retrying connection with ${targetId}, attempt ${retryCount + 1}`);
        startPeerConnection(targetId, isOfferer);
      }
    } else {
      log('info', `Ignoring ICE 701 error for ${targetId}, continuing connection`);
    }
  };

  peerConnection.onicegatheringstatechange = () => {
    log('info', `ICE gathering state for ${targetId}: ${peerConnection.iceGatheringState}`);
  };

  peerConnection.onconnectionstatechange = () => {
    log('info', `Connection state for ${targetId}: ${peerConnection.connectionState}`);
    if (peerConnection.connectionState === 'disconnected' || peerConnection.connectionState === 'failed') {
      log('info', `Connection failed with ${targetId}`);
      showStatusMessage('Peer connection failed, attempting to reconnect...');
      cleanupPeerConnection(targetId);
      const retryCount = retryCounts.get(targetId) || 0;
      if (retryCount < maxRetries) {
        retryCounts.set(targetId, retryCount + 1);
        log('info', `Retrying connection attempt ${retryCount + 1} with ${targetId}`);
        startPeerConnection(targetId, isOfferer);
      }
    } else if (peerConnection.connectionState === 'connected') {
      log('info', `WebRTC connection established with ${targetId} for code: ${code}`);
      isConnected = true;
      retryCounts.delete(targetId);
      clearTimeout(connectionTimeouts.get(targetId));
      updateMaxClientsUI();
    }
  };

  peerConnection.ondatachannel = (event) => {
    log('info', `Received data channel from ${targetId}`);
    if (dataChannels.has(targetId)) {
      log('info', `Closing existing data channel for ${targetId}`);
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
      log('info', `Sending offer to ${targetId} for code: ${code}`);
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'offer', offer: peerConnection.localDescription, code, targetId, clientId }));
      }
    }).catch(error => {
      log('error', `Error creating offer for ${targetId}:`, error);
      showStatusMessage('Failed to establish peer connection.');
    });
  }

  const timeout = setTimeout(() => {
    if (!dataChannels.get(targetId) || dataChannels.get(targetId).readyState !== 'open') {
      log('info', `P2P failed with ${targetId}, falling back to relay`);
      useRelay = true;
      showStatusMessage('P2P connection failed, switching to server relay mode.');
      cleanupPeerConnection(targetId);
    }
  }, 10000); // 10s timeout for fallback
  connectionTimeouts.set(targetId, timeout);
}

/**
 * Handles incoming offer from a peer.
 * @param {RTCSessionDescriptionInit} offer - The SDP offer.
 * @param {string} targetId - The ID of the peer sending the offer.
 */
async function handleOffer(offer, targetId) {
  log('info', `Handling offer from ${targetId} for code: ${code}`);
  if (offer.type !== 'offer') {
    log('error', `Invalid offer type from ${targetId}:`, offer.type);
    return;
  }
  if (!peerConnections.has(targetId)) {
    log('info', `No existing peer connection for ${targetId}, starting new one`);
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
    log('error', `Error handling offer from ${targetId}:`, error);
    showStatusMessage('Failed to connect to peer.');
  }
}

/**
 * Handles incoming answer from a peer.
 * @param {RTCSessionDescriptionInit} answer - The SDP answer.
 * @param {string} targetId - The ID of the peer sending the answer.
 */
async function handleAnswer(answer, targetId) {
  log('info', `Handling answer from ${targetId} for code: ${code}`);
  if (!peerConnections.has(targetId)) {
    log('info', `No peer connection for ${targetId}, starting new one and queuing answer`);
    startPeerConnection(targetId, false);
    candidatesQueues.get(targetId).push({ type: 'answer', answer });
    return;
  }
  const peerConnection = peerConnections.get(targetId);
  if (answer.type !== 'answer') {
    log('error', `Invalid answer type from ${targetId}:`, answer.type);
    return;
  }
  if (peerConnection.signalingState !== 'have-local-offer') {
    log('info', `Queuing answer from ${targetId}`);
    candidatesQueues.get(targetId).push({ type: 'answer', answer });
    return;
  }
  try {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
    const queue = candidatesQueues.get(targetId) || [];
    queue.forEach(item => {
      if (item.type === 'answer') {
        peerConnection.setRemoteDescription(new RTCSessionDescription(item.answer)).catch(error => {
          log('error', `Error applying queued answer from ${targetId}:`, error);
          showStatusMessage('Error processing peer response.');
        });
      } else if (item.type === 'candidate') {
        handleCandidate(item.candidate, targetId);
      }
    });
    candidatesQueues.set(targetId, []);
  } catch (error) {
    log('error', `Error handling answer from ${targetId}:`, error);
    showStatusMessage('Error connecting to peer.');
  }
}

/**
 * Handles incoming ICE candidate from a peer.
 * @param {RTCIceCandidateInit} candidate - The ICE candidate.
 * @param {string} targetId - The ID of the peer sending the candidate.
 */
function handleCandidate(candidate, targetId) {
  log('info', `Handling ICE candidate from ${targetId} for code: ${code}`);
  const peerConnection = peerConnections.get(targetId);
  if (peerConnection && peerConnection.remoteDescription) {
    peerConnection.addIceCandidate(new RTCIceCandidate(candidate)).catch(error => {
      log('error', `Error adding ICE candidate from ${targetId}:`, error);
      showStatusMessage('Error establishing peer connection.');
    });
  } else {
    const queue = candidatesQueues.get(targetId) || [];
    queue.push({ type: 'candidate', candidate });
    candidatesQueues.set(targetId, queue);
  }
}

/**
 * Sends a text message to peers or relay.
 * @param {string} content - The message content to send.
 */
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
    messageDiv.setAttribute('role', 'listitem');
    messageDiv.setAttribute('aria-label', `Message from ${username}`);
    const timeSpan = document.createElement('span');
    timeSpan.className = 'timestamp';
    timeSpan.textContent = new Date(timestamp).toLocaleTimeString();
    messageDiv.appendChild(timeSpan);
    messageDiv.appendChild(document.createTextNode(`${username}: ${sanitizedContent}`));
    messages.appendChild(messageDiv);
    messages.scrollTop = messages.scrollHeight;
    const messageInput = document.getElementById('messageInput');
    messageInput.value = '';
    messageInput.style.height = '2.5rem';
    processedMessageIds.add(messageId);
    messageInput?.focus();
  } else {
    showStatusMessage('Error: No connections or username not set.');
    document.getElementById('messageInput')?.focus();
  }
}

/**
 * Automatically connects to a chat using a code from URL.
 * @param {string} codeParam - The code parameter from the URL.
 */
function autoConnect(codeParam) {
  log('info', 'autoConnect running with code:', codeParam);
  code = codeParam;
  initialContainer.classList.add('hidden');
  connectContainer.classList.add('hidden');
  usernameContainer.classList.add('hidden');
  chatContainer.classList.remove('hidden');
  codeDisplayElement.classList.add('hidden');
  copyCodeButton.classList.add('hidden');
  log('info', 'Loaded username from localStorage:', username);
  if (validateCode(codeParam)) {
    if (validateUsername(username)) {
      log('info', 'Valid username and code, joining chat');
      codeDisplayElement.textContent = `Using code: ${code}`;
      codeDisplayElement.classList.remove('hidden');
      copyCodeButton.classList.remove('hidden');
      messages.classList.add('waiting');
      statusElement.textContent = 'Waiting for connection...';
      if (socket.readyState === WebSocket.OPEN) {
        log('info', 'WebSocket open, sending join');
        socket.send(JSON.stringify({ type: 'join', code, clientId, username }));
      } else {
        log('info', 'WebSocket not open, waiting for open event');
        socket.addEventListener('open', () => {
          log('info', 'WebSocket opened in autoConnect, sending join');
          socket.send(JSON.stringify({ type: 'join', code, clientId, username }));
        }, { once: true });
      }
      document.getElementById('messageInput')?.focus();
    } else {
      log('info', 'No valid username, prompting for username');
      usernameContainer.classList.remove('hidden');
      chatContainer.classList.add('hidden');
      statusElement.textContent = 'Please enter a username to join the chat';
      document.getElementById('usernameInput').value = username || '';
      document.getElementById('usernameInput')?.focus();
      document.getElementById('joinWithUsernameButton').onclick = () => {
        const usernameInput = document.getElementById('usernameInput').value.trim();
        if (!validateUsername(usernameInput)) {
          showStatusMessage('Invalid username: 1-16 alphanumeric characters.');
          document.getElementById('usernameInput')?.focus();
          return;
        }
        username = usernameInput;
        localStorage.setItem('username', username);
        log('info', 'Username set in localStorage during autoConnect:', username);
        usernameContainer.classList.add('hidden');
        chatContainer.classList.remove('hidden');
        codeDisplayElement.textContent = `Using code: ${code}`;
        codeDisplayElement.classList.remove('hidden');
        copyCodeButton.classList.remove('hidden');
        messages.classList.add('waiting');
        statusElement.textContent = 'Waiting for connection...';
        if (socket.readyState === WebSocket.OPEN) {
          log('info', 'WebSocket open, sending join after username input');
          socket.send(JSON.stringify({ type: 'join', code, clientId, username }));
        } else {
          log('info', 'WebSocket not open, waiting for open event after username');
          socket.addEventListener('open', () => {
            log('info', 'WebSocket opened in autoConnect join, sending join');
            socket.send(JSON.stringify({ type: 'join', code, clientId, username }));
          }, { once: true });
        }
        document.getElementById('messageInput')?.focus();
      };
    }
  } else {
    log('info', 'Invalid code, showing initial container');
    initialContainer.classList.remove('hidden');
    usernameContainer.classList.add('hidden');
    chatContainer.classList.add('hidden');
    showStatusMessage('Invalid code format. Please enter a valid code.');
    document.getElementById('connectToggleButton')?.focus();
  }
}
