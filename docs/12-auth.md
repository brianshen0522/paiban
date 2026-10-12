# 12 Accounts, permissions and security

This site is for people who know each other, but it sits on the internet, downloads files, connects to outside sites and runs ffmpeg. This document lists what must be done.

## Accounts

- Username (`username`): lowercase English letters, digits and underscores, 3 to 32 characters. Case-insensitive on input, stored in lowercase.
- Display name: 1 to 20 characters, may be Chinese. This is what others see on shared videos, notifications and logs.
- Two roles: `admin` and `member`.
- No email. The system sends no mail.

### The first administrator (D18)

When `api` starts, if the `users` table is empty and the environment variables `BOOTSTRAP_ADMIN_USERNAME` and `BOOTSTRAP_ADMIN_PASSWORD` both have values, it creates this administrator. If the table is not empty, these two variables are ignored completely.

Details:

| Case | Behavior |
| --- | --- |
| The table is empty, both variables have values, and they follow the rules | Create the administrator. The display name starts as the username (the first 20 characters if longer than 20) and can be changed in Profile after signing in |
| The table is empty and a value breaks the rules (username not 3 to 32 lowercase English letters, digits and underscores; password shorter than 8 characters), or only one of them is set | `api` exits with an error whose message says which variable and which rule. Don't silently skip it, or you get a site no one can sign in to |
| The table is empty and neither variable is set | Start normally and write one warning line to the log. No one can sign in at this point; set the variables and restart, and the administrator is created |
| The table is not empty | Don't look at these two variables at all. Leaving them in `.env` has no effect, but we recommend changing the password after the first sign-in and deleting these two lines |

The password value is never written to the log.

There is no setup page where "the first person to open the site becomes administrator": someone else could get there first as soon as the site goes online.

### Passwords

- At least 8 characters, at most 200. No required mix of cases or symbols.
- Hashed with argon2id (the default parameters of `@node-rs/argon2` are fine), stored as a PHC-format string.
- When signing in with a username that doesn't exist, still run one hash comparison (against a fixed fake hash), so response time doesn't reveal whether the account exists.
- Changing the password requires the current password; on success, all other sessions of this account are deleted.
- Passwords and hashes are never logged or returned anywhere.

### Sign-in state

- Cookie name `paiban_session`; the value is 32 random bytes in base64url.
- Attributes: `HttpOnly`, `SameSite=Lax`, `Path=/`, plus `Secure` when `PUBLIC_URL` is https.
- The database stores only its SHA-256 (`sessions.token_hash`). A database leak is not a session leak.
- Valid for 30 days. When fewer than 15 days remain, the next request extends it as well. `last_seen_at` is updated at most once every 5 minutes.
- Expired rows are ignored in queries; no code needs to clean them up.
- The "Signed-in devices" page lists your own sessions and can sign out other devices. The API returns the operating system and browser names derived from the User-Agent at sign-in (`os`, `browser`, null when they can't be derived); text like "Windows · Edge" and "Unknown device" is written by the front end.
- When an account is disabled, removed or has its password reset, all of its sessions are deleted.

### Attempt limits

| Target | Limit |
| --- | --- |
| Sign-in, same account | 5 failures within 15 minutes locks it for 15 minutes |
| Sign-in, same IP | 20 within 15 minutes |
| Checking invite codes and registering, same IP | 10 per minute |
| Checking reset links and resetting, same IP | 10 per minute |

`api` has only one instance, so keeping the counts in memory is fine. Return `RATE_LIMITED` with how many seconds remain to wait.

`api` sits behind Caddy; the client IP must be taken from `X-Forwarded-For`, and this header is trusted only when it comes from the internal Docker network.

## Invites

- The administrator chooses the role (member or administrator) and the validity period (1, 3 or 7 days).
- Invite codes look like `XXXX-XXXX`, with the alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no easily confused I, O, 0, 1), generated with cryptographic-grade randomness.
- The link is `<PUBLIC_URL>/invite/<invite code>`.
- An invite code can be used only once. On registration, check "not expired, not used" and mark it used in the same transaction, so two people can't use it at the same time.
- Unused ones can be "Revoke"d; used or expired ones can be "Clear"ed. Both delete that row.

## Reset password (D17)

- The administrator presses "Reset password" on the users page, which generates a link: `<PUBLIC_URL>/reset/<token>`. The token is 32 random bytes in base64url; the database stores only the hash.
- Valid for 30 minutes, usable only once. Generating a new one for the same account voids the old one.
- **The link appears only in the response that generated it** and can't be looked up afterward. The administrator passes it to the person privately.
- After the person sets a new password, the link stops working and all sessions are deleted.

## Who can do what

