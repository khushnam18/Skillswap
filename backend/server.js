const express = require("express");                              
const mongoose = require("mongoose");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const dotenv = require("dotenv");
for (const envPath of [path.join(__dirname, ".env"), path.join(__dirname, "../.env")]) {
    const result = dotenv.config({ path: envPath });
    if (result && result.parsed) {
        for (const [key, val] of Object.entries(result.parsed)) {
            if (val !== "" && val !== undefined) {
                process.env[key] = val;
            }
        }
    }
}

const cors = require("cors");                             //cors ko import/load kar rahe hain, taaki frontend aur backend ke beech request allow ho sake
const User = require("./userModel"); 
const Connection = require("./connectionModel");
const Message = require("./messageModel");
const LiveSession = require("./liveSessionModel");
const Review = require("./reviewModel");
const Assessment = require("./assessmentModel");
const LearningImpact = require("./learningImpactModel");
const { skillAssessmentService } = require("./skillAssessmentService");
const { learningImpactService } = require("./learningImpactService");
const { setupSocketIO, JWT_SECRET } = require("./socketHandler");
const { memoryStore, seedData, isMongoActive } = require("./memoryStore");

const PORT = process.env.APP_PORT || 3000;
const app = express();

app.use(cors());

// JSON data receive karne ke liye
app.use(express.json());

// Serve static frontend files
app.use(express.static(path.join(__dirname, "../frontend")));

// Create HTTP server and initialize Socket.IO
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST", "PUT"]
    },
    transports: ["websocket", "polling"],
    pingTimeout: 25000,
    pingInterval: 10000,
    allowEIO3: true
});

// Setup Socket.IO real-time handlers
const socketManager = setupSocketIO(io);

// Authentication Middleware for Protected REST APIs
const verifyAuth = async (req, res, next) => {
    try {
        let token = req.headers.authorization;
        if (token && token.startsWith("Bearer ")) {
            token = token.slice(7).trim();
        }
        if (!token && req.query.token) {
            token = req.query.token;
        }

        if (!token) {
            return res.status(401).json({
                message: "Authentication required. Please login."
            });
        }

        const decoded = jwt.verify(token, JWT_SECRET);
        if (!decoded || !decoded.userId) {
            return res.status(401).json({
                message: "Invalid or expired token. Please login again."
            });
        }

        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({
            message: "Authentication failed: " + err.message
        });
    }
};

//connection request api/route.//yeha is POST route ka kaam connection request bhejna hai.
app.post("/api/connections", async (req, res) => {
    try {
        const { sender, receiver } = req.body;

        if (isMongoActive()) {
            const existingConnection = await Connection.findOne({
                sender,
                receiver
            });

            if (existingConnection) {
                return res.status(400).json({
                    message: "Connection request already sent."
                });
            }

            const connection = new Connection({
                sender,
                receiver
            });

            await connection.save();

            return res.json({
                message: "Connection request sent successfully!",
                connection
            });
        }

        const result = memoryStore.createConnection(sender, receiver);
        if (result.error) {
            return res.status(400).json({ message: result.error });
        }
        res.json({
            message: "Connection request sent successfully!",
            connection: result.connection
        });

    } catch (error) {
        console.log(error.message);

        res.status(500).json({
            message: "Failed to send connection request"
        });
    }
});

//Ye route check karta hai ki kisi user ko connection request kis-kis ne bheji hai.
app.get("/api/connections/:userId", async (req, res) => {
    try {
        if (isMongoActive()) {
            const connections = await Connection.find({
                receiver: req.params.userId
            }).populate("sender", "name email");

            return res.json(connections);
        }

        const connections = memoryStore.getUserConnections(req.params.userId);
        res.json(connections);

    } catch (error) {
        console.log(error.message);

        res.status(500).json({
            message: "Failed to fetch connection requests"
        });
    }
});

//Accept/Reject button ko backend se working banayega yeh part.
app.put("/api/connections/:id", async (req, res) => {
    try {
        const { status } = req.body;

        if (isMongoActive()) {
            const connection = await Connection.findByIdAndUpdate(
                req.params.id,
                { status },
                { new: true }
            );

            return res.json({
                message: `Connection ${status} successfully!`,
                connection
            });
        }

        const connection = memoryStore.updateConnectionStatus(req.params.id, status);
        res.json({
            message: `Connection ${status} successfully!`,
            connection
        });

    } catch (error) {
        console.log(error.message);

        res.status(500).json({
            message: "Failed to update connection"
        });
    }
});

//Accepted Connections ki API banayenge(Ye sirf accepted connections nikalega..Aur user chahe sender ho ya receiver, dono situations mein connection milega.)
app.get("/api/accepted-connections/:userId", async (req, res) => {
    try {
        const userId = req.params.userId;

        if (isMongoActive()) {
            const connections = await Connection.find({
                status: "accepted",
                $or: [
                    { sender: userId },
                    { receiver: userId }
                ]
            })
            .populate("sender", "name email teachSkills learnSkills bio location")
            .populate("receiver", "name email teachSkills learnSkills bio location");

            return res.json(connections);
        }

        const connections = memoryStore.getAcceptedConnections(userId);
        res.json(connections);

    } catch (error) {
        console.log(error.message);

        res.status(500).json({
            message: "Failed to fetch accepted connections"
        });
    }
});

// ==========================================
// REST APIS FOR REAL-TIME CHAT (MESSAGES)
// ==========================================

// Get message history for a connection (strictly authorized)
app.get("/api/messages/:connectionId", verifyAuth, async (req, res) => {
    try {
        const { connectionId } = req.params;
        const currentUserId = req.user.userId;

        let connection = null;
        if (isMongoActive()) {
            connection = await Connection.findById(connectionId);
        } else {
            connection = memoryStore.getConnectionById(connectionId);
        }

        if (!connection) {
            return res.status(404).json({ message: "Connection not found" });
        }

        if (connection.status !== "accepted") {
            return res.status(403).json({ message: "Cannot view messages: Connection is not accepted" });
        }

        const sId = (connection.sender._id || connection.sender).toString();
        const rId = (connection.receiver._id || connection.receiver).toString();

        if (sId !== currentUserId && rId !== currentUserId) {
            return res.status(403).json({ message: "Unauthorized to access messages for this connection" });
        }

        if (isMongoActive()) {
            const messages = await Message.find({ connection: connectionId })
                .sort({ createdAt: 1 })
                .populate("sender", "name email")
                .populate("receiver", "name email");

            return res.json(messages);
        }

        const messages = memoryStore.getMessages(connectionId);
        res.json(messages);
    } catch (error) {
        console.log(error.message);
        res.status(500).json({ message: "Failed to fetch messages" });
    }
});

// Mark messages in connection as read for the logged-in user
app.put("/api/messages/read/:connectionId", verifyAuth, async (req, res) => {
    try {
        const { connectionId } = req.params;
        const currentUserId = req.user.userId;

        let connection = null;
        if (isMongoActive()) {
            connection = await Connection.findById(connectionId);
        } else {
            connection = memoryStore.getConnectionById(connectionId);
        }

        if (!connection || connection.status !== "accepted") {
            return res.status(403).json({ message: "Unauthorized or invalid connection" });
        }

        const sId = (connection.sender._id || connection.sender).toString();
        const rId = (connection.receiver._id || connection.receiver).toString();

        if (sId !== currentUserId && rId !== currentUserId) {
            return res.status(403).json({ message: "Unauthorized" });
        }

        if (isMongoActive()) {
            await Message.updateMany(
                { connection: connectionId, receiver: currentUserId, read: false },
                { $set: { read: true } }
            );
        } else {
            memoryStore.markMessagesAsRead(connectionId, currentUserId);
        }

        res.json({ message: "Messages marked as read" });
    } catch (error) {
        console.log(error.message);
        res.status(500).json({ message: "Failed to update read status" });
    }
});

