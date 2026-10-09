// Phaser owns this canvas. React mounts it once and never re-renders it —
// data goes in through scene.syncAgents(agents). To add a visual state,
// extend applyStatus().
//
// Each agent is a little articulated figure. applyStatus() decides what a
// status makes it do: sit and work at its own desk, stand beside the desk when
// a draft needs you, take a break in the pantry or the lobby when it is idle,
// or stop dead when it is paused. Behaviour follows `status` only, so what you
// see is always what the database says.
import { useEffect, useRef } from 'react';
import Phaser from 'phaser';

const WIDTH = 960;
const HEIGHT = 700;

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
  IDLE: { ring: 0x64748b, label: '', text: '#94a3b8' },
  WORKING: { ring: 0x22d3ee, label: 'Working', text: '#67e8f9' },
  AWAITING_APPROVAL: { ring: 0xfbbf24, label: 'Needs you', text: '#fcd34d' },
  PAUSED: { ring: 0xef4444, label: 'Paused', text: '#fca5a5' },
};

const WALK_SPEED = 54;          // px per second
const ARRIVE_RADIUS = 3;

// The gaps between desk blocks. Anyone crossing the room walks an aisle
// instead of straight over someone's desk.
const AISLE_ROWS = [240, 375, 525];
const AISLE_COLS = [320, 640];

const DEPTH = { floor: 0, furniture: 1, people: 5, labels: 12 };

const rand = (min, max) => min + Math.random() * (max - min);
const nearest = (values, v) =>
  values.reduce((best, c) => (Math.abs(c - v) < Math.abs(best - v) ? c : best), values[0]);

class OfficeScene extends Phaser.Scene {
  constructor() {
    super('office');
    this.people = new Map();   // agent id -> person
    this.pending = [];         // agents handed over before create() ran
    this.onSelect = null;
    this.spots = [];           // claimable places to stand or sit
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
    const g = this.add.graphics().setDepth(DEPTH.floor);
    g.fillStyle(0x0f172a, 1).fillRect(0, 0, WIDTH, HEIGHT);

    g.lineStyle(1, 0x1a2538, 1);
    for (let x = 0; x <= WIDTH; x += 40) g.lineBetween(x, 0, x, HEIGHT);
    for (let y = 0; y <= HEIGHT; y += 40) g.lineBetween(0, y, WIDTH, y);

    g.lineStyle(3, 0x334155, 1).strokeRect(18, 58, WIDTH - 36, HEIGHT - 76);
    g.fillStyle(0x1e293b, 1).fillRoundedRect(18, 14, WIDTH - 36, 34, 8);
    this.add.text(34, 22, 'VIRTUAL OFFICE — FLOOR 1', {
      fontFamily: 'ui-monospace, monospace', fontSize: '14px', color: '#64748b',
    }).setDepth(DEPTH.labels);

    this.drawLobby(40, 74, 400, 132);
    this.drawPantry(520, 74, 400, 132);
    this.drawWaterCooler(320, 430);
    this.drawPrinter(640, 430);
  }

  zone(x, y, w, h, title) {
    const g = this.add.graphics().setDepth(DEPTH.floor);
    g.fillStyle(0x121d31, 1).fillRoundedRect(x, y, w, h, 10);
    g.lineStyle(1, 0x24334f, 1).strokeRoundedRect(x, y, w, h, 10);
    this.add.text(x + 12, y + 9, title, {
      fontFamily: 'ui-monospace, monospace', fontSize: '10px', color: '#5a6f94',
    }).setDepth(DEPTH.labels);
    return this.add.graphics().setDepth(DEPTH.furniture);
  }

  /** Reception and a sofa. Somewhere to wait, and somewhere to sit down. */
  drawLobby(x, y, w, h) {
    const g = this.zone(x, y, w, h, 'LOBBY');
    const midY = y + h / 2 + 6;

    // Reception counter along the right of the zone.
    g.fillStyle(0x2a3a52, 1).fillRoundedRect(x + w - 74, y + 26, 58, 76, 6);
    g.fillStyle(0x3d577a, 1).fillRoundedRect(x + w - 68, y + 32, 46, 10, 3);

    // Sofa: back, seat, two arms.
    const sofaX = x + 66;
    g.fillStyle(0x2f4460, 1).fillRoundedRect(sofaX - 52, midY - 30, 104, 16, 6);
    g.fillStyle(0x3d577a, 1).fillRoundedRect(sofaX - 56, midY - 16, 112, 22, 6);
    g.lineStyle(1, 0x2f4460, 1).lineBetween(sofaX, midY - 14, sofaX, midY + 4);
    g.fillStyle(0x2f4460, 1).fillRoundedRect(sofaX - 60, midY - 22, 10, 26, 4);
    g.fillStyle(0x2f4460, 1).fillRoundedRect(sofaX + 50, midY - 22, 10, 26, 4);

    // Coffee table and a plant.
    g.fillStyle(0x2a3a52, 1).fillRoundedRect(sofaX + 86, midY - 8, 56, 20, 5);
    g.fillStyle(0x7c3f20, 1).fillRoundedRect(x + w - 112, y + 78, 16, 14, 2);
    g.fillStyle(0x16a34a, 1);
    g.fillCircle(x + w - 104, y + 70, 11);
    g.fillCircle(x + w - 114, y + 76, 7);

    this.spots.push(
      { x: sofaX - 26, y: midY - 4, sit: true, takenBy: null },
      { x: sofaX + 26, y: midY - 4, sit: true, takenBy: null },
      { x: x + w - 46, y: y + h - 16, sit: false, takenBy: null },
    );
  }

