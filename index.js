const express = require('express');
const cors = require('cors');
require('dotenv').config();
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const connectDB = require('./config/database');
const UserService = require('./services/userService');
const WalletService = require('./services/walletService');
const User = require('./models/User');
const Game = require('./models/Game');
const jwt = require('jsonwebtoken');
const BingoCards = require('./data/cartellas');

// Import routes
const { router: authRoutes, authMiddleware } = require('./routes/auth');
const walletRoutes = require('./routes/wallet');
const userRoutes = require('./routes/user');
const adminRoutes = require('./routes/admin');
const generalRoutes = require('./routes/general');
const smsForwarderRoutes = require('./routes/smsForwarder');
const smsWebhookRoutes = require('./routes/smsWebhook');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3001;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const WEBAPP_URL = process.env.WEBAPP_URL || '';

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve uploaded files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// JWT secret - ensure consistency
const JWT_SECRET = process.env.JWT_SECRET || 'your_super_secret_jwt_key_here_change_this';

// Debug JWT secret on startup
console.log('JWT Secret Debug:', {
    hasEnvSecret: !!process.env.JWT_SECRET,
    secretLength: JWT_SECRET.length,
    secretPreview: JWT_SECRET.substring(0, 10) + '...'
});

// Health check endpoint to keep service alive
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage()
    });
});

// Use routes
app.use('/auth', authRoutes);
app.use('/wallet', walletRoutes);
app.use('/user', userRoutes);
app.use('/admin', adminRoutes);
app.use('/sms-forwarder', smsForwarderRoutes);
app.use('/sms-webhook', smsWebhookRoutes);
app.use('/', generalRoutes);

// Initialize database connection
connectDB().catch(() => {
    console.log('⚠️  MongoDB connection failed. The service requires a database.');
});

// WebSocket server at /ws
const wss = new WebSocketServer({ noServer: true });

// --- Simple in-memory rooms with auto-cycling phases ---
const stakes = [10, 50];
const rooms = new Map(); // stake -> room
let currentStakeIndex = 0;

function makeRoom(stake) {
    const room = {
        id: `room_${stake}`,
        stake,
        phase: 'registration', // registration, running, announce
        currentGameId: null, // Will be set when registration starts
        players: new Map(), // userId -> { ws, cartella, name }
        selectedPlayers: new Set(), // userIds who have successfully bet
        calledNumbers: [],
        cartellas: new Map(), // userId -> cartella
        winners: [],
        takenCards: new Set(), // numbers chosen during registration (1-100)
        userCardSelections: new Map(), // userId -> cardNumber
        startTime: Date.now(),
        registrationEndTime: Date.now() + 60000, // 60 seconds from now
        gameEndTime: null,
        onJoin: async (ws) => {
            console.log('Room onJoin called:', { userId: ws.userId, roomStake: room.stake, roomPhase: room.phase });

            room.players.set(ws.userId, { ws, cartella: null, name: 'Player' });
            ws.room = room;

            const snapshot = {
                phase: room.phase,
                gameId: room.currentGameId,
                playersCount: room.selectedPlayers.size,
                calledNumbers: room.calledNumbers,
                called: room.calledNumbers,
                stake: room.stake,
                takenCards: Array.from(room.takenCards),
                yourSelection: room.userCardSelections.get(ws.userId) || null,
                nextStartAt: room.registrationEndTime || room.gameEndTime || null,
                isWatchMode: room.phase !== 'registration',
                prizePool: room.phase === 'running' ? (room.selectedPlayers.size * room.stake) - Math.floor(room.selectedPlayers.size * room.stake * 0.2) : 0
            };

            console.log('Sending snapshot to user:', { userId: ws.userId, snapshot });
            broadcast('snapshot', snapshot, room);
        },
        onLeave: (ws) => {
            room.players.delete(ws.userId);
            room.selectedPlayers.delete(ws.userId);
            room.cartellas.delete(ws.userId);
            const prev = room.userCardSelections.get(ws.userId);
            if (prev !== undefined && prev !== null) {
                room.takenCards.delete(prev);
                room.userCardSelections.delete(ws.userId);
            }
            broadcast('players_update', { playersCount: room.selectedPlayers.size }, room);
            broadcast('registration_update', { takenCards: Array.from(room.takenCards) }, room);
        }
    };
    return room;
}

