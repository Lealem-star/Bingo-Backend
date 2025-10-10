const express = require('express');
const BingoCards = require('../data/cartellas');
const CartellaService = require('../services/cartellaService');
const Game = require('../models/Game');
const User = require('../models/User');

const router = express.Router();

// GET /
router.get('/', (req, res) => {
    res.json({ message: 'Welcome to Bingo Backend API!' });
});

// GET /health
router.get('/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// GET /debug
router.get('/debug', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        headers: req.headers,
        jwt_secret_set: !!process.env.JWT_SECRET
    });
});

// GET /api/bingo/status
router.get('/api/bingo/status', (req, res) => {
    res.json({
        gameStatus: 'ready',
        message: 'Bingo game is ready to start'
    });
});

// GET /api/game/status - Game countdown and status endpoint
router.get('/api/game/status', async (req, res) => {
    try {
        // For now, simulate countdown logic
        // In a real implementation, this would be managed by a game service
        const now = new Date();
        const seconds = now.getSeconds();

        // Simulate countdown that resets every 15 seconds
        const countdown = 15 - (seconds % 15);

        // Get actual player count from database
        const activeSelections = await CartellaService.getActiveSelections();
        const playersCount = activeSelections.length;

        // Determine game status based on countdown and players
        let gameStatus = 'waiting';
        if (countdown <= 5 && playersCount >= 1) {
            gameStatus = 'starting';
        } else if (countdown === 0 && playersCount >= 1) {
            gameStatus = 'playing';
        }

        // Get recent selections from database
        const recentSelections = await CartellaService.getRecentSelections(10);

        res.json({
            success: true,
            countdown: countdown,
            playersCount: playersCount,
            gameStatus: gameStatus,
            gameId: gameStatus === 'playing' ? `game_${Date.now()}` : null,
            takenCartellas: activeSelections.map(selection => ({
                cartellaNumber: selection.cartellaNumber,
                playerId: selection.playerId,
                playerName: selection.playerName,
                selectedAt: selection.selectedAt
            })),
            recentSelections: recentSelections,
            timestamp: now.toISOString()
        });
    } catch (error) {
        console.error('Error fetching game status:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch game status'
        });
    }
});

// POST /api/cartellas/select - Select a cartella
router.post('/api/cartellas/select', async (req, res) => {
    try {
        const { cartellaNumber, playerId, playerName, stake, gameId } = req.body;

        if (!cartellaNumber || cartellaNumber < 1 || cartellaNumber > BingoCards.cards.length) {
            return res.status(400).json({
                success: false,
                error: 'Invalid cartella number'
            });
        }

        // Use CartellaService to select cartella
        const result = await CartellaService.selectCartella(
            cartellaNumber,
            playerId,
            playerName,
            stake || 10,
            gameId
        );

        if (!result.success) {
            const statusCode = result.error === 'Cartella already taken' ? 409 : 400;
            return res.status(statusCode).json(result);
        }

        // Get updated active selections
        const activeSelections = await CartellaService.getActiveSelections();

        res.json({
            success: true,
            message: result.message,
            cartellaNumber: result.selection.cartellaNumber,
            selection: result.selection,
            takenCartellas: activeSelections.map(selection => ({
                cartellaNumber: selection.cartellaNumber,
                playerId: selection.playerId,
                playerName: selection.playerName,
                selectedAt: selection.selectedAt
            }))
        });

    } catch (error) {
        console.error('Error selecting cartella:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to select cartella'
        });
    }
});

// GET /api/cartellas/taken - Get all taken cartellas
router.get('/api/cartellas/taken', async (req, res) => {
    try {
        const activeSelections = await CartellaService.getActiveSelections();
        const recentSelections = await CartellaService.getRecentSelections(20);

        res.json({
            success: true,
            takenCartellas: activeSelections.map(selection => ({
                cartellaNumber: selection.cartellaNumber,
                playerId: selection.playerId,
                playerName: selection.playerName,
                selectedAt: selection.selectedAt
            })),
            recentSelections: recentSelections,
            totalSelected: activeSelections.length
        });
    } catch (error) {
        console.error('Error fetching taken cartellas:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch taken cartellas'
        });
    }
});

// POST /api/cartellas/reset - Reset all selections (for testing/admin)
router.post('/api/cartellas/reset', async (req, res) => {
    try {
        const result = await CartellaService.resetAllSelections();

        if (!result.success) {
            return res.status(500).json(result);
        }

        res.json(result);
    } catch (error) {
        console.error('Error resetting cartellas:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to reset cartellas'
        });
    }
});

// GET /api/cartellas - Serve all bingo cards
router.get('/api/cartellas', (req, res) => {
    try {
        res.json({
            success: true,
            cards: BingoCards.cards,
            totalCards: BingoCards.cards.length
        });
    } catch (error) {
        console.error('Error serving cartellas:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to load cartellas data'
        });
    }
});

