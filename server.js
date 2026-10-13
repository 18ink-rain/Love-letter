const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ---------- 牌堆定义 ----------
// 与服务端判定、前端「规则说明 / 牌谱」共用同一份数据（cards.js）
const { CARD_DEF } = require('./cards');

function buildDeck() {
  const deck = [];
  CARD_DEF.forEach(c => {
    for (let i = 0; i < c.count; i++) {
      deck.push({ ...c, uid: Math.random().toString(36).slice(2, 9) });
    }
  });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// ---------- 房间 ----------
const rooms = {};

function genRoomId() {
  let id = '';
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  do {
    id = '';
    for (let i = 0; i < 4; i++) id += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms[id]);
  return id;
}

function newPlayer(id, name) {
  return { id, name, hand: [], discards: [], out: false, protected: false, score: 0 };
}

function createRoom(hostId, hostName) {
  const roomId = genRoomId();
  rooms[roomId] = {
    id: roomId,
    host: hostId,
    players: [newPlayer(hostId, hostName)],
    deck: [],
    table: [],      // 全场公共牌桌：按出牌先后顺序摆放，所有人可见
    turn: 0,
    state: 'waiting',
    log: [],
    winner: null,
    round: 0,        // 已打完的局数，第一局开始后为 1
    firstId: null,   // 下一局的先手玩家 id（默认房主，之后为上局胜者）
  };
  return rooms[roomId];
}

function joinRoom(roomId, playerId, playerName) {
  const room = rooms[roomId];
  if (!room) return { error: '房间不存在' };
  if (room.players.length >= 4) return { error: '房间已满' };
  if (room.state !== 'waiting') return { error: '游戏已开始' };
  room.players.push(newPlayer(playerId, playerName));
  return { room };
}

/** 开一局新游戏：重置牌桌并确定先手（第一局房主先手，之后由上一局胜者先手） */
function startGame(room) {
  room.round = (room.round || 0) + 1;
  room.deck = buildDeck();
  room.table = [];
  room.players.forEach(p => {
    p.hand = [room.deck.pop()];
    p.discards = [];
    p.out = false;
    p.protected = false;
  });

  let firstIdx = room.players.findIndex(p => p.id === room.firstId);
  if (firstIdx < 0) firstIdx = 0;
  room.turn = firstIdx;

  room.state = 'playing';
  room.log = [];
  room.winner = null;
  addLog(room, `第 ${room.round} 局开始！共 ${room.players.length} 人。`);
  // 给先手玩家摸一张牌，让他有两张手牌
  const first = room.players[room.turn];
  drawCard(room, first);
  io.to(room.id).emit('fx', { type: 'draw', playerId: first.id });
}

function addLog(room, text) {
  room.log.push(text);
  if (room.log.length > 50) room.log.shift();
}

function drawCard(room, player) {
  if (room.deck.length === 0) return null;
  const card = room.deck.pop();
  player.hand.push(card);
  return card;
}

function checkMustPlayCountess(player) {
  const hasCountess = player.hand.some(c => c.id === 7);
  const hasKingOrPrince = player.hand.some(c => c.id === 6 || c.id === 5);
  return hasCountess && hasKingOrPrince;
}

function resolvePlay(room, playerId, cardUid, targetId, guessId) {
  const player = room.players.find(p => p.id === playerId);
  if (!player || player.out) return { error: '你已出局' };
  if (room.players[room.turn].id !== playerId) return { error: '还没轮到你' };
  if (room.state !== 'playing') return { error: '游戏未进行' };

  const cardIndex = player.hand.findIndex(c => c.uid === cardUid);
  if (cardIndex === -1) return { error: '手牌中没有这张牌' };
  const card = player.hand[cardIndex];

  if (checkMustPlayCountess(player) && card.id !== 7) {
    return { error: '你必须打出伯爵夫人' };
  }

  // 打出牌：个人弃牌堆用于结算比大小，公共牌桌用于中间的展示与动画
  player.hand.splice(cardIndex, 1);
  player.discards.push(card);
  room.table.push({
    uid: card.uid,
    cardId: card.id,
    name: card.name,
    point: card.point,
    playerId: player.id,
    playerName: player.name,
    kind: 'play',
  });
  addLog(room, `${player.name} 打出【${card.name}】`);
  
  // 通知玩家手牌减少
  io.to(playerId).emit('yourHand', player.hand);

  const target = targetId ? room.players.find(p => p.id === targetId) : null;

  switch (card.id) {
    case 1: // 卫兵
      if (!target) return { error: '需要选择目标' };
      if (target.protected) { addLog(room, `${target.name} 受到侍女保护，无效`); break; }
      if (guessId) {
        const guessed = CARD_DEF.find(c => c.id === guessId);
        const hit = target.hand.some(c => c.id === guessId);
        if (hit) {
          target.out = true;
          addLog(room, `${target.name} 被猜中【${guessed.name}】，出局！`);
        } else {
          addLog(room, `猜错了，${target.name} 安全。`);
        }
        // 驱动「命中 / 落空」特效；被猜中时这张牌本来就要公开
        io.to(room.id).emit('fx', {
          type: 'guess', byId: player.id, targetId: target.id,
          hit, cardId: hit ? guessId : null,
        });
      }
      break;
    case 2: // 神父
      if (!target) return { error: '需要选择目标' };
      if (target.protected) {
        addLog(room, `${target.name} 受到侍女保护，无效`);
        io.to(playerId).emit('privateInfo', { targetName: target.name, blocked: true });
        break;
      }
      {
        // 下发结构化结果，客户端才能画出卡面；牌堆耗尽时目标可能已无手牌
        const seen = target.hand[0];
        io.to(playerId).emit('privateInfo', {
          targetName: target.name,
          card: seen ? { id: seen.id, name: seen.name, point: seen.point } : null,
        });
        addLog(room, `${player.name} 查看了 ${target.name} 的手牌`);
      }
      break;
    case 3: // 男爵
      if (!target) return { error: '需要选择目标' };
      if (target.protected) { addLog(room, `${target.name} 受到侍女保护，无效`); break; }
      {
        const p1 = player.hand[0].point;
        const p2 = target.hand[0].point;
        addLog(room, `${player.name} 与 ${target.name} 比大小：${p1} vs ${p2}`);
        let loser = null;
        if (p1 > p2) { target.out = true; loser = target.id; addLog(room, `${target.name} 出局`); }
        else if (p2 > p1) { player.out = true; loser = player.id; addLog(room, `${player.name} 出局`); }
        else { addLog(room, '平局，无事发生'); }
        // 比点数时双方是亮牌的，可以广播给所有人做「对决」动画
        io.to(room.id).emit('fx', {
          type: 'duel',
          a: { id: player.id, name: player.name, cardId: player.hand[0].id },
          b: { id: target.id, name: target.name, cardId: target.hand[0].id },
          loserId: loser,
        });
      }
      break;
    case 4: // 侍女
      player.protected = true;
      addLog(room, `${player.name} 获得保护`);
      break;
    case 5: // 王子
      if (!target) return { error: '需要选择目标' };
      // 侍女的保护只挡「别人指定你」，自己对自己用王子是合法的
      if (target.protected && target.id !== player.id) {
        addLog(room, `${target.name} 受到侍女保护，无效`);
        break;
      }
      if (!target.hand.length) { addLog(room, `${target.name} 没有手牌可弃`); break; }
      {
        const self = target.id === player.id;
        const old = target.hand.pop();
        target.discards.push(old);
        room.table.push({
          uid: old.uid,
          cardId: old.id,
          name: old.name,
          point: old.point,
          playerId: target.id,
          playerName: target.name,
          kind: 'discard',
        });
        addLog(room, `${target.name} 弃掉【${old.name}】${self ? '（指定自己）' : ''}`);
        if (old.id === 8) {
          target.out = true;
          addLog(room, `${target.name} 弃掉公主，出局！`);
        } else {
          const newCard = drawCard(room, target);
          if (newCard) addLog(room, `${target.name} 重新摸了一张牌`);
          else addLog(room, `牌堆已空，${target.name} 没有摸到牌`);
        }
      }
      break;
    case 6: // 国王
      if (!target) return { error: '需要选择目标' };
      if (target.protected) { addLog(room, `${target.name} 受到侍女保护，无效`); break; }
      if (!player.hand.length || !target.hand.length) { addLog(room, '有人没有手牌，交换失败'); break; }
      {
        const tmp = player.hand[0];
        player.hand[0] = target.hand[0];
        target.hand[0] = tmp;
        addLog(room, `${player.name} 与 ${target.name} 交换了手牌`);
      }
      break;
    case 7: // 伯爵夫人
      addLog(room, `伯爵夫人没有效果`);
      break;
    case 8: // 公主
      player.out = true;
      addLog(room, `${player.name} 打出公主，出局！`);
      break;
  }

  // 王子、国王会改动别人的手牌，这里统一给每位玩家重发自己最新的手牌，
  // 避免对方客户端停留在旧手牌上。
  syncHands(room);

  const alive = room.players.filter(p => !p.out);
  if (alive.length <= 1) {
    if (alive.length === 1) endRound(room, [alive[0].id], `🏆 ${alive[0].name} 获胜！`);
    else endRound(room, [], '所有玩家都已出局，本局无人获胜。');
    return { ok: true };
  }

  advanceTurn(room);
  return { ok: true };
}

/** 把当前玩家的回合交给下一位存活玩家，并让他摸牌 */
function advanceTurn(room) {
  let next = room.turn;
  for (let i = 0; i < room.players.length; i++) {
    next = (next + 1) % room.players.length;
    if (!room.players[next].out) break;
  }
  room.turn = next;

  if (room.deck.length === 0) {
    endByPoints(room);
    return;
  }

  const current = room.players[room.turn];
  drawCard(room, current);
  current.protected = false;

  // 通知当前玩家手牌增加（私有）
  io.to(current.id).emit('yourHand', current.hand);
  io.to(room.id).emit('fx', { type: 'draw', playerId: current.id });

  // 注意：这里不能再用 io.to(room.id) 群发同一份状态，
  // 否则每人收到的「自己手牌点数」会被后发的通用版本覆盖（值为 null）。
  broadcastState(room);
}

/** 给房间内每位玩家各发一份自己的手牌 */
function syncHands(room) {
  room.players.forEach(p => io.to(p.id).emit('yourHand', p.hand));
}

/** 只剩一人（或无人）时收尾本局 */
function finishIfSolo(room) {
  const alive = room.players.filter(p => !p.out);
  if (alive.length > 1) return false;
  if (alive.length === 1) endRound(room, [alive[0].id], `🏆 ${alive[0].name} 获胜！`);
  else endRound(room, [], '所有玩家都已出局，本局无人获胜。');
  return true;
}

/** 认输退出本局：判为出局，但玩家仍留在房间里观战，下一局自动回到牌桌 */
function forceOut(room, player, logText) {
  player.out = true;
  addLog(room, logText);
  if (finishIfSolo(room)) return;

  if (room.players[room.turn].id === player.id) advanceTurn(room);
  else { syncHands(room); broadcastState(room); }
}

/** 把玩家移出房间；若牌局进行中则等同于出局，牌局继续 */
function leaveRoom(room, socket) {
  const idx = room.players.findIndex(p => p.id === socket.id);
  if (idx === -1) return;

  const playing = room.state === 'playing';
  const player = room.players[idx];
  const wasTurn = playing && room.players[room.turn].id === socket.id;
  const curId = playing ? room.players[room.turn].id : null;

  room.players.splice(idx, 1);
  socket.leave(room.id);

  if (!room.players.length) { delete rooms[room.id]; return; }
  if (room.host === socket.id) room.host = room.players[0].id;
  addLog(room, `${player.name} 离开了房间`);

  if (!playing) { broadcastState(room); return; }
  if (finishIfSolo(room)) return;

  if (wasTurn) {
    // 退回离开者的前一位，再由 advanceTurn 顺延到他的下一位
    room.turn = (idx - 1 + room.players.length) % room.players.length;
    advanceTurn(room);
  } else {
    room.turn = Math.max(0, room.players.findIndex(p => p.id === curId));
    syncHands(room);
    broadcastState(room);
  }
}

/** 统一的收尾：记分、决定下一局先手、公开全场手牌、通知客户端 */
function endRound(room, winnerIds, reason) {
  room.state = 'ended';
  room.winner = winnerIds || [];
  room.winner.forEach(id => {
    const p = room.players.find(x => x.id === id);
    if (p) p.score += 1;
  });
  room.firstId = room.winner.length ? room.winner[0] : null;
  if (reason) addLog(room, reason);

  const names = room.winner
    .map(id => (room.players.find(p => p.id === id) || {}).name)
    .filter(Boolean)
    .join('、');

  io.to(room.id).emit('gameEnd', {
    winner: names || '无人',
    winnerId: room.winner,
    round: room.round,
    // 结算时公开所有人的剩余手牌
    reveal: room.players.map(p => ({
      id: p.id,
      name: p.name,
      out: p.out,
      score: p.score,
      hand: p.hand.map(c => ({ id: c.id, name: c.name, point: c.point })),
    })),
  });
  broadcastState(room);          // 让客户端看到最终牌桌（含各自弃牌堆）
}

function endByPoints(room) {
  const alive = room.players.filter(p => !p.out);
  const handPoint = p => (p.hand[0] ? p.hand[0].point : 0);
  const bestDiscard = p => p.discards.reduce((m, c) => Math.max(m, c.point), 0);

  let maxPoint = -1;
  let winners = [];
  alive.forEach(p => {
    const pt = handPoint(p);
    if (pt > maxPoint) { maxPoint = pt; winners = [p]; }
    else if (pt === maxPoint) { winners.push(p); }
  });
  if (winners.length > 1) {
    let maxDiscard = -1;
    winners.forEach(p => { maxDiscard = Math.max(maxDiscard, bestDiscard(p)); });
    winners = winners.filter(p => bestDiscard(p) === maxDiscard);
  }
  const names = winners.map(w => w.name).join('、');
  endRound(room, winners.map(w => w.id), `牌堆已空，${names} 获胜！`);
}

function serializeRoom(room, viewerId) {
  // 本局结束后全场公开：所有人都能看到彼此的剩余手牌
  const ended = room.state === 'ended';
  return {
    id: room.id,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      handCount: p.hand.length,
      // 只把「自己」剩余手牌的点数发给本人，用于男爵比大小等判断，避免泄露他人手牌
      remainingPoint: p.id === viewerId ? handPointOf(p) : null,
      hand: ended ? p.hand.map(c => ({ id: c.id, name: c.name, point: c.point })) : null,
      discards: p.discards.map(c => ({ id: c.id, name: c.name, point: c.point })),
      out: p.out,
      protected: p.protected,
      score: p.score || 0,
    })),
    deckCount: room.deck.length,
    // 全场公共牌桌：出牌顺序 + 谁打的，中间区域据此渲染与播放动画
    table: (room.table || []).map(t => ({
      uid: t.uid, cardId: t.cardId, name: t.name, point: t.point,
      playerId: t.playerId, playerName: t.playerName, kind: t.kind,
    })),
    turn: room.turn,
    state: room.state,
    log: room.log,
    host: room.host,
    round: room.round || 0,
  };
}

