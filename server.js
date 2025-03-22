const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;

const games = new Map();
const players = new Map();
const buyRequests = new Map();

const rounds = [
    { sets: 2, runs: 0 }, // Round 1
    { sets: 1, runs: 1 }, // Round 2
    { sets: 0, runs: 2 }, // Round 3
    { sets: 3, runs: 0 }, // Round 4
    { sets: 2, runs: 1 }, // Round 5
    { sets: 1, runs: 2 }, // Round 6
    { sets: 0, runs: 3 }  // Round 7
];

function createDeck() {
    const suits = ['♠', '♥', '♦', '♣'];
    const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    let deck = [];
    for (let i = 0; i < 2; i++) {
        for (let suit of suits) {
            for (let rank of ranks) {
                deck.push(`${rank}${suit}`);
            }
        }
    }
    deck.push('JOKER1', 'JOKER2', 'JOKER3', 'JOKER4');
    return deck.sort(() => Math.random() - 0.5);
}

function initializeGame(gameId, startingRound = 0) {
    const deck = createDeck();
    const discardPile = [deck.pop()];
    const validatedRound = Math.max(0, Math.min(6, Math.floor(startingRound))); // Ensure 0-6
    return {
        players: new Map(),
        deck,
        discardPile,
        currentRound: validatedRound,
        currentPlayer: null,
        phase: 'waiting',
        buyPhase: false,
        roundBuys: new Map(),
        hasDrawn: false,
        hasChosenDiscard: false,
        turnCount: 0
    };
}

function validateSet(cards) {
    if (cards.length < 3) return false;
    const ranks = cards.map(card => card.includes('JOKER') ? 'JOKER' : card.slice(0, -1));
    const nonJokers = ranks.filter(r => r !== 'JOKER');
    const uniqueNonJokers = new Set(nonJokers);
    return (uniqueNonJokers.size === 1 && nonJokers.length + ranks.length - nonJokers.length === cards.length) || 
           (uniqueNonJokers.size === 0 && ranks.every(r => r === 'JOKER'));
}

function validateRun(cards) {
    if (cards.length < 4) return false;
    const rankOrder = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    const sortedCards = cards.map(card => ({
        rank: card.includes('JOKER') ? 'JOKER' : card.slice(0, -1),
        suit: card.includes('JOKER') ? null : card.slice(-1),
        original: card
    }));

    const nonJokers = sortedCards.filter(c => c.rank !== 'JOKER').sort((a, b) => rankOrder.indexOf(a.rank) - rankOrder.indexOf(b.rank));
    const jokers = sortedCards.filter(c => c.rank === 'JOKER').length;
    if (nonJokers.length === 0) return false;

    const suit = nonJokers[0].suit;
    if (!nonJokers.every(c => c.suit === suit)) return false;

    const indices = nonJokers.map(c => rankOrder.indexOf(c.rank));
    const minIndex = Math.min(...indices);
    const maxIndex = Math.max(...indices);
    const requiredLength = maxIndex - minIndex + 1;
    const totalLength = nonJokers.length + jokers;

    return totalLength >= 4 && totalLength >= requiredLength && requiredLength <= rankOrder.length;
}

function canAddToMeld(meld, cards) {
    const combined = [...meld, ...cards];
    return meld.length >= 3 && (validateSet(combined) || validateRun(combined));
}

app.use(express.static('public'));

