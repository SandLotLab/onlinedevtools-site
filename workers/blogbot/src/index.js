/* eslint-disable no-console */

/**
 * BlogBot Worker — onlinedevtools-site
 *
 * Flow:
 *   Cron / API trigger
 *   → Durable Object gate (run-lock + schedule check)
 *   → Brave Search (gather authoritative sources)
 *   → Fetch excerpts (bounded)
 *   → Anthropic Messages API (generate article JSON)
 *   → Quality checks (no scripts, citations valid, plagiarism safeguard)
 *   → GitHub: create branch → commit files → open PR → AUTO-MERGE
 *   → Cloudflare Pages deploys on merge automatically
 */

const DEFAULT_HEADERS = {
  "User-Agent": "onlinedevtools-blogbot/1.0 (+https://onlinedevtools.app/blog)"
};

// ─── Entry point ─────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true, ts: new Date().toISOString() }, 200);
    }

    if (url.pathname === "/api/blogbot/run" && request.method === "POST") {
      const auth = request.headers.get("Authorization") || "";
      if (!timingSafeEqual(auth, `Bearer ${env.BLOGBOT_ADMIN_TOKEN || ""}`)) {
        return json({ ok: false, error: "unauthorized" }, 401);
      }

      const body = await safeJson(request);
      const dryRun        = !!body?.dryRun;
      const force         = !!body?.force;  // bypass schedule gate (testing only)
      const topicOverride = typeof body?.topic === "string" ? body.topic : null;

      const result = await runOnce(env, ctx, { trigger: "api", dryRun, force, topicOverride });
      return json({ ok: true, result }, 200);
    }

    return json({ ok: false, error: "not_found" }, 404);
  },

  async scheduled(event, env, ctx) {
    const result = await runOnce(env, ctx, { trigger: "cron", dryRun: false, topicOverride: null });
    console.log("scheduled run result:", result?.status, result?.reason || "");
  }
};

// ─── Durable Object ───────────────────────────────────────────────────────────

export class BlogBotState {
  constructor(state, env) {
    this.state = state;
    this.env   = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    // POST /begin — schedule gate + run-lock
    if (url.pathname === "/begin" && request.method === "POST") {
      const body = await safeJson(request);

      const nowIso      = body?.nowIso || new Date().toISOString();
      const now         = new Date(nowIso);
      const tz          = body?.tz || "America/Los_Angeles";
      const publishDays = (body?.publishDays || "2,5")
        .split(",").map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n));

      const local = toZonedParts(now, tz);

      const stateObj       = await this.state.storage.get("state") || {};
      const lastLocalDate  = stateObj.lastLocalDate  || null;
      const inProgress     = stateObj.inProgress     || false;
      const inProgressSince = stateObj.inProgressSince || null;

      // Soft lock: if stuck >20 min, allow another run
      if (inProgress && inProgressSince) {
        const ageMs = now.getTime() - new Date(inProgressSince).getTime();
        if (ageMs < 20 * 60 * 1000) {
          return json({ allowed: false, status: "locked", reason: "run_in_progress" }, 409);
        }
      }

      const localDate = local.date; // YYYY-MM-DD
      const localDow  = local.dow;  // 0..6

      if (!publishDays.includes(localDow)) {
  return json({ allowed: false, status: "skipped", reason: "not_publish_day", local }, 200);
}

if (lastLocalDate === localDate) {
  return json({ allowed: false, status: "skipped", reason: "already_ran_today", local }, 200);
}

      const rotationIndex = Number.isFinite(stateObj.rotationIndex) ? stateObj.rotationIndex : 0;

      await this.state.storage.put("state", {
        ...stateObj,
        inProgress: true,
        inProgressSince: now.toISOString(),
        pendingLocalDate: localDate,
        rotationIndex
      });

      return json({ allowed: true, rotationIndex, localDate, local }, 200);
    }

    // POST /finish — clear lock, advance rotation
    if (url.pathname === "/finish" && request.method === "POST") {
      const body     = await safeJson(request);
      const stateObj = await this.state.storage.get("state") || {};

      const nextRotationIndex = (Number.isFinite(stateObj.rotationIndex) ? stateObj.rotationIndex : 0) + 1;

      await this.state.storage.put("state", {
        ...stateObj,
        inProgress: false,
        inProgressSince: null,
        lastLocalDate: body?.localDate || stateObj.pendingLocalDate || stateObj.lastLocalDate || null,
        pendingLocalDate: null,
        lastResult: body || null,
        rotationIndex: nextRotationIndex,
        lastRunAt: new Date().toISOString()
      });

      return json({ ok: true }, 200);
    }

    // GET /last — inspect state (useful for debugging)
    if (url.pathname === "/last" && request.method === "GET") {
      const stateObj = await this.state.storage.get("state") || {};
      return json({ ok: true, state: stateObj }, 200);
    }

    return json({ ok: false, error: "not_found" }, 404);
  }
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

