I have everything I need. Here is the research output.

---

# "A Torrent Client, but for Compute" — UX Research for the CE Hosting Dashboard

Research synthesis of donate/share/host desktop-app UX, plus a concrete screen and feature inventory for a **"Host my machine on CE"** dashboard.

---

## Part 1 — Reference apps: what they show and why it works

### 1. BitTorrent clients (qBittorrent / Transmission / Deluge)

This is the closest mental model for CE: a long-running background daemon that **gives and takes a shared resource**, surfaced as a list of live work items plus global rates.

**Information hierarchy (top → bottom):**

| Layer | Element | Notes for CE |
|---|---|---|
| **Global status bar (always visible, bottom)** | ↓ down speed, ↑ up speed, DHT node count, connection status (green/red), session ratio, free disk | The "vital signs." Single most-glanced-at strip. |
| **Per-torrent table (the core)** | Name, size, status (seeding/downloading/stalled/queued), progress %, ↓/↑ speed, seeds/peers, **ratio**, ETA, added-on, category/tags | One row per unit of work. Sortable, filterable. |
| **Left sidebar filters** | All / Downloading / Seeding / Completed / Active / Inactive / Stalled / by category / by tracker | State-based and tag-based slicing of the same rows. |
| **Per-item detail tabs (bottom panel)** | General, Trackers, **Peers** (IP, client, country flag, up/down per peer), Content (file tree), Speed graph | Drill-down without leaving the list. |
| **Toolbar** | Add, pause/resume all, **set global rate limits**, search | Bulk control. |

**Throttle / scheduler patterns (directly transferable):**
- **Global + per-torrent speed caps** (KB/s up and down). Right-click a row → "Limit upload rate."
- **Alternative speed limits ("Speed Limits Mode" / turtle icon)** — a one-click toggle to a slower profile, *plus* a **scheduler** to auto-switch (e.g. throttle 8am–6pm, full speed overnight). Transmission's turtle + qBittorrent's scheduler are the gold standard here.
- **Seeding limits**: stop seeding at ratio X or after N minutes. CE analog: "stop hosting after I've earned X / after N hours / when ratio ≥ X."
- **Ratio** is the single most culturally loaded number — it frames the whole give/take relationship and creates a soft social obligation to contribute. **CE should adopt ratio as a first-class metric** (credits earned hosting ÷ credits spent on jobs).

**Why it works:** zero-config glanceability. A live list of work + two big rate numbers + a ratio. Everything else is progressive disclosure.

---

### 2. Folding@home / BOINC (donate compute — points, teams, contribution)

These optimize for **motivation of a donor**, not management of a business. The hosting feeling is "I'm contributing to something."

**Folding@home elements:**
- Big **donate/pause** toggle and a **Power slider: Light / Medium / Full** (maps to % of CPU/GPU used) — dead-simple throttle, no KB/s.
- **Points** earned, **Work Units (WUs) completed**, current project/disease the WU belongs to (gives *meaning* to the work).
- **Team** name + rank; global/personal leaderboards.
- "What am I folding?" — shows the *purpose* of the current job.

**BOINC elements** (confirmed from docs):
- **Tasks tab**: per-task rows — project, application, progress %, status (running/ready/suspended), elapsed/remaining time, deadline.
- **Credit / RAC (Recent Average Credit)** — a *decaying* average that rewards sustained contribution over lifetime totals. A smart metric: it shows "are you contributing *lately*," not just a lifetime number.
- **Computing preferences** (the throttle panel): use at most N% of CPUs, use at most N% of CPU *time* (thermal throttle), max download/upload rate KB/s, **only when idle / only between hours X–Y / suspend when on battery / suspend when CPU usage above N%**, disk and RAM caps.
- **Projects tab**: attach/detach projects, per-project resource share, suspend/resume.

**Transferable to CE:**
- A **Light/Medium/Full power preset** as the default throttle UI (expose raw caps only in "Advanced").
- **RAC-style "recent earnings rate"** alongside lifetime totals.
- **Conditional hosting rules**: only when idle, only on AC power, only between hours, pause if my own CPU load is high. These make "always-on background donation" feel safe.
- **Meaning/purpose** line per job ("running an inference task for node X") — humanizes otherwise-opaque compute.

---

### 3. Akash / Render provider dashboards (earning compute — the business view)

These treat the machine as **revenue infrastructure**. Confirmed (Akash Provider Console, 2025): the dashboard centers on **revenue earned, leases, and used/available resources by type (GPU, CPU, memory, storage), plus uptime and utilization**. A Provider Earnings API exposes revenue + utilization with daily/weekly/monthly filters.

