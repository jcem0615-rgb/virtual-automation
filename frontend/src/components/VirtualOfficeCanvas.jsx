// Phaser owns this canvas. React mounts it once and never re-renders it —
// data goes in through scene.syncAgents(agents). To add a visual state,
// extend applyStatus().
//
// Each agent is a little articulated figure that walks the floor, sits at its
// desk to work, and stands up when it needs you. The behaviour is driven only
// by `status`, so what you see is always what the database says.
import { useEffect, useRef } from 'react';
import Phaser from 'phaser';

const WIDTH = 960;
const HEIGHT = 640;

// avatar_sprite_key only selects a colour; the figures are drawn from primitives.
const SPRITE_COLOURS = {
  staff_amber: 0xf59e0b,
  staff_rose: 0xf43f5e,
  staff_sky: 0x38bdf8,
  staff_lime: 0x84cc16,
  staff_violet: 0xa78bfa,
  staff_slate: 0x94a3b8,
  staff_teal: 0x2dd4bf,
  staff_red: 0xef4444,
  staff_orange: 0xfb923c,
  staff_default: 0x64748b,
};

const SKIN_TONES = [0xf2d2b6, 0xe0b38c, 0xc68963, 0x9c6240];
const TROUSERS = 0x334155;

const STATUS_STYLE = {
  IDLE: { ring: 0x64748b, label: 'Idle', text: '#94a3b8' },
  WORKING: { ring: 0x22d3ee, label: 'Working', text: '#67e8f9' },
  AWAITING_APPROVAL: { ring: 0xfbbf24, label: 'Needs you', text: '#fcd34d' },
  PAUSED: { ring: 0xef4444, label: 'Paused', text: '#fca5a5' },
};

const WALK_SPEED = 54;          // px per second
const ARRIVE_RADIUS = 3;

// The gaps between desk blocks. Anyone crossing the room walks an aisle
// instead of straight over someone's desk.
const AISLE_ROWS = [252, 432];
const AISLE_COLS = [315, 645];
const nearest = (values, v) =>
  values.reduce((best, c) => (Math.abs(c - v) < Math.abs(best - v) ? c : best), values[0]);

const rand = (min, max) => min + Math.random() * (max - min);

class OfficeScene extends Phaser.Scene {
  constructor() {
    super('office');
    this.people = new Map();   // agent id -> person
    this.pending = [];         // agents handed over before create() ran
    this.onSelect = null;
    this.landmarks = [];
  }

  create() {
    this.reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.drawFloor();
    this.ready = true;
    if (this.pending.length) this.syncAgents(this.pending);
    this.pending = [];
  }

  // ------------------------------------------------------------ the room
  drawFloor() {
    const g = this.add.graphics();
    g.fillStyle(0x0f172a, 1).fillRect(0, 0, WIDTH, HEIGHT);

    g.lineStyle(1, 0x1a2538, 1);
    for (let x = 0; x <= WIDTH; x += 40) g.lineBetween(x, 0, x, HEIGHT);
    for (let y = 0; y <= HEIGHT; y += 40) g.lineBetween(0, y, WIDTH, y);

    g.lineStyle(3, 0x334155, 1).strokeRect(18, 58, WIDTH - 36, HEIGHT - 76);
    g.fillStyle(0x1e293b, 1).fillRoundedRect(18, 14, WIDTH - 36, 34, 8);
    this.add.text(34, 22, 'VIRTUAL OFFICE — FLOOR 1', {
      fontFamily: 'ui-monospace, monospace', fontSize: '14px', color: '#64748b',
    });

    // Places worth walking to. Staff with nothing on drift between them.
    this.landmarks = [
      this.drawWaterCooler(315, 250),
      this.drawPrinter(645, 250),
      this.drawPlant(315, 440),
      this.drawCoffee(645, 440),
    ];
  }

  drawWaterCooler(x, y) {
    const g = this.add.graphics();
    g.fillStyle(0x1e293b, 1).fillRoundedRect(x - 11, y - 10, 22, 30, 3);
    g.fillStyle(0x38bdf8, 0.75).fillRoundedRect(x - 8, y - 22, 16, 16, 4);
    g.fillStyle(0x0f172a, 1).fillRect(x - 4, y + 2, 8, 4);
    this.labelProp(x, y + 28, 'water');
    return this.standingPoint(x, y + 44, 'water');
  }