async function runOnce(env, ctx, { trigger, dryRun, force, topicOverride }) {
  const now         = new Date();
  const tz          = env.TIMEZONE      || "America/Los_Angeles";
  const publishDays = env.PUBLISH_DAYS  || "2,5";

  const stub = env.BLOGBOT_STATE.get(env.BLOGBOT_STATE.idFromName("singleton"));

  let rotationIndex = 0;
  let localDate     = toZonedParts(now, tz).date;

  if (force) {
    // Bypass schedule gate — for manual testing outside publish days.
    const stateRes  = await stub.fetch("https://blogbot-state/last", { method: "GET" });
    const stateData = await safeJson(stateRes);
    rotationIndex   = Number.isFinite(stateData?.state?.rotationIndex) ? stateData.state.rotationIndex : 0;
    console.log("force=true: bypassing schedule gate, rotationIndex=", rotationIndex);
  } else {
    // Gate: schedule check + run-lock (strongly consistent via DO)
    const beginRes = await stub.fetch("https://blogbot-state/begin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nowIso: now.toISOString(), tz, publishDays })
    });

    // Use safeJson — 204 has no body; raw .json() would throw outside the try-catch below.
    const begin = await safeJson(beginRes);

    if (!beginRes.ok) {
      return { status: "blocked", reason: begin?.reason || "lock_failed", http: beginRes.status };
    }

    if (!begin || begin?.allowed === false) {
      return { status: "skipped", reason: begin?.reason || "not_due" };
    }

    rotationIndex = begin.rotationIndex || 0;
    localDate     = begin.localDate || localDate;
  }

  try {
    const topic = pickTopic(env, rotationIndex, topicOverride);
    console.log("selected topic:", topic.id, topic.titleHint);

    const sources = await gatherSources(env, topic);

    const draft = await generatePostDraft(env, { topic, sources, localDate, now, tz });

    const qa = runQualityChecks(env, { draft, sources, topic });
    if (!qa.ok) {
      console.log("quality check failed:", JSON.stringify(qa.errors));
      await finishRun(stub, { localDate, status: "failed_quality", qa });
      return { status: "failed_quality", qa };
    }

    const files = await buildRepoWrites(env, { draft, topic, localDate, now, tz });

    if (dryRun) {
      await finishRun(stub, { localDate, status: "dry_run", slug: draft.slug, title: draft.title });
      return { status: "dry_run", slug: draft.slug, title: draft.title, files: files.map(f => f.path) };
    }

    // Create PR then immediately auto-merge it
    const pr = await commitAndAutoMerge(env, {
      title: `Blog: ${draft.title}`,
      body: buildPrBody(topic, draft, sources),
      files
    });

    await finishRun(stub, { localDate, status: "merged", slug: draft.slug, pr });
    return { status: "merged", slug: draft.slug, pr };

  } catch (err) {
    console.log("run error:", err?.stack || String(err));
    await finishRun(stub, { localDate, status: "error", error: String(err) });
    return { status: "error", error: String(err) };
  }
}

