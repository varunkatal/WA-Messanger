/**
 * Opened in a tab by the side panel: the side panel can't show Chrome's
 * "Allow microphone" prompt, but a normal tab can. The permission is per
 * extension, so once allowed here the side panel can record too.
 */
const status = document.getElementById('status');

async function askForMic() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop()); // only needed the permission
    status.className = 'ok';
    status.textContent = 'Microphone allowed. Go back to the side panel and tap 🎙 again. This tab will close by itself.';
    setTimeout(() => window.close(), 2500);
  } catch (err) {
    status.className = 'err';
    status.textContent =
      err.name === 'NotAllowedError'
        ? 'The microphone is blocked. Click the icon at the left of the address bar, set Microphone to Allow, then reload this tab. ' +
          'On a Mac also check System Settings → Privacy & Security → Microphone → Google Chrome is on.'
        : `Could not use the microphone: ${err.message}`;
  }
}

askForMic();
