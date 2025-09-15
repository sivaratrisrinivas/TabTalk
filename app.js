// Affection - Refactored, lean, and clear
// Single module organizing WebRTC, audio processing, and UI helpers

// ----------------------------
// Global state and constants
// ----------------------------
const TURN_CONFIG = (() => {
    try {
        // Allow supplying TURN via window or localStorage (JSON)
        // Example: { urls: 'turns:turn.example.com:5349', username: 'user', credential: 'pass' }
        return window.AFFECTION_TURN || JSON.parse(localStorage.getItem('AFFECTION_TURN') || 'null');
    } catch (_) { return null; }
})();

const ICE_SERVERS = {
    iceServers: [
        { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
        ...(TURN_CONFIG ? [TURN_CONFIG] : [])
    ],
};

const AUDIO_CONSTRAINTS = {
    echoCancellation: { ideal: true },
    noiseSuppression: { ideal: true },
    autoGainControl: { ideal: false },
    channelCount: { ideal: 1 },
    sampleRate: { ideal: 48000 },
    sampleSize: { ideal: 16 },
};

const State = {
    pc: null,
    localStream: null,
    processedLocalAudioTrack: null,
    audioContext: null,
    remoteAudioConnected: false,
};

// DOM refs
const UI = {
    localVideo: document.getElementById('localVideo'),
    remoteVideo: document.getElementById('remoteVideo'),
    startButton: document.getElementById('startButton'),
    hangupButton: document.getElementById('hangupButton'),
    muteButton: document.getElementById('muteButton'),
    videoButton: document.getElementById('videoButton'),
    shareButton: document.getElementById('shareButton'),
    reconnectButton: document.getElementById('reconnectButton'),
    // UI chrome
    appTitle: document.getElementById('appTitle'),
    statusBadge: document.getElementById('statusBadge'),
    statusDot: document.getElementById('statusDot'),
    statusText: document.getElementById('statusText'),
    controls: document.getElementById('controls'),
    localCard: document.getElementById('localCard'),
    remoteCard: document.getElementById('remoteCard'),
    localVideoWrap: document.getElementById('localVideoWrap'),
    remoteVideoWrap: document.getElementById('remoteVideoWrap'),
    localHalo: document.getElementById('localHalo'),
    remoteHalo: document.getElementById('remoteHalo'),
    localShimmer: document.getElementById('localShimmer'),
    remoteShimmer: document.getElementById('remoteShimmer'),
};

// Rooms and Socket: always connect to signaling on :3000 (static can be anywhere)
const ROOM = (location.hash && location.hash.slice(1)) || 'main';
const socket = io('http://localhost:3000', { transports: ['websocket', 'polling'] });
try {
    console.log('[signal] page origin:', window.location.origin);
    console.log('[signal] socket manager opts:', socket && socket.io && socket.io.opts ? socket.io.opts : null);
} catch (_) {}

socket.on('connect', () => {
    console.log('Connected to signaling');
    setStatus('disconnected', 'Ready');
    try { socket.emit('join', ROOM); } catch (_) {}
});
socket.on('connect_error', (err) => {
    console.error('[signal] connect_error:', err && err.message ? err.message : err);
    try {
        console.warn('[signal] hint: if this page is served on a different port than the Node server, same-origin socket will 404');
        console.warn('[signal] current location:', window.location.href);
    } catch (_) {}
});

socket.on('message', async (message) => {
    try {
        switch (message.type) {
            case 'offer':
                await onOffer(message.offer);
                break;
            case 'answer':
                await onAnswer(message.answer);
                break;
            case 'candidate':
                await onCandidate(message.candidate);
                break;
        }
    } catch (e) {
        console.error('Signal handling error:', e);
        setStatus('disconnected', 'Call setup failed');
    }
});

// ----------------------------
// Core WebRTC flow
// ----------------------------
function createPeer() {
    const pc = new RTCPeerConnection(ICE_SERVERS);
    attachPeerHandlers(pc);
    return pc;
}

function attachPeerHandlers(pc) {
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('message', { room: ROOM, type: 'candidate', candidate: event.candidate });
        }
    };

    pc.ontrack = (event) => {
        UI.remoteVideo.srcObject = event.streams[0];
        try { if (event.track.kind === 'audio') { processRemoteAudio(event.streams[0]); } } catch (_) {}
        onRemoteConnected();
    };
}

async function prepareLocalMedia() {
    setStatus('connecting', 'Requesting media...');
    const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: AUDIO_CONSTRAINTS,
    });
    State.localStream = stream;
    UI.localVideo.srcObject = stream;
    revealVideo(UI.localShimmer);
    haloBurst(UI.localHalo);
    State.processedLocalAudioTrack = await buildLocalAudioChain(stream);
}

