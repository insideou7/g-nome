// Export and import of saved games, so they outlive the browser's storage.
//
// A G-NOME save is two things: SGNOME<n>.SAV (written by script 6291, kept
// in storage by anim/files.js) and its name, which the save screen keeps in
// the INI as [GnomeGames] savegame_<n> (scripts 6290 and 6282). There are 20
// slots, 0-19. An export file is JSON:
//   { "format": "g-nome-saves", "version": 1,
//     "saves": [{ "slot": 0, "name": "...", "data": "<base64 .SAV>" }] }

import { STORE, toBase64, fromBase64 } from "./anim/files.js";

export const SLOTS = 20;
const FORMAT = "g-nome-saves";
const SECTION = "GnomeGames";
const fileName = (/** @type {number} */ slot) => `SGNOME${slot}.SAV`;
const nameKey = (/** @type {number} */ slot) => `savegame_${slot}`;

/**
 * The saves in storage, as an export object.
 * @param {Storage | {getItem(k: string): string | null}} storage
 * @param {{get(section: string, key: string): string | undefined}} ini
 */
export function exportSaves(storage, ini) {
  const saves = [];
  for (let slot = 0; slot < SLOTS; slot++) {
    const data = storage.getItem(STORE + fileName(slot));
    if (data === null) continue;
    saves.push({ slot, name: ini.get(SECTION, nameKey(slot)) ?? "", data });
  }
  return { format: FORMAT, version: 1, saves };
}

/**
 * Write the saves of an export object (or its JSON text) into storage and
 * the INI, replacing those slots. `files` is the running engine's
 * ScriptFiles, so a game in progress sees them at once. Returns how many
 * saves were imported; throws if the file is not a G-NOME save export.
 * @param {any} input
 * @param {{storage: {setItem(k: string, v: string): void}, ini: {set(section: string, key: string, v: any): void}, files?: {save(name: string, bytes: Uint8Array): void} | null}} to
 */
export function importSaves(input, { storage, ini, files }) {
  const obj = typeof input === "string" ? JSON.parse(input) : input;
  if (obj?.format !== FORMAT || !Array.isArray(obj.saves)) throw new Error("not a G-NOME saves file");
  const ok = obj.saves.filter((/** @type {any} */ s) => Number.isInteger(s?.slot) && s.slot >= 0 && s.slot < SLOTS && typeof s.data === "string");
  // Decode them all first, so a damaged file writes nothing.
  const decoded = ok.map((/** @type {any} */ s) => ({ slot: s.slot, name: String(s.name ?? "").slice(0, 30), bytes: fromBase64(s.data) }));
  for (const s of decoded) {
    if (files) files.save(fileName(s.slot), s.bytes);
    else storage.setItem(STORE + fileName(s.slot), toBase64(s.bytes));
    ini.set(SECTION, nameKey(s.slot), s.name);
  }
  return ok.length;
}

/**
 * The running engine's script files (RENDER.R32's File externs), if any.
 * @param {import("./engine.js").Engine | null} engine
 */
export function scriptFilesOf(engine) {
  return engine?.plugins?.find((p) => p.name === "render")?.files ?? null;
}
