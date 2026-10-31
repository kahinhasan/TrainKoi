// Builds edges.json: the real OpenStreetMap rail track between every pair of
// neighbouring stations. Run once from the project folder (Node 18+, no install):
//   node tools/make-edges.mjs            (downloads from Overpass, then writes ./edges.json)
//   node tools/make-edges.mjs saved.json (use an Overpass JSON you already saved)
// Then commit edges.json next to index.html.
import fs from "node:fs";
const net = JSON.parse(fs.readFileSync(new URL("./net.json", import.meta.url), "utf8"));
const OUT = new URL("../edges.json", import.meta.url);
const QUERY = '[out:json][timeout:300];way["railway"="rail"][!"service"](20.4,87.8,26.8,92.8);out geom;';
const SERVERS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter", "https://overpass.private.coffee/api/interpreter"];

async function load() {
  if (process.argv[2]) return JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  for (const s of SERVERS) {
    try {
      console.log("Downloading from", s);
      const r = await fetch(s, { method: "POST", body: "data=" + encodeURIComponent(QUERY), headers: { "content-type": "application/x-www-form-urlencoded" } });
      if (r.ok) return await r.json();
      console.log(" ->", r.status);
    } catch (e) { console.log(" ->", e.message); }
  }
  throw new Error("All Overpass servers failed. Try again later, or save the result in a browser and pass the file name.");
}
const rad = Math.PI / 180;
const hav = (a, b) => 6371 * Math.hypot((b[0] - a[0]) * rad * Math.cos((a[1] + b[1]) * rad / 2), (b[1] - a[1]) * rad);
const key = p => p[0].toFixed(5) + "," + p[1].toFixed(5);

const data = await load();
const nodes = new Map(), adj = new Map();
function node(p) { const k = key(p); if (!nodes.has(k)) { nodes.set(k, [+p[0].toFixed(5), +p[1].toFixed(5)]); adj.set(k, []); } return k; }
for (const w of data.elements || []) {
  if (w.type !== "way" || !w.geometry) continue;
  let prev = null;
  for (const g of w.geometry) {
    if (!g) { prev = null; continue; }
    const k = node([g.lon, g.lat]);
    if (prev && prev !== k) { const d = hav(nodes.get(prev), nodes.get(k)); adj.get(prev).push([k, d]); adj.get(k).push([prev, d]); }
    prev = k;
  }
}
console.log("Track nodes:", nodes.size);

const grid = new Map(), cell = p => Math.floor(p[0] / 0.05) + "," + Math.floor(p[1] / 0.05);
for (const [k, p] of nodes) { const c = cell(p); if (!grid.has(c)) grid.set(c, []); grid.get(c).push(k); }
function snap(p, maxKm = 8) {
  let best = null, bd = maxKm;
  const cx = Math.floor(p[0] / 0.05), cy = Math.floor(p[1] / 0.05), R = Math.ceil(maxKm / 5) + 1;
  for (let x = cx - R; x <= cx + R; x++) for (let y = cy - R; y <= cy + R; y++)
    for (const k of grid.get(x + "," + y) || []) { const d = hav(p, nodes.get(k)); if (d < bd) { bd = d; best = k; } }
  return best;
}
class Heap { constructor() { this.a = []; }
  push(x) { const a = this.a; a.push(x); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
  pop() { const a = this.a, t = a[0], l = a.pop(); if (a.length) { a[0] = l; let i = 0; for (;;) { let m = i, L = 2 * i + 1, R = L + 1; if (L < a.length && a[L][0] < a[m][0]) m = L; if (R < a.length && a[R][0] < a[m][0]) m = R; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } } return t; }
  get size() { return this.a.length; } }
function route(s, t, limit) {
  const dist = new Map([[s, 0]]), prev = new Map(), h = new Heap(); h.push([0, s]);
  while (h.size) {
    const [d, u] = h.pop(); if (d > dist.get(u)) continue; if (u === t) break; if (d > limit) return null;
    for (const [v, w] of adj.get(u)) { const nd = d + w; if (nd < (dist.get(v) ?? Infinity)) { dist.set(v, nd); prev.set(v, u); h.push([nd, v]); } }
  }
  if (!dist.has(t)) return null;
  const out = []; for (let c = t; c !== undefined; c = prev.get(c)) out.push(nodes.get(c));
  return out.reverse();
}
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop(); let md = 0, mi = -1;
    for (let i = a + 1; i < b; i++) {
      const [x, y] = pts[i], [x1, y1] = pts[a], [x2, y2] = pts[b], dx = x2 - x1, dy = y2 - y1;
      const u = dx || dy ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy))) : 0;
      const d = Math.hypot(x - (x1 + u * dx), y - (y1 + u * dy)); if (d > md) { md = d; mi = i; }
    }
    if (md > tol) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
const out = {}, st = {}, snapK = {};
for (const [name, p] of Object.entries(net.stations)) { const k = snap(p); if (k) { snapK[name] = k; st[name] = nodes.get(k); } else console.log("No track near station:", name); }
let ok = 0, bad = [];
for (const [a, b] of net.edges) {
  if (!snapK[a] || !snapK[b]) { bad.push(a + " - " + b + " (no snap)"); continue; }
  const straight = hav(net.stations[a], net.stations[b]);
  const p = route(snapK[a], snapK[b], Math.max(25, straight * 3));
  if (!p) { bad.push(a + " - " + b + " (no track path)"); continue; }
  out[a + "|" + b] = simplify(p, 0.0002); ok++;
}
out._st = st;
fs.writeFileSync(OUT, JSON.stringify(out));
console.log(`Done: ${ok} of ${net.edges.length} links follow real track. Wrote edges.json (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB).`);
if (bad.length) console.log("Left as straight lines:\n  " + bad.join("\n  "));