async function addLocalTracks(pc) {
    // Video
    State.localStream.getVideoTracks().forEach((track) => pc.addTrack(track, State.localStream));
    // Audio
    const processed = State.processedLocalAudioTrack;
    const rawAudio = State.localStream.getAudioTracks()[0];
    if (processed) pc.addTrack(processed, State.localStream);
    else if (rawAudio) pc.addTrack(rawAudio, State.localStream);
}

async function startCall() {
    try {
        ripple(UI.startButton);
        console.log('[call] startCall: begin');
        await prepareLocalMedia();
        State.pc = createPeer();
        await addLocalTracks(State.pc);

        setStatus('connecting', 'Creating offer...');
        console.log('[call] startCall: signalingState(before offer)=', State.pc.signalingState);
        const offer = await State.pc.createOffer();
        await State.pc.setLocalDescription(offer);
        console.log('[call] startCall: signalingState(after setLocalDescription)=', State.pc.signalingState);

        // Try configuring audio sender after local description is set (encodings should exist now)
        try {
            await configureAudioSender(State.pc);
        } catch (e) {
            console.warn('[audio] configureAudioSender post-offer threw', e);
        }

        setStatus('connecting', 'Calling...');
        socket.emit('message', { room: ROOM, type: 'offer', offer });
    } catch (e) {
        console.error('startCall failed', e);
        setStatus('disconnected', 'Permissions blocked');
    }
}

async function onOffer(offer) {
    setStatus('connecting', 'Incoming call...');
    console.log('[signal] onOffer: signalingState(before)=', State.pc ? State.pc.signalingState : '(no pc)');
    State.pc = createPeer();
    await State.pc.setRemoteDescription(new RTCSessionDescription(offer));
    console.log('[signal] onOffer: signalingState(after setRemote)=', State.pc.signalingState);

    await prepareLocalMedia();
    await addLocalTracks(State.pc);

    const answer = await State.pc.createAnswer();
    await State.pc.setLocalDescription(answer);
    console.log('[signal] onOffer: signalingState(after setLocal answer)=', State.pc.signalingState);

    // Configure audio sender after answer local description is set
    try {
        await configureAudioSender(State.pc);
    } catch (e) {
        console.warn('[audio] configureAudioSender post-answer threw', e);
    }
    socket.emit('message', { room: ROOM, type: 'answer', answer });
}

async function onAnswer(answer) {
    if (!State.pc) return;
    console.log('[signal] onAnswer: signalingState(before)=', State.pc.signalingState);
    if (State.pc.signalingState !== 'have-local-offer') {
        console.warn('[signal] onAnswer ignored; expected have-local-offer, got', State.pc.signalingState);
        return; // glare/late answer; ignore to avoid InvalidStateError
    }
    await State.pc.setRemoteDescription(new RTCSessionDescription(answer));
    console.log('[signal] onAnswer: signalingState(after setRemote)=', State.pc.signalingState);
}

async function onCandidate(candidate) {
    try {
        if (!State.pc) return;
        await State.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
        console.warn('addIceCandidate failed', e);
    }
}

function hangup() {
    try {
        if (State.pc) {
            State.pc.getSenders().forEach((sender) => { try { if (sender.track) sender.track.stop(); } catch(_) {} });
            State.pc.close();
            State.pc = null;
        }
        if (State.localStream) {
            State.localStream.getTracks().forEach((t) => { try { t.stop(); } catch(_) {} });
            State.localStream = null;
        }
        State.processedLocalAudioTrack = null;
        State.remoteAudioConnected = false;
        if (UI.localVideo) UI.localVideo.srcObject = null;
        if (UI.remoteVideo) UI.remoteVideo.srcObject = null;
        setGlowIntensity(0.0);
        setStatus('disconnected', 'Call ended');
        if (window.anime) {
            anime({ targets: [UI.localCard, UI.remoteCard], scale: [1.0, 0.995, 1.0], duration: 400, easing: 'easeInOutQuad' });
        }
    } catch (e) {
        console.error('hangup failed', e);
    }
}

