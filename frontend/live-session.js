// SkillSwap Live Skill Session Client Logic (Socket.IO + WebRTC + Session Live Chat)

let socket = null;
let currentUser = null;
let authToken = null;
let sessionId = null;
let sessionData = null;
let partnerUser = null;
let isHostUser = false;

let localStream = null;
let peerConnection = null;
let screenStream = null;
let isScreenSharing = false;

let isAudioMuted = false;
let isVideoStopped = false;
let hasExplicitlyLeft = false;
let isSessionEnded = false;

let timerInterval = null;
let timerSeconds = 0;
let iceCandidatesQueue = [];
let typingTimeout = null;
let unreadChatCount = 0;

// WebRTC Perfect Negotiation & ICE recovery state
let makingOffer = false;
let ignoreOffer = false;
let isSettingRemoteAnswerPending = false;
let ctrlDataChannel = null;
let remoteMediaStream = null;
let remoteCameraMuted = false;
let isPartnerOnline = false;
let iceRetryCount = 0;
let iceRetryTimer = null;
let disconnectedDebounceTimer = null;
let hasWebRTCExhaustedRetries = false;
const MAX_ICE_RETRIES = 3;

// Chat deduplication & pending delivery tracking
const renderedMessageIds = new Set();
const pendingMessageMap = new Map(); // clientMessageId -> { el, text, clientMessageId, timerId }

// Dynamic ICE servers (populated from GET /api/live-sessions/ice-servers with STUN fallback)
const DEFAULT_ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" }
];

let rtcConfig = {
    iceServers: DEFAULT_ICE_SERVERS,
    iceCandidatePoolSize: 10
};

async function loadIceServers() {
    try {
        const res = await fetch("/api/live-sessions/ice-servers", {
            headers: { "Authorization": `Bearer ${authToken}` }
        });
        if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data.iceServers) && data.iceServers.length > 0) {
                rtcConfig = {
                    iceServers: data.iceServers,
                    iceCandidatePoolSize: 10
                };
            }
        }
    } catch (err) {
        console.warn("Could not fetch custom ICE servers, using default STUN:", err.message);
    }
}

function extractId(val) {
    if (!val) return "";
    if (typeof val === "object" && val._id) return String(val._id);
    return String(val);
}

document.addEventListener("DOMContentLoaded", async () => {
    // 1. Validate Authentication
    const userStr = localStorage.getItem("currentUser");
    authToken = localStorage.getItem("token");

    if (!userStr || !authToken) {
        showAlert("Please login to join the Live Skill Session.", "error");
        setTimeout(() => { window.location.href = "login.html"; }, 1200);
        return;
    }

    try {
        currentUser = JSON.parse(userStr);
    } catch {
        window.location.href = "login.html";
        return;
    }

    // 2. Validate Session ID in URL parameters
    const params = new URLSearchParams(window.location.search);
    sessionId = params.get("sessionId");

    if (!sessionId) {
        showAlert("Session ID is missing from the URL.", "error");
        setTimeout(() => { window.location.href = "connections.html"; }, 1500);
        return;
    }

    const shortIdEl = document.getElementById("session-id-short");
    if (shortIdEl) {
        shortIdEl.textContent = sessionId.slice(-8);
    }

    // 3. Setup UI Controls
    setupControlButtons();

    // 4. Authorize & load session details + ICE configuration
    const authorized = await loadSessionDetails();
    if (!authorized) return;

    await loadIceServers();

    // 5. Connect to Socket.IO room & load session chat history FIRST (never block chat/presence on camera/mic!)
    initSignalingSocket();
    await loadSessionMessages();

    // 6. Request Camera & Microphone gracefully (chat & session remain active even if camera/mic unavailable)
    await initLocalMedia({ showModalOnFailure: true });
});

