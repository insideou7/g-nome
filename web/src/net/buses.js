// Buses carry DirectPlay messages (plain objects) between browser peers.
// Every bus has the same shape:
//   bus.id                  this peer's id (a random string)
//   bus.send(to, msg)       to a peer id, or to every other peer when to is null
//   bus.onmessage(from, msg)
//   bus.onpeerleave(peer)   optional: the transport noticed a peer go away
//   bus.close()
//
// MemoryHub    peers in one JavaScript realm (tests)
// BroadcastBus browser tabs of the same site on one computer
// ServerBus    peers that share a relay server (web/tools/net-server.mjs)
// RtcBus       a ServerBus that moves each peer-to-peer link onto a WebRTC
//              data channel once one opens; the server carries only the
//              lobby and the WebRTC handshake after that

export function peerId(random = Math.random) {
  return Math.floor(random() * 2 ** 48).toString(36).padStart(10, "0");
}

// Uint8Arrays don't survive JSON: send them as base64 strings.
/**
 * @param {any} msg
 */
export function encode(msg) {
  return JSON.stringify(msg, (k, v) => (v instanceof Uint8Array ? { $b: toBase64(v) } : v));
}
/**
 * @param {string} text
 */
export function decode(text) {
  return JSON.parse(text, (k, v) => (v && typeof v === "object" && typeof v.$b === "string" ? fromBase64(v.$b) : v));
}
/**
 * @param {Uint8Array} bytes
 */
function toBase64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
/**
 * @param {string} s
 */
function fromBase64(s) {
  const t = atob(s);
  const b = new Uint8Array(t.length);
  for (let i = 0; i < t.length; i++) b[i] = t.charCodeAt(i);
  return b;
}

// ----------------------------------------------------------------- memory

// Delivers on the next drain() (or right away with { immediate: true }), so
// tests can step two engines in turn.
export class MemoryHub {
  constructor({ immediate = false } = {}) {
    this.peers = new Map();
    /** @type {any} */
    this.pending = [];
    this.immediate = immediate;
  }
  bus(id = peerId()) {
    const hub = this;
    const bus = {
      id,
      onmessage: null,
      onpeerleave: null,
      /**
       * @param {any} to
       * @param {any} msg
       */
      send(to, msg) {
        const copy = structuredClone(msg);
        for (const [pid, p] of hub.peers) {
          if (pid === id || (to !== null && to !== pid)) continue;
          if (hub.immediate) p.onmessage?.(id, copy);
          else hub.pending.push([p, id, copy]);
        }
      },
      close() {
        hub.peers.delete(id);
        for (const p of hub.peers.values()) p.onpeerleave?.(id);
      },
    };
    this.peers.set(id, bus);
    return bus;
  }
  drain() {
    while (this.pending.length) {
      const [p, from, msg] = this.pending.shift();
      if (this.peers.get(p.id) === p) p.onmessage?.(from, msg);
    }
  }
}

// ------------------------------------------------------- BroadcastChannel

export class BroadcastBus {
  constructor(name = "g-nome-net") {
    this.id = peerId();
    /** @type {any} */
    this.onmessage = null;
    this.onpeerleave = null;
    this.channel = new BroadcastChannel(name);
    this.channel.onmessage = (e) => {
      const { from, to, msg } = e.data || {};
      if (from === this.id || (to !== null && to !== this.id)) return;
      this.onmessage?.(from, msg);
    };
  }
  /**
   * @param {any} to
   * @param {any} msg
   */
  send(to, msg) {
    this.channel.postMessage({ from: this.id, to, msg });
  }
  close() {
    this.channel.close();
  }
}

// ----------------------------------------------------------- relay server

// Server-sent events down, POSTs up. `base` is the server's /net/ URL.
export class ServerBus {
  /**
   * @param {string} base
   */
  constructor(base) {
    this.base = base.endsWith("/") ? base : base + "/";
    this.id = peerId();
    /** @type {any} */
    this.onmessage = null;
    /** @type {any} */
    this.onpeerleave = null;
    // The server drops messages from peers it hasn't met: hold them until
    // our event stream is open.
    /** @type {any[] | null} */
    this.held = [];
    this.events = new EventSource(`${this.base}events?id=${this.id}`);
    this.events.onopen = () => {
      const held = this.held;
      this.held = null;
      for (const [to, msg] of held || []) this.relay(to, msg);
    };
    this.events.onmessage = (e) => {
      const { from, msg, left } = decode(e.data);
      if (left) this.peerLeft(left);
      else if (from !== this.id) this.receive(from, msg);
    };
  }
  /**
   * @param {any} from
   * @param {any} msg
   */
  receive(from, msg) {
    this.onmessage?.(from, msg);
  }
  /**
   * @param {any} peer
   */
  peerLeft(peer) {
    this.onpeerleave?.(peer);
  }
  /**
   * @param {any} to
   * @param {any} msg
   */
  send(to, msg) {
    this.relay(to, msg);
  }
  /**
   * @param {any} to
   * @param {any} msg
   */
  relay(to, msg) {
    if (this.held) return void this.held.push([to, msg]);
    fetch(`${this.base}send`, { method: "POST", body: encode({ from: this.id, to, msg }) }).catch(() => {});
  }
  close() {
    this.events.close();
  }

