// RENDER.R32's task and goal externs (0x1001ac50-0x1001c37e): each unit's
// AI keeps a prioritised list of tasks. Spec: docs/formats/animation.md.
//
// setTaskProps(listProp, currentProp) names two object properties: the
// first holds a copy of a type 11 table (script 412 copies table 411: 10
// rows of 9 ints), the second the index of the current task. Each row:
//   0 task (the script that runs it)   1 active       2 a
//   3 target (doNextTask returns it)   4 b   5 c   6 d
//   7 next task index, -1 = none       8 priority
import { table } from "../builtins.js";

const COLS = 9;
const F = { TASK: 0, ACTIVE: 1, A: 2, TARGET: 3, B: 4, C: 5, D: 6, NEXT: 7, PRIORITY: 8 };

export function taskExterns(engine) {
  let listProp = 0; // DAT_10041210
  let curProp = 0; // DAT_10041214
  const props = () => engine.render3d?.objects;
  const getProp = (obj, n) => props()?.getProperty(obj, n) ?? 0;
  const setProp = (obj, n, v) => props()?.setProperty(obj, n, v);

  // The object's task table as { rows, get(r, c), set(r, c, v) }, or null.
  const tasks = (obj) => {
    const id = getProp(obj, listProp);
    const t = id ? table(engine.vm, id) : null;
    if (!t) return null;
    const rows = t.header[10];
    const at = (r, c) => r * t.strides[0] + c * (t.strides[1] ?? 1);
    return {
      rows,
      get: (r, c) => (r >= 0 && r < rows ? t.data[at(r, c)] : 0),
      set: (r, c, v) => {
        if (r >= 0 && r < rows) t.data[at(r, c)] = v;
      },
    };
  };
  const clearRow = (l, r) => {
    for (let c = 0; c < COLS; c++) l.set(r, c, 0);
    l.set(r, F.NEXT, -1);
  };
  const fill = (l, r, task, priority, target, b, c, d, a, next) => {
    l.set(r, F.TASK, task);
    l.set(r, F.PRIORITY, priority);
    l.set(r, F.TARGET, target);
    l.set(r, F.B, b);
    l.set(r, F.C, c);
    l.set(r, F.D, d);
    l.set(r, F.A, a);
    l.set(r, F.ACTIVE, 1);
    l.set(r, F.NEXT, next || -1);
  };
  const freeRow = (l) => {
    for (let r = 0; r < l.rows; r++) if (!l.get(r, F.ACTIVE)) return r;
    return -1;
  };
  // 0x1001be93 / 0x1001bf13: highest / lowest priority among active tasks
  const highest = (l) => {
    let p = 0;
    for (let r = 0; r < l.rows; r++) if (l.get(r, F.ACTIVE) && l.get(r, F.PRIORITY) > p) p = l.get(r, F.PRIORITY);
    return p;
  };
  const lowest = (l) => {
    let p = l.get(0, F.PRIORITY);
    for (let r = 0; r < l.rows; r++) if (l.get(r, F.ACTIVE) && l.get(r, F.PRIORITY) < p) p = l.get(r, F.PRIORITY);
    return p;
  };

  return {
    setTaskProps(list, current) {
      listProp = list;
      curProp = current;
      return 0;
    },
    getTaskField: (obj, r, c) => tasks(obj)?.get(r, c) ?? 0,
    setTaskField(obj, r, c, v) {
      const l = tasks(obj);
      if (!l) return 0;
      l.set(r, c, v);
      return l.get(r, c);
    },
    clearTask(obj, r) {
      const l = tasks(obj);
      if (l && r >= 0 && r < l.rows) clearRow(l, r);
      return 0;
    },
    clearTaskList(obj) {
      const l = tasks(obj);
      if (l) for (let r = 0; r < l.rows; r++) clearRow(l, r);
      return 0;
    },
    // Move on to the current task's `next` (if it is active and has one);
    // returns the target of the task that was current.
    doNextTask(obj) {
      const l = tasks(obj);
      if (!l) return 0;
      const cur = getProp(obj, curProp);
      const next = l.get(cur, F.NEXT);
      if (l.get(cur, F.ACTIVE) && next >= 0) setProp(obj, curProp, next);
      return l.get(cur, F.TARGET);
    },
    // Overwrite the current task; returns its index.
    setCurrentTask(obj, task, priority, target, b, c, d, a, next) {
      const l = tasks(obj);
      if (!l) return 0;
      const cur = getProp(obj, curProp);
      if (cur !== -1) fill(l, cur, task, priority, target, b, c, d, a, next);
      return cur;
    },
    // Put a task in a free row and chain it after the current one.
    setNextTask(obj, task, priority, target, b, c, d, a, next) {
      const l = tasks(obj);
      if (!l) return 0;
      const r = freeRow(l);
      if (r >= 0) {
        fill(l, r, task, priority, target, b, c, d, a, next);
        l.set(getProp(obj, curProp), F.NEXT, r);
      }
      return r;
    },
    // Put a task in a free row; returns its index or -1.
    insertTask(obj, task, priority, target, b, c, d, a, next) {
      const l = tasks(obj);
      if (!l) return 0;
      const r = freeRow(l);
      if (r >= 0) fill(l, r, task, priority, target, b, c, d, a, next);
      return r;
    },
    // Make the active task with the highest priority current (ties keep the
    // current one). Returns the old task's target if it changed, else 0.
    TaskSetHighestIndex(obj) {
      const l = tasks(obj);
      if (!l) return 0;
      const cur = getProp(obj, curProp);
      let best = cur;
      let p = cur > -1 && l.get(cur, F.ACTIVE) ? l.get(cur, F.PRIORITY) : 0;
      for (let r = 0; r < l.rows; r++) {
        if (l.get(r, F.ACTIVE) && l.get(r, F.PRIORITY) > p) {
          best = r;
          p = l.get(r, F.PRIORITY);
        }
      }
      if (p === 0) return 0;
      const out = best !== cur ? l.get(cur, F.TARGET) : 0;
      setProp(obj, curProp, best);
      return out;
    },
    completeTask(obj, r) {
      tasks(obj)?.set(r, F.ACTIVE, 0);
      return 0;
    },
    // Add delta to a task's priority (not below 0); returns the new value.
    changeTaskPriority(obj, r, delta) {
      const l = tasks(obj);
      if (!l) return 0;
      const p = Math.max(0, l.get(r, F.PRIORITY) + delta);
      l.set(r, F.PRIORITY, p);
      return p;
    },
    // Index of the task (active or not) with this task script and target, or -1.
    existsGoal(obj, task, target) {
      const l = tasks(obj);
      if (!l) return getProp(obj, listProp) ? -1 : 0;
      for (let r = 0; r < l.rows; r++) if (l.get(r, F.TASK) === task && l.get(r, F.TARGET) === target) return r;
      return -1;
    },
    // Re-activate task r with priority p: -4 lowest, -3 highest, -2 above
    // the highest, -1 leave it inactive, else keep its own priority.
    activateGoal(obj, r, p) {
      const l = tasks(obj);
      if (!l || r === -1) return 0;
      l.set(r, F.ACTIVE, 1);
      if (p === -1) return 0;
      p = p === -4 ? lowest(l) : p === -3 ? highest(l) : p === -2 ? highest(l) + 1 : l.get(r, F.PRIORITY);
      p = Math.max(0, p);
      l.set(r, F.PRIORITY, p);
      return p;
    },
    // Give every task priority p (-3 highest, -4 lowest, other negatives 0).
    equalizeGoalPriorities(obj, p) {
      const l = tasks(obj);
      if (!l) return 0;
      p = p === -3 ? highest(l) : p === -4 ? lowest(l) : Math.max(0, p);
      for (let r = 0; r < l.rows; r++) l.set(r, F.PRIORITY, p);
      return p;
    },
    getHighestPriority: (obj) => {
      const l = tasks(obj);
      return l ? highest(l) : -1;
    },
    getLowestPriority: (obj) => {
      const l = tasks(obj);
      return l ? lowest(l) : -1;
    },
  };
}
