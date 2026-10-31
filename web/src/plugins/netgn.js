// NETGN.R32: network play. The original wraps DirectPlay 3 (DPLAYX.DLL) for
// the lobby, and adds G-Nome's own messages that keep units in step during a
// game. Here DirectPlay is web/src/net/dplay.js, running over a browser
// transport (web/src/net/buses.js). Reversed from the G-Nome build; see
// docs/netgn.md for the externs, the message layouts and the script side.
//
// Calls are synchronous as in the original. Externs get the arguments after
// the plugin context; pointers are VM byte addresses; string arguments are
// RTLIB32 string ids.
import { DirectPlay, SYS } from "../net/dplay.js";
import { BroadcastBus, RtcBus, ServerBus } from "../net/buses.js";

const MAX_BUF = 0x400; // NETGN caps its message buffer at 1 KB
const LISTEN_BUF = 0x144; // NetDPListen's buffer (0x10014310)
const SPEED_SCALE = 100; // ctx+0x10 = 100.0f: speed on the wire is x 100
const CONN_TYPE = 3; // DPInit's answer; 1 TCP/IP and 2 modem need an address dialog

// Message kinds (first byte) of the in-game messages. NetDPListen returns the
// kind and script list 5987 runs the handler script for it.
export const KIND = {
  NONE: 1,
  RELIABLE: 2, // original only: {2, u16 seq, message}, acked by {3, u16 seq}
  ACK: 3,
  CREATE: 4, // NetDPSendCreDO
  DESTROY: 6, // NetDPSendDestObj (0x1d when the flag property is 0)
  DAMAGE: 7,
  STEAL: 8,
  STOLE: 9,
  STEAL_DENIED: 0xa,
  EJECT: 0xb,
  PLAYER_JOINED: 0xc, // DirectPlay system messages, re-coded by NetDPListen
  PLAYER_LEFT: 0xd,
  HITCHED: 0xe,
  SCRIPT: 0xf, // DPSendMsg / NetDPSendMsg: u32 (type << 8 | 0xf), data
  MOVE: 0x10, // NetDPSendUpdNDO, full transform (0x11: flag property < 1)
  STILL: 0x12, // stopped: two properties only (0x13)
  GROUND: 0x14, // on the ground and upright: x, z, at (0x15)
  IFF: 0x16,
  HOST: 0x17,
  DO: 0x18, // NetDPSendUpdDO: position and orientation of a class >= 300 object
  CRASHED: 0x19, // class < 100 with property 133 set
  SMALL: 0x1a, // class < 100, full transform
  PLEASE_KILL: 0x1b, // 0x1c when the flag property is 0
  DESTROY0: 0x1d,
};

function defaultProviders() {
  const list = [];
  if (typeof BroadcastChannel === "function" && typeof window === "object") {
    list.push({ name: "Browser Tabs On This Computer", open: () => new BroadcastBus() });
  }
  if (typeof location === "object" && typeof RTCPeerConnection === "function" && location.protocol.startsWith("http")) {
    const base = new URL("/net/", location.href).href;
    const p = { name: "Internet (WebRTC)", open: () => new RtcBus(base), available: false };
    ServerBus.probe(base).then((ok) => (p.available = ok));
    list.push(p);
  }
  return list;
}

