// A small stand-in for DirectPlay 3, the part NETGN.R32 uses: sessions,
// players, and messages between players. It runs over a "bus" (see buses.js)
// that carries plain objects between browser peers. There is no server-side
// game logic: the peer that creates a session is its host, as in DirectPlay.
//
// Peers and players: every browser is one peer (bus.id). A peer joins at
// most one session and owns at most one player. Player ids (dpid) are random
// positive 31-bit numbers chosen by their owner, so DPCreatePlayer can
// answer at once, as the game expects.
//
// Everything the game calls is synchronous, so the network side is always
// one step behind: session lists come from replies to earlier requests, and
// joining adopts the player list the host advertised.
//
// Bus messages ({t, ...}):
//   enum                         who hosts a session? (broadcast)
//   sess {s}                     a host's answer: guid, name, max, members, players
//   hello {guid, pw}             a peer joins; every member adds it
//   refuse {guid}                the host turns a joiner away (full, password)
//   roster {guid, players}       a member's own players, sent to a newcomer
//   player {guid, p}             a player was created
//   unplayer {guid, dpid}        a player was destroyed
//   data {guid, from, to, b}     a message between players (to 0 = everyone)
//   ping/pong {guid, at}         keepalive and round-trip time
//   bye {guid}                   a peer leaves the session

export const SYS = { CREATEPLAYER: 3, DESTROYPLAYER: 5, SESSIONLOST: 0x31, HOST: 0x101 };

const PING_MS = 1000;
const TIMEOUT_MS = 6000; // a member silent this long has gone
const SESSION_TTL_MS = 5000; // forget sessions not advertised for this long

export class DirectPlay {
  /** @param {any} bus @param {{ now?: () => number, random?: () => number, log?: (msg: string) => void }} [opts] */
  constructor(bus, { now = () => Date.now(), random = Math.random, log = (msg) => {} } = {}) {
    this.bus = bus;
    this.now = now;
    this.random = random;
    this.log = log;
    this.sessions = new Map(); // guid -> advertised session, from enum replies
    this.session = null; // the session we are in: {guid, name, max, pw, host}
    this.members = new Map(); // peer -> {lastSeen, rtt}
    this.players = new Map(); // dpid -> {dpid, name, long, peer}
    this.local = 0; // our player's dpid
    this.isHost = false;
    this.queue = []; // received: {from, to, bytes} or {from: 0, sys}
    this.lastPing = 0;
    bus.onmessage = (from, m) => this.onMessage(from, m);
    bus.onpeerleave = (peer) => this.memberLeft(peer);
  }

  // --------------------------------------------------------------- lobby

  // Ask every host on the bus to advertise. Replies arrive later.
  requestSessions() {
    this.bus.send(null, { t: "enum" });
  }

  // Sessions heard from recently (DPEnumSessions). Also asks again.
  enumSessions() {
    const t = this.now();
    for (const [g, s] of this.sessions) if (t - s.seen > SESSION_TTL_MS) this.sessions.delete(g);
    this.requestSessions();
    return [...this.sessions.values()];
  }

  createSession(name, max, pw = "") {
    this.leave();
    const guid = this.newGuid();
    this.session = { guid, name, max: max || 8, pw, host: this.bus.id };
    this.members = new Map([[this.bus.id, { lastSeen: this.now(), rtt: 0 }]]);
    this.players = new Map();
    this.isHost = true;
    this.log(`net: created session "${name}"`);
    return true;
  }

  // Optimistic: adopt what the host advertised and say hello to everyone in
  // it. If the host refuses, the session is lost (SESSIONLOST).
  joinSession(guid, pw = "") {
    const s = this.sessions.get(guid);
    if (!s) return false;
    if (s.members.length >= s.max) return false;
    this.leave();
    this.session = { guid, name: s.name, max: s.max, pw, host: s.host };
    this.members = new Map([[this.bus.id, { lastSeen: this.now(), rtt: 0 }]]);
    for (const peer of s.members) this.members.set(peer, { lastSeen: this.now(), rtt: 0 });
    this.players = new Map(s.players.map((p) => [p.dpid, { ...p }]));
    this.isHost = false;
    this.toMembers({ t: "hello", pw });
    this.log(`net: joined session "${s.name}" (${s.players.length} players)`);
    return true;
  }

  // DPClose: leave the session.
  leave() {
    if (!this.session) return;
    this.toMembers({ t: "bye" });
    this.session = null;
    this.members = new Map();
    this.players = new Map();
    this.local = 0;
    this.isHost = false;
    this.queue = [];
  }

  // ------------------------------------------------------------- players

  createPlayer(name, long) {
    if (!this.session) return 0;
    let dpid;
    do dpid = 1 + Math.floor(this.random() * 0x7ffffffe);
    while (this.players.has(dpid));
    const p = { dpid, name, long, peer: this.bus.id };
    this.players.set(dpid, p);
    this.local = dpid;
    this.toMembers({ t: "player", p });
    return dpid;
  }

  destroyPlayer(dpid = this.local) {
    if (!this.players.has(dpid)) return false;
    this.players.delete(dpid);
    if (dpid === this.local) this.local = 0;
    this.toMembers({ t: "unplayer", dpid });
    return true;
  }

