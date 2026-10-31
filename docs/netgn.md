# NETGN.R32: network play

`NETGN.R32` (81 KB, built 8 Feb 1997) is the plugin behind the NETWORK
menu. It exports 55 externs plus `RtLibInit`/`RtLibFree`. The `DP*` half
wraps DirectPlay 3 (`DPLAYX.DLL`, `IDirectPlay3A`) for the lobby; the
`NetDP*` half is G-Nome's own protocol that keeps units in step during a
game. It reads and writes `RENDER.R32` objects directly: an object id is a
resource whose data is the object struct, so `NetDPSendUpdNDO(obj, ...)`
reads the position at `+0x0c`, the `at` and `right` rows at `+0x30` and
`+0x3c`, the speed at `+0x80` and properties at
`+0xec + 16 * count(+0xe4) + 4 * p` (see [battlefield.md](battlefield.md)).

The browser engine reimplements it in
[web/src/plugins/netgn.js](../web/src/plugins/netgn.js), with a small
DirectPlay stand-in ([web/src/net/dplay.js](../web/src/net/dplay.js)) over
browser transports ([web/src/net/buses.js](../web/src/net/buses.js)). The
message layouts below are kept byte for byte, so the scripts' accessors and
`NetDPProcessMessage` behave as in the original. Addresses are in the
G-Nome build (image base `0x10000000`); the decompile is
`re-output/netgn` (`npx rea-agents decompile-all NETGN.R32`).

## Runtime state

`RtLibInit` returns the plugin context `0x1001e028` (`ctx`), a block of
dwords:

| Field | Meaning |
| --- | --- |
| `ctx[4]` | `100.0f`: speeds travel as `speed * 100` in 16 bits |
| `ctx[5]` | the RTLIB32 context, for `RtGetString` / `RtRunMsg` / `RtGetResource` |
| `ctx[7]`, `ctx[8]`, `ctx[9]` | chosen service provider GUID, `IDirectPlay3A`, `IDirectPlayLobby2A` |
| `ctx[10]` | the `DPSESSIONDESC2` used to create or join |
| `ctx[0xe]`, `ctx[0xd]` | session table (`0x2d` bytes per GUID + name; indices are stable across refreshes) and its size |
| `ctx[0xf]` | maximum players (`DPInit`'s third argument) |
| `ctx[0x11]` | player table, `0x21` bytes per slot: `{u32 dpid, char name[20], u8, u32 latency, u32 last heard}` |
| `ctx[0x12]` | our dpid |
| `ctx[0x16]` | the provider's maximum message size; the send buffer `ctx[0x1a]` is at most 1 KB |
| `ctx[0x17]` | the largest latency of any player, 100 to 1000 ms |
| `ctx[0x19]` | 1 on the host |

Scripts never see slot numbers except through `DPGetIndex`,
`DPGetPlayerInfo` and the second argument of `DPEnumPlayers`' callback
(1-based). A slot is taken when the player is created, found by
`DPJoinSession`/`DPEnumInSession`, or announced by a CREATEPLAYER system
message that the scripts receive; it is freed on DESTROYPLAYER.

`RtRunMsg` (RTLIB32 `0x1001af10`) is how the plugin calls back into
scripts. It is synchronous: it builds a statement-`0x01` call record with
`nlocals = 0x20` (so the callee's frame sits 32 locals below the caller's),
runs it, and returns the script's return value (1 unless it returns 0).
Every enumeration stops when its callback returns 0.

## Lobby externs

Arguments are listed after the plugin context. `str` arguments are RTLIB32
string ids; `&x` are pointers into script memory.

| Extern | Address | What it does |
| --- | --- | --- |
| `DPIsValidVersion()` | `0x10002214` | 1 if DirectPlay 3 is installed |
| `DPCheckForConnect()` | `0x100022ed` | 1 if a lobby program started the game |
| `DPEnumProviders(str, script)` | `0x10002359` | `script(major, minor)` per service provider with its name in `str`; then "MPath MPlayer". Returns the count |
| `DPInit(str, index, max)` | `0x10002458` | open the provider named `str`, or number `index` when `str` is empty. Returns the connection type: 1 TCP/IP, 2 modem, 3 IPX, 4 other, 5 Mplayer (runs `MPN.DLL!MplayNow`; the scripts then quit), 0 on failure |
| `DPInitINetAddress(str, str)`, `DPInitPhoneAddress`, `DPInitSerialAddress` | `0x1000265b`... | address for TCP/IP, modem, serial; the scripts never call them, so DirectPlay asks with its own dialog |
| `DPEnumSessions(str, timeout, script)` | `0x10002ac2` | `script(index, maxPlayers, currentPlayers)` per session, name (20 chars) in `str`; sessions without a name are skipped. Returns the number of sessions reported (the callback `FUN_100019cb` counts them in the enum context), -1 on error |
| `DPCreateSession(str name, str password)` | `0x10002e79` | flags `0x44` (keep-alive, host migration); we become host |
| `DPJoinSession(index, str password)` | `0x10002cc7` | join, then register every player already in it |
| `DPEnumInSession(?, str, str, script)` | `0x10002be6` | register every player; `script(dpid, n)` when script is not 0 |
| `DPCreatePlayer(str name, str longName, ?, ?)` | `0x10003269` | our player; returns its dpid |
| `DPDestroyPlayer()`, `DPClose()`, `DPDeInit()` | `0x1000351a`, `0x10003052`, `0x100029cb` | undo the above |
| `DPEnumPlayers(str, str, script)` | `0x100030f9` | `script(dpid, slot)` per registered player, names in the strings. Returns the count |
| `DPGetPlayerInfo(dpid, &slot, str)` | `0x10003636` | slot (or -1) and name |
| `DPGetIndex(dpid)`, `DPGetNumPlayers()`, `DPGetMaxBufLen()`, `DPPlayerIsHost()` | | |
| `DPEnableNewPlayers(on)` | `0x10002bb4` | does nothing |
| `DPSendMsg(to, flags, type, buf, len)` | `0x1000392f` | sends `u32 (type << 8 | 0x0f)` then `len` bytes. `to` 0 is everyone. Flag 1 goes through NETGN's own reliable layer (below) |
| `DPReceiveMsg(&sys, &from, &type, buf, &len, copy)` | `0x10003d1f` | the next message; returns 0 when there is none. See below |
| `DPBufToStr(str, buf, n)`, `DPStrToBuf(buf, str, n)` | `0x100043cc`, `0x1000441e` | copy up to 255 bytes between a string and script memory |

`DPReceiveMsg` sets `*sys` to 1 for DirectPlay system messages (`*from` =
0) and copies the message struct from its second word, so `buf[0]` is the
player type and `buf[1]` the dpid:

| `*type` | System message | Effect |
| --- | --- | --- |
| 3 | `DPSYS_CREATEPLAYERORGROUP` | register the player; copies at most `0x28` bytes |
| 5 | `DPSYS_DESTROYPLAYERORGROUP` | free its slot; at most `0x1c` bytes |
| `0x31`, `0x101` | `DPSYS_SESSIONLOST`, `DPSYS_HOST` | we are host now |

For player messages `*sys` is 0, `*from` the sender and `*type` the word
the sender passed to `DPSendMsg`; the data after it is copied and `*len`
becomes the full size. Types `0x65` (a file chunk; the file sender is not
exported, so unused), `0x66` (the host destroys our player) and `0x67`
are handled inside. A message that is not a script message (one of the
in-game kinds below) gives type 0.

The lobby itself is script code (`7451` to `7766`): the host answers type
1007 (a client's version) with 1008 (the game settings), 1003 starts the
game, 1010/1004/1005 carry the player list and choices, 1000 and 1012 are
chat lines.

## In-game messages

During a game the scripts call `NetDPListen(&from)` in a loop (`5964`,
from the frame script) and run entry `kind` of statement list `5987` for
each message; the handlers (`5965` to `5986`) read fields with the
`NetDPGet*` accessors and apply them with `NetDPProcessMessage`. Units are
named on the wire by a one-byte net id (property 11), mapped back to an
object through table `G1848`.

`NetDPListen` (`0x100058b9`) receives into a 0x144-byte buffer at
`0x10014310` and returns its first byte, the kind. It also turns system
messages into kinds: CREATEPLAYER is `0x0c` (`*from` = the new dpid),
DESTROYPLAYER `0x0d`, HOST `0x17`; others are 1. Messages from ourselves,
acks and kinds above `0x1d` are 1 (nothing to do), and an empty queue is 0.

| Kind | Sent by | Size | Layout after the kind byte | Handler |
| --- | --- | --- | --- | --- |
| `02` | reliable layer | n+3 | `u16 seq`, message | unwrapped, acked |
| `03` | reliable layer | 3 | `u16 seq` | ack |
| `04` | `NetDPSendCreDO(obj, owner, target, type, indx, reliable, idProp)` | `0x2c` | owner id, `u16 0`, pos `f32[3]` at 4, at `f32[3]` at `0x10`, right `f32[3]` at `0x1c`, target id at `0x28`, indx at `0x29`, `u16 type` at `0x2a` | `5966` |
| `05` | | | | `5967` (empty) |
| `06`, `1d` | `NetDPSendDestObj(obj, idProp, instProp, seed, killer, flagProp)` | `0xb` | id, instance, `i32 seed` at 3, `i32 killer` at 7 | `5971`, `5972` |
| `07` | `NetDPSendDamage(obj, tag, health, armor, parent, shieldProp, idProp, instProp, reliable)` | `0xd` | id, tag, shields, `i16 health`, `i16 armor`, `i32 parent`, instance at `0xc` | `5973` |
| `08`, `09` | `NetDPSendSteal(a, b, idProp, instProp)`, `NetDPSendStole` | 8 | a id, b id, `i32 dpid` at 3, a instance at 7 | `5974`, `5975` |
| `0a` | the host, refusing a steal | 8 | as `08` | `5976` |
| `0b` | `NetDPSendEject(a, b, idProp)` | 8 | a id, b id, `i32 dpid` | `5977` |
| `0c`, `0d` | system | | the DirectPlay struct; dpid at 8 | `5978`, `5979` |
| `0e` | `NetDPSendHitched(a, b, value, idProp, instProp)` | 8 | a id, b id, `i32 value`, a instance | `5980` |
| `0f` | `NetDPSendMsg`, `DPSendMsg` | n | `u32 (type << 8 | 0x0f)`, data | `5981`, reads it with `NetDPGetMsg` |
| `10`, `11` | `NetDPSendUpdNDO` | `0x2e` | id, `i16 speed*100`, pos at 4, at at `0x10`, right at `0x1c`, `i16 p3, p4, p5` at `0x28` | `5968` |
| `12`, `13` | `NetDPSendUpdNDO`, stopped | 6 | id, `i16 p4, p5` | `5968` |
| `14`, `15` | `NetDPSendUpdNDO`, on the ground and upright | `0x1e` | id, `i16 speed*100`, `f32 x, z`, at at `0xc`, `i16 p3, p4, p5` at `0x18` | `5968` |
| `16` | `NetDPSendIFF(obj, iffProp, idProp)` | 4 | id, `i16 iff` | `5982` |
| `17` | system | | | `5983` |
| `18` | `NetDPSendUpdDO(obj)` | `0x25` | pos at 1, at at `0xd`, right at `0x19` (unaligned) | `5984` |
| `19` | `NetDPSendUpdNDO`, class < 100 with property 133 set | 6 | id, `i16 p4, p5` | `5969` |
| `1a` | `NetDPSendUpdNDO`, class < 100 | `0x2e` | as `10` | `5970` |
| `1b`, `1c` | `NetDPSendPleaseKill(obj, idProp, instProp, killer, flagProp)` | `0xb` | id, instance, `i32 0`, `i32 killer` at 7 | `5985`, `5986` |

The odd kinds of each pair (`11`, `13`, `15`, `1c`, `1d`) are sent when the
flag property (77 for updates, 100 for kills) is below 1 or 0.

Accessors (all read the listen buffer): `NetDPGetLocalID` byte 1,
`NetDPGetTag` byte 2, `NetDPGetTarget` byte `0x28` for kind 4, byte `0xc`
for kind 7, else byte 2, `NetDPGetInstance` byte 7, `NetDPGetIndx` byte
`0x29`, `NetDPGetType` `u16` at `0x2a`, `NetDPGetSeed` `i32` at 3,
`NetDPGetHealth` / `NetDPGetArmor` `i16` at 4 / 6, `NetDPGetParent` `i32`
at 8, `NetDPGetKiller` `i32` at 7, `NetDPGetShields(obj, p)` sets property
p to the signed byte at 3. `NetDPGetMsg(buf, &len)` copies the message and
shifts the first word back to the script's type.

`NetDPProcessMessage(obj, p3, p4, p5, p6, from)` (`0x1000562f`) applies
the buffer to `obj`:

* `04`, `18`: position and `at`/`right` (`18` also recomputes `up = at x
  right`; `04` leaves `up` alone). Returns the object's speed x 100.
* `10`, `11`, `1a`: transform, `up = at x right`, speed = `i16 / 100`,
  then properties `p3..p6` = the speed and the three `i16`s. Returns 1 for
  `11`.
* `12`, `13`, `19`: if the object moves, stop it and zero `p3`, `p4`; put
  it on the ground (`y = 0`); `p5`, `p6` = the two `i16`s.
* `14`, `15`: `x, 0, z`, `at`, `up = (0, 1, 0)`, `right = up x at`, speed and
  properties as `10`.
* `16`: property `p3` = the `i16`.
* `08`: the host's answer to a steal: with `p3` 0 it sends kind `0a` back
  to `from`, otherwise kind `09` to everyone (both from the same buffer).
* `09`: 1 if the dpid in it is ours. `0b`: 1 on the host. `0c`, `0d`:
  register / free the player.

`NetDPSendUpdNDO(obj, p3, p4, p5, idProp, flagProp)` picks the message:
class (property 0) below 100 sends `19` or `1a`; otherwise if `p3` and the
speed are 0 and the position differs from the last update it sends the
short `12`, else `14` when the object sits upright on `y = 0`, else `10`.
It keeps the full `0x2e`-byte message per net id (`0x1001aa10`, `0x36`
bytes each with the time and last IFF value).

`NetDPDelta(obj, p3, p4, p5, iffProp, idProp)` (`0x10006839`) decides when
the player's own unit needs an update: it sends IFF if that property
changed, then compares against the kept message, extrapolating the
position along the old `at` at the old speed. It reports a change when
`p5` or `p4` moved by more than 200, `p3` by more than 5, the speed by more
than 0.5, any `at`/`right` component or the extrapolated position by more
than 0.1, or the unit started moving; and only once the last update is
older than `ctx[0x17]`. So each unit sends at most one update per
round-trip of the slowest player.

`NetDPLostConnect(dpid, ms)` is 1 when nothing came from that player for
`ms` milliseconds (unused by the scripts).

### The reliable layer

DirectPlay 3's guaranteed sends were slow over modems, so NETGN has its
own (`0x100045c0`): flag 1 on the in-game sends wraps the message as
`{02, u16 seq, message}`, keeps it in one of 64 slots (`0x10014500`,
`0x194` bytes each) and resends it to every player who has not acked
(`{03, u16 seq}`) once their latency has passed (`0x10004b8d`, run on every
listen). The receiver acks and drops repeats of the last 10 sequence
numbers per player (`0x10004a94`). Latencies are measured from the acks
and clamped to 100-1000 ms.

The browser transports are reliable and ordered, so the reimplementation
sends every message once and never wraps it; kinds 2 and 3 never appear.

## The browser version

`web/src/net/dplay.js` plays DirectPlay's part between browser peers: the
session creator is host; sessions are found by broadcasting a request and
collecting hosts' answers; joining adopts the player list the host
advertised and greets every member; each peer picks its player's dpid at
random, so `DPCreatePlayer` can answer at once. Pings every second measure
round trips (the latency used by `NetDPDelta`) and drop a member silent
for 6 s. When the host leaves, the member with the lowest peer id becomes
host and gets `DPSYS_HOST`, as DirectPlay's host migration does.

The calls are synchronous like the original, so `DPEnumSessions` returns
what hosts answered since the last call (the session list refreshes every
3 s) and `DPInit` reports connection type 3, which makes the scripts
refresh on their own instead of waiting for an address dialog.

Providers (`DPEnumProviders`), in `web/src/net/buses.js`:

| Name | Transport |
| --- | --- |
| Browser Tabs On This Computer | `BroadcastChannel` between tabs of the same site |
| Internet (WebRTC) | offered when the page comes from `web/tools/net-server.mjs`. The server introduces the browsers (server-sent events and POSTs under `/net/`) and relays the WebRTC handshake; each pair of players then talks over a data channel, or through the server when WebRTC can't connect |

"MPath MPlayer" is left out: it launched the Mplayer service, which is
gone, and the scripts quit the game when it is picked.

`web/tests/netgn-check.mjs` tests the DirectPlay stand-in and the message
encodings. `web/tests/net-tabs.mjs` needs the game folder and Playwright:
two headless pages go through the real menus (one hosts, the other joins,
chats, both set GO, the host launches) and check that game messages flow
both ways in the battle, over tabs or over the server and WebRTC.

Two RTLIB32 pieces the menus need came with this work: text entry
(statement `0x2C`, used for the game and player names and chat; see
[rtlib32-names.md](rtlib32-names.md)) and the mouse globals `G5005` and
`G5006` that list screens read to find the clicked row
([rtlib32-engine.md](rtlib32-engine.md)).
