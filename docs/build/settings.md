# Install settings

An Install's storage, Evidence store and sign-in are independent settings ([ADR 0002](../adr/0002-one-authority-per-organisation.md)). With none set, `darkory serve` runs as **Local**: SQLite in the data directory, Evidence on disk beside it, and a printed login link. Every setting is an environment variable. Most also have a flag, and a flag wins over its variable. Settings that usually carry a secret (`DARKORY_DB_LISTEN`, `DARKORY_SMTP_*`, `DARKORY_S3_*`) are environment-only, so they never appear in a process list.

## Where the server listens and is reached

| Variable | Flag | Default | Meaning |
|---|---|---|---|
| `DARKORY_LISTEN` | `--listen` | `0.0.0.0:7357` (every interface) | Address `serve` listens on. `127.0.0.1:7357` keeps the Install to this machine. Printed links use `127.0.0.1` when it listens on every interface, unless `DARKORY_PUBLIC_URL` is set. |
| `DARKORY_PUBLIC_URL` | `--public-url` | none: `http://` and the address a request came to | Address browsers reach the Install at, such as `https://darkory.example.com`. Login links are built on it, and the browser-cookie origin check accepts it. Set it behind a proxy that ends TLS. Emailed sign-in requires it. |
| `DARKORY_PROXY_HOPS` | `--proxy-hops` | `0` | How many proxies in front append to `X-Forwarded-For`. The client's address is that many entries from the end; with `0` it is the connection's address. A chain shorter than that is ignored and the connection's address counts. Only the email sign-in rate limit uses it. Leave it at `0` unless every request passes through that many proxies you run, or clients can choose their own address. |
| `DARKORY_MAX_WAITING` | `--max-waiting` | `16` | How many Activity streams, and separately how many waiting `next` calls, one Member may have open on a server process at once. One more is refused with `too_many_requests` (429). |
| `DARKORY_RUNNER` | `--runner` | `auto` | Whether `serve` runs the Runner beside the server (ADR 0013): `auto` runs it when `<data>/agents` holds `<member>.token` files, `on` refuses to start without them, `off` never (run `darkory runner` instead). |
| `DARKORY_RUNNER_TMUX` | `darkory runner --tmux` | `auto` | Where sessions run: in tmux when it is on the PATH (`auto`), always (`on`) or never (`off`, child processes that cannot be joined). Environment only for `serve`. |
| `DARKORY_RUNNER_TIMINGS` | — | the plan's | The Runner's clocks, for tests: `wait`, `timeout`, `tick`, `stale`, `nudge`, `exit`, `poll`, `retry` as `name=duration` pairs separated by commas (defaults 30s, 5m, 30s, 2m, 2m, 30s, 1m, 5s). |
| `DARKORY_MCP_NO_HEARTBEAT` | `darkory mcp --no-heartbeat` | off | `darkory mcp` sends no Heartbeats: the Runner that started the session sends them while it shows progress. The Runner's MCP configuration sets it. |

Every request body must arrive within 30 seconds; an Evidence upload gets a further second for each 64 KiB. Every response carries `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin` and a Content-Security-Policy that forbids framing.

## Storage

| Variable | Flag | Default | Meaning |
|---|---|---|---|
| `DARKORY_DATA` | `--data` | `.` (the image: `/data`) | Directory for the SQLite file and, by default, Evidence. |
| `DARKORY_DB` | `--db` | `darkory.db` in the data directory | A `postgres://` or `postgresql://` URL selects Postgres; anything else is a SQLite file path. |
| `DARKORY_DB_LISTEN` | (environment only) | `DARKORY_DB` | Postgres only. Where the connection that LISTENs for other server processes' writes goes. It must reach the same database directly or through session pooling. LISTEN through a transaction-pooling PgBouncer is accepted but never delivers. Set it when `DARKORY_DB` goes through such a pooler. At start the server notifies itself and logs a warning when that notification does not arrive. |
| `DARKORY_MIGRATE` | `--migrate` | off | Postgres only: apply pending migrations at start. |

