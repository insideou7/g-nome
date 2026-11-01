// Plays campaign missions to a win with a scripted bot, to check that each
// mission's goals can be met in the browser engine: boarding and ejecting,
// trigger zones, control panels, the IFF dial, radio replies, kills.
//
// Usage: node web/tests/campaign-bot.mjs [game/g-nome/G-NOME] [--missions 2,5-7] [--verbose]
//
// The bot is not a player: it teleports near each goal (goto) and then
// drives the last stretch with the throttle (walkto), so collisions and
// hotspots still decide whether a unit boards or a trigger fires. Where the
// way itself is the test (mission 8's canyon gates), drive finds a path
// round the solid hotspots and drives all of it. Kills go
// through the game's own destroy script (engine.mission.destroy). Math.random
// is seeded so a run always takes the same path.
//
// Step syntax, run in order with 60 ticks (2 s) after each:
//   goto:REF[,dx,dz]    put the player's unit next to REF (offset in world units)
//   walkto:REF[,ticks]  face REF and drive at it until the player reaches it
//   drive:REF[,ticks[,clear[,dx,dz]]]  drive to REF (plus an offset) on a path round the
//                       solid hotspots, keeping `clear` world units from them (empty: default)
//   avoid:REF,R[,N]     keep later drive paths more than R world units from REF
//                       (or from each of REF[0..N-1], such as the mines of a minefield); avoid:none forgets them
//   stop                hold the throttle against the motion until the unit stands still
//   eject               leave the current vehicle or building (script 1943)
//   kill:REF            destroy REF (script 2242)
//   killpilots[:SIDE]   destroy every pilot on foot whose side (p115) is SIDE, or every hostile one
//   wait:T              let T more ticks run
//   key:VK              press and release a key (virtual-key code)
//   click:X,Y           click at screen pixels
//   iff:N               dial the IFF code N with U, I, O and P (one octal digit each)
//   hold:REF,G[,ticks]  face REF and hold fire key G (1-4: the weapon group) for ticks (default 1)
//   face:REF[,ticks]    keep facing REF for ticks (default 1), such as to hold a
//                       target in the sights (script 582) while an airstrike is painted
//   near:REF,D[,ticks]  wait (at most ticks, default 1200) until REF is within D world units; no 60-tick pause after
//   tab:REF             press Tab (next target, script 2000) until REF is the target (G1811)
//   killclass:N         destroy every hostile unit of class N (units that appear
//                       during play, such as spawned HAWCs or ejected pilots)
//   call:S(ARGS)        run script S with REF arguments
//   fire:REF[,ticks[,group]]  face REF and fire weapon group 1-4 (keys 1-4, default 1)
//                       until REF is destroyed
//   target:REF          step the target with Tab until it is REF, and face it
// REF is a global (G381), an array element (G73[0]) or a number; drive also
// takes a point X/Z in world units.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { insidePolygon } from "../src/battlefield/collision.js";