io.on('connection', (socket) => {
    console.log('Player connected:', socket.id);

    socket.on('joinGame', (gameId, playerName, startingRound) => {
        if (!games.has(gameId)) {
            const roundIndex = startingRound !== undefined ? startingRound : 0; // Default to 0 if not provided
            games.set(gameId, initializeGame(gameId, roundIndex));
            console.log(`Game ${gameId} initialized with starting round: ${roundIndex + 1}`);
        }

        const game = games.get(gameId);
        if (!game) {
            socket.emit('error', 'Game initialization failed.');
            return;
        }

        if (game.players.size >= 10) {
            socket.emit('error', 'Game is full');
            return;
        }

        game.players.set(socket.id, {
            name: playerName,
            hand: [],
            melds: [],
            score: 0,
            hasGoneDown: false
        });

        players.set(socket.id, { gameId, name: playerName });
        socket.join(gameId);

        const hand = game.deck.splice(0, 10);
        game.players.get(socket.id).hand = hand;

        if (!game.currentPlayer && game.players.size === 1) {
            game.currentPlayer = socket.id;
        }

        updateGameState(gameId);

        if (game.players.size >= 2 && game.phase === 'waiting') {
            game.phase = 'playing';
            io.to(gameId).emit('gameStart', { currentPlayer: game.currentPlayer });
        }
    });

    socket.on('drawCard', (gameId) => {
        const game = games.get(gameId);
        if (!game) {
            socket.emit('error', 'Game not found.');
            return;
        }
        if (game.currentPlayer !== socket.id || game.buyPhase || game.hasDrawn || !game.hasChosenDiscard) return;

        const player = game.players.get(socket.id);
        if (game.deck.length > 0) {
            const card = game.deck.pop();
            player.hand.push(card);
            game.hasDrawn = true;
        }
        updateGameState(gameId);
    });

    socket.on('drawDiscard', (gameId) => {
        const game = games.get(gameId);
        if (!game) {
            socket.emit('error', 'Game not found.');
            return;
        }
        if (game.currentPlayer !== socket.id || game.buyPhase || game.hasDrawn || game.hasChosenDiscard || game.discardPile.length === 0) return;

        const player = game.players.get(socket.id);
        const card = game.discardPile.pop();
        player.hand.push(card);
        game.hasDrawn = true;
        game.hasChosenDiscard = true;
        updateGameState(gameId);
    });

    socket.on('discard', (gameId, cardIndices) => {
        const game = games.get(gameId);
        if (!game) {
            socket.emit('error', 'Game not found.');
            return;
        }
        if (game.currentPlayer !== socket.id || game.buyPhase || !game.hasDrawn || !game.hasChosenDiscard || cardIndices.length !== 1) {
            socket.emit('error', 'Cannot discard: invalid turn state or incorrect number of cards selected.');
            return;
        }

        const player = game.players.get(socket.id);
        const totalCards = player.hand.length;

        if (totalCards < 1) {
            socket.emit('error', 'Cannot discard: no cards in hand.');
            return;
        }

        const cardIndex = cardIndices[0];
        if (cardIndex < 0 || cardIndex >= player.hand.length) {
            socket.emit('error', 'Invalid card index for discard.');
            return;
        }

        const card = player.hand.splice(cardIndex, 1)[0];
        game.discardPile.push(card);
        game.turnCount++;
        if (player.hand.length === 0 && player.hasGoneDown) {
            endRound(gameId);
        } else {
            moveToNextPlayer(gameId);
        }
        updateGameState(gameId);
    });

    socket.on('passDiscard', (gameId) => {
        const game = games.get(gameId);
        if (!game) {
            socket.emit('error', 'Game not found.');
            return;
        }
        if (game.currentPlayer !== socket.id || game.buyPhase || game.hasChosenDiscard) return;

        game.hasChosenDiscard = true;
        if (game.discardPile.length > 0) {
            game.buyPhase = true;
            buyRequests.set(gameId, []);
            io.to(gameId).emit('buyOpportunity', { discard: game.discardPile[game.discardPile.length - 1] });
            updateGameState(gameId);

            setTimeout(() => {
                const requests = buyRequests.get(gameId) || [];
                if (game.buyPhase) {
                    if (requests.length > 0) {
                        const playerIds = Array.from(game.players.keys());
                        const currentIndex = playerIds.indexOf(game.currentPlayer);
                        const nextPlayerIndex = (currentIndex + 1) % playerIds.length;
                        const buyerId = requests.sort((a, b) => {
                            const aIndex = playerIds.indexOf(a);
                            const bIndex = playerIds.indexOf(b);
                            return (aIndex < nextPlayerIndex ? aIndex + playerIds.length : aIndex) -
                                   (bIndex < nextPlayerIndex ? bIndex + playerIds.length : bIndex);
                        })[0];

                        if (game.deck.length > 1 && game.discardPile.length > 0) {
                            const discard = game.discardPile.pop();
                            const extraCard = game.deck.pop();
                            game.players.get(buyerId).hand.push(discard, extraCard);
                            game.roundBuys.set(buyerId, (game.roundBuys.get(buyerId) || 0) + 1);
                            io.to(buyerId).emit('buySuccess', { discard, extraCard });
                            io.to(gameId).emit('buyResult', { buyer: game.players.get(buyerId).name, discard });
                        }
                    }
                    game.buyPhase = false;
                    buyRequests.delete(gameId);
                    updateGameState(gameId);
                }
            }, 5000);
        } else {
            updateGameState(gameId);
        }
    });

    socket.on('buyDiscard', (gameId) => {
        const game = games.get(gameId);
        if (!game) {
            socket.emit('error', 'Game not found.');
            return;
        }
        if (game.currentPlayer === socket.id || !game.buyPhase) return;

        const buysThisRound = game.roundBuys.get(socket.id) || 0;
        if (buysThisRound >= 3) {
            socket.emit('error', 'You’ve reached your buy limit for this round');
            return;
        }

        let requests = buyRequests.get(gameId) || [];
        if (!requests.includes(socket.id)) {
            requests.push(socket.id);
            buyRequests.set(gameId, requests);
        }
    });

    socket.on('goOut', (gameId, { sets, runs }) => {
        const game = games.get(gameId);
        if (!game) {
            socket.emit('error', 'Game not found.');
            return;
        }
        if (game.currentPlayer !== socket.id || game.buyPhase || !game.hasDrawn || !game.hasChosenDiscard) {
            socket.emit('error', 'Cannot go down: invalid turn state.');
            return;
        }

        const player = game.players.get(socket.id);
        const roundContract = rounds[game.currentRound];
        if (sets.length !== roundContract.sets || runs.length !== roundContract.runs) {
            socket.emit('error', `You need exactly ${roundContract.sets} sets and ${roundContract.runs} runs`);
            return;
        }

        const allCards = [...sets.flat(), ...runs.flat()];
        const playerHandMap = new Map();
        player.hand.forEach(card => {
            playerHandMap.set(card, (playerHandMap.get(card) || 0) + 1);
        });

        const submittedCardsMap = new Map();
        allCards.forEach(card => {
            submittedCardsMap.set(card, (submittedCardsMap.get(card) || 0) + 1);
        });

        for (let [card, count] of submittedCardsMap) {
            if (!playerHandMap.has(card) || playerHandMap.get(card) < count) {
                socket.emit('error', 'Invalid cards: not in hand or exceeds count.');
                return;
            }
        }

        if (!sets.every(validateSet) || !runs.every(validateRun)) {
            socket.emit('error', 'Invalid sets or runs.');
            return;
        }

        player.melds = [...sets, ...runs];
        player.hand = player.hand.filter(card => {
            const countInHand = playerHandMap.get(card) || 0;
            const countInMelds = submittedCardsMap.get(card) || 0;
            playerHandMap.set(card, countInHand - countInMelds);
            return playerHandMap.get(card) > 0;
        });
        player.hasGoneDown = true;
        io.to(socket.id).emit('goOutSuccess', { melds: player.melds });
        updateGameState(gameId);
    });

    socket.on('layoff', (gameId, { targetPlayerId, meldIndex, cards }) => {
        const game = games.get(gameId);
        if (!game) {
            socket.emit('error', 'Game not found.');
            return;
        }
        if (game.currentPlayer !== socket.id || game.buyPhase || !game.hasDrawn || !game.hasChosenDiscard) return;
    
        const player = game.players.get(socket.id);
        if (!player.hasGoneDown) return;
    
        const targetPlayer = targetPlayerId === socket.id ? player : game.players.get(targetPlayerId);
        if (!targetPlayer || !targetPlayer.hasGoneDown || meldIndex >= targetPlayer.melds.length) return;
    
        if (!cards.every(card => player.hand.includes(card))) return;
        if (!canAddToMeld(targetPlayer.melds[meldIndex], cards)) {
            socket.emit('error', 'Cannot add these cards to the meld');
            return;
        }
    
        const rankOrder = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
        targetPlayer.melds[meldIndex].push(...cards);
        // Sort meld if it's a run (sets don't need sorting as they're same-rank)
        if (validateRun(targetPlayer.melds[meldIndex])) {
            targetPlayer.melds[meldIndex].sort((a, b) => {
                const rankA = a.includes('JOKER') ? 'JOKER' : a.slice(0, -1);
                const rankB = b.includes('JOKER') ? 'JOKER' : b.slice(0, -1);
                return rankA === 'JOKER' ? 1 : rankB === 'JOKER' ? -1 : rankOrder.indexOf(rankA) - rankOrder.indexOf(rankB);
            });
        }
        player.hand = player.hand.filter(card => !cards.includes(card));
        updateGameState(gameId);
    });

    socket.on('updateHandOrder', (gameId, newHandOrder) => {
        const game = games.get(gameId);
        if (!game) {
            socket.emit('error', 'Game not found.');
            return;
        }
        const player = game.players.get(socket.id);
        if (player) {
            player.hand = newHandOrder;
            updateGameState(gameId);
        }
    });

    socket.on('disconnect', () => {
        const player = players.get(socket.id);
        if (player) {
            const gameId = player.gameId;
            const game = games.get(gameId);
            if (game) {
                game.players.delete(socket.id);
                console.log(`Player ${socket.id} disconnected from game ${gameId}. Players left: ${game.players.size}`);
                if (game.players.size === 0) {
                    games.delete(gameId);
                    console.log(`Game ${gameId} deleted as no players remain.`);
                } else if (game.currentPlayer === socket.id) {
                    moveToNextPlayer(gameId);
                }
                updateGameState(gameId);
            }
            players.delete(socket.id);
        }
    });
});

