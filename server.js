// 聚会桌游 · 联网版 Demo 后端（狼人杀 / 杀人游戏 双模式）
// 零依赖：Node 内置 http + SSE 实时推送
// 本地运行：node server.js  （默认端口 3000）
// 云端部署：监听 process.env.PORT，可直接部署到 Render / SnapDeploy 等免费 Node 平台

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// ---------- 模式配置 ----------
// 每个模式定义：角色、角色顺序（用于建房步进器）、预设、夜间步骤顺序、步骤名、最小人数。
const MODES = {
  werewolf: {
    label: '狼人杀',
    roles: {
      werewolf: { name: '狼人', emoji: '🐺', team: 'wolf' },
      seer:     { name: '预言家', emoji: '🔮', team: 'good' },
      witch:    { name: '女巫', emoji: '🧪', team: 'good' },
      hunter:   { name: '猎人', emoji: '🏹', team: 'good' },
      guard:    { name: '守卫', emoji: '🛡️', team: 'good' },
      villager: { name: '平民', emoji: '👨', team: 'good' },
    },
    roleOrder: ['werewolf', 'seer', 'witch', 'hunter', 'guard', 'villager'],
    presets: {
      '6人':  { werewolf: 2, seer: 1, witch: 1, hunter: 0, guard: 0, villager: 2 },
      '8人':  { werewolf: 2, seer: 1, witch: 1, hunter: 1, guard: 0, villager: 3 },
      '9人':  { werewolf: 3, seer: 1, witch: 1, hunter: 1, guard: 0, villager: 3 },
      '10人': { werewolf: 3, seer: 1, witch: 1, hunter: 1, guard: 1, villager: 3 },
    },
    minPlayers: 4, minWolves: 1,
  },
  killgame: {
    label: '杀人游戏',
    roles: {
      killer:    { name: '杀手', emoji: '🔪', team: 'wolf' },
      sniper:    { name: '狙击手', emoji: '🎯', team: 'wolf' },
      terrorist: { name: '恐怖分子', emoji: '💣', team: 'wolf' },
      police:    { name: '警察', emoji: '🚓', team: 'good' },
      doctor:    { name: '医生', emoji: '⚕️', team: 'good' },
      butterfly: { name: '花蝴蝶', emoji: '🦋', team: 'good' },
      oldman:    { name: '森林老人', emoji: '🌲', team: 'good' },
      civilian:  { name: '平民', emoji: '🧑', team: 'good' },
    },
    roleOrder: ['killer', 'sniper', 'terrorist', 'police', 'doctor', 'butterfly', 'oldman', 'civilian'],
    presets: {
      '8人':  { killer: 2, sniper: 1, terrorist: 1, police: 1, doctor: 1, butterfly: 1, oldman: 1, civilian: 1 },
      '10人': { killer: 2, sniper: 1, terrorist: 1, police: 2, doctor: 1, butterfly: 1, oldman: 1, civilian: 2 },
      '12人': { killer: 3, sniper: 1, terrorist: 1, police: 2, doctor: 1, butterfly: 1, oldman: 1, civilian: 3 },
    },
    minPlayers: 6, minWolves: 1,
  },
};

const rooms = new Map(); // code -> room

function genCode() {
  let c;
  do {
    c = '';
    for (let i = 0; i < 4; i++) c += Math.floor(Math.random() * 10); // 4 位纯数字 0000-9999
  } while (rooms.has(c));
  return c;
}
function uid() { return Math.random().toString(36).slice(2, 10); }
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

function expandRoles(cfg, order) {
  const list = [];
  order.forEach(r => { for (let i = 0; i < (cfg[r] || 0); i++) list.push(r); });
  return list;
}
function alivePlayers(room) { return room.players.filter(p => p.alive); }
function aliveTeam(room, team) { return room.players.filter(p => p.alive && p.team === team); }
function nameOf(room, id) { const p = room.players.find(x => x.id === id); return p ? p.name : '?'; }