// Mission goals and how the bot meets them (briefing text in quotes).
const SOLUTIONS = {
  // 1-2 Drawbridge: "Commandeer Darken vehicle", "Lower bridge and cross
  // River Angada". The bridge control (G373) shows a panel; clicking it
  // lowers the bridge (G349), then the far bank (trigger G359) and three
  // kills finish it.
  2: ["goto:G73[0],0,1", "walkto:G73[0],300", "goto:G373,-4,0", "eject", "walkto:G373,600",
    "click:184,146", "wait:100", "eject", "goto:G359,0,8", "walkto:G359,400",
    "kill:G173[3]", "kill:G173[4]", "kill:G173[5]"],
  // 1-3 Convoy: "Enter Darken HQ at Chansk". Board the motor pool (G407)
  // for the IFF code, take a Union HAWC, dial the Darken IFF, start the
  // convoy (trigger G625[0]) and catch up with it. Six seconds later the
  // convoy calls and the radio menu opens by itself (script 366) for five
  // seconds: F9 answers (message 6, hook G1221 = 8790), which unlocks the
  // HQ (G397). Pressing F1 then would close the menu instead. Getting out
  // after that turns every enemy hostile (hook G983 = 8792), so leave the
  // HAWC just west of the HQ and run in before its guns get you.
  3: ["goto:G407,0,6", "walkto:G407,400", "eject", "goto:G13[0],0,2", "walkto:G13[0],300",
    "call:409(G973,2408)", "goto:G625[0],0,3", "walkto:G625[0],200", "goto:G73[0],5,0", "wait:200",
    "key:120", "goto:G397,-3,0", "eject", "walkto:G397,600"],
  // 1-4 LATLON: enter the array (G381) on foot, wait for the radio, leave
  // and destroy it.
  4: ["goto:G381,-8,0", "eject", "walkto:G381,600", "wait:200", "eject", "kill:G381"],
  // 1-5 Rescue!: "Set IFF to 0024", defeat the security tower (G419),
  // reach Kylie (trigger G625[0]).
  5: ["iff:20", "kill:G419", "goto:G625[0],0,6", "walkto:G625[0],300"],
  // 2-1 Dropship Rendezvous: take a HAWC, meet the Union HAWCs (trigger
  // G625[3]), clear the landing site and reach waypoint 2 (G625[2]).
  6: ["walkto:G13[0],400", "goto:G625[3],0,5", "walkto:G625[3],200", "wait:200",
    "kill:G713", "kill:G263[0]", "kill:G419", "wait:400", "goto:G625[2],0,5", "walkto:G625[2],300"],
  // 2-2 River Race: occupy the Meson tower (G263[0]), then destroy the
  // LATLON array (G381).
  7: ["goto:G263[0],0,-4", "eject", "walkto:G263[0],400", "eject", "kill:G381"],
  // 2-3 Canyon Maze: "you'll meet [them] at the exit of the gorge". Gates
  // (class 237) close the canyon; destroying their control tower (class
  // 223) switches them off (2101 -> 2279 drops the barrier hotspot). Tower
  // G420 opens the west gates (G427[0..2]); the trigger past them (G625[1])
  // springs the ambush; tower G419 opens the south gates (G427[3..5]) to
  // the exit (trigger G625[2], script 8919 wins). The wingman (G13[1])
  // guards the start until ordered on the radio: guard and follow tie at
  // priority 1 and TaskSetHighestIndex keeps the current task, as RENDER.R32
  // does. It must live (8920: its pilot G2 dying fails the mission).
  8: ["kill:G420", "drive:G625[1]", "kill:G419", "drive:G625[2]"],
  // 2-4 Egger: "Help Thane steal Merc Patrol HAWC", "Lure Merc HAWC into
  // Thane's EGGER range", "Signal Thane to attack". Three Merc kills
  // (G707) bring Thane (G5, on foot) in at the trigger G625[0]. Shooting
  // range of the patrol HAWC (G33[0]) makes it chase the player; lead it
  // to within 12 world units of Thane (update script 8942), then F1+F9
  // (hook G1221 = 8944) sends him in. His EGGER shot (weapon kind 25,
  // script 1711) throws the crew out, he boards the empty HAWC (hook G984
  // = 8938) and 2246 wins. Stand north of him: scenery south-east of him
  // (9739, class 253) stops shots from that side.
  9: ["kill:G33[1]", "kill:G33[2]", "kill:G33[3]", "goto:G33[0],-15,10", "wait:200",
    "goto:G5,0,10", "wait:300", "key:112", "key:120", "wait:1300"],
  // 2-5 The Citadel Approach: "Rendezvous at base of Mesa Caracon",
  // "Destroy base defenses" (three of the towers G419/G420, the bunkers
  // G263 or the popup cluster G345: hook 8967 counts G707), "Draw sentry
  // vehicles away from elevator" (sentry G33[4] chasing the player into
  // trigger G625[3] runs 8968 -> 8969, which also fires when it is hit,
  // hook G987, or killed: Thane (G5) then walks to the elevator), and
  // "Rendezvous at elevator on Thane's signal" (trigger G625[0], script
  // 8974, on foot: G1 is the player's pilot). Thane's dialogue (table
  // 8960, rows from 5) ends with the win (2245). With only G33[4] gone,
  // something still guarding the way shoots Thane, which fails the
  // mission (8967 -> 2249), so G33[3] goes too.
  10: ["kill:G419", "kill:G420", "kill:G263[2]", "goto:G33[4],0,15", "wait:100",
    "kill:G33[4]", "kill:G33[3]", "wait:2100", "goto:G625[0],0,8", "eject", "walkto:G625[0],400"],
  // 2-6 Battle in the Clouds: "Defend Citadel buildings". The wingmen man
  // the Citadel (G5 the shuttle G417, G2 a Meson tower); the player takes
  // another tower (G263[0]). Waves of craft (G33, class 181) come for the
  // player; 8993 sends in the next one as each dies, and G2471 kills (8 on
  // easy, counting the first from 8992) win through 2246. Losing either
  // wingman, or the shuttle while G5 flies it, fails (8995).
  11: ["goto:G263[0],0,-4", "walkto:G263[0],400", "kill:G33[1]", "kill:G33[2]", "kill:G33[3]",
    "kill:G33[4]", "kill:G33[5]", "kill:G33[6]", "kill:G33[7]"],
  // 3-1 Scorp Crossing: "Pass through Ur-Binshar crossing". The player
  // (G1) and two pilots (G2, G5) start on foot. Walking into trigger G625[9]
  // wakes the Scorp vehicle G53[1] and its three guards (G183, whose guns
  // throw a pilot out of his vehicle). Boarding G53[1] (hook G984 = 9022)
  // calls the two pilots aboard; when both are in (hook G993 = 9029) the
  // player's IFF becomes a Scorp code and the Scorp convoy G53[2..4] sets
  // off (9030). The pilots walk, so that takes about a minute. The convoy
  // meets a Union patrol (G13) and they fight; three dead Union pilots
  // (hook G985 = 9021, G710) send the convoy on to the crossing (9033), so
  // the bot destroys the patrol and the crews that eject. The crossing
  // trigger G625[1] lets the player through only with a convoy vehicle
  // within 7 units (9031); otherwise the guards attack and the mission
  // fails 15 s later (2249). The far side (trigger G625[8] or G625[2],
  // 9032) wins.
  12: ["goto:G625[9],-3,0", "walkto:G625[9],100", "kill:G183[0]", "kill:G183[1]", "kill:G183[2]",
    "goto:G53[1],2,0", "walkto:G53[1],200", "wait:2400",
    "kill:G13[0]", "kill:G13[1]", "kill:G13[2]", "killpilots:0", "wait:2400",
    "goto:G53[2],3,0", "drive:G625[1]", "drive:G625[8]"],
  // 3-2 CommArray at Ur-Kinsk: "Kylie/Sheridan to attack rocket tower",
  // "Thane to wait for signal at generator", "Destroy or disable Meson
  // Tower, signal Thane", "Proceed to waypoint 2". Near the rocket tower
  // (G273[1]) E targets it, then F2 / F4 pick Kylie / Sheridan on the radio
  // and F1 sends them at the target (2019). The Meson tower (G381) stands in
  // a walled yard open to the south; destroying it (script 9060) arms
  // waypoint 2 (G625[3], hook 9062 wins). F3 + F9 signals Thane (message 6,
  // hook G1221 = 9058) and he attacks the generator (G385). Thane's pilot
  // (G5) dying fails the mission.
  13: ["goto:G273[1],-15,5", "key:69", "key:113", "key:112", "key:115", "key:112",
    "goto:G381,-6,-20", "kill:G381", "key:114", "key:120", "drive:G625[3]"],
  // 3-3 Raid on Ur-Ulit: "Instruct wingmen to occupy Scorp vehicles"
  // (G53[1..3], hook G984 = 9084 wins once all three have friendly
  // pilots). Shooting the Merc HAWC G53[0] (hit hook G987 = 9081) sends it
  // out of the base to trigger G625[0] and after the player; an EGGER shot
  // empties it and boarding it with the player's pilot G1 (hook 9083) puts
  // the wingmen on follow and the Merc mines (class 570, G467/G499) on
  // view. The base buildings, guard pilot and towers go first, while the
  // towers are empty: a crew thrown out of a destroyed tower runs for an
  // empty Scorp, and manned towers shoot the player down. The wingmen
  // (G13[0], G13[1], G13[3]) start behind rocks and get stuck against
  // them when they steer straight at their leader (RENDER.R32 does the
  // same), so they are told to follow (F1, F5) and led out of the camp to
  // the north first; they ignore mines (property 132), the player picks a
  // lane between them. Every 20 s after boarding, 9087 sends a new Merc
  // pilot for the Scorps, so they are shot on the way in. At the Scorps,
  // Tab picks each Scorp, F2-F4 picks a wingman and F4 (message 9, script
  // 2121) sends him out of his vehicle and into the target.
  14: ["kill:G397", "kill:G595", "kill:G183[0]", "kill:G273[0]", "kill:G273[1]", "killpilots:3",
    "key:112", "key:116", "drive:G625[1],20000,,6,8", "wait:600",
    "goto:G53,-12,0", "hold:G53,1,3", "goto:G625[1],6,8", "near:G53,25", "eject", "near:G53,12",
    "goto:G53,0,5", "hold:G53,2,20", "wait:30", "walkto:G53,300",
    "drive:G54,600,,-31.5,26", "drive:G54,600,,-31.5,5", "killpilots:3", "drive:G54,600,,-10,4", "stop", "killpilots:3",
    "tab:G54", "key:113", "key:115", "killpilots:3", "tab:G55", "key:114", "key:115", "killpilots:3",
    "tab:G56", "key:115", "key:115", "killpilots:3", "wait:300", "killpilots:3", "wait:300"],
  // 3-4 Ur-Alr': "Primary: Help Sheridan enter Scorp HQ at Ur-Alr'",
  // "Cross Eraskat River, defeat bridge defenses", "Approach Ur-Alr':
  // Waypoint two", "Attack Ur-Alr'". Five seconds in the bridge (G349)
  // swings open (timer -> 1787). Its control station (G373) has a Scorp
  // crew, so nobody else can board it (2240), and losing it or the bridge
  // before crossing fails the mission (9112 -> 2249). The bunkers G273[0],
  // G273[1] guard it. The wingman's pilot (G5) carries an EGGER (1656 in
  // 9107; weapon kind 25): send the wingman at the station (F1+F2), get
  // him out (F1+F6, message 8) and his EGGER throws the crew out (1711 ->
  // 1712). Board the station from the south, dial a friendly IFF so the
  // wingman stops shooting at it (its code is still Scorp), and click the
  // panel to close the bridge (1777 -> 4399). The east end (trigger G357,
  // 9109) is objective 1; the walk on stays in the 1.7-unit lane of the
  // deck. Waypoint two (G625[0], 9110) wakes Sheridan's team. Sheridan
  // (G3) is the pilot of G13[3]; when the shield building G411 falls
  // (9112), 2121 sends him to the HQ (G397) and boarding it (hook G984 =
  // 9111) wins. For that he must be on foot near the base (from his start
  // by the north camp he stalls on the compound's corner), alive (the
  // fence G595, power plant G385, gun G273[4] and the HAWCs G411 spawns
  // shoot him), and the HQ empty: with its Scorp crew he cannot board it,
  // so the EGGER hit (1711) that the wingman would bring is run directly.
  // His transport is destroyed to put him out, as the base usually does.
  15: ["wait:200", "kill:G273[0]", "kill:G273[1]", "goto:G373,8,-8", "key:112", "key:113", "wait:600",
    "key:112", "key:117", "wait:1200", "goto:G373,0,-4", "eject", "walkto:G373,300", "iff:1053",
    "click:184,146", "wait:200", "eject", "goto:G13[0],0,-3", "walkto:G13[0],300", "kill:G53[2]",
    "kill:G53[0]", "drive:G357", "walkto:G359,300", "drive:G625[0]", "stop", "kill:G595", "kill:G385",
    "kill:G273[4]", "wait:600", "killclass:24", "killclass:142", "kill:G13[3]", "killclass:24",
    "call:1711(G397,G5)", "kill:G411", "killclass:142", "wait:1500"],
  // 3-5 Ion-Strike: "Destroy G-Nome laboratory", "Defeat rocket tower
  // defense", "Destroy laboratory with ion-strike". The four rocket towers
  // (G333, class 234) belong to the control station G345 (class 222);
  // destroying it runs 2126, which stops their update scripts. The lab
  // G417 (class 227) sits against a mesa, so only some spots see it; from
  // the trigger G625[0] the second weapon group hits it. Its death (hook
  // G985 = 9133) marks objective 0 and starts dialogue 9129; the last
  // line (9136, 9137) waits 5 s and 9138 wins (2246) if the player is in
  // a vehicle, or calls the ion strike (1649) down on a player on foot.
  // Nothing in the mission gives the player the laser sight (weapon kind
  // 32, the Ctrl+Z cheat), so the lab is shot down. The escorts and
  // turrets are killed, and their crews, as in other missions.
  16: ["kill:G53[0]", "kill:G53[1]", "kill:G53[2]", "kill:G53[3]", "kill:G53[4]", "kill:G53[5]",
    "kill:G273[0]", "kill:G273[1]", "kill:G273[2]", "kill:G273[3]", "wait:100", "killpilots:3",
    "drive:-26/-50,20000,1.5", "fire:G345,900,2", "drive:G625[0],20000,1", "fire:G417,1800,2", "wait:600"],
  // 4-1 Captured!: "Rescue Kylle at Scorp Imperial HQ". The HQ (G397)
  // sits in a walled compound whose gates (G427, class 237) belong to the
  // security tower G419 (script 2098); destroying it opens them (2101 ->
  // 2279). The trigger by the HQ (G625[0], script 9156) sends the guards
  // out and sets the eject hook G983 = 9155: the player's pilot (G1)
  // getting out there wins (2246). Losing Kylle (G5) or the HQ fails it.
  // The whole way is driven, with the player's unit vulnerable.
  17: ["kill:G419", "drive:G625[0]", "wait:300", "eject", "wait:200"],
  // 4-2 Scorp Defense: "Defend Ur-Kinsk", "Occupy guard towers", "Command
  // Sant Drones, F5-F8". Scorp craft (G13) head for the HQ (G397) and the
  // security tower (G419). The player's pilot (G1) boarding a guard tower
  // (G273, hook G984 = 9168) marks the towers done. While the drawbridge
  // G349 is down (p42 = 0) each of G13[6] and G13[7] that dies is replaced
  // (9169); raising it from its control station (G373, the panel at
  // 184,146) stops that and drops whatever is on it. The kill hook (G985 =
  // 9167) wins (2245) once G2487 Scorps (6 on easy, plus one per
  // replacement) are down and the bridge is up, or once G1868 passes 900.
  // Losing either wingman (G5, G2), or ten of the player's side, fails it.
  // The wingmen fight on foot, so the two Scorps nearest them go first.
  18: ["kill:G13[2]", "kill:G13[1]", "goto:G273[1],0,3", "walkto:G273[1],300", "eject",
    "goto:G373,-4,0", "walkto:G373,600", "click:184,146", "wait:100",
    "kill:G13[4]", "kill:G13[5]", "kill:G13[6]", "kill:G13[7]"],
  // 4-3 War Zone: "Cross Shalten war zone to waypoint three", "Use Union
  // HAWCs and one airstrike". The player (G13[0], pilot G1) and two
  // wingmen (G2, G5 in G13[1], G13[2]) start north; losing either wingman's
  // pilot fails it (9190 -> 2249). The base is a maze of walls whose two
  // ways south are minefields (G467, G499: class 570, owned by the mine
  // control G595, warnings G625[3]/[4]) and the gate G349; the gates start
  // open (1780). Hotspots wake the defenders as the player comes: G367 by
  // the north gate (G73[1], G73[3], G33[1], G33[2]), G361 east (G33[3]),
  // G369 west, G357 south. G73[0] attacks from the start; the crews of
  // destroyed vehicles carry EGGER guns that throw the player out of his
  // HAWC, so they go too. The airstrike is weapon 32 in the pilot's own
  // list (group 3 on foot): fire it at the target (G974, held in the sights
  // for 10 checks by script 582) and keep it there about 10 s; 1649 -> 1650
  // then destroys it. Destroying G595 sets off all 32 mines. Waypoint three
  // (G625[0], 9200) wins. The supply stops (ammunition G713, objective 4;
  // shield doubler G397, objective 3) are optional. The way to the south
  // gate lines up north of it first: its posts leave a lane under 2 units.
  19: ["avoid:G467,3,16", "avoid:G499,3,16", "kill:G73[0]", "killpilots", "drive:G367", "kill:G73[1]", "kill:G73[3]",
    "kill:G33[1]", "kill:G33[2]", "killpilots", "drive:G595,20000,,-3,5", "kill:G33[3]", "eject",
    "tab:G595", "face:G595,60", "hold:G595,3,3", "face:G595,400", "walkto:G13[0],300", "avoid:none", "drive:G349,20000,,0,5", "drive:G625[0]"],
  // 4-4 General Delivery: "Lower bridge for reinforcements". The player
  // (pilot G1) starts in a vehicle (G53[0]). Five seconds in, a timer
  // (1787) raises the bridge G349. On the way west: guards G13[1..3], gun
  // towers G283, and a minefield (G467, class 570) owned by G595, whose
  // death sets all the mines off (2278 -> 2117). The trigger past the
  // mines (G625[0], script 9217) sends two craft (G13[6..7] on easy) after
  // the player, and G13[8] guards the bridge control G373. Some guns throw
  // the pilot out of the vehicle (weapon kind 26, 1715), and the crews of
  // destroyed units fight on foot, so the bot clears them as it goes. In
  // the control, the mission 2 panel lowers the bridge (1777 -> 4399, p42
  // = 0); getting out with it down (hook G983 = 9216) wins through 2246.
  // Losing the bridge, or the control while the bridge is up, fails (hook
  // G985 = 9214). The whole way is driven, with the player vulnerable.
  20: ["kill:G13[1]", "kill:G13[2]", "kill:G13[3]", "kill:G283[0]", "kill:G283[1]", "kill:G283[2]",
    "kill:G595", "wait:300", "killpilots:0", "drive:G625[0]", "kill:G13[6]", "kill:G13[7]", "kill:G13[8]",
    "wait:300", "killpilots:0", "drive:G373", "eject", "walkto:G373,600", "click:184,146", "wait:100", "eject"],
  // 4-5 Sheridan's Lair: "Destroy Recombination laboratory" (G417, class
  // 227) "before arrival of transport ship (20 min.)" (9233 checks the
  // clock every 10 s and fails at 1200 s, 2248), "Breach defenses" and
  // "Paint lab with laser sight for Ion-strike". The lab sits in a walled
  // compound whose gates (G427) belong to the security tower G419 (2098);
  // shooting the tower down opens them (2101 -> 2279). The player's pilot
  // G1 carries the laser sight (weapon 32, group 4; 9228 gives it). On
  // foot, within 12 world units, with the lab selected (Tab, then facing
  // it), holding 4 paints it (p141 = G974, script 1681); when the charge
  // runs out the ion strike (1649 -> 1650) destroys it. Its death (hook
  // G985 = 9230) marks objectives 0 and 4 and starts dialogue 9226 row 1,
  // whose callback 9232 wins (2246). The missile turrets G283[0] and
  // G283[3] reach the compound and kill a pilot on foot, and patrols hunt
  // the player, so they are killed. Nothing in the scripts checks
  // "exchange vehicles with Wilkins".
  21: ["kill:G283[0]", "kill:G283[3]", "kill:G283[6]", "kill:G53[2]", "kill:G53[6]", "kill:G53[7]",
    "drive:30/38", "key:48", "wait:300", "fire:G419,900,1", "fire:G419,900,2", "kill:G53[1]",
    "drive:38/-62,20000,0", "key:48", "wait:300", "eject", "drive:36/-76,20000,0",
    "target:G417", "fire:G417,900,4", "wait:400"],
  // 4-6 Mano-a-Mano: "Kill Sheridan and G-Nome". Sheridan (G3, side 3)
  // drives the G-Nome (G13[1]) along waypoints G605[0], G605[1], G359 to
  // the gate G349; reaching G357 behind it fails the mission (9257). His
  // update script 9259 keeps his target scan off until the player crosses
  // trigger G625[1] (9260); then he still heads for the gate but shoots
  // back, and if he gets there the mission fails. Killing him (hook G985
  // = 9255) wins (2246). Before that trigger he circles the rock at
  // G605[0] after bumping it: the collision sets his circle target (p70)
  // and only the scan timer that 9259 holds off would clear it. He is
  // shot with single full-charge shots (a held key fires weak ones) from
  // close by; about 26 bring the G-Nome down, so after 24 the kill step
  // finishes it, and then his pilot, thrown out when it dies.
  22: ["drive:G625[1]", "near:G13[1],20,3000", "goto:G13[1],-8,0", ...Array(24).fill("hold:G13[1],1,1"), "kill:G13[1]", "wait:100", "kill:G3"],
};