  drawPrinter(x, y) {
    const g = this.add.graphics();
    g.fillStyle(0x1e293b, 1).fillRoundedRect(x - 18, y - 10, 36, 22, 3);
    g.fillStyle(0x475569, 1).fillRect(x - 12, y - 16, 24, 7);
    g.fillStyle(0x94a3b8, 1).fillRect(x - 9, y + 12, 18, 5);
    this.labelProp(x, y + 24, 'printer');
    return this.standingPoint(x, y + 40, 'printer');
  }

  drawPlant(x, y) {
    const g = this.add.graphics();
    g.fillStyle(0x7c3f20, 1).fillRoundedRect(x - 9, y + 4, 18, 14, 2);
    g.fillStyle(0x16a34a, 1);
    g.fillCircle(x, y - 6, 11);
    g.fillCircle(x - 9, y + 1, 8);
    g.fillCircle(x + 9, y + 1, 8);
    return this.standingPoint(x + 26, y + 30, 'plant');
  }

  drawCoffee(x, y) {
    const g = this.add.graphics();
    g.fillStyle(0x1e293b, 1).fillRoundedRect(x - 20, y - 4, 40, 16, 3);
    g.fillStyle(0x92400e, 1).fillRoundedRect(x - 12, y - 16, 12, 13, 2);
    g.fillStyle(0xf8fafc, 1).fillCircle(x + 8, y - 6, 4);
    this.labelProp(x, y + 18, 'coffee');
    return this.standingPoint(x, y + 36, 'coffee');
  }

  /**
   * A place to stand, with a few separate spots. People claim one, so a
   * landmark gathers a small group instead of stacking everyone on one pixel.
   */
  standingPoint(x, y, name) {
    return {
      name,
      // Spaced wide enough that two names never sit on top of each other.
      slots: [
        { x: x - 44, y, takenBy: null },
        { x: x + 44, y, takenBy: null },
        { x, y: y + 30, takenBy: null },
      ],
    };
  }

  labelProp(x, y, text) {
    this.add.text(x, y, text, {
      fontFamily: 'ui-monospace, monospace', fontSize: '9px', color: '#475569',
    }).setOrigin(0.5);
  }

  drawDesk(x, y) {
    const g = this.add.graphics();
    g.fillStyle(0x1e293b, 1).fillRoundedRect(x - 66, y - 16, 132, 34, 5);
    g.fillStyle(0x0b1220, 1).fillRoundedRect(x - 22, y - 34, 44, 22, 3);  // monitor
    g.fillStyle(0x1d4ed8, 0.35).fillRect(x - 18, y - 30, 36, 14);         // screen
    g.fillStyle(0x334155, 1).fillRect(x - 5, y - 12, 10, 4);              // stand
    g.fillStyle(0x475569, 1).fillRoundedRect(x - 16, y + 2, 32, 7, 2);    // keyboard
    g.fillStyle(0x334155, 1).fillRoundedRect(x - 26, y + 46, 30, 10, 4);  // chair back
    return g;
  }

  // --------------------------------------------------------- sync + people
  /** Called by React whenever the agent list changes. */
  syncAgents(agents) {
    if (!this.ready) { this.pending = agents; return; }

    const seen = new Set();
    for (const agent of agents) {
      seen.add(agent.id);
      const person = this.people.get(agent.id) ?? this.createPerson(agent);
      const changed = person.data.status !== agent.status;
      person.data = agent;
      person.label.setText(agent.name);
      if (changed || person.task === null) this.applyStatus(person, agent);
    }
    for (const [id, person] of this.people) {
      if (!seen.has(id)) { this.destroyPerson(person); this.people.delete(id); }
    }
  }

