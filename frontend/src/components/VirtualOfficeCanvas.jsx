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

const WIDTH = 1100;
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
  staff_emerald: 0x34d399,
  staff_default: 0x64748b,
};

const SKIN_TONES = [0xf2d2b6, 0xe0b38c, 0xc68963, 0x9c6240];
const TROUSERS = 0x334155;

// The fit-out: warm woods, brass and marble, so the rooms read as somewhere
// you would actually want to sit rather than two grey boxes.
const FINISH = {
  marble: 0x2a3344,
  marbleVein: 0x3b465c,
  walnut: 0x5c3b25,
  walnutDark: 0x442b1a,
  brass: 0xc9a227,
  brassDim: 0x8a6f1c,
  leather: 0x6b4536,
  leatherDark: 0x4e3227,
  velvet: 0x3b4d6b,
  rug: 0x2b3850,
  glass: 0x7fc6e8,
  plant: 0x2f8f4e,
  plantDark: 0x236b3b,
};

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
// The lanes people walk down, between the desk blocks rather than over
// them. One above the front row, one between the two rows, one below.
const AISLE_ROWS = [245, 450, 655];
const AISLE_COLS = [230, 442, 654, 866];

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

    this.drawLobby(40, 74, 470, 132);
    this.drawPantry(590, 74, 470, 132);
    this.drawWaterCooler(230, 450);
    this.drawPrinter(866, 450);
  }

  zone(x, y, w, h, title, accent = 0x24334f) {
    const g = this.add.graphics().setDepth(DEPTH.floor);
    // Panelled wall, warm floor, brass trim.
    g.fillStyle(0x16202f, 1).fillRoundedRect(x, y, w, h, 12);
    g.fillStyle(0x1b2738, 1).fillRoundedRect(x + 3, y + 3, w - 6, h - 6, 10);
    g.lineStyle(1, accent, 0.45).strokeRoundedRect(x, y, w, h, 12);
    g.lineStyle(1, 0x223049, 0.8);
    for (let i = 1; i < 4; i += 1) g.lineBetween(x + (w / 4) * i, y + 4, x + (w / 4) * i, y + 16);
    g.lineStyle(1, 0, 0);
    this.add.text(x + 14, y + 8, title, {
      fontFamily: 'ui-monospace, monospace', fontSize: '10px',
      color: '#b99a34', letterSpacing: 2,
    }).setDepth(DEPTH.labels);
    g.fillStyle(accent, 0.5).fillRect(x + 14, y + 21, 26, 1);
    return this.add.graphics().setDepth(DEPTH.furniture);
  }

  /** A rug, so a room reads as a room and not a rectangle. */
  rug(g, x, y, w, h) {
    g.fillStyle(FINISH.rug, 1).fillRoundedRect(x, y, w, h, 10);
    g.lineStyle(2, FINISH.brassDim, 0.5).strokeRoundedRect(x + 5, y + 5, w - 10, h - 10, 7);
    g.lineStyle(1, 0, 0);
  }

  /** A potted plant, drawn at a size that suits where it stands. */
  plant(g, x, y, scale = 1) {
    g.fillStyle(FINISH.walnutDark, 1)
      .fillRoundedRect(x - 9 * scale, y, 18 * scale, 15 * scale, 3);
    g.fillStyle(FINISH.walnut, 1)
      .fillRoundedRect(x - 10 * scale, y - 2 * scale, 20 * scale, 5 * scale, 2);
    g.fillStyle(FINISH.plantDark, 1);
    g.fillCircle(x - 7 * scale, y - 6 * scale, 8 * scale);
    g.fillCircle(x + 7 * scale, y - 5 * scale, 7 * scale);
    g.fillStyle(FINISH.plant, 1);
    g.fillCircle(x, y - 14 * scale, 10 * scale);
    g.fillCircle(x - 9 * scale, y - 11 * scale, 6 * scale);
    g.fillCircle(x + 9 * scale, y - 10 * scale, 5 * scale);
  }

  /**
   * The lobby: a marble reception desk with a brass rail, a leather sofa and
   * armchair round a rug, a coffee table, and greenery in the corners.
   */
  drawLobby(x, y, w, h) {
    const g = this.zone(x, y, w, h, 'LOBBY', FINISH.brass);
    const midY = y + h / 2 + 10;

    // Rug under the seating.
    this.rug(g, x + 18, midY - 40, 190, 76);

    // Reception counter: marble top, walnut body, brass foot rail.
    const deskX = x + w - 96;
    g.fillStyle(FINISH.walnutDark, 1).fillRoundedRect(deskX, y + 30, 80, 70, 6);
    g.fillStyle(FINISH.walnut, 1).fillRoundedRect(deskX + 4, y + 34, 72, 58, 4);
    g.fillStyle(FINISH.marble, 1).fillRoundedRect(deskX - 4, y + 24, 88, 12, 4);
    g.fillStyle(FINISH.marbleVein, 1).fillRect(deskX + 10, y + 28, 36, 2);
    g.fillStyle(FINISH.brass, 0.85).fillRoundedRect(deskX + 6, y + 94, 68, 4, 2);
    // A monitor and a bell on the counter.
    g.fillStyle(0x0b1220, 1).fillRoundedRect(deskX + 14, y + 8, 28, 16, 2);
    g.fillStyle(FINISH.brass, 0.9).fillCircle(deskX + 60, y + 18, 5);

    // Three-seat leather sofa with piping.
    const sofaX = x + 68;
    g.fillStyle(FINISH.leatherDark, 1).fillRoundedRect(sofaX - 62, midY - 36, 124, 20, 7);
    g.fillStyle(FINISH.leather, 1).fillRoundedRect(sofaX - 58, midY - 20, 116, 24, 7);
    g.lineStyle(1, FINISH.brassDim, 0.6);
    g.strokeRoundedRect(sofaX - 58, midY - 20, 116, 24, 7);
    g.lineBetween(sofaX - 20, midY - 18, sofaX - 20, midY + 2);
    g.lineBetween(sofaX + 20, midY - 18, sofaX + 20, midY + 2);
    g.lineStyle(1, 0, 0);
    g.fillStyle(FINISH.leatherDark, 1).fillRoundedRect(sofaX - 70, midY - 28, 12, 30, 5);
    g.fillStyle(FINISH.leatherDark, 1).fillRoundedRect(sofaX + 58, midY - 28, 12, 30, 5);

    // Armchair facing it.
    g.fillStyle(FINISH.leatherDark, 1).fillRoundedRect(sofaX + 112, midY - 30, 34, 16, 6);
    g.fillStyle(FINISH.leather, 1).fillRoundedRect(sofaX + 114, midY - 16, 30, 20, 6);

    // Marble coffee table with a tray.
    g.fillStyle(FINISH.marble, 1).fillRoundedRect(sofaX + 2, midY + 10, 64, 20, 5);
    g.fillStyle(FINISH.marbleVein, 1).fillRect(sofaX + 12, midY + 16, 24, 2);
    g.fillStyle(FINISH.brass, 0.8).fillRoundedRect(sofaX + 38, midY + 13, 18, 7, 2);

    // Greenery and a framed picture on the back wall.
    this.plant(g, x + 22, y + 44, 0.9);
    this.plant(g, x + w - 24, y + h - 22, 0.75);
    g.fillStyle(FINISH.walnut, 1).fillRoundedRect(x + 118, y + 14, 46, 30, 3);
    g.fillStyle(FINISH.velvet, 1).fillRect(x + 122, y + 18, 38, 22);

    this.spots.push(
      { x: sofaX - 30, y: midY + 4, sit: true, takenBy: null },
      { x: sofaX + 30, y: midY + 4, sit: true, takenBy: null },
      { x: sofaX + 129, y: midY + 6, sit: true, takenBy: null },
      { x: deskX - 28, y: y + h - 18, sit: false, takenBy: null },
    );
  }

  /**
   * The pantry: a marble counter with a brass tap and espresso machine, a
   * tall fridge, and a communal table with stools.
   */
  drawPantry(x, y, w, h) {
    const g = this.zone(x, y, w, h, 'PANTRY', FINISH.brass);
    const midY = y + h / 2 + 14;

    // Run of cabinets under a marble worktop.
    const counterW = Math.min(176, w - 120);
    g.fillStyle(FINISH.walnutDark, 1).fillRoundedRect(x + 16, y + 30, counterW, 34, 4);
    g.lineStyle(1, FINISH.walnut, 0.9);
    for (let i = 1; i < 3; i += 1) {
      g.lineBetween(x + 16 + (counterW / 3) * i, y + 32, x + 16 + (counterW / 3) * i, y + 62);
    }
    g.lineStyle(1, 0, 0);
    g.fillStyle(FINISH.marble, 1).fillRoundedRect(x + 12, y + 22, counterW + 8, 11, 3);
    g.fillStyle(FINISH.marbleVein, 1).fillRect(x + 40, y + 26, 44, 2);

    // Espresso machine, cups, and a brass tap over a sink.
    g.fillStyle(0x1b2334, 1).fillRoundedRect(x + 26, y + 6, 30, 18, 3);
    g.fillStyle(FINISH.brass, 0.9).fillRect(x + 36, y + 20, 10, 4);
    g.fillStyle(0xf3f6fb, 1).fillCircle(x + 70, y + 17, 4);
    g.fillStyle(0xf3f6fb, 1).fillCircle(x + 82, y + 17, 4);
    g.lineStyle(2, FINISH.brass, 0.9);
    g.beginPath();
    g.arc(x + 128, y + 18, 8, Math.PI, Math.PI * 1.9);
    g.strokePath();
    g.lineStyle(1, 0, 0);
    g.fillStyle(0x1b2334, 1).fillRoundedRect(x + 118, y + 24, 22, 8, 2);

    // Tall fridge with a brass handle.
    g.fillStyle(0x27384f, 1).fillRoundedRect(x + w - 66, y + 16, 46, 84, 6);
    g.fillStyle(0x2f4360, 1).fillRoundedRect(x + w - 62, y + 20, 38, 36, 4);
    g.fillStyle(0x2f4360, 1).fillRoundedRect(x + w - 62, y + 60, 38, 36, 4);
    g.fillStyle(FINISH.brass, 0.9).fillRoundedRect(x + w - 30, y + 30, 4, 18, 2);

    // Communal table on a rug, with stools.
    const tableX = x + w / 2 - 28;
    this.rug(g, tableX - 86, midY - 30, 172, 62);
    g.fillStyle(FINISH.walnut, 1).fillRoundedRect(tableX - 52, midY - 16, 104, 28, 6);
    g.fillStyle(FINISH.walnutDark, 1).fillRoundedRect(tableX - 46, midY + 10, 10, 10, 2);
    g.fillStyle(FINISH.walnutDark, 1).fillRoundedRect(tableX + 36, midY + 10, 10, 10, 2);
    // A bowl of fruit, because every good pantry has one.
    g.fillStyle(FINISH.brass, 0.85).fillCircle(tableX, midY - 4, 8);
    g.fillStyle(0xe4703a, 1).fillCircle(tableX - 3, midY - 8, 3);
    g.fillStyle(0xd9b43c, 1).fillCircle(tableX + 3, midY - 8, 3);

    for (const dx of [-74, 74]) {
      g.fillStyle(FINISH.leatherDark, 1).fillCircle(tableX + dx, midY + 4, 11);
      g.fillStyle(FINISH.leather, 1).fillCircle(tableX + dx, midY + 1, 10);
    }

    this.plant(g, x + 18, y + h - 24, 0.7);

    this.spots.push(
      { x: tableX - 74, y: midY + 8, sit: true, takenBy: null },
      { x: tableX + 74, y: midY + 8, sit: true, takenBy: null },
      { x: x + 70, y: y + h - 20, sit: false, takenBy: null },
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

    // A rug under each desk, so the work area is not bare floor.
    g.fillStyle(0x1a2335, 1).fillRoundedRect(x - 84, y - 20, 168, 78, 10);

    // Walnut desk with a marble edge and a brass modesty rail.
    g.fillStyle(FINISH.walnutDark, 1).fillRoundedRect(x - 66, y - 12, 132, 30, 5);
    g.fillStyle(FINISH.walnut, 1).fillRoundedRect(x - 63, y - 10, 126, 24, 4);
    g.fillStyle(FINISH.marble, 1).fillRoundedRect(x - 66, y - 16, 132, 8, 3);
    g.fillStyle(FINISH.marbleVein, 1).fillRect(x - 40, y - 13, 30, 1.5);
    g.fillStyle(FINISH.brass, 0.55).fillRect(x - 54, y + 15, 108, 2);

    // Monitor on a brass stand.
    g.fillStyle(0x0a111d, 1).fillRoundedRect(x - 23, y - 40, 46, 24, 3);
    g.fillStyle(0x1b3a6b, 0.6).fillRoundedRect(x - 19, y - 36, 38, 15, 2);
    g.fillStyle(0x3fbdf0, 0.25).fillRect(x - 17, y - 34, 20, 3);
    g.fillStyle(0x3fbdf0, 0.18).fillRect(x - 17, y - 29, 30, 2);
    g.fillStyle(FINISH.brassDim, 1).fillRect(x - 3, y - 17, 6, 3);

    // Keyboard, a notebook and a coffee, which is what a desk really has.
    g.fillStyle(0x2c3a52, 1).fillRoundedRect(x - 16, y - 4, 32, 7, 2);
    g.fillStyle(0xd8dee9, 0.85).fillRoundedRect(x + 24, y - 4, 14, 9, 1.5);
    g.fillStyle(FINISH.brass, 0.75).fillCircle(x - 32, y + 1, 4);

    // Leather task chair, tucked under; the agent is drawn on top of it.
    g.fillStyle(FINISH.leatherDark, 1).fillRoundedRect(x - 15, y + 24, 30, 15, 6);
    g.fillStyle(FINISH.leather, 1).fillRoundedRect(x - 13, y + 26, 26, 11, 5);
    g.fillStyle(0x24314a, 1).fillRoundedRect(x - 4, y + 38, 8, 9, 3);
    g.fillStyle(0x2c3a52, 1).fillRoundedRect(x - 12, y + 46, 24, 4, 2);
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
      person.roleLabel.setText(agent.role_title ?? agent.department);
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

    // Name on top, what they do underneath — the same two lines a real desk
    // nameplate carries.
    const label = this.add.text(desk.x, desk.y + 58, agent.name, {
      fontFamily: 'ui-sans-serif, system-ui', fontSize: '11px', color: '#e8eef8',
      backgroundColor: 'rgba(9,14,26,0.82)', padding: { x: 5, y: 2 },
    }).setOrigin(0.5, 0).setDepth(DEPTH.labels);
    const roleLabel = this.add.text(desk.x, desk.y + 72, agent.role_title ?? agent.department, {
      fontFamily: 'ui-monospace, monospace', fontSize: '9px', color: '#9ab0d0',
      backgroundColor: 'rgba(9,14,26,0.82)', padding: { x: 5, y: 2 },
    }).setOrigin(0.5, 0).setDepth(DEPTH.labels);

    const statusText = this.add.text(desk.x, desk.y - 6, '', {
      fontFamily: 'ui-monospace, monospace', fontSize: '10px', color: '#94a3b8',
    }).setOrigin(0.5).setDepth(DEPTH.labels);

    const person = {
      id: agent.id, data: agent, body, label, roleLabel, statusText,
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
    person.roleLabel.destroy();
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
    const dim = agent.status === 'PAUSED' ? 0.45 : 1;
    person.body.setAlpha(dim);
    person.label.setAlpha(dim);
    person.roleLabel.setAlpha(dim);

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
        y: Phaser.Math.Clamp(person.desk.y + rand(24, 40), 96, HEIGHT - 60),
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
    // Name directly under the figure, role flush beneath it: one block.
    person.label.setPosition(person.pos.x, person.pos.y + 22);
    person.roleLabel.setPosition(person.pos.x, person.pos.y + 22 + person.label.height);
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
        const room = bothStopped ? 92 : 38;
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