const dir = process.argv.slice(2).find((a) => !a.startsWith("--") && !/^[\d,-]+$/.test(a)) || "game/g-nome/G-NOME";
if (!existsSync(join(dir, "G-NOME.BIN"))) {
  console.log(`campaign bot: no game files in ${dir}, skipped`);
  process.exit(0);
}
const verbose = process.argv.includes("--verbose");
const mi = process.argv.indexOf("--missions");
/** @param {string} s */
const parseList = (s) => s.split(",").flatMap((p) => {
  const [a, b = a] = p.split("-").map(Number);
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
});
const missions = mi > 0 ? parseList(process.argv[mi + 1]) : Object.keys(SOLUTIONS).filter((k) => /^\d+$/.test(k)).map(Number);

const { Engine } = await import("../src/engine.js");
const names = new Map(readdirSync(dir).map((n) => [n.toUpperCase(), n]));
const files = {
  read: async (/** @type {string} */ n) => new Uint8Array(readFileSync(join(dir, names.get(n.toUpperCase())))),
  has: (/** @type {string} */ n) => names.has(n.toUpperCase()),
};

const VK_THROTTLE_UP = 0x6b, VK_THROTTLE_DOWN = 0x6d, VK_FIRE = 0x31; // 1-4: fire actions 29-32
const VK_TAB = 0x09; // next target (action 44)
const TILE = 6; // ground tiles (level -100) sit on a 6-unit grid
const CLEAR = 1; // world units drive keeps from wall edges where it can
const TRIGGER = 500; // class of trigger zones: their hotspots never block
const DEAD = 1729; // update script of a destroyed unit (script 2278)