  createPerson(agent) {
    const colour = SPRITE_COLOURS[agent.avatar_sprite_key] ?? SPRITE_COLOURS.staff_default;
    const skin = SKIN_TONES[Math.abs(hash(agent.id)) % SKIN_TONES.length];

    const desk = { x: agent.desk_x, y: agent.desk_y };
    this.drawDesk(desk.x, desk.y);
    this.add.text(desk.x, desk.y + 62, agent.department.toUpperCase(), {
      fontFamily: 'ui-monospace, monospace', fontSize: '10px', color: '#475569',
    }).setOrigin(0.5);

    // The figure: shadow, legs, torso, arms, head. Parts rotate at the joint,
    // which is why each limb has its origin at the top.
    const body = this.add.container(desk.x, desk.y + 40);
    const shadow = this.add.ellipse(0, 20, 26, 8, 0x000000, 0.28);
    const legL = this.add.rectangle(-4, 4, 5, 15, TROUSERS).setOrigin(0.5, 0);
    const legR = this.add.rectangle(4, 4, 5, 15, TROUSERS).setOrigin(0.5, 0);
    const torso = this.add.rectangle(0, -12, 17, 18, colour).setOrigin(0.5, 0);
    const armL = this.add.rectangle(-10, -10, 4, 14, colour).setOrigin(0.5, 0);
    const armR = this.add.rectangle(10, -10, 4, 14, colour).setOrigin(0.5, 0);
    const head = this.add.circle(0, -20, 7, skin);
    const hair = this.add.rectangle(0, -25, 14, 6, 0x1f2937).setOrigin(0.5, 0.5);
    const marker = this.add.circle(0, -36, 5, 0x64748b);

    body.add([shadow, legL, legR, armL, armR, torso, head, hair, marker]);
    body.setSize(40, 56);
    body.setScale(1.15);
    body.setInteractive({ useHandCursor: true });
    body.on('pointerdown', () => this.onSelect?.(this.people.get(agent.id)?.data ?? agent));
    body.on('pointerover', () => body.setScale(Math.sign(body.scaleX) * 1.3, 1.3));
    body.on('pointerout', () => body.setScale(Math.sign(body.scaleX) * 1.15, 1.15));

    const label = this.add.text(desk.x, desk.y + 70, agent.name, {
      fontFamily: 'ui-sans-serif, system-ui', fontSize: '11px', color: '#cbd5e1',
    }).setOrigin(0.5);

    const statusText = this.add.text(desk.x, desk.y + 26, '', {
      fontFamily: 'ui-monospace, monospace', fontSize: '10px', color: '#94a3b8',
    }).setOrigin(0.5);

    const person = {
      id: agent.id, data: agent, body, label, statusText,
      parts: { legL, legR, armL, armR, torso, head, hair, marker, shadow },
      desk,
      seat: { x: desk.x, y: desk.y + 40 },
      standSpot: { x: desk.x + 54, y: desk.y + 46 },
      pos: { x: desk.x, y: desk.y + 40 },
      target: null,
      path: [],            // remaining waypoints of the current route
      claim: null,         // the standing slot this person is holding
      task: null,          // 'SIT' | 'STAND' | 'WANDER'
      phase: rand(0, 10),  // keeps the crowd out of lockstep
      stride: 0,
      facing: 1,
      restUntil: 0,
    };
    this.people.set(agent.id, person);
    return person;
  }

  destroyPerson(person) {
    person.body.destroy();
    person.label.destroy();
    person.statusText.destroy();
  }

  /**
   * One place decides what a status looks like — and, now, what the person
   * does about it. Everything else is animation.
   */
  applyStatus(person, agent) {
    const style = STATUS_STYLE[agent.status] ?? STATUS_STYLE.IDLE;
    if (agent.status !== 'IDLE') this.releaseSlot(person);
    person.parts.marker.setFillStyle(style.ring);
    person.statusText.setText(agent.status === 'IDLE' ? '' : style.label).setColor(style.text);
    person.body.setAlpha(agent.status === 'PAUSED' ? 0.45 : 1);
    person.label.setAlpha(agent.status === 'PAUSED' ? 0.45 : 1);

    person.path = [];
    if (agent.status === 'WORKING') {
      person.task = 'SIT';
      this.routeTo(person, { ...person.seat });
    } else if (agent.status === 'AWAITING_APPROVAL') {
      person.task = 'STAND';
      this.routeTo(person, { ...person.standSpot });
    } else if (agent.status === 'PAUSED') {
      person.task = 'STOPPED';
      person.target = null;
    } else {
      person.task = 'WANDER';
      person.restUntil = 0;
    }
    person.target = person.path.shift() ?? null;

    if (this.reduceMotion) {
      const stop = person.path.at(-1) ?? person.target;
      if (stop) person.pos = { ...stop };
      person.path = [];
      person.target = null;
    }
  }

