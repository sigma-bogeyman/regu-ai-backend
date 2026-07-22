import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import Parser from "rss-parser";
import OpenAI from "openai";
import { MongoClient, ObjectId } from "mongodb";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { registerForumRoutes } from "./forum.js";

const openai = (process.env.OPENAI_API_KEY || process.env.Open_AI_RegVerse)
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY || process.env.Open_AI_RegVerse })
  : null;

// In-memory job store for async AI analysis (cleared on restart — fine for stateless Railway)
const aiJobs = new Map(); // jobId -> { status, result, error }

const app = express();
const parser = new Parser({
  timeout: 6000,
  headers: { "User-Agent": "RegVerse/1.0 (regulatory-intelligence-app)" },
});

// Lock CORS to Capacitor app origins only
app.use(cors({
  origin: ["capacitor://localhost", "https://localhost", "http://localhost"],
  methods: ["GET", "POST", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
app.use(express.json());

// Brute-force protection on credential endpoints. Defined here (before the auth
// routes below) so it is initialised by the time those routes are registered.
// 10 attempts per IP per 15 min covers honest typos but stops password spraying
// and stops /auth/forgot-password being used to spam email (and burn Resend credit).
const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Please wait a few minutes and try again." },
});

// ── AUTH: Mongo connection, JWT helpers, middleware ────────
const JWT_SECRET = process.env.JWT_SECRET || "dev-insecure-secret-change-me";
const MONGODB_URI = process.env.MONGODB_URI || "";

let _mongoClient = null;
let _db = null;
async function getDb() {
  if (_db) return _db;
  if (!MONGODB_URI) throw new Error("MONGODB_URI not configured");
  if (!_mongoClient) {
    _mongoClient = new MongoClient(MONGODB_URI);
    await _mongoClient.connect();
  }
  _db = _mongoClient.db(); // default DB from the connection string
  // Ensure unique email index (idempotent, safe to call repeatedly)
  try { await _db.collection("users").createIndex({ email: 1 }, { unique: true }); } catch {}
  return _db;
}

// Admin allow-list (comma-separated env, defaults to the owner). Used for moderation.
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "abinesh345@gmail.com")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

// Shape a Mongo user doc into the object the app expects
function publicUser(u) {
  return {
    id: u._id.toString(),
    name: u.name,
    email: u.email,
    plan: u.plan || "free",
    admin: ADMIN_EMAILS.includes((u.email || "").toLowerCase()),
  };
}

// ── Subscription products & entitlements ──────────────────────
const PRODUCT_ADFREE = "regverse_adfree_yearly"; // ₹199 — removes ads only
const PRODUCT_PRO    = "regverse_pro_yearly";    // ₹349 — all features + no ads
// Map a Google Play productId to the plan we store on the user.
// Legacy single product (regverse_premium_yearly) counts as full Pro.
function planForProduct(pid) {
  return pid === PRODUCT_ADFREE ? "adfree" : "pro";
}
// Pro entitlement = unlocks paid features (Expert Analysis, Mind Maps, Submission Tracker).
// Ad-Free (₹199) is NOT Pro. Admins are always Pro.
function isProUser(u) {
  if (!u) return false;
  if (ADMIN_EMAILS.includes((u.email || "").toLowerCase())) return true;
  return u.plan === "pro" || u.plan === "premium";
}

function signToken(userId) {
  return jwt.sign({ uid: userId }, JWT_SECRET, { expiresIn: "30d" });
}

// ── PASSWORD RESET config + email helper ───────────────────
// Public base URL where the reset page is served (this backend). The emailed
// link points here. Override with PUBLIC_URL if the domain changes.
const PUBLIC_URL   = process.env.PUBLIC_URL || "https://regu-ai-backend-production.up.railway.app";
const RESEND_KEY   = process.env.Resend || process.env.RESEND_API_KEY || "";
const RESEND_FROM  = process.env.RESEND_FROM || "RegVerse <onboarding@resend.dev>";
const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

// Send the reset email via Resend's HTTP API (no SDK needed).
async function sendResetEmail(to, link) {
  if (!RESEND_KEY) { console.warn("[reset] Resend key not set — skipping email send"); return; }
  const html = `<!doctype html><html><body style="margin:0;background:#f0f4f8;font-family:-apple-system,Segoe UI,sans-serif;padding:24px">
    <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #e2e8f0">
      <div style="background:#0f172a;border-bottom:2px solid #3b82f6;padding:20px 24px;color:#fff;font-size:18px;font-weight:800">RegVerse</div>
      <div style="padding:28px 24px;color:#0f172a">
        <div style="font-size:19px;font-weight:800;margin-bottom:10px">Reset your password</div>
        <div style="font-size:14px;color:#475569;line-height:1.6;margin-bottom:22px">We received a request to reset your RegVerse password. Tap the button below to set a new one. This link expires in 1 hour. If you didn't request this, you can ignore this email.</div>
        <a href="${link}" style="display:inline-block;background:#3b82f6;color:#fff;text-decoration:none;font-size:15px;font-weight:700;padding:13px 22px;border-radius:12px">Set a new password</a>
        <div style="font-size:12px;color:#94a3b8;line-height:1.6;margin-top:22px">Or paste this link into your browser:<br>${link}</div>
      </div>
    </div></body></html>`;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: RESEND_FROM, to: [to], subject: "Reset your RegVerse password", html }),
    });
    if (!r.ok) console.error("[reset] Resend error:", r.status, await r.text().catch(() => ""));
  } catch (e) {
    console.error("[reset] Resend send failed:", e);
  }
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ── GOOGLE PLAY BILLING verification (server-side) ─────────
const ANDROID_PACKAGE     = process.env.ANDROID_PACKAGE_NAME || "com.regverse.app";
const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL || "";
// Railway stores the PEM with literal \n — turn them back into real newlines.
const GOOGLE_PRIVATE_KEY  = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

let _gTok = { token: null, exp: 0 };
// Exchange the service-account key for a short-lived Google API access token.
async function getGoogleAccessToken() {
  if (_gTok.token && Date.now() < _gTok.exp - 60_000) return _gTok.token;
  if (!GOOGLE_CLIENT_EMAIL || !GOOGLE_PRIVATE_KEY) throw new Error("Google service account not configured");
  const assertion = jwt.sign(
    { scope: "https://www.googleapis.com/auth/androidpublisher" },
    GOOGLE_PRIVATE_KEY,
    { algorithm: "RS256", issuer: GOOGLE_CLIENT_EMAIL, audience: "https://oauth2.googleapis.com/token", expiresIn: 3600 }
  );
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  const data = await r.json();
  if (!data.access_token) throw new Error("Google token error: " + JSON.stringify(data));
  _gTok = { token: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 };
  return data.access_token;
}