// ==========================================
// REST APIS FOR LIVE SESSIONS (WEBRTC & LIVE CHAT)
// ==========================================

const pendingSessionCreations = new Map();

function extractId(val) {
    if (!val) return "";
    if (typeof val === "object" && val._id) return val._id.toString();
    return val.toString();
}

// Get WebRTC ICE servers (STUN + optional TURN relay from env)
app.get("/api/live-sessions/ice-servers", verifyAuth, async (req, res) => {
    const iceServers = [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
        { urls: "stun:stun2.l.google.com:19302" },
        { urls: "stun:stun.cloudflare.com:3478" }
    ];

    if (process.env.TURN_URLS && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
        const urls = process.env.TURN_URLS.split(",").map(u => u.trim()).filter(Boolean);
        if (urls.length > 0) {
            iceServers.push({
                urls,
                username: process.env.TURN_USERNAME,
                credential: process.env.TURN_CREDENTIAL
            });
        }
    } else if (process.env.METERED_DOMAIN && process.env.METERED_SECRET_KEY) {
        try {
            const resp = await fetch(`https://${process.env.METERED_DOMAIN}/api/v1/turn/credentials?apiKey=${encodeURIComponent(process.env.METERED_SECRET_KEY)}`);
            if (resp.ok) {
                const meteredServers = await resp.json();
                if (Array.isArray(meteredServers)) {
                    iceServers.push(...meteredServers);
                }
            }
        } catch (err) {
            console.warn("Metered TURN lookup skipped:", err.message);
        }
    }

    res.json({ iceServers });
});

// Get all active live sessions for the logged-in user (discovery)
app.get("/api/live-sessions", verifyAuth, async (req, res) => {
    try {
        const currentUserId = req.user.userId;

        if (isMongoActive()) {
            const sessions = await LiveSession.find({
                status: "live",
                $or: [{ host: currentUserId }, { participant: currentUserId }]
            })
                .sort({ startedAt: -1 })
                .populate("host", "name email teachSkills learnSkills")
                .populate("participant", "name email teachSkills learnSkills")
                .populate("connectionId");

            const enriched = sessions.map(s => {
                const obj = s.toObject();
                obj.participants = socketManager.getSessionParticipants(s._id);
                return obj;
            });

            return res.json(enriched);
        }

        const sessions = memoryStore.getActiveLiveSessionsForUser(currentUserId).map(s => ({
            ...s,
            participants: socketManager.getSessionParticipants(s._id)
        }));
        res.json(sessions);
    } catch (error) {
        console.log("Fetch active live sessions error:", error.message);
        res.status(500).json({ message: "Failed to fetch live sessions" });
    }
});

// Create or get active live session for an accepted connection
app.post("/api/live-sessions", verifyAuth, async (req, res) => {
    try {
        const { connectionId, participantId, skillTopic } = req.body;
        const currentUserId = req.user.userId;

        if (!connectionId || !participantId) {
            return res.status(400).json({ message: "connectionId and participantId are required" });
        }

        if (isMongoActive() && (!mongoose.Types.ObjectId.isValid(connectionId) || !mongoose.Types.ObjectId.isValid(participantId))) {
            return res.status(400).json({ message: "Invalid connectionId or participantId" });
        }

        let connection = null;
        if (isMongoActive()) {
            connection = await Connection.findById(connectionId);
        } else {
            connection = memoryStore.getConnectionById(connectionId);
        }

        if (!connection) {
            return res.status(404).json({ message: "Connection not found" });
        }

        if (connection.status !== "accepted") {
            return res.status(403).json({ message: "Cannot start session: Connection is not accepted" });
        }

        const p1 = extractId(connection.sender);
        const p2 = extractId(connection.receiver);

        const isSender = (currentUserId === p1 || currentUserId === p2);
        const isReceiver = (String(participantId) === p1 || String(participantId) === p2);

        if (!isSender || !isReceiver || currentUserId === String(participantId)) {
            return res.status(403).json({ message: "Unauthorized: Invalid session participants" });
        }

        const lockKey = String(connectionId);
        while (pendingSessionCreations.has(lockKey)) {
            await pendingSessionCreations.get(lockKey);
        }

        let resolveLock;
        const lockPromise = new Promise(resolve => { resolveLock = resolve; });
        pendingSessionCreations.set(lockKey, lockPromise);

        try {
            let activeSession = null;
            let created = false;

            if (isMongoActive()) {
                activeSession = await LiveSession.findOne({
                    connectionId,
                    status: "live"
                })
                    .populate("host", "name email teachSkills learnSkills")
                    .populate("participant", "name email teachSkills learnSkills")
                    .populate("connectionId");

                if (!activeSession) {
                    const newDoc = await LiveSession.create({
                        host: currentUserId,
                        participant: participantId,
                        connectionId,
                        skillTopic: typeof skillTopic === "string" ? skillTopic.trim() : "",
                        status: "live",
                        startedAt: new Date()
                    });

                    activeSession = await LiveSession.findById(newDoc._id)
                        .populate("host", "name email teachSkills learnSkills")
                        .populate("participant", "name email teachSkills learnSkills")
                        .populate("connectionId");
                    created = true;
                }
            } else {
                const result = memoryStore.createOrGetLiveSession(connectionId, currentUserId, participantId, skillTopic || "");
                activeSession = result.session;
                created = result.created;
            }

            if (created && activeSession) {
                const payload = { session: activeSession };
                io.to("user_" + currentUserId).emit("liveSessionStarted", payload);
                io.to("user_" + String(participantId)).emit("liveSessionStarted", payload);
            }

            return res.status(200).json({
                message: created ? "Live session created" : "Live session ready",
                created,
                session: activeSession
            });
        } finally {
            pendingSessionCreations.delete(lockKey);
            resolveLock();
        }
    } catch (error) {
        console.log(error.message);
        res.status(500).json({ message: "Failed to initialize live session" });
    }
});

// Explicit join validation endpoint for an existing live session
app.post("/api/live-sessions/:id/join", verifyAuth, async (req, res) => {
    try {
        const currentUserId = req.user.userId;
        const sessionId = req.params.id;

        if (isMongoActive() && !mongoose.Types.ObjectId.isValid(sessionId)) {
            return res.status(404).json({ message: "Live session not found" });
        }

        let session = null;
        if (isMongoActive()) {
            session = await LiveSession.findById(sessionId)
                .populate("host", "name email teachSkills learnSkills")
                .populate("participant", "name email teachSkills learnSkills")
                .populate("connectionId");
        } else {
            session = memoryStore.getLiveSessionById(sessionId);
        }

        if (!session) {
            return res.status(404).json({ message: "Live session not found" });
        }

        const hostId = extractId(session.host);
        const participantId = extractId(session.participant);

        if (hostId !== currentUserId && participantId !== currentUserId) {
            return res.status(403).json({ message: "Unauthorized to join this live session" });
        }

        if (session.status === "completed" || session.status === "cancelled") {
            return res.status(400).json({ message: "This live session has already ended", session });
        }

        const sessionObj = typeof session.toObject === "function" ? session.toObject() : { ...session };
        sessionObj.participants = socketManager.getSessionParticipants(session._id || sessionId);

        res.json({
            message: "Authorized to join live session",
            session: sessionObj,
            participants: sessionObj.participants
        });
    } catch (error) {
        console.log("Join live session error:", error.message);
        res.status(500).json({ message: "Failed to join live session" });
    }
});

