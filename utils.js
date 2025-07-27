// utils.js
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
