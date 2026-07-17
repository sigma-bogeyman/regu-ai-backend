// ─────────────────────────────────────────────────────────────
//  The Exchange — RegVerse community forum
//  Self-contained module. Mounted from index.js via registerForumRoutes(app, deps).
//  Additive only: it registers /exchange/* routes and touches nothing else.
// ─────────────────────────────────────────────────────────────
import { ObjectId } from "mongodb";

// Categories are fixed constants (no separate collection needed for MVP).
export const CATEGORIES = [
  { slug: "eu-variations",  name: "EU Variations",     desc: "Type IA/IB/II, CHMP, procedures", icon: "🇪🇺" },
  { slug: "us-fda",         name: "US / FDA",          desc: "510(k), PMA, CMC, guidances",     icon: "🏛️" },
  { slug: "medical-devices",name: "Medical Devices",   desc: "MDR, MDCG, Notified Bodies",      icon: "🩺" },
  { slug: "career",         name: "Career & Interview",desc: "Roles, prep, salaries, growth",   icon: "💬" },
  { slug: "general",        name: "General",           desc: "Everything else in reg affairs",  icon: "🗂️" },
];
const CATEGORY_SLUGS = new Set(CATEGORIES.map(c => c.slug));

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "abinesh345@gmail.com")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
const isAdmin = (user) => user && ADMIN_EMAILS.includes((user.email || "").toLowerCase());

const clampStr = (s, n) => String(s || "").trim().slice(0, n);
const cleanTags = (t) => (Array.isArray(t) ? t : []).map(x => clampStr(x, 24)).filter(Boolean).slice(0, 5);

// Shape a thread doc for the client (list form — no full body).
function threadCard(t, { trending = false } = {}) {
  return {
    id: t._id.toString(),
    title: t.title,
    snippet: (t.body || "").slice(0, 140),
    category: t.category,
    tags: t.tags || [],
    author: { name: t.authorName, verified: !!t.authorVerified, role: t.authorRole || "" },
    upvotes: (t.upvotes || []).length,
    replyCount: t.replyCount || 0,
    createdAt: t.createdAt,
    lastActivityAt: t.lastActivityAt || t.createdAt,
    trending,
  };
}

// Simple "hot" score: engagement decayed by age.
function hotScore(t) {
  const up = (t.upvotes || []).length;
  const ageH = Math.max(1, (Date.now() - new Date(t.createdAt).getTime()) / 3.6e6);
  return (up * 2 + (t.replyCount || 0) * 3 + 1) / Math.pow(ageH + 2, 1.4);
}