function moveToNextPlayer(gameId) {
    const game = games.get(gameId);
    if (!game) {
        console.log(`moveToNextPlayer: Game ${gameId} not found.`);
        return;
    }
    const playerIds = Array.from(game.players.keys());
    if (playerIds.length === 0) {
        console.log(`moveToNextPlayer: No players in game ${gameId}.`);
        return;
    }
    const currentIndex = playerIds.indexOf(game.currentPlayer);
    game.currentPlayer = playerIds[(currentIndex + 1) % playerIds.length];
    game.buyPhase = false;
    game.hasDrawn = false;
    game.hasChosenDiscard = false;
    updateGameState(gameId);
}

function updateGameState(gameId) {
    const game = games.get(gameId);
    if (!game) {
        console.log(`updateGameState: Game ${gameId} not found.`);
        return;
    }
    const playerIds = Array.from(game.players.keys());
    console.log(`Updating state for game ${gameId}. Players: ${playerIds.length}, Current Player: ${game.currentPlayer}`);

    playerIds.forEach((id) => {
        const player = game.players.get(id);
        io.to(id).emit('gameUpdate', {
            yourHand: player.hand,
            players: playerIds.map(pid => ({
                id: pid,
                name: game.players.get(pid).name,
                cardCount: player.hand.length,
                melds: game.players.get(pid).melds,
                hasGoneDown: game.players.get(pid).hasGoneDown,
                score: game.players.get(pid).score
            })),
            discardPile: game.discardPile,
            currentRound: game.currentRound,
            roundConditions: rounds[game.currentRound],
            currentPlayer: game.currentPlayer,
            isYourTurn: id === game.currentPlayer && !game.buyPhase,
            canBuy: game.buyPhase && id !== game.currentPlayer && (game.roundBuys.get(id) || 0) < 3,
            buysThisRound: game.roundBuys.get(id) || 0,
            hasDrawn: game.hasDrawn,
            hasChosenDiscard: game.hasChosenDiscard,
            turnCount: game.turnCount
        });
    });
}