export class NetPlugin {
  // engine.netOptions: { providers: [{name, open() -> bus, available?}] }
  constructor(engine) {
    this.engine = engine;
    this.name = "netgn";
    this.providerList = engine.netOptions?.providers || defaultProviders();
    this.dp = null;
    this.bus = null;
    this.maxPlayers = 0; // ctx[0xf]
    this.slots = []; // ctx[0x11]: player table, 1-based indices for the scripts
    this.local = 0; // ctx[0x12]: our dpid
    this.host = 0; // ctx[0x19]
    this.sessionTable = []; // FUN_100011de: session index -> guid, kept across refreshes
    this.lastHeard = new Map(); // dpid -> time of their last message (+0x1d)
    this.msg = new Uint8Array(LISTEN_BUF); // the last NetDPListen message
    this.msgLen = 0;
    this.sent = new Map(); // net id -> last update sent (0x1001aa10, 0x36 bytes each)
    this.maxLatency = 0; // ctx[0x17]

    const n = (f) => (...a) => f.apply(this, a);
    this.externs = {
      DPIsValidVersion: () => 1,
      DPCheckForConnect: () => 0, // not started from a lobby program
      DPEnumProviders: n(this.enumProviders),
      DPInit: n(this.init),
      DPInitINetAddress: () => 1,
      DPInitPhoneAddress: () => 1,
      DPInitSerialAddress: () => 1,
      DPDeInit: n(this.deinit),
      DPEnumSessions: n(this.enumSessions),
      DPEnableNewPlayers: () => 0,
      DPEnumInSession: n(this.enumInSession),
      DPJoinSession: n(this.joinSession),
      DPCreateSession: n(this.createSession),
      DPClose: n(this.close),
      DPEnumPlayers: n(this.enumPlayers),
      DPCreatePlayer: n(this.createPlayer),
      DPDestroyPlayer: n(this.destroyPlayer),
      DPGetNumPlayers: () => this.slots.filter(Boolean).length,
      DPGetPlayerInfo: n(this.getPlayerInfo),
      DPGetMaxBufLen: () => MAX_BUF,
      DPGetIndex: (dpid) => this.index(dpid),
      DPPlayerIsHost: () => this.host,
      DPSendMsg: n(this.sendScriptMsg),
      DPReceiveMsg: n(this.receive),
      DPBufToStr: n(this.bufToStr),
      DPStrToBuf: n(this.strToBuf),

      NetDPListen: n(this.listen),
      NetDPGetMsg: n(this.getMsg),
      NetDPProcessMessage: n(this.process),
      NetDPDelta: n(this.delta),
      NetDPLostConnect: (dpid, ms) => (this.now() - (this.lastHeard.get(dpid) ?? 0) > ms >>> 0 ? 1 : 0),
      NetDPGetLocalID: () => this.msg[1],
      NetDPGetTag: () => this.msg[2],
      NetDPGetTarget: () => (this.msg[0] === KIND.CREATE ? this.msg[0x28] : this.msg[0] === KIND.DAMAGE ? this.msg[0xc] : this.msg[2]),
      NetDPGetInstance: () => this.msg[7],
      NetDPGetIndx: () => this.msg[0x29],
      NetDPGetType: () => this.dv().getUint16(0x2a, true),
      NetDPGetSeed: () => this.dv().getInt32(3, true),
      NetDPGetHealth: () => this.dv().getInt16(4, true),
      NetDPGetArmor: () => this.dv().getInt16(6, true),
      NetDPGetParent: () => this.dv().getInt32(8, true),
      NetDPGetKiller: () => this.dv().getInt32(7, true),
      NetDPGetShields: (obj, p) => this.setProp(obj, p, this.dv().getInt8(3)),
      NetDPSendMsg: n(this.sendRawMsg),
      NetDPSendCreDO: n(this.sendCreate),
      NetDPSendDamage: n(this.sendDamage),
      NetDPSendDestObj: n(this.sendDestroy),
      NetDPSendPleaseKill: n(this.sendPleaseKill),
      NetDPSendSteal: n(this.sendSteal),
      NetDPSendStole: n(this.sendStole),
      NetDPSendEject: n(this.sendEject),
      NetDPSendHitched: n(this.sendHitched),
      NetDPSendIFF: n(this.sendIFF),
      NetDPSendUpdDO: n(this.sendUpdateDO),
      NetDPSendUpdNDO: n(this.sendUpdate),
    };
  }

  now() {
    return this.engine.time;
  }

  get providers() {
    return this.providerList.filter((p) => p.available !== false);
  }

  service() {
    this.dp?.service();
    if (this.dp && this.local) {
      for (const dpid of this.slots) if (dpid && dpid !== this.local) this.maxLatency = Math.max(this.maxLatency, this.dp.latency(dpid));
    }
  }

  // ---------------------------------------------------------- VM helpers

  vm() {
    return this.engine.vm;
  }
  dv() {
    return new DataView(this.msg.buffer);
  }
  store(addr, v) {
    if (addr) this.vm().store(addr, v | 0);
  }
  load(addr) {
    return addr ? this.vm().load(addr) : 0;
  }
  readBytes(addr, n) {
    return this.vm().u8.slice(addr, addr + Math.max(0, n));
  }
  writeBytes(addr, bytes) {
    if (addr) this.vm().u8.set(bytes, addr);
  }
  str(id) {
    return this.engine.getString(id) ?? "";
  }
  setStr(id, s) {
    this.engine.setString(id, s);
  }
  // RtRunMsg: run a script right away with arguments, in a frame 32 locals
  // below the caller's (the call record's nlocals byte is set to 0x20).
  // Returns 1 unless the script returned 0.
  runMsg(script, args) {
    const vm = this.vm();
    const saved = vm.retval;
    vm.retval = 1;
    try {
      vm.callScript(script, 0x20, args);
    } catch (e) {
      this.engine.log(`netgn: script ${script} failed: ${e.message}`);
    }
    const r = vm.retval;
    vm.retval = saved;
    return r;
  }

  // --------------------------------------------------------- the lobby

  // DPEnumProviders(nameStr, script): script(major, minor) per provider with
  // its name in nameStr; stops when the script returns 0. The original adds
  // "MPath MPlayer" last (the Mplayer service, long gone); this does not.
  enumProviders(nameStr, script) {
    let n = 0;
    for (const p of this.providers) {
      this.setStr(nameStr, p.name);
      n++;
      if (!this.runMsg(script, [0, 0])) break;
    }
    return n;
  }