// GET a subscription purchase's status from the Play Developer API.
async function getSubscription(productId, token) {
  const access = await getGoogleAccessToken();
  const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${ANDROID_PACKAGE}/purchases/subscriptions/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(token)}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${access}` } });
  const data = await r.json();
  if (!r.ok) throw new Error("subscription verify failed: " + JSON.stringify(data));
  return data; // { paymentState, expiryTimeMillis, acknowledgementState, ... }
}

// Acknowledge a purchase (required within 3 days or Google auto-refunds).
async function acknowledgeSubscription(productId, token) {
  const access = await getGoogleAccessToken();
  const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${ANDROID_PACKAGE}/purchases/subscriptions/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(token)}:acknowledge`;
  await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" }, body: "{}" });
}

// requireAuth — validates the Bearer token and loads req.user
async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Not authenticated" });
    const payload = jwt.verify(token, JWT_SECRET);
    const db = await getDb();
    const user = await db.collection("users").findOne({ _id: new ObjectId(payload.uid) });
    if (!user) return res.status(401).json({ error: "Account not found" });
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid or expired session" });
  }
}

// ── AUTH ROUTES ────────────────────────────────────────────
app.post("/auth/signup", authLimiter, async (req, res) => {
  try {
    const name = (req.body?.name || "").trim();
    const email = (req.body?.email || "").trim().toLowerCase();
    const password = req.body?.password || "";
    if (!email || !password) return res.status(400).json({ error: "Email and password are required" });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "Enter a valid email address" });
    if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });

    const db = await getDb();
    const existing = await db.collection("users").findOne({ email });
    if (existing) return res.status(409).json({ error: "An account with this email already exists" });

    const passwordHash = await bcrypt.hash(password, 10);
    const doc = { name: name || email.split("@")[0], email, passwordHash, plan: "free", createdAt: new Date() };
    const result = await db.collection("users").insertOne(doc);
    doc._id = result.insertedId;

    return res.json({ token: signToken(doc._id.toString()), user: publicUser(doc) });
  } catch (e) {
    if (e?.code === 11000) return res.status(409).json({ error: "An account with this email already exists" });
    console.error("[/auth/signup]", e);
    return res.status(500).json({ error: "Could not create account. Please try again." });
  }
});

app.post("/auth/signin", authLimiter, async (req, res) => {
  try {
    const email = (req.body?.email || "").trim().toLowerCase();
    const password = req.body?.password || "";
    if (!email || !password) return res.status(400).json({ error: "Email and password are required" });

    const db = await getDb();
    const user = await db.collection("users").findOne({ email });
    if (!user) return res.status(401).json({ error: "Incorrect email or password" });

    const ok = await bcrypt.compare(password, user.passwordHash || "");
    if (!ok) return res.status(401).json({ error: "Incorrect email or password" });

    return res.json({ token: signToken(user._id.toString()), user: publicUser(user) });
  } catch (e) {
    console.error("[/auth/signin]", e);
    return res.status(500).json({ error: "Could not sign in. Please try again." });
  }
});

app.get("/auth/me", requireAuth, (req, res) => {
  res.json(publicUser(req.user));
});

// ── SAVED ASSESSMENTS ──────────────────────────────────────
app.get("/assessments", requireAuth, async (req, res) => {
  try {
    const db = await getDb();
    const list = await db.collection("assessments")
      .find({ userId: req.user._id.toString() })
      .sort({ createdAt: -1 })
      .toArray();
    res.json(list.map(a => ({ ...a, _id: a._id.toString() })));
  } catch (e) {
    console.error("[GET /assessments]", e);
    res.status(500).json({ error: "Could not load saved assessments" });
  }
});

app.post("/assessments", requireAuth, async (req, res) => {
  try {
    const db = await getDb();
    const doc = {
      userId: req.user._id.toString(),
      title: req.body?.title || "Assessment",
      changeType: req.body?.changeType || "",
      regions: Array.isArray(req.body?.regions) ? req.body.regions : [],
      result: req.body?.result ?? null,
      createdAt: new Date(),
    };
    const result = await db.collection("assessments").insertOne(doc);
    res.json({ ...doc, _id: result.insertedId.toString() });
  } catch (e) {
    console.error("[POST /assessments]", e);
    res.status(500).json({ error: "Could not save assessment" });
  }
});

app.delete("/assessments/:id", requireAuth, async (req, res) => {
  try {
    const db = await getDb();
    let _id;
    try { _id = new ObjectId(req.params.id); } catch { return res.status(400).json({ error: "Invalid id" }); }
    await db.collection("assessments").deleteOne({ _id, userId: req.user._id.toString() });
    res.json({ ok: true });
  } catch (e) {
    console.error("[DELETE /assessments]", e);
    res.status(500).json({ error: "Could not delete assessment" });
  }
});

// ── PASSWORD RESET ─────────────────────────────────────────
// Always responds 200 with the same message so it never reveals whether an
// email is registered.
app.post("/auth/forgot-password", authLimiter, async (req, res) => {
  const generic = { ok: true, message: "If an account exists for that email, a reset link is on its way." };
  try {
    const email = (req.body?.email || "").trim().toLowerCase();
    if (!email) return res.status(400).json({ error: "Email is required" });

    const db = await getDb();
    const user = await db.collection("users").findOne({ email });
    if (user) {
      const rawToken = crypto.randomBytes(32).toString("hex");
      await db.collection("users").updateOne(
        { _id: user._id },
        { $set: { resetTokenHash: sha256(rawToken), resetTokenExp: Date.now() + RESET_TTL_MS } }
      );
      const link = `${PUBLIC_URL}/reset-password?uid=${user._id.toString()}&token=${rawToken}`;
      await sendResetEmail(email, link);
    }
    return res.json(generic);
  } catch (e) {
    console.error("[/auth/forgot-password]", e);
    return res.json(generic); // still generic — don't leak errors either
  }
});

