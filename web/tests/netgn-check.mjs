// Checks for network play.
//   node web/tests/netgn-check.mjs                     DirectPlay stand-in and NETGN messages
//   node web/tests/netgn-check.mjs game/g-nome/G-NOME  ...plus two engines that host and
//                                                      join a game through the real menus
import assert from "node:assert/strict";
import { DirectPlay, SYS } from "../src/net/dplay.js";
import { MemoryHub, encode, decode } from "../src/net/buses.js";
import { NetPlugin, KIND } from "../src/plugins/netgn.js";
import { WorldObject } from "../src/battlefield/world.js";

let passed = 0;
function check(name, f) {
  f();
  passed++;
  console.log(`ok  ${name}`);
}

// ------------------------------------------------- DirectPlay stand-in

check("sessions, players and messages", () => {
  const hub = new MemoryHub();
  let t = 0;
  const now = () => t;
  const a = new DirectPlay(hub.bus("a"), { now });
  const b = new DirectPlay(hub.bus("b"), { now });
  const c = new DirectPlay(hub.bus("c"), { now });
  a.createSession("ARENA", 4);
  const pa = a.createPlayer("ann", "Ann");
  assert.equal(b.enumSessions().length, 0); // asks; the answer comes later
  hub.drain();
  const [s] = b.enumSessions();
  assert.equal(s.name, "ARENA");
  assert.equal(s.players.length, 1);
  assert.ok(b.joinSession(s.guid));
  assert.ok(b.players.has(pa)); // adopted from the advert
  const pb = b.createPlayer("bob", "Bob");
  hub.drain();
  assert.deepEqual(a.receive().sys, { type: SYS.CREATEPLAYER, dpid: pb, name: "bob", long: "Bob" });
  b.send(pb, 0, Uint8Array.of(1, 2, 3));
  a.send(pa, pb, Uint8Array.of(9));
  hub.drain();
  assert.deepEqual([...a.receive().bytes], [1, 2, 3]);
  const m = b.receive();
  assert.equal(m.from, pa);
  assert.deepEqual([...m.bytes], [9]);
  // A third peer joins; the host leaves; the lowest peer id left is host.
  c.requestSessions();
  hub.drain();
  assert.ok(c.joinSession(s.guid));
  const pc = c.createPlayer("cy", "Cy");
  hub.drain();
  assert.equal(c.players.size, 3);
  assert.equal(b.receive().sys.dpid, pc);
  a.leave();
  hub.drain();
  assert.deepEqual(b.receive().sys, { type: SYS.DESTROYPLAYER, dpid: pa });
  assert.deepEqual(b.receive().sys, { type: SYS.HOST });
  assert.ok(b.isHost && !c.isHost);
  // A silent peer times out.
  hub.peers.delete("c");
  for (t = 1000; t <= 8000; t += 1000) {
    b.service();
    hub.drain();
  }
  assert.ok(!b.members.has("c"));
});

check("a full session refuses", () => {
  const hub = new MemoryHub();
  const a = new DirectPlay(hub.bus("a"));
  const b = new DirectPlay(hub.bus("b"));
  a.createSession("ONE", 1);
  b.requestSessions();
  hub.drain();
  assert.equal(b.joinSession(b.enumSessions()[0].guid), false);
});

check("messages survive JSON", () => {
  const m = decode(encode({ t: "data", b: Uint8Array.of(0, 255, 7) }));
  assert.ok(m.b instanceof Uint8Array);
  assert.deepEqual([...m.b], [0, 255, 7]);
});

// ------------------------------------------------------ NETGN plugin

// Just enough engine for the plugin: VM memory, strings, objects, world.
function fakeEngine(hub, id) {
  const mem = new Int32Array(1 << 16);
  const props = new Map();
  const objs = new Map();
  const e = {
    time: 0,
    log: () => {},
    strings: new Map(),
    getString: (i) => e.strings.get(i) ?? "",
    setString: (i, s) => e.strings.set(i, s),
    netOptions: { providers: [{ name: "Test", open: () => hub.bus(id) }] },
    vm: {
      mem,
      u8: new Uint8Array(mem.buffer),
      retval: 0,
      load: (a) => mem[a >> 2],
      store: (a, v) => (mem[a >> 2] = v),
      callScript: () => 1,
    },
    render3d: {
      objects: {
        getProperty: (o, p) => props.get(`${o}.${p}`) ?? 0,
        setProperty: (o, p, v) => props.set(`${o}.${p}`, v | 0),
      },
    },
    world: { get: (o) => objs.get(o) || null },
    addObject(o) {
      objs.set(o, new WorldObject(o));
      return objs.get(o);
    },
  };
  return e;
}

function pair() {
  const hub = new MemoryHub();
  const ea = fakeEngine(hub, "a"), eb = fakeEngine(hub, "b");
  const a = new NetPlugin(ea), b = new NetPlugin(eb);
  const x = (p) => p.externs;
  x(a).DPInit(0, 0, 8);
  x(b).DPInit(0, 0, 8);
  ea.setString(20, "GAME");
  x(a).DPCreateSession(20, 0);
  const pa = x(a).DPCreatePlayer(21, 22, 0, 5000);
  hub.drain();
  x(b).DPEnumSessions(18, 1000, 7606);
  hub.drain();
  x(b).DPEnumSessions(18, 1000, 7606);
  assert.equal(eb.getString(18), "GAME");
  assert.equal(x(b).DPJoinSession(0, 0), 1);
  const pb = x(b).DPCreatePlayer(21, 22, 0, 5000);
  hub.drain();
  return { hub, ea, eb, a, b, pa, pb };
}