  // DPInit(nameStr, index, maxPlayers): pick a provider by name, or by
  // index when the name is empty. Returns the connection type (1 TCP/IP,
  // 2 modem, 3 IPX, 4 other; 5 = Mplayer, the scripts then quit), 0 on
  // failure. Type 3 makes the scripts refresh the session list by
  // themselves.
  init(nameStr, index, maxPlayers) {
    const name = this.str(nameStr);
    const list = this.providers;
    const p = name ? list.find((q) => q.name === name) : list[index];
    if (!p) return 0;
    this.deinit();
    this.maxPlayers = maxPlayers || 8;
    this.bus = p.open();
    this.dp = new DirectPlay(this.bus, { now: () => this.now(), log: (m) => this.engine.log(m) });
    this.dp.requestSessions();
    this.engine.log(`netgn: using ${p.name}`);
    return CONN_TYPE;
  }

  deinit() {
    if (!this.dp) return 0;
    if (this.local) this.destroyPlayer();
    this.dp.leave();
    this.bus.close();
    this.dp = this.bus = null;
    this.slots = [];
    this.host = 0;
    this.sessionTable = [];
    return 0;
  }

  // DPEnumSessions(nameStr, timeout, script): script(index, maxPlayers,
  // currentPlayers) per session, name in nameStr. DirectPlay waits up to
  // `timeout` ms for answers; here the list is what hosts answered to
  // earlier requests (the scripts ask every 3 s). Returns how many sessions
  // it reported (FUN_100019cb counts them; the scripts draw that many rows).
  enumSessions(nameStr, timeout, script) {
    if (!this.dp) return 0;
    let count = 0;
    for (const s of this.dp.enumSessions()) {
      if (!s.name) continue;
      let i = this.sessionTable.indexOf(s.guid);
      if (i < 0) i = this.sessionTable.push(s.guid) - 1;
      this.setStr(nameStr, s.name.slice(0, 20));
      count++;
      if (!this.runMsg(script, [i, s.max, s.members.length])) break;
    }
    return count;
  }

  // DPCreateSession(nameStr, passwordStr)
  createSession(nameStr, pwStr) {
    if (!this.dp) return 0;
    this.dp.createSession(this.str(nameStr).slice(0, 20), this.maxPlayers, this.str(pwStr));
    this.slots = new Array(this.maxPlayers).fill(0);
    this.host = 1;
    this.sent.clear();
    return 1;
  }

  // DPJoinSession(index, passwordStr): join, then register the session's
  // players (EnumPlayers with FUN_10001aeb).
  joinSession(index, pwStr) {
    const guid = this.sessionTable[index];
    if (!this.dp || !guid || !this.dp.joinSession(guid, this.str(pwStr))) return 0;
    this.slots = new Array(this.maxPlayers).fill(0);
    this.host = 0;
    this.sent.clear();
    for (const dpid of this.dp.players.keys()) this.register(dpid);
    return 1;
  }

  close() {
    this.dp?.leave();
    this.slots = [];
    this.local = 0;
    return 1;
  }

  // DPEnumInSession(?, nameStr, longStr, script): register every player in
  // the session; script(dpid, count) for each when script is not 0.
  enumInSession(unused, nameStr, longStr, script) {
    if (!this.dp) return 0;
    let count = 0;
    for (const p of this.dp.players.values()) {
      this.setStr(nameStr, p.name);
      this.setStr(longStr, p.long);
      if (++count > this.maxPlayers) return 0;
      this.register(p.dpid);
      if (script) this.runMsg(script, [p.dpid, count]);
    }
    return 0;
  }

  // DPEnumPlayers(nameStr, longStr, script): script(dpid, index) for every
  // registered player. Returns how many.
  enumPlayers(nameStr, longStr, script) {
    if (!this.dp) return 0;
    let n = 0;
    for (let i = 0; i < this.slots.length; i++) {
      const dpid = this.slots[i];
      if (!dpid) continue;
      const p = this.dp.players.get(dpid);
      this.setStr(nameStr, p?.name ?? "");
      this.setStr(longStr, p?.long ?? "");
      n++;
      if (!this.runMsg(script, [dpid, i + 1])) break;
    }
    return n;
  }

  // DPCreatePlayer(nameStr, longStr, ?, ?): our player; returns its dpid.
  createPlayer(nameStr, longStr) {
    if (!this.dp) return 0;
    const dpid = this.dp.createPlayer(this.str(nameStr), this.str(longStr));
    if (!dpid) return 0;
    this.register(dpid);
    this.local = dpid;
    return dpid;
  }

  destroyPlayer() {
    if (!this.dp || !this.local) return 0;
    this.dp.destroyPlayer(this.local);
    this.local = 0;
    return 1;
  }

