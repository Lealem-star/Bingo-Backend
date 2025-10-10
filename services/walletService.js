const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');
const User = require('../models/User');

class WalletService {
    // Get wallet by user ID
    static async getWallet(userId) {
        try {
            let wallet = await Wallet.findOne({ userId });
            if (!wallet) {
                wallet = await this.createWallet(userId);
            }
            return wallet;
        } catch (error) {
            console.error('Error getting wallet:', error);
            throw error;
        }
    }

    // Create wallet
    static async createWallet(userId) {
        try {
            const wallet = new Wallet({
                userId,
                balance: 0,
                main: 0,
                play: 0,
                coins: 0,
                gamesWon: 0
            });
            await wallet.save();
            return wallet;
        } catch (error) {
            console.error('Error creating wallet:', error);
            throw error;
        }
    }

    // Update wallet balance
    static async updateBalance(userId, updates) {
        try {
            const wallet = await Wallet.findOne({ userId });
            if (!wallet) {
                throw new Error('Wallet not found');
            }

            const balanceBefore = {
                balance: wallet.balance,
                main: wallet.main,
                play: wallet.play,
                coins: wallet.coins
            };

            // Update balances
            if (updates.balance !== undefined) wallet.balance = Math.max(0, wallet.balance + updates.balance);
            if (updates.main !== undefined) wallet.main = Math.max(0, wallet.main + updates.main);
            if (updates.play !== undefined) wallet.play = Math.max(0, wallet.play + updates.play);
            if (updates.coins !== undefined) wallet.coins = Math.max(0, wallet.coins + updates.coins);
            if (updates.gamesWon !== undefined) wallet.gamesWon += updates.gamesWon;

            await wallet.save();

            return {
                wallet,
                balanceBefore,
                balanceAfter: {
                    balance: wallet.balance,
                    main: wallet.main,
                    play: wallet.play,
                    coins: wallet.coins
                }
            };
        } catch (error) {
            console.error('Error updating wallet balance:', error);
            throw error;
        }
    }

    // Process deposit
    static async processDeposit(userId, amount, smsData = null) {
        try {
            // Credit main wallet (deposit balance)
            const result = await this.updateBalance(userId, { main: amount });

            // Gift play wallet: 10% of deposit
            const giftPlayAmount = Math.floor(amount * 0.1);
            if (giftPlayAmount > 0) {
                await this.updateBalance(userId, { play: giftPlayAmount });
            }

            // Create transaction record
            const transaction = new Transaction({
                userId,
                type: 'deposit',
                amount,
                description: `Deposit via SMS: ETB ${amount}${giftPlayAmount ? ` (+${giftPlayAmount} play wallet gift)` : ''}`,
                reference: smsData?.ref || null,
                smsData,
                balanceBefore: result.balanceBefore,
                balanceAfter: result.balanceAfter
            });
            await transaction.save();

            // Update wallet total deposited
            await Wallet.findOneAndUpdate(
                { userId },
                {
                    $inc: { totalDeposited: amount },
                    $set: { lastDepositDate: new Date() }
                }
            );

            // If user has outstanding credit, auto-repay from deposit
            const wallet = await Wallet.findOne({ userId });
            if (wallet && wallet.creditOutstanding > 0 && wallet.main > 0) {
                const repay = Math.min(wallet.main, wallet.creditOutstanding);
                wallet.main -= repay;
                wallet.creditOutstanding -= repay;
                wallet.creditUsed = Math.max(0, wallet.creditUsed - repay);
                await wallet.save();
            }

            return { wallet: result.wallet, transaction };
        } catch (error) {
            console.error('Error processing deposit:', error);
            throw error;
        }
    }

    // Convert coins to play wallet at 100 coins = 1 birr
    static async convertCoins(userId, coins, targetWallet = 'play') {
        try {
            const wallet = await Wallet.findOne({ userId });
            if (!wallet) {
                throw new Error('Wallet not found');
            }

            if (wallet.coins < coins) {
                throw new Error('Insufficient coins');
            }

            // Conversion rate: 100 coins -> 1 birr
            const birrAmount = Math.floor(coins / 100);
            if (birrAmount <= 0) {
                throw new Error('MIN_CONVERSION_NOT_MET');
            }

            const coinsToDeduct = birrAmount * 100;

            // Convert to play wallet only
            const updates = {
                coins: -coinsToDeduct,
                play: birrAmount
            };

            const result = await this.updateBalance(userId, updates);

            // Create transaction record
            const transaction = new Transaction({
                userId,
                type: 'coin_conversion',
                amount: birrAmount,
                description: `Converted ${coinsToDeduct} coins to ETB ${birrAmount} (added to play wallet)`,
                balanceBefore: result.balanceBefore,
                balanceAfter: result.balanceAfter
            });
            await transaction.save();

            return { wallet: result.wallet, transaction };
        } catch (error) {
            console.error('Error converting coins:', error);
            throw error;
        }
    }

