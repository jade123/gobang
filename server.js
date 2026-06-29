const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_DIR = path.join(__dirname, "public");
const BOARD_SIZE = 15;
const DIRECTIONS = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1]
];

const players = new Map();
const games = new Map();
const invites = new Map();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

function id(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        req.destroy();
        reject(new Error("请求体过大"));
      }
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("JSON 格式错误"));
      }
    });
    req.on("error", reject);
  });
}

function publicAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter(address => address && address.family === "IPv4" && !address.internal)
    .map(address => `http://${address.address}:${PORT}`);
}

function playerView(player) {
  return {
    id: player.id,
    name: player.name,
    status: player.gameId ? "playing" : "idle",
    gameId: player.gameId || null
  };
}

function peersPayload() {
  return {
    players: [...players.values()].map(playerView),
    addresses: publicAddresses()
  };
}

function sendEvent(player, type, payload) {
  if (!player || !player.res) return;
  player.res.write(`event: ${type}\n`);
  player.res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcast(type, payload) {
  for (const player of players.values()) {
    sendEvent(player, type, payload);
  }
}

function broadcastPeers() {
  broadcast("peers", peersPayload());
}

function cleanPlayer(playerId) {
  const player = players.get(playerId);
  if (!player) return;

  if (player.gameId) {
    const game = games.get(player.gameId);
    if (game && !game.finished) {
      finishGame(game, game.players.find(idValue => idValue !== playerId), "opponent-left");
      notifyGame(game);
    }
  }

  for (const [inviteId, invite] of invites.entries()) {
    if (invite.from === playerId || invite.to === playerId) {
      invites.delete(inviteId);
    }
  }

  players.delete(playerId);
  broadcastPeers();
}

function makeBoard() {
  return Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null));
}

function gameView(game) {
  return {
    id: game.id,
    mode: game.mode || "lan",
    board: game.board,
    players: game.players.map(playerId => {
      const player = players.get(playerId);
      return {
        id: playerId,
        name: player ? player.name : playerId === game.computerId ? game.computerName : "已离线",
        stone: game.stones[playerId]
      };
    }),
    turn: game.turn,
    winner: game.winner,
    finished: game.finished,
    reason: game.reason,
    lastMove: game.lastMove
  };
}

function notifyGame(game) {
  const payload = gameView(game);
  for (const playerId of game.players) {
    sendEvent(players.get(playerId), "game", payload);
  }
  broadcastPeers();
}

function countDirection(board, row, col, dr, dc, stone) {
  let count = 0;
  let r = row + dr;
  let c = col + dc;
  while (
    r >= 0 &&
    r < BOARD_SIZE &&
    c >= 0 &&
    c < BOARD_SIZE &&
    board[r][c] === stone
  ) {
    count += 1;
    r += dr;
    c += dc;
  }
  return count;
}

function hasFive(board, row, col, stone) {
  return DIRECTIONS.some(([dr, dc]) => {
    const total =
      1 +
      countDirection(board, row, col, dr, dc, stone) +
      countDirection(board, row, col, -dr, -dc, stone);
    return total >= 5;
  });
}

function isBoardFull(board) {
  return board.every(row => row.every(cell => cell));
}

function releaseGamePlayers(game) {
  for (const playerId of game.players) {
    const player = players.get(playerId);
    if (player) player.gameId = null;
  }
}

function finishGame(game, winner, reason) {
  game.finished = true;
  game.winner = winner;
  game.reason = reason;
  releaseGamePlayers(game);
}

function hasNeighbor(board, row, col) {
  for (let dr = -2; dr <= 2; dr += 1) {
    for (let dc = -2; dc <= 2; dc += 1) {
      if (dr === 0 && dc === 0) continue;
      const r = row + dr;
      const c = col + dc;
      if (r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE && board[r][c]) {
        return true;
      }
    }
  }
  return false;
}

function emptyCells(board) {
  const cells = [];
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      if (!board[row][col]) cells.push({ row, col });
    }
  }
  return cells;
}

function wouldWin(board, row, col, stone) {
  board[row][col] = stone;
  const wins = hasFive(board, row, col, stone);
  board[row][col] = null;
  return wins;
}

function scoreMove(board, row, col, stone) {
  const center = Math.floor(BOARD_SIZE / 2);
  let score = 18 - Math.abs(row - center) - Math.abs(col - center);

  for (const [dr, dc] of DIRECTIONS) {
    const total =
      1 +
      countDirection(board, row, col, dr, dc, stone) +
      countDirection(board, row, col, -dr, -dc, stone);
    score += total * total * total * total;
  }

  return score;
}

