// Phaser owns this canvas. React mounts it once and never re-renders it —
// data goes in through scene.syncAgents(agents). To add a visual state,
// extend applyStatus().
import { useEffect, useRef } from 'react';
import Phaser from 'phaser';

const WIDTH = 960;
const HEIGHT = 620;

// avatar_sprite_key only selects a colour; avatars are drawn from primitives.
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

const STATUS_STYLE = {
  IDLE: { ring: 0x475569, label: 'Idle', text: '#94a3b8' },
  WORKING: { ring: 0x22d3ee, label: 'Working', text: '#67e8f9' },
  AWAITING_APPROVAL: { ring: 0xfbbf24, label: 'Needs you', text: '#fcd34d' },
  PAUSED: { ring: 0xef4444, label: 'Paused', text: '#fca5a5' },
};

class OfficeScene extends Phaser.Scene {
  constructor() {
    super('office');
    this.desks = new Map();   // agent id -> { container, parts }
    this.pending = [];        // agents handed over before create() ran
    this.onSelect = null;
  }

  create() {
    this.drawFloor();
    this.ready = true;
    if (this.pending.length) this.syncAgents(this.pending);
    this.pending = [];
  }

  drawFloor() {
    const g = this.add.graphics();
    g.fillStyle(0x0f172a, 1).fillRect(0, 0, WIDTH, HEIGHT);

    // Floor tiles.
    g.lineStyle(1, 0x1e293b, 1);
    for (let x = 0; x <= WIDTH; x += 40) g.lineBetween(x, 0, x, HEIGHT);
    for (let y = 0; y <= HEIGHT; y += 40) g.lineBetween(0, y, WIDTH, y);

    // Walls and a reception counter, so the floor reads as a room.
    g.lineStyle(3, 0x334155, 1).strokeRect(12, 56, WIDTH - 24, HEIGHT - 68);
    g.fillStyle(0x1e293b, 1).fillRoundedRect(12, 12, WIDTH - 24, 36, 8);

    this.add.text(28, 22, 'VIRTUAL OFFICE — FLOOR 1', {
      fontFamily: 'ui-monospace, monospace', fontSize: '15px', color: '#64748b',
    });
  }

  /** Called by React whenever the agent list changes. */
  syncAgents(agents) {
    if (!this.ready) { this.pending = agents; return; }

    const seen = new Set();
    for (const agent of agents) {
      seen.add(agent.id);
      const desk = this.desks.get(agent.id) ?? this.createDesk(agent);
      desk.data = agent;
      desk.nameText.setText(agent.name);
      desk.deptText.setText(agent.department);
      this.applyStatus(desk, agent);
    }
    for (const [id, desk] of this.desks) {
      if (!seen.has(id)) { desk.container.destroy(); this.desks.delete(id); }
    }
  }

  createDesk(agent) {
    const colour = SPRITE_COLOURS[agent.avatar_sprite_key] ?? SPRITE_COLOURS.staff_default;
    const container = this.add.container(agent.desk_x, agent.desk_y);

    const deskTop = this.add.rectangle(0, 34, 128, 16, 0x334155).setOrigin(0.5);
    const ring = this.add.circle(0, -6, 30, 0x000000, 0).setStrokeStyle(3, 0x475569);
    const body = this.add.circle(0, 6, 15, colour);
    const head = this.add.circle(0, -16, 11, colour);
    const badge = this.add.circle(20, -26, 7, 0x475569);

    const nameText = this.add.text(0, 48, agent.name, {
      fontFamily: 'ui-sans-serif, system-ui', fontSize: '14px', color: '#e2e8f0',
    }).setOrigin(0.5);
    const deptText = this.add.text(0, 65, agent.department, {
      fontFamily: 'ui-monospace, monospace', fontSize: '11px', color: '#64748b',
    }).setOrigin(0.5);
    const statusText = this.add.text(0, -48, '', {
      fontFamily: 'ui-monospace, monospace', fontSize: '11px', color: '#94a3b8',
    }).setOrigin(0.5);

    container.add([deskTop, ring, body, head, badge, statusText, nameText, deptText]);
    container.setSize(140, 130);
    container.setInteractive({ useHandCursor: true });
    container.on('pointerover', () => container.setScale(1.05));
    container.on('pointerout', () => container.setScale(1));
    container.on('pointerdown', () => this.onSelect?.(this.desks.get(agent.id)?.data ?? agent));

    const desk = { container, ring, body, head, badge, nameText, deptText, statusText, data: agent };
    this.desks.set(agent.id, desk);
    return desk;
  }

  /** One place decides what a status looks like. */
  applyStatus(desk, agent) {
    const style = STATUS_STYLE[agent.status] ?? STATUS_STYLE.IDLE;
    desk.ring.setStrokeStyle(3, style.ring);
    desk.badge.setFillStyle(style.ring);
    desk.statusText.setText(style.label).setColor(style.text);
    desk.container.setAlpha(agent.status === 'PAUSED' ? 0.55 : 1);

    this.tweens.killTweensOf(desk.badge);
    desk.badge.setScale(1);
    if (agent.status === 'WORKING' || agent.status === 'AWAITING_APPROVAL') {
      this.tweens.add({
        targets: desk.badge,
        scale: agent.status === 'AWAITING_APPROVAL' ? 1.6 : 1.3,
        duration: agent.status === 'AWAITING_APPROVAL' ? 550 : 900,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      });
    }
  }
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