function broadcast(type, payload, targetRoom = null) {
    const message = JSON.stringify({ type, payload });
    if (targetRoom) {
        // Broadcast to specific room
        targetRoom.players.forEach(({ ws }) => {
            if (ws.readyState === ws.OPEN) {
                ws.send(message);
            }
        });
    } else {
        // Broadcast to all rooms (fallback)
        rooms.forEach(room => {
            room.players.forEach(({ ws }) => {
                if (ws.readyState === ws.OPEN) {
                    ws.send(message);
                }
            });
        });
    }
}

async function startRegistration(room) {
    console.log('startRegistration called for room:', room.stake);
    room.phase = 'registration';
    room.registrationEndTime = Date.now() + 60000; // 60 seconds
    room.startTime = Date.now();
    room.takenCards.clear();
    room.userCardSelections.clear();
    room.selectedPlayers.clear(); // Clear previous selections

    // Generate a more unique gameId with random component and process ID
    const timestamp = Date.now();
    const random = Math.floor(Math.random() * 10000);
    const processId = process.pid ? String(process.pid).slice(-2) : '00';
    room.currentGameId = `LB${String(timestamp).slice(-4)}${String(random).padStart(4, '0')}${processId}`;
    console.log('Registration started with gameId:', room.currentGameId);

    // Create game record in database when registration starts
    let gameCreated = false;
    let attempts = 0;
    const maxAttempts = 5;

    while (!gameCreated && attempts < maxAttempts) {
        try {
            // Check if game already exists
            const existingGame = await Game.findOne({ gameId: room.currentGameId });
            if (existingGame) {
                // Generate new gameId if duplicate found
                const timestamp = Date.now();
                const random = Math.floor(Math.random() * 10000);
                const processId = process.pid ? String(process.pid).slice(-2) : '00';
                room.currentGameId = `LB${String(timestamp).slice(-4)}${String(random).padStart(4, '0')}${processId}`;
                attempts++;
                continue;
            }

            const game = new Game({
                gameId: room.currentGameId,
                stake: room.stake,
                players: [],
                status: 'registration',
                registrationEndsAt: new Date(room.registrationEndTime),
                pot: 0,
                systemCut: 0,
                prizePool: 0
            });
            await game.save();
            console.log(`Game ${room.currentGameId} created for stake ${room.stake}`);
            gameCreated = true;
        } catch (error) {
            if (error.code === 11000) { // Duplicate key error
                console.log(`Duplicate gameId ${room.currentGameId}, generating new one...`);
                const timestamp = Date.now();
                const random = Math.floor(Math.random() * 10000);
                const processId = process.pid ? String(process.pid).slice(-2) : '00';
                room.currentGameId = `LB${String(timestamp).slice(-4)}${String(random).padStart(4, '0')}${processId}`;
                attempts++;
            } else {
                console.error('Error creating game record:', error);
                break;
            }
        }
    }

    if (!gameCreated) {
        console.error(`Failed to create game after ${maxAttempts} attempts`);
    }

    broadcast('registration_open', {
        gameId: room.currentGameId,
        stake: room.stake,
        playersCount: 0, // Start with 0, will update as players join
        duration: 60000, // 60 seconds
        endsAt: room.registrationEndTime,
        availableCards: Array.from({ length: 100 }, (_, i) => i + 1), // Generate 1-100 available cards
        takenCards: [],
        isWatchMode: false
    }, room);

    setTimeout(async () => {
        if (room.phase === 'registration') {
            broadcast('registration_closed', { gameId: room.currentGameId }, room);
            startGame(room);
        }
    }, 60000); // 60 seconds
}

