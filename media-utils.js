// media-utils.js - Media recording utilities

import { showStatusMessage } from './utils.js';
import { sendMedia } from './main.js';

let mediaRecorder = null;
let voiceTimerInterval = null;

export function startVoiceRecording() {
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

export function stopVoiceRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
  }
}
