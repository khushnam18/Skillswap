const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const Connection = require("./connectionModel");
const Message = require("./messageModel");
const User = require("./userModel");
const LiveSession = require("./liveSessionModel");
const { memoryStore, isMongoActive } = require("./memoryStore");

const JWT_SECRET = process.env.JWT_SECRET || "skillswap_jwt_secret_key_2026_super_secure";

// Map to track active user sockets: userId -> Set of socketId
const userSockets = new Map();

// Authoritative live session room participant state:
// sessionId -> Map<userId, { userId, name, role, status, joinedAt, lastSeenAt, socketIds: Set<string> }>
const sessionRooms = new Map();

function serializeParticipants(sessionId) {
    const sId = String(sessionId);
    const roomMap = sessionRooms.get(sId);
    if (!roomMap) return [];
    return Array.from(roomMap.values()).map(p => ({
        userId: p.userId,
        name: p.name,
        role: p.role,
        status: p.status,
        joinedAt: p.joinedAt,
        lastSeenAt: p.lastSeenAt
    }));
}

function clearSessionRoom(sessionId) {
    sessionRooms.delete(String(sessionId));
}

function extractId(val) {
    if (!val) return "";
    if (typeof val === "object" && val._id) return val._id.toString();
    return val.toString();
}

async function fetchAuthorizedSession(sessionId, userId) {
    if (!sessionId) return { error: "Session ID required", code: 400 };
    const sId = String(sessionId);

    let session = null;
    if (isMongoActive()) {
        if (mongoose.Types.ObjectId.isValid(sId)) {
            try {
                session = await LiveSession.findById(sId)
                    .populate("host", "name email teachSkills learnSkills")
                    .populate("participant", "name email teachSkills learnSkills");
            } catch {
                session = null;
            }
        }
    }
    if (!session) {
        session = memoryStore.getLiveSessionById(sId);
    }

    if (!session) {
        return { error: "Live session not found", code: 404 };
    }

    if (session.status === "completed" || session.status === "cancelled") {
        return { error: "Session has already ended", code: 400, session };
    }

    const hostId = extractId(session.host);
    const participantId = extractId(session.participant);
    const uid = String(userId);

    if (uid !== hostId && uid !== participantId) {
        return { error: "Unauthorized to access this live session", code: 403 };
    }

    // Verify accepted connection
    const rawConnId = extractId(session.connectionId);
    let connection = null;
    if (isMongoActive() && mongoose.Types.ObjectId.isValid(rawConnId)) {
        try {
            connection = await Connection.findById(rawConnId);
        } catch {
            connection = null;
        }
    }
    if (!connection) {
        connection = memoryStore.getConnectionById(rawConnId);
    }

    if (!connection || connection.status !== "accepted") {
        return { error: "Underlying connection is not accepted", code: 403 };
    }

    return { session, hostId, participantId, connectionId: rawConnId };
}

