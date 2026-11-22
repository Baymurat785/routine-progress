const { Plugin, MarkdownRenderChild, Platform } = require("obsidian");

const DAY_MS = 86400000;
const DATE_NOTE = /^Daily\/(\d{4}-\d{2}-\d{2})\.md$/;
const SVG_NS = "http://www.w3.org/2000/svg";
const HEADING = /^##\s+(.+?)\s*$/;
const TICK = /^\s*- \[([ xX])\]/;
// "- [x] Sick day" anywhere in a daily note: the stock stays flat that day.
// The line itself earns no points.
const SICK = /^\s*- \[([ xX])\]\s*Sick day\b/i;
const MEASURE = /^\s*- ([^\[].*?):\s*(\d+(?:\.\d+)?)?\s*(?:\/\s*(\d+(?:\.\d+)?))?\s*$/;

const OVERALL = "Overall";
const OVERALL_COLOR = "var(--text-normal)";
const COLORS = {
  Mind: "#2e9e5b",
  Body: "#e5484d",
  Work: "#3b82f6",
};
const SPARE_COLORS = ["#ec4899", "#84cc16", "#6366f1", "#b45309"];

// Point-based scoring. Each category earns points from its items, and its
// score is points / goal. There is no cap: a day above the goal scores above
// 100%, so reading 20 pages shows as more progress than reading 10.
// Ticks match by the start of their label; counters earn points per unit.
// Items not listed earn DEFAULT_TICK (ticks) or DEFAULT_UNIT (per unit).
const DEFAULT_TICK = 5;
const DEFAULT_UNIT = 1;
const POINTS = {
  Mind: {
    goal: 100,
    items: {
      "Meditate": 20,
      "Journal": 15,
      "No phone in the first hour": 15,
      "Read pages": 2, // per page: 25 pages = 50
    },
  },
  Body: {
    goal: 100,
    items: {
      // per rep, km or thousand steps: 20 push-ups + 3 km + 6k steps = 110
      "Push-ups": 1,
      "Squats": 0.5,
      "Run km": 20,
      "Steps k": 5,
      "Slept 7+ hours": 20,
    },
  },
  Work: {
    goal: 100,
    items: {
      "Deep work hours": 20, // per hour: 4 hours = 80
      "Planned the day": 10,
      "Learned something new": 10,
    },
  },
};
// "### Morning set" style sub-sections: every row carries its own points
// ("· 9 pts"), each set adds up to SET_GOAL, and it counts toward the
// section above it at SET_SHARE (100 set points = 10 category points).
const SUBHEADING = /^###\s+(.+?)\s*$/;
const SET_GOAL = 100;
const SET_SHARE = 0.1;
const LABEL_POINTS = /·\s*(\d+(?:\.\d+)?)\s*pts\b/;

// Points per unit for a counter row, from whichever category lists it.
function unitPoints(name) {
  for (const config of Object.values(POINTS)) {
    if (config.items[name] !== undefined) return config.items[name];
  }
  return null;
}

function weightOf(config, label, fallback) {
  const written = label.match(LABEL_POINTS);
  if (written) return Number(written[1]);
  for (const [key, weight] of Object.entries(config.items)) {
    if (label === key || label.startsWith(key)) return weight;
  }
  return fallback;
}

function parse(text) {
  const categories = new Map();
  const measures = {};
  const sections = {};
  const ticked = [];
  let sick = false;
  let current = null;
  let group = null;
  let inBlock = false;
  let awaitName = false;
  const category = () => {
    const name = current || "Other";
    if (!categories.has(name)) categories.set(name, { points: 0, total: 0, config: POINTS[name] });
    return categories.get(name);
  };
  for (const line of text.split("\n")) {
    const sickLine = line.match(SICK);
    if (sickLine) {
      sick = sickLine[1] !== " ";
      continue;
    }
    if (line.trim() === "```set") {
      inBlock = true;
      awaitName = true;
      continue;
    }
    if (awaitName) {
      awaitName = false;
      group = line.trim();
      sections[group] = 0;
      continue;
    }
    if (inBlock && line.trim() === "```") {
      inBlock = false;
      group = null;
      continue;
    }
    const heading = line.match(HEADING);
    if (heading) {
      current = heading[1];
      group = null;
      continue;
    }
    const sub = line.match(SUBHEADING);
    if (sub) {
      group = /\bset\b/i.test(sub[1]) ? sub[1] : null;
      if (group) sections[group] = 0;
      continue;
    }
    const tick = line.match(TICK);
    if (tick && group) {
      const written = line.match(LABEL_POINTS);
      if (tick[1] !== " " && written) {
        sections[group] += Number(written[1]);
        category().points += Number(written[1]) * SET_SHARE;
      }
      continue;
    }
    if (tick) {
      const c = category();
      const done = tick[1] !== " ";
      if (done) ticked.push(line.replace(TICK, "").replace(LABEL_POINTS, "").trim());
      if (c.config) {
        const label = line.replace(TICK, "").trim();
        if (done) c.points += weightOf(c.config, label, DEFAULT_TICK);
      } else {
        c.total += 1;
        if (done) c.points += 1;
      }
      continue;
    }
    const measure = line.match(MEASURE);
    if (measure && (measure[3] === undefined || Number(measure[3]) > 0)) {
      const value = measure[2] === undefined ? null : Number(measure[2]);
      const c = category();
      if (value !== null) measures[measure[1]] = value;
      if (group) {
        const written = measure[1].match(LABEL_POINTS);
        if (written && value) {
          const share = measure[3] === undefined ? 1 : Math.min(value / Number(measure[3]), 1);
          sections[group] += share * Number(written[1]);
          c.points += share * Number(written[1]) * SET_SHARE;
        }
        continue;
      }
      if (c.config) {
        c.points += (value || 0) * weightOf(c.config, measure[1], DEFAULT_UNIT);
        continue;
      }
      c.total += 1;
      if (value !== null) {
        c.points += measure[3] === undefined ? (value > 0 ? 1 : 0) : value / Number(measure[3]);
      }
    }
  }
  const scores = {};
  for (const [name, c] of categories) {
    if (c.config) scores[name] = Math.round((c.points / c.config.goal) * 100);
    else if (c.total) scores[name] = Math.round((c.points / c.total) * 100);
  }
  const values = Object.values(scores);
  if (values.length) {
    scores[OVERALL] = Math.round(values.reduce((sum, v) => sum + v, 0) / values.length);
  }
  for (const name of Object.keys(sections)) sections[name] = Math.round(sections[name] * 10) / 10;
  return { scores, measures, sections, ticked, sick };
}

// ---- Game: XP, levels, streaks and the daily minimum -----------------------
// XP: every point earned in a POINTS category, summed over all days. Never drops.
// Level n needs LEVEL_BASE + LEVEL_STEP * n more XP to reach n + 1.
const LEVEL_BASE = 200;
const LEVEL_STEP = 100;
const TITLES = [
  [1, "Starter", "first steps"],
  [3, "Apprentice", "building the habit"],
  [6, "Builder", "it is a routine now"],
  [10, "Achiever", "consistent"],
  [15, "Master", "it runs itself"],
  [20, "Legend", "years of compounding"],
];
// The daily minimum: hit all three and the day keeps the chain alive.
const MINIMUM = [
  { name: "Sleep", label: "Slept 7+ hours", test: (d) => d.ticked.includes("Slept 7+ hours") },
  { name: "Move", label: "Body 30%+", test: (d) => (d.scores.Body || 0) >= 30 },
  { name: "Read", label: "Read 10+ pages", test: (d) => (d.measures["Read pages"] || 0) >= 10 },
];
// One missed day per 7 days is forgiven in the chain.
const SHIELD_DAYS = 7;
const STREAKS = [
  { name: "Meditate", test: (d) => d.ticked.includes("Meditate") },
  { name: "Journal", test: (d) => d.ticked.includes("Journal") },
  { name: "Read 10", test: (d) => (d.measures["Read pages"] || 0) >= 10 },
  { name: "Body 50%", test: (d) => (d.scores.Body || 0) >= 50 },
  { name: "Deep work 2h", test: (d) => (d.measures["Deep work hours"] || 0) >= 2 },
];

function dayXp(day) {
  let xp = 0;
  for (const name of Object.keys(POINTS)) xp += (day.scores[name] || 0) * POINTS[name].goal / 100;
  return Math.round(xp);
}

function levelOf(xp) {
  let level = 1;
  let floor = 0;
  while (xp >= floor + LEVEL_BASE + LEVEL_STEP * level) {
    floor += LEVEL_BASE + LEVEL_STEP * level;
    level += 1;
  }
  const need = LEVEL_BASE + LEVEL_STEP * level;
  const title = TITLES.filter(([from]) => level >= from).pop();
  return { level, into: xp - floor, need, title: title[1], meaning: title[2] };
}

function dateKey(time) {
  return new Date(time).toISOString().slice(0, 10);
}

// Walk back from today. An unfinished today does not break anything yet.
// With shields, one miss per SHIELD_DAYS is skipped instead of ending the run.
function streak(byDate, today, test, shields) {
  const first = Math.min(...[...byDate.keys()].map(Date.parse));
  const todayDone = byDate.has(today) && test(byDate.get(today));
  let t = Date.parse(today) - (todayDone ? 0 : DAY_MS);
  let count = 0;
  let lastShield = -Infinity;
  for (let i = 0; t >= first; i++, t -= DAY_MS) {
    const day = byDate.get(dateKey(t));
    if (day && test(day)) {
      count += 1;
    } else if (shields && i - lastShield >= SHIELD_DAYS && t - DAY_MS >= first) {
      lastShield = i;
    } else {
      break;
    }
  }
  return { count, todayDone, shieldReady: count === 0 || lastShield < 0 || lastShield >= SHIELD_DAYS };
}

function bestStreak(days, test) {
  let best = 0;
  let run = 0;
  let prev = null;
  for (const day of days) {
    const t = Date.parse(day.date);
    if (prev !== null && t - prev !== DAY_MS) run = 0;
    run = test(day) ? run + 1 : 0;
    best = Math.max(best, run);
    prev = t;
  }
  return best;
}

function gameStats(days, today) {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const xp = days.reduce((sum, d) => sum + dayXp(d), 0);
  const todayDay = byDate.get(today);
  const minimumTest = (d) => MINIMUM.every((m) => m.test(d));
  return {
    xp,
    todayXp: todayDay ? dayXp(todayDay) : 0,
    ...levelOf(xp),
    minimum: MINIMUM.map((m) => ({ ...m, done: !!todayDay && m.test(todayDay) })),
    chain: streak(byDate, today, minimumTest, true),
    streaks: STREAKS.map((s) => ({ ...s, ...streak(byDate, today, s.test, false), best: bestStreak(days, s.test) })),
  };
}

function average(values) {
  return values.length ? Math.round(values.reduce((sum, v) => sum + v, 0) / values.length) : 0;
}

function colorFor(name, spare) {
  if (name === OVERALL) return OVERALL_COLOR;
  if (COLORS[name]) return COLORS[name];
  if (!spare.has(name)) spare.set(name, SPARE_COLORS[spare.size % SPARE_COLORS.length]);
  return spare.get(name);
}

function add(parent, name, attrs, text) {
  const node = document.createElementNS(SVG_NS, name);
  for (const key in attrs) node.setAttribute(key, attrs[key]);
  if (text !== undefined) node.textContent = text;
  parent.appendChild(node);
  return node;
}

function axisRange(lines, floor, ceiling, minSpan) {
  const values = lines.flatMap((line) => line.points.map((p) => p.value));
  const low = Math.min(...values), high = Math.max(...values);
  const pad = Math.max((high - low) * 0.15, minSpan / 2);
  const min = Math.max(floor, low - pad);
  return { min, max: Math.min(ceiling, Math.max(high + pad, min + minSpan)) };
}

function changeText(points, suffix) {
  if (points.length < 2) return "";
  const delta = Math.round((points[points.length - 1].value - points[points.length - 2].value) * 10) / 10;
  if (delta === 0) return " =";
  return delta > 0 ? ` ▲${delta}${suffix}` : ` ▼${-delta}${suffix}`;
}

function drawChart(el, dates, lines, range, suffix) {
  const width = 640, height = 300, left = 44, right = 16, top = 16, bottom = 34;
  const svg = add(el, "svg", { viewBox: `0 0 ${width} ${height}`, width: "100%", role: "img" });
  const muted = "var(--text-muted)";
  const { min, max } = range;
  const y = (v) => top + (max - v) / (max - min) * (height - top - bottom);
  for (let i = 0; i <= 4; i++) {
    const v = min + (max - min) * i / 4;
    add(svg, "line", { x1: left, x2: width - right, y1: y(v), y2: y(v), stroke: "var(--background-modifier-border)" });
    add(svg, "text", { x: left - 8, y: y(v) + 5, "text-anchor": "end", "font-size": 14, fill: muted }, `${max - min >= 8 ? Math.round(v) : Math.round(v * 10) / 10}${suffix}`);
  }
  const start = Date.parse(dates[0]);
  const span = Math.max(Date.parse(dates[dates.length - 1]) - start, DAY_MS);
  const x = (date) => left + (Date.parse(date) - start) / span * (width - left - right);
  for (const line of lines) {
    add(svg, "polyline", {
      points: line.points.map((p) => `${x(p.date)},${y(p.value)}`).join(" "),
      fill: "none", stroke: line.color, "stroke-width": line.width, "stroke-linejoin": "round",
    });
    for (const p of line.points) {
      const dot = add(svg, "circle", { cx: x(p.date), cy: y(p.value), r: line.width + 1, fill: line.color });
      add(dot, "title", {}, `${line.name}, ${p.date}: ${p.value}${suffix}`);
    }
  }
  const label = (date, anchor) => add(svg, "text", {
    x: x(date), y: height - 10, "text-anchor": anchor, "font-size": 14, fill: muted,
  }, date.slice(5));
  label(dates[0], "start");
  if (dates.length > 1) label(dates[dates.length - 1], "end");
}

function drawLegend(el, lines) {
  const legend = el.createEl("div");
  legend.style.cssText = "display:flex;flex-wrap:wrap;gap:4px 14px;margin:4px 0 12px;font-size:0.9em";
  for (const line of lines) {
    const item = legend.createEl("span");
    const swatch = item.createEl("span");
    swatch.style.cssText = `display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:5px;background:${line.color}`;
    item.createEl("span", { text: `${line.name} ${line.points[line.points.length - 1].value}%${changeText(line.points, "%")}` });
  }
}

function seriesOf(days, field, names) {
  return names.map((name) => ({
    name,
    points: days.filter((d) => d[field][name] !== undefined).map((d) => ({ date: d.date, value: d[field][name] })),
  }));
}

function namesOf(days, field) {
  const names = [];
  for (const d of days) {
    for (const name of Object.keys(d[field])) {
      if (!names.includes(name)) names.push(name);
    }
  }
  return names;
}

async function loadDays(app) {
  const files = app.vault.getMarkdownFiles()
    .map((file) => ({ file, match: file.path.match(DATE_NOTE) }))
    .filter(({ match }) => match)
    .sort((a, b) => a.match[1].localeCompare(b.match[1]));
  const days = [];
  for (const { file, match } of files) {
    const result = parse(await app.vault.cachedRead(file));
    if (result.scores[OVERALL] !== undefined) days.push({ date: match[1], ...result });
  }
  return days;
}

function formatValue(value) {
  return String(Math.round(value * 100) / 100);
}

async function saveMeasure(app, file, name, target, value) {
  const prefix = `- ${name}:`;
  await app.vault.process(file, (text) => text.split("\n").map((line) => {
    const measure = line.match(MEASURE);
    return measure && measure[1] === name ? `${prefix} ${value === null ? "" : formatValue(value)}${target === undefined ? "" : ` / ${target}`}` : line;
  }).join("\n"));
}

// Live score for one section of the open note: "```score\nMind\n```".
class ScoreView extends MarkdownRenderChild {
  constructor(el, app, path, name) {
    super(el);
    this.app = app;
    this.path = path;
    this.name = name;
  }

  onload() {
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file.path === this.path) this.render();
    }));
    this.render();
  }

  async render() {
    const file = this.app.vault.getAbstractFileByPath(this.path);
    if (!file) return;
    const { scores, sections } = parse(await this.app.vault.cachedRead(file));
    const isSet = sections[this.name] !== undefined;
    const score = isSet ? Math.round(sections[this.name] / SET_GOAL * 100) : scores[this.name] || 0;
    const config = isSet ? { goal: SET_GOAL } : POINTS[this.name];
    const el = this.containerEl;
    el.empty();
    const box = el.createEl("div");
    box.style.cssText = "display:flex;align-items:center;gap:10px;margin:4px 0 8px";
    const text = config
      ? `${formatValue(score * config.goal / 100)} / ${config.goal} pts`
      : "";
    box.createEl("strong", { text: `Today: ${score}%` });
    if (text) box.createEl("span", { text }).style.cssText = "color:var(--text-muted)";
    if (isSet) box.createEl("span", { text: `(${formatValue(sections[this.name] * SET_SHARE)} of 10 category pts)` }).style.cssText = "color:var(--text-muted)";
    const bar = el.createEl("div");
    bar.style.cssText = "height:6px;border-radius:3px;background:var(--background-modifier-border);overflow:hidden;margin-bottom:10px";
    bar.createEl("div").style.cssText = `height:100%;width:${Math.min(score, 100)}%;background:${COLORS[this.name] || "var(--interactive-accent)"}`;
  }
}

