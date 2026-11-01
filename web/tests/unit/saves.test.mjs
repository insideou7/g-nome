// Unit tests for save game export and import (src/saves.js), with
// stand-ins for localStorage and the INI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { exportSaves, importSaves, SLOTS } from "../../src/saves.js";
import { STORE, toBase64, fromBase64 } from "../../src/anim/files.js";

function memoryStorage() {
  const m = new Map();
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}
function memoryIni() {
  const m = new Map();
  return { m, get: (s, k) => m.get(`${s}/${k}`), set: (s, k, v) => m.set(`${s}/${k}`, v) };
}

test("base64 round trip keeps every byte value", () => {
  const all = Uint8Array.from({ length: 256 }, (_, i) => i);
  assert.deepEqual(fromBase64(toBase64(all)), all);
});

test("exportSaves lists the filled slots with their names", () => {
  const storage = memoryStorage(), ini = memoryIni();
  storage.setItem(STORE + "SGNOME3.SAV", toBase64(Uint8Array.of(1, 2, 3)));
  storage.setItem(STORE + "SGNOME19.SAV", toBase64(Uint8Array.of(9)));
  storage.setItem(STORE + "SGNOME20.SAV", "ignored: past the last slot");
  ini.set("GnomeGames", "savegame_3", "Mission 4");
  const out = exportSaves(storage, ini);
  assert.equal(out.format, "g-nome-saves");
  assert.equal(out.version, 1);
  assert.deepEqual(out.saves.map((s) => [s.slot, s.name]), [[3, "Mission 4"], [19, ""]]);
  assert.equal(SLOTS, 20);
});

test("importSaves round-trips an export into empty storage", () => {
  const a = memoryStorage(), ai = memoryIni();
  a.setItem(STORE + "SGNOME0.SAV", toBase64(Uint8Array.of(5, 6, 7)));
  ai.set("GnomeGames", "savegame_0", "First");
  const json = JSON.stringify(exportSaves(a, ai));
  const b = memoryStorage(), bi = memoryIni();
  assert.equal(importSaves(json, { storage: b, ini: bi }), 1);
  assert.deepEqual(fromBase64(b.getItem(STORE + "SGNOME0.SAV")), Uint8Array.of(5, 6, 7));
  assert.equal(bi.get("GnomeGames", "savegame_0"), "First");
});

test("importSaves goes through the running game's files when given", () => {
  const saved = [];
  const files = { save: (name, bytes) => saved.push([name, [...bytes]]) };
  const storage = memoryStorage();
  importSaves({ format: "g-nome-saves", saves: [{ slot: 2, name: "x", data: toBase64(Uint8Array.of(4)) }] }, { storage, ini: memoryIni(), files });
  assert.deepEqual(saved, [["SGNOME2.SAV", [4]]]);
  assert.equal(storage.m.size, 0);
});

test("importSaves skips bad slots and trims long names", () => {
  const ini = memoryIni();
  const n = importSaves(
    {
      format: "g-nome-saves",
      saves: [
        { slot: -1, data: "" },
        { slot: 20, data: "" },
        { slot: 1.5, data: "" },
        { slot: 4, data: 7 },
        { slot: 5, name: "N".repeat(40), data: toBase64(Uint8Array.of(1)) },
      ],
    },
    { storage: memoryStorage(), ini },
  );
  assert.equal(n, 1);
  assert.equal(ini.get("GnomeGames", "savegame_5").length, 30);
});

test("importSaves rejects other files and writes nothing from a damaged one", () => {
  assert.throws(() => importSaves({ format: "other", saves: [] }, { storage: memoryStorage(), ini: memoryIni() }), /not a G-NOME saves file/);
  const storage = memoryStorage();
  const bad = { format: "g-nome-saves", saves: [{ slot: 0, data: toBase64(Uint8Array.of(1)) }, { slot: 1, data: "!!not base64!!" }] };
  assert.throws(() => importSaves(bad, { storage, ini: memoryIni() }));
  assert.equal(storage.m.size, 0);
});