**Migrations.** On SQLite, `serve` backs up the file (`<file>.pre-NNNN.<time>.bak`) and migrates at every start. On Postgres, a Cloud rollout runs `darkory migrate` as its own step first ([ADR 0009](../adr/0009-agpl-core-closed-cloud-operations.md)). `serve` refuses to start while migrations are pending, unless it is given `--migrate`. On both engines a binary refuses a database that a newer release has migrated. `darkory init` migrates on both.

```sh
darkory migrate --db "$DARKORY_DB" --dry-run   # list pending migrations, apply nothing
darkory migrate --db "$DARKORY_DB"             # apply them and exit
```

`darkory migrate` takes `--data` and `--db` (and their variables) the way `serve` does.

**Several server processes.** On Postgres, each `serve` process sends a `NOTIFY` on channel `darkory_wake` after every write commits and holds one LISTEN connection (`application_name` `darkory-wake`). Together these wake the `next` long-polls and Activity streams waiting on the other processes ([ADR 0006](../adr/0006-web-app-embedded-with-sse-activity.md)). Each process uses one extra connection beyond its pool of 20.

## Evidence store

| Variable | Flag | Default | Meaning |
|---|---|---|---|
| `DARKORY_EVIDENCE` | `--evidence` | `evidence` in the data directory | A directory for the disk store, or `s3://bucket` or `s3://bucket/prefix` for S3-compatible storage. |
| `DARKORY_EVIDENCE_MAX_MB` | `--evidence-max-mb` | `100` | The largest Evidence file, in MiB. A larger upload is refused before a byte is read. |
| `DARKORY_S3_ENDPOINT` | (environment only) | AWS | The service's URL with its scheme, such as `http://minio:9000` or `https://<account>.r2.cloudflarestorage.com`. |
| `DARKORY_S3_REGION` | (environment only) | `AWS_REGION`, else `us-east-1` | Region used to sign requests. |
| `DARKORY_S3_ACCESS_KEY` | (environment only) | `AWS_ACCESS_KEY_ID` | Required for S3. |
| `DARKORY_S3_SECRET_KEY` | (environment only) | `AWS_SECRET_ACCESS_KEY` | Required for S3. Never logged. |
| `DARKORY_S3_PATH_STYLE` | (environment only) | `false` | `true` puts the bucket in the path (`endpoint/bucket/key`), which MinIO and most S3-compatible services need. |

`serve` checks that the bucket can be reached before it starts. Each object is written with one streamed `PUT` of known length, so an upload is never held in memory. A failed upload leaves nothing behind. One object can be at most 5 GiB.

## Sign-in

| Variable | Flag | Default | Meaning |
|---|---|---|---|
| `DARKORY_NO_LOGIN_LINK` | `--no-login-link` | off | Do not issue or print the startup login link. Use it for a container whose output goes to logs that others read. An admin can still issue links through `/v1`. |
| `DARKORY_NO_BROWSER` | `--no-browser` | off | Print the startup login link without opening a browser. |
| `DARKORY_SESSION_IDLE` | `--session-idle` | `720h` (30 days) | A browser Session not used for this long ends, whatever its cookie says. A Go duration. |
| `DARKORY_SESSION_LIFETIME` | `--session-lifetime` | `2160h` (90 days) | A browser Session ends this long after it started, used or not; its cookie is kept as long. |
| `DARKORY_TOKEN_SESSION_IDLE` | `--token-session-idle` | `15m` | A token Session no request has come through for this long ends, unless a Claim bound to it is still live; a request with its id then starts a new Session. Three times the Runner's Heartbeat timeout: every Session in use makes a request at least once a minute. Token Sessions also end when closed, and when their token is revoked. A Go duration. |
| `DARKORY_SMTP_URL` | (environment only) | none: email sign-in is off | The SMTP server that sends emailed login links: `smtp://user:pass@host:587` requires STARTTLS, `smtps://user:pass@host:465` uses TLS from the start, and `smtp://host:25?tls=none` sends plain text, for a relay on a trusted network only. Percent-encode the user and password. |
| `DARKORY_SMTP_FROM` | (environment only) | none | The sender, such as `Darkory <darkory@example.com>`. Required with `DARKORY_SMTP_URL`. |
| `DARKORY_SMTP_MAX_PER_HOUR` | (environment only) | `300` | The most sign-in emails a server process sends an hour. Over it, requests still answer 202 and nothing is sent until the cap refills; printed and admin-issued links keep working. |