  // DPGetPlayerInfo(dpid, &index, nameStr)
  getPlayerInfo(dpid, indexAddr, nameStr) {
    const i = this.index(dpid);
    this.store(indexAddr, i);
    this.setStr(nameStr, i > 0 ? this.dp?.players.get(dpid)?.name ?? "" : "");
    return 1;
  }

  // FUN_10001d11: 1-based slot of a player, -1 if unknown, 0 for dpid 0.
  index(dpid) {
    if (!dpid) return 0;
    const i = this.slots.indexOf(dpid);
    return i < 0 ? -1 : i + 1;
  }

  // FUN_10001493 / FUN_100015b8: add or free a slot.
  register(dpid) {
    if (!dpid || this.slots.includes(dpid)) return 0;
    const i = this.slots.indexOf(0);
    if (i < 0) return 0;
    this.slots[i] = dpid;
    this.lastHeard.set(dpid, this.now());
    return i + 1;
  }
  unregister(dpid) {
    const i = this.slots.indexOf(dpid);
    if (i >= 0) this.slots[i] = 0;
  }

  // DPSendMsg(to, flags, type, buf, len): u32 (type << 8 | 0xf), then len
  // bytes. to 0 = everyone. Flag 1 = guaranteed (all messages are here).
  sendScriptMsg(to, flags, type, buf, len) {
    if (!this.local) return 0;
    const b = new Uint8Array(4 + Math.min(Math.max(0, len), MAX_BUF - 4));
    new DataView(b.buffer).setUint32(0, ((type << 8) | 0xf) >>> 0, true);
    b.set(this.readBytes(buf, b.length - 4), 4);
    return this.send(b, to);
  }

  // NetDPSendMsg(to, flags, buf, len): like DPSendMsg, but the type is the
  // buffer's first word, which it rewrites in place to (type << 8 | 0xf).
  sendRawMsg(to, flags, buf, len) {
    if (!this.local) return 0;
    this.store(buf, (this.load(buf) << 8) | 0xf);
    return this.send(this.readBytes(buf, Math.min(len, MAX_BUF)), to);
  }

  send(bytes, to = 0) {
    if (!this.dp || !this.local) return 0;
    return this.dp.send(this.local, to, bytes) ? 1 : 0;
  }

  // DPReceiveMsg(&isSystem, &from, &type, buf, &len, copy): the next
  // message for our player (from *from only, when it is not 0). System
  // messages copy their DPMSG struct from its second word; player messages
  // their data after the type word. Returns 0 when there is none.
  receive(sysAddr, fromAddr, typeAddr, buf, lenAddr, copy) {
    this.store(typeAddr, 0);
    if (!this.dp || !this.local) return 0;
    const m = this.next(this.load(fromAddr));
    if (!m) return 0;
    if (m.from === 0) {
      const sys = this.sysBytes(m.sys);
      let cap = this.load(lenAddr);
      if (m.sys.type === SYS.CREATEPLAYER) {
        this.register(m.sys.dpid);
        cap = Math.min(cap, 0x28);
      } else if (m.sys.type === SYS.DESTROYPLAYER) {
        this.unregister(m.sys.dpid);
        cap = Math.min(cap, 0x1c);
      } else if (m.sys.type === SYS.HOST || m.sys.type === SYS.SESSIONLOST) {
        this.host = 1;
        cap = 0;
      } else {
        this.store(lenAddr, sys.length);
      }
      if (copy && cap) this.writeBytes(buf, sys.subarray(4, 4 + cap));
      this.store(typeAddr, m.sys.type);
      this.store(sysAddr, 1);
      this.store(fromAddr, 0);
      return 1;
    }
    this.store(sysAddr, 0);
    this.store(fromAddr, m.from);
    this.lastHeard.set(m.from, this.now());
    const head = new DataView(m.bytes.buffer, m.bytes.byteOffset).getUint32(0, true);
    if ((head & 0xff) !== KIND.SCRIPT) return 1; // a game message: type stays 0
    const type = head >>> 8;
    if (type === 0x65) {
      this.store(lenAddr, 0x18); // file transfer: no script sends files
    } else if (type === 0x66) {
      this.destroyPlayer(); // the host asked us to leave
      this.store(lenAddr, 0);
    } else if (type !== 0x67) {
      if (copy) this.writeBytes(buf, m.bytes.subarray(4, 4 + this.load(lenAddr)));
      this.store(lenAddr, m.bytes.length);
    }
    this.store(typeAddr, type);
    return 1;
  }

  // The next queued message, optionally only from one player.
  next(from) {
    if (!this.dp) return null;
    const q = this.dp.queue;
    const i = from ? q.findIndex((m) => m.from === from) : q.length ? 0 : -1;
    return i < 0 ? null : q.splice(i, 1)[0];
  }

