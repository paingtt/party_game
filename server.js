// 聚会狼人杀 · 联网版 Demo 后端
// 零依赖：Node 内置 http + SSE 实时推送
// 本地运行：node server.js  （默认端口 3000）
// 云端部署：监听 process.env.PORT，可直接部署到 Render / Koyeb 等免费 Node 平台

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROLE_DEFS = {
  werewolf: { name: '狼人', emoji: '🐺', team: 'wolf' },
  seer:     { name: '预言家', emoji: '🔮', team: 'good' },
  witch:    { name: '女巫', emoji: '🧪', team: 'good' },
  hunter:   { name: '猎人', emoji: '🏹', team: 'good' },
  guard:    { name: '守卫', emoji: '🛡️', team: 'good' },
  villager: { name: '平民', emoji: '👨', team: 'good' },
};
const ROLE_ORDER = ['werewolf', 'seer', 'witch', 'hunter', 'guard', 'villager'];

const rooms = new Map(); // code -> room

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do {
    c = '';
    for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(c));
  return c;
}
function uid() { return Math.random().toString(36).slice(2, 10); }
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

function expandRoles(cfg) {
  const list = [];
  ROLE_ORDER.forEach(r => { for (let i = 0; i < (cfg[r] || 0); i++) list.push(r); });
  return list;
}
function alivePlayers(room) { return room.players.filter(p => p.alive); }
function nameOf(room, id) { const p = room.players.find(x => x.id === id); return p ? p.name : '?'; }
function aliveWolves(room) { return room.players.filter(p => p.isWolf && p.alive); }

function buildNightSteps(room) {
  const steps = [];
  if (aliveWolves(room).length > 0) steps.push('wolf');
  if (room.players.some(p => p.role === 'guard' && p.alive)) steps.push('guard');
  if (room.players.some(p => p.role === 'seer' && p.alive)) steps.push('seer');
  if (room.players.some(p => p.role === 'witch' && p.alive)) steps.push('witch');
  return steps;
}
const STEP_NAME = { wolf: '狼人行动', guard: '守卫行动', seer: '预言家查验', witch: '女巫行动' };

function log(room, msg) {
  room.log.push({ day: room.day, t: Date.now(), msg });
  if (room.log.length > 200) room.log.shift();
}

function kill(room, id, cause) {
  const p = room.players.find(x => x.id === id);
  if (!p || !p.alive) return;
  p.alive = false;
  const tag = cause === 'poison' ? '被女巫毒杀' : cause === 'vote' ? '被投票放逐' : cause === 'hunter' ? '被猎人开枪' : '夜晚被击杀';
  log(room, `${p.name}（${ROLE_DEFS[p.role].name}）${tag}。`);
  if (p.role === 'hunter' && cause !== 'poison') room.hunter = { pending: true, deadId: id };
}

function checkWin(room) {
  const wolves = room.players.filter(p => p.isWolf && p.alive).length;
  const good = room.players.filter(p => !p.isWolf && p.alive).length;
  if (wolves === 0) return 'good';
  if (wolves >= good) return 'wolf';
  return null;
}