Opening a login link shows a page naming the Member it signs in as, with a button; pressing it signs the browser in, and closes the Session of any cookie the browser held. An admin lists a Member's open Sessions with `GET /v1/members/{member}/sessions` (`darkory session list <member>`), and `POST /v1/members/{member}/deactivate` (`darkory member deactivate <member>`) revokes their tokens, closes their Sessions, ends their Claims and refuses every later credential of theirs until they are reactivated.

An Install always has the **printed link**. `serve` prints a link at every start, and an admin issues one for any Member with `POST /v1/members/{member}/login-links` (`darkory login <member>`). With SMTP set, the Install also has the **emailed link**. `POST /v1/sign-in/email` emails a link to each Member whose email matches, ignoring case. The link has the same 15-minute expiry and single use as a printed link. The request always answers 202. It is limited per client address (an IPv6 client by its /64) before the reply; then, only for an address a Member has, per Member and by the cap on emails sent. `serve` refuses to start when `DARKORY_SMTP_URL` is set without `DARKORY_PUBLIC_URL` and `DARKORY_SMTP_FROM`. The health reply lists the modes (`printed_link`, `email_link`) from `Server.SignInModes`. GitHub and Google sign-in are not in this build.

## Updates and the container

| Variable | Default | Meaning |
|---|---|---|
| `DARKORY_NO_UPDATE_CHECK` | off | Turns off the update notice, and `serve`'s daily check for a newer release (so health never reports one). The CLI and `serve` also take `--no-update-check`. |
| `DARKORY_UPDATE_URL` | GitHub's releases API | Another releases API for `darkory update` and the notice. Signatures are still checked against the key compiled into the binary. |
| `DARKORY_CONTAINER` | set in the image | Makes `darkory update` point at a newer image instead of replacing the binary. |
| `DARKORY_VERSION`, `DARKORY_INSTALL_DIR`, `DARKORY_DOWNLOAD_URL` | latest, `/usr/local/bin`, GitHub | Settings of `install.sh` ([release.md](release.md)). `DARKORY_DOWNLOAD_URL` must be https unless `DARKORY_INSECURE` is set. |

## The CLI and MCP server

These are settings of a client, not of the Install: `DARKORY_URL` (`--url`, default `http://127.0.0.1:7357`), `DARKORY_TOKEN` (`--token`), `DARKORY_SESSION` (`--session`; `darkory prime` prints one), `DARKORY_NO_UPDATE_CHECK` (`--no-update-check`) and `DARKORY_INSECURE` (`--insecure`, default off).

- A plain `http://` URL to a host other than `localhost` or a loopback address is refused unless `DARKORY_INSECURE` is set (any value but empty, `0` or `false`), since the token would cross the network in clear text.
- Prefer `DARKORY_TOKEN` to `--token`: other processes on the machine can read a command's arguments, and `--token` prints a warning saying so.

## Tests

`DARKORY_TEST_POSTGRES_URL` runs the Postgres tests ([testing.md](testing.md)). `DARKORY_TEST_S3=1` runs the S3 store against MinIO in Docker (`DARKORY_TEST_S3_IMAGE` names another image). `DARKORY_TEST_SMTP=1` runs emailed sign-in through Mailpit in Docker. `DARKORY_E2E=1` runs the end-to-end suite in `e2e/` against a freshly built binary, on Postgres when `DARKORY_E2E_POSTGRES_URL` is set; `DARKORY_E2E_SOAK`, `DARKORY_E2E_SOAK_TASKS` and `DARKORY_E2E_RACE` tune its soak ([testing.md](testing.md)).