  // DirectPlay's system message structs: DPMSG_CREATEPLAYERORGROUP and
  // DPMSG_DESTROYPLAYERORGROUP start {type, playerType (1 = player), dpid};
  // pointers (data, names) are 0.
  sysBytes(sys) {
    const b = new Uint8Array(0x30);
    const dv = new DataView(b.buffer);
    dv.setUint32(0, sys.type, true);
    if (sys.dpid) {
      dv.setUint32(4, 1, true);
      dv.setUint32(8, sys.dpid, true);
      if (sys.type === SYS.CREATEPLAYER) dv.setUint32(12, this.slots.filter(Boolean).length, true);
    }
    return b;
  }

  // DPBufToStr(str, buf, n) / DPStrToBuf(buf, str, n): copy up to 255 bytes.
  bufToStr(strId, buf, n) {
    const b = this.readBytes(buf, Math.min(n, 255));
    const end = b.indexOf(0);
    this.setStr(strId, String.fromCharCode(...(end < 0 ? b : b.subarray(0, end))));
    return 0;
  }
  strToBuf(buf, strId, n) {
    const s = this.str(strId);
    const b = new Uint8Array(Math.min(n, 255));
    for (let i = 0; i < s.length && i < b.length; i++) b[i] = s.charCodeAt(i);
    this.writeBytes(buf, b);
    return 0;
  }

  // ------------------------------------------------------- in the game

  // NetDPListen(&from): take the next message into the listen buffer and
  // return its kind (0 when there is none, 1 for nothing to do). System
  // messages become kinds 0xc (joined, from = the new dpid), 0xd (left) and
  // 0x17 (we are host now).
  listen(fromAddr) {
    if (!this.dp) return 0;
    const m = this.dp.receive();
    if (!m) return 0;
    this.msg.fill(0);
    let kind = KIND.NONE;
    if (m.from === 0) {
      const sys = this.sysBytes(m.sys);
      this.msg.set(sys.subarray(0, LISTEN_BUF));
      this.msgLen = sys.length;
      this.store(fromAddr, 0);
      if (m.sys.type === SYS.CREATEPLAYER) kind = KIND.PLAYER_JOINED;
      else if (m.sys.type === SYS.DESTROYPLAYER) kind = KIND.PLAYER_LEFT;
      else if (m.sys.type === SYS.HOST) {
        kind = KIND.HOST;
        this.host = 1;
      }
      if (m.sys.dpid) this.store(fromAddr, m.sys.dpid);
      this.msg[0] = kind;
      return kind;
    }
    this.store(fromAddr, m.from);
    if (m.from === this.local) return KIND.NONE;
    this.lastHeard.set(m.from, this.now());
    this.msgLen = Math.min(m.bytes.length, LISTEN_BUF);
    this.msg.set(m.bytes.subarray(0, this.msgLen));
    kind = this.msg[0];
    if (kind === KIND.ACK || kind > 0x1d) kind = KIND.NONE;
    return kind;
  }

  // NetDPGetMsg(buf, &len): copy the listen buffer, with the first word
  // shifted back to the script's message type. Returns the full length.
  getMsg(buf, lenAddr) {
    const n = Math.min(this.load(lenAddr) >>> 0, this.msgLen);
    this.store(lenAddr, n);
    this.writeBytes(buf, this.msg.subarray(0, n));
    if (n >= 4) this.store(buf, this.load(buf) >>> 8);
    return this.msgLen;
  }

