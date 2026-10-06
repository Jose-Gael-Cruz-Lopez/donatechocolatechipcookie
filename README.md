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

## Page entrance

The invitation appears immediately with a gentle CSS fade and 12px upward movement. The title leads; the copy, buttons, J signature, and footer follow in small steps. The full entrance completes within one second. There is no cookie loading screen or waiting period.

Reduced-motion visitors see everything immediately. Keyboard focus also reveals the full invitation immediately. The entrance needs no JavaScript; all content is visible if animations are unavailable. The previous cookie artwork is archived in `design/cookie-intro/` and is no longer loaded by the page.

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

There is no public endpoint for reading personal details. The private admin API checks authentication on every request. Email addresses are normalized and deduplicated without allowing an unauthenticated visitor to overwrite someone else's signup. Input bounds, a honeypot, same-origin checks, short-lived hashed-IP rate limits, prepared SQL, and a restrictive content security policy protect the signup flow. A database outage returns an error and leaves form answers intact for retry.

No payment, analytics, email campaign service, public member directory, or student-selection scoring is included.

## Private admin portal

Open [the admin portal](https://donateachocolatechipcookie.com/admin/). It shows registrations, total signups, signups today (UTC), distinct schools, searchable fields, pagination, and CSV export. It is read-only apart from signing in and out; public visitors cannot list registrations.

The owner is configured in `ADMIN_EMAIL`. A dedicated, randomly generated admin password is saved locally in the ignored `exports/admin-access.txt` file for the owner. Only its SHA-256 hash is stored in the Cloudflare Worker secret `ADMIN_PASSWORD_HASH`; the password and hash are never committed. Keep generated passwords at least 32 random bytes. `ADMIN_ORIGIN` restricts admin access to the primary HTTPS domain. The Workers address and `www` redirect admin pages there; their admin API requests are denied.

Apply `migrations/0002_admin.sql` before deploying the portal. D1 stores only hashes of 256-bit session tokens in `admin_sessions`, with an eight-hour expiry. Cookies are Secure, HttpOnly, and SameSite=Strict. Logout revokes the session immediately and checks a CSRF token. Password rotation invalidates every previous session automatically. Failed logins are throttled in `admin_login_attempts`; both tables contain short-lived authentication state, separate from `community_members`.

To rotate access, generate a fresh random password, compute its SHA-256 hex digest, and update the secret using `npx wrangler secret put ADMIN_PASSWORD_HASH`. Update the owner's private login file separately. Do not commit credentials, session cookies, database exports, or `.dev.vars`.

For local development, set `ADMIN_ORIGIN=http://127.0.0.1:8787`, `ADMIN_EMAIL`, and a test password's `ADMIN_PASSWORD_HASH` in the ignored `.dev.vars`. Run `npm run db:local` and `npm run dev`. The `/admin` assets always run through the Worker so static routing cannot bypass the login guard. Admin responses disable caching and search indexing. CSV exports use a fixed record snapshot and escape spreadsheet formula prefixes.

## Community idea

Start with in-person conversations and a simple way to stay connected. Welcome people through curiosity and what they want to make, rather than school prestige. Use the fun fact as a future conversation starter; keep personal answers private.

The first follow-up can invite members to a small meetup or a shared project session. Introduce J naturally when someone wants to take a project further. Measure useful introductions, meetup attendance, and projects people start together. The website collects interest; the community grows through the follow-through.
