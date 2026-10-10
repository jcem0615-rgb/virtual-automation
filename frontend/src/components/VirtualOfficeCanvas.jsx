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

// The fit-out that every floor shares: the woods, the upholstery, the
// greenery. What changes between floors is in FLOOR_THEMES below.
const FINISH = {
  walnut: 0x8a5c36,
  walnutDark: 0x603d22,
  brass: 0xc9a227,
  brassDim: 0x97771b,
  leather: 0x9a6c4a,
  leatherDark: 0x6d4a32,
  sofa: 0x7e8ba3,
  sofaLight: 0x99a5ba,
  sofaDark: 0x5a6579,
  chair: 0x3b4458,
  chairDark: 0x272e3d,
  counter: 0xeceff4,
  counterDark: 0xb9c0cb,
  counterEdge: 0xf8fafc,
  cabinet: 0x8a6243,
  cabinetDark: 0x5f4430,
  pot: 0xb5724a,
  potDark: 0x8a5436,
  plant: 0x3fae5e,
  plantDark: 0x2c7e45,
};

/**
 * What a floor is made of. Same ten desks everywhere, but an electrical
 * contractor's office is not a salon with different names on the desks, so
 * the boards, the walls, the accent and the one piece of kit that says what
 * the business does all come from its line of work.
 */
const FLOOR_THEMES = {
  electrical: {
    floor: 0xc49a6c, floorAlt: 0xb88d5f, floorSeam: 0x8f6a44,
    wall: 0xd9d3c7, wallDark: 0xb9b2a4, frame: 0x6f7a86,
    sky: 0x9fc6de, skyFar: 0x7aa7c4, accent: 0xe08a1e,
    desk: 0x8a5c36, deskDark: 0x603d22, screen: 0x2563eb,
    rug: 0xa98257, rugAlt: 0xb08c62, labelInk: '#5b5346',
    feature: 'workbench',
  },
  it_services: {
    floor: 0xcdb391, floorAlt: 0xc2a784, floorSeam: 0x9c8260,
    wall: 0xd5d8dd, wallDark: 0xb4b8bf, frame: 0x6b7683,
    sky: 0xa6cade, skyFar: 0x80acc6, accent: 0x1f8fc4,
    desk: 0x6f7786, deskDark: 0x4e5564, screen: 0x0ea5e9,
    rug: 0x9aa7b4, rugAlt: 0xb9bcc0, labelInk: '#4f5864',
    feature: 'rack',
  },
  retail: {
    floor: 0xdcc39c, floorAlt: 0xd2b78e, floorSeam: 0xa8906a,
    wall: 0xe4ded2, wallDark: 0xc4bcad, frame: 0x76806a,
    sky: 0xa9cfe0, skyFar: 0x83b0c8, accent: 0x18a16f,
    desk: 0x9a6c45, deskDark: 0x6f4d30, screen: 0x10b981,
    rug: 0xbda07b, rugAlt: 0xc9ae8b, labelInk: '#5c5446',
    feature: 'shelving',
  },
  food: {
    floor: 0xc08057, floorAlt: 0xb4744a, floorSeam: 0x8a5634,
    wall: 0xe5d9c9, wallDark: 0xc5b8a5, frame: 0x7d6a56,
    sky: 0xb0cee0, skyFar: 0x8aadc6, accent: 0xe2672a,
    desk: 0x8a5c36, deskDark: 0x603d22, screen: 0xf97316,
    rug: 0xa9774f, rugAlt: 0xb4845c, labelInk: '#5e4b3a',
    feature: 'prep',
  },
  construction: {
    floor: 0xb7b2a8, floorAlt: 0xaca79c, floorSeam: 0x8b867c,
    wall: 0xd2cfc8, wallDark: 0xb0ada5, frame: 0x6e7279,
    sky: 0xa3c4d8, skyFar: 0x7ea3bd, accent: 0xd9a21b,
    desk: 0x7d6a50, deskDark: 0x594a37, screen: 0xeab308,
    rug: 0x9e998e, rugAlt: 0xaaa69b, labelInk: '#4f4c45',
    feature: 'plans',
  },
  logistics: {
    floor: 0xa8adb5, floorAlt: 0x9ca1a9, floorSeam: 0x7c8189,
    wall: 0xcfd4da, wallDark: 0xadb2b9, frame: 0x68727f,
    sky: 0x9fc7de, skyFar: 0x79a6c3, accent: 0x1b86c4,
    desk: 0x5f6a7c, deskDark: 0x434c5b, screen: 0x0284c7,
    rug: 0x8f959d, rugAlt: 0x9ba1a9, labelInk: '#49505a',
    feature: 'pallets',
  },
  salon: {
    floor: 0xd9b8ae, floorAlt: 0xcfaba0, floorSeam: 0xa6857c,
    wall: 0xe6dae0, wallDark: 0xc5b8bf, frame: 0x7e6c78,
    sky: 0xc2c4e0, skyFar: 0x9b9ec4, accent: 0xd4518c,
    desk: 0x9a6a6a, deskDark: 0x6e4a4a, screen: 0xec4899,
    rug: 0xc29a95, rugAlt: 0xcda9a2, labelInk: '#5f4c52',
    feature: 'mirror',
  },
  professional_services: {
    floor: 0xab8356, floorAlt: 0x9f7749, floorSeam: 0x7a5b35,
    wall: 0xd8d2c4, wallDark: 0xb7b1a2, frame: 0x6d6657,
    sky: 0x9ec3dc, skyFar: 0x78a2c1, accent: 0xb08a1e,
    desk: 0x7a5232, deskDark: 0x563921, screen: 0xca8a04,
    rug: 0x96724a, rugAlt: 0xa37f55, labelInk: '#564e40',
    feature: 'library',
  },
  general: {
    floor: 0xc6ab85, floorAlt: 0xbb9f77, floorSeam: 0x957d59,
    wall: 0xd8d6d0, wallDark: 0xb6b4ad, frame: 0x6f757c,
    sky: 0xa4c8dd, skyFar: 0x7ea7c3, accent: 0x5b7490,
    desk: 0x7f6648, deskDark: 0x5a4833, screen: 0x64748b,
    rug: 0xae9471, rugAlt: 0xb9a07e, labelInk: '#55514a',
    feature: 'library',
  },
};

