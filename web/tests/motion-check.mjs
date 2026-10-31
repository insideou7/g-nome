// Check the motion and task externs (web/src/anim/motion.js, tasks.js) on
// stand-in objects shaped like the battlefield's WorldObject. Needs no game
// files. Usage: node web/tests/motion-check.mjs
import { motionExterns, leadDirection, approachAngle } from "../src/anim/motion.js";
import { taskExterns } from "../src/anim/tasks.js";

let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed++;
};
const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;

// Rotation about a unit axis, right-hand rule, degrees (battlefield math.js).
const DEG = Math.PI / 180;
const rotate = (v, k, deg) => {
  const a = deg * DEG, c = Math.cos(a), s = Math.sin(a);
  const d = (k[0] * v[0] + k[1] * v[1] + k[2] * v[2]) * (1 - c);
  const x = [k[1] * v[2] - k[2] * v[1], k[2] * v[0] - k[0] * v[2], k[0] * v[1] - k[1] * v[0]];
  return v.map((vi, i) => vi * c + x[i] * s + k[i] * d);
};
class Obj {
  constructor(id, pos = [0, 0, 0]) {
    this.id = id;
    this.pos = pos.slice();
    this.last = pos.slice();
    this.vel = [0, 0, 0];
    this.gravity = 0;
    this.speed = 0;
    this.basis = { right: [1, 0, 0], up: [0, 1, 0], at: [0, 0, 1] };
    this.spin = { pitch: 0, yaw: 0, roll: 0 };
  }
  turn(yaw, pitch = 0, roll = 0) {
    const b = this.basis;
    const steps = [[b.right.slice(), pitch], [b.up.slice(), yaw], [b.at.slice(), roll]].filter((s) => s[1]);
    const r = (v) => steps.reduce((v, [k, d]) => rotate(v, k, d), v);
    this.basis = { right: r(b.right), up: r(b.up), at: r(b.at) };
  }
  move(dt) {
    this.last = this.pos.slice();
    this.vel[1] += this.gravity * dt;
    this.pos = this.pos.map((p, i) => p + this.vel[i] * dt);
  }
  setPosition(p) {
    this.pos = p.slice();
    this.last = p.slice();
  }
}
const heading = (o) => Math.atan2(o.basis.at[0], o.basis.at[2]) / DEG;

const objects = new Map();
const props = new Map();
const engine = {
  world: { get: (id) => objects.get(id), groundFlag: 0 },
  render3d: {
    objects: {
      getProperty: (id, n) => props.get(id)?.[n] ?? 0,
      setProperty: (id, n, v) => {
        if (!props.has(id)) props.set(id, []);
        props.get(id)[n] = v;
      },
    },
  },
  animation: { state: new Map(), syncRate: () => {} },
};
const add = (id, pos) => {
  const o = new Obj(id, pos);
  objects.set(id, o);
  return o;
};
const x = motionExterns(engine);

// Speed
const a = add(1);
x.SetVelocityForward(1, 250);
check(near(a.speed, 2.5) && near(a.vel[2], 2.5) && x.GetVelocityForward(1) === 250, "SetVelocityForward 250 = 2.5 units/s along at");

// ApproachTargetSpeed: accelerate at 1 unit/s² towards 3 units/s.
x.SetVelocityForward(1, 0);
x.SetMaxAccel(1, 100);
engine.render3d.objects.setProperty(1, 12, 300);
engine.render3d.objects.setProperty(1, 35, 300);
engine.render3d.objects.setProperty(1, 95, 10);
let drain = 0;
for (let i = 0; i < 10; i++) drain = x.ApproachTargetSpeed(1, 100);
check(near(a.speed, 1) && Math.abs(props.get(1)[34] - 100) <= 1, `ApproachTargetSpeed after 1 s at 1 unit/s²: speed ${a.speed.toFixed(3)}, property 34 = ${props.get(1)[34]}`);
check(drain === -7, `while accelerating it returns -(95·|12|·7)/(35·10) = ${drain}`);
check(a.pos[1] === 0 && a.motion.xz && near(a.vel[2], 1), "a ground unit's velocity stays in the ground plane");
for (let i = 0; i < 30; i++) drain = x.ApproachTargetSpeed(1, 100);
check(near(a.speed, 3) && drain === -5, "it settles on the target speed, then returns the cruising drain (×5)");

// Turning: a yaw target is worked off by the spin step with limited
// acceleration and stops on the angle.
const b = add(2);
x.SetMaxAngularAccel(2, 0, 9000, 9000);
x.SetMaxAngularVelocity(2, 0, 9000, 9000);
x.SetTargetAxisAngle(2, 9000, 2);
b.motion.targetCos = 1; // brake on approach, as yawToward sets it
let steps = 0;
while (b.motion.targetYaw !== 0 && steps < 500) {
  x.UpdateOrient(2, 33);
  steps++;
}
check(steps < 500 && Math.abs(heading(b) - 90) < 2, `a 90° yaw target turns the object to ${heading(b).toFixed(1)}° in ${steps} steps`);
check(b.spin.yaw === 0, "and leaves it not spinning");

// MoveToPursue (yaw mode) aims at a target to the right.
const c = add(3, [0, 0, 0]);
add(4, [10, 0, 10]);
x.SetMaxAngularAccel(3, 0, 18000, 18000);
x.SetMaxAngularVelocity(3, 0, 18000, 18000);
for (let i = 0; i < 200; i++) {
  x.MoveToPursue(3, 4, 2, 0, 33);
  x.UpdateOrient(3, 33);
}
check(Math.abs(heading(c) - 45) < 2, `MoveToPursue turns towards the target (heading ${heading(c).toFixed(1)}°, want 45°)`);
check(x.DotProduct(3, 0, 4, 0) > 9990, "DotProduct facing the target ≈ 10000");