// 为单个玩家生成视图（隐藏他人身份，按阶段过滤信息）
function view(room, pid) {
  const me = room.players.find(p => p.id === pid);
  if (!me) return { error: 'not_found' };
  const players = room.players.map(p => ({
    id: p.id, name: p.name, alive: p.alive,
    role: (room.phase === 'end') ? p.role : (p.id === pid ? p.role : null),
    isWolf: (room.phase === 'end') ? p.isWolf : (p.id === pid ? p.isWolf : null),
  }));
  let myAction = null;
  if (room.phase === 'night') {
    const step = room.night.steps[room.night.step];
    const a = room.night;
    if (step === 'wolf' && me.isWolf) {
      myAction = { type: 'wolf', targets: alivePlayers(room).filter(p => !p.isWolf).map(p => ({ id: p.id, name: p.name })), submitted: !!a.wolfVotes[pid] };
    } else if (step === 'guard' && me.role === 'guard') {
      myAction = { type: 'guard', targets: alivePlayers(room).filter(p => p.id !== room.guardLast).map(p => ({ id: p.id, name: p.name })), submitted: a.guardTarget != null };
    } else if (step === 'seer' && me.role === 'seer') {
      if (a.seerDone) myAction = { type: 'seer', done: true, result: a.seerResult };
      else myAction = { type: 'seer', targets: alivePlayers(room).map(p => ({ id: p.id, name: p.name })), submitted: false };
    } else if (step === 'witch' && me.role === 'witch') {
      myAction = {
        type: 'witch',
        victim: a.wolfTarget != null ? nameOf(room, a.wolfTarget) : null,
        healAvail: room.witch.heal, poisonAvail: room.witch.poison,
        submitted: a.witchDone,
      };
    }
  }
  let hunter = null;
  if (room.phase === 'hunter' && room.hunter && room.hunter.pending) {
    const h = room.players.find(p => p.id === room.hunter.deadId);
    if (h && h.id === pid) {
      hunter = { targets: alivePlayers(room).map(p => ({ id: p.id, name: p.name })) };
    } else {
      hunter = { waiting: true };
    }
  }
  return {
    code: room.code, phase: room.phase, day: room.day, hostId: room.hostId, you: { id: me.id, name: me.name, role: me.role, team: me.team, alive: me.alive, isWolf: me.isWolf },
    players, myAction,
    night: (room.phase === 'night') ? { step: room.night.step, stepName: STEP_NAME[room.night.steps[room.night.step]] || '', total: room.night.steps.length } : null,
    hunt: hunter,
    lastDeaths: room.lastDeaths || [],
    votesCount: Object.keys(room.votes).length,
    aliveCount: alivePlayers(room).length,
    chat: room.chat.slice(-60),
    log: room.log.slice(-25),
    result: room.phase === 'end' ? room.result : null,
  };
}

function broadcast(room) {
  room.clients.forEach((res, pid) => {
    try { res.write(`data: ${JSON.stringify(view(room, pid))}\n\n`); } catch (e) {}
  });
}

// ---------- 游戏流程 ----------
function startGame(room) {
  const list = expandRoles(room.roleConfig);
  if (list.length < 4 || room.players.length !== list.length) return false;
  shuffle(list);
  room.players.forEach((p, i) => {
    const r = list[i];
    p.role = r; p.team = ROLE_DEFS[r].team; p.isWolf = (r === 'werewolf');
  });
  room.day = 1;
  room.lastDeaths = [];
  startNight(room, true);
  log(room, `游戏开始，共 ${room.players.length} 人。`);
  return true;
}

function resetNight(room) {
  room.night = { steps: buildNightSteps(room), step: 0, wolfVotes: {}, guardTarget: null, seerTarget: null, seerDone: false, seerResult: null, witchHeal: false, witchPoison: null, witchDone: false };
}

function startNight(room, first) {
  room.phase = 'night';
  room.lastDeaths = [];
  resetNight(room);
  log(room, `第 ${room.day} 夜降临。`);
  broadcast(room);
}

function advanceNight(room) {
  const a = room.night;
  a.step++;
  if (a.step >= a.steps.length) { resolveNight(room); return; }
  log(room, `进入 ${STEP_NAME[a.steps[a.step]]}。`);
  broadcast(room);
}

function resolveNight(room) {
  const a = room.night;
  const deaths = [];
  if (a.wolfTarget != null) {
    const guarded = a.guardTarget === a.wolfTarget;
    const healed = a.witchHeal;
    if (!guarded && !healed) deaths.push({ id: a.wolfTarget, cause: 'night' });
    else if (guarded) log(room, `守卫守护了 ${nameOf(room, a.wolfTarget)}，狼刀失效。`);
    else if (healed) log(room, `女巫使用解药救活了 ${nameOf(room, a.wolfTarget)}。`);
  }
  if (a.witchPoison != null) deaths.push({ id: a.witchPoison, cause: 'poison' });
  room.lastDeaths = deaths.map(d => ({ name: nameOf(room, d.id), role: ROLE_DEFS[room.players.find(p => p.id === d.id).role].name }));
  deaths.forEach(d => kill(room, d.id, d.cause));
  room.guardLast = a.guardTarget;
  room.phase = 'day';
  log(room, '天亮了。');
  if (room.hunter && room.hunter.pending) { room.phase = 'hunter'; broadcast(room); return; }
  broadcast(room);
}

function startVote(room) {
  if (room.phase !== 'day') return;
  room.phase = 'vote';
  room.votes = {};
  log(room, '进入投票环节。');
  broadcast(room);
}