function findComputerMove(game) {
  const cells = emptyCells(game.board);
  const computerStone = game.stones[game.computerId];
  const humanId = game.players.find(playerId => playerId !== game.computerId);
  const humanStone = game.stones[humanId];

  for (const cell of cells) {
    if (wouldWin(game.board, cell.row, cell.col, computerStone)) return cell;
  }

  for (const cell of cells) {
    if (wouldWin(game.board, cell.row, cell.col, humanStone)) return cell;
  }

  const candidates = cells.filter(cell => hasNeighbor(game.board, cell.row, cell.col));
  const scopedCells = candidates.length ? candidates : [{ row: 7, col: 7 }];
  let best = scopedCells[0];
  let bestScore = -Infinity;

  for (const cell of scopedCells) {
    const attack = scoreMove(game.board, cell.row, cell.col, computerStone);
    const defense = scoreMove(game.board, cell.row, cell.col, humanStone) * 0.92;
    const score = attack + defense;
    if (score > bestScore) {
      best = cell;
      bestScore = score;
    }
  }

  return best;
}

function playComputerTurn(game) {
  if (!game.computerId || game.finished || game.turn !== game.computerId) return;
  const move = findComputerMove(game);
  const stone = game.stones[game.computerId];

  game.board[move.row][move.col] = stone;
  game.lastMove = { row: move.row, col: move.col, playerId: game.computerId, stone };

  if (hasFive(game.board, move.row, move.col, stone)) {
    finishGame(game, game.computerId, "five");
  } else if (isBoardFull(game.board)) {
    finishGame(game, null, "draw");
  } else {
    game.turn = game.players.find(playerId => playerId !== game.computerId);
  }
}

function createGame(blackId, whiteId) {
  const game = {
    id: id("game"),
    mode: "lan",
    board: makeBoard(),
    players: [blackId, whiteId],
    stones: {
      [blackId]: "black",
      [whiteId]: "white"
    },
    turn: blackId,
    winner: null,
    finished: false,
    reason: null,
    lastMove: null
  };

  games.set(game.id, game);
  players.get(blackId).gameId = game.id;
  players.get(whiteId).gameId = game.id;
  notifyGame(game);
  return game;
}

