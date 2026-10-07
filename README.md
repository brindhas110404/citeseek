# CiteSeek

**Answers from your research papers, with receipts.**

**Live demo:** https://citeseek.brindhas110404.workers.dev

CiteSeek turns research papers into a conversation. Upload a PDF, ask questions in plain English, and get answers grounded in the paper's text. Answers include numbered citations; click one to inspect the retrieved passage behind it. Check important claims against the original paper.

Built entirely on Cloudflare's developer platform: Workers AI, Vectorize, Workflows, Durable Objects, D1 and KV. It runs on the free plan with no credit card.

## Features

| | What it does | How |
|---|---|---|
| **Clickable citations** | Answers cite passages as `[1]`, `[2]`. Clicking one opens an evidence panel with the passage, query-term highlighting and a match score. | Sources streamed alongside the answer; stored with each message in the Durable Object |
| **Streaming answers** | Text appears token by token. | Workers AI `stream: true` → Server-Sent Events |
| **Paper brief** | Each upload gets a summary, key points and four suggested questions. | Extra Workflow step using Llama 3.3 |
| **Account controls** | See every device you're signed in on and sign them out, download all your data (papers with their text, briefs and every conversation) as one file, or delete your account and everything in it. Changing or removing your email notifies the old address. | `src/index.ts` account routes, sessions table with device + last-active |
| **Accounts** | Username + password sign-in. Each person's papers, search and conversations are private to them. | PBKDF2-SHA256 password hashing, HttpOnly session cookies, D1 |
| **Forgot password** | Two ways back in. **Email:** add an optional email at sign-up (or later in Password recovery), confirm it from the link we send, and "Forgot password?" emails you a single-use reset link (30 minutes). **Recovery key:** sign-up also shows a one-time key; use it from the same popup. Either one signs out every other device. Owners can also reset any account from the terminal. | Only hashes of keys and link tokens are stored (D1 `recovery_keys`, `email_tokens`). Reset links go only to confirmed addresses, so a typo can't hand someone your account; the forgot form answers the same either way and is rate-limited per address and network |
| **Abuse protection** | 5 wrong passwords lock an account for 15 minutes; failed sign-ins and sign-ups are also capped per network address. Passwords need 10+ characters and can't be common or contain the username (live strength meter). Cloudflare Turnstile bot check on sign-in and sign-up. | `src/guard.ts`, attempt log in D1, Turnstile siteverify |
| **Archive & Recently deleted** | Papers and conversations can both be archived (hidden from the library) or deleted (kept 30 days in Recently deleted, with Undo, then erased automatically). Each conversation is tagged with the paper it's about. Asking in an archived conversation moves it back. Erasing a paper for good erases its conversations too. | Soft-delete state on papers and chats in D1; lazy 30-day purge of vectors, text, rows and chat history |
| **Paper atlas (3D globe)** | The sign-in page and the home screen open on a spinning globe of ~160k papers on AI and the fields it touches: 22 conferences (NeurIPS, ICML, ICLR, ACL, EMNLP, NAACL, CVPR, ICCV, WACV, AISTATS, COLT, UAI, CoRL, MIDL, L4DC, CLeaR, CHIL, ML4H, Learning on Graphs, AutoML, CoLLAs, ACML) since 2018, plus recent arXiv preprints from 13 fields (AI, vision, robotics, speech, search, HCI, software, hardware, security, statistics, health, biology, theory). Papers about similar things sit together and research areas form colored "continents". Drag to spin, pinch or ⌘/Ctrl-scroll to zoom, filter by year and conference/arXiv, search titles, and click any dot for its abstract and field, then **Add to my library**. If the paper's own site blocks downloads, CiteSeek finds a free copy by title (arXiv, Semantic Scholar, OpenAlex); missing abstracts are looked up the same way; and when no free copy exists it offers "Open paper page" + "Upload the PDF". | `scripts/build-atlas.mjs` (official proceedings data → local MiniLM embeddings → k-means topics → force layout on a sphere) + `static/globe.js` (Three.js, custom point shader) + `src/resolve.ts` |
| **Home screen** | Opens on a home page: ask across your library, shoot in a paper, pick up a recent conversation, or open any paper's brief from its card. Click the logo to return. | Recent chats remembered per browser; history itself lives in Durable Objects |
| **Shoot to index** | Dropping or choosing a file opens a mini court: pick **Flick it** (swing and let go) or **Slingshot** (pull back with a live trajectory preview, release to launch), then sink the crumpled-paper ball to upload. Your choice is remembered. Real arc physics with rim and backboard bounces. "Skip" uploads directly, and reduced-motion users get the plain form. | `static/court.js`: pointer-velocity throw, gravity, collision, no libraries |
| **Title detection** | Leave the title blank and CiteSeek reads the real title from the paper instead of showing `1706.03762v7.pdf`. Click a title in the brief to rename it. | PDF metadata as a hint, confirmed by Llama 3.3 from the first page |
| **Scoped search** | Ask one paper or your whole library. | One Vectorize namespace per paper |
| **Follow-up understanding** | "How long did *it* train?" is rewritten into a standalone query before searching. | Llama 3.1 8B query rewriting |
| **Reranking** | 20 candidates retrieved, top 6 kept by a cross-encoder. | `@cf/baai/bge-reranker-base` |
| **Token-aware chunking** | ~350-token, sentence-respecting chunks with overlap. | `src/utils.ts` |
| **Broad questions work** | "What is this paper about?" uses the stored brief as context. | Overviews injected into the system prompt |
| **Persistent chat** | Reload the page and the conversation (and its citations) is still there. | Durable Object with SQLite |

