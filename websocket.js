// websocket.js - WebSocket creation and message handlers

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