// ----------------------------
// Audio processing
// ----------------------------
async function buildLocalAudioChain(stream) {
    try {
        if (!State.audioContext) {
            State.audioContext = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
        }
        const source = State.audioContext.createMediaStreamSource(new MediaStream([stream.getAudioTracks()[0]]));

        const highpass = State.audioContext.createBiquadFilter();
        highpass.type = 'highpass';
        highpass.frequency.value = 120;

        const presence = State.audioContext.createBiquadFilter();
        presence.type = 'peaking';
        presence.frequency.value = 2500;
        presence.Q.value = 1.0;
        presence.gain.value = 2.5;

        const highshelf = State.audioContext.createBiquadFilter();
        highshelf.type = 'highshelf';
        highshelf.frequency.value = 8000;
        highshelf.gain.value = -1.0;

        const compressor = State.audioContext.createDynamicsCompressor();
        compressor.threshold.value = -24;
        compressor.knee.value = 20;
        compressor.ratio.value = 3.5;
        compressor.attack.value = 0.003;
        compressor.release.value = 0.25;

        const dest = State.audioContext.createMediaStreamDestination();
        source.connect(highpass).connect(presence).connect(highshelf).connect(compressor).connect(dest);
        const track = dest.stream.getAudioTracks()[0];
        return track || null;
    } catch (e) {
        console.warn('Local audio chain failed, falling back to raw audio', e);
        return null;
    }
}

function processRemoteAudio(stream) {
    try {
        if (!State.audioContext) {
            State.audioContext = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
        }
        if (State.remoteAudioConnected) return;
        State.remoteAudioConnected = true;
        if (UI.remoteVideo) UI.remoteVideo.muted = true;

        const source = State.audioContext.createMediaStreamSource(new MediaStream([stream.getAudioTracks()[0]]));
        const highpass = State.audioContext.createBiquadFilter();
        highpass.type = 'highpass';
        highpass.frequency.value = 100;
        const highshelf = State.audioContext.createBiquadFilter();
        highshelf.type = 'highshelf';
        highshelf.frequency.value = 9000;
        highshelf.gain.value = -1.5;
        const compressor = State.audioContext.createDynamicsCompressor();
        compressor.threshold.value = -26;
        compressor.knee.value = 18;
        compressor.ratio.value = 2.5;
        compressor.attack.value = 0.005;
        compressor.release.value = 0.2;
        source.connect(highpass).connect(highshelf).connect(compressor).connect(State.audioContext.destination);
    } catch (e) {
        console.warn('Remote audio chain failed, using element audio', e);
        if (UI.remoteVideo) UI.remoteVideo.muted = false;
    }
}

async function configureAudioSender(pc) {
    try {
        const senders = pc.getSenders ? pc.getSenders() : [];
        const audioSender = senders.find((s) => s.track && s.track.kind === 'audio');
        if (!audioSender || !audioSender.getParameters) {
            console.warn('[audio] No audio sender or getParameters unsupported');
            return;
        }
        const current = audioSender.getParameters() || {};
        console.log('[audio] getParameters():', JSON.parse(JSON.stringify(current)));
        if (!current.encodings || current.encodings.length === 0) {
            console.warn('[audio] Skipping setParameters: no encodings present yet');
            return;
        }
        // Mutate the full parameters object to satisfy engines that expect all members (incl. codecs)
        current.encodings[0] = { ...(current.encodings[0] || {}), maxBitrate: 64000 };
        console.log('[audio] setParameters() with:', JSON.parse(JSON.stringify(current)));
        await audioSender.setParameters(current);
    } catch (e) {
        console.warn('Failed to set audio sender parameters', e);
    }
}

// ----------------------------
// UI helpers
// ----------------------------
function animateEntrance() {
    try {
        if (window.anime) {
            const tl = anime.timeline({ easing: 'easeOutQuad', duration: 500 });
            tl.add({ targets: UI.appTitle, opacity: [0, 1], translateY: [10, 0] })
              .add({ targets: UI.statusBadge, opacity: [0, 1], translateY: [-8, 0] }, '-=200')
              .add({ targets: [UI.localCard, UI.remoteCard], opacity: [0, 1], translateY: [8, 0], delay: anime.stagger(100) }, '-=150')
              .add({ targets: UI.controls, opacity: [0, 1], translateY: [8, 0] }, '-=200');
        } else {
            [UI.appTitle, UI.statusBadge, UI.localCard, UI.remoteCard, UI.controls].forEach((el) => { if (el) { el.style.opacity = 1; el.style.transform = 'none'; } });
        }
    } catch (_) {}
}

function setStatus(state, text) {
    const badge = UI.statusBadge;
    if (!badge) return;
    badge.classList.remove('connected', 'connecting', 'disconnected');
    if (state === 'connected') badge.classList.add('connected');
    if (state === 'connecting') badge.classList.add('connecting');
    if (state === 'disconnected') badge.classList.add('disconnected');
    if (typeof text === 'string') UI.statusText.textContent = text;
    if (window.anime) {
        anime({ targets: badge, opacity: 1, translateY: 0, duration: 300, easing: 'easeOutQuad' });
        pulseDot(state);
    }
}