  /** Counter, fridge and a table to eat at. */
  drawPantry(x, y, w, h) {
    const g = this.zone(x, y, w, h, 'PANTRY');
    const midY = y + h / 2 + 10;

    // Counter with a kettle and mugs.
    g.fillStyle(0x2a3a52, 1).fillRoundedRect(x + 16, y + 24, 150, 20, 5);
    g.fillStyle(0x92400e, 1).fillRoundedRect(x + 28, y + 12, 14, 14, 3);
    g.fillStyle(0xf8fafc, 1).fillCircle(x + 60, y + 20, 4);
    g.fillStyle(0xf8fafc, 1).fillCircle(x + 74, y + 20, 4);

    // Fridge.
    g.fillStyle(0x27384f, 1).fillRoundedRect(x + w - 60, y + 16, 40, 66, 5);
    g.fillStyle(0x94a3b8, 1).fillRect(x + w - 30, y + 36, 4, 14);

    // Table with two stools.
    const tableX = x + w / 2 - 20;
    g.fillStyle(0x2a3a52, 1).fillRoundedRect(tableX - 44, midY - 14, 88, 26, 6);
    g.fillStyle(0x3d577a, 1).fillCircle(tableX - 66, midY + 2, 10);
    g.fillStyle(0x3d577a, 1).fillCircle(tableX + 66, midY + 2, 10);

    this.spots.push(
      { x: tableX - 66, y: midY + 6, sit: true, takenBy: null },
      { x: tableX + 66, y: midY + 6, sit: true, takenBy: null },
      { x: x + 70, y: y + h - 18, sit: false, takenBy: null },
    );
  }

  drawWaterCooler(x, y) {
    const g = this.add.graphics().setDepth(DEPTH.furniture);
    g.fillStyle(0x1e293b, 1).fillRoundedRect(x - 11, y - 10, 22, 30, 3);
    g.fillStyle(0x38bdf8, 0.75).fillRoundedRect(x - 8, y - 22, 16, 16, 4);
    this.labelProp(x, y + 26, 'water');
    this.spots.push(
      { x: x - 54, y: y + 8, sit: false, takenBy: null },
      { x: x + 54, y: y + 8, sit: false, takenBy: null },
    );
  }

  drawPrinter(x, y) {
    const g = this.add.graphics().setDepth(DEPTH.furniture);
    g.fillStyle(0x1e293b, 1).fillRoundedRect(x - 18, y - 10, 36, 22, 3);
    g.fillStyle(0x475569, 1).fillRect(x - 12, y - 16, 24, 7);
    g.fillStyle(0x94a3b8, 1).fillRect(x - 9, y + 12, 18, 5);
    this.labelProp(x, y + 24, 'printer');
    this.spots.push(
      { x: x - 54, y: y + 6, sit: false, takenBy: null },
      { x: x + 54, y: y + 6, sit: false, takenBy: null },
    );
  }

  labelProp(x, y, text) {
    this.add.text(x, y, text, {
      fontFamily: 'ui-monospace, monospace', fontSize: '9px', color: '#475569',
    }).setOrigin(0.5).setDepth(DEPTH.labels);
  }