// Compact counters for a ```track block. Rows with a points value show what
// they earn; a block with several such rows (Body) gets a total on top.
function drawTrackBlock(el, app, file, source) {
  const rows = source.split("\n").map((line) => line.match(MEASURE)).filter(Boolean).map((m) => ({
    name: m[1],
    target: m[3],
    value: m[2] === undefined ? null : Number(m[2]),
    per: unitPoints(m[1]),
  }));
  if (!rows.length) return;
  const scored = rows.filter((row) => row.per !== null);
  const box = el.createEl("div");
  const framed = scored.length > 1;
  box.style.cssText = `font-size:0.85em;margin:6px 0;${framed ? "border:1px solid var(--background-modifier-border);border-radius:10px;padding:8px 10px" : ""}`;
  let total = null, fill = null;
  if (framed) {
    const head = box.createEl("div");
    head.style.cssText = "display:flex;align-items:baseline;gap:8px;margin-bottom:4px;padding-right:30px";
    head.createEl("strong", { text: "Training" }).style.cssText = "font-size:1.1em";
    total = head.createEl("span");
    total.style.cssText = "color:var(--text-muted)";
    const bar = box.createEl("div");
    bar.style.cssText = "height:4px;border-radius:2px;background:var(--background-modifier-border);overflow:hidden;margin-bottom:6px";
    fill = bar.createEl("div");
  }
  const paintTotal = () => {
    if (!total) return;
    const points = scored.reduce((sum, row) => sum + (row.value || 0) * row.per, 0);
    total.setText(`${formatValue(Math.round(points * 10) / 10)} pts · ${Math.round(points)}%`);
    fill.style.cssText = `height:100%;width:${Math.min(points, 100)}%;background:${COLORS.Body}`;
  };
  const pill = "min-width:0;height:24px;width:26px;padding:0;font-size:1em;border-radius:6px;box-shadow:none";
  rows.forEach((row, i) => {
    const line = box.createEl("div");
    line.style.cssText = `display:flex;align-items:center;gap:6px;padding:3px 0;${framed && i ? "border-top:1px solid var(--background-modifier-border-hover)" : ""}`;
    line.createEl("span", { text: row.name }).style.cssText = "flex:1;min-width:0;font-weight:600";
    const minus = line.createEl("button", { text: "−" });
    minus.style.cssText = pill;
    const input = line.createEl("input", { type: "number" });
    input.setAttribute("inputmode", "decimal");
    input.setAttribute("min", "0");
    input.setAttribute("placeholder", "0");
    input.setAttribute("aria-label", row.name);
    input.style.cssText = "width:52px;height:24px;padding:0 4px;text-align:center;font-size:1em";
    if (row.value !== null) input.value = formatValue(row.value);
    const plus = line.createEl("button", { text: "+" });
    plus.style.cssText = pill;
    if (row.target !== undefined) line.createEl("span", { text: `/ ${row.target}` }).style.cssText = "color:var(--text-muted)";
    const earned = line.createEl("span");
    earned.style.cssText = "width:78px;text-align:right;color:var(--text-faint);font-variant-numeric:tabular-nums;white-space:nowrap";
    const paint = () => {
      earned.setText(row.per === null ? "" : `${formatValue((row.value || 0) * row.per)} · ×${formatValue(row.per)}`);
      earned.style.color = (row.value || 0) > 0 ? "var(--text-normal)" : "var(--text-faint)";
    };
    const commit = (next) => {
      row.value = next;
      input.value = next === null ? "" : formatValue(next);
      paint();
      paintTotal();
      saveMeasure(app, file, row.name, row.target, next);
    };
    minus.addEventListener("click", () => commit(Math.max((row.value || 0) - 1, 0)));
    plus.addEventListener("click", () => commit((row.value || 0) + 1));
    input.addEventListener("change", () => {
      const typed = parseFloat(input.value);
      commit(Number.isNaN(typed) || typed < 0 ? null : typed);
    });
    paint();
  });
  paintTotal();
}

