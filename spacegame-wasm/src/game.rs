//! Game state — ingests authoritative `Snapshot`s from the mesh, tracks the local player, follows the
//! camera, computes the interest set (which sectors to subscribe to), and builds the input message to
//! publish. All world types/maths come from the `spacegame` SDK, so the client and host agree exactly.

use std::collections::HashMap;

use spacegame::client::ClientProfile;
use spacegame::shard::SectorId;
use spacegame::sim::SECTOR_SIZE;
use spacegame::wire::{topics, ClientMsg, ShipView, Snapshot};

use crate::input::InputState;

/// The local view of the world.
pub struct Game {
    /// Our authenticated NodeId — the unspoofable player id.
    pub me: String,
    pub profile: ClientProfile,
    /// Latest snapshot per sector token (interest-scoped).
    pub sectors: HashMap<String, Snapshot>,
    /// Our ship's last known world position + heading (for the camera + aim).
    pub my_x: f32,
    pub my_y: f32,
    pub my_a: f32,
    pub alive: bool,
    /// The sector token our ship is in (where we publish input).
    pub cur_sector: String,
    /// Camera centre (world units) — eased toward the ship.
    pub cam_x: f32,
    pub cam_y: f32,
    /// The live ruleset version the host last reported (a rise ⇒ hot reload happened).
    pub ruleset_version: u64,
    /// Topics we've already subscribed to.
    subscribed: std::collections::HashSet<String>,
}

impl Game {
    pub fn new(me: String, profile: ClientProfile) -> Self {
        Game {
            me,
            profile,
            sectors: HashMap::new(),
            my_x: SECTOR_SIZE * 0.5,
            my_y: SECTOR_SIZE * 0.5,
            my_a: 0.0,
            alive: false,
            cur_sector: "0_0".to_string(),
            cam_x: SECTOR_SIZE * 0.5,
            cam_y: SECTOR_SIZE * 0.5,
            ruleset_version: 0,
            subscribed: std::collections::HashSet::new(),
        }
    }

    /// Apply one inbound snapshot.
    pub fn ingest(&mut self, topic: String, snap: Snapshot) {
        self.ruleset_version = self.ruleset_version.max(snap.ruleset);
        // Find our ship in this sector to update position/camera/current-sector.
        if let Some(me) = snap.ships.iter().find(|s| s.id == self.me) {
            // Convert sector-local coords to world coords using the snapshot's sector.
            if let Some(sid) = SectorId::parse(&snap.sector) {
                self.my_x = sid.sx as f32 * SECTOR_SIZE + me.x as f32;
                self.my_y = sid.sy as f32 * SECTOR_SIZE + me.y as f32;
            } else {
                self.my_x = me.x as f32;
                self.my_y = me.y as f32;
            }
            self.my_a = me.a as f32 / 100.0;
            self.alive = me.alive;
            self.cur_sector = snap.sector.clone();
        }
        self.sectors.insert(topic, snap);
    }

    /// Ease the camera toward the ship; prune stale far sectors.
    pub fn tick_camera(&mut self) {
        self.cam_x += (self.my_x - self.cam_x) * 0.18;
        self.cam_y += (self.my_y - self.cam_y) * 0.18;
    }

    /// The sectors we should be subscribed to right now (interest management). Returns any that are
    /// newly needed since last call (the caller subscribes to them).
    pub fn new_subscriptions(&mut self) -> Vec<String> {
        let want = self.profile.interest_set(self.my_x, self.my_y);
        let mut fresh = Vec::new();
        for s in want {
            let t = topics::state(&s.token());
            if self.subscribed.insert(t.clone()) {
                fresh.push(t);
            }
        }
        fresh
    }