// The page the emailed link opens. Self-contained HTML, RegVerse-styled.
app.get("/reset-password", (req, res) => {
  const uid = escapeHtml(req.query.uid || "");
  const token = escapeHtml(req.query.token || "");
  res.set("Content-Type", "text/html").send(`<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Reset password · RegVerse</title></head>
<body style="margin:0;background:#f0f4f8;font-family:-apple-system,Segoe UI,sans-serif;min-height:100vh;display:flex;align-items:flex-start;justify-content:center;padding:24px">
<div style="width:100%;max-width:420px;background:#fff;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden">
  <div style="background:#0f172a;border-bottom:2px solid #3b82f6;padding:18px 22px;color:#fff;font-size:18px;font-weight:800">RegVerse</div>
  <div style="padding:26px 22px" id="wrap">
    <div style="font-size:20px;font-weight:800;color:#0f172a;margin-bottom:4px">Set a new password</div>
    <div style="font-size:13px;color:#94a3b8;margin-bottom:20px">Choose a strong password for your account.</div>
    <div id="msg" style="display:none;border-radius:10px;padding:10px 14px;font-size:13px;margin-bottom:16px"></div>
    <label style="font-size:12px;font-weight:600;color:#475569;display:block;margin-bottom:6px">New password</label>
    <input id="pw" type="password" placeholder="Min 6 characters" style="width:100%;box-sizing:border-box;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:12px 14px;font-size:14px;color:#0f172a;margin-bottom:14px;outline:none">
    <label style="font-size:12px;font-weight:600;color:#475569;display:block;margin-bottom:6px">Confirm password</label>
    <input id="pw2" type="password" placeholder="Re-enter password" style="width:100%;box-sizing:border-box;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:12px 14px;font-size:14px;color:#0f172a;margin-bottom:20px;outline:none">
    <button id="btn" style="width:100%;background:#3b82f6;border:none;border-radius:12px;padding:14px;font-size:15px;font-weight:700;color:#fff;cursor:pointer">Reset password</button>
  </div>
</div>
<script>
  var uid=${JSON.stringify(uid)}, token=${JSON.stringify(token)};
  var btn=document.getElementById('btn'), msg=document.getElementById('msg');
  function show(t,ok){msg.style.display='block';msg.textContent=t;msg.style.background=ok?'#ecfdf5':'#fef2f2';msg.style.color=ok?'#047857':'#b91c1c';msg.style.border='1px solid '+(ok?'#a7f3d0':'#fecaca');}
  btn.onclick=function(){
    var pw=document.getElementById('pw').value, pw2=document.getElementById('pw2').value;
    if(pw.length<6){show('Password must be at least 6 characters.',false);return;}
    if(pw!==pw2){show('Passwords do not match.',false);return;}
    btn.disabled=true;btn.textContent='Resetting…';
    fetch('/auth/reset-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({uid:uid,token:token,password:pw})})
      .then(function(r){return r.json().then(function(d){return {ok:r.ok,d:d};});})
      .then(function(x){
        if(x.ok){document.getElementById('wrap').innerHTML='<div style="text-align:center;padding:20px 0"><div style="width:64px;height:64px;border-radius:50%;background:#ecfdf5;border:2px solid #a7f3d0;display:flex;align-items:center;justify-content:center;font-size:30px;color:#10b981;margin:0 auto 16px">✓</div><div style="font-size:19px;font-weight:800;color:#0f172a;margin-bottom:6px">Password updated</div><div style="font-size:13px;color:#475569;line-height:1.6">You can now open the RegVerse app and sign in with your new password.</div></div>';}
        else{show((x.d&&x.d.error)||'Could not reset password.',false);btn.disabled=false;btn.textContent='Reset password';}
      })
      .catch(function(){show('Network error. Please try again.',false);btn.disabled=false;btn.textContent='Reset password';});
  };
</script></body></html>`);
});

app.post("/auth/reset-password", async (req, res) => {
  try {
    const { uid, token, password } = req.body || {};
    if (!uid || !token || !password) return res.status(400).json({ error: "Missing fields" });
    if (String(password).length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });

    const db = await getDb();
    let _id;
    try { _id = new ObjectId(uid); } catch { return res.status(400).json({ error: "This reset link is invalid." }); }
    const user = await db.collection("users").findOne({ _id });
    if (!user || !user.resetTokenHash || !user.resetTokenExp) return res.status(400).json({ error: "This reset link is invalid or already used." });
    if (Date.now() > user.resetTokenExp) return res.status(400).json({ error: "This reset link has expired. Request a new one." });
    if (sha256(token) !== user.resetTokenHash) return res.status(400).json({ error: "This reset link is invalid." });

    const passwordHash = await bcrypt.hash(password, 10);
    await db.collection("users").updateOne(
      { _id },
      { $set: { passwordHash }, $unset: { resetTokenHash: "", resetTokenExp: "" } }
    );
    return res.json({ ok: true });
  } catch (e) {
    console.error("[/auth/reset-password]", e);
    return res.status(500).json({ error: "Could not reset password. Please try again." });
  }
});

// ── UPGRADE TO PREMIUM (verify Google Play purchase) ───────
// The app sends the Google purchaseToken here after a successful buy/restore.
// We verify it server-side, acknowledge it, mark the user premium, and return
// a fresh JWT so the app flips to premium immediately.
app.post("/auth/upgrade-premium", requireAuth, async (req, res) => {
  try {
    const { purchaseToken, productId } = req.body || {};
    if (!purchaseToken || !productId) return res.status(400).json({ error: "Missing purchase details" });

    let sub;
    try {
      sub = await getSubscription(productId, purchaseToken);
    } catch (e) {
      console.error("[upgrade-premium] verify:", e);
      return res.status(400).json({ error: "Could not verify this purchase with Google Play. Please try again." });
    }

    // paymentState: 0 pending, 1 received, 2 free trial, 3 deferred
    const paid = sub.paymentState === 1 || sub.paymentState === 2;
    const notExpired = Number(sub.expiryTimeMillis || 0) > Date.now();
    if (!paid || !notExpired) return res.status(400).json({ error: "This subscription is not active." });

    // Acknowledge if Google hasn't seen an ack yet (required within 3 days).
    if (sub.acknowledgementState === 0) {
      try { await acknowledgeSubscription(productId, purchaseToken); }
      catch (e) { console.error("[upgrade-premium] acknowledge:", e); }
    }

    const plan = planForProduct(productId); // "adfree" (₹199) or "pro" (₹349 / legacy)
    const db = await getDb();
    await db.collection("users").updateOne(
      { _id: req.user._id },
      { $set: { plan, subscription: { productId, purchaseToken, expiryTimeMillis: sub.expiryTimeMillis, updatedAt: new Date() } } }
    );
    const fresh = await db.collection("users").findOne({ _id: req.user._id });
    return res.json({ token: signToken(fresh._id.toString()), user: publicUser(fresh) });
  } catch (e) {
    console.error("[/auth/upgrade-premium]", e);
    return res.status(500).json({ error: "Could not complete the upgrade. Please try again." });
  }
});

// Rate limiters — 30 req/min for news, 20 req/min for analyze
const newsLimiter = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false });
const analyzeLimiter = rateLimit({ windowMs: 60_000, max: 20, standardHeaders: true, legacyHeaders: false });


