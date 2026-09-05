const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);

const io = new Server(server, { 
  cors: { origin: '*' },
  maxHttpBufferSize: 1e8
});

app.use(express.static(path.join(__dirname)));
app.use(express.json({ limit: '50mb' }));

const QUESTIONS_FILE = path.join(__dirname, 'questions.json');

// ചോദ്യങ്ങൾ ഫയലിൽ നിന്ന് റീഡ് ചെയ്യുന്നു
function loadQuestionsFromFile() {
  try {
    if (fs.existsSync(QUESTIONS_FILE)) {
      const data = fs.readFileSync(QUESTIONS_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error("Error reading questions.json:", err);
  }
  return [];
}

// ചോദ്യങ്ങൾ ഫയലിലേക്ക് സേവ് ചെയ്യുന്നു
function saveQuestionsToFile(deck) {
  try {
    fs.writeFileSync(QUESTIONS_FILE, JSON.stringify(deck, null, 2), 'utf-8');
  } catch (err) {
    console.error("Error saving questions.json:", err);
  }
}

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

// ചോദ്യങ്ങൾ അഡ്മിൻ പേജിലേക്ക് എത്തിക്കാനുള്ള API
app.get('/api/questions', (req, res) => {
  res.json(loadQuestionsFromFile());
});

let gameState = {
  status: 'LOBBY',
  pin: null,
  deck: loadQuestionsFromFile(),
  currentIdx: -1,
  players: {},
  correctSubmissionsCount: 0
};

let activeTimer = null;
let currentSecondsLeft = 0;

function getLeaderboard() {
  return Object.values(gameState.players)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
}

function stopCurrentQuestion() {
  if (activeTimer) {
    clearInterval(activeTimer);
    activeTimer = null;
  }
  if (gameState.status === 'ACTIVE') {
    gameState.status = 'LEADERBOARD';
    const q = gameState.deck[gameState.currentIdx];
    io.emit('question_expired', { 
      correctIdx: q.correctChoice,
      leaderboard: getLeaderboard()
    });
  }
}

io.on('connection', (socket) => {
  socket.on('admin_init_deck', ({ deck }) => {
    if (activeTimer) clearInterval(activeTimer);
    
    gameState.deck = deck;
    saveQuestionsToFile(deck); // ചോദ്യങ്ങൾ questions.json ലേക്ക് സൂക്ഷിക്കുന്നു

    gameState.currentIdx = -1;
    gameState.status = 'READY';
    gameState.players = {};
    gameState.correctSubmissionsCount = 0;
    gameState.pin = Math.floor(100000 + Math.random() * 900000).toString();

    socket.emit('game_pin_generated', { pin: gameState.pin });
    io.emit('player_count_update', 0);
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
    if (activeTimer) clearInterval(activeTimer);

    gameState.currentIdx = questionIdx;
    gameState.status = 'ACTIVE';
    gameState.correctSubmissionsCount = 0;

    const q = gameState.deck[questionIdx];
    currentSecondsLeft = q.timeLimit;

    io.emit('new_question', {
      index: questionIdx,
      total: gameState.deck.length,
      text: q.text,
      options: q.options,
      image: q.image || null,
      timeLimit: q.timeLimit
    });

    activeTimer = setInterval(() => {
      currentSecondsLeft--;
      io.emit('timer_tick', { secondsLeft: currentSecondsLeft, total: q.timeLimit });

      if (currentSecondsLeft <= 0) {
        stopCurrentQuestion();
      }
    }, 1000);
  });

  socket.on('submit_answer', ({ choiceIdx }) => {
    const q = gameState.deck[gameState.currentIdx];
    if (gameState.status !== 'ACTIVE' || !gameState.players[socket.id]) return;

    if (choiceIdx === q.correctChoice) {
      const bonus = Math.max(0, 80 - (gameState.correctSubmissionsCount * 10));
      gameState.players[socket.id].score += (800 + bonus);
      gameState.correctSubmissionsCount++;
    }
    socket.emit('answer_accepted');
  });

  socket.on('admin_reveal_early', () => {
    stopCurrentQuestion();
  });

  socket.on('admin_show_podium', () => {
    if (activeTimer) clearInterval(activeTimer);
    gameState.status = 'PODIUM';
    
    const allRanked = Object.values(gameState.players)
      .sort((a, b) => b.score - a.score);
    const topThree = allRanked.slice(0, 3);

    io.emit('display_podium', { winners: topThree, fullResults: allRanked });
  });

  socket.on('disconnect', () => {
    delete gameState.players[socket.id];
    io.emit('player_count_update', Object.keys(gameState.players).length);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});