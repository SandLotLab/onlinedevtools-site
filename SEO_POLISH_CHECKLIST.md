# Online Dev Tools SEO / Crawl / Ads Readiness Checklist

This checklist captures the next updates to fully complete the switch to `onlinedevtools.app` and improve search + monetization readiness.

## High priority (do now)

- [ ] Verify Search Console for **domain property** (`onlinedevtools.app`) and submit `/sitemap.xml`.
- [ ] Ensure only one production hostname is indexable (`https://onlinedevtools.app`) and keep all alternates 301 redirected.
- [ ] Add a custom **404 page** and ensure it returns HTTP 404.
- [ ] Add a custom **500 fallback page** for user trust.
- [ ] Add unique OG/Twitter preview image tags on core pages (`og:image`, `twitter:image`).
- [ ] Add `Organization` JSON-LD globally with logo + sameAs links.

## Content / information architecture

- [ ] Expand each tool page with a short “How to use”, “Common errors”, and FAQ section (helps long-tail queries).
- [ ] Add internal links between related tools (example: JSON Formatter <-> JSON to TypeScript).
- [ ] Add one changelog/news page and link updates there instead of homepage-only bullets.
- [ ] Add one comparison/intent page (e.g., “Best free JSON formatter online”).

## Technical SEO hygiene

- [ ] Include `lastmod` values in `sitemap.xml` on each deployment.
- [ ] Add `og:site_name` and `twitter:card` consistently to all indexable pages.
- [ ] Keep canonical URLs self-referencing and slash-consistent (already mostly done).
- [ ] Validate structured data in Google Rich Results Test after each deploy.

## AdSense readiness

- [ ] Keep Privacy, Terms, Contact pages in top/footer nav and clearly accessible.
- [ ] Add/verify a cookie consent flow that supports ads/analytics mode choices by region.
- [ ] Add an “Advertiser-friendly” content policy note (no prohibited content/tool abuse intent).
- [ ] Start with low ad density and reserve stable ad slots to avoid layout shift (CLS).

## Performance / crawl budget

- [ ] Run Lighthouse on homepage + top 3 tools and fix biggest LCP/CLS/INP findings.
- [ ] Preload critical stylesheet if render-blocking is high.
- [ ] Compress/resize non-critical images and use explicit width/height where missing.
- [ ] Confirm Brotli/gzip is enabled at edge.

## Analytics / measurement

- [ ] Track key events: tool use, copy action, download action, outbound click.
- [ ] Build GA4 funnels for “Landing -> Tool Interaction -> Return Visit”.
- [ ] Link GA4 + Search Console and inspect Queries x Landing Pages monthly.

## Brand / polish

- [ ] Replace remaining references to legacy naming/side projects on core conversion pages if they distract from the main brand.
- [ ] Create a simple brand style pass: consistent page titles, H1 patterns, and CTA tone.
- [ ] Add a lightweight “Trust” section (local-first, no uploads, privacy-safe) to every tool template.

