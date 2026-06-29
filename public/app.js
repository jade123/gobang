const state = {
  me: null,
  eventSource: null,
  players: [],
  game: null,
  pendingInvite: null,
  boardSize: 15,
  addresses: []
};

const elements = {
  lanAddress: document.querySelector("#lanAddress"),
  copyAddress: document.querySelector("#copyAddress"),
  joinPanel: document.querySelector("#joinPanel"),
  joinForm: document.querySelector("#joinForm"),
  nickname: document.querySelector("#nickname"),
  appPanel: document.querySelector("#appPanel"),
  myName: document.querySelector("#myName"),
  myStatus: document.querySelector("#myStatus"),
  onlineCount: document.querySelector("#onlineCount"),
  playersList: document.querySelector("#playersList"),
  gameTitle: document.querySelector("#gameTitle"),
  gameHint: document.querySelector("#gameHint"),
  board: document.querySelector("#board"),
  resignButton: document.querySelector("#resignButton"),
  inviteBox: document.querySelector("#inviteBox"),
  inviteText: document.querySelector("#inviteText"),
  acceptInvite: document.querySelector("#acceptInvite"),
  declineInvite: document.querySelector("#declineInvite"),
  toast: document.querySelector("#toast")
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "请求失败");
  }
  return data;
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.remove("hidden");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    elements.toast.classList.add("hidden");
  }, 2600);
}

function setAddresses(addresses) {
  state.addresses = addresses || [];
  const current = `${location.protocol}//${location.host}`;
  const address = state.addresses[0] || current;
  elements.lanAddress.textContent = `访问地址：${address}`;
}

function renderPlayers() {
  elements.playersList.innerHTML = "";
  elements.onlineCount.textContent = String(state.players.length);

  const others = state.players.filter(player => player.id !== state.me?.id);
  if (!others.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "还没有其他玩家在线";
    elements.playersList.append(empty);
    return;
  }

  for (const player of others) {
    const row = document.createElement("div");
    row.className = "player-row";

    const info = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = player.name;
    const status = document.createElement("span");
    status.textContent = player.status === "playing" ? "对局中" : "可邀请";
    info.append(name, status);

    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "邀请";
    button.disabled = player.status === "playing" || Boolean(state.game && !state.game.finished);
    button.addEventListener("click", () => invitePlayer(player.id));

    row.append(info, button);
    elements.playersList.append(row);
  }
}

function myStone() {
  return state.game?.players.find(player => player.id === state.me?.id)?.stone || null;
}

function playerName(playerId) {
  if (playerId === state.me?.id) return state.me.name;
  return state.players.find(player => player.id === playerId)?.name || "对手";
}

function isStarPoint(row, col) {
  return (
    (row === 3 && col === 3) ||
    (row === 3 && col === 11) ||
    (row === 7 && col === 7) ||
    (row === 11 && col === 3) ||
    (row === 11 && col === 11)
  );
}

function renderGame() {
  elements.board.innerHTML = "";
  const game = state.game;
  const playing = game && !game.finished;
  const mine = myStone();

  elements.resignButton.classList.toggle("hidden", !playing);
  elements.myStatus.textContent = playing ? `对局中，执${mine === "black" ? "黑" : "白"}` : "大厅中";

  if (!game) {
    elements.gameTitle.textContent = "等待邀请";
    elements.gameHint.textContent = "选择一位在线玩家，邀请他开始比赛。";
  } else if (game.finished) {
    const winnerText =
      game.reason === "draw"
        ? "平局"
        : game.winner === state.me.id
          ? "你赢了"
          : `${playerName(game.winner)} 赢了`;
    const reasonText = {
      five: "五子连线",
      resign: "认输结束",
      "opponent-left": "对手离线",
      draw: "棋盘下满"
    }[game.reason] || "对局结束";
    elements.gameTitle.textContent = winnerText;
    elements.gameHint.textContent = reasonText;
  } else {
    const turnMine = game.turn === state.me.id;
    elements.gameTitle.textContent = turnMine ? "轮到你落子" : `等待 ${playerName(game.turn)} 落子`;
    elements.gameHint.textContent = `你执${mine === "black" ? "黑" : "白"}，黑棋先行。`;
  }

  const board = game?.board || Array.from({ length: state.boardSize }, () => Array(state.boardSize).fill(null));
  for (let row = 0; row < state.boardSize; row += 1) {
    for (let col = 0; col < state.boardSize; col += 1) {
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "cell";
      if (row === 0) cell.classList.add("edge-top");
      if (row === state.boardSize - 1) cell.classList.add("edge-bottom");
      if (col === 0) cell.classList.add("edge-left");
      if (col === state.boardSize - 1) cell.classList.add("edge-right");
      if (isStarPoint(row, col)) cell.classList.add("star");
      cell.setAttribute("aria-label", `${row + 1} 行 ${col + 1} 列`);
      const value = board[row][col];

      if (isStarPoint(row, col)) {
        const star = document.createElement("span");
        star.className = "star-point";
        cell.append(star);
      }

      if (value) {
        const stone = document.createElement("span");
        stone.className = `stone ${value}`;
        cell.append(stone);
      }

      if (game?.lastMove?.row === row && game?.lastMove?.col === col) {
        cell.classList.add("last");
        const mark = document.createElement("span");
        mark.className = "move-mark";
        cell.append(mark);
      }

      cell.disabled = !playing || game.turn !== state.me?.id || Boolean(value);
      cell.addEventListener("click", () => placeStone(row, col));
      elements.board.append(cell);
    }
  }
}

