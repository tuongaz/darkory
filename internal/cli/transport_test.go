package cli

import (
	"errors"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// unreachable fails every request, counting them.
type unreachable struct {
	mu   sync.Mutex
	sent []string
}

func (u *unreachable) RoundTrip(req *http.Request) (*http.Response, error) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.sent = append(u.sent, req.URL.Host)
	return nil, errors.New("network down")
}

// A plain http URL to a host other than this machine is refused before anything is sent, since
// the token would cross the network in clear text, unless --insecure or DARKORY_INSECURE says the
// network is trusted (security review L10).
func TestPlainHTTPToAnotherHostNeedsInsecure(t *testing.T) {
	for _, tc := range []struct {
		url       string
		env, args []string
		refused   bool
	}{
		{url: "http://darkory.example:7357", refused: true},
		{url: "http://10.0.0.5:7357", refused: true},
		{url: "http://localhost.example.com", refused: true},
		{url: "http://darkory.example:7357", args: []string{"--insecure"}},
		{url: "http://darkory.example:7357", env: []string{"DARKORY_INSECURE", "1"}},
		{url: "http://darkory.example:7357", env: []string{"DARKORY_INSECURE", "false"}, refused: true},
		{url: "https://darkory.example"},
		{url: "http://127.0.0.1:7357"},
		{url: "http://127.8.9.10:7357"},
		{url: "http://localhost:7357"},
		{url: "http://LOCALHOST:7357"},
		{url: "http://[::1]:7357"},
	} {
		rt := &unreachable{}
		r := &runner{t: t, hc: &http.Client{Transport: rt}, env: map[string]string{
			"DARKORY_URL": tc.url, "DARKORY_TOKEN": "dk_secret"}}
		if tc.env != nil {
			r.env[tc.env[0]] = tc.env[1]
		}
		res := r.run(append([]string{"me"}, tc.args...)...)
		switch {
		case tc.refused && (res.code != ExitUsage || len(rt.sent) != 0 || !strings.Contains(res.stderr, "clear text")):
			t.Errorf("%s %v %v: exit %d, sent %v, %q; want it refused before sending", tc.url, tc.env, tc.args, res.code, rt.sent, res.stderr)
		case !tc.refused && (res.code != ExitFailed || len(rt.sent) == 0):
			t.Errorf("%s %v %v: exit %d, sent %v, %q; want it sent", tc.url, tc.env, tc.args, res.code, rt.sent, res.stderr)
		}
	}
	// --insecure is a global flag, accepted before the command too.
	if !Handles([]string{"--insecure", "me"}) {
		t.Error("--insecure before the command is not taken as the CLI's")
	}
}

// A token given with --token works as DARKORY_TOKEN does, with one warning on standard error that
// the process list shows it; standard output is unchanged.
func TestTokenFlagWarns(t *testing.T) {
	in := newInstall(t, storetest.Open(t, store.SQLite))
	byEnv := in.as("ada", "ada-cli").run("me")
	flagged := &runner{t: t, env: map[string]string{"DARKORY_URL": in.ts.URL, "DARKORY_SESSION": "ada-cli"}}
	byFlag := flagged.run("me", "--token", in.ada)
	if byEnv.code != 0 || byFlag.code != 0 || byFlag.stdout != byEnv.stdout {
		t.Fatalf("me with DARKORY_TOKEN: %d %q; with --token: %d %q %q", byEnv.code, byEnv.stdout, byFlag.code, byFlag.stdout, byFlag.stderr)
	}
	if strings.Contains(byEnv.stderr, "DARKORY_TOKEN") || strings.Count(byFlag.stderr, "warning: --token") != 1 ||
		!strings.Contains(byFlag.stderr, "set DARKORY_TOKEN instead") {
		t.Errorf("stderr with DARKORY_TOKEN: %q; with --token: %q", byEnv.stderr, byFlag.stderr)
	}
}