  // NetDPProcessMessage(obj, p3, p4, p5, p6, from) (FUN_1000562f): apply the
  // listened message to obj. The property numbers say where its values go.
  process(obj, p3, p4, p5, p6, from) {
    const m = this.msg;
    const dv = this.dv();
    switch (m[0]) {
      case KIND.CREATE: // FUN_10004e70: the third axis is not recomputed
        this.setTransform(obj, [f32(dv, 4), f32(dv, 8), f32(dv, 0xc)], vec(dv, 0x10), vec(dv, 0x1c));
        return this.speed100(obj);
      case 5:
        return 1;
      case KIND.STEAL: // FUN_10005520: answer the thief
        if (!p3) {
          m[0] = KIND.STEAL_DENIED;
          this.send(m.slice(0, 8), from);
        } else {
          m[0] = KIND.STOLE;
          this.send(m.slice(0, 8), 0);
        }
        return 0;
      case KIND.STOLE:
        return dv.getInt32(3, true) === this.local ? 1 : 0;
      case KIND.EJECT:
        return this.host;
      case KIND.PLAYER_JOINED:
        this.register(dv.getUint32(8, true));
        return dv.getUint32(8, true) | 0;
      case KIND.PLAYER_LEFT:
        this.unregister(dv.getUint32(8, true));
        return 0;
      case KIND.MOVE:
      case KIND.MOVE + 1:
      case KIND.SMALL: // FUN_1000504a
        this.setTransform(obj, [f32(dv, 4), f32(dv, 8), f32(dv, 0xc)], vec(dv, 0x10), vec(dv, 0x1c));
        this.setSpeed(obj, dv.getInt16(2, true) / SPEED_SCALE);
        this.setProp(obj, p3, dv.getInt16(2, true));
        this.setProp(obj, p4, dv.getInt16(0x28, true));
        this.setProp(obj, p5, dv.getInt16(0x2a, true));
        this.setProp(obj, p6, dv.getInt16(0x2c, true));
        return m[0] === KIND.MOVE + 1 ? 1 : 0;
      case KIND.STILL:
      case KIND.STILL + 1:
      case KIND.CRASHED: {
        // FUN_100053da
        const o = this.engine.world?.get(obj);
        if (o && o.speed !== 0) {
          o.speed = 0;
          this.setProp(obj, p3, 0);
          this.setProp(obj, p4, 0);
        }
        if (o) o.pos[1] = 0;
        this.setProp(obj, p5, dv.getInt16(2, true));
        this.setProp(obj, p6, dv.getInt16(4, true));
        return m[0] === KIND.STILL + 1 ? 1 : 0;
      }
      case KIND.GROUND:
      case KIND.GROUND + 1: {
        // FUN_1000520e: x and z, upright
        const at = vec(dv, 0xc);
        this.setTransform(obj, [f32(dv, 4), 0, f32(dv, 8)], at, [at[2], 0, -at[0]], [0, 1, 0]);
        this.setSpeed(obj, dv.getInt16(2, true) / SPEED_SCALE);
        this.setProp(obj, p3, dv.getInt16(2, true));
        this.setProp(obj, p4, dv.getInt16(0x18, true));
        this.setProp(obj, p5, dv.getInt16(0x1a, true));
        this.setProp(obj, p6, dv.getInt16(0x1c, true));
        return m[0] === KIND.GROUND + 1 ? 1 : 0;
      }
      case KIND.IFF: // FUN_100055bf
        this.setProp(obj, p3, dv.getInt16(2, true));
        return 1;
      case KIND.DO: // FUN_10004f36: unaligned, from byte 1
        this.setTransform(obj, [f32(dv, 1), f32(dv, 5), f32(dv, 9)], vec(dv, 0xd), vec(dv, 0x19));
        return this.speed100(obj);
      default:
        return 0;
    }
  }

  // ------------------------------------------------- sending game state

  // NetDPSendCreDO(obj, owner, target, type, indx, reliable, idProp):
  // a new object (a shot, a dropped item) at obj's place.
  sendCreate(obj, owner, target, type, indx, reliable, idProp) {
    const b = new Uint8Array(0x2c);
    const dv = new DataView(b.buffer);
    b[0] = KIND.CREATE;
    b[1] = this.prop(owner, idProp);
    this.putTransform(dv, 4, 0x10, obj);
    b[0x28] = target ? this.prop(target, idProp) : 0;
    b[0x29] = indx;
    dv.setUint16(0x2a, type, true);
    this.send(b);
    return 0;
  }

  // NetDPSendDamage(obj, tag, health, armor, parent, shieldProp, idProp,
  // instanceProp, reliable)
  sendDamage(obj, tag, health, armor, parent, p7, p8, p9, reliable) {
    const b = new Uint8Array(0xd);
    const dv = new DataView(b.buffer);
    b[0] = KIND.DAMAGE;
    b[1] = this.prop(obj, p8);
    b[2] = tag;
    b[3] = this.prop(obj, p7);
    dv.setInt16(4, health, true);
    dv.setInt16(6, armor, true);
    dv.setInt32(8, parent, true);
    b[0xc] = this.prop(obj, p9);
    this.send(b);
    return 0;
  }

  // NetDPSendDestObj(obj, idProp, instanceProp, seed, killer, flagProp)
  sendDestroy(obj, p3, p4, seed, killer, p7) {
    this.send(this.killMsg(this.prop(obj, p7) ? KIND.DESTROY : KIND.DESTROY0, obj, p3, p4, seed, killer));
    return 0;
  }

  // NetDPSendPleaseKill(obj, idProp, instanceProp, killer, flagProp): ask
  // the host to destroy it.
  sendPleaseKill(obj, p3, p4, killer, p6) {
    this.send(this.killMsg(this.prop(obj, p6) ? KIND.PLEASE_KILL : KIND.PLEASE_KILL + 1, obj, p3, p4, 0, killer));
    return 0;
  }

  killMsg(kind, obj, p3, p4, a, b7) {
    const b = new Uint8Array(0xb);
    const dv = new DataView(b.buffer);
    b[0] = kind;
    b[1] = this.prop(obj, p3);
    b[2] = this.prop(obj, p4);
    dv.setInt32(3, a, true);
    dv.setInt32(7, b7, true);
    return b;
  }