function setupSocketIO(io) {
    // Socket authentication middleware: verifies JWT token
    io.use(async (socket, next) => {
        try {
            let token = socket.handshake.auth?.token;
            if (!token && socket.handshake.headers?.authorization) {
                const parts = socket.handshake.headers.authorization.split(" ");
                if (parts.length === 2 && parts[0] === "Bearer") {
                    token = parts[1];
                }
            }

            if (!token) {
                return next(new Error("Authentication error: Token is required"));
            }

            const decoded = jwt.verify(token, JWT_SECRET);
            if (!decoded || !decoded.userId) {
                return next(new Error("Authentication error: Invalid token"));
            }

            let user = null;
            if (isMongoActive() && mongoose.Types.ObjectId.isValid(decoded.userId)) {
                try {
                    user = await User.findById(decoded.userId).select("_id name email teachSkills learnSkills");
                } catch {
                    user = null;
                }
            }
            if (!user) {
                user = memoryStore.findUserById(decoded.userId);
            }

            if (!user) {
                return next(new Error("Authentication error: User does not exist"));
            }

            socket.userId = user._id.toString();
            socket.user = user;
            socket.joinedSessions = new Set();
            next();
        } catch (err) {
            console.error("Socket authentication error:", err.message);
            next(new Error("Authentication error: " + err.message));
        }
    });

    io.on("connection", (socket) => {
        const userId = socket.userId;
        console.log(`🔌 User connected to socket: ${socket.user.name} (${userId})`);

        // Register user socket
        if (!userSockets.has(userId)) {
            userSockets.set(userId, new Set());
        }
        userSockets.get(userId).add(socket.id);

        // Join personal room for direct notifications
        socket.join("user_" + userId);

        // Broadcast to all connected clients that this user is online
        io.emit("userStatusChanged", { userId, online: true });

        // Handler to check online status of specific users
        socket.on("getOnlineUsers", (userIds, callback) => {
            if (typeof callback === "function" && Array.isArray(userIds)) {
                const statusMap = {};
                userIds.forEach(id => {
                    const idStr = id?.toString();
                    statusMap[idStr] = userSockets.has(idStr) && userSockets.get(idStr).size > 0;
                });
                callback(statusMap);
            }
        });

        // ==========================================
        // 1-ON-1 PERSISTENT CHAT EVENTS (chat.html)
        // ==========================================

        socket.on("sendMessage", async (data, callback) => {
            try {
                const { connectionId, receiverId, message } = data || {};

                if (!connectionId || !receiverId || !message || !message.trim()) {
                    const errRes = { success: false, message: "Invalid message payload" };
                    if (typeof callback === "function") callback(errRes);
                    return socket.emit("chatError", errRes);
                }

                let connection = null;
                if (isMongoActive() && mongoose.Types.ObjectId.isValid(connectionId)) {
                    try {
                        connection = await Connection.findById(connectionId);
                    } catch {
                        connection = null;
                    }
                }
                if (!connection) {
                    connection = memoryStore.getConnectionById(connectionId);
                }

                if (!connection) {
                    const errRes = { success: false, message: "Connection not found" };
                    if (typeof callback === "function") callback(errRes);
                    return socket.emit("chatError", errRes);
                }

                if (connection.status !== "accepted") {
                    const errRes = { success: false, message: "Cannot send message: Connection is not accepted" };
                    if (typeof callback === "function") callback(errRes);
                    return socket.emit("chatError", errRes);
                }

                const senderId = socket.userId;
                const p1 = extractId(connection.sender);
                const p2 = extractId(connection.receiver);

                const isSenderParticipant = (senderId === p1 || senderId === p2);
                const isReceiverParticipant = (receiverId.toString() === p1 || receiverId.toString() === p2);
                const isDistinct = (senderId !== receiverId.toString());

                if (!isSenderParticipant || !isReceiverParticipant || !isDistinct) {
                    const errRes = { success: false, message: "Unauthorized: You do not belong to this connection" };
                    if (typeof callback === "function") callback(errRes);
                    return socket.emit("chatError", errRes);
                }

                let populatedMessage = null;
                if (isMongoActive()) {
                    try {
                        const savedMessage = await Message.create({
                            sender: senderId,
                            receiver: receiverId,
                            connection: connectionId,
                            message: message.trim(),
                            read: false
                        });
                        populatedMessage = await Message.findById(savedMessage._id)
                            .populate("sender", "name email")
                            .populate("receiver", "name email");
                    } catch {
                        populatedMessage = null;
                    }
                }

                if (!populatedMessage) {
                    populatedMessage = memoryStore.createMessage(senderId, receiverId, connectionId, message.trim());
                }

                io.to("user_" + receiverId).emit("receiveMessage", populatedMessage);
                socket.emit("messageSent", populatedMessage);

                if (typeof callback === "function") {
                    callback({ success: true, message: populatedMessage });
                }
            } catch (err) {
                console.error("Error in sendMessage socket event:", err);
                const errRes = { success: false, message: "Failed to send message" };
                if (typeof callback === "function") callback(errRes);
                socket.emit("chatError", errRes);
            }
        });

        socket.on("markAsRead", async (data) => {
            try {
                const { connectionId } = data || {};
                if (!connectionId) return;

                let connection = null;
                if (isMongoActive() && mongoose.Types.ObjectId.isValid(connectionId)) {
                    try {
                        connection = await Connection.findById(connectionId);
                    } catch {
                        connection = null;
                    }
                }
                if (!connection) {
                    connection = memoryStore.getConnectionById(connectionId);
                }
                if (!connection || connection.status !== "accepted") return;

                const currentUserId = socket.userId;
                const p1 = extractId(connection.sender);
                const p2 = extractId(connection.receiver);
                if (currentUserId !== p1 && currentUserId !== p2) return;

                const otherUserId = (p1 === currentUserId) ? p2 : p1;

                if (isMongoActive()) {
                    await Message.updateMany(
                        { connection: connectionId, receiver: currentUserId, read: false },
                        { $set: { read: true } }
                    );
                } else {
                    memoryStore.markMessagesAsRead(connectionId, currentUserId);
                }

                io.to("user_" + otherUserId).emit("messagesRead", {
                    connectionId,
                    readerId: currentUserId
                });
            } catch (err) {
                console.error("Error in markAsRead socket event:", err);
            }
        });

        socket.on("typing", (data) => {
            const { receiverId, connectionId, isTyping } = data || {};
            if (receiverId) {
                io.to("user_" + receiverId).emit("userTyping", {
                    senderId: socket.userId,
                    connectionId,
                    isTyping
                });
            }
        });

        // ==========================================
        // LIVE SESSION ROOM, PRESENCE & WEBRTC SIGNALING
        // ==========================================

        socket.on("joinSession", async ({ sessionId } = {}, callback) => {
            try {
                const authCheck = await fetchAuthorizedSession(sessionId, socket.userId);
                if (authCheck.error) {
                    if (typeof callback === "function") {
                        callback({ success: false, message: authCheck.error, code: authCheck.code });
                    }
                    return;
                }

                const { session, hostId, participantId } = authCheck;
                const sId = extractId(session._id || sessionId);
                const currentUserId = socket.userId;
                const roomName = "session_" + sId;

                socket.join(roomName);
                socket.joinedSessions.add(sId);

                // Initialize authoritative room participant map if needed
                if (!sessionRooms.has(sId)) {
                    const map = new Map();
                    const hostName = (session.host && session.host.name) ? session.host.name : "Host";
                    const partName = (session.participant && session.participant.name) ? session.participant.name : "Participant";
                    map.set(hostId, {
                        userId: hostId,
                        name: hostName,
                        role: "host",
                        status: "offline",
                        joinedAt: null,
                        lastSeenAt: null,
                        socketIds: new Set()
                    });
                    map.set(participantId, {
                        userId: participantId,
                        name: partName,
                        role: "participant",
                        status: "offline",
                        joinedAt: null,
                        lastSeenAt: null,
                        socketIds: new Set()
                    });
                    sessionRooms.set(sId, map);
                }

                const roomMap = sessionRooms.get(sId);
                const now = new Date().toISOString();
                let entry = roomMap.get(currentUserId);
                if (!entry) {
                    entry = {
                        userId: currentUserId,
                        name: socket.user.name,
                        role: currentUserId === hostId ? "host" : "participant",
                        status: "online",
                        joinedAt: now,
                        lastSeenAt: now,
                        socketIds: new Set()
                    };
                    roomMap.set(currentUserId, entry);
                }

                const wasOffline = entry.status !== "online" || entry.socketIds.size === 0;
                entry.name = socket.user.name;
                entry.status = "online";
                entry.joinedAt = entry.joinedAt || now;
                entry.lastSeenAt = now;
                entry.socketIds.add(socket.id);

                const participants = serializeParticipants(sId);

                // Notify peers in the session room
                socket.to(roomName).emit("sessionUserJoined", {
                    sessionId: sId,
                    userId: currentUserId,
                    userName: socket.user.name,
                    role: entry.role,
                    reconnected: !wasOffline ? false : true,
                    socketId: socket.id
                });

                // Broadcast authoritative participant list to everyone in the room (including joiner)
                io.to(roomName).emit("sessionParticipantsUpdated", {
                    sessionId: sId,
                    participants
                });

                if (typeof callback === "function") {
                    callback({
                        success: true,
                        session,
                        participants,
                        userId: currentUserId,
                        userName: socket.user.name
                    });
                }
            } catch (err) {
                console.error("Error in joinSession:", err);
                if (typeof callback === "function") {
                    callback({ success: false, message: "Server error joining session" });
                }
            }
        });

        // Session-scoped real-time live chat message
        socket.on("sendSessionMessage", async (data, callback) => {
            try {
                const { sessionId, message, clientMessageId } = data || {};
                const trimmedText = typeof message === "string" ? message.trim() : "";

                if (!sessionId || !trimmedText) {
                    const errRes = { success: false, message: "Session ID and message text are required" };
                    if (typeof callback === "function") callback(errRes);
                    return;
                }

                if (trimmedText.length > 4000) {
                    const errRes = { success: false, message: "Message exceeds 4000 characters limit" };
                    if (typeof callback === "function") callback(errRes);
                    return;
                }

                const authCheck = await fetchAuthorizedSession(sessionId, socket.userId);
                if (authCheck.error) {
                    const errRes = { success: false, message: authCheck.error, code: authCheck.code };
                    if (typeof callback === "function") callback(errRes);
                    return;
                }

                const { session, hostId, participantId, connectionId } = authCheck;
                const sId = extractId(session._id || sessionId);
                const senderId = socket.userId;
                const receiverId = senderId === hostId ? participantId : hostId;
                const cleanClientId = clientMessageId ? String(clientMessageId).slice(0, 128) : null;

                // Ensure sender socket is in the session room
                const roomName = "session_" + sId;
                if (!socket.joinedSessions.has(sId)) {
                    socket.join(roomName);
                    socket.joinedSessions.add(sId);
                }

                let populatedMessage = null;
                let duplicate = false;

                if (isMongoActive()) {
                    try {
                        if (cleanClientId) {
                            const existing = await Message.findOne({
                                sessionId: sId,
                                sender: senderId,
                                clientMessageId: cleanClientId
                            })
                                .populate("sender", "name email")
                                .populate("receiver", "name email");

                            if (existing) {
                                populatedMessage = existing;
                                duplicate = true;
                            }
                        }

                        if (!populatedMessage) {
                            const saved = await Message.create({
                                sender: senderId,
                                receiver: receiverId,
                                connection: connectionId,
                                sessionId: sId,
                                clientMessageId: cleanClientId,
                                message: trimmedText,
                                read: false
                            });
                            populatedMessage = await Message.findById(saved._id)
                                .populate("sender", "name email")
                                .populate("receiver", "name email");
                        }
                    } catch (dbErr) {
                        console.error("Mongo sendSessionMessage error:", dbErr.message);
                        populatedMessage = null;
                    }
                } else {
                    if (cleanClientId) {
                        const existing = memoryStore.findSessionMessageByClientId(sId, senderId, cleanClientId);
                        if (existing) {
                            populatedMessage = existing;
                            duplicate = true;
                        }
                    }
                    if (!populatedMessage) {
                        populatedMessage = memoryStore.createMessage(senderId, receiverId, connectionId, trimmedText, {
                            sessionId: sId,
                            clientMessageId: cleanClientId
                        });
                    }
                }

                if (!populatedMessage) {
                    const errRes = { success: false, message: "Failed to persist session message" };
                    if (typeof callback === "function") callback(errRes);
                    return;
                }

                // Emit strictly to this session's room only (never across sessions)
                if (!duplicate) {
                    io.to(roomName).emit("sessionMessage", populatedMessage);
                }

                if (typeof callback === "function") {
                    callback({ success: true, duplicate, message: populatedMessage });
                }
            } catch (err) {
                console.error("Error in sendSessionMessage:", err);
                const errRes = { success: false, message: "Failed to send session message" };
                if (typeof callback === "function") callback(errRes);
            }
        });

        socket.on("sessionTyping", ({ sessionId, isTyping } = {}) => {
            if (!sessionId) return;
            const sId = String(sessionId);
            if (!socket.joinedSessions.has(sId)) return;
            socket.to("session_" + sId).emit("sessionUserTyping", {
                sessionId: sId,
                userId: socket.userId,
                userName: socket.user.name,
                isTyping: !!isTyping
            });
        });

        socket.on("webrtcOffer", ({ sessionId, offer }) => {
            if (!sessionId || !offer) return;
            const sId = String(sessionId);
            if (!socket.joinedSessions.has(sId)) return;
            socket.to("session_" + sId).emit("webrtcOffer", {
                sessionId: sId,
                offer,
                senderId: socket.userId,
                senderName: socket.user.name
            });
        });

        socket.on("webrtcAnswer", ({ sessionId, answer }) => {
            if (!sessionId || !answer) return;
            const sId = String(sessionId);
            if (!socket.joinedSessions.has(sId)) return;
            socket.to("session_" + sId).emit("webrtcAnswer", {
                sessionId: sId,
                answer,
                senderId: socket.userId
            });
        });

        socket.on("iceCandidate", ({ sessionId, candidate }) => {
            if (!sessionId || !candidate) return;
            const sId = String(sessionId);
            if (!socket.joinedSessions.has(sId)) return;
            socket.to("session_" + sId).emit("iceCandidate", {
                sessionId: sId,
                candidate,
                senderId: socket.userId
            });
        });

        socket.on("webrtcRequestReconnect", ({ sessionId } = {}) => {
            if (!sessionId) return;
            const sId = String(sessionId);
            if (!socket.joinedSessions.has(sId)) return;
            socket.to("session_" + sId).emit("webrtcRequestReconnect", {
                sessionId: sId,
                senderId: socket.userId,
                senderName: socket.user.name
            });
        });

        socket.on("mediaToggle", ({ sessionId, type, enabled }) => {
            if (!sessionId) return;
            const sId = String(sessionId);
            if (!socket.joinedSessions.has(sId)) return;
            socket.to("session_" + sId).emit("userMediaToggled", {
                sessionId: sId,
                userId: socket.userId,
                type,
                enabled
            });
        });

        socket.on("leaveSession", ({ sessionId } = {}, callback) => {
            if (!sessionId) {
                if (typeof callback === "function") callback({ success: false });
                return;
            }
            const sId = String(sessionId);
            const roomName = "session_" + sId;

            socket.joinedSessions.delete(sId);
            socket.leave(roomName);

            const roomMap = sessionRooms.get(sId);
            if (roomMap && roomMap.has(userId)) {
                const entry = roomMap.get(userId);
                entry.socketIds.delete(socket.id);
                entry.lastSeenAt = new Date().toISOString();
                if (entry.socketIds.size === 0) {
                    entry.status = "offline";
                    socket.to(roomName).emit("sessionUserLeft", {
                        sessionId: sId,
                        userId: socket.userId,
                        userName: socket.user.name
                    });
                    io.to(roomName).emit("sessionParticipantsUpdated", {
                        sessionId: sId,
                        participants: serializeParticipants(sId)
                    });
                }
            } else {
                socket.to(roomName).emit("sessionUserLeft", {
                    sessionId: sId,
                    userId: socket.userId,
                    userName: socket.user.name
                });
            }

            if (typeof callback === "function") callback({ success: true });
        });

        // ==========================================
        // DISCONNECT
        // ==========================================
        socket.on("disconnect", (reason) => {
            console.log(`🔌 User disconnected: ${socket.user?.name} (${userId}) [${reason}]`);

            // Notify any active live session rooms this socket was participating in
            for (const sId of socket.joinedSessions) {
                const roomName = "session_" + sId;
                const roomMap = sessionRooms.get(sId);
                if (roomMap && roomMap.has(userId)) {
                    const entry = roomMap.get(userId);
                    entry.socketIds.delete(socket.id);
                    entry.lastSeenAt = new Date().toISOString();
                    if (entry.socketIds.size === 0) {
                        entry.status = "disconnected";
                        io.to(roomName).emit("sessionUserDisconnected", {
                            sessionId: sId,
                            userId,
                            userName: socket.user?.name || "Participant"
                        });
                        io.to(roomName).emit("sessionParticipantsUpdated", {
                            sessionId: sId,
                            participants: serializeParticipants(sId)
                        });
                    }
                }
            }
            socket.joinedSessions.clear();

            const sockets = userSockets.get(userId);
            if (sockets) {
                sockets.delete(socket.id);
                if (sockets.size === 0) {
                    userSockets.delete(userId);
                    io.emit("userStatusChanged", { userId, online: false });
                }
            }
        });
    });

    return {
        isUserOnline: (uid) => {
            const uidStr = uid?.toString();
            return userSockets.has(uidStr) && userSockets.get(uidStr).size > 0;
        },
        getSessionParticipants: serializeParticipants,
        clearSessionRoom
    };
}

module.exports = { setupSocketIO, JWT_SECRET, clearSessionRoom };