  /**
   * Lay out a route to `destination`: step into the nearest aisle, follow it
   * across, then step out. Short hops go straight there.
   */
  routeTo(person, destination) {
    const from = person.pos;
    person.path = [];
    const far = Math.hypot(destination.x - from.x, destination.y - from.y) > 150;
    if (far) {
      const aisleY = nearest(AISLE_ROWS, (from.y + destination.y) / 2);
      const aisleX = nearest(AISLE_COLS, (from.x + destination.x) / 2);
      // Out to the aisle, along it, then in to the destination.
      person.path.push({ x: from.x, y: aisleY });
      if (Math.abs(destination.x - from.x) > 200) {
        person.path.push({ x: aisleX, y: aisleY });
      }
      person.path.push({ x: destination.x, y: aisleY });
    }
    person.path.push(destination);
  }

  releaseSlot(person) {
    if (person.claim) {
      person.claim.takenBy = null;
      person.claim = null;
    }
  }

  /** Where an idle person drifts to next: their own desk, or a free spot. */
  pickWanderTarget(person) {
    this.releaseSlot(person);

    // Roughly half the time they potter about their own desk.
    if (Math.random() < 0.5) {
      return {
        x: Phaser.Math.Clamp(person.desk.x + rand(-46, 46), 46, WIDTH - 46),
        y: Phaser.Math.Clamp(person.desk.y + rand(34, 54), 96, HEIGHT - 46),
      };
    }

    const free = [];
    for (const landmark of this.landmarks) {
      for (const slot of landmark.slots) if (!slot.takenBy) free.push(slot);
    }
    if (!free.length) return { x: person.seat.x, y: person.seat.y };

    const slot = free[Math.floor(rand(0, free.length))];
    slot.takenBy = person.id;
    person.claim = slot;
    return { x: slot.x, y: slot.y };
  }

  update(time, delta) {
    const dt = Math.min(delta, 50) / 1000;
    for (const person of this.people.values()) {
      this.step(person, time, dt);
    }
    this.separate();
  }

  /**
   * Nobody stands inside anyone else. Only idle figures are nudged — a seated
   * agent belongs at its own desk and should not be pushed off it.
   */
  separate() {
    const movable = [...this.people.values()].filter(
      (p) => p.task === 'WANDER' && !p.target);
    for (let i = 0; i < movable.length; i += 1) {
      for (let j = i + 1; j < movable.length; j += 1) {
        const a = movable[i];
        const b = movable[j];
        const dx = b.pos.x - a.pos.x;
        const dy = b.pos.y - a.pos.y;
        const distance = Math.hypot(dx, dy);
        if (distance > 48 || distance === 0) continue;
        const push = (48 - distance) / 2;
        const nx = dx / distance;
        const ny = dy / distance;
        a.pos.x -= nx * push; a.pos.y -= ny * push;
        b.pos.x += nx * push; b.pos.y += ny * push;
      }
    }
  }