// Load & authorize session details via POST /api/live-sessions/:id/join
async function loadSessionDetails() {
    try {
        updateConnStatus("Verifying session...", "connecting");

        const response = await fetch(`/api/live-sessions/${encodeURIComponent(sessionId)}/join`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${authToken}`,
                "Content-Type": "application/json"
            }
        });

        const payload = await response.json().catch(() => ({}));

        if (response.status === 401) {
            showAlert("Your login session has expired. Redirecting to login...", "error");
            localStorage.removeItem("token");
            setTimeout(() => { window.location.href = "login.html"; }, 1500);
            return false;
        }

        if (response.status === 403) {
            showAlert(payload.message || "Unauthorized: You do not belong to this live session.", "error");
            setTimeout(() => { window.location.href = "connections.html"; }, 2200);
            return false;
        }

        if (response.status === 400 && payload.session && payload.session.status === "completed") {
            sessionData = payload.session;
            hydrateSessionParticipantsUI();
            isSessionEnded = true;
            showSessionEndedModal("This live session has already concluded.");
            return false;
        }

        if (!response.ok || !payload.session) {
            throw new Error(payload.message || "Live session not found");
        }

        sessionData = payload.session;
        hydrateSessionParticipantsUI();

        if (Array.isArray(payload.participants)) {
            renderParticipantsBar(payload.participants);
        }

        // Check and render AI Learning Impact baseline pre-assessment
        if (typeof checkLiveSessionImpact === "function") {
            checkLiveSessionImpact(sessionId);
        }

        return true;
    } catch (err) {
        console.error("Error loading session:", err);
        showAlert("Failed to load session details: " + err.message, "error");
        setTimeout(() => { window.location.href = "connections.html"; }, 3000);
        return false;
    }
}

function hydrateSessionParticipantsUI() {
    if (!sessionData || !currentUser) return;
    const myId = extractId(currentUser._id);
    const hostId = extractId(sessionData.host);
    isHostUser = hostId === myId;
    partnerUser = isHostUser ? sessionData.participant : sessionData.host;

    const myTeach = (currentUser.teachSkills || []).slice(0, 2).join(", ");
    const partnerTeach = (partnerUser?.teachSkills || []).slice(0, 2).join(", ");
    const topicText = sessionData.skillTopic
        ? `${sessionData.skillTopic} • ${partnerUser?.name || "Partner"} ⇄ ${currentUser.name}`
        : `${partnerUser?.name || "Partner"} (${partnerTeach || "Skills"}) ⇄ ${currentUser.name} (${myTeach || "Skills"})`;

    document.getElementById("session-topic").textContent = topicText;

    document.getElementById("local-name").textContent = `${currentUser.name} (You)`;
    document.getElementById("local-label-name").textContent = `${currentUser.name} (You)`;
    document.getElementById("local-avatar").textContent = getInitials(currentUser.name);

    const pName = partnerUser?.name || "Skill Partner";
    document.getElementById("remote-name").textContent = pName;
    document.getElementById("remote-label-name").textContent = pName;
    document.getElementById("remote-avatar").textContent = getInitials(pName);
    document.getElementById("remote-status-msg").textContent = `Waiting for ${pName} to join...`;

    const subtitle = document.getElementById("drawer-chat-subtitle");
    if (subtitle) {
        subtitle.textContent = `Session chat with ${pName}`;
    }

    // Update Dock End/Leave button according to host authority
    const endBtn = document.getElementById("btn-end-call");
    const endLabel = document.getElementById("btn-end-call-label");
    if (endBtn && endLabel) {
        if (isHostUser) {
            endLabel.textContent = "End Session";
            endBtn.title = "End Live Session for Everyone";
        } else {
            endLabel.textContent = "Leave Call";
            endBtn.title = "Leave Live Session";
        }
    }
}

// Request camera and microphone access without blocking session room/chat
async function initLocalMedia({ showModalOnFailure = false } = {}) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setMediaUnavailableState("Browser media devices unavailable — Live Chat active");
        return false;
    }

    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: {
                width: { ideal: 1280 },
                height: { ideal: 720 },
                facingMode: "user"
            },
            audio: {
                echoCancellation: true,
                noiseSuppression: true
            }
        });

        localStream = stream;
        const localVideo = document.getElementById("local-video");
        localVideo.srcObject = stream;
        document.getElementById("local-placeholder").classList.add("hidden");
        document.getElementById("permission-modal").classList.add("hidden");

        // Attach tracks to active peerConnection and renegotiate cleanly if already initialized
        if (peerConnection) {
            await attachLocalMediaTracksToPeer(localStream);
        }

        // Sync initial button icons back to active state
        isAudioMuted = false;
        isVideoStopped = false;
        const btnMic = document.getElementById("btn-toggle-mic");
        const btnCam = document.getElementById("btn-toggle-cam");
        if (btnMic) {
            btnMic.classList.add("active");
            btnMic.classList.remove("muted");
            const icon = btnMic.querySelector(".btn-icon");
            if (icon) icon.textContent = "🎤";
            const label = document.getElementById("label-mic");
            if (label) label.textContent = "Mute";
        }
        if (btnCam) {
            btnCam.classList.add("active");
            btnCam.classList.remove("muted");
            const icon = btnCam.querySelector(".btn-icon");
            if (icon) icon.textContent = "📷";
            const label = document.getElementById("label-cam");
            if (label) label.textContent = "Stop Video";
        }

        return true;
    } catch (err) {
        console.warn("Camera/microphone not acquired (chat-only mode enabled):", err.name, err.message);
        setMediaUnavailableState("Camera/Mic off — Live Chat active");
        if (showModalOnFailure) {
            const desc = document.getElementById("permission-modal-desc");
            if (desc) {
                desc.textContent = `Could not access camera/microphone (${err.message || err.name}). You can retry permissions or continue in real-time chat mode.`;
            }
            document.getElementById("permission-modal").classList.remove("hidden");
        }
        return false;
    }
}

async function attachLocalMediaTracksToPeer(stream) {
    if (!peerConnection || !stream) return;

    let needsRenegotiation = false;
    const transceivers = peerConnection.getTransceivers ? peerConnection.getTransceivers() : [];

    for (const track of stream.getTracks()) {
        const matchingTransceiver = transceivers.find(t =>
            t.sender && (
                (t.sender.track && t.sender.track.kind === track.kind) ||
                (t.receiver && t.receiver.track && t.receiver.track.kind === track.kind)
            )
        );

        if (matchingTransceiver && matchingTransceiver.sender) {
            await matchingTransceiver.sender.replaceTrack(track);
            if (matchingTransceiver.direction === "recvonly") {
                matchingTransceiver.direction = "sendrecv";
                needsRenegotiation = true;
            } else if (matchingTransceiver.direction === "inactive") {
                matchingTransceiver.direction = "sendonly";
                needsRenegotiation = true;
            }
        } else {
            peerConnection.addTrack(track, stream);
            needsRenegotiation = true;
        }
    }

    if (needsRenegotiation && isPartnerOnline) {
        await sendWebRTCOffer(partnerUser?.name || "Partner");
    }
}

function setMediaUnavailableState(statusText) {
    const localPlaceholder = document.getElementById("local-placeholder");
    const localPlaceholderStatus = document.getElementById("local-placeholder-status");
    const localCamStatus = document.getElementById("local-cam-status");
    const localMicStatus = document.getElementById("local-mic-status");
    const btnMic = document.getElementById("btn-toggle-mic");
    const btnCam = document.getElementById("btn-toggle-cam");

    if (localPlaceholder) localPlaceholder.classList.remove("hidden");
    if (localPlaceholderStatus) localPlaceholderStatus.textContent = statusText || "Camera is off";
    if (localCamStatus) localCamStatus.textContent = "🚫";
    if (localMicStatus) localMicStatus.textContent = "🔇";
    if (btnMic) {
        btnMic.classList.remove("active");
        btnMic.classList.add("muted");
    }
    if (btnCam) {
        btnCam.classList.remove("active");
        btnCam.classList.add("muted");
    }
}

// Setup Socket.IO signaling & session room connection
function initSignalingSocket() {
    updateConnStatus("Connecting to live server...", "connecting");

    socket = io("", {
        auth: { token: authToken },
        transports: ["websocket", "polling"],
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000
    });

    socket.on("connect", () => {
        console.log("🟢 Connected to Socket.IO as:", currentUser.name);
        if (hasExplicitlyLeft || isSessionEnded) return;

        updateConnStatus("Joining live room...", "connecting");
        joinRoomAndSync();
    });

    socket.on("reconnect", async () => {
        console.log("🔄 Socket reconnected; re-syncing session state & chat history");
        hideAlert();
        if (!hasExplicitlyLeft && !isSessionEnded) {
            await loadSessionMessages();
        }
    });

    socket.on("disconnect", (reason) => {
        console.warn("⚠️ Signaling socket disconnected:", reason);
        if (!hasExplicitlyLeft && !isSessionEnded) {
            updateConnStatus("Disconnected • Reconnecting...", "error");
            showAlert("Connection interrupted. Attempting to reconnect automatically...", "warning");
        }
    });

    socket.on("connect_error", (err) => {
        console.warn("Signaling socket error:", err.message);
        updateConnStatus("Connection error", "error");
        if (err.message && err.message.toLowerCase().includes("authentication")) {
            showAlert("Authentication expired or invalid. Please log in again.", "error");
            setTimeout(() => { window.location.href = "login.html"; }, 1800);
        } else {
            showAlert("Real-time connection error: " + err.message, "warning");
        }
    });

    // Authoritative participant list updates
    socket.on("sessionParticipantsUpdated", ({ sessionId: evtSessionId, participants }) => {
        if (evtSessionId && String(evtSessionId) !== String(sessionId)) return;
        renderParticipantsBar(participants || []);
    });

    // Remote peer joined: reset stale PeerConnection and initiate Perfect Negotiation cleanly
    socket.on("sessionUserJoined", async ({ sessionId: evtSessionId, userId, userName, reconnected }) => {
        if (evtSessionId && String(evtSessionId) !== String(sessionId)) return;
        if (extractId(userId) === extractId(currentUser._id)) return;

        console.log("👋 Peer joined session:", userName, userId, reconnected ? "(reconnected)" : "");
        isPartnerOnline = true;
        hasWebRTCExhaustedRetries = false;
        iceRetryCount = 0;

        const retryBtn = document.getElementById("btn-retry-webrtc");
        if (retryBtn) retryBtn.classList.add("hidden");

        updateConnStatus(`${userName} joined`, "connected");
        document.getElementById("remote-status-msg").textContent = localStream
            ? `Connecting video/audio with ${userName}...`
            : `${userName} is online • Connecting session...`;
        document.getElementById("remote-spinner")?.classList.remove("hidden");
        startTimer();

        // Always reset PeerConnection if partner joined/reconnected cleanly
        resetPeerConnection();
        initPeerConnection();

        if (isHostUser) {
            await sendWebRTCOffer(userName);
        }
    });

    // Partner requested ICE/WebRTC reconnect
    socket.on("webrtcRequestReconnect", async ({ sessionId: evtSessionId, senderId, senderName }) => {
        if (evtSessionId && String(evtSessionId) !== String(sessionId)) return;
        if (extractId(senderId) === extractId(currentUser._id)) return;

        console.log("🔄 Partner requested WebRTC reconnect:", senderName);
        hasWebRTCExhaustedRetries = false;
        iceRetryCount = 0;
        const retryBtn = document.getElementById("btn-retry-webrtc");
        if (retryBtn) retryBtn.classList.add("hidden");
        document.getElementById("remote-spinner")?.classList.remove("hidden");
        document.getElementById("remote-status-msg").textContent = `Reconnecting media with ${senderName || "Partner"}...`;

        resetPeerConnection();
        initPeerConnection();

        if (isHostUser) {
            await sendWebRTCOffer(senderName || "Partner", { iceRestart: true });
        }
    });

    // Received WebRTC Offer (Perfect Negotiation)
    socket.on("webrtcOffer", async ({ sessionId: evtSessionId, offer, senderId, senderName }) => {
        if (evtSessionId && String(evtSessionId) !== String(sessionId)) return;
        if (extractId(senderId) === extractId(currentUser._id)) return;
        if (!offer) return;

        console.log("📥 Received WebRTC Offer from:", senderName);
        isPartnerOnline = true;
        if (!peerConnection) {
            initPeerConnection();
        }

        const polite = !isHostUser;
        try {
            const offerCollision =
                offer.type === "offer" &&
                (makingOffer || peerConnection.signalingState !== "stable");

            ignoreOffer = !polite && offerCollision;
            if (ignoreOffer) {
                console.log("⚠️ Ignoring colliding WebRTC offer (impolite host)");
                return;
            }

            if (offerCollision && peerConnection.signalingState === "have-local-offer") {
                await peerConnection.setLocalDescription({ type: "rollback" });
            }

            await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
            await flushIceCandidatesQueue();

            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);

            socket.emit("webrtcAnswer", {
                sessionId,
                answer: peerConnection.localDescription
            });
        } catch (err) {
            console.error("Error handling WebRTC offer:", err);
        }
    });

    // Received WebRTC Answer
    socket.on("webrtcAnswer", async ({ sessionId: evtSessionId, answer, senderId }) => {
        if (evtSessionId && String(evtSessionId) !== String(sessionId)) return;
        if (senderId && extractId(senderId) === extractId(currentUser._id)) return;
        if (!answer) return;

        try {
            if (peerConnection && peerConnection.signalingState === "have-local-offer") {
                isSettingRemoteAnswerPending = true;
                try {
                    await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
                    await flushIceCandidatesQueue();
                } finally {
                    isSettingRemoteAnswerPending = false;
                }
            }
        } catch (err) {
            console.error("Error setting remote description from answer:", err);
        }
    });

    // Received ICE candidate
    socket.on("iceCandidate", async ({ sessionId: evtSessionId, candidate, senderId }) => {
        if (evtSessionId && String(evtSessionId) !== String(sessionId)) return;
        if (senderId && extractId(senderId) === extractId(currentUser._id)) return;
        if (!candidate) return;

        try {
            if (peerConnection && peerConnection.remoteDescription && peerConnection.remoteDescription.type) {
                await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
            } else {
                iceCandidatesQueue.push(candidate);
            }
        } catch (err) {
            if (!ignoreOffer) {
                console.warn("Error adding ICE candidate:", err);
            }
        }
    });

    // Remote peer toggled audio or video
    socket.on("userMediaToggled", ({ sessionId: evtSessionId, type, enabled }) => {
        if (evtSessionId && String(evtSessionId) !== String(sessionId)) return;
        if (type === "audio") {
            const micIcon = document.getElementById("remote-mic-status");
            if (micIcon) {
                micIcon.textContent = enabled ? "🎤" : "🔇";
                micIcon.title = enabled ? "Mic Active" : "Mic Muted";
            }
        } else if (type === "video") {
            remoteCameraMuted = !enabled;
            const camIcon = document.getElementById("remote-cam-status");
            const remotePlaceholder = document.getElementById("remote-placeholder");
            if (camIcon) {
                camIcon.textContent = enabled ? "📷" : "🚫";
                camIcon.title = enabled ? "Camera Active" : "Camera Off";
            }
            if (!enabled) {
                remotePlaceholder.classList.remove("hidden");
                document.getElementById("remote-status-msg").textContent = `${partnerUser?.name || "Partner"} turned off camera`;
                document.getElementById("remote-spinner").classList.add("hidden");
            } else if (hasLiveRemoteVideo()) {
                remotePlaceholder.classList.add("hidden");
            }
        }
    });

    // Session-scoped real-time chat message
    socket.on("sessionMessage", (msg) => {
        if (!msg || (msg.sessionId && String(msg.sessionId) !== String(sessionId))) return;
        reconcileOrAppendSessionMessage(msg);
    });

    // Typing indicator inside live session chat
    socket.on("sessionUserTyping", ({ sessionId: evtSessionId, userId, userName, isTyping }) => {
        if (evtSessionId && String(evtSessionId) !== String(sessionId)) return;
        if (extractId(userId) === extractId(currentUser._id)) return;

        const indicator = document.getElementById("drawer-typing-indicator");
        const textEl = document.getElementById("drawer-typing-text");
        if (!indicator || !textEl) return;

        if (isTyping) {
            textEl.textContent = `${userName || "Partner"} is typing...`;
            indicator.classList.remove("hidden");
        } else {
            indicator.classList.add("hidden");
        }
    });

    // Peer unexpectedly disconnected
    socket.on("sessionUserDisconnected", ({ sessionId: evtSessionId, userName }) => {
        if (evtSessionId && String(evtSessionId) !== String(sessionId)) return;
        isPartnerOnline = false;
        clearIceTimers();
        updateConnStatus(`${userName} disconnected`, "connecting");
        document.getElementById("remote-placeholder").classList.remove("hidden");
        document.getElementById("remote-status-msg").textContent = `${userName} lost connection. Waiting for reconnect...`;
        document.getElementById("remote-spinner").classList.remove("hidden");
        document.getElementById("btn-retry-webrtc")?.classList.add("hidden");
    });

    // Peer intentionally left session
    socket.on("sessionUserLeft", ({ sessionId: evtSessionId, userName }) => {
        if (evtSessionId && String(evtSessionId) !== String(sessionId)) return;
        console.log("👋 Peer left the session:", userName);
        isPartnerOnline = false;
        hasWebRTCExhaustedRetries = false;
        clearIceTimers();
        updateConnStatus("Partner left • Waiting", "waiting");
        document.getElementById("remote-placeholder").classList.remove("hidden");
        document.getElementById("remote-status-msg").textContent = `${userName} left the session`;
        document.getElementById("remote-spinner").classList.add("hidden");
        document.getElementById("btn-retry-webrtc")?.classList.add("hidden");

        const remoteVideo = document.getElementById("remote-video");
        if (remoteVideo && remoteVideo.srcObject) {
            remoteVideo.srcObject = null;
        }
        resetPeerConnection();
    });

    // Session ended by host
    socket.on("sessionEnded", ({ sessionId: evtSessionId, endedBy }) => {
        if (evtSessionId && String(evtSessionId) !== String(sessionId)) return;
        if (isSessionEnded) return;
        isSessionEnded = true;
        console.log("Session officially ended by:", endedBy);
        document.getElementById("confirm-action-modal").classList.add("hidden");
        document.getElementById("session-left-modal").classList.add("hidden");
        updateConnStatus("Session ended", "error");
        cleanupMedia();
        const isSelf = extractId(endedBy) === extractId(currentUser._id);
        showSessionEndedModal(isSelf ? "You have ended the live session." : "The host has ended this live session.");
    });
}

function joinRoomAndSync() {
    if (!socket || !socket.connected) return;

    socket.emit("joinSession", { sessionId }, async (res) => {
        if (res && res.success) {
            hideAlert();
            const partnerOnline = Array.isArray(res.participants) && res.participants.some(
                p => extractId(p.userId) !== extractId(currentUser._id) && p.status === "online"
            );
            isPartnerOnline = partnerOnline;

            if (Array.isArray(res.participants)) {
                renderParticipantsBar(res.participants);
                const bothOnline = res.participants.filter(p => p.status === "online").length >= 2;
                if (bothOnline) {
                    updateConnStatus("Connected 🟢", "connected");
                    startTimer();
                    document.getElementById("remote-status-msg").textContent = localStream
                        ? `Connecting video/audio with ${partnerUser?.name || "Partner"}...`
                        : `${partnerUser?.name || "Partner"} is online • Chat active`;
                } else {
                    updateConnStatus("Online • Waiting for partner", "waiting");
                }
            } else {
                updateConnStatus("Online • Waiting for partner", "waiting");
            }

            if (partnerOnline) {
                resetPeerConnection();
                initPeerConnection();
                if (isHostUser) {
                    // Host initiates WebRTC handshake immediately (works even in chat-only / no-camera mode!)
                    await sendWebRTCOffer(partnerUser?.name || "Partner");
                }
            } else if (!peerConnection) {
                initPeerConnection();
            }
        } else {
            showAlert("Error joining session: " + (res?.message || "Unknown error"), "error");
            if (res?.code === 400 && sessionData) {
                showSessionEndedModal("This session has already ended.");
            }
        }
    });
}

async function flushIceCandidatesQueue() {
    if (!peerConnection || !peerConnection.remoteDescription) return;
    while (iceCandidatesQueue.length > 0) {
        const candidate = iceCandidatesQueue.shift();
        try {
            await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
            if (!ignoreOffer) {
                console.warn("Error flushing queued ICE candidate:", err);
            }
        }
    }
}

async function sendWebRTCOffer(targetName, { iceRestart = false } = {}) {
    if (!peerConnection || !socket || !socket.connected) return;
    if (makingOffer) return;
    if (!iceRestart && peerConnection.signalingState !== "stable") return;

    try {
        makingOffer = true;
        if (iceRestart && typeof peerConnection.restartIce === "function") {
            peerConnection.restartIce();
        }
        const offer = await peerConnection.createOffer(iceRestart ? { iceRestart: true } : undefined);
        if (peerConnection.signalingState !== "stable" && !iceRestart) {
            return;
        }
        await peerConnection.setLocalDescription(offer);
        socket.emit("webrtcOffer", {
            sessionId,
            offer: peerConnection.localDescription
        });
        console.log("📤 Sent WebRTC Offer to:", targetName, iceRestart ? "(ICE restart)" : "");
    } catch (err) {
        console.error("Error creating WebRTC offer:", err);
    } finally {
        makingOffer = false;
    }
}

function hasLiveRemoteVideo() {
    const remoteVideo = document.getElementById("remote-video");
    const stream = remoteVideo && remoteVideo.srcObject;
    if (!stream || typeof stream.getVideoTracks !== "function") return false;
    return stream.getVideoTracks().some(t => t.readyState === "live" && t.enabled !== false);
}

function renderParticipantsBar(participants) {
    const listEl = document.getElementById("participants-chips-list");
    if (!listEl) return;

    if (!participants || participants.length === 0) {
        listEl.innerHTML = `<span class="participant-status-chip offline"><span class="chip-dot"></span>No participants</span>`;
        return;
    }

    const myId = extractId(currentUser?._id);
    const statusLabelMap = {
        online: "Online",
        joining: "Joining...",
        disconnected: "Disconnected",
        offline: "Offline"
    };

    listEl.innerHTML = participants.map(p => {
        const isMe = extractId(p.userId) === myId;
        const status = p.status || "offline";
        const label = statusLabelMap[status] || "Offline";
        const roleTag = p.role === "host" ? "Host" : "Peer";
        return `
            <span class="participant-status-chip ${escapeHtml(status)}" title="${escapeHtml(p.name)} (${roleTag}) - ${label}">
                <span class="chip-dot"></span>
                <span>${escapeHtml(p.name)}${isMe ? " (You)" : ""}</span>
                <span class="chip-state">${label}</span>
            </span>
        `;
    }).join("");

    // Keep remote placeholder spinner synced with partner presence
    const partnerState = participants.find(p => extractId(p.userId) !== myId);
    if (partnerState) {
        isPartnerOnline = partnerState.status === "online";
        const spinner = document.getElementById("remote-spinner");
        const statusMsg = document.getElementById("remote-status-msg");
        const remoteVideoLive = hasLiveRemoteVideo();

        if (partnerState.status === "online") {
            startTimer();
            if (!hasWebRTCExhaustedRetries) {
                updateConnStatus("Connected 🟢", "connected");
            }
            if (!remoteVideoLive && statusMsg && !hasWebRTCExhaustedRetries) {
                const rtcState = peerConnection ? peerConnection.connectionState : "new";
                statusMsg.textContent = rtcState === "connected"
                    ? `${partnerState.name} is online • Camera off (Chat active)`
                    : `${partnerState.name} is online • Chat active`;
                if (spinner) spinner.classList.add("hidden");
            }
        } else if (partnerState.status === "disconnected") {
            updateConnStatus(`${partnerState.name} disconnected`, "connecting");
            if (statusMsg) statusMsg.textContent = `${partnerState.name} disconnected. Waiting for reconnect...`;
            if (spinner) spinner.classList.remove("hidden");
        } else {
            updateConnStatus("Waiting for partner", "waiting");
            if (statusMsg) statusMsg.textContent = `Waiting for ${partnerState.name} to join...`;
            if (spinner) spinner.classList.remove("hidden");
        }
    }
}

// ==========================================
// SESSION-SCOPED LIVE CHAT ENGINE
// ==========================================

async function loadSessionMessages() {
    const container = document.getElementById("drawer-messages");
    if (!container) return;

    const loadingEl = document.getElementById("drawer-loading-state");
    if (loadingEl) loadingEl.style.display = "block";

    try {
        const response = await fetch(`/api/live-sessions/${encodeURIComponent(sessionId)}/messages`, {
            headers: {
                "Authorization": `Bearer ${authToken}`
            }
        });

        if (!response.ok) {
            throw new Error("Could not load session messages");
        }

        const messages = await response.json();
        if (loadingEl) loadingEl.remove();

        // Remove empty hint if messages exist
        const hint = container.querySelector(".drawer-hint");
        if (messages.length > 0 && hint) hint.remove();

        if (messages.length === 0 && renderedMessageIds.size === 0 && pendingMessageMap.size === 0) {
            if (!container.querySelector(".drawer-hint")) {
                const p = document.createElement("p");
                p.className = "drawer-hint";
                p.style.cssText = "font-size:0.85rem; color:#94a3b8; text-align:center; margin-top:24px;";
                p.textContent = "No messages yet. Say hello to start the session chat!";
                container.appendChild(p);
            }
            return;
        }

        messages.forEach(msg => {
            reconcileOrAppendSessionMessage(msg, { suppressUnread: true });
        });
        scrollChatToBottom();
    } catch (err) {
        console.error("Failed to load session chat history:", err);
        if (loadingEl) {
            loadingEl.textContent = "Failed to load chat history. Retrying on reconnect...";
            loadingEl.style.color = "#f87171";
        }
    }
}

function generateClientMessageId() {
    return `cm_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function sendChatMessage(text, existingClientMessageId = null) {
    const trimmed = String(text || "").trim();
    if (!trimmed) return;

    if (isSessionEnded) {
        showAlert("Cannot send messages after the session has ended.", "warning");
        return;
    }

    const clientMessageId = existingClientMessageId || generateClientMessageId();
    const container = document.getElementById("drawer-messages");
    const hint = container.querySelector(".drawer-hint");
    if (hint) hint.remove();

    let bubbleEl = pendingMessageMap.get(clientMessageId)?.el;
    if (!bubbleEl) {
        bubbleEl = createMessageElement({
            sender: { _id: currentUser._id, name: currentUser.name },
            message: trimmed,
            createdAt: new Date(),
            clientMessageId
        }, "sending");
        container.appendChild(bubbleEl);
        scrollChatToBottom();
    } else {
        setMessageDeliveryState(bubbleEl, "sending", clientMessageId, trimmed);
    }

    const existingEntry = pendingMessageMap.get(clientMessageId);
    if (existingEntry && existingEntry.timerId) {
        clearTimeout(existingEntry.timerId);
    }

    if (!socket || !socket.connected) {
        setMessageDeliveryState(bubbleEl, "failed", clientMessageId, trimmed, "Offline");
        pendingMessageMap.set(clientMessageId, { el: bubbleEl, text: trimmed, clientMessageId, timerId: null });
        return;
    }

    const timeoutId = setTimeout(() => {
        if (pendingMessageMap.has(clientMessageId)) {
            setMessageDeliveryState(bubbleEl, "failed", clientMessageId, trimmed, "Timed out");
        }
    }, 6000);

    pendingMessageMap.set(clientMessageId, { el: bubbleEl, text: trimmed, clientMessageId, timerId: timeoutId });

    socket.emit("sendSessionMessage", {
        sessionId,
        message: trimmed,
        clientMessageId
    }, (ack) => {
        clearTimeout(timeoutId);
        if (ack && ack.success && ack.message) {
            reconcileOrAppendSessionMessage(ack.message, { suppressUnread: true });
        } else {
            setMessageDeliveryState(bubbleEl, "failed", clientMessageId, trimmed, ack?.message || "Send failed");
        }
    });
}

function reconcileOrAppendSessionMessage(msg, { suppressUnread = false } = {}) {
    if (!msg) return;
    const container = document.getElementById("drawer-messages");
    if (!container) return;

    const hint = container.querySelector(".drawer-hint");
    if (hint) hint.remove();
    const loadingEl = document.getElementById("drawer-loading-state");
    if (loadingEl) loadingEl.remove();

    const msgId = extractId(msg._id);
    const clientMsgId = msg.clientMessageId ? String(msg.clientMessageId) : null;

    // 1. If already rendered by server _id, prevent duplicate
    if (msgId && renderedMessageIds.has(msgId)) {
        return;
    }

    // 2. If matching an optimistic pending bubble via clientMessageId, reconcile in place
    if (clientMsgId && pendingMessageMap.has(clientMsgId)) {
        const entry = pendingMessageMap.get(clientMsgId);
        if (entry.timerId) clearTimeout(entry.timerId);
        pendingMessageMap.delete(clientMsgId);

        if (msgId) renderedMessageIds.add(msgId);
        entry.el.dataset.messageId = msgId;
        setMessageDeliveryState(entry.el, "sent", clientMsgId, msg.message, null, msg.createdAt);
        scrollChatToBottom();
        return;
    }

    // 3. Otherwise append fresh message bubble
    if (msgId) renderedMessageIds.add(msgId);

    const el = createMessageElement(msg, "sent");
    if (msgId) el.dataset.messageId = msgId;
    container.appendChild(el);
    scrollChatToBottom();

    // Update unread badge if drawer is hidden and message is from partner
    const isMine = extractId(msg.sender) === extractId(currentUser._id);
    const drawer = document.getElementById("in-call-chat-drawer");
    if (!suppressUnread && !isMine && drawer && drawer.classList.contains("hidden")) {
        unreadChatCount++;
        updateUnreadBadge();
    }
}

function createMessageElement(msg, deliveryState) {
    const isMine = extractId(msg.sender) === extractId(currentUser._id);
    const senderName = isMine ? "You" : (msg.sender?.name || partnerUser?.name || "Partner");
    const timeStr = formatTime(msg.createdAt || new Date());

    const row = document.createElement("div");
    row.className = `session-chat-msg ${isMine ? "mine" : "theirs"}`;
    if (msg.clientMessageId) row.dataset.clientMessageId = msg.clientMessageId;

    const header = document.createElement("div");
    header.className = "session-chat-msg-meta";
    header.textContent = `${senderName} • ${timeStr}`;

    const body = document.createElement("div");
    body.className = "session-chat-msg-body";
    body.textContent = msg.message || "";

    const footer = document.createElement("div");
    footer.className = "session-chat-msg-status";

    row.appendChild(header);
    row.appendChild(body);
    if (isMine) {
        row.appendChild(footer);
        setMessageDeliveryState(row, deliveryState, msg.clientMessageId, msg.message, null, msg.createdAt);
    }

    return row;
}

function setMessageDeliveryState(rowEl, state, clientMessageId, originalText, errorReason = null, createdAt = null) {
    if (!rowEl) return;
    const footer = rowEl.querySelector(".session-chat-msg-status");
    const meta = rowEl.querySelector(".session-chat-msg-meta");

    if (createdAt && meta) {
        const isMine = rowEl.classList.contains("mine");
        const senderLabel = isMine ? "You" : (meta.textContent.split("•")[0] || "Partner").trim();
        meta.textContent = `${senderLabel} • ${formatTime(createdAt)}`;
    }

    if (!footer) return;
    footer.innerHTML = "";
    rowEl.classList.remove("is-sending", "is-failed", "is-sent");

    if (state === "sending") {
        rowEl.classList.add("is-sending");
        footer.textContent = "Sending...";
    } else if (state === "failed") {
        rowEl.classList.add("is-failed");
        const label = document.createElement("span");
        label.textContent = errorReason ? `Failed (${errorReason})` : "Failed to send";
        const retryBtn = document.createElement("button");
        retryBtn.type = "button";
        retryBtn.className = "chat-retry-btn";
        retryBtn.textContent = "Retry";
        retryBtn.addEventListener("click", () => {
            sendChatMessage(originalText, clientMessageId);
        });
        footer.appendChild(label);
        footer.appendChild(retryBtn);
    } else {
        rowEl.classList.add("is-sent");
        footer.textContent = "Sent";
    }
}

function scrollChatToBottom() {
    const container = document.getElementById("drawer-messages");
    if (container) {
        container.scrollTop = container.scrollHeight;
    }
}

function updateUnreadBadge() {
    const badge = document.getElementById("chat-unread-badge");
    if (!badge) return;
    if (unreadChatCount > 0) {
        badge.textContent = unreadChatCount > 99 ? "99+" : String(unreadChatCount);
        badge.classList.remove("hidden");
    } else {
        badge.classList.add("hidden");
    }
}

function formatTime(dateInput) {
    const d = new Date(dateInput);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ==========================================
// WEBRTC PEER CONNECTION
// ==========================================

function clearIceTimers() {
    if (iceRetryTimer) {
        clearTimeout(iceRetryTimer);
        iceRetryTimer = null;
    }
    if (disconnectedDebounceTimer) {
        clearTimeout(disconnectedDebounceTimer);
        disconnectedDebounceTimer = null;
    }
}

function resetPeerConnection() {
    clearIceTimers();
    makingOffer = false;
    ignoreOffer = false;
    isSettingRemoteAnswerPending = false;
    ctrlDataChannel = null;
    remoteMediaStream = null;
    remoteCameraMuted = false;

    if (peerConnection) {
        try {
            peerConnection.onicecandidate = null;
            peerConnection.ontrack = null;
            peerConnection.onconnectionstatechange = null;
            peerConnection.oniceconnectionstatechange = null;
            peerConnection.onnegotiationneeded = null;
            peerConnection.ondatachannel = null;
            peerConnection.close();
        } catch {
            // ignore
        }
        peerConnection = null;
    }
    iceCandidatesQueue = [];
}

function initPeerConnection() {
    if (peerConnection) return;

    peerConnection = new RTCPeerConnection(rtcConfig);
    remoteMediaStream = new MediaStream();

    // Control data channel guarantees valid ICE/DTLS SDP negotiation even in chat-only mode
    if (isHostUser) {
        try {
            ctrlDataChannel = peerConnection.createDataChannel("skillswap-ctrl");
        } catch {
            // ignore
        }
    }
    peerConnection.ondatachannel = (event) => {
        ctrlDataChannel = event.channel;
    };

    // Attach existing local tracks or add recvonly transceivers so remote media can always be received
    const audioTrack = localStream ? localStream.getAudioTracks()[0] : null;
    const videoTrack = localStream ? localStream.getVideoTracks()[0] : null;

    if (audioTrack) {
        peerConnection.addTrack(audioTrack, localStream);
    } else {
        try {
            peerConnection.addTransceiver("audio", { direction: "recvonly" });
        } catch {
            // ignore
        }
    }

    if (videoTrack) {
        peerConnection.addTrack(videoTrack, localStream);
    } else {
        try {
            peerConnection.addTransceiver("video", { direction: "recvonly" });
        } catch {
            // ignore
        }
    }

    peerConnection.onnegotiationneeded = async () => {
        if (!isPartnerOnline || !peerConnection) return;
        await sendWebRTCOffer(partnerUser?.name || "Partner");
    };

    peerConnection.ontrack = (event) => {
        console.log("🎥 Received remote media track:", event.track.kind, "muted:", event.track.muted);
        const remoteVideo = document.getElementById("remote-video");
        const remotePlaceholder = document.getElementById("remote-placeholder");
        const remoteStatusMsg = document.getElementById("remote-status-msg");
        const remoteSpinner = document.getElementById("remote-spinner");

        if (!remoteMediaStream) {
            remoteMediaStream = new MediaStream();
        }

        const incomingTracks = event.streams && event.streams[0]
            ? event.streams[0].getTracks()
            : [event.track];

        incomingTracks.forEach(track => {
            if (!remoteMediaStream.getTracks().some(t => t.id === track.id)) {
                remoteMediaStream.addTrack(track);
            }
        });

        if (remoteVideo) {
            if (remoteVideo.srcObject !== remoteMediaStream) {
                remoteVideo.srcObject = remoteMediaStream;
            }
            remoteVideo.play().catch(() => {});
        }

        if (event.track.kind === "video") {
            const updateVideoDisplay = () => {
                if (!remotePlaceholder) return;
                if (!remoteCameraMuted && hasLiveRemoteVideo()) {
                    remotePlaceholder.classList.add("hidden");
                    document.getElementById("btn-retry-webrtc")?.classList.add("hidden");
                }
            };

            updateVideoDisplay();
            event.track.onunmute = updateVideoDisplay;
            event.track.onended = () => {
                if (!hasLiveRemoteVideo() && remotePlaceholder) {
                    remotePlaceholder.classList.remove("hidden");
                    if (remoteStatusMsg) {
                        remoteStatusMsg.textContent = `${partnerUser?.name || "Partner"} camera stopped • Chat active`;
                    }
                }
            };
        } else if (event.track.kind === "audio") {
            if (!hasLiveRemoteVideo() && remoteStatusMsg) {
                remoteStatusMsg.textContent = `${partnerUser?.name || "Partner"} • Audio connected`;
                if (remoteSpinner) remoteSpinner.classList.add("hidden");
            }
        }
    };

    peerConnection.onicecandidate = (event) => {
        if (event.candidate && socket && socket.connected) {
            socket.emit("iceCandidate", {
                sessionId,
                candidate: event.candidate
            });
        }
    };

    const handlePeerConnectionFailure = () => {
        if (!peerConnection || hasExplicitlyLeft || isSessionEnded || !isPartnerOnline) return;
        attemptIceRestart();
    };

    peerConnection.oniceconnectionstatechange = () => {
        if (!peerConnection) return;
        const iceState = peerConnection.iceConnectionState;
        console.log("🧊 ICE connection state:", iceState);
        if (iceState === "failed") {
            handlePeerConnectionFailure();
        }
    };

    peerConnection.onconnectionstatechange = () => {
        if (!peerConnection) return;
        const state = peerConnection.connectionState;
        console.log("⚡ WebRTC connection state changed:", state);

        switch (state) {
            case "connected":
                clearIceTimers();
                iceRetryCount = 0;
                hasWebRTCExhaustedRetries = false;
                updateConnStatus("Connected 🟢", "connected");
                document.getElementById("btn-retry-webrtc")?.classList.add("hidden");
                document.getElementById("remote-spinner")?.classList.add("hidden");

                if (!remoteCameraMuted && hasLiveRemoteVideo()) {
                    document.getElementById("remote-placeholder")?.classList.add("hidden");
                } else {
                    const statusMsg = document.getElementById("remote-status-msg");
                    if (statusMsg && isPartnerOnline) {
                        statusMsg.textContent = `${partnerUser?.name || "Partner"} connected • Chat active`;
                    }
                }
                startTimer();
                break;

            case "disconnected":
                if (hasExplicitlyLeft || isSessionEnded || !isPartnerOnline) break;
                updateConnStatus("Media reconnecting...", "connecting");
                clearTimeout(disconnectedDebounceTimer);
                disconnectedDebounceTimer = setTimeout(() => {
                    if (peerConnection && (peerConnection.connectionState === "disconnected" || peerConnection.connectionState === "failed")) {
                        handlePeerConnectionFailure();
                    }
                }, 2500);
                break;

            case "failed":
                handlePeerConnectionFailure();
                break;
        }
    };
}

function attemptIceRestart() {
    if (hasExplicitlyLeft || isSessionEnded || !isPartnerOnline) return;
    if (iceRetryTimer) return; // Restart already scheduled

    const remotePlaceholder = document.getElementById("remote-placeholder");
    const statusMsg = document.getElementById("remote-status-msg");
    const spinner = document.getElementById("remote-spinner");
    const retryBtn = document.getElementById("btn-retry-webrtc");

    if (iceRetryCount < MAX_ICE_RETRIES) {
        iceRetryCount += 1;
        updateConnStatus(`Reconnecting media (${iceRetryCount}/${MAX_ICE_RETRIES})...`, "connecting");
        if (remotePlaceholder) remotePlaceholder.classList.remove("hidden");
        if (spinner) spinner.classList.remove("hidden");
        if (retryBtn) retryBtn.classList.add("hidden");
        if (statusMsg) statusMsg.textContent = `Re-establishing media connection (${iceRetryCount}/${MAX_ICE_RETRIES})...`;

        iceRetryTimer = setTimeout(async () => {
            iceRetryTimer = null;
            if (!peerConnection || hasExplicitlyLeft || isSessionEnded || !isPartnerOnline) return;

            if (isHostUser) {
                await sendWebRTCOffer(partnerUser?.name || "Partner", { iceRestart: true });
            } else if (socket && socket.connected) {
                socket.emit("webrtcRequestReconnect", { sessionId });
            }
        }, 1000);
        return;
    }

    // Exhausted automatic ICE restarts: keep Socket.IO live chat healthy and expose manual retry
    hasWebRTCExhaustedRetries = true;
    const socketOnline = !!(socket && socket.connected);
    updateConnStatus(socketOnline ? "Chat Active • Video Blocked" : "Connection failed", socketOnline ? "waiting" : "error");
    if (remotePlaceholder) remotePlaceholder.classList.remove("hidden");
    if (spinner) spinner.classList.add("hidden");
    if (retryBtn) retryBtn.classList.remove("hidden");
    if (statusMsg) {
        statusMsg.textContent = socketOnline
            ? "Direct video blocked by firewall/NAT. Live chat remains active — click below to retry video."
            : "Connection lost. Waiting for network recovery...";
    }
}

// ==========================================
// CONTROLS, LEAVE VS END SESSION & MODALS
// ==========================================

function setupControlButtons() {
    // Copy Session ID chip
    const idPill = document.getElementById("session-id-pill");
    if (idPill) {
        idPill.addEventListener("click", async () => {
            if (!sessionId) return;
            try {
                await navigator.clipboard.writeText(sessionId);
                showAlert("Session ID copied to clipboard!", "success");
                setTimeout(hideAlert, 2000);
            } catch {
                showAlert(`Session ID: ${sessionId}`, "success");
            }
        });
    }

    // Alert close button
    const alertCloseBtn = document.getElementById("alert-close-btn");
    if (alertCloseBtn) {
        alertCloseBtn.addEventListener("click", hideAlert);
    }

    // 1. Microphone Toggle
    const btnMic = document.getElementById("btn-toggle-mic");
    const labelMic = document.getElementById("label-mic");
    const localMicStatus = document.getElementById("local-mic-status");

    btnMic.addEventListener("click", () => {
        if (!localStream) {
            showAlert("Microphone not available. Click Retry Permissions or continue with chat.", "warning");
            return;
        }
        const audioTrack = localStream.getAudioTracks()[0];
        if (!audioTrack) return;

        isAudioMuted = !isAudioMuted;
        audioTrack.enabled = !isAudioMuted;

        btnMic.classList.toggle("active", !isAudioMuted);
        btnMic.classList.toggle("muted", isAudioMuted);
        btnMic.querySelector(".btn-icon").textContent = isAudioMuted ? "🔇" : "🎤";
        labelMic.textContent = isAudioMuted ? "Unmute" : "Mute";
        localMicStatus.textContent = isAudioMuted ? "🔇" : "🎤";
        localMicStatus.title = isAudioMuted ? "Muted" : "Active";

        if (socket && socket.connected) {
            socket.emit("mediaToggle", {
                sessionId,
                type: "audio",
                enabled: !isAudioMuted
            });
        }
    });

    // 2. Camera Toggle
    const btnCam = document.getElementById("btn-toggle-cam");
    const labelCam = document.getElementById("label-cam");
    const localCamStatus = document.getElementById("local-cam-status");
    const localPlaceholder = document.getElementById("local-placeholder");

    btnCam.addEventListener("click", () => {
        if (!localStream) {
            showAlert("Camera not available. Click Retry Permissions or continue with chat.", "warning");
            return;
        }
        const videoTrack = localStream.getVideoTracks()[0];
        if (!videoTrack) return;

        isVideoStopped = !isVideoStopped;
        videoTrack.enabled = !isVideoStopped;

        btnCam.classList.toggle("active", !isVideoStopped);
        btnCam.classList.toggle("muted", isVideoStopped);
        btnCam.querySelector(".btn-icon").textContent = isVideoStopped ? "🚫" : "📷";
        labelCam.textContent = isVideoStopped ? "Start Video" : "Stop Video";
        localCamStatus.textContent = isVideoStopped ? "🚫" : "📷";
        localPlaceholder.classList.toggle("hidden", !isVideoStopped);

        if (socket && socket.connected) {
            socket.emit("mediaToggle", {
                sessionId,
                type: "video",
                enabled: !isVideoStopped
            });
        }
    });

    // 3. Screen Sharing Toggle
    const btnScreen = document.getElementById("btn-toggle-screen");
    const labelScreen = document.getElementById("label-screen");

    btnScreen.addEventListener("click", async () => {
        if (!isScreenSharing) {
            try {
                screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
                const screenTrack = screenStream.getVideoTracks()[0];

                if (peerConnection) {
                    const transceivers = peerConnection.getTransceivers ? peerConnection.getTransceivers() : [];
                    const videoTransceiver = transceivers.find(t =>
                        t.sender && (
                            (t.sender.track && t.sender.track.kind === "video") ||
                            (t.receiver && t.receiver.track && t.receiver.track.kind === "video")
                        )
                    );
                    if (videoTransceiver && videoTransceiver.sender) {
                        await videoTransceiver.sender.replaceTrack(screenTrack);
                        if (videoTransceiver.direction === "recvonly") {
                            videoTransceiver.direction = "sendrecv";
                            if (isPartnerOnline) await sendWebRTCOffer(partnerUser?.name || "Partner");
                        }
                    } else {
                        peerConnection.addTrack(screenTrack, screenStream);
                        if (isPartnerOnline) await sendWebRTCOffer(partnerUser?.name || "Partner");
                    }
                }

                document.getElementById("local-video").srcObject = screenStream;
                document.getElementById("local-placeholder").classList.add("hidden");

                isScreenSharing = true;
                btnScreen.classList.add("active");
                labelScreen.textContent = "Stop Sharing";

                screenTrack.onended = () => stopScreenSharing();
            } catch (err) {
                console.warn("Screen share cancelled or failed:", err);
            }
        } else {
            stopScreenSharing();
        }
    });

    function stopScreenSharing() {
        if (!isScreenSharing) return;
        if (screenStream) {
            screenStream.getTracks().forEach(t => t.stop());
            screenStream = null;
        }
        if (localStream) {
            const originalVideoTrack = localStream.getVideoTracks()[0];
            if (peerConnection && originalVideoTrack) {
                const videoSender = peerConnection.getSenders().find(s => s.track && s.track.kind === "video");
                if (videoSender) videoSender.replaceTrack(originalVideoTrack);
            }
            document.getElementById("local-video").srcObject = localStream;
        } else {
            document.getElementById("local-video").srcObject = null;
            document.getElementById("local-placeholder").classList.remove("hidden");
        }
        isScreenSharing = false;
        btnScreen.classList.remove("active");
        labelScreen.textContent = "Share Screen";
    }

    // 4. In-Call Chat Drawer Toggle
    const btnChat = document.getElementById("btn-toggle-chat");
    const drawer = document.getElementById("in-call-chat-drawer");
    const closeDrawerBtn = document.getElementById("close-drawer-btn");

    btnChat.addEventListener("click", () => {
        drawer.classList.toggle("hidden");
        const isOpen = !drawer.classList.contains("hidden");
        btnChat.classList.toggle("active", isOpen);
        if (isOpen) {
            unreadChatCount = 0;
            updateUnreadBadge();
            scrollChatToBottom();
            document.getElementById("drawer-msg-input")?.focus();
        }
    });

    closeDrawerBtn.addEventListener("click", () => {
        drawer.classList.add("hidden");
        btnChat.classList.remove("active");
    });

    // Chat Drawer Form Submit + Enter to send / Shift+Enter for newline + Typing indicator
    const drawerForm = document.getElementById("drawer-input-form");
    const drawerInput = document.getElementById("drawer-msg-input");

    function submitChatFromInput() {
        const text = drawerInput.value;
        if (!text.trim()) return;
        sendChatMessage(text);
        drawerInput.value = "";
        drawerInput.style.height = "auto";
        emitTyping(false);
    }

    drawerForm.addEventListener("submit", (e) => {
        e.preventDefault();
        submitChatFromInput();
    });

    drawerInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submitChatFromInput();
        }
    });

    drawerInput.addEventListener("input", () => {
        // Auto-grow textarea up to 110px
        drawerInput.style.height = "auto";
        drawerInput.style.height = Math.min(drawerInput.scrollHeight, 110) + "px";

        emitTyping(true);
        clearTimeout(typingTimeout);
        typingTimeout = setTimeout(() => emitTyping(false), 1500);
    });

    // 5. Leave Session (Top button) vs End Session / Leave Call (Dock button)
    document.getElementById("leave-session-btn-top").addEventListener("click", () => {
        openConfirmModal({
            icon: "👋",
            title: "Leave Live Session?",
            message: isHostUser
                ? "You will leave the live room temporarily. The session stays open so you or your partner can rejoin anytime."
                : "You will leave the live call. You can rejoin as long as the host keeps the session active.",
            confirmText: "Leave Room",
            confirmColor: "#4f46e5",
            onConfirm: leaveSessionOnly
        });
    });

    document.getElementById("btn-end-call").addEventListener("click", () => {
        if (isHostUser) {
            openConfirmModal({
                icon: "🛑",
                title: "End Session for Everyone?",
                message: "As the session host, ending this session will mark it completed and close it for all participants.",
                confirmText: "End Session",
                confirmColor: "#ef4444",
                onConfirm: endSessionForAll
            });
        } else {
            openConfirmModal({
                icon: "👋",
                title: "Leave Live Call?",
                message: "You will exit the live call. Your partner remains in the session until the host ends it.",
                confirmText: "Leave Call",
                confirmColor: "#ef4444",
                onConfirm: leaveSessionOnly
            });
        }
    });

    // 6. Rejoin button inside Left Session Modal
    const rejoinBtn = document.getElementById("rejoin-session-btn");
    if (rejoinBtn) {
        rejoinBtn.addEventListener("click", async () => {
            document.getElementById("session-left-modal").classList.add("hidden");
            hasExplicitlyLeft = false;
            if (socket) {
                if (!socket.connected) {
                    socket.connect();
                } else {
                    joinRoomAndSync();
                }
            } else {
                initSignalingSocket();
            }
            await loadSessionMessages();
            await initLocalMedia({ showModalOnFailure: false });
        });
    }

    // 7. Permission modal controls
    document.getElementById("retry-permission-btn").addEventListener("click", async () => {
        const ready = await initLocalMedia({ showModalOnFailure: true });
        if (ready && !peerConnection) {
            initPeerConnection();
            if (isPartnerOnline && isHostUser) {
                await sendWebRTCOffer(partnerUser?.name || "Partner");
            }
        }
    });

    const continueBtn = document.getElementById("continue-without-media-btn");
    if (continueBtn) {
        continueBtn.addEventListener("click", () => {
            document.getElementById("permission-modal").classList.add("hidden");
            // Open chat drawer automatically so user sees live chat right away
            if (drawer.classList.contains("hidden")) {
                drawer.classList.remove("hidden");
                btnChat.classList.add("active");
                unreadChatCount = 0;
                updateUnreadBadge();
            }
        });
    }

    // 8. Manual Reconnect Video button inside remote placeholder
    const retryWebrtcBtn = document.getElementById("btn-retry-webrtc");
    if (retryWebrtcBtn) {
        retryWebrtcBtn.addEventListener("click", async () => {
            iceRetryCount = 0;
            hasWebRTCExhaustedRetries = false;
            retryWebrtcBtn.classList.add("hidden");
            document.getElementById("remote-spinner")?.classList.remove("hidden");
            const statusMsg = document.getElementById("remote-status-msg");
            if (statusMsg) statusMsg.textContent = "Reconnecting peer video...";
            updateConnStatus("Reconnecting media...", "connecting");

            await loadIceServers();
            resetPeerConnection();
            initPeerConnection();

            if (socket && socket.connected) {
                socket.emit("webrtcRequestReconnect", { sessionId });
                if (isHostUser && isPartnerOnline) {
                    await sendWebRTCOffer(partnerUser?.name || "Partner", { iceRestart: true });
                }
            }
        });
    }
}

function emitTyping(isTyping) {
    if (socket && socket.connected && sessionId) {
        socket.emit("sessionTyping", { sessionId, isTyping });
    }
}

function openConfirmModal({ icon, title, message, confirmText, confirmColor, onConfirm }) {
    const modal = document.getElementById("confirm-action-modal");
    const iconEl = document.getElementById("confirm-modal-icon");
    const titleEl = document.getElementById("confirm-modal-title");
    const msgEl = document.getElementById("confirm-modal-message");
    const cancelBtn = document.getElementById("confirm-cancel-btn");
    const proceedBtn = document.getElementById("confirm-proceed-btn");

    iconEl.textContent = icon || "⚠️";
    titleEl.textContent = title || "Confirm";
    msgEl.textContent = message || "Are you sure?";
    proceedBtn.textContent = confirmText || "Confirm";
    proceedBtn.style.background = confirmColor || "#ef4444";

    const closeModal = () => {
        modal.classList.add("hidden");
        cancelBtn.onclick = null;
        proceedBtn.onclick = null;
    };

    cancelBtn.onclick = closeModal;
    proceedBtn.onclick = async () => {
        closeModal();
        if (typeof onConfirm === "function") {
            await onConfirm();
        }
    };

    modal.classList.remove("hidden");
}

// Leave room without ending the session for partner
async function leaveSessionOnly() {
    hasExplicitlyLeft = true;
    emitTyping(false);

    if (socket && socket.connected) {
        socket.emit("leaveSession", { sessionId });
    }

    cleanupMedia();
    updateConnStatus("Left room", "waiting");
    document.getElementById("session-left-modal").classList.remove("hidden");
}

// Host ends the session for all participants
async function endSessionForAll() {
    isSessionEnded = true;
    emitTyping(false);

    try {
        const res = await fetch(`/api/live-sessions/${encodeURIComponent(sessionId)}/end`, {
            method: "PUT",
            headers: {
                "Authorization": `Bearer ${authToken}`
            }
        });

        if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            isSessionEnded = false;
            showAlert(errData.message || "Failed to end live session.", "error");
            return;
        }

        cleanupMedia();
        showSessionEndedModal("You have ended the live session.");
    } catch (e) {
        isSessionEnded = false;
        console.warn("End session API call failed:", e);
        showAlert("Network error ending session. Please try again.", "error");
    }
}

