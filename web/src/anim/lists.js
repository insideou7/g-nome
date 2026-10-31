// RENDER.R32's list externs (0x10012c08-0x10012f9f): fixed-size arrays of
// ints that scripts use for unit groups, targets and the like. A list id is
// 1-based; ids are reused after ListDestroy. Spec: docs/formats/animation.md.
/** @import { Engine } from "../engine.js" */

/**
 * @param {Engine} engine
 * @returns {Externs}
 */
export function listExterns(engine) {
  /** @type {(number[] | null)[]} */
  const lists = [null]; // index = list id

  const get = (/** @type {number} */ id) => lists[id] || (lists[id] = []);
  // For other modules (collisions read sector and hotspot lists).
  engine.renderLists = { get: (/** @type {number} */ id) => (id > 0 ? lists[id] || null : null) };
  return {
    // ListCreate(n): a list of n zeros; returns its id
    ListCreate(n) {
      let id = 1;
      while (id < lists.length && lists[id]) id++;
      lists[id] = new Array(Math.max(0, n)).fill(0);
      return id;
    },
    ListDestroy(id) {
      if (id > 0) lists[id] = null;
      return 0;
    },
    ListLength: (id) => get(id).length,
    ListGetElem: (id, i) => get(id)[i] | 0,
    ListSetElem(id, i, v) {
      const l = get(id);
      if (i >= 0 && i < l.length) l[i] = v;
      return 0;
    },
    // Index of v (v != 0), else -1
    ListElemPosition: (id, v) => (v ? get(id).indexOf(v) : -1),
    // ListAdd(list, v, limit): put v in the first empty slot among the first
    // `limit` (0 = all); 0 if v is already there or the list is full.
    ListAdd(id, v, limit) {
      const l = get(id);
      const n = limit || l.length;
      for (let i = 0; i < n && i < l.length; i++) {
        if (l[i] === v) return 0;
        if (l[i] === 0) {
          l[i] = v;
          return 1;
        }
      }
      return 0;
    },
    // ListRemove(list, v, limit): the original ignores v and clears the
    // first non-empty slot. Kept as is; no G-Nome script calls it.
    ListRemove(id, _v, limit) {
      const l = get(id);
      const n = limit || l.length;
      for (let i = 0; i < n && i < l.length; i++) {
        if (l[i] !== 0) {
          l[i] = 0;
          return 1;
        }
      }
      return 0;
    },
    // ListIterate(list, script): queue script(element) for every slot,
    // empty ones included.
    ListIterate(id, script) {
      for (const v of get(id)) engine.runLater(script, [v]);
      return 0;
    },
  };
}