  // Send bytes from player `from` to player `to` (0 = every other player).
  send(from, to, bytes) {
    if (!this.session) return false;
    const m = { t: "data", from, to, b: bytes };
    if (to === 0) {
      const peers = new Set([...this.players.values()].map((p) => p.peer));
      peers.delete(this.bus.id);
      for (const peer of peers) this.toPeer(peer, m);
      return true;
    }
    const p = this.players.get(to);
    if (!p) return false;
    if (p.peer === this.bus.id) this.deliver(m);
    else this.toPeer(p.peer, m);
    return true;
  }

  // The next received message, or null.
  receive() {
    return this.queue.shift() || null;
  }

  latency(dpid) {
    const p = this.players.get(dpid);
    const m = p && this.members.get(p.peer);
    return m ? Math.min(1000, Math.max(100, m.rtt / 2)) : 100;
  }

  // ------------------------------------------------------------ plumbing

  // Called every engine tick: keepalives and timeouts.
  service() {
    if (!this.session) return;
    const t = this.now();
    if (t - this.lastPing >= PING_MS) {
      this.lastPing = t;
      this.toMembers({ t: "ping", at: t });
    }
    for (const [peer, m] of this.members) {
      if (peer !== this.bus.id && t - m.lastSeen > TIMEOUT_MS) {
        this.log(`net: lost contact with ${peer}`);
        this.memberLeft(peer);
      }
    }
  }

  advert() {
    const s = this.session;
    return { guid: s.guid, name: s.name, max: s.max, pw: !!s.pw, host: this.bus.id, members: [...this.members.keys()], players: [...this.players.values()] };
  }

  onMessage(from, m) {
    if (!m || from === this.bus.id) return;
    const s = this.session;
    if (m.t === "enum") {
      if (s && this.isHost) this.bus.send(from, { t: "sess", s: this.advert() });
      return;
    }
    if (m.t === "sess") {
      this.sessions.set(m.s.guid, { ...m.s, seen: this.now() });
      return;
    }
    if (!s || m.guid !== s.guid) return;
    const member = this.members.get(from);
    if (member) member.lastSeen = this.now();
    switch (m.t) {
      case "hello":
        if (this.isHost && (this.members.size >= s.max || (s.pw && m.pw !== s.pw))) {
          this.bus.send(from, { t: "refuse", guid: s.guid });
          return;
        }
        this.members.set(from, { lastSeen: this.now(), rtt: 0 });
        this.bus.send(from, { t: "roster", guid: s.guid, players: [...this.players.values()].filter((p) => p.peer === this.bus.id) });
        break;
      case "refuse":
        this.log("net: the host refused us");
        this.session = null;
        this.queue.push({ from: 0, sys: { type: SYS.SESSIONLOST } });
        break;
      case "roster":
        for (const p of m.players) this.addPlayer(p);
        break;
      case "player":
        if (member) this.addPlayer(m.p);
        break;
      case "unplayer":
        this.removePlayer(m.dpid);
        break;
      case "data":
        if (member) this.deliver(m);
        break;
      case "ping":
        this.bus.send(from, { t: "pong", guid: s.guid, at: m.at });
        break;
      case "pong":
        if (member) member.rtt = this.now() - m.at;
        break;
      case "bye":
        this.memberLeft(from);
        break;
    }
  }

  deliver(m) {
    if (m.to !== 0 && m.to !== this.local) return;
    if (!this.local) return; // DirectPlay queues messages per local player
    this.queue.push({ from: m.from, to: m.to, bytes: m.b instanceof Uint8Array ? m.b : new Uint8Array(m.b) });
  }

  addPlayer(p) {
    if (this.players.has(p.dpid)) return;
    this.players.set(p.dpid, { ...p });
    this.queue.push({ from: 0, sys: { type: SYS.CREATEPLAYER, dpid: p.dpid, name: p.name, long: p.long } });
  }

  removePlayer(dpid) {
    if (!this.players.delete(dpid)) return;
    this.queue.push({ from: 0, sys: { type: SYS.DESTROYPLAYER, dpid } });
  }

  // A member left or went silent: drop its players; if it was the host, the
  // member with the lowest peer id takes over (DPSESSION_MIGRATEHOST).
  memberLeft(peer) {
    if (!this.session || !this.members.delete(peer)) return;
    for (const p of [...this.players.values()]) if (p.peer === peer) this.removePlayer(p.dpid);
    if (peer === this.session.host) {
      const next = [...this.members.keys()].sort()[0];
      this.session.host = next;
      if (next === this.bus.id) {
        this.isHost = true;
        this.log("net: we are the host now");
        this.queue.push({ from: 0, sys: { type: SYS.HOST } });
      }
    }
  }

  toMembers(m) {
    for (const peer of this.members.keys()) if (peer !== this.bus.id) this.toPeer(peer, m);
  }

  toPeer(peer, m) {
    this.bus.send(peer, { ...m, guid: this.session?.guid });
  }

  newGuid() {
    const h = () => Math.floor(this.random() * 0x100000000).toString(16).padStart(8, "0");
    return `${h()}-${h()}-${h()}-${h()}`;
  }
}