check("lobby: join, DPReceiveMsg, DPSendMsg", () => {
  const { hub, ea, eb, a, b, pa, pb } = pair();
  const vm = ea.vm;
  // host sees the join as system message 3, with the dpid in the 2nd word
  vm.store(16, 320);
  assert.equal(a.externs.DPReceiveMsg(4, 8, 12, 0x100, 16, 1), 1);
  assert.deepEqual([vm.load(4), vm.load(12), vm.load(0x104)], [1, SYS.CREATEPLAYER, pb]);
  assert.equal(a.externs.DPGetNumPlayers(), 2);
  assert.equal(a.externs.DPGetIndex(pb), 2);
  // script message 1007 with one word
  eb.vm.store(0x200, 1234);
  b.externs.DPSendMsg(0, 1, 1007, 0x200, 4);
  hub.drain();
  vm.store(8, 0);
  vm.store(16, 320);
  assert.equal(a.externs.DPReceiveMsg(4, 8, 12, 0x100, 16, 1), 1);
  assert.deepEqual([vm.load(4), vm.load(8), vm.load(12), vm.load(0x100), vm.load(16)], [0, pb, 1007, 1234, 8]);
  assert.equal(a.externs.DPReceiveMsg(4, 8, 12, 0x100, 16, 1), 0);
  assert.equal(a.externs.DPPlayerIsHost(), 1);
  assert.equal(b.externs.DPPlayerIsHost(), 0);
  assert.ok(pa);
});

check("game: unit updates, listen, process", () => {
  const { hub, ea, eb, a, b } = pair();
  b.externs.NetDPListen(0x10); // the host's CREATEPLAYER? b gets none (it joined after)
  while (a.externs.NetDPListen(0x10)); // host drains the join
  const set = (e, o, p, v) => e.render3d.objects.setProperty(o, p, v);
  // a unit, net id 5, moving
  const u = ea.addObject(50);
  set(ea, 50, 0, 120); // class
  set(ea, 50, 11, 5); // net id
  set(ea, 50, 77, 1);
  set(ea, 50, 12, 7);
  set(ea, 50, 24, -300);
  set(ea, 50, 27, 450);
  u.pos = [1.5, 2, -3];
  u.speed = 1.25;
  a.externs.NetDPSendUpdNDO(50, 12, 24, 27, 11, 77);
  hub.drain();
  const v = eb.addObject(60);
  assert.equal(b.externs.NetDPListen(0x10), KIND.MOVE);
  assert.equal(eb.vm.load(0x10), a.local);
  assert.equal(b.externs.NetDPGetLocalID(), 5);
  b.externs.NetDPProcessMessage(60, 34, 12, 24, 27, a.local);
  assert.deepEqual(v.pos, [1.5, 2, -3]);
  assert.equal(v.speed, 1.25);
  const get = (o, p) => eb.render3d.objects.getProperty(o, p);
  assert.deepEqual([get(60, 34), get(60, 12), get(60, 24), get(60, 27)], [125, 7, -300, 450]);
  // on the ground and upright: the compact message
  u.pos = [4, 0, 5];
  a.externs.NetDPSendUpdNDO(50, 12, 24, 27, 11, 77);
  hub.drain();
  assert.equal(b.externs.NetDPListen(0x10), KIND.GROUND);
  b.externs.NetDPProcessMessage(60, 34, 12, 24, 27, a.local);
  assert.deepEqual(v.pos, [4, 0, 5]);
  assert.deepEqual(v.basis.right, [1, 0, -0]);
  // NetDPDelta: nothing changed, then a turn
  a.maxLatency = 0;
  ea.time = 50;
  u.speed = 0;
  a.externs.NetDPSendUpdNDO(50, 12, 24, 27, 11, 77);
  ea.time = 100;
  assert.equal(a.externs.NetDPDelta(50, 12, 24, 27, 113, 11), 0);
  u.turn(30);
  assert.equal(a.externs.NetDPDelta(50, 12, 24, 27, 113, 11), 1);
});

check("game: damage and script messages", () => {
  const { hub, ea, eb, a, b } = pair();
  while (a.externs.NetDPListen(0x10));
  ea.render3d.objects.setProperty(9, 11, 3);
  ea.render3d.objects.setProperty(9, 97, -2);
  ea.render3d.objects.setProperty(9, 129, 4);
  a.externs.NetDPSendDamage(9, 6, -40, 25, 777, 97, 11, 129, 1);
  hub.drain();
  const x = b.externs;
  assert.equal(x.NetDPListen(0x10), KIND.DAMAGE);
  assert.deepEqual([x.NetDPGetLocalID(), x.NetDPGetTag(), x.NetDPGetHealth(), x.NetDPGetArmor(), x.NetDPGetParent(), x.NetDPGetTarget()], [3, 6, -40, 25, 777, 4]);
  x.NetDPGetShields(1, 97);
  assert.equal(eb.render3d.objects.getProperty(1, 97), -2);
  // NetDPSendMsg rewrites the type word in place; NetDPGetMsg undoes it
  ea.vm.store(0x300, 1500);
  ea.vm.store(0x304, 42);
  a.externs.NetDPSendMsg(0, 1, 0x300, 8);
  assert.equal(ea.vm.load(0x300), (1500 << 8) | 0xf);
  hub.drain();
  assert.equal(x.NetDPListen(0x10), KIND.SCRIPT);
  eb.vm.store(0x24, 64);
  assert.equal(x.NetDPGetMsg(0x400, 0x24), 8);
  assert.deepEqual([eb.vm.load(0x400), eb.vm.load(0x404), eb.vm.load(0x24)], [1500, 42, 8]);
});

console.log(`${passed} checks passed`);
