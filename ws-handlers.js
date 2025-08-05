// ws-handlers.js - WebSocket creation and event handlers

import {
  code, clientId, username, isInitiator, isConnected, maxClients, totalClients,
  peerConnections, dataChannels, connectionTimeouts, retryCounts, candidatesQueues,
  processedMessageIds, usernames, useRelay, token, refreshToken, features, keyPair,
  roomKey, remoteAudios, refreshingToken, signalingQueue, reconnectAttempts,
  imageRateLimits, voiceRateLimits, globalMessageRate
} from './state.js';
import { showStatusMessage, startKeepAlive, stopKeepAlive, cleanupPeerConnection, initializeMaxClientsUI, updateMaxClientsUI, updateFeaturesUI, createImageModal, createAudioModal, sanitizeMessage } from './utils.js';
import { sendMedia, startPeerConnection, handleOffer, handleAnswer, handleCandidate, renegotiate, sendMessage, stopVoiceCall, processSignalingQueue, autoConnect } from './main.js';
import { refreshAccessToken } from './ui-events.js'; // If needed, but looks like it's in main or utils

export let socket = new WebSocket('wss://signaling-server-zc6m.onrender.com');
console.log('WebSocket created');

const maxReconnectAttempts = 5;

socket.onopen = () => {
  console.log('WebSocket opened');
  socket.send(JSON.stringify({ type: 'connect', clientId }));
  startKeepAlive();
  reconnectAttempts = 0;
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
    socket.onopen = socket.onopen;
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
      setTimeout(refreshAccessToken, 5 * 60 * 1000);
      if (pendingCode) {
        autoConnect(pendingCode);
        pendingCode = null;
      }
      if (pendingJoin) {
        socket.send(JSON.stringify({ type: 'join', ...pendingJoin, token }));
        pendingJoin = null;
      }
      processSignalingQueue();
      return;
    }
    if (message.type === 'token-refreshed') {
      token = message.accessToken;
      refreshToken = message.refreshToken;
      console.log('Received new tokens:', { accessToken: token, refreshToken });
      showStatusMessage('Authentication tokens refreshed.');
      setTimeout(refreshAccessToken, 5 * 60 * 1000);
      if (pendingJoin) {
        socket.send(JSON.stringify({ type: 'join', ...pendingJoin, token }));
        pendingJoin = null;
      }
      processSignalingQueue();
      refreshingToken = false;
      return;
    }
    if (message.type === 'error') {
      console.error('Server error:', message.message);
      if (message.message.includes('Invalid or expired token') || message.message.includes('Missing authentication token')) {
        if (refreshToken && !refreshingToken) {
          refreshingToken = true;
          console.log('Attempting to refresh token');
          socket.send(JSON.stringify({ type: 'refresh-token', clientId, refreshToken }));
        } else {
          console.error('No refresh token available or refresh in progress, forcing reconnect');
          stopKeepAlive();
          socket.close();
        }
      } else if (message.message.includes('Token revoked') || message.message.includes('Invalid or expired refresh token')) {
        showStatusMessage('Session expired. Reconnecting...');
        stopKeepAlive();
        token = '';
        refreshToken = '';
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
        token = '';
        refreshToken = '';
        showStatusMessage(message.message);
      } else {
        showStatusMessage(message.message);
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
      if (voiceCallActive) {
        renegotiate(message.clientId);
      }
    }
    if (message.type === 'client-disconnected') {
      totalClients = message.totalClients;
      console.log(`Client ${message.clientId} disconnected from code: ${code}, total: ${totalClients}`);
      usernames.delete(message.clientId);
      cleanupPeerConnection(message.clientId);
      if (remoteAudios.has(message.clientId)) {
        const audio = remoteAudios.get(message.clientId);
        audio.remove();
        remoteAudios.delete(message.clientId);
        if (remoteAudios.size === 0) {
          document.getElementById('remoteAudioContainer').classList.add('hidden');
        }
      }
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
        token = '';
        refreshToken = '';
        socket.close();
      }
    }
  }
};