function startGame(room) {
    if (room.selectedPlayers.size === 0) {
        // No players, start new registration immediately
        console.log('No players in game, starting new registration');
        startRegistration(room);
        return;
    }

    // Process stake sources per player and build pot from paying players only
    let payingUsers = [];
    let creditUsers = [];

    console.log(`Starting game ${room.currentGameId}: ${room.selectedPlayers.size} players`);
    console.log('Room players:', Array.from(room.players.keys()));
    console.log('Selected players:', Array.from(room.selectedPlayers));

    // Process wallet deductions for all selected players (fire and forget)
    const players = [];
    (async () => {
        for (const userId of room.selectedPlayers) {
            try {
                const result = await WalletService.processGameBet(userId, room.stake, room.currentGameId);
                if (result && result.wallet) {
                    players.push({
                        userId,
                        cartelaNumber: room.userCardSelections.get(userId),
                        joinedAt: new Date(),
                        isCredit: false
                    });
                    payingUsers.push(userId);
                    console.log(`Stake deducted for user ${userId} from ${result.source}`);

                    // Send wallet update to the player
                    const playerObj = room.players.get(userId);
                    const ws = playerObj && playerObj.ws;
                    if (ws && ws.readyState === ws.OPEN) {
                        const wallet = await WalletService.getWallet(userId);
                        ws.send(JSON.stringify({
                            type: 'wallet_update',
                            payload: {
                                main: wallet.main,
                                play: wallet.play,
                                coins: wallet.coins,
                                creditAvailable: wallet.creditAvailable,
                                creditUsed: wallet.creditUsed,
                                creditOutstanding: wallet.creditOutstanding,
                                source: result.source
                            }
                        }));
                    }
                }
            } catch (error) {
                if (String(error.message) === 'INSUFFICIENT_FUNDS') {
                    try {
                        // Try to grant and use credit (once per game eligibility enforced by wallet service)
                        await WalletService.useCredit(userId, room.stake);
                        players.push({
                            userId,
                            cartelaNumber: room.userCardSelections.get(userId),
                            joinedAt: new Date(),
                            isCredit: true
                        });
                        creditUsers.push(userId);
                        console.log(`User ${userId} is playing on credit`);

                        // Notify credit update
                        const playerObj = room.players.get(userId);
                        const ws = playerObj && playerObj.ws;
                        if (ws && ws.readyState === ws.OPEN) {
                            const wallet = await WalletService.getWallet(userId);
                            ws.send(JSON.stringify({
                                type: 'wallet_update',
                                payload: {
                                    main: wallet.main,
                                    play: wallet.play,
                                    coins: wallet.coins,
                                    creditAvailable: wallet.creditAvailable,
                                    creditUsed: wallet.creditUsed,
                                    creditOutstanding: wallet.creditOutstanding,
                                    source: 'credit'
                                }
                            }));
                        }
                    } catch (e) {
                        console.error(`Credit not available for user ${userId}:`, e.message);
                        // Remove player who couldn't pay nor get credit
                        room.selectedPlayers.delete(userId);
                    }
                } else {
                    console.error(`Failed to deduct stake for user ${userId}:`, error);
                    room.selectedPlayers.delete(userId);
                }
            }
        }

        // After processing sources, compute pot from paying users only
        const pot = payingUsers.length * room.stake;
        const systemCut = Math.floor(pot * 0.2);
        const prizePool = pot - systemCut;

        // Persist game start metadata
        try {
            await Game.findOneAndUpdate(
                { gameId: room.currentGameId },
                {
                    players: players,
                    pot: pot,
                    systemCut: systemCut,
                    prizePool: prizePool,
                    status: 'running',
                    startedAt: new Date()
                }
            );
        } catch (error) {
            console.error('Error updating game record:', error);
        }

        // Send individual game_started messages with computed prizePool
        room.selectedPlayers.forEach(userId => {
            const player = room.players.get(userId);
            if (player && player.ws) {
                const card = room.cartellas.get(userId);
                const cardNumber = room.userCardSelections.get(userId);
                const message = JSON.stringify({
                    type: 'game_started',
                    payload: {
                        gameId: room.currentGameId,
                        stake: room.stake,
                        playersCount: room.selectedPlayers.size,
                        pot: pot,
                        prizePool: prizePool,
                        calledNumbers: room.calledNumbers,
                        called: room.calledNumbers,
                        card: card,
                        cardNumber: cardNumber
                    }
                });
                if (player.ws.readyState === player.ws.OPEN) {
                    player.ws.send(message);
                }
            }
        });
    })();

    // (persisting handled above after payments/credit)

    room.phase = 'running';
    room.calledNumbers = [];
    room.winners = [];
    room.gameEndTime = Date.now() + 300000; // 5 minutes max

    // Assign predefined cartellas based on selected card numbers
    room.selectedPlayers.forEach(userId => {
        const selectedCardNumber = room.userCardSelections.get(userId);
        const cartella = getPredefinedCartella(selectedCardNumber);
        room.cartellas.set(userId, cartella);
        const player = room.players.get(userId);
        if (player) {
            player.cartella = cartella;
        }
    });

    // Send individual game_started messages to each player with their specific card
    room.selectedPlayers.forEach(userId => {
        const player = room.players.get(userId);
        if (player && player.ws) {
            const card = room.cartellas.get(userId);
            const cardNumber = room.userCardSelections.get(userId);
            console.log('Sending game_started to player:', { userId, gameId: room.currentGameId, cardNumber });
            console.log('WebSocket state:', { readyState: player.ws.readyState, OPEN: player.ws.OPEN });
            const message = JSON.stringify({
                type: 'game_started',
                payload: {
                    gameId: room.currentGameId,
                    stake: room.stake,
                    playersCount: room.selectedPlayers.size,
                    pot: pot,
                    prizePool: prizePool,
                    calledNumbers: room.calledNumbers,
                    called: room.calledNumbers,
                    card: card,
                    cardNumber: cardNumber
                }
            });
            console.log('Game started message:', message);
            if (player.ws.readyState === player.ws.OPEN) {
                player.ws.send(message);
                console.log('Game started message sent successfully to player:', userId);
            } else {
                console.log('WebSocket not open, cannot send message to player:', userId, 'readyState:', player.ws.readyState);
            }
        } else {
            console.log('Player not found in room.players:', { userId, hasPlayer: !!player, hasWs: !!(player && player.ws) });
        }
    });

    // Start calling numbers
    callNextNumber(room);
}

