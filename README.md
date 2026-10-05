# Donate a chocolate chip cookie

[Open the live website](https://donateachocolatechipcookie.com/) · Also available at [www.donateachocolatechipcookie.com](https://www.donateachocolatechipcookie.com/) and the [Workers address](https://donatechocolatechipcookie.cjxsez.workers.dev/).

A minimal community invitation for curious students and builders, from the people behind [J](https://risingfounder.net/). The public-facing name is **Chocolate Chip Cookie**.

The opening page stays intentionally quiet: an invitation, **Cut the Cookie**, and an optional explanation. The signup dialog collects name, email, school, grade/year, and a niche fun fact. Submissions are saved in a private Cloudflare D1 database; success is shown only after a successful database write. This site does not send emails automatically or process donations.

## Local development

Use Node 24 LTS (minimum 22.13) and npm.

```sh
npm ci
npm run db:local
npm run dev
```

Open http://127.0.0.1:8787. Local signups stay in the ignored `.wrangler/` directory and are separate from live signups.

```sh
npm test
npm run typecheck
npm run build
```

## Design

- Exact original fonts from `Jose-Gael-Cruz-Lopez/J`: Teodor Light (headings), Teodor Regular (invitation links), Lay Grotesk Medium (interface).
- White paper, black text, generous space, fine rules, restrained motion.
- Responsive native dialogs with keyboard focus containment, Escape/backdrop closing, clear labels, reduced-motion support, and visible submission feedback.
- The hero, About, signup, and success screens fit the viewport without page or dialog scrolling. Height-aware spacing and a landscape form layout keep controls visible; long text can still scroll inside its input field.
- Static HTML/CSS/JavaScript, without a frontend framework or third-party tracking.

## Cookie introduction

Higgsfield Recraft V4.1 generated the cookie as native vector artwork. Its stroke-only adaptation draws the outer contour, nine chips, and three small cracks, then fades into the hero. Source artwork and generation provenance are in `design/cookie-intro/`.

`public/intro.js` orchestrates SVG stroke animations in the browser. It plays on a fresh page load, finishes drawing in roughly 2.2 seconds, and fades out over 420ms. Reduced-motion visitors see the hero immediately. The skip button or keyboard interaction immediately reveals the page; missing JavaScript leaves the page visible; a 3.2-second failsafe covers animation errors.

`npm run assets:sync` embeds `public/cookie-contour.svg` into the HTML so the intro needs no separate image/video download. It also runs before development, builds, and deployment. Edit the standalone SVG as the source, then sync it.

## Hosting and signup storage

The Worker is `donatechocolatechipcookie`; its private D1 database is `donate-cookie-community`. Both belong in the same Cloudflare account as Rising Founder. `wrangler.jsonc` contains public resource identifiers, no secrets.

```sh
npx wrangler login
npm run db:remote
npm run deploy
```

The apex `donateachocolatechipcookie.com` and `www.donateachocolatechipcookie.com` are Worker **Custom Domains**, declared in `wrangler.jsonc` so deployments preserve them. Cloudflare manages their DNS records and TLS certificates. Manage them under Workers & Pages → donatechocolatechipcookie → Settings → Domains & Routes.

**View signups:** Cloudflare → Storage & Databases → D1 → donate-cookie-community → Studio → `community_members`.

**Export signups:**

```sh
npm run signups:export -- --remote
```

This writes a private CSV in ignored `exports/`, ready for Google Sheets or Excel. Omit `--remote` to export local test signups. The export neutralizes spreadsheet formula prefixes in submitted text. Do not commit exports or share the database publicly.

There is no public endpoint for reading personal details. Email addresses are normalized and deduplicated without allowing an unauthenticated visitor to overwrite someone else's signup. Input bounds, a honeypot, same-origin checks, short-lived hashed-IP rate limits, prepared SQL, and a restrictive content security policy protect the signup flow. A database outage returns an error and leaves form answers intact for retry.

No payment, analytics, email campaign service, public member directory, or student-selection scoring is included.

## Community idea

Start with in-person conversations and a simple way to stay connected. Welcome people through curiosity and what they want to make, rather than school prestige. Use the fun fact as a future conversation starter; keep personal answers private.

The first follow-up can invite members to a small meetup or a shared project session. Introduce J naturally when someone wants to take a project further. Measure useful introductions, meetup attendance, and projects people start together. The website collects interest; the community grows through the follow-through.