| Resource | Member | Administrator |
| --- | --- | --- |
| Search, film page | Yes | Yes |
| Download a new version, join someone else's version | Yes | Yes |
| View a download, enter its workspace, its video and subtitle endpoints | Only ones they hold | Only ones they hold, same as members |
| Pause, resume, retry, cancel | Only ones they hold | Only ones they hold |
| Add, edit, confirm, remove subtitles | Any subtitles of a film they hold (subtitles are shared) | Same as members |
| Create an export | For a film they hold | Same as members |
| Download an export | Holders of that film, or its creator | All |
| Delete an export | Ones they created | All |
| View usage | Yes (the site-wide numbers are the same for everyone) | Yes |
| See what others hold | Only "who has downloaded this version" and the names of sharers on the film page | Everything: the site-wide download list (read-only), the Storage management page |
| Force delete any item | No | Yes (Storage management page) |
| `/api/admin/…` | No | Yes |

**Operations on a given film only check "is this a holder"; administrators are no exception.** An administrator who wants to work on someone else's film (for example to help sync subtitles) first adds that version to their own Library on the film page, and from then on is like any other holder; to stop someone else's download, they use force delete on the Storage management page. This matches the prototype's behavior (after an administrator checks "Show everyone's downloads", other people's downloads are view-only). The benefit is that permissions follow a single rule, and anyone who touched the film is always on the holder list.

Every endpoint must be checked on the server; hiding buttons in the front end is not enough. Authorization is written as shared functions (`requireHolder(torrentId)`, `requireAdmin()`) that each route calls explicitly; `requireHolder` has no "let administrators through" branch. Add a test that walks every route and confirms none is missing its check.

Administrators cannot change their own role, disable themselves or remove themselves; nor can they leave the system without any active administrator (`LAST_ADMIN`).

## Cross-site request protection

- The cookie is `SameSite=Lax`.
- Requests that change data must carry the `X-Requested-With: paiban` header (a browser's cross-site form can't send custom headers), and `Origin` must be same-origin with `PUBLIC_URL`, or be the host this request reached (`Host`).
- Requests with a body must carry `Content-Type: application/json` (uploads are `multipart/form-data`); requests without a body don't require `Content-Type`.
- `GET` doesn't change data (except the two record-keeping fields `last_seen_at` and `last_used_at`).
- No CORS.

## Response headers

Added by Caddy (`deploy/Caddyfile`): `Content-Security-Policy` (same-origin only; no external resources loaded), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`.

`Referrer-Policy: no-referrer` has a real purpose: when users follow a link from here to Zimuku or a source page, this site's address isn't revealed to the other side. External links also get `rel="noopener noreferrer"`.

The web page loads no fonts, scripts or images from any external domain. Fonts come bundled with npm packages, and posters are fetched by the server on the browser's behalf.

## Outbound requests

The only places the server connects to are: YTS, TMDB (`api.themoviedb.org`, plus `image.tmdb.org` for posters), the three subtitle sources and their download hosts, and BitTorrent. The first four all go through one shared HTTP client, which is responsible for:

- **Host allowlist**: each source has a fixed list (see [07-subtitle-providers.md](07-subtitle-providers.md)); for YTS it is the host the administrator set. URLs not on the list are not connected to.
- **Blocking internal addresses**: after DNS resolution, if the address is in a private range, loopback, link-local, or the corresponding IPv6 ranges, don't connect. This includes the YTS and YIFY addresses the administrator fills in (so no one can point them at internal services). To decide whether an address is internal, use Node's built-in `net.BlockList`, or list the ranges explicitly and write tests; **don't use the `ip` package from npm**, whose `isPublic` / `isPrivate` have known misclassifications (GHSA-2p57-rm9w-gvfp).
- **Redirects**: at most 3, re-checking the host and address each time. YTS doesn't follow redirects to another host ([05-yts.md](05-yts.md)).
- **Timeouts and size limits**: every kind of request has them. The response size is counted while reading, and reading stops once it goes over.
- **https only**.
- **Strip the query string when logging**; log only the host and path.
- **Subtitle source requests are queued first**: requests to each source keep a gap between them, no matter which program sends them ("Common rules" in [07-subtitle-providers.md](07-subtitle-providers.md)).

This client must be done when YTS is built in phase 2; `api` and `media` share the same one.

**The language model used for auto-align** ("Language model" in [08-media-pipeline.md](08-media-pipeline.md)) is an exception and doesn't go through the client above: Claude connects to Anthropic's API through Anthropic's official SDK; OpenAI-compatible services connect to the address the administrator set, and **internal addresses are allowed** (an administrator's own model server is often on the LAN). Only administrators can set this address, what is sent is a prompt in a fixed format, only the matched IDs are taken from the response (IDs not in the prompt are dropped), and errors keep only a code, so the other side's response is never shown to anyone. This request is sent only from `api` (only it can read the key), doesn't follow redirects, and is cut off when the response exceeds 1 MB.

**Peer data on the download details page**: other people's IP addresses exist in full only inside the `torrent` service; what is written to the database and sent to the browser has the second half masked ("61.220.x.x"), and connection identifiers are hashes with a random salt. The country lookup table is downloaded when building the image, and lookups at runtime make no outside connections.

### Relaxations for development and testing

The fake YTS and fake subtitle sources run on internal addresses over `http://`, and the rules above would block them all. So there is an explicit switch:

- `ALLOW_LOCAL_SOURCES=1`: allows `http://` and internal addresses; validation of the YTS and YIFY addresses is relaxed accordingly.
- `SOURCE_OVERRIDES`: replaces the fixed source hosts with other URLs (JSON, keyed by the original host). The client swaps them only **after** the host allowlist check passes, so the allowlist itself is still tested.
- These two variables, plus `torrent`'s `TORRENT_TEST_PEERS`, may appear only in the development and test compose files. **When `NODE_ENV=production`, if any one of them is set, the program exits with an error at startup.** This must have a test.

It is an environment variable rather than an option on a settings page because it should not be something an administrator can click in the interface.

## Uploads and archives

- Check the extension and size first, then the file header to determine the actual format.
- Uploaded content is always treated as data: never executed, never returned as HTML. Subtitle text shown on screen is always plain text (React does this by default; don't use `dangerouslySetInnerHTML`).
- Extraction limits are in [07-subtitle-providers.md](07-subtitle-providers.md). The key points: don't trust paths inside archives, don't extract symbolic links, and limit the count and total size (against archive bombs).
- Extraction tools are started with array arguments, not through a shell; the output directory is a working directory the program created itself.

## File paths

- Every file path is built from IDs in the database and fixed rules; **no path fragment from a request is accepted**.
- The only paths that come from outside are file names in torrents and file names in archives. Both must be resolved and confirmed to fall inside the expected folder.
- Export file names, after checking, are used only in `Content-Disposition` and the final file name; the storage folder is `/data/exports/<id>/`, so a file name can't escape it.
- Download responses use `Content-Disposition: attachment; filename*=UTF-8''<percent-encoded>`.

## Running external programs

ffmpeg, ffprobe, ffsubsync and extraction tools are all started with array arguments (`spawn(cmd, [args])`), never by building strings or going through a shell. File names in the arguments all come from the trusted paths described above. The subtitle track title ("繁體中文", Traditional Chinese) is a fixed string, not user input.

## Keys

| Key | Where it lives | Who can get it |
| --- | --- | --- |
| `SECRET_KEY`, database password, first administrator's password | Environment variables (`.env`) | `SECRET_KEY` goes only to `api` |
| TMDB key, SubDL key, Assrt (Shooter) token, language model keys | The `secrets` table, encrypted with `SECRET_KEY` using AES-256-GCM (a random 12-byte nonce per entry, with the name as additional authenticated data) | Only `api` can decrypt them |

- The API only reports whether a key "is set". No endpoint ever returns the contents.
- `.env` is not under version control. The repo has only `.env.example`, which must not contain real values.
- No key may appear in the log, including keys carried in URLs. Write a test: run each source's requests once with a fake key and confirm that string can't be found in the log output.
- For other people's keys that appear in responses, see D28 and [07-subtitle-providers.md](07-subtitle-providers.md).

## Activity log

Every consequential thing a user does writes one `audit_log` row. `action` is a stable code; the wording in the interface is mapped by the front end.

`target` stores data, not sentences (like the rest of the API). How the "Target" column is displayed is up to the front end; the right column below is the data it needs.

| Code | Wording in the interface | Data in `target` → shown as |
| --- | --- | --- |
| `auth.login` | Signed in | `{os, browser}` → device ("Windows · Edge") |
| `auth.logout` | Signed out | |
| `auth.session.revoke` | Signed out another device | `{os, browser}` → device |
| `auth.register` | Registered with an invite code | `{code}` → invite code (already used up by then) |
| `auth.password.change` | Changed password | |
| `auth.password.reset` | Set password with a reset link | |
| `torrent.add` | Started a download / Queued a download | `{movieTitle, version}` → title · version |
| `torrent.join` | Added to Library | Same as above |
| `torrent.manual` | Added a torrent by hand | Same as above (Brian, 2026-10-09) |
| `torrent.pause` | Paused a download | Same as above |
| `torrent.resume` | Resumed a download | Same as above |
| `torrent.retry` | Retried a download | Same as above |
| `torrent.leave` | Removed from Library / Gave up a download | Same as above |
| `torrent.delete` | Deleted a video / Cancelled a download | Same as above |
| `media.preview.request` | Requested a preview file | Same as above |
| `subtitle.add` | Added subtitles | `{movieTitle, language}` → title · language |
| `subtitle.remove` | Removed subtitles | Same as above |
| `subtitle.candidate.remove` | Removed candidate subtitles | `{movieTitle, releaseName}` → title · release name or file name |
| `subtitle.confirm` | Confirmed a subtitle sync | Same as above |
| `export.create` | Exported an MKV | `{movieTitle, fileName}` → title |
| `export.delete` | Deleted an export | `{fileName}` → file name |
| `admin.user.role` | Changed a role | `{name, role}` → name → role |
| `admin.user.disable` | Disabled an account | `{name}` → name |
| `admin.user.enable` | Enabled an account | Same as above |
| `admin.user.reset_link` | Made a password reset link | Same as above |
| `admin.user.remove` | Removed an account | Same as above |
| `admin.invite.create` | Created an invite | `{role, days}` → role · days valid. The invite code is not recorded: it is still usable |
| `admin.invite.revoke` | Revoked an invite | `{code}` → invite code (already void by then) |
| `admin.storage.limit` | Changed the storage limit | `{fromBytes, toBytes}` → old → new |
| `admin.storage.delete` | Deleted as administrator | `{itemKind, movieTitle, fileName}` (whichever apply) → the item's kind and name |
| `admin.storage.rescan` | Recounted usage | |
| `admin.settings.change` | Depends on which group of settings changed; see the table below | `{keys}`: the changed setting keys, joined with commas |
| `admin.secret.set` | Updated a key | `{name}` → the key's name (not its contents) |
| `admin.secret.clear` | Cleared a key | Same as above |
| `admin.task.retry` | Retried a background task | `{kind, movieTitle}` → task kind · title |

The difference between `torrent.leave` and `torrent.delete` is whether the files were really deleted: if others still hold it, it's the former; if this was the last holder, the latter.

The interface wording for `admin.settings.change` is grouped by the keys changed (the first five are sentences the prototype used):

| Keys changed | Wording |
| --- | --- |
| `downloads.*`, `media.*` | Changed download settings |
| `yts.baseUrl` | Updated the YTS address |
| `providers.yify.baseUrl` | Updated the YIFY Subtitles address |
| `providers.justsubtitles.mode` | Changed the JustSubtitles lookup method |
| `providers.cacheHours` | Changed the cache time |
| `providers.<source>.enabled` | Enabled a subtitle source / Disabled a subtitle source (the target is the source's name) |
| Anything else (Zimuku address, default languages) | Changed source settings |

One save writes only one entry; when several groups change, use the wording of the first matching row in the table, and `keys` still lists them all.

In these two tables, the following wordings are new (the prototype didn't log those actions, or didn't have that feature): Paused a download, Resumed a download, Signed out another device, Set password with a reset link, Requested a preview file, Removed candidate subtitles, Recounted usage, Cleared a key, Retried a background task, Changed source settings. All others are sentences the prototype used.

The log never contains passwords, keys, tokens, still-usable invite codes or reset links.

## Pre-launch checklist

- [ ] When not signed in, every endpoint returns 401 except `/api/health` and the sign-in, invite and reset endpoints
- [ ] A member calling any `/api/admin/…` gets 403
- [ ] A member calling endpoints for downloads, subtitles or videos they don't hold gets 403 (exports they can't see return 404, consistent with [04-api.md](04-api.md): don't reveal it exists); the same goes for administrators on films they don't hold (except downloading and deleting exports, and lists with `scope=all`)
- [ ] When `NODE_ENV=production` and `ALLOW_LOCAL_SOURCES`, `SOURCE_OVERRIDES` or `TORRENT_TEST_PEERS` is set, all three programs refuse to start
- [ ] Write requests missing `X-Requested-With` are rejected
- [ ] After an account is disabled, its existing sessions stop working immediately
- [ ] No passwords, keys or session values can be found in the log or `audit_log`
- [ ] For the JustSubtitles response entry that carries `api_key`, the URL stored in the database has no query string
- [ ] When an administrator sets the YTS address to `https://127.0.0.1` or an internal host name, requests are blocked
- [ ] Uploading a zip with a `../` path, a zip with a symbolic link, and a zip that expands past the limit are all rejected and leave no files outside the working directory
- [ ] When subtitle text contains `<script>`, the screen shows it as text
- [ ] An export file name containing `/` is rejected
- [ ] The repo has no `.env` and no real keys