// Get live session details
app.get("/api/live-sessions/:id", verifyAuth, async (req, res) => {
    try {
        const currentUserId = req.user.userId;
        const sessionId = req.params.id;

        if (isMongoActive() && !mongoose.Types.ObjectId.isValid(sessionId)) {
            return res.status(404).json({ message: "Live session not found" });
        }

        let session = null;
        if (isMongoActive()) {
            session = await LiveSession.findById(sessionId)
                .populate("host", "name email teachSkills learnSkills")
                .populate("participant", "name email teachSkills learnSkills")
                .populate("connectionId");
        } else {
            session = memoryStore.getLiveSessionById(sessionId);
        }

        if (!session) {
            return res.status(404).json({ message: "Live session not found" });
        }

        const hostId = extractId(session.host);
        const participantId = extractId(session.participant);

        if (hostId !== currentUserId && participantId !== currentUserId) {
            return res.status(403).json({ message: "Unauthorized to access this session" });
        }

        const sessionObj = typeof session.toObject === "function" ? session.toObject() : { ...session };
        sessionObj.participants = socketManager.getSessionParticipants(session._id || sessionId);

        res.json(sessionObj);
    } catch (error) {
        console.log(error.message);
        res.status(500).json({ message: "Failed to fetch live session" });
    }
});

// Get chat history strictly scoped to a specific live session
app.get("/api/live-sessions/:id/messages", verifyAuth, async (req, res) => {
    try {
        const currentUserId = req.user.userId;
        const sessionId = req.params.id;

        if (isMongoActive() && !mongoose.Types.ObjectId.isValid(sessionId)) {
            return res.status(404).json({ message: "Live session not found" });
        }

        let session = null;
        if (isMongoActive()) {
            session = await LiveSession.findById(sessionId);
        } else {
            session = memoryStore.getLiveSessionById(sessionId);
        }

        if (!session) {
            return res.status(404).json({ message: "Live session not found" });
        }

        const hostId = extractId(session.host);
        const participantId = extractId(session.participant);

        if (hostId !== currentUserId && participantId !== currentUserId) {
            return res.status(403).json({ message: "Unauthorized to view messages for this live session" });
        }

        if (isMongoActive()) {
            const messages = await Message.find({ sessionId })
                .sort({ createdAt: 1 })
                .populate("sender", "name email")
                .populate("receiver", "name email");
            return res.json(messages);
        }

        const messages = memoryStore.getSessionMessages(sessionId);
        res.json(messages);
    } catch (error) {
        console.log("Fetch session messages error:", error.message);
        res.status(500).json({ message: "Failed to fetch live session messages" });
    }
});

// End live session (Host-authoritative: ends session for all participants)
app.put("/api/live-sessions/:id/end", verifyAuth, async (req, res) => {
    try {
        const currentUserId = req.user.userId;
        const sessionId = req.params.id;

        if (isMongoActive() && !mongoose.Types.ObjectId.isValid(sessionId)) {
            return res.status(404).json({ message: "Live session not found" });
        }

        let session = null;
        let hostId = "";
        let participantId = "";

        if (isMongoActive()) {
            session = await LiveSession.findById(sessionId);
            if (!session) {
                return res.status(404).json({ message: "Live session not found" });
            }

            hostId = extractId(session.host);
            participantId = extractId(session.participant);

            if (hostId !== currentUserId) {
                return res.status(403).json({ message: "Only the session host can end the session for all participants" });
            }

            if (session.status === "completed") {
                return res.json({ message: "Live session already completed", session });
            }

            session.status = "completed";
            session.endedAt = new Date();
            await session.save();
        } else {
            session = memoryStore.getLiveSessionById(sessionId);
            if (!session) {
                return res.status(404).json({ message: "Live session not found" });
            }

            hostId = extractId(session.host);
            participantId = extractId(session.participant);

            if (hostId !== currentUserId) {
                return res.status(403).json({ message: "Only the session host can end the session for all participants" });
            }

            if (session.status === "completed") {
                return res.json({ message: "Live session already completed", session });
            }

            session = memoryStore.endLiveSession(sessionId);
        }

        const resolvedId = extractId(session._id || sessionId);
        const endPayload = {
            sessionId: resolvedId,
            endedBy: currentUserId,
            endedAt: session.endedAt || new Date()
        };

        io.to("session_" + resolvedId).emit("sessionEnded", endPayload);
        io.to("user_" + hostId).emit("sessionEnded", endPayload);
        io.to("user_" + participantId).emit("sessionEnded", endPayload);
        socketManager.clearSessionRoom(resolvedId);

        res.json({ message: "Live session ended successfully", session });
    } catch (error) {
        console.log(error.message);
        res.status(500).json({ message: "Failed to end live session" });
    }
});

// ==========================================
// REST APIS FOR REVIEWS & COMMUNITY RATINGS
// ==========================================

// Submit a session review and rating
app.post("/api/reviews", verifyAuth, async (req, res) => {
    try {
        const reviewerId = req.user.userId;
        const { revieweeId, rating, feedback, skillTopic, sessionId, connectionId } = req.body;

        if (!revieweeId) {
            return res.status(400).json({ message: "Reviewee ID is required" });
        }

        if (reviewerId === revieweeId) {
            return res.status(400).json({ message: "You cannot review your own session" });
        }

        const numericRating = Math.max(1, Math.min(5, Number(rating) || 5));

        if (isMongoActive()) {
            const review = new Review({
                reviewer: reviewerId,
                reviewee: revieweeId,
                sessionId: sessionId || null,
                connectionId: connectionId || null,
                rating: numericRating,
                feedback: (feedback || "").trim(),
                skillTopic: (skillTopic || "Skill Exchange").trim()
            });

            await review.save();
            const populated = await Review.findById(review._id)
                .populate("reviewer", "name email")
                .populate("reviewee", "name email");

            return res.status(201).json({
                message: "Review submitted successfully!",
                review: populated
            });
        }

        const review = memoryStore.createReview({
            reviewerId,
            revieweeId,
            rating: numericRating,
            feedback,
            skillTopic,
            sessionId,
            connectionId
        });

        res.status(201).json({
            message: "Review submitted successfully!",
            review
        });
    } catch (error) {
        console.error("Submit review error:", error.message);
        res.status(500).json({ message: "Failed to submit review" });
    }
});

// Get reviews and aggregated rating stats for a specific user
app.get("/api/reviews/user/:userId", async (req, res) => {
    try {
        const { userId } = req.params;

        if (isMongoActive()) {
            const reviews = await Review.find({ reviewee: userId })
                .sort({ createdAt: -1 })
                .populate("reviewer", "name email")
                .populate("reviewee", "name email");

            const totalReviews = reviews.length;
            const avg = totalReviews > 0
                ? parseFloat((reviews.reduce((acc, r) => acc + r.rating, 0) / totalReviews).toFixed(1))
                : 5.0;

            return res.json({
                averageRating: avg,
                totalReviews,
                reviews
            });
        }

        const stats = memoryStore.getUserRatingStats(userId);
        res.json(stats);
    } catch (error) {
        console.error("Get user reviews error:", error.message);
        res.status(500).json({ message: "Failed to fetch user reviews" });
    }
});