function pulseDot(state) {
    const dot = UI.statusDot;
    if (!dot || !window.anime) return;
    anime.remove(dot);
    const colorScale = state === 'connected' ? 1 : state === 'connecting' ? 0.7 : 0.5;
    anime({
        targets: dot,
        scale: [1, 1.4, 1],
        boxShadow: [
            `0 0 0 0 rgba(99,102,241,0)`,
            `0 0 18px 6px rgba(99,102,241,${0.45 * colorScale})`,
            `0 0 0 0 rgba(99,102,241,0)`
        ],
        easing: 'easeInOutSine',
        duration: 1200,
        loop: state !== 'connected'
    });
}

function setGlowIntensity(intensity) {
    document.documentElement.style.setProperty('--glow', String(intensity));
}

function onRemoteConnected() {
    setStatus('connected', 'Connected');
    if (window.anime) {
        anime({ targets: UI.remoteVideoWrap, scale: [0.98, 1], duration: 350, easing: 'easeOutBack' });
        anime({ targets: document.documentElement, update: () => setGlowIntensity(0.35), duration: 0 });
        revealVideo(UI.remoteShimmer);
        haloBurst(UI.remoteHalo);
        anime({
            targets: document.documentElement,
            duration: 1600,
            easing: 'easeInOutSine',
            update: (anim) => {
                const t = anim.progress / 100;
                const value = 0.25 + Math.sin(t * Math.PI * 2) * 0.08;
                setGlowIntensity(value);
            },
            loop: 2
        });
    } else {
        setGlowIntensity(0.25);
    }
}

function addButtonInteractions(button) {
    if (!button) return;
    button.addEventListener('mousedown', () => { if (window.anime) anime({ targets: button, scale: 0.97, duration: 120, easing: 'easeOutQuad' }); });
    button.addEventListener('mouseup', () => { if (window.anime) anime({ targets: button, scale: 1.0, duration: 160, easing: 'easeOutQuad' }); });
    button.addEventListener('mouseleave', () => { if (window.anime) anime({ targets: button, scale: 1.0, duration: 160, easing: 'easeOutQuad' }); });
}

function ripple(button) {
    if (!button) return;
    const rect = button.getBoundingClientRect();
    const circle = document.createElement('span');
    const size = Math.max(rect.width, rect.height) * 2;
    circle.style.position = 'absolute';
    circle.style.left = `${rect.width / 2 - size / 2}px`;
    circle.style.top = `${rect.height / 2 - size / 2}px`;
    circle.style.width = circle.style.height = `${size}px`;
    circle.style.borderRadius = '50%';
    circle.style.pointerEvents = 'none';
    circle.style.background = 'radial-gradient(circle, rgba(255,255,255,0.45), rgba(255,255,255,0) 60%)';
    button.appendChild(circle);
    if (window.anime) {
        anime({ targets: circle, opacity: [0.6, 0], scale: [0.2, 1], duration: 600, easing: 'easeOutQuad', complete: () => circle.remove() });
    } else { setTimeout(() => circle.remove(), 600); }
}

function initShimmers() {
    if (!window.anime) return;
    [UI.localShimmer, UI.remoteShimmer].forEach((el) => {
        if (!el) return;
        el.style.opacity = 0.35;
        anime({ targets: el, backgroundPositionX: ['-150%', '150%'], duration: 1600, easing: 'linear', loop: true });
    });
}

function revealVideo(shimmerEl) {
    if (!shimmerEl) return;
    if (window.anime) {
        anime({ targets: shimmerEl, opacity: [0.35, 0], duration: 500, easing: 'easeOutQuad', complete: () => shimmerEl.style.display = 'none' });
    } else { shimmerEl.style.display = 'none'; }
}

function haloBurst(haloEl) {
    if (!haloEl || !window.anime) return;
    haloEl.style.opacity = 0.0;
    anime({ targets: haloEl, opacity: [0.0, 0.9, 0.0], scale: [0.9, 1.05, 1.0], duration: 800, easing: 'easeOutQuad' });
}

function initParallax() {
    window.addEventListener('mousemove', (e) => {
        const cx = window.innerWidth / 2;
        const cy = window.innerHeight / 2;
        const dx = (e.clientX - cx) / cx;
        const dy = (e.clientY - cy) / cy;
        if (window.anime) {
            anime({ targets: UI.localCard, translateX: dx * 4, translateY: dy * 4, duration: 200, easing: 'easeOutQuad' });
            anime({ targets: UI.remoteCard, translateX: -dx * 4, translateY: -dy * 4, duration: 200, easing: 'easeOutQuad' });
            anime({ targets: UI.appTitle, translateY: dy * -2, duration: 200, easing: 'easeOutQuad' });
        }
    });
}