// Cleanup hardware tracks and peer connection
function cleanupMedia() {
    stopTimer();
    if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
        localStream = null;
    }
    if (screenStream) {
        screenStream.getTracks().forEach(t => t.stop());
        screenStream = null;
    }
    resetPeerConnection();
    const localVideo = document.getElementById("local-video");
    const remoteVideo = document.getElementById("remote-video");
    if (localVideo) localVideo.srcObject = null;
    if (remoteVideo) remoteVideo.srcObject = null;
}

// Session Duration Timer
function startTimer() {
    if (timerInterval) return;

    timerInterval = setInterval(() => {
        timerSeconds++;
        const mins = String(Math.floor(timerSeconds / 60)).padStart(2, "0");
        const secs = String(timerSeconds % 60).padStart(2, "0");
        const timerEl = document.getElementById("session-timer");
        if (timerEl) timerEl.textContent = `${mins}:${secs}`;
    }, 1000);
}

function stopTimer() {
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }
}

let selectedRating = 5;
let ratingWidgetInitialized = false;

function initStarRatingWidget() {
    if (ratingWidgetInitialized) return;
    ratingWidgetInitialized = true;

    const starButtons = document.querySelectorAll(".star-btn");
    const ratingText = document.getElementById("star-rating-text");
    const ratingLabels = {
        1: "1.0 / 5 (Needs Improvement)",
        2: "2.0 / 5 (Fair)",
        3: "3.0 / 5 (Good Exchange)",
        4: "4.0 / 5 (Very Good)",
        5: "5.0 / 5 (Excellent)"
    };

    starButtons.forEach(btn => {
        btn.addEventListener("click", () => {
            const val = parseInt(btn.dataset.rating, 10);
            selectedRating = val;

            starButtons.forEach(b => {
                const bVal = parseInt(b.dataset.rating, 10);
                if (bVal <= val) {
                    b.style.color = "#fbbf24";
                    b.classList.add("active");
                } else {
                    b.style.color = "#475569";
                    b.classList.remove("active");
                }
            });

            if (ratingText) {
                ratingText.textContent = ratingLabels[val] || `${val}.0 / 5`;
            }
        });

        btn.addEventListener("mouseenter", () => {
            const val = parseInt(btn.dataset.rating, 10);
            starButtons.forEach(b => {
                const bVal = parseInt(b.dataset.rating, 10);
                b.style.color = (bVal <= val) ? "#fbbf24" : "#475569";
            });
        });

        btn.addEventListener("mouseleave", () => {
            starButtons.forEach(b => {
                const bVal = parseInt(b.dataset.rating, 10);
                b.style.color = (bVal <= selectedRating) ? "#fbbf24" : "#475569";
            });
        });
    });

    const submitBtn = document.getElementById("submit-review-btn");
    if (submitBtn) {
        submitBtn.addEventListener("click", handleReviewSubmit);
    }
}