// ```game``` at the top of a daily note: level, XP, the daily minimum,
// the chain and one streak chip per habit. Computed for that note's date.
class GameView extends MarkdownRenderChild {
  constructor(el, app, path) {
    super(el);
    this.app = app;
    this.today = (path.match(DATE_NOTE) || [])[1] || dateKey(Date.now() - new Date().getTimezoneOffset() * 60000);
  }

  onload() {
    const refresh = (file) => {
      if (DATE_NOTE.test(file.path)) this.render();
    };
    this.registerEvent(this.app.vault.on("modify", refresh));
    this.registerEvent(this.app.vault.on("create", refresh));
    this.registerEvent(this.app.vault.on("delete", refresh));
    this.render();
  }

  async render() {
    const days = (await loadDays(this.app)).filter((d) => d.date <= this.today);
    const el = this.containerEl;
    el.empty();
    if (!days.length) return;
    drawGame(el, gameStats(days, this.today));
  }
}

function drawGame(el, game) {
  const accent = "var(--interactive-accent)";
  const muted = "var(--text-muted)";
  const box = el.createEl("div");
  box.style.cssText = "border:1px solid var(--background-modifier-border);border-radius:8px;padding:8px 10px;margin:4px 0 10px;font-size:0.85em;line-height:1.4";

  const head = box.createEl("div");
  head.style.cssText = "display:flex;align-items:baseline;gap:8px;padding-right:30px";
  const level = head.createEl("strong", { text: `⭐ Level ${game.level} · ${game.title}` });
  level.style.cssText = "font-size:1.1em";
  level.title = game.meaning;
  head.createEl("span", { text: `${game.xp.toLocaleString()} XP` }).style.cssText = `margin-left:auto;color:${muted}`;
  const plus = head.createEl("span", { text: `+${game.todayXp} today` });
  plus.style.cssText = `color:${game.todayXp ? "#2e9e5b" : muted};font-weight:600`;

  const bar = box.createEl("div");
  bar.style.cssText = "height:5px;border-radius:3px;background:var(--background-modifier-border);overflow:hidden;margin:5px 0 2px";
  bar.createEl("div").style.cssText = `height:100%;width:${Math.round(game.into / game.need * 100)}%;background:${accent}`;
  box.createEl("div", { text: `${game.need - game.into} XP to Level ${game.level + 1}` }).style.cssText = `font-size:0.85em;color:${muted};margin-bottom:8px`;

  const pill = (parent, text, on, title) => {
    const p = parent.createEl("span", { text });
    p.style.cssText = `display:inline-block;padding:1px 8px;border-radius:10px;white-space:nowrap;border:1px solid ${on ? "#2e9e5b" : "var(--background-modifier-border)"};background:${on ? "rgba(46,158,91,0.12)" : "transparent"};color:${on ? "var(--text-normal)" : muted}`;
    if (title) p.title = title;
    return p;
  };

  const minRow = box.createEl("div");
  minRow.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;gap:5px;margin-bottom:6px";
  const allDone = game.minimum.every((m) => m.done);
  minRow.createEl("span", { text: allDone ? "Minimum done" : "Daily minimum" }).style.cssText = "font-weight:600;margin-right:2px";
  for (const m of game.minimum) pill(minRow, `${m.done ? "✓" : "○"} ${m.label}`, m.done);
  const chain = game.chain;
  const chainText = chain.count
    ? `${chain.count}-day chain${chain.todayDone ? "" : " · keep it today"}`
    : "Start a chain today";
  const chainEl = minRow.createEl("span", { text: chainText });
  chainEl.style.cssText = `margin-left:auto;font-weight:600;color:${chain.count ? "var(--text-normal)" : muted}`;
  const shield = minRow.createEl("span", { text: chain.shieldReady ? "Shield ready" : "Shield used" });
  shield.title = chain.shieldReady
    ? "Shield ready: one missed day this week won't break the chain"
    : "Shield used this week: the next miss breaks the chain";
  shield.style.cssText = chain.shieldReady ? "" : "opacity:0.4";

  const chips = box.createEl("div");
  chips.style.cssText = "display:flex;flex-wrap:wrap;gap:5px";
  for (const s of game.streaks) {
    const text = `${s.name} · ${s.count}`;
    const chip = pill(chips, text, s.todayDone, `Best: ${s.best} day${s.best === 1 ? "" : "s"}`);
    if (s.count && !s.todayDone) chip.style.borderStyle = "dashed";
  }
}