async function finishRun(stub, payload) {
  await stub.fetch("https://blogbot-state/finish", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
}

// ─── Topic rotation ────────────────────────────────────────────────────────────

function pickTopic(env, rotationIndex, override) {
  const tools      = toolCatalog(env);
  const siteTopics = siteTopicCatalog(env);
  const all        = interleave(siteTopics, tools);

  if (override) {
    const found =
      all.find(t => t.id === override) ||
      all.find(t => (t.titleHint || "").toLowerCase().includes(override.toLowerCase()));
    if (found) return found;
  }

  return all[Math.abs(rotationIndex) % all.length];
}

function toolCatalog(env) {
  const o = env.SITE_ORIGIN || "https://onlinedevtools.app";
  return [
    { kind: "tool", id: "jwt-decoder",      titleHint: "JWT debugging: decoding vs verifying, exp/nbf/iat, and safe troubleshooting",                        primaryUrl: `${o}/jwt-decoder`,      relatedUrls: [`${o}/base64-encoder-decoder`, `${o}/url-parser`] },
    { kind: "tool", id: "csp-analyzer",     titleHint: "CSP hardening workflow: from report-only to enforcement with practical testing",                      primaryUrl: `${o}/csp-analyzer`,     relatedUrls: [`${o}/diff-checker`, `${o}/log-explorer`] },
    { kind: "tool", id: "json-formatter",   titleHint: "JSON formatting for API debugging: predictable diffs, key sorting, and schema checks",                primaryUrl: `${o}/json-formatter`,   relatedUrls: [`${o}/json-editor`, `${o}/diff-checker`] },
    { kind: "tool", id: "whois-lookup",     titleHint: "WHOIS and domain intelligence: investigating ownership, registrar signals, and response workflows",    primaryUrl: `${o}/whois-lookup`,     relatedUrls: [`${o}/ip-lookup`, `${o}/hostname-to-ip`] },
    { kind: "tool", id: "hash-generator",   titleHint: "Hashing vs HMAC for engineers: choosing algorithms and avoiding common mistakes",                      primaryUrl: `${o}/hash-generator`,   relatedUrls: [`${o}/secure-paste`, `${o}/uuid-generator`] },
    { kind: "tool", id: "regex-tester",     titleHint: "Regex testing and debugging in the browser: flags, lookaheads, and common pitfalls",                  primaryUrl: `${o}/regex-tester`,     relatedUrls: [`${o}/diff-checker`, `${o}/log-explorer`] },
    { kind: "tool", id: "diff-checker",     titleHint: "Diffing configs and code changes safely: when to use unified vs side-by-side diffs",                  primaryUrl: `${o}/diff-checker`,     relatedUrls: [`${o}/json-formatter`, `${o}/log-explorer`] },
    { kind: "tool", id: "uuid-generator",   titleHint: "UUID v4 vs v7: entropy, monotonic ordering, and database index performance",                          primaryUrl: `${o}/uuid-generator`,   relatedUrls: [`${o}/hash-generator`, `${o}/secure-paste`] },
    { kind: "tool", id: "yaml-validator",   titleHint: "YAML validation and common CI/CD mistakes: anchors, multi-doc, and key ordering",                     primaryUrl: `${o}/yaml-validator`,   relatedUrls: [`${o}/json-formatter`, `${o}/diff-checker`] },
    { kind: "tool", id: "base64",           titleHint: "Base64 encoding in web APIs: URL-safe variants, padding, and common edge cases",                      primaryUrl: `${o}/base64-encoder-decoder`, relatedUrls: [`${o}/url-parser`, `${o}/jwt-decoder`] }
  ];
}

function siteTopicCatalog(env) {
  const o = env.SITE_ORIGIN || "https://onlinedevtools.app";
  return [
    { kind: "site", id: "local-first-security-tools",  titleHint: "Local-first browser security tools: threat model, privacy, and safe usage patterns",          primaryUrl: `${o}/about`, relatedUrls: [`${o}/privacy`, `${o}/tools`] },
    { kind: "site", id: "incident-response-toolbelt",  titleHint: "Building a lightweight incident-response toolbelt in the browser: repeatable workflows",       primaryUrl: `${o}/tools`, relatedUrls: [`${o}/log-explorer`, `${o}/diff-checker`] }
  ];
}

function interleave(a, b) {
  const out = [];
  const n   = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (i < a.length) out.push(a[i]);
    if (i < b.length) out.push(b[i]);
  }
  return out;
}

// ─── Source gathering (Brave Search) ─────────────────────────────────────────