// Get overall platform community rating stats & recent verified reviews
app.get("/api/reviews/community", async (req, res) => {
    try {
        if (isMongoActive()) {
            const reviews = await Review.find()
                .sort({ createdAt: -1 })
                .limit(10)
                .populate("reviewer", "name email")
                .populate("reviewee", "name email");

            const count = await Review.countDocuments();
            const aggregate = await Review.aggregate([
                { $group: { _id: null, avgRating: { $avg: "$rating" } } }
            ]);

            const avg = aggregate.length > 0 && aggregate[0].avgRating
                ? parseFloat(aggregate[0].avgRating.toFixed(1))
                : 5.0;

            const totalSessions = await LiveSession.countDocuments();

            return res.json({
                averageRating: avg,
                totalReviews: count,
                totalSessions,
                recentReviews: reviews
            });
        }

        const globalStats = memoryStore.getGlobalCommunityStats();
        const recentReviews = memoryStore.getAllReviews().slice(0, 10);
        res.json({
            ...globalStats,
            recentReviews
        });
    } catch (error) {
        console.error("Get community stats error:", error.message);
        res.status(500).json({ message: "Failed to fetch community ratings" });
    }
});

// ============================================================================
// AI-POWERED SKILL VERIFICATION ASSESSMENT SYSTEM
// ============================================================================

// 1. Start or generate an assessment for a specific skill
app.post("/api/assessments/start", verifyAuth, async (req, res) => {
    try {
        const { skill } = req.body;
        const userId = req.user.userId;

        if (!skill || typeof skill !== "string" || !skill.trim()) {
            return res.status(400).json({ message: "Valid skill name is required to start an assessment." });
        }

        const trimmedSkill = skill.trim();

        // Verify that the user actually offers to teach this skill
        let user;
        if (isMongoActive()) {
            user = await User.findById(userId);
        } else {
            user = memoryStore.findUserById(userId);
        }

        if (!user) {
            return res.status(404).json({ message: "User not found." });
        }

        const offersSkill = (user.teachSkills || []).some(
            s => s.toLowerCase() === trimmedSkill.toLowerCase()
        );

        if (!offersSkill) {
            return res.status(400).json({
                message: `You do not have '${trimmedSkill}' listed in your teaching skills. Add it to your profile first.`
            });
        }

        // Generate the 6-question benchmark test
        const assessmentPackage = await skillAssessmentService.generateAssessment(trimmedSkill);

        // Store active session token with expiration (45 minutes)
        const sessionId = "sess_" + Date.now() + "_" + Math.random().toString(36).substring(2, 9);
        const sessionPayload = {
            sessionId,
            userId: String(userId),
            skill: trimmedSkill,
            internalBenchmark: assessmentPackage.internalBenchmark,
            proctoringConsent: false,
            startedAt: Date.now()
        };

        memoryStore.startActiveTestSession(sessionId, sessionPayload);

        // Send sanitized questions to client (WITHOUT correctOptionIndex or internal grading criteria)
        res.status(200).json({
            sessionId,
            skill: trimmedSkill,
            title: assessmentPackage.title,
            totalQuestions: assessmentPackage.questions.length,
            questions: assessmentPackage.questions
        });

    } catch (error) {
        console.error("Start assessment error:", error);
        res.status(500).json({ message: "Failed to start skill assessment. Please try again." });
    }
});

// 1b. Telemetry event logging for live proctoring (full-screen exits, visibility changes, camera disconnects)
app.post("/api/assessments/proctoring-event", verifyAuth, async (req, res) => {
    try {
        const { sessionId, eventType, details } = req.body;
        const userId = req.user.userId;

        if (!sessionId || !eventType) {
            return res.status(400).json({ message: "Session ID and event type are required." });
        }

        const activeSession = memoryStore.getActiveTestSession(sessionId);
        if (!activeSession) {
            return res.status(404).json({ message: "Active assessment session not found." });
        }

        if (String(activeSession.userId) !== String(userId)) {
            return res.status(403).json({ message: "Unauthorized: session mismatch." });
        }

        const event = {
            type: eventType,
            timestamp: new Date(),
            details: details || ""
        };

        activeSession.proctoringEvents = activeSession.proctoringEvents || [];
        activeSession.proctoringEvents.push(event);

        if (eventType === "fullscreen_exit") {
            activeSession.fullscreenExitCount = (activeSession.fullscreenExitCount || 0) + 1;
        } else if (eventType === "visibility_hidden") {
            activeSession.visibilityChangeCount = (activeSession.visibilityChangeCount || 0) + 1;
        } else if (eventType === "window_blur") {
            activeSession.windowBlurCount = (activeSession.windowBlurCount || 0) + 1;
        } else if (eventType === "camera_disconnect") {
            activeSession.cameraDisconnectCount = (activeSession.cameraDisconnectCount || 0) + 1;
        } else if (eventType === "session_paused") {
            activeSession.isPaused = true;
        } else if (eventType === "session_resumed") {
            activeSession.isPaused = false;
        }

        memoryStore.updateActiveTestSession(sessionId, activeSession);

        res.status(200).json({
            status: "recorded",
            fullscreenExitCount: activeSession.fullscreenExitCount || 0,
            visibilityChangeCount: activeSession.visibilityChangeCount || 0,
            cameraDisconnectCount: activeSession.cameraDisconnectCount || 0,
            isPaused: activeSession.isPaused || false
        });
    } catch (err) {
        console.error("Proctoring event error:", err);
        res.status(500).json({ message: "Failed to record proctoring telemetry." });
    }
});

// 1c. Generate AI follow-up questions dynamically based on the submitted practical task solution
app.post("/api/assessments/generate-followup", verifyAuth, async (req, res) => {
    try {
        const { sessionId, practicalSolution } = req.body;
        const userId = req.user.userId;

        if (!sessionId || !practicalSolution || typeof practicalSolution !== "string") {
            return res.status(400).json({ message: "Session ID and practical solution code are required." });
        }

        const activeSession = memoryStore.getActiveTestSession(sessionId);
        if (!activeSession) {
            return res.status(404).json({ message: "Active assessment session not found or expired." });
        }

        if (String(activeSession.userId) !== String(userId)) {
            return res.status(403).json({ message: "Unauthorized session access." });
        }

        const questions = activeSession.internalBenchmark.questions || [];
        const practicalQ = questions.find(q => q.type === "practical");
        const taskText = practicalQ ? practicalQ.question : "Practical coding challenge";

        const followUpList = await skillAssessmentService.generateFollowUpQuestions(
            activeSession.skill,
            taskText,
            practicalSolution
        );

        // Store follow-up questions in active test session for later server-side grading
        activeSession.followUpQuestions = followUpList;
        memoryStore.updateActiveTestSession(sessionId, activeSession);

        // Send sanitized questions without expectedKeyConcepts
        const sanitizedFollowUps = followUpList.map(fq => ({
            id: fq.id,
            topic: fq.topic,
            question: fq.question,
            maxPoints: fq.maxPoints
        }));

        res.status(200).json({
            questions: sanitizedFollowUps
        });
    } catch (err) {
        console.error("Generate follow-up error:", err);
        res.status(500).json({ message: "Failed to generate follow-up questions." });
    }
});

