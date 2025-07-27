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
      document.getElementById('imageButton')?.focus();
    });
    modal.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        modal.classList.remove('active');
        document.getElementById('imageButton')?.focus();
      }
    });
  });
  messageDiv.appendChild(imgElement);
  messages.appendChild(messageDiv);
  messages.scrollTop = messages.scrollHeight;
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
      messageDiv.appendChild(document.createTextNode(sanitizeMessage(data.content)));
    }
    messages.appendChild(messageDiv);
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
      document.getElementById('messageInput')?.focus();
    } else {
      console.log('No valid username, prompting for username');
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
        document.getElementById('messageInput')?.focus();
      };
    }
  } else {
    console.log('Invalid code, showing initial container');
    initialContainer.classList.remove('hidden');
    usernameContainer.classList.add('hidden');
    chatContainer.classList.add('hidden');
    showStatusMessage('Invalid code format. Please enter a valid code.');
    document.getElementById('connectToggleButton')?.focus();
  }
}