export function registerForumRoutes(app, { getDb, requireAuth }) {
  // ── Categories ──────────────────────────────────────────
  app.get("/exchange/categories", async (req, res) => {
    try {
      const db = await getDb();
      const counts = await db.collection("forum_threads").aggregate([
        { $match: { status: { $ne: "removed" } } },
        { $group: { _id: "$category", n: { $sum: 1 } } },
      ]).toArray();
      const map = Object.fromEntries(counts.map(c => [c._id, c.n]));
      res.json(CATEGORIES.map(c => ({ ...c, threads: map[c.slug] || 0 })));
    } catch (e) {
      // categories are static — still return them even if the count query fails
      res.json(CATEGORIES.map(c => ({ ...c, threads: 0 })));
    }
  });

  // ── Feed: sort = hot | recent | unanswered ; optional category / tag ──
  app.get("/exchange/feed", async (req, res) => {
    try {
      const sort = ["hot", "recent", "unanswered"].includes(req.query.sort) ? req.query.sort : "hot";
      const q = { status: { $ne: "removed" } };
      if (req.query.category && CATEGORY_SLUGS.has(req.query.category)) q.category = req.query.category;
      if (req.query.tag) q.tags = req.query.tag;
      if (sort === "unanswered") q.replyCount = { $lte: 0 };

      const db = await getDb();
      let docs = await db.collection("forum_threads").find(q).sort({ lastActivityAt: -1 }).limit(120).toArray();

      if (sort === "hot") {
        docs = docs.map(d => ({ d, s: hotScore(d) })).sort((a, b) => b.s - a.s).slice(0, 40)
          .map((x, i) => threadCard(x.d, { trending: i < 3 }));
      } else {
        docs = docs.slice(0, 40).map(d => threadCard(d));
      }
      res.json(docs);
    } catch (e) {
      console.error("[/exchange/feed]", e);
      res.status(500).json({ error: "Could not load The Exchange." });
    }
  });

  // ── Single thread + replies ─────────────────────────────
  app.get("/exchange/threads/:id", async (req, res) => {
    try {
      let _id; try { _id = new ObjectId(req.params.id); } catch { return res.status(400).json({ error: "Invalid id" }); }
      const db = await getDb();
      const t = await db.collection("forum_threads").findOne({ _id });
      if (!t || t.status === "removed") return res.status(404).json({ error: "Discussion not found." });
      const replies = await db.collection("forum_replies")
        .find({ threadId: _id.toString(), status: { $ne: "removed" } })
        .sort({ createdAt: 1 }).toArray();
      res.json({
        id: t._id.toString(),
        title: t.title,
        body: t.body,
        category: t.category,
        tags: t.tags || [],
        author: { name: t.authorName, verified: !!t.authorVerified, role: t.authorRole || "" },
        upvotes: (t.upvotes || []).length,
        replyCount: t.replyCount || 0,
        createdAt: t.createdAt,
        replies: replies.map(r => ({
          id: r._id.toString(),
          body: r.body,
          author: { name: r.authorName, verified: !!r.authorVerified, role: r.authorRole || "" },
          upvotes: (r.upvotes || []).length,
          createdAt: r.createdAt,
        })),
      });
    } catch (e) {
      console.error("[GET /exchange/threads/:id]", e);
      res.status(500).json({ error: "Could not load this discussion." });
    }
  });

  // ── Create a thread (auth) ──────────────────────────────
  app.post("/exchange/threads", requireAuth, async (req, res) => {
    try {
      const title = clampStr(req.body?.title, 160);
      const body = clampStr(req.body?.body, 8000);
      const category = req.body?.category;
      if (title.length < 5) return res.status(400).json({ error: "Give your post a clearer title (min 5 characters)." });
      if (!CATEGORY_SLUGS.has(category)) return res.status(400).json({ error: "Pick a category." });
      if (body.length < 1) return res.status(400).json({ error: "Add some detail to your post." });

      const db = await getDb();
      const now = new Date();
      const doc = {
        title, body, category, tags: cleanTags(req.body?.tags),
        authorId: req.user._id.toString(),
        authorName: req.user.name || (req.user.email || "").split("@")[0],
        authorVerified: !!req.user.verified,
        authorRole: req.user.role || "",
        upvotes: [], replyCount: 0, reports: [],
        status: "active", createdAt: now, lastActivityAt: now,
      };
      const r = await db.collection("forum_threads").insertOne(doc);
      res.json({ id: r.insertedId.toString() });
    } catch (e) {
      console.error("[POST /exchange/threads]", e);
      res.status(500).json({ error: "Could not post. Please try again." });
    }
  });

  // ── Reply to a thread (auth) ────────────────────────────
  app.post("/exchange/threads/:id/replies", requireAuth, async (req, res) => {
    try {
      const body = clampStr(req.body?.body, 8000);
      if (body.length < 1) return res.status(400).json({ error: "Write a reply first." });
      let _id; try { _id = new ObjectId(req.params.id); } catch { return res.status(400).json({ error: "Invalid id" }); }
      const db = await getDb();
      const t = await db.collection("forum_threads").findOne({ _id });
      if (!t || t.status === "removed") return res.status(404).json({ error: "Discussion not found." });

      const now = new Date();
      const reply = {
        threadId: _id.toString(), body,
        authorId: req.user._id.toString(),
        authorName: req.user.name || (req.user.email || "").split("@")[0],
        authorVerified: !!req.user.verified,
        authorRole: req.user.role || "",
        upvotes: [], reports: [], status: "active", createdAt: now,
      };
      const ins = await db.collection("forum_replies").insertOne(reply);
      await db.collection("forum_threads").updateOne({ _id }, { $inc: { replyCount: 1 }, $set: { lastActivityAt: now } });
      res.json({ id: ins.insertedId.toString() });
    } catch (e) {
      console.error("[POST reply]", e);
      res.status(500).json({ error: "Could not post your reply." });
    }
  });

  // ── Toggle upvote on a thread or reply (auth) ───────────
  const upvote = (collection) => async (req, res) => {
    try {
      let _id; try { _id = new ObjectId(req.params.id); } catch { return res.status(400).json({ error: "Invalid id" }); }
      const db = await getDb();
      const uid = req.user._id.toString();
      const doc = await db.collection(collection).findOne({ _id });
      if (!doc || doc.status === "removed") return res.status(404).json({ error: "Not found." });
      const has = (doc.upvotes || []).includes(uid);
      await db.collection(collection).updateOne({ _id }, has ? { $pull: { upvotes: uid } } : { $addToSet: { upvotes: uid } });
      res.json({ upvotes: (doc.upvotes || []).length + (has ? -1 : 1), upvoted: !has });
    } catch (e) {
      console.error("[upvote]", e);
      res.status(500).json({ error: "Could not register your vote." });
    }
  };
  app.post("/exchange/threads/:id/upvote", requireAuth, upvote("forum_threads"));
  app.post("/exchange/replies/:id/upvote", requireAuth, upvote("forum_replies"));

  // ── Report a thread or reply (auth) ─────────────────────
  const report = (collection) => async (req, res) => {
    try {
      let _id; try { _id = new ObjectId(req.params.id); } catch { return res.status(400).json({ error: "Invalid id" }); }
      const db = await getDb();
      await db.collection(collection).updateOne(
        { _id },
        { $addToSet: { reports: { by: req.user._id.toString(), reason: clampStr(req.body?.reason, 200), at: new Date() } } }
      );
      res.json({ ok: true });
    } catch (e) {
      console.error("[report]", e);
      res.status(500).json({ error: "Could not submit the report." });
    }
  };
  app.post("/exchange/threads/:id/report", requireAuth, report("forum_threads"));
  app.post("/exchange/replies/:id/report", requireAuth, report("forum_replies"));

  // ── Remove a thread/reply (author or admin) ─────────────
  const remove = (collection) => async (req, res) => {
    try {
      let _id; try { _id = new ObjectId(req.params.id); } catch { return res.status(400).json({ error: "Invalid id" }); }
      const db = await getDb();
      const doc = await db.collection(collection).findOne({ _id });
      if (!doc) return res.status(404).json({ error: "Not found." });
      if (doc.authorId !== req.user._id.toString() && !isAdmin(req.user)) return res.status(403).json({ error: "Not allowed." });
      await db.collection(collection).updateOne({ _id }, { $set: { status: "removed" } });
      res.json({ ok: true });
    } catch (e) {
      console.error("[remove]", e);
      res.status(500).json({ error: "Could not remove." });
    }
  };
  app.delete("/exchange/threads/:id", requireAuth, remove("forum_threads"));
  app.delete("/exchange/replies/:id", requireAuth, remove("forum_replies"));

  // ── ADMIN moderation ────────────────────────────────────
  const requireAdmin = (req, res, next) => {
    if (!isAdmin(req.user)) return res.status(403).json({ error: "Admins only." });
    next();
  };

  // Reports queue — every non-removed thread/reply that has at least one report.
  app.get("/exchange/admin/reports", requireAuth, requireAdmin, async (req, res) => {
    try {
      const db = await getDb();
      const [threads, replies] = await Promise.all([
        db.collection("forum_threads").find({ status: { $ne: "removed" }, "reports.0": { $exists: true } }).toArray(),
        db.collection("forum_replies").find({ status: { $ne: "removed" }, "reports.0": { $exists: true } }).toArray(),
      ]);
      const items = [
        ...threads.map(t => ({ kind: "thread", id: t._id.toString(), title: t.title, body: t.body, author: t.authorName, category: t.category, reports: t.reports || [], reportCount: (t.reports || []).length, createdAt: t.createdAt })),
        ...replies.map(r => ({ kind: "reply", id: r._id.toString(), threadId: r.threadId, body: r.body, author: r.authorName, reports: r.reports || [], reportCount: (r.reports || []).length, createdAt: r.createdAt })),
      ].sort((a, b) => b.reportCount - a.reportCount || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      res.json(items);
    } catch (e) {
      console.error("[/exchange/admin/reports]", e);
      res.status(500).json({ error: "Could not load reports." });
    }
  });

  // Dismiss reports on an item (keeps the content, clears the flags).
  app.post("/exchange/admin/dismiss/:kind/:id", requireAuth, requireAdmin, async (req, res) => {
    try {
      const coll = req.params.kind === "reply" ? "forum_replies" : "forum_threads";
      let _id; try { _id = new ObjectId(req.params.id); } catch { return res.status(400).json({ error: "Invalid id" }); }
      const db = await getDb();
      await db.collection(coll).updateOne({ _id }, { $set: { reports: [] } });
      res.json({ ok: true });
    } catch (e) {
      console.error("[/exchange/admin/dismiss]", e);
      res.status(500).json({ error: "Could not dismiss." });
    }
  });
}