function buildNightSteps(room) {
  const steps = [];
  if (room.mode === 'werewolf') {
    if (aliveTeam(room, 'wolf').length > 0) steps.push('wolf');
    if (room.players.some(p => p.role === 'guard' && p.alive)) steps.push('guard');
    if (room.players.some(p => p.role === 'seer' && p.alive)) steps.push('seer');
    if (room.players.some(p => p.role === 'witch' && p.alive)) steps.push('witch');
  } else {
    if (room.players.some(p => p.role === 'butterfly' && p.alive)) steps.push('butterfly');
    if (room.players.some(p => p.role === 'sniper' && p.alive)) steps.push('sniper');
    if (room.players.some(p => p.role === 'killer' && p.alive)) steps.push('killer');
    if (room.players.some(p => p.role === 'doctor' && p.alive)) steps.push('doctor');
    if (room.players.some(p => p.role === 'police' && p.alive)) steps.push('police');
    if (room.players.some(p => p.role === 'oldman' && p.alive)) steps.push('oldman');
  }
  return steps;
}
const STEP_NAME = {
  werewolf: { wolf: '狼人行动', guard: '守卫行动', seer: '预言家查验', witch: '女巫行动' },
  killgame: { butterfly: '花蝴蝶护体', sniper: '狙击手狙击', killer: '杀手杀人', doctor: '医生救治', police: '警察指认', oldman: '森林老人禁言' },
};

function log(room, msg) {
  room.log.push({ day: room.day, t: Date.now(), msg });
  if (room.log.length > 200) room.log.shift();
}

function kill(room, id, cause) {
  const p = room.players.find(x => x.id === id);
  if (!p || !p.alive) return;
  p.alive = false;
  const RD = MODES[room.mode].roles;
  let tag;
  if (cause === 'poison') tag = '被女巫毒杀';
  else if (cause === 'bomb') tag = '被恐怖分子引爆';
  else if (cause === 'linked') tag = '与花蝴蝶同归于尽';
  else if (cause === 'vote') tag = '被投票放逐';
  else if (cause === 'hunter') tag = '被猎人开枪';
  else tag = '夜晚被击杀';
  log(room, `${p.name}（${RD[p.role].name}）${tag}。`);
  if (room.mode === 'werewolf' && p.role === 'hunter' && cause !== 'poison') room.hunter = { pending: true, deadId: id };
}

function checkWin(room) {
  if (room.mode === 'werewolf') return checkWinWerewolf(room);
  return checkWinKillgame(room);
}
function checkWinWerewolf(room) {
  const wolves = room.players.filter(p => p.isWolf && p.alive).length;
  const good = room.players.filter(p => !p.isWolf && p.alive).length;
  if (wolves === 0) return 'good';
  if (wolves >= good) return 'wolf';
  return null;
}
function checkWinKillgame(room) {
  const wolf = room.players.filter(p => p.alive && p.team === 'wolf').length;
  const good = room.players.filter(p => p.alive && p.team === 'good').length;
  const goodSpecial = room.players.filter(p => p.alive && p.team === 'good' && p.role !== 'civilian').length;
  if (wolf === 0) return 'good';
  if (goodSpecial === 0 || wolf >= good) return 'wolf';
  return null;
}