  // {kind, a.idProp, b.idProp, u32 our dpid, a.instanceProp}
  pairMsg(kind, a, bObj, p4, p5) {
    const b = new Uint8Array(8);
    b[0] = kind;
    b[1] = this.prop(a, p4);
    b[2] = this.prop(bObj, p4);
    new DataView(b.buffer).setInt32(3, this.local, true);
    if (p5 !== undefined) b[7] = this.prop(a, p5);
    return b;
  }

  // NetDPSendSteal(thief, victim, idProp, instanceProp): the host decides
  // at once (STOLE to everyone); others ask the host. Returns 1 on the host.
  sendSteal(a, bObj, p4, p5) {
    const msg = this.pairMsg(this.host ? KIND.STOLE : KIND.STEAL, a, bObj, p4, p5);
    this.send(msg);
    return this.host ? 1 : 0;
  }

  sendStole(a, bObj, p4, p5) {
    this.send(this.pairMsg(KIND.STOLE, a, bObj, p4, p5));
    return 1;
  }

  // NetDPSendEject(a, b, idProp): returns 1 when we are not the host.
  sendEject(a, bObj, p4) {
    this.send(this.pairMsg(KIND.EJECT, a, bObj, p4));
    return this.host ? 0 : 1;
  }

  // NetDPSendHitched(a, b, value, idProp, instanceProp)
  sendHitched(a, bObj, value, p5, p6) {
    const b = new Uint8Array(8);
    b[0] = KIND.HITCHED;
    b[1] = this.prop(a, p5);
    b[2] = this.prop(bObj, p5);
    new DataView(b.buffer).setInt32(3, value, true);
    b[7] = this.prop(a, p6);
    this.send(b);
    return 1;
  }

  // NetDPSendIFF(obj, iffProp, idProp): the side the object is on.
  sendIFF(obj, p3, p4) {
    const b = new Uint8Array(4);
    b[0] = KIND.IFF;
    b[1] = this.prop(obj, p4);
    new DataView(b.buffer).setInt16(2, this.prop(obj, p3), true);
    this.send(b);
    return 1;
  }

  // NetDPSendUpdDO(obj): position and orientation, unaligned after the kind.
  sendUpdateDO(obj) {
    const b = new Uint8Array(0x25);
    b[0] = KIND.DO;
    this.putTransform(new DataView(b.buffer), 1, 0xd, obj);
    this.send(b);
    return 0;
  }

  // NetDPSendUpdNDO(obj, p3, p4, p5, idProp, flagProp): a unit's state.
  // Picks the smallest message that says it (see docs/netgn.md) and keeps
  // a copy per net id for NetDPDelta.
  sendUpdate(obj, p3, p4, p5, p6, p7) {
    const b = new Uint8Array(0x2e);
    const dv = new DataView(b.buffer);
    const cls = this.prop(obj, 0);
    const flag = this.prop(obj, p7) < 1;
    let kind = cls < 100 ? (this.prop(obj, 133) ? KIND.CRASHED : KIND.SMALL) : flag ? KIND.MOVE + 1 : KIND.MOVE;
    const id = this.prop(obj, p6) & 0xff;
    b[1] = id;
    const speed100 = this.speed100(obj);
    dv.setInt16(2, speed100, true);
    this.putTransform(dv, 4, 0x10, obj);
    const v3 = this.prop(obj, p3);
    dv.setInt16(0x28, v3, true);
    dv.setInt16(0x2a, this.prop(obj, p4), true);
    dv.setInt16(0x2c, this.prop(obj, p5), true);
    const last = this.sent.get(id);
    const moved = !last || !b.subarray(4, 0x10).every((v, i) => v === last.bytes[4 + i]);
    const o = this.engine.world?.get(obj);
    if (kind === KIND.CRASHED) {
      if (o) o.speed = 0;
      b[0] = kind;
      this.remember(id, b);
      const s = new Uint8Array(6);
      s[0] = kind;
      s[1] = id;
      s.set(b.subarray(0x2a, 0x2e), 2);
      this.send(s);
      return 0;
    }
    b[0] = kind;
    this.remember(id, b);
    if (kind === KIND.SMALL) return void this.send(b);
    if (v3 === 0 && (!o || o.speed === 0) && moved) {
      // stopped, and not where we last said: just the two properties
      const s = new Uint8Array(6);
      s[0] = flag ? KIND.STILL + 1 : KIND.STILL;
      s[1] = id;
      s.set(b.subarray(0x2a, 0x2e), 2);
      this.send(s);
    } else if (o && o.pos[1] === 0 && o.basis.up[0] === 0 && o.basis.up[1] === 1 && o.basis.up[2] === 0) {
      const g = new Uint8Array(0x1e);
      const gv = new DataView(g.buffer);
      g[0] = flag ? KIND.GROUND + 1 : KIND.GROUND;
      g[1] = id;
      gv.setInt16(2, speed100, true);
      g.set(b.subarray(4, 8), 4); // x
      g.set(b.subarray(0xc, 0x10), 8); // z
      g.set(b.subarray(0x10, 0x1c), 0xc); // at
      g.set(b.subarray(0x28, 0x2e), 0x18);
      this.send(g);
    } else {
      this.send(b);
    }
    return 0;
  }