## Architecture

```
 Browser (static/)                       Cloudflare Worker (Hono, src/index.ts)
 ─────────────────                       ──────────────────────────────────────
 PDF → text (pdf.js)  ── POST /api/papers ──►  KV: paper text + metadata
                                               │
                                               ▼
                                   Workflow: PaperIngestionWorkflow
                                   ├─ chunk (token-aware)
                                   ├─ embed (BGE, 768-d) → Vectorize [namespace = paper]
                                   ├─ summarize (Llama 3.3) → brief + suggested questions
                                   └─ mark ready
 Question ──────────── POST /api/chat ──►  1. history       ← Durable Object (SQLite)
                                           2. rewrite query ← Llama 3.1 8B
                                           3. retrieve      ← Vectorize top-20
                                           4. rerank        ← BGE reranker → top-6
                                           5. answer        ← Llama 3.3 70B (streamed)
 ◄──────── SSE: meta (sources) · token · token · … · done
```

## Getting started

**Prerequisites:** Node.js 18+ and a free [Cloudflare account](https://dash.cloudflare.com/sign-up).

```bash
npm install
npx wrangler login               # opens your browser
npm run setup                    # one time: creates the Vectorize index, KV namespace and D1 database
cp .dev.vars.example .dev.vars   # local settings (Turnstile test keys; email is optional)
npm run dev                      # http://localhost:8787
```

`npm run setup` writes the new KV and D1 ids into `wrangler.toml`. It's safe to re-run: anything that already exists on your account is found by name and reused, never recreated. The first time you run `npm run dev`, Cloudflare may ask you to register a free `workers.dev` subdomain. Follow the link it prints.

> Workers AI and Vectorize always use your real Cloudflare account, even locally (there is no local simulator). KV, Durable Objects and Workflows run locally during `npm run dev`. Everything stays within the free tier for normal use.

### Paper atlas

The globe's data is built once, on your machine, and shipped as static files:

```bash
npm run dev            # keep running in one terminal (used to name the map's regions with Workers AI)
npm run atlas:build    # in another; first run ~30–60 min, re-runs reuse .atlas-cache/
```

Papers come from each venue's own published data: **PMLR** (ICML, AISTATS, COLT, UAI, CoRL, MIDL, L4DC, CLeaR, CHIL, ML4H, Learning on Graphs, AutoML, CoLLAs, ACML), **NeurIPS** (neurips.cc data files; proceedings site for 2018–19), **ICLR** (iclr.cc data files, 2020+), **ACL / EMNLP / NAACL** (ACL Anthology, main tracks), **CVPR / ICCV / WACV** (CVF Open Access), plus recent **arXiv** preprints via OpenAlex, with a share for each of 13 fields. Output goes to `static/atlas/` (git-ignored) and deploys with the app. Settings: `ATLAS_FROM_YEAR` (default 2018), `ATLAS_ARXIV_CAP` (default 40000, split across the fields), `ATLAS_SKIP=cvf,arxiv` (leave sources out), `ATLAS_CVF_ABSTRACTS=0` (skip the ~30k CVF abstract pages), `ATLAS_EMBEDDER=tfidf` (skip the neural model), `ATLAS_REFRESH=1` (re-download). Embeddings are remembered per paper, so adding sources later only embeds the new papers.

**How placement works:** every paper's title + abstract is embedded with `all-MiniLM-L6-v2`, running locally through transformers.js (installed automatically on the first build; no API, no cost). Papers are grouped into a few hundred topics with spherical k-means; topics are spread over the sphere by a force layout seeded from PCA, so related topics are neighbours and each gets area proportional to its size; topics are grouped into colored regions (named by Llama 3.1 8B through the dev server, or by keywords). Inside a topic, papers fill a sunflower pattern ordered by their local PCA direction, so near-identical papers sit side by side.

**Adding a paper:** the server fetches the open-access PDF from a short allowlist of paper hosts (arXiv, OpenReview, NeurIPS/PMLR/ACL proceedings…), never arbitrary URLs, and the browser runs it through the normal upload.

### Turnstile (bot check)

Locally, `.dev.vars` (copied from `.dev.vars.example`) holds Cloudflare's public **test** keys, which always pass and show a small "Testing only" box:

```
TURNSTILE_SITE_KEY=1x00000000000000000000AA
TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA
```

Before deploying, create a free widget in the Cloudflare dashboard (**Turnstile → Add widget**, add your `*.workers.dev` hostname) and store its keys (see [Adding secrets](#adding-secrets)):

```bash
npx wrangler secret put TURNSTILE_SITE_KEY
npx wrangler secret put TURNSTILE_SECRET_KEY
```

Leave both unset to turn the check off.

### Accounts and passwords

Accounts live in the D1 database `citeseek-db`, table `users`. Passwords are stored only as salted PBKDF2 hashes, so they can't be read back, only replaced. While developing, D1 is a local SQLite file under `.wrangler/state/`; the deployed app uses a separate database on Cloudflare (dashboard → **Storage & Databases → D1 → citeseek-db → Console**).

```bash
npm run reset-password -- --list                # accounts, and whether each has a recovery key
npm run reset-password -- <username>            # set a new password (asks for it, typing hidden)
npm run reset-password -- <username> --remote   # same, on the deployed database
```

### Sending reset emails

Locally nothing needs setting up: with no email service configured, an email you add is confirmed straight away, "Forgot password?" goes straight to choosing a new password, and anything that would have been emailed is printed in the `npm run dev` terminal. This shortcut only works on `localhost`. To send real emails, pick one:

**Brevo (free, no domain or card needed, 300 emails a day)**
1. Sign up at brevo.com, then add and confirm a sender address (your Gmail is fine) under *Senders, Domains & Dedicated IPs*.
2. Create an API key under *SMTP & API → API Keys*.
3. Locally, add to `.dev.vars`: `BREVO_API_KEY=...` and `EMAIL_FROM=you@gmail.com`. For the deployed app, add the same two as secrets (see [Adding secrets](#adding-secrets)): `.dev.vars` is never uploaded.
4. If Brevo refuses to send from the deployed app, turn off **Security → Authorized IPs** in Brevo: Cloudflare sends from many changing addresses.

Emails from a Gmail address sent through another service are more likely to land in spam; a domain of your own fixes that. A reset link is only sent to an address that has been confirmed; an unconfirmed address gets a confirmation link instead.

**Cloudflare Email Service** (needs your own domain on Cloudflare and the Workers Paid plan): onboard the domain under *Email → Email Sending*, then add to `wrangler.toml`:
```toml
send_email = [{ name = "EMAIL" }]
[vars]
EMAIL_FROM = "no-reply@yourdomain.com"
```

Optional: `APP_URL` sets the address used in emailed links (defaults to the address the request came in on).

### Deploy

```bash
npm run setup          # skip if you already ran it in Getting started
npm run atlas:build    # optional, with `npm run dev` running; otherwise the globe is empty
npm run deploy         # → https://citeseek.<your-subdomain>.workers.dev
```

`npm run deploy` first runs `scripts/deploy-check.mjs`, which stops the deploy if the database isn't set up and warns about anything optional that's missing (email, Turnstile, the atlas), printing the command that fixes each one. Run every command from the project folder (the one with `wrangler.toml`).

The deployed app has its own database, separate from the local one, so create your account again on the live site (and confirm your email there).

### Adding secrets

Settings in `.dev.vars` only apply locally. The deployed app reads them as Cloudflare secrets, which take effect immediately without redeploying. Either way works:

- **Terminal:** run `npx wrangler secret put BREVO_API_KEY` (the setting's **name**), press Enter, then paste the **value** when it asks "Enter a secret value". It should finish with `Uploaded secret BREVO_API_KEY`. If it prints anything else after "Uploaded secret", the name and value were swapped: remove it with `npx wrangler secret delete <that name>`.
- **Dashboard:** Workers & Pages → citeseek → Settings → Variables and Secrets → **Add**, type **Secret**, with the name and value in their own boxes.

`npx wrangler secret list` shows the names that are set. The app uses `BREVO_API_KEY`, `EMAIL_FROM`, `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` and, optionally, `APP_URL`.

### Offline test mode

`npm run dev:mock` runs the full app with deterministic fakes for Workers AI and Vectorize (`test/mock-entry.ts`). It needs no account and is useful for UI work.

## API

All routes except `/api/auth/*`, `/api/atlas/lookup` and `/api/log` require a signed-in session cookie.

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/auth/signup` | `{ username, password }` → creates an account and signs in |
| `POST` | `/api/auth/login` | `{ username, password }` → signs in |
| `POST` | `/api/auth/reset` | `{ username, recoveryKey, password }` → sets a new password, returns a new recovery key |
| `POST` | `/api/auth/forgot` | `{ email }` → emails a reset link if a confirmed account uses it (same answer either way) |
| `POST` | `/api/auth/reset-token` | `{ token }` → which account a reset link is for |
| `POST` | `/api/auth/reset-link` | `{ token, password }` → sets the new password from an emailed link |
| `POST` | `/api/auth/verify-email` | `{ token }` → confirms an email address |
| `POST` | `/api/auth/logout` | Ends the session |
| `GET` | `/api/auth/me` | The signed-in user, or 401 |
| `POST` | `/api/account/recovery-key` | `{ password }` → a new recovery key (the old one stops working) |
| `POST` | `/api/account/email` | `{ email, password }` → add or change your email (sends a confirmation link); `""` removes it |
| `POST` | `/api/account/email/resend` | Sends the confirmation link again |
| `GET` | `/api/account/sessions` | Devices you're signed in on |
| `POST` | `/api/account/sessions/revoke` | `{ id }` signs out one device; `{ others: true }` signs out all the others |
| `GET` | `/api/account/export` | Download all your data as one JSON file |
| `POST` | `/api/account/delete` | `{ password, confirm }` → deletes your account and everything in it |
| `POST` | `/api/papers` | Upload (multipart: `text` or `file`, `title`, `filename`) |
| `GET` | `/api/papers?state=active\|archived\|deleted` | List papers in a section, plus counts for each section |
| `POST` | `/api/papers/empty-trash` | Erase everything in Recently deleted now |
| `GET` | `/api/papers/:id` | One paper's metadata and indexing progress |
| `PATCH` | `/api/papers/:id` | `{ title }` to rename, `{ state }` to archive, unarchive or restore |
| `DELETE` | `/api/papers/:id` | Move to Recently deleted; `?permanent=1` erases text, vectors and record now |
| `GET` | `/api/chats?state=active\|archived\|deleted` | Your conversations in a section, each with its paper's title |
| `PATCH` | `/api/chat/:sessionId` | `{ state }` to archive, unarchive or restore a conversation |
| `POST` | `/api/chat` | `{ message, sessionId?, paperId? }` → SSE stream (`meta`, `token`, `done`, `error`) |
| `GET` | `/api/chat/:sessionId` | Conversation history including cited passages |
| `GET` | `/api/atlas/lookup?title=` | Finds a free PDF and abstract for a globe paper (public) |
| `GET` | `/api/atlas/pdf?url=` | Fetches a globe paper's PDF from an allowlisted host |
| `POST` | `/api/log` | Browser error reports (public, rate-limited) |
| `DELETE` | `/api/chat/:sessionId` | Move a conversation to Recently deleted; `?permanent=1` erases it now |

## Project structure

```
src/
  index.ts         API routes, streaming chat endpoint, account routes, error logging, cron entry
  rag.ts           embeddings, query rewriting, two-stage retrieval + reranking, prompts
  workflow.ts      durable ingestion pipeline (chunk → embed → summarize → paper index)
  chat-session.ts  Durable Object: conversation memory in SQLite
  chats.ts         conversation helpers shared by routes and cleanup
  auth.ts          sign-up, sign-in, sessions + devices, recovery keys, auth middleware
  email.ts         account email, confirmation and reset links, change notices
  mail.ts          sends email (Cloudflare Email Service, Brevo, or the dev terminal)
  doccheck.ts      "is this a research paper?" check on upload
  resolve.ts       finds free PDFs and abstracts for globe papers (arXiv, Semantic Scholar, OpenAlex)
  maintenance.ts   daily cleanup job (expired trash, sessions, links, leftover vectors)
  db.ts            D1 schema (auto-created + migrations), papers, archive/trash, conversations
  guard.ts         rate limits, password rules, Turnstile
  utils.ts         text cleaning, token-aware chunking
static/
  index.html, styles.css
  js/              the app, one file per area (core, library, upload, chat, views, auth, account, atlas, boot)
  pdf-reader.js    column-aware PDF text extraction, header/footer removal, OCR for scans
  globe.js         the paper atlas (Three.js)
  court.js         the shoot-to-index upload game
  report.js        sends browser errors to the server logs
scripts/           build-atlas, setup, deploy-check, reset-password
test/e2e/          end-to-end tests (npm test)
test/mock-*.ts|mjs offline fakes for Workers AI, Vectorize and the atlas sources
```

## Tests

```bash
npx playwright install chromium   # once per machine
npm test                          # 19 end-to-end tests, fully offline (about 2 minutes)
```

The tests start the app in offline mode (`test/wrangler.mock.toml`: Workers AI and Vectorize are faked, rate limits are relaxed) and drive a real browser through sign-up, password resets, uploads and the paper check, asking questions and opening citations, whole-library search, archive and Recently deleted, devices, data export, account deletion, the globe (if an atlas is built), PDF column handling and the cleanup job.

## Design decisions

- **Two-stage library search.** Each paper also gets one "summary vector" (title + brief) in a per-user index. A whole-library question first picks the ~8 most relevant papers from that index, then searches passages only in those, so it costs two searches whether you have 10 papers or 1,000. Papers without a summary vector yet are always searched, and older papers get one in the background.
- **PDFs read like a person would.** Two-column pages are detected from text positions and read column by column; running headers, footers and page numbers are dropped; hyphenated words are rejoined; scanned PDFs are recognized with OCR (loaded only when needed).
- **The globe loads in pieces.** Visitors download one ~3 MB file; titles come in 2,000-title chunks when hovered, and search loads only the word-index pieces for the words typed.
- **Observability and cleanup.** Server errors and browser errors are logged as structured events (Workers Logs). A daily cron job empties expired trash for every user (not just those who visit), clears old sessions and links, and retries any passages Vectorize refused to delete.

- **Workflows for ingestion.** Embedding a long paper is many API calls. Each batch is a checkpointed `step.do()`, so a failure at batch 7 resumes at batch 7 instead of starting over.
- **Namespaces instead of metadata filters.** Vectorize namespaces scope a search to one paper without needing a metadata index created ahead of time.
- **Durable Objects for chat.** A conversation needs ordered, strongly consistent writes; a per-session SQLite database co-located with compute fits better than eventually-consistent KV.
- **D1 for accounts and paper records; KV for paper text.** Users, sessions, paper metadata (including archive/deleted state) and the conversation list need queries ("this user's archived papers"), so they live in D1's SQLite. Full paper text is large, written once and read rarely, so it stays in KV. Both are free with no card required.
- **Per-paper namespaces double as tenant isolation.** Searches only ever query the namespaces of the signed-in user's own active papers, so one account can never retrieve another's passages, and archived or deleted papers drop out of search automatically.
- **Friendly errors, without the risk.** Sign-in says "No account with that username" instead of a vague "wrong username or password". That reveals which usernames exist, but sign-up has to reveal that anyway, and per-account lockouts, per-address limits and Turnstile make the knowledge useless for guessing passwords.
- **Chats are keyed by user.** Each conversation's Durable Object is addressed as `userId:sessionId`, so a guessed session id can't open someone else's history.
- **Citations as a first-class feature.** An answer is only as useful as your ability to check it, so sources travel with every answer and are stored with the message.