  // Is there a relay server at `base`? Resolves to true or false.
  /**
   * @param {string} base
   */
  static async probe(base) {
    try {
      const r = await fetch(`${base.endsWith("/") ? base : base + "/"}hello`);
      return r.ok && (await r.json()).netgn === 1;
    } catch {
      return false;
    }
  }
}

// ----------------------------------------------------------------- WebRTC

// Session lookups go to peers we may never play with: keep them on the relay.
const LOBBY = new Set(["enum", "sess"]);

// Peers that talk to each other get a data channel. The peer with the lower
// id makes the offer; offers, answers and ICE candidates go through the
// relay as {rtc: ...} messages. Until the channel is open (or if it never
// opens, say behind a strict NAT), messages go through the relay.
export class RtcBus extends ServerBus {
  /**
   * @param {string} base
   */
  constructor(base, { iceServers = [{ urls: "stun:stun.l.google.com:19302" }] } = {}) {
    super(base);
    this.iceServers = iceServers;
    this.links = new Map(); // peer -> {pc, dc}
  }

  /**
   * @param {any} to
   * @param {any} msg
   */
  send(to, msg) {
    if (to !== null && !LOBBY.has(msg.t)) {
      const dc = this.link(to).dc;
      if (dc && dc.readyState === "open") return dc.send(encode(msg));
    }
    this.relay(to, msg);
  }

  /**
   * @param {any} from
   * @param {any} msg
   */
  receive(from, msg) {
    if (msg && msg.rtc) return this.signal(from, msg.rtc);
    // Someone is talking to us directly: set up a link to them.
    if (msg && !LOBBY.has(msg.t)) this.link(from);
    super.receive(from, msg);
  }

  /**
   * @param {any} peer
   */
  peerLeft(peer) {
    this.drop(peer);
    super.peerLeft(peer);
  }

  /**
   * @param {string} peer
   */
  link(peer) {
    let l = this.links.get(peer);
    if (l) return l;
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    l = { pc, dc: null };
    this.links.set(peer, l);
    pc.onicecandidate = (e) => e.candidate && this.relay(peer, { rtc: { candidate: e.candidate.toJSON() } });
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") this.drop(peer);
    };
    const attach = (/** @type {RTCDataChannel} */ dc) => {
      l.dc = dc;
      dc.onmessage = (/** @type {any} */ e) => super.receive(peer, decode(e.data));
    };
    if (this.id < peer) {
      attach(pc.createDataChannel("g-nome", { ordered: true }));
      pc.createOffer()
        .then((o) => pc.setLocalDescription(o))
        .then(() => this.relay(peer, { rtc: { sdp: pc.localDescription?.toJSON() } }))
        .catch(() => this.drop(peer));
    } else {
      pc.ondatachannel = (e) => attach(e.channel);
    }
    return l;
  }

  /**
   * @param {any} peer
   * @param {any} s
   */
  async signal(peer, s) {
    const { pc } = this.link(peer);
    try {
      if (s.sdp) {
        await pc.setRemoteDescription(s.sdp);
        if (s.sdp.type === "offer") {
          await pc.setLocalDescription(await pc.createAnswer());
          this.relay(peer, { rtc: { sdp: pc.localDescription?.toJSON() } });
        }
      } else if (s.candidate) {
        await pc.addIceCandidate(s.candidate);
      }
    } catch {
      // Candidates can arrive before the description; the relay still works.
    }
  }

  /**
   * @param {any} peer
   */
  drop(peer) {
    const l = this.links.get(peer);
    if (!l) return;
    this.links.delete(peer);
    l.pc.close();
  }

  // How many peers we reach over an open data channel (for tests and the UI).
  directLinks() {
    return [...this.links.values()].filter((l) => l.dc && l.dc.readyState === "open").length;
  }

  close() {
    for (const p of [...this.links.keys()]) this.drop(p);
    super.close();
  }
}