// ── HOME ROUTE ────────────────────────────────────────────
app.get("/", (req, res) => {
  res.send("RegRadar backend running");
});


// ── RSS FEED DEFINITIONS ──────────────────────────────────
// Official feeds where confirmed working; Google News RSS for the rest
// Google News RSS is always available and never blocks
const GN = (q) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;

// LIVE_FEEDS: agencies with reliable RSS (official or Google News with unambiguous search terms)
const FEEDS = [
  // Official — confirmed working
  {
    agency: "MHRA",
    url: "https://www.gov.uk/search/news-and-communications.atom?organisations[]=medicines-and-healthcare-products-regulatory-agency",
    homeLink: "https://www.gov.uk/government/organisations/medicines-and-healthcare-products-regulatory-agency",
  },
  {
    agency: "ANVISA",
    url: "https://www.gov.br/anvisa/en/@@rss.xml",
    homeLink: "https://www.gov.br/anvisa/en",
  },

  // Google News RSS — reliable fallback for agencies with unambiguous search terms
  {
    agency: "FDA",
    url: GN("FDA pharmaceutical drug approval regulatory guidance"),
    homeLink: "https://www.fda.gov",
  },
  {
    agency: "EMA",
    // NOTE: do NOT include the bare token "EMA" — it also means "Exponential Moving
    // Average" (a stock indicator) and pulls in finance articles. Full name only.
    url: GN("\"European Medicines Agency\" medicines regulatory"),
    homeLink: "https://www.ema.europa.eu",
  },
  {
    agency: "TGA",
    url: GN("\"Therapeutic Goods Administration\" TGA Australia regulatory"),
    homeLink: "https://www.tga.gov.au",
  },
  {
    agency: "Health Canada",
    url: GN("\"Health Canada\" pharmaceutical drug regulatory guidance"),
    homeLink: "https://www.canada.ca/en/health-canada.html",
  },
  {
    agency: "PMDA",
    url: GN("PMDA Japan pharmaceutical regulatory approval"),
    homeLink: "https://www.pmda.go.jp/english/",
  },
  {
    agency: "EDQM",
    url: GN("EDQM \"European Pharmacopoeia\" regulatory"),
    homeLink: "https://www.edqm.eu",
  },
  {
    agency: "ICH",
    url: GN("ICH \"International Council for Harmonisation\" guideline pharmaceutical"),
    homeLink: "https://www.ich.org",
  },
  {
    agency: "CDSCO",
    url: GN("CDSCO India drug pharmaceutical regulatory approval"),
    homeLink: "https://cdsco.gov.in",
  },
];

// STATIC_ONLY_AGENCIES: these are guaranteed via static data (their names are too ambiguous
// for Google News or their RSS feeds are not publicly available in English)
const STATIC_ONLY_AGENCIES = new Set([
  "Medsafe", "NPRA", "HSA", "MFDS", "NMPA", "SFDA", "UAE Health", "Qatar MOPH",
]);