function makeDraggable(draggableEl) {
    if (!draggableEl) return;
    let isDragging = false;
    let startX = 0, startY = 0;
    let originX = 0, originY = 0;

    const getBounds = () => {
        const elRect = draggableEl.getBoundingClientRect();
        const padding = 12;
        const maxX = window.innerWidth - elRect.width - padding;
        const maxY = window.innerHeight - elRect.height - padding;
        return { minX: padding, minY: padding, maxX, maxY };
    };

    const applyTransform = (x, y) => {
        draggableEl.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    };

    const onPointerDown = (e) => {
        isDragging = true;
        draggableEl.setPointerCapture(e.pointerId);
        startX = e.clientX; startY = e.clientY;
        const m = /translate3d\(([-0-9.]+)px, ([-0-9.]+)px/.exec(draggableEl.style.transform || '');
        originX = m ? parseFloat(m[1]) : 0;
        originY = m ? parseFloat(m[2]) : 0;
        if (window.anime) anime({ targets: draggableEl, scale: 1.02, duration: 120, easing: 'easeOutQuad' });
    };

    const onPointerMove = (e) => {
        if (!isDragging) return;
        const { minX, minY, maxX, maxY } = getBounds();
        const dx = e.clientX - startX; const dy = e.clientY - startY;
        let nextX = originX + dx; let nextY = originY + dy;
        nextX = Math.max(minX, Math.min(maxX, nextX));
        nextY = Math.max(minY, Math.min(maxY, nextY));
        applyTransform(nextX, nextY);
    };

    const onPointerUp = (e) => {
        if (!isDragging) return;
        isDragging = false;
        draggableEl.releasePointerCapture(e.pointerId);
        if (window.anime) anime({ targets: draggableEl, scale: 1.0, duration: 140, easing: 'easeOutQuad' });
    };

    draggableEl.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
}

// ----------------------------
// Init
// ----------------------------
function init() {
    animateEntrance();
    addButtonInteractions(UI.startButton);
    addButtonInteractions(UI.hangupButton);
    addButtonInteractions(UI.muteButton);
    addButtonInteractions(UI.videoButton);
    addButtonInteractions(UI.shareButton);
    addButtonInteractions(UI.reconnectButton);
    makeDraggable(UI.localVideoWrap);
    initShimmers();
    initParallax();

    UI.startButton.addEventListener('click', startCall);
    UI.hangupButton.addEventListener('click', hangup);
    if (UI.muteButton) UI.muteButton.addEventListener('click', () => {
        const t = State.localStream && State.localStream.getAudioTracks ? State.localStream.getAudioTracks()[0] : null;
        if (!t) return;
        t.enabled = !t.enabled;
        UI.muteButton.textContent = t.enabled ? 'Mute' : 'Unmute';
    });
    if (UI.videoButton) UI.videoButton.addEventListener('click', () => {
        const t = State.localStream && State.localStream.getVideoTracks ? State.localStream.getVideoTracks()[0] : null;
        if (!t) return;
        t.enabled = !t.enabled;
        UI.videoButton.textContent = t.enabled ? 'Video Off' : 'Video On';
    });
    if (UI.shareButton) UI.shareButton.addEventListener('click', async () => {
        try {
            const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
            const screenTrack = display.getVideoTracks()[0];
            const sender = State.pc && State.pc.getSenders ? State.pc.getSenders().find(s => s.track && s.track.kind === 'video') : null;
            if (sender) await sender.replaceTrack(screenTrack);
            screenTrack.onended = async () => {
                const cam = State.localStream && State.localStream.getVideoTracks ? State.localStream.getVideoTracks()[0] : null;
                if (cam && sender) await sender.replaceTrack(cam);
            };
        } catch (e) {
            console.warn('Screen share canceled/failed', e);
        }
    });
    if (UI.reconnectButton) UI.reconnectButton.addEventListener('click', async () => {
        if (!State.pc) return;
        try {
            await State.pc.restartIce();
            setStatus('connecting', 'Re-negotiating…');
            const offer = await State.pc.createOffer({ iceRestart: true });
            await State.pc.setLocalDescription(offer);
            socket.emit('message', { room: ROOM, type: 'offer', offer });
        } catch (e) {
            console.error('ICE restart failed', e);
        }
    });
}

init();