// Stock: a price that starts at 100 and moves each day by how the day went.
// A day at STOCK_FLAT% keeps the price flat; every 5 points above or below
// moves it 1%. A day with no note counts as 0%, so skipped days pull it down.
const STOCK_START = 100;
const STOCK_FLAT = 50;
const STOCK_STEP = 5;
const STOCK_MAX_MOVE = 10;
const STOCK_RANGES = [["1W", 7], ["1M", 30], ["3M", 90], ["All", Infinity]];

function stockSeries(days, today) {
  if (!days.length) return [];
  const byDate = new Map(days.map((d) => [d.date, d.scores[OVERALL]]));
  const sickDays = new Set(days.filter((d) => d.sick).map((d) => d.date));
  const points = [];
  let price = STOCK_START;
  for (let t = Date.parse(days[0].date); t <= Date.parse(today); t += DAY_MS) {
    const date = dateKey(t);
    const score = byDate.get(date) ?? 0;
    const sick = sickDays.has(date);
    const move = sick ? 0 : Math.max(-STOCK_MAX_MOVE, Math.min(STOCK_MAX_MOVE, (score - STOCK_FLAT) / STOCK_STEP));
    price *= 1 + move / 100;
    points.push({ date, score, move, price: Math.round(price * 100) / 100, missing: !byDate.has(date), sick });
  }
  return points;
}