// ── STATIC FALLBACK (used when an RSS feed fails) ─────────
const STATIC_FALLBACK = {
  FDA: [
    { title: "FDA updates manufacturing guidance for sterile drug products", date: "2026-04-25", link: "https://www.fda.gov" },
    { title: "FDA issues safety communication on injectable medications", date: "2026-04-20", link: "https://www.fda.gov" },
    { title: "FDA releases draft guidance on labelling requirements", date: "2026-04-15", link: "https://www.fda.gov" },
  ],
  EMA: [
    { title: "EMA updates nitrosamine guidance for marketing authorisation holders", date: "2026-04-24", link: "https://www.ema.europa.eu" },
    { title: "EMA publishes new reflection paper on biologics comparability", date: "2026-04-18", link: "https://www.ema.europa.eu" },
    { title: "EMA CHMP issues positive opinion on new marketing authorisation", date: "2026-04-12", link: "https://www.ema.europa.eu" },
  ],
  MHRA: [
    { title: "MHRA updates variation filing process for post-Brexit landscape", date: "2026-04-23", link: "https://www.gov.uk/mhra" },
    { title: "MHRA introduces new clinical trial notification system", date: "2026-04-17", link: "https://www.gov.uk/mhra" },
    { title: "MHRA publishes GMP inspection outcomes annual report", date: "2026-04-11", link: "https://www.gov.uk/mhra" },
  ],
  TGA: [
    { title: "TGA updates GMP framework for biological medicines", date: "2026-04-22", link: "https://www.tga.gov.au" },
    { title: "TGA releases updated guidance on prescription medicine labelling", date: "2026-04-16", link: "https://www.tga.gov.au" },
    { title: "TGA launches enhanced eTGA regulatory submission portal", date: "2026-04-09", link: "https://www.tga.gov.au" },
  ],
  "Health Canada": [
    { title: "Health Canada releases biologics guidance document update", date: "2026-04-21", link: "https://www.canada.ca/en/health-canada.html" },
    { title: "Health Canada proposes amendments to Food and Drug Regulations", date: "2026-04-14", link: "https://www.canada.ca/en/health-canada.html" },
    { title: "Health Canada publishes post-market surveillance annual report", date: "2026-04-08", link: "https://www.canada.ca/en/health-canada.html" },
  ],
  PMDA: [
    { title: "PMDA updates QMS inspection procedures for medical devices", date: "2026-04-26", link: "https://www.pmda.go.jp/english" },
    { title: "PMDA announces new fast-track pathways for regenerative medicine", date: "2026-04-19", link: "https://www.pmda.go.jp/english" },
    { title: "PMDA releases updated guidelines for remote GMP audits", date: "2026-04-13", link: "https://www.pmda.go.jp/english" },
  ],
  ANVISA: [
    { title: "ANVISA revises API registration requirements for imported products", date: "2026-04-27", link: "https://www.gov.br/anvisa/en" },
    { title: "ANVISA publishes new GMP certification resolutions", date: "2026-04-18", link: "https://www.gov.br/anvisa/en" },
    { title: "ANVISA updates post-approval change classifications", date: "2026-04-10", link: "https://www.gov.br/anvisa/en" },
  ],
  EDQM: [
    { title: "EDQM implements CEP 2.0 formatting requirements for applications", date: "2026-04-28", link: "https://www.edqm.eu" },
    { title: "European Pharmacopoeia Supplement 11.3 published", date: "2026-04-22", link: "https://www.edqm.eu" },
    { title: "EDQM announces new limits for elemental impurities in excipients", date: "2026-04-12", link: "https://www.edqm.eu" },
  ],
  ICH: [
    { title: "ICH Q13 continuous manufacturing guideline adopted by regulatory bodies", date: "2026-04-26", link: "https://www.ich.org" },
    { title: "ICH Q9(R1) quality risk management implementation guide published", date: "2026-04-20", link: "https://www.ich.org" },
    { title: "ICH M11 clinical study protocol harmonisation guideline released", date: "2026-04-14", link: "https://www.ich.org" },
  ],
  CDSCO: [
    { title: "CDSCO mandates QR codes on active pharmaceutical ingredients", date: "2026-04-25", link: "https://cdsco.gov.in" },
    { title: "SUGAM portal upgraded for faster variation and new drug filings", date: "2026-04-19", link: "https://cdsco.gov.in" },
    { title: "CDSCO releases new risk-based GMP inspection guidelines", date: "2026-04-14", link: "https://cdsco.gov.in" },
  ],
  Medsafe: [
    { title: "Medsafe updates labelling requirements for prescription medicines", date: "2026-04-23", link: "https://www.medsafe.govt.nz" },
    { title: "Medsafe publishes new GMP compliance requirements for importers", date: "2026-04-16", link: "https://www.medsafe.govt.nz" },
    { title: "New Zealand regulatory update: provisional consent pathway amendments", date: "2026-04-09", link: "https://www.medsafe.govt.nz" },
  ],
  NPRA: [
    { title: "NPRA Malaysia updates product registration guidelines for biologics", date: "2026-04-24", link: "https://www.npra.gov.my" },
    { title: "NPRA issues new GMP inspection requirements for API manufacturers", date: "2026-04-17", link: "https://www.npra.gov.my" },
    { title: "NPRA publishes revised post-market surveillance framework", date: "2026-04-10", link: "https://www.npra.gov.my" },
  ],
  HSA: [
    { title: "HSA Singapore introduces streamlined pathway for innovative therapeutics", date: "2026-04-25", link: "https://www.hsa.gov.sg" },
    { title: "HSA updates GMP requirements aligned with PIC/S standards", date: "2026-04-18", link: "https://www.hsa.gov.sg" },
    { title: "HSA releases revised therapeutic products regulations", date: "2026-04-11", link: "https://www.hsa.gov.sg" },
  ],
  MFDS: [
    { title: "MFDS Korea updates bioequivalence testing guidelines for generic drugs", date: "2026-04-26", link: "https://www.mfds.go.kr/eng" },
    { title: "MFDS announces enhanced pharmacovigilance reporting requirements", date: "2026-04-20", link: "https://www.mfds.go.kr/eng" },
    { title: "MFDS Korea strengthens GMP inspections for imported pharmaceuticals", date: "2026-04-13", link: "https://www.mfds.go.kr/eng" },
  ],
  NMPA: [
    { title: "NMPA China releases updated technical guidelines for drug registration", date: "2026-04-27", link: "https://www.nmpa.gov.cn" },
    { title: "NMPA issues new specifications for clinical trial data requirements", date: "2026-04-21", link: "https://www.nmpa.gov.cn" },
    { title: "NMPA updates import drug registration pathway for multinationals", date: "2026-04-14", link: "https://www.nmpa.gov.cn" },
  ],
  SFDA: [
    { title: "SFDA Saudi Arabia updates drug registration requirements for biologics", date: "2026-04-24", link: "https://www.sfda.gov.sa/en" },
    { title: "SFDA issues new halal pharmaceutical manufacturing guidance", date: "2026-04-17", link: "https://www.sfda.gov.sa/en" },
    { title: "SFDA launches expedited review pathway for unmet medical needs", date: "2026-04-10", link: "https://www.sfda.gov.sa/en" },
  ],
  "UAE Health": [
    { title: "UAE MOHAP updates pharmaceutical product registration guidelines", date: "2026-04-23", link: "https://www.mohap.gov.ae/en" },
    { title: "UAE announces digital transformation of drug regulatory submissions", date: "2026-04-16", link: "https://www.mohap.gov.ae/en" },
    { title: "UAE DCCU releases new requirements for clinical trial authorisation", date: "2026-04-09", link: "https://www.mohap.gov.ae/en" },
  ],
  "Qatar MOPH": [
    { title: "Qatar MOPH updates pharmaceutical pricing and reimbursement policy", date: "2026-04-22", link: "https://www.moph.gov.qa/english" },
    { title: "Qatar issues new guidelines for drug import and registration", date: "2026-04-15", link: "https://www.moph.gov.qa/english" },
    { title: "Qatar MOPH strengthens pharmacovigilance reporting for market authorisation holders", date: "2026-04-08", link: "https://www.moph.gov.qa/english" },
  ],
};


// ── CACHE (15 min TTL) ────────────────────────────────────
const CACHE_TTL = 15 * 60 * 1000;

// Pre-fill cache with static data so the very first app request responds instantly
const _initialStatic = Object.entries(STATIC_FALLBACK).flatMap(([agency, items]) =>
  items.map((s) => ({ ...s, agency, source: "static" }))
);
_initialStatic.sort((a, b) => new Date(b.date) - new Date(a.date));
// Mark ts as stale (0) so the first real request will trigger a live refresh
let newsCache = { data: _initialStatic, ts: 0 };

// ── News relevance filter ─────────────────────────────────────
// Google News keyword feeds occasionally return off-topic items — most often
// finance/stock articles that match an ambiguous acronym (e.g. "EMA" also means
// the Exponential Moving Average stock indicator). This drops anything clearly
// non-regulatory by title pattern AND by source, so junk can't leak through no
// matter which feed produced it. Exclusion-only (a denylist), so it won't drop
// genuine regulatory headlines. If an agency ends up empty after filtering, the
// existing static-fallback logic fills it with curated items.
const FINANCE_TITLE_RE = /\b(stocks?|shares?|nasdaq|nyse|nyse:|portfolio|dividend|price target|buy rating|sell rating|market ?cap|hedge funds?|bullish|bearish|moving average|should you buy|is it a buy|earnings call|short interest|analyst price|upgraded to buy|downgraded to)\b/i;
const BLOCKED_NEWS_SOURCES = [
  "tradingview", "motley fool", "zacks", "marketbeat", "benzinga", "simply wall st",
  "seeking alpha", "insider monkey", "tipranks", "investorplace", "stocktwits",
  "barchart", "gurufocus", "wallstreetzen", "stocktitan", "market screener",
  "defense world", "etf daily news", "the cerbat gem", "modern readers",
];
function isRelevantArticle(title, link) {
  const t = title || "";
  if (FINANCE_TITLE_RE.test(t)) return false;
  // Google News titles end with " - <Publisher>"; block by publisher name.
  const dash = t.lastIndexOf(" - ");
  if (dash > 0) {
    const src = t.slice(dash + 3).trim().toLowerCase();
    if (BLOCKED_NEWS_SOURCES.some((s) => src === s || src.includes(s))) return false;
  }
  try {
    const host = new URL(link).hostname.replace(/^www\./, "").toLowerCase();
    if (BLOCKED_NEWS_SOURCES.some((s) => host.includes(s.replace(/\s+/g, "")))) return false;
  } catch { /* unparseable link — title checks already applied */ }
  return true;
}