    // Process game bet - use main wallet first, then play wallet
    static async processGameBet(userId, amount, gameId) {
        try {
            const wallet = await Wallet.findOne({ userId });
            if (!wallet) {
                throw new Error('Wallet not found');
            }

            // Check if main wallet has enough
            if (wallet.main >= amount) {
                // Use main wallet
                const result = await this.updateBalance(userId, { main: -amount });

                // Create transaction record
                const transaction = new Transaction({
                    userId,
                    type: 'game_bet',
                    amount: -amount,
                    description: `Game bet: ETB ${amount} (from main wallet)`,
                    gameId,
                    balanceBefore: result.balanceBefore,
                    balanceAfter: result.balanceAfter
                });
                await transaction.save();

                return { wallet: result.wallet, transaction, source: 'main' };
            } else if (wallet.play >= amount) {
                // Use play wallet
                const result = await this.updateBalance(userId, { play: -amount });

                // Create transaction record
                const transaction = new Transaction({
                    userId,
                    type: 'game_bet',
                    amount: -amount,
                    description: `Game bet: ETB ${amount} (from play wallet)`,
                    gameId,
                    balanceBefore: result.balanceBefore,
                    balanceAfter: result.balanceAfter
                });
                await transaction.save();

                return { wallet: result.wallet, transaction, source: 'play' };
            } else {
                throw new Error('INSUFFICIENT_FUNDS');
            }
        } catch (error) {
            console.error('Error processing game bet:', error);
            throw error;
        }
    }

    // Process game win - credit to main wallet
    static async processGameWin(userId, amount, gameId) {
        try {
            const result = await this.updateBalance(userId, { main: amount, gamesWon: 1 });

            // Auto-repay outstanding credit first from main
            const wallet = await Wallet.findOne({ userId });
            if (wallet && wallet.creditOutstanding > 0 && wallet.main > 0) {
                const repay = Math.min(amount, wallet.creditOutstanding);
                wallet.main -= repay;
                wallet.creditOutstanding -= repay;
                wallet.creditUsed = Math.max(0, wallet.creditUsed - repay);
                await wallet.save();
            }

            // Create transaction record
            const transaction = new Transaction({
                userId,
                type: 'game_win',
                amount,
                description: `Game win: ETB ${amount} (credited to main wallet)`,
                gameId,
                balanceBefore: result.balanceBefore,
                balanceAfter: result.balanceAfter
            });
            await transaction.save();

            return { wallet: result.wallet, transaction };
        } catch (error) {
            console.error('Error processing game win:', error);
            throw error;
        }
    }

    // Compute credit tier based on all-time deposits
    static getCreditTierAmount(totalDeposited) {
        if (totalDeposited > 500) return 50;
        if (totalDeposited >= 200) return 20;
        return 10;
    }

    // Ensure credit availability fields are set based on tier
    static async ensureCreditAvailability(userId) {
        const wallet = await Wallet.findOne({ userId });
        if (!wallet) throw new Error('Wallet not found');
        const tier = this.getCreditTierAmount(wallet.totalDeposited || 0);
        // Set available to tier if lower than tier
        if ((wallet.creditAvailable || 0) < tier) {
            wallet.creditAvailable = tier;
            await wallet.save();
        }
        return wallet;
    }

    // Use credit for a game stake (once per game handled by caller)
    static async useCredit(userId, amount) {
        const wallet = await this.ensureCreditAvailability(userId);
        if ((wallet.main > 0) || (wallet.play > 0)) {
            throw new Error('NOT_ELIGIBLE_FOR_CREDIT');
        }
        const tier = wallet.creditAvailable || 0;
        if (amount > tier) {
            throw new Error('CREDIT_LIMIT_EXCEEDED');
        }
        // Increase used and outstanding by amount
        wallet.creditUsed = (wallet.creditUsed || 0) + amount;
        wallet.creditOutstanding = (wallet.creditOutstanding || 0) + amount;
        await wallet.save();
        return wallet;
    }