    /// Build the input message to publish this frame from the keyboard/mouse state, and the topic to
    /// publish it on. Aim is the world-space angle from our ship to the mouse cursor.
    pub fn build_input(&self, input: &InputState, canvas_w: f32, canvas_h: f32, scale: f32) -> (String, ClientMsg) {
        // Mouse is in screen pixels; the ship is at screen centre-ish (camera follows it). Convert the
        // mouse to a world-relative direction.
        let dx = (input.mouse_x - canvas_w * 0.5) / scale + (self.cam_x - self.my_x);
        let dy = (input.mouse_y - canvas_h * 0.5) / scale + (self.cam_y - self.my_y);
        let aim = dy.atan2(dx);
        let turn = if input.left { -1 } else if input.right { 1 } else { 0 };
        let msg = ClientMsg::Input {
            thrust: input.thrust,
            turn,
            fire: input.fire,
            aim: Some(aim),
            name: None,
        };
        let in_topic = topics::input(&self.cur_sector);
        (in_topic, msg)
    }

    /// Every ship across the interest-scoped snapshots, in **world** coordinates, tagged friend/foe.
    pub fn visible_ships(&self) -> Vec<RenderShip> {
        let mut out = Vec::new();
        for snap in self.sectors.values() {
            let sid = SectorId::parse(&snap.sector).unwrap_or(SectorId::new(0, 0));
            let (ox, oy) = (sid.sx as f32 * SECTOR_SIZE, sid.sy as f32 * SECTOR_SIZE);
            for s in &snap.ships {
                out.push(RenderShip::from_view(s, ox, oy, &self.me));
            }
        }
        out
    }

    /// Live projectiles + beams + explosions across the interest set, in world coordinates.
    pub fn visible_fx(&self) -> Fx {
        let mut fx = Fx::default();
        for snap in self.sectors.values() {
            let sid = SectorId::parse(&snap.sector).unwrap_or(SectorId::new(0, 0));
            let (ox, oy) = (sid.sx as f32 * SECTOR_SIZE, sid.sy as f32 * SECTOR_SIZE);
            for b in &snap.bullets {
                fx.bullets.push([ox + b.x as f32, oy + b.y as f32, b.hue as f32, if b.homing { 1.0 } else { 0.0 }]);
            }
            for bm in &snap.beams {
                fx.beams.push([ox + bm.x0 as f32, oy + bm.y0 as f32, ox + bm.x1 as f32, oy + bm.y1 as f32, bm.hue as f32, bm.kind as f32]);
            }
            for e in &snap.explosions {
                fx.explosions.push([ox + e.x as f32, oy + e.y as f32, e.r as f32, e.hue as f32]);
            }
            for d in &snap.debris {
                fx.debris.push([ox + d.x as f32, oy + d.y as f32, d.r as f32, (d.a as f32) / 100.0]);
            }
        }
        fx
    }
}

/// A ship reduced to what the renderer needs, in world coords, with a friend/foe/self tag.
pub struct RenderShip {
    pub x: f32,
    pub y: f32,
    pub a: f32,
    pub hue: f32,
    pub hp_frac: f32,
    /// 0 = enemy player, 1 = me, 2 = my fleet NPC, 3 = other player's NPC.
    pub tag: u8,
    pub alive: bool,
}

impl RenderShip {
    fn from_view(s: &ShipView, ox: f32, oy: f32, me: &str) -> RenderShip {
        let is_npc = s.owner.is_some();
        let mine = s.owner.as_deref() == Some(me) || s.id == me;
        let tag = if s.id == me {
            1
        } else if is_npc && mine {
            2
        } else if is_npc {
            3
        } else {
            0
        };
        RenderShip {
            x: ox + s.x as f32,
            y: oy + s.y as f32,
            a: s.a as f32 / 100.0,
            hue: s.hue as f32,
            hp_frac: if s.max_hp > 0 { (s.hp as f32 / s.max_hp as f32).clamp(0.0, 1.0) } else { 0.0 },
            tag,
            alive: s.alive,
        }
    }
}

/// Transient effects to draw this frame.
#[derive(Default)]
pub struct Fx {
    /// `[x, y, hue, homing]`
    pub bullets: Vec<[f32; 4]>,
    /// `[x0, y0, x1, y1, hue, kind]`
    pub beams: Vec<[f32; 6]>,
    /// `[x, y, r, hue]`
    pub explosions: Vec<[f32; 4]>,
    /// `[x, y, r, angle]`
    pub debris: Vec<[f32; 4]>,
}
