const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// ഇമേജ് അപ്‌ലോഡിനായി Buffer സൈസ് കൂട്ടുന്നു
const io = new Server(server, { 
  cors: { origin: '*' },
  maxHttpBufferSize: 1e8
});

// റൂട്ട് ഫോൾഡറിലെ എല്ലാ ഫയലുകളും (logo.png ഉൾപ്പെടെ) സെർവ് ചെയ്യുന്നു
app.use(express.static(path.join(__dirname)));

// റൂട്ടുകൾ
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

let gameState = {
  status: 'LOBBY',
  pin: null,
  deck: [],
  currentIdx: -1,
  deadline: 0,
  players: {},
  answers: {}
};

io.on('connection', (socket) => {
  socket.on('admin_init_deck', ({ deck }) => {
    gameState.deck = deck;
    gameState.currentIdx = -1;
    gameState.status = 'READY';
    gameState.pin = Math.floor(100000 + Math.random() * 900000).toString();
    socket.emit('game_pin_generated', { pin: gameState.pin });
  });

  socket.on('join_game', ({ pin, name }) => {
    if (!gameState.pin || gameState.pin !== pin.trim()) {
      return socket.emit('join_error', { message: 'Invalid Game PIN!' });
    }
    gameState.players[socket.id] = { name: name || 'Participant', score: 0 };
    socket.emit('joined_successfully', { name, pin });
    io.emit('player_count_update', Object.keys(gameState.players).length);
  });

  socket.on('admin_start_question', ({ questionIdx }) => {
    if (!gameState.deck[questionIdx]) return;
    gameState.currentIdx = questionIdx;
    gameState.status = 'ACTIVE';
    gameState.answers = {};

    const q = gameState.deck[questionIdx];
    const durationMs = q.timeLimit * 1000;
    gameState.deadline = Date.now() + durationMs;

    io.emit('new_question', {
      index: questionIdx,
      total: gameState.deck.length,
      text: q.text,
      options: q.options,
      image: q.image || null,
      timeLimit: q.timeLimit,
      deadline: gameState.deadline
    });

    setTimeout(() => {
      if (gameState.currentIdx === questionIdx && gameState.status === 'ACTIVE') {
        gameState.status = 'EXPIRED';
        io.emit('question_expired', { correctIdx: q.correctChoice });
      }
    }, durationMs);
  });

  socket.on('submit_answer', ({ choiceIdx }) => {
    const now = Date.now();
    const q = gameState.deck[gameState.currentIdx];

    if (gameState.status !== 'ACTIVE' || now > gameState.deadline || gameState.answers[socket.id] !== undefined) {
      return socket.emit('answer_rejected');
    }

    gameState.answers[socket.id] = choiceIdx;
    if (choiceIdx === q.correctChoice) {
      const remainingRatio = Math.max(0, (gameState.deadline - now) / (q.timeLimit * 1000));
      gameState.players[socket.id].score += 500 + Math.round(500 * remainingRatio);
    }
    socket.emit('answer_accepted');
  });

  socket.on('admin_reveal_early', () => {
    if (gameState.status === 'ACTIVE') {
      gameState.status = 'EXPIRED';
      const q = gameState.deck[gameState.currentIdx];
      io.emit('question_expired', { correctIdx: q.correctChoice });
    }
  });

  socket.on('admin_show_podium', () => {
    gameState.status = 'PODIUM';
    const ranked = Object.values(gameState.players)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    io.emit('display_podium', { winners: ranked });
  });

  socket.on('disconnect', () => {
    delete gameState.players[socket.id];
    delete gameState.answers[socket.id];
    io.emit('player_count_update', Object.keys(gameState.players).length);
  });
});

// Render-ന് ആവശ്യമായ PORT സെറ്റിംഗ്
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});