    // Process game completion - give 10 coins as gift
    static async processGameCompletion(userId, gameId) {
        try {
            const result = await this.updateBalance(userId, { coins: 10 });

            // Create transaction record
            const transaction = new Transaction({
                userId,
                type: 'game_completion',
                amount: 10,
                description: `Game completion gift: 10 coins`,
                gameId,
                balanceBefore: result.balanceBefore,
                balanceAfter: result.balanceAfter
            });
            await transaction.save();

            return { wallet: result.wallet, transaction };
        } catch (error) {
            console.error('Error processing game completion:', error);
            throw error;
        }
    }

    // Get transaction history
    static async getTransactionHistory(userId, type = null, limit = 50, skip = 0) {
        try {
            const query = { userId };
            if (type) {
                query.type = type;
            }

            const transactions = await Transaction.find(query)
                .sort({ createdAt: -1 })
                .limit(limit)
                .skip(skip);

            const total = await Transaction.countDocuments({ userId });

            return { transactions, total };
        } catch (error) {
            console.error('Error getting transaction history:', error);
            throw error;
        }
    }

    // Process withdrawal request
    static async processWithdrawal(userId, amount, destination) {
        try {
            const wallet = await this.getWallet(userId);

            if (wallet.main < amount) {
                return { success: false, error: 'INSUFFICIENT_FUNDS' };
            }

            // Create pending withdrawal transaction
            const transaction = new Transaction({
                userId,
                type: 'withdrawal',
                amount,
                status: 'pending',
                description: `Withdrawal to ${destination}`,
                metadata: { destination }
            });

            await transaction.save();

            return {
                success: true,
                transactionId: transaction._id
            };
        } catch (error) {
            console.error('Error processing withdrawal:', error);
            return { success: false, error: 'INTERNAL_ERROR' };
        }
    }

    // Process withdrawal approval (admin)
    static async processWithdrawalApproval(userId, amount) {
        try {
            const wallet = await this.getWallet(userId);

            if (wallet.main < amount) {
                return { success: false, error: 'INSUFFICIENT_FUNDS' };
            }

            // Deduct from main wallet
            wallet.main -= amount;
            await wallet.save();

            return { success: true };
        } catch (error) {
            console.error('Error processing withdrawal approval:', error);
            return { success: false, error: 'INTERNAL_ERROR' };
        }
    }

    // Process deposit approval (admin)
    static async processDepositApproval(userId, amount) {
        try {
            const wallet = await this.getWallet(userId);

            // Add to main wallet
            const result = await this.updateBalance(userId, { main: amount });

            // Gift coins: 10% of deposit amount
            const giftCoins = Math.floor(amount * 0.1);
            if (giftCoins > 0) {
                await this.updateBalance(userId, { coins: giftCoins });
            }

            return { success: true, wallet: result.wallet };
        } catch (error) {
            console.error('Error processing deposit approval:', error);
            return { success: false, error: 'INTERNAL_ERROR' };
        }
    }

    // Transfer funds between main and play wallets
    static async transferFunds(userId, amount, direction) {
        try {
            const wallet = await Wallet.findOne({ userId });
            if (!wallet) {
                throw new Error('Wallet not found');
            }

            const balanceBefore = {
                main: wallet.main,
                play: wallet.play,
                coins: wallet.coins
            };

            let sourceWallet, targetWallet, sourceField, targetField;

            if (direction === 'main-to-play') {
                sourceWallet = wallet.main;
                targetWallet = wallet.play;
                sourceField = 'main';
                targetField = 'play';
            } else if (direction === 'play-to-main') {
                sourceWallet = wallet.play;
                targetWallet = wallet.main;
                sourceField = 'play';
                targetField = 'main';
            } else {
                throw new Error('Invalid transfer direction');
            }

            if (sourceWallet < amount) {
                throw new Error('Insufficient funds');
            }

            // Perform transfer
            wallet[sourceField] -= amount;
            wallet[targetField] += amount;
            await wallet.save();

            // Create transaction record
            const transaction = new Transaction({
                userId,
                type: 'wallet_transfer',
                amount: amount,
                description: `Transfer ${amount} from ${sourceField} to ${targetField} wallet`,
                balanceBefore: balanceBefore,
                balanceAfter: {
                    main: wallet.main,
                    play: wallet.play,
                    coins: wallet.coins
                }
            });
            await transaction.save();

            return { wallet, transaction };
        } catch (error) {
            console.error('Error transferring funds:', error);
            throw error;
        }
    }
}

module.exports = WalletService;