function handPointOf(player) {
  return player.hand[0] ? player.hand[0].point : 0;
}

/** 给房间内每位玩家各发一份「只含自己手牌信息」的状态 */
function broadcastState(room) {
  room.players.forEach(p => {
    io.to(p.id).emit('stateUpdate', serializeRoom(room, p.id));
  });
}

io.on('connection', (socket) => {
  socket.on('createRoom', (name, cb) => {
    const room = createRoom(socket.id, name);
    socket.join(room.id);
    cb({ roomId: room.id, state: serializeRoom(room, socket.id) });
  });

  socket.on('joinRoom', (roomId, name, cb) => {
    const res = joinRoom(roomId, socket.id, name);
    if (res.error) return cb({ error: res.error });
    socket.join(roomId);
    broadcastState(res.room);
    cb({ roomId, state: serializeRoom(res.room, socket.id) });
  });

  socket.on('startGame', (roomId) => {
    const room = rooms[roomId];
    if (!room) return;
    if (room.host !== socket.id) return;
    if (room.state !== 'waiting') return;
    startGame(room);
    // 给每个人发自己的手牌（仅本人可见）
    syncHands(room);
    broadcastState(room);
  });

  // 多轮次：房主在结算面板点「下一局」，房间与玩家保持不变，累计胜场继续记
  socket.on('nextRound', (roomId, cb) => {
    const room = rooms[roomId];
    if (!room) return cb && cb({ error: '房间不存在' });
    if (room.host !== socket.id) return cb && cb({ error: '只有房主可以开始下一局' });
    if (room.state !== 'ended') return cb && cb({ error: '本局还没有结束' });
    if (room.players.length < 2) return cb && cb({ error: '至少需要 2 人才能开始' });
    startGame(room);
    syncHands(room);
    broadcastState(room);
    cb && cb({ ok: true });
  });

  socket.on('playCard', ({ roomId, cardUid, targetId, guessId }, cb) => {
    const room = rooms[roomId];
    if (!room) return cb({ error: '房间不存在' });
    const res = resolvePlay(room, socket.id, cardUid, targetId, guessId);
    if (res.error) return cb({ error: res.error });
    broadcastState(room);
    cb({ ok: true });
  });

  // 认输退出本局：判为出局，留在房间里观战（下一局自动回到牌桌）
  socket.on('quitRound', (roomId, cb) => {
    const room = rooms[roomId];
    if (!room) return cb && cb({ error: '房间不存在' });
    if (room.state !== 'playing') return cb && cb({ error: '当前没有进行中的对局' });
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return cb && cb({ error: '你不在这个房间里' });
    if (player.out) return cb && cb({ error: '你已经出局了' });
    forceOut(room, player, `${player.name} 认输，退出本局`);
    cb && cb({ ok: true });
  });

  // 离开房间：回到大厅（牌局进行中则等同于出局）
  socket.on('leaveRoom', (roomId, cb) => {
    const room = rooms[roomId];
    if (!room) return cb && cb({ error: '房间不存在' });
    if (!room.players.some(p => p.id === socket.id)) return cb && cb({ error: '你不在这个房间里' });
    leaveRoom(room, socket);
    cb && cb({ ok: true });
  });

  socket.on('disconnect', () => {
    Object.keys(rooms).forEach(rid => {
      const room = rooms[rid];
      if (room && room.players.some(p => p.id === socket.id)) leaveRoom(room, socket);
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ 情书服务器运行中：http://localhost:${PORT}`);
});