class StockView extends MarkdownRenderChild {
  constructor(el, app) {
    super(el);
    this.app = app;
    this.range = 30;
  }

  onload() {
    const refresh = (file) => {
      if (DATE_NOTE.test(file.path)) this.render();
    };
    this.registerEvent(this.app.vault.on("modify", refresh));
    this.registerEvent(this.app.vault.on("create", refresh));
    this.registerEvent(this.app.vault.on("delete", refresh));
    this.render();
  }

  async render() {
    const today = dateKey(Date.now() - new Date().getTimezoneOffset() * 60000);
    const days = (await loadDays(this.app)).filter((d) => d.date <= today);
    const el = this.containerEl;
    el.empty();
    if (!days.length) {
      el.createEl("p", { text: "No daily notes yet." });
      return;
    }
    drawStock(el, stockSeries(days, today), this.range, (range) => {
      this.range = range;
      this.render();
    });
  }
}

function drawStock(el, all, range, setRange) {
  const green = "var(--color-green)", red = "var(--color-red)", muted = "var(--text-muted)";
  const points = all.slice(-Math.min(all.length, range + 1));
  const last = points[points.length - 1];
  const base = points.length > 1 ? points[0].price : STOCK_START;
  const box = el.createEl("div");
  box.style.cssText = "border:1px solid var(--background-modifier-border);border-radius:8px;padding:10px 12px;margin-bottom:12px";

  const head = box.createEl("div");
  head.style.cssText = "display:flex;align-items:baseline;gap:10px;flex-wrap:wrap";
  head.createEl("span", { text: "ME" }).style.cssText = `font-weight:600;color:${muted};letter-spacing:0.08em;font-size:0.85em`;
  head.createEl("span", { text: last.price.toFixed(2) }).style.cssText = "font-size:1.8em;font-weight:700";
  const dayChange = last.price - (all.length > 1 ? all[all.length - 2].price : STOCK_START);
  const dayColor = dayChange >= 0 ? green : red;
  head.createEl("span", {
    text: last.sick ? "Sick day · held flat" : `${dayChange >= 0 ? "▲" : "▼"} ${Math.abs(dayChange).toFixed(2)} (${last.move >= 0 ? "+" : ""}${last.move.toFixed(1)}%) today`,
  }).style.cssText = `color:${dayColor};font-weight:600`;

  const tabs = head.createEl("span");
  tabs.style.cssText = "margin-left:auto;display:flex;gap:4px";
  for (const [label, days] of STOCK_RANGES) {
    const tab = tabs.createEl("button", { text: label });
    const active = days === range;
    tab.style.cssText = `padding:1px 8px;font-size:0.8em;height:auto;box-shadow:none;border-radius:4px;${active ? "background:var(--interactive-accent);color:var(--text-on-accent)" : "background:transparent"}`;
    tab.onclick = () => setRange(days);
  }

  const change = last.price - base;
  const color = change >= 0 ? green : red;
  const pct = base ? change / base * 100 : 0;
  const sub = box.createEl("div", {
    text: `${change >= 0 ? "+" : ""}${change.toFixed(2)} (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%) over ${points.length - 1 || 1} day${points.length > 2 ? "s" : ""} · today's score ${last.score}%`,
  });
  sub.style.cssText = `color:${muted};font-size:0.85em;margin-bottom:6px`;

  const width = 640, height = 220, left = 8, right = 52, top = 12, bottom = 26;
  const prices = points.map((p) => p.price);
  const low = Math.min(...prices, base), high = Math.max(...prices, base);
  const pad = Math.max((high - low) * 0.12, 1);
  const min = low - pad, max = high + pad;
  const svg = add(box, "svg", { viewBox: `0 0 ${width} ${height}`, width: "100%", role: "img" });
  const id = `stock-${Math.random().toString(36).slice(2)}`;
  const grad = add(add(svg, "defs", {}), "linearGradient", { id, x1: 0, x2: 0, y1: 0, y2: 1 });
  add(grad, "stop", { offset: "0%", "stop-color": color, "stop-opacity": 0.35 });
  add(grad, "stop", { offset: "100%", "stop-color": color, "stop-opacity": 0 });
  const x = (i) => left + (points.length > 1 ? i / (points.length - 1) : 0.5) * (width - left - right);
  const y = (v) => top + (max - v) / (max - min) * (height - top - bottom);

  for (let i = 0; i <= 3; i++) {
    const v = min + (max - min) * i / 3;
    add(svg, "line", { x1: left, x2: width - right, y1: y(v), y2: y(v), stroke: "var(--background-modifier-border)" });
    add(svg, "text", { x: width - right + 6, y: y(v) + 4, "font-size": 12, fill: muted }, v.toFixed(1));
  }
  add(svg, "line", { x1: left, x2: width - right, y1: y(base), y2: y(base), stroke: muted, "stroke-dasharray": "3 4", opacity: 0.7 });

  const coords = points.map((p, i) => `${x(i)},${y(p.price)}`);
  if (points.length > 1) {
    add(svg, "polygon", {
      points: `${x(0)},${height - bottom} ${coords.join(" ")} ${x(points.length - 1)},${height - bottom}`,
      fill: `url(#${id})`,
    });
    add(svg, "polyline", { points: coords.slice(0, -1).join(" "), fill: "none", stroke: color, "stroke-width": 2.5, "stroke-linejoin": "round" });
    add(svg, "line", {
      x1: x(points.length - 2), y1: y(points[points.length - 2].price), x2: x(points.length - 1), y2: y(last.price),
      stroke: color, "stroke-width": 2.5, "stroke-dasharray": "4 3",
    });
  }
  points.forEach((p, i) => {
    const dot = add(svg, "circle", {
      cx: x(i), cy: y(p.price), r: i === points.length - 1 ? 4.5 : 3,
      fill: p.missing || p.sick ? "var(--background-primary)" : p.move >= 0 ? green : red,
      stroke: p.sick ? muted : p.move >= 0 ? green : red, "stroke-width": 1.5,
    });
    add(dot, "title", {}, `${p.date}: ${p.sick ? `sick day, held flat (score ${p.score}%)` : p.missing ? "no note" : `score ${p.score}%`} · ${p.price.toFixed(2)} (${p.move >= 0 ? "+" : ""}${p.move.toFixed(1)}%)`);
  });
  const label = (i, anchor) => add(svg, "text", { x: x(i), y: height - 8, "text-anchor": anchor, "font-size": 12, fill: muted }, points[i].date.slice(5));
  label(0, "start");
  if (points.length > 1) label(points.length - 1, "end");

  const foot = box.createEl("div", {
    text: `High ${high.toFixed(2)} · Low ${low.toFixed(2)} · A ${STOCK_FLAT}% day keeps it flat, every ${STOCK_STEP} points above or below moves it 1%. A missed day counts as 0%. Tick "Sick day" in a daily note to hold it flat that day (hollow grey dot). Today's segment is dashed: it is still live.`,
  });
  foot.style.cssText = `color:${muted};font-size:0.78em;margin-top:4px`;
}

