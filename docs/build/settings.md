# Install settings

An Install's storage, Evidence store and sign-in are independent settings ([ADR 0002](../adr/0002-one-authority-per-organisation.md)). With none set, `darkory serve` runs as **Local**: SQLite in the data directory, Evidence on disk beside it, and a printed login link. Every setting is an environment variable. Most also have a flag, and a flag wins over its variable. Settings that usually carry a secret (`DARKORY_DB_LISTEN`, `DARKORY_SMTP_*`, `DARKORY_S3_*`) are environment-only, so they never appear in a process list.

## Where the server listens and is reached

| Variable | Flag | Default | Meaning |
|---|---|---|---|
| `DARKORY_LISTEN` | `--listen` | `127.0.0.1:7357` (the image: `0.0.0.0:7357`) | Address `serve` listens on. |
| `DARKORY_PUBLIC_URL` | `--public-url` | none: `http://` and the address a request came to | Address browsers reach the Install at, such as `https://darkory.example.com`. Login links are built on it, and the browser-cookie origin check accepts it. Set it behind a proxy that ends TLS. Emailed sign-in requires it. |
| `DARKORY_PROXY_HOPS` | `--proxy-hops` | `0` | How many proxies in front append to `X-Forwarded-For`. The client's address is that many entries from the end; with `0` it is the connection's address. Only the email sign-in rate limit uses it. Leave it at `0` unless every request passes through that many proxies you run, or clients can choose their own address. |

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
| `DARKORY_SMTP_URL` | (environment only) | none: email sign-in is off | The SMTP server that sends emailed login links: `smtp://user:pass@host:587` requires STARTTLS, `smtps://user:pass@host:465` uses TLS from the start, and `smtp://host:25?tls=none` sends plain text, for a relay on a trusted network only. Percent-encode the user and password. |
| `DARKORY_SMTP_FROM` | (environment only) | none | The sender, such as `Darkory <darkory@example.com>`. Required with `DARKORY_SMTP_URL`. |
| `DARKORY_SMTP_MAX_PER_HOUR` | (environment only) | `300` | The most sign-in emails a server process sends an hour. Over it, requests still answer 202 and nothing is sent until the cap refills; printed and admin-issued links keep working. |

An Install always has the **printed link**. `serve` prints a link at every start, and an admin issues one for any Member with `POST /v1/members/{member}/login-links` (`darkory login <member>`). With SMTP set, the Install also has the **emailed link**. `POST /v1/sign-in/email` emails a link to each Member whose email matches, ignoring case. The link has the same 15-minute expiry and single use as a printed link. The request always answers 202. It is limited per client address (an IPv6 client by its /64) before the reply; then, only for an address a Member has, per Member and by the cap on emails sent. `serve` refuses to start when `DARKORY_SMTP_URL` is set without `DARKORY_PUBLIC_URL` and `DARKORY_SMTP_FROM`. The health reply lists the modes (`printed_link`, `email_link`) from `Server.SignInModes`. GitHub and Google sign-in are not in this build.

## Updates and the container

| Variable | Default | Meaning |
|---|---|---|
| `DARKORY_NO_UPDATE_CHECK` | off | Turns off the update notice. The CLI also has `--no-update-check`. |
| `DARKORY_UPDATE_URL` | GitHub's releases API | Another releases API for `darkory update` and the notice. Signatures are still checked against the key compiled into the binary. |
| `DARKORY_CONTAINER` | set in the image | Makes `darkory update` point at a newer image instead of replacing the binary. |
| `DARKORY_VERSION`, `DARKORY_INSTALL_DIR`, `DARKORY_DOWNLOAD_URL` | latest, `/usr/local/bin`, GitHub | Settings of `install.sh` ([release.md](release.md)). |

## The CLI and MCP server

These are settings of a client, not of the Install: `DARKORY_URL` (`--url`, default `http://127.0.0.1:7357`), `DARKORY_TOKEN` (`--token`), `DARKORY_SESSION` (`--session`; `darkory prime` prints one) and `DARKORY_NO_UPDATE_CHECK` (`--no-update-check`).

## Tests

`DARKORY_TEST_POSTGRES_URL` runs the Postgres tests ([testing.md](testing.md)). `DARKORY_TEST_S3=1` runs the S3 store against MinIO in Docker (`DARKORY_TEST_S3_IMAGE` names another image). `DARKORY_TEST_SMTP=1` runs emailed sign-in through Mailpit in Docker.