  remember(id, b) {
    const prev = this.sent.get(id);
    this.sent.set(id, { bytes: b.slice(), at: this.now(), iff: prev?.iff ?? 0 });
  }

  // NetDPDelta(obj, p3, p4, p5, iffProp, idProp): 1 when obj has drifted
  // from what we last sent (dead reckoning along the last heading), and the
  // last send is older than the slowest player's latency. Sends IFF when
  // that property changed.
  delta(obj, p3, p4, p5, p6, p7) {
    const id = this.prop(obj, p7) & 0xff;
    const now = this.now();
    let last = this.sent.get(id);
    if (!last) {
      last = { bytes: new Uint8Array(0x2e), at: 0, iff: 0 };
      this.sent.set(id, last);
    }
    const iff = this.prop(obj, p6);
    if (iff !== last.iff) {
      last.iff = iff;
      this.sendIFF(obj, p6, p7);
    }
    const s = new DataView(last.bytes.buffer);
    const o = this.engine.world?.get(obj);
    const pos = o ? o.pos : [0, 0, 0];
    const at = o ? o.basis.at : [0, 0, 1];
    const right = o ? o.basis.right : [1, 0, 0];
    const sp = this.speed100(obj);
    const v3 = this.prop(obj, p3) << 16 >> 16;
    const lastSpeed = s.getInt16(2, true);
    const t = (now - last.at) * 0.001 * (lastSpeed / SPEED_SCALE);
    const near = (a, b) => Math.abs(a - b) <= 0.1;
    let changed =
      Math.abs((this.prop(obj, p5) << 16 >> 16) - s.getInt16(0x2c, true)) > 200 ||
      Math.abs((this.prop(obj, p4) << 16 >> 16) - s.getInt16(0x2a, true)) > 200 ||
      Math.abs(v3 - s.getInt16(0x28, true)) > 5 ||
      Math.abs(sp - lastSpeed) > 50;
    for (let i = 0; i < 3 && !changed; i++) {
      if (!near(right[i], f32(s, 0x1c + 4 * i)) || !near(at[i], f32(s, 0x10 + 4 * i))) changed = true;
      else if (!near(pos[i], f32(s, 0x10 + 4 * i) * t + f32(s, 4 + 4 * i))) changed = true;
    }
    if (!changed) changed = (sp !== 0 && lastSpeed === 0) || (v3 !== 0 && s.getInt16(0x28, true) === 0);
    return changed && now - last.at > this.maxLatency ? 1 : 0;
  }

  // -------------------------------------------------- objects and props

  prop(obj, p) {
    return this.engine.render3d?.objects?.getProperty(obj, p) ?? 0;
  }
  setProp(obj, p, v) {
    this.engine.render3d?.objects?.setProperty(obj, p, v);
    return 0;
  }
  speed100(obj) {
    const o = this.engine.world?.get(obj);
    return o ? Math.trunc(o.speed * SPEED_SCALE) : 0;
  }
  setSpeed(obj, v) {
    const o = this.engine.world?.get(obj);
    if (o) o.speed = v;
  }

  // Position at `p`, then at and right (the object's +0x30 and +0x3c).
  putTransform(dv, p, a, obj) {
    const o = this.engine.world?.get(obj);
    const pos = o ? o.pos : [0, 0, 0];
    const at = o ? o.basis.at : [0, 0, 1];
    const right = o ? o.basis.right : [1, 0, 0];
    for (let i = 0; i < 3; i++) {
      dv.setFloat32(p + 4 * i, pos[i], true);
      dv.setFloat32(a + 4 * i, at[i], true);
      dv.setFloat32(a + 12 + 4 * i, right[i], true);
    }
  }

  // up defaults to at x right, as NETGN computes the third row.
  /** @param {number[] | null} [up] */
  setTransform(obj, pos, at, right, up = null) {
    const o = this.engine.world?.get(obj);
    if (!o) return;
    o.pos = pos;
    o.basis = { at, right, up: up || cross(at, right) };
    o.moved = true;
  }
}

function f32(dv, p) {
  return dv.getFloat32(p, true);
}
function vec(dv, p) {
  return [f32(dv, p), f32(dv, p + 4), f32(dv, p + 8)];
}
function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
