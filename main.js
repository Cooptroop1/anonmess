// Core logic: peer connections, message sending, handling offers, etc.
// Global vars for dynamic TURN creds from server
let turnUsername = '';
let turnCredential = '';
let localStream = null;
let voiceCallActive = false;
let remoteAudios = new Map();
let signalingQueue = new Map(); // Map of targetId to array of pending messages

async function sendMedia(file, type) {
    const validTypes = {
        image: ['image/jpeg', 'image/png'],
        voice: ['audio/webm', 'audio/ogg']
    };
    // Check if feature is enabled before proceeding
    if ((type === 'image' && !features.enableImages) || (type === 'voice' && !features.enableVoice)) {
        showStatusMessage(`Error: ${type.charAt(0).toUpperCase() + type.slice(1)} messages are disabled by admin.`);
        document.getElementById(`${type}Button`)?.focus();
        return;
    }
    if (!file || !validTypes[type].includes(file.type) || !username || dataChannels.size === 0) {
        showStatusMessage(`Error: Select a ${type === 'image' ? 'JPEG/PNG image' : 'valid audio format'} and ensure you are connected.`);
        document.getElementById(`${type}Button`)?.focus();
        return;
    }
    if (file.size > 5 * 1024 * 1024) {
        showStatusMessage(`Error: ${type === 'image' ? 'Image' : 'Audio'} size exceeds 5MB limit.`);
        document.getElementById(`${type}Button`)?.focus();
        return;
    }
    // Rate limiting
    const rateLimits = type === 'image' ? imageRateLimits : voiceRateLimits;
    const now = performance.now();
    const rateLimit = rateLimits.get(clientId) || { count: 0, startTime: now };
    if (now - rateLimit.startTime >= 60000) {
        rateLimit.count = 0;
        rateLimit.startTime = now;
    }
    rateLimit.count += 1;
    rateLimits.set(clientId, rateLimit);
    if (rateLimit.count > 5) {
        showStatusMessage(`${type === 'image' ? 'Image' : 'Voice'} rate limit reached (5/min). Please wait.`);
        document.getElementById(`${type}Button`)?.focus();
        return;
    }
    let base64;
    if (type === 'image') {
        const maxWidth = 640;
        const maxHeight = 360;
        let quality = 0.4;
        if (file.size > 3 * 1024 * 1024) {
            quality = 0.3;
        } else if (file.size > 1 * 1024 * 1024) {
            quality = 0.35;
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
        base64 = canvas.toDataURL('image/jpeg', quality);
        URL.revokeObjectURL(img.src);
    } else {
        const mp3Blob = await encodeAudioToMp3(file);
        base64 = await new Promise(resolve => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.readAsDataURL(mp3Blob);
        });
    }
    const messageId = generateMessageId();
    const timestamp = Date.now();
    const payload = { messageId, type, data: base64, username, timestamp };
    const jsonString = JSON.stringify(payload);
    if (useRelay) {
        if (!roomKey) {
            showStatusMessage('Error: Encryption key not available for relay mode.');
            return;
        }
        const { encrypted, iv } = await encrypt(jsonString);
        if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: `relay-${type}`, code, clientId, token, encryptedData: encrypted, iv }));
        }
    } else if (dataChannels.size > 0) {
        dataChannels.forEach((dataChannel) => {
            if (dataChannel.readyState === 'open') {
                dataChannel.send(jsonString);
            }
        });
    } else {
        showStatusMessage('Error: No connections.');
        return;
    }
    // Display locally
    const messages = document.getElementById('messages');
    const messageDiv = document.createElement('div');
    messageDiv.className = 'message-bubble self';
    const timeSpan = document.createElement('span');
    timeSpan.className = 'timestamp';
    timeSpan.textContent = new Date(timestamp).toLocaleTimeString();
    messageDiv.appendChild(timeSpan);
    messageDiv.appendChild(document.createTextNode(`${username}: `));
    if (type === 'image') {
        const imgElement = document.createElement('img');
        imgElement.src = base64;
        imgElement.style.maxWidth = '100%';
        imgElement.style.borderRadius = '0.5rem';
        imgElement.style.cursor = 'pointer';
        imgElement.setAttribute('alt', 'Sent image');
        imgElement.addEventListener('click', () => createImageModal(base64, `${type}Button`));
        messageDiv.appendChild(imgElement);
    } else {
        const audioElement = document.createElement('audio');
        audioElement.src = base64;
        audioElement.controls = true;
        audioElement.setAttribute('alt', 'Sent voice message');
        audioElement.addEventListener('click', () => createAudioModal(base64, `${type}Button`));
        messageDiv.appendChild(audioElement);
    }
    messages.prepend(messageDiv);
    messages.scrollTop = 0;
    processedMessageIds.add(messageId);
    document.getElementById(`${type}Button`)?.focus();
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
            sendSignalingMessage('candidate', { candidate: event.candidate, targetId });
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
            const privacyStatus = document.getElementById('privacyStatus');
            if (privacyStatus) {
                privacyStatus.textContent = 'E2E Encrypted (P2P)';
                privacyStatus.classList.remove('hidden');
            }
        }
    };
    peerConnection.ontrack = (event) => {
        console.log(`Received remote track from ${targetId}`);
        if (!remoteAudios.has(targetId)) {
            const audio = document.createElement('audio');
            audio.srcObject = event.streams[0];
            audio.autoplay = true;
            audio.play().catch(error => console.error('Error playing remote audio:', error));
            remoteAudios.set(targetId, audio);
            document.getElementById('remoteAudioContainer').appendChild(audio);
            document.getElementById('remoteAudioContainer').classList.remove('hidden');
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
            sendSignalingMessage('offer', { offer: peerConnection.localDescription, targetId });
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
            const privacyStatus = document.getElementById('privacyStatus');
            if (privacyStatus) {
                privacyStatus.textContent = 'Relay Mode: E2E Encrypted';
                privacyStatus.classList.remove('hidden');
            }
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
    dataChannel.onmessage = async (event) => {
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
        if (!data.messageId || !data.username || (!data.content && !data.data)) {
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
            img.addEventListener('click', () => createImageModal(data.data, 'messageInput'));
            messageDiv.appendChild(img);
        } else if (data.type === 'voice') {
            const audio = document.createElement('audio');
            audio.src = data.data;
            audio.controls = true;
            audio.setAttribute('alt', 'Received voice message');
            audio.addEventListener('click', () => createAudioModal(data.data, 'messageInput'));
            messageDiv.appendChild(audio);
        } else {
            messageDiv.appendChild(document.createTextNode(sanitizeMessage(data.content)));
        }
        messages.prepend(messageDiv);
        messages.scrollTop = 0;
        if (isInitiator) {
            dataChannels.forEach((dc, id) => {
                if (id !== targetId && dc.readyState === 'open') {
                    dc.send(event.data); // Forward the original data (unencrypted in P2P)
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
        voiceRateLimits.delete(targetId);
        if (remoteAudios.has(targetId)) {
            const audio = remoteAudios.get(targetId);
            audio.remove();
            remoteAudios.delete(targetId);
            if (remoteAudios.size === 0) {
                document.getElementById('remoteAudioContainer').classList.add('hidden');
            }
        }
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
        sendSignalingMessage('answer', { answer: peerConnection.localDescription, targetId });
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
async function sendMessage(content) {
    if (content && dataChannels.size > 0 && username) {
        const messageId = generateMessageId();
        const sanitizedContent = sanitizeMessage(content);
        const timestamp = Date.now();
        const payload = { messageId, content: sanitizedContent, username, timestamp };
        const jsonString = JSON.stringify(payload);
        if (useRelay) {
            if (!roomKey) {
                showStatusMessage('Error: Encryption key not available for relay mode.');
                return;
            }
            const { encrypted, iv } = await encrypt(jsonString);
            if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: 'relay-message', code, clientId, token, encryptedContent: encrypted, iv }));
            }
        } else {
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
        messages.scrollTop = 0;
        processedMessageIds.add(messageId);
        const messageInput = document.getElementById('messageInput');
        messageInput.value = '';
        messageInput.style.height = '2.5rem';
        messageInput?.focus();
    } else {
        showStatusMessage('Error: No connections or username not set.');
        document.getElementById('messageInput')?.focus();
    }
}
async function toggleVoiceCall() {
    if (!features.enableVoiceCalls) {
        showStatusMessage('Voice calls are disabled by admin.');
        return;
    }
    if (voiceCallActive) {
        stopVoiceCall();
    } else {
        startVoiceCall();
    }
}
async function startVoiceCall() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        showStatusMessage('Microphone not supported.');
        return;
    }
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        peerConnections.forEach((peerConnection, targetId) => {
            localStream.getTracks().forEach(track => {
                peerConnection.addTrack(track, localStream);
            });
            renegotiate(targetId);
        });
        voiceCallActive = true;
        document.getElementById('voiceCallButton').classList.add('active');
        document.getElementById('voiceCallButton').title = 'End Voice Call';
        showStatusMessage('Voice call started.');
    } catch (error) {
        console.error('Error starting voice call:', error);
        showStatusMessage('Failed to access microphone for voice call.');
    }
}
function stopVoiceCall() {
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    peerConnections.forEach((peerConnection, targetId) => {
        peerConnection.getSenders().forEach(sender => {
            if (sender.track && sender.track.kind === 'audio') {
                peerConnection.removeTrack(sender);
            }
        });
        renegotiate(targetId);
    });
    voiceCallActive = false;
    document.getElementById('voiceCallButton').classList.remove('active');
    document.getElementById('voiceCallButton').title = 'Start Voice Call';
    showStatusMessage('Voice call ended.');
}
async function renegotiate(targetId) {
    const peerConnection = peerConnections.get(targetId);
    if (peerConnection && peerConnection.signalingState === 'stable') {
        try {
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            sendSignalingMessage('offer', { offer: peerConnection.localDescription, targetId });
        } catch (error) {
            console.error(`Error renegotiating with ${targetId}:`, error);
            showStatusMessage('Failed to renegotiate peer connection.');
        }
    }
}
function sendSignalingMessage(type, additionalData) {
    if (!token) {
        console.log('No token, refreshing and queuing signaling message');
        refreshAccessToken();
        if (!signalingQueue.has('global')) signalingQueue.set('global', []);
        signalingQueue.get('global').push({ type, additionalData });
        return;
    }
    const message = { type, ...additionalData, code, clientId, token };
    if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message));
    } else {
        console.log('Socket not open, queuing signaling message');
        if (!signalingQueue.has('global')) signalingQueue.set('global', []);
        signalingQueue.get('global').push({ type, additionalData });
    }
}
function processSignalingQueue() {
    signalingQueue.forEach((queue, key) => {
        while (queue.length > 0) {
            const { type, additionalData } = queue.shift();
            sendSignalingMessage(type, additionalData);
        }
    });
    signalingQueue.clear();
}
async function autoConnect(codeParam) {
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
                socket.send(JSON.stringify({ type: 'join', code, clientId, username, token }));
            } else {
                console.log('WebSocket not open, waiting for open event');
                socket.addEventListener('open', () => {
                    console.log('WebSocket opened in autoConnect, sending join');
                    socket.send(JSON.stringify({ type: 'join', code, clientId, username, token }));
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
                    socket.send(JSON.stringify({ type: 'join', code, clientId, username, token }));
                } else {
                    console.log('WebSocket not open, waiting for open event after username');
                    socket.addEventListener('open', () => {
                        console.log('WebSocket opened in autoConnect join, sending join');
                        socket.send(JSON.stringify({ type: 'join', code, clientId, username, token }));
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
// New: Function to update UI based on features
function updateFeaturesUI() {
    const imageButton = document.getElementById('imageButton');
    const voiceButton = document.getElementById('voiceButton');
    const voiceCallButton = document.getElementById('voiceCallButton');
    if (imageButton) {
        imageButton.disabled = !features.enableImages;
        imageButton.style.opacity = features.enableImages ? 1 : 0.5; // Gray out visually
        imageButton.title = features.enableImages ? 'Send Image' : 'Images disabled by admin';
    }
    if (voiceButton) {
        voiceButton.disabled = !features.enableVoice;
        voiceButton.style.opacity = features.enableVoice ? 1 : 0.5; // Gray out visually
        voiceButton.title = features.enableVoice ? 'Record Voice' : 'Voice disabled by admin';
    }
    if (voiceCallButton) {
        voiceCallButton.disabled = !features.enableVoiceCalls;
        voiceCallButton.style.opacity = features.enableVoiceCalls ? 1 : 0.5;
        voiceCallButton.title = features.enableVoiceCalls ? 'Start Voice Call' : 'Voice calls disabled by admin';
    }
    if (!features.enableService) {
        showStatusMessage('Service disabled by admin. Disconnecting...');
        socket.close();
    }
}