async function handleReviewSubmit() {
    const submitBtn = document.getElementById("submit-review-btn");
    const statusMsg = document.getElementById("review-status-msg");
    const topicInput = document.getElementById("review-topic-input");
    const feedbackInput = document.getElementById("review-feedback-input");

    if (!partnerUser || !extractId(partnerUser)) {
        showAlert("Unable to submit review: partner details not loaded.", "error");
        return;
    }

    const revieweeId = extractId(partnerUser);
    const skillTopic = topicInput ? topicInput.value.trim() : "";
    const feedback = feedbackInput ? feedbackInput.value.trim() : "";

    submitBtn.disabled = true;
    submitBtn.textContent = "Submitting review...";
    statusMsg.style.display = "block";
    statusMsg.style.color = "#94a3b8";
    statusMsg.textContent = "Saving your review and updating community rating...";

    try {
        const response = await fetch("/api/reviews", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${authToken}`
            },
            body: JSON.stringify({
                revieweeId,
                rating: selectedRating,
                feedback,
                skillTopic: skillTopic || (sessionData ? sessionData.skillTopic : "Live Skill Session"),
                sessionId,
                connectionId: sessionData ? extractId(sessionData.connectionId) : null
            })
        });

        const data = await response.json();

        if (response.ok) {
            statusMsg.style.color = "#34d399";
            statusMsg.textContent = "Review submitted! Rating updated in community profile.";
            submitBtn.textContent = "Review Submitted ✓";
            submitBtn.style.background = "#059669";

            if (topicInput) topicInput.disabled = true;
            if (feedbackInput) feedbackInput.disabled = true;
            document.querySelectorAll(".star-btn").forEach(b => b.disabled = true);
        } else {
            statusMsg.style.color = "#f87171";
            statusMsg.textContent = data.message || "Failed to submit review.";
            submitBtn.disabled = false;
            submitBtn.textContent = "Retry Submit";
        }
    } catch (err) {
        console.error("Review submit error:", err);
        statusMsg.style.color = "#f87171";
        statusMsg.textContent = "Network error. Please try again.";
        submitBtn.disabled = false;
        submitBtn.textContent = "Retry Submit";
    }
}

function showSessionEndedModal(message) {
    stopTimer();
    const modal = document.getElementById("session-ended-modal");
    document.getElementById("session-summary-text").textContent = message;
    document.getElementById("final-duration").textContent = document.getElementById("session-timer").textContent;

    const partnerHeading = document.getElementById("review-partner-heading");
    if (partnerHeading && partnerUser) {
        partnerHeading.textContent = `Rate your exchange with ${partnerUser.name}`;
    }

    const topicInput = document.getElementById("review-topic-input");
    if (topicInput && partnerUser && partnerUser.teachSkills && partnerUser.teachSkills.length > 0 && !topicInput.value) {
        topicInput.value = partnerUser.teachSkills[0];
    }

    initStarRatingWidget();
    modal.classList.remove("hidden");

    if (typeof checkLiveSessionImpact === "function" && sessionId) {
        checkLiveSessionImpact(sessionId);
    }
}

function updateConnStatus(text, type) {
    const textEl = document.getElementById("conn-status-text");
    const dotEl = document.getElementById("status-dot");
    if (textEl) textEl.textContent = text;
    if (!dotEl) return;

    dotEl.className = "status-indicator-dot";
    if (type === "connected") {
        dotEl.classList.add("connected");
    } else if (type === "error") {
        dotEl.classList.add("error");
    } else {
        dotEl.classList.add("connecting");
    }
}

function showAlert(text, variant = "error") {
    const alertBox = document.getElementById("session-alert");
    const alertText = document.getElementById("alert-text");
    if (!alertBox || !alertText) return;
    alertText.textContent = text;
    alertBox.className = `session-alert ${variant}`;
}

function hideAlert() {
    const alertBox = document.getElementById("session-alert");
    if (alertBox) {
        alertBox.classList.add("hidden");
    }
}

function getInitials(name) {
    if (!name) return "?";
    return name.trim().split(" ").filter(Boolean).map(part => part[0].toUpperCase()).slice(0, 2).join("");
}

function escapeHtml(str) {
    if (!str) return "";
    return String(str).replace(/[&<>'"]/g, tag => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "'": "&#39;",
        '"': "&quot;"
    }[tag] || tag));
}