  step(person, time, dt) {
    const { parts } = person;
    person.phase += dt;

    if (!person.target && person.path.length) person.target = person.path.shift();

    if (person.task === 'WANDER' && !person.target && time > person.restUntil) {
      this.routeTo(person, this.pickWanderTarget(person));
      person.target = person.path.shift() ?? null;
    }

    let walking = false;
    if (person.target && !this.reduceMotion) {
      const dx = person.target.x - person.pos.x;
      const dy = person.target.y - person.pos.y;
      const distance = Math.hypot(dx, dy);
      if (distance <= ARRIVE_RADIUS) {
        person.pos = { ...person.target };
        person.target = null;
        // After a stroll, stand about for a few seconds before moving again.
        if (person.task === 'WANDER' && !person.path.length) {
          person.restUntil = time + rand(2600, 7000);
        }
      } else {
        const stepLength = Math.min(WALK_SPEED * dt, distance);
        person.pos.x += (dx / distance) * stepLength;
        person.pos.y += (dy / distance) * stepLength;
        person.stride += stepLength;
        if (Math.abs(dx) > 1.5) person.facing = dx > 0 ? 1 : -1;
        walking = true;
      }
    }

    const seated = !walking && person.task === 'SIT';
    const stopped = person.task === 'STOPPED';

    // Position: a seated figure sits a little lower and behind the desk edge.
    person.body.x = person.pos.x;
    person.body.y = person.pos.y + (seated ? -4 : 0);
    person.body.scaleX = person.facing * 1.15;
    person.label.setPosition(person.pos.x, person.pos.y + 30);
    person.statusText.setPosition(person.pos.x, person.pos.y - 46);

    if (this.reduceMotion || stopped) {
      this.poseStill(person, stopped);
      return;
    }

    if (walking) {
      // Legs and arms swing opposite each other; the body bobs on each step.
      const swing = Math.sin(person.stride * 0.26) * 26;
      parts.legL.setAngle(swing);
      parts.legR.setAngle(-swing);
      parts.armL.setAngle(-swing * 0.8);
      parts.armR.setAngle(swing * 0.8);
      parts.torso.y = -12 + Math.abs(Math.sin(person.stride * 0.26)) * -1.2;
      parts.head.y = -20 + Math.abs(Math.sin(person.stride * 0.26)) * -1.2;
      parts.hair.y = parts.head.y - 5;
      parts.shadow.setScale(1, 1);
    } else if (seated) {
      // Sitting: thighs forward, hands on the keyboard, small typing motion.
      parts.legL.setAngle(74);
      parts.legR.setAngle(74);
      const type = Math.sin(person.phase * 9) * 7;
      parts.armL.setAngle(58 + type);
      parts.armR.setAngle(58 - type);
      parts.torso.y = -10;
      parts.head.y = -18 + Math.sin(person.phase * 2.2) * 0.6;
      parts.hair.y = parts.head.y - 5;
      parts.shadow.setScale(0.8, 0.8);
    } else {
      // Standing: breathing, with a wave while a draft is waiting on you.
      const breathe = Math.sin(person.phase * 1.7) * 1.1;
      parts.legL.setAngle(0);
      parts.legR.setAngle(0);
      parts.torso.y = -12 + breathe * 0.4;
      parts.head.y = -20 + breathe * 0.4;
      parts.hair.y = parts.head.y - 5;
      parts.shadow.setScale(1, 1);
      if (person.data.status === 'AWAITING_APPROVAL') {
        parts.armL.setAngle(-150 + Math.sin(person.phase * 6) * 16);
        parts.armR.setAngle(breathe * 2);
      } else {
        parts.armL.setAngle(breathe * 2);
        parts.armR.setAngle(-breathe * 2);
      }
    }

    // The status marker pulses for anything that wants your attention.
    const status = person.data.status;
    const pulse = status === 'AWAITING_APPROVAL' ? 1 + Math.abs(Math.sin(person.phase * 4)) * 0.5
      : status === 'WORKING' ? 1 + Math.abs(Math.sin(person.phase * 2)) * 0.2 : 1;
    parts.marker.setScale(pulse);
    parts.marker.y = (seated ? -32 : -36) + (status === 'AWAITING_APPROVAL' ? -2 : 0);
  }

  /** Paused (or reduced-motion): a still figure, no idling, no typing. */
  poseStill(person, stopped) {
    const { parts } = person;
    const seated = person.task === 'SIT';
    parts.legL.setAngle(seated ? 74 : 0);
    parts.legR.setAngle(seated ? 74 : 0);
    parts.armL.setAngle(stopped ? 6 : seated ? 58 : 0);
    parts.armR.setAngle(stopped ? -6 : seated ? 58 : 0);
    parts.torso.y = -12;
    parts.head.y = stopped ? -18 : -20;     // head down when switched off
    parts.hair.y = parts.head.y - 5;
    parts.marker.setScale(1);
    parts.marker.y = -36;
  }
}

function hash(value) {
  let out = 0;
  for (let i = 0; i < value.length; i += 1) out = (out * 31 + value.charCodeAt(i)) | 0;
  return out;
}

export default function VirtualOfficeCanvas({ agents, onSelectAgent }) {
  const hostRef = useRef(null);
  const gameRef = useRef(null);
  const sceneRef = useRef(null);
  const selectRef = useRef(onSelectAgent);

  selectRef.current = onSelectAgent;

  // Mount Phaser exactly once.
  useEffect(() => {
    const scene = new OfficeScene();
    scene.onSelect = (agent) => selectRef.current?.(agent);
    sceneRef.current = scene;
    // A handle on the scene while developing; stripped from production builds.
    if (import.meta.env.DEV) window.__voScene = scene;

    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: hostRef.current,
      width: WIDTH,
      height: HEIGHT,
      backgroundColor: '#0f172a',
      scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_HORIZONTALLY },
      scene,
    });
    gameRef.current = game;

    return () => { game.destroy(true); gameRef.current = null; sceneRef.current = null; };
  }, []);

  // Push data in; never re-render the canvas through React.
  useEffect(() => {
    sceneRef.current?.syncAgents(agents ?? []);
  }, [agents]);

  return <div ref={hostRef} className="w-full overflow-hidden rounded-xl border border-slate-800" />;
}