class ProgressView extends MarkdownRenderChild {
  constructor(el, app, range) {
    super(el);
    this.app = app;
    this.range = range;
  }

  onload() {
    const refresh = (file) => {
      if (DATE_NOTE.test(file.path)) this.render();
    };
    this.registerEvent(this.app.vault.on("modify", refresh));
    this.registerEvent(this.app.vault.on("create", refresh));
    this.registerEvent(this.app.vault.on("delete", refresh));
    this.render();
  }

  async render() {
    const cutoff = Date.now() - this.range * DAY_MS;
    const allDays = await loadDays(this.app);
    const days = allDays.filter((d) => Date.parse(d.date) >= cutoff);
    this.containerEl.empty();
    if (!days.length) {
      this.containerEl.createEl("p", { text: "No daily notes yet." });
      return;
    }
    const dates = days.map((d) => d.date);
    const last7 = days.slice(-7).map((d) => d.scores[OVERALL]);
    this.containerEl.createEl("p", {
      text: `Overall today (${dates[dates.length - 1]}): ${days[days.length - 1].scores[OVERALL]}%. Last 7 logged days: ${average(last7)}% average.`,
    });

    const spare = new Map();
    const categories = namesOf(days, "scores").filter((name) => name !== OVERALL);
    const lines = seriesOf(days, "scores", [...categories, OVERALL]).map((line) => ({
      ...line,
      color: colorFor(line.name, spare),
      width: line.name === OVERALL ? 4 : 2,
    }));
    drawChart(this.containerEl, dates, lines, axisRange(lines, 0, Infinity, 10), "%");
    drawLegend(this.containerEl, lines);


    for (const line of seriesOf(days, "measures", namesOf(days, "measures"))) {
      this.containerEl.createEl("h4", { text: `${line.name}: ${line.points[line.points.length - 1].value}${changeText(line.points, "")}` });
      drawChart(this.containerEl, dates, [{ ...line, color: "var(--interactive-accent)", width: 3 }], axisRange([line], 0, Infinity, 2), "");
    }
  }
}