function endRound(gameId) {
    const game = games.get(gameId);
    if (!game) {
        console.log(`endRound: Game ${gameId} not found.`);
        return;
    }
    const scores = new Map();
    game.players.forEach((player, id) => {
        const score = player.hand.reduce((sum, card) => sum + getCardValue(card), 0);
        player.score += score;
        scores.set(id, { name: player.name, score: player.score });
    });
    game.currentRound++;
    io.to(gameId).emit('roundEnd', { scores: Object.fromEntries(scores) });
    if (game.currentRound > 6) {
        declareWinner(gameId);
    } else {
        resetRound(gameId);
    }
}

function getCardValue(card) {
    if (card.includes('JOKER')) return 20;
    if (card.startsWith('A')) return 15;
    if (['K', 'Q', 'J'].includes(card[0])) return 10;
    return 5;
}

function declareWinner(gameId) {
    const game = games.get(gameId);
    if (!game) {
        console.log(`declareWinner: Game ${gameId} not found.`);
        return;
    }
    const winner = Array.from(game.players.entries())
        .reduce((min, [id, player]) => player.score < min.score ? player : min, game.players.values().next().value);
    io.to(gameId).emit('gameOver', { winner: winner.name, scores: Object.fromEntries(game.players.entries()) });
}

function resetRound(gameId) {
    const game = games.get(gameId);
    if (!game) {
        console.log(`resetRound: Game ${gameId} not found.`);
        return;
    }
    game.deck = createDeck();
    game.discardPile = [game.deck.pop()];
    game.players.forEach(player => {
        player.hand = game.deck.splice(0, 10);
        player.melds = [];
        player.hasGoneDown = false;
    });
    game.currentPlayer = Array.from(game.players.keys())[0];
    game.hasDrawn = false;
    game.buyPhase = false;
    game.hasChosenDiscard = false;
    game.turnCount = 0;
    game.roundBuys.clear();
    updateGameState(gameId);
}

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});