**Elements:**
- **Earnings**: total revenue, revenue over time (daily/weekly/monthly chart), pending vs. settled.
- **Active leases/workloads** table: tenant, resources allocated, price, duration, status.
- **Capacity gauges**: used vs. available per resource type (GPU/CPU/RAM/storage/bandwidth) — usually horizontal bars or donuts.
- **Uptime / availability %** and **bid/win stats** (how often you're chosen).
- **Pricing controls**: set your price per resource unit; this is the provider's lever on demand.

**Render Network adds:** GPU tier/benchmark score, **reputation/reliability tier** (gates access to higher-value jobs), job queue, OctaneBench-style score.

**Transferable to CE:**
- **Earnings is the hero metric** for the "earn" framing — total + over-time chart + recent rate.
- **Capacity utilization gauges** per resource type (you've offered N cores / M GB; X% is in use right now).
- **Pricing / minimum-bid control** is the provider's main agency lever.
- **Reputation tier** as a visible, earned status that unlocks better-paying work — maps cleanly to CE's trust gradient.

---

### 4. Tailscale device UI (the fleet / peer view, done calmly)

Tailscale's "Machines" page is the benchmark for **presenting a fleet of your own + connected nodes** without networking jargon.

**Elements:**
- **Machines list**: name, OS icon, **CE/Tailscale IP**, **owner/tag**, **last seen** (relative time, e.g. "2 min ago"), **connection status dot** (green=online/direct, yellow=relayed, grey=offline).
- **Direct vs. relayed** indicator — tells you connection *quality* at a glance (maps perfectly to CE's DCUtR-direct vs. relay-circuit distinction).
- **Expiry / key health** warnings inline on the row.
- Per-device detail: routes, ACL tags, last handshake, version, **expire/disable/remove** actions.
- **This device** is pinned/highlighted distinctly from peers.
- Calm, low-saturation palette; status conveyed by small colored dots, not loud banners.

**Transferable to CE:**
- A **peers/devices page** with status dots, last-seen, and **direct-vs-relayed connection quality**.
- "**This machine**" visually distinguished from the rest of the mesh.
- Capability/grant status shown inline (who you've granted, expiry) — CE's capability tokens map onto Tailscale's ACL-tag-per-device display.

---

## Part 2 — Synthesis: the cross-cutting UI patterns to steal

1. **Global vital-signs strip, always visible** (torrent status bar): earn rate, spend rate, mesh-peer count, online/offline dot, **ratio**, today's earnings.
2. **One row per unit of work** (torrents/BOINC tasks/Akash leases): the central table is "jobs running on my machine."
3. **State filters in a left rail**: Running / Queued / Completed / Failed / by peer.
4. **Progressive disclosure**: list → select row → detail panel (no page nav).
5. **One big toggle + a 3-step power preset** (F@h): hosting On/Off, Light/Medium/Full — raw caps behind "Advanced."
6. **A turtle/throttle quick-toggle + a scheduler** (Transmission/qBittorrent): instant slow-mode and time-based auto-switching.
7. **Ratio + recent-rate metrics** (torrent ratio + BOINC RAC): reward *sustained recent* contribution, not just lifetime totals.
8. **Meaning per job** (F@h): humanize the work ("inference for peer 7f3a…").
9. **Calm status dots, direct-vs-relayed** (Tailscale): connection quality without jargon.
10. **Earned reputation tier that unlocks better jobs** (Render): visible status tied to CE's trust gradient.

---

## Part 3 — Proposed CE Hosting Dashboard: screen & feature inventory

> Framing: **"Donate compute, earn credits."** The dashboard is a torrent client where the "torrents" are jobs running on your machine, "upload" is compute you donate, "download" is compute you consume, and **ratio** is your give/take balance.

### Persistent chrome (all screens)

- **Global vital-signs bar (bottom, always on):**
  `● Online (3 mesh peers, 1 direct / 2 relayed)` · `▲ earning 1,240 cr/hr` · `▼ spending 0 cr/hr` · `Ratio 4.7` · `Today: +9,800 cr` · `Height 184,221`
- **Master toggle (top-left):** big **Hosting: ON/OFF** switch + **Power preset: Light · Medium · Full** segmented control.
- **Turtle/Eco quick-toggle** next to it (one-click throttle to a low-impact profile).

---

### Screen 1 — **Overview / Dashboard** (default landing)

The "am I earning, is it healthy?" glance.

- **Hero earnings card:** total balance (credits), **earnings-over-time chart** (toggle: today / 7d / 30d), and **recent earn rate** (RAC-style decaying average).
- **Ratio gauge:** credits earned hosting ÷ credits spent. The signature CE number.
- **Live capacity gauges** (one bar each): **CPU**, **GPU**, **RAM**, **Disk**, **Bandwidth** — "offered vs. in-use right now."
- **Mini job list:** top 3–5 active jobs (full list on Screen 2).
- **Uptime card:** current session uptime, 30-day availability %, longest streak.
- **Reputation / trust tier badge:** current tier + "what unlocks at the next tier."
- **Mesh health:** peer count, direct vs. relayed split, relay status.

### Screen 2 — **Jobs** (the core table — the "torrent list")

One row per cell/job running on or dispatched from this machine.

- **Columns:** Job ID (short hash) · **Purpose** ("inference · peer 7f3a…") · Image/cell · Status (Running / Queued / Settling / Completed / Failed) · CPU/GPU/RAM used · **Elapsed** · **Earned so far** (cr) · Rate (cr/min) · Peer (counterparty) · Connection (direct/relayed dot).
- **Left-rail filters:** All · Running · Queued · Completed · Failed · Hosting-for-others · My-jobs-elsewhere · by peer.
- **Bulk toolbar:** pause new bids · drain (finish current, accept no new) · kill-all.
- **Row context menu:** view logs · **force-stop (kill)** · set per-job priority · block this peer.
- **Detail panel (select a row):** tabs — **General** (full IDs, capability/grant used, escrow/settlement state) · **Resources** (live CPU/GPU/RAM/net graphs) · **Logs** (streamed) · **Payment** (bid, heartbeats, settlement, channel receipts) · **Peer** (counterparty node, history, reputation).

### Screen 3 — **Resources & Limits** (the throttle/scheduler panel)

BOINC's computing preferences, modernized.

- **Power presets** (Light/Medium/Full) expand to raw caps:
  - Max **CPU cores** / max **% CPU** to offer; **GPU** offer on/off + which GPUs; max **RAM**; max **disk**; max **up/down bandwidth (MB/s)**.
- **Conditional hosting rules (toggles):** only when idle · only on AC power · suspend if my own CPU load > N% · suspend when on metered network · keep N cores reserved for me · thermal cap (pause above N°C).
- **Scheduler:** weekly grid — full-speed / throttled / off per hour block (the qBittorrent scheduler pattern). "Throttle 9–17 weekdays, full overnight."
- **Stop conditions (seeding-limit analog):** stop hosting at ratio ≥ X · after earning N credits · after N hours.
- **Pricing controls:** minimum bid / reserve price per resource-unit; auto-accept threshold; **verification dial** (how much job verification to require, gating which work you take).

### Screen 4 — **Peers / Mesh** (Tailscale-style)

- **Devices list:** "**This machine**" pinned at top, then mesh peers — name/node-id-short · OS · status dot · **direct vs. relayed** · last-seen · jobs exchanged · **per-peer ratio with you** · reputation.
- **Per-peer detail:** interaction history (CE `/history`), capabilities granted to/from them + expiry, block/allow, relay path.
- **My grants & capabilities:** who I've granted what (abilities, expiry), with **revoke** action; capabilities I hold for others' machines.
- **Mesh diagnostics:** bootstrap/relay reachability, NAT status (DCUtR success), my advertised multiaddrs.

### Screen 5 — **Earnings / Wallet / History**

- Balance, **earnings vs. spend over time** (stacked), ratio trend.
- **Ledger:** transactions (UptimeReward, JobSettle in/out, Heartbeats, Transfers, channel closes) — filterable, exportable (the Akash Earnings-API analog: daily/weekly/monthly).
- **Per-job economics:** what each completed job paid.
- Transfer/withdraw action; open **payment channels** view (capacity locked, receipts).

### Screen 6 — **Activity feed / Notifications** (optional but high-value)

- Chronological stream: "Accepted job from peer X (+120 cr)," "Job settled (+1,450 cr)," "Reached trust tier 3," "Relay reconnected," "Throttled by schedule." — gives the always-on background daemon a sense of life and trust.

---

## Part 4 — Information-hierarchy summary (the one-screen answer)

For a **"host my machine on CE"** dashboard, the must-have elements, in priority order:

1. **Hosting ON/OFF + power preset** (Light/Medium/Full) — the one control that matters.
2. **Earnings** — total, over-time chart, and a **recent earn rate** (RAC-style).
3. **Ratio** — earned-hosting ÷ spent — the give/take signature metric.
4. **Live job list** — one row per job: purpose, status, resources, earned-so-far, peer, connection quality.
5. **Capacity utilization gauges** — CPU/GPU/RAM/disk/bandwidth, offered vs. in-use.
6. **Resource caps + scheduler + conditional rules** (only-when-idle / on-AC / thermal / hours).
7. **Turtle/eco quick-throttle** toggle.
8. **Peers/mesh view** — status dots, direct-vs-relayed, last-seen, per-peer ratio, capability grants.
9. **Uptime / availability %** and **reputation tier** (earned, unlocks better-paying work).
10. **Global vital-signs strip** — earn rate, spend rate, peers, online dot, today's total — always visible.

**Design tone:** Tailscale-calm (dots over banners, relative times, "this machine" highlighted), torrent-glanceable (rates + ratio + a live list), F@h-motivating (a purpose line per job, a simple power slider, a contribution feel), Akash-credible (earnings and utilization are real, charted, exportable).

Sources:
- [Introducing: Akash Provider Console](https://akash.network/blog/introducing-akash-provider-console/)
- [State of Akash Q3 2025 — Messari](https://messari.io/report/state-of-akash-q3-2025)
- [BOINC Preferences — BOINC Wiki](https://boinc.berkeley.edu/wiki/Preferences)
- [BOINC 6: Advanced Local Preferences — BOINC Wiki](https://boinc.mundayweb.com/wiki/index.php?title=BOINC_6:_Advanced_Local_Preferences)