// The wall runs along the top; everything below it is floor.
const WALL_H = 118;

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

/** A stable number per business, so a floor looks the same every time. */
function seedOf(text) {
  let n = 0;
  for (const ch of String(text ?? '')) n = (n * 31 + ch.charCodeAt(0)) % 100000;
  return n;
}

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
    this.theme = FLOOR_THEMES.general;
    this.seed = 0;
    this.floorKey = null;
  }

  create() {
    this.reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.room = this.add.container(0, 0);
    this.drawRoom();
    this.ready = true;
    if (this.pending.length) this.syncAgents(this.pending);
    this.pending = [];
  }

  /**
   * Which office this is. Changing floors tears the room down and builds the
   * other one — the people are re-synced right after, so nobody is left
   * standing on furniture that no longer exists.
   */
  setFloor(floor) {
    const key = `${floor?.id ?? 'none'}:${floor?.business_type ?? 'general'}`;
    if (key === this.floorKey) return;
    this.floorKey = key;
    this.theme = FLOOR_THEMES[floor?.business_type] ?? FLOOR_THEMES.general;
    this.seed = seedOf(floor?.id ?? floor?.business_type ?? 'office');
    this.floorName = floor?.name ?? 'VIRTUAL OFFICE';
    if (!this.ready) return;
    this.drawRoom();
    // Every spot the old room owned is gone, so anyone holding one is sent
    // back to their desk and picks a new place from the new room.
    for (const person of this.people.values()) {
      person.claim = null;
      this.applyStatus(person, person.data);
    }
  }

  /** Build (or rebuild) the room, leaving the people alone. */
  drawRoom() {
    for (const child of this.room.list.slice()) child.destroy();
    this.spots = [];
    this.building = [];
    this.drawFloor();
    for (const object of this.building) this.room.add(object);
    this.building = null;
  }

  /** Every room object goes through here so a rebuild can clear it. */
  keep(object) {
    if (this.building) this.building.push(object);
    return object;
  }

  // ------------------------------------------------------------ the room
  //
  // Drawn as a room seen from a little above rather than a flat plan: every
  // solid thing gets a top face, a darker front face below it and a soft
  // shadow, with the light coming from the windows along the top. It is not a
  // 3D engine — the people still walk a flat grid — but it reads as a place.
  //
  // What the room is made of comes from the business's line of work, so a
  // retail floor and an electrical contractor's floor are not the same office
  // with different names on the desks. `theme` is picked in setFloor().

  drawFloor() {
    const t = this.theme;
    const g = this.keep(this.add.graphics()).setDepth(DEPTH.floor);

    // Floorboards, running the length of the room, with a seam every plank
    // and a few boards knocked slightly darker so it is not a flat fill.
    g.fillStyle(t.floor, 1).fillRect(0, 0, WIDTH, HEIGHT);
    // A warm pool of daylight under the windows, falling off toward the back
    // of the room, so the floor is not one flat colour.
    for (let i = 0; i < 14; i += 1) {
      g.fillStyle(0xffffff, 0.035 - i * 0.0024).fillRect(0, WALL_H + i * 12, WIDTH, 12);
    }
    for (let y = WALL_H; y < HEIGHT; y += 26) {
      g.fillStyle(t.floorAlt, this.noise(y) > 0.62 ? 0.5 : 0.22).fillRect(0, y, WIDTH, 26);
      g.fillStyle(t.floorSeam, 0.5).fillRect(0, y + 25, WIDTH, 1);
    }
    // Short seams across, so the boards look laid rather than striped.
    g.fillStyle(t.floorSeam, 0.35);
    for (let y = WALL_H; y < HEIGHT; y += 26) {
      for (let x = (y / 26) % 2 ? 90 : 210; x < WIDTH; x += 240) g.fillRect(x, y, 1.5, 26);
    }

    this.drawWalls(g, t);
    this.drawLounge(40, WALL_H + 8, 430, 150);
    this.drawPantry(WIDTH - 420, WALL_H + 8, 380, 150);
    this.drawMeetingTable(WIDTH / 2, 452);
    this.drawFeature(t);
    this.drawGreenery(t);
  }

  /**
   * A back wall with a glass curtain wall in it. The glass is where the room
   * gets its light, so everything below is lit from the top.
   */
  drawWalls(g, t) {
    // The wall itself, with a shadow where it meets the floor.
    g.fillStyle(t.wall, 1).fillRect(0, 0, WIDTH, WALL_H);
    g.fillStyle(t.wallDark, 1).fillRect(0, WALL_H - 10, WIDTH, 10);
    g.fillStyle(0x000000, 0.22).fillRect(0, WALL_H, WIDTH, 14);

    // Glazing: two runs of windows with mullions and a hint of outside.
    const bays = [[64, 400], [WIDTH - 470, 410]];
    for (const [x, w] of bays) {
      g.fillStyle(t.frame, 1).fillRoundedRect(x - 6, 14, w + 12, WALL_H - 36, 4);
      g.fillStyle(t.sky, 1).fillRect(x, 20, w, WALL_H - 48);
      // Daylight falling down the glass.
      g.fillStyle(0xffffff, 0.1).fillRect(x, 20, w, 16);
      g.fillStyle(t.skyFar, 0.55).fillRect(x, WALL_H - 46, w, 18);
      g.fillStyle(t.frame, 1);
      for (let m = 1; m * 100 < w; m += 1) g.fillRect(x + m * 100 - 2, 20, 4, WALL_H - 48);
      g.fillRect(x, 20 + (WALL_H - 48) / 2 - 2, w, 4);
    }

    // A framed picture and a clock on the solid piece between the bays.
    const midX = (bays[0][0] + bays[0][1] + bays[1][0]) / 2;
    g.fillStyle(t.frame, 1).fillRoundedRect(midX - 34, 26, 68, 46, 3);
    g.fillStyle(t.accent, 0.5).fillRect(midX - 29, 31, 58, 36);
    g.fillStyle(t.wallDark, 1).fillCircle(midX, 92, 13);
    g.fillStyle(0xf8fafc, 1).fillCircle(midX, 92, 10);
    g.fillStyle(t.wallDark, 1).fillRect(midX - 1, 85, 2, 8).fillRect(midX, 91, 7, 2);
  }

  /** Noise with a stable value per coordinate, so a redraw looks the same. */
  noise(n) {
    const v = Math.sin((n + this.seed) * 12.9898) * 43758.5453;
    return v - Math.floor(v);
  }

  /** A box with a top face and a front face: the whole 2.5D trick. */
  box(g, x, y, w, d, h, top, front, radius = 3) {
    g.fillStyle(0x000000, 0.2).fillRoundedRect(x + 3, y + d - 2, w, h + 4, radius);
    g.fillStyle(front, 1).fillRoundedRect(x, y + d - h / 2, w, h, radius);
    g.fillStyle(top, 1).fillRoundedRect(x, y, w, d, radius);
  }

  /**
   * A rug. Woven, a shade off the boards rather than a block of colour, with
   * a border and a fringe — otherwise it reads as a hole in the floor.
   */
  rug(g, x, y, w, h, colour, edge) {
    g.fillStyle(0x000000, 0.08).fillRoundedRect(x + 3, y + 3, w, h, 6);
    g.fillStyle(colour, 1).fillRoundedRect(x, y, w, h, 6);
    g.fillStyle(0xffffff, 0.05);
    for (let i = y + 6; i < y + h - 4; i += 7) g.fillRect(x + 4, i, w - 8, 2);
    g.lineStyle(2, edge, 0.45).strokeRoundedRect(x + 7, y + 7, w - 14, h - 14, 4);
    g.lineStyle(0, 0, 0);
    g.fillStyle(colour, 1);
    for (let i = x + 6; i < x + w - 4; i += 8) {
      g.fillRect(i, y - 3, 3, 3).fillRect(i, y + h, 3, 3);
    }
  }

  /**
   * A plant. Three canopy blobs over a pot, sized to where it stands — the
   * big ones are trees in the corners, the small ones sit on a counter.
   */
  plant(g, x, y, scale = 1, dark = false) {
    const leaf = dark ? FINISH.plantDark : FINISH.plant;
    g.fillStyle(0x000000, 0.18).fillEllipse(x + 2, y + 9 * scale, 26 * scale, 9 * scale);
    g.fillStyle(FINISH.potDark, 1).fillRoundedRect(x - 10 * scale, y - 2 * scale, 20 * scale, 16 * scale, 3);
    g.fillStyle(FINISH.pot, 1).fillRoundedRect(x - 11 * scale, y - 4 * scale, 22 * scale, 7 * scale, 2);
    g.fillStyle(FINISH.plantDark, 1);
    g.fillCircle(x - 8 * scale, y - 10 * scale, 9 * scale);
    g.fillCircle(x + 8 * scale, y - 9 * scale, 8 * scale);
    g.fillStyle(leaf, 1);
    g.fillCircle(x, y - 19 * scale, 11 * scale);
    g.fillCircle(x - 10 * scale, y - 15 * scale, 7 * scale);
    g.fillCircle(x + 10 * scale, y - 14 * scale, 6 * scale);
    g.fillStyle(0xffffff, 0.08).fillCircle(x - 3 * scale, y - 23 * scale, 5 * scale);
  }

  /**
   * The lounge: a sofa and an armchair round a low table on a rug, with a
   * sideboard and a screen on the wall behind. Where people go when there is
   * nothing on.
   *
   * Drawn back to front — rug, table, armchair, then the sofa nearest the
   * viewer — because this is one graphics object and later is on top.
   */
  drawLounge(x, y, w, h) {
    const t = this.theme;
    const g = this.keep(this.add.graphics()).setDepth(DEPTH.furniture);
    this.zoneLabel(x + w - 62, y + 2, 'LOUNGE');

    // Sideboard along the wall, with a screen over it.
    this.box(g, x + 10, y - 4, 132, 20, 13, FINISH.walnut, FINISH.walnutDark, 3);
    g.fillStyle(0x1f2937, 1).fillRoundedRect(x + 36, y - 28, 84, 22, 2);
    g.fillStyle(t.accent, 0.35).fillRoundedRect(x + 40, y - 24, 76, 14, 2);
    g.fillStyle(FINISH.brass, 0.85).fillCircle(x + 22, y, 4);
    g.fillStyle(0xf1f5f9, 0.8).fillRoundedRect(x + 128, y - 6, 10, 14, 2);

    this.rug(g, x + 22, y + 28, 272, 108, t.rug, t.accent);

    // Coffee table, with something on it.
    const tx = x + 142;
    const ty = y + 70;
    g.fillStyle(0x000000, 0.16).fillEllipse(tx + 3, ty + 7, 76, 28);
    g.fillStyle(FINISH.walnutDark, 1).fillEllipse(tx, ty + 5, 72, 26);
    g.fillStyle(FINISH.walnut, 1).fillEllipse(tx, ty, 72, 26);
    g.fillStyle(0xffffff, 0.06).fillEllipse(tx - 14, ty - 5, 30, 10);
    g.fillStyle(0xf1f5f9, 0.85).fillRoundedRect(tx - 24, ty - 6, 18, 11, 2);
    g.fillStyle(t.accent, 0.85).fillCircle(tx + 16, ty, 5);

    // Armchair at the end of the rug, turned toward the table.
    const ax = x + 232;
    const ay = y + 44;
    g.fillStyle(0x000000, 0.14).fillRoundedRect(ax + 3, ay + 30, 48, 20, 8);
    g.fillStyle(FINISH.sofaDark, 1).fillRoundedRect(ax, ay, 48, 22, 7);
    g.fillStyle(FINISH.sofa, 1).fillRoundedRect(ax + 3, ay + 4, 42, 14, 6);
    g.fillStyle(FINISH.sofaDark, 1)
      .fillRoundedRect(ax, ay + 16, 13, 34, 6)
      .fillRoundedRect(ax + 35, ay + 16, 13, 34, 6);
    g.fillStyle(FINISH.sofaLight, 1).fillRoundedRect(ax + 15, ay + 20, 18, 28, 5);

    // The sofa, nearest the viewer: a back, two arms and cushions between
    // them. A slab with a front face reads as a counter, not a seat.
    const sx = x + 34;
    const sy = y + 92;
    const sw = 184;
    g.fillStyle(0x000000, 0.16).fillRoundedRect(sx + 4, sy + 34, sw, 22, 8);
    g.fillStyle(FINISH.sofaDark, 1).fillRoundedRect(sx, sy, sw, 24, 7);
    g.fillStyle(FINISH.sofa, 1).fillRoundedRect(sx + 3, sy + 4, sw - 6, 15, 6);
    g.fillStyle(FINISH.sofaDark, 1)
      .fillRoundedRect(sx, sy + 18, 15, 36, 7)
      .fillRoundedRect(sx + sw - 15, sy + 18, 15, 36, 7);
    for (let i = 0; i < 3; i += 1) {
      g.fillStyle(FINISH.sofaLight, 1)
        .fillRoundedRect(sx + 18 + i * 50, sy + 22, 46, 28, 6);
    }
    g.fillStyle(t.accent, 0.6).fillRoundedRect(sx + 22, sy + 26, 20, 20, 5);
    g.fillStyle(t.accent, 0.35).fillRoundedRect(sx + 122, sy + 26, 20, 20, 5);

    this.plant(g, x + w - 34, y + h - 18, 1.15);
    this.plant(g, x + 304, y + 44, 0.75, true);

    this.spots.push(
      { x: sx + 40, y: sy + 36, sit: true, takenBy: null },
      { x: sx + 90, y: sy + 36, sit: true, takenBy: null },
      { x: sx + 140, y: sy + 36, sit: true, takenBy: null },
      { x: ax + 24, y: ay + 34, sit: true, takenBy: null },
      { x: x + w - 72, y: y + h - 14, sit: false, takenBy: null },
    );
  }

  /**
   * The pantry: a run of counter with an espresso machine and a sink, a tall
   * fridge, and a high table with stools.
   */
  drawPantry(x, y, w, h) {
    const t = this.theme;
    const g = this.keep(this.add.graphics()).setDepth(DEPTH.furniture);
    this.zoneLabel(x + 12, y + 4, 'PANTRY');

    // Upper cabinets, then the counter under them.
    this.box(g, x + 10, y - 6, w - 130, 22, 14, FINISH.cabinet, FINISH.cabinetDark, 3);
    this.box(g, x + 10, y + 26, w - 130, 30, 18, FINISH.counter, FINISH.counterDark, 3);
    g.fillStyle(FINISH.counterEdge, 1).fillRect(x + 10, y + 26, w - 130, 3);

    // Espresso machine, a kettle, the sink and its tap.
    this.box(g, x + 26, y + 10, 34, 18, 14, 0x1f2937, 0x111827, 3);
    g.fillStyle(t.accent, 0.8).fillRect(x + 32, y + 15, 22, 3);
    g.fillStyle(0x94a3b8, 1).fillRect(x + 41, y + 28, 4, 7);
    this.box(g, x + 72, y + 14, 18, 14, 12, 0xcbd5e1, 0x94a3b8, 3);
    g.fillStyle(FINISH.counterDark, 1).fillRoundedRect(x + 110, y + 30, 40, 20, 4);
    g.fillStyle(FINISH.brass, 1).fillRect(x + 128, y + 18, 3, 14).fillRect(x + 128, y + 18, 13, 3);
    this.plant(g, x + 172, y + 30, 0.55);

    // Tall fridge at the end of the run.
    this.box(g, x + w - 104, y - 4, 44, 76, 20, 0xe2e8f0, 0xcbd5e1, 4);
    g.fillStyle(0xcbd5e1, 1).fillRect(x + w - 104, y + 30, 44, 2);
    g.fillStyle(0x94a3b8, 1).fillRoundedRect(x + w - 70, y + 10, 4, 14, 2);

    // High table with stools, which is where people actually eat.
    const tx = x + 70;
    const ty = y + 92;
    g.fillStyle(0x000000, 0.2).fillEllipse(tx + 3, ty + 8, 108, 36);
    g.fillStyle(FINISH.walnutDark, 1).fillEllipse(tx, ty + 6, 104, 34);
    g.fillStyle(FINISH.walnut, 1).fillEllipse(tx, ty + 2, 104, 34);
    for (const dx of [-62, 62]) {
      g.fillStyle(0x000000, 0.18).fillEllipse(tx + dx + 2, ty + 6, 26, 12);
      g.fillStyle(FINISH.leatherDark, 1).fillEllipse(tx + dx, ty + 4, 26, 12);
      g.fillStyle(FINISH.leather, 1).fillEllipse(tx + dx, ty, 26, 12);
    }
    // A fruit bowl, because an empty table looks abandoned.
    g.fillStyle(FINISH.brass, 0.85).fillEllipse(tx, ty, 24, 10);
    g.fillStyle(0xef7d55, 1).fillCircle(tx - 5, ty - 3, 4);
    g.fillStyle(0x9ad636, 1).fillCircle(tx + 4, ty - 2, 4);

    this.plant(g, x + w - 26, y + h - 20, 1.05);

    this.spots.push(
      { x: tx - 62, y: ty + 2, sit: true, takenBy: null },
      { x: tx + 62, y: ty + 2, sit: true, takenBy: null },
      { x: x + 40, y: y + 62, sit: false, takenBy: null },
      { x: x + 150, y: y + 62, sit: false, takenBy: null },
    );
  }

  /** The meeting table in the middle of the floor, with chairs round it. */
  drawMeetingTable(x, y) {
    const t = this.theme;
    const g = this.keep(this.add.graphics()).setDepth(DEPTH.furniture);

    this.rug(g, x - 150, y - 56, 300, 112, t.rugAlt, t.accent);

    // Chairs first, so the table sits over them.
    for (const [dx, dy] of [[-76, -34], [0, -38], [76, -34], [-76, 34], [0, 38], [76, 34]]) {
      g.fillStyle(0x000000, 0.18).fillEllipse(x + dx + 2, y + dy + 4, 28, 13);
      g.fillStyle(FINISH.chairDark, 1).fillEllipse(x + dx, y + dy + 2, 28, 13);
      g.fillStyle(FINISH.chair, 1).fillEllipse(x + dx, y + dy - 1, 28, 13);
      g.fillStyle(FINISH.chairDark, 1)
        .fillRoundedRect(x + dx - 12, y + dy + (dy < 0 ? -12 : 4), 24, 9, 3);
    }

    g.fillStyle(0x000000, 0.22).fillEllipse(x + 4, y + 8, 212, 76);
    g.fillStyle(FINISH.walnutDark, 1).fillEllipse(x, y + 5, 208, 74);
    g.fillStyle(FINISH.walnut, 1).fillEllipse(x, y, 208, 74);
    g.fillStyle(0xffffff, 0.05).fillEllipse(x - 30, y - 12, 90, 26);

    // What is on it: a laptop, papers, a carafe.
    g.fillStyle(0x1f2937, 1).fillRoundedRect(x - 56, y - 12, 34, 20, 2);
    g.fillStyle(t.accent, 0.3).fillRoundedRect(x - 53, y - 9, 28, 13, 2);
    g.fillStyle(0xf1f5f9, 0.85).fillRoundedRect(x + 10, y - 6, 26, 16, 2);
    g.fillStyle(0x94a3b8, 1).fillRoundedRect(x + 52, y - 10, 12, 20, 3);

    this.labelProp(x, y + 50, 'meeting');
    this.spots.push(
      { x: x - 76, y: y - 34, sit: true, takenBy: null },
      { x: x + 76, y: y - 34, sit: true, takenBy: null },
      { x: x - 76, y: y + 34, sit: true, takenBy: null },
      { x: x + 76, y: y + 34, sit: true, takenBy: null },
    );
  }

  /**
   * The one piece of kit that says what this business actually does. Same
   * ten desks everywhere; this is what makes a salon's floor not an IT
   * shop's.
   */
  drawFeature(t) {
    const g = this.keep(this.add.graphics()).setDepth(DEPTH.furniture);
    const x = 70;
    const y = 452;

    if (t.feature === 'workbench') {
      // A bench with a pegboard of tools over it.
      this.box(g, x - 44, y - 34, 106, 26, 14, FINISH.walnut, FINISH.walnutDark, 3);
      g.fillStyle(0x3f4a5c, 1).fillRoundedRect(x - 42, y - 66, 102, 30, 3);
      g.fillStyle(0x2c3545, 0.5);
      for (let i = 0; i < 10; i += 1) g.fillCircle(x - 36 + i * 11, y - 60, 1.4);
      for (let i = 0; i < 5; i += 1) {
        g.fillStyle(i % 2 ? t.accent : 0xb9c0cb, 0.9)
          .fillRoundedRect(x - 36 + i * 21, y - 58, 5, 18, 2);
      }
      g.fillStyle(0x64748b, 1).fillRoundedRect(x - 28, y - 30, 24, 9, 2);
      g.fillStyle(t.accent, 0.9).fillRoundedRect(x + 4, y - 28, 18, 6, 2);
      this.labelProp(x + 8, y + 6, 'workbench');
    } else if (t.feature === 'rack') {
      // A short server rack with its lights on.
      this.box(g, x - 34, y - 56, 78, 34, 42, 0x1f2937, 0x111827, 3);
      for (let i = 0; i < 5; i += 1) {
        g.fillStyle(0x0f172a, 1).fillRoundedRect(x - 28, y - 50 + i * 7, 66, 5, 1);
        g.fillStyle(i % 2 ? 0x34d399 : t.accent, 0.9).fillCircle(x + 32, y - 48 + i * 7, 1.8);
      }
      this.labelProp(x + 5, y + 2, 'rack');
    } else if (t.feature === 'shelving') {
      // Stock shelving with boxes on it.
      this.box(g, x - 50, y - 54, 120, 32, 30, FINISH.cabinet, FINISH.cabinetDark, 2);
      for (let r = 0; r < 2; r += 1) {
        for (let i = 0; i < 4; i += 1) {
          g.fillStyle(i % 2 ? FINISH.walnut : t.accent, 0.75)
            .fillRoundedRect(x - 44 + i * 29, y - 50 + r * 15, 24, 11, 2);
        }
      }
      this.labelProp(x + 10, y + 2, 'stock');
    } else if (t.feature === 'prep') {
      // A stainless prep counter with a hob.
      this.box(g, x - 48, y - 44, 116, 30, 16, 0xcbd5e1, 0x94a3b8, 3);
      g.fillStyle(0x334155, 1).fillRoundedRect(x - 40, y - 40, 40, 22, 3);
      for (const [dx, dy] of [[-32, -34], [-12, -34], [-32, -26], [-12, -26]]) {
        g.fillStyle(t.accent, 0.8).fillCircle(x + dx, y + dy, 4);
      }
      g.fillStyle(0x94a3b8, 1).fillRoundedRect(x + 12, y - 38, 34, 18, 3);
      this.labelProp(x + 10, y + 2, 'prep');
    } else if (t.feature === 'plans') {
      // A plan table with rolled drawings beside it.
      this.box(g, x - 50, y - 46, 118, 34, 14, FINISH.walnut, FINISH.walnutDark, 2);
      g.fillStyle(0xe2e8f0, 0.9).fillRoundedRect(x - 42, y - 42, 70, 26, 2);
      g.lineStyle(1, 0x64748b, 0.8);
      g.strokeRect(x - 36, y - 37, 30, 16).strokeRect(x - 2, y - 37, 22, 16);
      g.lineStyle(0, 0, 0);
      for (let i = 0; i < 3; i += 1) {
        g.fillStyle(0xcbd5e1, 1).fillRoundedRect(x + 40 + i * 9, y - 42, 7, 28, 3);
      }
      this.labelProp(x + 10, y + 2, 'plans');
    } else if (t.feature === 'pallets') {
      // Stacked pallets and a trolley.
      for (let i = 0; i < 3; i += 1) {
        this.box(g, x - 40 + i * 4, y - 30 - i * 10, 74, 22, 10,
          FINISH.walnut, FINISH.walnutDark, 2);
      }
      g.fillStyle(t.accent, 0.8).fillRoundedRect(x - 20, y - 56, 32, 14, 2);
      g.fillStyle(0x475569, 1).fillRoundedRect(x + 46, y - 36, 6, 34, 2);
      this.labelProp(x + 10, y + 4, 'pallets');
    } else if (t.feature === 'mirror') {
      // A styling station: mirror, chair, trolley.
      g.fillStyle(FINISH.brass, 1).fillRoundedRect(x - 36, y - 78, 72, 54, 26);
      g.fillStyle(0x334155, 1).fillRoundedRect(x - 32, y - 74, 64, 46, 22);
      g.fillStyle(0xffffff, 0.12).fillRoundedRect(x - 24, y - 68, 22, 34, 11);
      this.box(g, x - 40, y - 24, 80, 24, 14, FINISH.counter, FINISH.counterDark, 3);
      g.fillStyle(t.accent, 0.8).fillCircle(x - 20, y - 16, 4);
      g.fillStyle(0xcbd5e1, 1).fillCircle(x, y - 16, 4);
      this.labelProp(x + 6, y + 6, 'styling');
    } else {
      // A bookcase: the plain, respectable default.
      this.box(g, x - 46, y - 56, 108, 32, 34, FINISH.walnut, FINISH.walnutDark, 2);
      for (let r = 0; r < 2; r += 1) {
        for (let i = 0; i < 9; i += 1) {
          g.fillStyle(i % 3 === 0 ? t.accent : i % 3 === 1 ? 0x94a3b8 : FINISH.leather, 0.8)
            .fillRoundedRect(x - 40 + i * 11, y - 52 + r * 15, 7, 12, 1);
        }
      }
      this.labelProp(x + 8, y + 2, 'library');
    }

    this.spots.push(
      { x: x - 60, y: y + 10, sit: false, takenBy: null },
      { x: x + 70, y: y + 10, sit: false, takenBy: null },
    );
  }

  /** Planters down the middle and trees in the corners. */
  drawGreenery(t) {
    const g = this.keep(this.add.graphics()).setDepth(DEPTH.furniture);

    // A long planter box between the two desk rows, which is also what stops
    // the middle of the room looking like a corridor.
    const px = WIDTH / 2 - 230;
    this.box(g, px, 436, 70, 22, 12, FINISH.pot, FINISH.potDark, 4);
    this.plant(g, px + 20, 444, 0.6);
    this.plant(g, px + 50, 446, 0.5, true);
    this.box(g, WIDTH / 2 + 160, 436, 70, 22, 12, FINISH.pot, FINISH.potDark, 4);
    this.plant(g, WIDTH / 2 + 180, 444, 0.55, true);
    this.plant(g, WIDTH / 2 + 210, 446, 0.62);

    // Corner trees, bigger than anything on a desk.
    this.plant(g, 46, HEIGHT - 54, 1.5);
    this.plant(g, WIDTH - 46, HEIGHT - 54, 1.4, true);
    this.plant(g, WIDTH - 44, 418, 1.25);

    // A water point, because people walk to one.
    const wx = WIDTH - 120;
    const wy = 452;
    this.box(g, wx - 12, wy - 10, 26, 22, 24, 0xe2e8f0, 0xcbd5e1, 3);
    g.fillStyle(t.sky, 0.75).fillRoundedRect(wx - 9, wy - 28, 20, 20, 5);
    this.labelProp(wx, wy + 22, 'water');
    this.spots.push(
      { x: wx - 46, y: wy + 8, sit: false, takenBy: null },
      { x: wx + 46, y: wy + 8, sit: false, takenBy: null },
    );
  }

  zoneLabel(x, y, text) {
    this.keep(this.add.text(x, y, text, {
      fontFamily: 'ui-monospace, monospace', fontSize: '10px',
      color: this.theme.labelInk, letterSpacing: 2,
    })).setDepth(DEPTH.labels);
  }

  labelProp(x, y, text) {
    this.keep(this.add.text(x, y, text, {
      fontFamily: 'ui-monospace, monospace', fontSize: '9px',
      color: this.theme.labelInk,
    })).setOrigin(0.5).setDepth(DEPTH.labels);
  }

  /**
   * A desk: a rug, the desk itself with a front face, a monitor on a stand,
   * the things that are actually on a desk, and the chair its agent works
   * from. The agent is drawn on top of the chair.
   */
  drawDesk(x, y) {
    const t = this.theme;
    const g = this.keep(this.add.graphics()).setDepth(DEPTH.furniture);

    // No rug under a desk: on boards it only reads as a grey slab. A soft
    // pool of shadow is what actually lifts the furniture off the floor.
    g.fillStyle(0x000000, 0.055).fillEllipse(x + 3, y + 16, 164, 62);

    // Desk: top face, front face, and a shadow under it.
    g.fillStyle(0x000000, 0.22).fillRoundedRect(x - 64, y + 2, 132, 22, 4);
    g.fillStyle(t.deskDark, 1).fillRoundedRect(x - 66, y - 2, 132, 20, 4);
    g.fillStyle(t.desk, 1).fillRoundedRect(x - 66, y - 16, 132, 22, 4);
    g.fillStyle(0xffffff, 0.06).fillRect(x - 60, y - 13, 60, 3);
    // A pedestal of drawers under one end.
    g.fillStyle(t.deskDark, 1).fillRoundedRect(x + 26, y + 2, 38, 26, 3);
    g.fillStyle(FINISH.brassDim, 0.8).fillRect(x + 34, y + 9, 22, 2).fillRect(x + 34, y + 19, 22, 2);

    // Monitor: panel, screen, stand.
    g.fillStyle(0x0a111d, 1).fillRoundedRect(x - 26, y - 46, 52, 28, 3);
    g.fillStyle(t.screen, 0.75).fillRoundedRect(x - 22, y - 42, 44, 19, 2);
    g.fillStyle(0xffffff, 0.18).fillRect(x - 19, y - 39, 22, 3);
    g.fillStyle(0xffffff, 0.1).fillRect(x - 19, y - 33, 32, 2);
    g.fillStyle(0xffffff, 0.1).fillRect(x - 19, y - 28, 26, 2);
    g.fillStyle(0x1f2937, 1).fillRect(x - 4, y - 19, 8, 4);
    g.fillStyle(0x334155, 1).fillRoundedRect(x - 12, y - 16, 24, 3, 1);

    // Keyboard, notepad, a mug, a small plant.
    g.fillStyle(0x2c3a52, 1).fillRoundedRect(x - 18, y - 9, 34, 8, 2);
    g.fillStyle(0xe2e8f0, 0.9).fillRoundedRect(x - 46, y - 9, 16, 11, 1.5);
    g.fillStyle(t.accent, 0.85).fillCircle(x - 54, y - 2, 4.5);
    g.fillStyle(0xffffff, 0.25).fillCircle(x - 55, y - 3.5, 1.6);
    this.plant(g, x + 48, y - 6, 0.34);

    // Task chair seen from above: seat, back, five-star base.
    g.fillStyle(0x000000, 0.2).fillEllipse(x + 2, y + 44, 36, 16);
    g.fillStyle(FINISH.chairDark, 1).fillEllipse(x, y + 42, 34, 15);
    g.fillStyle(FINISH.chair, 1).fillEllipse(x, y + 39, 34, 15);
    g.fillStyle(FINISH.chairDark, 1).fillRoundedRect(x - 14, y + 44, 28, 10, 4);
    g.fillStyle(0x475569, 1);
    for (let i = 0; i < 5; i += 1) {
      const a = (i / 5) * Math.PI * 2 + 0.3;
      g.fillRect(x - 1.5 + Math.cos(a) * 9, y + 52 + Math.sin(a) * 5, 3, 3);
    }
    // Handed back so the desk goes when its agent does — otherwise switching
    // floors would leave the old office's furniture behind.
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
    const deskArt = this.drawDesk(desk.x, desk.y);
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
      id: agent.id, data: agent, body, label, roleLabel, statusText, deskArt,
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
    person.deskArt?.destroy();
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

export default function VirtualOfficeCanvas({ agents, floor, onSelectAgent }) {
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
      backgroundColor: '#1b2334',
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

  // Which office this is, then who is in it. The order matters: the room is
  // rebuilt first so the people are placed in the room they are actually in.
  useEffect(() => {
    sceneRef.current?.setFloor(floor ?? null);
    sceneRef.current?.syncAgents(agents ?? []);
  }, [agents, floor]);

  // On a phone, fitting 1100px of floor into 390 leaves the nameplates
  // unreadable, so the floor keeps a usable width and the strip scrolls
  // sideways instead. The page itself never overflows — the scrolling happens
  // inside this box.
  return (
    <div className="w-full overflow-x-auto overflow-y-hidden rounded-xl border border-slate-800">
      <div ref={hostRef} className="min-w-[680px] sm:min-w-0" />
    </div>
  );
}