// 为单个玩家生成视图（隐藏他人身份，按阶段过滤信息）
function view(room, pid) {
  const me = room.players.find(p => p.id === pid);
  if (!me) return { error: 'not_found' };
  const RD = MODES[room.mode].roles;
  const players = room.players.map(p => ({
    id: p.id, name: p.name, alive: p.alive,
    role: (room.phase === 'end') ? p.role : (p.id === pid ? p.role : null),
    isWolf: (room.phase === 'end') ? p.isWolf : (p.id === pid ? p.isWolf : null),
  }));
  const myAction = buildMyAction(room, me);
  let hunter = null;
  if (room.mode === 'werewolf' && room.phase === 'hunter' && room.hunter && room.hunter.pending) {
    const h = room.players.find(p => p.id === room.hunter.deadId);
    if (h && h.id === pid) hunter = { targets: alivePlayers(room).map(p => ({ id: p.id, name: p.name })) };
    else hunter = { waiting: true };
  }
  return {
    mode: room.mode,
    code: room.code, phase: room.phase, day: room.day, hostId: room.hostId, noJudge: !!room.noJudge,
    you: { id: me.id, name: me.name, role: me.role, team: me.team, alive: me.alive, isWolf: me.isWolf },
    readyCount: room.ready ? room.ready.size : 0,
    readyTotal: room.players.length,
    youReady: !!(room.ready && room.ready.has(pid)),
    proceedCount: room.proceed ? [...room.proceed].filter(id => { const p = room.players.find(x => x.id === id); return p && p.alive; }).length : 0,
    proceedNeed: (() => { const n = alivePlayers(room).length; return n > 0 ? Math.floor(n / 2) + 1 : 0; })(),
    players, myAction,
    night: (room.phase === 'night') ? { steps: room.night.steps, step: room.night.step, stepName: (STEP_NAME[room.mode][room.night.steps[room.night.step]] || ''), total: room.night.steps.length } : null,
    hunt: hunter,
    lastDeaths: room.lastDeaths || [],
    votesCount: Object.keys(room.votes).length,
    aliveCount: alivePlayers(room).length,
    silencedName: room.silenced ? nameOf(room, room.silenced) : null,
    silencedId: room.silenced || null,
    terroristBombUsed: !!room.terroristBombUsed,
    chat: room.chat.slice(-60),
    log: room.log.slice(-25),
    result: room.phase === 'end' ? room.result : null,
  };
}

function buildMyAction(room, me) {
  if (room.phase !== 'night') return null;
  const a = room.night;
  const step = a.steps[a.step];
  const alive = alivePlayers(room).map(p => ({ id: p.id, name: p.name }));
  if (room.mode === 'werewolf') {
    if (step === 'wolf' && me.isWolf) {
      return { type: 'wolf', targets: alive.filter(p => !p.isWolf), submitted: !!a.wolfVotes[me.id] };
    } else if (step === 'guard' && me.role === 'guard') {
      return { type: 'guard', targets: alive.filter(p => p.id !== room.guardLast), submitted: a.guardTarget != null };
    } else if (step === 'seer' && me.role === 'seer') {
      if (a.seerDone) return { type: 'seer', done: true, result: a.seerResult };
      return { type: 'seer', targets: alive, submitted: false };
    } else if (step === 'witch' && me.role === 'witch') {
      return {
        type: 'witch',
        victim: a.wolfTarget != null ? nameOf(room, a.wolfTarget) : null,
        healAvail: room.witch.heal, poisonAvail: room.witch.poison,
        submitted: a.witchDone,
      };
    }
    return null;
  } else {
    if (step === 'butterfly' && me.role === 'butterfly') {
      return { type: 'butterfly', targets: alive.filter(p => p.id !== me.id), submitted: a.butterflyTarget != null };
    } else if (step === 'sniper' && me.role === 'sniper') {
      return { type: 'sniper', targets: alive, submitted: a.sniperTarget != null };
    } else if (step === 'killer' && me.role === 'killer') {
      return { type: 'killer', targets: alive.filter(p => p.team !== 'wolf'), submitted: !!a.killerVotes[me.id] };
    } else if (step === 'doctor' && me.role === 'doctor') {
      let victim = null;
      if (a.killerTarget != null) victim = nameOf(room, a.killerTarget);
      else if (a.sniperTarget != null) victim = nameOf(room, a.sniperTarget);
      return { type: 'doctor', targets: alive, victim, submitted: a.doctorDone };
    } else if (step === 'police' && me.role === 'police') {
      if (a.policeDone) return { type: 'police', done: true, result: a.policeResult };
      return { type: 'police', targets: alive, submitted: false };
    } else if (step === 'oldman' && me.role === 'oldman') {
      return { type: 'oldman', targets: alive.filter(p => p.id !== me.id), submitted: a.oldmanDone };
    }
    return null;
  }
}

function broadcast(room) {
  room.clients.forEach((res, pid) => {
    try { res.write(`data: ${JSON.stringify(view(room, pid))}\n\n`); } catch (e) {}
  });
}