function render() {
  if (state.me) {
    elements.joinPanel.classList.add("hidden");
    elements.appPanel.classList.remove("hidden");
    elements.myName.textContent = state.me.name;
  }
  renderPlayers();
  renderGame();
}

function connectEvents() {
  if (state.eventSource) state.eventSource.close();

  state.eventSource = new EventSource(`/events?playerId=${encodeURIComponent(state.me.id)}`);
  state.eventSource.addEventListener("peers", event => {
    const payload = JSON.parse(event.data);
    state.players = payload.players;
    setAddresses(payload.addresses);
    render();
  });
  state.eventSource.addEventListener("invite", event => {
    const invite = JSON.parse(event.data);
    state.pendingInvite = invite;
    elements.inviteText.textContent = `${invite.from.name} 邀请你下一盘五子棋`;
    elements.inviteBox.classList.remove("hidden");
  });
  state.eventSource.addEventListener("game", event => {
    state.game = JSON.parse(event.data);
    elements.inviteBox.classList.add("hidden");
    render();
  });
  state.eventSource.addEventListener("notice", event => {
    showToast(JSON.parse(event.data).message);
  });
  state.eventSource.onerror = () => {
    showToast("连接断开，正在尝试重连");
  };
}

async function join(name) {
  const data = await api("/api/join", {
    method: "POST",
    body: { name }
  });
  state.me = data.player;
  state.players = data.peers.players;
  setAddresses(data.peers.addresses);
  localStorage.setItem("lan-gomoku-name", name);
  connectEvents();
  render();
}

async function invitePlayer(playerId) {
  try {
    await api("/api/invite", {
      method: "POST",
      body: { from: state.me.id, to: playerId }
    });
    showToast("邀请已发送");
  } catch (error) {
    showToast(error.message);
  }
}

async function respondInvite(accepted) {
  if (!state.pendingInvite) return;
  try {
    const data = await api("/api/invite/respond", {
      method: "POST",
      body: {
        inviteId: state.pendingInvite.id,
        playerId: state.me.id,
        accepted
      }
    });
    if (data.game) state.game = data.game;
    state.pendingInvite = null;
    elements.inviteBox.classList.add("hidden");
    render();
  } catch (error) {
    showToast(error.message);
  }
}

async function placeStone(row, col) {
  if (!state.game) return;
  try {
    const data = await api(`/api/game/${state.game.id}/move`, {
      method: "POST",
      body: {
        playerId: state.me.id,
        row,
        col
      }
    });
    state.game = data.game;
    render();
  } catch (error) {
    showToast(error.message);
  }
}

async function resign() {
  if (!state.game || state.game.finished) return;
  try {
    const data = await api(`/api/game/${state.game.id}/resign`, {
      method: "POST",
      body: { playerId: state.me.id }
    });
    state.game = data.game;
    render();
  } catch (error) {
    showToast(error.message);
  }
}

elements.joinForm.addEventListener("submit", event => {
  event.preventDefault();
  const name = elements.nickname.value.trim();
  if (!name) {
    showToast("请输入昵称");
    return;
  }
  join(name).catch(error => showToast(error.message));
});

elements.acceptInvite.addEventListener("click", () => respondInvite(true));
elements.declineInvite.addEventListener("click", () => respondInvite(false));
elements.resignButton.addEventListener("click", resign);
elements.copyAddress.addEventListener("click", async () => {
  const address = state.addresses[0] || `${location.protocol}//${location.host}`;
  try {
    await navigator.clipboard.writeText(address);
    showToast("地址已复制");
  } catch {
    showToast(address);
  }
});

window.addEventListener("beforeunload", () => {
  if (!state.me) return;
  navigator.sendBeacon(
    "/api/leave",
    new Blob([JSON.stringify({ playerId: state.me.id })], { type: "application/json" })
  );
});

api("/api/config")
  .then(config => {
    state.boardSize = config.boardSize;
    setAddresses(config.addresses);
    renderGame();
  })
  .catch(() => {
    elements.lanAddress.textContent = `访问地址：${location.protocol}//${location.host}`;
  });

elements.nickname.value = localStorage.getItem("lan-gomoku-name") || "";