function callNextNumber(room) {
    if (room.phase !== 'running' || room.calledNumbers.length >= 75) {
        toAnnounce(room); // Fire and forget - don't block
        return;
    }

    let number;
    do {
        number = Math.floor(Math.random() * 75) + 1;
    } while (room.calledNumbers.includes(number));

    room.calledNumbers.push(number);
    broadcast('number_called', { gameId: room.currentGameId, number, calledNumbers: room.calledNumbers, value: number, called: room.calledNumbers }, room);

    // Check for winners (fire and forget - don't block the game flow)
    checkWinners(room);

    // Call next number after delay (maintains consistent timing)
    setTimeout(() => callNextNumber(room), 2000);
}

async function checkWinners(room) {
    const winners = [];
    room.cartellas.forEach((cartella, userId) => {
        if (checkBingo(cartella, room.calledNumbers)) {
            winners.push({ userId, cartella });
        }
    });

    if (winners.length > 0) {
        room.winners = winners;
        await toAnnounce(room);
    }
}

async function toAnnounce(room) {
    room.phase = 'announce';

    // Populate winner data with user names
    const populatedWinners = await Promise.all(room.winners.map(async (winner) => {
        try {
            const user = await User.findById(winner.userId);
            return {
                ...winner,
                name: user ? `${user.firstName} ${user.lastName}`.trim() : 'Unknown Player',
                cartelaNumber: winner.cartella?.cartelaNumber || winner.cartelaNumber,
                cardNumbers: winner.cartella?.numbers || winner.cardNumbers,
                called: room.calledNumbers
            };
        } catch (error) {
            console.error('Error fetching user for winner:', error);
            return {
                ...winner,
                name: 'Unknown Player',
                cartelaNumber: winner.cartella?.cartelaNumber || winner.cartelaNumber,
                cardNumbers: winner.cartella?.numbers || winner.cardNumbers,
                called: room.calledNumbers
            };
        }
    }));

    broadcast('game_finished', {
        gameId: room.currentGameId,
        winners: populatedWinners,
        calledNumbers: room.calledNumbers,
        called: room.calledNumbers,
        stake: room.stake,
        nextStartAt: Date.now() + 10000
    }, room);

    // Process winnings
    if (room.winners.length > 0) {
        const pot = room.selectedPlayers.size * room.stake;
        const systemCut = Math.floor(pot * 0.2); // 20% system cut
        const prizePool = pot - systemCut;
        const prizePerWinner = Math.floor(prizePool / room.winners.length);

        room.winners.forEach(async (winner) => {
            try {
                await WalletService.processGameWin(winner.userId, prizePerWinner);

                // Send wallet update to the winner
                const ws = room.players.get(winner.userId);
                if (ws && ws.readyState === WebSocket.OPEN) {
                    const wallet = await WalletService.getWallet(winner.userId);
                    ws.send(JSON.stringify({
                        type: 'wallet_update',
                        payload: {
                            main: wallet.main,
                            play: wallet.play,
                            coins: wallet.coins,
                            source: 'win'
                        }
                    }));
                }
            } catch (error) {
                console.error('Game win processing error:', error);
            }
        });

        // Give 10 coins to all players who completed the game
        room.selectedPlayers.forEach(async (userId) => {
            try {
                await WalletService.processGameCompletion(userId, room.currentGameId);

                // Send wallet update to the player
                const ws = room.players.get(userId);
                if (ws && ws.readyState === WebSocket.OPEN) {
                    const wallet = await WalletService.getWallet(userId);
                    ws.send(JSON.stringify({
                        type: 'wallet_update',
                        payload: {
                            main: wallet.main,
                            play: wallet.play,
                            coins: wallet.coins,
                            source: 'completion'
                        }
                    }));
                }
            } catch (error) {
                console.error('Game completion processing error:', error);
            }
        });

        // Update existing game record with final results
        try {
            await Game.findOneAndUpdate(
                { gameId: room.currentGameId },
                {
                    players: Array.from(room.selectedPlayers).map(userId => ({ userId })),
                    winners: room.winners.map(w => ({ userId: w.userId, prize: prizePerWinner })),
                    calledNumbers: room.calledNumbers,
                    pot,
                    systemCut,
                    prizePool,
                    status: 'completed',
                    finishedAt: new Date()
                },
                { new: true }
            );
            console.log(`Game ${room.currentGameId} updated with final results`);
        } catch (error) {
            console.error('Error updating game record:', error);
        }
    }

    // Reset room after delay, then immediately start a new registration round
    setTimeout(async () => {
        room.players.clear();
        room.selectedPlayers.clear();
        room.cartellas.clear();
        room.calledNumbers = [];
        room.winners = [];
        room.startTime = null;
        room.registrationEndTime = null;
        room.gameEndTime = null;
        // Start new registration immediately
        await startRegistration(room);
    }, 10000);
}