// 2. Submit assessment answers for evaluation and persistence
app.post("/api/assessments/submit", verifyAuth, async (req, res) => {
    try {
        const { sessionId, answers, proctoringSummary } = req.body;
        const userId = req.user.userId;

        if (!sessionId || !answers || typeof answers !== "object") {
            return res.status(400).json({ message: "Missing sessionId or answers payload." });
        }

        // Retrieve active test session
        const activeSession = memoryStore.getActiveTestSession(sessionId);
        if (!activeSession) {
            return res.status(400).json({
                message: "Assessment session expired, completed, or invalid. Please start a new assessment."
            });
        }

        // Enforce authorization: only the user who started this session may submit
        if (String(activeSession.userId) !== String(userId)) {
            return res.status(403).json({ message: "Unauthorized: session belongs to another user." });
        }

        // Check for empty answers
        const hasAnswers = Object.keys(answers).length > 0;
        if (!hasAnswers) {
            return res.status(400).json({ message: "Cannot submit empty assessment responses." });
        }

        // Combine server-side verified telemetry with client summary safely
        const verifiedProctoringData = {
            consentGiven: true,
            cameraMonitoringActive: true,
            fullscreenExitCount: Math.max(activeSession.fullscreenExitCount || 0, (proctoringSummary && proctoringSummary.fullscreenExitCount) || 0),
            visibilityChangeCount: Math.max(activeSession.visibilityChangeCount || 0, (proctoringSummary && proctoringSummary.visibilityChangeCount) || 0),
            windowBlurCount: Math.max(activeSession.windowBlurCount || 0, (proctoringSummary && proctoringSummary.windowBlurCount) || 0),
            cameraDisconnectCount: Math.max(activeSession.cameraDisconnectCount || 0, (proctoringSummary && proctoringSummary.cameraDisconnectCount) || 0),
            events: activeSession.proctoringEvents || []
        };

        // Evaluate using weighted 30% MCQ, 50% Practical, 20% Follow-up rubric
        const evaluationResult = await skillAssessmentService.evaluateProctoredAssessment({
            skill: activeSession.skill,
            answers,
            internalBenchmark: activeSession.internalBenchmark,
            followUpQuestions: activeSession.followUpQuestions || [],
            proctoringData: verifiedProctoringData
        });

        // Invalidate active session to prevent duplicate submissions
        memoryStore.deleteActiveTestSession(sessionId);

        // Persist assessment record in database
        let savedAssessment;
        if (isMongoActive()) {
            const assessmentDoc = new Assessment({
                userId,
                skill: activeSession.skill,
                score: evaluationResult.score,
                verificationLevel: evaluationResult.verificationLevel,
                estimatedLevel: evaluationResult.estimatedLevel,
                status: evaluationResult.status,
                breakdown: evaluationResult.breakdown,
                followUpGenerated: (activeSession.followUpQuestions || []).length > 0,
                followUpQuestions: activeSession.followUpQuestions || [],
                proctoring: evaluationResult.proctoring,
                startedAt: new Date(activeSession.startedAt || Date.now()),
                completedAt: new Date(),
                strengths: evaluationResult.strengths,
                areasForImprovement: evaluationResult.areasForImprovement,
                evaluationSummary: evaluationResult.evaluationSummary,
                rubricNote: evaluationResult.rubricNote,
                answersRecord: evaluationResult.answersRecord
            });

            savedAssessment = await assessmentDoc.save();

            // Update user verifiedSkills cache
            const user = await User.findById(userId);
            if (user) {
                user.verifiedSkills = (user.verifiedSkills || []).filter(
                    s => s.skill.toLowerCase() !== activeSession.skill.toLowerCase()
                );
                user.verifiedSkills.push({
                    skill: activeSession.skill,
                    score: evaluationResult.score,
                    estimatedLevel: evaluationResult.estimatedLevel,
                    verificationLevel: evaluationResult.verificationLevel,
                    assessmentId: savedAssessment._id,
                    verifiedAt: new Date()
                });
                await user.save();
            }
        } else {
            savedAssessment = memoryStore.saveAssessment({
                userId,
                skill: activeSession.skill,
                score: evaluationResult.score,
                verificationLevel: evaluationResult.verificationLevel,
                estimatedLevel: evaluationResult.estimatedLevel,
                status: evaluationResult.status,
                breakdown: evaluationResult.breakdown,
                followUpGenerated: (activeSession.followUpQuestions || []).length > 0,
                followUpQuestions: activeSession.followUpQuestions || [],
                proctoring: evaluationResult.proctoring,
                startedAt: new Date(activeSession.startedAt || Date.now()),
                completedAt: new Date(),
                strengths: evaluationResult.strengths,
                areasForImprovement: evaluationResult.areasForImprovement,
                evaluationSummary: evaluationResult.evaluationSummary,
                rubricNote: evaluationResult.rubricNote,
                answersRecord: evaluationResult.answersRecord
            });
        }

        res.status(200).json({
            message: "Live proctored assessment evaluated and recorded successfully!",
            assessment: savedAssessment
        });

    } catch (error) {
        console.error("Submit assessment error:", error);
        res.status(500).json({ message: "Failed to evaluate assessment submission. Please try again." });
    }
});

// 3. Get user's assessment history (protected: only user themselves can view full history)
app.get("/api/assessments/my-history", verifyAuth, async (req, res) => {
    try {
        const userId = req.user.userId;

        if (isMongoActive()) {
            const history = await Assessment.find({ userId }).sort({ createdAt: -1 });
            return res.json(history);
        }

        const history = memoryStore.findAssessmentsByUserId(userId);
        res.json(history);
    } catch (error) {
        console.error("Get assessment history error:", error);
        res.status(500).json({ message: "Failed to fetch assessment history." });
    }
});

// 4. Get public verified skill badges for a mentor (public profile visibility)
app.get("/api/users/:id/verified-skills", async (req, res) => {
    try {
        const targetUserId = req.params.id;

        if (isMongoActive()) {
            const user = await User.findById(targetUserId, "name verifiedSkills teachSkills");
            if (!user) return res.status(404).json({ message: "User not found" });
            return res.json(user.verifiedSkills || []);
        }

        const user = memoryStore.findUserById(targetUserId);
        if (!user) return res.status(404).json({ message: "User not found" });
        res.json(user.verifiedSkills || []);
    } catch (error) {
        console.error("Get user verified skills error:", error);
        res.status(500).json({ message: "Failed to fetch verified skills" });
    }
});

// ============================================================================
// AI LEARNING IMPACT ANALYZER ENDPOINTS (PRE & POST SESSION ASSESSMENTS)
// ============================================================================

// 1. Get or initialize learning impact status for a live session
app.get("/api/learning-impact/session/:sessionId", verifyAuth, async (req, res) => {
    try {
        const { sessionId } = req.params;
        const currentUserId = req.user.userId;

        // Fetch live session
        let session;
        if (isMongoActive()) {
            session = await LiveSession.findById(sessionId)
                .populate("host", "name email teachSkills learnSkills")
                .populate("participant", "name email teachSkills learnSkills");
        } else {
            session = memoryStore.getLiveSessionById(sessionId);
        }

        if (!session) {
            return res.status(404).json({ message: "Live session not found." });
        }

        const hostId = (session.host._id || session.host).toString();
        const participantId = (session.participant._id || session.participant).toString();

        if (hostId !== currentUserId && participantId !== currentUserId) {
            return res.status(403).json({ message: "Access forbidden: you are not a participant in this session." });
        }

        // Host is mentor, participant is learner (or current user if participant)
        const mentorId = hostId;
        const learnerId = participantId;

        // Fetch existing record
        let record;
        if (isMongoActive()) {
            record = await LearningImpact.findOne({ sessionId, learnerId })
                .populate("learnerId", "name email")
                .populate("mentorId", "name email");
        } else {
            record = memoryStore.findLearningImpactBySessionAndLearner(sessionId, learnerId);
        }

        const skillName = (session.skillTopic) || (session.host.teachSkills && session.host.teachSkills[0]) || "Full Stack Development";

        res.json({
            sessionStatus: session.status,
            skill: skillName,
            learnerId,
            mentorId,
            isLearner: currentUserId === learnerId,
            isMentor: currentUserId === mentorId,
            impact: record || {
                sessionId,
                learnerId,
                mentorId,
                skill: skillName,
                preAssessment: { completed: false, score: 0 },
                postAssessment: { completed: false, score: 0 },
                impactAnalysis: { status: "pending_pre" }
            }
        });

    } catch (err) {
        console.error("Get learning impact error:", err);
        res.status(500).json({ message: "Failed to load learning impact status." });
    }
});