function finishVote(room) {
  const tally = {};
  Object.values(room.votes).forEach(t => { if (t !== -1 && t !== '-1') tally[t] = (tally[t] || 0) + 1; });
  let max = -1, winners = [];
  Object.keys(tally).forEach(k => { const v = tally[k]; if (v > max) { max = v; winners = [k]; } else if (v === max) winners.push(k); });
  let eliminated = null;
  if (winners.length === 0) log(room, '投票平票/弃票，无人出局。');
  else if (winners.length > 1) { eliminated = winners[Math.floor(Math.random() * winners.length)]; log(room, `票型平局，随机淘汰 ${nameOf(room, eliminated)}。`); }
  else { eliminated = winners[0]; log(room, `投票结果：${nameOf(room, eliminated)} 以 ${max} 票被放逐。`); }
  if (eliminated != null) kill(room, eliminated, 'vote');
  room.votes = {};
  if (room.hunter && room.hunter.pending) { room.phase = 'hunter'; broadcast(room); return; }
  afterVote(room);
}

function afterVote(room) {
  const w = checkWin(room);
  if (w) { room.phase = 'end'; room.result = w; log(room, w === 'good' ? '好人阵营胜利！' : '狼人阵营胜利！'); broadcast(room); return; }
  room.day++;
  startNight(room, false);
}

// ---------- HTTP ----------
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  // SSE
  if (url === '/api/events' && req.method === 'GET') {
    const q = new URL(req.url, 'http://x').searchParams;
    const code = q.get('code'), pid = q.get('player');
    const room = rooms.get(code);
    if (!room || !room.players.find(p => p.id === pid)) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    res.write(`data: ${JSON.stringify(view(room, pid))}\n\n`);
    room.clients.set(pid, res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 25000);
    req.on('close', () => { clearInterval(ping); if (room.clients.get(pid) === res) room.clients.delete(pid); const p = room.players.find(x => x.id === pid); if (p) p.connected = false; });
    return;
  }
  // static index
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
    return;
  }
  // JSON API
  if (url.startsWith('/api/') && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let data; try { data = JSON.parse(body || '{}'); } catch (e) { data = {}; }
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      const out = handleApi(url, data);
      res.end(JSON.stringify(out));
      if (out && out._broadcast && out._room) { broadcast(out._room); }
    });
    return;
  }
  res.writeHead(404); res.end('not found');
});