function getPredefinedCartella(cardNumber) {
    // Card numbers are 1-100, array index is 0-99
    const cardIndex = cardNumber - 1;
    if (cardIndex >= 0 && cardIndex < BingoCards.cards.length) {
        return BingoCards.cards[cardIndex];
    }
    // Fallback to first card if invalid number
    return BingoCards.cards[0];
}

function checkBingo(cartella, calledNumbers) {
    // Check rows
    for (let i = 0; i < 5; i++) {
        if (cartella[i].every(num => num === 0 || calledNumbers.includes(num))) {
            return true;
        }
    }

    // Check columns
    for (let j = 0; j < 5; j++) {
        if (cartella.every(row => row[j] === 0 || calledNumbers.includes(row[j]))) {
            return true;
        }
    }

    // Check diagonals
    if (cartella.every((row, i) => row[i] === 0 || calledNumbers.includes(row[i]))) {
        return true;
    }
    if (cartella.every((row, i) => row[4 - i] === 0 || calledNumbers.includes(row[4 - i]))) {
        return true;
    }

    return false;
}

// Removed minute-based auto-cycler. Rounds will be chained after each game ends,
// and initial registration will start at server boot.

// WebSocket connection handling
wss.on('connection', async (ws, request) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const token = url.searchParams.get('token') || '';
    const stakeParam = Number(url.searchParams.get('stake') || '');

    try {
        const payload = jwt.verify(token, JWT_SECRET);
        ws.userId = String(payload.sub);

        console.log('WebSocket JWT Verification Success:', {
            sub: payload.sub,
            userId: ws.userId,
            tokenPreview: token.substring(0, 50) + '...',
            payloadKeys: Object.keys(payload),
            isObjectId: /^[0-9a-fA-F]{24}$/.test(payload.sub),
            isTelegramId: /^\d+$/.test(payload.sub) && payload.sub.length < 15
        });

        // Validate that we have a proper user ID
        if (!payload.sub || payload.sub === 'undefined' || payload.sub === 'null') {
            console.error('Invalid user ID in JWT payload:', payload.sub);
            ws.close(1008, 'Invalid user ID in token');
            return;
        }

    } catch (error) {
        console.log('JWT verification failed:', {
            error: error.message,
            tokenPreview: token ? token.substring(0, 50) + '...' : 'NO_TOKEN',
            tokenLength: token ? token.length : 0,
            jwtSecret: JWT_SECRET ? 'SET' : 'NOT_SET',
            errorType: error.name
        });

        // Send a more helpful error message for expired tokens
        if (error.name === 'TokenExpiredError') {
            ws.close(1008, 'Token expired - please refresh page');
        } else {
            ws.close(1008, 'Invalid token');
        }
        return;
    }

    // Auto-join room based on URL stake param (aligns with frontend behavior)
    if (!Number.isNaN(stakeParam) && stakes.includes(stakeParam)) {
        if (!rooms.has(stakeParam)) {
            rooms.set(stakeParam, makeRoom(stakeParam));
        }
        const room = rooms.get(stakeParam);
        await room.onJoin(ws);
    }

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'join_room') {
                const stake = data.stake || data.payload?.stake;
                console.log('join_room received:', { stake, dataStake: data.stake, payloadStake: data.payload?.stake, fullData: data });

                if (!stake || !stakes.includes(stake)) {
                    console.error('Invalid stake for join_room:', { stake, validStakes: stakes });
                    ws.send(JSON.stringify({
                        type: 'error',
                        payload: { message: 'Invalid stake', validStakes: stakes }
                    }));
                    return;
                }

                if (!rooms.has(stake)) {
                    rooms.set(stake, makeRoom(stake));
                }
                const room = rooms.get(stake);
                console.log('Joining room:', { stake, roomPhase: room.phase, gameId: room.currentGameId });
                await room.onJoin(ws);
            } else if (data.type === 'select_card') {
                const room = ws.room;
                const cardNumber = Number(data.cardNumber || data.payload?.cardNumber);
                console.log('select_card received:', { cardNumber, roomPhase: room?.phase, userId: ws.userId });

                if (room && Number.isInteger(cardNumber) && cardNumber >= 1 && cardNumber <= 100) {
                    // Only process if we're in registration phase
                    if (room.phase !== 'registration') {
                        console.log('Rejecting selection - not in registration phase:', room.phase);
                        ws.send(JSON.stringify({
                            type: 'selection_rejected',
                            payload: {
                                reason: 'NOT_IN_REGISTRATION',
                                cardNumber,
                                currentPhase: room.phase,
                                isWatchMode: true
                            }
                        }));
                        return;
                    }

                    const previous = room.userCardSelections.get(ws.userId);
                    if (previous) {
                        room.takenCards.delete(previous);
                        room.selectedPlayers.delete(ws.userId);
                    }

                    if (room.takenCards.has(cardNumber)) {
                        // Already taken, notify user
                        ws.send(JSON.stringify({ type: 'selection_rejected', payload: { reason: 'TAKEN', cardNumber } }));
                        return;
                    }

                    // Just reserve the spot - no wallet deduction yet
                    room.userCardSelections.set(ws.userId, cardNumber);
                    room.takenCards.add(cardNumber);
                    room.selectedPlayers.add(ws.userId);

                    // Calculate current prize pool (80% of stake × players)
                    const currentPrizePool = Math.floor(room.selectedPlayers.size * room.stake * 0.8);

                    ws.send(JSON.stringify({
                        type: 'selection_confirmed',
                        payload: {
                            cardNumber,
                            playersCount: room.selectedPlayers.size,
                            prizePool: currentPrizePool
                        }
                    }));

                    // Broadcast updates to all players
                    broadcast('players_update', {
                        playersCount: room.selectedPlayers.size,
                        prizePool: currentPrizePool
                    }, room);
                    broadcast('registration_update', {
                        takenCards: Array.from(room.takenCards),
                        prizePool: currentPrizePool
                    }, room);
                }
            } else if (data.type === 'bingo_claim' || data.type === 'claim_bingo') {
                const room = ws.room;
                if (room && room.phase === 'running') {
                    const cartella = room.cartellas.get(ws.userId);
                    if (cartella && checkBingo(cartella, room.calledNumbers)) {
                        room.winners.push({ userId: ws.userId, cartella });
                        // Send bingo_accepted event to all players
                        broadcast('bingo_accepted', {
                            gameId: room.currentGameId,
                            winners: room.winners,
                            calledNumbers: room.calledNumbers,
                            called: room.calledNumbers
                        }, room);
                        await toAnnounce(room);
                    }
                }
            }
        } catch (error) {
            console.error('WebSocket message error:', error);
        }
    });

    ws.on('close', () => {
        if (ws.room) {
            ws.room.onLeave(ws);
        }
    });
});

// Handle WebSocket upgrade
server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
    if (pathname === '/ws') {
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
        });
    } else {
        socket.destroy();
    }
});

// Start server
server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🌐 WebSocket available at ws://localhost:${PORT}/ws`);

    // Initialize rooms with registration phase active
    stakes.forEach(async (stake) => {
        if (!rooms.has(stake)) {
            rooms.set(stake, makeRoom(stake));
        }
        const room = rooms.get(stake);
        // Start registration immediately
        await startRegistration(room);
    });
});

// Start Telegram bot
if (BOT_TOKEN) {
    const { startTelegramBot } = require('./telegram/bot');
    startTelegramBot({ BOT_TOKEN, WEBAPP_URL });
} else {
    console.log('⚠️  BOT_TOKEN not set. Telegram bot is disabled.');
}
