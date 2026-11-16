# SkySwap API

The server behind [SkySwap](https://skyswap-app.vercel.app), a citizen science app built on real images from NASA's SPHEREx telescope.

The API does four jobs:

1. It keeps people's accounts and answers.
2. It turns answers into findings and checks them against known catalogs.
3. It serves the sky index and the object files to the app.
4. It cuts and packs photo crops from the public SPHEREx archive.

It stores no email, phone number or name.

## What it serves

| Area | Routes | What they do |
|---|---|---|
| Sky index | `/kit/index/*`, `/api/sky`, `/api/explore/*` | Which SPHEREx photos cover a point, served from the two-part index (one light file per sky cell, heavy details stored once per image) |
| Photos | `/api/s3/*`, crop routes | Reads only the needed bytes of each photo from the public archive and sends the exact crop, compressed. The pixels are unchanged |
| Objects and stories | `/api/objects`, `/api/stories`, `/kit/objects/*` | The 36 featured sky objects, their posts, spectra, motion and Lab packages |
| Swap | `/api/classify/*` | The deck of blind cards, answers and marks |
| Findings and community | `/api/candidates`, `/api/community/*` | Candidates, automatic catalog checks, threaded comments, votes and reports |
| Accounts | `/api/session`, `/api/me`, `/api/auth/*` | Nickname sign-up, passkeys, sign-in by QR code, recovery code and connected devices |
| Docs | `/docs` | Interactive OpenAPI reference |

## Three rules the code keeps

- **Answers are blind.** A person who has seen a finding's discussion no longer gets that card, and a later answer to it does not count.
- **A candidate stays a candidate.** The catalog checks write "already known" or "open". They never write "discovery". Only a person can publish or discard a finding.
- **Machine guesses are labeled as guesses.** Scores belong to posts and comments, never to people.

## Run it

Requires Node.js 22 and the SkySwap data folder (`../data` by default).

```bash
npm install
npm run dev        # http://127.0.0.1:4000, docs at /docs
```

| Variable | Default | Meaning |
|---|---|---|
| `PORT`, `HOST` | `4000`, `127.0.0.1` | Where the server listens |
| `SKYSWAP_DATA` | `../data` | Sky index, objects, deck and app posts |
| `SKYSWAP_DB` | `var/skyswap.sqlite` | SQLite database. Migrations run on start and only add, never drop |
| `SKYSWAP_CACHE_DIR`, `SKYSWAP_CACHE_MB` | `var/cutouts`, `512` | Disk cache for photo crops |
| `SKYSWAP_AVATAR_DIR` | `var/avatars` | Profile picture stock, cropped from the NASA Image and Video Library |
| `WEB_ORIGIN` | `http://localhost:3000` | The site allowed to call the API |
| `SKYSWAP_RP_ID`, `SKYSWAP_ORIGIN` | `localhost`, `http://localhost:3000` | Passkey domain and origin. They must match the site's address |
| `COOKIE_SECRET` | development value | Secret used to sign session cookies. Set a long random value in production |
| `SKYSWAP_LOG` | `error` | `error`, `warn`, `info` or `silent` |

Other commands:

```bash
npm run typecheck
npm run lint
npm test
npm run openapi    # writes the OpenAPI file used by the site's types
npm run findings -- set <id> <in_review|published|discarded> --url <source>
```

## Production

The API runs on a free Google Cloud e2-micro instance as a systemd service, behind Caddy for automatic HTTPS. Three scheduled jobs keep it current:

- **Daily copy of the database to Cloudflare R2**, keeping 30 days;
- **Pull of new data from R2**, run after the weekly update, with a restart only when something changed;
- **Refresh of the DuckDNS address**, in case the instance IP changes.

## Data credits

- **SPHEREx, WISE and 2MASS images** come from NASA/IPAC IRSA. Orbits come from JPL Horizons.
- **Catalog checks** use ESA Gaia, SIMBAD (CDS), the Minor Planet Center and IMCCE.
- **Profile pictures** are crops of images from the NASA Image and Video Library.