// Waypoints (x, z) from `from` to `to` on a 1-unit grid: cells on a ground
// tile and outside every solid hotspot still in its object's hotspot list
// (property 16; scripts 434/435 take a gate's barrier out of it), found
// breadth first. With `clear`, a cell also keeps that far from wall edges
// (nearEdge), or with `round` has that much room all round it (for a wide
// vehicle that would catch on a corner). Null when there is no way.
/**
 * @param {any} engine
 * @param {number[]} from
 * @param {number[]} to
 * @param {number} clear
 * @param {boolean} round
 * @param {number[][]} avoid circles (x, z, radius) to keep out of
 */
function findPath(engine, from, to, clear = CLEAR, round = false, avoid = []) {
  const prop = (/** @type {number} */ id, /** @type {number} */ p) => engine.render3d.objects.getProperty(id, p);
  const objs = [...engine.world.objects.values()];
  const tiles = new Set();
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const o of objs) {
    if (o.level !== -100) continue;
    tiles.add(`${Math.round(o.pos[0] / TILE)},${Math.round(o.pos[2] / TILE)}`);
    x0 = Math.min(x0, o.pos[0] - TILE); x1 = Math.max(x1, o.pos[0] + TILE);
    z0 = Math.min(z0, o.pos[2] - TILE); z1 = Math.max(z1, o.pos[2] + TILE);
  }
  const solid = [];
  for (const o of objs) {
    if (prop(o.id, 0) === TRIGGER) continue;
    for (const n of engine.renderLists?.get(prop(o.id, 16)) || []) {
      const h = engine.hotspots.get(n);
      if (h && h.flags & 1) solid.push(h);
    }
  }
  // Keep `clear` units away from wall edges too: a cell just outside a
  // wall lets the unit cut the corner into it and get stuck in a notch
  // (mission 17's rocks). Narrow ways (mission 8's canyon) need clear = 0.
  const prints = new Map(solid.filter((h) => h.type !== 0x10).map((h) => [h, engine.collision.footprint(h)]));
  const nearEdge = (/** @type {any} */ fp, /** @type {number} */ x, /** @type {number} */ z) => {
    const { pts, flags } = fp;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      if (flags[i]) continue;
      const [ax, , az] = pts[j], [bx, , bz] = pts[i];
      const ex = bx - ax, ez = bz - az, l2 = ex * ex + ez * ez;
      const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / l2)) : 0;
      if (Math.hypot(ax + ex * t - x, az + ez * t - z) < clear) return true;
    }
    return false;
  };
  const ring = round && clear ? [[0, 0], ...[0, 1, 2, 3, 4, 5, 6, 7].map((k) => [clear * Math.cos(k * Math.PI / 4), clear * Math.sin(k * Math.PI / 4)])] : [[0, 0]];
  const blocked = (/** @type {number} */ x, /** @type {number} */ z) =>
    !tiles.has(`${Math.round(x / TILE)},${Math.round(z / TILE)}`) ||
    avoid.some(([ax, az, r]) => Math.hypot(ax - x, az - z) < r) ||
    ring.some(([dx, dz]) => inside(x + dx, z + dz)) ||
    (!round && clear > 0 && [...prints.values()].some((fp) => fp.pts.length > 0 && nearEdge(fp, x, z)));
  const inside = (/** @type {number} */ x, /** @type {number} */ z) =>
    solid.some((h) => {
      if (h.type === 0x10) return Math.hypot(h.pos[0] - x, h.pos[2] - z) <= h.id / 100;
      const fp = prints.get(h);
      if (!fp.pts.length) return false;
      return insidePolygon(fp.pts, x, z) !== (h.type === 8);
    });
  x0 = Math.floor(x0); z0 = Math.floor(z0);
  const w = Math.ceil(x1) - x0 + 1, hgt = Math.ceil(z1) - z0 + 1;
  const cell = (/** @type {number[]} */ p) => Math.round(p[2] - z0) * w + Math.round(p[0] - x0);
  const start = cell(from), goal = cell(to);
  const prev = new Int32Array(w * hgt).fill(-1);
  prev[start] = start;
  const queue = [start];
  for (let k = 0; k < queue.length && prev[goal] < 0; k++) {
    const c = queue[k], cx = c % w, cz = (c - cx) / w;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const x = cx + dx, z = cz + dz, n = z * w + x;
      if (x < 0 || z < 0 || x >= w || z >= hgt || prev[n] >= 0) continue;
      if (n !== goal && blocked(x + x0, z + z0)) continue;
      prev[n] = c;
      queue.push(n);
    }
  }
  if (prev[goal] < 0) return null;
  const out = [];
  for (let c = goal; c !== start; c = prev[c]) out.push([(c % w) + x0, Math.floor(c / w) + z0]);
  return out.reverse().filter((_, i, a) => i % 4 === 3 || i === a.length - 1);
}
const IFF_KEYS = [0x55, 0x49, 0x4f, 0x50]; // U I O P: actions 55-58, scripts 1994-1997