// MoveToEvade turns the other way.
const e = add(5, [0, 0, 0]);
x.SetMaxAngularAccel(5, 0, 18000, 18000);
x.SetMaxAngularVelocity(5, 0, 18000, 18000);
for (let i = 0; i < 200; i++) {
  x.MoveToEvade(5, 4, 2, 33);
  x.UpdateOrient(5, 33);
}
check(Math.abs(Math.abs(heading(e)) - 135) < 2, `MoveToEvade turns away (heading ${heading(e).toFixed(1)}°)`);

// Pitch mode turns now and returns the step.
const p = add(6, [0, 0, 0]);
add(7, [0, 10, 10]);
x.SetMaxAngularAccel(6, 0, 9000, 9000);
x.SetMaxAngularVelocity(6, 0, 9000, 9000);
let r = 0;
for (let i = 0; i < 200; i++) {
  r = x.MoveToPursue(6, 7, 1, 0, 33);
  x.UpdateOrient(6, 33);
}
const elev = Math.asin(p.basis.at[1]) / DEG;
check(Math.abs(elev - 45) < 3, `MoveToPursue in pitch mode climbs towards the target (${elev.toFixed(1)}°)`);

// Follow and circle give finite headings.
const f = add(8, [5, 0, 0]);
x.MoveToFollow(8, 4, 300, 2);
x.MoveInCircle(8, 4, 300, 2);
check(Number.isFinite(f.motion.targetYaw), "MoveToFollow / MoveInCircle set a yaw target");

// True lead: a target 10 units to the side moving at 1 unit/s along +z,
// chased at 2 units/s, is met where both arrive together.
const d = leadDirection([0, 0, 0], 2, [10, 0, 0], [0, 0, 1]);
const t = 10 / Math.sqrt(4 - 1);
check(near(d[0], 10 / (2 * t), 1e-2) && near(d[2], t / (2 * t), 1e-2), `lead direction (${d.map((v) => v.toFixed(3))})`);
check(leadDirection([0, 0, 0], 0.5, [10, 0, 0], [0, 0, 1]).join() === "0,0,1", "no meeting point within 10 s gives (0, 0, 1)");

// Pointing and direction
const g = add(9, [0, 0, 0]);
x.PointAtXZ(9, 4);
check(near(heading(g), 45) && x.DotProduct2D(9, 0, 4, 0) > 9990, "PointAtXZ faces the target");
x.SetObjectDirection(9, 100, 0, 0);
check(near(g.basis.at[0], 1) && near(g.basis.right[2], -1) && near(g.basis.up[1], 1), "SetObjectDirection(100, 0, 0): at +x, right -z, up +y");
check(x.ObjectDistance(9, 4) === Math.trunc(Math.hypot(10, 10) * 100), "ObjectDistance in script units");
x.ObjectMoveForwardUp(9, 200, 50);
check(near(g.pos[0], 2) && near(g.pos[1], 0.5) && g.last[0] === g.pos[0], "ObjectMoveForwardUp steps along at and up");
check(Math.abs(x.SphericalToRectangular(100, 0, 900, 0) - 100) <= 1 && x.SphericalToRectangular(100, 0, 0, 1) === 100, "SphericalToRectangular (tenths of a degree)");

// approachAngle from rest nudges into motion
const rate = { v: 0 };
const s = approachAngle(90, 1, 90, rate, 0.1, 180);
check(near(s, 0.9) && near(rate.v, 9), "the controller starts from rest with accel·dt");

// Tasks: a type 11 table of 10 rows × 9 columns, as script 412 copies 411.
const rows = 10, cols = 9;
const tbl = { header: new Int32Array(15), strides: [cols, 1], data: new Int32Array(rows * cols) };
tbl.header[10] = rows;
const tasksEngine = {
  render3d: engine.render3d,
  vm: { engine: { tables: new Map([[5000, tbl]]), bin: { type: () => 11 }, dynamic: new Map(), res: () => null } },
};
const k = taskExterns(tasksEngine);
const U = 100;
engine.render3d.objects.setProperty(U, 58, 5000);
engine.render3d.objects.setProperty(U, 60, 0);
k.setTaskProps(58, 60);
k.clearTaskList(U);
check(k.getTaskField(U, 3, 7) === -1 && k.getHighestPriority(U) === 0, "clearTaskList leaves rows inactive with next = -1");
const t1 = k.insertTask(U, 416, 5, 77, 0, 0, 0, 0, 0);
const t2 = k.insertTask(U, 417, 9, 88, 0, 0, 0, 0, 0);
check(t1 === 0 && t2 === 1, "insertTask fills free rows");
check(k.TaskSetHighestIndex(U) === 77 && props.get(U)[60] === 1, "TaskSetHighestIndex picks the priority 9 task and returns the old target");
check(k.existsGoal(U, 416, 77) === 0 && k.existsGoal(U, 416, 1) === -1, "existsGoal finds a task by script and target");
const t3 = k.setNextTask(U, 418, 1, 99, 0, 0, 0, 0, 0);
check(k.getTaskField(U, 1, 7) === t3 && k.doNextTask(U) === 88 && props.get(U)[60] === t3, "setNextTask chains after the current task; doNextTask follows it");
k.completeTask(U, t2);
check(k.getHighestPriority(U) === 5 && k.getLowestPriority(U) === 1, "completeTask drops a task from the priorities");
const above = k.activateGoal(U, t2, -2);
check(above > 5 && above === k.getHighestPriority(U), "activateGoal(-2) puts a task above the highest");
check(k.changeTaskPriority(U, t1, -10) === 0, "priorities don't go below 0");

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