// 2. Start a Pre- or Post-Session Assessment
app.post("/api/learning-impact/start", verifyAuth, async (req, res) => {
    try {
        const { sessionId, stage } = req.body;
        const currentUserId = req.user.userId;

        if (!sessionId || !["pre", "post"].includes(stage)) {
            return res.status(400).json({ message: "Valid sessionId and stage ('pre' or 'post') are required." });
        }

        // Verify session and participation
        let session;
        if (isMongoActive()) {
            session = await LiveSession.findById(sessionId)
                .populate("host", "name email teachSkills learnSkills")
                .populate("participant", "name email teachSkills learnSkills");
        } else {
            session = memoryStore.getLiveSessionById(sessionId);
        }

        if (!session) {
            return res.status(404).json({ message: "Live session not found." });
        }

        const hostId = (session.host._id || session.host).toString();
        const participantId = (session.participant._id || session.participant).toString();

        if (hostId !== currentUserId && participantId !== currentUserId) {
            return res.status(403).json({ message: "Access forbidden: you do not belong to this session." });
        }

        // Determine learner ID
        const learnerId = participantId;
        const mentorId = hostId;

        // Check prerequisites for stage
        let existingRecord;
        if (isMongoActive()) {
            existingRecord = await LearningImpact.findOne({ sessionId, learnerId });
        } else {
            existingRecord = memoryStore.findLearningImpactBySessionAndLearner(sessionId, learnerId);
        }

        if (stage === "post") {
            if (session.status !== "completed") {
                return res.status(400).json({
                    message: "Post-assessment is available only after the session has been marked completed."
                });
            }
            if (!existingRecord || !existingRecord.preAssessment || !existingRecord.preAssessment.completed) {
                return res.status(400).json({
                    message: "Pre-assessment was not completed for this session. A post-assessment requires baseline comparison data."
                });
            }
        }

        const skillName = session.skillTopic || (session.host.teachSkills && session.host.teachSkills[0]) || "Software Engineering";
        const topicName = session.skillTopic || skillName;

        const assessmentPackage = await learningImpactService.generateSessionAssessment({
            stage,
            skill: skillName,
            topic: topicName,
            learningObjectives: existingRecord ? existingRecord.learningObjectives : []
        });

        // Store active test session with proctoring telemetry trackers
        const impactToken = "imp_" + stage + "_" + Date.now() + "_" + Math.random().toString(36).substring(2, 7);
        const sessionPayload = {
            token: impactToken,
            sessionId,
            learnerId,
            mentorId,
            stage,
            skill: skillName,
            learningObjectives: assessmentPackage.learningObjectives,
            internalBenchmark: assessmentPackage.internalBenchmark,
            proctoringConsent: false,
            startedAt: Date.now()
        };

        memoryStore.startActiveImpactSession(impactToken, sessionPayload);

        res.json({
            token: impactToken,
            stage,
            skill: skillName,
            topic: topicName,
            title: assessmentPackage.title,
            learningObjectives: assessmentPackage.learningObjectives,
            questions: assessmentPackage.questions
        });

    } catch (err) {
        console.error("Start learning impact error:", err);
        res.status(500).json({ message: "Failed to generate session assessment." });
    }
});

// 2b. Telemetry event logging for learning impact live proctoring (Pre & Post assessments)
app.post("/api/learning-impact/proctoring-event", verifyAuth, async (req, res) => {
    try {
        const { token, eventType, details } = req.body;
        const currentUserId = req.user.userId;

        if (!token || !eventType) {
            return res.status(400).json({ message: "Token and event type are required." });
        }

        const activeTest = memoryStore.getActiveImpactSession(token);
        if (!activeTest) {
            return res.status(404).json({ message: "Active assessment session not found." });
        }

        if (String(activeTest.learnerId) !== String(currentUserId) && String(activeTest.mentorId) !== String(currentUserId)) {
            return res.status(403).json({ message: "Unauthorized test session access." });
        }

        const event = {
            type: eventType,
            timestamp: new Date(),
            details: details || ""
        };

        activeTest.proctoringEvents = activeTest.proctoringEvents || [];
        activeTest.proctoringEvents.push(event);

        if (eventType === "fullscreen_exit") {
            activeTest.fullscreenExitCount = (activeTest.fullscreenExitCount || 0) + 1;
        } else if (eventType === "visibility_hidden") {
            activeTest.visibilityChangeCount = (activeTest.visibilityChangeCount || 0) + 1;
        } else if (eventType === "window_blur") {
            activeTest.windowBlurCount = (activeTest.windowBlurCount || 0) + 1;
        } else if (eventType === "camera_disconnect") {
            activeTest.cameraDisconnectCount = (activeTest.cameraDisconnectCount || 0) + 1;
        } else if (eventType === "session_paused") {
            activeTest.isPaused = true;
        } else if (eventType === "session_resumed") {
            activeTest.isPaused = false;
        }

        memoryStore.updateActiveImpactSession(token, activeTest);

        res.status(200).json({
            status: "recorded",
            fullscreenExitCount: activeTest.fullscreenExitCount || 0,
            visibilityChangeCount: activeTest.visibilityChangeCount || 0,
            cameraDisconnectCount: activeTest.cameraDisconnectCount || 0,
            isPaused: activeTest.isPaused || false
        });
    } catch (err) {
        console.error("Impact proctoring event error:", err);
        res.status(500).json({ message: "Failed to record proctoring telemetry." });
    }
});