async function buildNewsFeed() {
  // Fetch all RSS feeds in parallel — failures are caught individually
  const results = await Promise.allSettled(
    FEEDS.map(async ({ agency, url, homeLink }) => {
      const feed = await parser.parseURL(url);
      return (feed.items || [])
        .map((item) => ({
          agency,
          title: item.title?.replace(/<[^>]*>/g, "").trim() || "No title",
          date: item.pubDate || item.isoDate || new Date().toISOString(),
          link: item.link || homeLink,
          source: "live",
        }))
        .filter((a) => isRelevantArticle(a.title, a.link)) // drop finance/off-topic junk
        .slice(0, 25);
    })
  );

  const articles = [];
  const liveAgencies = new Set();

  results.forEach((result, i) => {
    const { agency } = FEEDS[i];
    if (result.status === "fulfilled" && result.value.length > 0) {
      articles.push(...result.value);
      liveAgencies.add(agency);
      console.log(`✓ ${agency}: ${result.value.length} live articles`);
    } else {
      const reason = result.reason?.message || "empty feed";
      console.log(`✗ ${agency}: ${reason} — using static fallback`);
    }
  });

  // Fill in static fallback for:
  //  a) any live-feed agency where RSS failed, AND
  //  b) ALL static-only agencies (always guaranteed)
  for (const [agency, statics] of Object.entries(STATIC_FALLBACK)) {
    if (!liveAgencies.has(agency) || STATIC_ONLY_AGENCIES.has(agency)) {
      articles.push(...statics.map((s) => ({ ...s, agency, source: "static" })));
    }
  }

  articles.sort((a, b) => new Date(b.date) - new Date(a.date));
  return articles;
}


// ── NEWS ROUTE ────────────────────────────────────────────
app.get("/news", newsLimiter, async (req, res) => {
  const now = Date.now();

  // Always respond immediately with whatever is cached (static or live)
  if (newsCache.data) {
    res.json(newsCache.data);
  }

  // If cache is stale, refresh in background (or foreground if nothing cached yet)
  if (now - newsCache.ts >= CACHE_TTL) {
    const deadline = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("RSS fetch exceeded 10s deadline")), 10000)
    );
    Promise.race([buildNewsFeed(), deadline])
      .then((data) => {
        newsCache = { data, ts: Date.now() };
        console.log(`Cache refreshed: ${data.length} total articles`);
      })
      .catch((err) => {
        console.log(`RSS refresh failed (${err.message}), static data retained`);
        // Mark cache as fresh so we don't hammer the feeds on every request
        newsCache = { ...newsCache, ts: Date.now() };
      });
  }
});


// ── ANALYZE ROUTE ─────────────────────────────────────────

// Severity matrix: changeType + riskFlags → High / Medium / Low
function calcSeverity(changeType, flags) {
  const highTypes = ["Site Transfer", "Process Change", "Formulation Change", "Excipient Change"];
  const medTypes  = ["Specification Change", "Analytical Method Change", "Shelf Life Extension",
                     "Container Closure Change", "Scale-up / Scale-down"];

  if (highTypes.includes(changeType) || flags.cqa || flags.impurity || flags.sterility) return "High";
  if (medTypes.includes(changeType)  || flags.validation) return "Medium";
  return "Low";
}

// Per-region filing matrix
const REGIONAL_MATRIX = {
  FDA: {
    High:   { filing: "Prior Approval Supplement (PAS)",         timeline: "6–12 months",  note: "Requires complete validation and comparability data before submission." },
    Medium: { filing: "Changes Being Effected in 30 Days (CBE-30)", timeline: "3–4 months", note: "Submit 30 days prior to distribution. FDA may convert to PAS." },
    Low:    { filing: "Annual Report",                            timeline: "1–2 months",  note: "Document in next Annual Product Review. No prior approval needed." },
  },
  EMA: {
    High:   { filing: "Type II Variation",         timeline: "60–90 days",  note: "CHMP assessment required. Protocol assistance available for complex changes." },
    Medium: { filing: "Type IB Variation",         timeline: "30 days",     note: "Do-and-tell after 30-day notification period unless CMDh objects." },
    Low:    { filing: "Type IA Variation (IAIN)",  timeline: "14–30 days",  note: "Notify EMA within 12 months of implementation for minor changes." },
  },
  MHRA: {
    High:   { filing: "Major Variation (prior approval)",  timeline: "90 days",     note: "Mirrors EMA Type II post-Brexit. May require MHRA-specific data." },
    Medium: { filing: "Minor Variation Type II",           timeline: "60 days",     note: "Prior approval required before implementation." },
    Low:    { filing: "Minor Variation Type I / Notification", timeline: "14–30 days", note: "Notification pathway for low-risk administrative changes." },
  },
  PMDA: {
    High:   { filing: "Partial Change Application (一部変更)",     timeline: "12–18 months", note: "Full review required. Engage PMDA early via consultation meeting." },
    Medium: { filing: "Minor Change Notification (軽微変更届)",     timeline: "30–60 days",   note: "Notify PMDA before or promptly after implementation." },
    Low:    { filing: "Minor Change Notification",                  timeline: "30 days",       note: "File notification within 30 days of implementation." },
  },
  TGA: {
    High:   { filing: "Category 1 Application",    timeline: "6–12 months", note: "Requires full supporting data. Pre-submission meeting recommended." },
    Medium: { filing: "Category 2 Application",    timeline: "3–4 months",  note: "TGA assessment required before implementation." },
    Low:    { filing: "Category 3 Notification",   timeline: "1–2 months",  note: "Self-assessed notification; retain supporting documentation." },
  },
  "Health Canada": {
    High:   { filing: "Supplement",                        timeline: "10–12 months", note: "Full review by Health Canada. Submit before implementation." },
    Medium: { filing: "Notifiable Change (Level I)",       timeline: "6 months",     note: "Notify Health Canada; may implement after 60 days if no objection." },
    Low:    { filing: "Annual Review / Notification",      timeline: "1–3 months",   note: "Record change and report in next annual review submission." },
  },
  ANVISA: {
    High:   { filing: "Type III Post-Registration Amendment", timeline: "12–18 months", note: "Approval required before implementation. High documentation burden." },
    Medium: { filing: "Type II Post-Registration Amendment",  timeline: "6–12 months",  note: "Prior approval required. ANVISA review timeline can be lengthy." },
    Low:    { filing: "Type I Amendment / Notification",      timeline: "1–3 months",   note: "Notify ANVISA; implementation after filing confirmation." },
  },
  CDSCO: {
    High:   { filing: "Major Amendment to Manufacturing Licence", timeline: "12–24 months", note: "CDSCO approval mandatory. Engage State Licensing Authority in parallel." },
    Medium: { filing: "Minor Amendment (Form 29)",                timeline: "3–6 months",   note: "Submit to CDSCO/State Authority before or at time of change." },
    Low:    { filing: "Notification / Annual Statement",          timeline: "1–3 months",   note: "Notify CDSCO via SUGAM portal; retain supporting data." },
  },
};