const WALLPAPER_PATH = "progress-wallpaper.png";
const WALLPAPER_DAYS = 14;

function drawWallpaper(days) {
  const width = 1179, height = 2556, left = 110, right = 70, top = 1000, bottom = 1720;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext("2d");
  g.fillStyle = "#0b0d12";
  g.fillRect(0, 0, width, height);
  const font = (size, weight = 500) => `${weight} ${size}px -apple-system, sans-serif`;

  const recent = days.slice(-WALLPAPER_DAYS);
  const spare = new Map();
  const categories = namesOf(recent, "scores").filter((name) => name !== OVERALL);
  const lines = seriesOf(recent, "scores", [...categories, OVERALL]).map((line) => ({
    ...line,
    color: line.name === OVERALL ? "#ffffff" : colorFor(line.name, spare),
    width: line.name === OVERALL ? 10 : 5,
  }));
  const overall = lines[lines.length - 1].points;

  g.fillStyle = "#ffffff";
  g.font = font(120, 700);
  g.fillText(`${overall[overall.length - 1].value}%`, left, top - 110);
  g.fillStyle = "#9aa0ac";
  g.font = font(38);
  const change = changeText(overall, "%");
  g.fillText(`Overall${change}  ·  ${recent[recent.length - 1].date}`, left, top - 50);

  const { min, max } = axisRange(lines, 0, Infinity, 10);
  const y = (v) => top + (max - v) / (max - min) * (bottom - top);
  const start = Date.parse(recent[0].date);
  const span = Math.max(Date.parse(recent[recent.length - 1].date) - start, DAY_MS);
  const x = (date) => left + (Date.parse(date) - start) / span * (width - left - right);

  g.font = font(30);
  for (let i = 0; i <= 4; i++) {
    const v = min + (max - min) * i / 4;
    g.strokeStyle = "#262a33";
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(left, y(v));
    g.lineTo(width - right, y(v));
    g.stroke();
    g.fillStyle = "#9aa0ac";
    g.textAlign = "right";
    g.fillText(`${Math.round(v)}`, left - 16, y(v) + 10);
  }
  g.textAlign = "left";

  for (const line of lines) {
    g.strokeStyle = line.color;
    g.fillStyle = line.color;
    g.lineWidth = line.width;
    g.lineJoin = "round";
    g.beginPath();
    line.points.forEach((p, i) => (i ? g.lineTo(x(p.date), y(p.value)) : g.moveTo(x(p.date), y(p.value))));
    g.stroke();
    for (const p of line.points) {
      g.beginPath();
      g.arc(x(p.date), y(p.value), line.width + 4, 0, Math.PI * 2);
      g.fill();
    }
  }

  let row = bottom + 80;
  g.font = font(38);
  for (const line of lines.filter((l) => l.name !== OVERALL)) {
    g.fillStyle = line.color;
    g.beginPath();
    g.arc(left + 12, row - 13, 12, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#e6e8ec";
    g.fillText(`${line.name}  ${line.points[line.points.length - 1].value}%${changeText(line.points, "%")}`, left + 42, row);
    row += 58;
  }
  return canvas;
}

async function saveWallpaper(app) {
  const days = await loadDays(app);
  if (!days.length) return;
  const canvas = drawWallpaper(days);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  await app.vault.adapter.writeBinary(WALLPAPER_PATH, await blob.arrayBuffer());
}

// Fills today's daily note from the template when it is missing or empty.
async function ensureToday(app) {
  const path = `Daily/${window.moment().format("YYYY-MM-DD")}.md`;
  const template = app.vault.getAbstractFileByPath("Templates/Daily.md");
  if (!template) return;
  const existing = app.vault.getAbstractFileByPath(path);
  if (existing && existing.stat.size > 0) return;
  const text = await app.vault.read(template);
  if (!text.trim()) return;
  if (existing) await app.vault.modify(existing, text);
  else await app.vault.create(path, text);
}

module.exports = class RoutineProgress extends Plugin {
  onload() {
    const today = () => ensureToday(this.app).catch(console.error);
    this.app.workspace.onLayoutReady(today);
    this.registerInterval(window.setInterval(today, 5 * 60 * 1000));

    // Redraws the wallpaper image a moment after a daily note is saved.
    {
      let timer = null;
      const queue = () => {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => saveWallpaper(this.app).catch(console.error), 1500);
      };
      this.app.workspace.onLayoutReady(queue);
      this.registerEvent(this.app.vault.on("modify", (file) => {
        if (DATE_NOTE.test(file.path)) queue();
      }));
    }

    this.registerMarkdownCodeBlockProcessor("routine-progress", (source, el, ctx) => {
      const range = parseInt(source.trim(), 10) || 30;
      ctx.addChild(new ProgressView(el, this.app, range));
    });
    this.registerMarkdownCodeBlockProcessor("track", (source, el, ctx) => {
      const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
      drawTrackBlock(el, this.app, file, source);
    });
    this.registerMarkdownCodeBlockProcessor("score", (source, el, ctx) => {
      ctx.addChild(new ScoreView(el, this.app, ctx.sourcePath, source.trim()));
    });
    this.registerMarkdownCodeBlockProcessor("game", (source, el, ctx) => {
      ctx.addChild(new GameView(el, this.app, ctx.sourcePath));
    });
    this.registerMarkdownCodeBlockProcessor("stock", (source, el, ctx) => {
      ctx.addChild(new StockView(el, this.app));
    });
  }
};

module.exports.parse = parse;
module.exports.gameStats = gameStats;
module.exports.levelOf = levelOf;
module.exports.stockSeries = stockSeries;
module.exports.MEASURE = MEASURE;
module.exports.axisRange = axisRange;
module.exports.changeText = changeText;