async function gatherSources(env, topic) {
  const maxSources = parseInt(env.MAX_SOURCES || "8", 10);

  const queries = [
    `${topic.titleHint} official documentation`,
    `${topic.id} RFC spec`,
    `${topic.id} GitHub repo changelog`,
    `site:developers.cloudflare.com ${topic.id}`,
    `site:docs.github.com ${topic.id}`,
    `site:datatracker.ietf.org ${topic.id}`,
    `site:rfc-editor.org ${topic.id}`,
    `site:developer.mozilla.org ${topic.id}`
  ];

  const results = [];
  for (const q of queries) {
    const r = await braveWebSearch(env, q);
    for (const item of r) {
      if (!item.url || !item.title) continue;
      if (results.some(x => x.url === item.url)) continue;
      results.push(item);
      if (results.length >= maxSources * 2) break;
    }
    if (results.length >= maxSources * 2) break;
  }

  const scored = results
    .map(r => ({ ...r, score: authorityScore(r.url) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSources);

  const fetched = await Promise.all(
    scored.map(s => fetchExcerpt(env, s.url).then(ex => ({ ...s, excerpt: ex })))
  );

  return fetched.filter(s => (s.excerpt || "").length >= 200);
}

async function braveWebSearch(env, query) {
  const key = env.BRAVE_SEARCH_API_KEY;
  if (!key) throw new Error("Missing BRAVE_SEARCH_API_KEY");

  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", "10");
  url.searchParams.set("safesearch", "moderate");

  const res = await fetch(url.toString(), {
    headers: {
      ...DEFAULT_HEADERS,
      "Accept": "application/json",
      "X-Subscription-Token": key
    }
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Brave search failed: ${res.status} ${t.slice(0, 200)}`);
  }

  const data = await res.json();
  return (data?.web?.results || []).map(x => ({
    title: x.title,
    url: x.url,
    description: x.description || ""
  }));
}

function authorityScore(urlStr) {
  try {
    const u = new URL(urlStr);
    const h = u.hostname.toLowerCase();

    const highAuthority = [
      "developers.cloudflare.com",
      "docs.github.com",
      "developer.mozilla.org",
      "rfc-editor.org",
      "datatracker.ietf.org",
      "owasp.org",
      "github.com",
      "www.anthropic.com",
      "platform.claude.com",
      "developers.google.com",
      "www.rssboard.org"
    ];

    let score = 0;
    if (highAuthority.some(d => h === d || h.endsWith(`.${d}`))) score += 50;
    if (u.pathname.includes("/docs/") || u.pathname.includes("/documentation")) score += 15;
    if (u.pathname.includes("/blog/") || u.pathname.includes("/news/"))         score += 5;
    if (h.includes("medium.com"))   score -= 10;
    if (h.includes("reddit.com"))   score -= 25;
    return score;
  } catch {
    return 0;
  }
}

async function fetchExcerpt(env, url) {
  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 9000);
  try {
    const res = await fetch(url, { headers: DEFAULT_HEADERS, signal: controller.signal });
    if (!res.ok) return "";
    const html = await res.text();
    return html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 4000);
  } catch {
    return "";
  } finally {
    clearTimeout(timeout);
  }
}

// ─── LLM generation (Anthropic Messages API) ──────────────────────────────────

async function generatePostDraft(env, { topic, sources, localDate, now, tz }) {
  const minWords = parseInt(env.MIN_WORDS || "1400", 10);
  const maxWords = parseInt(env.MAX_WORDS || "2600", 10);
  const origin   = env.SITE_ORIGIN || "https://onlinedevtools.app";

  const numberedSources = sources.map((s, i) => ({
    n: i + 1,
    title: s.title,
    url: s.url,
    excerpt: (s.excerpt || s.description || "").slice(0, 900)
  }));

  const system = [
    "You are a senior security + infrastructure technical writer for Online Dev Tools.",
    "Write an original, SEO-forward article.",
    "You MUST ground all claims in the provided sources; do not invent citations.",
    "Cite sources inline using [n] where n matches the provided list.",
    "At the end include a short Sources list with the numbered URLs.",
    "Output MUST be valid JSON with keys:",
    "  title (string), description (string, ≤160 chars), slug (kebab-case string),",
    "  body_html (string — no <script> tags, no inline event handlers),",
    "  citations (array of {n, url, title}),",
    "  primary_tool_url (string), related_tool_urls (array of strings),",
    "  json_ld (JSON-LD string for schema.org Article).",
    "Hard rules: DO NOT invent sources. DO NOT quote more than 25 words from any single source.",
    "Prefer official docs, RFCs/specs, and vendor documentation over random blogs."
  ].join(" ");

  const user = [
    `DATE (local): ${localDate} (${tz})`,
    `SITE: ${origin}`,
    `TOPIC KIND: ${topic.kind}`,
    `TOPIC PROMPT: ${topic.titleHint}`,
    `PRIMARY TOOL PAGE: ${topic.primaryUrl}`,
    `RELATED TOOL PAGES: ${(topic.relatedUrls || []).join(", ")}`,
    `WORDS: target ${minWords}–${maxWords}`,
    "",
    "SOURCES (numbered):",
    ...numberedSources.map(s => `[${s.n}] ${s.title}\n${s.url}\nExcerpt: ${s.excerpt}`)
  ].join("\n");

  const model = env.ANTHROPIC_MODEL || "claude-opus-4-6";

  const resp = await anthropicMessages(env, {
    model,
    max_tokens: 3200,
    system,
    messages: [{ role: "user", content: user }]
  });

  const text = extractAnthropicText(resp);
console.log("RAW_LLM_TEXT_START");
console.log(text);
console.log("RAW_LLM_TEXT_END");

const parsed = safeParseJson(text);

if (!parsed?.title || !parsed?.body_html) {
  throw new Error(`LLM output missing required fields (title or body_html). Raw text: ${text}`);
}

  const slug = sanitizeSlug(parsed.slug || slugify(parsed.title));

  // Ensure the post links back to the primary tool page
  if (!String(parsed.body_html).includes(topic.primaryUrl)) {
    parsed.body_html = injectToolLinkBlock(parsed.body_html, topic);
  }

  const canonical = `${origin}/blog/${slug}`;

  parsed.json_ld = parsed.json_ld || JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Article",
    "headline": parsed.title,
    "datePublished": `${localDate}T09:00:00-07:00`,
    "dateModified":  `${localDate}T09:00:00-07:00`,
    "author":    [{ "@type": "Organization", "name": env.AUTHOR_NAME || "Online Dev Tools" }],
    "publisher":  { "@type": "Organization", "name": env.AUTHOR_NAME || "Online Dev Tools" },
    "mainEntityOfPage": canonical
  }, null, 2);

  return {
    title:            String(parsed.title).trim(),
    description:      String(parsed.description || "").trim().slice(0, 160),
    slug,
    body_html:        String(parsed.body_html),
    citations:        Array.isArray(parsed.citations) ? parsed.citations : [],
    primary_tool_url: parsed.primary_tool_url || topic.primaryUrl,
    related_tool_urls: parsed.related_tool_urls || topic.relatedUrls || [],
    json_ld:          typeof parsed.json_ld === "string" ? parsed.json_ld : JSON.stringify(parsed.json_ld, null, 2)
  };
}

async function anthropicMessages(env, payload) {
  const key = env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("Missing ANTHROPIC_API_KEY");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      ...DEFAULT_HEADERS,
      "content-type":       "application/json",
      "x-api-key":          key,
      "anthropic-version":  "2023-06-01"
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
  const t = await res.text();
  throw new Error(`Anthropic API failed: ${res.status} ${t}`);
}

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Anthropic API failed: ${res.status} ${t}`);
  }

  return res.json();
}

function extractAnthropicText(resp) {
  return (resp?.content || [])
    .filter(b => b?.type === "text" && typeof b?.text === "string")
    .map(b => b.text)
    .join("\n")
    .trim();
}

// ─── Quality checks ───────────────────────────────────────────────────────────

function runQualityChecks(env, { draft, sources, topic }) {
  const errors = [];

  if (/<script\b/i.test(draft.body_html))             errors.push("body_html contains <script> tag (disallowed)");
  if (draft.description.length < 80)                   errors.push("description too short (<80 chars)");
  if (!draft.slug || draft.slug.length < 8)            errors.push("slug too short");
  if (!String(draft.body_html).includes(topic.primaryUrl)) errors.push("missing required link to primary tool page");

  // Citation sanity: every [n] in body must exist in citations list
  const used     = Array.from(new Set(Array.from(String(draft.body_html).matchAll(/\[(\d+)\]/g)).map(m => Number(m[1]))));
  const provided = new Set((draft.citations || []).map(c => Number(c.n)).filter(n => Number.isFinite(n)));
  for (const u of used) {
    if (!provided.has(u)) errors.push(`citation [${u}] used in body but missing from citations list`);
  }

  // Anti-plagiarism: reject if long exact substrings overlap source excerpts
  const bodyText = stripTags(draft.body_html);
  for (const s of sources) {
    const ex = (s.excerpt || "").slice(0, 1500);
    if (!ex) continue;
    const overlap = longestCommonSubstring(bodyText, ex);
    if (overlap.length >= 140) {
      errors.push(`high overlap with source (${s.url}) substring length=${overlap.length}`);
      break;
    }
  }

  return { ok: errors.length === 0, errors };
}

// ─── Rendering + repo file writes ─────────────────────────────────────────────

async function buildRepoWrites(env, { draft, topic, localDate, now, tz }) {
  const origin = env.SITE_ORIGIN || "https://onlinedevtools.app";

  const templatePost  = await githubGetText(env, "templates/blog-post.html",  env.GITHUB_TARGET_BRANCH);
  const templateIndex = await githubGetText(env, "templates/blog-index.html", env.GITHUB_TARGET_BRANCH);

  const canonicalUrl = `${origin}/blog/${draft.slug}`;
  const sourcesHtml  = renderSourcesHtml(draft.citations);
  const readingTime  = estimateReadingTime(draft.body_html);

  const postHtml = templatePost
    .replaceAll("{{TITLE}}",        escapeHtml(draft.title))
    .replaceAll("{{DESCRIPTION}}",  escapeHtml(draft.description))
    .replaceAll("{{CANONICAL_URL}}", canonicalUrl)
    .replaceAll("{{AUTHOR}}",       escapeHtml(env.AUTHOR_NAME || "Online Dev Tools"))
    .replaceAll("{{DATE_ISO}}",     localDate)
    .replaceAll("{{DATE_HUMAN}}",   formatHumanDate(localDate, tz))
    .replaceAll("{{READING_TIME}}", readingTime)
    .replaceAll("{{BODY_HTML}}",    draft.body_html)
    .replaceAll("{{SOURCES_HTML}}", sourcesHtml)
    .replaceAll("{{JSON_LD}}",      draft.json_ld);

  // Load posts registry from repo, prepend new entry
  const postsJsonPath = "blog/posts.json";
  const postsJsonRaw  = await githubGetTextOptional(env, postsJsonPath, env.GITHUB_TARGET_BRANCH);
  const postsData     = postsJsonRaw ? (safeParseJson(postsJsonRaw) || { posts: [] }) : { posts: [] };

  const newEntry = {
    title:            draft.title,
    slug:             draft.slug,
    description:      draft.description,
    date:             localDate,
    canonical:        canonicalUrl,
    primary_tool_url: topic.primaryUrl
  };

  const nextPosts = {
    posts: [newEntry, ...(Array.isArray(postsData?.posts) ? postsData.posts : [])]
      .filter((p, i, arr) => arr.findIndex(x => x.slug === p.slug) === i)
      .slice(0, 60)
  };

  const blogListHtml = nextPosts.posts.map(p => `<li class="blog-list-item">
      <a href="/blog/${p.slug}"><strong>${escapeHtml(p.title)}</strong></a>
      <div class="blog-list-meta"><time datetime="${p.date}">${escapeHtml(p.date)}</time></div>
      <p>${escapeHtml(p.description || "")}</p>
    </li>`).join("\n");

  const indexHtml = templateIndex.replace(
    /<!-- BLOG_LIST_START -->[\s\S]*<!-- BLOG_LIST_END -->/m,
    `<!-- BLOG_LIST_START -->\n<ul class="blog-list">\n${blogListHtml}\n</ul>\n<!-- BLOG_LIST_END -->`
  );

  // Update sitemap.xml
  const sitemapXml = await githubGetText(env, "sitemap.xml", env.GITHUB_TARGET_BRANCH);
  const nextSitemap = upsertSitemap(sitemapXml, canonicalUrl, localDate);

  // Update rss.xml
  const rssXml  = await githubGetText(env, "rss.xml", env.GITHUB_TARGET_BRANCH);
  const nextRss = upsertRss(rssXml, { title: draft.title, link: canonicalUrl, description: draft.description, date: now });

  return [
    { path: `blog/${draft.slug}.html`, content: postHtml },
    { path: "blog/index.html",         content: indexHtml },
    { path: postsJsonPath,             content: JSON.stringify(nextPosts, null, 2) + "\n" },
    { path: "sitemap.xml",             content: nextSitemap },
    { path: "rss.xml",                 content: nextRss }
  ];
}

function renderSourcesHtml(citations) {
  const arr = Array.isArray(citations) ? citations : [];
  if (arr.length === 0) return "<p>No external sources listed.</p>";
  const items = arr
    .map(c => `<li id="source-${escapeHtml(String(c.n))}">[${escapeHtml(String(c.n))}] <a href="${escapeHtml(c.url)}" rel="nofollow noopener" target="_blank">${escapeHtml(c.title || c.url)}</a></li>`)
    .join("\n");
  return `<ol>\n${items}\n</ol>`;
}

// ─── GitHub: branch → commit → PR → auto-merge ───────────────────────────────

async function commitAndAutoMerge(env, { title, body, files }) {
  const owner      = env.GITHUB_OWNER;
  const repo       = env.GITHUB_REPO;
  const baseBranch = env.GITHUB_TARGET_BRANCH || "main";

  // 1. Resolve base SHA
  const baseRef = await githubApi(env, `GET /repos/${owner}/${repo}/git/ref/heads/${baseBranch}`);
  const baseSha = baseRef?.object?.sha;
  if (!baseSha) throw new Error("Unable to resolve base branch SHA");

  // 2. Create draft branch
  const branchName = `blogbot/${new Date().toISOString().slice(0, 10)}/${randSuffix(6)}`;
  await githubApi(env, `POST /repos/${owner}/${repo}/git/refs`, {
    ref: `refs/heads/${branchName}`,
    sha: baseSha
  });

  // 3. Commit each file to the new branch
  for (const f of files) {
    const existing = await githubGetMetaOptional(env, f.path, baseBranch);
    await githubPutFile(env, f.path, f.content, {
      branch:  branchName,
      message: `blogbot: update ${f.path}`,
      sha:     existing?.sha || undefined
    });
  }

  // 4. Open PR
  const pr = await githubApi(env, `POST /repos/${owner}/${repo}/pulls`, {
    title,
    head:  branchName,
    base:  baseBranch,
    body
  });

  const prNumber = pr?.number;
  if (!prNumber) throw new Error("PR creation returned no number");

  console.log(`PR #${prNumber} created: ${pr?.html_url}`);

  // 5. Auto-merge via squash (keeps main history clean)
  try {
    await githubApi(env, `PUT /repos/${owner}/${repo}/pulls/${prNumber}/merge`, {
      merge_method: "squash",
      commit_title: title,
      commit_message: `Auto-merged by blogbot.\n\n${body}`
    });
    console.log(`PR #${prNumber} auto-merged`);
  } catch (mergeErr) {
    // Merge can fail if branch protection requires reviews. Log and continue —
    // the PR still exists and can be manually merged.
    console.log(`Auto-merge failed (PR left open for manual review): ${mergeErr?.message || mergeErr}`);
  }

  return {
    number:  prNumber,
    url:     pr?.html_url,
    branch:  branchName
  };
}

function buildPrBody(topic, draft, sources) {
  return [
    "Automated blog post generated by blogbot.",
    "",
    `**Title:** ${draft.title}`,
    `**Slug:** ${draft.slug}`,
    `**Primary tool:** ${topic.primaryUrl}`,
    "",
    "**Sources used:**",
    ...sources.slice(0, 8).map(s => `- ${s.title} — ${s.url}`),
    "",
    "**Checklist:**",
    "- [ ] Review technical correctness",
    "- [ ] Confirm citations open and are authoritative",
    "- [ ] Confirm internal tool links are appropriate"
  ].join("\n");
}

// ─── GitHub helpers ───────────────────────────────────────────────────────────

async function githubGetText(env, path, ref) {
  const owner = env.GITHUB_OWNER;
  const repo  = env.GITHUB_REPO;
  const data  = await githubApi(env, `GET /repos/${owner}/${repo}/contents/${encodeComponentPath(path)}?ref=${encodeURIComponent(ref)}`);
  const content = data?.content;
  if (!content) throw new Error(`Missing content for ${path}`);
  return decodeBase64(content);
}

async function githubGetTextOptional(env, path, ref) {
  try { return await githubGetText(env, path, ref); } catch { return null; }
}

async function githubGetMetaOptional(env, path, ref) {
  const owner = env.GITHUB_OWNER;
  const repo  = env.GITHUB_REPO;
  try {
    const data = await githubApi(env, `GET /repos/${owner}/${repo}/contents/${encodeComponentPath(path)}?ref=${encodeURIComponent(ref)}`);
    return { sha: data?.sha || null };
  } catch { return null; }
}

async function githubPutFile(env, path, contentText, { branch, message, sha }) {
  const owner   = env.GITHUB_OWNER;
  const repo    = env.GITHUB_REPO;
  const payload = { message, content: encodeBase64(contentText), branch };
  if (sha) payload.sha = sha;
  return githubApi(env, `PUT /repos/${owner}/${repo}/contents/${encodeComponentPath(path)}`, payload);
}

async function githubApi(env, route, body) {
  const token = env.GITHUB_TOKEN;
  if (!token) throw new Error("Missing GITHUB_TOKEN");

  const { method, url } = parseGithubRoute(route);
  const res = await fetch(url, {
    method,
    headers: {
      ...DEFAULT_HEADERS,
      "Accept":              "application/vnd.github+json",
      "Authorization":       `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "content-type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`GitHub API ${res.status}: ${t.slice(0, 300)}`);
  }
  return res.json();
}

function parseGithubRoute(route) {
  const m = route.match(/^(GET|POST|PUT|PATCH|DELETE)\s+(.+)$/i);
  if (!m) throw new Error(`Bad route: ${route}`);
  const path = m[2];
  return {
    method: m[1].toUpperCase(),
    url:    `https://api.github.com${path.startsWith("/") ? "" : "/"}${path}`
  };
}

function encodeComponentPath(p) {
  return p.split("/").map(encodeURIComponent).join("/");
}

// ─── Sitemap + RSS updaters ───────────────────────────────────────────────────

function upsertSitemap(xml, canonicalUrl, lastmodDate) {
  if (xml.includes(`<loc>${canonicalUrl}</loc>`)) return xml;

  const urlBlock = `  <url>
    <loc>${canonicalUrl}</loc>
    <lastmod>${lastmodDate}</lastmod>
  </url>
`;

  if (xml.includes("</urlset>")) {
    return xml.replace("</urlset>", `${urlBlock}</urlset>`);
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urlBlock}</urlset>
`;
}

function upsertRss(xml, { title, link, description, date }) {
  const guid = link;
  if (xml.includes(`<guid>${escapeXml(guid)}</guid>`)) return xml;

  const pubDate = date.toUTCString();

  const item = `    <item>
      <title>${escapeXml(title)}</title>
      <link>${escapeXml(link)}</link>
      <guid>${escapeXml(guid)}</guid>
      <pubDate>${escapeXml(pubDate)}</pubDate>
      <description>${escapeXml(description)}</description>
    </item>
`;

  xml = xml.replace(/<lastBuildDate>.*<\/lastBuildDate>/, `<lastBuildDate>${escapeXml(pubDate)}</lastBuildDate>`);
  return xml.replace("</channel>", `${item}\n  </channel>`);
}

// ─── Small utilities ──────────────────────────────────────────────────────────

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

async function safeJson(reqOrRes) {
  try { return await reqOrRes.json(); } catch { return null; }
}

function safeParseJson(text) {
  // Strip markdown code fences if model wraps the JSON
  const trimmed = String(text).trim();
  const fenced  = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  try { return JSON.parse(fenced ? fenced[1] : trimmed); } catch { return null; }
}

function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function sanitizeSlug(s) {
  const x = slugify(s);
  return x.length ? x : `post-${randSuffix(8)}`;
}

function randSuffix(n) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes    = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => alphabet[b % alphabet.length]).join("");
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeXml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function stripTags(html) {
  return String(html).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function estimateReadingTime(bodyHtml) {
  const words   = stripTags(bodyHtml).split(/\s+/).filter(Boolean).length;
  const minutes = Math.max(1, Math.round(words / 220));
  return `${minutes} min read`;
}

function formatHumanDate(localDate, tz) {
  const d   = new Date(`${localDate}T12:00:00Z`);
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "short", day: "2-digit" });
  return fmt.format(d);
}

function injectToolLinkBlock(bodyHtml, topic) {
  const links = [topic.primaryUrl, ...(topic.relatedUrls || [])]
    .map(u => `<li><a href="${u}">${escapeHtml(u)}</a></li>`)
    .join("");
  return `${bodyHtml}\n<section><h2>Related tools on Online Dev Tools</h2><ul>${links}</ul></section>`;
}

function toZonedParts(date, tz) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit", weekday: "short"
  }).formatToParts(date);

  const get = type => parts.find(p => p.type === type)?.value;
  const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    dow:  dowMap[get("weekday")] ?? 0
  };
}

function timingSafeEqual(a, b) {
  const sa = String(a);
  const sb = String(b);
  if (sa.length !== sb.length) return false;
  let r = 0;
  for (let i = 0; i < sa.length; i++) r |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  return r === 0;
}

function decodeBase64(b64) {
  const clean = String(b64).replace(/\n/g, "");
  const bytes = Uint8Array.from(atob(clean), c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodeBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function longestCommonSubstring(a, b) {
  const s1 = String(a).slice(0, 1200);
  const s2 = String(b).slice(0, 1200);
  const rows = new Array(s1.length + 1).fill(0).map(() => new Array(s2.length + 1).fill(0));
  let maxLen = 0;
  let endIdx = 0;
  for (let i = 1; i <= s1.length; i++) {
    for (let j = 1; j <= s2.length; j++) {
      if (s1[i - 1] === s2[j - 1]) {
        rows[i][j] = rows[i - 1][j - 1] + 1;
        if (rows[i][j] > maxLen) { maxLen = rows[i][j]; endIdx = i; }
      }
    }
  }
  return s1.slice(endIdx - maxLen, endIdx);
}