// CTD section mapping by change type + applies-to
function getCTDSections(changeType, appliesTo) {
  const isDS   = appliesTo === "Drug Substance (DS)";
  const isDP   = appliesTo === "Drug Product (DP)";
  const isBoth = !isDS && !isDP; // "Both DS & DP" or default

  const DS_sections = {
    "Process Change":           ["3.2.S.2.2", "3.2.S.2.3", "3.2.S.2.4", "3.2.S.2.5", "3.2.S.4.4"],
    "Site Transfer":            ["3.2.S.2.1", "3.2.S.2.2", "3.2.S.2.6", "GMP Certificate (3.2.R)"],
    "Specification Change":     ["3.2.S.4.1", "3.2.S.4.2", "3.2.S.4.3", "3.2.S.4.5"],
    "Analytical Method Change": ["3.2.S.4.2", "3.2.S.4.3"],
    "Shelf Life Extension":     ["3.2.S.7.1", "3.2.S.7.3"],
    "Container Closure Change": ["3.2.S.6", "3.2.S.7.1"],
    "Excipient Change":         ["3.2.S.2.3", "3.2.S.4.1"],
    "Formulation Change":       ["3.2.S.2.2", "3.2.S.4.1", "3.2.S.7.1"],
    "Scale-up / Scale-down":    ["3.2.S.2.2", "3.2.S.2.5", "3.2.S.4.4"],
    "Labelling Change":         ["Module 1.3 (Administrative)"],
  };

  const DP_sections = {
    "Process Change":           ["3.2.P.3.3", "3.2.P.3.4", "3.2.P.3.5", "3.2.P.5.4", "3.2.P.8.1"],
    "Site Transfer":            ["3.2.P.3.1", "3.2.P.3.3", "3.2.P.3.5", "GMP Certificate (3.2.R)"],
    "Specification Change":     ["3.2.P.5.1", "3.2.P.5.2", "3.2.P.5.3", "3.2.P.5.6"],
    "Analytical Method Change": ["3.2.P.5.2", "3.2.P.5.3"],
    "Shelf Life Extension":     ["3.2.P.8.1", "3.2.P.8.2", "3.2.P.8.3"],
    "Container Closure Change": ["3.2.P.2.4", "3.2.P.7", "3.2.P.8.1"],
    "Excipient Change":         ["3.2.P.1", "3.2.P.2.1", "3.2.P.3.3", "3.2.P.5.1", "3.2.P.8"],
    "Formulation Change":       ["3.2.P.1", "3.2.P.2", "3.2.P.3", "3.2.P.5", "3.2.P.8"],
    "Scale-up / Scale-down":    ["3.2.P.3.3", "3.2.P.3.5", "3.2.P.5.4"],
    "Labelling Change":         ["Module 1.3 (Administrative)", "3.2.P.1"],
  };

  const dsArr = DS_sections[changeType] || ["Module 3.2.S"];
  const dpArr = DP_sections[changeType] || ["Module 3.2.P"];

  if (isDS)   return dsArr;
  if (isDP)   return dpArr;
  return [...new Set([...dsArr, ...dpArr])];
}

// Recommendation generator
function makeRecommendation(changeType, severity, productType, regions) {
  const regionList = regions.join(", ");

  if (severity === "High") {
    return `This is a high-impact change requiring prior approval in most markets. Do not implement before receiving approval in all selected regions (${regionList}). Prepare a global comparability/validation package first and file sequentially — US and EU first, then follow-on markets. Consider ICH Q12 PACMP to streamline future changes of this type.`;
  }
  if (severity === "Medium") {
    return `This is a moderate-impact change. Compile the full supporting data package before submitting to ${regionList}. Notification timelines vary — confirm country-specific submission windows. Stability data should be available at the time of submission or committed to a post-approval protocol.`;
  }
  return `This is a low-risk change. File or notify as required by each market (${regionList}). Retain supporting documentation in your change control system. No prior approval is expected, but ensure all records are inspection-ready.`;
}

