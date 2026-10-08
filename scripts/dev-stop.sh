#!/usr/bin/env bash
# dev-stop.sh stops an earlier `make dev` of this checkout so a new one can start: `api` stops the
# devrun watcher (and with it the server it runs) and whatever still listens on 7358, `web` stops
# whatever listens on 7357. Each gets SIGTERM and 12 s to shut down cleanly, then SIGKILL.
set -u

root=$(cd "$(dirname "$0")/.." && pwd -P)
pids=()
ports=()

for what in "$@"; do
	case $what in
	api)
		ports+=(7358)
		# devrun watchers started from this checkout, even orphaned ones whose make has gone: left
		# alone, one rebuilds .dev/bin/darkory on every save beside the new watcher.
		for pid in $(pgrep -f 'devrun -o .*-pkg ./cmd/darkory' || true); do
			cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')
			[ "$cwd" = "$root" ] && pids+=("$pid")
		done
		;;
	web) ports+=(7357) ;;
	*) echo "dev-stop: unknown part $what (want api or web)" >&2; exit 2 ;;
	esac
done

for port in ${ports[@]+"${ports[@]}"}; do
	for pid in $(lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true); do
		pids+=("$pid")
	done
done

[ ${#pids[@]} -eq 0 ] && exit 0

echo "dev-stop: stopping the earlier run (pids ${pids[*]})"
kill -TERM "${pids[@]}" 2>/dev/null || true

alive() {
	for pid in "${pids[@]}"; do kill -0 "$pid" 2>/dev/null && return 0; done
	for port in ${ports[@]+"${ports[@]}"}; do
		lsof -nP -t -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 && return 0
	done
	return 1
}

for _ in $(seq 1 120); do
	alive || exit 0
	sleep 0.1
done

echo "dev-stop: still running after 12 s; killing it"
kill -KILL "${pids[@]}" 2>/dev/null || true
for port in ${ports[@]+"${ports[@]}"}; do
	for pid in $(lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true); do
		kill -KILL "$pid" 2>/dev/null || true
	done
done
sleep 0.5