// ---------- 游戏流程 ----------
function startGame(room) {
  const M = MODES[room.mode];
  const list = expandRoles(room.roleConfig, M.roleOrder);
  if (list.length < M.minPlayers || room.players.length !== list.length) return false;
  shuffle(list);
  room.players.forEach((p, i) => {
    const r = list[i];
    p.role = r; p.team = M.roles[r].team; p.isWolf = (M.roles[r].team === 'wolf');
  });
  room.day = 1;
  room.lastDeaths = [];
  room.emptyNeedles = {};
  room.terroristBombUsed = false;
  room.silenced = null;
  startNight(room, true);
  log(room, `游戏开始（${M.label}），共 ${room.players.length} 人。`);
  return true;
}

// 无法官模式：所有玩家都准备且人数符合配置时自动开局
function maybeAutoStart(room) {
  if (room.phase !== 'lobby' || !room.noJudge) return false;
  const list = expandRoles(room.roleConfig, MODES[room.mode].roleOrder);
  if (room.players.length !== list.length) return false;
  if (!room.players.every(p => room.ready.has(p.id))) return false;
  return startGame(room);
}

function resetNight(room) {
  const a = { steps: buildNightSteps(room), step: 0 };
  if (room.mode === 'werewolf') {
    a.wolfVotes = {}; a.guardTarget = null; a.seerTarget = null; a.seerDone = false; a.seerResult = null;
    a.witchHeal = false; a.witchPoison = null; a.witchDone = false;
  } else {
    a.butterflyTarget = null; a.sniperTarget = null; a.killerVotes = {}; a.killerTarget = null;
    a.doctorTarget = null; a.doctorDone = false; a.policeTarget = null; a.policeDone = false; a.policeResult = null;
    a.oldmanTarget = null; a.oldmanDone = false;
  }
  room.night = a;
}

function startNight(room, first) {
  room.phase = 'night';
  room.proceed = new Set();
  room.lastDeaths = [];
  room.silenced = null;
  resetNight(room);
  room.night.stepAt = Date.now();
  log(room, `第 ${room.day} 夜降临。`);
  skipUnrunnable(room);
  broadcast(room);
}

function advanceNight(room) {
  const a = room.night;
  a.step++;
  room.proceed = new Set();
  if (a.step >= a.steps.length) { resolveNight(room); return; }
  skipUnrunnable(room);
  a.stepAt = Date.now();
  broadcast(room);
}

// 无法官模式：夜晚某步的在线角色长时间不操作，超时自动跳过该步，避免全场卡死
const NIGHT_STEP_TIMEOUT = 45000;
function checkNightTimeouts() {
  const now = Date.now();
  rooms.forEach(room => {
    if (room.phase === 'night' && room.night && room.night.stepAt && now - room.night.stepAt > NIGHT_STEP_TIMEOUT) {
      if (stepActorConnected(room)) {
        log(room, `步骤超时（${STEP_NAME[room.mode][room.night.steps[room.night.step]] || '当前步骤'}），自动跳过。`);
        advanceNight(room);
      } else {
        skipUnrunnable(room);
        if (room.phase === 'night') broadcast(room);
      }
    }
  });
}

// 当前夜晚步骤是否有「在线且存活」的角色可以操作
function stepActorConnected(room) {
  const a = room.night;
  if (!a || a.step >= a.steps.length) return false;
  const step = a.steps[a.step];
  const any = (role) => room.players.some(p => p.role === role && p.alive && p.connected);
  if (room.mode === 'werewolf') {
    if (step === 'wolf') return aliveTeam(room, 'wolf').some(p => p.connected);
    if (step === 'guard') return any('guard');
    if (step === 'seer') return any('seer');
    if (step === 'witch') return any('witch');
  } else {
    if (step === 'butterfly') return any('butterfly');
    if (step === 'sniper') return any('sniper');
    if (step === 'killer') return any('killer');
    if (step === 'doctor') return any('doctor');
    if (step === 'police') return any('police');
    if (step === 'oldman') return any('oldman');
  }
  return false;
}

