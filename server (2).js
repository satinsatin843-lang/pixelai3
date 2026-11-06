const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "10kb" }));
app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin"
  });
  next();
});

// ---------- Settings (Render > Environment me badal sakte ho) ----------
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT) || 15;
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const SECRET = process.env.SECRET || ADMIN_KEY || crypto.randomBytes(32).toString("hex");

// ---------- Chhota database (JSON file) ----------
const DATA_FILE = path.join(__dirname, "data.json");
let db = { users: {}, total: 0 };
try { db = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch (e) {}
function save() { try { fs.writeFileSync(DATA_FILE, JSON.stringify(db)); } catch (e) {} }
const today = () => new Date().toISOString().slice(0, 10);

function getUser(email) {
  if (!db.users[email]) db.users[email] = { joined: new Date().toISOString(), images: 0, day: "", today: 0 };
  return db.users[email];
}
function leftFor(email) {
  const u = db.users[email];
  if (!u) return DAILY_LIMIT;
  return Math.max(0, DAILY_LIMIT - (u.day === today() ? u.today : 0));
}

// ---------- Token (restart ke baad bhi chalta hai agar SECRET set ho) ----------
function sign(email) {
  const exp = Date.now() + 30 * 864e5;
  const p = Buffer.from(email + "|" + exp).toString("base64url");
  const s = crypto.createHmac("sha256", SECRET).update(p).digest("base64url");
  return p + "." + s;
}
function verify(t) {
  if (!t || typeof t !== "string" || t.length > 400) return null;
  const parts = t.split(".");
  if (parts.length !== 2) return null;
  const e = crypto.createHmac("sha256", SECRET).update(parts[0]).digest("base64url");
  const a = Buffer.from(parts[1]), b = Buffer.from(e);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const [email, exp] = Buffer.from(parts[0], "base64url").toString().split("|");
  if (!email || Number(exp) < Date.now()) return null;
  return email;
}

// ---------- Simple rate limit (IP ke hisaab se) ----------
const hits = new Map();
function limiter(name, max, windowMs) {
  return (req, res, next) => {
    const key = name + "|" + req.ip;
    const now = Date.now();
    const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
    if (arr.length >= max) return res.status(429).json({ error: "Bahut zyada requests, thodi der ruko." });
    arr.push(now); hits.set(key, arr);
    next();
  };
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some(t => now - t < 120000)) hits.delete(k); }, 300000).unref();

// ---------- Image options ----------
const STYLES = {
  none: "",
  photo: ", ultra realistic photo, sharp focus, natural lighting, high detail",
  cartoon: ", cartoon style, vibrant colors, clean outlines",
  anime: ", anime style, detailed, studio quality",
  art3d: ", 3d render, soft lighting, high detail",
  neon: ", neon cyberpunk, glowing lights, night city",
  watercolor: ", watercolor painting, soft textures",
  logo: ", minimal vector logo, flat design, white background",
  sketch: ", pencil sketch, detailed shading"
};
const RATIOS = { "1:1": [768, 768], "16:9": [1024, 576], "9:16": [576, 1024], "4:3": [896, 672] };
const MODELS = ["flux", "turbo"];

// ---------- Routes ----------
app.post("/api/login", limiter("login", 10, 60000), (req, res) => {
  const email = String((req.body && req.body.email) || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 120) {
    return res.status(400).json({ error: "Sahi email daalo." });
  }
  getUser(email); save();
  res.json({ token: sign(email), email, left: leftFor(email), limit: DAILY_LIMIT });
});

app.get("/api/me", (req, res) => {
  const email = verify(req.get("x-token"));
  if (!email) return res.status(401).json({ error: "Dobara login karo." });
  res.json({ email, left: leftFor(email), limit: DAILY_LIMIT });
});

app.post("/api/generate", limiter("gen", 12, 60000), async (req, res) => {
  const email = verify(req.get("x-token"));
  if (!email) return res.status(401).json({ error: "Dobara login karo." });

  const b = req.body || {};
  const prompt = String(b.prompt || "").trim().slice(0, 400);
  if (!prompt) return res.status(400).json({ error: "Prompt likho." });
  if (leftFor(email) <= 0) return res.status(429).json({ error: "Aaj ki free limit khatam. Kal dobara aao." });

  const style = STYLES[b.style] !== undefined ? b.style : "none";
  const [w, h] = RATIOS[b.ratio] || RATIOS["1:1"];
  const model = MODELS.includes(b.model) ? b.model : "flux";
  const seed = Number.isInteger(b.seed) && b.seed >= 0 && b.seed < 1e9 ? b.seed : Math.floor(Math.random() * 1e9);

  const url = "https://image.pollinations.ai/prompt/" + encodeURIComponent(prompt + STYLES[style]) +
    "?width=" + w + "&height=" + h + "&model=" + model + "&nologo=true&seed=" + seed;

  let r, lastErr;
  for (let i = 0; i < 2; i++) {
    try {
      r = await fetch(url, { signal: AbortSignal.timeout(70000) });
      if (r.ok) break;
      lastErr = "api " + r.status;
    } catch (e) { lastErr = e.message; }
    r = null;
  }
  if (!r) return res.status(502).json({ error: "Image nahi ban payi, thodi der baad try karo." });

  const buf = Buffer.from(await r.arrayBuffer());
  const u = getUser(email);
  if (u.day !== today()) { u.day = today(); u.today = 0; }
  u.today++; u.images++; db.total++; save();

  res.set({
    "Content-Type": r.headers.get("content-type") || "image/jpeg",
    "x-left": String(leftFor(email)),
    "x-seed": String(seed),
    "Access-Control-Expose-Headers": "x-left, x-seed"
  });
  res.send(buf);
});

app.get("/api/admin", (req, res) => {
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) return res.status(403).json({ error: "Galat key." });
  const list = Object.entries(db.users)
    .map(([email, u]) => ({ email, joined: u.joined, images: u.images }))
    .sort((a, b) => b.images - a.images);
  res.json({ users: list.length, images: db.total, list });
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "admin.html")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("PixelAI Pro chal raha hai, port " + PORT));