function handleApi(url, data) {
  switch (url) {
    case '/api/create': {
      const cfg = data.roles || {};
      const total = ROLE_ORDER.reduce((s, r) => s + (cfg[r] || 0), 0);
      if (total < 4) return { ok: false, error: '至少 4 人' };
      if ((cfg.werewolf || 0) < 1) return { ok: false, error: '至少 1 名狼人' };
      const code = genCode();
      const hostId = uid();
      const room = {
        code, hostId, day: 0, phase: 'lobby',
        players: [{ id: hostId, name: (data.name || '法官').slice(0, 12), role: null, team: null, isWolf: false, alive: true, connected: true }],
        roleConfig: cfg, night: null, witch: { heal: true, poison: true }, guardLast: null,
        votes: {}, chat: [], log: [], result: null, hunter: null, lastDeaths: [],
        clients: new Map(),
      };
      rooms.set(code, room);
      log(room, `房间 ${code} 已创建。`);
      return { ok: true, code, playerId: hostId, isHost: true };
    }
    case '/api/join': {
      const room = rooms.get(data.code);
      if (!room) return { ok: false, error: '房间不存在' };
      if (room.phase !== 'lobby') return { ok: false, error: '游戏已开始，无法加入' };
      const id = uid();
      room.players.push({ id, name: (data.name || '玩家').slice(0, 12), role: null, team: null, isWolf: false, alive: true, connected: true });
      return { ok: true, code: room.code, playerId: id, isHost: false };
    }
    case '/api/start': {
      const room = rooms.get(data.code);
      if (!room) return { ok: false, error: '房间不存在' };
      if (data.playerId !== room.hostId) return { ok: false, error: '只有法官能开始' };
      if (!startGame(room)) return { ok: false, error: '人数与角色配置不符' };
      return { ok: true, _broadcast: true, _room: room };
    }
    case '/api/action': {
      const room = rooms.get(data.code);
      if (!room) return { ok: false, error: '房间不存在' };
      const pid = data.playerId;
      const me = room.players.find(p => p.id === pid);
      if (!me) return { ok: false, error: '玩家不存在' };
      const type = data.type;
      if (type === 'chat') {
        const text = (data.text || '').toString().slice(0, 200);
        if (text) { room.chat.push({ name: me.name, text, ts: Date.now() }); if (room.chat.length > 100) room.chat.shift(); }
        return { ok: true, _broadcast: true, _room: room };
      }
      if (type === 'start_vote') {
        if (pid !== room.hostId) return { ok: false, error: '只有法官能开始投票' };
        startVote(room);
        return { ok: true, _broadcast: true, _room: room };
      }
      if (room.phase === 'night') {
        const step = room.night.steps[room.night.step];
        const a = room.night;
        if (step === 'wolf' && me.isWolf && type === 'wolf_kill') {
          a.wolfVotes[pid] = data.target != null ? data.target : null;
          if (Object.keys(a.wolfVotes).length >= aliveWolves(room).length) {
            const vals = Object.values(a.wolfVotes).filter(v => v != null);
            a.wolfTarget = vals.length ? vals[0] : null;
            log(room, `狼人选择击杀 ${a.wolfTarget != null ? nameOf(room, a.wolfTarget) : '无人'}。`);
            advanceNight(room);
          }
          return { ok: true, _broadcast: true, _room: room };
        }
        if (step === 'guard' && me.role === 'guard' && type === 'guard') {
          a.guardTarget = data.target != null ? data.target : null;
          advanceNight(room);
          return { ok: true, _broadcast: true, _room: room };
        }
        if (step === 'seer' && me.role === 'seer' && type === 'seer') {
          if (a.seerDone) return { ok: false, error: '今晚已查验' };
          const t = data.target;
          a.seerTarget = t; a.seerDone = true;
          const tp = room.players.find(p => p.id === t);
          a.seerResult = tp.isWolf ? 'wolf' : 'good';
          log(room, `预言家查验了 ${nameOf(room, t)}。`);
          advanceNight(room);
          return { ok: true, _broadcast: true, _room: room };
        }
        if (step === 'witch' && me.role === 'witch' && type === 'witch') {
          if (a.witchDone) return { ok: false, error: '已行动' };
          const heal = !!data.heal, poison = data.poison != null ? data.poison : null;
          if (heal && a.wolfTarget != null && room.witch.heal) { a.witchHeal = true; room.witch.heal = false; }
          if (poison != null && room.witch.poison && !heal) { a.witchPoison = poison; room.witch.poison = false; }
          a.witchDone = true;
          log(room, '女巫行动结束。');
          advanceNight(room);
          return { ok: true, _broadcast: true, _room: room };
        }
        return { ok: false, error: '当前不是你的行动阶段' };
      }
      if (room.phase === 'vote' && type === 'vote') {
        if (!me.alive) return { ok: false, error: '你已出局' };
        const t = data.target;
        if (t === -1 || t === '-1' || t == null) { room.votes[pid] = -1; }
        else {
          const tp = room.players.find(p => p.id === t);
          if (!tp || !tp.alive || tp.id === me.id) return { ok: false, error: '无效投票' };
          room.votes[pid] = t;
        }
        if (Object.keys(room.votes).length >= alivePlayers(room).length) finishVote(room);
        else broadcast(room);
        return { ok: true, _broadcast: room.phase === 'vote' ? false : true, _room: room };
      }
      if (room.phase === 'hunter' && room.hunter && room.hunter.pending && me.id === room.hunter.deadId && type === 'hunter_shoot') {
        const t = data.target != null ? data.target : null;
        if (t != null) { const tp = room.players.find(p => p.id === t); if (!tp || !tp.alive) return { ok: false, error: '无效目标' }; kill(room, t, 'hunter'); }
        room.hunter = null;
        const w = checkWin(room);
        if (w) { room.phase = 'end'; room.result = w; log(room, w === 'good' ? '好人阵营胜利！' : '狼人阵营胜利！'); }
        else { room.phase = 'day'; }
        return { ok: true, _broadcast: true, _room: room };
      }
      return { ok: false, error: '无效操作' };
    }
    default: return { ok: false, error: 'unknown' };
  }
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`聚会狼人杀(联网版) 已启动: http://localhost:${PORT}  (bind 0.0.0.0, PORT=${PORT})`);
});