// 3. Submit Pre- or Post-Session Assessment answers with proctoring validation
app.post("/api/learning-impact/submit", verifyAuth, async (req, res) => {
    try {
        const { token, answers, proctoringSummary } = req.body;
        const currentUserId = req.user.userId;

        if (!token || !answers || typeof answers !== "object") {
            return res.status(400).json({ message: "Valid token and answers payload required." });
        }

        const activeTest = memoryStore.getActiveImpactSession(token);
        if (!activeTest) {
            return res.status(400).json({ message: "Assessment session expired or invalid. Please restart." });
        }

        if (String(activeTest.learnerId) !== String(currentUserId) && String(activeTest.mentorId) !== String(currentUserId)) {
            return res.status(403).json({ message: "Unauthorized: this test belongs to another user." });
        }

        // Evaluate answers against internal benchmark
        const evaluation = await learningImpactService.evaluateAnswers({
            stage: activeTest.stage,
            skill: activeTest.skill,
            answers,
            internalBenchmark: activeTest.internalBenchmark
        });

        // Combine verified server-side telemetry with client summary safely
        const verifiedProctoring = {
            consentGiven: true,
            cameraMonitoringActive: true,
            fullscreenExitCount: Math.max(activeTest.fullscreenExitCount || 0, (proctoringSummary && proctoringSummary.fullscreenExitCount) || 0),
            visibilityChangeCount: Math.max(activeTest.visibilityChangeCount || 0, (proctoringSummary && proctoringSummary.visibilityChangeCount) || 0),
            windowBlurCount: Math.max(activeTest.windowBlurCount || 0, (proctoringSummary && proctoringSummary.windowBlurCount) || 0),
            cameraDisconnectCount: Math.max(activeTest.cameraDisconnectCount || 0, (proctoringSummary && proctoringSummary.cameraDisconnectCount) || 0),
            isFlaggedForReview: false,
            flagReason: "",
            events: activeTest.proctoringEvents || []
        };

        // Flagging threshold rule: 5 or more suspicious events triggers provisional review
        const totalSuspiciousEvents = verifiedProctoring.fullscreenExitCount + verifiedProctoring.visibilityChangeCount + verifiedProctoring.cameraDisconnectCount;
        if (totalSuspiciousEvents >= 5) {
            verifiedProctoring.isFlaggedForReview = true;
            verifiedProctoring.flagReason = `Flagged for administrative review: ${verifiedProctoring.fullscreenExitCount} full-screen exits, ${verifiedProctoring.visibilityChangeCount} visibility changes, and ${verifiedProctoring.cameraDisconnectCount} camera interruptions during ${activeTest.stage}-assessment.`;
        }

        memoryStore.deleteActiveImpactSession(token);

        // Fetch or create database record
        let record;
        if (isMongoActive()) {
            record = await LearningImpact.findOne({
                sessionId: activeTest.sessionId,
                learnerId: activeTest.learnerId
            });

            if (!record) {
                record = new LearningImpact({
                    sessionId: activeTest.sessionId,
                    learnerId: activeTest.learnerId,
                    mentorId: activeTest.mentorId,
                    skill: activeTest.skill,
                    learningObjectives: activeTest.learningObjectives
                });
            }
        } else {
            record = memoryStore.findLearningImpactBySessionAndLearner(activeTest.sessionId, activeTest.learnerId);
            if (!record) {
                record = {
                    sessionId: activeTest.sessionId,
                    learnerId: activeTest.learnerId,
                    mentorId: activeTest.mentorId,
                    skill: activeTest.skill,
                    learningObjectives: activeTest.learningObjectives,
                    preAssessment: { completed: false, score: 0 },
                    postAssessment: { completed: false, score: 0 },
                    impactAnalysis: { status: "pending_pre" }
                };
            }
        }

        if (activeTest.stage === "pre") {
            record.preAssessment = {
                completed: true,
                score: evaluation.score,
                completedAt: new Date(),
                answers: evaluation.answersRecord,
                proctoring: verifiedProctoring
            };
            record.impactAnalysis = {
                ...(record.impactAnalysis || {}),
                status: verifiedProctoring.isFlaggedForReview ? "provisional_review" : "pre_completed",
                isProvisional: verifiedProctoring.isFlaggedForReview,
                reviewNotice: verifiedProctoring.isFlaggedForReview ? `Pre-assessment flagged for review: ${verifiedProctoring.flagReason}` : "",
                preScore: evaluation.score
            };
        } else {
            // Post assessment
            record.postAssessment = {
                completed: true,
                score: evaluation.score,
                completedAt: new Date(),
                answers: evaluation.answersRecord,
                proctoring: verifiedProctoring
            };

            // Synthesize full comparative learning impact report with proctoring checks
            const analysis = learningImpactService.synthesizeImpactReport({
                preAssessment: record.preAssessment,
                postAssessment: record.postAssessment,
                skill: record.skill,
                learningObjectives: record.learningObjectives
            });

            record.impactAnalysis = analysis;
        }

        // Save
        let saved;
        if (isMongoActive()) {
            saved = await record.save();
        } else {
            saved = memoryStore.saveLearningImpact(record);
        }

        res.json({
            message: `${activeTest.stage === "pre" ? "Pre-Session Baseline" : "Post-Session Mastery"} completed successfully!`,
            stage: activeTest.stage,
            score: evaluation.score,
            impact: saved
        });

    } catch (err) {
        console.error("Submit learning impact error:", err);
        res.status(500).json({ message: "Failed to evaluate session assessment." });
    }
});

// 4. Get a user's private learning impact history
app.get("/api/learning-impact/my-reports", verifyAuth, async (req, res) => {
    try {
        const userId = req.user.userId;

        if (isMongoActive()) {
            const reports = await LearningImpact.find({
                $or: [{ learnerId: userId }, { mentorId: userId }]
            })
            .populate("learnerId", "name email")
            .populate("mentorId", "name email")
            .populate("sessionId", "startedAt endedAt status")
            .sort({ createdAt: -1 });

            return res.json(reports);
        }

        const reports = memoryStore.findLearningImpactsByLearner(userId);
        res.json(reports);
    } catch (err) {
        console.error("Get learning reports error:", err);
        res.status(500).json({ message: "Failed to fetch learning impact reports." });
    }
});

// CRITICAL: Fail fast if MongoDB is not connected so requests don't hang
mongoose.set("bufferCommands", false);

let mongoMemoryServer = null;
let mongoConnectionMode = "disconnected";
let lastMongoError = null;

async function seedDatabaseIfEmpty() {
    try {
        const userCount = await User.countDocuments();
        if (userCount === 0) {
            await User.insertMany(seedData.users);
            await Connection.insertMany(seedData.connections);
            await Message.insertMany(seedData.messages);
            await Review.insertMany(seedData.reviews);
            console.log("Seeded initial SkillSwap demo data into MongoDB.");
        }
    } catch (seedErr) {
        console.warn("MongoDB seed warning:", seedErr.message);
    }
}

async function connectDatabase() {
    if (process.env.MONGODB_URI) {
        try {
            const connectOpts = {
                serverSelectionTimeoutMS: 8000
            };
            try {
                const parsed = new URL(process.env.MONGODB_URI);
                if (!parsed.pathname || parsed.pathname === "/") {
                    connectOpts.dbName = "skillswap";
                }
            } catch {}
            await mongoose.connect(process.env.MONGODB_URI, connectOpts);
            mongoConnectionMode = "external";
            lastMongoError = null;
            console.log("MongoDB Connected Successfully!");
            await seedDatabaseIfEmpty();
            return;
        } catch (error) {
            lastMongoError = error.message;
            console.warn("External MONGODB_URI connection failed, falling back to local MongoMemoryServer:", error.message);
        }
    }

    try {
        const { MongoMemoryServer } = require("mongodb-memory-server");
        mongoMemoryServer = await MongoMemoryServer.create();
        const uri = mongoMemoryServer.getUri();
        await mongoose.connect(uri);
        mongoConnectionMode = "memory-server";
        console.log("MongoDB Connected Successfully via MongoMemoryServer:", uri);
        await seedDatabaseIfEmpty();
    } catch (memErr) {
        mongoConnectionMode = "memory-store-fallback";
        console.warn("MongoMemoryServer failed to start, using in-memory fallback store:", memErr.message);
    }
}

function normalizeSkillList(value) {
    if (Array.isArray(value)) {
        return value.map(s => String(s).trim()).filter(Boolean);
    }
    if (typeof value === "string") {
        return value.split(",").map(s => s.trim()).filter(Boolean);
    }
    return [];
}