/** @param {number} n */
async function play(n) {
  let seed = 1;
  const random = Math.random;
  Math.random = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296;
  try {
    const engine = new Engine(files, { log: () => {} });
    await engine.init();
    engine.boot();
    const vm = engine.vm;
    const prop = (/** @type {number} */ id, /** @type {number} */ p) => engine.render3d.objects.getProperty(id, p);
    const ref = (/** @type {string} */ s) => {
      const r = /^G(\d+)(?:\[(\d+)\])?$/.exec(s);
      return r ? vm.getGlobal(Number(r[1]) + Number(r[2] || 0)) : Number(s);
    };
    const player = () => vm.getGlobal(973);
    /** @type {number[][]} */
    const avoid = []; // circles (x, z, radius) drive keeps out of
    const obj = (/** @type {number} */ id) => engine.world.get(id);
    const step = async (/** @type {number} */ ticks) => {
      for (let i = 0; i < ticks; i++) {
        engine.tick(1000 / 30);
        await new Promise((r) => setImmediate(r));
      }
    };
    // Skip the opening movie and wait for the main menu (script 8344's
    // rect), as a player would. Left running, the movie's end script sets
    // G2119 (the campaign mission) to 0 about 70 s in, which breaks every
    // objective lookup (script 8318) in a long mission.
    for (let i = 0; i < 60 && !engine.plugins.some((/** @type {any} */ p) => p.ownsScreen); i++) await step(1);
    engine.input.keyDown(0x1b);
    engine.input.keyUp(0x1b);
    for (let i = 0; i < 150 && !engine.clickRects.some((/** @type {any} */ r) => !r.off && r.script === 8344); i++) await step(1);
    await step(30);
    // Start the mission the way the briefing's launch button does (8317).
    for (const g of [2118, 2119]) vm.setGlobal(g, n);
    vm.setGlobal(982, 0);
    engine.run(8317);
    await step(60);
    assert.ok(player(), `mission ${n}: no player unit`);

    for (const s of SOLUTIONS[n]) {
      const [k, v = ""] = s.split(/:(.*)/);
      if (verbose) console.log(`  m${n} ${s}`);
      if (k === "goto") {
        const [r, dx = "0", dz = "0"] = v.split(",");
        const target = obj(ref(r)), me = obj(player());
        assert.ok(target && me, `mission ${n}: ${s}: no such unit`);
        me.setPosition([target.pos[0] + Number(dx), me.pos[1], target.pos[2] + Number(dz)]);
        me.tickPos = me.pos.slice();
      } else if (k === "walkto") {
        const [r, ticks = "300"] = v.split(",");
        const id = ref(r);
        for (let i = 0; i < Number(ticks) && player() !== id; i++) {
          const me = obj(player()), target = obj(id);
          if (!me || !target) break;
          const dx = target.pos[0] - me.pos[0], dz = target.pos[2] - me.pos[2], d = Math.hypot(dx, dz);
          if (d < 0.3) break;
          me.basis = { at: [dx / d, 0, dz / d], up: [0, 1, 0], right: [-dz / d, 0, dx / d] };
          me.tickBasis = me.basis;
          if (i % 3 === 0) engine.input.keyDown(VK_THROTTLE_UP, false, false, i > 0);
          await step(1);
        }
        engine.input.keyUp(VK_THROTTLE_UP);
        for (let i = 0; i < 20; i++) engine.input.keyDown(VK_THROTTLE_DOWN, false, false, i > 0);
        engine.input.keyUp(VK_THROTTLE_DOWN);
        if (verbose) console.log(`    now ${player()} at ${obj(player())?.pos.map(Math.round)}`);
      } else if (k === "drive") {
        const [r, ticks = "20000", c = "", dx = "0", dz = "0"] = v.split(",");
        const clear = c === "" ? undefined : c;
        const id = ref(r);
        const point = /^(-?[\d.]+)\/(-?[\d.]+)$/.exec(r);
        const at = point ? [Number(point[1]), 0, Number(point[2])] : obj(id).pos;
        const goal = [at[0] + Number(dx), 0, at[2] + Number(dz)];
        // Without a clearance, try the default and then none.
        const way = clear !== undefined ? findPath(engine, obj(player()).pos, goal, Number(clear), true, avoid)
          : findPath(engine, obj(player()).pos, goal, CLEAR, false, avoid) || findPath(engine, obj(player()).pos, goal, 0, false, avoid);
        assert.ok(way, `mission ${n}: ${s}: no way through`);
        let i = 0;
        for (const [x, z] of way) {
          for (; i < Number(ticks) && engine.mission.status().outcome === "playing"; i++) {
            const me = obj(player());
            if (!me) break;
            const dx = x - me.pos[0], dz = z - me.pos[2], d = Math.hypot(dx, dz);
            if (d < 2) break;
            me.basis = { at: [dx / d, 0, dz / d], up: [0, 1, 0], right: [-dz / d, 0, dx / d] };
            me.tickBasis = me.basis;
            if (i % 3 === 0) engine.input.keyDown(VK_THROTTLE_UP, false, false, i > 0);
            await step(1);
          }
        }
        engine.input.keyUp(VK_THROTTLE_UP);
        for (let j = 0; j < 20; j++) engine.input.keyDown(VK_THROTTLE_DOWN, false, false, j > 0);
        engine.input.keyUp(VK_THROTTLE_DOWN);
        if (verbose) console.log(`    now ${player()} at ${obj(player())?.pos.map(Math.round)} after ${i} ticks`);
      } else if (k === "avoid") {
        if (v === "none") avoid.length = 0;
        // REF,R[,N]: N > 1 avoids the array REF[0..N-1] (skipping empty slots).
        const [r, rad, count = "1"] = v.split(",");
        const base = /^G(\d+)$/.exec(r);
        for (let i = 0; v !== "none" && i < Number(count); i++) {
          const p = obj(base && Number(count) > 1 ? vm.getGlobal(Number(base[1]) + i) : ref(r))?.pos;
          if (p) avoid.push([p[0], p[2], Number(rad)]);
        }
      } else if (k === "eject") engine.callScript(1943, []);
      else if (k === "stop") {
        let held = 0;
        for (let i = 0; i < 150; i++) {
          const speed = obj(player())?.speed || 0;
          const want = speed > 0.05 ? VK_THROTTLE_DOWN : speed < -0.05 ? VK_THROTTLE_UP : 0;
          if (want !== held) {
            if (held) engine.input.keyUp(held);
            if (want) engine.input.keyDown(want);
            held = want;
          }
          if (!want) break;
          await step(1);
        }
        if (held) engine.input.keyUp(held);
      }
      else if (k === "killclass") {
        for (const e of engine.mission.status().enemies) if (e.class === Number(v)) engine.mission.destroy(e.id);
      }
      // Once the mission is won, more kills would run its win script again.
      else if (k === "kill") {
        if (!engine.mission.status().ending) engine.mission.destroy(ref(v));
      }
      else if (k === "killpilots") {
        // Pilots on foot (class below 100): the hostile ones, or those of
        // side p115 = v, such as the crews that eject from destroyed vehicles.
        for (const id of engine.mission.units())
          if (id !== player() && prop(id, 0) < 100 && (v ? prop(id, 115) === Number(v) && prop(id, 77) : engine.mission.hostile(player(), id)))
            engine.mission.destroy(id);
      }
      else if (k === "fire") {
        // Shots, hits and damage all go through the game's own scripts.
        const [r, ticks = "900", group = "1"] = v.split(",");
        const id = ref(r), vk = VK_FIRE + Number(group) - 1;
        // Gone: the mission cleared its global, or the object is dead (death
        // script 2278 leaves structures standing with update script 1729).
        const alive = () => ref(r) === id && obj(id) && obj(id).updateScript !== DEAD;
        let brake = false;
        for (let i = 0; i < Number(ticks) && alive() && engine.mission.status().outcome === "playing"; i++) {
          // Stand still: drive and walkto can leave some throttle on, and
          // walking into a building boards it. Not when the throttle (p12)
          // is already 0 (key 0, the game's full stop): that would back away.
          if (i === 0) brake = prop(player(), 12) > 0;
          if (i < 30 && brake) engine.input.keyDown(VK_THROTTLE_DOWN, false, false, i > 0);
          else if (i === 30) engine.input.keyUp(VK_THROTTLE_DOWN);
          const me = obj(player()), target = obj(id);
          const dx = target.pos[0] - me.pos[0], dz = target.pos[2] - me.pos[2], d = Math.hypot(dx, dz);
          if (i % 60 === 0 && d > 0.5) {
            me.basis = { at: [dx / d, 0, dz / d], up: [0, 1, 0], right: [-dz / d, 0, dx / d] };
            me.tickBasis = me.basis;
          }
          // Tap once a second: a held key fires the energy weapons at
          // whatever charge they have.
          if (i % 30 === 0) engine.input.keyDown(vk);
          if (i % 30 === 2) engine.input.keyUp(vk);
          await step(1);
        }
        engine.input.keyUp(vk);
        if (verbose) console.log(`    ${r} ${alive() ? "still there" : "destroyed"}`);
      }
      else if (k === "target") {
        // Tab (action 44, script 2000) steps the target G1811 through the
        // unit list; facing it for 10 frames selects it (G974, script 582),
        // which is what the laser sight paints.
        const id = ref(v);
        for (let i = 0; i < 150 && vm.getGlobal(1811) !== id; i++) {
          engine.input.keyDown(VK_TAB);
          await step(1);
          engine.input.keyUp(VK_TAB);
          await step(1);
        }
        const me = obj(player()), t = obj(id);
        const dx = t.pos[0] - me.pos[0], dz = t.pos[2] - me.pos[2], d = Math.hypot(dx, dz);
        me.basis = { at: [dx / d, 0, dz / d], up: [0, 1, 0], right: [-dz / d, 0, dx / d] };
        me.tickBasis = me.basis;
        await step(15);
        assert.equal(vm.getGlobal(974), id, `mission ${n}: ${s}: not selected`);
      }
      else if (k === "wait") await step(Number(v));
      else if (k === "key") {
        engine.input.keyDown(Number(v));
        await step(2);
        engine.input.keyUp(Number(v));
      } else if (k === "click") {
        const [x, y] = v.split(",").map(Number);
        engine.mouseMove(x, y);
        engine.mouseDown(x, y);
        await step(2);
      } else if (k === "iff") {
        const want = Number(v);
        for (let d = 0; d < 4; d++) {
          const shift = 9 - 3 * d;
          for (let i = 0; i < 8 && ((prop(player(), 113) >> shift) & 7) !== ((want >> shift) & 7); i++) {
            engine.input.keyDown(IFF_KEYS[d]);
            await step(1);
            engine.input.keyUp(IFF_KEYS[d]);
            await step(1);
          }
        }
        assert.equal(prop(player(), 113), want, `mission ${n}: IFF dial`);
      } else if (k === "hold" || k === "face") {
        const [r, a, b = "1"] = v.split(",");
        const g = k === "hold" ? Number(a) : 0, ticks = k === "hold" ? b : a || "1";
        const id = ref(r);
        assert.ok(obj(id) && obj(player()), `mission ${n}: ${s}: no such unit`);
        if (g) engine.input.keyDown(0x30 + g);
        for (let i = 0; i < Number(ticks); i++) {
          const me = obj(player()), target = obj(id);
          if (!me || !target) break;
          const dx = target.pos[0] - me.pos[0], dz = target.pos[2] - me.pos[2], d = Math.hypot(dx, dz);
          me.basis = { at: [dx / d, 0, dz / d], up: [0, 1, 0], right: [-dz / d, 0, dx / d] };
          me.tickBasis = me.basis;
          await step(1);
        }
        if (g) engine.input.keyUp(0x30 + g);
      } else if (k === "near") {
        const [r, dist, ticks = "1200"] = v.split(",");
        const id = ref(r);
        for (let i = 0; i < Number(ticks); i++) {
          const me = obj(player()), t = obj(id);
          if (!me || !t || Math.hypot(t.pos[0] - me.pos[0], t.pos[2] - me.pos[2]) <= Number(dist)) break;
          await step(1);
        }
        continue;
      } else if (k === "tab") {
        const id = ref(v);
        for (let i = 0; i < 150 && vm.getGlobal(1811) !== id; i++) {
          engine.input.keyDown(0x09);
          await step(1);
          engine.input.keyUp(0x09);
        }
        assert.equal(vm.getGlobal(1811), id, `mission ${n}: ${s}: not in range`);
      } else if (k === "call") {
        const [, id, args] = /** @type {RegExpExecArray} */ (/(\d+)\((.*)\)/.exec(v));
        vm.callValue(Number(id), args ? args.split(",").map(ref) : []);
      } else throw new Error(`unknown step ${s}`);
      await step(60);
    }
    // The win runs the fly-by (2243) and then the debrief; give it time.
    for (let i = 0; i < 40 && engine.mission.status().outcome === "playing"; i++) await step(30);
    const outcome = engine.mission.status().outcome;
    assert.equal(outcome, "won", `mission ${n} ended ${outcome}`);
    assert.equal(engine.vm.unknown.size, 0, `mission ${n}: unimplemented ${[...engine.vm.unknown.keys()]}`);
  } finally {
    Math.random = random;
  }
}

let failed = 0;
for (const n of missions) {
  if (!SOLUTIONS[n]) {
    console.log(`mission ${n}: no solution yet`);
    continue;
  }
  try {
    await play(n);
    console.log(`mission ${n}: won`);
  } catch (e) {
    failed++;
    console.log(`mission ${n}: FAILED ${/** @type {Error} */ (e).message}`);
  }
}
if (failed) process.exit(1);