app.post("/analyze", analyzeLimiter, (req, res) => {
  try {
    const { input } = req.body;

    // Input validation
    if (!input || typeof input !== "object") {
      return res.status(400).json({ error: "Invalid request: input object is required" });
    }
    const { productType, appliesTo, changeType, regions, riskFlags } = input;
    if (!changeType || typeof changeType !== "string") {
      return res.status(400).json({ error: "Invalid request: changeType is required" });
    }

    const safeRegions  = Array.isArray(regions)  ? regions  : [];
    const safeFlags    = riskFlags && typeof riskFlags === "object" ? riskFlags : {};

    const flags = {
      cqa:        !!safeFlags.cqa,
      impurity:   !!safeFlags.impurity,
      sterility:  !!safeFlags.sterility,
      validation: !!safeFlags.validation,
    };

    const severity = calcSeverity(changeType, flags);
    const ctdSections = getCTDSections(changeType, appliesTo);

    const regionResults = {};
    for (const region of safeRegions) {
      const entry = REGIONAL_MATRIX[region]?.[severity];
      if (entry) {
        regionResults[region] = { ...entry, risk: severity };
      }
    }

    const riskNotes = [];
    if (flags.cqa)        riskNotes.push("CQA impact identified — comparability data required");
    if (flags.impurity)   riskNotes.push("Impurity profile change — ICH Q3A/Q3B justification needed");
    if (flags.sterility)  riskNotes.push("Sterility assurance impact — sterility validation data required");
    if (flags.validation) riskNotes.push("Process validation required — at least 3 conformance batches expected");

    res.json({
      severity,
      productType,
      changeType,
      appliesTo,
      regions: regionResults,
      ctdSections,
      riskNotes,
      recommendation: makeRecommendation(changeType, severity, productType || "", safeRegions),
    });
  } catch (e) {
    console.error("[/analyze] error:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});


// ── AI ANALYSIS — async job queue ────────────────────────────────────────────
const aiLimiter = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false });

// Shared scoping rules + JSON schema used by both prompts.
// `regions` is the exact list of markets the user selected — the model must never
// stray outside it (this is what stops EMA/EU appearing when it wasn't selected).
function insightContract(regions, domain) {
  const regionList = (regions || []).length ? regions.join(", ") : "(none specified)";
  const emaNote = domain === "device"
    ? "\n- IMPORTANT: The EMA does NOT regulate medical devices. Never mention EMA, EMA variations, or centralised procedure for a device change."
    : "";
  return `CRITICAL MARKET-SCOPING RULES (follow exactly):
- The user selected ONLY these markets: ${regionList}.
- Every guidance, risk, document, and strategy you give MUST be limited to these markets.
- Do NOT mention, cite, compare to, or reference ANY market, agency, or regulatory framework that is not in that list. In particular do NOT mention EMA or EU variation categories (Type IA/IB/II) unless an EU or EMA market is explicitly in the list above.
- "marketSpecific" MUST contain exactly one entry for each selected market and no others.${emaNote}

Respond with valid JSON only — no markdown, no prose outside the JSON — using this exact structure:
{
  "applicableGuidances": [
    { "code": "e.g. ICH Q12 / MDCG 2020-3 / ISO 14971 / 21 CFR 807.81", "section": "specific clause/section number if known, else \\"\\"", "title": "short title of the guideline", "relevance": "1-2 sentences on why THIS specific change triggers this guideline", "keyQuote": "the specific phrasing or snippet from that exact clause that applies to THIS change — reproduce the guideline's actual wording as precisely as possible; if you are not certain of the verbatim text, give the closest faithful paraphrase and never invent clause numbers or wording, else \\"\\"" }
  ],
  "keyPoints": [ "3 to 5 specific, change-specific, actionable insights citing the exact guideline or clause" ],
  "potentialRisks": [ "concrete regulatory or technical risks specific to this change; return [] if genuinely none" ],
  "submissionStrategy": "one paragraph on filing sequence and strategy ACROSS THE SELECTED MARKETS ONLY — leveraging prior approvals, clock-stop/objection risk, parallel vs sequential filing",
  "marketSpecific": [ { "market": "one of the selected markets", "documents": "the specific dossier sections / documents to prepare for that market", "note": "the filing type and timeline nuance for that market" } ],
  "strategicInsight": "one paragraph of higher-level strategic advice",
  "commonPitfalls": [ "reviewer focus areas or common mistakes for this change type" ],
  "preSubmissionRecommendations": [ "checklist items to complete before filing" ]
}
Provide 2 to 4 applicableGuidances. Be specific and technical — cite real guideline codes and clause numbers, not generic statements.`;
}

function buildPharmaPrompt(assessResult) {
  const regions = assessResult.selectedRegions || [];
  const euSelected = regions.some(r => /EU|EMA|EEA/i.test(r));
  return `You are a senior regulatory affairs expert in pharmaceutical post-approval change management (ICH Q8-Q12, CTD/eCTD, and the specific post-approval change frameworks of the selected markets only).

A regulatory assessment has been run.

Assessment context:
- Product type: ${assessResult.productType || "Pharmaceutical"}
- Change: ${assessResult.title || assessResult.code || "Unknown change"}
- Sub-section: ${assessResult.subSectionLabel || ""}
- Condition: ${assessResult.subTypeDesc || ""}${euSelected ? `\n- EU variation type: ${assessResult.euType || ""}` : ""}
- Severity: ${assessResult.severity || ""}
- Selected markets: ${regions.join(", ")}

${insightContract(regions, "pharma")}`;
}

function buildMDPrompt(assessResult) {
  const regions = assessResult.selectedRegions || [];
  const filingsSummary = (assessResult.filings || [])
    .map(f => `${f.territory} (${f.agency}): ${f.action?.label} — ${f.action?.timeline}`)
    .join("\n");

  return `You are a senior medical device regulatory consultant (ISO 13485, ISO 14971, IEC 62304, MDCG guidance, FDA 21 CFR Part 820 and 807, and the device frameworks of the selected markets only).

A device change assessment has been completed.

Assessment context:
- Device class: ${assessResult.mdDeviceClass || ""}
- Change type: ${assessResult.changeLabel || assessResult.mdChangeType || ""}
- Selected markets: ${regions.join(", ")}
- Filing requirements:
${filingsSummary}

${insightContract(regions, "device")}`;
}

app.post("/analyze/start", aiLimiter, requireAuth, async (req, res) => {
  // Expert Analysis is a Pro-only feature. Gate here so Free/Ad-Free accounts
  // can NEVER trigger an OpenAI call (no token cost), even via a direct API hit.
  if (!isProUser(req.user)) {
    return res.status(403).json({ error: "Expert Analysis is a Pro feature.", code: "pro_required" });
  }
  if (!openai) {
    return res.status(503).json({ error: "AI analysis not configured — OpenAI API key missing" });
  }
  try {
    const { assessResult } = req.body;
    if (!assessResult || typeof assessResult !== "object") {
      return res.status(400).json({ error: "assessResult is required" });
    }

    const jobId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    aiJobs.set(jobId, { status: "pending" });

    // Run AI generation asynchronously — don't await here
    const isMD = assessResult.productType === "Medical Device";
    const prompt = isMD ? buildMDPrompt(assessResult) : buildPharmaPrompt(assessResult);

    (async () => {
      try {
        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: prompt }],
          response_format: { type: "json_object" },
        });
        const text = completion.choices[0].message.content.trim();
        const parsed = JSON.parse(text);
        aiJobs.set(jobId, { status: "done", result: parsed });
      } catch (e) {
        console.error("[AI job error]", e.message);
        aiJobs.set(jobId, { status: "error", error: e.message });
      }
      // Clean up after 10 minutes
      setTimeout(() => aiJobs.delete(jobId), 10 * 60 * 1000);
    })();

    res.json({ jobId });
  } catch (e) {
    console.error("[/analyze/start]", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/analyze/status/:jobId", (req, res) => {
  const job = aiJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ status: "not_found" });
  res.json(job);
});


// The Exchange (community forum) — additive routes under /exchange
registerForumRoutes(app, { getDb, requireAuth });

const PORT = process.env.PORT || 5001;
app.listen(PORT, "0.0.0.0", () => {
  console.log("RegVerse backend running on port " + PORT);
});