// Create user / signup route
app.post("/api/users", async (req, res) => {
    try {
        const {
            name,
            email,
            password,
            location,
            bio,
            teachSkills,
            learnSkills
        } = req.body;

        const cleanName = typeof name === "string" ? name.trim() : "";
        const cleanEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
        const cleanPassword = typeof password === "string" ? password : "";
        const cleanTeachSkills = normalizeSkillList(teachSkills);
        const cleanLearnSkills = normalizeSkillList(learnSkills);

        if (!cleanName || !cleanEmail || !cleanPassword) {
            return res.status(400).json({ message: "Name, email, and password are required." });
        }

        if (isMongoActive()) {
            const existing = await User.findOne({ email: cleanEmail });
            if (existing) {
                return res.status(400).json({ message: "User with this email already exists" });
            }

            const user = new User({
                name: cleanName,
                email: cleanEmail,
                password: cleanPassword,
                location: typeof location === "string" ? location.trim() : "",
                bio: typeof bio === "string" ? bio.trim() : "",
                teachSkills: cleanTeachSkills,
                learnSkills: cleanLearnSkills
            });

            await user.save();

            const token = jwt.sign(
                { userId: user._id, email: user.email },
                JWT_SECRET,
                { expiresIn: "7d" }
            );

            return res.status(201).json({
                message: "User created successfully!",
                user: user,
                token: token
            });
        }

        const existing = memoryStore.findUserByEmail(cleanEmail);
        if (existing) {
            return res.status(400).json({ message: "User with this email already exists" });
        }

        const user = memoryStore.createUser({
            name: cleanName,
            email: cleanEmail,
            password: cleanPassword,
            location: typeof location === "string" ? location.trim() : "",
            bio: typeof bio === "string" ? bio.trim() : "",
            teachSkills: cleanTeachSkills,
            learnSkills: cleanLearnSkills
        });

        const token = jwt.sign(
            { userId: user._id, email: user.email },
            JWT_SECRET,
            { expiresIn: "7d" }
        );

        res.status(201).json({
            message: "User created successfully!",
            user: user,
            token: token
        });

    } catch (error) {
        console.error("Create user error:", error.message);

        if (error.code === 11000) {
            return res.status(400).json({
                message: "User with this email already exists"
            });
        }

        if (error.name === "ValidationError") {
            return res.status(400).json({
                message: error.message
            });
        }

        res.status(500).json({
            message: "Failed to create user"
        });
    }
});

// Update user profile endpoint
app.put("/api/users/:id", async (req, res) => {
    try {
        const {
            name,
            email,
            password,
            location,
            bio,
            teachSkills,
            learnSkills
        } = req.body;

        const updateData = {};
        if (name) updateData.name = name;
        if (email) updateData.email = email;
        if (password) updateData.password = password;
        if (location !== undefined) updateData.location = location;
        if (bio !== undefined) updateData.bio = bio;
        if (Array.isArray(teachSkills)) updateData.teachSkills = teachSkills;
        if (Array.isArray(learnSkills)) updateData.learnSkills = learnSkills;

        if (isMongoActive()) {
            const updatedUser = await User.findByIdAndUpdate(
                req.params.id,
                updateData,
                { new: true, runValidators: true }
            );

            if (!updatedUser) {
                return res.status(404).json({ message: "User not found" });
            }

            return res.json({
                message: "Profile updated successfully!",
                user: updatedUser
            });
        }

        const updated = memoryStore.updateUser(req.params.id, updateData);
        if (!updated) {
            return res.status(404).json({ message: "User not found" });
        }

        res.json({
            message: "Profile updated successfully!",
            user: updated
        });

    } catch (error) {
        console.error("Profile update error:", error.message);
        res.status(500).json({ message: "Failed to update profile" });
    }
});

// Saare users MongoDB se lene ke liye get api
app.get("/api/users", async (req, res) => {
    try {
        if (isMongoActive()) {
            const users = await User.find();
            return res.json(users);
        }

        const users = memoryStore.getAllUsers();
        res.json(users);
    } catch (error) {
        console.log(error.message);

        const users = memoryStore.getAllUsers();
        res.json(users);
    }
});

// Health / status endpoint
app.get("/api/health", (req, res) => {
    res.json({
        status: "ok",
        app: "SkillSwap",
        mongoConnected: mongoose.connection.readyState === 1,
        mongoMode: mongoConnectionMode
    });
});

// Error handling middleware for MongoDB disconnection / buffering errors
app.use((err, req, res, next) => {
    if (err && (err.name === "MongooseError" || err.name === "MongoNetworkError" || (err.message && err.message.includes("buffering timed out")))) {
        console.warn("[SkillSwap] Database offline error handled:", err.message);
        if (req.method === "GET") {
            return res.json([]);
        }
        return res.status(503).json({
            message: "Database temporarily unavailable. Please try again shortly or configure MONGODB_URI."
        });
    }
    next(err);
});

// Login API
app.post("/api/login", async (req, res) => {
    try {
        const { email, password } = req.body;
        const cleanEmail = typeof email === "string" ? email.trim() : "";

        let user = null;
        if (isMongoActive()) {
            const escaped = cleanEmail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            user = await User.findOne({ email: { $regex: new RegExp(`^${escaped}$`, "i") } });
        } else {
            user = memoryStore.findUserByEmail(cleanEmail);
        }

        if (!user) {
            return res.status(404).json({
                message: "User not found"
            });
        }

        if (user.password !== password) {
            return res.status(401).json({
                message: "Incorrect password"
            });
        }

        // Generate signed JWT token
        const token = jwt.sign(
            { userId: user._id, email: user.email },
            JWT_SECRET,
            { expiresIn: "7d" }
        );

        res.json({
            message: "Login successful!",
            user: user,
            token: token
        });

    } catch (error) {
        console.log(error.message);

        res.status(500).json({
            message: "Login failed"
        });
    }
});

//Match API users ke skills compare karke batayegi ki kaun kiske liye suitable SkillSwap partner hai.
app.get("/api/matches/:userId", async (req, res) => {
    try {
        let currentUser = null;
        let otherUsers = [];

        if (isMongoActive()) {
            currentUser = await User.findById(req.params.userId);
            if (!currentUser) {
                return res.status(404).json({ message: "User not found" });
            }
            otherUsers = await User.find({ _id: { $ne: currentUser._id } });
        } else {
            currentUser = memoryStore.findUserById(req.params.userId);
            if (!currentUser) {
                return res.status(404).json({ message: "User not found" });
            }
            otherUsers = memoryStore.getAllUsers().filter(u => u._id.toString() !== currentUser._id.toString());
        }

        const normalize = skill => skill.trim().toLowerCase();

        const matches = otherUsers.filter(otherUser => {
            const myTeachSkills = (currentUser.teachSkills || []).map(normalize);
            const myLearnSkills = (currentUser.learnSkills || []).map(normalize);

            const theirTeachSkills = (otherUser.teachSkills || []).map(normalize);
            const theirLearnSkills = (otherUser.learnSkills || []).map(normalize);

            const theyTeachWhatIWant =
                myLearnSkills.some(skill =>
                    theirTeachSkills.includes(skill)
                );

            const ITeachWhatTheyWant =
                theirLearnSkills.some(skill =>
                    myTeachSkills.includes(skill)
                );

            return theyTeachWhatIWant && ITeachWhatTheyWant;
        });

        res.json(matches);

    } catch (error) {
        console.log(error.message);

        res.status(500).json({
            message: "Failed to find matches"
        });
    }
});

//is portion ka kam hai profile.html ko database se kisi ek specific user ki information dilwana.
app.get("/api/users/:id", async (req, res) => {
    try {
        let user = null;
        if (isMongoActive()) {
            user = await User.findById(req.params.id);
        } else {
            user = memoryStore.findUserById(req.params.id);
        }

        if (!user) {
            return res.status(404).json({
                message: "User not found"
            });
        }

        res.json(user);

    } catch (error) {
        res.status(500).json({
            message: "Server error"
        });
    }
});

server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running at http://0.0.0.0:${PORT}`);
});

connectDatabase();

async function shutdown() {
    try {
        await mongoose.disconnect();
        if (mongoMemoryServer) {
            await mongoMemoryServer.stop();
        }
    } catch (e) {
        // ignore shutdown errors
    } finally {
        process.exit(0);
    }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);