  /** A desk, its monitor, and the chair its agent works from. */
  drawDesk(x, y) {
    const g = this.add.graphics().setDepth(DEPTH.furniture);
    // Desk, with the monitor at the back and the keyboard at the front edge.
    g.fillStyle(0x1e293b, 1).fillRoundedRect(x - 64, y - 14, 128, 28, 5);
    g.fillStyle(0x0b1220, 1).fillRoundedRect(x - 21, y - 36, 42, 21, 3);  // monitor
    g.fillStyle(0x1d4ed8, 0.32).fillRect(x - 17, y - 32, 34, 13);         // screen
    g.fillStyle(0x334155, 1).fillRect(x - 4, y - 15, 8, 3);               // stand
    g.fillStyle(0x475569, 1).fillRoundedRect(x - 15, y + 1, 30, 6, 2);    // keyboard
    // The chair sits just under the desk; the agent is drawn on top of it.
    g.fillStyle(0x2b3a52, 1).fillRoundedRect(x - 13, y + 26, 26, 13, 5);  // seat
    g.fillStyle(0x24314a, 1).fillRoundedRect(x - 4, y + 38, 8, 9, 3);     // stem
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
    this.add.text(desk.x, desk.y + 74, agent.department.toUpperCase(), {
      fontFamily: 'ui-monospace, monospace', fontSize: '10px', color: '#475569',
    }).setOrigin(0.5).setDepth(DEPTH.labels);

    // The figure: shadow, legs, torso, arms, head. Parts rotate at the joint,
    // which is why each limb has its origin at the top.
    const body = this.add.container(desk.x, desk.y + 30).setDepth(DEPTH.people);
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

    const label = this.add.text(desk.x, desk.y + 60, agent.name, {
      fontFamily: 'ui-sans-serif, system-ui', fontSize: '11px', color: '#cbd5e1',
    }).setOrigin(0.5).setDepth(DEPTH.labels);

    const statusText = this.add.text(desk.x, desk.y - 6, '', {
      fontFamily: 'ui-monospace, monospace', fontSize: '10px', color: '#94a3b8',
    }).setOrigin(0.5).setDepth(DEPTH.labels);

    const person = {
      id: agent.id, data: agent, body, label, statusText,
      parts: { legL, legR, armL, armR, torso, head, hair, marker, shadow },
      desk,
      seat: { x: desk.x, y: desk.y + 30 },
      standSpot: { x: desk.x + 56, y: desk.y + 38 },
      pos: { x: desk.x, y: desk.y + 30 },
      target: null,
      path: [],            // remaining waypoints of the current route
      claim: null,         // the spot this person is holding
      task: null,          // 'SIT' | 'STAND' | 'WANDER' | 'STOPPED'
      resting: false,      // sitting somewhere that is not their desk
      phase: rand(0, 10),  // keeps the crowd out of lockstep
      stride: 0,
      facing: 1,
      restUntil: 0,
    };
    this.people.set(agent.id, person);
    return person;
  }

  destroyPerson(person) {
    this.releaseSpot(person);
    person.body.destroy();
    person.label.destroy();
    person.statusText.destroy();
  }

  /**
   * One place decides what a status looks like — and what the person does
   * about it. Everything else is animation.
   */
  applyStatus(person, agent) {
    const style = STATUS_STYLE[agent.status] ?? STATUS_STYLE.IDLE;
    if (agent.status !== 'IDLE') this.releaseSpot(person);
    person.parts.marker.setFillStyle(style.ring);
    person.statusText.setText(style.label).setColor(style.text);
    person.body.setAlpha(agent.status === 'PAUSED' ? 0.45 : 1);
    person.label.setAlpha(agent.status === 'PAUSED' ? 0.45 : 1);

    person.path = [];
    person.resting = false;
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
    if (Math.hypot(destination.x - from.x, destination.y - from.y) > 150) {
      const aisleY = nearest(AISLE_ROWS, (from.y + destination.y) / 2);
      const aisleX = nearest(AISLE_COLS, (from.x + destination.x) / 2);
      person.path.push({ x: from.x, y: aisleY });
      if (Math.abs(destination.x - from.x) > 200) {
        person.path.push({ x: aisleX, y: aisleY });
      }
      person.path.push({ x: destination.x, y: aisleY });
    }
    person.path.push(destination);
  }

  releaseSpot(person) {
    if (person.claim) {
      person.claim.takenBy = null;
      person.claim = null;
    }
  }

  /** Where an idle person goes next: their own desk, or a free seat somewhere. */
  pickWanderTarget(person) {
    this.releaseSpot(person);

    // Half the time they just potter about their own desk.
    if (Math.random() < 0.5) {
      return {
        x: Phaser.Math.Clamp(person.desk.x + rand(-46, 46), 46, WIDTH - 46),
        y: Phaser.Math.Clamp(person.desk.y + rand(26, 46), 96, HEIGHT - 46),
      };
    }

    const free = this.spots.filter((s) => !s.takenBy);
    if (!free.length) return { ...person.seat };

    const spot = free[Math.floor(rand(0, free.length))];
    spot.takenBy = person.id;
    person.claim = spot;
    return { x: spot.x, y: spot.y };
  }

  update(time, delta) {
    const dt = Math.min(delta, 50) / 1000;
    for (const person of this.people.values()) this.step(person, time, dt);
    this.separate();
  }