// 若当前步骤负责角色全部掉线/离线，则自动跳过该步骤，避免游戏卡死
function skipUnrunnable(room) {
  const a = room.night;
  let guard = 0;
  while (room.phase === 'night' && a.step < a.steps.length && !stepActorConnected(room)) {
    if (guard++ > 30) break;
    const skipped = STEP_NAME[room.mode][a.steps[a.step]];
    a.step++;
    if (a.step >= a.steps.length) { resolveNight(room); return; }
    log(room, `跳过 ${skipped}（该角色无人操作）`);
  }
  if (room.phase === 'night' && a.step < a.steps.length) {
    log(room, `进入 ${STEP_NAME[room.mode][a.steps[a.step]]}。`);
  }
}

function resolveNight(room) {
  if (room.mode === 'werewolf') return resolveNightWerewolf(room);
  return resolveNightKillgame(room);
}

function resolveNightWerewolf(room) {
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
  room.lastDeaths = deaths.map(d => ({ name: nameOf(room, d.id), role: MODES.werewolf.roles[room.players.find(p => p.id === d.id).role].name }));
  deaths.forEach(d => kill(room, d.id, d.cause));
  room.guardLast = a.guardTarget;
  room.phase = 'day';
  room.proceed = new Set();
  log(room, '天亮了。');
  if (room.hunter && room.hunter.pending) { room.phase = 'hunter'; broadcast(room); return; }
  const w = checkWin(room);
  if (w) { room.phase = 'end'; room.result = w; log(room, w === 'good' ? '好人阵营胜利！' : '狼人阵营胜利！'); broadcast(room); return; }
  broadcast(room);
}

function resolveNightKillgame(room) {
  const a = room.night;
  const RD = MODES.killgame.roles;
  const deaths = new Map(); // id -> cause
  if (a.killerTarget != null) deaths.set(a.killerTarget, 'night');
  if (a.sniperTarget != null) deaths.set(a.sniperTarget, 'night');

  const butterfly = room.players.find(p => p.role === 'butterfly' && p.alive);
  const bt = a.butterflyTarget;

  // 花蝴蝶护体：若花蝴蝶本人未死，则被保护者免疫今晚一切致死效果
  if (butterfly && bt != null && !deaths.has(butterfly.id)) {
    deaths.delete(bt);
  }
  // 医生：救活被刀/狙者；否则累计一次空针，两次空针扎死
  if (a.doctorTarget != null) {
    if (deaths.has(a.doctorTarget)) {
      deaths.delete(a.doctorTarget);
      room.emptyNeedles[a.doctorTarget] = 0;
    } else {
      room.emptyNeedles[a.doctorTarget] = (room.emptyNeedles[a.doctorTarget] || 0) + 1;
      if (room.emptyNeedles[a.doctorTarget] >= 2) deaths.set(a.doctorTarget, 'poison');
    }
  }
  // 花蝴蝶连带：若花蝴蝶今晚死亡，其保护的人也与她同死
  if (butterfly && bt != null && deaths.has(butterfly.id)) {
    deaths.set(bt, 'linked');
  }
  // 森林老人禁言（非致死）
  if (a.oldmanTarget != null) room.silenced = a.oldmanTarget;

  room.lastDeaths = Array.from(deaths.keys()).map(id => ({ name: nameOf(room, id), role: RD[room.players.find(p => p.id === id).role].name }));
  deaths.forEach((cause, id) => kill(room, id, cause));
  room.phase = 'day';
  room.proceed = new Set();
  log(room, '天亮了。');
  const w = checkWin(room);
  if (w) { room.phase = 'end'; room.result = w; log(room, w === 'good' ? '好人阵营胜利！' : '杀手阵营胜利！'); }
  broadcast(room);
}

function startVote(room) {
  if (room.phase !== 'day') return;
  room.phase = 'vote';
  room.proceed = new Set();
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
  if (room.mode === 'werewolf' && room.hunter && room.hunter.pending) { room.phase = 'hunter'; broadcast(room); return; }
  afterVote(room);
}

function maybeFinishVote(room) {
  const alive = alivePlayers(room);
  const connectedAlive = alive.filter(p => p.connected);
  const allConnectedVoted = connectedAlive.length > 0 && connectedAlive.every(p => room.votes[p.id] !== undefined);
  if (connectedAlive.length === 0 || allConnectedVoted) finishVote(room);
  else broadcast(room);
}