function createComputerGame(playerId) {
  const player = players.get(playerId);
  const computerId = id("computer");
  const game = {
    id: id("game"),
    mode: "computer",
    board: makeBoard(),
    players: [playerId, computerId],
    computerId,
    computerName: "电脑",
    stones: {
      [playerId]: "black",
      [computerId]: "white"
    },
    turn: playerId,
    winner: null,
    finished: false,
    reason: null,
    lastMove: null
  };

  games.set(game.id, game);
  player.gameId = game.id;
  notifyGame(game);
  return game;
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname);
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: "禁止访问" });
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      sendJson(res, 404, { error: "文件不存在" });
      return;
    }

    const type = mimeTypes[path.extname(filePath)] || "application/octet-stream";
    res.writeHead(200, {
      "content-type": type,
      "cache-control": "no-cache"
    });
    res.end(data);
  });
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/api/config") {
    sendJson(res, 200, {
      boardSize: BOARD_SIZE,
      addresses: publicAddresses()
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/join") {
    const body = await readBody(req);
    const name = String(body.name || "").trim().slice(0, 18);
    if (!name) {
      sendJson(res, 400, { error: "请输入昵称" });
      return;
    }

    const player = {
      id: id("player"),
      name,
      gameId: null,
      res: null,
      heartbeat: null
    };
    players.set(player.id, player);
    sendJson(res, 200, { player: playerView(player), peers: peersPayload() });
    broadcastPeers();
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/leave") {
    const body = await readBody(req);
    cleanPlayer(body.playerId);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/invite") {
    const body = await readBody(req);
    const from = players.get(body.from);
    const to = players.get(body.to);
    if (!from || !to) {
      sendJson(res, 404, { error: "玩家不在线" });
      return;
    }
    if (from.id === to.id) {
      sendJson(res, 400, { error: "不能邀请自己" });
      return;
    }
    if (from.gameId || to.gameId) {
      sendJson(res, 409, { error: "有玩家正在对局中" });
      return;
    }

    const invite = {
      id: id("invite"),
      from: from.id,
      to: to.id,
      createdAt: Date.now()
    };
    invites.set(invite.id, invite);
    sendEvent(to, "invite", {
      id: invite.id,
      from: playerView(from)
    });
    sendJson(res, 200, { inviteId: invite.id });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/computer/start") {
    const body = await readBody(req);
    const player = players.get(body.playerId);
    if (!player) {
      sendJson(res, 404, { error: "玩家不在线" });
      return;
    }
    if (player.gameId) {
      sendJson(res, 409, { error: "你正在对局中" });
      return;
    }

    const game = createComputerGame(player.id);
    sendJson(res, 200, { game: gameView(game) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/invite/respond") {
    const body = await readBody(req);
    const invite = invites.get(body.inviteId);
    if (!invite) {
      sendJson(res, 404, { error: "邀请已失效" });
      return;
    }

    const from = players.get(invite.from);
    const to = players.get(invite.to);
    if (!from || !to) {
      invites.delete(invite.id);
      sendJson(res, 404, { error: "玩家不在线" });
      return;
    }
    if (body.playerId !== to.id) {
      sendJson(res, 403, { error: "无权响应此邀请" });
      return;
    }

    invites.delete(invite.id);

    if (body.accepted) {
      if (from.gameId || to.gameId) {
        sendJson(res, 409, { error: "有玩家正在对局中" });
        return;
      }
      const game = createGame(from.id, to.id);
      sendEvent(from, "notice", { message: `${to.name} 接受了你的邀请` });
      sendJson(res, 200, { accepted: true, game: gameView(game) });
      return;
    }

    sendEvent(from, "notice", { message: `${to.name} 拒绝了你的邀请` });
    sendJson(res, 200, { accepted: false });
    return;
  }

  if (req.method === "POST" && url.pathname.startsWith("/api/game/")) {
    const [, apiPrefix, gamePrefix, gameId, action] = url.pathname.split("/");
    const game = games.get(gameId);
    const body = await readBody(req);
    const player = players.get(body.playerId);

    if (apiPrefix !== "api" || gamePrefix !== "game" || !gameId || !action) {
      sendJson(res, 404, { error: "接口不存在" });
      return;
    }

    if (!game || !player || !game.players.includes(player.id)) {
      sendJson(res, 404, { error: "对局不存在" });
      return;
    }

    if (action === "move") {
      const row = Number(body.row);
      const col = Number(body.col);
      if (game.finished) {
        sendJson(res, 409, { error: "对局已结束" });
        return;
      }
      if (game.turn !== player.id) {
        sendJson(res, 409, { error: "还没轮到你" });
        return;
      }
      if (
        !Number.isInteger(row) ||
        !Number.isInteger(col) ||
        row < 0 ||
        row >= BOARD_SIZE ||
        col < 0 ||
        col >= BOARD_SIZE ||
        game.board[row][col]
      ) {
        sendJson(res, 400, { error: "落子位置无效" });
        return;
      }

      const stone = game.stones[player.id];
      game.board[row][col] = stone;
      game.lastMove = { row, col, playerId: player.id, stone };

      if (hasFive(game.board, row, col, stone)) {
        finishGame(game, player.id, "five");
      } else if (isBoardFull(game.board)) {
        finishGame(game, null, "draw");
      } else {
        game.turn = game.players.find(playerId => playerId !== player.id);
        playComputerTurn(game);
      }

      notifyGame(game);
      sendJson(res, 200, { game: gameView(game) });
      return;
    }

    if (action === "resign") {
      if (!game.finished) {
        finishGame(game, game.players.find(playerId => playerId !== player.id), "resign");
        notifyGame(game);
      }
      sendJson(res, 200, { game: gameView(game) });
      return;
    }
  }

  sendJson(res, 404, { error: "接口不存在" });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/events") {
      const player = players.get(url.searchParams.get("playerId"));
      if (!player) {
        sendJson(res, 404, { error: "玩家不在线" });
        return;
      }

      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no"
      });
      res.write("\n");

      player.res = res;
      player.heartbeat = setInterval(() => {
        res.write(": ping\n\n");
      }, 15000);

      sendEvent(player, "peers", peersPayload());
      broadcastPeers();

      req.on("close", () => {
        clearInterval(player.heartbeat);
        if (players.get(player.id) === player) {
          cleanPlayer(player.id);
        }
      });
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res);
      return;
    }

    serveStatic(req, res);
  } catch (error) {
    sendJson(res, 500, { error: error.message || "服务器错误" });
  }
});

server.listen(PORT, HOST, () => {
  const addresses = publicAddresses();
  console.log(`LAN Gomoku is running at http://localhost:${PORT}`);
  if (addresses.length) {
    console.log("LAN addresses:");
    for (const address of addresses) console.log(`  ${address}`);
  } else {
    console.log("No LAN IPv4 address found yet.");
  }
});