  step(person, time, dt) {
    const { parts } = person;
    person.phase += dt;

    if (!person.target && person.path.length) person.target = person.path.shift();

    if (person.task === 'WANDER' && !person.target && time > person.restUntil) {
      this.routeTo(person, this.pickWanderTarget(person));
      person.target = person.path.shift() ?? null;
      person.resting = false;
    }

    let walking = false;
    if (person.target && !this.reduceMotion) {
      const dx = person.target.x - person.pos.x;
      const dy = person.target.y - person.pos.y;
      const distance = Math.hypot(dx, dy);
      if (distance <= ARRIVE_RADIUS) {
        person.pos = { ...person.target };
        person.target = null;
        if (person.task === 'WANDER' && !person.path.length) {
          // Sit down if the spot they claimed is a seat; breaks last longer.
          person.resting = person.claim?.sit === true;
          person.restUntil = time + (person.resting ? rand(6000, 12000) : rand(2600, 7000));
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

    const atDesk = !walking && person.task === 'SIT';
    const onBreak = !walking && person.resting;
    const seated = atDesk || onBreak;
    const stopped = person.task === 'STOPPED';

    person.body.x = person.pos.x;
    person.body.y = person.pos.y + (seated ? -4 : 0);
    person.body.scaleX = person.facing * 1.15;
    person.label.setPosition(person.pos.x, person.pos.y + 26);
    person.statusText.setPosition(person.pos.x, person.pos.y - 46);
    parts.shadow.setVisible(!seated);

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
    } else if (atDesk) {
      // At the desk: thighs forward on the chair, hands on the keyboard.
      parts.legL.setAngle(74);
      parts.legR.setAngle(74);
      const type = Math.sin(person.phase * 9) * 7;
      parts.armL.setAngle(58 + type);
      parts.armR.setAngle(58 - type);
      parts.torso.y = -10;
      parts.head.y = -18 + Math.sin(person.phase * 2.2) * 0.6;
      parts.hair.y = parts.head.y - 5;
    } else if (onBreak) {
      // Sitting in the pantry or the lobby: relaxed, hands in the lap.
      const breathe = Math.sin(person.phase * 1.5) * 1.1;
      parts.legL.setAngle(78);
      parts.legR.setAngle(78);
      parts.armL.setAngle(36 + breathe);
      parts.armR.setAngle(36 - breathe);
      parts.torso.y = -9 + breathe * 0.3;
      parts.head.y = -17 + breathe * 0.4;
      parts.hair.y = parts.head.y - 5;
    } else {
      // Standing: breathing, with a wave while a draft is waiting on you.
      const breathe = Math.sin(person.phase * 1.7) * 1.1;
      parts.legL.setAngle(0);
      parts.legR.setAngle(0);
      parts.torso.y = -12 + breathe * 0.4;
      parts.head.y = -20 + breathe * 0.4;
      parts.hair.y = parts.head.y - 5;
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
    parts.marker.y = seated ? -32 : -36;
  }

  /**
   * Nobody walks through anyone else. Anybody on their feet gets nudged —
   * wider apart when they have stopped, so names stay readable, and just
   * enough while walking that two people brush past instead of merging.
   * Seated figures are left alone: they belong where they are.
   */
  separate() {
    const onFoot = [...this.people.values()].filter(
      (p) => p.task !== 'STOPPED' && !p.resting && !(p.task === 'SIT' && !p.target));
    for (let i = 0; i < onFoot.length; i += 1) {
      for (let j = i + 1; j < onFoot.length; j += 1) {
        const a = onFoot[i];
        const b = onFoot[j];
        const bothStopped = !a.target && !b.target;
        const room = bothStopped ? 48 : 30;
        const dx = b.pos.x - a.pos.x;
        const dy = b.pos.y - a.pos.y;
        const distance = Math.hypot(dx, dy);
        if (distance > room || distance === 0) continue;
        const push = (room - distance) / 2;
        const nx = dx / distance;
        const ny = dy / distance;
        a.pos.x -= nx * push; a.pos.y -= ny * push;
        b.pos.x += nx * push; b.pos.y += ny * push;
      }
    }
  }

  /** Paused (or reduced-motion): a still figure, no idling, no typing. */
  poseStill(person, stopped) {
    const { parts } = person;
    const seated = person.task === 'SIT' || person.resting;
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
      scale: {
        mode: Phaser.Scale.FIT,
        autoCenter: Phaser.Scale.CENTER_HORIZONTALLY,
        // Without this Phaser widens the host div to the game's own width,
        // which pushes the whole page sideways on a phone.
        expandParent: false,
      },
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