// GET /api/cartellas/:cardNumber - Serve specific card
router.get('/api/cartellas/:cardNumber', (req, res) => {
    try {
        const cardNumber = parseInt(req.params.cardNumber);

        if (isNaN(cardNumber) || cardNumber < 1 || cardNumber > BingoCards.cards.length) {
            return res.status(400).json({
                success: false,
                error: 'Invalid card number. Must be between 1 and ' + BingoCards.cards.length
            });
        }

        const cardIndex = cardNumber - 1;
        const card = BingoCards.cards[cardIndex];

        res.json({
            success: true,
            cardNumber: cardNumber,
            card: card
        });
    } catch (error) {
        console.error('Error serving cartella:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to load cartella data'
        });
    }
});

// POST /api/cartellas/confirm - Confirm a cartella selection (deduct stake)
router.post('/api/cartellas/confirm', async (req, res) => {
    try {
        const { cartellaNumber, playerId } = req.body;

        if (!cartellaNumber || !playerId) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: cartellaNumber, playerId'
            });
        }

        const result = await CartellaService.confirmCartellaSelection(cartellaNumber, playerId);

        if (!result.success) {
            return res.status(400).json(result);
        }

        res.json(result);
    } catch (error) {
        console.error('Error confirming cartella selection:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to confirm cartella selection'
        });
    }
});

// POST /api/cartellas/cancel - Cancel a cartella selection
router.post('/api/cartellas/cancel', async (req, res) => {
    try {
        const { cartellaNumber, playerId } = req.body;

        if (!cartellaNumber || !playerId) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: cartellaNumber, playerId'
            });
        }

        const result = await CartellaService.cancelCartellaSelection(cartellaNumber, playerId);

        if (!result.success) {
            return res.status(400).json(result);
        }

        res.json(result);
    } catch (error) {
        console.error('Error cancelling cartella selection:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to cancel cartella selection'
        });
    }
});

// GET /api/cartellas/stats - Get cartella selection statistics
router.get('/api/cartellas/stats', async (req, res) => {
    try {
        const result = await CartellaService.getSelectionStats();

        if (!result.success) {
            return res.status(500).json(result);
        }

        res.json(result);
    } catch (error) {
        console.error('Error getting cartella stats:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get cartella statistics'
        });
    }
});

// GET /api/cartellas/player/:playerId - Get player's cartella selections
router.get('/api/cartellas/player/:playerId', async (req, res) => {
    try {
        const { playerId } = req.params;

        if (!playerId) {
            return res.status(400).json({
                success: false,
                error: 'Missing playerId parameter'
            });
        }

        const result = await CartellaService.getPlayerSelections(playerId);

        if (!result.success) {
            return res.status(500).json(result);
        }

        res.json(result);
    } catch (error) {
        console.error('Error getting player selections:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get player selections'
        });
    }
});

// GET /api/leaderboard?period=alltime|monthly|weekly|daily|newyear
router.get('/api/leaderboard', async (req, res) => {
    try {
        const period = String(req.query.period || 'alltime');

        const now = new Date();
        const start = new Date(0);
        if (period === 'daily') {
            start.setTime(now.getTime());
            start.setHours(0, 0, 0, 0);
        } else if (period === 'weekly') {
            const day = now.getDay();
            const diff = (day === 0 ? 6 : day - 1); // Monday start
            start.setTime(now.getTime());
            start.setHours(0, 0, 0, 0);
            start.setDate(start.getDate() - diff);
        } else if (period === 'monthly') {
            start.setTime(now.getTime());
            start.setDate(1);
            start.setHours(0, 0, 0, 0);
        } else if (period === 'newyear') {
            start.setFullYear(now.getFullYear(), 0, 1);
            start.setHours(0, 0, 0, 0);
        }

        const matchTime = (period === 'alltime') ? {} : { finishedAt: { $gte: start, $lte: now } };

        // Aggregate wins and played from Game model
        // played: any game where user is in players
        // wins: any game where user appears in winners
        const playedAgg = await Game.aggregate([
            { $match: { status: 'finished', ...matchTime } },
            { $unwind: '$players' },
            { $group: { _id: '$players.userId', played: { $sum: 1 } } }
        ]);

        const winsAgg = await Game.aggregate([
            { $match: { status: 'finished', ...matchTime } },
            { $unwind: '$winners' },
            { $group: { _id: '$winners.userId', wins: { $sum: 1 } } }
        ]);

        const playedMap = new Map(playedAgg.map(r => [String(r._id), r.played]));
        const winsMap = new Map(winsAgg.map(r => [String(r._id), r.wins]));

        // Merge keys
        const userIds = new Set([...playedMap.keys(), ...winsMap.keys()]);

        // Fetch user names
        const users = await User.find({ _id: { $in: Array.from(userIds) } }, { firstName: 1, username: 1 }).lean();
        const idToUser = new Map(users.map(u => [String(u._id), u]));

        const leaders = Array.from(userIds).map(id => {
            const u = idToUser.get(id) || {};
            return {
                name: u.firstName || u.username || 'Player',
                wins: winsMap.get(id) || 0,
                played: playedMap.get(id) || 0
            };
        }).sort((a, b) => b.wins - a.wins || b.played - a.played).slice(0, 100);

        res.json({ leaders });
    } catch (e) {
        console.error('leaderboard error', e);
        res.status(500).json({ error: 'leaderboard_failed' });
    }
});

module.exports = router;