function afterVote(room) {
  const w = checkWin(room);
  if (w) { room.phase = 'end'; room.result = w; log(room, w === 'good' ? '好人阵营胜利！' : (room.mode === 'werewolf' ? '狼人阵营胜利！' : '杀手阵营胜利！')); broadcast(room); return; }
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
    const _sp = room.players.find(x => x.id === pid);
    if (_sp) _sp.connected = true;
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 25000);
    req.on('close', () => {
      clearInterval(ping);
      if (room.clients.get(pid) === res) room.clients.delete(pid);
      const p = room.players.find(x => x.id === pid);
      if (p) p.connected = false;
      // 断线兜底：夜晚当前步骤角色全部离线 → 自动跳过；投票阶段若只剩离线者未投 → 自动结算
      if (room.phase === 'night' && !stepActorConnected(room)) { skipUnrunnable(room); broadcast(room); }
      else if (room.phase === 'vote') { maybeFinishVote(room); }
    });
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
      const mode = MODES[data.mode] ? data.mode : 'werewolf';
      const M = MODES[mode];
      const cfg = data.roles || {};
      const total = M.roleOrder.reduce((s, r) => s + (cfg[r] || 0), 0);
      if (total < M.minPlayers) return { ok: false, error: `至少 ${M.minPlayers} 人` };
      const wolves = M.roleOrder.filter(r => M.roles[r].team === 'wolf').reduce((s, r) => s + (cfg[r] || 0), 0);
      if (wolves < M.minWolves) return { ok: false, error: `至少 ${M.minWolves} 名杀手/狼人` };
      const code = genCode();
      const hostId = uid();
      const room = {
        code, mode, hostId, day: 0, phase: 'lobby',
        noJudge: !!data.noJudge, ready: new Set(), proceed: new Set(),
        players: [{ id: hostId, name: (data.name || (data.noJudge ? '玩家' : '法官')).slice(0, 12), role: null, team: null, isWolf: false, alive: true, connected: true }],
        roleConfig: cfg, night: null, votes: {}, chat: [], log: [], result: null, lastDeaths: [], clients: new Map(),
        emptyNeedles: {}, terroristBombUsed: false, silenced: null,
      };
      if (mode === 'werewolf') { room.witch = { heal: true, poison: true }; room.guardLast = null; room.hunter = null; }
      rooms.set(code, room);
      log(room, `房间 ${code} 已创建（${M.label}）。`);
      return { ok: true, code, playerId: hostId, isHost: true };
    }
    case '/api/join': {
      const room = rooms.get(data.code);
      if (!room) return { ok: false, error: '房间不存在' };
      if (room.phase !== 'lobby') return { ok: false, error: '游戏已开始，无法加入' };
      const id = uid();
      room.players.push({ id, name: (data.name || '玩家').slice(0, 12), role: null, team: null, isWolf: false, alive: true, connected: true });
      const started = room.noJudge ? maybeAutoStart(room) : false;
      return { ok: true, code: room.code, playerId: id, isHost: false, _broadcast: started, _room: room };
    }
    case '/api/start': {
      const room = rooms.get(data.code);
      if (!room) return { ok: false, error: '房间不存在' };
      if (data.playerId !== room.hostId) return { ok: false, error: '只有法官能开始' };
      if (!startGame(room)) return { ok: false, error: '人数与角色配置不符' };
      return { ok: true, _broadcast: true, _room: room };
    }
    case '/api/leave': {
      const room = rooms.get(data.code);
      if (!room) return { ok: true }; // 房间已不在也视为成功
      // 只有 host 在 lobby 阶段可以"销毁房间"返回主界面；其他情况仅将自己标记离线
      const pid = data.playerId;
      if (room.hostId === pid && room.phase === 'lobby') {
        rooms.delete(data.code);
        return { ok: true, destroyed: true };
      }
      const me = room.players.find(p => p.id === pid);
      if (me) me.connected = false;
      if (room.ready) room.ready.delete(pid);
      if (room.proceed) room.proceed.delete(pid);
      return { ok: true };
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
      if (type === 'ready') {
        if (room.phase !== 'lobby') return { ok: false, error: '游戏已开始' };
        if (!room.noJudge) return { ok: false, error: '该房间为法官模式' };
        if (room.ready.has(pid)) return { ok: true };
        room.ready.add(pid);
        const started = maybeAutoStart(room);
        if (!started) {
          const list = expandRoles(room.roleConfig, MODES[room.mode].roleOrder);
          if (room.players.length !== list.length)
            log(room, `需恰好 ${list.length} 人才能开始（当前 ${room.players.length} 人，且需全员准备）`);
        }
        return { ok: true, _broadcast: true, _room: room };
      }
      if (type === 'proceed') {
        if (!room.noJudge) return { ok: false, error: '该房间为法官模式' };
        if (!me.alive) return { ok: false, error: '出局玩家无法推进' };
        if (room.phase !== 'day' && room.phase !== 'vote' && room.phase !== 'night') return { ok: false, error: '当前阶段无需确认' };
        room.proceed.add(pid);
        const alive = alivePlayers(room);
        const need = Math.floor(alive.length / 2) + 1; // 超过一半
        const got = [...room.proceed].filter(id => { const p = room.players.find(x => x.id === id); return p && p.alive; }).length;
        if (got >= need) {
          room.proceed = new Set();
          if (room.phase === 'day') { startVote(room); return { ok: true, _broadcast: true, _room: room }; }
          if (room.phase === 'vote') { log(room, `多数玩家确认，提前结算投票。`); finishVote(room); return { ok: true, _broadcast: true, _room: room }; }
          if (room.phase === 'night') {
            if (stepActorConnected(room)) { log(room, `多数玩家确认，跳过 ${STEP_NAME[room.mode][room.night.steps[room.night.step]] || '当前步骤'}。`); advanceNight(room); return { ok: true, _broadcast: true, _room: room }; }
            broadcast(room); return { ok: true, _broadcast: true, _room: room };
          }
        }
        return { ok: true, _broadcast: true, _room: room };
      }
      if (type === 'start_vote') {
        if (pid !== room.hostId) return { ok: false, error: '只有法官能开始投票' };
        startVote(room);
        return { ok: true, _broadcast: true, _room: room };
      }
      if (type === 'host_skip') {
        if (pid !== room.hostId) return { ok: false, error: '只有法官能跳过' };
        if (room.phase !== 'night') return { ok: false, error: '现在无法跳过' };
        const cur = STEP_NAME[room.mode][room.night.steps[room.night.step]] || '当前步骤';
        log(room, `法官跳过了 ${cur}。`);
        advanceNight(room);
        return { ok: true, _broadcast: true, _room: room };
      }
      if (type === 'host_force_vote') {
        if (pid !== room.hostId) return { ok: false, error: '只有法官能结算' };
        if (room.phase !== 'vote') return { ok: false, error: '现在无法结算' };
        log(room, '法官强制结束投票并结算。');
        finishVote(room);
        return { ok: true, _broadcast: true, _room: room };
      }
      if (type === 'terrorist_bomb') {
        if (room.mode !== 'killgame') return { ok: false, error: '无效操作' };
        if (room.phase !== 'day' && room.phase !== 'vote') return { ok: false, error: '现在不能引爆' };
        if (me.role !== 'terrorist') return { ok: false, error: '只有恐怖分子能引爆' };
        if (room.terroristBombUsed) return { ok: false, error: '本局已引爆过' };
        if (!me.alive) return { ok: false, error: '你已出局' };
        const t = data.target; const tp = room.players.find(p => p.id === t);
        if (!tp || !tp.alive || tp.id === me.id) return { ok: false, error: '无效目标' };
        room.terroristBombUsed = true;
        kill(room, me.id, 'bomb');
        if (tp.team !== 'wolf') kill(room, tp.id, 'bomb');
        log(room, `恐怖分子引爆，与 ${tp.name} 同归于尽。`);
        const w = checkWin(room);
        if (w) { room.phase = 'end'; room.result = w; log(room, w === 'good' ? '好人阵营胜利！' : '杀手阵营胜利！'); }
        return { ok: true, _broadcast: true, _room: room };
      }
      if (room.phase === 'night') {
        const step = room.night.steps[room.night.step];
        const a = room.night;
        if (room.mode === 'werewolf') {
          if (step === 'wolf' && me.isWolf && type === 'wolf_kill') {
            a.wolfVotes[pid] = data.target != null ? data.target : null;
            const connWolves = aliveTeam(room, 'wolf').filter(p => p.connected).length;
            if (connWolves > 0 && Object.keys(a.wolfVotes).length >= connWolves) {
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
        } else {
          if (step === 'butterfly' && me.role === 'butterfly' && type === 'butterfly') {
            a.butterflyTarget = data.target != null ? data.target : null;
            advanceNight(room);
            return { ok: true, _broadcast: true, _room: room };
          }
          if (step === 'sniper' && me.role === 'sniper' && type === 'sniper') {
            a.sniperTarget = data.target != null ? data.target : null;
            advanceNight(room);
            return { ok: true, _broadcast: true, _room: room };
          }
          if (step === 'killer' && me.role === 'killer' && type === 'killer') {
            if (a.killerTarget != null) return { ok: false, error: '杀手已选定目标' };
            a.killerTarget = data.target != null ? data.target : null;
            log(room, `杀手选择击杀 ${a.killerTarget != null ? nameOf(room, a.killerTarget) : '无人'}。`);
            advanceNight(room);
            return { ok: true, _broadcast: true, _room: room };
          }
          if (step === 'doctor' && me.role === 'doctor' && type === 'doctor') {
            if (a.doctorDone) return { ok: false, error: '已行动' };
            a.doctorTarget = data.target != null ? data.target : null; a.doctorDone = true;
            log(room, '医生行动结束。');
            advanceNight(room);
            return { ok: true, _broadcast: true, _room: room };
          }
          if (step === 'police' && me.role === 'police' && type === 'police') {
            if (a.policeDone) return { ok: false, error: '已查验' };
            const t = data.target;
            if (t == null) return { ok: false, error: '请选择查验目标' };
            const tp = room.players.find(p => p.id === t);
            if (!tp) return { ok: false, error: '无效目标' };
            a.policeTarget = t; a.policeDone = true;
            a.policeResult = tp.team === 'wolf' ? 'wolf' : 'good';
            log(room, `警察查验了 ${nameOf(room, t)}。`);
            advanceNight(room);
            return { ok: true, _broadcast: true, _room: room };
          }
          if (step === 'oldman' && me.role === 'oldman' && type === 'oldman') {
            if (a.oldmanDone) return { ok: false, error: '已行动' };
            a.oldmanTarget = data.target != null ? data.target : null; a.oldmanDone = true;
            log(room, '森林老人行动结束。');
            advanceNight(room);
            return { ok: true, _broadcast: true, _room: room };
          }
          return { ok: false, error: '当前不是你的行动阶段' };
        }
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
        maybeFinishVote(room);
        return { ok: true, _broadcast: room.phase === 'vote' ? false : true, _room: room };
      }
      if (room.phase === 'hunter' && room.mode === 'werewolf' && room.hunter && room.hunter.pending && me.id === room.hunter.deadId && type === 'hunter_shoot') {
        const t = data.target != null ? data.target : null;
        if (t != null) { const tp = room.players.find(p => p.id === t); if (!tp || !tp.alive) return { ok: false, error: '无效目标' }; kill(room, t, 'hunter'); }
        room.hunter = null;
        const w = checkWin(room);
        if (w) { room.phase = 'end'; room.result = w; log(room, w === 'good' ? '好人阵营胜利！' : '狼人阵营胜利！'); }
        else { room.phase = 'day'; room.proceed = new Set(); }
        return { ok: true, _broadcast: true, _room: room };
      }
      return { ok: false, error: '无效操作' };
    }
    default: return { ok: false, error: 'unknown' };
  }
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`聚会桌游(联网版) 已启动: http://localhost:${PORT}  (bind 0.0.0.0, PORT=${PORT})`);
});

setInterval(checkNightTimeouts, 5000);
